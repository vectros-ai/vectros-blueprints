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
- `BUNDLED_BLUEPRINTS` / `BLUEPRINT_NAMES` / `getBlueprint(name)` — the
  curated library: `task-management` (the minimal authoring exemplar),
  `coding-agent-memory`, `agentic-sdlc` (a whole-SDLC system of
  record for an AI dev team: ten schemas — nine curated (split by content vs
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

- **`lookupFields`** — each entry is either a bare field name (`"status"`) or an
  object `{ fieldName, unique?, rangeEnabled?, sortBy?, allowOverflow? }`. The
  index shape is **migration-locked** — you cannot change it once the schema is
  live, even by removing and re-adding the field — so choose deliberately:
  - `unique` enforces a uniqueness constraint.
  - **equality (default) vs. `rangeEnabled`** — equality for ids/foreign keys/
    status enums/categories; `rangeEnabled` (ordered `from`/`to`/`prefix`, billed
    at the range rate) for values you query as an order (**dates, sequences,
    scores, versions**). Range/prefix order is lexical, so ISO-8601 dates sort
    correctly but an ordinal enum (`low…urgent`) would sort alphabetically — leave
    those as equality.
  - **7-slot budget** — a schema has 7 fast equality-lookup slots (ownership ids +
    `externalId` ride their own; `rangeEnabled` lookups use a row, not a slot, so
    they don't count). An 8th equality lookup is rejected unless it sets
    `allowOverflow` (a higher-cost secondary index).
  - `sortBy` sets the equality-lookup listing order (`createdAt` default,
    `lastUpdated`, or a declared field). Sorting by an **optional** field silently
    drops records lacking it — prefer the always-present timestamps.
  - **Sensitive fields may be equality lookups** (HMAC blind index → exact
    find-by-value without storing the value in the clear), but never `rangeEnabled`
    (a hash is not orderable), and no `sortBy` may name a sensitive field.
  Max 10. Do **not** list a reserved identifier (`externalId` or an ownership id) —
  those have first-class finders, so the platform rejects redeclaring them as
  schema lookups.
- **`capabilities`** — today `{ auditHistory }`; defaults to `true` on the
  platform when omitted. Surface it to make the audit posture self-documenting.
- **`active`** — whether the schema accepts new records (inactive schemas reject
  creation). Defaults to active.
- **`userId` / `orgId` / `clientId`** — schema-level ownership defaults (flat,
  mirroring the platform `SchemaRequest`). With a scoped token these must be
  consistent with the profile's `dataScope`.

The `accessProfile.dataScope` value lists accept a **`null` sentinel** — e.g.
`{ orgId: ["org_x", null] }` grants `org_x`'s records **plus** tenant-level
(owner-less / shared) records. Omitting `null` restricts the key to the listed
owners only.

A blueprint may also declare top-level **`roles`** — a map of `roleId` → ordered
scope clauses (each an `allowedActions` list with an optional `dataScope`). Unlike
`accessProfile` (which scopes the service-principal key `bootstrap` mints), roles
are reusable, identity-agnostic rules you bind to a principal *after* bootstrap with
`vectros access grant --principal <p> --role <roleId>`. `bootstrap` provisions the
declared roles in the context but binds them to no one. The bundled `agentic-sdlc`
ships an `editor` role for this — join your own user to the context so you can
browse and curate the knowledge base in the app. Role clauses pass the same
data-plane scope gate as `accessProfile`.

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
- `targetSurface` (**required**) — which surface the target lives on
  (`record` | `document` | `user` | `org` | `client`). The same `typeName` can exist on
  more than one surface, so this disambiguates which lookup resolves the link. (Omitting
  it 400s at `createSchema` — "requires targetSurface".)
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
reference field to `lookupFields` as an equality lookup. The bundled `coding-agent-memory`
blueprint is the exemplar (a `convention` links to the `decision` that established it).

## Testing a blueprint

Blueprints are tested **like code**, in three layers:

1. **Change-time (every PR, no creds):** the `@vectros-ai/cli` unit suite runs every
   `BUNDLED_BLUEPRINT` through the harness core (snapshot → apply → assert → teardown)
   with a fake client, plus the structural + scope-gate + `fieldType` guards here. A
   new blueprint the loader can't provision fails here.
2. **Post-deploy canary:** one bundled blueprint runs a live `blueprint-test` in the
   CLI staging smoke to catch unrelated API-contract regressions.
3. **Live credential proof (one-time, on a new/changed blueprint):**
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
