import { createConnectorRegistry } from "./connectors/registry.js";
import type { ConnectorRuntime } from "./connectors/types.js";
import type { OpenWikiOnboardingConfig } from "./onboarding.js";

export function isExplorableConnector(
  connector: Pick<ConnectorRuntime, "posture">,
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
