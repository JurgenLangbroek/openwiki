import {
  OPENWIKI_GLEAN_BACKEND_URL_ENV_KEY,
  OPENWIKI_GLEAN_EMAIL_ENV_KEY,
  OPENWIKI_GLEAN_INSTANCE_ENV_KEY,
} from "../../../constants.js";
import type { AuthProviderId } from "../../../auth/types.js";
import type { ConnectorId } from "../../types.js";
import {
  GLEAN_REGISTRABLE_DOMAIN,
  GleanBackendResolutionError,
  resolveGleanBackendUrl,
} from "../glean-backend.js";

/**
 * Everything the setup wizard needs to know about connecting Glean, owned by the
 * Glean connector rather than by `src/credentials.tsx`.
 *
 * The wizard changed by 2227 lines in the 2026-07 upstream sync and the fork's
 * 126 inline Glean lines produced six of that merge's conflicts, so ADR-0004
 * fixes the seam: connector-specific wizard logic lives in
 * `sources/<connector>/setup.ts` — upstream's own convention for its LangSmith
 * connector — and the wizard gains only an import and a source-option entry.
 * Nothing here imports the wizard, and nothing here knows about Ink: the
 * descriptor is data, and the three hooks are pure functions over an env bag and
 * a caught error.
 *
 * The rest of the Glean connector is still the flat pair `../glean.ts` and
 * `../glean-backend.ts`; decomposing that 2200-line module into this directory is
 * a separate ticket, so only the setup module lives here for now.
 */

/**
 * What to tell the user about a setup failure, and — only when re-entering it can
 * actually clear the failure — which secret input to send them back to. Absent
 * `retryEnvKey` means the remedy is not reachable from the wizard: report the
 * message where the failure happened rather than bouncing the user to an input
 * that cannot fix it. Structural rather than imported from the wizard, so the
 * dependency runs one way (wizard -> connector).
 */
export type GleanAuthFailureReport = {
  message: string;
  retryEnvKey?: string;
};

/**
 * The subset of the wizard's `SourceSetupOption` this descriptor populates. It is
 * declared here, not imported from `credentials.tsx`, so the connector never
 * depends on the wizard.
 *
 * Two separate `satisfies` clauses in the wizard keep the duplicated shape honest,
 * and it is worth knowing which does what. `SOURCE_OPTIONS`'
 * `satisfies readonly SourceSetupOption[]` catches a field whose *type* drifts —
 * including the return types of the hooks below. It does **not** catch a hook that
 * is renamed or missing, because the hooks are optional there and TypeScript's
 * excess-property check does not apply to an identifier. The narrower
 * `satisfies Required<Pick<SourceSetupOption, …>>` on this descriptor's entry in
 * that array is what closes that gap; it is load-bearing, not decoration, and
 * mutation-tested from both sides.
 *
 * Neither can prove the wizard still *calls* a hook — no type does. That is
 * unpinned: the wizard component is not rendered by any test.
 */
interface GleanSourceOption {
  // `Extract` rather than the bare union: it proves "glean" is a real
  // ConnectorId/AuthProviderId while keeping the literal type, so splicing this
  // descriptor into the wizard's source list does not widen the list's inferred
  // element types and ripple into everything that narrows on `source.id`.
  authProvider: Extract<AuthProviderId, "glean">;
  displayName: string;
  examples: string[];
  id: Extract<ConnectorId, "glean">;
  instructions: string[];
  secretInputs: { envKey: string; label: string; secret: boolean }[];
  validateSecretInput: (envKey: string, value: string) => string | null;
  resolveConnectorConfigAfterAuth: () => Record<string, unknown> | undefined;
  describeAuthFailure: (error: unknown) => GleanAuthFailureReport | null;
}

/**
 * Glean's entry in the wizard's ordered source list. The wizard splices this into
 * `SOURCE_OPTIONS` and drives everything Glean-specific through the three hooks,
 * so it never tests `source.id === "glean"`.
 */
export const GLEAN_SOURCE_OPTION: GleanSourceOption = {
  authProvider: "glean",
  describeAuthFailure: describeGleanAuthFailure,
  displayName: "Glean (work context)",
  examples: [
    "Track active projects, teams, and decisions across my work context.",
    "Follow important tickets and docs connected to current work.",
  ],
  id: "glean",
  instructions: [
    "Enter your work email so OpenWiki can resolve your company's Glean backend from its domain.",
    "No client ID or client secret is needed because OpenWiki self-registers via OAuth.",
    "Approve access in the browser window when it opens.",
  ],
  resolveConnectorConfigAfterAuth: () => resolveGleanConnectorConfigAfterAuth(),
  secretInputs: [
    {
      envKey: OPENWIKI_GLEAN_EMAIL_ENV_KEY,
      label: "Work email",
      secret: false,
    },
  ],
  validateSecretInput: (envKey, value) =>
    envKey === OPENWIKI_GLEAN_EMAIL_ENV_KEY
      ? validateGleanWorkEmail(value)
      : null,
};

/**
 * Whether the entered work email resolves a Glean backend, as the message to show
 * or null when it does. The email's registrable domain label is what names the
 * instance (`acme.example` -> `acme-be.glean.com`), so an unresolvable value is a
 * question for the user rather than an error to crash on — the wizard re-prompts.
 * An `OPENWIKI_GLEAN_BACKEND_URL` or `OPENWIKI_GLEAN_INSTANCE` already in the
 * environment resolves the backend on its own, so it makes any email acceptable.
 */
export function validateGleanWorkEmail(
  email: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  try {
    resolveGleanBackendUrl({
      backendBaseUrl: env[OPENWIKI_GLEAN_BACKEND_URL_ENV_KEY],
      email: email.trim(),
      instance: env[OPENWIKI_GLEAN_INSTANCE_ENV_KEY],
    });
    return null;
  } catch (error) {
    if (error instanceof GleanBackendResolutionError) {
      return getGleanBackendResolutionRetryMessage(error);
    }

    throw error;
  }
}

/**
 * The connector config to record after Glean authorizes: the work email, so a
 * later Pull resolves the same backend the user authorized against without
 * depending on the env var still being set. Undefined when no email was entered
 * (an instance or backend-URL override authorized instead), which leaves the
 * connector config alone.
 */
export function resolveGleanConnectorConfigAfterAuth(
  env: NodeJS.ProcessEnv = process.env,
): { email: string } | undefined {
  const email = env[OPENWIKI_GLEAN_EMAIL_ENV_KEY]?.trim();

  return email ? { email } : undefined;
}

/**
 * Explains an authorization failure, and says whether re-entering a secret input
 * can clear it. Null leaves the failure to the wizard's generic report.
 *
 * Two failures are worth explaining, they arrive from different places, and
 * crucially only one of them is the user's to fix here.
 *
 * `GleanBackendResolutionError` means the backend could not be derived at all, so
 * the work email genuinely is the fix and this one re-prompts for it.
 *
 * A refused endpoint host means the backend resolved but sits off Glean's
 * registrable domain, which ADR-0005 makes a deliberate refusal whose remedy is a
 * code change. Untranslated it reaches the user as a bare
 * "MCP protected resource URL host is not allowed.", naming the cause and not the
 * remedy — but it names **no retry target**, because re-entering the work email
 * provably cannot clear it: an off-domain host is only reachable through
 * `OPENWIKI_GLEAN_BACKEND_URL` or a connector-config `backendBaseUrl`, and
 * `resolveGleanBackendUrl` returns on that override before it ever reads the
 * email. Naming the email anyway bounced the user between the authorize and
 * secret-input steps with no exit. Both remedies the message gives live outside
 * the wizard, so the failure is reported where it happened.
 *
 * Everything else is left to the generic report, including the same validator's
 * other refusals — no work email fixes an endpoint served over http either.
 *
 * The host refusal is a plain `Error` from upstream's `validateOAuthEndpointUrl`,
 * raised under whichever of several endpoint labels the tenant's metadata reaches
 * first, so it is recognised by the suffix all of them share rather than by any
 * one label. A test drives the real validator and feeds its error through here,
 * so a reworded upstream message fails that test instead of silently
 * un-translating this.
 */
export function describeGleanAuthFailure(
  error: unknown,
): GleanAuthFailureReport | null {
  if (error instanceof GleanBackendResolutionError) {
    return {
      message: getGleanBackendResolutionRetryMessage(error),
      retryEnvKey: OPENWIKI_GLEAN_EMAIL_ENV_KEY,
    };
  }

  if (isRefusedEndpointHostError(error)) {
    return {
      message: `Glean's OAuth endpoints must be on ${GLEAN_REGISTRABLE_DOMAIN}, and this deployment's are not. Clear ${OPENWIKI_GLEAN_BACKEND_URL_ENV_KEY} to use your instance's ${GLEAN_REGISTRABLE_DOMAIN} backend, or add your custom domain to the Glean provider's oauthAllowedHosts in src/auth/providers.ts.`,
    };
  }

  return null;
}

function isRefusedEndpointHostError(error: unknown): boolean {
  return (
    error instanceof Error && / host is not allowed\.$/u.test(error.message)
  );
}

function getGleanBackendResolutionRetryMessage(
  error: GleanBackendResolutionError,
): string {
  return `${error.message} Please re-enter your work email and try again.`;
}
