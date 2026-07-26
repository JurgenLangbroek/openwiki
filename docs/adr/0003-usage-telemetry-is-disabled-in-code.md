# Usage telemetry is disabled in code, not configuration

Upstream ships opt-out PostHog telemetry that reports, on `init`, the brain mode, the model provider, and the set of configured connectors — which on this fork includes `glean`. This fork ingests Coolblue-internal work context and has no data-processing agreement covering that egress, so `isTelemetryDisabled()` returns `true` unconditionally instead of relying on `OPENWIKI_TELEMETRY_DISABLED` being present in the environment. That function is upstream's own chokepoint, so no call path can bypass it, and it suppresses the first-run disclosure notice as a side effect.

**Considered options:** setting `OPENWIKI_TELEMETRY_DISABLED=1` in `$OPENWIKI_HOME/.env` was rejected because it fails silently — a fresh machine, a CI runner, or a personal-brain home without the variable ships data with no warning. Pointing telemetry at a Coolblue-owned PostHog was rejected as unjustified effort for data nobody would read.

**Consequences:** the unconditional `return true` reads as dead code and will attract cleanup during future upstream syncs; the comment at the gate names this ADR so the next sync leaves it alone. Upstream's telemetry tests that assert events are sent need fork-local adjustment, and will need it again whenever upstream extends them.
