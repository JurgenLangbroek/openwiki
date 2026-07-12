import { describe, expect, test } from "vitest";
import { createConnectorRegistry } from "../src/connectors/registry.ts";
import {
  createSourceSynthesisPolicy,
  createSourceUpdateMessage,
} from "../src/ingestion.ts";

describe("source synthesis policy", () => {
  test("assembles Glean guidance for durable pages and permalinked evidence", () => {
    const policy = createSourceSynthesisPolicy("glean");

    expect(policy).toMatch(/\/projects\/<slug>\.md/u);
    expect(policy).toMatch(/\/people\/<slug>\.md/u);
    expect(policy).toMatch(/state of the project.*not a diary/isu);
    expect(policy).toMatch(
      /Never create meeting logs, journals, or per-day digests/u,
    );
    expect(policy).toMatch(/Glean permalink.*markdown link.*item.*url/isu);
    expect(policy).toMatch(/\/sources\/glean\.md.*compact evidence index/isu);
    expect(policy).toMatch(/coverage counts and pointers/isu);
    expect(policy).toMatch(/real uncertainties.*Open Questions/isu);
  });

  test("does not add Glean-specific guidance to another connector", () => {
    const policy = createSourceSynthesisPolicy("slack");

    expect(policy).not.toMatch(/\/projects\/<slug>\.md/u);
    expect(policy).not.toMatch(/Glean permalink/u);
    expect(policy).not.toMatch(/\/sources\/glean\.md/u);
  });

  test("includes Glean guidance and raw files in the assembled update message", () => {
    const connector = createConnectorRegistry().glean;
    const message = createSourceUpdateMessage({
      config: {
        sourceInstances: [],
        sources: {},
        version: 1,
        wikiGoal: "Track active work and collaborators.",
      },
      connector,
      deterministicPull: {
        connectorId: "glean",
        message: "Probed 2 MCP tool(s); pulled 3 feed item(s) (2 new).",
        rawFiles: ["/tmp/probe.json", "/tmp/feed.json"],
        runId: "run-1",
        statePath: "~/.openwiki/connectors/glean/state.json",
        status: "success",
        warnings: [],
      },
      rawFiles: ["/tmp/probe.json", "/tmp/feed.json"],
      sourceConfig: {
        connectorId: "glean",
        id: "glean-primary",
      },
    });

    expect(message).toContain("/projects/<slug>.md");
    expect(message).toContain("Glean permalink");
    expect(message).toContain("/sources/glean.md");
    expect(message).toContain("- /tmp/probe.json\n- /tmp/feed.json");
  });
});
