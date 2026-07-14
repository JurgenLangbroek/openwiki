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
import {
  createGatewayUnavailableWarning,
  isMcpEndpointUnavailableError,
} from "../mcp-errors.js";
import { listMcpTools, type McpToolDescriptor } from "../mcp-client.js";
import { annotateToolsWithPolicy } from "../tool-policy.js";
import { writeToolCatalog } from "../tool-catalog.js";
import type {
  ConnectorDefinition,
  ConnectorIngestResult,
  ConnectorRetentionConfig,
  ConnectorRuntime,
  ConnectorState,
  McpConnectorConfig,
  McpEndpointId,
} from "../types.js";
import { resolveGleanTarget, type GleanTargetConfig } from "./glean-backend.js";

export { resolveGleanBackendUrl } from "./glean-backend.js";

export type ExpansionCandidate = {
  id: string;
  sourceStream: EvidenceStreamName;
  tier: number;
  title?: string;
  url?: string;
};

export type GleanProbeTransport = {
  fetchCalendar: (input: { backendUrl: string }) => Promise<unknown>;
  fetchExpansion: (input: {
    backendUrl: string;
    item: ExpansionCandidate;
  }) => Promise<unknown>;
  fetchFeed: (input: { backendUrl: string }) => Promise<unknown>;
  fetchMessages: (input: {
    backendUrl: string;
    sinceDate: string;
  }) => Promise<unknown>;
  fetchMyWork: (input: {
    backendUrl: string;
    sinceDate: string;
  }) => Promise<unknown>;
  listTools: (input: {
    endpoint: McpEndpointId;
    mcpUrl: string;
  }) => Promise<McpToolDescriptor[]>;
};

type GleanConfig = GleanTargetConfig &
  ConnectorRetentionConfig & {
    allowedTools?: string[];
    enabled?: boolean;
    expansion?: {
      maxItems?: number;
      transcriptDatasources?: string[];
    };
    messagingApps?: string[];
    windowHours?: number;
  };

const definition: ConnectorDefinition = {
  backend: "direct-api",
  description:
    "Probes a Glean tenant's MCP tool catalog and pulls deterministic evidence streams.",
  displayName: "Glean",
  id: "glean",
  posture: "hybrid",
  requiredEnv: [
    OPENWIKI_GLEAN_ACCESS_TOKEN_ENV_KEY,
    OPENWIKI_GLEAN_REFRESH_TOKEN_ENV_KEY,
  ],
};

const DEFAULT_GLEAN_CONFIG: GleanConfig = {
  enabled: false,
  expansion: {
    maxItems: 20,
    transcriptDatasources: ["fellow"],
  },
  gatewayPath: "/mcp/gateway/proxy",
  mcpPath: "/mcp/default",
  messagingApps: ["slack"],
  windowHours: 48,
};
const GLEAN_DISABLED_MESSAGE =
  "Glean connector is not enabled. Run openwiki auth glean or set enabled: true in ~/.openwiki/connectors/glean/config.json.";

export function createGleanConnector(overrides?: {
  transport?: GleanProbeTransport;
}): ConnectorRuntime {
  return {
    ...definition,
    discoverLiveTools: async (): Promise<ConnectorIngestResult> => {
      const preparation = await prepareGleanLiveTools(overrides?.transport);
      if (preparation.kind === "result") {
        return preparation.result;
      }

      const {
        fetchedAt,
        liveTools,
        rawFiles,
        runId,
        target,
        toolCount,
        warnings,
      } = preparation;
      const state = await readConnectorState("glean");
      await writeConnectorState(
        "glean",
        updateStateWithRun(state, {
          at: fetchedAt,
          rawFiles,
          runId,
          status: "success",
          warnings,
        }),
      );

      return {
        connectorId: "glean",
        liveTools,
        message: `Probed ${toolCount} MCP tool(s) at ${target.backendUrl}.`,
        rawFiles,
        runId,
        statePath: "~/.openwiki/connectors/glean/state.json",
        status: "success",
        warnings,
      };
    },
    mcpEndpoints: ["default", "gateway"],
    ingest: async (): Promise<ConnectorIngestResult> => {
      const preparation = await prepareGleanLiveTools(overrides?.transport);
      if (preparation.kind === "result") {
        return preparation.result;
      }

      const {
        config,
        fetchedAt,
        liveTools,
        rawFiles,
        runId,
        target,
        toolCount,
        transport,
        warnings,
      } = preparation;
      const windowHours = normalizeWindowHours(config.windowHours);
      const sinceDate = calculateSinceDate(fetchedAt, windowHours);
      let state = await readConnectorState("glean");

      const summaries: string[] = [];
      const pulledStreams: PulledEvidenceStream[] = [];
      let succeededStreams = 0;

      const streamPulls: EvidenceStreamPull[] = [
        {
          fetch: async () =>
            await transport.fetchFeed({ backendUrl: target.backendUrl }),
          filename: "feed.json",
          pull: ({ fetchedAt, response, seenIds }) =>
            pullDocumentStream({
              fetchedAt,
              response,
              seenIds,
              stream: "feed",
            }),
          stream: "feed",
        },
        {
          fetch: async () =>
            await transport.fetchMyWork({
              backendUrl: target.backendUrl,
              sinceDate,
            }),
          filename: "my-work.json",
          pull: ({ fetchedAt, response, seenIds }) =>
            pullDocumentStream({
              fetchedAt,
              response,
              seenIds,
              stream: "my-work",
              window: { sinceDate, windowHours },
            }),
          stream: "my-work",
        },
        {
          fetch: async () =>
            await transport.fetchMessages({
              backendUrl: target.backendUrl,
              sinceDate,
            }),
          filename: "messages.json",
          pull: ({ fetchedAt, response, seenIds }) =>
            pullDocumentStream({
              fetchedAt,
              response,
              seenIds,
              stream: "messages",
              window: { sinceDate, windowHours },
            }),
          stream: "messages",
        },
        {
          fetch: async () =>
            await transport.fetchCalendar({
              backendUrl: target.backendUrl,
            }),
          filename: "calendar.json",
          pull: pullCalendarStream,
          stream: "calendar",
        },
      ];

      for (const streamPull of streamPulls) {
        try {
          const pulled = streamPull.pull({
            fetchedAt,
            response: await streamPull.fetch(),
            seenIds: state.seenIds?.[streamPull.stream] ?? [],
          });
          rawFiles.push(
            await writeRawJson(
              "glean",
              runId,
              streamPull.filename,
              pulled.artifact,
            ),
          );
          state = withSeenIds(state, streamPull.stream, pulled.seenIds);
          pulledStreams.push({
            items: pulled.artifact.items,
            stream: streamPull.stream,
          });
          succeededStreams += 1;
          summaries.push(
            `${streamPull.stream} ${pulled.artifact.counts.new} new`,
          );
        } catch (error) {
          warnings.push(createStreamWarning(streamPull.stream, error));
        }
      }

      if (succeededStreams > 0) {
        try {
          const pulled = await pullExpandedStream({
            backendUrl: target.backendUrl,
            fetchedAt,
            maxItems: normalizeExpansionMaxItems(config.expansion?.maxItems),
            pulledStreams,
            seenIds: state.seenIds?.expanded ?? [],
            transcriptDatasources: normalizeTranscriptDatasources(
              config.expansion?.transcriptDatasources,
            ),
            transport,
          });
          warnings.push(...pulled.warnings);
          rawFiles.push(
            await writeRawJson(
              "glean",
              runId,
              "expanded.json",
              pulled.artifact,
            ),
          );
          state = withSeenIds(state, "expanded", pulled.seenIds);
          summaries.push(`expanded ${pulled.artifact.counts.expanded} new`);
        } catch (error) {
          warnings.push(
            `Glean expanded pull failed: ${readErrorReason(error)}`,
          );
        }
      }

      const status = succeededStreams > 0 ? "success" : "error";
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
        ...(status === "success" ? { liveTools } : {}),
        message:
          status === "success"
            ? `Probed ${toolCount} MCP tool(s) at ${target.backendUrl}; pulled ${summaries.join(", ")}.`
            : "All Glean evidence streams failed. Run openwiki auth glean to sign in again, then retry.",
        rawFiles,
        runId,
        statePath: "~/.openwiki/connectors/glean/state.json",
        status,
        warnings,
      };
    },
    resolveMcpConfig: resolveGleanMcpConfig,
  };
}

type GleanLiveToolsPreparation =
  | { kind: "result"; result: ConnectorIngestResult }
  | {
      config: GleanConfig;
      fetchedAt: string;
      kind: "ready";
      liveTools: NonNullable<ConnectorIngestResult["liveTools"]>;
      rawFiles: string[];
      runId: string;
      target: Awaited<ReturnType<typeof resolveGleanTarget>>;
      toolCount: number;
      transport: GleanProbeTransport;
      warnings: string[];
    };

async function prepareGleanLiveTools(
  transportOverride?: GleanProbeTransport,
): Promise<GleanLiveToolsPreparation> {
  const runId = createRunId();
  const config = await readConnectorConfig<GleanConfig>(
    "glean",
    DEFAULT_GLEAN_CONFIG,
  );
  const transport =
    transportOverride ?? createDefaultTransport(config.messagingApps);

  if (config.enabled !== true) {
    return {
      kind: "result",
      result: createEmptyResult(runId, "skipped", GLEAN_DISABLED_MESSAGE),
    };
  }

  let target: Awaited<ReturnType<typeof resolveGleanTarget>>;
  try {
    target = await resolveGleanTarget(config);
  } catch (error) {
    return {
      kind: "result",
      result: createEmptyResult(
        runId,
        "error",
        error instanceof Error ? error.message : String(error),
      ),
    };
  }

  if (
    !process.env[OPENWIKI_GLEAN_ACCESS_TOKEN_ENV_KEY] &&
    !process.env[OPENWIKI_GLEAN_REFRESH_TOKEN_ENV_KEY]
  ) {
    return {
      kind: "result",
      result: createEmptyResult(
        runId,
        "error",
        "Glean credentials are missing. Run openwiki auth glean to sign in.",
      ),
    };
  }

  const liveTools: NonNullable<ConnectorIngestResult["liveTools"]> = [];
  const rawFiles: string[] = [];
  let defaultProbe: GleanEndpointProbeResult;
  try {
    defaultProbe = await probeGleanEndpoint({
      allowedTools: config.allowedTools,
      backendUrl: target.backendUrl,
      endpoint: "default",
      liveTools,
      mcpUrl: target.mcpUrl,
      rawFiles,
      runId,
      transport,
    });
  } catch {
    return {
      kind: "result",
      result: createEmptyResult(
        runId,
        "error",
        "Glean MCP probe failed. Run openwiki auth glean to sign in again, then retry.",
      ),
    };
  }

  const warnings: string[] = [];
  let gatewayToolCount = 0;
  try {
    const gatewayProbe = await probeGleanEndpoint({
      allowedTools: config.allowedTools,
      backendUrl: target.backendUrl,
      endpoint: "gateway",
      fetchedAt: defaultProbe.fetchedAt,
      liveTools,
      mcpUrl: target.gatewayUrl,
      rawFiles,
      runId,
      transport,
    });
    gatewayToolCount = gatewayProbe.tools.length;
  } catch (error) {
    warnings.push(
      isMcpEndpointUnavailableError(error)
        ? createGatewayUnavailableWarning(definition.displayName)
        : `Glean gateway probe failed: ${readErrorReason(error)}; gateway reads are disabled for this run.`,
    );
  }

  return {
    config,
    fetchedAt: defaultProbe.fetchedAt,
    kind: "ready",
    liveTools,
    rawFiles,
    runId,
    target,
    toolCount: defaultProbe.tools.length + gatewayToolCount,
    transport,
    warnings,
  };
}

async function resolveGleanMcpConfig(
  endpoint: McpEndpointId = "default",
): Promise<McpConnectorConfig> {
  const config = await readConnectorConfig<GleanConfig>(
    "glean",
    DEFAULT_GLEAN_CONFIG,
  );

  if (config.enabled !== true) {
    throw new Error(GLEAN_DISABLED_MESSAGE);
  }

  const { gatewayUrl, mcpUrl } = await resolveGleanTarget(config);

  return createGleanEndpointConfig(
    endpoint === "gateway" ? gatewayUrl : mcpUrl,
    config.allowedTools,
  );
}

function createGleanEndpointConfig(
  url: string,
  allowedTools: string[] | undefined,
): McpConnectorConfig {
  return {
    allowedTools,
    enabled: true,
    transport: {
      headers: {
        Authorization: `Bearer \${${OPENWIKI_GLEAN_ACCESS_TOKEN_ENV_KEY}}`,
      },
      type: "http",
      url,
    },
  };
}

type GleanEndpointProbeResult = {
  fetchedAt: string;
  tools: McpToolDescriptor[];
};

async function probeGleanEndpoint(input: {
  allowedTools?: string[];
  backendUrl: string;
  endpoint: McpEndpointId;
  fetchedAt?: string;
  liveTools: NonNullable<ConnectorIngestResult["liveTools"]>;
  mcpUrl: string;
  rawFiles: string[];
  runId: string;
  transport: GleanProbeTransport;
}): Promise<GleanEndpointProbeResult> {
  const tools = await input.transport.listTools({
    endpoint: input.endpoint,
    mcpUrl: input.mcpUrl,
  });
  const fetchedAt = input.fetchedAt ?? new Date().toISOString();
  const annotatedTools = annotateToolsWithPolicy(
    tools,
    input.allowedTools,
    input.endpoint,
  );
  input.liveTools.push(
    ...annotatedTools.map((tool) => ({
      ...tool,
      endpoint: input.endpoint,
    })),
  );

  const writeCatalog = async () =>
    await writeToolCatalog({
      config: createGleanEndpointConfig(input.mcpUrl, input.allowedTools),
      connectorId: "glean",
      endpoint: input.endpoint,
      generatedAt: fetchedAt,
      tools: annotatedTools,
    });
  const writeProbeArtifact = async () =>
    await writeRawJson(
      "glean",
      input.runId,
      input.endpoint === "gateway" ? "gateway-probe.json" : "probe.json",
      {
        backendUrl: input.backendUrl,
        fetchedAt,
        mcpUrl: input.mcpUrl,
        toolCount: tools.length,
        tools: tools.map(({ annotations, description, name }) => ({
          annotations,
          description,
          name,
        })),
      },
    );

  if (input.endpoint === "gateway") {
    input.rawFiles.push(await writeProbeArtifact());
    await writeCatalog();
  } else {
    await writeCatalog();
    input.rawFiles.push(await writeProbeArtifact());
  }

  return { fetchedAt, tools };
}

const FEED_CATEGORIES = [
  "RECENT",
  "MENTION",
  "EVENT",
  "TASK",
  "FOLLOW_UP",
] as const;
const MAX_SEEN_IDS_PER_STREAM = 5_000;
const CALENDAR_WINDOW_DAYS = 7;
const DEFAULT_EXPANSION_MAX_ITEMS = 20;
const DEFAULT_MESSAGING_APPS = ["slack"];
const DEFAULT_TRANSCRIPT_DATASOURCES = ["fellow"];
const DEFAULT_WINDOW_HOURS = 48;

type JsonObject = Record<string, unknown>;
type CalendarItemDescriptor = {
  inWindow?: (item: JsonObject, fetchedAt: string) => boolean;
  normalize: (rawItem: JsonObject, fetchedAt: string) => JsonObject | null;
};
type DocumentNormalizationOptions = {
  category?: string;
  kind?: string;
  requireUrl: boolean;
};
type DocumentStreamName = "feed" | "messages" | "my-work";
type EvidenceStreamName = DocumentStreamName | "calendar";
type ExpansionCounts = {
  candidates: number;
  capped: number;
  deduplicated: number;
  expanded: number;
  failed: number;
};
type ExpansionPullResult = {
  artifact: {
    counts: ExpansionCounts;
    fetchedAt: string;
    items: JsonObject[];
    stream: "expanded";
  };
  seenIds: string[];
  warnings: string[];
};
type GleanSearchFacetFilter = {
  fieldName: string;
  values: { relationType: string; value: string }[];
};
type PulledEvidenceStream = {
  items: JsonObject[];
  stream: EvidenceStreamName;
};
type RankedExpansionCandidate = ExpansionCandidate & { order: number };
type SeenStreamName = EvidenceStreamName | "expanded";
type StreamCounts = {
  deduplicated: number;
  fetched: number;
  new: number;
  skipped: number;
};
type DocumentWindow = { sinceDate: string; windowHours: number };
type EvidenceStreamPull = {
  fetch: () => Promise<unknown>;
  filename: string;
  pull: (input: StreamPullInput) => StreamPullResult;
  stream: EvidenceStreamName;
};
type StreamPullInput = {
  fetchedAt: string;
  response: unknown;
  seenIds: string[];
};
type StreamPullResult = {
  artifact: { counts: StreamCounts; items: JsonObject[] };
  seenIds: string[];
};

function createDefaultTransport(
  messagingApps: string[] | undefined,
): GleanProbeTransport {
  const apps = normalizeMessagingApps(messagingApps);

  return {
    fetchCalendar: async ({ backendUrl }) =>
      await postGleanJson(backendUrl, "/rest/api/v1/people", {
        includeFields: ["BUSY_EVENTS", "DOCUMENT_ACTIVITY"],
      }),
    fetchExpansion: async ({ backendUrl, item }) =>
      await postGleanJson(backendUrl, "/rest/api/v1/getdocuments", {
        documentSpecs: [{ id: item.id }],
        includeFields: ["DOCUMENT_CONTENT"],
      }),
    fetchFeed: async ({ backendUrl }) =>
      await postGleanJson(backendUrl, "/rest/api/v1/feed", {
        categories: FEED_CATEGORIES,
      }),
    fetchMessages: async ({ backendUrl, sinceDate }) =>
      mergeSearchResponses(
        await Promise.all(
          apps.map(
            async (app) =>
              await fetchGleanSearch(backendUrl, "", sinceDate, [
                {
                  fieldName: "app",
                  values: [{ relationType: "EQUALS", value: app }],
                },
              ]),
          ),
        ),
      ),
    fetchMyWork: async ({ backendUrl, sinceDate }) =>
      mergeSearchResponses(
        await Promise.all(
          ['owner:"me"', 'from:"me"'].map(
            async (query) =>
              await fetchGleanSearch(backendUrl, query, sinceDate),
          ),
        ),
      ),
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
}

async function fetchGleanSearch(
  backendUrl: string,
  query: string,
  sinceDate: string,
  facetFilters: GleanSearchFacetFilter[] = [],
): Promise<unknown> {
  return await postGleanJson(backendUrl, "/rest/api/v1/search", {
    pageSize: 100,
    query,
    requestOptions: {
      facetFilters: [
        {
          fieldName: "last_updated_at",
          values: [{ relationType: "GT", value: sinceDate }],
        },
        ...facetFilters,
      ],
    },
  });
}

async function postGleanJson(
  backendUrl: string,
  pathname: string,
  body: JsonObject,
): Promise<unknown> {
  const accessToken = process.env[OPENWIKI_GLEAN_ACCESS_TOKEN_ENV_KEY];
  if (!accessToken) {
    throw new Error("Glean access token is missing.");
  }

  const response = await requestGleanJson(
    backendUrl,
    pathname,
    body,
    accessToken,
  );
  if (response.status !== 401) {
    return await parseGleanJsonResponse(response, pathname);
  }

  const refreshedToken = await refreshOAuthAccessToken("glean");
  return await parseGleanJsonResponse(
    await requestGleanJson(backendUrl, pathname, body, refreshedToken),
    pathname,
  );
}

async function requestGleanJson(
  backendUrl: string,
  pathname: string,
  body: JsonObject,
  accessToken: string,
): Promise<Response> {
  return await fetch(`${backendUrl}${pathname}`, {
    body: JSON.stringify(body),
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    method: "POST",
  });
}

async function parseGleanJsonResponse(
  response: Response,
  pathname: string,
): Promise<unknown> {
  if (!response.ok) {
    throw Object.assign(
      new Error(
        `Glean ${pathname} request failed: ${response.status} ${response.statusText}`,
      ),
      { status: response.status },
    );
  }

  return await response.json();
}

function mergeSearchResponses(responses: unknown[]): JsonObject {
  return {
    results: responses.flatMap((response) =>
      isJsonObject(response) && Array.isArray(response.results)
        ? (response.results as unknown[])
        : [],
    ),
  };
}

async function pullExpandedStream({
  backendUrl,
  fetchedAt,
  maxItems,
  pulledStreams,
  seenIds,
  transcriptDatasources,
  transport,
}: {
  backendUrl: string;
  fetchedAt: string;
  maxItems: number;
  pulledStreams: PulledEvidenceStream[];
  seenIds: string[];
  transcriptDatasources: string[];
  transport: GleanProbeTransport;
}): Promise<ExpansionPullResult> {
  const candidatesById = new Map<string, RankedExpansionCandidate>();
  const transcriptDatasourceSet = new Set(transcriptDatasources);
  let order = 0;

  for (const pulledStream of pulledStreams) {
    for (const item of pulledStream.items) {
      const candidate = createExpansionCandidate(
        pulledStream.stream,
        item,
        transcriptDatasourceSet,
      );
      if (!candidate) {
        continue;
      }

      const rankedCandidate = { ...candidate, order };
      order += 1;
      const existing = candidatesById.get(candidate.id);
      if (!existing || candidate.tier < existing.tier) {
        candidatesById.set(candidate.id, rankedCandidate);
      }
    }
  }

  const candidates = [...candidatesById.values()];
  const priorIds = new Set(seenIds);
  const unseenCandidates = candidates.filter(
    (candidate) => !priorIds.has(candidate.id),
  );
  unseenCandidates.sort(
    (left, right) => left.tier - right.tier || left.order - right.order,
  );
  const selectedCandidates = unseenCandidates.slice(0, maxItems);
  const items: JsonObject[] = [];
  const expandedIds: string[] = [];
  const warnings: string[] = [];
  let failed = 0;

  for (const candidate of selectedCandidates) {
    try {
      const response = await transport.fetchExpansion({
        backendUrl,
        item: candidate,
      });
      items.push(
        removeUndefinedValues({
          content: extractExpansionContent(response),
          fetchedAt,
          id: candidate.id,
          sourceStream: candidate.sourceStream,
          tier: candidate.tier,
          title: candidate.title,
          url: candidate.url,
        }),
      );
      expandedIds.push(candidate.id);
    } catch (error) {
      failed += 1;
      warnings.push(
        `Glean expanded fetch failed for ${candidate.id}: ${readErrorReason(error)}`,
      );
    }
  }

  return {
    artifact: {
      counts: {
        candidates: candidates.length,
        capped: unseenCandidates.length - selectedCandidates.length,
        deduplicated: candidates.length - unseenCandidates.length,
        expanded: items.length,
        failed,
      },
      fetchedAt,
      items,
      stream: "expanded",
    },
    seenIds: [...seenIds, ...expandedIds].slice(-MAX_SEEN_IDS_PER_STREAM),
    warnings,
  };
}

function createExpansionCandidate(
  stream: EvidenceStreamName,
  item: JsonObject,
  transcriptDatasources: Set<string>,
): ExpansionCandidate | null {
  const id = readString(item, "id");
  if (!id) {
    return null;
  }

  let tier: number | undefined;
  if (
    stream === "calendar" &&
    readString(item, "kind") === "document-activity" &&
    transcriptDatasources.has(
      (readString(item, "datasource") ?? "").toLowerCase(),
    )
  ) {
    tier = 1;
  } else if (stream === "my-work") {
    tier = 2;
  } else if (
    stream === "messages" ||
    (stream === "feed" && readString(item, "category") === "MENTION")
  ) {
    tier = 3;
  }

  return tier === undefined
    ? null
    : {
        id,
        sourceStream: stream,
        tier,
        title: readString(item, "title"),
        url: readString(item, "url"),
      };
}

function extractExpansionContent(response: unknown): unknown {
  return extractExpansionText(response) ?? response ?? null;
}

function extractExpansionText(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (!isJsonObject(value)) {
    return undefined;
  }

  const directText = readString(value, "text", "fullText");
  if (directText) {
    return directText;
  }
  if (Array.isArray(value.fullTextList)) {
    const textList = value.fullTextList.filter(
      (entry): entry is string => typeof entry === "string",
    );
    if (textList.length > 0) {
      return textList.join("\n");
    }
  }

  for (const nestedValue of [value.content, value.document]) {
    const nestedText = extractExpansionText(nestedValue);
    if (nestedText) {
      return nestedText;
    }
  }

  if (Array.isArray(value.documents)) {
    for (const document of value.documents) {
      const documentText = extractExpansionText(document);
      if (documentText) {
        return documentText;
      }
    }
  }

  return undefined;
}

function pullDocumentStream({
  fetchedAt,
  response,
  seenIds,
  stream,
  window,
}: {
  fetchedAt: string;
  response: unknown;
  seenIds: string[];
  stream: DocumentStreamName;
  window?: DocumentWindow;
}): {
  artifact: {
    counts: StreamCounts;
    fetchedAt: string;
    items: JsonObject[];
    stream: DocumentStreamName;
    window?: DocumentWindow;
  };
  seenIds: string[];
} {
  const rawItems = extractFeedItems(response);
  const pulled = dedupeStreamItems({
    normalize: (rawItem) =>
      normalizeFeedItem(rawItem.value, rawItem.category, fetchedAt),
    rawItems,
    seenIds,
  });

  return {
    artifact: {
      counts: pulled.counts,
      fetchedAt,
      items: pulled.items,
      stream,
      ...(window ? { window } : {}),
    },
    seenIds: pulled.seenIds,
  };
}

function pullCalendarStream({
  fetchedAt,
  response,
  seenIds,
}: {
  fetchedAt: string;
  response: unknown;
  seenIds: string[];
}): {
  artifact: {
    counts: StreamCounts;
    fetchedAt: string;
    items: JsonObject[];
    person: JsonObject;
    stream: "calendar";
    window: { days: number };
  };
  seenIds: string[];
} {
  const { busyEvents, documents, person } = extractCalendarResponse(response);
  const busyEventDescriptor: CalendarItemDescriptor = {
    inWindow: isBusyEventInWindow,
    normalize: normalizeBusyEvent,
  };
  const documentActivityDescriptor: CalendarItemDescriptor = {
    normalize: normalizeDocumentActivity,
  };
  const rawItems = [
    ...busyEvents.map((value) => ({
      descriptor: busyEventDescriptor,
      value,
    })),
    ...documents.map((value) => ({
      descriptor: documentActivityDescriptor,
      value,
    })),
  ];
  const pulled = dedupeStreamItems({
    normalize: ({ descriptor, value }) => {
      const item = descriptor.normalize(value, fetchedAt);
      return item &&
        (!descriptor.inWindow || descriptor.inWindow(item, fetchedAt))
        ? item
        : null;
    },
    rawItems,
    seenIds,
  });

  return {
    artifact: {
      counts: pulled.counts,
      fetchedAt,
      items: pulled.items,
      person,
      stream: "calendar",
      window: { days: CALENDAR_WINDOW_DAYS },
    },
    seenIds: pulled.seenIds,
  };
}

function dedupeStreamItems<RawItem>({
  normalize,
  rawItems,
  seenIds,
}: {
  normalize: (rawItem: RawItem) => JsonObject | null;
  rawItems: RawItem[];
  seenIds: string[];
}): {
  counts: StreamCounts;
  items: JsonObject[];
  seenIds: string[];
} {
  const priorIds = new Set(seenIds);
  const newIds: string[] = [];
  const items: JsonObject[] = [];
  let deduplicated = 0;
  let skipped = 0;

  for (const rawItem of rawItems) {
    const item = normalize(rawItem);
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
    counts: {
      deduplicated,
      fetched: rawItems.length,
      new: items.length,
      skipped,
    },
    items,
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
  return normalizeDocumentFields(rawItem, fetchedAt, {
    category: readString(rawItem, "category") ?? fallbackCategory,
    requireUrl: true,
  });
}

function normalizeDocumentFields(
  rawItem: JsonObject,
  fetchedAt: string,
  options: DocumentNormalizationOptions,
): JsonObject | null {
  const document = isJsonObject(rawItem.document) ? rawItem.document : rawItem;
  const metadata = isJsonObject(document.metadata) ? document.metadata : {};
  const url =
    readString(document, "url", "permalink") ??
    readString(rawItem, "url", "viewURL", "permalink");
  const id =
    readString(document, "id", "documentId") ??
    readString(rawItem, "id", "documentId") ??
    url;
  if (!id || (options.requireUrl && !url)) {
    return null;
  }

  return removeUndefinedValues({
    app:
      readStringOrName(rawItem.app) ??
      readString(document, "app") ??
      readString(metadata, "app"),
    category: options.category,
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
    kind: options.kind,
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

function extractCalendarResponse(response: unknown): {
  busyEvents: JsonObject[];
  documents: JsonObject[];
  person: JsonObject;
} {
  if (!isJsonObject(response)) {
    return { busyEvents: [], documents: [], person: {} };
  }

  const rawPeople = Array.isArray(response.results)
    ? response.results.filter(isJsonObject)
    : [];
  const rawPerson = rawPeople[0] ?? {};
  const busyEvents = Array.isArray(rawPerson.busyEvents)
    ? rawPerson.busyEvents.filter(isJsonObject)
    : [];
  const documents = Array.isArray(response.relatedDocuments)
    ? response.relatedDocuments.filter(isJsonObject)
    : [];

  return {
    busyEvents,
    documents,
    person: removeUndefinedValues({
      email: readString(rawPerson, "email"),
      name: readString(rawPerson, "name", "displayName"),
      obfuscatedId: readString(rawPerson, "obfuscatedId"),
    }),
  };
}

function normalizeBusyEvent(
  rawEvent: JsonObject,
  fetchedAt: string,
): JsonObject | null {
  const endTime = readString(rawEvent, "endTime", "end");
  const name = readString(rawEvent, "name", "title");
  const startTime = readString(rawEvent, "startTime", "start");
  const url = readString(rawEvent, "url", "permalink");
  const explicitId = readString(rawEvent, "id", "eventId") ?? url;
  if (!explicitId && !endTime && !name && !startTime) {
    return null;
  }
  const id =
    explicitId ?? `busy:${startTime ?? ""}/${endTime ?? ""}/${name ?? ""}`;

  return removeUndefinedValues({
    endTime,
    fetchedAt,
    id,
    kind: "busy-event",
    name,
    startTime,
    url,
  });
}

function normalizeDocumentActivity(
  rawDocument: JsonObject,
  fetchedAt: string,
): JsonObject | null {
  return normalizeDocumentFields(rawDocument, fetchedAt, {
    kind: "document-activity",
    requireUrl: false,
  });
}

function isBusyEventInWindow(item: JsonObject, fetchedAt: string): boolean {
  const startTime = readString(item, "startTime");
  const endTime = readString(item, "endTime");
  if (!startTime || !endTime) {
    return true;
  }

  const start = Date.parse(startTime);
  const end = Date.parse(endTime);
  if (Number.isNaN(start) || Number.isNaN(end)) {
    return true;
  }

  const center = Date.parse(fetchedAt);
  const radius = CALENDAR_WINDOW_DAYS * 24 * 60 * 60 * 1_000;
  return end >= center - radius && start <= center + radius;
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

function calculateSinceDate(fetchedAt: string, windowHours: number): string {
  const boundaryBufferHours = 24;
  const since = new Date(
    Date.parse(fetchedAt) -
      (windowHours + boundaryBufferHours) * 60 * 60 * 1_000,
  );
  return since.toISOString().slice(0, 10);
}

function normalizeWindowHours(windowHours: number | undefined): number {
  return typeof windowHours === "number" &&
    Number.isFinite(windowHours) &&
    windowHours > 0
    ? windowHours
    : DEFAULT_WINDOW_HOURS;
}

function normalizeExpansionMaxItems(maxItems: number | undefined): number {
  return typeof maxItems === "number" &&
    Number.isFinite(maxItems) &&
    maxItems > 0
    ? maxItems
    : DEFAULT_EXPANSION_MAX_ITEMS;
}

function normalizeMessagingApps(messagingApps: string[] | undefined): string[] {
  if (!Array.isArray(messagingApps)) {
    return DEFAULT_MESSAGING_APPS;
  }

  return messagingApps
    .filter((app): app is string => typeof app === "string")
    .map((app) => app.trim())
    .filter((app) => app.length > 0);
}

function normalizeTranscriptDatasources(
  transcriptDatasources: string[] | undefined,
): string[] {
  if (!Array.isArray(transcriptDatasources)) {
    return DEFAULT_TRANSCRIPT_DATASOURCES;
  }

  const normalized = transcriptDatasources
    .filter(
      (datasource): datasource is string => typeof datasource === "string",
    )
    .map((datasource) => datasource.trim().toLowerCase())
    .filter((datasource) => datasource.length > 0);
  return normalized.length > 0 ? normalized : DEFAULT_TRANSCRIPT_DATASOURCES;
}

function withSeenIds(
  state: ConnectorState,
  stream: SeenStreamName,
  seenIds: string[],
): ConnectorState {
  return {
    ...state,
    seenIds: {
      ...state.seenIds,
      [stream]: seenIds,
    },
  };
}

function createStreamWarning(
  stream: EvidenceStreamName,
  error: unknown,
): string {
  if (stream === "feed" && isFeedEndpointUnavailable(error)) {
    return "Glean feed endpoint is unavailable for this tenant; the MCP probe was kept.";
  }

  return `Glean ${stream} pull failed: ${readErrorReason(error)}`;
}

function readErrorReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
