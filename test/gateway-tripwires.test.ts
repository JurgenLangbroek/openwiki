import { describe, expect, test } from "vitest";
import {
  createGatewayTripwireState,
  DEFAULT_GATEWAY_READ_SANITY_CEILING,
  GatewayRepeatReadError,
  GatewaySanityCeilingError,
  registerGatewayRead,
} from "../src/connectors/gateway-tripwires.ts";

describe("Gateway Datasource Read tripwires", () => {
  test("refuses a repeat read when nested argument keys are reordered", () => {
    const state = createGatewayTripwireState();

    registerGatewayRead(state, {
      args: { fields: { assignee: true, summary: true }, issueKey: "OW-35" },
      serverId: "jira-primary",
      toolName: "JIRA_GET_ISSUE",
    });

    expect(() =>
      registerGatewayRead(state, {
        args: { issueKey: "OW-35", fields: { summary: true, assignee: true } },
        serverId: "jira-primary",
        toolName: "JIRA_GET_ISSUE",
      }),
    ).toThrow(GatewayRepeatReadError);
    expect(() =>
      registerGatewayRead(state, {
        args: { fields: { assignee: true, summary: true }, issueKey: "OW-35" },
        serverId: "jira-primary",
        toolName: "JIRA_GET_ISSUE",
      }),
    ).toThrow(/repeat Gateway Datasource Read.*not new information/iu);
  });

  test("allows distinct arguments for the same downstream tool", () => {
    const state = createGatewayTripwireState();

    expect(() =>
      registerGatewayRead(state, {
        args: { issueKey: "OW-35" },
        serverId: "jira-primary",
        toolName: "JIRA_GET_ISSUE",
      }),
    ).not.toThrow();
    expect(() =>
      registerGatewayRead(state, {
        args: { issueKey: "OW-36" },
        serverId: "jira-primary",
        toolName: "JIRA_GET_ISSUE",
      }),
    ).not.toThrow();
  });

  test("does not consume ceiling budget for a refused repeat", () => {
    const state = createGatewayTripwireState({ sanityCeiling: 2 });
    const firstRead = {
      args: { issueKey: "OW-35" },
      serverId: "jira-primary",
      toolName: "JIRA_GET_ISSUE",
    };

    registerGatewayRead(state, firstRead);
    expect(() => registerGatewayRead(state, firstRead)).toThrow(
      GatewayRepeatReadError,
    );

    expect(() =>
      registerGatewayRead(state, {
        ...firstRead,
        args: { issueKey: "OW-36" },
      }),
    ).not.toThrow();
  });

  test("fails loudly with the configured ceiling and latches", () => {
    const state = createGatewayTripwireState({ sanityCeiling: 2 });
    for (const issueKey of ["OW-35", "OW-36"]) {
      registerGatewayRead(state, {
        args: { issueKey },
        serverId: "jira-primary",
        toolName: "JIRA_GET_ISSUE",
      });
    }

    const tripped = captureError(() =>
      registerGatewayRead(state, {
        args: { issueKey: "OW-37" },
        serverId: "jira-primary",
        toolName: "JIRA_GET_ISSUE",
      }),
    );

    expect(tripped).toBeInstanceOf(GatewaySanityCeilingError);
    expect(tripped).toMatchObject({ rule: "sanity-ceiling" });
    expect(tripped.message).toMatch(
      /sanity ceiling of 2.*failing loudly.*instead of trimming silently/iu,
    );

    expect(() =>
      registerGatewayRead(state, {
        args: { issueKey: "OW-35" },
        serverId: "jira-primary",
        toolName: "JIRA_GET_ISSUE",
      }),
    ).toThrow(tripped);
  });

  test("uses a default sanity ceiling far above a plausible run", () => {
    expect(DEFAULT_GATEWAY_READ_SANITY_CEILING).toBe(1_000);
    expect(createGatewayTripwireState().sanityCeiling).toBe(1_000);
    expect(createGatewayTripwireState({ sanityCeiling: 7 }).sanityCeiling).toBe(
      7,
    );
  });
});

function captureError(action: () => void): Error {
  try {
    action();
  } catch (error) {
    if (error instanceof Error) {
      return error;
    }
    throw error;
  }

  throw new Error("Expected action to throw.");
}
