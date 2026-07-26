import { chmod, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  ensureConnectorHome,
  getConnectorConfigPath,
  getConnectorRawDir,
  getConnectorStatePath,
} from "../openwiki-home.js";
import type { ConnectorId, ConnectorState } from "./types.js";

/**
 * How many run summaries a connector's state keeps, newest first.
 *
 * Sized from the Backfill, the only thing that appends run summaries in bulk.
 * A Backfill invocation appends exactly one summary, and a walk that stops
 * early continues in a later invocation, so a Backfill costs one summary per
 * invocation it takes to finish its walk. The Slice Walker refuses to advance
 * past `SLICE_WALK_SANITY_CEILING` slices, which caps the slices a walk can
 * cover; an interrupted walk whose every invocation advances at least one
 * slice therefore fits in a window of that size. This number matches that
 * ceiling — it is that measurement, not a round guess.
 *
 * That makes the window headroom, **not** a proof, and no finite window closes
 * the two holes:
 *
 * - **Zero-progress invocations.** Glean's Backfill appends a summary and
 *   returns *without* advancing the walk when a stream fetch rejects (a 429
 *   past the rate gate's attempts, an expired token), and the
 *   Content-Expansion total-failure tripwire deliberately rewinds the walk to
 *   before the failing streak. A persistently failing backend can burn
 *   summaries without walking slices, and the sanity ceiling does not fire
 *   because it counts slices, not invocations.
 * - **A shared window.** This is the single append point for *every* connector
 *   run: tool probes, ordinary window Pulls, and Backfill invocations, across
 *   all connectors. A Backfill spread over days competes for the window with
 *   the scheduled Pulls running beside it.
 *
 * A hard guarantee would need a rule specific to Backfill runs — never
 * evicting a run whose raw data is still unswept, say — which is a larger
 * change than a window size. Deliberately not done here.
 *
 * Two consequences of widening the window, both intended:
 *
 * - Raw retention improves. `sweepConnectorRawRetention` only sees runs still
 *   listed here, so an evicted run's `raw/<run-id>/` directory can never be
 *   swept; fewer evictions means fewer orphaned directories.
 * - Backfill synthesis recovers more. `runBackfillSynthesis` re-reads every
 *   prior unsynthesized run's `rawFiles`; eviction previously capped that
 *   recovery set near 20 and now caps it near this window. Recovering stalled
 *   runs is the point, but the set deserves a bound of its own rather than one
 *   inherited from run eviction.
 *
 * Keep this at or above `SLICE_WALK_SANITY_CEILING`; `test/retention.test.ts`
 * pins that relationship.
 */
export const RETAINED_CONNECTOR_RUNS = 400;

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
