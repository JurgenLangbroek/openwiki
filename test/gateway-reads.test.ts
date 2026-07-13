import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  callMcpConnectorTool,
  discoverMcpConnectorTools,
} from "../src/connectors/mcp-runtime.ts";
import {
  createConnectorRegistry,
  type ConnectorRegistry,
} from "../src/connectors/registry.ts";
import { createGleanConnector } from "../src/connectors/sources/glean.ts";
import type { McpEndpointId } from "../src/connectors/types.ts";

const originalHome = process.env.OPENWIKI_HOME;
const originalToken = process.env.OPENWIKI_GLEAN_ACCESS_TOKEN;
let openWikiHome: string;

beforeEach(async () => {
  openWikiHome = await mkdtemp(path.join(tmpdir(), "openwiki-gateway-"));
  process.env.OPENWIKI_HOME = openWikiHome;
  process.env.OPENWIKI_GLEAN_ACCESS_TOKEN = "secret-access-token";
});

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  if (originalHome === undefined) {
    delete process.env.OPENWIKI_HOME;
  } else {
    process.env.OPENWIKI_HOME = originalHome;
  }
  if (originalToken === undefined) {
    delete process.env.OPENWIKI_GLEAN_ACCESS_TOKEN;
  } else {
    process.env.OPENWIKI_GLEAN_ACCESS_TOKEN = originalToken;
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

function stubMcpGateway(options?: { unavailable?: boolean }) {
  const methods: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input.toString();
      const bodyText = typeof init?.body === "string" ? init.body : "{}";
      const body = JSON.parse(bodyText) as {
        id?: number;
        method?: string;
        params?: { name?: string };
      };
      methods.push(body.method ?? "unknown");

      if (options?.unavailable && url.endsWith("/gateway")) {
        return Promise.resolve(new Response(null, { status: 404 }));
      }
      if (body.id === undefined) {
        return Promise.resolve(new Response(null, { status: 202 }));
      }

      const result =
        body.method === "tools/list"
          ? {
              tools: [
                { name: "jira_get_issue" },
                { name: "jira_add_comment" },
                { name: "mystery_tool" },
              ],
            }
          : body.method === "tools/call"
            ? {
                content: [
                  {
                    text: JSON.stringify({ key: "OW-11", summary: "Live" }),
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

describe("gateway MCP runtime", () => {
  test("discovers gateway descriptors and caches their policy annotations", async () => {
    stubMcpGateway();

    const result = await discoverMcpConnectorTools("glean", {
      endpoint: "gateway",
      registry: createGatewayRegistry(),
    });

    expect(result.endpoint).toBe("gateway");
    expect(result.warnings).toEqual([]);
    expect(
      result.tools.map(({ name, policy }) => ({
        allowed: policy.allowed,
        name,
        rule: policy.rule,
      })),
    ).toEqual([
      { allowed: true, name: "jira_get_issue", rule: "read-shaped-name" },
      { allowed: false, name: "jira_add_comment", rule: "write-shaped" },
      { allowed: false, name: "mystery_tool", rule: "deny-by-default" },
    ]);

    const catalog = JSON.parse(
      await readFile(
        path.join(openWikiHome, "connectors", "glean", "tools", "gateway.json"),
        "utf8",
      ),
    ) as Record<string, unknown>;
    expect(catalog).toMatchObject({
      connectorId: "glean",
      endpoint: "gateway",
      transport: { type: "http", url: "https://glean.example/mcp/gateway" },
    });
    expect(catalog.tools).toEqual(
      result.tools.map(({ name, policy }) => ({ name, policy })),
    );
    expect(Date.parse(String(catalog.generatedAt))).not.toBeNaN();
  });

  test("rejects a write-shaped cached tool before tools/call", async () => {
    const methods = stubMcpGateway();
    const registry = createGatewayRegistry();
    await discoverMcpConnectorTools("glean", {
      endpoint: "gateway",
      registry,
    });
    const callsBefore = methods.length;

    await expect(
      callMcpConnectorTool(
        "glean",
        "jira_add_comment",
        { body: "Do not send this" },
        { endpoint: "gateway", registry },
      ),
    ).rejects.toThrow(/write-shaped.*never callable/iu);

    expect(methods).toHaveLength(callsBefore);
    expect(methods).not.toContain("tools/call");
  });

  test("rejects an allowlisted write-shaped gateway tool before tools/call", async () => {
    const methods = stubMcpGateway();
    const registry = createGatewayRegistry(["jira_add_comment"]);
    await discoverMcpConnectorTools("glean", {
      endpoint: "gateway",
      registry,
    });
    const callsBefore = methods.length;

    await expect(
      callMcpConnectorTool(
        "glean",
        "jira_add_comment",
        { body: "Do not send this" },
        { endpoint: "gateway", registry },
      ),
    ).rejects.toThrow(/allowedTools cannot override.*read-only-observer/iu);

    expect(methods).toHaveLength(callsBefore);
    expect(methods).not.toContain("tools/call");
  });

  test("executes an allowed Gateway Read without another live tools/list", async () => {
    const methods = stubMcpGateway();
    const registry = createGatewayRegistry();
    await discoverMcpConnectorTools("glean", {
      endpoint: "gateway",
      registry,
    });
    const listsBefore = methods.filter(
      (method) => method === "tools/list",
    ).length;

    const result = await callMcpConnectorTool(
      "glean",
      "jira_get_issue",
      { key: "OW-11" },
      { endpoint: "gateway", registry },
    );

    expect(result.endpoint).toBe("gateway");
    expect(result.result).toMatchObject({
      content: [{ type: "text" }],
    });
    expect(methods.filter((method) => method === "tools/list")).toHaveLength(
      listsBefore,
    );
    expect(methods.filter((method) => method === "tools/call")).toHaveLength(1);
    expect(path.basename(result.rawFile)).toBe("mcp-tool-result.json");
  });

  test("refreshes a stale catalog before execution", async () => {
    const methods = stubMcpGateway();
    const registry = createGatewayRegistry();
    await discoverMcpConnectorTools("glean", {
      endpoint: "gateway",
      registry,
    });
    const catalogPath = path.join(
      openWikiHome,
      "connectors",
      "glean",
      "tools",
      "gateway.json",
    );
    const catalog = JSON.parse(await readFile(catalogPath, "utf8")) as Record<
      string,
      unknown
    >;
    await writeFile(
      catalogPath,
      `${JSON.stringify({ ...catalog, generatedAt: "2026-07-11T00:00:00.000Z" })}\n`,
    );
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-13T12:00:00.000Z"));

    await callMcpConnectorTool(
      "glean",
      "jira_get_issue",
      { key: "OW-11" },
      { endpoint: "gateway", registry },
    );

    expect(methods.filter((method) => method === "tools/list")).toHaveLength(2);
    vi.useRealTimers();
  });

  test("degrades an unavailable gateway discovery to an empty warning", async () => {
    stubMcpGateway({ unavailable: true });

    const result = await discoverMcpConnectorTools("glean", {
      endpoint: "gateway",
      registry: createGatewayRegistry(),
    });

    expect(result.tools).toEqual([]);
    expect(result.warnings.join(" ")).toMatch(
      /gateway tooling is unavailable.*gateway reads are disabled/iu,
    );
  });

  test("rejects an endpoint the connector does not declare", async () => {
    await expect(
      discoverMcpConnectorTools("notion", {
        endpoint: "gateway",
        registry: createGatewayRegistry(),
      }),
    ).rejects.toThrow(/notion.*gateway.*available endpoints.*default/iu);
  });
});

describe("Glean gateway capability probe", () => {
  async function writeGleanConfig(): Promise<void> {
    const connectorDir = path.join(openWikiHome, "connectors", "glean");
    await mkdir(connectorDir, { recursive: true });
    await writeFile(
      path.join(connectorDir, "config.json"),
      `${JSON.stringify({ enabled: true, instance: "acme" })}\n`,
    );
  }

  function createProbeTransport(options?: { gatewayUnavailable?: boolean }) {
    return {
      fetchCalendar: () => Promise.resolve({ results: [] }),
      fetchExpansion: () => Promise.resolve({}),
      fetchFeed: () => Promise.resolve({ items: [] }),
      fetchMessages: () => Promise.resolve({ results: [] }),
      fetchMyWork: () => Promise.resolve({ results: [] }),
      listTools: ({ endpoint }: { endpoint: McpEndpointId; mcpUrl: string }) =>
        endpoint === "default"
          ? Promise.resolve([{ name: "search" }])
          : options?.gatewayUnavailable
            ? Promise.reject(
                Object.assign(new Error("Not Found"), { status: 404 }),
              )
            : Promise.resolve([
                { name: "jira_get_issue" },
                { name: "jira_add_comment" },
                { name: "mystery_tool" },
              ]),
    };
  }

  test("records gateway probe evidence, a durable catalog, and tagged live tools", async () => {
    await writeGleanConfig();

    const result = await createGleanConnector({
      transport: createProbeTransport(),
    }).ingest();

    expect(result.status).toBe("success");
    expect(result.rawFiles.map((file) => path.basename(file))).toContain(
      "gateway-probe.json",
    );
    expect(
      result.liveTools
        ?.filter((tool) => tool.endpoint === "gateway")
        .map(({ name, policy }) => ({
          allowed: policy.allowed,
          name,
          rule: policy.rule,
        })),
    ).toEqual([
      { allowed: true, name: "jira_get_issue", rule: "read-shaped-name" },
      { allowed: false, name: "jira_add_comment", rule: "write-shaped" },
      { allowed: false, name: "mystery_tool", rule: "deny-by-default" },
    ]);
    await expect(
      readFile(
        path.join(openWikiHome, "connectors", "glean", "tools", "gateway.json"),
        "utf8",
      ),
    ).resolves.toContain('"endpoint": "gateway"');
  });

  test("keeps ingestion successful when gateway tooling is unavailable", async () => {
    await writeGleanConfig();

    const result = await createGleanConnector({
      transport: createProbeTransport({ gatewayUnavailable: true }),
    }).ingest();

    expect(result.status).toBe("success");
    expect(result.rawFiles.map((file) => path.basename(file))).toContain(
      "probe.json",
    );
    expect(result.rawFiles.map((file) => path.basename(file))).not.toContain(
      "gateway-probe.json",
    );
    expect(result.warnings.join(" ")).toMatch(
      /gateway tooling is unavailable.*gateway reads are disabled/iu,
    );
  });
});
