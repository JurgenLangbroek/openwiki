import {
  DynamicStructuredTool,
  type StructuredToolInterface,
} from "@langchain/core/tools";
import { constants as fsConstants } from "node:fs";
import { open, readdir, stat } from "node:fs/promises";
import path from "node:path";
import {
  getConnectorConfigPath,
  getConnectorRawDir,
  getOpenWikiHomeDir,
  getOpenWikiLocalWikiDir,
  resolveConnectorRawPath,
} from "../openwiki-home.js";
import {
  CONNECTOR_IDS,
  createConnectorRegistry,
  isConnectorId,
} from "./registry.js";
import {
  callMcpConnectorTool,
  discoverMcpConnectorTools,
  getMcpConnectorIds,
  isMcpConnectorId,
} from "./mcp-runtime.js";
import {
  callGatewayDatasourceRead,
  discoverGatewayDatasourceTools,
} from "./gateway-read.js";
import { createGatewayTripwireState } from "./gateway-tripwires.js";
import { getMcpErrorMessage } from "./mcp-errors.js";
import { sanitizeMcpValue } from "./mcp-runtime-support.js";
import type { RunLedgerEscalationEvent } from "./run-ledger.js";
import {
  MCP_ENDPOINT_IDS,
  type ConnectorId,
  type ConnectorIngestOptions,
  type McpEndpointId,
} from "./types.js";

export type OpenWikiConnectorToolsOptions = {
  onEscalation?: (event: RunLedgerEscalationEvent) => void;
};

const MAX_ESCALATION_TARGET_LENGTH = 120;

export function createOpenWikiConnectorTools(
  options: OpenWikiConnectorToolsOptions = {},
): StructuredToolInterface[] {
  const connectorIds = [...CONNECTOR_IDS].sort();
  const mcpConnectorIds = getMcpConnectorIds();
  const mcpConnectorId = mcpConnectorIds[0];
  const gatewayTripwires = createGatewayTripwireState();

  return [
    new DynamicStructuredTool({
      name: "openwiki_list_connectors",
      description:
        "List built-in OpenWiki connectors, their backends, required env var names, config paths, and raw data paths. Secret values are never returned.",
      schema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      } as const,
      func: async () => stringifyToolResult(await listConnectors()),
    }),
    new DynamicStructuredTool({
      name: "openwiki_list_mcp_tools",
      description: `List live MCP tools for a configured MCP connector and endpoint, then write discovery under ~/.openwiki/connectors/<id>/raw and cache descriptors locally. The "default" endpoint reads the connector index. The "gateway" endpoint discovers Gateway Reads: read-only tools against live underlying datasources such as issue trackers, calendars, and wikis. Each tool includes a deny-by-default read-only policy decision; denied tools cannot be called. Input: ${JSON.stringify({ connectorId: mcpConnectorId, endpoint: "default" })}. Use exact returned tool names.`,
      schema: {
        type: "object",
        properties: {
          connectorId: {
            type: "string",
            enum: mcpConnectorIds,
          },
          endpoint: {
            type: "string",
            enum: MCP_ENDPOINT_IDS,
            default: "default",
          },
        },
        required: ["connectorId"],
        additionalProperties: false,
      } as const,
      func: async (input) =>
        stringifyToolResult(
          await listMcpToolsForConnector(
            getConnectorId(input, "connectorId"),
            getMcpEndpointInput(input),
          ),
        ),
    }),
    new DynamicStructuredTool({
      name: "openwiki_call_mcp_tool",
      description: `Call one exact discovered MCP tool permitted by the deny-by-default read-only policy and write the result under ~/.openwiki/connectors/<id>/raw. The "default" endpoint is an Index Read. The "gateway" endpoint is a Gateway Read against a live underlying datasource such as an issue tracker, calendar, or wiki. Denied tools cannot be called on either endpoint. Input: ${JSON.stringify({ connectorId: mcpConnectorId, endpoint: "default", toolName: "exact_tool_name", args: { query: "Applied AI" } })}.`,
      schema: {
        type: "object",
        properties: {
          args: {
            type: "object",
            additionalProperties: true,
          },
          connectorId: {
            type: "string",
            enum: mcpConnectorIds,
          },
          endpoint: {
            type: "string",
            enum: MCP_ENDPOINT_IDS,
            default: "default",
          },
          toolName: {
            type: "string",
          },
        },
        required: ["connectorId", "toolName"],
        additionalProperties: false,
      } as const,
      func: async (input) =>
        stringifyToolResult(
          await callMcpToolForConnector(
            getConnectorId(input, "connectorId"),
            getStringInput(input, "toolName"),
            getRecordInput(input, "args") ?? {},
            getMcpEndpointInput(input),
          ),
        ),
    }),
    new DynamicStructuredTool({
      name: "openwiki_find_gateway_datasource_tools",
      description: `Discover read-policed downstream datasource tools for Jira, Confluence, Gmail, and Calendar behind an MCP gateway, cache the merged find_skills catalog, and record the discovery. Every downstream tool includes its deny-by-default policy decision; denied tools are never callable. Input: ${JSON.stringify({ connectorId: mcpConnectorId, queries: ["Jira issue reads for OW-35"] })}.`,
      schema: {
        type: "object",
        properties: {
          connectorId: {
            type: "string",
            enum: mcpConnectorIds,
          },
          queries: {
            type: "array",
            items: { type: "string" },
            minItems: 1,
          },
        },
        required: ["connectorId", "queries"],
        additionalProperties: false,
      } as const,
      func: async (input) =>
        stringifyToolResult(
          await findGatewayDatasourceTools(
            getConnectorId(input, "connectorId"),
            getRequiredStringArrayInput(input, "queries"),
          ),
        ),
    }),
    new DynamicStructuredTool({
      name: "openwiki_gateway_datasource_read",
      description: `This is the ONLY path to underlying datasources behind an MCP gateway. Every call is policed deny-by-default read-only according to the exact downstream tool, recorded with provenance, and write-shaped or unknown tools are refused before network access. Re-reading the same document within one agent run is refused because it is not new information. Input: ${JSON.stringify({ args: { issueKey: "OW-35" }, connectorId: mcpConnectorId, serverId: "jira-primary", toolName: "JIRA_GET_ISSUE" })}.`,
      schema: {
        type: "object",
        properties: {
          args: {
            type: "object",
            additionalProperties: true,
          },
          connectorId: {
            type: "string",
            enum: mcpConnectorIds,
          },
          serverId: {
            type: "string",
          },
          toolName: {
            type: "string",
          },
        },
        required: ["connectorId", "serverId", "toolName"],
        additionalProperties: false,
      } as const,
      func: async (input) => {
        const args = getRecordInput(input, "args") ?? {};
        const connectorId = getConnectorId(input, "connectorId");
        const serverId = getStringInput(input, "serverId");
        const target = createEscalationTarget(args);
        const toolName = getStringInput(input, "toolName");
        let result: Awaited<ReturnType<typeof readGatewayDatasource>>;

        try {
          result = await readGatewayDatasource({
            args,
            connectorId,
            serverId,
            toolName,
            tripwires: gatewayTripwires,
          });
        } catch (error) {
          recordEscalation(options, {
            outcome: "failed",
            reason: getMcpErrorMessage(error),
            serverId,
            ...(target ? { target } : {}),
            toolName,
            type: "escalation",
          });
          throw error;
        }

        recordEscalation(options, {
          outcome: "ok",
          serverId,
          ...(target ? { target } : {}),
          toolName,
          type: "escalation",
        });
        return stringifyToolResult(result);
      },
    }),
    new DynamicStructuredTool({
      name: "openwiki_ingest_connector",
      description:
        'Run deterministic ingestion for one built-in connector and write raw data/manifests under ~/.openwiki/connectors/<id>/raw. Input: {"connectorId":"x","streams":["bookmarks"],"limit":1}.',
      schema: {
        type: "object",
        properties: {
          connectorId: {
            type: "string",
            enum: connectorIds,
          },
          limit: { type: "number" },
          streams: {
            type: "array",
            items: { type: "string" },
          },
          windowHours: { type: "number" },
        },
        required: ["connectorId"],
        additionalProperties: false,
      } as const,
      func: async (input) =>
        stringifyToolResult(
          await ingestConnector(
            getConnectorId(input, "connectorId"),
            getIngestOptions(input),
          ),
        ),
    }),
    new DynamicStructuredTool({
      name: "openwiki_ingest_all_connectors",
      description:
        "Run deterministic ingestion for all configured built-in connectors. Connectors that are not configured or enabled are skipped.",
      schema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      } as const,
      func: async () => stringifyToolResult(await ingestAllConnectors()),
    }),
    new DynamicStructuredTool({
      name: "openwiki_list_raw_items",
      description:
        'List raw files for a connector under ~/.openwiki/connectors/<id>/raw. Input: {"connectorId":"x"}.',
      schema: {
        type: "object",
        properties: {
          connectorId: {
            type: "string",
            enum: connectorIds,
          },
        },
        required: ["connectorId"],
        additionalProperties: false,
      } as const,
      func: async (input) =>
        stringifyToolResult(
          await listRawItems(getConnectorId(input, "connectorId")),
        ),
    }),
    new DynamicStructuredTool({
      name: "openwiki_read_raw_item",
      description:
        'Read a raw connector file by connector ID and relative path. Only files inside ~/.openwiki/connectors/<id>/raw are allowed. Input: {"connectorId":"x","path":"2026-.../bookmarks.json","maxBytes":50000}.',
      schema: {
        type: "object",
        properties: {
          connectorId: {
            type: "string",
            enum: connectorIds,
          },
          maxBytes: {
            type: "number",
          },
          path: {
            type: "string",
          },
        },
        required: ["connectorId", "path"],
        additionalProperties: false,
      } as const,
      func: async (input) =>
        stringifyToolResult(
          await readRawItem(
            getConnectorId(input, "connectorId"),
            getStringInput(input, "path"),
            getNumberInput(input, "maxBytes") ?? 100_000,
          ),
        ),
    }),
  ];
}

function createEscalationTarget(
  args: Record<string, unknown>,
): string | undefined {
  if (Object.keys(args).length === 0) {
    return undefined;
  }

  const target = JSON.stringify(sanitizeMcpValue(args));
  const targetCodePoints = [...target];
  return targetCodePoints.length <= MAX_ESCALATION_TARGET_LENGTH
    ? target
    : `${targetCodePoints
        .slice(0, MAX_ESCALATION_TARGET_LENGTH - 1)
        .join("")}…`;
}

function recordEscalation(
  options: OpenWikiConnectorToolsOptions,
  event: RunLedgerEscalationEvent,
): void {
  try {
    options.onEscalation?.(event);
  } catch {
    // Recording is observational and must not influence gateway read policy.
  }
}

async function listConnectors() {
  const registry = createConnectorRegistry();
  const connectors = [];

  for (const connector of Object.values(registry)) {
    const configPath = getConnectorConfigPath(connector.id);
    const configExists = await pathExists(configPath);
    const requiredEnvStatus = connector.requiredEnv.map((key) => ({
      key,
      set: Boolean(process.env[key]),
    }));
    const allRequiredEnvSet = requiredEnvStatus.every((env) => env.set);

    connectors.push({
      authConfigured: connector.requiredEnv.length === 0 || allRequiredEnvSet,
      backend: connector.backend,
      configExists,
      configPath,
      description: connector.description,
      displayName: connector.displayName,
      id: connector.id,
      posture: connector.posture,
      rawDir: getConnectorRawDir(connector.id),
      readyForIngestion: configExists && allRequiredEnvSet,
      requiredEnv: connector.requiredEnv,
      requiredEnvStatus,
    });
  }

  return {
    note: "Secret values are never returned. requiredEnvStatus reports presence only.",
    homeDir: getOpenWikiHomeDir(),
    wikiDir: getOpenWikiLocalWikiDir(),
    connectors,
  };
}

async function ingestConnector(
  connectorId: ConnectorId,
  options: ConnectorIngestOptions,
) {
  const registry = createConnectorRegistry();

  return registry[connectorId].ingest(options);
}

async function listMcpToolsForConnector(
  connectorId: ConnectorId,
  endpoint: McpEndpointId,
) {
  if (!isMcpConnectorId(connectorId)) {
    throw new Error(`Connector ${connectorId} is not MCP-backed.`);
  }

  return await discoverMcpConnectorTools(connectorId, { endpoint });
}

async function callMcpToolForConnector(
  connectorId: ConnectorId,
  toolName: string,
  args: Record<string, unknown>,
  endpoint: McpEndpointId,
) {
  if (!isMcpConnectorId(connectorId)) {
    throw new Error(`Connector ${connectorId} is not MCP-backed.`);
  }

  return await callMcpConnectorTool(connectorId, toolName, args, { endpoint });
}

async function findGatewayDatasourceTools(
  connectorId: ConnectorId,
  queries: string[],
) {
  if (!isMcpConnectorId(connectorId)) {
    throw new Error(`Connector ${connectorId} is not MCP-backed.`);
  }

  return await discoverGatewayDatasourceTools(connectorId, queries);
}

async function readGatewayDatasource(
  input: Parameters<typeof callGatewayDatasourceRead>[0],
) {
  if (!isMcpConnectorId(input.connectorId)) {
    throw new Error(`Connector ${input.connectorId} is not MCP-backed.`);
  }

  return await callGatewayDatasourceRead(input);
}

function getMcpEndpointInput(input: unknown): McpEndpointId {
  if (!isRecord(input) || input.endpoint === undefined) {
    return "default";
  }

  if (!isMcpEndpointId(input.endpoint)) {
    throw new Error(
      `Expected MCP endpoint input: ${MCP_ENDPOINT_IDS.join(" or ")}`,
    );
  }

  return input.endpoint;
}

function isMcpEndpointId(value: unknown): value is McpEndpointId {
  return MCP_ENDPOINT_IDS.some((endpoint) => endpoint === value);
}

async function ingestAllConnectors() {
  const registry = createConnectorRegistry();
  const results = [];

  for (const connector of Object.values(registry)) {
    results.push(await connector.ingest());
  }

  return {
    results,
  };
}

async function listRawItems(connectorId: ConnectorId) {
  const rawDir = getConnectorRawDir(connectorId);
  const files = await listFiles(rawDir, rawDir);
  const latestRunId = getLatestRunId(files);

  return {
    connectorId,
    files,
    latestFiles:
      latestRunId === null
        ? []
        : files.filter((file) => file.startsWith(`${latestRunId}/`)),
    latestRunId,
    note: "Files are sorted newest run first so agents should prefer latestFiles for current answers.",
    rawDir,
  };
}

async function readRawItem(
  connectorId: ConnectorId,
  relativePath: string,
  maxBytes: number,
) {
  const filePath = resolveConnectorRawPath(connectorId, relativePath);
  const fileHandle = await open(
    filePath,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
  );

  try {
    const fileStat = await fileHandle.stat();

    if (!fileStat.isFile()) {
      throw new Error("Raw item path must point to a file.");
    }

    const content = await fileHandle.readFile("utf8");
    const limit = Math.max(1, Math.min(maxBytes, 500_000));

    return {
      connectorId,
      content: content.slice(0, limit),
      filePath,
      truncated: content.length > limit,
    };
  } finally {
    await fileHandle.close();
  }
}

async function listFiles(
  rootDir: string,
  currentDir: string,
): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(currentDir, { withFileTypes: true });
  } catch (error) {
    if (isFileNotFoundError(error)) {
      return [];
    }

    throw error;
  }

  const files: string[] = [];
  for (const entry of entries) {
    const entryPath = path.join(currentDir, entry.name);

    if (entry.isDirectory()) {
      files.push(...(await listFiles(rootDir, entryPath)));
    } else if (entry.isFile()) {
      files.push(path.relative(rootDir, entryPath));
    }
  }

  return files.sort(compareRawFilePaths);
}

function compareRawFilePaths(left: string, right: string): number {
  const [leftRun = "", leftFile = ""] = left.split("/", 2);
  const [rightRun = "", rightFile = ""] = right.split("/", 2);

  if (leftRun !== rightRun) {
    return rightRun.localeCompare(leftRun);
  }

  return leftFile.localeCompare(rightFile);
}

function getLatestRunId(files: string[]): string | null {
  const firstFile = files[0];
  if (!firstFile) {
    return null;
  }

  return firstFile.split("/", 1)[0] ?? null;
}

function getConnectorId(input: unknown, key: string): ConnectorId {
  const value = getStringInput(input, key);

  if (!isConnectorId(value)) {
    throw new Error(`Invalid connector ID: ${value}`);
  }

  return value;
}

function getIngestOptions(input: unknown): ConnectorIngestOptions {
  return {
    limit: getNumberInput(input, "limit") ?? undefined,
    streams: getStringArrayInput(input, "streams"),
    windowHours: getNumberInput(input, "windowHours") ?? undefined,
  };
}

function getStringInput(input: unknown, key: string): string {
  if (!isRecord(input) || typeof input[key] !== "string") {
    throw new Error(`Missing string input: ${key}`);
  }

  return input[key];
}

function getNumberInput(input: unknown, key: string): number | null {
  if (!isRecord(input) || input[key] === undefined) {
    return null;
  }

  if (typeof input[key] !== "number") {
    throw new Error(`Expected number input: ${key}`);
  }

  return input[key];
}

function getRecordInput(
  input: unknown,
  key: string,
): Record<string, unknown> | null {
  if (!isRecord(input) || input[key] === undefined) {
    return null;
  }

  if (!isRecord(input[key])) {
    throw new Error(`Expected object input: ${key}`);
  }

  return input[key];
}

function getStringArrayInput(
  input: unknown,
  key: string,
): string[] | undefined {
  if (!isRecord(input) || input[key] === undefined) {
    return undefined;
  }

  if (!Array.isArray(input[key])) {
    throw new Error(`Expected string array input: ${key}`);
  }

  return input[key].filter(
    (value): value is string => typeof value === "string",
  );
}

function getRequiredStringArrayInput(input: unknown, key: string): string[] {
  if (
    !isRecord(input) ||
    !Array.isArray(input[key]) ||
    input[key].length === 0 ||
    !input[key].every((value) => typeof value === "string")
  ) {
    throw new Error(`Expected non-empty string array input: ${key}`);
  }

  return input[key];
}

function stringifyToolResult(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isFileNotFoundError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (isFileNotFoundError(error)) {
      return false;
    }

    throw error;
  }
}
