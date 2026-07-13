import { describe, expect, test } from "vitest";
import {
  annotateToolsWithPolicy,
  evaluateToolPolicy,
} from "../src/connectors/tool-policy.ts";

describe("MCP tool policy", () => {
  test("annotates every discovered tool with its policy decision", () => {
    const tools = annotateToolsWithPolicy(
      [
        { inputSchema: { type: "object" }, name: "search_documents" },
        { description: "Create a page.", name: "page_action" },
      ],
      [],
    );

    expect(tools).toHaveLength(2);
    expect(tools[0]?.inputSchema).toEqual({ type: "object" });
    expect(tools[0]?.policy.allowed).toBe(true);
    expect(tools[0]?.policy.rule).toBe("read-shaped-name");
    expect(tools[1]?.description).toBe("Create a page.");
    expect(tools[1]?.policy.allowed).toBe(false);
    expect(tools[1]?.policy.rule).toBe("write-shaped");
  });

  test("allows an explicitly allowlisted unshaped tool", () => {
    expect(
      evaluateToolPolicy({ allowedTools: ["chat"], tool: { name: "chat" } }),
    ).toMatchObject({
      allowed: true,
      rule: "allowlist",
    });
  });

  test("denies an unknown tool with no read-only signals", () => {
    expect(evaluateToolPolicy({ tool: { name: "chat" } })).toMatchObject({
      allowed: false,
      rule: "deny-by-default",
    });
  });

  test("denies a write-shaped tool name", () => {
    expect(evaluateToolPolicy({ tool: { name: "create_page" } })).toMatchObject(
      {
        allowed: false,
        rule: "write-shaped",
      },
    );
  });

  test("allows a strict read-only annotation", () => {
    expect(
      evaluateToolPolicy({
        tool: { annotations: { readOnlyHint: true }, name: "chat" },
      }),
    ).toMatchObject({
      allowed: true,
      rule: "read-only-annotation",
    });
  });

  test.each(["search_documents", "read_document"])(
    "allows read-shaped tool name %s",
    (name) => {
      expect(evaluateToolPolicy({ tool: { name } })).toMatchObject({
        allowed: true,
        rule: "read-shaped-name",
      });
    },
  );

  test("allows a camelCase read-shaped tool name", () => {
    expect(
      evaluateToolPolicy({ tool: { name: "searchDocuments" } }),
    ).toMatchObject({
      allowed: true,
      rule: "read-shaped-name",
    });
  });

  test("denies a write-shaped name despite a read-only annotation", () => {
    expect(
      evaluateToolPolicy({
        tool: {
          annotations: { readOnlyHint: true },
          name: "create_page",
        },
      }),
    ).toMatchObject({
      allowed: false,
      rule: "write-shaped",
    });
  });

  test("denies a camelCase write-shaped name despite a read-only annotation", () => {
    expect(
      evaluateToolPolicy({
        tool: {
          annotations: { readOnlyHint: true },
          name: "createPage",
        },
      }),
    ).toMatchObject({
      allowed: false,
      rule: "write-shaped",
    });
  });

  test("denies a name with conflicting read and write shapes", () => {
    expect(
      evaluateToolPolicy({ tool: { name: "search_and_update_page" } }),
    ).toMatchObject({
      allowed: false,
      rule: "write-shaped",
    });
  });

  test("denies a read-shaped name containing an execute token", () => {
    expect(
      evaluateToolPolicy({ tool: { name: "load_and_execute" } }),
    ).toMatchObject({
      allowed: false,
      rule: "write-shaped",
    });
  });

  test("denies a read-named tool with a write-shaped description", () => {
    expect(
      evaluateToolPolicy({
        tool: {
          description: "Create a new page from the search results.",
          name: "search_documents",
        },
      }),
    ).toMatchObject({
      allowed: false,
      rule: "write-shaped",
    });
  });

  test("does not grant access from a read-shaped description", () => {
    expect(
      evaluateToolPolicy({
        tool: { description: "Search all documents.", name: "chat" },
      }),
    ).toMatchObject({
      allowed: false,
      rule: "deny-by-default",
    });
  });

  test("allows an explicitly allowlisted write-shaped tool", () => {
    expect(
      evaluateToolPolicy({
        allowedTools: ["create_page"],
        tool: { name: "create_page" },
      }),
    ).toMatchObject({
      allowed: true,
      rule: "allowlist",
    });
  });

  test("denies an allowlisted write-shaped gateway tool", () => {
    const decision = evaluateToolPolicy({
      allowedTools: ["jira_add_comment"],
      endpoint: "gateway",
      tool: { name: "jira_add_comment" },
    });

    expect(decision).toMatchObject({
      allowed: false,
      rule: "write-shaped",
    });
    expect(decision.reason).toMatch(
      /write-shaped gateway tools.*never callable.*allowedTools.*cannot override.*read-only-observer policy/iu,
    );
  });

  test("allows an allowlisted neutral-shaped gateway tool", () => {
    expect(
      evaluateToolPolicy({
        allowedTools: ["tenant_catalog"],
        endpoint: "gateway",
        tool: { name: "tenant_catalog" },
      }),
    ).toMatchObject({
      allowed: true,
      rule: "allowlist",
    });
  });

  test.each(["yes", 1])(
    "does not grant access for non-boolean readOnlyHint %j",
    (readOnlyHint) => {
      expect(
        evaluateToolPolicy({
          tool: { annotations: { readOnlyHint }, name: "chat" },
        }),
      ).toMatchObject({
        allowed: false,
        rule: "deny-by-default",
      });
    },
  );

  test("matches read-shaped names case-insensitively", () => {
    expect(
      evaluateToolPolicy({ tool: { name: "Search_Documents" } }),
    ).toMatchObject({
      allowed: true,
      rule: "read-shaped-name",
    });
  });

  test("does not match get inside widget", () => {
    expect(evaluateToolPolicy({ tool: { name: "widget" } })).toMatchObject({
      allowed: false,
      rule: "deny-by-default",
    });
  });

  test("recognizes lookup as a separate read-shaped name token", () => {
    expect(
      evaluateToolPolicy({ tool: { name: "widget_lookup" } }),
    ).toMatchObject({
      allowed: true,
      rule: "read-shaped-name",
    });
  });

  test.each([
    {
      input: { tool: { name: "chat" } },
      name: "chat",
    },
    {
      input: { tool: { name: "create_page" } },
      name: "create_page",
    },
  ])("explains how to classify denied tool $name", ({ input, name }) => {
    const decision = evaluateToolPolicy(input);

    expect(decision.reason).toContain(name);
    expect(decision.reason).toContain("allowedTools");
  });

  test.each([
    {
      allowedTools: ["chat"],
      tool: { name: "chat" },
    },
    {
      tool: { annotations: { readOnlyHint: true }, name: "chat" },
    },
    {
      tool: { name: "search_documents" },
    },
  ])("mentions the tool name in allowed decision reasons", (input) => {
    expect(evaluateToolPolicy(input).reason).toContain(input.tool.name);
  });
});
