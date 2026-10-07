import { rm } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// Mock the two external boundaries so nothing hits the network and CI detection
// is deterministic. install-id and the tee use the real filesystem.
const ci = vi.hoisted(() => ({ isCI: false, name: null as string | null }));
vi.mock("ci-info", () => ({ default: ci }));

const posthog = vi.hoisted(() => {
  // `capture()` awaits captureImmediate's promise, so the mock returns one.
  const captureImmediate = vi.fn(() => Promise.resolve(undefined));
  const shutdown = vi.fn(() => Promise.resolve(undefined));
  // Regular function (not an arrow) so `new PostHog(...)` is constructable.
  const PostHog = vi.fn(function (this: Record<string, unknown>) {
    this.captureImmediate = captureImmediate;
    this.shutdown = shutdown;
  });
  return { captureImmediate, shutdown, PostHog };
});
vi.mock("posthog-node", () => ({ PostHog: posthog.PostHog }));

import { getConfiguredConnectorIds } from "../src/connectors/registry.ts";
import { capture as captureEvent } from "../src/telemetry/client.ts";
import { DEFAULT_POSTHOG_KEY } from "../src/telemetry/config.ts";
import { classifyError } from "../src/telemetry/errors.ts";
import {
  ciSentinelId,
  isCiEnvironment,
  isProductionBuild,
  isTelemetryDisabled,
  noticeSuppressed,
} from "../src/telemetry/gates.ts";
import { getOrCreateInstallId } from "../src/telemetry/install-id.ts";
import { buildRunEvent } from "../src/telemetry/senders.ts";
import type { RunEventContext } from "../src/telemetry/senders.ts";
import type { RunTelemetry } from "../src/telemetry/types.ts";
import { useTempOpenWikiHome } from "./support/temp-openwiki-home.ts";

const ENV_KEYS = [
  "OPENWIKI_TELEMETRY_DISABLED",
  "DO_NOT_TRACK",
  "OPENWIKI_SCHEDULED",
  "OPENWIKI_NOTION_MCP_ACCESS_TOKEN",
] as const;

let savedEnv: Record<string, string | undefined>;
let savedOpenWikiHome: string | undefined;
let tempHome: string;

beforeEach(async () => {
  // `src/telemetry/install-id.ts` mkdirs and writes under the OpenWiki home for
  // real. The vitest home guard makes the developer's real home unreachable, so
  // this file must be given a throwaway one or every write fails ENOTDIR.
  // Still load-bearing after #63: `recordRun` no longer reaches the home (the
  // gate stops it first), but the human-identity test below resolves the install
  // id directly, which does.
  savedOpenWikiHome = process.env.OPENWIKI_HOME;
  tempHome = await useTempOpenWikiHome("openwiki-telemetry-");

  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }

  ci.isCI = false;
  ci.name = null;
  posthog.captureImmediate.mockReset();
  posthog.captureImmediate.mockResolvedValue(undefined);
  posthog.shutdown.mockReset();
  posthog.shutdown.mockResolvedValue(undefined);
  posthog.PostHog.mockClear();
});

afterEach(async () => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = savedEnv[key];
    }
  }

  if (savedOpenWikiHome === undefined) {
    delete process.env.OPENWIKI_HOME;
  } else {
    process.env.OPENWIKI_HOME = savedOpenWikiHome;
  }

  await rm(tempHome, { force: true, recursive: true });
});

function runDetails(overrides: Partial<RunTelemetry> = {}): RunTelemetry {
  return {
    command: "init",
    outcome: "success",
    mode: "personal",
    provider: "anthropic",
    configuredConnectors: [],
    ...overrides,
  };
}

describe("classifyError", () => {
  test("maps known shapes to the right enum", () => {
    const abort = new Error("aborted");
    abort.name = "AbortError";

    expect(classifyError(abort)).toBe("aborted");
    expect(classifyError({ status: 401 })).toBe("provider_auth");
    expect(classifyError({ status: 403 })).toBe("provider_auth");
    expect(classifyError({ statusCode: 429 })).toBe("provider_rate_limit");
    expect(
      classifyError(new Error("OPENAI_API_KEY is required to run OpenWiki.")),
    ).toBe("missing_credentials");
    expect(
      classifyError(new Error("A base URL is required to run OpenWiki.")),
    ).toBe("missing_config");
    expect(classifyError(new Error("Invalid model ID: nope"))).toBe(
      "invalid_model",
    );
    expect(classifyError(new Error("Request timed out"))).toBe(
      "provider_timeout",
    );
    expect(classifyError(new Error("fetch failed"))).toBe("network");
    expect(
      classifyError(Object.assign(new Error("x"), { code: "ENOENT" })),
    ).toBe("filesystem");
    expect(classifyError(new Error("something weird"))).toBe("agent_error");
  });

  test("never returns the raw message", () => {
    const secret = "token=/Users/me/.openwiki/secret-value";
    const result = classifyError(new Error(secret));

    expect(result).toBe("agent_error");
    expect(result).not.toContain("secret");
  });
});

describe("gates", () => {
  test("isTelemetryDisabled does not honor either var: the fork closes it in code", () => {
    // Upstream reads OPENWIKI_TELEMETRY_DISABLED / DO_NOT_TRACK here and
    // otherwise sends. This fork's gate returns true unconditionally
    // (docs/adr/0003-usage-telemetry-is-disabled-in-code.md), so neither
    // variable is consulted — including with the values that used to mean
    // "telemetry on". test/telemetry-disabled.test.ts pins this in full.
    expect(isTelemetryDisabled()).toBe(true);

    process.env.OPENWIKI_TELEMETRY_DISABLED = "0";
    process.env.DO_NOT_TRACK = "0";
    expect(isTelemetryDisabled()).toBe(true);
  });

  test("isCiEnvironment: ci-info OR the scheduled escape hatch, and its falsy set", () => {
    expect(isCiEnvironment()).toBe(false);

    ci.isCI = true;
    expect(isCiEnvironment()).toBe(true);
    ci.isCI = false;

    process.env.OPENWIKI_SCHEDULED = "1";
    expect(isCiEnvironment()).toBe(true);

    // The shared env parsing counts these as not set. Upstream covered that
    // through isTelemetryDisabled's vars, which this fork no longer reads, so
    // the coverage moves to the other caller of the same helper rather than
    // being lost.
    for (const falsy of ["0", "false", ""]) {
      process.env.OPENWIKI_SCHEDULED = falsy;
      expect(isCiEnvironment()).toBe(false);
    }
  });

  test("ciSentinelId slugs the provider name", () => {
    ci.name = "GitHub Actions";
    expect(ciSentinelId()).toBe("ci-github-actions");
    ci.name = "Travis CI";
    expect(ciSentinelId()).toBe("ci-travis-ci");
    ci.name = null;
    expect(ciSentinelId()).toBe("ci-unknown");
  });

  test("noticeSuppressed is opt-out OR ci, and the opt-out limb is always true", () => {
    // Upstream's first case is `false`: outside CI, with nothing set, the notice
    // shows. Under the fork's gate the opt-out limb is unconditionally true, so
    // the notice is suppressed on every path — asserted here against a
    // non-CI environment so it is the opt-out limb doing it, not CI.
    expect(isCiEnvironment()).toBe(false);
    expect(noticeSuppressed()).toBe(true);

    // The CI limb still works as upstream intends.
    ci.isCI = true;
    expect(noticeSuppressed()).toBe(true);
  });
});

describe("client.capture", () => {
  test("sets the minimal-collection flags and never sends an IP", async () => {
    const sent = await captureEvent({
      distinctId: "id-1",
      event: "openwiki_run",
      properties: { command: "init" },
    });

    expect(sent).toBe(true);
    expect(posthog.PostHog).toHaveBeenCalledWith(
      DEFAULT_POSTHOG_KEY,
      expect.objectContaining({ isServer: false }),
    );

    const arg = posthog.captureImmediate.mock.calls[0]?.[0] as {
      disableGeoip?: boolean;
      properties: Record<string, unknown>;
    };
    expect(arg.disableGeoip).toBe(true);
    // The client passes properties through untouched; the person-profile flag
    // is set per-event by `send`, not here.
    expect(arg.properties).not.toHaveProperty("$process_person_profile");
    expect(arg.properties).not.toHaveProperty("$ip");
    expect(posthog.shutdown).toHaveBeenCalledOnce();
  });
});

describe("getConfiguredConnectorIds", () => {
  test("reports only auth-gated, fully-configured connectors", () => {
    expect(getConfiguredConnectorIds()).not.toContain("notion");
    // Zero-auth built-ins never count as adoption signal.
    expect(getConfiguredConnectorIds()).not.toContain("git-repo");
    expect(getConfiguredConnectorIds()).not.toContain("hackernews");

    process.env.OPENWIKI_NOTION_MCP_ACCESS_TOKEN = "secret";
    expect(getConfiguredConnectorIds()).toContain("notion");
  });
});

/*
 * Upstream drove the assertions below through `recordRun` and read the event
 * back off the PostHog mock or the tee. This fork's gate returns before
 * `recordRun` resolves an identity or builds an event
 * (docs/adr/0003-usage-telemetry-is-disabled-in-code.md), so the composition can
 * no longer be exercised end to end. The tests are kept rather than deleted, and
 * re-pointed at the parts upstream had already factored out: the pure payload
 * builder `buildRunEvent` (which is upstream's own single source of truth for
 * the payload, shared with its seed script), the two identity sources, and
 * `isProductionBuild`. `capture` keeps its own coverage above.
 *
 * They are deliberately NOT made to pass by mocking the fork's gate away: they
 * describe what the send path would send, so an upstream change to the payload
 * still breaks a test here, while nothing here can be misread as evidence that
 * telemetry fires. That it does not fire is test/telemetry-disabled.test.ts.
 *
 * The `recordRun` wiring around the builder (identity choice, tee shape, never
 * throws) cannot be reached with the real gate closed. test/telemetry-send-path.test.ts
 * covers it, and says plainly that it models upstream's open gate. The
 * `distinctId` and `ci` assertions below only echo the context the test passes
 * in. The identity choice that feeds them is asserted there, not here.
 */
describe("the run event the send path would send", () => {
  function context(overrides: Partial<RunEventContext> = {}): RunEventContext {
    return { ci: false, production: false, distinctId: "id-1", ...overrides };
  }

  test("human run uses the install id, ci=false, profile off", async () => {
    const { id } = await getOrCreateInstallId();
    expect(id).toMatch(/^[0-9a-f-]{36}$/i);

    const event = buildRunEvent(runDetails(), context({ distinctId: id }));

    expect(event.distinctId).toBe(id);
    expect(event.properties.ci).toBe(false);
    // Every run is anonymous: no person profile is ever created.
    expect(event.properties.$process_person_profile).toBe(false);
  });

  test("CI run uses the sentinel id, ci=true, profile off", () => {
    process.env.OPENWIKI_SCHEDULED = "1";
    expect(isCiEnvironment()).toBe(true);

    const event = buildRunEvent(
      runDetails(),
      context({ ci: true, distinctId: ciSentinelId() }),
    );

    expect(event.distinctId).toBe("ci-unknown");
    expect(event.properties.ci).toBe(true);
    // CI stays anonymous (no person profile).
    expect(event.properties.$process_person_profile).toBe(false);
  });

  test("configured connectors become boolean connector_<id> properties", () => {
    const event = buildRunEvent(
      runDetails({ configuredConnectors: ["web-search", "notion"] }),
      context(),
    );

    expect(event.event).toBe("openwiki_run");
    // Hyphens are normalized to underscores; only configured ones appear.
    expect(event.properties).toMatchObject({
      connector_web_search: true,
      connector_notion: true,
    });
    expect(event.properties).not.toHaveProperty("connector_slack");
  });

  test("no connector_ properties when nothing is configured", () => {
    const props = buildRunEvent(
      runDetails({ configuredConnectors: [] }),
      context(),
    ).properties;

    expect(Object.keys(props).some((key) => key.startsWith("connector_"))).toBe(
      false,
    );
  });

  test("stamps production=false when running from source (dev/test)", () => {
    // Tests import from src/, so isProductionBuild() (dist/ check) is false;
    // the published build runs from dist/ and would send production=true.
    expect(isProductionBuild()).toBe(false);

    const props = buildRunEvent(
      runDetails(),
      context({ production: isProductionBuild() }),
    ).properties;

    expect(props.production).toBe(false);
  });

  test("update runs omit the init-only setup fields", () => {
    // The agent only sets mode/provider/connectors on init; an update payload
    // built without them must not carry mode/provider/connector_ properties.
    const props = buildRunEvent(
      { command: "update", outcome: "success" },
      context(),
    ).properties;

    expect(props).not.toHaveProperty("mode");
    expect(props).not.toHaveProperty("provider");
    expect(Object.keys(props).some((key) => key.startsWith("connector_"))).toBe(
      false,
    );
    expect(props).toMatchObject({ command: "update", outcome: "success" });
  });
});
