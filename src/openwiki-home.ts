import { chmod, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export function getOpenWikiHomeDir(): string {
  const override = process.env.OPENWIKI_HOME?.trim();
  return override
    ? path.resolve(override)
    : path.join(os.homedir(), ".openwiki");
}

export function getOpenWikiConnectorsDir(): string {
  return path.join(getOpenWikiHomeDir(), "connectors");
}

export function getOpenWikiLocalWikiDir(): string {
  return path.join(getOpenWikiHomeDir(), "wiki");
}

export function getOpenWikiSkillsDir(): string {
  return path.join(getOpenWikiHomeDir(), "skills");
}

export function getConnectorDir(connectorId: string): string {
  return path.join(getOpenWikiConnectorsDir(), connectorId);
}

export function getConnectorConfigPath(connectorId: string): string {
  return path.join(getConnectorDir(connectorId), "config.json");
}

export function getConnectorStatePath(connectorId: string): string {
  return path.join(getConnectorDir(connectorId), "state.json");
}

export function getConnectorRawDir(connectorId: string): string {
  return path.join(getConnectorDir(connectorId), "raw");
}

export function getConnectorToolsDir(connectorId: string): string {
  return path.join(getConnectorDir(connectorId), "tools");
}

export function getConnectorToolCatalogPath(
  connectorId: string,
  endpoint: string,
): string {
  return path.join(getConnectorToolsDir(connectorId), `${endpoint}.json`);
}

export function getConnectorLogsDir(connectorId: string): string {
  return path.join(getConnectorDir(connectorId), "logs");
}

export async function ensureOpenWikiHome(): Promise<void> {
  const homeDir = getOpenWikiHomeDir();
  await mkdir(homeDir, { recursive: true, mode: 0o700 });
  await chmodIfExists(homeDir, 0o700);
  await mkdir(getOpenWikiConnectorsDir(), { recursive: true, mode: 0o700 });
  await mkdir(getOpenWikiLocalWikiDir(), { recursive: true, mode: 0o700 });
  await mkdir(getOpenWikiSkillsDir(), { recursive: true, mode: 0o700 });
}

export async function ensureConnectorHome(connectorId: string): Promise<void> {
  assertSafeConnectorId(connectorId);
  await ensureOpenWikiHome();
  await mkdir(getConnectorDir(connectorId), { recursive: true, mode: 0o700 });
  await mkdir(getConnectorRawDir(connectorId), {
    recursive: true,
    mode: 0o700,
  });
  await mkdir(getConnectorLogsDir(connectorId), {
    recursive: true,
    mode: 0o700,
  });
}

export function assertSafeConnectorId(connectorId: string): void {
  if (!/^[a-z][a-z0-9-]{0,63}$/u.test(connectorId)) {
    throw new Error(`Invalid connector ID: ${connectorId}`);
  }
}

export function resolveConnectorRawPath(
  connectorId: string,
  relativePath: string,
): string {
  assertSafeConnectorId(connectorId);
  const rawDir = getConnectorRawDir(connectorId);
  const resolved = path.resolve(rawDir, relativePath);

  if (resolved !== rawDir && !resolved.startsWith(`${rawDir}${path.sep}`)) {
    throw new Error(
      "Raw item path must stay inside the connector raw directory.",
    );
  }

  return resolved;
}

async function chmodIfExists(filePath: string, mode: number): Promise<void> {
  try {
    await chmod(filePath, mode);
  } catch (error) {
    if (!isFileNotFoundError(error)) {
      throw error;
    }
  }
}

function isFileNotFoundError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
