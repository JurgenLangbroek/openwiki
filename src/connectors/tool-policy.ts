export type ToolPolicyRule =
  | "allowlist"
  | "deny-by-default"
  | "read-only-annotation"
  | "read-shaped-name"
  | "write-shaped";

export type ToolPolicyDecision = {
  allowed: boolean;
  reason: string;
  rule: ToolPolicyRule;
};

export type PolicyEvaluableTool = {
  annotations?: Record<string, unknown>;
  description?: string;
  name: string;
};

export type ToolWithPolicy<T extends PolicyEvaluableTool> = T & {
  policy: ToolPolicyDecision;
};

const MUTATING_WORD_PATTERN =
  /\b(create|update|delete|archive|restore|move|patch|insert|append|comment|invite|share|upload|write|edit|send|add|remove|execute|run|submit|post|put|set|publish|modify|trigger|apply|merge|push|assign|cancel|start|stop)\b/iu;
const READ_WORD_PATTERN =
  /\b(search|retrieve|get|list|query|read|fetch|find|lookup|load|children)\b/iu;

export function evaluateToolPolicy(input: {
  allowedTools?: string[];
  tool: PolicyEvaluableTool;
}): ToolPolicyDecision {
  if (input.allowedTools?.includes(input.tool.name)) {
    return {
      allowed: true,
      reason: `MCP tool ${input.tool.name} is explicitly classified as safe by allowedTools in the local connector config.`,
      rule: "allowlist",
    };
  }

  const normalizedToolText = normalizeToolText(
    `${input.tool.name} ${input.tool.description ?? ""}`,
  );
  if (MUTATING_WORD_PATTERN.test(normalizedToolText)) {
    return {
      allowed: false,
      reason: `MCP tool ${input.tool.name} is write-shaped and is never callable under the read-only-observer policy. Only an explicit allowedTools entry in the local connector config can classify it otherwise.`,
      rule: "write-shaped",
    };
  }

  if (input.tool.annotations?.readOnlyHint === true) {
    return {
      allowed: true,
      reason: `MCP tool ${input.tool.name} is allowed by its MCP readOnlyHint annotation.`,
      rule: "read-only-annotation",
    };
  }

  if (READ_WORD_PATTERN.test(normalizeToolText(input.tool.name))) {
    return {
      allowed: true,
      reason: `MCP tool ${input.tool.name} is allowed because its name is conservatively read-shaped.`,
      rule: "read-shaped-name",
    };
  }

  return {
    allowed: false,
    reason: `MCP tool ${input.tool.name} is not classified as read-only. Add it to allowedTools in the local connector config only if it is safe for ingestion.`,
    rule: "deny-by-default",
  };
}

export function annotateToolsWithPolicy<T extends PolicyEvaluableTool>(
  tools: T[],
  allowedTools?: string[],
): ToolWithPolicy<T>[] {
  return tools.map((tool) => ({
    ...tool,
    policy: evaluateToolPolicy({ allowedTools, tool }),
  }));
}

function normalizeToolText(text: string): string {
  return text
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .replace(/[_./:#?=&-]+/gu, " ");
}
