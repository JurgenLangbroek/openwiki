import { mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

const originalOpenWikiHome = process.env.OPENWIKI_HOME;
const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "openwiki-home-"));
  tempDirs.push(directory);
  return directory;
}

afterEach(async () => {
  vi.resetModules();

  if (originalOpenWikiHome === undefined) {
    delete process.env.OPENWIKI_HOME;
  } else {
    process.env.OPENWIKI_HOME = originalOpenWikiHome;
  }

  await Promise.all(
    tempDirs
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("OPENWIKI_HOME", () => {
  test("routes connector config, state, and raw IO using the value at call time", async () => {
    process.env.OPENWIKI_HOME = await createTempDir();
    const { configureAuthProvider } = await import("../src/auth/configure.ts");
    const {
      readConnectorConfig,
      readConnectorState,
      writeConnectorState,
      writeRawJson,
    } = await import("../src/connectors/io.ts");

    const openWikiHome = await createTempDir();
    process.env.OPENWIKI_HOME = openWikiHome;

    const configured = await configureAuthProvider("notion");
    const state = {
      lastRunAt: "2026-07-11T00:00:00.000Z",
      version: 1,
    } as const;
    await writeConnectorState("notion", state);
    const rawPath = await writeRawJson("notion", "run-1", "items.json", {
      items: [1],
    });

    const connectorDir = path.join(openWikiHome, "connectors", "notion");
    expect(configured.configPath).toBe(path.join(connectorDir, "config.json"));
    await expect(readConnectorConfig("notion", {})).resolves.toMatchObject({
      enabled: true,
    });
    await expect(readConnectorState("notion")).resolves.toEqual(state);
    expect(rawPath).toBe(path.join(connectorDir, "raw", "run-1", "items.json"));
    await expect(readFile(rawPath, "utf8")).resolves.toBe(
      `${JSON.stringify({ items: [1] }, null, 2)}\n`,
    );
  });

  test("falls back to ~/.openwiki when unset or blank", async () => {
    const { getOpenWikiHomeDir, getOpenWikiLocalWikiDir } =
      await import("../src/openwiki-home.ts");

    const defaultHome = path.join(homedir(), ".openwiki");

    delete process.env.OPENWIKI_HOME;
    expect(getOpenWikiHomeDir()).toBe(defaultHome);
    expect(getOpenWikiLocalWikiDir()).toBe(path.join(defaultHome, "wiki"));

    process.env.OPENWIKI_HOME = "   ";
    expect(getOpenWikiHomeDir()).toBe(defaultHome);
  });

  test("env file path follows the override at call time", async () => {
    const { getOpenWikiEnvPath } = await import("../src/env.ts");

    delete process.env.OPENWIKI_HOME;
    expect(getOpenWikiEnvPath()).toBe(
      path.join(homedir(), ".openwiki", ".env"),
    );

    const openWikiHome = await createTempDir();
    process.env.OPENWIKI_HOME = openWikiHome;
    expect(getOpenWikiEnvPath()).toBe(path.join(openWikiHome, ".env"));
  });
});
