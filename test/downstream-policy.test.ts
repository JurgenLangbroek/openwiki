import { describe, expect, test } from "vitest";
import { resolveDownstreamToolPolicy } from "../src/connectors/downstream-policy.ts";

describe("downstream gateway tool policy", () => {
  test("allows a downstream tool with a read-only annotation", () => {
    const resolution = resolveDownstreamToolPolicy({
      catalog: createCatalog({
        "jira-default": [
          {
            annotations: { destructiveHint: false, readOnlyHint: true },
            description: "Retrieves a Jira issue by ID or key",
            name: "JIRA_GET_ISSUE",
            server_id: "jira-primary",
          },
        ],
      }),
      ref: { serverId: "jira-primary", toolName: "JIRA_GET_ISSUE" },
    });

    expect(resolution.decision).toMatchObject({
      allowed: true,
      rule: "read-only-annotation",
    });
    expect(resolution.decision.reason).toContain("JIRA_GET_ISSUE");
    expect(resolution.descriptor).toMatchObject({
      annotations: { destructiveHint: false, readOnlyHint: true },
      description: "Retrieves a Jira issue by ID or key",
      name: "JIRA_GET_ISSUE",
    });
  });

  test("allows a downstream tool with a conservatively read-shaped name", () => {
    const resolution = resolveDownstreamToolPolicy({
      catalog: createCatalog({
        "confluence-default": [
          {
            annotations: {},
            name: "CONFLUENCE_GET_PAGE_BY_ID",
            server_id: "confluence-primary",
          },
        ],
      }),
      ref: {
        serverId: "confluence-primary",
        toolName: "CONFLUENCE_GET_PAGE_BY_ID",
      },
    });

    expect(resolution.decision).toMatchObject({
      allowed: true,
      rule: "read-shaped-name",
    });
    expect(resolution.decision.reason).toContain("CONFLUENCE_GET_PAGE_BY_ID");
  });

  test.each(["JIRA_ADD_COMMENT", "CONFLUENCE_CREATE_PAGE"])(
    "denies write-shaped downstream tool %s",
    (toolName) => {
      const resolution = resolveDownstreamToolPolicy({
        catalog: createCatalog({
          default: [{ annotations: {}, name: toolName, server_id: "primary" }],
        }),
        ref: { serverId: "primary", toolName },
      });

      expect(resolution.decision).toMatchObject({
        allowed: false,
        rule: "write-shaped",
      });
      expect(resolution.decision.reason).toContain(toolName);
    },
  );

  test("does not let allowedTools override a write-shaped downstream tool", () => {
    const toolName = "JIRA_ADD_COMMENT";
    const resolution = resolveDownstreamToolPolicy({
      allowedTools: [toolName],
      catalog: createCatalog({
        default: [{ name: toolName, server_id: "jira-primary" }],
      }),
      ref: { serverId: "jira-primary", toolName },
    });

    expect(resolution.decision).toMatchObject({
      allowed: false,
      rule: "write-shaped",
    });
    expect(resolution.decision.reason).toMatch(
      /JIRA_ADD_COMMENT.*allowedTools cannot override/iu,
    );
  });

  test("denies a read-shaped downstream name with a write-shaped description", () => {
    const toolName = "CONFLUENCE_GET_PAGE_BY_ID";
    const resolution = resolveDownstreamToolPolicy({
      catalog: createCatalog({
        default: [
          {
            description: "Update a page and return the new contents.",
            name: toolName,
            server_id: "confluence-primary",
          },
        ],
      }),
      ref: { serverId: "confluence-primary", toolName },
    });

    expect(resolution.decision).toMatchObject({
      allowed: false,
      rule: "write-shaped",
    });
    expect(resolution.decision.reason).toContain(toolName);
  });

  test("allows an allowlisted neutral-shaped downstream tool", () => {
    const toolName = "TENANT_CATALOG";

    const decision = resolveDownstreamToolPolicy({
      allowedTools: [toolName],
      catalog: createCatalog({
        default: [{ name: toolName, server_id: "gateway-primary" }],
      }),
      ref: { serverId: "gateway-primary", toolName },
    }).decision;

    expect(decision).toMatchObject({
      allowed: true,
      rule: "allowlist",
    });
    expect(decision.reason).toContain(toolName);
  });

  test("denies an unclassifiable downstream tool and preserves its descriptor", () => {
    const toolName = "TENANT_CATALOG";
    const resolution = resolveDownstreamToolPolicy({
      catalog: createCatalog({
        default: [
          { annotations: {}, name: toolName, server_id: "gateway-primary" },
        ],
      }),
      ref: { serverId: "gateway-primary", toolName },
    });

    expect(resolution.decision).toMatchObject({
      allowed: false,
      rule: "deny-by-default",
    });
    expect(resolution.descriptor).toMatchObject({
      annotations: {},
      name: toolName,
      server_id: "gateway-primary",
    });
  });

  test.each([
    {
      ref: { serverId: "jira-primary", toolName: "JIRA_GET_PROJECT" },
      scenario: "tool name is absent",
    },
    {
      ref: { serverId: "jira-secondary", toolName: "JIRA_GET_ISSUE" },
      scenario: "tool exists only under a different server",
    },
  ])("denies when the downstream $scenario", ({ ref }) => {
    const resolution = resolveDownstreamToolPolicy({
      catalog: createCatalog({
        default: [
          {
            annotations: { readOnlyHint: true },
            name: "JIRA_GET_ISSUE",
            server_id: "jira-primary",
          },
        ],
      }),
      ref,
    });

    expect(resolution.decision).toMatchObject({
      allowed: false,
      rule: "downstream-tool-not-found",
    });
    expect(resolution.decision.reason).toMatch(
      new RegExp(`${ref.toolName}.*not found.*gateway skill catalog`, "iu"),
    );
    expect(resolution.descriptor).toBeUndefined();
  });

  test("matches a downstream tool through a secondary instance server", () => {
    const toolName = "JIRA_GET_ISSUE";
    const resolution = resolveDownstreamToolPolicy({
      catalog: createCatalog({
        default: [
          {
            annotations: { readOnlyHint: true },
            instances: [
              { dsi_label: "Jira", server_id: "jira-primary" },
              { dsi_label: "Ellis", server_id: "jira-secondary" },
            ],
            name: toolName,
            server_id: "jira-primary",
          },
        ],
      }),
      ref: { serverId: "jira-secondary", toolName },
    });

    expect(resolution.decision).toMatchObject({
      allowed: true,
      rule: "read-only-annotation",
    });
    expect(resolution.descriptor?.instances).toContainEqual({
      server_id: "jira-secondary",
    });
  });

  test("denies a destructive downstream tool despite read-only signals", () => {
    const toolName = "CONFLUENCE_GET_PAGE_BY_ID";
    const resolution = resolveDownstreamToolPolicy({
      catalog: createCatalog({
        default: [
          {
            annotations: { destructiveHint: true, readOnlyHint: true },
            name: toolName,
            server_id: "confluence-primary",
          },
        ],
      }),
      ref: { serverId: "confluence-primary", toolName },
    });

    expect(resolution.decision).toMatchObject({
      allowed: false,
      rule: "destructive-annotation",
    });
    expect(resolution.decision.reason).toMatch(
      /CONFLUENCE_GET_PAGE_BY_ID.*destructiveHint.*never callable.*read-only observer/iu,
    );
  });

  test("denies a downstream tool that requires human approval", () => {
    const toolName = "JIRA_GET_ISSUE";
    const resolution = resolveDownstreamToolPolicy({
      catalog: createCatalog({
        default: [
          {
            annotations: { readOnlyHint: true },
            name: toolName,
            requires_approval: true,
            server_id: "jira-primary",
          },
        ],
      }),
      ref: { serverId: "jira-primary", toolName },
    });

    expect(resolution.decision).toMatchObject({
      allowed: false,
      rule: "requires-approval",
    });
    expect(resolution.decision.reason).toMatch(
      /JIRA_GET_ISSUE.*requires_approval.*human sign-off.*never callable/iu,
    );
    expect(resolution.descriptor?.requires_approval).toBe(true);
  });

  test("uses the most conservative decision across duplicate descriptors", () => {
    const toolName = "JIRA_ISSUE_DETAILS";
    const resolution = resolveDownstreamToolPolicy({
      catalog: createCatalog({
        "jira-unclassified": [
          {
            annotations: {},
            name: toolName,
            server_id: "jira-primary",
          },
        ],
        "jira-write-shaped": [
          {
            description: "Add a comment to the Jira issue.",
            name: toolName,
            server_id: "jira-primary",
          },
        ],
      }),
      ref: { serverId: "jira-primary", toolName },
    });

    expect(resolution.decision).toMatchObject({
      allowed: false,
      rule: "write-shaped",
    });
    expect(resolution.decision.reason).toContain(toolName);
    expect(resolution.descriptor?.description).toBe(
      "Add a comment to the Jira issue.",
    );
  });

  test.each([
    { catalog: null, scenario: "a null catalog" },
    { catalog: {}, scenario: "a catalog without skills" },
    {
      catalog: { skills: { default: "not an object" } },
      scenario: "a non-object skill",
    },
    {
      catalog: {
        skills: { default: { "tools/BROKEN.json": "not valid JSON" } },
      },
      scenario: "an unparseable tool entry",
    },
    {
      catalog: {
        skills: {
          default: {
            "tools/NO_NAME.json": JSON.stringify({ server_id: "primary" }),
          },
        },
      },
      scenario: "a descriptor without a name",
    },
    {
      catalog: {
        skills: {
          default: {
            "tools/NOT_A_STRING.json": {
              name: "NOT_A_STRING",
              server_id: "primary",
            },
          },
        },
      },
      scenario: "a non-string tool entry",
    },
  ])("denies without throwing for $scenario", ({ catalog }) => {
    const toolName = "MISSING_TOOL";
    const resolution = resolveDownstreamToolPolicy({
      catalog,
      ref: { serverId: "primary", toolName },
    });

    expect(resolution.decision).toMatchObject({
      allowed: false,
      rule: "downstream-tool-not-found",
    });
    expect(resolution.decision.reason).toContain(toolName);
  });
});

function createCatalog(
  skills: Record<string, Record<string, unknown>[]>,
): unknown {
  return {
    skill_order: Object.keys(skills),
    skills: Object.fromEntries(
      Object.entries(skills).map(([skillName, descriptors]) => [
        skillName,
        Object.fromEntries(
          descriptors.map((descriptor, index) => {
            const entryName =
              typeof descriptor.name === "string"
                ? descriptor.name
                : String(index);

            return [`tools/${entryName}.json`, JSON.stringify(descriptor)];
          }),
        ),
      ]),
    ),
  };
}
