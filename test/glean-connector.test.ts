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

beforeEach(async () => {
  openWikiHome = await mkdtemp(path.join(tmpdir(), "openwiki-glean-"));
  process.env.OPENWIKI_HOME = openWikiHome;
  for (const key of GLEAN_ENV_KEYS) {
    delete process.env[key];
  }
});

afterEach(async () => {
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

  test("writes the probe and a normalized feed artifact with persisted identities", async () => {
    await writeGleanConfig({
      enabled: true,
      instance: "acme",
      mcpPath: "/mcp/gateway",
    });
    process.env.OPENWIKI_GLEAN_ACCESS_TOKEN = "secret-access-token";
    process.env.OPENWIKI_GLEAN_REFRESH_TOKEN = "secret-refresh-token";

    const connector = createGleanConnector({
      transport: {
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
      "Probed 2 MCP tool(s) at https://acme-be.glean.com; pulled 1 feed item(s) (1 new).",
    );
    expect(result.rawFiles.map((file) => path.basename(file))).toEqual([
      "probe.json",
      "feed.json",
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

    const stateText = await readFile(
      path.join(openWikiHome, "connectors", "glean", "state.json"),
      "utf8",
    );
    const state = JSON.parse(stateText) as {
      runs: { rawFiles: string[]; runId: string; status: string }[];
      seenIds: Record<string, string[]>;
    };
    expect(state.seenIds.feed).toEqual(["document-123"]);
    expect(state.runs[0]).toMatchObject({
      rawFiles: result.rawFiles,
      runId: result.runId,
      status: "success",
    });
    expect(stateText).not.toContain("secret-access-token");
    expect(stateText).not.toContain("secret-refresh-token");
    expect(stateText).not.toContain("Authorization");
  });

  test("uses the default MCP path for the tenant probe", async () => {
    await writeGleanConfig({ enabled: true, instance: "acme" });
    process.env.OPENWIKI_GLEAN_ACCESS_TOKEN = "secret-access-token";
    let probedUrl = "";
    const connector = createGleanConnector({
      transport: {
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

  test("uses the OAuth token for the default MCP probe and feed request", async () => {
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
    expect(requests).toHaveLength(4);
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

  test("returns an authentication hint when the tenant probe fails", async () => {
    await writeGleanConfig({ enabled: true, instance: "acme" });
    process.env.OPENWIKI_GLEAN_ACCESS_TOKEN = "secret-access-token";
    const connector = createGleanConnector({
      transport: {
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

  test("omits optional feed fields that the tenant response does not provide", async () => {
    await writeGleanConfig({ enabled: true, instance: "acme" });
    process.env.OPENWIKI_GLEAN_ACCESS_TOKEN = "secret-access-token";
    const connector = createGleanConnector({
      transport: {
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

  test("returns actionable authentication guidance when the feed pull fails", async () => {
    await writeGleanConfig({ enabled: true, instance: "acme" });
    process.env.OPENWIKI_GLEAN_ACCESS_TOKEN = "secret-access-token";
    const connector = createGleanConnector({
      transport: {
        fetchFeed: () => Promise.reject(new Error("401 Unauthorized")),
        listTools: () => Promise.resolve([{ name: "search" }]),
      },
    });

    const result = await connector.ingest();

    expect(result.status).toBe("error");
    expect(result.message).toMatch(/openwiki auth glean/u);
    expect(result.rawFiles.map((file) => path.basename(file))).toEqual([
      "probe.json",
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
        fetchFeed: () => Promise.reject(unavailableError),
        listTools: () => Promise.resolve([{ name: "search" }]),
      },
    });

    const result = await connector.ingest();

    expect(result.status).toBe("success");
    expect(result.rawFiles.map((file) => path.basename(file))).toEqual([
      "probe.json",
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
