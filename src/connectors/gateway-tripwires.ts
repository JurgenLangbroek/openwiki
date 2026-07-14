import type { DownstreamToolRef } from "./downstream-policy.js";

export const DEFAULT_GATEWAY_READ_SANITY_CEILING = 1_000;

export type GatewayReadRef = DownstreamToolRef & {
  args: Record<string, unknown>;
};

export type GatewayTripwireRule = "repeat-read" | "sanity-ceiling";

export type GatewayTripwireState = {
  readonly sanityCeiling: number;
  readonly seenReadKeys: Set<string>;
  ceilingError: GatewaySanityCeilingError | null;
};

export class GatewayRepeatReadError extends Error {
  readonly rule = "repeat-read" as const;

  constructor() {
    super(
      "A repeat Gateway Datasource Read of the same document within one run is by definition not new information and is refused.",
    );
    this.name = "GatewayRepeatReadError";
  }
}

export class GatewaySanityCeilingError extends Error {
  readonly rule = "sanity-ceiling" as const;

  constructor(ceiling: number) {
    super(
      `Gateway Datasource Read sanity ceiling of ${ceiling} distinct reads exceeded; the run is failing loudly instead of trimming silently.`,
    );
    this.name = "GatewaySanityCeilingError";
  }
}

export function createGatewayTripwireState(
  options: { sanityCeiling?: number } = {},
): GatewayTripwireState {
  return {
    ceilingError: null,
    sanityCeiling: options.sanityCeiling ?? DEFAULT_GATEWAY_READ_SANITY_CEILING,
    seenReadKeys: new Set<string>(),
  };
}

export function registerGatewayRead(
  state: GatewayTripwireState,
  ref: GatewayReadRef,
): void {
  if (state.ceilingError !== null) {
    throw state.ceilingError;
  }

  const key = JSON.stringify([ref.serverId, ref.toolName, sortValue(ref.args)]);
  if (state.seenReadKeys.has(key)) {
    throw new GatewayRepeatReadError();
  }

  if (state.seenReadKeys.size + 1 > state.sanityCeiling) {
    state.ceilingError = new GatewaySanityCeilingError(state.sanityCeiling);
    throw state.ceilingError;
  }

  state.seenReadKeys.add(key);
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }

  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, entry]) => [key, sortValue(entry)]),
    );
  }

  return value;
}
