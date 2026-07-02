# Changelog

All notable changes to `@vectros-ai/blueprints` are documented here.
This project adheres to [Semantic Versioning](https://semver.org).

## 0.6.3 — 2026-07-01

### Added

- **`agentic-sdlc` now declares an `editor` role for the human owner.** `bootstrap`
  provisions a scoped key for your *agent*, but doesn't join *you* — so a blueprint's
  context doesn't appear in the data-plane app until your own user is granted access
  there. The blueprint now ships a reusable `editor` role at **parity with the service
  key** (`records:r/c/u`, `search:r`, `schemas:r`, `inference:r`, `documents:r/c`,
  `folders:r/c`; no delete, no control-plane), which `bootstrap` creates in the context.
  Bind it to your user once to browse and curate the KB in the app:
  `vectros access grant --principal usr_<your-user-id> --context agentic-sdlc --role editor`
  (or via the admin app's Access → Contexts → Profiles). The guide and walkthrough
  document the one-time join, and the package README now documents the top-level
  `roles` format field (previously undocumented — no bundled blueprint used it).

## 0.6.2 — 2026-06-29

### Changed

- **`agentic-sdlc` ingest guidance corrected for explicit upsert.** The guide and the
  ingest-agent prompt now describe syncing accurately: re-ingesting an unchanged item
  returns it as-is (`created: false`), and propagating **edited** source requires
  `upsert: true` — a plain re-create returns the existing item unchanged rather than
  applying the edit. Pick stable `externalId`s and re-ingest with `upsert` to keep the
  knowledge base in sync; a from-scratch rebuild into an empty context is unaffected.

## 0.6.1 — 2026-06-28

### Added

- New bundled blueprint **`agentic-sdlc`** — a whole-SDLC system of
  record for an AI development team, organized by **content vs structure**. Nine
  schemas: ADRs (`decision`), `design`/specs, `reference`, `runbook`, and
  `postmortem` bind the **document** surface (the markdown body is the artifact);
  `control`, `convention`, `gotcha`, and a glossary `term` are **records** (the
  typed fields are the artifact). They form a **cross-surface knowledge graph** —
  records reference documents (`control` → the `runbook` that verifies it;
  `convention`/`term` → the `decision` behind them) and documents reference
  documents (a `design` → its `decision`, a `runbook` → the `postmortem` it was
  born from, an ADR → the one it supersedes). Shows hybrid search + grounded
  `rag_ask` over document bodies, range/sort on every artifact's date, a
  governance `control` that carries its evidence, a `convention` with distinct
  rule/why/howToApply fields, and a glossary `term` with a `unique` lookup. Ships
  without bundled seeds (the cross-surface graph is populated by the ingest agent).
- Usage guide (`guides/agentic-sdlc.md`) and drop-in agent orientation prompt
  (`prompts/agentic-sdlc-agent.md`) shipped with the package.

## 0.6.0 — 2026-06-28

### Added

- **Document seeds.** A seed entry now declares a **surface**: `surface: record`
  (a structured record — the existing behavior) or `surface: document` (a
  text-ingested document carrying a `title` and `text`, with optional structured
  `fields`). A blueprint can now pre-populate documents, not just records, and
  model a **cross-surface graph** — a record's `reference` can target a seeded
  document by `externalId`, and vice versa. A seed's surface is validated against
  the bound schema's `allowedSurfaces`.

### Changed

- **Breaking (format):** every seed entry must now declare `surface`. Existing
  record seeds add `surface: record`. The discriminator is explicit by design — a
  document seed's first-class `title`/`text` are distinct from a record's
  `fields`, so the two shapes are validated separately.

## 0.5.0 — 2026-06-20

Initial public release of the Vectros blueprints library.

### Added

- Curated, ready-to-apply use-case blueprints — each bundling a schema set, a
  least-privilege AccessProfile, and seed data: `task-management`,
  `coding-agent-memory`, `second-brain`, and `clinical-intake`.
- The Blueprint format and a structural validation API for authoring your own —
  including field validation, render hints, sensitive (PHI) fields, typed
  `reference` links between record types, and the lookup-index surface (equality
  and ordered range/prefix lookups, the 7-slot budget, and uniqueness).
