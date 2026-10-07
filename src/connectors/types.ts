import type { PolicyEvaluableTool, ToolWithPolicy } from "./tool-policy.js";
import type { RunLedgerEvent } from "./run-ledger.js";
import type { SliceWalkState } from "./slice-walker.js";

export type ConnectorId =
  | "git-repo"
  | "glean"
  | "google"
  | "hackernews"
  | "langsmith"
  | "notion"
  | "slack"
  | "web-search"
  | "x";

export type ConnectorBackend =
  "direct-api" | "local-git" | "mcp-http" | "mcp-stdio";

export type ConnectorPosture = "agentic" | "deterministic" | "hybrid";

export const MCP_ENDPOINT_IDS = ["default", "gateway"] as const;

export type McpEndpointId = (typeof MCP_ENDPOINT_IDS)[number];

export type ConnectorDefinition = {
  backend: ConnectorBackend;
  description: string;
  displayName: string;
  id: ConnectorId;
  mode: "code" | "personal";
  requiredEnv: string[];
  supportsAgenticDiscovery: boolean;
};

export type ConnectorIngestOptions = {
  connectorConfig?: Record<string, unknown>;
  instanceId?: string;
  limit?: number;
  repoRoot?: string;
  streams?: string[];
  windowHours?: number;
};

export type ConnectorIngestResult = {
  connectorId: ConnectorId;
  ledgerEvents?: RunLedgerEvent[];
  liveTools?: (ToolWithPolicy<PolicyEvaluableTool> & {
    endpoint?: McpEndpointId;
  })[];
  message: string;
  rawFiles: string[];
  runId: string;
  statePath: string;
  status: "error" | "skipped" | "success";
  warnings: string[];
};

/**
 * What a connector source module returns: the definition plus its callable
 * surface. Deliberately carries no Connector Posture — posture is a fork
 * concept, so requiring it here would force every upstream connector source to
 * be edited (see `PosturedConnectorRuntime` and ADR-0004).
 */
export type ConnectorRuntime = ConnectorDefinition & {
  backfill?: (
    options?: ConnectorIngestOptions,
  ) => Promise<ConnectorIngestResult>;
  discoverLiveTools?: () => Promise<ConnectorIngestResult>;
  ingest: (options?: ConnectorIngestOptions) => Promise<ConnectorIngestResult>;
  mcpEndpoints?: McpEndpointId[];
  resolveMcpConfig?: (endpoint?: McpEndpointId) => Promise<McpConnectorConfig>;
};

/**
 * A connector runtime with its Connector Posture resolved from the fork-owned
 * table in `posture.ts` and stamped on by the registry. Everything downstream
 * of the registry — Ingestion, Backfill, Exploration, live-tool assembly —
 * reads posture as a plain value and never looks it up by id.
 */
export type PosturedConnectorRuntime = ConnectorRuntime & {
  posture: ConnectorPosture;
};

export type ConnectorRetentionConfig = {
  rawRetentionDays?: number;
};

export type ConnectorState = {
  backfill?: SliceWalkState;
  lastRunAt?: string;
  latestIds?: Record<string, string>;
  runs?: ConnectorRunSummary[];
  seenIds?: Record<string, string[]>;
  version: 1;
};

export type ConnectorRunSummary = {
  at: string;
  rawDeletedAt?: string;
  rawFiles: string[];
  runId: string;
  status: ConnectorIngestResult["status"];
  synthesizedAt?: string;
  warnings: string[];
};

export type McpConnectorConfig = {
  allowedTools?: string[];
  enabled?: boolean;
  mode?: "mcp-http" | "mcp-stdio";
  transport?: {
    args?: string[];
    command?: string;
    env?: Record<string, string>;
    headers?: Record<string, string>;
    type: "http" | "stdio";
    url?: string;
  };
  readOnlyOperations?: McpReadOnlyOperation[];
};

export type McpReadOnlyOperation = {
  args?: Record<string, unknown>;
  name: string;
  type: "resource" | "tool";
};
