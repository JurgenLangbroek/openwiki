import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  discoverLiveTools: vi.fn(),
  readConfig: vi.fn(),
  runAgent: vi.fn(),
}));

vi.mock("../src/agent/index.ts", () => ({
  createOpenWikiThreadId: () => "exploration-ledger-test-thread",
  runOpenWikiAgent: mocks.runAgent,
}));

vi.mock("../src/env.ts", () => ({
  loadOpenWikiEnv: vi.fn(),
}));

vi.mock("../src/onboarding.ts", () => ({
  readOpenWikiOnboardingConfig: mocks.readConfig,
}));

vi.mock("../src/connectors/registry.ts", () => ({
  createConnectorRegistry: () => ({
    glean: {
      backend: "direct-api",
      description: "Glean fixture",
      discoverLiveTools: mocks.discoverLiveTools,
      displayName: "Glean",
      id: "glean",
      ingest: vi.fn(),
      posture: "hybrid",
      requiredEnv: [],
    },
  }),
  isConnectorId: (value: string) => value === "glean",
}));

import { runOpenWikiExploration } from "../src/exploration.ts";

const originalOpenWikiHome = process.env.OPENWIKI_HOME;
let openWikiHome: string;

beforeEach(async () => {
  vi.clearAllMocks();
  openWikiHome = await mkdtemp(
    path.join(tmpdir(), "openwiki-exploration-run-"),
  );
  process.env.OPENWIKI_HOME = openWikiHome;
  mocks.readConfig.mockResolvedValue({
    sourceInstances: [
      {
        connectedAt: "2026-07-01T00:00:00.000Z",
        connectorId: "glean",
        id: "glean-primary",
      },
    ],
    sources: {},
    version: 1,
  });
  mocks.discoverLiveTools.mockResolvedValue({
    connectorId: "glean",
    ledgerEvents: [
      {
        status: "none",
        type: "watermark",
        watermark: "2026-07-14T10:00:00.000Z",
      },
    ],
    message: "Probed fixture tools.",
    rawFiles: [],
    runId: "explore-run-1",
    statePath: "~/.openwiki/connectors/glean/state.json",
    status: "success",
    warnings: [],
  });
  mocks.runAgent.mockResolvedValue({ command: "update", model: "fixture" });
});

afterEach(async () => {
  if (originalOpenWikiHome === undefined) {
    delete process.env.OPENWIKI_HOME;
  } else {
    process.env.OPENWIKI_HOME = originalOpenWikiHome;
  }
  await rm(openWikiHome, { force: true, recursive: true });
});

describe("runOpenWikiExploration", () => {
  test("writes the discovery Run Ledger into the Brain Wiki", async () => {
    await expect(
      runOpenWikiExploration("ignored", { target: "glean" }),
    ).resolves.toMatchObject({
      results: [{ connectorId: "glean", status: "agent-updated" }],
    });

    await expect(
      readFile(
        path.join(openWikiHome, "wiki", "sources", "glean-run-ledger.md"),
        "utf8",
      ),
    ).resolves.toContain("## Run explore-run-1 — explore — success");
  });
});
