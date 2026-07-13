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
import {
  annotateToolsWithPolicy,
  evaluateToolPolicy,
  type ToolWithPolicy,
} from "./tool-policy.js";
import type {
  ConnectorId,
  ConnectorIngestResult,
  McpConnectorConfig,
} from "./types.js";

export type McpToolDiscoveryResult = {
  connectorId: ConnectorId;
  rawFile: string;
  runId: string;
  tools: ToolWithPolicy<McpToolDescriptor>[];
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
  const tools = annotateToolsWithPolicy(discovery.tools, config.allowedTools);
  const rawFile = await writeRawJson(connectorId, runId, "mcp-tools.json", {
    connectorId,
    generatedAt: new Date().toISOString(),
    note: "Live MCP tools/list discovery with read-only policy decisions. Tool names must be used exactly as returned; denied tools are not callable.",
    tools,
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
    tools,
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

  const policy = evaluateToolPolicy({
    allowedTools: config.allowedTools,
    tool,
  });
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
