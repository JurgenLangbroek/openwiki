import { createConnectorRegistry } from "./connectors/registry.js";
import type { PosturedConnectorRuntime } from "./connectors/types.js";
import type { OpenWikiOnboardingConfig } from "./onboarding.js";

export function isExplorableConnector(
  connector: Pick<PosturedConnectorRuntime, "posture">,
): boolean {
  return connector.posture === "agentic" || connector.posture === "hybrid";
}

export function configHasExplorableSource(
  config: OpenWikiOnboardingConfig,
): boolean {
  const registry = createConnectorRegistry();
  return config.sourceInstances.some(
    (sourceConfig) =>
      Boolean(sourceConfig.connectedAt) &&
      isExplorableConnector(registry[sourceConfig.connectorId]),
  );
}
