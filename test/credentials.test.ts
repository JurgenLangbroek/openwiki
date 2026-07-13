import { afterEach, describe, expect, test } from "vitest";
import {
  getTemplateSourceOptions,
  needsCredentialSetup,
  validateGleanWorkEmail,
} from "../src/credentials.tsx";

const ENV_KEYS = [
  "LANGSMITH_API_KEY",
  "OPENROUTER_API_KEY",
  "OPENWIKI_MODEL_ID",
  "OPENWIKI_PROVIDER",
] as const;

const originalEnv = new Map<string, string | undefined>(
  ENV_KEYS.map((key) => [key, process.env[key]]),
);

afterEach(() => {
  for (const key of ENV_KEYS) {
    const originalValue = originalEnv.get(key);

    if (originalValue === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = originalValue;
    }
  }
});

describe("needsCredentialSetup", () => {
  test("requires provider setup for an invalid configured provider", () => {
    process.env.OPENWIKI_PROVIDER = "bogus";
    process.env.OPENROUTER_API_KEY = "sk-or-v1-placeholder";
    process.env.OPENWIKI_MODEL_ID = "z-ai/glm-5.2";
    process.env.LANGSMITH_API_KEY = "lsv2_placeholder";

    expect(needsCredentialSetup()).toBe(true);
  });
});

describe("validateGleanWorkEmail", () => {
  test("accepts a work email with a resolvable company domain", () => {
    expect(validateGleanWorkEmail("j@acme.example", {})).toBeNull();
  });

  test("returns actionable guidance for an unresolvable email", () => {
    expect(validateGleanWorkEmail("j@localhost", {})).toMatch(
      /Cannot resolve the Glean backend.*re-enter your work email/u,
    );
  });

  test("accepts an email when the Glean instance override resolves the backend", () => {
    expect(
      validateGleanWorkEmail("j@localhost", {
        OPENWIKI_GLEAN_INSTANCE: "acme",
      }),
    ).toBeNull();
  });
});

describe("personal onboarding sources", () => {
  test("offers Glean", () => {
    expect(
      getTemplateSourceOptions("personal").map((source) => source.id),
    ).toContain("glean");
  });

  test("shows the Glean work email while it is entered", () => {
    const sourceOptions = getTemplateSourceOptions("personal");
    const glean = sourceOptions.find((source) => source.id === "glean");

    expect(glean?.secretInputs).toEqual([
      {
        envKey: "OPENWIKI_GLEAN_EMAIL",
        label: "Work email",
        secret: false,
      },
    ]);
    expect(
      sourceOptions.flatMap((source) =>
        source.secretInputs
          .filter((input) => input.secret === false)
          .map((input) => ({ envKey: input.envKey, sourceId: source.id })),
      ),
    ).toEqual([{ envKey: "OPENWIKI_GLEAN_EMAIL", sourceId: "glean" }]);
  });
});
