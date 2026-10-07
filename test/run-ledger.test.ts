import { describe, expect, test } from "vitest";
import {
  renderRunLedgerSection,
  type RunLedger,
  upsertRunLedgerSection,
} from "../src/connectors/run-ledger.ts";
import {
  OPENWIKI_GENERATED_FIELD,
  parseFrontmatterFields,
  splitFrontmatter,
  validateOkfFrontmatter,
} from "../src/okf/frontmatter.ts";

function ledger(overrides: Partial<RunLedger> = {}): RunLedger {
  return {
    connectorId: "glean",
    events: [],
    message: "Pulled Glean evidence.",
    mode: "ingest",
    runId: "run-1",
    startedAt: "2026-07-14T10:00:00.000Z",
    status: "success",
    ...overrides,
  };
}

describe("renderRunLedgerSection", () => {
  test("renders standing and sliced Pulls, stream errors, and empty Pulls", () => {
    const rendered = renderRunLedgerSection(
      ledger({
        events: [
          {
            counts: { deduplicated: 2, fetched: 8, new: 6 },
            stream: "feed",
            type: "pull",
          },
          {
            counts: { deduplicated: 0, fetched: 4, new: 4 },
            slice: {
              number: 2,
              sinceDate: "2026-05-01",
              untilDate: "2026-05-31",
            },
            stream: "my-work",
            type: "pull",
          },
          {
            counts: { deduplicated: 0, fetched: 0, new: 0 },
            error: "tenant search unavailable",
            slice: { number: 2, sinceDate: "2026-05-01" },
            stream: "messages",
            type: "pull",
          },
        ],
      }),
    );

    expect(rendered).toContain("| — | — | feed | 8 | 6 | 2 |  |");
    expect(rendered).toContain(
      "| 2 | 2026-05-01 → 2026-05-31 | my-work | 4 | 4 | 0 |  |",
    );
    expect(rendered).toContain(
      "| 2 | 2026-05-01 → — | messages | 0 | 0 | 0 | tenant search unavailable |",
    );
    expect(renderRunLedgerSection(ledger())).toContain(
      "No Pull events recorded for this run.",
    );
  });

  test("summarizes Content Expansion and renders every outcome", () => {
    const rendered = renderRunLedgerSection(
      ledger({
        events: [
          {
            id: "failed-1",
            outcome: "failed",
            reason: "permission denied",
            sourceStream: "my-work",
            title: "Restricted plan",
            type: "expansion",
            url: "https://app.glean.com/go/failed-1",
          },
          {
            id: "ok-1",
            outcome: "ok",
            sourceStream: "messages",
            title: "Launch thread",
            type: "expansion",
            url: "https://app.glean.com/go/ok-1",
          },
          {
            id: "seen-1",
            outcome: "skipped",
            reason: "already expanded in a prior run",
            sourceStream: "expanded",
            type: "expansion",
          },
          {
            id: "seen-2",
            outcome: "skipped",
            reason: "already expanded in a prior run",
            sourceStream: "expanded",
            type: "expansion",
          },
          {
            id: "unsupported-1",
            outcome: "skipped",
            reason: "unsupported datasource",
            sourceStream: "expanded",
            type: "expansion",
          },
        ],
      }),
    );

    expect(rendered).toContain("ok 1 · failed 1 · skipped 3");
    expect(rendered).toContain(
      "- FAILED [Restricted plan](https://app.glean.com/go/failed-1) (my-work) — permission denied",
    );
    expect(rendered).toContain(
      "- ok [Launch thread](https://app.glean.com/go/ok-1) (messages)",
    );
    expect(rendered).toContain("- skipped 2 — already expanded in a prior run");
    expect(rendered).toContain("- skipped 1 — unsupported datasource");
  });

  test("renders aggregate deduplicated candidates as one skipped outcome", () => {
    const rendered = renderRunLedgerSection(
      ledger({
        events: [
          {
            count: 5,
            id: "previously-expanded-candidates",
            outcome: "skipped",
            reason: "already expanded in a prior run",
            sourceStream: "expanded",
            type: "expansion",
          },
        ],
      }),
    );

    expect(rendered).toContain("ok 0 · failed 0 · skipped 5");
    expect(rendered).toContain(
      "- skipped — already expanded in a prior run (5 candidates)",
    );
  });

  test("does not infer skipped counts from document ids", () => {
    const rendered = renderRunLedgerSection(
      ledger({
        events: [
          {
            id: "5 candidates",
            outcome: "skipped",
            reason: "unsupported datasource",
            sourceStream: "expanded",
            type: "expansion",
          },
        ],
      }),
    );

    expect(rendered).toContain("ok 0 · failed 0 · skipped 1");
    expect(rendered).toContain("- skipped 1 — unsupported datasource");
  });

  test("makes an all-failed Content Expansion run impossible to miss", () => {
    const failures = Array.from({ length: 20 }, (_, index) => ({
      id: `document-${index + 1}`,
      outcome: "failed" as const,
      reason: "index read unavailable",
      sourceStream: "my-work",
      type: "expansion" as const,
    }));

    expect(renderRunLedgerSection(ledger({ events: failures }))).toContain(
      "> ⚠️ ALERT: all 20 Content Expansion attempts failed — the wiki gained no document content this run.",
    );

    const mixed = [
      ...failures.slice(0, 3),
      ...Array.from({ length: 17 }, (_, index) => ({
        id: `expanded-${index + 1}`,
        outcome: "ok" as const,
        sourceStream: "messages",
        type: "expansion" as const,
      })),
    ];
    expect(renderRunLedgerSection(ledger({ events: mixed }))).not.toContain(
      "⚠️ ALERT",
    );

    const entirePullFailure = renderRunLedgerSection(
      ledger({
        events: [
          {
            id: "(entire expansion pull)",
            outcome: "failed",
            reason: "expansion pipeline unavailable",
            sourceStream: "expanded",
            type: "expansion",
          },
        ],
      }),
    );
    expect(entirePullFailure).toContain(
      "> ⚠️ ALERT: all 1 Content Expansion attempts failed — the wiki gained no document content this run.",
    );
    expect(entirePullFailure).toContain(
      "- FAILED (entire expansion pull) (expanded) — expansion pipeline unavailable",
    );
  });

  test("renders Escalations and the empty state", () => {
    const rendered = renderRunLedgerSection(
      ledger({
        events: [
          {
            outcome: "ok",
            serverId: "gateway",
            target: "JIRA-36",
            toolName: "jira_get_issue",
            type: "escalation",
          },
          {
            outcome: "failed",
            reason: "document was deleted",
            serverId: "gateway",
            target: "Launch brief",
            toolName: "drive_get_document",
            type: "escalation",
          },
        ],
      }),
    );

    expect(rendered).toContain("- jira_get_issue on gateway — JIRA-36 — ok");
    expect(rendered).toContain(
      "- drive_get_document on gateway — Launch brief — FAILED (document was deleted)",
    );
    expect(renderRunLedgerSection(ledger())).toContain(
      "No Escalations in this run.",
    );
  });

  test("renders the latest walking, dry, and absent watermark", () => {
    expect(
      renderRunLedgerSection(
        ledger({
          events: [
            {
              status: "walking",
              type: "watermark",
              watermark: "2026-05-01T12:00:00.000Z",
            },
          ],
        }),
      ),
    ).toContain("History provably covered back to 2026-05-01 (walking).");
    expect(
      renderRunLedgerSection(
        ledger({
          events: [
            {
              status: "walking",
              type: "watermark",
              watermark: "2026-05-01",
            },
            {
              status: "dry",
              type: "watermark",
              watermark: "2026-04-01",
            },
          ],
        }),
      ),
    ).toContain("History provably covered back to 2026-04-01 (dry).");
    expect(
      renderRunLedgerSection(
        ledger({
          events: [
            {
              status: "none",
              type: "watermark",
              watermark: "2026-07-14T10:00:00.000Z",
            },
          ],
        }),
      ),
    ).toContain("No Backfill watermark recorded yet.");
    expect(renderRunLedgerSection(ledger())).toContain(
      "No Backfill watermark recorded yet.",
    );
  });

  test("renders error headings loudly and includes warnings only when present", () => {
    const rendered = renderRunLedgerSection(
      ledger({
        events: [{ message: "Feed was unavailable.", type: "warning" }],
        status: "error",
      }),
    );

    expect(rendered).toMatch(/^## Run run-1 — ingest — ERROR/mu);
    expect(rendered).toContain("### Warnings\n\n- Feed was unavailable.");
    expect(renderRunLedgerSection(ledger())).not.toContain("### Warnings");
  });
});

describe("upsertRunLedgerSection", () => {
  test("creates a fresh page with its fixed header", () => {
    const page = upsertRunLedgerSection(null, ledger());

    expect(splitFrontmatter(page).body).toMatch(
      /^\n# Glean Run Ledger\n\n_Machine-generated by OpenWiki runs\. Do not edit\._\n\n## Run run-1 — ingest — success/u,
    );
  });

  test("prepends new runs and round-trips its own output", () => {
    const first = upsertRunLedgerSection(null, ledger());
    const second = upsertRunLedgerSection(
      first,
      ledger({ runId: "run-2", startedAt: "2026-07-14T11:00:00.000Z" }),
    );

    expect(second.indexOf("## Run run-2")).toBeLessThan(
      second.indexOf("## Run run-1"),
    );
    expect(upsertRunLedgerSection(second, ledger({ runId: "run-2" }))).toBe(
      second.replace(
        "Started: 2026-07-14T11:00:00.000Z",
        "Started: 2026-07-14T10:00:00.000Z",
      ),
    );
  });

  test("replaces the same run in place without a duplicate", () => {
    const page = upsertRunLedgerSection(
      upsertRunLedgerSection(null, ledger()),
      ledger({ runId: "run-2" }),
    );
    const replaced = upsertRunLedgerSection(
      page,
      ledger({ message: "Replacement result.", runId: "run-1" }),
    );

    expect(replaced.match(/## Run run-1/gu)).toHaveLength(1);
    expect(replaced.indexOf("## Run run-2")).toBeLessThan(
      replaced.indexOf("## Run run-1"),
    );
    expect(replaced).toContain("Replacement result.");
  });

  test("retains only the newest configured number of runs", () => {
    let page: string | null = null;
    for (let run = 1; run <= 4; run += 1) {
      page = upsertRunLedgerSection(page, ledger({ runId: `run-${run}` }), {
        maxRuns: 3,
      });
    }

    expect(page).toContain("## Run run-4");
    expect(page).toContain("## Run run-3");
    expect(page).toContain("## Run run-2");
    expect(page).not.toContain("## Run run-1");
    expect(page).toContain(
      "_Older runs pruned: only the most recent 3 are kept on this page._",
    );

    const roundTripped = upsertRunLedgerSection(
      page,
      ledger({ runId: "run-5" }),
      { maxRuns: 3 },
    );
    expect(roundTripped).toContain("## Run run-5");
    expect(roundTripped).toContain("## Run run-4");
    expect(roundTripped).toContain("## Run run-3");
    expect(roundTripped).not.toContain("## Run run-2");
    expect(
      roundTripped.match(
        /_Older runs pruned: only the most recent 3 are kept on this page\._/gu,
      ),
    ).toHaveLength(1);

    const expandedRetention = upsertRunLedgerSection(
      roundTripped,
      ledger({ runId: "run-6" }),
      { maxRuns: 5 },
    );
    expect(expandedRetention).toContain(
      "_Older runs pruned: only the most recent 5 are kept on this page._",
    );
    expect(expandedRetention).not.toContain("most recent 3");
  });

  test("retains no sections when maxRuns is zero", () => {
    const page = upsertRunLedgerSection(null, ledger(), { maxRuns: 0 });

    expect(splitFrontmatter(page).body).toBe(
      "\n# Glean Run Ledger\n\n_Machine-generated by OpenWiki runs. Do not edit._\n\n_Older runs pruned: only the most recent 0 are kept on this page._\n",
    );
    expect(
      upsertRunLedgerSection(page, ledger({ runId: "run-2" }), { maxRuns: 0 }),
    ).toBe(page);
  });

  test("preserves foreign pages below the fresh Run Ledger", () => {
    const foreignPage = "# Notes\n\nOwner text.\n";
    const page = upsertRunLedgerSection(foreignPage, ledger());

    expect(page).toContain("# Glean Run Ledger");
    expect(page).toContain("## Run run-1 — ingest — success");
    expect(page).toContain(
      "_The previous content of this page could not be parsed as a Run Ledger and is preserved below._",
    );
    expect(page).toContain("\n---\n");
    expect(page.endsWith(foreignPage)).toBe(true);
  });

  test("round-trips free text that resembles a run heading", () => {
    const first = upsertRunLedgerSection(
      null,
      ledger({
        events: [
          {
            message:
              "warning first line\n## Run not-a-section — ingest — success",
            type: "warning",
          },
        ],
        message:
          "result first line\n## Run also-not-a-section — ingest — success",
      }),
    );
    const second = upsertRunLedgerSection(first, ledger({ runId: "run-2" }));

    expect(second).not.toContain(
      "The previous content of this page could not be parsed",
    );
    expect(second.match(/\n## Run /gu)).toHaveLength(2);
    expect(second).toContain(
      "result first line ## Run also-not-a-section — ingest — success",
    );
    expect(second).toContain(
      "warning first line ## Run not-a-section — ingest — success",
    );
  });
});

describe("Run Ledger front matter", () => {
  function frontMatterOf(page: string): string {
    const { body } = splitFrontmatter(page);
    return page.slice(0, page.length - body.length);
  }

  function runs(count: number): RunLedger[] {
    return Array.from({ length: count }, (_, index) =>
      ledger({ message: `Result ${index + 1}.`, runId: `run-${index + 1}` }),
    );
  }

  test("a first write carries type, title, an authored description, and the generated marker", () => {
    const page = upsertRunLedgerSection(null, ledger());
    const fields = parseFrontmatterFields(page);

    expect(page.startsWith("---\n")).toBe(true);
    expect(fields).toMatchObject({
      title: "Glean Run Ledger",
      type: "Run Ledger",
      [OPENWIKI_GENERATED_FIELD]: true,
    });
    // Authored text: this pins the wording, so a change to it is deliberate.
    expect(fields?.description).toBe(
      "Machine-generated record of each Glean run (ingest, backfill, explore): items pulled per stream and slice, every Content Expansion outcome with failure reasons, every Escalation with the downstream tool used, and the current Backfill watermark. Never edited by hand or by the synthesis agent.",
    );
  });

  test("the title follows the connector", () => {
    const page = upsertRunLedgerSection(
      null,
      ledger({ connectorId: "langsmith" }),
    );

    expect(parseFrontmatterFields(page)?.title).toBe("Langsmith Run Ledger");
    expect(splitFrontmatter(page).body).toContain("# Langsmith Run Ledger");
  });

  test("upstream's front-matter validator accepts the written front matter", () => {
    const first = upsertRunLedgerSection(null, ledger());
    const pruned = runs(5).reduce<string | null>(
      (page, run) => upsertRunLedgerSection(page, run, { maxRuns: 2 }),
      null,
    );

    expect(validateOkfFrontmatter(first)).toEqual({ valid: true });
    expect(validateOkfFrontmatter(pruned ?? "")).toEqual({ valid: true });
  });

  test("repeated upserts keep the front matter byte-identical", () => {
    const first = upsertRunLedgerSection(null, ledger());
    const original = frontMatterOf(first);
    let page = first;

    for (const run of runs(4).slice(1)) {
      page = upsertRunLedgerSection(page, run);
      expect(frontMatterOf(page)).toBe(original);
    }
    page = upsertRunLedgerSection(page, ledger({ message: "Replaced." }));
    expect(frontMatterOf(page)).toBe(original);
    expect(original).not.toBe("");
  });

  test("the prune path keeps the front matter byte-identical", () => {
    let page: string | null = null;
    let original = "";

    for (const run of runs(6)) {
      page = upsertRunLedgerSection(page, run, { maxRuns: 2 });
      original ||= frontMatterOf(page);
      expect(frontMatterOf(page)).toBe(original);
    }
    expect(page).toContain("_Older runs pruned: only the most recent 2");
    expect(page).not.toContain("## Run run-1 ");
    expect(
      (page ?? "").match(new RegExp(`^${OPENWIKI_GENERATED_FIELD}:`, "gmu")),
    ).toHaveLength(1);
  });

  test("a zero-run page keeps its front matter", () => {
    const first = upsertRunLedgerSection(null, ledger(), { maxRuns: 0 });

    expect(
      upsertRunLedgerSection(first, ledger({ runId: "run-2" }), { maxRuns: 0 }),
    ).toBe(first);
    expect(validateOkfFrontmatter(first)).toEqual({ valid: true });
  });

  test("run sections round-trip intact beside the front matter", () => {
    const all = runs(3);
    const page = all.reduce<string | null>(
      (current, run) => upsertRunLedgerSection(current, run),
      null,
    );
    const { body } = splitFrontmatter(page ?? "");
    const rendered = [...all].reverse().map(renderRunLedgerSection);

    expect(body.startsWith("\n# Glean Run Ledger\n\n_Machine-generated")).toBe(
      true,
    );
    for (const section of rendered) {
      expect(body).toContain(section);
    }
    const positions = rendered.map((section) => body.indexOf(section));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  test("a legacy page without front matter gains it once and keeps every run", () => {
    const modern = runs(3).reduce<string | null>(
      (page, run) => upsertRunLedgerSection(page, run, { maxRuns: 2 }),
      null,
    ) as string;
    const legacy = splitFrontmatter(modern).body.replace(/^\n/u, "");
    expect(legacy.startsWith("# Glean Run Ledger")).toBe(true);

    const migrated = upsertRunLedgerSection(
      legacy,
      ledger({ runId: "run-4" }),
      {
        maxRuns: 2,
      },
    );

    expect(validateOkfFrontmatter(migrated)).toEqual({ valid: true });
    expect(migrated).not.toContain(
      "The previous content of this page could not be parsed",
    );
    expect(migrated).toContain("## Run run-4 ");
    expect(migrated).toContain("## Run run-3 ");
    expect(migrated).toContain("_Older runs pruned: only the most recent 2");

    const settled = upsertRunLedgerSection(
      migrated,
      ledger({ runId: "run-5" }),
      {
        maxRuns: 2,
      },
    );
    expect(frontMatterOf(settled)).toBe(frontMatterOf(migrated));
    expect(settled.match(/^---$/gmu)).toHaveLength(2);
  });

  test("a legacy page keeps every run when none is pruned", () => {
    const legacy = splitFrontmatter(
      runs(3).reduce<string | null>(
        (page, run) => upsertRunLedgerSection(page, run),
        null,
      ) as string,
    ).body.replace(/^\n/u, "");
    const migrated = upsertRunLedgerSection(legacy, ledger({ runId: "run-4" }));

    for (const runId of ["run-1", "run-2", "run-3", "run-4"]) {
      expect(migrated).toContain(`## Run ${runId} `);
    }
  });

  test("front matter another writer enriched survives verbatim", () => {
    const first = upsertRunLedgerSection(null, ledger());
    const enriched = first.replace(
      `${OPENWIKI_GENERATED_FIELD}: true\n`,
      'tags:\n  - "ops"\n',
    );
    expect(validateOkfFrontmatter(enriched)).toEqual({ valid: true });

    const next = upsertRunLedgerSection(enriched, ledger({ runId: "run-2" }));

    expect(frontMatterOf(next)).toBe(frontMatterOf(enriched));
    expect(next).toContain("## Run run-2 ");
    expect(next).toContain("## Run run-1 ");
  });

  test("front matter without a usable type is replaced on a ledger page", () => {
    const first = upsertRunLedgerSection(null, ledger());
    const broken = `---\ntitle: "Mine"\n---\n${splitFrontmatter(first).body}`;

    const next = upsertRunLedgerSection(broken, ledger({ runId: "run-2" }));

    expect(frontMatterOf(next)).toBe(frontMatterOf(first));
    expect(next).toContain("## Run run-1 ");
    expect(next).not.toContain("The previous content of this page");
  });

  test("a foreign page keeps its own front matter below the ledger's", () => {
    const foreign =
      '---\ntype: "Note"\ntitle: "Owner notes"\n---\n\n# Notes\n\nOwner text.\n';
    const page = upsertRunLedgerSection(foreign, ledger());

    expect(parseFrontmatterFields(page)).toMatchObject({
      title: "Glean Run Ledger",
      type: "Run Ledger",
    });
    expect(validateOkfFrontmatter(page)).toEqual({ valid: true });
    expect(page).toContain(
      "_The previous content of this page could not be parsed as a Run Ledger and is preserved below._",
    );
    expect(page.endsWith(foreign)).toBe(true);
  });
});
