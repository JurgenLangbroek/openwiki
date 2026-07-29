import { describe, expect, test } from "vitest";
import { validateOAuthEndpointUrl } from "../src/auth/oauth-discovery.ts";
import { AUTH_PROVIDERS } from "../src/auth/providers.ts";
import { GleanBackendResolutionError } from "../src/connectors/sources/glean-backend.ts";
import {
  describeGleanAuthFailure,
  GLEAN_SOURCE_OPTION,
  resolveGleanConnectorConfigAfterAuth,
  validateGleanWorkEmail,
} from "../src/connectors/sources/glean/setup.ts";

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

describe("GLEAN_SOURCE_OPTION", () => {
  test("collects the work email unmasked and authorizes through the Glean provider", () => {
    expect(GLEAN_SOURCE_OPTION.id).toBe("glean");
    expect(GLEAN_SOURCE_OPTION.authProvider).toBe("glean");
    expect(GLEAN_SOURCE_OPTION.secretInputs).toEqual([
      { envKey: "OPENWIKI_GLEAN_EMAIL", label: "Work email", secret: false },
    ]);
  });

  test("validates the work email input itself, so the wizard needs no Glean branch", () => {
    // The descriptor is the seam: the wizard calls validateSecretInput for
    // whichever source is selected and never names Glean.
    expect(
      GLEAN_SOURCE_OPTION.validateSecretInput?.(
        "OPENWIKI_GLEAN_EMAIL",
        "j@localhost",
      ),
    ).toMatch(/Cannot resolve the Glean backend/u);
    expect(
      GLEAN_SOURCE_OPTION.validateSecretInput?.(
        "OPENWIKI_GLEAN_EMAIL",
        "j@acme.example",
      ),
    ).toBeNull();
  });

  test("has no opinion about another source's secret input", () => {
    expect(
      GLEAN_SOURCE_OPTION.validateSecretInput?.(
        "OPENWIKI_TAVILY_API_KEY",
        "not-an-email",
      ),
    ).toBeNull();
  });
});

describe("resolveGleanConnectorConfigAfterAuth", () => {
  test("records the work email the backend was resolved from", () => {
    expect(
      resolveGleanConnectorConfigAfterAuth({
        OPENWIKI_GLEAN_EMAIL: "  j@acme.example  ",
      }),
    ).toEqual({ email: "j@acme.example" });
  });

  test("records nothing when no work email was entered", () => {
    expect(resolveGleanConnectorConfigAfterAuth({})).toBeUndefined();
    expect(
      resolveGleanConnectorConfigAfterAuth({ OPENWIKI_GLEAN_EMAIL: "   " }),
    ).toBeUndefined();
  });
});

describe("describeGleanAuthFailure", () => {
  test("sends an unresolvable backend back to the work email prompt", () => {
    expect(
      describeGleanAuthFailure(
        new GleanBackendResolutionError("Cannot resolve the Glean backend."),
      ),
    ).toEqual({
      message:
        "Cannot resolve the Glean backend. Please re-enter your work email and try again.",
      retryEnvKey: "OPENWIKI_GLEAN_EMAIL",
    });
  });

  test("translates a refused OAuth endpoint host into its actual remedy", () => {
    // ADR-0005 confines Glean's OAuth endpoints to glean.com and names this step
    // as the place to translate the refusal, which otherwise reaches the user as
    // a bare "MCP protected resource URL host is not allowed." The error is
    // produced here by the real validator with Glean's real allowed-host list, so
    // a reworded upstream refusal fails this test rather than silently
    // un-translating the message.
    let refusal: unknown;
    try {
      validateOAuthEndpointUrl(
        "https://glean.acme.example/mcp/default",
        "MCP protected resource URL",
        { allowedHosts: AUTH_PROVIDERS.glean.oauthAllowedHosts },
      );
    } catch (error) {
      refusal = error;
    }

    const described = describeGleanAuthFailure(refusal);

    expect(described?.retryEnvKey).toBe("OPENWIKI_GLEAN_EMAIL");
    expect(described?.message).toContain("glean.com");
    expect(described?.message).toContain("OPENWIKI_GLEAN_BACKEND_URL");
    expect(described?.message).toContain("oauthAllowedHosts");
    expect(described?.message).toMatch(/re-enter your work email/u);
  });

  test("translates the refusal under every endpoint label it can be raised with", () => {
    // validateOAuthEndpointUrl raises the same refusal for each endpoint it
    // checks, and which one fires first depends on the tenant's metadata, so the
    // translation keys on the shared suffix rather than one label.
    for (const label of [
      "MCP protected resource URL",
      "MCP protected resource metadata",
      "OAuth authorization server issuer",
      "OAuth authorization server metadata",
      "token endpoint",
    ]) {
      expect(
        describeGleanAuthFailure(new Error(`${label} host is not allowed.`)),
      ).not.toBeNull();
    }
  });

  test("leaves a different endpoint refusal to the wizard's generic report", () => {
    // Same validator, different cause: nothing about the work email fixes an
    // endpoint served over http, so re-prompting for it would be misleading.
    expect(
      describeGleanAuthFailure(
        new Error("MCP protected resource URL must use https."),
      ),
    ).toBe(null);
  });

  test("leaves an unrelated authorization failure to the wizard's generic report", () => {
    expect(describeGleanAuthFailure(new Error("Network request failed."))).toBe(
      null,
    );
    expect(describeGleanAuthFailure("not an error")).toBe(null);
  });
});
