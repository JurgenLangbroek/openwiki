import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { getOpenWikiLocalWikiDir } from "./openwiki-home.js";
import {
  createNoWatermarkEvent,
  type RunLedger,
  type RunLedgerEscalationEvent,
  type RunLedgerMode,
  upsertRunLedgerSection,
} from "./connectors/run-ledger.js";
import type { ConnectorId, ConnectorIngestResult } from "./connectors/types.js";

export type BuildRunLedgerFromResultInput = {
  connectorId: ConnectorId;
  errorMessage?: string;
  escalationEvents?: RunLedgerEscalationEvent[];
  fallbackMessage: string;
  fallbackRunId: string;
  mode: RunLedgerMode;
  result?: ConnectorIngestResult;
  startedAt: string;
  status?: RunLedger["status"];
};

type RunLedgerBestEffortInput = BuildRunLedgerFromResultInput & {
  displayName: string;
  onError: (message: string) => void;
};

export type RunLedgerEscalationRecorder = {
  events: RunLedgerEscalationEvent[];
  flush: (input: RunLedgerBestEffortInput) => Promise<void>;
  record: (event: RunLedgerEscalationEvent) => void;
};

export function createRunLedgerEscalationRecorder(): RunLedgerEscalationRecorder {
  const events: RunLedgerEscalationEvent[] = [];

  return {
    events,
    flush: async (input) => {
      if (events.length === 0) {
        return;
      }

      await writeRunLedgerBestEffort({
        ...input,
        escalationEvents: events,
      });
    },
    record: (event) => events.push(event),
  };
}

export function buildRunLedgerFromResult({
  connectorId,
  errorMessage,
  escalationEvents,
  fallbackMessage,
  fallbackRunId,
  mode,
  result,
  startedAt,
  status,
}: BuildRunLedgerFromResultInput): RunLedger {
  return {
    connectorId,
    events: [
      ...(result?.ledgerEvents ?? [
        createNoWatermarkEvent(startedAt),
        ...(result?.warnings ?? []).map((message) => ({
          message,
          type: "warning" as const,
        })),
      ]),
      ...(escalationEvents ?? []),
    ],
    message: errorMessage ?? result?.message ?? fallbackMessage,
    mode,
    runId: result?.runId ?? fallbackRunId,
    startedAt,
    status: status ?? result?.status ?? (errorMessage ? "error" : "success"),
  };
}

export async function writeRunLedgerBestEffort({
  displayName,
  onError,
  ...input
}: RunLedgerBestEffortInput): Promise<void> {
  try {
    await writeRunLedger(buildRunLedgerFromResult(input));
  } catch (error) {
    onError(
      `${displayName} Run Ledger write failed: ${getErrorMessage(error)}`,
    );
  }
}

export function getRunLedgerPath(connectorId: string): string {
  return path.join(
    getOpenWikiLocalWikiDir(),
    "sources",
    `${connectorId}-run-ledger.md`,
  );
}

export async function writeRunLedger(ledger: RunLedger): Promise<string> {
  const filePath = getRunLedgerPath(ledger.connectorId);
  let existingPage: string | null;

  try {
    existingPage = await readFile(filePath, "utf8");
  } catch (error) {
    if (!isFileNotFoundError(error)) {
      throw error;
    }
    existingPage = null;
  }

  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, upsertRunLedgerSection(existingPage, ledger), {
    encoding: "utf8",
  });

  return filePath;
}

function isFileNotFoundError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
