import { describe, expect, test } from "vitest";
import type { OpenWikiOnboardingConfig } from "../src/onboarding.ts";
import {
  createLaunchAgentPlist,
  DEFAULT_EXPLORATION_CRON,
  getPowerWindowForConfiguredSchedules,
  getSuggestedExplorationCronExpression,
  resolveScheduledAgentsToResume,
} from "../src/schedules.ts";

function baseConfig(): OpenWikiOnboardingConfig {
  return { sourceInstances: [], sources: {}, version: 1 };
}

describe("exploration schedules", () => {
  test("builds an exploration LaunchAgent plist", () => {
    const plist = createLaunchAgentPlist({
      agentKind: "exploration",
      calendarInterval: { Hour: 3, Minute: 0, Weekday: 1 },
      cliPath: "/opt/openwiki/dist/cli.js",
      cwd: "/workspace/openwiki",
      logPath: "/home/me/.openwiki/logs/exploration.schedule.log",
      nodePath: "/opt/node/bin/node",
    });

    expect(plist).toContain("<string>com.openwiki.exploration</string>");
    expect(plist).toContain("<string>/opt/node/bin/node</string>");
    expect(plist).toContain("<string>/opt/openwiki/dist/cli.js</string>");
    expect(plist).toMatch(
      /<string>explore<\/string>\s*<string>all<\/string>\s*<string>--scheduled<\/string>\s*<string>--print<\/string>/u,
    );
    expect(plist).toContain(
      "<string>/home/me/.openwiki/logs/exploration.schedule.log</string>",
    );
    expect(plist).toContain("<key>Weekday</key>\n    <integer>1</integer>");
  });

  test("merges nightly ingestion and the weekly exploration floor", () => {
    const window = getPowerWindowForConfiguredSchedules({
      ...baseConfig(),
      explorationSchedule: {
        description: "weekly",
        expression: "0 3 * * 1",
        updatedAt: "2026-07-13T00:00:00.000Z",
      },
      ingestionSchedule: {
        description: "nightly",
        expression: "0 2 * * *",
        updatedAt: "2026-07-13T00:00:00.000Z",
      },
    });

    expect(window).toEqual({
      days: "MTWRFSU",
      sleepTime: "03:30:00",
      wakeTime: "01:58:00",
    });
  });

  test("suggests the weekly floor unless one is already configured", () => {
    expect(DEFAULT_EXPLORATION_CRON).toBe("0 3 * * 1");
    expect(getSuggestedExplorationCronExpression(baseConfig())).toBe(
      "0 3 * * 1",
    );
    expect(
      getSuggestedExplorationCronExpression({
        ...baseConfig(),
        explorationSchedule: {
          description: "custom",
          expression: "30 4 * * 5",
          updatedAt: "2026-07-13T00:00:00.000Z",
        },
      }),
    ).toBe("30 4 * * 5");
  });

  test("resume plans both agents and adds a missing weekly floor", () => {
    const agents = resolveScheduledAgentsToResume({
      ...baseConfig(),
      ingestionSchedule: {
        description: "nightly",
        expression: "0 2 * * *",
        pausedAt: "2026-07-12T00:00:00.000Z",
        updatedAt: "2026-07-12T00:00:00.000Z",
      },
      sourceInstances: [
        {
          connectedAt: "2026-07-01T00:00:00.000Z",
          connectorId: "glean",
          id: "glean-primary",
        },
      ],
    });

    expect(agents).toEqual([
      { expression: "0 2 * * *", kind: "ingestion" },
      { expression: "0 3 * * 1", kind: "exploration" },
    ]);
  });

  test("resume plans both present schedules even if only ingestion was paused", () => {
    const agents = resolveScheduledAgentsToResume({
      ...baseConfig(),
      explorationSchedule: {
        description: "weekly",
        expression: "30 4 * * 5",
        updatedAt: "2026-07-01T00:00:00.000Z",
      },
      ingestionSchedule: {
        description: "nightly",
        expression: "0 2 * * *",
        pausedAt: "2026-07-12T00:00:00.000Z",
        updatedAt: "2026-07-12T00:00:00.000Z",
      },
    });

    expect(agents).toEqual([
      { expression: "0 2 * * *", kind: "ingestion" },
      { expression: "30 4 * * 5", kind: "exploration" },
    ]);
  });
});
