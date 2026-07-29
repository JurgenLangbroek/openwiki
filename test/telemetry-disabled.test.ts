import { readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/*
 * The fork's pin for ADR-0003 — "Usage telemetry is disabled in code, not
 * configuration". Upstream ships opt-out PostHog telemetry; this fork's
 * `isTelemetryDisabled()` returns true unconditionally, so nothing can be sent.
 *
 * This file is fork-owned and has no upstream counterpart, which is the point:
 * `src/telemetry/gates.ts` is upstream's file, so a future sync can resolve a
 * conflict there by taking upstream's version wholesale. A guard living inside
 * that file (a literal return type, a comment) would be taken away by the same
 * edit that re-enables sending. These tests are outside it and go red instead.
 *
 * They deliberately assert against the *composition* — `recordRunSafe` end to
 * end, not just the gate function — so a re-enable that comes from a send path
 * ceasing to consult the gate fails here too.
 *
 * Every test runs with the opt-out variables unset and CI detection pinned
 * false: the case that would otherwise send.
 */

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

import {
  isTelemetryDisabled,
  noticeSuppressed,
} from "../src/telemetry/gates.ts";
import { firstRunNoticePending } from "../src/telemetry/install-id.ts";
import { recordRunSafe } from "../src/telemetry/record-run-safe.ts";
import { useTempOpenWikiHome } from "./support/temp-openwiki-home.ts";

/** The decision record the gate must keep pointing at. */
const ADR_FILE = "docs/adr/0003-usage-telemetry-is-disabled-in-code.md";

const GATES_SOURCE = fileURLToPath(
  new URL("../src/telemetry/gates.ts", import.meta.url),
);

/**
 * Every variable that used to be able to turn telemetry on or off, plus the CI
 * escape hatch. All are cleared per test so no assertion here can pass because
 * of an environment the developer happens to export.
 */
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
  // A throwaway home, so "no install id was minted" is an assertion about an
  // empty directory rather than about an IO failure: the vitest home guard
  // would make any home write fail ENOTDIR, which would let these tests pass
  // even if telemetry had been re-enabled.
  savedOpenWikiHome = process.env.OPENWIKI_HOME;
  tempHome = await useTempOpenWikiHome("openwiki-telemetry-disabled-");

  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }

  ci.isCI = false;
  ci.name = null;
  posthog.captureImmediate.mockReset();
  posthog.captureImmediate.mockResolvedValue(undefined);
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

/** A tee target under the OS temp dir, cleaned up after the test. */
function teeFile(name: string): string {
  const file = path.join(tmpdir(), `ow-telemetry-disabled-${name}.json`);
  teeFiles.push(file);
  return file;
}

/** Nothing sent, no PostHog client even constructed. */
function expectNothingSent(): void {
  expect(posthog.PostHog).not.toHaveBeenCalled();
  expect(posthog.captureImmediate).not.toHaveBeenCalled();
}

/** Nothing written to the OpenWiki home — in particular, no install id. */
async function expectHomeUntouched(): Promise<void> {
  expect(await readdir(tempHome)).toEqual([]);
}

describe("telemetry is disabled in code (ADR-0003)", () => {
  test("the gate is closed with no opt-out variable set", () => {
    expect(isTelemetryDisabled()).toBe(true);
  });

  test("no environment value can open the gate back up", () => {
    // The values are not consulted at all, so the ones that used to mean
    // "telemetry on" have to fail too. This is what makes the disable a code
    // change rather than a default that happens to be off.
    for (const value of ["0", "false", "", "1", "true", "no"]) {
      process.env.OPENWIKI_TELEMETRY_DISABLED = value;
      expect(isTelemetryDisabled()).toBe(true);
      delete process.env.OPENWIKI_TELEMETRY_DISABLED;

      process.env.DO_NOT_TRACK = value;
      expect(isTelemetryDisabled()).toBe(true);
      delete process.env.DO_NOT_TRACK;
    }
  });

  test("a finished init run emits nothing and mints no install id", async () => {
    const file = teeFile("init");

    await recordRunSafe(
      "init",
      { outputMode: "repository", telemetryFile: file },
      { provider: "anthropic", outcome: "success" },
    );

    expectNothingSent();
    await expectHomeUntouched();
    expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({
      disabled: true,
      sent: false,
    });
  });

  test("an update run emits nothing", async () => {
    const file = teeFile("update");

    await recordRunSafe(
      "update",
      { outputMode: "local-wiki", telemetryFile: file },
      { provider: "anthropic", outcome: "success" },
    );

    expectNothingSent();
    await expectHomeUntouched();
  });

  test("a failed run emits nothing, error class and all", async () => {
    await recordRunSafe(
      "init",
      { outputMode: "local-wiki" },
      { provider: "anthropic", outcome: "failure", errorClass: "network" },
    );

    expectNothingSent();
    await expectHomeUntouched();
  });

  test("a skipped update run emits nothing", async () => {
    await recordRunSafe(
      "update",
      { outputMode: "local-wiki" },
      { provider: "anthropic", outcome: "noop" },
    );

    expectNothingSent();
    await expectHomeUntouched();
  });

  test("the first-run disclosure is never pending, and checking mints nothing", async () => {
    // Outside CI and with no opt-out set, upstream would show the notice on the
    // first run and mint the install id while deciding. The gate suppresses it,
    // so there is no disclosure for something that is already off.
    expect(noticeSuppressed()).toBe(true);
    expect(await firstRunNoticePending()).toBe(false);
    await expectHomeUntouched();
  });

  test("the gate names the decision record, so a later sync leaves it alone", async () => {
    // The unconditional disable reads as dead code; this comment is the only
    // thing that stops a future sync tidying it away, and losing it would not
    // fail any behavioural test. Hence a test about the comment.
    expect(await readFile(GATES_SOURCE, "utf8")).toContain(ADR_FILE);
  });
});
