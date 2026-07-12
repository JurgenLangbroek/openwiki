import {
  createRunId,
  readConnectorConfig,
  readConnectorState,
  updateStateWithRun,
  writeConnectorState,
  writeRawJson,
} from "./io.js";
import {
  executeMcpTool,
  listMcpTools,
  type McpToolDescriptor,
} from "./mcp-client.js";
import { sanitizeMcpTransport } from "./mcp-shared.js";
import { createConnectorRegistry, type ConnectorRegistry } from "./registry.js";
import type {
  ConnectorId,
  ConnectorIngestResult,
  McpConnectorConfig,
} from "./types.js";

export type McpToolDiscoveryResult = {
  connectorId: ConnectorId;
  rawFile: string;
  runId: string;
  tools: McpToolDescriptor[];
};

export type McpToolCallResult = {
  allowedBy: string;
  connectorId: ConnectorId;
  rawFile: string;
  result: unknown;
  runId: string;
  toolName: string;
};

export function getMcpConnectorIds(
  registry: ConnectorRegistry = createConnectorRegistry(),
): ConnectorId[] {
  return Object.values(registry)
    .filter(
      (connector) =>
        connector.backend === "mcp-http" || connector.backend === "mcp-stdio",
    )
    .map((connector) => connector.id);
}

export function isMcpConnectorId(
  connectorId: ConnectorId,
  registry: ConnectorRegistry = createConnectorRegistry(),
): boolean {
  return getMcpConnectorIds(registry).includes(connectorId);
}

export async function discoverMcpConnectorTools(
  connectorId: ConnectorId,
): Promise<McpToolDiscoveryResult> {
  const runId = createRunId();
  const state = await readConnectorState(connectorId);
  const config = await readMcpConnectorConfig(connectorId);
  const discovery = await listMcpTools(config);
  const rawFile = await writeRawJson(connectorId, runId, "mcp-tools.json", {
    connectorId,
    generatedAt: new Date().toISOString(),
    note: "Live MCP tools/list discovery. Tool names must be used exactly as returned.",
    tools: discovery.tools,
    transport: sanitizeMcpTransport(config.transport),
  });

  await recordMcpRun(connectorId, state, {
    rawFiles: [rawFile],
    runId,
    status: "success",
    warnings: [],
  });

  return {
    connectorId,
    rawFile,
    runId,
    tools: discovery.tools,
  };
}

export async function callMcpConnectorTool(
  connectorId: ConnectorId,
  toolName: string,
  args: Record<string, unknown>,
): Promise<McpToolCallResult> {
  const runId = createRunId();
  const state = await readConnectorState(connectorId);
  const config = await readMcpConnectorConfig(connectorId);
  const discovery = await listMcpTools(config);
  const tool = discovery.tools.find((candidate) => candidate.name === toolName);

  if (!tool) {
    throw new Error(
      `MCP tool ${toolName} was not returned by tools/list for ${connectorId}. Run openwiki_list_mcp_tools first and use an exact discovered name.`,
    );
  }

  const policy = getToolCallPolicy(config, tool);
  if (!policy.allowed) {
    throw new Error(policy.reason);
  }

  const result = await executeMcpTool(config, tool.name, args);
  const rawFile = await writeRawJson(
    connectorId,
    runId,
    "mcp-tool-result.json",
    {
      args: sanitizeValue(args),
      connectorId,
      generatedAt: new Date().toISOString(),
      result,
      tool,
      toolName: tool.name,
      transport: sanitizeMcpTransport(config.transport),
    },
  );

  await recordMcpRun(connectorId, state, {
    rawFiles: [rawFile],
    runId,
    status: "success",
    warnings: [],
  });

  return {
    allowedBy: policy.reason,
    connectorId,
    rawFile,
    result,
    runId,
    toolName: tool.name,
  };
}

async function readMcpConnectorConfig(
  connectorId: ConnectorId,
): Promise<McpConnectorConfig> {
  const config = await readConnectorConfig<McpConnectorConfig>(connectorId, {
    enabled: false,
    readOnlyOperations: [],
  });

  if (!config.enabled) {
    throw new Error(`${connectorId} MCP connector is not enabled.`);
  }

  if (!config.transport) {
    throw new Error(`${connectorId} MCP connector config requires transport.`);
  }

  return config;
}

async function recordMcpRun(
  connectorId: ConnectorId,
  state: Awaited<ReturnType<typeof readConnectorState>>,
  run: {
    rawFiles: string[];
    runId: string;
    status: ConnectorIngestResult["status"];
    warnings: string[];
  },
): Promise<void> {
  await writeConnectorState(
    connectorId,
    updateStateWithRun(state, {
      at: new Date().toISOString(),
      rawFiles: run.rawFiles,
      runId: run.runId,
      status: run.status,
      warnings: run.warnings,
    }),
  );
}

function getToolCallPolicy(
  config: McpConnectorConfig,
  tool: McpToolDescriptor,
): { allowed: true; reason: string } | { allowed: false; reason: string } {
  if (config.allowedTools?.includes(tool.name)) {
    return {
      allowed: true,
      reason: "allowed by connector config allowedTools",
    };
  }

  if (tool.annotations?.readOnlyHint === true) {
    return { allowed: true, reason: "allowed by MCP readOnlyHint annotation" };
  }

  if (
    isHostedNotionTransport(config.transport) &&
    looksLikeReadOnlyNotionTool(tool)
  ) {
    return {
      allowed: true,
      reason: "allowed by hosted Notion read-only tool name/description",
    };
  }

  return {
    allowed: false,
    reason: `MCP tool ${tool.name} is not marked read-only. Add it to allowedTools in the local connector config only if it is safe for ingestion.`,
  };
}

function isHostedNotionTransport(
  transport: McpConnectorConfig["transport"],
): boolean {
  if (transport?.type !== "http" || !transport.url) {
    return false;
  }

  const url = new URL(transport.url);

  return (
    url.protocol === "https:" &&
    url.hostname === "mcp.notion.com" &&
    url.pathname.replace(/\/+$/u, "") === "/mcp"
  );
}

function looksLikeReadOnlyNotionTool(tool: McpToolDescriptor): boolean {
  const text = `${tool.name} ${tool.description ?? ""}`;
  const looksReadOnly =
    /\b(search|retrieve|get|list|query|read|fetch|find|lookup|load|children)\b/iu.test(
      text,
    );
  const looksMutating =
    /\b(create|update|delete|archive|restore|move|patch|insert|append|comment|invite|share|upload|write|edit|send|add|remove)\b/iu.test(
      text,
    );

  return looksReadOnly && !looksMutating;
}

function sanitizeValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sanitizeValue);
  }

  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        isSecretLikeKey(key) ? "<redacted>" : sanitizeValue(entry),
      ]),
    );
  }

  return value;
}

function isSecretLikeKey(key: string): boolean {
  return /(token|secret|password|authorization|api[-_]?key|cookie)/iu.test(key);
}
