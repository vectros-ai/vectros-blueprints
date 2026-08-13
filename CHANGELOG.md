# Changelog

All notable changes to `@vectros-ai/blueprints` are documented here.
This project adheres to [Semantic Versioning](https://semver.org).

## 0.12.0

### Added

- **Top-level `issuers` — register trusted third-party IdP issuers for BYO-IdP
  token exchange.** A blueprint may now declare `issuers: [{ issuerId, issuer,
  jwksUri, audience, contextId, subClaim?, emailClaim? }]`. Unlike
  `schemas`/`accessProfile`/`roles` (applied under a per-context credential),
  issuers are tenant-wide provisioning config — the `@vectros-ai/cli` loader
  applies them in its bootstrap-token phase, alongside app-context/service-
  principal creation, using the same owner-only authority that creates the app
  context itself. `(issuer, audience)` must be globally unique across your
  tenant — use a distinct `audience` per environment/context sharing one IdP
  account. Fully backward-compatible: a blueprint that omits `issuers` parses
  and provisions exactly as before.

- **`BLUEPRINT_FIELD_PHASES` — which loader phase each top-level field applies
  in, self-documented.** A new exported `{ fieldName: 'bootstrap' | 'in-context' }`
  map (plus its `LoaderPhase` type) naming which of `@vectros-ai/cli`'s two
  loader phases each top-level blueprint field's resources are applied under —
  `issuers`/`servicePrincipal` in the bootstrap-token phase, `schemas`/
  `accessProfile`/`roles` in the per-context phase. Previously this was only
  discoverable by reading the CLI loader's source.

- **`agentic-sdlc` gains a `candidate` schema — the staging area in front of
  `memory`** (blueprint `1.6.0` → `1.9.0`). An agent distilling its own sessions
  proposes claims faster than it can verify them, and an unverified claim recalled
  as fact is worse than no claim at all. A proposal is now written as a
  `candidate`, verified, and only then promoted to a `memory`.

  It is **store-only (`indexMode: NONE`)**, which is the load-bearing part: an
  unverified claim is never indexed, so it cannot be returned by a search or a
  grounded answer under any query — the separation is enforced by the platform, not
  by every caller remembering a filter. Candidates stay reachable by id and by the
  lookups a review queue needs: `disposition` (what is waiting anywhere),
  `sessionId` (everything one conversation proposed), a `proposedAt` range (worked
  by age), and a **composite `(sessionId, disposition)`** — what is still unsettled
  *in this conversation*, which neither single-field lookup answers alone and which
  is the read an agent is shown as it works. It is the first bundled schema to
  declare a composite lookup. `sessionId` leads it because the leading field
  becomes the partition key, and leading with a four-value enum would sort every
  candidate ever proposed into four partitions.

  Its fields **mirror `memory`'s** wherever the two overlap — `title`, `body`,
  `kind`, `area`, `tags`, `sourceRef` — so verifying a candidate is a copy rather
  than a translation. `dest` (`memory` | `doc`) is the proposer's suggestion about which tier the claim
  belongs in — a question that stops existing once a verifier answers it. The
  workflow fields (`sessionId`, `proposedAt`, `disposition`, `ref`, `resolved`,
  `origin`, `reopenedWhy`, `revises`) are candidate-only too; they describe the
  REVIEW, not the claim, and so have nothing to mirror.

  The `member` role gains `records:r:candidate` — **read-only**, deliberately
  asymmetric with `memory`'s full CRU: a verdict is the output of a verification
  step, so it is written by the runtime that performed the check, while the queue,
  the verdicts and the corrections stay browsable.

### Fixed

- **The full ownership-scope grammar (namespace + value + the ≤2-dimension
  cap) is now validated on `accessProfile.identityOverrides`,
  `schemas[].scopes`, `seed[].scopes`, AND every `dataScope` KEY
  (`accessProfile.dataScope` and every `roles[].*.dataScope` clause) —
  placeholder-aware.**
  Previously these fields accepted almost any non-blank string, at every
  level: a bad literal value (`"a:b"`), a retired legacy key (`orgId`), a
  forbidden namespace (`scope:tenant`), a malformed `<namespace>:<value>`
  array entry, or more than 2 scope dimensions all linted clean and 400'd at
  apply — the exact deploy-time surprise this format's own validation exists
  to pre-empt. A naive grammar bolt-on would have broken every blueprint
  using the documented `${{ identities.<name> }}` substitution token (e.g.
  `{ "scope:org": "${{ identities.team }}" }`, or `'team:${{ identities.team }}'`
  in a `scopes` array), since the platform grammar deliberately excludes `$`,
  `{`, `}` (a stored value is re-parsed for placeholders server-side, so a
  placeholder-shaped literal would widen the credential to a whole
  compartment). The new checks recognize and skip the documented substitution
  form on every value — deferring to the existing declared-identity lint for
  it — and apply the platform's grammar to everything else, including the
  SUBSTITUTED value when `parseBlueprint` re-validates post-identity-
  resolution at apply time. `seed[].scopes` also gains the `.max(2)` its own
  doc comment already claimed but never enforced, and both `scopes` array
  fields now reject a namespace repeated with a conflicting value (matching
  the platform's own rule that an item carries at most one value per
  namespace). `dataScope`'s KEYS get the same namespace-grammar check as
  every other field here (`userId` is still a valid bare key — the principal
  dimension — every other key must be a grammar-valid `scope:<ns>`);
  `dataScope` VALUES are unchanged (a richer grammar — literal, the `null`
  tenant sentinel, or a runtime `${{ self.* }}`/`${{ under.self.* }}`
  placeholder — already partly covered by the existing placement lint, and
  out of scope for this pass).

  **This is a behavior change for any caller of `parseBlueprint`/
  `parseBlueprintJson`: a blueprint that previously parsed (because these
  fields were unvalidated) may now throw `BlueprintValidationError`** if it
  carries a value these grammars reject. Every rejected shape was already
  guaranteed to 400 at apply against the real platform, so nothing that
  worked end-to-end starts failing — but a blueprint that got as far as
  `validate`/`plan` on a bad value before now fails earlier, with a
  different, more specific error.

- **A malformed `${{ identities.* }}` reference now fails loudly instead of
  silently never substituting.** Two shapes previously passed structural
  validation but could never actually resolve: a hyphenated identity name
  (`identities: { demo-org: {...} }` declared fine, but `${{ identities.demo-org }}`
  could never match the reference grammar) and dotted property access
  (`${{ identities.owner.externalId }}`, which the format has never supported —
  only the whole identity id can be referenced). Both now reject at
  `parseBlueprint`/`blueprint validate` time with a specific, actionable
  message, before either could reach an apply and land as a literal
  unresolved string in a live `scopes:`/dataScope field.

- **`agentic-sdlc` guide: the query table showed `record_query` calls that cannot
  be made.** Three rows passed several fields at once (e.g.
  `record_query control { kind, criticality, status }`), but a lookup is an index
  the schema declares, and every lookup in this blueprint declares a single field.
  The rows now show a single-field lookup with the narrowing done caller-side, and
  the note under the table explains that a schema *may* declare several fields as
  one combined lookup — opt-in, declared up front, and not something a caller can
  assemble from two independent ones — then points at `hybrid_search`'s `filters`
  for ad-hoc multi-field filtering over a searchable type.

- **The install-time token resolver rejected `${{ self.scope.<ns> }}` and any
  `${{ under.self.* }}` reference as malformed**, even though these are the
  platform's own documented runtime identity-reference grammar for a role's
  `dataScope` — the resolver only recognized a flat, single-segment
  `${{ namespace.name }}` shape. Both forms now resolve (are correctly left
  literal for server-side resolution) at any depth, matching the runtime
  grammar. The `${{ self.* }}`/`${{ under.self.* }}` placement lint (which
  confines these tokens to a role clause's `dataScope`) is updated in
  lockstep — a misplaced multi-segment token (e.g. in a seed record field)
  is still caught, the same as the flat form always was.

## 0.11.0

### Added

- **`indexMode` accepts `NONE`.** A schema may now declare `indexMode: NONE` —
  store-only: the data is persisted, readable by id/`externalId`, and fully usable
  for structured lookups, but it is never indexed, so it can never appear in a
  search result or a grounded answer. The platform has always accepted this mode;
  the blueprint format did not, so a blueprint declaring it failed structural
  validation before the request was ever made. Reach for it when a type's contents
  must not compete with curated knowledge for retrieval slots — the exclusion is
  then structural rather than a filter every caller has to remember to apply.

  Note that **omitting `indexMode` is not the same as `HYBRID`**: a record with no
  mode of its own resolves to `NONE`, and a document with none is rejected. Declare
  the mode you want.

  `@vectros-ai/cli` bundles its own copy of this package, so applying a blueprint
  that declares `NONE` needs a CLI built against `0.11.x` — an earlier CLI rejects
  the value during structural validation, before any request is made.

## 0.10.0

### Added

- **A schema's `lookupFields` can now declare a composite (conjunctive) lookup** —
  `{ fieldNames: ['status', 'area'] }` matches on several fields at once ("every
  record where `status` is `open` **and** `area` is `billing`"), exact and
  complete, in the declared field order. 2-3 fields; order is significant and
  migration-locked, matching a leading run of the list (never a later field
  alone). `unique`/`rangeEnabled` are not available on a composite; `sortBy` and
  `allowOverflow` are. A schema declaring one must be record-only
  (`allowedSurfaces` omitted, or exactly `['record']`) — the platform's
  composite index has no document/user/entity reader yet. No bundled blueprint
  declares one in this release; adopting the shape in the bundled library is a
  separate, deliberate content decision.

### Fixed

- **Corrected the `sortBy` guidance in the README.** It said that sorting an
  equality lookup by an **optional** field "silently drops records lacking it,"
  and advised preferring the always-present timestamps. That was never accurate —
  an equality lookup resolves on the partition key, and `sortBy` only orders
  within it — and the platform now gives records with no value for the sorted
  field their own ordered position ahead of the rest, for records written from
  this platform release onward (earlier records take that position once they are
  next updated). The README also now covers
  what a `sortBy` genuinely constrains: the sorted field's declared type is
  migration-locked alongside `sortBy` itself, and an `array`/`object` field
  cannot be a `sortBy` target.

- The bundled-blueprint guard that enforced the retired "sortBy must name a
  required field" rule now checks the rules that actually hold, so a blueprint
  sorting by an optional field is no longer rejected.

## 0.9.0

### Added

- **`BlueprintSchemaSchema` gains `basedOn`.** A schema entry may declare
  `basedOn: <schemaId>` to mark itself as a customization of an existing
  same-`typeName` schema in the context, mirroring the platform's schema-create
  `basedOn` field (immutable once set, must point directly at the base).
  Optional and additive — no bundled blueprint sets it today.

## 0.8.0

### Changed (breaking)

- **Organization and client ownership is now expressed as namespaced scopes.**
  `org` and `client` are built-in namespaces alongside any you define (teams,
  projects, tenants, …), so ownership is authored the same way everywhere:
  - Schema ownership: the `orgId` / `clientId` fields are replaced by a single
    `scopes` array of `namespace:value` entries — e.g. `scopes: ["org:<id>"]`.
    `userId` is unchanged.
  - `allowedSurfaces`: `org` / `client` are replaced by `entity` (a schema binds
    to identity entities of any namespace).
  - Reference `targetSurface`: now `record`, `document`, `user`, or a namespace
    (`org`, `client`, or one you define); `entity` is not a valid target.
  - `dataScope` / `identityOverrides` keys use the `scope:<namespace>` form
    (`scope:org`, `scope:client`, …); the bare `orgId` / `clientId` keys are gone.
  - A declared identity's `kind` is `user` or a namespace (`org`, `client`, or
    one you define).

## 0.7.0

### Added

- **`agentic-sdlc` gains governed agent memory** (blueprint `1.3.0 → 1.6.0`).
  Alongside the team's shared, curated knowledge (decisions, conventions,
  gotchas, …) — the *crystallized* tier — agents and the humans they work for
  now have a **private** working-memory layer, enforced by the platform rather
  than by application code:
  - **The `memory` record type** — a flexible schema for working memory: `kind`
    (`user`/`feedback`/`project`/`reference`/`observation`), a searchable
    `body`, `area` (the same subsystem vocabulary as the curated types, so one
    filter narrows recall across all content), `agent` (the *role* that wrote
    it — `pm`, `builder`, … — not an instance id), `tags`, a supersede
    `status`, an optional `threadId` (your runtime's conversation/session id,
    for episodic slices), a range-queryable `updatedOn`, and `externalId` as
    the stable slug. It also carries a **`priority`** band (a range-queryable
    number, nullable — `0`/`10`/`20`/`30`) for the always-load pinned set and
    recall ranking, and three graph edges: `supersededBy`/`relatedTo` (self-refs
    for the evolution + see-also trail) and a `sourceRef` provenance string.
    Because `memory` is the highest-volume record, its lookups are kept **lean** —
    only the fields you enumerate deterministically (`kind`, `threadId`,
    `updatedOn` range, `priority` range) are lookup-indexed; `area`/`agent`/
    `status` are `filterable` search metadata (no per-write lookup row), and
    `priority`/`threadId` write a row only when set.
  - **The `member` role** — two unioned clauses: the curated shared KB (read
    *and* semantic recall, type-scoped so recall can never expose anyone's
    memory) and **private memory** (the member's own, isolated by a
    `${{ self.userId }}` data-scope — visible only to them, and both
    hybrid-searchable *and* `rag_ask`-groundable by its owner alone). Enroll a person or
    agent in one step with `vectros join agentic-sdlc --role member`; verify a
    binding with `vectros access explain`. (Team-shared working memory — the same
    `memory` type at a group scope — is a planned addition, deferred while the
    shared-scope ownership axis is finalized.)
  - **The bundled guide and agent orientation prompt** gain agent memory: the
    guide's "Agent memory" section (what belongs in memory, the promotion lifecycle
    private → curated, the "your issue tracker owns status; memory owns context"
    rule, the AND-vs-union access model, the `vectros access explain` check, and the
    context-administrator visibility caveat), and the prompt now lists the `memory`
    type and names the private tier as working memory's first-class home. The
    orientation prompt was also slimmed (~220 → ~120 lines) into an operating layer —
    the recall→act→capture loop plus the query/capture disciplines — that points to
    the guide for the exhaustive field lists, payload shapes, and sync markers rather
    than restating them. Recall guidance now leads with `hybrid_search` +
    natural-language queries (reason over the passages yourself; `rag_ask` is an
    optional, inference-metered layer), correcting the prior keyword-first advice.
- **Blueprint format: `accessProfile.identityOverrides` and seed `scopes`.** An
  `accessProfile` may declare identity overrides — the scope values its key
  stamps onto everything it writes — and a seed may declare its `scopes`
  ownership (`[]` = a private, user-owned item). `${{ identities.* }}` tokens
  substitute in both at apply time; `bootstrap` and `blueprint-test` apply them.

## 0.6.5 — 2026-07-04

### Fixed

- **`agentic-sdlc` service key now includes `documents:u`** (blueprint `1.2.0 → 1.3.0`).
  The bootstrapped service-principal `accessProfile` was missing `documents:u`, so the
  agent key could create documents but could neither archive them (a reversible
  `ARCHIVED` status flip — the document-surface analog of the `records:u` supersede it
  already does) nor re-ingest a changed document body (`document_ingest` with `upsert`,
  the repo↔KB sync primitive the bundled guide documents). The whole KB-sync story was
  therefore unexecutable by the very key the blueprint provisions. `documents:u` is now
  in the base data-plane set. Hard delete (`documents:d`) remains deliberately absent
  from the service key — it stays on the human `editor` role — so an archived document
  is always restorable and a compromised key can never purge the knowledge base.

## 0.6.4 — 2026-07-03

### Added

- **`agentic-sdlc` `editor` role now carries full data-plane delete** (blueprint `1.1.0 → 1.2.0`).
  The human owner's `editor` role gains `records:d` / `documents:d` / `folders:d` on top of the
  shared data-plane actions — so a person granted `editor` can hard-delete data-plane content
  (curation cleanup), while the agent's service key stays delete-free and curates by soft-retract
  (archive) instead. Deleting only *your own* data via a scoped credential is a separate, later
  capability; today `editor` is context-wide.
- **Guide + agent prompt now include KB query-mechanics guidance.** Reach for `record_query`
  before `hybrid_search` for an enumerable ask (exact + compact); query compactly by default
  (`limit: 3` + `uniqueDocuments: true`, since hits carry passages); how to scope by type per
  tool (`hybrid_search` uses `typeName`, which narrows documents and records alike;
  `record_query` uses `type`); and the `textMode: PHRASE` keyword-leg trap on long natural-language queries
  (a `textScore` of 0 on every hit means the keyword leg contributed nothing — use a short
  phrase or `textMode: "OR"`).
- **`agentic-sdlc` records now carry a `sourceRef` field** (blueprint `1.0.0 → 1.1.0`).
  The four record types (`control`, `convention`, `gotcha`, `term`) gain a `sourceRef` string —
  the repo path of the source file each record was distilled from — as an equality
  lookup. It is the record analog of the provenance a document keeps: because many
  records are extracted from one file, a record can't embed an in-file back-reference,
  so it names its source instead. A change to a source file then finds exactly its
  records (`record_query` by `sourceRef`) to re-extract, keeping the knowledge base in
  sync with the repository without a separate index to maintain. Additive and
  backward-compatible; existing records simply have no `sourceRef` until re-extracted.
- **Guide + agent prompt now document the repo↔KB sync pattern in full** — the two
  self-describing markers (`vectros-kb-id` for a file that *is* a KB document,
  `vectros-kb-records` for a file that *feeds* records) plus `sourceRef`, so a consumer
  can keep a mirrored repo and its KB in sync with no side index.

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
