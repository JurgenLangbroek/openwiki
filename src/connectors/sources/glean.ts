import {
  OPENWIKI_GLEAN_ACCESS_TOKEN_ENV_KEY,
  OPENWIKI_GLEAN_REFRESH_TOKEN_ENV_KEY,
} from "../../constants.js";
import { refreshOAuthAccessToken } from "../../auth/tokens.js";
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
  fetchFeed: (input: { backendUrl: string }) => Promise<unknown>;
  listTools: (input: { mcpUrl: string }) => Promise<McpToolDescriptor[]>;
};

type GleanConfig = GleanTargetConfig & {
  enabled?: boolean;
};

const definition: ConnectorDefinition = {
  backend: "direct-api",
  description: "Probes a Glean tenant's MCP tool catalog and pulls its feed.",
  displayName: "Glean",
  id: "glean",
  requiredEnv: [
    OPENWIKI_GLEAN_ACCESS_TOKEN_ENV_KEY,
    OPENWIKI_GLEAN_REFRESH_TOKEN_ENV_KEY,
  ],
  supportsAgenticDiscovery: false,
};

const defaultTransport: GleanProbeTransport = {
  fetchFeed: async ({ backendUrl }) => await fetchGleanFeed(backendUrl),
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
      let feedResponse: unknown;
      try {
        feedResponse = await transport.fetchFeed({
          backendUrl: target.backendUrl,
        });
      } catch (error) {
        const endpointUnavailable = isFeedEndpointUnavailable(error);
        const warnings = endpointUnavailable
          ? [
              "Glean feed endpoint is unavailable for this tenant; the MCP probe was kept.",
            ]
          : [];
        const status = endpointUnavailable ? "success" : "error";
        await writeConnectorState(
          "glean",
          updateStateWithRun(state, {
            at: fetchedAt,
            rawFiles,
            runId,
            status,
            warnings,
          }),
        );

        return {
          connectorId: "glean",
          message: endpointUnavailable
            ? `Probed ${tools.length} MCP tool(s) at ${target.backendUrl}; the Glean feed endpoint is unavailable.`
            : "Glean feed pull failed. Run openwiki auth glean to sign in again, then retry.",
          rawFiles,
          runId,
          statePath: "~/.openwiki/connectors/glean/state.json",
          status,
          warnings,
        };
      }
      const feed = pullFeedStream({
        fetchedAt,
        response: feedResponse,
        seenIds: state.seenIds?.feed ?? [],
      });
      rawFiles.push(
        await writeRawJson("glean", runId, "feed.json", feed.artifact),
      );
      await writeConnectorState(
        "glean",
        updateStateWithRun(
          {
            ...state,
            seenIds: {
              ...state.seenIds,
              feed: feed.seenIds,
            },
          },
          {
            at: fetchedAt,
            rawFiles,
            runId,
            status: "success",
            warnings: [],
          },
        ),
      );

      return {
        connectorId: "glean",
        message: `Probed ${tools.length} MCP tool(s) at ${target.backendUrl}; pulled ${feed.artifact.counts.fetched} feed item(s) (${feed.artifact.counts.new} new).`,
        rawFiles,
        runId,
        statePath: "~/.openwiki/connectors/glean/state.json",
        status: "success",
        warnings: [],
      };
    },
  };
}

const FEED_CATEGORIES = [
  "RECENT",
  "MENTION",
  "EVENT",
  "TASK",
  "FOLLOW_UP",
] as const;
const MAX_SEEN_IDS_PER_STREAM = 5_000;

type JsonObject = Record<string, unknown>;

async function fetchGleanFeed(backendUrl: string): Promise<unknown> {
  const accessToken = process.env[OPENWIKI_GLEAN_ACCESS_TOKEN_ENV_KEY];
  if (!accessToken) {
    throw new Error("Glean access token is missing.");
  }

  const response = await requestGleanFeed(backendUrl, accessToken);
  if (response.status !== 401) {
    return await parseGleanFeedResponse(response);
  }

  const refreshedToken = await refreshOAuthAccessToken("glean");
  return await parseGleanFeedResponse(
    await requestGleanFeed(backendUrl, refreshedToken),
  );
}

async function requestGleanFeed(
  backendUrl: string,
  accessToken: string,
): Promise<Response> {
  return await fetch(`${backendUrl}/rest/api/v1/feed`, {
    body: JSON.stringify({ categories: FEED_CATEGORIES }),
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    method: "POST",
  });
}

async function parseGleanFeedResponse(response: Response): Promise<unknown> {
  if (!response.ok) {
    throw Object.assign(
      new Error(
        `Glean feed request failed: ${response.status} ${response.statusText}`,
      ),
      { status: response.status },
    );
  }

  return await response.json();
}

function pullFeedStream({
  fetchedAt,
  response,
  seenIds,
}: {
  fetchedAt: string;
  response: unknown;
  seenIds: string[];
}): {
  artifact: {
    counts: {
      deduplicated: number;
      fetched: number;
      new: number;
      skipped: number;
    };
    fetchedAt: string;
    items: JsonObject[];
    stream: "feed";
  };
  seenIds: string[];
} {
  const rawItems = extractFeedItems(response);
  const priorIds = new Set(seenIds);
  const newIds: string[] = [];
  let deduplicated = 0;
  let skipped = 0;
  const items: JsonObject[] = [];

  for (const rawItem of rawItems) {
    const item = normalizeFeedItem(rawItem.value, rawItem.category, fetchedAt);
    if (!item) {
      skipped += 1;
      continue;
    }

    const identity = String(item.id);
    if (priorIds.has(identity)) {
      deduplicated += 1;
      continue;
    }

    priorIds.add(identity);
    newIds.push(identity);
    items.push(item);
  }

  return {
    artifact: {
      counts: {
        deduplicated,
        fetched: rawItems.length,
        new: items.length,
        skipped,
      },
      fetchedAt,
      items,
      stream: "feed",
    },
    seenIds: [...seenIds, ...newIds].slice(-MAX_SEEN_IDS_PER_STREAM),
  };
}

function extractFeedItems(
  response: unknown,
): { category?: string; value: JsonObject }[] {
  if (Array.isArray(response)) {
    return response.filter(isJsonObject).map((value) => ({ value }));
  }
  if (!isJsonObject(response)) {
    return [];
  }

  if (Array.isArray(response.items)) {
    return response.items.filter(isJsonObject).map((value) => ({ value }));
  }
  if (Array.isArray(response.results)) {
    return response.results.filter(isJsonObject).flatMap(expandFeedResult);
  }

  if (!Array.isArray(response.categories)) {
    return [];
  }

  return response.categories.flatMap((group) => {
    if (!isJsonObject(group)) {
      return [];
    }
    const items = firstArray(group.items, group.results) ?? [];
    const category = readString(group, "category", "name");
    return items.filter(isJsonObject).map((value) => ({ category, value }));
  });
}

function expandFeedResult(
  result: JsonObject,
): { category?: string; value: JsonObject }[] {
  if (!isJsonObject(result.primaryEntry)) {
    return [{ value: result }];
  }

  const category = readString(result, "category");
  const secondaryEntries = Array.isArray(result.secondaryEntries)
    ? result.secondaryEntries.filter(isJsonObject)
    : [];
  return [result.primaryEntry, ...secondaryEntries].map((value) => ({
    category,
    value,
  }));
}

function normalizeFeedItem(
  rawItem: JsonObject,
  fallbackCategory: string | undefined,
  fetchedAt: string,
): JsonObject | null {
  const document = isJsonObject(rawItem.document) ? rawItem.document : rawItem;
  const metadata = isJsonObject(document.metadata) ? document.metadata : {};
  const url =
    readString(document, "url", "permalink") ??
    readString(rawItem, "url", "viewURL", "permalink");
  const documentId =
    readString(document, "id", "documentId") ??
    readString(rawItem, "id", "documentId");
  if (!url) {
    return null;
  }
  const id = documentId ?? url;

  return removeUndefinedValues({
    app:
      readStringOrName(rawItem.app) ??
      readString(document, "app") ??
      readString(metadata, "app"),
    category: readString(rawItem, "category") ?? fallbackCategory,
    createdAt:
      readString(rawItem, "createdAt", "createTime") ??
      readString(document, "createdAt", "createTime") ??
      readString(metadata, "createdAt", "createTime"),
    datasource:
      readString(rawItem, "datasource") ??
      readString(document, "datasource") ??
      readString(metadata, "datasource"),
    fetchedAt,
    id,
    snippet: readSnippet(rawItem, document),
    title:
      readString(document, "title", "name") ?? readString(rawItem, "title"),
    updatedAt:
      readString(rawItem, "updatedAt", "updateTime") ??
      readString(document, "updatedAt", "updateTime") ??
      readString(metadata, "updatedAt", "updateTime"),
    url,
  });
}

function readSnippet(
  rawItem: JsonObject,
  document: JsonObject,
): string | undefined {
  const direct =
    readString(rawItem, "snippet", "justification") ??
    readString(document, "snippet");
  if (direct) {
    return direct;
  }

  const snippets = firstArray(rawItem.snippets, document.snippets);
  const firstSnippet = snippets?.[0];
  return typeof firstSnippet === "string"
    ? firstSnippet
    : isJsonObject(firstSnippet)
      ? readString(firstSnippet, "snippet", "text")
      : undefined;
}

function readString(object: JsonObject, ...keys: string[]): string | undefined {
  for (const key of keys) {
    if (typeof object[key] === "string" && object[key].length > 0) {
      return object[key];
    }
  }
  return undefined;
}

function firstArray(...values: unknown[]): unknown[] | undefined {
  return values.find(Array.isArray);
}

function readStringOrName(value: unknown): string | undefined {
  return typeof value === "string"
    ? value
    : isJsonObject(value)
      ? readString(value, "name", "displayName", "title", "id")
      : undefined;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function removeUndefinedValues(value: JsonObject): JsonObject {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  );
}

function isFeedEndpointUnavailable(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("status" in error)) {
    return false;
  }

  return error.status === 403 || error.status === 404;
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
