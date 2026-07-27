import type {
  ConnectorId,
  ConnectorPosture,
  ConnectorRuntime,
  PosturedConnectorRuntime,
} from "./types.js";

/**
 * The fork-owned Connector Posture table (ADR-0004).
 *
 * Posture is a fork concept that upstream's `ConnectorDefinition` has no field
 * for. Declaring it here, keyed by upstream's `ConnectorId`, keeps it out of
 * the connector definitions themselves, so an upstream edit to a connector
 * definition never touches fork-owned data.
 *
 * `satisfies Record<ConnectorId, ConnectorPosture>` makes the table exhaustive
 * at the type level: a new connector id fails to compile until its posture is
 * declared here. There is deliberately no runtime default — a silent fallback
 * would let a new connector pick up a posture nobody chose.
 *
 * Exported for this module's own test. Consumers read posture off the runtime
 * the registry stamps, never by looking an id up in here — that indirection is
 * what keeps fixtures free to pair any id with any posture.
 */
export const CONNECTOR_POSTURES = {
  "git-repo": "agentic",
  glean: "hybrid",
  google: "deterministic",
  hackernews: "deterministic",
  langsmith: "deterministic",
  notion: "agentic",
  slack: "deterministic",
  "web-search": "deterministic",
  x: "deterministic",
} as const satisfies Record<ConnectorId, ConnectorPosture>;

/**
 * Resolves the posture table once at the registry boundary and stamps each
 * runtime with its posture, so consumers (and test fakes) keep treating posture
 * as a value on the runtime rather than performing a lookup.
 */
export function stampConnectorPostures(
  runtimes: Record<ConnectorId, ConnectorRuntime>,
): Record<ConnectorId, PosturedConnectorRuntime> {
  const entries = Object.entries(runtimes) as [ConnectorId, ConnectorRuntime][];

  return Object.fromEntries(
    entries.map(([id, runtime]) => [id, stampConnectorPosture(runtime)]),
  ) as Record<ConnectorId, PosturedConnectorRuntime>;
}

function stampConnectorPosture(
  runtime: ConnectorRuntime,
): PosturedConnectorRuntime {
  return { ...runtime, posture: CONNECTOR_POSTURES[runtime.id] };
}
