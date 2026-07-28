import { afterEach, describe, expect, test, vi } from "vitest";
import {
  discoverAuthorizationServerMetadata,
  validateOAuthEndpointUrl,
} from "../src/auth/oauth-discovery.ts";
import {
  AUTH_PROVIDERS,
  resolveOAuthMcpResourceUrl,
} from "../src/auth/providers.ts";
import { resolveGleanBackendUrl } from "../src/connectors/sources/glean-backend.ts";
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

describe("Glean's declared OAuth allowed hosts", () => {
  // Glean's OAuth endpoints are discovered from metadata served by a backend
  // whose host is the most user-supplied one in the system: it is derived from a
  // work email domain or from an instance name typed during setup. The provider
  // therefore cannot declare a fixed hostname — it declares Glean's registrable
  // domain and leans on upstream's exact-or-suffix matching, which admits every
  // instance-derived backend and any authorization server on the same domain
  // while refusing anything off it.
  const gleanAllowedHosts = AUTH_PROVIDERS.glean.oauthAllowedHosts;

  test("admits the backend host that instance resolution actually generates", () => {
    // The relationship, not the literal. If `resolveGleanBackendUrl` ever moves
    // the backend to another domain, this fails here rather than locking every
    // real user out of authentication at runtime.
    const backendHost = new URL(resolveGleanBackendUrl({ instance: "acme" }))
      .hostname;

    expect(
      validateOAuthEndpointUrl(
        `https://${backendHost}/mcp/default`,
        "MCP protected resource URL",
        { allowedHosts: gleanAllowedHosts },
      ).hostname,
    ).toBe(backendHost);
  });

  test.each([
    [
      "an instance-derived backend host",
      "https://acme-be.glean.com/.well-known/oauth-protected-resource/mcp/default",
    ],
    [
      "a separately-hosted authorization server on Glean's own domain",
      "https://auth.glean.com/oauth/authorize",
    ],
    ["Glean's registrable domain itself", "https://glean.com/oauth/token"],
  ])("accepts %s", (_case, value) => {
    expect(
      validateOAuthEndpointUrl(value, "endpoint", {
        allowedHosts: gleanAllowedHosts,
      }).toString(),
    ).toBe(value);
  });

  test.each([
    ["an endpoint discovered off Glean's domain", "https://attacker.example/"],
    [
      "a host that merely ends with Glean's domain as a label prefix",
      "https://notglean.com/token",
    ],
    [
      "a lookalike that puts Glean's domain in a subdomain position",
      "https://glean.com.attacker.example/token",
    ],
  ])("refuses %s", (_case, value) => {
    expect(() =>
      validateOAuthEndpointUrl(value, "endpoint", {
        allowedHosts: gleanAllowedHosts,
      }),
    ).toThrow("endpoint host is not allowed.");
  });

  test.each([
    ["localhost", "https://localhost/token"],
    ["a loopback address", "https://127.0.0.1/token"],
    ["an RFC1918 address", "https://10.0.0.1/token"],
    ["the link-local metadata address", "https://169.254.169.254/latest/"],
    ["an IPv6 loopback address", "https://[::1]/token"],
    ["an IPv6 unique-local address", "https://[fd00::1]/token"],
  ])("refuses %s regardless of the allowed-host list", (_case, value) => {
    // Inherited from upstream and not configurable: the private-network check
    // runs before the allowed-host check and cannot be opted out of by a
    // provider. Pinned against Glean's own list so a future widening of that
    // list cannot quietly re-admit these.
    expect(() =>
      validateOAuthEndpointUrl(value, "endpoint", {
        allowedHosts: gleanAllowedHosts,
      }),
    ).toThrow("endpoint must not target localhost or private networks.");
  });

  test("refuses an IPv4-mapped IPv6 private address, but by host list rather than by the private-network check", () => {
    // Upstream's `isBlockedIpv6` has an `::ffff:<dotted quad>` branch that
    // cannot fire on a URL-derived hostname: WHATWG serialises
    // `[::ffff:10.0.0.1]` to `[::ffff:a00:1]`, which its dotted-quad regex
    // never matches. On this fork the target is still refused — by Glean's
    // allowed-host list — and that is the only thing refusing it, which is a
    // second reason a discovering provider must never be allowed to omit the
    // list. Asserted as it behaves, not as it reads.
    expect(() =>
      validateOAuthEndpointUrl("https://[::ffff:10.0.0.1]/token", "endpoint", {
        allowedHosts: gleanAllowedHosts,
      }),
    ).toThrow("endpoint host is not allowed.");
  });
});

describe("an OAuth provider that discovers its endpoints must declare allowed hosts", () => {
  // `oauthAllowedHosts` is optional on upstream's `OAuthProviderConfig`, and
  // upstream's matcher skips the host check entirely when the list is absent or
  // empty. So a provider added later that discovers its endpoints from metadata
  // and forgets the list gets no host check, no warning, and a green suite —
  // which is exactly the hole this ticket closed for Glean, reintroduced by
  // omission. `resolveOAuthMcpResourceUrl` is the fork-owned seam every such
  // provider passes through before any discovery happens, so the requirement is
  // enforced there and fails closed rather than silently opening up.

  const withoutAllowedHosts = (
    provider: OAuthProviderConfig,
  ): OAuthProviderConfig => {
    const stripped = { ...provider };
    delete stripped.oauthAllowedHosts;
    return stripped;
  };

  test("refuses to resolve for a provider that declares no allowed hosts", async () => {
    // Fails before resolution, so this never reaches Glean's resolver (which
    // reads the OpenWiki home). A missing declaration is a defect in the
    // provider table, not a user misconfiguration, so it must be reported
    // deterministically rather than behind whatever the environment does first:
    // move the guard after resolution and this test fails on the home guard's
    // ENOTDIR instead of the assertion.
    await expect(
      resolveOAuthMcpResourceUrl(withoutAllowedHosts(AUTH_PROVIDERS.glean)),
    ).rejects.toThrow(
      "Glean discovers OAuth endpoints from metadata, so it must declare oauthAllowedHosts.",
    );
  });

  test("treats an empty allowed-host list as no declaration at all", async () => {
    // Deliberate: upstream's check is gated on `allowedHosts.length > 0`, so an
    // empty array admits every host just as absence does. Reading it as "no
    // restriction wanted" would make the guard trivially bypassable by the same
    // omission it exists to catch.
    await expect(
      resolveOAuthMcpResourceUrl({
        ...AUTH_PROVIDERS.notion,
        oauthAllowedHosts: [],
      }),
    ).rejects.toThrow(
      "Notion MCP discovers OAuth endpoints from metadata, so it must declare oauthAllowedHosts.",
    );
  });

  test("does not require a list from a provider that discovers nothing", async () => {
    // Gmail, Slack and X authenticate against hardcoded endpoints and never
    // reach discovery, so there is no metadata to be redirected by and nothing
    // for a host list to constrain.
    await expect(
      resolveOAuthMcpResourceUrl(withoutAllowedHosts(AUTH_PROVIDERS.gmail)),
    ).resolves.toBeUndefined();
  });

  test.each(Object.values(AUTH_PROVIDERS).map((provider) => [provider.id]))(
    "%s declares an allowed-host list if it discovers endpoints",
    (providerId) => {
      // The class, not the instance: this fails the moment a provider that
      // discovers endpoints from metadata is added without a list, whether or
      // not anyone writes a test for that provider's auth flow.
      const provider = AUTH_PROVIDERS[providerId];
      const discoversEndpoints = Boolean(
        provider.mcpResourceUrl ?? provider.resolveMcpResourceUrl,
      );

      expect(
        discoversEndpoints
          ? (provider.oauthAllowedHosts?.length ?? 0) > 0
          : true,
        `${providerId} discovers OAuth endpoints from metadata but declares no oauthAllowedHosts`,
      ).toBe(true);
    },
  );
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
