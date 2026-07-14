import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { RunLedger } from "../src/connectors/run-ledger.ts";
import {
  buildRunLedgerFromResult,
  createRunLedgerEscalationRecorder,
  getRunLedgerPath,
  writeRunLedger,
  writeRunLedgerBestEffort,
} from "../src/run-ledger-io.ts";

const originalOpenWikiHome = process.env.OPENWIKI_HOME;
let openWikiHome: string;

function ledger(runId: string): RunLedger {
  return {
    connectorId: "glean",
    events: [],
    message: `Completed ${runId}.`,
    mode: "ingest",
    runId,
    startedAt: "2026-07-14T10:00:00.000Z",
    status: "success",
  };
}

beforeEach(async () => {
  openWikiHome = await mkdtemp(path.join(tmpdir(), "openwiki-ledger-"));
  process.env.OPENWIKI_HOME = openWikiHome;
});

afterEach(async () => {
  if (originalOpenWikiHome === undefined) {
    delete process.env.OPENWIKI_HOME;
  } else {
    process.env.OPENWIKI_HOME = originalOpenWikiHome;
  }
  await rm(openWikiHome, { force: true, recursive: true });
});

describe("writeRunLedger", () => {
  test("creates the source page and keeps subsequent runs newest-first", async () => {
    expect(getRunLedgerPath("glean")).toBe(
      path.join(openWikiHome, "wiki", "sources", "glean-run-ledger.md"),
    );

    const firstPath = await writeRunLedger(ledger("run-1"));
    const secondPath = await writeRunLedger(ledger("run-2"));
    const page = await readFile(secondPath, "utf8");

    expect(firstPath).toBe(secondPath);
    expect(secondPath).toBe(
      path.join(openWikiHome, "wiki", "sources", "glean-run-ledger.md"),
    );
    expect(page.indexOf("## Run run-2")).toBeLessThan(
      page.indexOf("## Run run-1"),
    );
  });
});

describe("buildRunLedgerFromResult", () => {
  test("synthesizes warning and watermark events when a connector has none", () => {
    expect(
      buildRunLedgerFromResult({
        connectorId: "glean",
        fallbackMessage: "No Pull result.",
        fallbackRunId: "fallback-run",
        mode: "explore",
        result: {
          connectorId: "glean",
          message: "Discovery was skipped.",
          rawFiles: [],
          runId: "discovery-run",
          statePath: "~/.openwiki/connectors/glean/state.json",
          status: "skipped",
          warnings: ["Gateway was unavailable."],
        },
        startedAt: "2026-07-14T10:00:00.000Z",
      }),
    ).toEqual({
      connectorId: "glean",
      events: [
        {
          status: "none",
          type: "watermark",
          watermark: "2026-07-14T10:00:00.000Z",
        },
        { message: "Gateway was unavailable.", type: "warning" },
      ],
      message: "Discovery was skipped.",
      mode: "explore",
      runId: "discovery-run",
      startedAt: "2026-07-14T10:00:00.000Z",
      status: "skipped",
    });
  });

  test("turns thrown-run context into an error ledger", () => {
    expect(
      buildRunLedgerFromResult({
        connectorId: "slack",
        errorMessage: "Slack Pull threw: offline",
        fallbackMessage: "No Pull result.",
        fallbackRunId: "fallback-run",
        mode: "ingest",
        startedAt: "2026-07-14T10:00:00.000Z",
      }),
    ).toMatchObject({
      message: "Slack Pull threw: offline",
      runId: "fallback-run",
      status: "error",
    });
  });

  test("appends escalations after connector-provided ledger events", () => {
    const built = buildRunLedgerFromResult({
      connectorId: "glean",
      escalationEvents: [
        {
          outcome: "ok",
          serverId: "jira-primary",
          toolName: "JIRA_GET_ISSUE",
          type: "escalation",
        },
      ],
      fallbackMessage: "No Pull result.",
      fallbackRunId: "fallback-run",
      mode: "ingest",
      result: {
        connectorId: "glean",
        ledgerEvents: [
          {
            counts: { deduplicated: 0, fetched: 1, new: 1 },
            stream: "feed",
            type: "pull",
          },
        ],
        message: "Pulled evidence.",
        rawFiles: [],
        runId: "pull-run",
        statePath: "~/.openwiki/connectors/glean/state.json",
        status: "success",
        warnings: [],
      },
      startedAt: "2026-07-14T10:00:00.000Z",
    });

    expect(built.events.map((event) => event.type)).toEqual([
      "pull",
      "escalation",
    ]);
  });
});

describe("writeRunLedgerBestEffort", () => {
  test("reports write failures without rejecting the run", async () => {
    await writeFile(path.join(openWikiHome, "wiki"), "not a directory");
    const errors: string[] = [];

    await expect(
      writeRunLedgerBestEffort({
        connectorId: "glean",
        displayName: "Glean",
        fallbackMessage: "No Pull result.",
        fallbackRunId: "fallback-run",
        mode: "ingest",
        onError: (message) => errors.push(message),
        startedAt: "2026-07-14T10:00:00.000Z",
      }),
    ).resolves.toBeUndefined();
    expect(errors).toEqual([
      expect.stringMatching(/^Glean Run Ledger write failed:/u),
    ]);
  });
});

describe("createRunLedgerEscalationRecorder", () => {
  test("skips empty flushes and writes recorded escalations", async () => {
    const recorder = createRunLedgerEscalationRecorder();
    const input = {
      connectorId: "glean" as const,
      displayName: "Glean",
      fallbackMessage: "No Pull result.",
      fallbackRunId: "escalation-run",
      mode: "explore" as const,
      onError: () => undefined,
      startedAt: "2026-07-14T10:00:00.000Z",
    };

    await recorder.flush(input);
    await expect(readFile(getRunLedgerPath("glean"), "utf8")).rejects.toThrow(
      /ENOENT/u,
    );

    recorder.record({
      outcome: "ok",
      serverId: "jira-primary",
      toolName: "JIRA_GET_ISSUE",
      type: "escalation",
    });
    await recorder.flush(input);

    await expect(
      readFile(getRunLedgerPath("glean"), "utf8"),
    ).resolves.toContain("- JIRA_GET_ISSUE on jira-primary — ok");
  });
});
