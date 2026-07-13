import { describe, expect, test } from "vitest";
import type { OpenWikiOnboardingConfig } from "../src/onboarding.ts";
import {
  configHasExplorableSource,
  resolveExplorationSourceInstances,
} from "../src/exploration.ts";

function config(
  overrides: Partial<OpenWikiOnboardingConfig> = {},
): OpenWikiOnboardingConfig {
  return {
    sourceInstances: [
      {
        connectedAt: "2026-07-01T00:00:00.000Z",
        connectorId: "glean",
        id: "glean-primary",
      },
      {
        connectedAt: "2026-07-01T00:00:00.000Z",
        connectorId: "git-repo",
        id: "git-primary",
      },
      {
        connectedAt: "2026-07-01T00:00:00.000Z",
        connectorId: "slack",
        id: "slack-primary",
      },
      { connectorId: "glean", id: "glean-disconnected" },
    ],
    sources: {},
    version: 1,
    ...overrides,
  };
}

describe("exploration eligibility", () => {
  test("all includes only connected hybrid and agentic source instances", () => {
    expect(
      resolveExplorationSourceInstances("all", config(), {
        scheduledOnly: false,
      }).map(({ id }) => id),
    ).toEqual(["glean-primary", "git-primary"]);
    expect(configHasExplorableSource(config())).toBe(true);
  });

  test("scheduled exploration requires an active exploration schedule", () => {
    expect(
      resolveExplorationSourceInstances("all", config(), {
        scheduledOnly: true,
      }),
    ).toEqual([]);
    expect(
      resolveExplorationSourceInstances(
        "all",
        config({
          explorationSchedule: {
            description: "weekly",
            expression: "0 3 * * 1",
            pausedAt: "2026-07-10T00:00:00.000Z",
            updatedAt: "2026-07-01T00:00:00.000Z",
          },
        }),
        { scheduledOnly: true },
      ),
    ).toEqual([]);
    expect(
      resolveExplorationSourceInstances(
        "all",
        config({
          explorationSchedule: {
            description: "weekly",
            expression: "0 3 * * 1",
            updatedAt: "2026-07-01T00:00:00.000Z",
          },
        }),
        { scheduledOnly: true },
      ).map(({ id }) => id),
    ).toEqual(["glean-primary", "git-primary"]);
  });

  test("explicit deterministic targets fail clearly", () => {
    expect(() =>
      resolveExplorationSourceInstances("slack", config(), {
        scheduledOnly: false,
      }),
    ).toThrow(/exploration only applies to hybrid or agentic connectors/iu);
    expect(() =>
      resolveExplorationSourceInstances(
        { id: "slack-primary", kind: "source-instance" },
        config(),
        { scheduledOnly: false },
      ),
    ).toThrow(/exploration only applies to hybrid or agentic connectors/iu);
  });

  test("all returns empty when no connected source is explorable", () => {
    const deterministicOnly = config({
      sourceInstances: [
        {
          connectedAt: "2026-07-01T00:00:00.000Z",
          connectorId: "slack",
          id: "slack-primary",
        },
      ],
    });

    expect(
      resolveExplorationSourceInstances("all", deterministicOnly, {
        scheduledOnly: false,
      }),
    ).toEqual([]);
    expect(configHasExplorableSource(deterministicOnly)).toBe(false);
  });
});
