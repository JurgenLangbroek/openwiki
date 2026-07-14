import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  gleanBackfill: vi.fn(),
  readConfig: vi.fn(),
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
      backfill: mocks.gleanBackfill,
      description: "Glean fixture",
      displayName: "Glean",
      id: "glean",
      ingest: vi.fn(),
      posture: "hybrid",
      requiredEnv: [],
    },
    slack: {
      backend: "direct-api",
      description: "Slack fixture",
      displayName: "Slack",
      id: "slack",
      ingest: vi.fn(),
      posture: "deterministic",
      requiredEnv: [],
    },
  }),
  isConnectorId: (value: string) => value === "glean" || value === "slack",
}));

import { runOpenWikiBackfill } from "../src/backfill.ts";

const originalOpenWikiHome = process.env.OPENWIKI_HOME;
let openWikiHome: string;

beforeEach(async () => {
  vi.clearAllMocks();
  openWikiHome = await mkdtemp(path.join(tmpdir(), "openwiki-backfill-run-"));
  process.env.OPENWIKI_HOME = openWikiHome;
  mocks.readConfig.mockResolvedValue({
    sourceInstances: [
      {
        connectedAt: "2026-07-01T00:00:00.000Z",
        connectorConfig: { instance: "acme" },
        connectorId: "glean",
        id: "glean-primary",
        name: "Work Glean",
      },
      {
        connectedAt: "2026-07-01T00:00:00.000Z",
        connectorId: "slack",
        id: "slack-primary",
      },
    ],
    sources: {},
    version: 1,
  });
  mocks.gleanBackfill.mockResolvedValue({
    connectorId: "glean",
    message:
      "Backfill walked 4 slice(s), pulled 2 item(s); history reaches back to 2026-06-04.",
    rawFiles: ["/tmp/backfill-slice-0001.json"],
    runId: "run-1",
    statePath: "~/.openwiki/connectors/glean/state.json",
    status: "success",
    warnings: [],
  });
});

afterEach(async () => {
  if (originalOpenWikiHome === undefined) {
    delete process.env.OPENWIKI_HOME;
  } else {
    process.env.OPENWIKI_HOME = originalOpenWikiHome;
  }
  await rm(openWikiHome, { force: true, recursive: true });
});

describe("runOpenWikiBackfill", () => {
  test("runs supported sources and skips connectors without Backfill", async () => {
    const text: string[] = [];

    const result = await runOpenWikiBackfill("ignored", {
      onEvent: (event) => {
        if (event.type === "text") text.push(event.text);
      },
      target: "all",
    });

    expect(result.results).toMatchObject([
      {
        connectorId: "glean",
        displayName: "Work Glean",
        rawFiles: ["/tmp/backfill-slice-0001.json"],
        sourceInstanceId: "glean-primary",
        status: "success",
      },
      {
        connectorId: "slack",
        displayName: "Slack",
        rawFiles: [],
        sourceInstanceId: "slack-primary",
        status: "skipped",
      },
    ]);
    expect(mocks.gleanBackfill).toHaveBeenCalledWith({
      connectorConfig: { instance: "acme" },
      instanceId: "glean-primary",
    });
    expect(text.join(" ")).toMatch(/Starting Work Glean Backfill/iu);
    expect(text.join(" ")).toMatch(/Slack does not support backfill/iu);
    await expect(
      readFile(
        path.join(openWikiHome, "wiki", "sources", "glean-run-ledger.md"),
        "utf8",
      ),
    ).resolves.toContain("## Run run-1 — backfill — success");
  });

  test("rejects a non-all target with no configured match", async () => {
    await expect(
      runOpenWikiBackfill("ignored", {
        target: { id: "web-search-2", kind: "source-instance" },
      }),
    ).rejects.toThrow("No configured ingestion source matched web-search-2.");
  });
});
