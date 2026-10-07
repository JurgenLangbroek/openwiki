---
name: write-connector
description: Add a new built-in OpenWiki source connector. Use when a user asks to create or implement an OpenWiki connector.
---

# Write An OpenWiki Connector

OpenWiki connectors are built-in TypeScript modules in the OSS repository. Do not create a plugin marketplace, dynamic connector package, or runtime-loaded untrusted connector. Add normal source files and tests.

## Required Shape

- Add the connector to src/connectors/types.ts and src/connectors/registry.ts.
- Add the connector id to CONNECTOR_IDS in src/connectors/registry.ts. The typecheck fails until you do (EveryConnectorIdIsListed).
- Add a case for the connector id to createConnectorSynthesisGuidance in src/ingestion.ts. The switch is exhaustive, so the typecheck fails until you do.
- The compiler does not check the next two. Add the connector id to isKnownConnectorId in src/onboarding.ts, or onboarding silently drops it. Add an entry to SOURCE_OPTIONS in src/credentials.tsx, or the setup wizard never offers it.
- Implement the connector under src/connectors/sources/<connector>.ts.
- The connector must expose a ConnectorRuntime with id, displayName, description, backend, mode, supportsAgenticDiscovery, requiredEnv, and ingest().
- Set mode to "code" only for a connector that pulls runtime evidence about the repository being documented. It runs in every code-mode update (langsmith is the example). Set mode to "personal" for a source that feeds the personal wiki, such as git-repo.
- Declare the connector's posture in the table in src/connectors/posture.ts; the registry stamps it onto the runtime. The table is exhaustive, so a new connector id does not compile until its posture is declared.
- Posture is the live axis: it decides deterministic pull versus agentic exploration. supportsAgenticDiscovery is a required field nothing here reads; set it, but never wire a decision to it.
- Ingestion writes raw JSON/manifests under ~/.openwiki/connectors/<id>/raw/<run-id>/.
- State lives in ~/.openwiki/connectors/<id>/state.json.
- Config lives in ~/.openwiki/connectors/<id>/config.json.
- Secrets live in ~/.openwiki/.env and are referenced only by env var name.

## Security Rules

- Never read, print, log, return, or hardcode secret values.
- Do not store credentials in connector config, raw files, state, logs, or tests.
- Validate connector IDs and raw file paths so reads and writes stay inside ~/.openwiki/connectors/<id>/.
- Use deterministic ingestion code for credentialed external fetching.
- If wrapping MCP, treat the MCP server as read-only and call only allowlisted read/dump operations from connector config.
- Do not let untrusted connector manifests instantiate arbitrary commands or arbitrary network endpoints without explicit built-in code review.

## Ingestion Rules

- Git/local repos should write compact manifests and let the agent inspect the local repo as the source of truth.
- Sources with timestamps should store per-stream cursors.
- Sources with object metadata should store IDs, last edited timestamps, and content hashes.
- Sources with pagination should store enough state to continue without refetching everything.
- Raw dumps should preserve source IDs, timestamps, URLs, authors, and enough provenance for citations.

## User-Facing Finish

When done, tell the user:

- which connector files changed,
- which env vars to set in ~/.openwiki/.env,
- what config file to create or edit,
- how to run openwiki personal --update to trigger ingestion,
- which scopes/permissions the source provider requires.
