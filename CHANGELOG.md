# Changelog

All notable changes to `@vectros-ai/blueprints` are documented here.
This project adheres to [Semantic Versioning](https://semver.org).

## 0.20.3 — 2026-10-25

### Fixed

- **A trigger's `dataScope` can use `${{ input.userId }}` and `${{ input.scope.<namespace> }}`.** The platform resolves these
  against the record that fires the trigger, and a file blueprint that uses them now passes install-time resolution and validation.

### Changed

- **The comments in the shipped code describe the code as it is today.** Behaviour is unchanged.

### Documentation

- **The README describes the `inputs:` block and the input and identity-resolution exports.** It states that a trigger's
  `scriptRef.version` is a string (`'3'`) or `"latest"`, and that `getBlueprint` returns `undefined` for an unknown name.
- **The agentic-sdlc guide counts eleven schemas, and the agent prompt says a `429` `BALANCE_BUSY` or a `503`
  `BALANCE_UNAVAILABLE` from `rag_ask` is not a shortage and to retry.**

## 0.20.2 — 2026-10-12

### Documentation

- **README corrections.** Removing a trigger from a blueprint de-provisions it on `vectros bootstrap` and on
  `vectros blueprint apply --prune`; `blueprint apply` without `--prune` deletes nothing. A trigger is removed only when
  it carries the blueprint's own marker and its service principal is the one the blueprint created. `vectros access
  grant` takes `--context`. An issuer's `issuer`, `jwksUri` and `userinfoUri` must be printable-ASCII `https://` URLs
  whose host is letters, digits, dots and dashes with an optional port, and the package rejects any other value as soon as the
  blueprint is parsed. A `reference` field without `targetSurface`, or with `targetSurface:
  entity`, is rejected when the blueprint is parsed. `externalId`, `userId` and `scopes` are not payload fields, and the
  examples do not declare `externalId`. `capabilities` belongs on `accessProfile`, on a role clause and on a trigger
  entry only. `agentic-sdlc` also ships the store-only `candidate` schema. `identityProjectionClaims` applies only when
  the app context is created. `${{ self.* }}`, `${{ under.self.* }}` and `${{ member.* }}` are refused in a trigger's
  grant, including through a composed role. A `sensitive` and `searchable` field is refused by the
  platform at schema creation, not by `validate`. Range lookups order `number` and `date` fields numerically and
  chronologically and string fields lexically. An `(issuer, audience)` pair is unique across all accounts. Declared
  identities resolve after the context, service principal and namespaces exist. `@vectros-ai/cli` forwards
  `capabilities` and admits only `member-lifecycle` and `delegate-principal-stamp`, and refuses a trigger grant on a
  control-plane resource. Signup does not register the `org` and `client` namespaces, so an account has
  them only once it registers them.
- **The `namespaces` field documentation says the same about `org` and `client`.**
- **Source comments state their rules themselves, and the `agentic-sdlc` guide points at the right section.** Comments
  that pointed at internal design documents now say what the rule is, so the source maps that ship with the package read
  on their own, and the guide's two references to the `memory` tier name its section (5), not section 8. No behavior
  changes.
- **The README states where a declared identity lives.** A `user`, and an entity in a tenant-wide namespace, are
  tenant-placed and survive `context destroy`; an entity in a namespace the blueprint declares (context-owned by
  default) is placed in the blueprint's context and erased with it.

## 0.20.1 — 2026-10-01

### Changed

- **The README and the `restrictedToDomain` field documentation describe how to get an unrestricted issuer from a
  domain-scoped one.** The platform refuses `vectros issuers update --clear-restricted-to-domain` unless the
  registration already holds the unrestricted `(issuer, audience)` pair, which one created scoped to a domain does
  not. Delete the scoped issuer, declare a new one without `restrictedToDomain`, and verify it with
  `vectros issuers verify`. A context holds one active issuer, and an issuer that any user has been created or
  matched through cannot be deleted; in that case declare the new issuer under a different app context.

## 0.20.0 — 2026-09-22

### Added

- **`issuers[].restrictedToDomain`.** A blueprint's issuer may now name a domain already verified
  for your account (verified once, in the developer portal). The registration is then scoped to
  that domain: a token matches only when its `hd` claim equals it, and an unrelated registration of
  the same issuer and audience never blocks it. A token with no matching `hd` claim is not matched
  at all, so scoping an issuer whose users sign in without one locks them out. It is written as a
  lowercase ASCII DNS name (`acme.com`): a URL, an uppercase letter, a port, or a non-ASCII
  look-alike domain is rejected when the blueprint is parsed; write an internationalized domain in
  its punycode (`xn--…`) form. The check is also exported as `isRestrictedToDomainName(value)`, so a
  tool that takes the same value elsewhere does not need its own copy of the grammar.
  `vectros bootstrap` shows it in the plan and forwards it on register and on re-apply; leaving it
  out on a re-apply keeps an existing scope, it does not clear it.

### Changed

- README: an issuer declared without `restrictedToDomain` starts `pending_verification` on platform 0.45.0 and
  later; `vectros bootstrap` or `vectros blueprint apply` (`@vectros-ai/cli` 0.23.0 and later) prints the challenge and the
  `vectros issuers verify` command, and exits `0` (or `4` with `--require-verified-issuers`). The README names
  `vectros blueprint apply` alongside `vectros bootstrap` where it says who supplies `--allow-script-adoption` and
  how a pending issuer is handled. The blueprint format itself is unchanged: the verification
  fields are on the platform's response, not something a blueprint declares.

## 0.19.0 — 2026-09-17

### Changed

- **⚠️ BREAKING: blueprint-authored free-text fields that reach a rendered, human-reviewed
  surface — today, `@vectros-ai/cli`'s pre-apply plan preview and its identity-disclosure/
  confirmation prompt — now REJECT forgery and homoglyph characters at parse time, instead of
  trusting every renderer downstream to sanitize its own inputs. This NARROWS what
  `parseBlueprint` accepts: a blueprint that parsed successfully under 0.18.x may now be
  rejected if one of the affected fields carries one of the characters below.** Several fields
  had no character-set constraint at all (`z.string().min(1)`, unlike `issuerId`/`roleId`/
  `signupType`, which the schema already pins to a lowercase-letters/digits/dashes regex): a
  blueprint's `name`/`version`/`contextName`; a service principal's `externalId`/`displayName`;
  a declared identity's `externalId`/`displayName` (printed immediately before the CLI's "Apply
  this plan?" gate); an issuer's `capturedClaims` entry; `identityProjectionClaims`; a
  `dataScope` value (in `roles`, `accessProfile`, `fragments`, `roleAssumable`, or `triggers`);
  an `allowedActions`/`fields` entry (in `roles`, `accessProfile`, or `triggers`); a field's
  `fieldId`; a schema's `lookupFields` entry (bare-string, `fieldName`, or `fieldNames` form); a
  trigger's `scriptRef.name`; a schema's or seed's `typeName`/seed's `externalId`; and the
  `roles`/`triggers` map KEYS themselves (`roleId`/`triggerName`), not just their values.

  **What is now rejected on those fields:** a raw newline or carriage return (forges a fake
  extra line), an ANSI escape sequence, a Unicode line/paragraph separator (U+2028/U+2029), a
  bidi-override/isolate character (U+202A-U+202E, U+2066-U+2069), a bidi MARK (U+200E, U+200F —
  reorders neutral characters without a full override), an invisible/zero-width character
  (U+00AD, U+061C, U+200B-U+200D, U+2060, U+FEFF), or a Unicode tag character (U+E0000-U+E007F).

  **An issuer's `issuer`/`jwksUri`/`userinfoUri` get a STRONGER, different check** (`safeUrlString`,
  not the blocklist above): the entire value must be printable ASCII, start with `https://`
  (`http://` is REJECTED — see below), and its AUTHORITY (the substring between `://` and the
  first `/`, `?`, or `#`) must match `[A-Za-z0-9.-]+(:\d+)?` — letters, digits, dot, dash, and an
  optional numeric port. This is a GRAMMAR on the raw authority, not a call to `new URL()`
  followed by more checks on the result — an earlier version of this check did parse with
  `new URL()`, which turned out to have two bypasses of its own: it percent-decodes the
  authority as part of parsing (so a percent-encoded homoglyph host decodes to the same string a
  literal homoglyph would also get punycode-normalized to, indistinguishable after the fact), and
  it splits `user@host` syntax into `.username`/`.hostname` separately (so `jwksUri:
  trusted-name@evil.example` parses with `.hostname === 'evil.example'` while the RAW string an
  operator reads shows the trusted-looking prefix first). The authority grammar excludes `%` and
  `@` outright, closing both by construction rather than patching the check that missed them.

  This closes the HOMOGLYPH class the blocklist cannot — a Cyrillic/Greek/etc. look-alike
  character in a domain (e.g. a Cyrillic `а` standing in for Latin `a`) is invisible to any
  enumerable "forgery character" list, since it is an ordinary-looking letter, just from the
  wrong script. An author who needs a genuine internationalized domain must supply its already-
  punycode (`xn--…`) ASCII form — which is what a real IdP presents on the wire, and which now
  reads as visibly distinct from a trusted plain-ASCII domain (with percent-encoding and userinfo
  excluded, what the operator reads in the rendered plan IS the actual authority).

  `https://` only, not `http://`: the platform hard-refuses a non-`https` issuer/jwksUri/
  userinfoUri at registration, so accepting `http://` here would repeat this package's own
  "lints clean, then 400s at apply" anti-pattern for the exact field this check exists to catch
  problems in beforehand.

  **Residuals, named rather than chased:** a trailing-dot host (`good.example.`) still passes
  (cosmetic); a bare IPv4 literal (`192.0.2.1`) still passes (a platform-side fetch concern this
  preview isn't positioned to evaluate); a bracketed IPv6 literal (`[::1]`) is rejected as a side
  effect of excluding `[`/`]`/extra `:` from the authority grammar (an acceptable false-reject,
  not a gap — an IdP is never realistically IPv6-literal-addressed in practice).

  **What this does NOT close, stated rather than implied:** (1) LENGTH is not bounded by either
  check (no `.max`) — `@vectros-ai/cli`'s `sanitizeForPlanDisplay` caps it at the render site
  instead. (2) The blocklist does not close the HOMOGLYPH class for a non-URL field — `name`,
  `contextName`, `fieldId`, and similar identifier/prose fields can still be authored with a
  visually-confusable character from a different Unicode script, since no enumerable blocklist
  can cover the full confusables space and these fields have no "must be ASCII" constraint a
  legitimate author could always satisfy the way a URL author can.

  **`description` (the blueprint's own top-level field) is DELIBERATELY UNAFFECTED — not wrapped
  at all, on either check.** It is never rendered on any operator-facing surface, and this repo's
  own flagship example blueprint authors it as a YAML folded (`>`) block scalar, which always
  parses to a string ending in exactly one trailing newline — indistinguishable from a forgery
  attempt to any of the checks above, and a defect this exact wrap introduced and then had
  reverted during review. If your blueprint's `description` is written as YAML block-scalar
  prose (the common case for a multi-line description), this release does not affect it.

  A new `safeDisplayString` schema wrapper (blocklist) and `safeUrlString` schema wrapper
  (positive URL check) close their respective classes at the schema once, for every current and
  future renderer, rather than requiring each new rendered field to remember its own
  sanitization. A map KEY (`roles`/`triggers`) uses `z.record`'s two-argument key-schema form,
  since neither wrapper can reach a record's key type directly, only a `ZodString` value.

  This narrows the vector; it does not eliminate every theoretical surface a `Blueprint` object
  could reach without ever passing through `parseBlueprint` (e.g. a caller constructing one by
  hand, which is how every bundled/first-party blueprint is loaded today) — `@vectros-ai/cli`'s
  own plan-preview renderer keeps its existing per-site sanitization as a second line of defense
  for exactly that case, and this package's own test suite round-trips every bundled blueprint
  through `parseBlueprint` (`GUARD: every bundled blueprint is structurally valid`) so a stray
  forgery character introduced by accident is still caught before it ships, even though the
  runtime `--blueprint <name>` path does not re-validate a bundled blueprint on every run.

  **Why a MINOR bump, not a patch, for a security fix:** this narrows what a previously-valid
  input this library accepts — a currently-valid blueprint could newly fail `parseBlueprint` if
  it carries one of the characters above in one of the affected fields (URL fields: also if the
  domain isn't plain-ASCII or the value isn't a well-formed URL). A published validation
  library's accepted-input surface is part of its contract; this repo's own blueprints were
  checked and are unaffected (after the `description` revert above), but a third party's cannot
  be. Run `vectros blueprint validate` against your blueprint(s) before upgrading.

### Docs

- **README correction: a script row DOES carry provenance now.** The `scripts:` section
  previously said "a script row carries no record of which blueprint pushed it" — true before
  `@vectros-ai/cli`'s script push-ownership gate shipped, false now. Corrected to describe the
  current behavior: each version does carry a provenance marker (used to gate pushing a new
  version onto an existing name), it's deletion that still has no second factor to gate on
  safely. Also documents the new push-ownership refusal and `--allow-script-adoption`. No
  behavior in this package changed — `@vectros-ai/blueprints` itself doesn't enforce any of this,
  the CLI does — so no version bump, just the correction.

- **README corrections for three 0.44.0 platform changes.** Deleting a script version still
  referenced by a live trigger rule is now refused (409, naming the rule) instead of silently
  breaking the trigger. The `issuers` field list was missing the new `restrictedToDomain` field,
  and didn't note that `jwksUri`/`userinfoUri` must now be `https://` or that a tenant is capped
  at 50 registered issuers. The `triggers` section didn't note that a grant naming a control-plane
  resource now requires the new `trigger-control-plane-grant` capability. No behavior in this
  package changed — these are all platform-enforced, not authored here — so no version bump.

### Fixed

- **Ten source comments named internal backend classes/methods by name** (in `src/types.ts` and
  four test files) describing which platform-side validation, limit, or gate a piece of
  authoring-time logic mirrors. Reworded to describe the mechanism without the class/method name;
  no behavioral change. Also reworded this file's own 0.12.0 entry, which named an internal
  workstream code, for the same reason — a `CHANGELOG.md` entry ships in every future tarball and
  mirror snapshot, so leaving an old one uncorrected re-publishes the leak with every release.

- **Two more sites named an internal backend identifier or an internal review-process finding**
  (`src/inputs.ts`'s doc comment naming an internal placeholder-grammar constant; a test in
  `tests/triggers.test.ts` attributing a fix to an internal reviewer's finding) — found by a
  post-merge audit. Reworded to describe the mechanism/gap generically; no behavioral change.

## 0.18.0 — 2026-09-07

### Added

- **A `scripts` block — a blueprint can now ship the source its trigger runs.** A map of script
  name → `{ source, declaredInputContract? }`, so a blueprint that declares a trigger can carry the
  code that trigger runs. A `scriptRef` is validated when the rule is DECLARED rather than when it
  fires — a rule naming a script with no versions in the target context is refused outright — so
  `scripts` is applied before the triggers that reference it.

  `source` is required, non-blank and capped at 300,000 UTF-8 bytes; `declaredInputContract` is
  optional, capped at 50,000, and descriptive only — nothing validates a firing against it. Both
  caps are counted in UTF-8 BYTES to match the platform, so a source full of multi-byte characters
  cannot slip past by being short in characters. Nothing parses the source, here or on the platform:
  a syntax error stays invisible until the version first runs.

  **The source is inline and there is no `path:`.** A shipped script runs under its trigger's
  declared grant, so it is live authority, and a blueprint is a bundle someone reviews before
  applying — keeping the source inside the bundle keeps what runs inside what was reviewed. It also
  keeps this package filesystem-free, which it has to be.

  **A version is not declarable, and a trigger naming a script this blueprint ships must use
  `version: latest`** — rejected at authoring time otherwise. Versions are assigned by the platform
  and a stored version is immutable, so a blueprint declares only the current source for a name; a
  pin would name a version the blueprint cannot know it produced, and once the source is edited that
  rule would go on running the superseded version with nothing to indicate it. A `scriptRef` naming
  a script the blueprint does NOT ship is unrestricted and may still pin, which is the existing
  "reference a script someone else pushed" case and keeps working unchanged.

  The map key is the script name and carries the platform's grammar (1–64 characters of letters,
  digits, `_`, `-`), checked at authoring rather than failing partway through an apply. `scripts` is
  applied in-context, and before the triggers that reference it.

- **`triggers[].fields`** — the record fields a rule projects into its script's
  `input.record`, and on an `UPDATE` firing into `input.previous`. `fields: []` is the "project
  nothing" declaration; the script still receives `input.recordId`. Required rather than defaulted
  so that projecting nothing is something an author states. An entry may name only a field the
  schema keeps inline — `inline: true`, `filterable: true`, or a lookup field (a leg or its `sortBy`
  target) — and never one marked `sensitive`; `parseBlueprint` checks that against the schema in the same blueprint rather than
  leaving it to fail partway through an apply. Note a rule declaring any `fields` must also hold a
  `records:r` clause covering the firing schema's type, without a literal `data_scope` constraint.

- **`schemas[].fields[].inline`** — keep a field on the record row when the payload is stored out of
  line, so it appears in list and lookup projections without `includePayload`, and so a trigger rule
  may project it. Rejected alongside `sensitive`: a sensitive field is blind-indexed and masked, so
  a readable row copy would defeat it.

- **A `filterable: true` field whose id is a platform-owned search-index key is now rejected at
  authoring time.** Such a field shadows the platform's own value in the index, silently costing
  recall and precision on type-scoped searches, and the platform now refuses it — so a blueprint
  declaring one FAILS TO APPLY. `parseBlueprint` reports it at validate/plan instead. The reserved
  set is per bind surface and is checked against only the surface(s) a schema declares, never the
  union: `tenantId`/`owner_id`/`folderId`/`rootFolderId`/`recordType` for a schema allowing
  `record`, plus `model_type`/`title` for one allowing `document`. A schema binding only to
  `entity` reserves nothing, and a non-filterable field of any name is unaffected. `status` is
  reserved on neither surface and remains available as a filterable field.

- **`assignableRoles` on a role clause and on an `accessProfile` inline clause** — a roleId
  allow-list restricting WHICH named roles that clause may compose into a delegated AccessProfile
  (`roleIds` composition). Orthogonal to `allowedActions`/`dataScope`: it narrows which roles the
  clause's authority may hand out, not how much data it reaches. Omitting it means no restriction,
  which is how every existing blueprint keeps behaving; an EMPTY list is rejected rather than read as
  "compose nothing", because an empty list states no rule. Capped at 20 entries, each matching the
  platform's roleId grammar, duplicates rejected. Entries are deliberately not resolved against this
  blueprint's own `roles` — a clause may legitimately name a role that already exists in the context.
  Rejected on a `roleIds`-composed `accessProfile`, which has no inline clause to carry it, matching
  the carve-out `dataScope` and `capabilities` already have.

  **Adoption note:** once a clause carries `assignableRoles`, it can compose only the roles the list
  names — so name every roleId the restricted clause still needs BEFORE adding the field, not after.

- **`issuers[].capturedClaims`** — a list of additional OIDC claim names, beyond `emailClaim`, to
  capture from that issuer's tokens on every successful token exchange and store as your tenant's
  golden identity-provider-asserted copy for the signed-in user. Not a fixed set: name whatever
  claims your provider actually asserts. Each is read from the verified token first, falling back to
  `userinfoUri` (when configured) only for names still missing after that. Omit entirely to capture
  nothing beyond email — unchanged behaviour for every existing blueprint. Capped at 20 entries of at
  most 64 characters each, and a duplicate is rejected rather than deduplicated.

- **`identityProjectionClaims`** — a new, optional top-level list declaring which of the captured
  claim names above are projected, read-only, onto access profiles in this blueprint's app context.
  Applied in the BOOTSTRAP phase, alongside the context create — setting it needs the platform
  provisioning capability, which only the bootstrap credential carries, so it could not be applied
  in-context. Capture and projection are separate opt-ins: capturing a claim stores it against the
  user, projecting it exposes it on a profile. A profile's projection fills once, the first time a
  sign-in for that principal can supply a value, and never updates again — so editing this list
  affects only profiles not yet filled, and re-applying a blueprint does not re-project existing
  ones. Omit to leave the context's declaration unchanged; declare an empty list to disable future
  projection. Same bounds as `capturedClaims`. Note that the declaration applies when the app context
  is CREATED — re-applying a blueprint against an existing context does not change it.

- **`triggers`** — a new, optional top-level block declaring rules that invoke a versioned script on
  a schema record's `CREATE`/`UPDATE`/`DELETE` event. The rule fires: a matching record write runs the
  script asynchronously under an explicitly declared grant, the same least-privilege posture as
  `roles`/`accessProfile`. Each entry declares:
  - `firingSource` — the schema (by its blueprint `typeName`) and event that fires the rule.
  - `scriptRef` — the script name and an exact version, or the literal `"latest"` to float to
    whatever version is current at fire time.
  - A grant — `roleIds` (composed from `roles`) **or** an inline `allowedActions`/`dataScope` pair,
    mutually exclusive, mirroring `accessProfile`'s own XOR shape exactly.
  - `manifest` — an optional list narrowing which host-object verbs the script may call, further
    restricting whatever the grant would otherwise permit (never widening it).

  The schema a trigger fires on must opt in with `capabilities.triggersEnabled: true`. Records only
  fire triggers when their schema declares it, so a rule against a schema without it would be
  created, hold a service principal and a grant, and silently never fire — `parseBlueprint` rejects
  that shape, and the platform rejects it again on apply. It defaults to `false` and is independent
  of `capabilities.auditHistory`: turning audit history off does not turn triggers off.

- **`${{ self.* }}` / `${{ under.self.* }}` / `${{ member.* }}` are REJECTED inside a
  `triggers[<name>].dataScope` value, and in the `dataScope` of any role a trigger composes via
  `roleIds`** (they remain valid in `roles[].dataScope`, `roleAssumable[]` and `fragments[]` for every
  OTHER use — what is refused is being a trigger's grant, not the value itself). A trigger's grant is resolved at fire time against the TRIGGER PRINCIPAL's
  identity, not the author's, so `${{ self.scope.org }}` there does not mean "my org" — it means "the
  trigger principal's org", reach the author is never checked to hold. The platform refuses it; this
  lint reports it at validate/plan instead of letting an apply fail partway through provisioning. Use
  `${{ input.* }}` to confine a trigger's grant to the record that fired it, or name literal values.

- **`schemas[].capabilities.triggersEnabled`** — the opt-in above, declarable on any schema.
- **`${{ input.* }}`** — a new `dataScope` value-source placeholder, valid **only** inside a
  `triggers[<name>].dataScope` value (rejected everywhere else `roles`/`accessProfile` accept a
  placeholder). Resolves to a dimension stamped on the record whose change fired the trigger — the
  same "confine authority to the acting record's own identity" pattern `${{ self.* }}` already gives
  the calling principal, one level removed.
- Structural lint coverage for the new block: `firingSource.schemaName` must name a schema this
  blueprint actually declares; `roleIds` must name roles this blueprint actually declares and may not
  repeat one; `scriptRef.version` must be a positive integer or `"latest"`.
- `triggers` is the one block an apply reconciles by ABSENCE: removing an entry de-provisions the
  trigger (its rule and access profile), where removing a `schemas` or `roles` entry leaves the
  resource in place. See the `triggers` section of the README for the full rule,
  including which triggers are out of an apply's reach entirely.

## 0.17.0 — 2026-08-27

### Added

- **`companyName`** — a new, optional top-level scalar field, sibling to `contextName`. Where
  `contextName` is the blueprint author's own fixed app identity (the same for every deployer),
  `companyName` is meant to vary per install — typically templated from a deployer-supplied
  `${{ inputs.x }}` value rather than hardcoded. Used for branding on platform-sent correspondence
  (e.g. invite emails) alongside `contextName`, not as a replacement for it. See `companyNameOf`.
- **`companyNameOf(blueprint)`** — reads `blueprint.companyName`, `undefined` when absent. No forced
  default (unlike `contextNameOf`'s `MCP — <name>` fallback) — an absent company name means "not
  supplied," not a placeholder baked into provisioned data.
- **`schemas[].expectedScopeDims`** — advisory-only declaration of the
  ownership dimensions a schema's records are typically scoped by (e.g.
  `expectedScopeDims: ['org', 'client']`). Not sent to the platform, never
  runtime-enforced — consumed only by `@vectros-ai/cli` ≥ 0.20.0's blueprint
  lint (`partial-datascope-dimension-coverage`) to warn when a role/
  `accessProfile` clause grants `r`/`u`/`d` on that typeName but its
  `dataScope` names only SOME of these dims, silently leaving the rest
  unconstrained — the read/write `dataScope`-coverage asymmetry, a
  ratified, deliberate design decision this field helps an author notice
  rather than changes. Same grammar as a
  `dataScope` key with the `scope:` prefix stripped: a bare namespace name,
  or `'userId'`. Fully optional; a schema with no `expectedScopeDims` never
  trips the lint.

### Fixed

- Scrubbed internal issue references and a backend class name out of two
  comments — visible in the published npm package's sourcemaps to anyone who
  reads mapped source. Comment-only; no behavior change.
- Scrubbed a second backend class name missed by the pass above — 4 more
  comments in `types.ts`, found while grepping a downstream `@vectros-ai/cli`
  build's bundled dist for the same leak class. Comment-only; no behavior
  change.

## 0.16.0 — 2026-08-27

### Added

- **`accessProfile.roleIds` — additive role composition for the blueprint's own
  service-principal profile.** A new alternative to the existing
  inline `allowedActions` clause: name one or more roles this same blueprint
  declares in `roles`, and the profile's effective grant becomes each named
  role's own clauses, concatenated in the order listed — mirrors the
  platform's own `roleId` → `roleIds` shape at the
  authoring layer. Mutually exclusive with `allowedActions` (exactly one of
  the two, enforced at parse time); a `roleIds`-composed profile has no inline
  clause of its own, so `dataScope` and `capabilities` are rejected alongside
  it — author those on the referenced role's own clause instead, where every
  profile referencing it picks them up uniformly (the same posture
  `roleAssumable` already takes for a `roleId`-referencing profile).
  `identityOverrides` is unaffected — a profile-level field, independent of
  where the clause list comes from. Every `roleIds` entry must resolve to a
  role this blueprint itself declares (same-context by construction); a
  duplicate entry is rejected outright, never silently deduplicated.
  `@vectros-ai/cli` ≥ 0.19.0 required — it mints the composed AccessProfile
  via the platform's `roleIds` field, creating the referenced roles first so
  the reference always resolves on first apply.
- **`issuers[].userinfoUri`** — declares the IdP's OIDC userinfo endpoint,
  alongside the existing `subClaim`/`emailClaim`. Needs `@vectros-ai/sdk` ≥
  0.41.0 (the platform field it forwards to) and `@vectros-ai/cli` ≥ 0.19.0
  to apply it.

### Fixed

- **The install-time `${{ … }}` resolver rejected the value-less `${{ any }}` `dataScope`
  sentinel as a "malformed reference".** It has no `.` at all, so it matched neither the
  flat `namespace.name` shape nor the deferred `self`/`identities`/`under`/`member`
  namespaces' (which all require at least one `.segment`) — the first blueprint to
  actually author it in a role's `dataScope` hit this outright. Fixed by deferring the
  bare token the same way the dotted runtime placeholders already are.

## 0.15.0

### Added

- **A top-level `fragments:` block, and a role clause's `dataScopeRef: <name>`
  field as sugar for reusing one.** Name a `dataScope` map once under
  `fragments`, then reference it from any clause instead of repeating an
  identical map across several — the exact duplication
  `casework.blueprint.yaml`'s `case_handler` role carried (four clauses all
  repeating `scope:org: ['${{ self.scope.org }}']`). Mutually exclusive with
  an inline `dataScope` on the same clause; an unknown `dataScopeRef` is a
  validation error at parse time. Purely local authoring sugar — expanded to
  a literal, independent `dataScope` before `parseBlueprint` returns, so
  `dataScopeRef` never reaches `@vectros-ai/cli`'s loader or the wire: the
  `createRole` payload for a fragment-using blueprint is byte-identical to
  the hand-inlined equivalent. An existing blueprint with no `fragments`
  block is byte-for-byte unaffected. `@vectros-ai/cli` ≥ 0.18.0 additionally
  renders the expanded, effective per-clause `dataScope` in `blueprint plan`
  output for every role, not just a fragment-using one.

- **A top-level `roleAssumable` map, wiring `Role.assumable` (the
  `POST /v1/auth/token/assume` entitlement grant) into blueprint
  authoring.** `roleAssumable.<roleId>` names, per `scope:<namespace>`, which
  values a holder of that role may assume — mirroring the platform's role
  create/update request grammar for this field exactly: the principal
  (`userId`) can never be named as a key, and each value accepts a plain literal,
  `${{ under.self.userId }}`, or `${{ member.scope.<namespace>[:level] }}`.
  Three forms are rejected at parse time: a bare `${{ self.<dim> }}`
  (tautological here — it can only equal whatever your identity already is),
  `${{ any }}` (not a concrete value), and
  `${{ under.self.scope.<namespace> }}` (it resolves against your own current
  value for a namespace an assume can itself change, so what the grant admitted
  would depend on what was last assumed; and where one access profile composes
  several roles they share one identity, so one role's grant would silently
  widen or narrow another's). That last form remains valid in `dataScope`,
  where it is re-derived per write. Every accepted form therefore depends only
  on a plain literal or on your own principal, which an assume can never
  change. Every key must name a role this blueprint actually declares in
  `roles`. Kept as a SEPARATE top-level map rather than folded into a role's
  own entry — `roles[roleId]` stays exactly the plain clause array it always
  was, so an existing blueprint (and any existing TypeScript consumer
  indexing `roles` directly) is unaffected whether or not it adopts this
  field.

## 0.14.0

### Added

- **A `namespaces[]` entry can now declare `tenantWide: true`**, requesting the
  platform's tenant-wide registration form (visible to every context in the
  account) instead of this blueprint's own context. `false`/omitted (the
  default) is the ordinary, context-owned registration every namespace got
  before — an existing blueprint is byte-for-byte unaffected. Declaring the
  field is a statement of intent only: it grants nothing on its own. The
  applying credential must separately hold OWNER-only authority, and
  `@vectros-ai/cli` ≥ 0.17.0 additionally refuses to even request it without an
  explicit opt-in flag at apply time. See that package's changelog for the full
  mechanism.

## 0.13.0

### Changed

- **The bundled blueprints (`task-management`, `second-brain`, `clinical-intake`,
  `agentic-sdlc`) now declare `dataScope: {}` explicitly wherever they intend
  tenant-wide/shared reach**, rather than omitting `dataScope` and relying on
  that meaning the same thing implicitly. No behavior change — an omitted key
  and an explicit empty object are equally unconstrained — but `@vectros-ai/cli`
  ≥ this release lints an *omitted* `dataScope` on an owner-scoped read/write
  action as a likely authoring mistake (unconstrained reach across every
  owner), and these bundled examples now model the deliberate spelling rather
  than tripping that nudge on their own intentionally-shared design.

- **`blueprint validate` now rejects a schema whose `allowedSurfaces` includes
  `user`, at author time.** Previously such a schema validated clean and
  `blueprint plan` previewed it as provisionable, while the apply failed with a
  `403` every time — so the only way to discover the problem was to run it
  against a live account.

  A user is account-global: the same person across every one of your app
  contexts. Its schema therefore has no single app context that could own it,
  lives account-wide, and can only be written with a root API key — which a
  blueprint never applies with. Model the data as a `record` scoped to the
  user, or as an `entity` schema.

  **`entity`-surfaced schemas are unaffected and remain valid.** An entity
  schema is owned by the app context that creates it — the same context a
  blueprint applies into — so a blueprint can provision one. If you have been
  avoiding `allowedSurfaces: ['entity']` because it used to fail at apply, it
  now works; that platform change ships alongside this release.

### Added

- **A blueprint may now declare top-level `namespaces[]`** — entity-namespace
  registrations (`namespace`, `specificityRank`, optional `entityBacked` and
  membership fields) applied via `@vectros-ai/cli`'s bootstrap-token phase,
  alongside `issuers`. Every declared namespace is **always owned by the
  blueprint's own `contextId`** — there is no tenant-wide option, since the
  platform confines namespace registration to the credential's own context
  unconditionally (the same shape `issuers` already has). Validated
  structurally: grammar, the reserved-namespace set, duplicate names/ranks,
  and membership-field co-occurrence rules. `org`/`client` are reserved
  namespace names, not built-ins — registered the same way as any other.
  They already exist tenant-wide in every account at `specificityRank`
  1000/2000; a context-owned registration needs a different rank, and
  shadows the tenant-wide one for this context's own callers.

  A role clause or the `accessProfile`'s `dataScope` may reference
  `${{ member.scope.<namespace> }}` (or `${{ member.scope.<namespace>:<level> }}`
  to select one declared membership level) to scope reach to the caller's own
  membership in a registered namespace, resolved by the platform per request.

- **Role clauses and `accessProfile` may now declare `capabilities` (format
  support only — read this before relying on it).** A role clause and the
  bootstrap `accessProfile` both gain an optional `capabilities: string[]` —
  format passthrough to the platform's `granted_capabilities` clause
  dimension, alongside the existing `allowedActions`/`dataScope`.

  Validated structurally only: non-blank, no duplicates, and the platform's
  public capability-name grammar (lowercase letters, digits and hyphens,
  starting with a letter, no colon, never `'*'`). This package does not know
  — and deliberately does not hard-code — which names are actually grantable
  today.

  **⚠️ This package parses and validates the field; it does not, by itself,
  cause anything to be granted.** Whether `capabilities` has any effect
  depends entirely on whether the client consuming this package (e.g.
  `@vectros-ai/cli`) reads the field and forwards it to the platform — check
  your client's own release notes. A client that does not yet support
  `capabilities` will silently ignore it, with no error at any layer. Fully
  backward-compatible either way: a blueprint that omits `capabilities`
  parses and provisions exactly as before.

### Changed (breaking)

- **An `issuers[]` entry must now target the blueprint's own `contextId`.** Validation rejects a
  blueprint whose issuer names a different app context, pointing at the offending entry and naming
  both contexts.

  `issuers[].contextId` was the only field able to name an app context other than the blueprint's
  own — schemas, roles, the access profile, the service principal and seed records all land in
  `contextId`. That asymmetry was a review blind spot rather than a feature: someone reading a pack
  sees which context it provisions and has no reason to check each issuer entry for a different
  target, so a blueprint could attach an identity provider — with self-signup onto a real role — to
  an app context it never otherwise mentions. An issuer is a trust anchor: whoever controls its
  `jwksUri` can mint identities the platform will accept. That is worth being certain about when a
  blueprint comes from somewhere else.

  This costs nothing real. One IdP account serving several app contexts already needs one issuer
  registration per context, because the `(issuer, audience)` pair must be unique — so each context
  needs its own audience and therefore its own entry, which belongs in that context's blueprint.

  **If a blueprint of yours does this today, move the entry into a blueprint for the context it
  targets, or set its `contextId` to the blueprint's own.**

  **⚠️ Requires a recent `@vectros-ai/cli` to apply.** The platform enforces a related but
  *different* rule: an issuer may only be registered for the app context that the **calling
  credential** is bound to. The API never sees your blueprint, so the two rules only agree when the
  credential applying it is bound to the blueprint's own context. Older CLI versions apply `issuers`
  under a bootstrap credential bound to `default`, so registering an issuer for any other context
  is refused with `403` — including a blueprint that satisfies the validation rule above. Upgrade
  the CLI before adopting `issuers` on a non-`default` context; `vectros --version` reports yours.

### Removed

- **The `coding-agent-memory` blueprint.** It never had a real adopter — no production
  provisioning, no test traffic beyond the bundled-library suite exercising it structurally like
  every other entry — and was never pressure-tested against a live tenant the way the other bundled
  blueprints have been. Removed before a wider release makes withdrawing an unvalidated blueprint a
  breaking change for someone who actually depends on it, rather than a clean deletion now.

  If you were using it: the schemas it provisioned (`decision`, `convention`, `gotcha`) are a subset
  of what `agentic-sdlc` provisions today, cross-linked into that blueprint's larger knowledge-graph
  model — `vectros bootstrap --blueprint agentic-sdlc` is the closest bundled equivalent. The
  removed source is still recoverable from this package's git history if you need to fork it
  standalone.

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

- **`${{ member.scope.<ns> }}` (and its `:<level>` selector form) — the
  namespace-membership runtime placeholder — is now supported, matching
  `self`/`under`.** It had no resolver entry at all: the install-time
  resolver rejected it outright as a malformed reference before it could
  ever reach the platform, and the placement lint that confines `self`/
  `under` to a role clause's `dataScope` did not recognize it either, so a
  misplaced or typo'd one gave no local warning. Both are fixed together —
  `${{ member.scope.<ns>[:<level>] }}` now resolves (is left literal for
  server-side resolution against the caller's live membership) at any depth
  including the leveled selector, and is confined to a role clause's
  `dataScope` by the same lint as `self`/`under`.

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
