import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  callGatewayDatasourceRead,
  discoverGatewayDatasourceTools,
  GatewayDatasourcePolicyError,
} from "../src/connectors/gateway-read.ts";
import {
  createGatewayTripwireState,
  GatewayRepeatReadError,
  GatewaySanityCeilingError,
} from "../src/connectors/gateway-tripwires.ts";
import {
  createConnectorRegistry,
  type ConnectorRegistry,
} from "../src/connectors/registry.ts";
import type { McpEndpointId } from "../src/connectors/types.ts";

const originalHome = process.env.OPENWIKI_HOME;
let openWikiHome: string;

beforeEach(async () => {
  openWikiHome = await mkdtemp(
    path.join(tmpdir(), "openwiki-gateway-datasource-"),
  );
  process.env.OPENWIKI_HOME = openWikiHome;
});

afterEach(async () => {
  vi.unstubAllGlobals();
  if (originalHome === undefined) {
    delete process.env.OPENWIKI_HOME;
  } else {
    process.env.OPENWIKI_HOME = originalHome;
  }
  await rm(openWikiHome, { force: true, recursive: true });
});

function createGatewayRegistry(allowedTools?: string[]): ConnectorRegistry {
  const registry = createConnectorRegistry();

  return {
    ...registry,
    glean: {
      ...registry.glean,
      mcpEndpoints: ["default", "gateway"],
      resolveMcpConfig: (endpoint: McpEndpointId = "default") =>
        Promise.resolve({
          allowedTools,
          enabled: true,
          transport: {
            type: "http" as const,
            url: `https://glean.example/mcp/${endpoint}`,
          },
        }),
    },
  };
}

function createCatalog() {
  return {
    skill_order: ["jira"],
    skills: {
      jira: {
        "tools/JIRA_ADD_COMMENT.json": JSON.stringify({
          description: "Add a comment to a Jira issue",
          name: "JIRA_ADD_COMMENT",
          server_id: "jira-primary",
        }),
        "tools/JIRA_GET_ISSUE.json": JSON.stringify({
          annotations: { readOnlyHint: true },
          description: "Retrieve a Jira issue",
          name: "JIRA_GET_ISSUE",
          server_id: "jira-primary",
        }),
      },
    },
  };
}

function stubMcpGateway(options?: { catalogs?: unknown[] }) {
  const methods: string[] = [];
  let discoveryCount = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const bodyText = typeof init?.body === "string" ? init.body : "{}";
      const body = JSON.parse(bodyText) as {
        id?: number;
        method?: string;
        params?: { name?: string };
      };
      methods.push(body.method ?? "unknown");

      if (body.id === undefined) {
        return Promise.resolve(new Response(null, { status: 202 }));
      }

      const result =
        body.method === "tools/list"
          ? {
              tools: [
                { annotations: { readOnlyHint: true }, name: "find_skills" },
                { name: "run_tool" },
              ],
            }
          : body.method === "tools/call" && body.params?.name === "find_skills"
            ? (() => {
                const catalogs = options?.catalogs ?? [createCatalog()];
                const catalog =
                  catalogs[Math.min(discoveryCount, catalogs.length - 1)];
                discoveryCount += 1;
                return {
                  content: [{ text: JSON.stringify(catalog), type: "text" }],
                };
              })()
            : body.method === "tools/call" && body.params?.name === "run_tool"
              ? {
                  content: [
                    {
                      text: JSON.stringify({
                        key: "OW-35",
                        summary: "Policed passthrough",
                      }),
                      type: "text",
                    },
                  ],
                }
              : {};

      return Promise.resolve(
        Response.json({ id: body.id, jsonrpc: "2.0", result }),
      );
    }),
  );

  return methods;
}

describe("Gateway Datasource Read runtime", () => {
  test("discovers policed downstream tools and persists the catalog and raw artifact", async () => {
    stubMcpGateway();

    const result = await discoverGatewayDatasourceTools(
      "glean",
      ["jira issue reads"],
      { registry: createGatewayRegistry() },
    );

    expect(
      result.tools.map(({ name, policy }) => ({
        allowed: policy.allowed,
        name,
        rule: policy.rule,
      })),
    ).toEqual([
      { allowed: false, name: "JIRA_ADD_COMMENT", rule: "write-shaped" },
      { allowed: true, name: "JIRA_GET_ISSUE", rule: "read-only-annotation" },
    ]);
    expect(path.basename(result.rawFile)).toBe("gateway-skills.json");

    const catalog = JSON.parse(
      await readFile(
        path.join(
          openWikiHome,
          "connectors",
          "glean",
          "tools",
          "gateway-downstream.json",
        ),
        "utf8",
      ),
    ) as Record<string, unknown>;
    expect(catalog).toMatchObject({
      connectorId: "glean",
      skill_order: ["jira"],
      skills: createCatalog().skills,
      transport: { type: "http", url: "https://glean.example/mcp/gateway" },
    });
    expect(Date.parse(String(catalog.generatedAt))).not.toBeNaN();

    const raw = JSON.parse(await readFile(result.rawFile, "utf8")) as Record<
      string,
      unknown
    >;
    expect(raw).toMatchObject({
      catalog: createCatalog(),
      connectorId: "glean",
      queries: ["jira issue reads"],
      transport: { type: "http", url: "https://glean.example/mcp/gateway" },
    });
  });

  test("executes an allowed downstream read and records full provenance", async () => {
    const methods = stubMcpGateway();
    const registry = createGatewayRegistry();
    await discoverGatewayDatasourceTools("glean", ["jira issue reads"], {
      registry,
    });

    const result = await callGatewayDatasourceRead({
      args: { apiKey: "do-not-record", issueKey: "OW-35" },
      connectorId: "glean",
      registry,
      serverId: "jira-primary",
      toolName: "JIRA_GET_ISSUE",
      tripwires: createGatewayTripwireState(),
    });

    expect(result).toMatchObject({
      connectorId: "glean",
      serverId: "jira-primary",
      toolName: "JIRA_GET_ISSUE",
    });
    expect(result.result).toMatchObject({ content: [{ type: "text" }] });
    expect(methods.filter((method) => method === "tools/call")).toHaveLength(2);
    expect(path.basename(result.rawFile)).toBe("gateway-datasource-read.json");

    const raw = JSON.parse(await readFile(result.rawFile, "utf8")) as Record<
      string,
      unknown
    >;
    expect(raw).toMatchObject({
      args: { apiKey: "<redacted>", issueKey: "OW-35" },
      connectorId: "glean",
      policy: { allowed: true, rule: "read-only-annotation" },
      serverId: "jira-primary",
      toolName: "JIRA_GET_ISSUE",
      transport: { type: "http", url: "https://glean.example/mcp/gateway" },
    });
  });

  test("merges discoveries and lets the newest discovery replace a skill", async () => {
    const confluenceSkill = {
      "tools/CONFLUENCE_GET_PAGE_BY_ID.json": JSON.stringify({
        name: "CONFLUENCE_GET_PAGE_BY_ID",
        server_id: "confluence-primary",
      }),
    };
    const newestJiraSkill = {
      "tools/JIRA_GET_ISSUE.json": JSON.stringify({
        name: "JIRA_GET_ISSUE",
        server_id: "jira-secondary",
      }),
    };
    stubMcpGateway({
      catalogs: [
        createCatalog(),
        {
          skill_order: ["confluence", "jira"],
          skills: { confluence: confluenceSkill, jira: newestJiraSkill },
        },
      ],
    });
    const registry = createGatewayRegistry();

    await discoverGatewayDatasourceTools("glean", ["jira"], { registry });
    const result = await discoverGatewayDatasourceTools(
      "glean",
      ["confluence"],
      { registry },
    );

    expect(result.tools.map((tool) => tool.name)).toEqual([
      "JIRA_GET_ISSUE",
      "CONFLUENCE_GET_PAGE_BY_ID",
    ]);
    const catalog = JSON.parse(
      await readFile(
        path.join(
          openWikiHome,
          "connectors",
          "glean",
          "tools",
          "gateway-downstream.json",
        ),
        "utf8",
      ),
    ) as { skill_order: string[]; skills: Record<string, unknown> };
    expect(catalog.skill_order).toEqual(["jira", "confluence"]);
    expect(catalog.skills).toEqual({
      confluence: confluenceSkill,
      jira: newestJiraSkill,
    });
  });

  test("refuses a write-shaped downstream call without network activity", async () => {
    const methods = stubMcpGateway();
    const registry = createGatewayRegistry(["JIRA_ADD_COMMENT"]);
    await discoverGatewayDatasourceTools("glean", ["jira"], { registry });
    const callsBefore = methods.length;

    const error = await captureError(() =>
      callGatewayDatasourceRead({
        args: { body: "Do not send this", issueKey: "OW-35" },
        connectorId: "glean",
        registry,
        serverId: "jira-primary",
        toolName: "JIRA_ADD_COMMENT",
        tripwires: createGatewayTripwireState(),
      }),
    );

    expect(error).toBeInstanceOf(GatewayDatasourcePolicyError);
    expect(error).toMatchObject({ rule: "write-shaped" });
    expect(error.message).toMatch(/allowedTools cannot override/iu);
    expect(methods).toHaveLength(callsBefore);
  });

  test("refuses a key-order-insensitive repeat without a second passthrough call", async () => {
    const methods = stubMcpGateway();
    const registry = createGatewayRegistry();
    const tripwires = createGatewayTripwireState();
    await discoverGatewayDatasourceTools("glean", ["jira"], { registry });
    await callGatewayDatasourceRead({
      args: { fields: { assignee: true, summary: true }, issueKey: "OW-35" },
      connectorId: "glean",
      registry,
      serverId: "jira-primary",
      toolName: "JIRA_GET_ISSUE",
      tripwires,
    });
    const callsBefore = methods.length;

    const error = await captureError(() =>
      callGatewayDatasourceRead({
        args: {
          issueKey: "OW-35",
          fields: { summary: true, assignee: true },
        },
        connectorId: "glean",
        registry,
        serverId: "jira-primary",
        toolName: "JIRA_GET_ISSUE",
        tripwires,
      }),
    );

    expect(error).toBeInstanceOf(GatewayRepeatReadError);
    expect(error.message).toMatch(/not new information/iu);
    expect(methods).toHaveLength(callsBefore);
  });

  test("fails loudly at the sanity ceiling and keeps the tripwire latched", async () => {
    const methods = stubMcpGateway();
    const registry = createGatewayRegistry();
    const tripwires = createGatewayTripwireState({ sanityCeiling: 2 });
    await discoverGatewayDatasourceTools("glean", ["jira"], { registry });
    for (const issueKey of ["OW-35", "OW-36"]) {
      await callGatewayDatasourceRead({
        args: { issueKey },
        connectorId: "glean",
        registry,
        serverId: "jira-primary",
        toolName: "JIRA_GET_ISSUE",
        tripwires,
      });
    }
    const callsBefore = methods.length;

    const tripped = await captureError(() =>
      callGatewayDatasourceRead({
        args: { issueKey: "OW-37" },
        connectorId: "glean",
        registry,
        serverId: "jira-primary",
        toolName: "JIRA_GET_ISSUE",
        tripwires,
      }),
    );
    const latched = await captureError(() =>
      callGatewayDatasourceRead({
        args: { issueKey: "OW-35" },
        connectorId: "glean",
        registry,
        serverId: "jira-primary",
        toolName: "JIRA_GET_ISSUE",
        tripwires,
      }),
    );

    expect(tripped).toBeInstanceOf(GatewaySanityCeilingError);
    expect(tripped.message).toMatch(/sanity ceiling of 2.*failing loudly/iu);
    expect(latched).toBe(tripped);
    expect(methods).toHaveLength(callsBefore);
  });

  test("requires fresh discovery before reading and performs zero fetches", async () => {
    const methods = stubMcpGateway();

    await expect(
      callGatewayDatasourceRead({
        args: { issueKey: "OW-35" },
        connectorId: "glean",
        registry: createGatewayRegistry(),
        serverId: "jira-primary",
        toolName: "JIRA_GET_ISSUE",
        tripwires: createGatewayTripwireState(),
      }),
    ).rejects.toThrow(/run openwiki_find_gateway_datasource_tools first/iu);

    expect(methods).toEqual([]);
  });

  test("refuses an unknown downstream tool via policy without a passthrough call", async () => {
    const methods = stubMcpGateway();
    const registry = createGatewayRegistry();
    await discoverGatewayDatasourceTools("glean", ["jira"], { registry });
    const callsBefore = methods.length;

    const error = await captureError(() =>
      callGatewayDatasourceRead({
        args: { issueKey: "OW-35" },
        connectorId: "glean",
        registry,
        serverId: "jira-primary",
        toolName: "JIRA_GET_SECRET",
        tripwires: createGatewayTripwireState(),
      }),
    );

    expect(error).toBeInstanceOf(GatewayDatasourcePolicyError);
    expect(error).toMatchObject({ rule: "downstream-tool-not-found" });
    expect(error.message).toMatch(/not found.*gateway skill catalog/iu);
    expect(methods).toHaveLength(callsBefore);
  });

  test("treats an unparsable skill payload as an empty deny-by-default catalog", async () => {
    const methods = stubMcpGateway({ catalogs: ["not a catalog"] });
    const registry = createGatewayRegistry();

    const discovery = await discoverGatewayDatasourceTools("glean", ["jira"], {
      registry,
    });
    const callsBefore = methods.length;
    const error = await captureError(() =>
      callGatewayDatasourceRead({
        args: { issueKey: "OW-35" },
        connectorId: "glean",
        registry,
        serverId: "jira-primary",
        toolName: "JIRA_GET_ISSUE",
        tripwires: createGatewayTripwireState(),
      }),
    );

    expect(discovery.tools).toEqual([]);
    expect(error).toMatchObject({ rule: "downstream-tool-not-found" });
    expect(methods).toHaveLength(callsBefore);
  });

  test("refuses a stale downstream catalog without live fallback", async () => {
    const methods = stubMcpGateway();
    const registry = createGatewayRegistry();
    await discoverGatewayDatasourceTools("glean", ["jira"], { registry });
    const catalogPath = path.join(
      openWikiHome,
      "connectors",
      "glean",
      "tools",
      "gateway-downstream.json",
    );
    const catalog = JSON.parse(await readFile(catalogPath, "utf8")) as Record<
      string,
      unknown
    >;
    await writeFile(
      catalogPath,
      `${JSON.stringify({ ...catalog, generatedAt: "2000-01-01T00:00:00.000Z" })}\n`,
    );
    const callsBefore = methods.length;

    await expect(
      callGatewayDatasourceRead({
        args: { issueKey: "OW-35" },
        connectorId: "glean",
        registry,
        serverId: "jira-primary",
        toolName: "JIRA_GET_ISSUE",
        tripwires: createGatewayTripwireState(),
      }),
    ).rejects.toThrow(/run openwiki_find_gateway_datasource_tools first/iu);

    expect(methods).toHaveLength(callsBefore);
  });
});

async function captureError(action: () => Promise<unknown>): Promise<Error> {
  try {
    await action();
  } catch (error) {
    if (error instanceof Error) {
      return error;
    }
    throw error;
  }

  throw new Error("Expected action to throw.");
}
