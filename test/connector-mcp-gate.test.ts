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
  test("recognizes only the registered MCP connector", () => {
    expect(isMcpConnectorId("notion")).toBe(true);
    expect(isMcpConnectorId("slack")).toBe(false);
  });

  test("lists MCP connectors from the real registry", () => {
    expect(getMcpConnectorIds()).toEqual(["notion"]);
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
      "notion",
      "slack",
    ]);
    expect(isMcpConnectorId("slack", registryWithSlackMcp)).toBe(true);
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

  test("tells the agent that listed tools include enforced policy decisions", () => {
    const description = getConnectorTool("openwiki_list_mcp_tools").description;

    expect(description).toMatch(/policy decision/iu);
    expect(description).toMatch(/denied tools cannot be called/iu);
  });
});
