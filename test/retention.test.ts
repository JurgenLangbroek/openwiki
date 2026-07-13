import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

const originalOpenWikiHome = process.env.OPENWIKI_HOME;
const tempDirs: string[] = [];

async function createTempHome(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "openwiki-retention-"));
  tempDirs.push(directory);
  process.env.OPENWIKI_HOME = directory;
  return directory;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return false;
    }

    throw error;
  }
}

afterEach(async () => {
  vi.doUnmock("../src/agent/index.ts");
  vi.doUnmock("../src/connectors/registry.ts");
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

describe("raw connector retention", () => {
  test("deletes only synthesized runs older than the connector TTL", async () => {
    const openWikiHome = await createTempHome();
    const { readConnectorState, writeConnectorState, writeRawJson } =
      await import("../src/connectors/io.ts");
    const { sweepConnectorRawRetention } =
      await import("../src/connectors/retention.ts");
    const now = new Date("2026-07-13T00:00:00.000Z");
    const expiredRunId = "2026-06-23T00-00-00-000Z";
    const recentRunId = "2026-07-12T00-00-00-000Z";
    const unsynthesizedRunId = "2026-06-13T00-00-00-000Z";

    await writeRawJson("glean", expiredRunId, "items.json", { items: [1] });
    await writeRawJson("glean", recentRunId, "items.json", { items: [2] });
    await writeRawJson("glean", unsynthesizedRunId, "items.json", {
      items: [3],
    });
    await writeConnectorState("glean", {
      runs: [
        {
          at: "2026-07-12T00:00:00.000Z",
          rawFiles: ["recent"],
          runId: recentRunId,
          status: "success",
          synthesizedAt: "2026-07-12T00:00:00.000Z",
          warnings: [],
        },
        {
          at: "2026-06-23T00:00:00.000Z",
          rawFiles: ["expired"],
          runId: expiredRunId,
          status: "success",
          synthesizedAt: "2026-06-23T00:00:00.000Z",
          warnings: [],
        },
        {
          at: "2026-06-13T00:00:00.000Z",
          rawFiles: ["unsynthesized"],
          runId: unsynthesizedRunId,
          status: "success",
          warnings: [],
        },
      ],
      version: 1,
    });

    await expect(sweepConnectorRawRetention("glean", { now })).resolves.toEqual(
      {
        connectorId: "glean",
        deletedRunIds: [expiredRunId],
        retentionDays: 14,
      },
    );

    const rawDir = path.join(openWikiHome, "connectors", "glean", "raw");
    expect(await pathExists(path.join(rawDir, expiredRunId))).toBe(false);
    expect(await pathExists(path.join(rawDir, recentRunId))).toBe(true);
    expect(await pathExists(path.join(rawDir, unsynthesizedRunId))).toBe(true);
    const sweptState = {
      runs: [
        {
          at: "2026-07-12T00:00:00.000Z",
          rawFiles: ["recent"],
          runId: recentRunId,
          status: "success",
          synthesizedAt: "2026-07-12T00:00:00.000Z",
          warnings: [],
        },
        {
          at: "2026-06-23T00:00:00.000Z",
          rawDeletedAt: "2026-07-13T00:00:00.000Z",
          rawFiles: [],
          runId: expiredRunId,
          status: "success",
          synthesizedAt: "2026-06-23T00:00:00.000Z",
          warnings: [],
        },
        {
          at: "2026-06-13T00:00:00.000Z",
          rawFiles: ["unsynthesized"],
          runId: unsynthesizedRunId,
          status: "success",
          warnings: [],
        },
      ],
      version: 1,
    };
    await expect(readConnectorState("glean")).resolves.toEqual(sweptState);

    await expect(sweepConnectorRawRetention("glean", { now })).resolves.toEqual(
      {
        connectorId: "glean",
        deletedRunIds: [],
        retentionDays: 14,
      },
    );
    await expect(readConnectorState("glean")).resolves.toEqual(sweptState);
  });

  test("leaves connectors without a configured or built-in TTL untouched", async () => {
    const openWikiHome = await createTempHome();
    const { readConnectorState, writeConnectorState, writeRawJson } =
      await import("../src/connectors/io.ts");
    const { sweepConnectorRawRetention } =
      await import("../src/connectors/retention.ts");
    const runId = "2026-06-13T00-00-00-000Z";
    const state = {
      runs: [
        {
          at: "2026-06-13T00:00:00.000Z",
          rawFiles: ["items.json"],
          runId,
          status: "success" as const,
          synthesizedAt: "2026-06-13T01:00:00.000Z",
          warnings: [],
        },
      ],
      version: 1 as const,
    };
    const rawPath = await writeRawJson("slack", runId, "items.json", {
      items: [1],
    });
    await writeConnectorState("slack", state);

    await expect(
      sweepConnectorRawRetention("slack", {
        now: new Date("2026-07-13T00:00:00.000Z"),
      }),
    ).resolves.toEqual({
      connectorId: "slack",
      deletedRunIds: [],
      retentionDays: undefined,
    });

    expect(await pathExists(rawPath)).toBe(true);
    await expect(readConnectorState("slack")).resolves.toEqual(state);
    expect(
      await pathExists(
        path.join(openWikiHome, "connectors", "slack", "state.json"),
      ),
    ).toBe(true);
  });

  test("uses the 14-day Glean default when config has no TTL", async () => {
    const openWikiHome = await createTempHome();
    const { readConnectorState, writeConnectorState, writeRawJson } =
      await import("../src/connectors/io.ts");
    const { sweepConnectorRawRetention } =
      await import("../src/connectors/retention.ts");
    const expiredRunId = "2026-06-28T00-00-00-000Z";
    const recentRunId = "2026-06-30T00-00-00-000Z";
    await writeRawJson("glean", expiredRunId, "items.json", { items: [1] });
    await writeRawJson("glean", recentRunId, "items.json", { items: [2] });
    await writeConnectorState("glean", {
      runs: [
        {
          at: "2026-06-30T00:00:00.000Z",
          rawFiles: ["recent"],
          runId: recentRunId,
          status: "success",
          synthesizedAt: "2026-06-30T00:00:00.000Z",
          warnings: [],
        },
        {
          at: "2026-06-28T00:00:00.000Z",
          rawFiles: ["expired"],
          runId: expiredRunId,
          status: "success",
          synthesizedAt: "2026-06-28T00:00:00.000Z",
          warnings: [],
        },
      ],
      version: 1,
    });

    await expect(
      sweepConnectorRawRetention("glean", {
        now: new Date("2026-07-13T00:00:00.000Z"),
      }),
    ).resolves.toMatchObject({
      deletedRunIds: [expiredRunId],
      retentionDays: 14,
    });

    const rawDir = path.join(openWikiHome, "connectors", "glean", "raw");
    expect(await pathExists(path.join(rawDir, expiredRunId))).toBe(false);
    expect(await pathExists(path.join(rawDir, recentRunId))).toBe(true);
    expect((await readConnectorState("glean")).runs?.[1]).toMatchObject({
      rawDeletedAt: "2026-07-13T00:00:00.000Z",
      rawFiles: [],
    });
  });

  test("uses a connector config TTL in preference to defaults", async () => {
    const openWikiHome = await createTempHome();
    const { writeConnectorState, writeRawJson } =
      await import("../src/connectors/io.ts");
    const { sweepConnectorRawRetention } =
      await import("../src/connectors/retention.ts");
    const expiredRunId = "2026-07-10T00-00-00-000Z";
    const recentRunId = "2026-07-12T00-00-00-000Z";
    await writeRawJson("slack", expiredRunId, "items.json", { items: [1] });
    await writeRawJson("slack", recentRunId, "items.json", { items: [2] });
    await writeConnectorState("slack", {
      runs: [
        {
          at: "2026-07-12T00:00:00.000Z",
          rawFiles: ["recent"],
          runId: recentRunId,
          status: "success",
          synthesizedAt: "2026-07-12T00:00:00.000Z",
          warnings: [],
        },
        {
          at: "2026-07-10T00:00:00.000Z",
          rawFiles: ["expired"],
          runId: expiredRunId,
          status: "success",
          synthesizedAt: "2026-07-10T00:00:00.000Z",
          warnings: [],
        },
      ],
      version: 1,
    });
    await writeFile(
      path.join(openWikiHome, "connectors", "slack", "config.json"),
      `${JSON.stringify({ rawRetentionDays: 2 }, null, 2)}\n`,
      "utf8",
    );

    await expect(
      sweepConnectorRawRetention("slack", {
        now: new Date("2026-07-13T00:00:00.000Z"),
      }),
    ).resolves.toEqual({
      connectorId: "slack",
      deletedRunIds: [expiredRunId],
      retentionDays: 2,
    });

    const rawDir = path.join(openWikiHome, "connectors", "slack", "raw");
    expect(await pathExists(path.join(rawDir, expiredRunId))).toBe(false);
    expect(await pathExists(path.join(rawDir, recentRunId))).toBe(true);
  });

  test("marks a matching run synthesized and ignores repeat or unknown runs", async () => {
    await createTempHome();
    const { markRunSynthesized, readConnectorState, writeConnectorState } =
      await import("../src/connectors/io.ts");
    const runId = "2026-07-13T00-00-00-000Z";
    const initialState = {
      lastRunAt: "2026-07-13T00:00:00.000Z",
      runs: [
        {
          at: "2026-07-13T00:00:00.000Z",
          rawFiles: ["items.json"],
          runId,
          status: "success" as const,
          warnings: [],
        },
      ],
      version: 1 as const,
    };
    await writeConnectorState("glean", initialState);

    await markRunSynthesized("glean", runId, "2026-07-13T00:05:00.000Z");
    const stampedState = await readConnectorState("glean");
    expect(stampedState).toEqual({
      ...initialState,
      runs: [
        {
          ...initialState.runs[0],
          synthesizedAt: "2026-07-13T00:05:00.000Z",
        },
      ],
    });

    await markRunSynthesized("glean", runId, "2026-07-13T00:10:00.000Z");
    await markRunSynthesized(
      "glean",
      "2026-07-13T00-15-00-000Z",
      "2026-07-13T00:15:00.000Z",
    );
    await expect(readConnectorState("glean")).resolves.toEqual(stampedState);
  });

  test("marks only unsynthesized runs without deleted raw data", async () => {
    const openWikiHome = await createTempHome();
    const {
      markUnsynthesizedRunsSynthesized,
      readConnectorState,
      writeConnectorState,
    } = await import("../src/connectors/io.ts");
    const initialState = {
      runs: [
        {
          at: "2026-07-10T00:00:00.000Z",
          rawFiles: ["already-synthesized.json"],
          runId: "2026-07-10T00-00-00-000Z",
          status: "success" as const,
          synthesizedAt: "2026-07-10T01:00:00.000Z",
          warnings: [],
        },
        {
          at: "2026-07-11T00:00:00.000Z",
          rawFiles: ["unsynthesized.json"],
          runId: "2026-07-11T00-00-00-000Z",
          status: "success" as const,
          warnings: [],
        },
        {
          at: "2026-07-12T00:00:00.000Z",
          rawDeletedAt: "2026-07-13T00:00:00.000Z",
          rawFiles: [],
          runId: "2026-07-12T00-00-00-000Z",
          status: "success" as const,
          warnings: [],
        },
      ],
      version: 1 as const,
    };
    await writeConnectorState("git-repo", initialState);

    await markUnsynthesizedRunsSynthesized(
      "git-repo",
      "2026-07-13T01:00:00.000Z",
    );

    await expect(readConnectorState("git-repo")).resolves.toEqual({
      ...initialState,
      runs: [
        initialState.runs[0],
        {
          ...initialState.runs[1],
          synthesizedAt: "2026-07-13T01:00:00.000Z",
        },
        initialState.runs[2],
      ],
    });

    await expect(
      markUnsynthesizedRunsSynthesized("notion", "2026-07-13T01:00:00.000Z"),
    ).resolves.toBeUndefined();
    expect(
      await pathExists(
        path.join(openWikiHome, "connectors", "notion", "state.json"),
      ),
    ).toBe(false);
  });

  test("stamps synthesis and sweeps retention during scheduled ingestion", async () => {
    const openWikiHome = await createTempHome();
    const { readConnectorState, writeConnectorState, writeRawJson } =
      await import("../src/connectors/io.ts");
    const { getConnectorStatePath } = await import("../src/openwiki-home.ts");
    const { saveOpenWikiOnboardingConfig } =
      await import("../src/onboarding.ts");
    const currentRunId = "2026-07-13T00-00-00-000Z";
    const expiredRunId = "2026-06-23T00-00-00-000Z";
    const currentRawPath = await writeRawJson(
      "glean",
      currentRunId,
      "items.json",
      { items: [1] },
    );
    await writeRawJson("glean", expiredRunId, "items.json", { items: [2] });
    await writeConnectorState("glean", {
      runs: [
        {
          at: "2026-07-13T00:00:00.000Z",
          rawFiles: [currentRawPath],
          runId: currentRunId,
          status: "success",
          warnings: [],
        },
        {
          at: "2026-06-23T00:00:00.000Z",
          rawFiles: ["expired"],
          runId: expiredRunId,
          status: "success",
          synthesizedAt: "2026-06-23T00:00:00.000Z",
          warnings: [],
        },
      ],
      version: 1,
    });
    await saveOpenWikiOnboardingConfig({
      ingestionSchedule: {
        description: "Daily",
        expression: "0 8 * * *",
        updatedAt: "2026-07-01T00:00:00.000Z",
      },
      sourceInstances: [
        {
          connectedAt: "2026-07-01T00:00:00.000Z",
          connectorId: "glean",
          id: "glean-primary",
        },
      ],
      sources: {},
      version: 1,
    });

    const connector = {
      backend: "direct-api",
      description: "Test Glean",
      displayName: "Glean",
      id: "glean",
      ingest: vi.fn().mockResolvedValue({
        connectorId: "glean",
        message: "Pulled fixture",
        rawFiles: [currentRawPath],
        runId: currentRunId,
        statePath: getConnectorStatePath("glean"),
        status: "success",
        warnings: [],
      }),
      posture: "deterministic",
      requiredEnv: [],
    };
    const runOpenWikiAgent = vi.fn().mockResolvedValue({});
    vi.doMock("../src/agent/index.ts", () => ({
      createOpenWikiThreadId: () => "retention-test-thread",
      runOpenWikiAgent,
    }));
    vi.doMock("../src/connectors/registry.ts", async () => {
      const actual = await vi.importActual<
        typeof import("../src/connectors/registry.ts")
      >("../src/connectors/registry.ts");

      return {
        ...actual,
        createConnectorRegistry: () => ({ glean: connector }),
      };
    });
    const { runOpenWikiIngestion } = await import("../src/ingestion.ts");

    await expect(
      runOpenWikiIngestion("ignored", {
        scheduledOnly: true,
        target: "glean",
      }),
    ).resolves.toMatchObject({
      results: [{ connectorId: "glean", status: "agent-updated" }],
    });

    expect(runOpenWikiAgent).toHaveBeenCalledOnce();
    const state = await readConnectorState("glean");
    expect(state.runs?.[0]?.synthesizedAt).toBeDefined();
    expect(state.runs?.[1]).toMatchObject({
      rawFiles: [],
      runId: expiredRunId,
    });
    expect(state.runs?.[1]?.rawDeletedAt).toBeDefined();
    expect(
      await pathExists(
        path.join(openWikiHome, "connectors", "glean", "raw", expiredRunId),
      ),
    ).toBe(false);
  });

  test("stamps every hybrid run only after non-skipped synthesis", async () => {
    await createTempHome();
    const { getConnectorStatePath } = await import("../src/openwiki-home.ts");
    const { readConnectorState, writeConnectorState, writeRawJson } =
      await import("../src/connectors/io.ts");
    const { saveOpenWikiOnboardingConfig } =
      await import("../src/onboarding.ts");
    const pullRunId = "2026-07-13T00-00-00-000Z";
    const liveToolRunId = "2026-07-13T00-01-00-000Z";
    const pullRawPath = await writeRawJson("glean", pullRunId, "items.json", {
      items: [1],
    });
    const liveToolRawPath = await writeRawJson(
      "glean",
      liveToolRunId,
      "mcp-tool-result.json",
      { result: { items: [2] } },
    );
    const unsynthesizedState = {
      runs: [
        {
          at: "2026-07-13T00:01:00.000Z",
          rawFiles: [liveToolRawPath],
          runId: liveToolRunId,
          status: "success" as const,
          warnings: [],
        },
        {
          at: "2026-07-13T00:00:00.000Z",
          rawFiles: [pullRawPath],
          runId: pullRunId,
          status: "success" as const,
          warnings: [],
        },
      ],
      version: 1 as const,
    };
    await writeConnectorState("glean", unsynthesizedState);
    await saveOpenWikiOnboardingConfig({
      sourceInstances: [
        {
          connectedAt: "2026-07-01T00:00:00.000Z",
          connectorId: "glean",
          id: "glean-primary",
        },
      ],
      sources: {},
      version: 1,
    });

    const connector = {
      backend: "direct-api",
      description: "Test hybrid Glean",
      displayName: "Glean",
      id: "glean",
      ingest: vi.fn().mockResolvedValue({
        connectorId: "glean",
        message: "Pulled fixture",
        rawFiles: [pullRawPath],
        runId: pullRunId,
        statePath: getConnectorStatePath("glean"),
        status: "success",
        warnings: [],
      }),
      posture: "hybrid",
      requiredEnv: [],
    };
    const runOpenWikiAgent = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ skipped: true });
    vi.doMock("../src/agent/index.ts", () => ({
      createOpenWikiThreadId: () => "hybrid-retention-test-thread",
      runOpenWikiAgent,
    }));
    vi.doMock("../src/connectors/registry.ts", async () => {
      const actual = await vi.importActual<
        typeof import("../src/connectors/registry.ts")
      >("../src/connectors/registry.ts");

      return {
        ...actual,
        createConnectorRegistry: () => ({ glean: connector }),
      };
    });
    const { runOpenWikiIngestion } = await import("../src/ingestion.ts");

    await runOpenWikiIngestion("ignored", { target: "glean" });

    const synthesizedRuns = (await readConnectorState("glean")).runs;
    expect(synthesizedRuns).toHaveLength(2);
    expect(
      synthesizedRuns?.every(
        ({ synthesizedAt }) => typeof synthesizedAt === "string",
      ),
    ).toBe(true);

    await writeConnectorState("glean", unsynthesizedState);
    await runOpenWikiIngestion("ignored", { target: "glean" });

    const skippedRuns = (await readConnectorState("glean")).runs;
    expect(skippedRuns).toHaveLength(2);
    expect(skippedRuns?.every(({ synthesizedAt }) => !synthesizedAt)).toBe(
      true,
    );
  });

  test("stamps agentic connector runs without a deterministic pull", async () => {
    const openWikiHome = await createTempHome();
    const { readConnectorState, writeConnectorState, writeRawJson } =
      await import("../src/connectors/io.ts");
    const { saveOpenWikiOnboardingConfig } =
      await import("../src/onboarding.ts");
    const runId = "2026-06-23T00-00-00-000Z";
    const rawPath = await writeRawJson("git-repo", runId, "manifest.json", {
      repositories: [],
    });
    await writeConnectorState("git-repo", {
      runs: [
        {
          at: "2026-06-23T00:00:00.000Z",
          rawFiles: [rawPath],
          runId,
          status: "success",
          warnings: [],
        },
      ],
      version: 1,
    });
    await writeFile(
      path.join(openWikiHome, "connectors", "git-repo", "config.json"),
      `${JSON.stringify({ rawRetentionDays: 1 }, null, 2)}\n`,
      "utf8",
    );
    await saveOpenWikiOnboardingConfig({
      sourceInstances: [
        {
          connectedAt: "2026-07-01T00:00:00.000Z",
          connectorId: "git-repo",
          id: "git-repo-primary",
        },
      ],
      sources: {},
      version: 1,
    });

    const connector = {
      backend: "local-git",
      description: "Test Git repository",
      displayName: "Git repository",
      id: "git-repo",
      ingest: vi.fn(),
      posture: "agentic",
      requiredEnv: [],
    };
    const runOpenWikiAgent = vi.fn().mockResolvedValue({});
    vi.doMock("../src/agent/index.ts", () => ({
      createOpenWikiThreadId: () => "agentic-retention-test-thread",
      runOpenWikiAgent,
    }));
    vi.doMock("../src/connectors/registry.ts", async () => {
      const actual = await vi.importActual<
        typeof import("../src/connectors/registry.ts")
      >("../src/connectors/registry.ts");

      return {
        ...actual,
        createConnectorRegistry: () => ({ "git-repo": connector }),
      };
    });
    const { runOpenWikiIngestion } = await import("../src/ingestion.ts");

    await expect(
      runOpenWikiIngestion("ignored", { target: "git-repo" }),
    ).resolves.toMatchObject({
      results: [{ connectorId: "git-repo", status: "agent-updated" }],
    });

    expect(runOpenWikiAgent).toHaveBeenCalledOnce();
    expect(connector.ingest).not.toHaveBeenCalled();
    const stampedRun = (await readConnectorState("git-repo")).runs?.[0];
    expect(stampedRun).toMatchObject({
      rawFiles: [rawPath],
      runId,
    });
    expect(typeof stampedRun?.synthesizedAt).toBe("string");
    expect(await pathExists(rawPath)).toBe(true);
  });
});
