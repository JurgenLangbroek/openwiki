import ciInfo from "ci-info";

/**
 * Always true in this fork: usage telemetry is disabled in code, not
 * configuration. See docs/adr/0003-usage-telemetry-is-disabled-in-code.md.
 *
 * Upstream reads `OPENWIKI_TELEMETRY_DISABLED` and `DO_NOT_TRACK` here and
 * otherwise sends. This fork ingests Coolblue-internal work context and has no
 * data-processing agreement covering that egress, so opting out through the
 * environment is not enough — a fresh machine, a scheduled run, or a Brain Wiki
 * home without the variable would ship data with no warning. The variables are
 * therefore not consulted at all; re-enabling telemetry is a deliberate edit to
 * this function.
 *
 * This is upstream's own chokepoint: `recordRun` consults it before resolving an
 * identity or building an event, and `noticeSuppressed()` below derives from it,
 * so the same line stops the sending and the first-run disclosure prompt for
 * something already off.
 *
 * The unconditional `return true` reads as dead code and will attract cleanup at
 * the next upstream sync — that is what the ADR reference above is for. It, and
 * the behaviour, are pinned by test/telemetry-disabled.test.ts, which lives
 * outside this upstream-owned file on purpose.
 */
export function isTelemetryDisabled(): boolean {
  return true;
}

/**
 * True in CI / scheduled contexts. CI runs are still captured, but tagged
 * `execution: "ci"` and sent under the sentinel id so they never inflate human
 * install counts. Detection is delegated to `ci-info`. `OPENWIKI_SCHEDULED` is
 * an explicit escape hatch for our own automation.
 */
export function isCiEnvironment(): boolean {
  return ciInfo.isCI || isTruthyEnv(process.env.OPENWIKI_SCHEDULED);
}

/**
 * Fixed distinct id for CI runs, namespaced by provider (e.g. "ci-github-actions").
 * Deliberately NOT unique: collapsing every CI run to one id per provider keeps
 * ephemeral runners from exploding the distinct count.
 */
export function ciSentinelId(): string {
  const provider = ciInfo.name
    ? ciInfo.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/gu, "-")
        .replace(/(^-|-$)/gu, "")
    : "unknown";

  return `ci-${provider}`;
}

/**
 * Whether the first-run notice is suppressed. Distinct from the send gate the
 * notice is skipped in CI, but events are still sent in CI. Only an explicit
 * opt-out stops sending.
 *
 * The paragraph above describes upstream. In this fork the opt-out limb is
 * unconditionally true, so the notice never shows and no event is ever sent,
 * in CI or out of it. See `isTelemetryDisabled()` above and
 * docs/adr/0003-usage-telemetry-is-disabled-in-code.md.
 */
export function noticeSuppressed(): boolean {
  return isTelemetryDisabled() || isCiEnvironment();
}

/**
 * True when running the compiled, published build (from `dist/`); false when
 * running from source (`src/` via tsx, or under vitest). Stamped on every event
 * as `production` so real installed-package usage can be separated from local
 * dev/test runs. Deliberately based on build origin, not `NODE_ENV` — that var
 * is common in developers' own shells and would misclassify real users.
 */
export function isProductionBuild(): boolean {
  return import.meta.url.includes("/dist/");
}

/**
 * Treats "0", "false", and "" as not set; any other value as truthy.
 */
function isTruthyEnv(value?: string): boolean {
  if (value === undefined) {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return normalized !== "" && normalized !== "0" && normalized !== "false";
}
