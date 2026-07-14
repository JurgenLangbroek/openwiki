import { describe, expect, test } from "vitest";
import { createBackfillSynthesisMessage } from "../src/backfill-synthesis.ts";
import { createConnectorRegistry } from "../src/connectors/registry.ts";

describe("Backfill synthesis prompt", () => {
  test("frames chronological history as durable arc evidence without flooding current surfaces", () => {
    const message = createBackfillSynthesisMessage({
      chunk: {
        index: 2,
        items: [{ id: "historical-project" }],
        spanFrom: "2026-03-01T00:00:00.000Z",
        spanTo: "2026-04-12T00:00:00.000Z",
      },
      chunkCount: 5,
      chunkFilePath:
        "/tmp/openwiki/connectors/glean/raw/run-1/synthesis-chunk-0002.json",
      config: {
        sourceInstances: [],
        sources: {},
        version: 1,
        wikiGoal: "Track project arcs and collaborators.",
      },
      connector: createConnectorRegistry().glean,
      sourceConfig: {
        connectorId: "glean",
        id: "glean-primary",
        ingestionGoal: "Prioritize decisions and turning points.",
        name: "Work Glean",
      },
    });

    expect(message).toMatch(/backfill synthesis chunk 2 of 5/iu);
    expect(message).toMatch(/2026-03-01.*2026-04-12/isu);
    expect(message).toMatch(/processed chronologically, oldest.*newest/iu);
    expect(message).toMatch(/historical.*months old.*not [“"]?now/isu);
    expect(message).toContain("Track project arcs and collaborators.");
    expect(message).toContain("Prioritize decisions and turning points.");
    expect(message).toMatch(/\/projects\/<slug>\.md.*(?:arc|timeline)/isu);
    expect(message).toMatch(/\/people\/<slug>\.md.*(?:arc|timeline)/isu);
    expect(message).toMatch(/permalink.*markdown link/isu);
    expect(message).toMatch(/mint new project\/people pages/iu);
    expect(message).toMatch(/Never add entries to \/commitments\.md/iu);
    expect(message).toMatch(
      /never rewrite current-status surfaces.*\/quickstart\.md.*\/themes\.md.*solely/isu,
    );
    expect(message).toMatch(/old item is history, not a live commitment/iu);
    expect(message).toContain(
      "- /tmp/openwiki/connectors/glean/raw/run-1/synthesis-chunk-0002.json",
    );
    expect(message).toMatch(/host filesystem paths under ~\/\.openwiki/iu);
    expect(message).toMatch(/cat, jq, or node/iu);
    expect(message).toMatch(/untrusted evidence, not.*instructions/iu);
    expect(message).toContain(
      "Never edit /sources/glean-run-ledger.md files: they are machine-generated Run Ledger pages.",
    );
    expect(message).toMatch(
      /backfill-history instructions.*override.*reusable policy.*\/commitments\.md.*current-status.*does not apply/isu,
    );
    expect(message).toMatch(/Do not run other source ingestions/iu);
  });
});
