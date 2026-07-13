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
import {
  createGatewayUnavailableWarning,
  isMcpEndpointUnavailableError,
} from "./mcp-errors.js";
import { createConnectorRegistry, type ConnectorRegistry } from "./registry.js";
import {
  isToolCatalogFresh,
  readToolCatalog,
  writeToolCatalog,
} from "./tool-catalog.js";
import {
  annotateToolsWithPolicy,
  evaluateToolPolicy,
  type ToolWithPolicy,
} from "./tool-policy.js";
import type {
  ConnectorId,
  ConnectorIngestResult,
  McpConnectorConfig,
  McpEndpointId,
} from "./types.js";

export type McpToolDiscoveryResult = {
  connectorId: ConnectorId;
  endpoint: McpEndpointId;
  rawFile: string;
  runId: string;
  tools: ToolWithPolicy<McpToolDescriptor>[];
  warnings: string[];
};

export type McpToolCallResult = {
  allowedBy: string;
  connectorId: ConnectorId;
  endpoint: McpEndpointId;
  rawFile: string;
  result: unknown;
  runId: string;
  toolName: string;
};

export type McpRuntimeOptions = {
  endpoint?: McpEndpointId;
  registry?: ConnectorRegistry;
};

export function getMcpConnectorIds(
  registry: ConnectorRegistry = createConnectorRegistry(),
): ConnectorId[] {
  return Object.values(registry)
    .filter(
      (connector) =>
        connector.backend === "mcp-http" ||
        connector.backend === "mcp-stdio" ||
        connector.resolveMcpConfig !== undefined,
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
  options: McpRuntimeOptions = {},
): Promise<McpToolDiscoveryResult> {
  const endpoint = options.endpoint ?? "default";
  const registry = options.registry ?? createConnectorRegistry();
  const runId = createRunId();
  const state = await readConnectorState(connectorId);
  const config = await readMcpConnectorConfig(connectorId, endpoint, registry);
  let discovery: Awaited<ReturnType<typeof listMcpTools>>;
  try {
    discovery = await listMcpTools(config);
  } catch (error) {
    if (endpoint !== "gateway" || !isMcpEndpointUnavailableError(error)) {
      throw error;
    }

    const warnings = [
      createGatewayUnavailableWarning(registry[connectorId].displayName),
    ];
    const rawFile = await writeRawJson(connectorId, runId, "mcp-tools.json", {
      connectorId,
      endpoint,
      generatedAt: new Date().toISOString(),
      tools: [],
      transport: sanitizeMcpTransport(config.transport),
      warnings,
    });
    await recordMcpRun(connectorId, state, {
      rawFiles: [rawFile],
      runId,
      status: "skipped",
      warnings,
    });

    return { connectorId, endpoint, rawFile, runId, tools: [], warnings };
  }

  const tools = annotateToolsWithPolicy(
    discovery.tools,
    config.allowedTools,
    endpoint,
  );
  const generatedAt = new Date().toISOString();
  await writeToolCatalog({
    config,
    connectorId,
    endpoint,
    generatedAt,
    tools,
  });
  const rawFile = await writeRawJson(connectorId, runId, "mcp-tools.json", {
    connectorId,
    endpoint,
    generatedAt,
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
    endpoint,
    rawFile,
    runId,
    tools,
    warnings: [],
  };
}

export async function callMcpConnectorTool(
  connectorId: ConnectorId,
  toolName: string,
  args: Record<string, unknown>,
  options: McpRuntimeOptions = {},
): Promise<McpToolCallResult> {
  const endpoint = options.endpoint ?? "default";
  const registry = options.registry ?? createConnectorRegistry();
  const runId = createRunId();
  const state = await readConnectorState(connectorId);
  const config = await readMcpConnectorConfig(connectorId, endpoint, registry);
  const catalog = await readToolCatalog(connectorId, endpoint);
  let tool =
    catalog && isToolCatalogFresh(catalog)
      ? catalog.tools.find((candidate) => candidate.name === toolName)
      : undefined;

  if (!tool) {
    const discovery = await listMcpTools(config);
    const tools = annotateToolsWithPolicy(
      discovery.tools,
      config.allowedTools,
      endpoint,
    );
    await writeToolCatalog({ config, connectorId, endpoint, tools });
    tool = tools.find((candidate) => candidate.name === toolName);
  }

  if (!tool) {
    throw new Error(
      `MCP tool ${toolName} was not returned by tools/list for ${connectorId} endpoint ${endpoint}. Run openwiki_list_mcp_tools first and use an exact discovered name.`,
    );
  }

  const policy = evaluateToolPolicy({
    allowedTools: config.allowedTools,
    endpoint,
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
      endpoint,
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
    endpoint,
    rawFile,
    result,
    runId,
    toolName: tool.name,
  };
}

async function readMcpConnectorConfig(
  connectorId: ConnectorId,
  endpoint: McpEndpointId,
  registry: ConnectorRegistry,
): Promise<McpConnectorConfig> {
  const connector = registry[connectorId];
  const availableEndpoints = connector.mcpEndpoints ?? ["default"];
  if (!availableEndpoints.includes(endpoint)) {
    throw new Error(
      `Connector ${connectorId} does not expose MCP endpoint ${endpoint}; available endpoints: ${availableEndpoints.join(", ")}. Choose an available endpoint and retry.`,
    );
  }
  const config = connector.resolveMcpConfig
    ? await connector.resolveMcpConfig(endpoint)
    : await readConnectorConfig<McpConnectorConfig>(connectorId, {
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
