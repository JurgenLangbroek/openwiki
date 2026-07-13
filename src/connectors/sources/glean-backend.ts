import {
  OPENWIKI_GLEAN_BACKEND_URL_ENV_KEY,
  OPENWIKI_GLEAN_EMAIL_ENV_KEY,
  OPENWIKI_GLEAN_INSTANCE_ENV_KEY,
} from "../../constants.js";
import { loadOpenWikiEnv } from "../../env.js";
import { readConnectorConfig } from "../io.js";

export type GleanBackendInput = {
  backendBaseUrl?: string;
  email?: string;
  instance?: string;
};

export type GleanTarget = {
  backendUrl: string;
  gatewayUrl: string;
  mcpUrl: string;
};

export type GleanTargetConfig = GleanBackendInput & {
  gatewayPath?: string;
  mcpPath?: string;
};

const COMMON_SECOND_LEVEL_PUBLIC_SUFFIX_LABELS = new Set([
  "ac",
  "co",
  "com",
  "edu",
  "gov",
  "net",
  "org",
]);

export function resolveGleanBackendUrl(input: GleanBackendInput): string {
  const backendBaseUrl = input.backendBaseUrl?.trim();

  if (backendBaseUrl) {
    let url: URL;
    try {
      url = new URL(backendBaseUrl);
    } catch {
      throw new Error("Glean backendBaseUrl must be a valid HTTPS URL.");
    }

    if (url.protocol !== "https:") {
      throw new Error("Glean backendBaseUrl must use HTTPS.");
    }

    if (url.username || url.password || url.search || url.hash) {
      throw new Error(
        "Glean backendBaseUrl must not include credentials, query parameters, or a fragment.",
      );
    }

    if (url.pathname !== "/") {
      throw new Error("Glean backendBaseUrl must be an HTTPS origin.");
    }

    return url.origin;
  }

  const instance = input.instance?.trim();
  if (instance) {
    return createGleanBackendUrl(instance);
  }

  const emailInstance = getRegistrableDomainLabel(input.email);
  if (emailInstance) {
    return createGleanBackendUrl(emailInstance);
  }

  throw new Error(
    "Cannot resolve the Glean backend. Set backendBaseUrl, instance, or email in the connector config, or OPENWIKI_GLEAN_BACKEND_URL, OPENWIKI_GLEAN_INSTANCE, or OPENWIKI_GLEAN_EMAIL.",
  );
}

export async function resolveGleanTarget(
  config?: GleanTargetConfig,
): Promise<GleanTarget> {
  await loadOpenWikiEnv();
  const resolvedConfig =
    config ??
    (await readConnectorConfig<GleanTargetConfig>("glean", {
      gatewayPath: "/mcp/gateway/proxy",
      mcpPath: "/mcp/default",
    }));
  const backendUrl = resolveGleanBackendUrl({
    backendBaseUrl: firstNonBlank(
      resolvedConfig.backendBaseUrl,
      process.env[OPENWIKI_GLEAN_BACKEND_URL_ENV_KEY],
    ),
    email: firstNonBlank(
      resolvedConfig.email,
      process.env[OPENWIKI_GLEAN_EMAIL_ENV_KEY],
    ),
    instance: firstNonBlank(
      resolvedConfig.instance,
      process.env[OPENWIKI_GLEAN_INSTANCE_ENV_KEY],
    ),
  });
  const mcpPath = resolvedConfig.mcpPath?.trim() ?? "/mcp/default";
  const gatewayPath =
    resolvedConfig.gatewayPath?.trim() ?? "/mcp/gateway/proxy";

  if (!mcpPath.startsWith("/")) {
    throw new Error("Glean mcpPath must start with /.");
  }
  if (!gatewayPath.startsWith("/")) {
    throw new Error("Glean gatewayPath must start with /.");
  }

  return {
    backendUrl,
    gatewayUrl: `${backendUrl}${gatewayPath}`,
    mcpUrl: `${backendUrl}${mcpPath}`,
  };
}

function createGleanBackendUrl(instance: string): string {
  const normalized = instance.trim().toLowerCase();
  if (
    normalized.length > 63 ||
    !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(normalized)
  ) {
    throw new Error(
      "Glean instance must be a valid DNS label. Set a valid instance or backendBaseUrl.",
    );
  }

  return `https://${normalized}-be.glean.com`;
}

function firstNonBlank(
  preferred: string | undefined,
  fallback: string | undefined,
): string | undefined {
  return preferred?.trim() || fallback;
}

function getRegistrableDomainLabel(email: string | undefined): string | null {
  const domain = email?.trim().toLowerCase().split("@").at(-1);
  const labels = domain?.split(".").filter(Boolean) ?? [];
  if (labels.length < 2) {
    return null;
  }

  const secondLevelLabel = labels.at(-2);
  const topLevelLabel = labels.at(-1);
  const usesCommonCountryCodeSuffix =
    labels.length >= 3 &&
    topLevelLabel?.length === 2 &&
    secondLevelLabel !== undefined &&
    COMMON_SECOND_LEVEL_PUBLIC_SUFFIX_LABELS.has(secondLevelLabel);

  return labels.at(usesCommonCountryCodeSuffix ? -3 : -2) ?? null;
}
