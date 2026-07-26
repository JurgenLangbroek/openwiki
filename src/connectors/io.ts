import { chmod, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  ensureConnectorHome,
  getConnectorConfigPath,
  getConnectorRawDir,
  getConnectorStatePath,
} from "../openwiki-home.js";
import { DEFAULT_SLICE_WALK_MAX_SLICES } from "./slice-walker.js";
import type { ConnectorId, ConnectorState } from "./types.js";

/**
 * How many run summaries a connector's state keeps, newest first.
 *
 * Derived from the Backfill, which is the only thing that produces run
 * summaries in bulk: each Backfill invocation appends exactly one summary, and
 * a walk that is interrupted and resumed — a 429 pacing trip, an expired token,
 * a killed process — needs one invocation per remaining slice in the worst
 * case. The Slice Walker refuses to walk past `DEFAULT_SLICE_WALK_MAX_SLICES`
 * slices in a single walk, so that ceiling is also the largest number of run
 * summaries one complete Backfill can cost. Retaining exactly that many
 * guarantees a Backfill never evicts the record of its own earlier slices, and
 * keeps every run reachable for the raw-retention sweep, which can only delete
 * (and un-orphan) raw directories belonging to runs still listed in state.
 *
 * A connector that raises `backfill.maxSlices` past the default ceiling walks
 * further than this window provably covers; the Run Ledger stays the durable
 * human-readable record in that case.
 */
export const RETAINED_CONNECTOR_RUNS = DEFAULT_SLICE_WALK_MAX_SLICES;

export async function readConnectorConfig<T extends object>(
  connectorId: ConnectorId,
  defaultConfig: T,
): Promise<T> {
  await ensureConnectorHome(connectorId);

  try {
    return {
      ...defaultConfig,
      ...(JSON.parse(
        await readFile(getConnectorConfigPath(connectorId), "utf8"),
      ) as T),
    };
  } catch (error) {
    if (isFileNotFoundError(error)) {
      return defaultConfig;
    }

    throw error;
  }
}

export async function readConnectorState(
  connectorId: ConnectorId,
): Promise<ConnectorState> {
  await ensureConnectorHome(connectorId);

  try {
    return JSON.parse(
      await readFile(getConnectorStatePath(connectorId), "utf8"),
    ) as ConnectorState;
  } catch (error) {
    if (isFileNotFoundError(error)) {
      return { version: 1 };
    }

    throw error;
  }
}

export async function markRunSynthesized(
  connectorId: ConnectorId,
  runId: string,
  synthesizedAt: string,
): Promise<void> {
  const state = await readConnectorState(connectorId);
  const runIndex = state.runs?.findIndex((run) => run.runId === runId) ?? -1;
  const run = state.runs?.[runIndex];

  if (runIndex < 0 || run === undefined || run.synthesizedAt !== undefined) {
    return;
  }

  await writeConnectorState(connectorId, {
    ...state,
    runs: state.runs?.map((existingRun, index) =>
      index === runIndex ? { ...existingRun, synthesizedAt } : existingRun,
    ),
  });
}

export async function markUnsynthesizedRunsSynthesized(
  connectorId: ConnectorId,
  synthesizedAt: string,
): Promise<void> {
  const state = await readConnectorState(connectorId);
  const hasUnsynthesizedRuns = state.runs?.some(
    (run) => run.synthesizedAt === undefined && run.rawDeletedAt === undefined,
  );

  if (!hasUnsynthesizedRuns) {
    return;
  }

  await writeConnectorState(connectorId, {
    ...state,
    runs: state.runs?.map((run) =>
      run.synthesizedAt === undefined && run.rawDeletedAt === undefined
        ? { ...run, synthesizedAt }
        : run,
    ),
  });
}

export async function writeConnectorState(
  connectorId: ConnectorId,
  state: ConnectorState,
): Promise<void> {
  await ensureConnectorHome(connectorId);
  await writePrivateJson(getConnectorStatePath(connectorId), state);
}

export async function writeRawJson(
  connectorId: ConnectorId,
  runId: string,
  filename: string,
  value: unknown,
): Promise<string> {
  await ensureConnectorHome(connectorId);
  const filePath = path.join(getConnectorRawDir(connectorId), runId, filename);
  await writePrivateJson(filePath, value);

  return filePath;
}

export function createRunId(): string {
  return new Date().toISOString().replace(/[:.]/gu, "-");
}

export function updateStateWithRun(
  state: ConnectorState,
  run: NonNullable<ConnectorState["runs"]>[number],
): ConnectorState {
  return {
    ...state,
    lastRunAt: run.at,
    runs: [run, ...(state.runs ?? [])].slice(0, RETAINED_CONNECTOR_RUNS),
    version: 1,
  };
}

async function writePrivateJson(
  filePath: string,
  value: unknown,
): Promise<void> {
  await import("node:fs/promises").then(({ mkdir }) =>
    mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 }),
  );
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await chmod(filePath, 0o600);
}

function isFileNotFoundError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
