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
  ConnectorState,
} from "../types.js";
import { resolveGleanTarget, type GleanTargetConfig } from "./glean-backend.js";

export { resolveGleanBackendUrl } from "./glean-backend.js";

export type GleanProbeTransport = {
  fetchCalendar: (input: { backendUrl: string }) => Promise<unknown>;
  fetchFeed: (input: { backendUrl: string }) => Promise<unknown>;
  fetchMessages: (input: {
    backendUrl: string;
    sinceDate: string;
  }) => Promise<unknown>;
  fetchMyWork: (input: {
    backendUrl: string;
    sinceDate: string;
  }) => Promise<unknown>;
  listTools: (input: { mcpUrl: string }) => Promise<McpToolDescriptor[]>;
};

type GleanConfig = GleanTargetConfig & {
  enabled?: boolean;
  messagingApps?: string[];
  windowHours?: number;
};

const definition: ConnectorDefinition = {
  backend: "direct-api",
  description:
    "Probes a Glean tenant's MCP tool catalog and pulls deterministic evidence streams.",
  displayName: "Glean",
  id: "glean",
  requiredEnv: [
    OPENWIKI_GLEAN_ACCESS_TOKEN_ENV_KEY,
    OPENWIKI_GLEAN_REFRESH_TOKEN_ENV_KEY,
  ],
  supportsAgenticDiscovery: false,
};

export function createGleanConnector(overrides?: {
  transport?: GleanProbeTransport;
}): ConnectorRuntime {
  return {
    ...definition,
    ingest: async (): Promise<ConnectorIngestResult> => {
      const runId = createRunId();
      const config = await readConnectorConfig<GleanConfig>("glean", {
        enabled: false,
        mcpPath: "/mcp/default",
        messagingApps: ["slack"],
        windowHours: 48,
      });
      const transport =
        overrides?.transport ?? createDefaultTransport(config.messagingApps);

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
      const windowHours = normalizeWindowHours(config.windowHours);
      const sinceDate = calculateSinceDate(fetchedAt, windowHours);
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
      let state = await readConnectorState("glean");
      const warnings: string[] = [];
      const summaries: string[] = [];
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
          succeededStreams += 1;
          summaries.push(
            `${streamPull.stream} ${pulled.artifact.counts.new} new`,
          );
        } catch (error) {
          warnings.push(createStreamWarning(streamPull.stream, error));
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
        message:
          status === "success"
            ? `Probed ${tools.length} MCP tool(s) at ${target.backendUrl}; pulled ${summaries.join(", ")}.`
            : "All Glean evidence streams failed. Run openwiki auth glean to sign in again, then retry.",
        rawFiles,
        runId,
        statePath: "~/.openwiki/connectors/glean/state.json",
        status,
        warnings,
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
const CALENDAR_WINDOW_DAYS = 7;
const DEFAULT_MESSAGING_APPS = ["slack"];
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
  artifact: { counts: StreamCounts };
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
    fetchFeed: async ({ backendUrl }) =>
      await postGleanJson(backendUrl, "/rest/api/v1/feed", {
        categories: FEED_CATEGORIES,
      }),
    fetchMessages: async ({ backendUrl, sinceDate }) =>
      mergeSearchResponses(
        await Promise.all(
          apps.map(
            async (app) =>
              await fetchGleanSearch(
                backendUrl,
                `from:"me" app:${app}`,
                sinceDate,
              ),
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

function normalizeMessagingApps(messagingApps: string[] | undefined): string[] {
  if (!Array.isArray(messagingApps)) {
    return DEFAULT_MESSAGING_APPS;
  }

  return messagingApps
    .filter((app): app is string => typeof app === "string")
    .map((app) => app.trim())
    .filter((app) => app.length > 0);
}

function withSeenIds(
  state: ConnectorState,
  stream: EvidenceStreamName,
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

  const reason = error instanceof Error ? error.message : String(error);
  return `Glean ${stream} pull failed: ${reason}`;
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
