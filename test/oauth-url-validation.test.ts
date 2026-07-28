import { afterEach, describe, expect, test, vi } from "vitest";
import {
  discoverAuthorizationServerMetadata,
  validateOAuthEndpointUrl,
} from "../src/auth/oauth-discovery.ts";
import {
  AUTH_PROVIDERS,
  resolveOAuthMcpResourceUrl,
} from "../src/auth/providers.ts";
import type { OAuthProviderConfig } from "../src/auth/types.ts";

describe("validateOAuthEndpointUrl", () => {
  test("allows HTTPS URLs on explicitly allowed hosts", () => {
    expect(
      validateOAuthEndpointUrl(
        "https://api.notion.com/v1/oauth/token",
        "token",
        {
          allowedHosts: ["notion.com"],
        },
      ).toString(),
    ).toBe("https://api.notion.com/v1/oauth/token");
  });

  test.each([
    "http://api.notion.com/v1/oauth/token",
    "https://localhost/token",
    "https://127.0.0.1/token",
    "https://10.0.0.1/token",
    "https://172.16.0.1/token",
    "https://192.168.0.1/token",
    "https://169.254.169.254/latest/meta-data/",
    "https://[::1]/token",
    "https://[fe80::1]/token",
    "https://[fd00::1]/token",
    "https://user:pass@api.notion.com/token",
    "https://attacker.example/token",
  ])("rejects unsafe OAuth endpoint URL %s", (value) => {
    expect(() =>
      validateOAuthEndpointUrl(value, "token", {
        allowedHosts: ["notion.com"],
      }),
    ).toThrow();
  });
});

describe("resolveOAuthMcpResourceUrl", () => {
  // Upstream guards `if (!provider.mcpResourceUrl) throw` inside
  // `registerMcpOAuthClient` and `discoverMcpTokenEndpoint`. This fork resolves
  // the resource URL dynamically for Glean, so that guard cannot live there —
  // Glean legitimately has no static `mcpResourceUrl` field, and the guard
  // would reject a working provider. It lives here instead, at the seam that
  // owns resolution, so the guarantee "an MCP OAuth provider that reaches
  // discovery has a non-empty resource URL" still holds.

  const providerWithResolver = (resolved: string): OAuthProviderConfig => ({
    ...AUTH_PROVIDERS.glean,
    resolveMcpResourceUrl: () => Promise.resolve(resolved),
  });

  test("returns a statically declared resource URL unchanged", async () => {
    await expect(
      resolveOAuthMcpResourceUrl(AUTH_PROVIDERS.notion),
    ).resolves.toBe("https://mcp.notion.com/mcp");
  });

  test("returns undefined for a provider that has no MCP resource URL at all", async () => {
    // Gmail authenticates against static endpoints; absence is not an error.
    await expect(
      resolveOAuthMcpResourceUrl(AUTH_PROVIDERS.gmail),
    ).resolves.toBeUndefined();
  });

  test("returns the dynamically resolved resource URL", async () => {
    await expect(
      resolveOAuthMcpResourceUrl(
        providerWithResolver("https://acme-be.glean.com/mcp/default"),
      ),
    ).resolves.toBe("https://acme-be.glean.com/mcp/default");
  });

  test.each(["", "   "])(
    "rejects a dynamic resolver that yields %o instead of falling through to a misleading message",
    async (resolved) => {
      // Without this the blank URL is simply falsy at the call site, and the
      // run fails with "Glean OAuth provider is incomplete." / "… token
      // endpoint is unknown." — neither of which names the real cause.
      await expect(
        resolveOAuthMcpResourceUrl(providerWithResolver(resolved)),
      ).rejects.toThrow("Glean did not resolve an MCP OAuth resource URL.");
    },
  );

  test.each(["", "   "])(
    "rejects a blank statically declared resource URL %o, not only a blank dynamic one",
    async (mcpResourceUrl) => {
      // The guard covers both branches. A blank static field is truthy-checked
      // the same way at the call sites, and would otherwise reach
      // `validateOAuthEndpointUrl` and die on a bare `TypeError: Invalid URL`
      // from `new URL()` — the same unnamed-cause failure the guard exists to
      // replace, one branch over.
      await expect(
        resolveOAuthMcpResourceUrl({
          ...AUTH_PROVIDERS.notion,
          mcpResourceUrl,
        }),
      ).rejects.toThrow(
        "Notion MCP did not resolve an MCP OAuth resource URL.",
      );
    },
  );

  test("trims the resolved resource URL so padding never reaches the wire", async () => {
    // The resolved string is not only fed to `new URL()` (which tolerates
    // padding) — it is also sent verbatim as the OAuth `resource` parameter in
    // the token request body and the authorization URL.
    await expect(
      resolveOAuthMcpResourceUrl(
        providerWithResolver(" https://acme-be.glean.com/mcp/default \n"),
      ),
    ).resolves.toBe("https://acme-be.glean.com/mcp/default");
  });

  test("trims a statically declared resource URL too", async () => {
    await expect(
      resolveOAuthMcpResourceUrl({
        ...AUTH_PROVIDERS.notion,
        mcpResourceUrl: "  https://mcp.notion.com/mcp  ",
      }),
    ).resolves.toBe("https://mcp.notion.com/mcp");
  });
});

describe("OAuth discovery fetches", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("does not follow metadata redirects", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(new Response(null, { status: 302 })),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      discoverAuthorizationServerMetadata("https://auth.notion.com/oauth", {
        allowedHosts: ["notion.com"],
      }),
    ).rejects.toThrow(
      "Could not discover OAuth authorization server metadata.",
    );

    expect(fetchMock).toHaveBeenCalled();
    for (const call of fetchMock.mock.calls) {
      expect(call[1]).toMatchObject({ redirect: "manual" });
    }
  });
});
