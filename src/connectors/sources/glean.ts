import {
  OPENWIKI_GLEAN_ACCESS_TOKEN_ENV_KEY,
  OPENWIKI_GLEAN_REFRESH_TOKEN_ENV_KEY,
} from "../../constants.js";
import {
  createRunId,
  readConnectorConfig,
  readConnectorState,
  updateStateWithRun,
  writeConnectorState,
  writeRawJson,
} from "../io.js";
import { listMcpTools, type McpToolDescriptor } from "../mcp-client.js";
import type {
  ConnectorDefinition,
  ConnectorIngestResult,
  ConnectorRuntime,
} from "../types.js";
import { resolveGleanTarget, type GleanTargetConfig } from "./glean-backend.js";

export { resolveGleanBackendUrl } from "./glean-backend.js";

export type GleanProbeTransport = {
  listTools: (input: { mcpUrl: string }) => Promise<McpToolDescriptor[]>;
};

type GleanConfig = GleanTargetConfig & {
  enabled?: boolean;
};

const definition: ConnectorDefinition = {
  backend: "direct-api",
  description: "Probes a Glean tenant's MCP tool catalog.",
  displayName: "Glean",
  id: "glean",
  requiredEnv: [
    OPENWIKI_GLEAN_ACCESS_TOKEN_ENV_KEY,
    OPENWIKI_GLEAN_REFRESH_TOKEN_ENV_KEY,
  ],
  supportsAgenticDiscovery: false,
};

const defaultTransport: GleanProbeTransport = {
  listTools: async ({ mcpUrl }) => {
    const result = await listMcpTools({
      transport: {
        headers: {
          Authorization: `Bearer \${${OPENWIKI_GLEAN_ACCESS_TOKEN_ENV_KEY}}`,
        },
        type: "http",
        url: mcpUrl,
      },
    });

    return result.tools;
  },
};

export function createGleanConnector(overrides?: {
  transport?: GleanProbeTransport;
}): ConnectorRuntime {
  const transport = overrides?.transport ?? defaultTransport;

  return {
    ...definition,
    ingest: async (): Promise<ConnectorIngestResult> => {
      const runId = createRunId();
      const config = await readConnectorConfig<GleanConfig>("glean", {
        enabled: false,
        mcpPath: "/mcp/default",
      });

      if (config.enabled !== true) {
        return createEmptyResult(
          runId,
          "skipped",
          "Glean connector is not enabled. Run openwiki auth glean or set enabled: true in ~/.openwiki/connectors/glean/config.json.",
        );
      }

      let target: Awaited<ReturnType<typeof resolveGleanTarget>>;
      try {
        target = await resolveGleanTarget(config);
      } catch (error) {
        return createEmptyResult(
          runId,
          "error",
          error instanceof Error ? error.message : String(error),
        );
      }

      if (
        !process.env[OPENWIKI_GLEAN_ACCESS_TOKEN_ENV_KEY] &&
        !process.env[OPENWIKI_GLEAN_REFRESH_TOKEN_ENV_KEY]
      ) {
        return createEmptyResult(
          runId,
          "error",
          "Glean credentials are missing. Run openwiki auth glean to sign in.",
        );
      }

      let tools: McpToolDescriptor[];
      try {
        tools = await transport.listTools({ mcpUrl: target.mcpUrl });
      } catch {
        return createEmptyResult(
          runId,
          "error",
          "Glean MCP probe failed. Run openwiki auth glean to sign in again, then retry.",
        );
      }

      const fetchedAt = new Date().toISOString();
      const rawFiles = [
        await writeRawJson("glean", runId, "probe.json", {
          backendUrl: target.backendUrl,
          fetchedAt,
          mcpUrl: target.mcpUrl,
          toolCount: tools.length,
          tools: tools.map(({ annotations, description, name }) => ({
            annotations,
            description,
            name,
          })),
        }),
      ];
      const state = await readConnectorState("glean");
      await writeConnectorState(
        "glean",
        updateStateWithRun(state, {
          at: fetchedAt,
          rawFiles,
          runId,
          status: "success",
          warnings: [],
        }),
      );

      return {
        connectorId: "glean",
        message: `Probed ${tools.length} MCP tool(s) at ${target.backendUrl}.`,
        rawFiles,
        runId,
        statePath: "~/.openwiki/connectors/glean/state.json",
        status: "success",
        warnings: [],
      };
    },
  };
}

function createEmptyResult(
  runId: string,
  status: "error" | "skipped",
  message: string,
): ConnectorIngestResult {
  return {
    connectorId: "glean",
    message,
    rawFiles: [],
    runId,
    statePath: "~/.openwiki/connectors/glean/state.json",
    status,
    warnings: [],
  };
}
