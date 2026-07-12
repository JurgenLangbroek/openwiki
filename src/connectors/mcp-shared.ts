import type { McpConnectorConfig } from "./types.js";

export function sanitizeMcpTransport(
  transport: McpConnectorConfig["transport"],
): McpConnectorConfig["transport"] | null {
  if (!transport) {
    return null;
  }

  return {
    args: transport.args,
    command: transport.command,
    env: transport.env,
    headers: transport.headers
      ? Object.fromEntries(
          Object.entries(transport.headers).map(([key, value]) => [
            key,
            value.replace(/\$\{?[A-Z_][A-Z0-9_]*\}?/gu, "<env-ref>"),
          ]),
        )
      : undefined,
    type: transport.type,
    url: transport.url,
  };
}
