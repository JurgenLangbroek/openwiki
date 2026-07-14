import type { OpenWikiRunEvent } from "./agent/types.js";
import { createRunId } from "./connectors/io.js";
import { createConnectorRegistry } from "./connectors/registry.js";
import type {
  ConnectorId,
  ConnectorIngestResult,
  ConnectorRuntime,
} from "./connectors/types.js";
import { loadOpenWikiEnv } from "./env.js";
import {
  resolveIngestionSourceInstances,
  type IngestionTarget,
} from "./ingestion.js";
import {
  readOpenWikiOnboardingConfig,
  type OnboardingSourceInstanceConfig,
} from "./onboarding.js";
import { ensureOpenWikiHome } from "./openwiki-home.js";
import { writeRunLedgerBestEffort } from "./run-ledger-io.js";

export type SourceBackfillResult = {
  backfillPull: ConnectorIngestResult;
  connectorId: ConnectorId;
  displayName: string;
  rawFiles: string[];
  sourceInstanceId: string;
  status: ConnectorIngestResult["status"];
};

export type OpenWikiBackfillResult = {
  results: SourceBackfillResult[];
};

export type OpenWikiBackfillOptions = {
  onEvent?: (event: OpenWikiRunEvent) => void;
  target: IngestionTarget;
};

export async function runOpenWikiBackfill(
  _cwd = process.cwd(),
  options: OpenWikiBackfillOptions,
): Promise<OpenWikiBackfillResult> {
  void _cwd;
  await loadOpenWikiEnv();
  await ensureOpenWikiHome();
  const config = await readOpenWikiOnboardingConfig();
  const registry = createConnectorRegistry();
  const sourceInstances = resolveIngestionSourceInstances(
    options.target,
    config,
    { scheduledOnly: false },
  );

  if (options.target !== "all" && sourceInstances.length === 0) {
    throw new Error(
      `No configured ingestion source matched ${formatTarget(options.target)}.`,
    );
  }

  const results: SourceBackfillResult[] = [];
  for (const sourceConfig of sourceInstances) {
    const connector = registry[sourceConfig.connectorId];
    results.push(
      await runSourceBackfill({
        connector,
        emit: options.onEvent,
        sourceConfig,
      }),
    );
  }

  return { results };
}

async function runSourceBackfill({
  connector,
  emit,
  sourceConfig,
}: {
  connector: ConnectorRuntime;
  emit?: (event: OpenWikiRunEvent) => void;
  sourceConfig: OnboardingSourceInstanceConfig;
}): Promise<SourceBackfillResult> {
  const displayName = sourceConfig.name ?? connector.displayName;
  emitText(emit, `\nStarting ${displayName} Backfill.\n`);

  const fallbackRunId = createRunId();
  const startedAt = new Date().toISOString();
  let backfillPull: ConnectorIngestResult;
  try {
    backfillPull = connector.backfill
      ? await connector.backfill({
          connectorConfig: sourceConfig.connectorConfig,
          instanceId: sourceConfig.id,
        })
      : createUnsupportedResult(connector, displayName);
  } catch (error) {
    backfillPull = {
      connectorId: connector.id,
      message: `${displayName} Backfill failed: ${getErrorMessage(error)}`,
      rawFiles: [],
      runId: fallbackRunId,
      statePath: `~/.openwiki/connectors/${connector.id}/state.json`,
      status: "error",
      warnings: [],
    };
  }

  await writeRunLedgerBestEffort({
    connectorId: connector.id,
    displayName,
    fallbackMessage: `${displayName} Backfill produced no result.`,
    fallbackRunId,
    mode: "backfill",
    onError: (message) => emitText(emit, `${message}\n`),
    result: backfillPull,
    startedAt,
  });

  emitText(
    emit,
    `${backfillPull.message} Raw files: ${
      backfillPull.rawFiles.length > 0
        ? backfillPull.rawFiles.join(", ")
        : "none"
    }\n`,
  );
  return {
    backfillPull,
    connectorId: connector.id,
    displayName,
    rawFiles: backfillPull.rawFiles,
    sourceInstanceId: sourceConfig.id,
    status: backfillPull.status,
  };
}

function createUnsupportedResult(
  connector: ConnectorRuntime,
  displayName: string,
): ConnectorIngestResult {
  return {
    connectorId: connector.id,
    message: `${displayName} does not support backfill.`,
    rawFiles: [],
    runId: createRunId(),
    statePath: `~/.openwiki/connectors/${connector.id}/state.json`,
    status: "skipped",
    warnings: [],
  };
}

function emitText(
  emit: ((event: OpenWikiRunEvent) => void) | undefined,
  text: string,
): void {
  emit?.({
    source: "main",
    text,
    type: "text",
  });
}

function formatTarget(target: IngestionTarget): string {
  return typeof target === "object" ? target.id : target;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
