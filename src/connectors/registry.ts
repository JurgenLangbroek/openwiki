import { stampConnectorPostures } from "./posture.js";
import { createGitRepoConnector } from "./sources/git-repo.js";
import { createGleanConnector } from "./sources/glean.js";
import { createGmailConnector } from "./sources/gmail.js";
import { createHackerNewsConnector } from "./sources/hackernews.js";
import { createLangSmithConnector } from "./sources/langsmith/index.js";
import { createMcpConnector } from "./sources/mcp.js";
import { createSlackConnector } from "./sources/slack.js";
import { createWebSearchConnector } from "./sources/web-search.js";
import { createXConnector } from "./sources/x.js";
import type { ConnectorId, PosturedConnectorRuntime } from "./types.js";

export const CONNECTOR_IDS = [
  "git-repo",
  "glean",
  "notion",
  "x",
  "google",
  "web-search",
  "hackernews",
  "langsmith",
  "slack",
] as const satisfies readonly ConnectorId[];

export type ConnectorRegistry = Record<ConnectorId, PosturedConnectorRuntime>;

export function createConnectorRegistry(): ConnectorRegistry {
  return stampConnectorPostures({
    "git-repo": createGitRepoConnector(),
    glean: createGleanConnector(),
    google: createGmailConnector(),
    hackernews: createHackerNewsConnector(),
    langsmith: createLangSmithConnector(),
    notion: createMcpConnector({
      description:
        "Notion connector backed by the hosted Notion MCP server or another configured read-only MCP server.",
      displayName: "Notion",
      id: "notion",
      requiredEnv: ["OPENWIKI_NOTION_MCP_ACCESS_TOKEN"],
    }),
    slack: createSlackConnector(),
    "web-search": createWebSearchConnector(),
    x: createXConnector(),
  });
}

export function isConnectorId(value: string): value is ConnectorId {
  return (CONNECTOR_IDS as readonly string[]).includes(value);
}

/**
 * Connector ids that require auth and have all required env vars set. Used by
 * telemetry as an adoption signal.
 */
export function getConfiguredConnectorIds(): ConnectorId[] {
  const registry = createConnectorRegistry();

  return Object.values(registry)
    .filter(
      (connector) =>
        connector.requiredEnv.length > 0 &&
        connector.requiredEnv.every((key) => Boolean(process.env[key])),
    )
    .map((connector) => connector.id);
}
