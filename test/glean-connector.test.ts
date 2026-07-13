import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { getAuthProvider } from "../src/auth/providers.ts";
import { configureAuthProvider } from "../src/auth/configure.ts";
import { formatAuthProviderList } from "../src/auth/oauth.ts";
import {
  getOAuthProviderIdForAccessTokenEnvKey,
  refreshOAuthAccessToken,
} from "../src/auth/tokens.ts";
import {
  createGleanConnector,
  resolveGleanBackendUrl,
} from "../src/connectors/sources/glean.ts";
import {
  CONNECTOR_IDS,
  createConnectorRegistry,
  isConnectorId,
} from "../src/connectors/registry.ts";

const GLEAN_ENV_KEYS = [
  "OPENWIKI_GLEAN_ACCESS_TOKEN",
  "OPENWIKI_GLEAN_BACKEND_URL",
  "OPENWIKI_GLEAN_CLIENT_ID",
  "OPENWIKI_GLEAN_EMAIL",
  "OPENWIKI_GLEAN_INSTANCE",
  "OPENWIKI_GLEAN_REFRESH_TOKEN",
  "OPENWIKI_GLEAN_TOKEN_EXPIRES_AT",
  "OPENWIKI_GLEAN_TOKEN_TYPE",
] as const;
const originalEnv = Object.fromEntries(
  ["OPENWIKI_HOME", ...GLEAN_ENV_KEYS].map((key) => [key, process.env[key]]),
);
let openWikiHome: string;

async function writeGleanConfig(
  config: Record<string, unknown>,
): Promise<void> {
  const connectorHome = path.join(openWikiHome, "connectors", "glean");
  await mkdir(connectorHome, { recursive: true });
  await writeFile(
    path.join(connectorHome, "config.json"),
    `${JSON.stringify(config)}\n`,
  );
}

function createEmptyGleanTransport() {
  return {
    fetchCalendar: () => Promise.resolve({ results: [] }),
    fetchExpansion: () => Promise.resolve({}),
    fetchFeed: () => Promise.resolve({ items: [] }),
    fetchMessages: () => Promise.resolve({ results: [] }),
    fetchMyWork: () => Promise.resolve({ results: [] }),
    listTools: () => Promise.resolve([]),
  };
}

function parseJsonObject(text: string): Record<string, unknown> {
  const value = JSON.parse(text) as unknown;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Expected a JSON object");
  }

  return value as Record<string, unknown>;
}

beforeEach(async () => {
  openWikiHome = await mkdtemp(path.join(tmpdir(), "openwiki-glean-"));
  process.env.OPENWIKI_HOME = openWikiHome;
  for (const key of GLEAN_ENV_KEYS) {
    delete process.env[key];
  }
});

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  await rm(openWikiHome, { force: true, recursive: true });
});

describe("resolveGleanBackendUrl", () => {
  test("prefers and normalizes an explicit HTTPS backend URL", () => {
    expect(
      resolveGleanBackendUrl({
        backendBaseUrl: "https://custom.glean.example/",
        email: "user@ignored.example",
        instance: "ignored",
      }),
    ).toBe("https://custom.glean.example");
  });

  test("builds a tenant backend from an instance", () => {
    expect(resolveGleanBackendUrl({ instance: "acme" })).toBe(
      "https://acme-be.glean.com",
    );
  });

  test("derives the tenant instance from an email domain", () => {
    expect(resolveGleanBackendUrl({ email: "j.doe@acme.nl" })).toBe(
      "https://acme-be.glean.com",
    );
  });

  test("derives the registrable label for a multi-label public suffix", () => {
    expect(resolveGleanBackendUrl({ email: "j.doe@acme.co.uk" })).toBe(
      "https://acme-be.glean.com",
    );
  });

  test("rejects an HTTP backend URL", () => {
    expect(() =>
      resolveGleanBackendUrl({ backendBaseUrl: "http://acme.example" }),
    ).toThrow(/HTTPS/u);
  });

  test("rejects backend URLs that could leak credentials or break MCP paths", () => {
    expect(() =>
      resolveGleanBackendUrl({
        backendBaseUrl: "https://user:secret@acme.example/",
      }),
    ).toThrow(/must not include/u);
    expect(() =>
      resolveGleanBackendUrl({
        backendBaseUrl: "https://acme.example/?token=secret",
      }),
    ).toThrow(/must not include/u);
    expect(() =>
      resolveGleanBackendUrl({
        backendBaseUrl: "https://acme.example/base",
      }),
    ).toThrow(/origin/u);
  });

  test("explains all supported settings when the backend is unresolved", () => {
    expect(() => resolveGleanBackendUrl({})).toThrow(
      /backendBaseUrl.*instance.*email.*OPENWIKI_GLEAN_BACKEND_URL.*OPENWIKI_GLEAN_INSTANCE.*OPENWIKI_GLEAN_EMAIL/u,
    );
  });
});

describe("Glean connector", () => {
  test("skips an unconfigured connector without writing raw files", async () => {
    const result = await createGleanConnector().ingest();

    expect(result.status).toBe("skipped");
    expect(result.message).toMatch(/openwiki auth glean|enabled: true/u);
    await expect(
      readdir(path.join(openWikiHome, "connectors", "glean", "raw")),
    ).resolves.toEqual([]);
  });

  test("skips an explicitly disabled connector with setup guidance", async () => {
    await writeGleanConfig({ enabled: false });

    const result = await createGleanConnector().ingest();

    expect(result.status).toBe("skipped");
    expect(result.message).toMatch(/openwiki auth glean|enabled: true/u);
  });

  test("returns an actionable error when the backend is unresolved", async () => {
    await writeGleanConfig({ enabled: true });

    const result = await createGleanConnector().ingest();

    expect(result.status).toBe("error");
    expect(result.message).toMatch(
      /backendBaseUrl.*instance.*email.*OPENWIKI_GLEAN_BACKEND_URL/u,
    );
  });

  test("asks the user to authenticate when credentials are missing", async () => {
    await writeGleanConfig({ enabled: true, instance: "acme" });

    const result = await createGleanConnector().ingest();

    expect(result.status).toBe("error");
    expect(result.message).toMatch(/openwiki auth glean/u);
  });

  test("annotates probed live tools with the read-only policy", async () => {
    await writeGleanConfig({ enabled: true, instance: "acme" });
    process.env.OPENWIKI_GLEAN_ACCESS_TOKEN = "secret-access-token";
    const connector = createGleanConnector({
      transport: {
        ...createEmptyGleanTransport(),
        listTools: () =>
          Promise.resolve([
            { description: "Search tenant content", name: "search" },
            {
              annotations: { readOnlyHint: true },
              name: "tenant_catalog",
            },
            {
              description: "Create an announcement",
              name: "create_announcement",
            },
          ]),
      },
    });

    const result = await connector.ingest();

    expect(result.status).toBe("success");
    expect(
      result.liveTools?.map(({ name, policy }) => ({
        allowed: policy.allowed,
        name,
        rule: policy.rule,
      })),
    ).toEqual([
      {
        allowed: true,
        name: "search",
        rule: "read-shaped-name",
      },
      {
        allowed: true,
        name: "tenant_catalog",
        rule: "read-only-annotation",
      },
      {
        allowed: false,
        name: "create_announcement",
        rule: "write-shaped",
      },
    ]);
  });

  test("resolves its live MCP config from enabled Glean settings", async () => {
    await writeGleanConfig({
      allowedTools: ["chat"],
      enabled: true,
      instance: "acme",
      mcpPath: "/mcp/gateway",
    });
    const connector = createGleanConnector();

    await expect(connector.resolveMcpConfig?.()).resolves.toEqual({
      allowedTools: ["chat"],
      enabled: true,
      transport: {
        headers: {
          Authorization: "Bearer ${OPENWIKI_GLEAN_ACCESS_TOKEN}",
        },
        type: "http",
        url: "https://acme-be.glean.com/mcp/gateway",
      },
    });
  });

  test("refuses to resolve live MCP config while Glean is disabled", async () => {
    await writeGleanConfig({ enabled: false, instance: "acme" });
    const connector = createGleanConnector();

    await expect(connector.resolveMcpConfig?.()).rejects.toThrow(
      /openwiki auth glean/u,
    );
  });

  test("writes one normalized artifact for every deterministic stream", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-13T12:00:00.000Z"));
    await writeGleanConfig({
      enabled: true,
      instance: "acme",
      mcpPath: "/mcp/gateway",
      windowHours: 48,
    });
    process.env.OPENWIKI_GLEAN_ACCESS_TOKEN = "secret-access-token";
    process.env.OPENWIKI_GLEAN_REFRESH_TOKEN = "secret-refresh-token";

    const connector = createGleanConnector({
      transport: {
        ...createEmptyGleanTransport(),
        fetchCalendar: ({ backendUrl }) => {
          expect(backendUrl).toBe("https://acme-be.glean.com");
          return Promise.resolve({
            relatedDocuments: [
              {
                datasource: "drive",
                id: "activity-document-1",
                title: "Atlas decision record",
                url: "https://app.glean.com/go/activity-document-1",
              },
            ],
            results: [
              {
                busyEvents: [
                  {
                    endTime: "2026-07-16T11:00:00.000Z",
                    eventId: "busy-event-1",
                    name: "Atlas review",
                    startTime: "2026-07-16T10:00:00.000Z",
                  },
                ],
                email: "owner@acme.example",
                name: "OpenWiki Owner",
                obfuscatedId: "person-obfuscated-1",
              },
            ],
          });
        },
        fetchFeed: ({ backendUrl }) => {
          expect(backendUrl).toBe("https://acme-be.glean.com");
          return Promise.resolve({
            results: [
              {
                category: "RECENT",
                primaryEntry: {
                  app: "slack",
                  document: {
                    datasource: "slack-datasource",
                    id: "document-123",
                    metadata: {
                      createTime: "2026-07-11T08:00:00.000Z",
                      updateTime: "2026-07-11T09:30:00.000Z",
                    },
                    title: "Project Atlas launch decision",
                    url: "https://app.glean.com/go/document-123",
                  },
                  justification: "The launch date is confirmed.",
                },
              },
            ],
          });
        },
        fetchExpansion: ({ backendUrl, item }) => {
          expect(backendUrl).toBe("https://acme-be.glean.com");
          return Promise.resolve({
            document: {
              content: { fullText: `Full content for ${item.id}` },
            },
          });
        },
        fetchMessages: ({ backendUrl, sinceDate }) => {
          expect({ backendUrl, sinceDate }).toEqual({
            backendUrl: "https://acme-be.glean.com",
            sinceDate: "2026-07-10",
          });
          return Promise.resolve({
            results: [
              {
                app: "slack",
                document: {
                  datasource: "slack-datasource",
                  id: "message-thread-1",
                  title: "Atlas launch thread",
                  url: "https://app.glean.com/go/message-thread-1",
                },
                snippets: [{ text: "Ship it on Tuesday." }],
              },
            ],
          });
        },
        fetchMyWork: ({ backendUrl, sinceDate }) => {
          expect({ backendUrl, sinceDate }).toEqual({
            backendUrl: "https://acme-be.glean.com",
            sinceDate: "2026-07-10",
          });
          return Promise.resolve({
            results: [
              {
                document: {
                  datasource: "drive",
                  id: "owned-document-1",
                  metadata: { updateTime: "2026-07-12T09:00:00.000Z" },
                  title: "Atlas launch plan",
                  url: "https://app.glean.com/go/owned-document-1",
                },
              },
            ],
          });
        },
        listTools: ({ mcpUrl }) => {
          expect(mcpUrl).toBe("https://acme-be.glean.com/mcp/gateway");
          return Promise.resolve([
            {
              annotations: { readOnlyHint: true },
              description: "Search tenant content",
              name: "search",
            },
            { name: "chat" },
          ]);
        },
      },
    });

    const result = await connector.ingest();

    expect(result.status).toBe("success");
    expect(result.message).toBe(
      "Probed 2 MCP tool(s) at https://acme-be.glean.com; pulled feed 1 new, my-work 1 new, messages 1 new, calendar 2 new, expanded 2 new.",
    );
    expect(result.rawFiles.map((file) => path.basename(file))).toEqual([
      "probe.json",
      "feed.json",
      "my-work.json",
      "messages.json",
      "calendar.json",
      "expanded.json",
    ]);

    const probeText = await readFile(result.rawFiles[0], "utf8");
    const probe = JSON.parse(probeText) as Record<string, unknown>;
    expect(probe).toMatchObject({
      backendUrl: "https://acme-be.glean.com",
      mcpUrl: "https://acme-be.glean.com/mcp/gateway",
      toolCount: 2,
      tools: [
        {
          annotations: { readOnlyHint: true },
          description: "Search tenant content",
          name: "search",
        },
        { name: "chat" },
      ],
    });
    expect(Date.parse(String(probe.fetchedAt))).not.toBeNaN();
    expect(probeText).not.toContain("secret-access-token");
    expect(probeText).not.toContain("secret-refresh-token");
    expect(probeText).not.toContain("Authorization");

    const feedText = await readFile(result.rawFiles[1], "utf8");
    const feed = JSON.parse(feedText) as Record<string, unknown>;
    expect(feed).toMatchObject({
      counts: { deduplicated: 0, fetched: 1, new: 1 },
      items: [
        {
          app: "slack",
          category: "RECENT",
          createdAt: "2026-07-11T08:00:00.000Z",
          datasource: "slack-datasource",
          id: "document-123",
          snippet: "The launch date is confirmed.",
          title: "Project Atlas launch decision",
          updatedAt: "2026-07-11T09:30:00.000Z",
          url: "https://app.glean.com/go/document-123",
        },
      ],
      stream: "feed",
    });
    expect(Date.parse(String(feed.fetchedAt))).not.toBeNaN();
    expect(feedText).not.toContain("secret-access-token");
    expect(feedText).not.toContain("secret-refresh-token");
    expect(feedText).not.toContain("Authorization");

    const artifacts: Record<string, Record<string, unknown>> = {};
    for (const file of result.rawFiles) {
      artifacts[path.basename(file)] = parseJsonObject(
        await readFile(file, "utf8"),
      );
    }
    expect(artifacts["my-work.json"]).toMatchObject({
      counts: { deduplicated: 0, fetched: 1, new: 1, skipped: 0 },
      items: [
        {
          datasource: "drive",
          fetchedAt: "2026-07-13T12:00:00.000Z",
          id: "owned-document-1",
          title: "Atlas launch plan",
          updatedAt: "2026-07-12T09:00:00.000Z",
          url: "https://app.glean.com/go/owned-document-1",
        },
      ],
      stream: "my-work",
      window: { sinceDate: "2026-07-10", windowHours: 48 },
    });
    expect(artifacts["messages.json"]).toMatchObject({
      counts: { deduplicated: 0, fetched: 1, new: 1, skipped: 0 },
      items: [
        {
          app: "slack",
          datasource: "slack-datasource",
          id: "message-thread-1",
          snippet: "Ship it on Tuesday.",
          url: "https://app.glean.com/go/message-thread-1",
        },
      ],
      stream: "messages",
      window: { sinceDate: "2026-07-10", windowHours: 48 },
    });
    expect(artifacts["calendar.json"]).toMatchObject({
      counts: { deduplicated: 0, fetched: 2, new: 2, skipped: 0 },
      items: [
        {
          endTime: "2026-07-16T11:00:00.000Z",
          fetchedAt: "2026-07-13T12:00:00.000Z",
          id: "busy-event-1",
          kind: "busy-event",
          name: "Atlas review",
          startTime: "2026-07-16T10:00:00.000Z",
        },
        {
          datasource: "drive",
          id: "activity-document-1",
          kind: "document-activity",
          title: "Atlas decision record",
          url: "https://app.glean.com/go/activity-document-1",
        },
      ],
      person: {
        email: "owner@acme.example",
        name: "OpenWiki Owner",
        obfuscatedId: "person-obfuscated-1",
      },
      stream: "calendar",
      window: { days: 7 },
    });
    expect(artifacts["expanded.json"]).toEqual({
      counts: {
        candidates: 2,
        capped: 0,
        deduplicated: 0,
        expanded: 2,
        failed: 0,
      },
      fetchedAt: "2026-07-13T12:00:00.000Z",
      items: [
        {
          content: "Full content for owned-document-1",
          fetchedAt: "2026-07-13T12:00:00.000Z",
          id: "owned-document-1",
          sourceStream: "my-work",
          tier: 2,
          title: "Atlas launch plan",
          url: "https://app.glean.com/go/owned-document-1",
        },
        {
          content: "Full content for message-thread-1",
          fetchedAt: "2026-07-13T12:00:00.000Z",
          id: "message-thread-1",
          sourceStream: "messages",
          tier: 3,
          title: "Atlas launch thread",
          url: "https://app.glean.com/go/message-thread-1",
        },
      ],
      stream: "expanded",
    });

    const stateText = await readFile(
      path.join(openWikiHome, "connectors", "glean", "state.json"),
      "utf8",
    );
    const state = JSON.parse(stateText) as {
      runs: { rawFiles: string[]; runId: string; status: string }[];
      seenIds: Record<string, string[]>;
    };
    expect(state.seenIds.feed).toEqual(["document-123"]);
    expect(state.seenIds["my-work"]).toEqual(["owned-document-1"]);
    expect(state.seenIds.messages).toEqual(["message-thread-1"]);
    expect(state.seenIds.calendar).toEqual([
      "busy-event-1",
      "activity-document-1",
    ]);
    expect(state.seenIds.expanded).toEqual([
      "owned-document-1",
      "message-thread-1",
    ]);
    expect(state.runs[0]).toMatchObject({
      rawFiles: result.rawFiles,
      runId: result.runId,
      status: "success",
    });
    for (const file of [
      ...result.rawFiles,
      path.join(openWikiHome, "connectors", "glean", "state.json"),
    ]) {
      const text = await readFile(file, "utf8");
      expect(text).not.toContain("secret-access-token");
      expect(text).not.toContain("secret-refresh-token");
      expect(text).not.toContain("Authorization");
    }
  });

  test("uses the default MCP path for the tenant probe", async () => {
    await writeGleanConfig({ enabled: true, instance: "acme" });
    process.env.OPENWIKI_GLEAN_ACCESS_TOKEN = "secret-access-token";
    let probedUrl = "";
    const connector = createGleanConnector({
      transport: {
        ...createEmptyGleanTransport(),
        fetchFeed: () => Promise.resolve({ items: [] }),
        listTools: ({ mcpUrl }) => {
          probedUrl = mcpUrl;
          return Promise.resolve([]);
        },
      },
    });

    const result = await connector.ingest();

    expect(result.status).toBe("success");
    expect(probedUrl).toBe("https://acme-be.glean.com/mcp/default");
  });

  test("uses the OAuth token and documented bodies for every default request", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-13T12:00:00.000Z"));
    await writeGleanConfig({ enabled: true, instance: "acme" });
    process.env.OPENWIKI_GLEAN_ACCESS_TOKEN = "secret-access-token";
    const requests: {
      authorization: string | null;
      body?: string;
      method?: string;
      url: string;
    }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request, init?: RequestInit) => {
        const url = input instanceof Request ? input.url : input.toString();
        const headers = new Headers(init?.headers);
        requests.push({
          authorization: headers.get("Authorization"),
          body: typeof init?.body === "string" ? init.body : undefined,
          method: init?.method,
          url,
        });
        if (url.endsWith("/rest/api/v1/feed")) {
          return Promise.resolve(Response.json({ items: [] }));
        }
        if (url.endsWith("/rest/api/v1/search")) {
          return Promise.resolve(Response.json({ results: [] }));
        }
        if (url.endsWith("/rest/api/v1/people")) {
          return Promise.resolve(Response.json({ results: [] }));
        }
        const body = typeof init?.body === "string" ? init.body : "{}";
        const request = JSON.parse(body) as { id?: number; method?: string };

        if (request.id === undefined) {
          return Promise.resolve(new Response(null, { status: 202 }));
        }

        return Promise.resolve(
          Response.json({
            id: request.id,
            jsonrpc: "2.0",
            result:
              request.method === "tools/list"
                ? { tools: [{ name: "search" }] }
                : {},
          }),
        );
      }),
    );

    const result = await createGleanConnector().ingest();

    expect(result.status).toBe("success");
    expect(requests).toHaveLength(8);
    expect(
      requests.every(
        ({ authorization }) => authorization === "Bearer secret-access-token",
      ),
    ).toBe(true);
    const mcpRequests = requests.filter(({ url }) =>
      url.endsWith("/mcp/default"),
    );
    expect(mcpRequests).toHaveLength(3);
    expect(
      mcpRequests.every(
        ({ authorization }) => authorization === "Bearer secret-access-token",
      ),
    ).toBe(true);
    const feedRequest = requests.find(({ url }) =>
      url.endsWith("/rest/api/v1/feed"),
    );
    expect(feedRequest).toMatchObject({
      authorization: "Bearer secret-access-token",
      method: "POST",
      url: "https://acme-be.glean.com/rest/api/v1/feed",
    });
    expect(JSON.parse(feedRequest?.body ?? "{}")).toEqual({
      categories: ["RECENT", "MENTION", "EVENT", "TASK", "FOLLOW_UP"],
    });

    const searchRequests = requests.filter(({ url }) =>
      url.endsWith("/rest/api/v1/search"),
    );
    expect(searchRequests).toHaveLength(3);
    expect(
      searchRequests.map(({ body }) => JSON.parse(body ?? "{}") as unknown),
    ).toEqual([
      {
        pageSize: 100,
        query: 'owner:"me"',
        requestOptions: {
          facetFilters: [
            {
              fieldName: "last_updated_at",
              values: [{ relationType: "GT", value: "2026-07-10" }],
            },
          ],
        },
      },
      {
        pageSize: 100,
        query: 'from:"me"',
        requestOptions: {
          facetFilters: [
            {
              fieldName: "last_updated_at",
              values: [{ relationType: "GT", value: "2026-07-10" }],
            },
          ],
        },
      },
      {
        pageSize: 100,
        query: 'from:"me" app:slack',
        requestOptions: {
          facetFilters: [
            {
              fieldName: "last_updated_at",
              values: [{ relationType: "GT", value: "2026-07-10" }],
            },
          ],
        },
      },
    ]);
    const peopleRequest = requests.find(({ url }) =>
      url.endsWith("/rest/api/v1/people"),
    );
    expect(peopleRequest).toMatchObject({
      authorization: "Bearer secret-access-token",
      method: "POST",
      url: "https://acme-be.glean.com/rest/api/v1/people",
    });
    expect(JSON.parse(peopleRequest?.body ?? "{}")).toEqual({
      includeFields: ["BUSY_EVENTS", "DOCUMENT_ACTIVITY"],
    });
  });

  test("refreshes once and retries the default feed request after a 401", async () => {
    await writeGleanConfig({ enabled: true, instance: "acme" });
    process.env.OPENWIKI_GLEAN_ACCESS_TOKEN = "expired-access-token";
    process.env.OPENWIKI_GLEAN_CLIENT_ID = "registered-client";
    process.env.OPENWIKI_GLEAN_REFRESH_TOKEN = "refresh-token";
    const feedAuthorizations: (string | null)[] = [];
    let tokenRefreshes = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request, init?: RequestInit) => {
        const url = input instanceof Request ? input.url : input.toString();

        if (url.endsWith("/rest/api/v1/feed")) {
          feedAuthorizations.push(
            new Headers(init?.headers).get("Authorization"),
          );
          return Promise.resolve(
            feedAuthorizations.length === 1
              ? new Response(null, { status: 401 })
              : Response.json({ results: [] }),
          );
        }
        if (url.includes("oauth-protected-resource")) {
          return Promise.resolve(
            Response.json({
              authorization_servers: ["https://auth.acme.example"],
            }),
          );
        }
        if (
          url.includes("oauth-authorization-server") ||
          url.includes("openid-configuration")
        ) {
          return Promise.resolve(
            Response.json({
              token_endpoint: "https://auth.acme.example/token",
            }),
          );
        }
        if (url === "https://auth.acme.example/token") {
          tokenRefreshes += 1;
          return Promise.resolve(
            Response.json({
              access_token: "refreshed-access-token",
              expires_in: 3600,
              refresh_token: "refresh-token",
              token_type: "Bearer",
            }),
          );
        }

        const body = typeof init?.body === "string" ? init.body : "{}";
        const request = JSON.parse(body) as { id?: number; method?: string };
        if (request.id === undefined) {
          return Promise.resolve(new Response(null, { status: 202 }));
        }
        return Promise.resolve(
          Response.json({
            id: request.id,
            jsonrpc: "2.0",
            result: request.method === "tools/list" ? { tools: [] } : {},
          }),
        );
      }),
    );

    const result = await createGleanConnector().ingest();

    expect(result.status).toBe("success");
    expect(tokenRefreshes).toBe(1);
    expect(feedAuthorizations).toEqual([
      "Bearer expired-access-token",
      "Bearer refreshed-access-token",
    ]);
  });

  test("refreshes once and retries the default people request after a 401", async () => {
    await writeGleanConfig({ enabled: true, instance: "acme" });
    process.env.OPENWIKI_GLEAN_ACCESS_TOKEN = "expired-access-token";
    process.env.OPENWIKI_GLEAN_CLIENT_ID = "registered-client";
    process.env.OPENWIKI_GLEAN_REFRESH_TOKEN = "refresh-token";
    const peopleAuthorizations: (string | null)[] = [];
    let tokenRefreshes = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request, init?: RequestInit) => {
        const url = input instanceof Request ? input.url : input.toString();

        if (url.endsWith("/rest/api/v1/feed")) {
          return Promise.resolve(Response.json({ items: [] }));
        }
        if (url.endsWith("/rest/api/v1/search")) {
          return Promise.resolve(Response.json({ results: [] }));
        }
        if (url.endsWith("/rest/api/v1/people")) {
          peopleAuthorizations.push(
            new Headers(init?.headers).get("Authorization"),
          );
          return Promise.resolve(
            peopleAuthorizations.length === 1
              ? new Response(null, { status: 401 })
              : Response.json({ results: [] }),
          );
        }
        if (url.includes("oauth-protected-resource")) {
          return Promise.resolve(
            Response.json({
              authorization_servers: ["https://auth.acme.example"],
            }),
          );
        }
        if (
          url.includes("oauth-authorization-server") ||
          url.includes("openid-configuration")
        ) {
          return Promise.resolve(
            Response.json({
              token_endpoint: "https://auth.acme.example/token",
            }),
          );
        }
        if (url === "https://auth.acme.example/token") {
          tokenRefreshes += 1;
          return Promise.resolve(
            Response.json({
              access_token: "refreshed-access-token",
              expires_in: 3600,
              refresh_token: "refresh-token",
              token_type: "Bearer",
            }),
          );
        }

        const body = typeof init?.body === "string" ? init.body : "{}";
        const request = JSON.parse(body) as { id?: number; method?: string };
        if (request.id === undefined) {
          return Promise.resolve(new Response(null, { status: 202 }));
        }
        return Promise.resolve(
          Response.json({
            id: request.id,
            jsonrpc: "2.0",
            result: request.method === "tools/list" ? { tools: [] } : {},
          }),
        );
      }),
    );

    const result = await createGleanConnector().ingest();

    expect(result.status).toBe("success");
    expect(tokenRefreshes).toBe(1);
    expect(peopleAuthorizations).toEqual([
      "Bearer expired-access-token",
      "Bearer refreshed-access-token",
    ]);
  });

  test("returns an authentication hint when the tenant probe fails", async () => {
    await writeGleanConfig({ enabled: true, instance: "acme" });
    process.env.OPENWIKI_GLEAN_ACCESS_TOKEN = "secret-access-token";
    const connector = createGleanConnector({
      transport: {
        ...createEmptyGleanTransport(),
        fetchFeed: () => Promise.resolve({ items: [] }),
        listTools: () => Promise.reject(new Error("401 Unauthorized")),
      },
    });

    const result = await connector.ingest();
    expect(result.message).toMatch(/openwiki auth glean/u);
    expect(result.status).toBe("error");
  });

  test("deduplicates feed identities across immediately repeated runs", async () => {
    await writeGleanConfig({ enabled: true, instance: "acme" });
    process.env.OPENWIKI_GLEAN_ACCESS_TOKEN = "secret-access-token";
    const transport = {
      ...createEmptyGleanTransport(),
      fetchFeed: () =>
        Promise.resolve({
          items: [
            {
              category: "MENTION",
              document: {
                id: "mention-1",
                title: "A mention",
                url: "https://app.glean.com/go/mention-1",
              },
            },
          ],
        }),
      listTools: () => Promise.resolve([]),
    };
    const connector = createGleanConnector({ transport });

    const first = await connector.ingest();
    const second = await connector.ingest();

    expect(first.status).toBe("success");
    expect(second.status).toBe("success");
    const secondFeed = JSON.parse(
      await readFile(
        second.rawFiles.find((file) => path.basename(file) === "feed.json")!,
        "utf8",
      ),
    ) as { counts: Record<string, number>; items: unknown[] };
    expect(secondFeed).toMatchObject({
      counts: { deduplicated: 1, fetched: 1, new: 0 },
      items: [],
    });

    const state = JSON.parse(
      await readFile(
        path.join(openWikiHome, "connectors", "glean", "state.json"),
        "utf8",
      ),
    ) as { seenIds: Record<string, string[]> };
    expect(state.seenIds.feed).toEqual(["mention-1"]);
  });

  test("deduplicates every stream across immediately repeated runs", async () => {
    await writeGleanConfig({ enabled: true, instance: "acme" });
    process.env.OPENWIKI_GLEAN_ACCESS_TOKEN = "secret-access-token";
    const transport = {
      fetchCalendar: () =>
        Promise.resolve({
          results: [
            {
              busyEvents: [
                {
                  endTime: "2026-07-13T10:30:00.000Z",
                  name: "Composite identity event",
                  startTime: "2026-07-13T10:00:00.000Z",
                },
              ],
            },
          ],
        }),
      fetchExpansion: () => Promise.resolve({}),
      fetchFeed: () =>
        Promise.resolve({
          items: [
            {
              id: "feed-repeat-1",
              url: "https://app.glean.com/go/feed-repeat-1",
            },
          ],
        }),
      fetchMessages: () =>
        Promise.resolve({
          results: [
            {
              id: "message-repeat-1",
              url: "https://app.glean.com/go/message-repeat-1",
            },
          ],
        }),
      fetchMyWork: () =>
        Promise.resolve({
          results: [
            {
              id: "work-repeat-1",
              url: "https://app.glean.com/go/work-repeat-1",
            },
          ],
        }),
      listTools: () => Promise.resolve([]),
    };
    const connector = createGleanConnector({ transport });

    const first = await connector.ingest();
    const firstState = JSON.parse(
      await readFile(
        path.join(openWikiHome, "connectors", "glean", "state.json"),
        "utf8",
      ),
    ) as { seenIds: Record<string, string[]> };
    const second = await connector.ingest();
    const secondArtifacts = await Promise.all(
      second.rawFiles
        .filter((file) => path.basename(file) !== "probe.json")
        .map(
          async (file) =>
            JSON.parse(await readFile(file, "utf8")) as {
              counts: Record<string, number>;
              items: unknown[];
              stream: string;
            },
        ),
    );

    expect(first.status).toBe("success");
    expect(second.status).toBe("success");
    expect(secondArtifacts.map(({ stream }) => stream)).toEqual([
      "feed",
      "my-work",
      "messages",
      "calendar",
      "expanded",
    ]);
    for (const artifact of secondArtifacts.slice(0, 4)) {
      expect(artifact.counts).toMatchObject({
        deduplicated: 1,
        fetched: 1,
        new: 0,
        skipped: 0,
      });
      expect(artifact.items).toEqual([]);
    }
    expect(secondArtifacts[4]).toMatchObject({
      counts: {
        candidates: 0,
        capped: 0,
        deduplicated: 0,
        expanded: 0,
        failed: 0,
      },
      items: [],
      stream: "expanded",
    });
    const secondState = JSON.parse(
      await readFile(
        path.join(openWikiHome, "connectors", "glean", "state.json"),
        "utf8",
      ),
    ) as { seenIds: Record<string, string[]> };
    expect(secondState.seenIds).toEqual(firstState.seenIds);
    expect(secondState.seenIds["my-work"]).toEqual(["work-repeat-1"]);
    expect(secondState.seenIds.calendar).toEqual([
      "busy:2026-07-13T10:00:00.000Z/2026-07-13T10:30:00.000Z/Composite identity event",
    ]);
  });

  test("uses an overlapping date window and filters parseable distant events", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-13T12:00:00.000Z"));
    await writeGleanConfig({ enabled: true, instance: "acme" });
    process.env.OPENWIKI_GLEAN_ACCESS_TOKEN = "secret-access-token";
    const sinceDates: string[] = [];
    const connector = createGleanConnector({
      transport: {
        ...createEmptyGleanTransport(),
        fetchCalendar: () =>
          Promise.resolve({
            results: [
              {
                busyEvents: [
                  {
                    endTime: "2026-07-23T13:00:00.000Z",
                    eventId: "too-far",
                    startTime: "2026-07-23T12:00:00.000Z",
                  },
                  {
                    endTime: "2026-07-16T13:00:00.000Z",
                    eventId: "nearby",
                    startTime: "2026-07-16T12:00:00.000Z",
                  },
                  {
                    endTime: "later-ish",
                    eventId: "unparseable",
                    startTime: "sometime soon",
                  },
                ],
              },
            ],
          }),
        fetchMessages: ({ sinceDate }) => {
          sinceDates.push(sinceDate);
          return Promise.resolve({ results: [] });
        },
        fetchMyWork: ({ sinceDate }) => {
          sinceDates.push(sinceDate);
          return Promise.resolve({ results: [] });
        },
      },
    });

    const result = await connector.ingest();
    const calendar = JSON.parse(
      await readFile(
        result.rawFiles.find(
          (file) => path.basename(file) === "calendar.json",
        )!,
        "utf8",
      ),
    ) as {
      counts: Record<string, number>;
      items: { id: string }[];
      window: Record<string, number>;
    };

    expect(sinceDates).toEqual(["2026-07-10", "2026-07-10"]);
    expect(calendar).toMatchObject({
      counts: { fetched: 3, new: 2, skipped: 1 },
      window: { days: 7 },
    });
    expect(calendar.items.map(({ id }) => id)).toEqual([
      "nearby",
      "unparseable",
    ]);
  });

  test("omits optional feed fields that the tenant response does not provide", async () => {
    await writeGleanConfig({ enabled: true, instance: "acme" });
    process.env.OPENWIKI_GLEAN_ACCESS_TOKEN = "secret-access-token";
    const connector = createGleanConnector({
      transport: {
        ...createEmptyGleanTransport(),
        fetchFeed: () =>
          Promise.resolve({
            categories: [
              {
                category: "TASK",
                results: [
                  {
                    document: {
                      id: "task-1",
                      url: "https://app.glean.com/go/task-1",
                    },
                  },
                ],
              },
            ],
          }),
        listTools: () => Promise.resolve([]),
      },
    });

    const result = await connector.ingest();
    const feed = JSON.parse(
      await readFile(
        result.rawFiles.find((file) => path.basename(file) === "feed.json")!,
        "utf8",
      ),
    ) as { fetchedAt: string; items: Record<string, unknown>[] };

    expect(feed.items).toEqual([
      {
        category: "TASK",
        fetchedAt: feed.fetchedAt,
        id: "task-1",
        url: "https://app.glean.com/go/task-1",
      },
    ]);
  });

  test("expands distinct candidates in tier order with full-content provenance", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-13T12:00:00.000Z"));
    await writeGleanConfig({
      enabled: true,
      expansion: { transcriptDatasources: [" Fellow "] },
      instance: "acme",
    });
    process.env.OPENWIKI_GLEAN_ACCESS_TOKEN = "secret-access-token";
    const fetchedIds: string[] = [];
    const connector = createGleanConnector({
      transport: {
        ...createEmptyGleanTransport(),
        fetchCalendar: () =>
          Promise.resolve({
            relatedDocuments: [
              {
                datasource: "FELLOW",
                id: "transcript-1",
                title: "Planning transcript",
                url: "https://app.glean.com/go/transcript-1",
              },
            ],
            results: [],
          }),
        fetchExpansion: ({ item }) => {
          fetchedIds.push(item.id);
          if (item.id === "transcript-1") {
            return Promise.resolve({
              document: { content: { fullText: "Transcript full text" } },
            });
          }
          if (item.id === "owned-1") {
            return Promise.resolve({
              content: { fullTextList: ["Owned", "document"] },
            });
          }
          return Promise.resolve({ text: "Mention full text" });
        },
        fetchFeed: () =>
          Promise.resolve({
            items: [
              {
                category: "MENTION",
                document: {
                  id: "transcript-1",
                  title: "Lower-priority transcript mention",
                  url: "https://app.glean.com/go/transcript-1",
                },
              },
              {
                category: "MENTION",
                document: {
                  id: "mention-1",
                  title: "Direct mention",
                  url: "https://app.glean.com/go/mention-1",
                },
              },
            ],
          }),
        fetchMyWork: () =>
          Promise.resolve({
            results: [
              {
                document: {
                  id: "owned-1",
                  title: "Owned plan",
                  url: "https://app.glean.com/go/owned-1",
                },
              },
            ],
          }),
      },
    });

    const result = await connector.ingest();
    const expandedPath = result.rawFiles.find(
      (file) => path.basename(file) === "expanded.json",
    )!;
    const expandedText = await readFile(expandedPath, "utf8");
    const expanded = JSON.parse(expandedText) as Record<string, unknown>;

    expect(result.status).toBe("success");
    expect(fetchedIds).toEqual(["transcript-1", "owned-1", "mention-1"]);
    expect(expanded).toEqual({
      counts: {
        candidates: 3,
        capped: 0,
        deduplicated: 0,
        expanded: 3,
        failed: 0,
      },
      fetchedAt: "2026-07-13T12:00:00.000Z",
      items: [
        {
          content: "Transcript full text",
          fetchedAt: "2026-07-13T12:00:00.000Z",
          id: "transcript-1",
          sourceStream: "calendar",
          tier: 1,
          title: "Planning transcript",
          url: "https://app.glean.com/go/transcript-1",
        },
        {
          content: "Owned\ndocument",
          fetchedAt: "2026-07-13T12:00:00.000Z",
          id: "owned-1",
          sourceStream: "my-work",
          tier: 2,
          title: "Owned plan",
          url: "https://app.glean.com/go/owned-1",
        },
        {
          content: "Mention full text",
          fetchedAt: "2026-07-13T12:00:00.000Z",
          id: "mention-1",
          sourceStream: "feed",
          tier: 3,
          title: "Direct mention",
          url: "https://app.glean.com/go/mention-1",
        },
      ],
      stream: "expanded",
    });
    expect(expandedText).not.toContain("secret-access-token");
    expect(expandedText).not.toContain("Authorization");
  });

  test("caps expansion after ranking so lower-value candidates stay snippets", async () => {
    await writeGleanConfig({
      enabled: true,
      expansion: { maxItems: 2, transcriptDatasources: ["fellow"] },
      instance: "acme",
    });
    process.env.OPENWIKI_GLEAN_ACCESS_TOKEN = "secret-access-token";
    const fetchExpansion = vi.fn((input: { item: { id: string } }) =>
      Promise.resolve({ content: `Full ${input.item.id}` }),
    );
    const connector = createGleanConnector({
      transport: {
        ...createEmptyGleanTransport(),
        fetchCalendar: () =>
          Promise.resolve({
            relatedDocuments: [
              {
                datasource: "fellow",
                id: "tier-1",
                url: "https://app.glean.com/go/tier-1",
              },
            ],
            results: [],
          }),
        fetchExpansion,
        fetchFeed: () =>
          Promise.resolve({
            items: [
              {
                category: "MENTION",
                id: "tier-3-feed",
                url: "https://app.glean.com/go/tier-3-feed",
              },
            ],
          }),
        fetchMessages: () =>
          Promise.resolve({
            results: [
              {
                id: "tier-3-message",
                url: "https://app.glean.com/go/tier-3-message",
              },
            ],
          }),
        fetchMyWork: () =>
          Promise.resolve({
            results: [
              {
                id: "tier-2",
                url: "https://app.glean.com/go/tier-2",
              },
            ],
          }),
      },
    });

    const result = await connector.ingest();
    const expanded = JSON.parse(
      await readFile(
        result.rawFiles.find(
          (file) => path.basename(file) === "expanded.json",
        )!,
        "utf8",
      ),
    ) as {
      counts: Record<string, number>;
      items: { id: string; tier: number }[];
    };

    expect(result.status).toBe("success");
    expect(fetchExpansion).toHaveBeenCalledTimes(2);
    expect(fetchExpansion.mock.calls.map(([input]) => input.item.id)).toEqual([
      "tier-1",
      "tier-2",
    ]);
    expect(expanded.counts).toEqual({
      candidates: 4,
      capped: 2,
      deduplicated: 0,
      expanded: 2,
      failed: 0,
    });
    expect(expanded.items.map(({ id, tier }) => ({ id, tier }))).toEqual([
      { id: "tier-1", tier: 1 },
      { id: "tier-2", tier: 2 },
    ]);
  });

  test("does not re-fetch an expanded id when it appears in another stream", async () => {
    await writeGleanConfig({ enabled: true, instance: "acme" });
    process.env.OPENWIKI_GLEAN_ACCESS_TOKEN = "secret-access-token";
    let secondRun = false;
    const fetchExpansion = vi.fn((input: { item: { id: string } }) =>
      Promise.resolve({ text: `Full ${input.item.id}` }),
    );
    const connector = createGleanConnector({
      transport: {
        ...createEmptyGleanTransport(),
        fetchExpansion,
        fetchMessages: () =>
          Promise.resolve({
            results: secondRun
              ? [
                  {
                    id: "cross-run-1",
                    url: "https://app.glean.com/go/cross-run-1",
                  },
                ]
              : [],
          }),
        fetchMyWork: () =>
          Promise.resolve({
            results: secondRun
              ? []
              : [
                  {
                    id: "cross-run-1",
                    url: "https://app.glean.com/go/cross-run-1",
                  },
                ],
          }),
      },
    });

    const first = await connector.ingest();
    expect(first.status).toBe("success");
    expect(fetchExpansion).toHaveBeenCalledTimes(1);
    fetchExpansion.mockClear();
    secondRun = true;

    const second = await connector.ingest();
    const expanded = JSON.parse(
      await readFile(
        second.rawFiles.find(
          (file) => path.basename(file) === "expanded.json",
        )!,
        "utf8",
      ),
    ) as { counts: Record<string, number>; items: unknown[] };
    const state = JSON.parse(
      await readFile(
        path.join(openWikiHome, "connectors", "glean", "state.json"),
        "utf8",
      ),
    ) as { seenIds: Record<string, string[]> };

    expect(second.status).toBe("success");
    expect(fetchExpansion).not.toHaveBeenCalled();
    expect(expanded).toMatchObject({
      counts: {
        candidates: 1,
        capped: 0,
        deduplicated: 1,
        expanded: 0,
        failed: 0,
      },
      items: [],
    });
    expect(state.seenIds.expanded).toEqual(["cross-run-1"]);
  });

  test("keeps successful expansions when one full-content fetch fails", async () => {
    await writeGleanConfig({ enabled: true, instance: "acme" });
    process.env.OPENWIKI_GLEAN_ACCESS_TOKEN = "secret-access-token";
    const connector = createGleanConnector({
      transport: {
        ...createEmptyGleanTransport(),
        fetchExpansion: ({ item }) =>
          item.id === "fails-1"
            ? Promise.reject(new Error("document unavailable"))
            : Promise.resolve({ text: "Working full text" }),
        fetchMessages: () =>
          Promise.resolve({
            results: [
              {
                id: "works-1",
                url: "https://app.glean.com/go/works-1",
              },
            ],
          }),
        fetchMyWork: () =>
          Promise.resolve({
            results: [
              {
                id: "fails-1",
                url: "https://app.glean.com/go/fails-1",
              },
            ],
          }),
      },
    });

    const result = await connector.ingest();
    const expanded = JSON.parse(
      await readFile(
        result.rawFiles.find(
          (file) => path.basename(file) === "expanded.json",
        )!,
        "utf8",
      ),
    ) as { counts: Record<string, number>; items: { id: string }[] };
    const state = JSON.parse(
      await readFile(
        path.join(openWikiHome, "connectors", "glean", "state.json"),
        "utf8",
      ),
    ) as { seenIds: Record<string, string[]> };

    expect(result.status).toBe("success");
    expect(result.warnings).toContain(
      "Glean expanded fetch failed for fails-1: document unavailable",
    );
    expect(expanded).toMatchObject({
      counts: {
        candidates: 2,
        capped: 0,
        deduplicated: 0,
        expanded: 1,
        failed: 1,
      },
      items: [{ id: "works-1" }],
    });
    expect(state.seenIds.expanded).toEqual(["works-1"]);
    expect(state.seenIds.expanded).not.toContain("fails-1");
  });

  test("degrades a feed failure while the other streams succeed", async () => {
    await writeGleanConfig({ enabled: true, instance: "acme" });
    process.env.OPENWIKI_GLEAN_ACCESS_TOKEN = "secret-access-token";
    const connector = createGleanConnector({
      transport: {
        ...createEmptyGleanTransport(),
        fetchFeed: () => Promise.reject(new Error("401 Unauthorized")),
        listTools: () => Promise.resolve([{ name: "search" }]),
      },
    });

    const result = await connector.ingest();

    expect(result.status).toBe("success");
    expect(result.warnings).toEqual([
      "Glean feed pull failed: 401 Unauthorized",
    ]);
    expect(result.rawFiles.map((file) => path.basename(file))).toEqual([
      "probe.json",
      "my-work.json",
      "messages.json",
      "calendar.json",
      "expanded.json",
    ]);
  });

  test("records a my-work warning while preserving other stream artifacts", async () => {
    await writeGleanConfig({ enabled: true, instance: "acme" });
    process.env.OPENWIKI_GLEAN_ACCESS_TOKEN = "secret-access-token";
    const connector = createGleanConnector({
      transport: {
        ...createEmptyGleanTransport(),
        fetchMyWork: () => Promise.reject(new Error("tenant search failed")),
        listTools: () => Promise.resolve([{ name: "search" }]),
      },
    });

    const result = await connector.ingest();

    expect(result.status).toBe("success");
    expect(result.warnings).toEqual([
      "Glean my-work pull failed: tenant search failed",
    ]);
    expect(result.rawFiles.map((file) => path.basename(file))).toEqual([
      "probe.json",
      "feed.json",
      "messages.json",
      "calendar.json",
      "expanded.json",
    ]);
    const state = JSON.parse(
      await readFile(
        path.join(openWikiHome, "connectors", "glean", "state.json"),
        "utf8",
      ),
    ) as { runs: { status: string; warnings: string[] }[] };
    expect(state.runs[0]).toMatchObject({
      status: "success",
      warnings: result.warnings,
    });
  });

  test("returns actionable authentication guidance when all evidence streams fail", async () => {
    await writeGleanConfig({ enabled: true, instance: "acme" });
    process.env.OPENWIKI_GLEAN_ACCESS_TOKEN = "secret-access-token";
    const failure = new Error("401 Unauthorized");
    const connector = createGleanConnector({
      transport: {
        fetchCalendar: () => Promise.reject(failure),
        fetchExpansion: () => Promise.resolve({}),
        fetchFeed: () => Promise.reject(failure),
        fetchMessages: () => Promise.reject(failure),
        fetchMyWork: () => Promise.reject(failure),
        listTools: () => Promise.resolve([{ name: "search" }]),
      },
    });

    const result = await connector.ingest();

    expect(result.status).toBe("error");
    expect(result.message).toMatch(/openwiki auth glean/u);
    expect(result.rawFiles.map((file) => path.basename(file))).toEqual([
      "probe.json",
    ]);
    expect(result.warnings).toEqual([
      "Glean feed pull failed: 401 Unauthorized",
      "Glean my-work pull failed: 401 Unauthorized",
      "Glean messages pull failed: 401 Unauthorized",
      "Glean calendar pull failed: 401 Unauthorized",
    ]);
  });

  test("keeps the probe successful when the tenant feed endpoint is unavailable", async () => {
    await writeGleanConfig({ enabled: true, instance: "acme" });
    process.env.OPENWIKI_GLEAN_ACCESS_TOKEN = "secret-access-token";
    const unavailableError = Object.assign(new Error("Not Found"), {
      status: 404,
    });
    const connector = createGleanConnector({
      transport: {
        ...createEmptyGleanTransport(),
        fetchFeed: () => Promise.reject(unavailableError),
        listTools: () => Promise.resolve([{ name: "search" }]),
      },
    });

    const result = await connector.ingest();

    expect(result.status).toBe("success");
    expect(result.rawFiles.map((file) => path.basename(file))).toEqual([
      "probe.json",
      "my-work.json",
      "messages.json",
      "calendar.json",
      "expanded.json",
    ]);
    expect(result.warnings.join(" ")).toMatch(/feed endpoint.*unavailable/iu);

    const state = JSON.parse(
      await readFile(
        path.join(openWikiHome, "connectors", "glean", "state.json"),
        "utf8",
      ),
    ) as { runs: { status: string; warnings: string[] }[] };
    expect(state.runs[0]).toMatchObject({
      status: "success",
      warnings: result.warnings,
    });
  });
});

describe("Glean registration", () => {
  test("registers Glean as a selectable direct API connector", () => {
    expect(CONNECTOR_IDS).toContain("glean");
    expect(createConnectorRegistry().glean.backend).toBe("direct-api");
    expect(isConnectorId("glean")).toBe(true);
  });
});

describe("Glean OAuth provider", () => {
  test("enumerates safely and resolves its tenant MCP resource at call time", async () => {
    expect(
      getOAuthProviderIdForAccessTokenEnvKey("OPENWIKI_GLEAN_ACCESS_TOKEN"),
    ).toBe("glean");

    const provider = getAuthProvider("glean");
    expect(provider).toMatchObject({
      clientAuth: "none",
      scopes: ["chat", "mcp", "search"],
      tokenMapping: {
        accessTokenEnvKey: "OPENWIKI_GLEAN_ACCESS_TOKEN",
        clientIdEnvKey: "OPENWIKI_GLEAN_CLIENT_ID",
        expiresAtEnvKey: "OPENWIKI_GLEAN_TOKEN_EXPIRES_AT",
        refreshTokenEnvKey: "OPENWIKI_GLEAN_REFRESH_TOKEN",
        tokenTypeEnvKey: "OPENWIKI_GLEAN_TOKEN_TYPE",
      },
    });
    await expect(provider.resolveMcpResourceUrl?.()).rejects.toThrow(
      /OPENWIKI_GLEAN_BACKEND_URL/u,
    );

    process.env.OPENWIKI_GLEAN_INSTANCE = "acme";
    await expect(provider.resolveMcpResourceUrl?.()).resolves.toBe(
      "https://acme-be.glean.com/mcp/default",
    );
  });

  test("mints the OAuth token audience for a configured MCP path", async () => {
    await writeGleanConfig({ instance: "acme", mcpPath: "/mcp/gateway" });

    await expect(
      getAuthProvider("glean").resolveMcpResourceUrl?.(),
    ).resolves.toBe("https://acme-be.glean.com/mcp/gateway");
  });

  test("rejects a configured MCP path without a leading slash", async () => {
    await writeGleanConfig({ instance: "acme", mcpPath: "mcp/gateway" });

    await expect(
      getAuthProvider("glean").resolveMcpResourceUrl?.(),
    ).rejects.toThrow(/mcpPath must start with \//u);
  });

  test("writes the minimal enabled connector config after authentication", async () => {
    const result = await configureAuthProvider("glean");
    const config = JSON.parse(await readFile(result.configPath, "utf8")) as {
      enabled: boolean;
      mcpPath: string;
      note: string;
    };

    expect(config).toMatchObject({
      enabled: true,
      mcpPath: "/mcp/default",
    });
    expect(config.note).toMatch(
      /backendBaseUrl.*instance.*email.*OPENWIKI_GLEAN_/u,
    );
    expect(result.nextSteps.join(" ")).toMatch(/probe.*Glean/u);
    expect(formatAuthProviderList()).toMatch(/glean\s+Glean/u);
  });

  test("loads tenant settings before discovering the refresh endpoint", async () => {
    await writeFile(
      path.join(openWikiHome, ".env"),
      [
        "OPENWIKI_GLEAN_CLIENT_ID=registered-client",
        "OPENWIKI_GLEAN_INSTANCE=acme",
        "OPENWIKI_GLEAN_REFRESH_TOKEN=refresh-token",
        "",
      ].join("\n"),
    );
    const requests: { body?: string; url: string }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request, init?: RequestInit) => {
        const url = input instanceof Request ? input.url : input.toString();
        const body =
          typeof init?.body === "string" ||
          init?.body instanceof URLSearchParams
            ? init.body.toString()
            : undefined;
        requests.push({ body, url });

        if (url.includes("oauth-protected-resource")) {
          return Promise.resolve(
            Response.json({
              authorization_servers: ["https://auth.acme.example"],
            }),
          );
        }
        if (
          url.includes("oauth-authorization-server") ||
          url.includes("openid-configuration")
        ) {
          return Promise.resolve(
            Response.json({
              token_endpoint: "https://auth.acme.example/token",
            }),
          );
        }
        if (url === "https://auth.acme.example/token") {
          return Promise.resolve(
            Response.json({
              access_token: "new-access-token",
              expires_in: 3600,
              refresh_token: "new-refresh-token",
              token_type: "Bearer",
            }),
          );
        }

        return Promise.resolve(new Response(null, { status: 404 }));
      }),
    );

    await expect(refreshOAuthAccessToken("glean")).resolves.toBe(
      "new-access-token",
    );
    expect(requests[0].url).toBe(
      "https://acme-be.glean.com/.well-known/oauth-protected-resource/mcp/default",
    );
    expect(requests.at(-1)?.body).toContain(
      "resource=https%3A%2F%2Facme-be.glean.com%2Fmcp%2Fdefault",
    );
  });
});
