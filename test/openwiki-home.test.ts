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

    // Moving the override after those modules loaded is the whole point of this
    // test: the home paths are `export let` bindings resolved at module load, so
    // only `resetOpenWikiHomePaths()` makes the new home take effect. If any
    // module in this chain had copied a home-derived path into a module-level
    // constant, the reset could not reach it and every expectation below would
    // still point at the first temp directory.
    const openWikiHome = await createTempDir();
    process.env.OPENWIKI_HOME = openWikiHome;
    const { resetOpenWikiHomePaths } = await import("../src/openwiki-home.ts");
    resetOpenWikiHomePaths();

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
    const home = await import("../src/openwiki-home.ts");

    const defaultHome = path.join(homedir(), ".openwiki");

    delete process.env.OPENWIKI_HOME;
    home.resetOpenWikiHomePaths();
    expect(home.openWikiHomeDir).toBe(defaultHome);
    expect(home.openWikiLocalWikiDir).toBe(path.join(defaultHome, "wiki"));

    process.env.OPENWIKI_HOME = "   ";
    home.resetOpenWikiHomePaths();
    expect(home.openWikiHomeDir).toBe(defaultHome);
  });

  test("resetOpenWikiHomePaths re-resolves every derived path", async () => {
    // Guards against a path being re-resolved only for the home itself: each
    // derived binding must be recomputed too, or a reset would move connector
    // IO while leaving the wiki, skills, or credentials behind in the old home.
    const home = await import("../src/openwiki-home.ts");

    const openWikiHome = await createTempDir();
    process.env.OPENWIKI_HOME = openWikiHome;
    home.resetOpenWikiHomePaths();

    expect({
      openWikiConnectorsDir: home.openWikiConnectorsDir,
      openWikiEnvDir: home.openWikiEnvDir,
      openWikiEnvPath: home.openWikiEnvPath,
      openWikiHomeDir: home.openWikiHomeDir,
      openWikiLocalWikiDir: home.openWikiLocalWikiDir,
      openWikiSkillsDir: home.openWikiSkillsDir,
    }).toEqual({
      openWikiConnectorsDir: path.join(openWikiHome, "connectors"),
      openWikiEnvDir: openWikiHome,
      openWikiEnvPath: path.join(openWikiHome, ".env"),
      openWikiHomeDir: openWikiHome,
      openWikiLocalWikiDir: path.join(openWikiHome, "wiki"),
      openWikiSkillsDir: path.join(openWikiHome, "skills"),
    });
  });

  test("env file path follows the override after a reset", async () => {
    // `src/env.ts` re-exports the credential paths rather than owning them, so
    // this also pins that the re-export stays a live binding: a value copied out
    // of `openwiki-home.ts` at import time would not follow the reset.
    const env = await import("../src/env.ts");
    const { resetOpenWikiHomePaths } = await import("../src/openwiki-home.ts");

    delete process.env.OPENWIKI_HOME;
    resetOpenWikiHomePaths();
    expect(env.openWikiEnvPath).toBe(path.join(homedir(), ".openwiki", ".env"));

    const openWikiHome = await createTempDir();
    process.env.OPENWIKI_HOME = openWikiHome;
    resetOpenWikiHomePaths();
    expect(env.openWikiEnvDir).toBe(openWikiHome);
    expect(env.openWikiEnvPath).toBe(path.join(openWikiHome, ".env"));
  });
});
