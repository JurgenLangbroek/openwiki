# OpenWiki

A CLI that generates and maintains two kinds of agent-written wikis: a per-repository code wiki, and a personal knowledge wiki built from connected data sources.

## Language

**Brain Wiki**:
The durable, human-readable personal knowledge base that accretes a model of the owner's work — projects, people, commitments, themes — with evidence links. It is an artefact to be opened and read, not a transient briefing.
_Avoid_: personal wiki, local wiki (code-level names for the same thing)

**Code Wiki**:
The generated documentation set for a single repository, living in that repo's `openwiki/` directory.

**Connector**:
A source of evidence for the Brain Wiki. A connector pulls raw items from one system and records them with provenance; it never writes wiki pages itself.

**Ingestion**:
The two-phase run that updates the Brain Wiki: a connector's deterministic pull of raw items, followed by agent synthesis of those items into wiki pages.

**Synthesis**:
The agent step that reads raw items and updates Brain Wiki pages, assigning each claim a confidence label.

**Pull**:
The deterministic, scheduled part of ingestion: a connector fetches a bounded window of raw items with no agent involvement. Reproducible for a given window.
_Avoid_: sync, scrape

**Backfill**:
A deliberately triggered Pull that walks a connector's history back until the source runs dry, in date slices. Its watermark is a completeness receipt: an interrupted Backfill resumes where it stopped; a finished one records how far back the evidence provably reaches. Distinct from the standing window a scheduled Pull re-fetches.

**Capability Probe**:
The authenticated check an ingestion run makes against a tenant to record which tools or streams it actually offers, written as a raw probe artifact (for example, `probe.json` for Glean's MCP tool catalog). Distinct from a Pull, which fetches evidence.

**Content Expansion**:
The deterministic Pull phase that fetches full document content (via Index Reads) for items the metadata pull surfaced, bounded by a per-run cap. Without it the wiki is built from titles and links only.
_Avoid_: expansion (bare — ambiguous with Exploration)

**Exploration**:
Agent-driven evidence gathering during synthesis: the agent decides live which questions to ask a connector's tools (search, chat, document reads) to deepen a page.
_Avoid_: agentic discovery (code-level flag name)

**Escalation**:
The Exploration move of re-reading evidence from the live underlying datasource (a Gateway Read) when the Index Read's cached content is missing or insufficient. Index first, gateway on insufficiency.

**Gateway Read**:
A read executed against the live underlying datasource (Gmail, Jira, Confluence, Calendar) through an intermediary's tool gateway, as opposed to reading that intermediary's index.

**Index Read**:
A read served from a search intermediary's own index (snippets, cached document content). May lag the live datasource.

**Open Question**:
An uncertainty recorded in the Brain Wiki that future evidence or exploration is expected to resolve. The set of active open questions doubles as the exploration queue.
