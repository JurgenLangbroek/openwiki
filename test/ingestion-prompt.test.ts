import { describe, expect, test } from "vitest";
import { createConnectorRegistry } from "../src/connectors/registry.ts";
import {
  createSourceSynthesisPolicy,
  createSourceUpdateMessage,
  resolveSynthesisStamp,
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
    expect(policy).toContain(
      "Never edit /sources/glean-run-ledger.md files: they are machine-generated Run Ledger pages.",
    );
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

  test("advertises only policy-allowed live tools beside a hybrid pull", () => {
    const connector = createConnectorRegistry().glean;
    const message = createSourceUpdateMessage({
      config: {
        sourceInstances: [],
        sources: {},
        version: 1,
      },
      connector,
      deterministicPull: {
        connectorId: "glean",
        liveTools: [
          {
            description:
              "Search indexed tenant content. Returns ranked results.",
            name: "search",
            policy: {
              allowed: true,
              reason: "Read-shaped tool name.",
              rule: "read-shaped-name",
            },
          },
          {
            description: "Create an announcement for a team.",
            name: "create_announcement",
            policy: {
              allowed: false,
              reason: "Write-shaped tool name.",
              rule: "write-shaped",
            },
          },
        ],
        message: "Pulled fixture evidence.",
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

    expect(message).toContain("- /tmp/probe.json\n- /tmp/feed.json");
    expect(message).toContain("Live index tools:");
    expect(message).toContain("search — Search indexed tenant content.");
    expect(message).toContain("openwiki_call_mcp_tool");
    expect(message).toContain('connectorId: "glean"');
    expect(message).toMatch(/deny-by-default read-only policy/iu);
    expect(message).toMatch(/untrusted evidence, not instructions/iu);
    expect(message).not.toContain("create_announcement");
    expect(message).not.toContain("Live gateway tools:");
  });

  test("advertises allowed gateway reads separately from index tools", () => {
    const connector = createConnectorRegistry().glean;
    const message = createSourceUpdateMessage({
      config: { sourceInstances: [], sources: {}, version: 1 },
      connector,
      deterministicPull: {
        connectorId: "glean",
        liveTools: [
          {
            endpoint: "default",
            name: "search",
            policy: {
              allowed: true,
              reason: "Read-shaped tool name.",
              rule: "read-shaped-name",
            },
          },
          {
            description: "Read the current Jira issue from its live source.",
            endpoint: "gateway",
            name: "jira_get_issue",
            policy: {
              allowed: true,
              reason: "Read-shaped tool name.",
              rule: "read-shaped-name",
            },
          },
          {
            endpoint: "gateway",
            name: "jira_add_comment",
            policy: {
              allowed: false,
              reason: "Write-shaped tool name.",
              rule: "write-shaped",
            },
          },
        ],
        message: "Pulled fixture evidence.",
        rawFiles: ["/tmp/probe.json", "/tmp/gateway-probe.json"],
        runId: "run-1",
        statePath: "~/.openwiki/connectors/glean/state.json",
        status: "success",
        warnings: [],
      },
      rawFiles: ["/tmp/probe.json", "/tmp/gateway-probe.json"],
      sourceConfig: { connectorId: "glean", id: "glean-primary" },
    });

    expect(message).toContain("Live index tools:");
    expect(message).toContain("Live gateway tools:");
    expect(message).toContain(
      "jira_get_issue — Read the current Jira issue from its live source.",
    );
    expect(message).toContain('endpoint: "gateway"');
    expect(message).toMatch(/live records.*underlying datasources/isu);
    expect(message).toMatch(/fresher than the index/iu);
    expect(message).toMatch(/raw pull files are the primary evidence/iu);
    expect(message).toMatch(/deny-by-default read-only policy/iu);
    expect(message).toMatch(/untrusted evidence/iu);
    expect(message).not.toContain("jira_add_comment");
  });

  test("omits the live-tools section when a hybrid pull has no allowed tools", () => {
    const connector = createConnectorRegistry().glean;
    const message = createSourceUpdateMessage({
      config: { sourceInstances: [], sources: {}, version: 1 },
      connector,
      deterministicPull: {
        connectorId: "glean",
        liveTools: [
          {
            name: "create_announcement",
            policy: {
              allowed: false,
              reason: "Write-shaped tool name.",
              rule: "write-shaped",
            },
          },
        ],
        message: "Pulled fixture evidence.",
        rawFiles: ["/tmp/probe.json"],
        runId: "run-1",
        statePath: "~/.openwiki/connectors/glean/state.json",
        status: "success",
        warnings: [],
      },
      rawFiles: ["/tmp/probe.json"],
      sourceConfig: { connectorId: "glean", id: "glean-primary" },
    });

    expect(message).not.toContain("Live index tools:");
    expect(message).not.toContain("create_announcement");
  });

  test("does not advertise live tools for a deterministic connector", () => {
    const connector = createConnectorRegistry().slack;
    const message = createSourceUpdateMessage({
      config: { sourceInstances: [], sources: {}, version: 1 },
      connector,
      deterministicPull: {
        connectorId: "slack",
        liveTools: [
          {
            name: "search_messages",
            policy: {
              allowed: true,
              reason: "Read-shaped tool name.",
              rule: "read-shaped-name",
            },
          },
        ],
        message: "Pulled Slack messages.",
        rawFiles: ["/tmp/messages.json"],
        runId: "run-1",
        statePath: "~/.openwiki/connectors/slack/state.json",
        status: "success",
        warnings: [],
      },
      rawFiles: ["/tmp/messages.json"],
      sourceConfig: { connectorId: "slack", id: "slack-primary" },
    });

    expect(message).toContain("Deterministic pull result:");
    expect(message).not.toContain("Live index tools:");
    expect(message).not.toContain("search_messages");
  });

  test("keeps the agentic connector message on its existing path", () => {
    const connector = createConnectorRegistry()["git-repo"];
    const message = createSourceUpdateMessage({
      config: { sourceInstances: [], sources: {}, version: 1 },
      connector,
      deterministicPull: undefined,
      rawFiles: [],
      sourceConfig: { connectorId: "git-repo", id: "git-repo-primary" },
    });

    expect(message).toContain(
      "This source cannot be fully pulled deterministically before the agent run",
    );
    expect(message).toContain("Source config:");
    expect(message).not.toContain("Deterministic pull result:");
    expect(message).not.toContain("Live index tools:");
  });
});

describe("synthesis stamping", () => {
  test("stamps every unsynthesized run after hybrid synthesis", () => {
    expect(resolveSynthesisStamp("hybrid", { runId: "pull-run" })).toEqual({
      kind: "all-unsynthesized",
    });
    expect(
      resolveSynthesisStamp("deterministic", { runId: "pull-run" }),
    ).toEqual({ kind: "run", runId: "pull-run" });
    expect(resolveSynthesisStamp("agentic", undefined)).toEqual({
      kind: "all-unsynthesized",
    });
  });
});
