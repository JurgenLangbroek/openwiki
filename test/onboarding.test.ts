import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

const originalHome = process.env.HOME;
const originalOpenWikiHome = process.env.OPENWIKI_HOME;
const tempHomes: string[] = [];

async function createTempHome(): Promise<string> {
  const home = await mkdtemp(path.join(tmpdir(), "openwiki-onboarding-"));
  tempHomes.push(home);
  return home;
}

async function loadOnboardingModule(home: string) {
  vi.resetModules();
  process.env.HOME = home;
  process.env.OPENWIKI_HOME = home;
  return await import("../src/onboarding.ts");
}

afterEach(async () => {
  vi.resetModules();

  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }

  if (originalOpenWikiHome === undefined) {
    delete process.env.OPENWIKI_HOME;
  } else {
    process.env.OPENWIKI_HOME = originalOpenWikiHome;
  }

  await Promise.all(
    tempHomes
      .splice(0)
      .map((home) => rm(home, { force: true, recursive: true })),
  );
});

describe("OpenWiki onboarding sources", () => {
  test("round-trips a Glean source instance with its connector config", async () => {
    const home = await createTempHome();
    const onboarding = await loadOnboardingModule(home);
    const gleanSource = {
      connectedAt: "2026-07-13T12:00:00.000Z",
      connectorConfig: { email: "j@acme.example" },
      connectorId: "glean" as const,
      id: "glean-1",
      ingestionGoal: "Track projects, teams, decisions, tickets, and docs.",
      name: "Glean work context",
    };

    await onboarding.saveOpenWikiOnboardingConfig({
      sourceInstances: [gleanSource],
      sources: {},
      version: 1,
    });

    const saved = await onboarding.readOpenWikiOnboardingConfig();
    expect(saved.sourceInstances).toEqual([gleanSource]);
  });

  test("normalizes a legacy Glean source into a source instance", async () => {
    const home = await createTempHome();
    const onboarding = await loadOnboardingModule(home);

    await writeFile(
      onboarding.getOpenWikiOnboardingPath(),
      `${JSON.stringify({
        sources: {
          glean: {
            connectedAt: "2026-07-13T12:00:00.000Z",
            connectorConfig: { email: "j@acme.example" },
            ingestionGoal: "Track work decisions and supporting docs.",
          },
        },
        version: 1,
      })}\n`,
      "utf8",
    );

    const saved = await onboarding.readOpenWikiOnboardingConfig();
    expect(saved.sourceInstances).toEqual([
      {
        connectedAt: "2026-07-13T12:00:00.000Z",
        connectorConfig: { email: "j@acme.example" },
        connectorId: "glean",
        id: "glean",
        ingestionGoal: "Track work decisions and supporting docs.",
      },
    ]);
  });
});

describe("OpenWiki onboarding instructions", () => {
  test("round-trips a normalized exploration schedule", async () => {
    const home = await createTempHome();
    const onboarding = await loadOnboardingModule(home);

    await onboarding.saveOpenWikiOnboardingConfig({
      explorationSchedule: {
        description: "Weekly on Monday at 3:00 AM",
        expression: "0 3 * * 1",
        launchAgentPath:
          "/tmp/Library/LaunchAgents/com.openwiki.exploration.plist",
        updatedAt: "2026-07-13T00:00:00.000Z",
        warning: "fixture warning",
      },
      sourceInstances: [],
      sources: {},
      version: 1,
    });

    await expect(
      onboarding.readOpenWikiOnboardingConfig(),
    ).resolves.toMatchObject({
      explorationSchedule: {
        description: "Weekly on Monday at 3:00 AM",
        expression: "0 3 * * 1",
        launchAgentPath:
          "/tmp/Library/LaunchAgents/com.openwiki.exploration.plist",
        updatedAt: "2026-07-13T00:00:00.000Z",
        warning: "fixture warning",
      },
    });
  });

  test("saves wiki instructions to INSTRUCTIONS.md instead of onboarding.json", async () => {
    const home = await createTempHome();
    const onboarding = await loadOnboardingModule(home);

    await onboarding.saveOpenWikiOnboardingConfig({
      ingestionSchedule: {
        description: "daily",
        expression: "0 9 * * *",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      sourceInstances: [],
      sources: {},
      version: 1,
      wikiGoal: "Track projects, commitments, and recurring themes.",
    });

    const json = JSON.parse(
      await readFile(onboarding.getOpenWikiOnboardingPath(), "utf8"),
    ) as Record<string, unknown>;
    const instructions = await readFile(
      onboarding.getOpenWikiInstructionsPath(),
      "utf8",
    );

    expect(json.wikiGoal).toBeUndefined();
    expect(instructions).toBe(
      "Track projects, commitments, and recurring themes.\n",
    );
  });

  test("reads wiki instructions only from INSTRUCTIONS.md", async () => {
    const home = await createTempHome();
    const onboarding = await loadOnboardingModule(home);

    await onboarding.saveOpenWikiOnboardingConfig({
      sourceInstances: [],
      sources: {},
      version: 1,
      wikiGoal: "Markdown instructions win.",
    });
    await writeFile(
      onboarding.getOpenWikiOnboardingPath(),
      `${JSON.stringify({
        sourceInstances: [],
        sources: {},
        version: 1,
        wikiGoal: "Legacy JSON fallback.",
      })}\n`,
      "utf8",
    );

    await expect(
      onboarding.readOpenWikiOnboardingConfig(),
    ).resolves.toMatchObject({
      wikiGoal: "Markdown instructions win.",
    });

    await rm(onboarding.getOpenWikiInstructionsPath());

    const config = await onboarding.readOpenWikiOnboardingConfig();
    expect(config.wikiGoal).toBeUndefined();
  });

  test("saves repository wiki instructions under openwiki", async () => {
    const home = await createTempHome();
    const repo = await mkdtemp(path.join(tmpdir(), "openwiki-repo-"));
    const onboarding = await loadOnboardingModule(home);

    try {
      await onboarding.saveRepositoryWikiInstructions(
        repo,
        "Shared repository brief.",
      );

      await expect(
        readFile(onboarding.getRepositoryWikiInstructionsPath(repo), "utf8"),
      ).resolves.toBe("Shared repository brief.\n");
      await expect(
        onboarding.readRepositoryWikiInstructions(repo),
      ).resolves.toBe("Shared repository brief.");
    } finally {
      await rm(repo, { force: true, recursive: true });
    }
  });
});

describe("OpenWiki onboarding completion", () => {
  test("does not require a schedule for code mode", async () => {
    const home = await createTempHome();
    const onboarding = await loadOnboardingModule(home);

    expect(
      onboarding.isOnboardingComplete({
        completedAt: "2026-01-01T00:00:00.000Z",
        modeId: "code",
        sourceInstances: [],
        sources: {},
        templateId: "code",
        version: 1,
        wikiGoal: "Maintain a code wiki.",
      }),
    ).toBe(true);
  });

  test("checks repository instructions for completed code mode", async () => {
    const home = await createTempHome();
    const repo = await mkdtemp(path.join(tmpdir(), "openwiki-repo-"));
    const onboarding = await loadOnboardingModule(home);

    try {
      await onboarding.saveOpenWikiOnboardingConfig({
        completedAt: "2026-01-01T00:00:00.000Z",
        modeId: "code",
        sourceInstances: [],
        sources: {},
        templateId: "code",
        version: 1,
      });

      expect(onboarding.isRepositoryCodeOnboardingCompleteSync(repo)).toBe(
        false,
      );

      await onboarding.saveRepositoryWikiInstructions(
        repo,
        "Maintain a shared code wiki.",
      );

      expect(onboarding.isRepositoryCodeOnboardingCompleteSync(repo)).toBe(
        true,
      );
    } finally {
      await rm(repo, { force: true, recursive: true });
    }
  });

  test("still requires a schedule for personal mode", async () => {
    const home = await createTempHome();
    const onboarding = await loadOnboardingModule(home);

    expect(
      onboarding.isOnboardingComplete({
        completedAt: "2026-01-01T00:00:00.000Z",
        modeId: "personal",
        sourceInstances: [],
        sources: {},
        templateId: "personal",
        version: 1,
        wikiGoal: "Track projects and commitments.",
      }),
    ).toBe(false);
  });
});
