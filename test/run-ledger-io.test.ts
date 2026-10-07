import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { OpenWikiLocalShellBackend } from "../src/agent/docs-only-backend.ts";
import {
  createRunLedgerDescription,
  type RunLedger,
} from "../src/connectors/run-ledger.ts";
import {
  OPENWIKI_GENERATED_FIELD,
  parseFrontmatterFields,
  splitFrontmatter,
  validateOkfFrontmatter,
} from "../src/okf/frontmatter.ts";
import {
  migrateWikiToOkf,
  synchronizeWikiIndexes,
} from "../src/okf/index-sync.ts";
import { openWikiLocalWikiDir } from "../src/openwiki-home.ts";
import {
  buildRunLedgerFromResult,
  createRunLedgerEscalationRecorder,
  getRunLedgerPath,
  writeRunLedger,
  writeRunLedgerBestEffort,
} from "../src/run-ledger-io.ts";
import { useTempOpenWikiHome } from "./support/temp-openwiki-home.ts";

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
  openWikiHome = await useTempOpenWikiHome("openwiki-ledger-");
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

describe("a written Run Ledger as a Concept Page", () => {
  function wikiBackend(): OpenWikiLocalShellBackend {
    return new OpenWikiLocalShellBackend({
      docsOnly: true,
      outputMode: "local-wiki",
      rootDir: openWikiLocalWikiDir,
      virtualMode: true,
    });
  }

  test("passes upstream's front-matter validator after every write", async () => {
    const filePath = await writeRunLedger(ledger("run-1"));
    expect(validateOkfFrontmatter(await readFile(filePath, "utf8"))).toEqual({
      valid: true,
    });

    await writeRunLedger(ledger("run-2"));
    expect(validateOkfFrontmatter(await readFile(filePath, "utf8"))).toEqual({
      valid: true,
    });
  });

  test("keeps its front matter byte-identical across written runs", async () => {
    const filePath = await writeRunLedger(ledger("run-1"));
    const first = await readFile(filePath, "utf8");
    const frontMatter = first.slice(
      0,
      first.length - splitFrontmatter(first).body.length,
    );

    for (const runId of ["run-2", "run-3", "run-1"]) {
      await writeRunLedger(ledger(runId));
      expect((await readFile(filePath, "utf8")).startsWith(frontMatter)).toBe(
        true,
      );
    }
    expect(frontMatter).toContain(`${OPENWIKI_GENERATED_FIELD}: true`);
  });

  test("the page-format migration changes nothing", async () => {
    await writeRunLedger(ledger("run-1"));
    const filePath = await writeRunLedger(ledger("run-2"));
    const before = await readFile(filePath, "utf8");

    await migrateWikiToOkf(wikiBackend(), "local-wiki");

    expect(await readFile(filePath, "utf8")).toBe(before);
  });

  test("a page from an older run without front matter gains it once", async () => {
    const filePath = await writeRunLedger(ledger("run-1"));
    const modern = await readFile(filePath, "utf8");
    await writeFile(
      filePath,
      splitFrontmatter(modern).body.replace(/^\n/u, ""),
    );

    await writeRunLedger(ledger("run-2"));
    const migrated = await readFile(filePath, "utf8");
    await migrateWikiToOkf(wikiBackend(), "local-wiki");

    expect(validateOkfFrontmatter(migrated)).toEqual({ valid: true });
    expect(migrated).toContain("## Run run-1 ");
    expect(migrated).toContain("## Run run-2 ");
    expect(await readFile(filePath, "utf8")).toBe(migrated);
  });

  async function writeLegacyLedger(
    connectorId: string,
    runIds: string[],
  ): Promise<string> {
    let filePath = "";
    for (const runId of runIds) {
      filePath = await writeRunLedger({ ...ledger(runId), connectorId });
    }
    const modern = await readFile(filePath, "utf8");
    await writeFile(
      filePath,
      splitFrontmatter(modern).body.replace(/^\n/u, ""),
    );
    return filePath;
  }

  test("a legacy page the migration stamped first still ends on the authored block", async () => {
    const filePath = await writeLegacyLedger("glean", ["run-1", "run-2"]);

    await migrateWikiToOkf(wikiBackend(), "local-wiki");
    const stamped = await readFile(filePath, "utf8");
    expect(parseFrontmatterFields(stamped)).toMatchObject({
      type: "Reference",
      [OPENWIKI_GENERATED_FIELD]: true,
    });

    await writeRunLedger(ledger("run-3"));
    const page = await readFile(filePath, "utf8");

    expect(validateOkfFrontmatter(page)).toEqual({ valid: true });
    expect(parseFrontmatterFields(page)).toMatchObject({
      description: createRunLedgerDescription("glean"),
      title: "Glean Run Ledger",
      type: "Run Ledger",
    });
    for (const runId of ["run-1", "run-2", "run-3"]) {
      expect(page).toContain(`## Run ${runId} `);
    }
    await migrateWikiToOkf(wikiBackend(), "local-wiki");
    expect(await readFile(filePath, "utf8")).toBe(page);
  });

  test("two legacy ledgers end authored when the migration runs between their writes", async () => {
    const gleanPath = await writeLegacyLedger("glean", ["run-1", "run-2"]);
    const slackPath = await writeLegacyLedger("slack", ["run-1", "run-2"]);

    // Ingestion order: ledger 1, then the agent run (migration sweeps the whole
    // wiki), then ledger 2.
    await writeRunLedger(ledger("run-3"));
    await migrateWikiToOkf(wikiBackend(), "local-wiki");
    await writeRunLedger({ ...ledger("run-3"), connectorId: "slack" });
    await synchronizeWikiIndexes(wikiBackend(), "local-wiki");

    const index = await readFile(
      path.join(path.dirname(gleanPath), "index.md"),
      "utf8",
    );
    for (const [filePath, connector, name] of [
      [gleanPath, "glean", "Glean"],
      [slackPath, "slack", "Slack"],
    ] as const) {
      const page = await readFile(filePath, "utf8");
      expect(validateOkfFrontmatter(page)).toEqual({ valid: true });
      expect(parseFrontmatterFields(page)).toMatchObject({
        description: createRunLedgerDescription(connector),
        type: "Run Ledger",
      });
      for (const runId of ["run-1", "run-2", "run-3"]) {
        expect(page).toContain(`## Run ${runId} `);
      }
      expect(index).toContain(
        `- [${name} Run Ledger](${connector}-run-ledger.md) - ${createRunLedgerDescription(connector)}`,
      );
    }
  });

  test("the directory's Wiki Index lists it with its authored description", async () => {
    const filePath = await writeRunLedger(ledger("run-1"));
    const before = await readFile(filePath, "utf8");

    await synchronizeWikiIndexes(wikiBackend(), "local-wiki");

    const index = await readFile(
      path.join(path.dirname(filePath), "index.md"),
      "utf8",
    );
    const description = createRunLedgerDescription("glean");
    expect(parseFrontmatterFields(before)?.description).toBe(description);
    expect(index).toContain(
      `- [Glean Run Ledger](glean-run-ledger.md) - ${description}`,
    );
    expect(await readFile(filePath, "utf8")).toBe(before);
  });

  test("a foreign page at the ledger path stays beside the new ledger", async () => {
    const filePath = getRunLedgerPath("glean");
    await mkdir(path.dirname(filePath), { recursive: true });
    const foreign = "# Notes\n\nOwner text.\n";
    await writeFile(filePath, foreign);

    await writeRunLedger(ledger("run-1"));
    const page = await readFile(filePath, "utf8");

    expect(validateOkfFrontmatter(page)).toEqual({ valid: true });
    expect(page.endsWith(foreign)).toBe(true);
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
