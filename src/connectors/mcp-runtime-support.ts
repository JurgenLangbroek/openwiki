import {
  readConnectorConfig,
  readConnectorState,
  updateStateWithRun,
  writeConnectorState,
} from "./io.js";
import type { ConnectorRegistry } from "./registry.js";
import type {
  ConnectorId,
  ConnectorIngestResult,
  McpConnectorConfig,
  McpEndpointId,
} from "./types.js";

export async function resolveMcpConnectorConfig(
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

export async function recordMcpRun(
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

export function sanitizeMcpValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sanitizeMcpValue);
  }

  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        isSecretLikeKey(key) ? "<redacted>" : sanitizeMcpValue(entry),
      ]),
    );
  }

  return value;
}

function isSecretLikeKey(key: string): boolean {
  return /(token|secret|password|authorization|api[-_]?key|cookie)/iu.test(key);
}
