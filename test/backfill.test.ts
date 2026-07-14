import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  gleanBackfill: vi.fn(),
  readConfig: vi.fn(),
  runAgent: vi.fn(),
}));

vi.mock("../src/agent/index.ts", () => ({
  createOpenWikiThreadId: () => "backfill-thread",
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
import {
  readConnectorState,
  writeConnectorState,
  writeRawJson,
} from "../src/connectors/io.ts";

const originalOpenWikiHome = process.env.OPENWIKI_HOME;
let openWikiHome: string;

beforeEach(async () => {
  vi.clearAllMocks();
  openWikiHome = await mkdtemp(path.join(tmpdir(), "openwiki-backfill-run-"));
  process.env.OPENWIKI_HOME = openWikiHome;
  mocks.runAgent.mockResolvedValue({ command: "update", model: "fixture" });
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
  test("synthesizes shaped slice history oldest first and stamps the run", async () => {
    const runId = "run-synthesis";
    const newerSlice = await writeRawJson(
      "glean",
      runId,
      "backfill-slice-0001.json",
      {
        fetchedAt: "2026-07-01T00:00:00.000Z",
        messages: { items: [], stream: "messages" },
        myWork: {
          items: [
            {
              id: "newest",
              title: "Newest event",
              updatedAt: "2026-05-01T00:00:00.000Z",
              url: "https://glean.example/newest",
            },
          ],
          stream: "my-work",
        },
        sliceNumber: 1,
      },
    );
    const probe = await writeRawJson("glean", runId, "probe.json", {
      sliceNumber: 99,
      tools: [{ name: "search" }],
    });
    const olderSlice = await writeRawJson(
      "glean",
      runId,
      "backfill-slice-0002.json",
      {
        expanded: {
          items: [
            {
              content: "O".repeat(50_000),
              id: "oldest",
              sourceStream: "my-work",
              tier: "document",
              title: "Expanded oldest event",
              url: "https://glean.example/oldest",
            },
            {
              content: "M".repeat(50_000),
              id: "middle",
              sourceStream: "messages",
              tier: "document",
            },
            {
              content: "Unmatched historical evidence",
              id: "expanded-only",
              sourceStream: "expanded",
              tier: "document",
            },
          ],
          stream: "expanded",
        },
        fetchedAt: "2026-07-01T00:00:00.000Z",
        messages: {
          items: [
            {
              createdAt: "2026-04-12T00:00:00.000Z",
              id: "middle",
              url: "https://glean.example/middle",
            },
          ],
          stream: "messages",
        },
        myWork: {
          items: [
            {
              id: "oldest",
              updatedAt: "2026-03-01T00:00:00.000Z",
            },
          ],
          stream: "my-work",
        },
        sliceNumber: 2,
      },
    );
    const rawFiles = [newerSlice, probe, olderSlice];
    await writeConnectorState("glean", {
      runs: [
        {
          at: "2026-07-01T00:00:00.000Z",
          rawFiles,
          runId,
          status: "success",
          warnings: [],
        },
      ],
      version: 1,
    });
    mocks.gleanBackfill.mockResolvedValue({
      connectorId: "glean",
      message: "Backfill pulled historical evidence.",
      rawFiles,
      runId,
      statePath: "~/.openwiki/connectors/glean/state.json",
      status: "success",
      warnings: [],
    });

    const result = await runOpenWikiBackfill("ignored", { target: "glean" });

    expect(result.results[0]).toMatchObject({
      status: "success",
      synthesis: {
        chunkCount: 2,
        itemCount: 4,
        status: "synthesized",
      },
    });
    expect(mocks.runAgent).toHaveBeenCalledTimes(2);
    const userMessages = mocks.runAgent.mock.calls.map(
      (call) => (call[2] as { userMessage: string }).userMessage,
    );
    expect(userMessages[0]).toMatch(
      /chunk 1 of 2.*2026-03-01T00:00:00\.000Z.*2026-03-01T00:00:00\.000Z/isu,
    );
    expect(userMessages[1]).toMatch(
      /chunk 2 of 2.*2026-04-12T00:00:00\.000Z.*2026-05-01T00:00:00\.000Z/isu,
    );

    const rawDir = path.join(openWikiHome, "connectors", "glean", "raw", runId);
    expect(
      (await readdir(rawDir)).filter((filename) =>
        filename.startsWith("synthesis-chunk-"),
      ),
    ).toEqual(["synthesis-chunk-0001.json", "synthesis-chunk-0002.json"]);
    const oldestChunk = JSON.parse(
      await readFile(path.join(rawDir, "synthesis-chunk-0001.json"), "utf8"),
    ) as { items: Record<string, unknown>[] };
    expect(oldestChunk.items[0]).toMatchObject({
      content: "O".repeat(50_000),
      id: "oldest",
      title: "Expanded oldest event",
      url: "https://glean.example/oldest",
    });
    const state = JSON.parse(
      await readFile(
        path.join(openWikiHome, "connectors", "glean", "state.json"),
        "utf8",
      ),
    ) as { runs: { synthesizedAt?: string }[] };
    expect(state.runs[0]?.synthesizedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
  });

  test("recovers prior unsynthesized slices and stamps only runs whose history was processed", async () => {
    const currentRunId = "run-current";
    const priorRunId = "run-prior";
    const probeRunId = "run-probe-only";
    const currentSlice = await writeRawJson(
      "glean",
      currentRunId,
      "backfill-slice-0001.json",
      {
        messages: { items: [], stream: "messages" },
        myWork: {
          items: [
            {
              id: "current-item",
              updatedAt: "2026-02-01T00:00:00.000Z",
            },
          ],
          stream: "my-work",
        },
        sliceNumber: 1,
      },
    );
    const priorSlice = await writeRawJson(
      "glean",
      priorRunId,
      "backfill-slice-0001.json",
      {
        messages: {
          items: [
            {
              id: "prior-item",
              updatedAt: "2026-01-01T00:00:00.000Z",
            },
          ],
          stream: "messages",
        },
        myWork: { items: [], stream: "my-work" },
        sliceNumber: 1,
      },
    );
    const probe = await writeRawJson("glean", probeRunId, "probe.json", {
      tools: [{ name: "search" }],
    });
    await writeConnectorState("glean", {
      runs: [
        {
          at: "2026-07-02T00:00:00.000Z",
          rawFiles: [currentSlice],
          runId: currentRunId,
          status: "success",
          warnings: [],
        },
        {
          at: "2026-07-01T00:00:00.000Z",
          rawFiles: [priorSlice],
          runId: priorRunId,
          status: "success",
          warnings: [],
        },
        {
          at: "2026-06-30T00:00:00.000Z",
          rawFiles: [probe],
          runId: probeRunId,
          status: "success",
          warnings: [],
        },
      ],
      version: 1,
    });
    mocks.gleanBackfill.mockResolvedValue({
      connectorId: "glean",
      message: "Backfill pulled current historical evidence.",
      rawFiles: [currentSlice],
      runId: currentRunId,
      statePath: "~/.openwiki/connectors/glean/state.json",
      status: "success",
      warnings: [],
    });
    const text: string[] = [];

    const result = await runOpenWikiBackfill("ignored", {
      onEvent: (event) => {
        if (event.type === "text") text.push(event.text);
      },
      target: "glean",
    });

    expect(result.results[0]).toMatchObject({
      synthesis: {
        chunkCount: 1,
        itemCount: 2,
        status: "synthesized",
      },
    });
    expect(text.join(" ")).toContain(
      "Recovering 1 unsynthesized prior backfill run(s).",
    );
    const userMessage = (
      mocks.runAgent.mock.calls[0]?.[2] as { userMessage: string }
    ).userMessage;
    expect(userMessage).toMatch(
      /2026-01-01T00:00:00\.000Z.*2026-02-01T00:00:00\.000Z/isu,
    );
    const synthesisChunk = JSON.parse(
      await readFile(
        path.join(
          openWikiHome,
          "connectors",
          "glean",
          "raw",
          currentRunId,
          "synthesis-chunk-0001.json",
        ),
        "utf8",
      ),
    ) as { items: { id?: string }[] };
    expect(synthesisChunk.items.map((item) => item.id)).toEqual([
      "prior-item",
      "current-item",
    ]);
    const state = await readConnectorState("glean");
    expect(
      state.runs?.find((run) => run.runId === currentRunId)?.synthesizedAt,
    ).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
    expect(
      state.runs?.find((run) => run.runId === priorRunId)?.synthesizedAt,
    ).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
    expect(
      state.runs?.find((run) => run.runId === probeRunId),
    ).not.toHaveProperty("synthesizedAt");
  });

  test("does not synthesize a failed pull even when it reports raw artifacts", async () => {
    mocks.gleanBackfill.mockResolvedValue({
      connectorId: "glean",
      message: "Backfill stopped after a stream failure.",
      rawFiles: ["/tmp/partial-backfill-slice.json"],
      runId: "failed-pull",
      statePath: "~/.openwiki/connectors/glean/state.json",
      status: "error",
      warnings: [],
    });

    const result = await runOpenWikiBackfill("ignored", { target: "glean" });

    expect(result.results[0]).toMatchObject({
      status: "error",
    });
    expect(result.results[0]).not.toHaveProperty("synthesis");
    expect(mocks.runAgent).not.toHaveBeenCalled();
  });

  test("returns a synthesis error and leaves the run unstamped when the agent fails", async () => {
    const runId = "run-agent-error";
    const priorRunId = "run-prior-agent-error";
    const slice = await writeRawJson(
      "glean",
      runId,
      "backfill-slice-0001.json",
      {
        messages: { items: [], stream: "messages" },
        myWork: {
          items: [
            {
              id: "historical-item",
              updatedAt: "2026-01-01T00:00:00.000Z",
            },
          ],
          stream: "my-work",
        },
        sliceNumber: 1,
      },
    );
    const priorSlice = await writeRawJson(
      "glean",
      priorRunId,
      "backfill-slice-0001.json",
      {
        messages: {
          items: [
            {
              id: "prior-historical-item",
              updatedAt: "2025-12-01T00:00:00.000Z",
            },
          ],
          stream: "messages",
        },
        myWork: { items: [], stream: "my-work" },
        sliceNumber: 1,
      },
    );
    await writeConnectorState("glean", {
      runs: [
        {
          at: "2026-07-01T00:00:00.000Z",
          rawFiles: [slice],
          runId,
          status: "success",
          warnings: [],
        },
        {
          at: "2026-06-30T00:00:00.000Z",
          rawFiles: [priorSlice],
          runId: priorRunId,
          status: "success",
          warnings: [],
        },
      ],
      version: 1,
    });
    mocks.gleanBackfill.mockResolvedValue({
      connectorId: "glean",
      message: "Backfill pulled one historical item.",
      rawFiles: [slice],
      runId,
      statePath: "~/.openwiki/connectors/glean/state.json",
      status: "success",
      warnings: [],
    });
    mocks.runAgent.mockRejectedValue(new Error("agent unavailable"));

    const result = await runOpenWikiBackfill("ignored", { target: "glean" });

    expect(result.results[0]).toMatchObject({
      backfillPull: { status: "success" },
      status: "error",
      synthesis: {
        chunkCount: 1,
        itemCount: 2,
        message: "agent unavailable",
        status: "error",
      },
    });
    const state = await readConnectorState("glean");
    expect(state.runs?.find((run) => run.runId === runId)).not.toHaveProperty(
      "synthesizedAt",
    );
    expect(
      state.runs?.find((run) => run.runId === priorRunId),
    ).not.toHaveProperty("synthesizedAt");
  });

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
        synthesis: {
          chunkCount: 0,
          itemCount: 0,
          status: "skipped",
        },
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
