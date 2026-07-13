import { rm } from "node:fs/promises";
import path from "node:path";
import { getConnectorRawDir } from "../openwiki-home.js";
import {
  readConnectorConfig,
  readConnectorState,
  writeConnectorState,
} from "./io.js";
import { CONNECTOR_IDS } from "./registry.js";
import type { ConnectorId, ConnectorRetentionConfig } from "./types.js";

const MILLISECONDS_PER_DAY = 86_400_000;
const RUN_ID_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/u;

export const RAW_RETENTION_DEFAULT_DAYS: Partial<Record<ConnectorId, number>> =
  {
    glean: 14,
  };

export type ConnectorRetentionSweepResult = {
  connectorId: ConnectorId;
  deletedRunIds: string[];
  retentionDays: number | undefined;
};

export function resolveRawRetentionDays(
  connectorId: ConnectorId,
  config: ConnectorRetentionConfig | undefined,
): number | undefined {
  return isValidRetentionDays(config?.rawRetentionDays)
    ? config.rawRetentionDays
    : RAW_RETENTION_DEFAULT_DAYS[connectorId];
}

export async function sweepConnectorRawRetention(
  connectorId: ConnectorId,
  options: { now: Date },
): Promise<ConnectorRetentionSweepResult> {
  const config = await readConnectorConfig<ConnectorRetentionConfig>(
    connectorId,
    {},
  );
  const retentionDays = resolveRawRetentionDays(connectorId, config);

  if (retentionDays === undefined) {
    return { connectorId, deletedRunIds: [], retentionDays };
  }

  const state = await readConnectorState(connectorId);
  const deletedRunIds: string[] = [];
  const rawDeletedAt = options.now.toISOString();

  for (const run of state.runs ?? []) {
    if (run.synthesizedAt === undefined) {
      continue;
    }

    if (run.rawDeletedAt !== undefined) {
      continue;
    }

    const ageMilliseconds =
      options.now.getTime() - Date.parse(run.synthesizedAt);

    if (!(ageMilliseconds > retentionDays * MILLISECONDS_PER_DAY)) {
      continue;
    }

    assertSafeRunId(run.runId);
    await rm(path.join(getConnectorRawDir(connectorId), run.runId), {
      force: true,
      recursive: true,
    });
    run.rawDeletedAt = rawDeletedAt;
    run.rawFiles = [];
    deletedRunIds.push(run.runId);
  }

  if (deletedRunIds.length > 0) {
    await writeConnectorState(connectorId, state);
  }

  return { connectorId, deletedRunIds, retentionDays };
}

export async function sweepAllConnectorRawRetention(options: {
  connectorIds?: readonly ConnectorId[];
  now: Date;
}): Promise<ConnectorRetentionSweepResult[]> {
  const results: ConnectorRetentionSweepResult[] = [];

  for (const connectorId of options.connectorIds ?? CONNECTOR_IDS) {
    try {
      results.push(
        await sweepConnectorRawRetention(connectorId, {
          now: options.now,
        }),
      );
    } catch {
      results.push({
        connectorId,
        deletedRunIds: [],
        retentionDays: undefined,
      });
    }
  }

  return results;
}

function assertSafeRunId(runId: string): void {
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new Error(`Invalid connector run ID: ${runId}`);
  }
}

function isValidRetentionDays(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}
