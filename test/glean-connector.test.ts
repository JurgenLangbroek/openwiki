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

  test("writes the tenant tool catalog probe and records a successful run", async () => {
    await writeGleanConfig({
      enabled: true,
      instance: "acme",
      mcpPath: "/mcp/gateway",
    });
    process.env.OPENWIKI_GLEAN_ACCESS_TOKEN = "secret-access-token";
    process.env.OPENWIKI_GLEAN_REFRESH_TOKEN = "secret-refresh-token";

    const connector = createGleanConnector({
      transport: {
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
      "Probed 2 MCP tool(s) at https://acme-be.glean.com.",
    );
    expect(result.rawFiles).toHaveLength(1);
    expect(path.basename(result.rawFiles[0])).toBe("probe.json");

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

    const state = JSON.parse(
      await readFile(
        path.join(openWikiHome, "connectors", "glean", "state.json"),
        "utf8",
      ),
    ) as { runs: { rawFiles: string[]; runId: string; status: string }[] };
    expect(state.runs[0]).toMatchObject({
      rawFiles: result.rawFiles,
      runId: result.runId,
      status: "success",
    });
  });

  test("uses the default MCP path for the tenant probe", async () => {
    await writeGleanConfig({ enabled: true, instance: "acme" });
    process.env.OPENWIKI_GLEAN_ACCESS_TOKEN = "secret-access-token";
    let probedUrl = "";
    const connector = createGleanConnector({
      transport: {
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

  test("uses the OAuth access-token template in the default MCP transport", async () => {
    await writeGleanConfig({ enabled: true, instance: "acme" });
    process.env.OPENWIKI_GLEAN_ACCESS_TOKEN = "secret-access-token";
    const requests: { authorization: string | null; url: string }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request, init?: RequestInit) => {
        const url = input instanceof Request ? input.url : input.toString();
        const headers = new Headers(init?.headers);
        requests.push({
          authorization: headers.get("Authorization"),
          url,
        });
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
    expect(requests).toHaveLength(3);
    expect(requests.every(({ url }) => url.endsWith("/mcp/default"))).toBe(
      true,
    );
    expect(
      requests.every(
        ({ authorization }) => authorization === "Bearer secret-access-token",
      ),
    ).toBe(true);
  });

  test("returns an authentication hint when the tenant probe fails", async () => {
    await writeGleanConfig({ enabled: true, instance: "acme" });
    process.env.OPENWIKI_GLEAN_ACCESS_TOKEN = "secret-access-token";
    const connector = createGleanConnector({
      transport: {
        listTools: () => Promise.reject(new Error("401 Unauthorized")),
      },
    });

    const result = await connector.ingest();
    expect(result.message).toMatch(/openwiki auth glean/u);
    expect(result.status).toBe("error");
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
