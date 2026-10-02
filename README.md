# @vectros-ai/blueprints

[![npm](https://img.shields.io/npm/v/@vectros-ai/blueprints)](https://www.npmjs.com/package/@vectros-ai/blueprints)
[![license](https://img.shields.io/npm/l/@vectros-ai/blueprints)](https://www.apache.org/licenses/LICENSE-2.0)

The Vectros **blueprint** format + the curated bundled library.

A **blueprint** is a versioned, reviewed bundle for one use case: a schema
set + a **least-privilege** AccessProfile + a service principal + optional
seed data, all with stable identifiers so applying it twice converges
instead of duplicating. [`@vectros-ai/cli`](https://www.npmjs.com/package/@vectros-ai/cli)
`bootstrap` applies them to provision a ready-to-use data model + a narrow
`ssk_*`.

This package is **data + types + structural validation only**. It contains
**no enforcement**: the security boundary — the scope gate that bounds a
blueprint's requested scopes to data-plane-only — lives in the CLI binary
(the trust boundary), because blueprints are untrusted
input.

```ts
import {
  BUNDLED_BLUEPRINTS,
  getBlueprint,
  parseBlueprintJson,
  type Blueprint,
} from '@vectros-ai/blueprints';

const tm = getBlueprint('task-management');    // a bundled Blueprint
const mine = parseBlueprintJson(jsonText);     // parse + validate untrusted JSON (throws on bad shape)
```

`parseBlueprintJson` takes a JSON **string**; `parseBlueprint` validates an
already-parsed object. Both throw `BlueprintValidationError` on a bad shape.

## Exports

- `Blueprint` + field/schema/seed types — the format.
- `parseBlueprint(input)` / `parseBlueprintJson(json)` — structural (zod)
  validation; throws `BlueprintValidationError` on a malformed shape.
- `contextNameOf(blueprint)` — the app-context display name. Falls back to
  `MCP — <name>` when the blueprint omits `contextName`.
- `companyNameOf(blueprint)` — the deploying organization's own display name, distinct from
  `contextNameOf`: `contextName` is the blueprint author's fixed identity for the app (the same
  for every deployer), `companyName` is meant to vary per install (typically templated from a
  deployer-supplied `${{ inputs.x }}` value). Used for branding on platform-sent correspondence
  (e.g. invite emails) alongside `contextName`, not as a replacement for it. Unlike
  `contextNameOf`, has no forced default — returns `undefined` when the blueprint omits it.
- `isRestrictedToDomainName(value)` — whether a string is a lowercase ASCII DNS name of the shape an
  issuer's `restrictedToDomain` accepts, for a tool that takes the same value from somewhere else
  (for example a command-line flag) and should not carry its own copy of the grammar.
- `BUNDLED_BLUEPRINTS` / `BLUEPRINT_NAMES` / `getBlueprint(name)` — the
  curated library: `task-management` (the minimal authoring exemplar),
  `agentic-sdlc` (a whole-SDLC system of
  record for an AI dev team: eleven schemas — nine curated (split by content vs
  structure) — ADRs, designs, references, runbooks, and post-mortems as
  **documents**; controls, conventions, gotchas, and a glossary as **records** —
  linked into a **cross-surface** knowledge graph, with hybrid search + grounded
  `rag_ask`, plus a private `memory` tier for per-principal working memory; see
  [`guides/agentic-sdlc.md`](guides/agentic-sdlc.md) and the drop-in agent prompt
  [`prompts/agentic-sdlc-agent.md`](prompts/agentic-sdlc-agent.md)),
  `second-brain`, and `clinical-intake` (the PHI/sensitive-field exemplar).

## The format, field by field

This is the format *contract* reference. For the authoring *workflow*
(`init` → `validate` → `plan` → `bootstrap`), see
[`@vectros-ai/cli`'s AUTHORING.md](https://www.npmjs.com/package/@vectros-ai/cli).

A schema's `fields[]` carry, beyond the basics (`fieldId`, `fieldType`,
`required`, `searchable`, `filterable`, `enumValues`, `description`):

- **`validation`** — server-enforced rules mirroring the platform
  `ValidationRules`: `minLength` / `maxLength` / `min` / `max` / `pattern` /
  `email` / `url` / `phone` / `step` / `multipleOf` / `minItems` / `maxItems` /
  `required`. Strict — an unknown rule key is an authoring error.
- **`renderHints`** — `label` / `widget` (`text|textarea|select|date|checkbox`) /
  `order` / `section` / `helpText` / `displayField` (mark the record's headline
  column — at most one per schema). Authored per-field; the CLI loader pivots
  them into the schema-level keyed map the platform expects.
- **`sensitive`** (boolean, default false) — marks a field as PHI/PII. The
  platform redacts it from logs/audit/errors **at write time** (destroyed before
  the audit snapshot — not reversible masking), blind-indexes it for lookups,
  **excludes it from the search index**, and masks it in responses unless the token
  carries the `s` reveal scope for the record type. The bundled `clinical-intake`
  blueprint is the exemplar. (Marking a field both `sensitive` and `searchable` is
  contradictory — a sensitive field never enters the search index.)

A schema additionally accepts:

- **`expectedScopeDims`** — advisory only: the ownership dimensions (bare namespace names, or
  `userId` for the principal) a schema author expects every role's `dataScope` clause to cover for
  this type. The CLI's blueprint lint warns when a role clause grants `r`/`u`/`d` on this type but
  its `dataScope` names only *some* of these dims — the easiest way to leave a dimension
  unintentionally unconstrained, since reads (unlike creates) never require full-dimension
  `dataScope` coverage. It helps you notice that read/write asymmetry; it doesn't change it — the
  asymmetry itself is deliberate platform behavior. Does not affect enforcement at runtime.
- **`lookupFields`** — each entry is a bare field name (`"status"`), an object
  `{ fieldName, unique?, rangeEnabled?, sortBy?, allowOverflow? }` (one field),
  or an object `{ fieldNames, sortBy?, allowOverflow? }` (a **composite**: 2-3
  fields matched together at once — see below). The index shape is
  **migration-locked** — you cannot change it once the schema is live, even by
  removing and re-adding the field(s) — so choose deliberately:
  - `unique` enforces a uniqueness constraint. Single-field lookups only.
  - **equality (default) vs. `rangeEnabled`** — equality for ids/foreign keys/
    status enums/categories; `rangeEnabled` (ordered `from`/`to`/`prefix`, billed
    at the range rate) for values you query as an order (**dates, sequences,
    scores, versions**). Range/prefix order is lexical, so ISO-8601 dates sort
    correctly but an ordinal enum (`low…urgent`) would sort alphabetically — leave
    those as equality. Single-field lookups only — a composite is an exact-match
    index over its fields; declare the range lookup separately.
  - **7-slot budget** — a schema has 7 fast equality-lookup slots (ownership ids +
    `externalId` ride their own; `rangeEnabled` lookups use a row, not a slot, so
    they don't count; a composite counts as ONE slot). An 8th equality lookup is
    rejected unless it sets `allowOverflow` (a higher-cost secondary index).
  - `sortBy` sets the equality-lookup listing order (`createdAt` default,
    `lastUpdated`, or a declared field), and is also what `sortFrom`/`sortTo`
    narrow against. The sorted field may be optional: records carrying no value
    for it are listed ahead of those that do, and are never inside a bounded
    window. Both `sortBy` and the sorted field's **type** are migration-locked,
    and an `array`/`object` field cannot be a `sortBy` target. Valid on a
    composite too, ordering *within* a group (see below), not across the result.
  - **Sensitive fields may be equality lookups** (HMAC blind index → exact
    find-by-value without storing the value in the clear), but never `rangeEnabled`
    (a hash is not orderable), and no `sortBy` may name a sensitive field. This
    applies per-field even inside a composite.
  Max 10. Do **not** list a reserved identifier (`externalId` or an ownership id) —
  those have first-class finders, so the platform rejects redeclaring them as
  schema lookups; a composite may not carry one in any position either.

  **Composite (conjunctive) lookups** — `{ fieldNames: ['status', 'area'] }` matches
  on *all* of the listed fields at once: "every record where `status` is `open`
  **and** `area` is `billing`", exact and complete, in the declared field order.
  2-3 fields; a 1-element list is rejected (it is not a spelling of the plain
  `fieldName` form — declare that instead). **Order is significant and
  migration-locked**: a query may match a leading run of the list (the first
  field alone, the first two together, …) but never a later field by itself —
  declare a separate lookup for that. `unique` and `rangeEnabled` are refused on
  a composite; `sortBy` and `allowOverflow` are still available. **Record-only**:
  a schema declaring a composite must set `allowedSurfaces` to exactly `['record']`
  (or omit it — the loader defaults to `['record']`) — the platform's composite
  index has no document/user/entity reader yet.
- **`inline`** (per field) — keep the field on the record row when the payload is stored out of line
  (a large record, or a `LARGE_PAYLOAD` storage profile), so it appears in list and lookup
  projections without `includePayload`. It is also what makes an otherwise-ordinary field
  **projectable into a trigger script**: a rule's `fields` may name a field only if it is `inline`,
  `filterable`, or a lookup field (a leg or its `sortBy` target). Cannot be combined with `sensitive` — a sensitive field is
  blind-indexed and masked, so a readable row copy would defeat it. The platform also refuses, with
  a `409`, to remove whatever keeps a field projectable while a live trigger rule still projects it
  — dropping its `inline` flag, its `filterable` flag, or the lookup that carried it.
- **`capabilities`** — `{ auditHistory, triggersEnabled }`. `auditHistory` defaults to `true` on the
  platform when omitted; surface it to make the audit posture self-documenting. `triggersEnabled`
  defaults to `false` and is the opt-in a schema must declare before a trigger may fire on its
  records — the two are independent, so turning audit history off does not turn triggers off.
- **`filterable` field ids are checked against the platform's own search-index keys.** A
  `filterable: true` field whose `fieldId` collides with a platform-owned metadata key for a surface
  the schema binds to would shadow the platform's value in the index, and the platform rejects it —
  so it is reported here at validate/plan rather than failing partway through an apply. The reserved
  set is per surface: `tenantId`, `owner_id`, `folderId`, `rootFolderId`, `recordType` for a schema
  allowing `record`, plus `model_type` and `title` for one allowing `document`. A schema binding only
  to `entity` reserves nothing, and a non-filterable field of any name is unaffected. `status` is
  reserved on neither surface.
- **`active`** — whether the schema accepts new records (inactive schemas reject
  creation). Defaults to active.
- **`userId` / `scopes`** — schema-level ownership defaults, mirroring the
  platform `SchemaRequest`: the principal `userId` plus `scopes`, namespaced
  parent edges as `<namespace>:<value>` (`org:...`, `client:...`, or a namespace
  you registered — at most two namespaces). With a scoped token these must be
  consistent with the profile's `dataScope`.
- **`basedOn`** — id of an existing schema this one *customizes*, mirroring the
  platform's `basedOn` schema field. Required when a schema named `typeName`
  already exists in this context under a **different** owner (a create that
  omits it in that case is rejected with a `400`); omit when this is the first
  schema under that name (it becomes that name's shared base, and must then be
  ownerless — no `userId`/`scopes`). Points directly at the base (one hop) and
  is immutable once set. The bundled loader's own re-apply of the *same*
  blueprint never needs this — it reconciles server-side by owner — this field
  is for a schema that intentionally customizes a base another owner defined.

The `accessProfile.dataScope` value lists accept a **`null` sentinel** — e.g.
`{ "scope:org": ["org_x", null] }` grants `org_x`'s records **plus** tenant-level
(owner-less / shared) records. Omitting `null` restricts the key to the listed
owners only. Keys are `userId` (the principal) plus namespaced `scope:<ns>` scopes.

A blueprint may also declare top-level **`roles`** — a map of `roleId` → ordered
scope clauses (each an `allowedActions` list with an optional `dataScope`). Unlike
`accessProfile` (which scopes the service-principal key `bootstrap` mints), roles
are reusable, identity-agnostic rules you bind to a principal *after* bootstrap with
`vectros access grant --principal <p> --role <roleId>`. `bootstrap` provisions the
declared roles in the context but binds them to no one. The bundled `agentic-sdlc`
ships an `editor` role for this — join your own user to the context so you can
browse and curate the knowledge base in the app. Role clauses pass the same
data-plane scope gate as `accessProfile`.

Instead of an inline `allowedActions` clause, `accessProfile` may declare
**`roleIds`** — a list of one or more roles this SAME blueprint declares in
`roles`, composed additively: the effective grant is each named role's own
clauses, concatenated in the order listed (never merged, so each clause keeps
meaning exactly what its own author wrote). `allowedActions`/`roleIds` are
mutually exclusive — exactly one of the two — and a `roleIds`-composed profile
carries no `dataScope`/`capabilities`/`assignableRoles` of its own; author those on the
referenced roles instead. Every id must resolve to a role declared in this
blueprint, and no id may repeat:

```yaml
accessProfile:
  roleIds: [case-handler, hr-admin]
roles:
  case-handler:
    - allowedActions: [records:r:case, records:u:case]
  hr-admin:
    - allowedActions: [records:r:hr]
```

A blueprint may also declare a top-level **`fragments`** — a map of name →
`dataScope`, purely an authoring convenience for when several role clauses
would otherwise repeat an identical `dataScope` verbatim. Reference one from a
clause with **`dataScopeRef`** instead of an inline `dataScope` — the two are
mutually exclusive on the same clause, never both. A `dataScopeRef` is
resolved to its fragment's literal `dataScope` before anything downstream
(the CLI loader, the wire payload it sends) ever sees it — it is local sugar,
never itself provisioned:

```yaml
fragments:
  ownOrg:
    "scope:org": ['${{ self.scope.org }}']
roles:
  case-handler:
    - allowedActions: [records:cru:case]
      dataScopeRef: ownOrg
    - allowedActions: [search:r]
      dataScopeRef: ownOrg
```

A blueprint may also declare a top-level **`roleAssumable`** — a map of
`roleId` → grant, naming which values a holder of that role may become via
`POST /v1/auth/token/assume`. It's a sibling of `roles`, not a field folded
into a role's clause list, and every key it names must resolve to a role this
same blueprint declares under `roles`. Its grammar is deliberately narrower
than a clause's `dataScope`: every key must be a namespaced `scope:<ns>` (the
principal — `userId` — can never be named here, unlike `dataScope`), and no
value may be `null` (there's no tenant-level/owner-less reading to opt into —
`/assume` always requests one concrete value). Values accept a plain literal,
`${{ under.self.userId }}`, or `${{ member.scope.<namespace>[:level] }}`:

```yaml
roleAssumable:
  hr-admin:
    "scope:org": [org_engineering, org_sales]
roles:
  hr-admin:
    - allowedActions: [records:r]
```

Both `accessProfile` and each role clause may also carry an optional
**`assignableRoles`** — a roleId allow-list restricting WHICH named roles that clause may compose
into a delegated AccessProfile (`roleIds` composition). Orthogonal to `allowedActions`/`dataScope`:
it narrows which roles the clause's authority may hand out, not how much data it reaches. Omitting
it means no restriction; an EMPTY list is rejected rather than meaning "compose nothing", because an
empty list states no rule. At most 20 entries, each matching the platform's roleId grammar,
duplicates rejected. Entries are deliberately not resolved against this blueprint's own `roles` — a
clause may legitimately name a role that already exists in the context. **Adoption note:** once a
clause carries the field it can compose only the roles it names, so name every roleId the restricted
clause still needs *before* adding it.

**`capabilities`** — a list of platform capability names (distinct from the
schema-level `capabilities` above), e.g. `capabilities: ['member-lifecycle']`.
This package validates the SHAPE only (non-blank, no duplicates, lowercase
kebab-case, no `'*'`) — it deliberately does not know which names are actually
grantable, since that set is a platform property. **This field parses and
validates; it does not, by itself, cause anything to be granted.** Whether it
has any effect depends entirely on whether the tool applying your blueprint
(e.g. `@vectros-ai/cli`) reads and forwards it — check that tool's own release
notes before relying on it.

A blueprint may declare a top-level **`scripts`** — a map of script name → declaration — carrying
the source a trigger's `scriptRef` runs. Without it a blueprint can *name* a script but not *ship*
one, and the adoption flow breaks in the middle: a trigger's `scriptRef` is checked when the rule is
declared, not when it fires, so a rule naming a script that has no versions in the target context is
refused outright.

```yaml
schemas:
  - typeName: intake
    displayName: Intake
    capabilities: { triggersEnabled: true }
    fields:
      - { fieldId: externalId, fieldType: string }
      - { fieldId: status, fieldType: string, inline: true }
scripts:
  notify-assignee:
    # The source ships INLINE. There is no `path:` — see below.
    source: |
      export default function (input) {
        return { notified: input.recordId };
      }
    # Optional, and DESCRIPTIVE only — nothing validates a firing against it.
    declaredInputContract: "{ recordId: string, record: { status: string } }"
triggers:
  on-intake-update:
    firingSource: { schemaName: intake, event: UPDATE }
    # A script this blueprint ships is referenced as `latest`, never pinned — see below.
    scriptRef: { name: notify-assignee, version: latest }
    fields: [status]
    allowedActions: [records:r:intake]
```

- The map **key is the script's name** — the same name a `scriptRef.name` resolves against. 1–64
  characters of letters, digits, `_` and `-`.
- `source` — **required**, non-blank, at most 300,000 UTF-8 bytes. **Nothing parses it**, here or on
  the platform: it is stored as written, so a syntax error stays invisible until the version first
  runs, where it surfaces as a script error from the rule that dispatched it.
- `declaredInputContract` — optional, at most 50,000 UTF-8 bytes. It documents the input shape for a
  human reading the blueprint; nothing enforces it.

Both limits are counted in **UTF-8 bytes, not characters**, matching the platform — a source full of
multi-byte characters can sit under 300,000 characters and still be over the limit.

**There is no `path:`, and that is deliberate.** A shipped script runs under its trigger's declared
grant, so it is live authority; a blueprint is a bundle someone reviews before applying it. Keeping
the source inside the bundle keeps what runs inside what was reviewed — a path would let a blueprint
pull in code the reviewer of the file never saw.

**You cannot declare a version, and a trigger on a shipped script must use `version: latest`.**
Versions are assigned by the platform, auto-incrementing per name, and a stored version is immutable
— superseded, never edited. So a blueprint declares only the *current source* for a name. Pinning a
trigger to a number would name a version the blueprint cannot know it produced, and the trap is what
happens next: edit `source`, the push mints a new version, and the pinned rule goes on running the
old code with nothing to tell you. A `scriptRef` naming a script this blueprint does **not** ship is
unrestricted and may still pin a version — that is the "reference a script someone else pushed" case.

**Re-applying an unchanged blueprint pushes nothing.** An apply reads the name's current version
first and only stores a new one when `source` or `declaredInputContract` actually differs, so a
repeated apply does not accumulate versions or silently re-point a `latest` rule at code identical to
what it was already running. Editing `source` pushes one new version, which every `latest` rule then
picks up.

A blueprint may also declare a top-level **`triggers`** — a map of trigger name → declaration,
each naming a schema event that invokes a versioned script under an explicitly declared grant.
**A declared trigger FIRES.** A record write on a schema that opts in via
`capabilities.triggersEnabled` dispatches the rule's script, which runs asynchronously in a sandbox
under the grant declared here — so a trigger's `allowedActions`/`dataScope`/`capabilities`, or the
roles its `roleIds` composes, are live authority. Author the grant as narrowly as you would any
other credential's, and review it the same way. Applied per-context like `roles`/`accessProfile`,
not in the bootstrap phase. A grant naming a control-plane resource (`keys`, `profiles`, `users`,
`app-contexts`, `access-log`, `scripts`, any op) or the bare wildcard `*` additionally requires the
applying credential to hold the `trigger-control-plane-grant` capability — no bundled blueprint
declares one, and this is refused by default. Each entry:

```yaml
schemas:
  - typeName: intake
    displayName: Intake
    # A schema fires triggers only when it opts in.
    capabilities: { triggersEnabled: true }
    fields:
      - { fieldId: externalId, fieldType: string }
      # `inline` is what makes a field projectable into a trigger script.
      - { fieldId: status, fieldType: string, inline: true }
roles:
  case-worker:
    - allowedActions: [records:u:intake]
triggers:
  on-intake-create:
    firingSource: { schemaName: intake, event: CREATE }
    # Quoted: a version is a string, and bare 3 is a YAML number.
    scriptRef: { name: notify-assignee, version: '3' }
    # Projects nothing — the script still receives input.recordId.
    fields: []
    roleIds: [case-worker]
  on-intake-update:
    firingSource: { schemaName: intake, event: UPDATE }
    scriptRef: { name: notify-assignee, version: latest }
    fields: [status]
    # `fields` needs a matching READ: records:r covering the firing schema's type,
    # and that clause's dataScope may use only ${{ input.* }} placeholders, never a literal.
    allowedActions: [records:r:intake, records:u:intake]
    dataScope: { "scope:org": ["${{ input.scope.org }}"] }
    manifest: [records.get, records.update]
```

- `fields` — **required** — the record fields projected into the script's `input.record`, and on an
  `UPDATE` firing into `input.previous` (the same fields as they were before the write). On a
  `DELETE` firing `input.record` carries them from the deleted row, which is the only way a script
  sees anything of it. **`fields: []` is the "project nothing" declaration** — the script still gets
  `input.recordId` — and it is required rather than defaulted so that projecting nothing is
  something you state rather than something you get by forgetting the key.

  An entry may name only a field the schema keeps **inline**: declared `inline: true`, or
  `filterable: true`, or used as a lookup field — either a leg of one or its `sortBy` target — and
  never one marked `sensitive`. `parseBlueprint`
  checks this against the schema in the same blueprint, so a mistake is an authoring error rather
  than a `400` partway through an apply. `record` and `previous` together are capped at 224 KB
  serialised; a firing that exceeds it is not run.

  ⚠️ **A rule that declares any `fields` must be able to READ what it fires on.** Its grant must hold
  a `records:r` clause covering the firing schema's type — **a grant with no read at all is
  rejected** — and that clause may not carry a *literal* `data_scope` constraint. A
  `${{ input.userId }}` or `${{ input.scope.<namespace> }}` placeholder is fine, because it resolves
  to the firing record's own value. Grant only the read the rule needs: the credential declaring the
  trigger must itself hold whatever the rule asks for, so a broad read here demands a broad
  credential.

- `firingSource.schemaName` + `firingSource.event` (`CREATE`/`UPDATE`/`DELETE`) — which schema
  event invokes the script. `schemaName` must name a `typeName` this same blueprint declares
  under `schemas:`.
- `scriptRef.name` + `scriptRef.version` — the script to run. `version` is an exact integer, or
  the literal `"latest"` to float to whichever version is current when the trigger actually fires
  (rather than pinning to the version current at blueprint-apply time).

  ⚠️ **If the script is one this blueprint SHIPS via `scripts:`, `latest` is the only accepted
  value** — a pin is rejected at authoring time. Version numbers are assigned by the platform, so a
  blueprint cannot know which number its own source landed on, and a pin would keep running the
  superseded version after the source was edited. The freedom to pin applies to a `scriptRef` naming
  a script this blueprint does not ship, which is what the example above does.
- A grant — `roleIds` (composed from `roles`, every id must resolve to a role this blueprint
  declares) **or** an inline `allowedActions`/`dataScope` pair, mutually exclusive, the same XOR
  shape `accessProfile` uses. This is the authority the script executes under — least-privilege,
  scoped to only what the trigger's own logic needs, never inherited from whoever applies the
  blueprint.
- `manifest` (optional) — a list of host-object verbs (e.g. `records.get`) further narrowing what
  the script may call, on top of whatever the grant above would otherwise permit. Never widens it.
- `dataScope` values may use `${{ input.<dim> }}` — resolves to a stamped dimension on the record
  whose change fired the trigger, the same "confine to the acting record's own identity" pattern
  `${{ self.* }}` gives the calling principal. This placeholder is valid **only** inside a
  `triggers[<name>].dataScope` value; it is rejected everywhere `roles`/`accessProfile` accept a
  placeholder.

**Removing a trigger de-provisions it.** Triggers are the one thing an apply reconciles by
*absence* as well as presence: delete an entry from `triggers` and re-apply, and its rule and the
access profile behind it are deleted, so a trigger you removed cannot keep acting under a grant
that outlived it. Its service principal is kept, so re-adding the same trigger later reattaches to
the same identity rather than creating a second one. Triggers created outside this blueprint are
never touched — ownership is established from the trigger's own service principal, not its name.
Nothing else a blueprint declares is ever deleted by removing it: drop a `schemas` entry and the
schema (and its records) stay, drop a `roles` entry and the role stays, since either could be in
use by something this blueprint cannot see.

**Removing a script does NOT de-provision it** — the deliberate counterpoint to the paragraph above,
and the asymmetry to remember. Drop an entry from `scripts` and re-apply, and every stored version
stays. Each version does carry a record of which blueprint pushed it (used to gate PUSHING a new
version onto an existing name — see the next paragraph), but there is no second, principal-shaped
factor to pair that marker with the way a trigger row has one, so deleting on it alone would still be
unrecoverable — the stored source is the only copy. The platform refuses (`409`) to delete a version
still referenced by a live trigger rule — directly, by a pinned `scriptRef`, or via `"latest"` when the
version being deleted is the current newest of its name — so re-point or remove the trigger first. An
unreferenced script version is inert, so leaving it costs storage and nothing else. Remove one
deliberately with `vectros scripts delete`, after `vectros scripts list` shows you what a context
holds.

**Pushing onto a name you don't already own is refused.** Before superseding a script name that
already has a version, the loader checks who pushed the current one: a name already marked for a
*different* blueprint is refused outright (push under a different name instead); a name with no
marker at all (hand-authored, or pushed before this marker existed) is refused unless the operator
re-runs with `--allow-script-adoption` — a flag only the operator running `bootstrap` or `vectros blueprint apply` can supply, never
something a blueprint can declare for itself. A blueprint that already owns a name (or is pushing it
for the first time) needs neither. Adoption itself is subject to the platform's own authorization on
top of this flag: an account owner can adopt any unmarked name, but one Dev Portal team member cannot
adopt a name a *different* team member hand-pushed — see the CLI's own `AUTHORING.md` for the full
mechanism.

A blueprint may also declare top-level **`issuers`** — trusted third-party IdP
issuers to register for BYO-IdP token exchange, each `{ issuerId, issuer, jwksUri,
audience, contextId, subClaim?, emailClaim?, userinfoUri?, restrictedToDomain?, selfSignupPolicies?, capturedClaims? }`.
`jwksUri` and, when set, `userinfoUri` must be `https://` URLs — the platform rejects an `http://` value
at apply time. `restrictedToDomain` names a domain already verified for your account (verified once, in
the developer portal) and is written as a lowercase DNS name such as `acme.com`, never a URL: it scopes
the registration to that domain — a token matches only when its `hd` claim equals it. Google Workspace emits
`hd` natively; other identity providers need a claims-mapping rule that emits a claim named exactly `hd`, and
a token without a matching one is not matched at all, so scoping an issuer whose users sign in without it
locks them out. An unverified domain fails the apply with the platform's `400`.
Omitting it on a re-apply leaves an existing scope unchanged. On platform 0.45.0 and later a scope is removed only
from a registration that already holds the unrestricted `(issuer, audience)` pair, which one created with a domain
normally does not: `vectros issuers update --clear-restricted-to-domain` is refused for it. To get an unrestricted
issuer, delete the scoped one, declare a new one without `restrictedToDomain`, and verify it with
`vectros issuers verify`. A context holds one active issuer, and an issuer that any user has been created or
matched through cannot be deleted; in that case declare the new issuer under a different app context. An issuer declared WITHOUT it starts
`pending_verification` on platform 0.45.0 and later and accepts no token until you prove you control the identity
provider: `vectros bootstrap` or `vectros blueprint apply` (`@vectros-ai/cli` 0.23.0 and later) still finishes and exits `0`, prints the challenge and the command that answers it
(`vectros issuers verify`) at the end of its output, and exits `4` for a pending issuer only when given `--require-verified-issuers`. A tenant is capped at 50 registered issuers. Unlike `schemas`/`accessProfile`/
`roles` (applied under a per-context token), issuers are applied in the loader's
**bootstrap-token phase**, alongside app-context/service-principal creation —
tenant-wide provisioning config that needs the bootstrap credential's owner-only
authority, not an ordinary context-scoped one. `(issuer, audience)` must be
globally unique across the tenant — use a distinct `audience` per environment/
context sharing one IdP account.

Each entry's **`contextId` must equal the blueprint's own `contextId`**. An issuer
is a trust anchor — whoever controls its `jwksUri` can mint identities your tenant
accepts — so a blueprint may only attach one to the context it actually provisions.
One IdP account serving several contexts therefore needs one entry per context,
each in that context's own blueprint; that is no extra work, since the
`(issuer, audience)` uniqueness rule already forces a separate entry per context.

**`capturedClaims`** names additional OIDC claims — beyond `emailClaim`, which keeps its own field —
to read from this issuer's tokens on every successful exchange and store as your tenant's golden
identity-provider-asserted copy for the signed-in user. Not a fixed set: name whatever your provider
actually asserts. Each is read from the verified token first, falling back to `userinfoUri` (when
configured) only for names still missing. Omit to capture nothing beyond email. At most 20 entries
of at most 64 characters; a duplicate is rejected rather than deduplicated.

The top-level **`identityProjectionClaims`** is the other half: it declares which of those captured
names are projected, read-only, onto access profiles in this blueprint's app context. Capture and
projection are separate opt-ins — capturing stores a claim against the user, projecting exposes it
on a profile — and declaring a name no issuer captures simply never fills. A profile's projection
fills once, the first time a sign-in for that principal can supply a value (for an invited member,
not until they accept and sign in), and never updates again; editing the list therefore affects only
profiles not yet filled, and re-applying a blueprint does not re-project existing ones. Omit to leave
the context's declaration unchanged, or declare an empty list to disable future projection.
**The declaration takes effect when the app context is CREATED.** Re-applying a blueprint against a
context that already exists does not change it, in either direction — a declared list is not
applied and an empty list does not disable. Change an existing context's declaration through the
platform API instead. Like
`issuers`, it applies in the **bootstrap-token phase** — setting it needs the platform provisioning
capability, which only that phase's credential carries.

A blueprint may also declare top-level **`namespaces`** — entity-namespace
registrations, each `{ namespace, specificityRank, entityBacked?, membershipRecordType?,
membershipTargetField?, membershipLevelField?, membershipLevels?, tenantWide? }`. Like
`issuers`, these are applied in the loader's **bootstrap-token phase**, alongside
app-context/service-principal creation. Every declared namespace is **owned by the
blueprint's own `contextId` by default**.

- `namespace` — 2-32 chars, a lowercase letter first, then lowercase letters/digits/
  `_`/`-`. A closed set of words is rejected as reserved (`user`, `record`, `document`,
  `entity`, `self`, `tenant`, `context`, `scope`, `versions`, `lookup`) — `org`/`client`
  are NOT in that set: they're reserved namespace names, not built-ins, registered the
  same way as any other. They already exist tenant-wide in every account at
  `specificityRank` 1000/2000 (below); a context-owned registration needs a different
  rank, and shadows the tenant-wide one for this context's own callers.
- `specificityRank` — an integer `0..1_000_000`, this namespace's position in the
  account's specificity order (breaks ties when a caller holds two scope dimensions
  at once). Must be unique among this blueprint's own namespaces; the platform is the
  only party that can see the rest of the account's registrations (including `org`=
  1000 and `client`=2000), so a collision with those or another blueprint's namespace
  still surfaces at apply, same as any other non-idempotent-registration collision.
- `entityBacked` (optional) — when `true`, every value in this namespace must resolve
  to an existing identity entity; when `false`/omitted, values are free-form strings
  validated by grammar only.
- `membershipRecordType` + `membershipTargetField` — optional, declared together
  (or both omitted): which record type + field hold grants of this namespace's
  values. `membershipRecordType` must name a `typeName` **this same blueprint**
  declares under `schemas:` — membership can only resolve over a record type the
  blueprint itself ships, never one that merely already exists in the target
  context. Declaring this grants nobody anything on its own; a role opts in
  explicitly with `${{ member.scope.<namespace> }}` in its `dataScope`.
- `membershipLevelField` + `membershipLevels` — optional, declared together: the
  field naming a grant's level (so the same user can hold different levels in
  different values of this namespace) and the complete set of level labels allowed.
- `tenantWide` (optional, default `false`) — request the platform's tenant-wide
  registration form (visible to every context in the account) instead of this
  blueprint's own context. Declaring it is not a grant on its own: the applying
  credential must separately hold OWNER-only authority, and the CLI refuses to even
  request it without an explicit `--allow-tenant-wide-namespaces` flag at
  `bootstrap`/apply time — a blueprint cannot make this happen by itself.

Registration is **not idempotent server-side**: a re-apply whose declaration matches
what's already registered converges silently, but one that disagrees with the live
registration fails the apply rather than silently overwriting it. For a `tenantWide`
namespace this includes a collision with a **different** blueprint's (or a manual)
registration of the same name — that always fails rather than being silently adopted,
since a tenant-wide row is co-owned by no single blueprint.

A blueprint may also declare a top-level **`identities`** — a map of local name →
principal declaration, each `{ kind, externalId, displayName?, metadata? }`. It
names principals the blueprint expects to exist so other fields can *reference*
them, without the blueprint creating a person-specific credential itself:

- `kind` — `user` (the fixed principal surface) or an entity namespace (`org`,
  `client`, or one you registered) — the same value set `vectros identity create
  --type` accepts.
- `externalId` — your stable id for the principal. Resolution is idempotent by
  this value (ensure-exist), the same posture as `servicePrincipal`.
- `displayName` (optional) — an entity's `name`; for a `user` (which has no
  first-class `name` field) it's folded into `payload.displayName` instead.
- `metadata` (optional) — a JSON object merged into the principal's `payload`.

Reference a declared identity anywhere a principal id is valid — a schema's
`userId`/`scopes`, an `accessProfile`/role `dataScope` or `identityOverrides`,
seed-record ownership — with a **`${{ identities.<name> }}`** token. For example,
an `identityOverrides` entry that stamps every record the service key writes as
owned by a declared `team` identity:

```
identityOverrides: { "scope:org": "${{ identities.team }}" }
```

Resolution is its own creds-bearing pass, **earlier than either loader phase**
(the reason `identities` is deliberately absent from `BLUEPRINT_FIELD_PHASES`
below): every *declared* identity is ensured to exist — tenant-wide, under the
bootstrap credential, the same category as `servicePrincipal` — whether or not
anything in the blueprint actually references it, and every `${{
identities.<name> }}` token is then substituted with the resolved principal's
bare (unprefixed) id before the bootstrap/in-context phases ever run. A `user`
identity defaults to `HUMAN` (the blueprint's own `servicePrincipal` is the
separate SERVICE credential).

Two things are caught **offline**, at `validate`/`plan`, rather than surfacing
only as a live apply failure: a `${{ identities.<name> }}` token that names an
identity NOT declared in the `identities` block is a parse-time error, and only
the **whole identity id** can be referenced — a dotted property access like
`${{ identities.team.externalId }}` is rejected, since the resolver only ever
has a bare id to substitute, never the declaration's other fields. A declared
name is separately constrained to letters/digits/underscore, not starting with a
digit (`demoOrg`, not `demo-org`) — the same grammar a `${{ identities.<name> }}`
token itself can match. A name outside it is rejected as a parse error at
declare time (`validate`/`plan`), not silently accepted as unreferenceable.

Which top-level fields apply in which loader phase isn't something you have to
infer or remember: `BLUEPRINT_FIELD_PHASES` (exported alongside `Blueprint`) is a
`{ fieldName: 'bootstrap' | 'in-context' }` map you can inspect directly —
`@vectros-ai/cli`'s own `vectros blueprint plan` preview derives its
`[<phase>-token phase]` annotations from this same map, so the two can't drift.
`identities` isn't in it, for the reason given above.

All of the above are **optional and backward-compatible** — a blueprint that
omits them parses and provisions exactly as before.

## Authoring

Drop a `blueprints/<name>.ts` exporting a `Blueprint` default, register it in
`src/index.ts`. The bundled-library test guards that every blueprint parses;
the CLI's scope-gate test guards that every bundled blueprint stays
data-plane-only. The bundled `task-management` blueprint is the
heavily-commented exemplar — copy it to start.

**`fieldType` must be a platform-supported type** — one of `string`, `number`,
`boolean`, `date`, `enum`, `array`, `object`, `reference`.
The format keeps `fieldType` a free-form string for forward-compat, so an unsupported
value (e.g. `string[]` — a string array is **`array`**) parses fine but **400s at
`createSchema`** on a live apply. The bundled-library tests include a `fieldType`
allowlist guard so this fails at PR time, not on apply.

**Authoring a `reference` field.** A field with `fieldType: 'reference'` declares a typed
link to another record. The blueprint format carries these extra authoring keys:

- `targetTypeName` (**required**) — the `typeName` the link points at.
- `targetSurface` (**required**) — which surface the target lives on: a fixed
  surface (`record` | `document` | `user`) or an entity-backed **namespace**
  (`org`, `client`, or one you registered). The same `typeName` can exist on more
  than one surface, so this disambiguates which lookup resolves the link. The value
  set is data-driven (namespaces are tenant-defined), so it is a free string, not a
  closed enum. (Omitting it 400s at `createSchema` — "requires targetSurface".)
- `targetField` (optional) — the field on the target used to resolve the link; defaults
  (platform side) to the target's `externalId` / lookup key when omitted. Must name a
  **unique** lookup on the target type.
- `cardinality` (optional) — `one` (default) or `many`.

```ts
{
  fieldId: 'authorId',
  fieldType: 'reference',
  targetTypeName: 'author',
  targetSurface: 'record',
  targetField: 'externalId',
  cardinality: 'one',
}
```

Write-time existence of the target **is** enforced by default — a referencing record can
only be written once its target exists (so seed the target first). There is no
reverse-reference index on this surface; to query "which records reference X", add the
reference field to `lookupFields` as an equality lookup. The bundled `agentic-sdlc`
blueprint is the exemplar (a `decision`'s `supersedes` field links to the `decision` it
replaces).

## Testing a blueprint

Blueprints are tested **like code**, in two layers:

1. **Change-time (every PR, no creds):** the `@vectros-ai/cli` unit suite runs every
   `BUNDLED_BLUEPRINT` through the harness core (snapshot → apply → assert → teardown)
   with a fake client, plus the structural + scope-gate + `fieldType` guards here. A
   new blueprint the loader can't provision fails here.
2. **Live credential proof (one-time, on a new/changed blueprint):**
   `vectros blueprint-test <name>` against your tenant (apply → assert a real `ssk_*`
   ping → created-only teardown). Needs a bootstrap token — see the `@vectros-ai/cli`
   docs.

> ⚠️ Applying a blueprint that declares its **own new `contextId`** requires a bootstrap
> token with authority to **create** that app-context. A token pinned to an existing
> context can't create a new one, so the apply step will fail — bootstrap into an existing
> context, or use a token with context-creation authority.

## Security & trust

Vectros enforces per-customer, fail-closed isolation and least-privilege scoped keys, with a
tamper-evident audit and version history. Customer-facing surfaces are hardened through extensive
adversarial security review. For the full trust posture, drawn plainly with its boundaries, see the
[compliance and trust guide](https://docs.vectros.ai/guides/operations-trust/compliance).

## License

Apache-2.0. See the LICENSE file.
