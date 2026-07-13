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
      requiredEnv: [],
      supportsAgenticDiscovery: false,
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
});
