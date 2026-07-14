import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  ensureConnectorHome,
  getConnectorToolCatalogPath,
} from "../openwiki-home.js";
import {
  readGatewaySkillCatalog,
  type GatewaySkillCatalog,
} from "./downstream-policy.js";
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

export type GatewayDownstreamToolCatalog = GatewaySkillCatalog & {
  connectorId: ConnectorId;
  generatedAt: string;
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
  catalog: { generatedAt: string },
  now = Date.now(),
): boolean {
  const generatedAt = Date.parse(catalog.generatedAt);
  const age = now - generatedAt;
  return Number.isFinite(generatedAt) && age >= 0 && age <= TOOL_CATALOG_TTL_MS;
}

export async function readGatewayDownstreamToolCatalog(
  connectorId: ConnectorId,
): Promise<GatewayDownstreamToolCatalog | null> {
  try {
    const value = JSON.parse(
      await readFile(
        getConnectorToolCatalogPath(connectorId, "gateway-downstream"),
        "utf8",
      ),
    ) as unknown;

    return isGatewayDownstreamToolCatalog(value, connectorId) ? value : null;
  } catch (error) {
    if (isFileNotFoundError(error) || error instanceof SyntaxError) {
      return null;
    }

    throw error;
  }
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

export async function writeGatewayDownstreamToolCatalog(input: {
  catalog: GatewaySkillCatalog;
  config: McpConnectorConfig;
  connectorId: ConnectorId;
  generatedAt?: string;
}): Promise<string> {
  await ensureConnectorHome(input.connectorId);
  const filePath = getConnectorToolCatalogPath(
    input.connectorId,
    "gateway-downstream",
  );
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await writeFile(
    filePath,
    `${JSON.stringify(
      {
        ...input.catalog,
        connectorId: input.connectorId,
        generatedAt: input.generatedAt ?? new Date().toISOString(),
        transport: sanitizeMcpTransport(input.config.transport),
      } satisfies GatewayDownstreamToolCatalog,
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

function isGatewayDownstreamToolCatalog(
  value: unknown,
  connectorId: ConnectorId,
): value is GatewayDownstreamToolCatalog {
  if (value === null || typeof value !== "object") {
    return false;
  }

  const catalog = value as Record<string, unknown>;
  return (
    catalog.connectorId === connectorId &&
    typeof catalog.generatedAt === "string" &&
    Array.isArray(catalog.skill_order) &&
    catalog.skill_order.every((skill) => typeof skill === "string") &&
    readGatewaySkillCatalog(catalog) !== undefined
  );
}

function isFileNotFoundError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
