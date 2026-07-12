# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

<!-- OPENWIKI:START -->

## OpenWiki

This repository uses OpenWiki for recurring code documentation. Start with `openwiki/quickstart.md`, then follow its links to architecture, workflows, domain concepts, operations, integrations, testing guidance, and source maps.

The scheduled OpenWiki GitHub Actions workflow refreshes the repository wiki. Do not hand-edit generated OpenWiki pages unless explicitly asked; prefer updating source code/docs and letting OpenWiki regenerate.

<!-- OPENWIKI:END -->

## Commands

```sh
pnpm install            # install dependencies
pnpm test               # run the Vitest suite
pnpm vitest run test/env.test.ts   # run a single test file
pnpm typecheck          # tsc --noEmit
pnpm lint:check         # eslint (pnpm lint to autofix)
pnpm format:check       # prettier (pnpm format to write)
pnpm build              # compile to dist/ (cleans first)
pnpm dev                # run the CLI from source via tsx
```

Run `pnpm format`, `pnpm lint`, and `pnpm test` before opening a PR — they match CI (`.github/workflows/checks.yml`).

To exercise the CLI against another repository, build and `pnpm link --global`, then run `openwiki` from the target repo (see DEVELOPMENT.md). `OPENWIKI_DEV=1 openwiki --dry-run` does a dry run.

## What this is

A TypeScript ESM CLI (`openwiki` binary, Node >= 20) that runs a DeepAgents documentation agent with an Ink (React) terminal UI. Two modes:

- **code** — writes repository documentation into the target repo's `openwiki/` directory; run metadata in `openwiki/.last-update.json`.
- **personal** — builds a local "personal brain" wiki under the OpenWiki home from connector sources (Gmail, Slack, Notion via MCP, X, Hacker News, web search, local git repos).

## Architecture

Execution flow: `src/commands.ts` parses argv → `src/cli.tsx` (Ink app) drives onboarding/credentials and run lifecycle → `src/agent/index.ts` creates the provider-specific model and DeepAgents runtime → `src/agent/prompt.ts` assembles the run instructions → the agent writes docs through a local-shell backend rooted at the target (repo root in code mode, the wiki dir in personal mode).

- **User-visible semantics are split** across `src/commands.ts`, `src/cli.tsx`, and `src/agent/*`. When changing CLI behavior, verify both the parser and the agent prompt/runtime.
- **Providers are centralized in `src/constants.ts`** (`PROVIDER_CONFIGS`, `OpenWikiProvider`, env key names, model lists). Adding or changing a provider also means updating the model-creation branch in `src/agent/index.ts`.
- **OpenWiki home tree** (`~/.openwiki`: `wiki/`, `connectors/`, `skills/`, `.env`, sqlite checkpoint) is resolved by lazy accessors in `src/openwiki-home.ts`, overridable via the `OPENWIKI_HOME` env var. Always call the accessors at use time — never capture a home-derived path in a module-level constant, or the override (used by tests) breaks.
- **Credentials** live in `$OPENWIKI_HOME/.env`, managed by `src/env.ts`. `MANAGED_ENV_KEYS` there is the single source of truth for every env var OpenWiki reads or persists; diagnostics and debug key lists derive from it. The interactive setup wizard is `src/credentials.tsx`.
- **Connectors**: `src/connectors/registry.ts` + one module per source in `src/connectors/sources/`. All connector IO goes through `src/connectors/io.ts` and lands under `$OPENWIKI_HOME/connectors/<id>/` (`config.json`, `state.json`, `raw/<run-id>/`). The agent reaches connectors only through the constrained tools in `src/connectors/tools.ts`; ingestion runs are orchestrated by `src/ingestion.ts`. To add a connector, follow the skill in `src/connectors/write-connector-skill.ts`.
- **Scheduling**: `src/schedules.ts` installs macOS launchd agents for recurring ingestion; `examples/` holds the GitHub Actions / GitLab CI templates for scheduled doc updates.

## Tests

Vitest, in `test/*.test.ts`. Tests that need an isolated home point `OPENWIKI_HOME` at a temp dir (see `test/openwiki-home.test.ts`); prefer that over stubbing `HOME` and resetting modules.

## Fork status

This is a private fork of `langchain-ai/openwiki`. Never open PRs against or push to the upstream repository — all work lands on this fork's `main` (issues and PRs live here too). CONTRIBUTING.md is upstream's policy and does not apply to work on this fork.

## Way of working

Work is driven from GitHub issues on this fork and ships as feature branch → PR against this fork's `main` → rebase merge, with `Closes #N` (one per line) in the PR body so issues auto-close. `.github/workflows/checks.yml` runs format/lint/test on PRs, but Actions does not currently run on this fork — always verify locally (`pnpm typecheck && pnpm test && pnpm lint:check && pnpm format:check`) before merging. `openwiki-update.yml` is the scheduled wiki refresh, not a PR check.

Upstream syncs are the exception to the PR flow: merge `upstream/main` into `main` as a plain merge commit and push directly after the local checks pass — never via a rebase-merged PR, which would rewrite upstream SHAs and break future syncs (the `upstream` remote is fetch-only by design).

The workflow runs on the Matt Pocock skills, in roughly this order:

- `/wayfinder` — chart a big, foggy chunk of work as investigation tickets on the issue tracker and resolve them until the way is clear.
- `/grill-with-docs` — relentless interview to stress-test a plan or design; produces the domain glossary in `CONTEXT.md` and ADRs in `docs/adr/` as it goes. Read both before designing or naming things: `CONTEXT.md` is the ubiquitous language, and ADRs (e.g. `docs/adr/0001-brain-wiki-is-a-read-only-observer.md`) are binding decisions.
- `/to-spec` — synthesize the conversation into a spec on the issue tracker.
- `/to-tickets` — break a spec into tracer-bullet tickets with explicit blocking edges.
- `/implement` — implement a ticket: TDD at pre-agreed seams, regular typechecks, full suite at the end. Delegate the implementation itself to the Codex subagent (`/codex:rescue`, i.e. the `codex:codex-rescue` agent): hand it a full design brief, then review, verify, and commit from the main session. Make sure `node_modules` is installed first, or its verification phase hangs hunting for binaries; if Codex fails with "model requires a newer version of Codex", upgrade the CLI (`npm install -g @openai/codex`) and kill the stale app-server broker so the shared runtime restarts on the new binary. When running inside tmux, follow the tmux-driver skill's Codex live-view flow: as soon as the background job reports its Codex session ID, spawn the bundled `codex-live-view.sh <session-id>` pane so the session is watchable live — the rescue subagent's pane only shows the handoff, not the session. Post-review fixes are Codex work too: dispatch them by resuming the same Codex session (`codex-companion.mjs task --background --write --resume-last` with a findings brief) instead of implementing them inline in the main session, and give the fix round its own live-view pane. When a delegation or review round is done, close what you opened: stop idle subagents (TaskStop) and reap owned tmux panes.
- `/code-review` — two-axis review (repo standards + originating spec) before the work ships.
