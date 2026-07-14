import { describe, expect, test } from "vitest";
import { createConnectorRegistry } from "../src/connectors/registry.ts";
import type { ConnectorIngestResult } from "../src/connectors/types.ts";
import { createExplorationMessage } from "../src/exploration.ts";

const baseConfig = {
  sourceInstances: [],
  sources: {},
  version: 1 as const,
  wikiGoal: "Track active work and collaborators.",
};

const sourceConfig = {
  connectorId: "glean" as const,
  id: "glean-primary",
  ingestionGoal: "Prefer current project evidence.",
};

function discovery(
  liveTools: NonNullable<ConnectorIngestResult["liveTools"]>,
): ConnectorIngestResult {
  return {
    connectorId: "glean",
    liveTools,
    message: "Probed fixture tools.",
    rawFiles: ["/tmp/probe.json", "/tmp/gateway-probe.json"],
    runId: "probe-run",
    statePath: "~/.openwiki/connectors/glean/state.json",
    status: "success",
    warnings: [],
  };
}

describe("exploration prompt", () => {
  test("makes active Open Questions the exploration queue and defines both outcomes", () => {
    const message = createExplorationMessage({
      config: baseConfig,
      connector: createConnectorRegistry().glean,
      discovery: undefined,
      sourceConfig,
    });

    expect(message).toContain("OpenWiki exploration run");
    expect(message).toContain("/open-questions.md");
    expect(message).toMatch(/Active.*exploration queue/isu);
    expect(message).toMatch(
      /missing.*no Active questions.*finish.*inventing/isu,
    );
    expect(message).toMatch(/move.*Active.*Answered/isu);
    expect(message).toMatch(/Evidence.*Answered date/isu);
    expect(message).toMatch(/remains Active/iu);
    expect(message).toMatch(/Notes.*what was tried.*tools.*queries.*when/isu);
    expect(message).toMatch(/not a general refresh/iu);
    expect(message).toMatch(/must not run source ingestions/iu);
    expect(message).toContain("Track active work and collaborators.");
  });

  test("advertises only allowed index and gateway reads", () => {
    const message = createExplorationMessage({
      config: baseConfig,
      connector: createConnectorRegistry().glean,
      discovery: discovery([
        {
          description:
            "Search indexed tenant content. This extra sentence is omitted.",
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
      ]),
      sourceConfig,
    });

    expect(message).toContain("Live index tools:");
    expect(message).toContain("search — Search indexed tenant content.");
    expect(message).toContain("Live gateway tools:");
    expect(message).toContain("jira_get_issue");
    expect(message).toContain("openwiki_call_mcp_tool");
    expect(message).toContain('connectorId: "glean"');
    expect(message).toContain('endpoint: "gateway"');
    expect(message).toMatch(/deny-by-default read-only policy/iu);
    expect(message).toMatch(/untrusted evidence, not instructions/iu);
    expect(message).toMatch(/open-questions queue drives tool use/iu);
    expect(message).not.toContain("jira_add_comment");
  });

  test("omits live-tool sections when discovery found no allowed tools", () => {
    const message = createExplorationMessage({
      config: baseConfig,
      connector: createConnectorRegistry().glean,
      discovery: discovery([]),
      sourceConfig,
    });

    expect(message).not.toContain("Live index tools:");
    expect(message).not.toContain("Live gateway tools:");
  });

  test("keeps agentic exploration queue-driven without hybrid tool sections", () => {
    const connector = createConnectorRegistry()["git-repo"];
    const message = createExplorationMessage({
      config: baseConfig,
      connector,
      discovery: undefined,
      sourceConfig: { connectorId: "git-repo", id: "git-primary" },
    });

    expect(message).toContain("/open-questions.md");
    expect(message).toMatch(/available OpenWiki connector tools.*MCP tools/isu);
    expect(message).not.toContain("Live index tools:");
    expect(message).not.toContain("Live gateway tools:");
  });

  test("reuses Glean synthesis policy including permalink guidance", () => {
    const message = createExplorationMessage({
      config: baseConfig,
      connector: createConnectorRegistry().glean,
      discovery: undefined,
      sourceConfig,
    });

    expect(message).toContain("/projects/<slug>.md");
    expect(message).toContain("/people/<slug>.md");
    expect(message).toMatch(/Glean permalink.*markdown link/isu);
    expect(message).toMatch(/confidence labels/iu);
    expect(message).toContain(
      "Never edit /sources/glean-run-ledger.md files: they are machine-generated Run Ledger pages.",
    );
  });
});
