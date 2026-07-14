import {
  collectToolDescriptors,
  readGatewaySkillCatalog,
  resolveDownstreamToolPolicy,
  resolveDownstreamToolPolicyFromDescriptors,
  type DownstreamToolDescriptor,
  type DownstreamToolPolicyDecision,
  type DownstreamToolRef,
  type GatewaySkillCatalog,
} from "./downstream-policy.js";
import {
  registerGatewayRead,
  type GatewayTripwireState,
} from "./gateway-tripwires.js";
import { createRunId, readConnectorState, writeRawJson } from "./io.js";
import { executeMcpTool } from "./mcp-client.js";
import {
  recordMcpRun,
  resolveMcpConnectorConfig,
  sanitizeMcpValue,
} from "./mcp-runtime-support.js";
import { sanitizeMcpTransport } from "./mcp-shared.js";
import { createConnectorRegistry, type ConnectorRegistry } from "./registry.js";
import {
  isToolCatalogFresh,
  readGatewayDownstreamToolCatalog,
  writeGatewayDownstreamToolCatalog,
} from "./tool-catalog.js";
import type { ConnectorId } from "./types.js";

export type GatewayDatasourceTool = DownstreamToolDescriptor & {
  name: string;
  policy: DownstreamToolPolicyDecision;
};

export type GatewayDatasourceDiscoveryResult = {
  connectorId: ConnectorId;
  rawFile: string;
  runId: string;
  tools: GatewayDatasourceTool[];
};

export type GatewayDatasourceDiscoveryOptions = {
  registry?: ConnectorRegistry;
};

export type GatewayDatasourceReadResult = DownstreamToolRef & {
  allowedBy: string;
  connectorId: ConnectorId;
  rawFile: string;
  result: unknown;
  runId: string;
};

export type GatewayDatasourceReadInput = DownstreamToolRef & {
  args: Record<string, unknown>;
  connectorId: ConnectorId;
  registry?: ConnectorRegistry;
  tripwires: GatewayTripwireState;
};

export class GatewayDatasourcePolicyError extends Error {
  readonly rule: DownstreamToolPolicyDecision["rule"];

  constructor(decision: DownstreamToolPolicyDecision) {
    super(decision.reason);
    this.name = "GatewayDatasourcePolicyError";
    this.rule = decision.rule;
  }
}

export async function discoverGatewayDatasourceTools(
  connectorId: ConnectorId,
  queries: string[],
  options: GatewayDatasourceDiscoveryOptions = {},
): Promise<GatewayDatasourceDiscoveryResult> {
  if (queries.length === 0) {
    throw new Error(
      "Gateway datasource discovery requires at least one find_skills query.",
    );
  }

  const registry = options.registry ?? createConnectorRegistry();
  const runId = createRunId();
  const state = await readConnectorState(connectorId);
  const config = await resolveMcpConnectorConfig(
    connectorId,
    "gateway",
    registry,
  );
  const result = await executeMcpTool(config, "find_skills", { queries });
  const catalog = parseGatewaySkillCatalog(result);
  const existing = await readGatewayDownstreamToolCatalog(connectorId);
  const mergedCatalog = mergeGatewaySkillCatalog(existing, catalog);
  const generatedAt = new Date().toISOString();
  await writeGatewayDownstreamToolCatalog({
    catalog: mergedCatalog,
    config,
    connectorId,
    generatedAt,
  });

  const tools = annotateGatewayDatasourceTools(
    mergedCatalog,
    config.allowedTools,
  );
  const rawFile = await writeRawJson(
    connectorId,
    runId,
    "gateway-skills.json",
    {
      catalog,
      connectorId,
      generatedAt,
      queries,
      tools,
      transport: sanitizeMcpTransport(config.transport),
    },
  );

  await recordMcpRun(connectorId, state, {
    rawFiles: [rawFile],
    runId,
    status: "success",
    warnings: [],
  });

  return { connectorId, rawFile, runId, tools };
}

export async function callGatewayDatasourceRead(
  input: GatewayDatasourceReadInput,
): Promise<GatewayDatasourceReadResult> {
  const catalog = await readGatewayDownstreamToolCatalog(input.connectorId);
  if (catalog === null || !isToolCatalogFresh(catalog)) {
    throw new Error(
      `No fresh gateway downstream tool catalog is available for ${input.connectorId}. Run openwiki_find_gateway_datasource_tools first, then use an exact discovered serverId and toolName.`,
    );
  }

  const registry = input.registry ?? createConnectorRegistry();
  const config = await resolveMcpConnectorConfig(
    input.connectorId,
    "gateway",
    registry,
  );
  const { decision } = resolveDownstreamToolPolicy({
    allowedTools: config.allowedTools,
    catalog,
    ref: { serverId: input.serverId, toolName: input.toolName },
  });
  if (!decision.allowed) {
    throw new GatewayDatasourcePolicyError(decision);
  }

  registerGatewayRead(input.tripwires, {
    args: input.args,
    serverId: input.serverId,
    toolName: input.toolName,
  });

  const runId = createRunId();
  const state = await readConnectorState(input.connectorId);
  const result = await executeMcpTool(config, "run_tool", {
    arguments: input.args,
    server_id: input.serverId,
    tool_name: input.toolName,
  });
  const rawFile = await writeRawJson(
    input.connectorId,
    runId,
    "gateway-datasource-read.json",
    {
      args: sanitizeMcpValue(input.args),
      connectorId: input.connectorId,
      generatedAt: new Date().toISOString(),
      policy: decision,
      result,
      serverId: input.serverId,
      toolName: input.toolName,
      transport: sanitizeMcpTransport(config.transport),
    },
  );

  await recordMcpRun(input.connectorId, state, {
    rawFiles: [rawFile],
    runId,
    status: "success",
    warnings: [],
  });

  return {
    allowedBy: decision.reason,
    connectorId: input.connectorId,
    rawFile,
    result,
    runId,
    serverId: input.serverId,
    toolName: input.toolName,
  };
}

function parseGatewaySkillCatalog(result: unknown): GatewaySkillCatalog {
  const content =
    result !== null && typeof result === "object" && !Array.isArray(result)
      ? (result as Record<string, unknown>).content
      : undefined;
  if (!Array.isArray(content)) {
    return createEmptyGatewaySkillCatalog();
  }

  for (const item of content) {
    const text =
      item !== null && typeof item === "object" && !Array.isArray(item)
        ? (item as Record<string, unknown>).text
        : undefined;
    if (typeof text !== "string") {
      continue;
    }

    try {
      const catalog = readGatewaySkillCatalog(JSON.parse(text) as unknown);
      if (catalog !== undefined) {
        return catalog;
      }
    } catch {
      continue;
    }
  }

  return createEmptyGatewaySkillCatalog();
}

function mergeGatewaySkillCatalog(
  existing: GatewaySkillCatalog | null,
  discovered: GatewaySkillCatalog,
): GatewaySkillCatalog {
  const previous = existing ?? createEmptyGatewaySkillCatalog();

  return {
    ...previous,
    ...discovered,
    skill_order: [
      ...new Set([...previous.skill_order, ...discovered.skill_order]),
    ],
    skills: {
      ...previous.skills,
      ...discovered.skills,
    },
  };
}

function annotateGatewayDatasourceTools(
  catalog: GatewaySkillCatalog,
  allowedTools?: string[],
): GatewayDatasourceTool[] {
  const descriptors = collectToolDescriptors(catalog, {
    preserveUnknownFields: true,
  });

  return descriptors.map((descriptor) => {
    const serverId = readDescriptorServerId(descriptor) ?? "";
    const toolName = descriptor.name;
    const { decision } = resolveDownstreamToolPolicyFromDescriptors({
      allowedTools,
      descriptors,
      ref: { serverId, toolName },
    });

    return { ...descriptor, policy: decision };
  });
}

function readDescriptorServerId(
  descriptor: DownstreamToolDescriptor,
): string | undefined {
  if (descriptor.server_id !== undefined) {
    return descriptor.server_id;
  }

  return descriptor.instances?.find(
    (instance) => instance.server_id !== undefined,
  )?.server_id;
}

function createEmptyGatewaySkillCatalog(): GatewaySkillCatalog {
  return { skill_order: [], skills: {} };
}
