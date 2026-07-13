import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  ensureConnectorHome,
  getConnectorToolCatalogPath,
} from "../openwiki-home.js";
import type { McpToolDescriptor } from "./mcp-client.js";
import { sanitizeMcpTransport } from "./mcp-shared.js";
import type { ToolWithPolicy } from "./tool-policy.js";
import type {
  ConnectorId,
  McpConnectorConfig,
  McpEndpointId,
} from "./types.js";

export const TOOL_CATALOG_TTL_MS = 24 * 60 * 60 * 1_000;

export type McpToolCatalog = {
  connectorId: ConnectorId;
  endpoint: McpEndpointId;
  generatedAt: string;
  tools: ToolWithPolicy<McpToolDescriptor>[];
  transport: ReturnType<typeof sanitizeMcpTransport>;
};

export async function readToolCatalog(
  connectorId: ConnectorId,
  endpoint: McpEndpointId,
): Promise<McpToolCatalog | null> {
  try {
    const value = JSON.parse(
      await readFile(
        getConnectorToolCatalogPath(connectorId, endpoint),
        "utf8",
      ),
    ) as unknown;

    return isToolCatalog(value, connectorId, endpoint) ? value : null;
  } catch (error) {
    if (isFileNotFoundError(error) || error instanceof SyntaxError) {
      return null;
    }

    throw error;
  }
}

export function isToolCatalogFresh(
  catalog: McpToolCatalog,
  now = Date.now(),
): boolean {
  const generatedAt = Date.parse(catalog.generatedAt);
  const age = now - generatedAt;
  return Number.isFinite(generatedAt) && age >= 0 && age <= TOOL_CATALOG_TTL_MS;
}

export async function writeToolCatalog(input: {
  config: McpConnectorConfig;
  connectorId: ConnectorId;
  endpoint: McpEndpointId;
  generatedAt?: string;
  tools: ToolWithPolicy<McpToolDescriptor>[];
}): Promise<string> {
  await ensureConnectorHome(input.connectorId);
  const filePath = getConnectorToolCatalogPath(
    input.connectorId,
    input.endpoint,
  );
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await writeFile(
    filePath,
    `${JSON.stringify(
      {
        connectorId: input.connectorId,
        endpoint: input.endpoint,
        generatedAt: input.generatedAt ?? new Date().toISOString(),
        tools: input.tools,
        transport: sanitizeMcpTransport(input.config.transport),
      } satisfies McpToolCatalog,
      null,
      2,
    )}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  await chmod(filePath, 0o600);
  return filePath;
}

function isToolCatalog(
  value: unknown,
  connectorId: ConnectorId,
  endpoint: McpEndpointId,
): value is McpToolCatalog {
  if (value === null || typeof value !== "object") {
    return false;
  }

  const catalog = value as Record<string, unknown>;
  return (
    catalog.connectorId === connectorId &&
    catalog.endpoint === endpoint &&
    typeof catalog.generatedAt === "string" &&
    Array.isArray(catalog.tools) &&
    catalog.tools.every(
      (tool) =>
        tool !== null &&
        typeof tool === "object" &&
        typeof (tool as Record<string, unknown>).name === "string",
    )
  );
}

function isFileNotFoundError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
