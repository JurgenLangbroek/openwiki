import { describe, expect, test } from "vitest";
import {
  getMcpConnectorIds,
  isMcpConnectorId,
} from "../src/connectors/mcp-runtime.ts";
import {
  CONNECTOR_IDS,
  createConnectorRegistry,
} from "../src/connectors/registry.ts";
import { createOpenWikiConnectorTools } from "../src/connectors/tools.ts";

function getConnectorIdEnum(toolName: string): string[] {
  const tool = getConnectorTool(toolName);

  const schema = tool.schema as unknown as {
    properties: { connectorId: { enum: string[] } };
  };

  return schema.properties.connectorId.enum;
}

function getEndpointSchema(toolName: string): {
  default: string;
  enum: string[];
} {
  const tool = getConnectorTool(toolName);
  const schema = tool.schema as unknown as {
    properties: { endpoint: { default: string; enum: string[] } };
  };

  return schema.properties.endpoint;
}

function getConnectorTool(toolName: string) {
  const tool = createOpenWikiConnectorTools().find(
    (candidate) => candidate.name === toolName,
  );

  if (!tool) {
    throw new Error(`Missing connector tool: ${toolName}`);
  }

  return tool;
}

describe("MCP connector eligibility", () => {
  test("recognizes registered MCP and hybrid-capability connectors", () => {
    expect(isMcpConnectorId("glean")).toBe(true);
    expect(isMcpConnectorId("notion")).toBe(true);
    expect(isMcpConnectorId("slack")).toBe(false);
  });

  test("lists MCP connectors from the real registry", () => {
    expect(getMcpConnectorIds()).toEqual(["glean", "notion"]);
  });

  test("makes an additional registry MCP connector eligible without gate edits", () => {
    const registry = createConnectorRegistry();
    const registryWithSlackMcp = {
      ...registry,
      slack: {
        ...registry.slack,
        backend: "mcp-http" as const,
      },
    };

    expect(getMcpConnectorIds(registryWithSlackMcp)).toEqual([
      "glean",
      "notion",
      "slack",
    ]);
    expect(isMcpConnectorId("slack", registryWithSlackMcp)).toBe(true);
  });

  test("makes a non-MCP backend eligible through its runtime capability", () => {
    const registry = createConnectorRegistry();
    const registryWithSlackCapability = {
      ...registry,
      slack: {
        ...registry.slack,
        resolveMcpConfig: () =>
          Promise.resolve({
            enabled: true,
            transport: {
              type: "http" as const,
              url: "https://example.test/mcp",
            },
          }),
      },
    };

    expect(getMcpConnectorIds(registryWithSlackCapability)).toEqual([
      "glean",
      "notion",
      "slack",
    ]);
  });

  test("publishes registry-derived connector IDs in tool schemas", () => {
    const expectedMcpIds = getMcpConnectorIds();
    const expectedConnectorIds = [...CONNECTOR_IDS].sort();

    expect(getConnectorIdEnum("openwiki_list_mcp_tools")).toEqual(
      expectedMcpIds,
    );
    expect(getConnectorIdEnum("openwiki_call_mcp_tool")).toEqual(
      expectedMcpIds,
    );
    expect(getConnectorIdEnum("openwiki_ingest_connector")).toEqual(
      expectedConnectorIds,
    );
    expect(getConnectorIdEnum("openwiki_list_raw_items")).toEqual(
      expectedConnectorIds,
    );
    expect(getConnectorIdEnum("openwiki_read_raw_item")).toEqual(
      expectedConnectorIds,
    );
  });

  test("publishes default and gateway endpoints in MCP tool schemas", () => {
    expect(getEndpointSchema("openwiki_list_mcp_tools")).toMatchObject({
      default: "default",
      enum: ["default", "gateway"],
    });
    expect(getEndpointSchema("openwiki_call_mcp_tool")).toMatchObject({
      default: "default",
      enum: ["default", "gateway"],
    });
  });

  test("declares Glean gateway capability without widening Notion", () => {
    const registry = createConnectorRegistry();

    expect(registry.glean.mcpEndpoints).toEqual(["default", "gateway"]);
    expect(registry.notion.mcpEndpoints).toBeUndefined();
  });

  test("tells the agent that listed tools include enforced policy decisions", () => {
    const description = getConnectorTool("openwiki_list_mcp_tools").description;

    expect(description).toMatch(/policy decision/iu);
    expect(description).toMatch(/denied tools cannot be called/iu);
  });
});
