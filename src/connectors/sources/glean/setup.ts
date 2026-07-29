import {
  OPENWIKI_GLEAN_BACKEND_URL_ENV_KEY,
  OPENWIKI_GLEAN_EMAIL_ENV_KEY,
  OPENWIKI_GLEAN_INSTANCE_ENV_KEY,
} from "../../../constants.js";
import type { AuthProviderId } from "../../../auth/types.js";
import type { ConnectorId } from "../../types.js";
import {
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
 * A retryable setup failure: what to tell the user, and which secret input to
 * send them back to. Structural rather than imported from the wizard, so the
 * dependency runs one way (wizard -> connector).
 */
export type GleanSetupRetry = {
  message: string;
  retryEnvKey: string;
};

/**
 * The subset of the wizard's `SourceSetupOption` this descriptor populates. It is
 * declared here, not imported from `credentials.tsx`, so the connector never
 * depends on the wizard; the wizard's own
 * `satisfies readonly SourceSetupOption[]` on `SOURCE_OPTIONS` is what proves the
 * two shapes still agree, and fails to compile if they drift.
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
  describeAuthFailure: (error: unknown) => GleanSetupRetry | null;
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
 * Translates an authorization failure into a retryable prompt, or null to let the
 * wizard report it generically.
 *
 * `GleanBackendResolutionError` means the backend could not be derived at all, so
 * the user's own input is the fix and the wizard re-prompts for it.
 */
export function describeGleanAuthFailure(
  error: unknown,
): GleanSetupRetry | null {
  if (error instanceof GleanBackendResolutionError) {
    return {
      message: getGleanBackendResolutionRetryMessage(error),
      retryEnvKey: OPENWIKI_GLEAN_EMAIL_ENV_KEY,
    };
  }

  return null;
}

function getGleanBackendResolutionRetryMessage(
  error: GleanBackendResolutionError,
): string {
  return `${error.message} Please re-enter your work email and try again.`;
}
