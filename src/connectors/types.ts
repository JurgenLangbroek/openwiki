import type { ToolWithPolicy } from "./tool-policy.js";

export type ConnectorId =
  | "git-repo"
  | "glean"
  | "google"
  | "hackernews"
  | "notion"
  | "slack"
  | "web-search"
  | "x";

export type ConnectorBackend =
  "direct-api" | "local-git" | "mcp-http" | "mcp-stdio";

export type ConnectorPosture = "agentic" | "deterministic" | "hybrid";

export type ConnectorDefinition = {
  backend: ConnectorBackend;
  description: string;
  displayName: string;
  id: ConnectorId;
  posture: ConnectorPosture;
  requiredEnv: string[];
};

export type ConnectorIngestOptions = {
  connectorConfig?: Record<string, unknown>;
  instanceId?: string;
  limit?: number;
  streams?: string[];
  windowHours?: number;
};

export type ConnectorIngestResult = {
  connectorId: ConnectorId;
  liveTools?: ToolWithPolicy<{
    annotations?: Record<string, unknown>;
    description?: string;
    name: string;
  }>[];
  message: string;
  rawFiles: string[];
  runId: string;
  statePath: string;
  status: "error" | "skipped" | "success";
  warnings: string[];
};

export type ConnectorRuntime = ConnectorDefinition & {
  ingest: (options?: ConnectorIngestOptions) => Promise<ConnectorIngestResult>;
  resolveMcpConfig?: () => Promise<McpConnectorConfig>;
};

export type ConnectorRetentionConfig = {
  rawRetentionDays?: number;
};

export type ConnectorState = {
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
