import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/*
 * This file models upstream's OPEN gate. On this fork the gate is closed
 * (docs/adr/0003-usage-telemetry-is-disabled-in-code.md), so the real code never
 * takes the path these tests exercise. They exist to keep covering
 * `recordRun`'s post-gate wiring: the identity choice (install id for a human,
 * sentinel for CI), the tee shape, and the "never throws" guarantee. A future
 * upstream change to that wiring then breaks a test here instead of passing
 * unnoticed.
 *
 * The gate is mocked open for this file only. `isTelemetryDisabled` is the one
 * override; every other export of gates.ts stays real. Nothing here can send:
 * `posthog-node` is mocked, so no request leaves the machine. That telemetry is
 * closed in the real code is test/telemetry-disabled.test.ts, which imports the
 * real gate.
 */

vi.mock("../src/telemetry/gates.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/telemetry/gates.ts")>()),
  isTelemetryDisabled: () => false,
}));

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

import { getOrCreateInstallId } from "../src/telemetry/install-id.ts";
import { recordRun } from "../src/telemetry/senders.ts";
import type { RunTelemetry } from "../src/telemetry/types.ts";
import { useTempOpenWikiHome } from "./support/temp-openwiki-home.ts";

const ENV_KEYS = [
  "OPENWIKI_TELEMETRY_DISABLED",
  "DO_NOT_TRACK",
  "OPENWIKI_SCHEDULED",
] as const;

let savedEnv: Record<string, string | undefined>;
let savedOpenWikiHome: string | undefined;
let tempHome: string;
const teeFiles: string[] = [];

beforeEach(async () => {
  // The human run mints an install id under the OpenWiki home for real. The
  // vitest home guard makes the developer's real home unreachable, so this file
  // needs a throwaway one.
  savedOpenWikiHome = process.env.OPENWIKI_HOME;
  tempHome = await useTempOpenWikiHome("openwiki-telemetry-send-path-");

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

  await Promise.all(teeFiles.map((file) => rm(file, { force: true })));
  teeFiles.length = 0;
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

/** A tee target under the OS temp dir, cleaned up after the test. */
function teeFile(name: string): string {
  const file = path.join(tmpdir(), `ow-telemetry-send-path-${name}.json`);
  teeFiles.push(file);
  return file;
}

interface Tee {
  disabled: boolean;
  ci: boolean;
  sent: boolean;
  event: {
    distinctId: string;
    properties: { ci: boolean; $process_person_profile: boolean };
  };
}

async function readTee(file: string): Promise<Tee> {
  return JSON.parse(await readFile(file, "utf8")) as Tee;
}

describe("recordRun with the gate open (upstream's send path)", () => {
  test("human run uses the install id, ci=false, profile off", async () => {
    const file = teeFile("human");

    await recordRun(runDetails({ telemetryFile: file }));

    const tee = await readTee(file);
    const { id } = await getOrCreateInstallId();
    expect(id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(tee.disabled).toBe(false);
    expect(tee.ci).toBe(false);
    expect(tee.sent).toBe(true);
    expect(tee.event.distinctId).toBe(id);
    expect(tee.event.properties.ci).toBe(false);
    // Every run is anonymous: no person profile is ever created.
    expect(tee.event.properties.$process_person_profile).toBe(false);
    expect(posthog.captureImmediate).toHaveBeenCalledOnce();
  });

  test("CI run uses the sentinel id, ci=true, profile off", async () => {
    process.env.OPENWIKI_SCHEDULED = "1";
    const file = teeFile("ci");

    await recordRun(runDetails({ telemetryFile: file }));

    const tee = await readTee(file);
    expect(tee.disabled).toBe(false);
    expect(tee.ci).toBe(true);
    expect(tee.sent).toBe(true);
    expect(tee.event.distinctId).toBe("ci-unknown");
    expect(tee.event.properties.ci).toBe(true);
    // CI stays anonymous (no person profile).
    expect(tee.event.properties.$process_person_profile).toBe(false);
    expect(posthog.captureImmediate).toHaveBeenCalledOnce();
  });

  test("never throws even if capture fails", async () => {
    posthog.captureImmediate.mockImplementation(() => {
      throw new Error("boom");
    });

    // The mock must really be reached, or this test proves nothing.
    await expect(recordRun(runDetails())).resolves.toBeUndefined();
    expect(posthog.captureImmediate).toHaveBeenCalledOnce();
  });
});
