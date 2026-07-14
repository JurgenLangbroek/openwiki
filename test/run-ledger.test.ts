import { describe, expect, test } from "vitest";
import {
  renderRunLedgerSection,
  type RunLedger,
  upsertRunLedgerSection,
} from "../src/connectors/run-ledger.ts";

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

    expect(page).toMatch(
      /^# Glean Run Ledger\n\n_Machine-generated by OpenWiki runs\. Do not edit\._\n\n## Run run-1 — ingest — success/mu,
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

    expect(page).toBe(
      "# Glean Run Ledger\n\n_Machine-generated by OpenWiki runs. Do not edit._\n\n_Older runs pruned: only the most recent 0 are kept on this page._\n",
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
