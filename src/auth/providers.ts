import {
  OPENWIKI_GMAIL_ACCESS_TOKEN_ENV_KEY,
  OPENWIKI_GMAIL_REFRESH_TOKEN_ENV_KEY,
  OPENWIKI_GLEAN_ACCESS_TOKEN_ENV_KEY,
  OPENWIKI_GLEAN_CLIENT_ID_ENV_KEY,
  OPENWIKI_GLEAN_REFRESH_TOKEN_ENV_KEY,
  OPENWIKI_GLEAN_TOKEN_EXPIRES_AT_ENV_KEY,
  OPENWIKI_GLEAN_TOKEN_TYPE_ENV_KEY,
  OPENWIKI_NOTION_MCP_ACCESS_TOKEN_ENV_KEY,
  OPENWIKI_NOTION_MCP_CLIENT_ID_ENV_KEY,
  OPENWIKI_NOTION_MCP_REFRESH_TOKEN_ENV_KEY,
  OPENWIKI_GOOGLE_CLIENT_ID_ENV_KEY,
  OPENWIKI_GOOGLE_CLIENT_SECRET_ENV_KEY,
  OPENWIKI_SLACK_CLIENT_ID_ENV_KEY,
  OPENWIKI_SLACK_CLIENT_SECRET_ENV_KEY,
  OPENWIKI_SLACK_USER_TOKEN_ENV_KEY,
  OPENWIKI_X_ACCESS_TOKEN_ENV_KEY,
  OPENWIKI_X_CLIENT_ID_ENV_KEY,
  OPENWIKI_X_CLIENT_SECRET_ENV_KEY,
  OPENWIKI_X_REFRESH_TOKEN_ENV_KEY,
} from "../constants.js";
import { resolveGleanTarget } from "../connectors/sources/glean-backend.js";
import type { AuthProviderId, OAuthProviderConfig } from "./types.js";

export const AUTH_PROVIDERS: Record<AuthProviderId, OAuthProviderConfig> = {
  glean: {
    clientAuth: "none",
    displayName: "Glean",
    id: "glean",
    resolveMcpResourceUrl: async () => (await resolveGleanTarget()).mcpUrl,
    scopes: ["chat", "documents", "feed", "mcp", "people", "search"],
    tokenMapping: {
      accessTokenEnvKey: OPENWIKI_GLEAN_ACCESS_TOKEN_ENV_KEY,
      clientIdEnvKey: OPENWIKI_GLEAN_CLIENT_ID_ENV_KEY,
      expiresAtEnvKey: OPENWIKI_GLEAN_TOKEN_EXPIRES_AT_ENV_KEY,
      refreshTokenEnvKey: OPENWIKI_GLEAN_REFRESH_TOKEN_ENV_KEY,
      tokenTypeEnvKey: OPENWIKI_GLEAN_TOKEN_TYPE_ENV_KEY,
    },
  },
  gmail: {
    authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    clientAuth: "client_secret_post",
    clientIdEnvKey: OPENWIKI_GOOGLE_CLIENT_ID_ENV_KEY,
    clientSecretEnvKey: OPENWIKI_GOOGLE_CLIENT_SECRET_ENV_KEY,
    displayName: "Gmail",
    extraAuthParams: {
      access_type: "offline",
      prompt: "consent",
    },
    id: "gmail",
    scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
    tokenMapping: {
      accessTokenEnvKey: OPENWIKI_GMAIL_ACCESS_TOKEN_ENV_KEY,
      expiresAtEnvKey: "OPENWIKI_GMAIL_TOKEN_EXPIRES_AT",
      refreshTokenEnvKey: OPENWIKI_GMAIL_REFRESH_TOKEN_ENV_KEY,
      tokenTypeEnvKey: "OPENWIKI_GMAIL_TOKEN_TYPE",
    },
    tokenUrl: "https://oauth2.googleapis.com/token",
  },
  notion: {
    clientAuth: "none",
    displayName: "Notion MCP",
    id: "notion",
    mcpResourceUrl: "https://mcp.notion.com/mcp",
    oauthAllowedHosts: ["notion.com"],
    scopes: [],
    tokenMapping: {
      accessTokenEnvKey: OPENWIKI_NOTION_MCP_ACCESS_TOKEN_ENV_KEY,
      clientIdEnvKey: OPENWIKI_NOTION_MCP_CLIENT_ID_ENV_KEY,
      expiresAtEnvKey: "OPENWIKI_NOTION_MCP_TOKEN_EXPIRES_AT",
      refreshTokenEnvKey: OPENWIKI_NOTION_MCP_REFRESH_TOKEN_ENV_KEY,
      tokenTypeEnvKey: "OPENWIKI_NOTION_MCP_TOKEN_TYPE",
    },
  },
  slack: {
    authUrl: "https://slack.com/oauth/v2/authorize",
    clientAuth: "client_secret_post",
    clientIdEnvKey: OPENWIKI_SLACK_CLIENT_ID_ENV_KEY,
    clientSecretEnvKey: OPENWIKI_SLACK_CLIENT_SECRET_ENV_KEY,
    displayName: "Slack",
    extraAuthParams: {
      scope: "",
      user_scope:
        "channels:read,channels:history,groups:read,groups:history,im:read,im:history,mpim:read,mpim:history,users:read,search:read,search:read.files,search:read.im,search:read.mpim,search:read.private,search:read.public,search:read.users",
    },
    id: "slack",
    scopes: [],
    tokenMapping: {
      accessTokenEnvKey: OPENWIKI_SLACK_USER_TOKEN_ENV_KEY,
      expiresAtEnvKey: "OPENWIKI_SLACK_USER_TOKEN_EXPIRES_AT",
      refreshTokenEnvKey: "OPENWIKI_SLACK_USER_REFRESH_TOKEN",
      tokenTypeEnvKey: "OPENWIKI_SLACK_USER_TOKEN_TYPE",
    },
    tokenUrl: "https://slack.com/api/oauth.v2.access",
  },
  x: {
    authUrl: "https://x.com/i/oauth2/authorize",
    clientAuth: "none",
    clientIdEnvKey: OPENWIKI_X_CLIENT_ID_ENV_KEY,
    clientSecretEnvKey: OPENWIKI_X_CLIENT_SECRET_ENV_KEY,
    displayName: "X / Twitter",
    id: "x",
    scopes: [
      "tweet.read",
      "users.read",
      "offline.access",
      "bookmark.read",
      "list.read",
    ],
    tokenMapping: {
      accessTokenEnvKey: OPENWIKI_X_ACCESS_TOKEN_ENV_KEY,
      expiresAtEnvKey: "OPENWIKI_X_TOKEN_EXPIRES_AT",
      refreshTokenEnvKey: OPENWIKI_X_REFRESH_TOKEN_ENV_KEY,
      tokenTypeEnvKey: "OPENWIKI_X_TOKEN_TYPE",
    },
    tokenUrl: "https://api.x.com/2/oauth2/token",
  },
};

export function getAuthProvider(
  providerId: AuthProviderId,
): OAuthProviderConfig {
  return AUTH_PROVIDERS[providerId];
}

/**
 * The MCP OAuth resource URL for a provider, or `undefined` when the provider
 * has no MCP resource at all (Gmail, Slack and X authenticate against static
 * endpoints — absence is not an error).
 *
 * Most providers declare `mcpResourceUrl` statically. Glean cannot: its
 * backend is derived at runtime from a work email or instance name, so it
 * supplies `resolveMcpResourceUrl` instead. Callers must resolve through here
 * *before* handing the URL to `oauth-discovery.js`, so the dynamic value is
 * what gets validated.
 *
 * This is also where upstream's `if (!provider.mcpResourceUrl) throw` guard
 * lives on this fork. Upstream places it inside `registerMcpOAuthClient` and
 * `discoverMcpTokenEndpoint`, where it can only read the static field — for
 * Glean that field is legitimately absent, so the guard there would reject a
 * working provider. Asserting non-empty at this seam keeps the guarantee
 * ("anything that reaches discovery has a real resource URL") while letting the
 * dynamic resolution through, and reports a resource-URL-specific failure
 * instead of falling through to "<provider> OAuth provider is incomplete."
 */
export async function resolveOAuthMcpResourceUrl(
  provider: OAuthProviderConfig,
): Promise<string | undefined> {
  if (!provider.resolveMcpResourceUrl) {
    return provider.mcpResourceUrl;
  }

  const resolved = await provider.resolveMcpResourceUrl();

  if (!resolved.trim()) {
    throw new Error(
      `${provider.displayName} did not resolve an MCP OAuth resource URL.`,
    );
  }

  return resolved;
}

export function isAuthProviderId(value: string): value is AuthProviderId {
  return value in AUTH_PROVIDERS;
}
