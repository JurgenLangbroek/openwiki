import {
  evaluateToolPolicy,
  type PolicyEvaluableTool,
  type ToolPolicyDecision,
  type ToolPolicyRule,
} from "./tool-policy.js";

export type DownstreamToolRef = {
  serverId: string;
  toolName: string;
};

export type DownstreamToolDescriptor = PolicyEvaluableTool & {
  instances?: DownstreamToolInstance[];
  requires_approval?: boolean;
  server_id?: string;
};

export type DownstreamToolInstance = {
  server_id?: string;
};

export type DownstreamToolPolicyRule =
  | ToolPolicyRule
  | "destructive-annotation"
  | "downstream-tool-not-found"
  | "requires-approval";

export type DownstreamToolPolicyDecision = Omit<ToolPolicyDecision, "rule"> & {
  rule: DownstreamToolPolicyRule;
};

export type DownstreamToolPolicyResolution = {
  decision: DownstreamToolPolicyDecision;
  descriptor?: DownstreamToolDescriptor;
};

export type GatewaySkillCatalog = {
  [key: string]: unknown;
  skill_order: string[];
  skills: Record<string, Record<string, unknown>>;
};

const DENIAL_RULE_SEVERITY: Partial<Record<DownstreamToolPolicyRule, number>> =
  {
    "deny-by-default": 1,
    "destructive-annotation": 2,
    "downstream-tool-not-found": 1,
    "requires-approval": 2,
    "write-shaped": 2,
  };

export function resolveDownstreamToolPolicy(input: {
  allowedTools?: string[];
  catalog: unknown;
  ref: DownstreamToolRef;
}): DownstreamToolPolicyResolution {
  return resolveDownstreamToolPolicyFromDescriptors({
    allowedTools: input.allowedTools,
    descriptors: collectToolDescriptors(input.catalog),
    ref: input.ref,
  });
}

export function resolveDownstreamToolPolicyFromDescriptors(input: {
  allowedTools?: string[];
  descriptors: readonly DownstreamToolDescriptor[];
  ref: DownstreamToolRef;
}): DownstreamToolPolicyResolution {
  const descriptors = input.descriptors.filter((candidate) =>
    matchesToolRef(candidate, input.ref),
  );

  if (descriptors.length === 0) {
    return {
      decision: {
        allowed: false,
        reason: `Downstream tool ${input.ref.toolName} for server ${input.ref.serverId} was not found in the gateway skill catalog.`,
        rule: "downstream-tool-not-found",
      },
    };
  }

  const resolutions = descriptors.map((descriptor) => ({
    decision: evaluateDownstreamToolPolicy(descriptor, input.allowedTools),
    descriptor,
  }));

  return resolutions.reduce((mostSevere, resolution) =>
    getDecisionSeverity(resolution.decision) >
    getDecisionSeverity(mostSevere.decision)
      ? resolution
      : mostSevere,
  );
}

function evaluateDownstreamToolPolicy(
  descriptor: DownstreamToolDescriptor,
  allowedTools?: string[],
): DownstreamToolPolicyDecision {
  if (descriptor.annotations?.destructiveHint === true) {
    return {
      allowed: false,
      reason: `Downstream tool ${descriptor.name} has destructiveHint=true in the gateway skill catalog, so it is never callable by the read-only observer.`,
      rule: "destructive-annotation",
    };
  }

  if (descriptor.requires_approval === true) {
    return {
      allowed: false,
      reason: `Downstream tool ${descriptor.name} has requires_approval=true in the gateway skill catalog and needs human sign-off, so it is never callable by the read-only observer.`,
      rule: "requires-approval",
    };
  }

  return evaluateToolPolicy({
    allowedTools,
    endpoint: "gateway",
    tool: descriptor,
  });
}

function getDecisionSeverity(decision: DownstreamToolPolicyDecision): number {
  if (decision.allowed) {
    return 0;
  }

  return DENIAL_RULE_SEVERITY[decision.rule] ?? 1;
}

function matchesToolRef(
  descriptor: DownstreamToolDescriptor,
  ref: DownstreamToolRef,
): boolean {
  return (
    descriptor.name === ref.toolName &&
    (descriptor.server_id === ref.serverId ||
      descriptor.instances?.some(
        (instance) => instance.server_id === ref.serverId,
      ) === true)
  );
}

export function collectToolDescriptors(
  catalog: unknown,
  options: { preserveUnknownFields: true },
): (DownstreamToolDescriptor & Record<string, unknown>)[];
export function collectToolDescriptors(
  catalog: unknown,
  options?: { preserveUnknownFields?: false },
): DownstreamToolDescriptor[];
export function collectToolDescriptors(
  catalog: unknown,
  options: { preserveUnknownFields?: boolean } = {},
): DownstreamToolDescriptor[] {
  const parsedCatalog = readGatewaySkillCatalog(catalog);
  if (parsedCatalog === undefined) {
    return [];
  }

  const descriptors: DownstreamToolDescriptor[] = [];
  const orderedSkillNames = [
    ...new Set([
      ...parsedCatalog.skill_order,
      ...Object.keys(parsedCatalog.skills),
    ]),
  ];
  for (const skillName of orderedSkillNames) {
    const entries = parsedCatalog.skills[skillName];
    if (entries === undefined) {
      continue;
    }

    for (const [entryName, entryValue] of Object.entries(entries)) {
      if (!/^tools\/[^/]+\.json$/u.test(entryName)) {
        continue;
      }

      const descriptor = parseToolDescriptor(
        entryValue,
        options.preserveUnknownFields ?? false,
      );
      if (descriptor !== undefined) {
        descriptors.push(descriptor);
      }
    }
  }

  return descriptors;
}

export function readGatewaySkillCatalog(
  value: unknown,
): GatewaySkillCatalog | undefined {
  const catalog = readRecord(value);
  const skills = readRecordOfRecords(catalog?.skills);
  if (catalog === undefined || skills === undefined) {
    return undefined;
  }

  return {
    ...catalog,
    skill_order: readStringArray(catalog.skill_order),
    skills,
  };
}

function parseToolDescriptor(
  value: unknown,
  preserveUnknownFields: boolean,
): DownstreamToolDescriptor | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  try {
    const parsed = readRecord(JSON.parse(value) as unknown);
    const name = readString(parsed?.name);
    if (parsed === undefined || name === undefined) {
      return undefined;
    }

    const annotations = readRecord(parsed.annotations);
    const description = readString(parsed.description);
    const instances = readToolInstances(
      parsed.instances,
      preserveUnknownFields,
    );
    const requiresApproval = readBoolean(parsed.requires_approval);
    const serverId = readString(parsed.server_id);

    const descriptor: DownstreamToolDescriptor = {
      ...(annotations === undefined ? {} : { annotations }),
      ...(description === undefined ? {} : { description }),
      ...(instances === undefined ? {} : { instances }),
      name,
      ...(requiresApproval === undefined
        ? {}
        : { requires_approval: requiresApproval }),
      ...(serverId === undefined ? {} : { server_id: serverId }),
    };

    if (!preserveUnknownFields) {
      return descriptor;
    }

    const preserved = { ...parsed, ...descriptor };
    deleteInvalidKnownField(preserved, "annotations", annotations);
    deleteInvalidKnownField(preserved, "description", description);
    deleteInvalidKnownField(preserved, "instances", instances);
    deleteInvalidKnownField(preserved, "requires_approval", requiresApproval);
    deleteInvalidKnownField(preserved, "server_id", serverId);
    return preserved;
  } catch {
    return undefined;
  }
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function readToolInstances(
  value: unknown,
  preserveUnknownFields: boolean,
): DownstreamToolInstance[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  return value.map((instance) => {
    const parsed = readRecord(instance);
    const serverId = readString(parsed?.server_id);
    if (!preserveUnknownFields || parsed === undefined) {
      return { server_id: serverId };
    }

    const preserved = { ...parsed, server_id: serverId };
    if (serverId === undefined) {
      delete preserved.server_id;
    }
    return preserved;
  });
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readRecordOfRecords(
  value: unknown,
): Record<string, Record<string, unknown>> | undefined {
  const record = readRecord(value);
  if (record === undefined) {
    return undefined;
  }

  return Object.values(record).every((entry) => readRecord(entry) !== undefined)
    ? (record as Record<string, Record<string, unknown>>)
    : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function deleteInvalidKnownField(
  descriptor: Record<string, unknown>,
  key: string,
  normalizedValue: unknown,
): void {
  if (normalizedValue === undefined) {
    delete descriptor[key];
  }
}
