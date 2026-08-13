/**
 * Blueprint format + STRUCTURAL validation.
 *
 * A blueprint is a versioned, reviewed bundle: a schema set + a
 * least-privilege AccessProfile + a service principal + optional seed
 * data, all with stable identifiers so a loader re-run converges instead
 * of duplicating.
 *
 * This package owns the FORMAT + structural (zod) validation ONLY. The
 * security boundary — the scope gate that bounds a blueprint's requested
 * `allowedActions` to data-plane-only — lives in the CLI binary
 * (`@vectros-ai/cli`), NOT here: blueprints are untrusted input, and the
 * trust boundary is the binary that mints.
 *
 * The blueprint's stable id is `name` (renamed from the v0.3-internal
 * `pack` field during a later split — no shipped consumers).
 */
import { z } from 'zod';

// AppContext contextId rule mirrors the backend (3-31 chars, starts with a
// lowercase letter, then lowercase letters/digits/dashes).
const CONTEXT_ID_RE = /^[a-z][a-z0-9-]{2,30}$/;

/**
 * Maximum distinct ownership-scope dimensions a record can carry — the
 * platform's own two-scope-pair capacity. ONE constant for every place that
 * number is spelled — the schema-level `.max()` caps below AND
 * `lintIdentityOverrides`'s own cap check — found in review after a widening
 * left one of three "2"s as a literal that a future bound change would
 * silently miss.
 */
const MAX_SCOPE_DIMENSIONS = 2;

// Field-level validation rules — mirrors the platform's field-validation
// vocabulary. Passed straight through to the schema request so the backend
// enforces them.
// `.strict()` so an unknown rule key is a clear authoring error, not a silent
// no-op (the platform tolerates extra keys, but our format should teach).
const ValidationRulesSchema = z
  .object({
    required: z.boolean().optional(),
    minLength: z.number().int().optional(),
    maxLength: z.number().int().optional(),
    min: z.number().int().optional(),
    max: z.number().int().optional(),
    pattern: z.string().optional(),
    email: z.boolean().optional(),
    url: z.boolean().optional(),
    phone: z.boolean().optional(),
    step: z.number().int().optional(),
    multipleOf: z.number().int().optional(),
    minItems: z.number().int().optional(),
    maxItems: z.number().int().optional(),
  })
  .strict();

// Per-field render hints — authored field-by-field for readability; the loader
// pivots them into the schema-level `renderHints` map keyed by fieldId that the
// platform `SchemaRequest.renderHints` (RenderHintDef) expects.
const RenderHintsSchema = z
  .object({
    label: z.string().optional(),
    widget: z.enum(['text', 'textarea', 'select', 'date', 'checkbox']).optional(),
    order: z.number().int().optional(),
    section: z.string().optional(),
    helpText: z.string().optional(),
    // Marks this field as the record's headline (display) field — the linked
    // primary column in the records list + the title on the detail view. At most
    // one per schema (the platform takes the first by order). Format passthrough →
    // SchemaRequest.renderHints[fieldId].displayField.
    displayField: z.boolean().optional(),
  })
  .strict();

const BlueprintFieldDefSchema = z
  .object({
    fieldId: z.string().min(1),
    fieldType: z.string().min(1),
    required: z.boolean().optional(),
    searchable: z.boolean().optional(),
    filterable: z.boolean().optional(),
    enumValues: z.array(z.string()).optional(),
    description: z.string().optional(),
    // NEW (format passthrough) — the loader stopped dropping these.
    validation: ValidationRulesSchema.optional(),
    renderHints: RenderHintsSchema.optional(),
    // Marks the field as sensitive (PHI/PII): the platform redacts it from
    // logs/audit/errors AT WRITE TIME, blind-indexes it for lookups, EXCLUDES it
    // from the search index, and masks it in responses unless the token carries
    // the `s` reveal scope for this record type (SchemaRequest.FieldDef.sensitive).
    // Format passthrough — the loader forwards it to createSchema. Default false.
    sensitive: z.boolean().optional(),
    // Reference-field surface — a typed foreign-key link to another record. The
    // platform (SchemaRequest.FieldDef) requires BOTH targetTypeName AND
    // targetSurface on a reference field; the blueprint format uses the SAME names
    // as the SDK so they forward 1:1, and the loader provisions a real reference.
    // (Write-time existence enforcement is on by default platform-side; the target
    // must exist when a referencing record is written — order your seed accordingly.)
    targetTypeName: z.string().min(1).optional(),
    // The field on the target record used to resolve the link; defaults (platform
    // side) to the target's externalId/lookup key when omitted. Must name a UNIQUE
    // lookup on the target type.
    targetField: z.string().min(1).optional(),
    // Which surface the target lives on. REQUIRED on a reference field: the same
    // typeName can exist on more than one surface, so this disambiguates which
    // lookup resolves the link (SchemaRequest.FieldDef.targetSurface). A fixed
    // surface (`record`/`document`/`user`) OR an entity-backed namespace
    // (`org`/`client`, or one you registered). The value set is
    // data-driven (namespaces are tenant-defined at runtime), so this is a free
    // string, not a closed enum; the platform existence-checks it at authoring.
    // `entity` is NOT a target — it names the bind surface, not a location.
    targetSurface: z.string().min(1).optional(),
    cardinality: z.enum(['one', 'many']).optional(),
  })
  .strict()
  .superRefine((field, ctx) => {
    const isReference = field.fieldType === 'reference';
    const hasRefKeys =
      field.targetTypeName !== undefined ||
      field.targetField !== undefined ||
      field.targetSurface !== undefined ||
      field.cardinality !== undefined;
    if (isReference && field.targetTypeName === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['targetTypeName'],
        message: "a 'reference' field requires 'targetTypeName' (the typeName it points to)",
      });
    }
    if (isReference && field.targetSurface === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['targetSurface'],
        message:
          "a 'reference' field requires 'targetSurface' (which surface the target lives on: 'record', 'document', 'user', or an entity-backed namespace such as 'org', 'client', or one you registered)",
      });
    }
    // `entity` names the schema BIND surface (see allowedSurfaces), never a reference
    // TARGET — a target names a location, and every entity lives in a namespace. Reject
    // it here with a pointed error rather than let the platform 400 every write later.
    if (isReference && field.targetSurface === 'entity') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['targetSurface'],
        message:
          "'entity' is not a reference target — name the entity's namespace instead (e.g. 'org', 'client', or a namespace you registered)",
      });
    }
    if (!isReference && hasRefKeys) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['fieldType'],
        message:
          "targetTypeName/targetField/targetSurface/cardinality are only valid on a field with fieldType: 'reference'",
      });
    }
  });

// A lookup field is either a bare field name (back-compat) or an object form
// that can additionally declare a uniqueness constraint, an ordered range/prefix
// index, an exact-match sort key, an opt-in past the fast-index budget, or —
// the composite (conjunctive) form — several fields matched together at once.
// The loader normalizes all three to the partner-API `LookupDef` shape ([SV5]).
const BlueprintLookupFieldSchema = z.union([
  z.string().min(1),
  z
    .object({
      // A lookup field declares either ONE field (fieldName) or 2-3 fields
      // matched together (fieldNames) — never both, never neither. `.strict()`
      // below only rejects unknown KEYS; it does not enforce this combination,
      // so the `.superRefine()` after it carries the actual rule.
      fieldName: z.string().min(1).optional(),
      // Composite (conjunctive) lookup: match on all of these fields at once —
      // "every record where `status` is `open` AND `area` is `billing`", exact,
      // in a stable order. Order is significant and locked at create: a query
      // may match a leading run of the list (the first field alone, the first
      // two together, …) but never a later field alone — declare a separate
      // lookup for that. Record-only: the schema's `allowedSurfaces` must be
      // exactly `['record']` (checked at the schema level below) — the
      // platform's composite index has no document/user/entity reader yet.
      fieldNames: z.array(z.string().min(1)).min(2).max(3).optional(),
      // Not available on a composite (`fieldNames`) lookup — checked below.
      unique: z.boolean().optional(),
      // Opt this field into ordered range + prefix lookups (from/to/prefix) on
      // top of exact match. Billed at the range-index rate; not valid on a
      // sensitive field (a blind index is not orderable), and — like `unique`
      // — not available on a composite lookup: it is an exact-match index over
      // its fields; declare the range lookup separately. Locked at create.
      rangeEnabled: z.boolean().optional(),
      // Sort key for the exact-match index: 'createdAt' (default), 'lastUpdated',
      // or a declared field on this schema. Locked at create. Valid on a
      // composite lookup too — it orders WITHIN a group when a query supplies
      // fewer values than the lookup declares, not across the whole result.
      sortBy: z.string().min(1).optional(),
      // Opt a field past the fixed fast-index budget into a higher-cost
      // secondary index. No effect on a field that fits within the budget.
      allowOverflow: z.boolean().optional(),
    })
    .strict()
    .superRefine((lf, ctx) => {
      const hasFieldName = lf.fieldName !== undefined;
      const hasFieldNames = lf.fieldNames !== undefined;
      if (hasFieldName === hasFieldNames) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "a lookup field declares either 'fieldName' (one field) or 'fieldNames' " +
            "(2-3 fields matched together), never both and never neither",
        });
        return; // the combination is already wrong; skip the composite-only checks below
      }
      if (hasFieldNames) {
        if (lf.unique !== undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['unique'],
            message: "'unique' is not available on a composite ('fieldNames') lookup",
          });
        }
        if (lf.rangeEnabled !== undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['rangeEnabled'],
            message: "'rangeEnabled' is not available on a composite ('fieldNames') lookup",
          });
        }
      }
    }),
]);

// Schema capabilities — today just `auditHistory` (platform default true). We
// surface it so a blueprint's audit posture is self-documenting + reviewable.
const BlueprintCapabilitiesSchema = z
  .object({
    auditHistory: z.boolean().optional(),
  })
  .strict();

const BlueprintSchemaSchema = z
  .object({
    typeName: z.string().min(1),
    displayName: z.string().min(1),
    description: z.string().optional(),
    // Default search-index mode for instances of this type. HYBRID, SEMANTIC and
    // TEXT all make content searchable; NONE is store-only — the data is
    // persisted, readable by id/externalId, and fully usable for structured
    // lookups, but it is never indexed, so it can never appear in a search or a
    // grounded answer. That makes NONE the right choice for a type whose contents
    // must not compete with curated knowledge for retrieval slots: the exclusion
    // is structural rather than a filter the caller has to remember to apply.
    //
    // OMITTING THIS IS NOT THE SAME AS 'HYBRID'. With no default declared, a
    // record that does not set its own indexMode resolves to NONE (store-only),
    // and a document with no indexMode is rejected outright. Declare the mode you
    // want; do not rely on the absent case to mean "searchable".
    indexMode: z.enum(['HYBRID', 'SEMANTIC', 'TEXT', 'NONE']).optional(),
    fields: z.array(BlueprintFieldDefSchema).default([]),
    lookupFields: z.array(BlueprintLookupFieldSchema).max(10).optional(),
    // Which typed surfaces may bind this schema. REQUIRED + non-empty on
    // the platform `SchemaRequest` (0.23+); the loader defaults it to ['record']
    // when a blueprint omits it (blueprints provision record types + seed records).
    // The org/client bind surfaces fold into the single `entity`
    // surface — a schema binds to entities of ANY namespace via `entity` plus the
    // entity's own `schemaId` (the namespace is the entity's, not the schema's).
    allowedSurfaces: z.array(z.enum(['record', 'document', 'user', 'entity'])).min(1).optional(),
    // NEW (format passthrough) — mirror the platform `SchemaRequest` shape 1:1.
    capabilities: BlueprintCapabilitiesSchema.optional(),
    // Whether the schema is active; inactive schemas reject new record creation.
    active: z.boolean().optional(),
    // Schema-level ownership defaults, matching `SchemaRequest`: the principal
    // `userId` plus `scopes` — namespaced parent edges as `<namespace>:<value>`
    // (`org:...`, `client:...`, or a namespace you registered), at most two
    // namespaces. The flat `orgId`/`clientId` fields fold into `scopes`. Each
    // entry's namespace + value are validated below
    // (`lintNamespacedScopeArrays`) — this `.max(MAX_SCOPE_DIMENSIONS)` is
    // only the shape-level cap, not the grammar check.
    // With a scoped token these must be consistent with the profile's dataScope
    // (a cross-consistency lint is deferred to the lint slice).
    userId: z.string().min(1).optional(),
    scopes: z.array(z.string().min(1)).max(MAX_SCOPE_DIMENSIONS).optional(),
    // The id of an existing schema this one is a CUSTOMIZATION of, when a schema
    // named `typeName` already exists in this context — required in that case,
    // and must be omitted when this create is the first schema under that name
    // (it becomes that name's shared base). Must point directly at the base (one
    // hop); immutable once set. Mirrors the `basedOn` field on the platform's
    // schema-create request.
    basedOn: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((schema, ctx) => {
    // A composite ('fieldNames') lookup is record-only — the platform's composite
    // index has no document/user/entity reader yet. `allowedSurfaces` omitted
    // defaults (loader-side) to ['record'], so only an EXPLICIT, different value
    // is a violation here.
    const hasComposite = (schema.lookupFields ?? []).some(
      (lf) => typeof lf === 'object' && lf.fieldNames !== undefined,
    );
    if (!hasComposite) return;
    const surfaces = schema.allowedSurfaces;
    const isRecordOnly = surfaces === undefined || (surfaces.length === 1 && surfaces[0] === 'record');
    if (!isRecordOnly) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['allowedSurfaces'],
        message:
          `schema '${schema.typeName}': a composite ('fieldNames') lookup requires ` +
          "allowedSurfaces to be exactly ['record'] — the platform's composite index has no " +
          'document/user/entity reader yet',
      });
    }
  });

const BlueprintAccessProfileSchema = z
  .object({
    // Validated structurally here; the SCOPE GATE (in @vectros-ai/cli) is
    // what enforces the data-plane-only security boundary.
    allowedActions: z.array(z.string().min(1)).min(1),
    // Optional ownership binding: { userId: [...], "scope:org": [...], "scope:client": [...] }.
    // A `null` element in a value list is the documented NULL SENTINEL — it
    // grants access to TENANT-LEVEL (owner-less) records IN ADDITION to the
    // listed owner ids. `null` is the literal matched value: a tenant-level
    // record has a genuinely-null ownership field, and the platform's scope
    // matcher tests `allowedValues.contains(null)` against the tenant-level
    // null sentinel (+ ScopeClause). Keys are `userId` (the principal) plus
    // namespaced `scope:<ns>` scopes (`scope:org`, `scope:client`, `scope:group`,
    // ...) — the flat `orgId`/`clientId` keys are gone. e.g.
    // `{ "scope:org": ["org_x", null] }` = "org_x's records AND tenant-shared
    // records". Omitting null restricts to the listed owners ONLY (the key will
    // NOT see tenant-level/seed records). Every KEY is validated below
    // (`lintDataScopeKeys`) — `userId` or a grammar-valid `scope:<ns>`, no
    // other shape.
    dataScope: z.record(z.array(z.union([z.string().min(1), z.null()]))).optional(),
    // Optional identity overrides for the service principal's profile — scope
    // values its key STAMPS onto everything it writes (a credential can only
    // stamp ownership its identity carries). Keys are the namespaced `scope:<ns>`
    // form (`scope:org`, `scope:client`, or a namespace you registered; the bare
    // `orgId`/`clientId` keys are gone); values may be `${{ identities.* }}`
    // tokens (substituted at apply time). e.g. `{ "scope:org": '${{ identities.team }}' }`
    // makes every record the service key writes org/team-owned.
    //
    // Every KEY, the ≤2-dimension cap, and every LITERAL value are validated
    // below (`lintIdentityOverrides`, placeholder-aware — see that function's
    // docstring); this `.min(1)` is only the shape-level "non-blank" guard on
    // the value, not the grammar check.
    identityOverrides: z.record(z.string().min(1)).optional(),
  })
  .strict();

// A single role clause — mirrors the platform/SDK ScopeClause (allowedActions +
// optional per-clause dataScope). Multi-clause roles let one role grant several
// (action-set, data-scope) rules at once, evaluated per-clause server-side.
// `${{ self.* }}` placeholders are legal in a clause's dataScope: they are a
// RUNTIME sentinel the platform resolves per-principal at request time
// — the install-time resolver leaves them literal (see inputs.ts),
// and a top-level lint (BlueprintSchema) confines them to here. Every KEY is
// also validated (`lintDataScopeKeys`) — `userId` or a grammar-valid
// `scope:<ns>`, no other shape, same rule as `accessProfile.dataScope` above.
const BlueprintRoleClauseSchema = z
  .object({
    allowedActions: z.array(z.string().min(1)).min(1),
    dataScope: z.record(z.array(z.union([z.string().min(1), z.null()]))).optional(),
  })
  .strict();

// Optional top-level `roles`: a map of roleId → ordered clauses. Authored in the
// blueprint and bound to principals via `vectros access grant --role <id>`.
// DISTINCT from `accessProfile` (the least-privilege scope the bootstrap mints
// for the blueprint's own service-principal key). Roles are identity-agnostic,
// reusable, multi-clause rules (architecture §6).
const BlueprintRolesSchema = z.record(z.array(BlueprintRoleClauseSchema).min(1));

// A namespace name: a lowercase letter first, then lowercase letters,
// digits, `_` or `-`, 2-32 chars — mirrors the platform `IdentityNamespaceDB`
// grammar. The fixed surfaces are not namespaces and can never be entity kinds.
const IDENTITY_NAMESPACE_RE = /^[a-z][a-z0-9_-]{1,31}$/;
const FORBIDDEN_IDENTITY_NAMESPACES = new Set(['record', 'document', 'entity', 'user']);

// A declared identity's `kind`: the fixed `user` surface, OR an entity namespace
// (`org`/`client` — built-in — or one you registered). Orgs and clients fold into
// the generic identity-entity model, so the closed `user|org|client`
// enum generalizes to any entity-backed namespace. `user` is the one fixed surface
// that is not a namespace; the reserved surface words are rejected as kinds.
const IdentityKindSchema = z.string().min(1).superRefine((val, ctx) => {
  if (val === 'user') return; // the fixed principal surface (createUser)
  if (!IDENTITY_NAMESPACE_RE.test(val)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `kind must be 'user' or an entity namespace (2-32 chars, a lowercase letter first, then lowercase letters/digits/_/-), e.g. 'org', 'client', 'team'`,
    });
  } else if (FORBIDDEN_IDENTITY_NAMESPACES.has(val)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `'${val}' is a reserved surface name and cannot be an entity namespace — use 'user' for a user, or a namespace like 'org'/'client'/'team'`,
    });
  }
});

// A declared identity — a principal the blueprint expects to exist, ensured
// (idempotently, by externalId) at APPLY time by a creds-bearing pass (the CLI
// install orchestrator). Referenced elsewhere via `${{ identities.<name> }}`,
// which the install-time resolver leaves literal and the apply pass substitutes
// with the resolved principal id. The schema is FORMAT/shape only; resolution
// (resolveBlueprintIdentities) lives in identities.ts.
const IdentityDeclSchema = z
  .object({
    kind: IdentityKindSchema,
    externalId: z.string().min(1),
    displayName: z.string().min(1).optional(),
    metadata: z.record(z.unknown()).optional(),
  })
  .strict();

// Identity name grammar — MUST mirror the capture group in IDENTITY_REF_RE
// below (and identities.ts's own IDENTITY_TOKEN_RE, the same pattern
// duplicated there for its scan/substitute pass over the apply-time tree):
// a name outside this grammar could previously still be DECLARED (nothing
// constrained the `identities` block's keys), but could never be REFERENCED
// — `${{ identities.<name> }}`'s own token grammar cannot match it, so
// `${{ identities.demo-org }}` silently never substituted into a live
// `scopes:`/dataScope field instead of erroring.
const IDENTITY_NAME_RE = /^[A-Za-z_]\w*$/;

// Optional top-level `identities` block — a map of local name → declaration.
// Exported so the apply-time resolver (identities.ts) validates the block too.
// Keys are constrained to IDENTITY_NAME_RE so every declared name is ALSO a
// name a `${{ identities.<name> }}` token can actually match — loud at parse
// time instead of a silent, permanently-unmatchable declaration.
export const IdentitiesDeclSchema = z.record(
  z.string().regex(IDENTITY_NAME_RE, {
    message:
      "identity name must match letters/digits/underscore, not starting with a digit (e.g. 'demoOrg', not 'demo-org') — " +
      "'${{ identities.<name> }}' can never reference a name outside this grammar",
  }),
  IdentityDeclSchema,
);

const BlueprintServicePrincipalSchema = z
  .object({
    externalId: z.string().min(1),
    displayName: z.string().min(1),
  })
  .strict();

// issuerId grammar mirrors the platform's stored issuer-key format (SDK
// `IssuerRequest.issuerId` doc: "3-31 characters, a lowercase letter first, then
// lowercase letters, digits, or hyphens") — identical to CONTEXT_ID_RE, reused
// rather than duplicated.
const ISSUER_ID_RE = CONTEXT_ID_RE;

// A trusted third-party IdP issuer, registered in the blueprint's BOOTSTRAP-token
// phase — alongside app-context/service-principal creation, NOT folded into the
// in-context load with schemas/accessProfile/roles. Tenant-wide provisioning
// config: needs the bootstrap credential's owner-only `provisioning:c`, the same
// gate the app-context create itself requires, never an ordinary partner-grantable
// scope. Shape mirrors the SDK's `IssuerRequest` 1:1 so the loader forwards it
// without a transform.
const BlueprintIssuerSchema = z
  .object({
    /** Short slug identifying this issuer within your tenant. Immutable once registered. */
    issuerId: z.string().regex(ISSUER_ID_RE, {
      message:
        "issuerId must be 3-31 chars, start with a lowercase letter, then lowercase letters/digits/dashes (e.g. 'auth0-prod')",
    }),
    /** The IdP's `iss` claim value, exactly as it appears in tokens it issues. */
    issuer: z.string().min(1),
    /** The IdP's remote JWKS endpoint, used to verify presented tokens' signatures. */
    jwksUri: z.string().min(1),
    /**
     * The `aud` claim value a presented subject_token must carry. Must be globally
     * unique in combination with `issuer` — use a distinct audience per
     * environment/context sharing one IdP account (most OIDC providers support
     * this as an ordinary per-API/application default).
     */
    audience: z.string().min(1),
    /** Which app context an exchanged token targets. Must be an existing app context. */
    contextId: z.string().regex(CONTEXT_ID_RE, {
      message:
        "contextId must be 3-31 chars, start with a lowercase letter, then lowercase letters/digits/dashes (e.g. 'casework')",
    }),
    /** The claim carrying the subject identifier. Platform defaults to 'sub' when omitted. */
    subClaim: z.string().min(1).optional(),
    /** The claim carrying the subject's email (first-login invite matching). Platform defaults to 'email' when omitted. */
    emailClaim: z.string().min(1).optional(),
    /**
     * Opt-in self-service signup: a list of {signupType, roleId} pairs. When a first-time exchange
     * caller presents no invite token but names a signupType matching one of these (or omits it and
     * exactly one entry exists), a brand-new user is created and bound to that entry's role, no
     * invite required. Every entry must be something you're willing to grant to ANY caller who can
     * present a token from this issuer — a role carrying elevated (provisioning or wildcard) scope
     * is rejected. Omit entirely to leave self-signup disabled (the default).
     */
    selfSignupPolicies: z
      .array(
        z
          .object({
            signupType: z.string().regex(ISSUER_ID_RE, {
              message:
                "signupType must be 3-31 chars, start with a lowercase letter, then lowercase letters/digits/dashes (e.g. 'practitioner')",
            }),
            roleId: z.string().regex(ISSUER_ID_RE, {
              message:
                "roleId must be 3-31 chars, start with a lowercase letter, then lowercase letters/digits/dashes (e.g. 'practitioner-member')",
            }),
          })
          .strict(),
      )
      .optional(),
  })
  .strict();

// A seed pre-populates the context at bootstrap. It is a DISCRIMINATED union on
// `surface`, because the two surfaces are genuinely different shapes — not the
// same object with a couple of optional extras:
//   • a RECORD seed (`surface: 'record'`) carries its data in `fields` (the payload).
//   • a DOCUMENT seed (`surface: 'document'`) is text-ingested: the platform's
//     ingest path REQUIRES a first-class `title` and non-empty `text`, with optional
//     structured `fields` (payload) bound to the schema. `title`/`text` are document
//     attributes DISTINCT from payload — a record schema may itself declare a payload
//     field literally named `title` (the bundled `decision` type does), so they can't
//     be reserved keys inside `fields`.
// `surface` is REQUIRED on every seed so each entry states its surface explicitly;
// the discriminator routes the CLI loader to `createRecord` vs `ingestDocument` and
// gives precise per-variant validation errors.
const SeedCommonShape = {
  /** The schema typeName this seed instantiates (should match a declared schema). */
  typeName: z.string().min(1),
  /**
   * Stable, caller-supplied id — the loader's idempotency key AND the value other
   * seeds resolve a `reference` against (across surfaces: a record seed may
   * reference a document seed by its externalId, and vice versa).
   */
  externalId: z.string().min(1),
  /**
   * Optional scope ownership for the seeded item, as `namespace:value` entries
   * (≤2, e.g. `['org:${{ identities.team }}']`; tokens substitute at apply
   * time). `[]` = a private, user-owned item. Omitted = the seeding
   * credential's full identity (the default). Each entry's namespace + value
   * are validated below (`lintNamespacedScopeArrays`) — this
   * `.max(MAX_SCOPE_DIMENSIONS)` is only the shape-level cap, not the grammar
   * check.
   */
  scopes: z.array(z.string()).max(MAX_SCOPE_DIMENSIONS).optional(),
} as const;

const RecordSeedSchema = z
  .object({
    surface: z.literal('record'),
    ...SeedCommonShape,
    /** The record payload, validated against the bound schema. */
    fields: z.record(z.unknown()),
  })
  .strict();

const DocumentSeedSchema = z
  .object({
    surface: z.literal('document'),
    ...SeedCommonShape,
    /** Human-readable document title — REQUIRED by the text-ingest path. */
    title: z.string().min(1),
    /** Raw text content to ingest + index — REQUIRED and non-empty (the platform rejects a blank ingest). */
    text: z.string().min(1),
    /** Optional structured payload bound to the schema (the document's `fields`). */
    fields: z.record(z.unknown()).optional(),
  })
  .strict();

const BlueprintSeedRecordSchema = z.discriminatedUnion('surface', [
  RecordSeedSchema,
  DocumentSeedSchema,
]);

// `${{ self.* }}` (and its `${{ under.self.* }}` form) is a RUNTIME
// per-principal placeholder (platform-resolved at request time). It is only
// meaningful inside a role clause's dataScope; anywhere else in a blueprint
// it would never resolve. This walk confines it there (teach-by-error),
// running on the already-input-resolved doc (the install-time resolver
// leaves these tokens literal — see inputs.ts).
//
// Broader than a strict single-segment match — the runtime grammar allows
// deeper dotted paths (`self.scope.<ns>`, `under.self.<field>` — see
// inputs.ts's DEFERRED_NAMESPACES), so a strict `self\.[A-Za-z_]\w*` shape
// would silently miss them. Same reasoning as IDENTITY_REF_LOOSE_RE below:
// captures ANYTHING between the `self.`/`under.` prefix and the closing
// `}}` (never crossing a literal `}`), so a token this lint's narrower form
// couldn't parse is still DETECTED here rather than silently invisible —
// landing as a dead, unresolved literal wherever it was misplaced.
const SELF_TOKEN_RE = /\$\{\{\s*(?:self|under)\.[^}]*?\s*\}\}/;

function lintSelfTokenPlacement(value: unknown, ctx: z.RefinementCtx): void {
  const walk = (node: unknown, path: (string | number)[], inRoleDataScope: boolean): void => {
    if (typeof node === 'string') {
      if (!inRoleDataScope && SELF_TOKEN_RE.test(node)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path,
          message:
            "'${{ self.* }}' is a runtime per-principal placeholder — it is only valid inside a roles[].dataScope value",
        });
      }
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((v, i) => walk(v, [...path, i], inRoleDataScope));
      return;
    }
    if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        // path === ['roles', <roleId>, <clauseIndex>] and key 'dataScope' opens
        // the only subtree where self.* is allowed.
        const entering =
          inRoleDataScope || (path.length === 3 && path[0] === 'roles' && k === 'dataScope');
        walk(v, [...path, k], entering);
      }
    }
  };
  walk(value, [], false);
}

// Every `${{ identities.<name> }}` reference must point at a declared identity in
// the top-level `identities` block — caught offline (at validate/plan), before
// the creds-bearing apply pass tries (and fails) to resolve an unknown name.
const IDENTITY_REF_RE = /\$\{\{\s*identities\.([A-Za-z_]\w*)\s*\}\}/g;

// Broader than IDENTITY_REF_RE — same `${{ identities.` prefix and `}}` suffix,
// but captures ANYTHING in between (never crossing a literal `}`), so a token
// whose shape IDENTITY_REF_RE cannot match — dotted property access
// (`identities.demoOrg.externalId`), a hyphenated/invalid name — is still
// DETECTED here rather than silently invisible to every check. Before this
// existed, such a token matched neither this lint nor the apply-time
// substitution's own (equally strict) regex, so it reached apply-time
// untouched and landed as a literal, unresolved '${{ ... }}' string in
// whatever ownership/dataScope field it was written into.
const IDENTITY_REF_LOOSE_RE = /\$\{\{\s*identities\.([^}]*?)\s*\}\}/g;

function lintIdentityRefs(value: unknown, ctx: z.RefinementCtx): void {
  const declared = new Set(
    value && typeof value === 'object' && 'identities' in value && (value as { identities?: unknown }).identities
      ? Object.keys((value as { identities: Record<string, unknown> }).identities)
      : [],
  );
  const walk = (node: unknown, path: (string | number)[]): void => {
    if (typeof node === 'string') {
      // Malformed shape FIRST — a token IDENTITY_REF_RE's strict grammar can't
      // match at all would otherwise never reach the declared-check below and
      // pass through silently.
      for (const m of node.matchAll(IDENTITY_REF_LOOSE_RE)) {
        const captured = m[1];
        if (IDENTITY_NAME_RE.test(captured)) continue; // well-formed — declared-check below handles it
        const dotIndex = captured.indexOf('.');
        const message =
          dotIndex === -1
            ? `'\${{ identities.${captured} }}' is not a valid identities reference — the name must match letters/digits/underscore, not starting with a digit`
            : `'\${{ identities.${captured} }}' is not valid — property access ('.${captured.slice(dotIndex + 1)}') is not supported; only the whole identity id can be referenced, as '\${{ identities.${captured.slice(0, dotIndex)} }}'`;
        ctx.addIssue({ code: z.ZodIssueCode.custom, path, message });
      }
      for (const m of node.matchAll(IDENTITY_REF_RE)) {
        if (!declared.has(m[1])) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path,
            message: `'\${{ identities.${m[1]} }}' references an undeclared identity — add '${m[1]}' to the top-level 'identities' block`,
          });
        }
      }
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((v, i) => walk(v, [...path, i]));
    } else if (node && typeof node === 'object') {
      // Don't scan the declarations themselves (their values aren't token refs).
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        if (path.length === 0 && k === 'identities') continue;
        walk(v, [...path, k]);
      }
    }
  };
  walk(value, []);
}

// The scope-VALUE grammar the platform enforces server-side once a `scope:<ns>`
// value is stored — mirrors the CLI's own scope-value grammar byte-for-byte.
// `:` is excluded because the value becomes an entity id inside a colon-split
// storage key (one bad value breaks a whole batched resolution, not just its
// own row); `$`, `{`, `}` are excluded because a stored value is substituted
// into a scope clause and the RESULT is re-parsed for placeholders, so a
// placeholder-shaped value would be read back as a matcher and widen the
// credential to a whole compartment.
const SCOPE_VALUE_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

// The scope-NAMESPACE grammar + forbidden set — mirrors the CLI's own copy
// byte-for-byte (both verified independently against the platform's
// `ScopeNamespaces.NAMESPACE_PATTERN`/`FORBIDDEN_NAMESPACES`, not against each
// other, so this is not a re-derivation of a re-derivation). `org`/`client`
// are RESERVED namespaces (platform-defined semantics) but are NOT forbidden —
// they're valid, ordinary `scope:<ns>` namespaces. `user`/`self`/`tenant`/
// `context`/`scope` are forbidden because they'd shadow the principal
// dimension, the `${{ self.* }}` placeholder family, or the partition axes;
// `record`/`document`/`entity` because they'd collide with a schema
// reference's fixed-surface resolution; `versions`/`lookup` because they're
// entity sub-path route segments.
const SCOPE_NAMESPACE_RE = /^[a-z][a-z0-9_-]{1,31}$/;
const FORBIDDEN_SCOPE_NAMESPACES: ReadonlySet<string> = new Set([
  'user', 'record', 'document', 'entity', 'self', 'tenant', 'context', 'scope', 'versions', 'lookup',
]);

/**
 * Null when `namespace` is a scope namespace the platform will accept, else the reason it will not
 * (mirrors `ScopeNamespaces.namespaceGrammarError`, same check order — forbidden set FIRST, so a
 * reserved word gets the "reserved" message rather than a shape complaint).
 */
function scopeNamespaceGrammarError(namespace: string): string | null {
  if (namespace === '') return 'scope namespace must not be blank';
  if (FORBIDDEN_SCOPE_NAMESPACES.has(namespace)) {
    return `'${namespace}' is a reserved namespace and cannot be used as an ownership scope`;
  }
  if (!SCOPE_NAMESPACE_RE.test(namespace)) {
    return `'${namespace}' is not a valid namespace — 2-32 chars, lowercase letter first, then lowercase letters, digits, '_' or '-'`;
  }
  return null;
}

// Whole-string form of IDENTITY_REF_LOOSE_RE above — DERIVED from it (anchored,
// not re-spelled) rather than a second ad-hoc placeholder literal. An
// `accessProfile.identityOverrides` value IS the field, never text a token is
// embedded in, so recognizing the documented substitution form means "this
// value IS a placeholder", not "this value CONTAINS one" — an unanchored,
// substring `.match()` against the same regex let a value like
// `${{ identities.team }}-x:y` skip the grammar check entirely with its
// colon-bearing suffix intact, exactly the shape this lint exists to catch
// (caught in review, confirmed against the code before this comment was
// written).
//
// NOTE this is a narrowing as well as a fix: a value that merely EMBEDS a
// well-formed token (e.g. that same `-x:y`-suffixed string) is now rejected
// pre-substitution, where the unanchored form would have waved it through.
// Low impact by construction — a scope value is an entity id, so suffixing
// or prefixing one is not a meaningful authoring pattern, and nothing in this
// package's bundled blueprints, fixtures, or examples authors that shape —
// but it IS a behavior change for any external consumer who happened to rely
// on the (buggy) permissive read.
const IDENTITY_PLACEHOLDER_WHOLE_RE = new RegExp(`^${IDENTITY_REF_LOOSE_RE.source}$`);

// `accessProfile.identityOverrides` mirrors the platform's FULL
// `AccessProfileDB.validateIdentityOverrides` rule, not just the value half:
// every KEY must be `scope:<ns>` with a grammar-valid, non-forbidden `<ns>`
// (a bare `orgId`/`clientId` — the retired legacy spellings this field's own
// comment says are "gone" — or a forbidden namespace like `scope:tenant`
// currently lints clean and 400s at apply, same defect class as the value
// gap); the map carries AT MOST 2 dimensions (a record carries
// at most 2 scope values, so an identity may stamp at most 2); and every VALUE
// is either the documented `${{ identities.<name> }}` substitution token (see
// that field's own comment above) — the platform grammar's excluded
// `$`/`{`/`}` would reject every blueprint using one if applied naively — or
// must satisfy the platform's literal scope-value grammar. The placeholder
// check is PLACEHOLDER-AWARE on the documented WHOLE-VALUE shape and defers to
// `lintIdentityRefs` for the strict name-grammar/declared check, which already
// walks this field as part of its whole-tree scan.
//
// Because this runs inside `BlueprintSchema`'s superRefine, it fires again
// whenever `parseBlueprint` re-validates the tree post-identity-substitution
// (the CLI's apply-time identity-substitution pass) — so a SUBSTITUTED value
// is checked too, not only the pre-substitution literal/token.
function lintIdentityOverrides(
  value: unknown,
  ctx: z.RefinementCtx,
): void {
  const overrides = (value as { accessProfile?: { identityOverrides?: Record<string, unknown> } }).accessProfile
    ?.identityOverrides;
  if (!overrides) return;
  const entries = Object.entries(overrides);

  if (entries.length > MAX_SCOPE_DIMENSIONS) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['accessProfile', 'identityOverrides'],
      message:
        `identityOverrides names ${entries.length} scope dimensions — a record carries at most ` +
        `${MAX_SCOPE_DIMENSIONS} scope values, so an identity may stamp at most ${MAX_SCOPE_DIMENSIONS}.`,
    });
  }

  for (const [key, v] of entries) {
    const ns = key.startsWith('scope:') ? key.slice('scope:'.length) : null;
    const nsError = ns === null ? null : scopeNamespaceGrammarError(ns);
    if (ns === null || nsError !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['accessProfile', 'identityOverrides', key],
        message:
          ns === null
            ? `'${key}' is not allowed — identityOverrides keys must be 'scope:org', 'scope:client', ` +
              `or an open 'scope:<namespace>' key (the bare 'orgId'/'clientId' spellings are retired)`
            : `identityOverrides['${key}'] ${nsError}`,
      });
    }

    if (typeof v !== 'string') continue; // shape error — caught by the field schema itself
    if (IDENTITY_PLACEHOLDER_WHOLE_RE.test(v)) continue; // IS a placeholder — lintIdentityRefs's job
    if (!SCOPE_VALUE_RE.test(v)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['accessProfile', 'identityOverrides', key],
        message:
          `'${v}' is not a valid scope value — 1-128 characters, starting with a letter or digit and ` +
          "continuing with letters, digits, '_' or '-'. A value may not contain ':', '$', '{', or '}' " +
          "(the one exception is the documented '${{ identities.<name> }}' substitution token).",
      });
    }
  }
}

// `schemas[].scopes` and `seed[].scopes` share ONE shape: an array of
// `<namespace>:<value>` strings (split on the FIRST colon, mirroring the
// platform's own `ScopeNamespaces.parseScopeValue` — splitting on the LAST
// colon, or limiting the split, would silently REINTERPRET a malformed entry
// instead of rejecting it), ≤2 entries, currently entirely unvalidated here —
// the same "lints clean, 400s at apply" gap `lintIdentityOverrides` closes for
// the map form. The VALUE half may be the documented `${{ identities.<name> }}`
// token (e.g. `'org:${{ identities.team }}'`, per that field's own comment) —
// placeholder-aware exactly like `lintIdentityOverrides`, and for the same
// reason.
//
// A namespace appearing twice with DIFFERENT values is rejected — the array
// carries at most one value per namespace, and the platform's own
// `applyAuthoredScopes` rejects the same shape; an exact repeat (same
// namespace AND same value) is tolerated as harmless redundancy rather than
// flagged as a conflict. Found in review: the schema-level `.max()` still
// bounds RAW entry count (not distinct-namespace count), so an exact-repeat
// entry padding a 3rd slot remains over-strict relative to the platform in
// that one narrow, adversarial-authoring-only shape — judged not worth
// moving the cap out of the schema layer for a shape nothing in this repo's
// fixtures, seed data, or bundled blueprints authors.
function lintScopeEntries(
  entries: readonly unknown[] | undefined,
  path: (string | number)[],
  ctx: z.RefinementCtx,
): void {
  if (!entries) return;
  const seenValueByNamespace = new Map<string, string>();
  for (let i = 0; i < entries.length; i++) {
    const raw = entries[i];
    if (typeof raw !== 'string') continue; // shape error — caught by the field schema itself
    const sep = raw.indexOf(':');
    if (sep <= 0 || sep === raw.length - 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...path, i],
        message: `'${raw}' must be '<namespace>:<value>' (e.g. 'org:6ba7...' or 'team:${'${{ identities.team }}'}')`,
      });
      continue;
    }
    const namespace = raw.slice(0, sep);
    const val = raw.slice(sep + 1);
    const nsError = scopeNamespaceGrammarError(namespace);
    if (nsError !== null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [...path, i], message: `'${raw}' ${nsError}` });
    } else {
      const priorValue = seenValueByNamespace.get(namespace);
      if (priorValue !== undefined && priorValue !== val) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [...path, i],
          message:
            `'${namespace}' appears more than once with different values ('${priorValue}' and '${val}') — ` +
            'an item carries at most one value per namespace',
        });
      }
      seenValueByNamespace.set(namespace, val);
    }
    if (IDENTITY_PLACEHOLDER_WHOLE_RE.test(val)) continue; // IS a placeholder — lintIdentityRefs's job
    if (!SCOPE_VALUE_RE.test(val)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...path, i],
        message:
          `'${raw}' has an invalid value — 1-128 characters, starting with a letter or digit and ` +
          "continuing with letters, digits, '_' or '-'. A value may not contain ':', '$', '{', or '}' " +
          "(the one exception is the documented '${{ identities.<name> }}' substitution token).",
      });
    }
  }
}

function lintNamespacedScopeArrays(value: unknown, ctx: z.RefinementCtx): void {
  const bp = value as {
    schemas?: Array<{ scopes?: unknown[] }>;
    seed?: Array<{ scopes?: unknown[] }>;
  };
  (bp.schemas ?? []).forEach((s, i) => lintScopeEntries(s.scopes, ['schemas', i, 'scopes'], ctx));
  (bp.seed ?? []).forEach((s, i) => lintScopeEntries(s.scopes, ['seed', i, 'scopes'], ctx));
}

// The last unvalidated member of the ownership-scope-grammar defect class:
// `dataScope` KEYS, on BOTH `accessProfile.dataScope` and every
// `roles[].*.dataScope` clause. The VALUE array elements are already
// shape-checked (non-blank string | null) by the field schema, but a KEY like
// the retired bare `orgId`/`clientId`, or a forbidden namespace such as
// `scope:tenant`, lints clean and 400s at apply — the same gap
// `lintIdentityOverrides` closed for `identityOverrides`' keys. `userId` is
// the one non-namespaced key this field allows (the principal dimension, per
// the field's own doc comment) — every other key must be a grammar-valid,
// non-forbidden `scope:<ns>`.
//
// Deliberately KEYS ONLY: `dataScope` VALUES are a richer grammar than a
// literal owner id — `${{ self.* }}`/`${{ under.self.* }}` runtime
// placeholders are legal here (confined to `roles[].dataScope` by the
// separate `lintSelfTokenPlacement`, forbidden in `accessProfile.dataScope`)
// — and composing a literal-value grammar check with that existing placement
// confinement is a distinct piece of work this function does not attempt.
function lintDataScopeKey(key: string, path: (string | number)[], ctx: z.RefinementCtx): void {
  if (key === 'userId') return;
  const ns = key.startsWith('scope:') ? key.slice('scope:'.length) : null;
  const nsError = ns === null ? null : scopeNamespaceGrammarError(ns);
  if (ns === null || nsError !== null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path,
      message:
        ns === null
          ? `'${key}' is not allowed — dataScope keys must be 'userId' or a namespaced 'scope:<namespace>' key ` +
            "(the bare 'orgId'/'clientId' spellings are retired)"
          : `dataScope['${key}'] ${nsError}`,
    });
  }
}

function lintDataScopeKeys(value: unknown, ctx: z.RefinementCtx): void {
  const bp = value as {
    accessProfile?: { dataScope?: Record<string, unknown> };
    roles?: Record<string, Array<{ dataScope?: Record<string, unknown> }>>;
  };
  for (const key of Object.keys(bp.accessProfile?.dataScope ?? {})) {
    lintDataScopeKey(key, ['accessProfile', 'dataScope', key], ctx);
  }
  for (const [roleId, clauses] of Object.entries(bp.roles ?? {})) {
    clauses.forEach((clause, i) => {
      for (const key of Object.keys(clause.dataScope ?? {})) {
        lintDataScopeKey(key, ['roles', roleId, i, 'dataScope', key], ctx);
      }
    });
  }
}

// A seed's `surface` must be one the bound schema actually allows — e.g. a
// `surface: 'document'` seed of a record-only type would fail the surface bind at
// apply time. Caught offline (validate/plan) instead. A seed whose typeName has
// no declared schema is NOT flagged here: the loader warns + skips it at apply,
// and a blueprint may legitimately seed a pre-existing (un-redeclared) type.
function lintSeedSurfaces(value: unknown, ctx: z.RefinementCtx): void {
  const bp = value as { schemas?: Array<{ typeName?: string; allowedSurfaces?: string[] }>; seed?: Array<{ typeName?: string; externalId?: string; surface?: string }> };
  if (!Array.isArray(bp.seed)) return;
  const byType = new Map((bp.schemas ?? []).map((s) => [s.typeName, s]));
  bp.seed.forEach((seed, i) => {
    const schema = byType.get(seed.typeName);
    if (!schema) return;
    const allowed = schema.allowedSurfaces ?? ['record'];
    if (!allowed.includes(seed.surface ?? 'record')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['seed', i, 'surface'],
        message: `seed '${seed.externalId}' uses surface '${seed.surface ?? 'record'}', but schema '${seed.typeName}' allows only [${allowed.join(', ')}]`,
      });
    }
  });
}

/**
 * Which loader-phase a top-level blueprint field's resources are applied in
 * (`@vectros-ai/cli`'s `runLoader`, TWO-TOKEN flow):
 *   - `'bootstrap'` — applied under the narrow, owner-only bootstrap credential
 *     (`provisioning:c`), before the per-context re-mint. Tenant-wide
 *     provisioning config, the same category as the app-context create itself.
 *   - `'in-context'` — applied under the per-context token re-minted AFTER the
 *     bootstrap phase. Ordinary data-plane provisioning, confined to the
 *     blueprint's own `contextId`.
 *
 * SELF-DOCUMENTING PHASE METADATA: which phase a field applies in was, until
 * this map existed, a fact enforced ONLY by `runLoader`'s hardcoded imperative
 * sequence in `@vectros-ai/cli` — not something readable from
 * `BlueprintSchema`'s own type definitions. That gap is exactly what produced
 * an early design mistake for `issuers` (a first draft proposed folding it into
 * the in-context load). This map is the fix: the loader package
 * imports it rather than re-asserting the phase distinction a second time in
 * its own comments, so the two can't independently drift, and a fork author (or
 * a future field author) can inspect it directly instead of reading
 * `loader.ts`. `vectros blueprint plan` also derives its `[<phase>-phase]`
 * preview annotation from this map.
 *
 * Deliberately covers only the fields the TWO-TOKEN split actually applies to.
 * `identities` is NOT here: declared identities are ensured by a separate,
 * EARLIER pass (the CLI's `resolveApplyTimeIdentities`, before `runLoader` ever
 * runs — see `assertNoUnresolvedIdentities`), not by either loader phase, so
 * shoehorning it into this two-value enum would misdescribe it rather than
 * document it. `name`/`version`/`description`/`contextId`/`contextName` are the
 * blueprint's own scalar identity, not a nested resource block — no phase
 * applies to them individually.
 */
export type LoaderPhase = 'bootstrap' | 'in-context';

export const BLUEPRINT_FIELD_PHASES: Readonly<Record<string, LoaderPhase>> = Object.freeze({
  servicePrincipal: 'bootstrap',
  issuers: 'bootstrap',
  schemas: 'in-context',
  accessProfile: 'in-context',
  roles: 'in-context',
  seed: 'in-context',
});

export const BlueprintSchema = z
  .object({
    /** Stable blueprint id (the `--blueprint <name>` selector + idempotency key). */
    name: z.string().min(1),
    version: z.string().min(1),
    description: z.string().min(1),
    /** The app-context the profile + scoped key bind to (e.g. "mcp"). */
    contextId: z.string().regex(CONTEXT_ID_RE, {
      message:
        "contextId must be 3-31 chars, start with a lowercase letter, then lowercase letters/digits/dashes (e.g. 'mcp')",
    }),
    /** Human-readable app-context name; defaults to `MCP — <name>` (see {@link contextNameOf}) when absent. */
    contextName: z.string().min(1).optional(),
    schemas: z.array(BlueprintSchemaSchema).default([]),
    accessProfile: BlueprintAccessProfileSchema,
    servicePrincipal: BlueprintServicePrincipalSchema,
    seed: z.array(BlueprintSeedRecordSchema).optional(),
    /** Optional multi-clause roles, bound to principals via `access grant --role`. */
    roles: BlueprintRolesSchema.optional(),
    /** Optional principals ensured-exist at apply; referenced via ${{ identities.* }}. */
    identities: IdentitiesDeclSchema.optional(),
    /**
     * Optional trusted third-party IdP issuers to register (BYO-IdP token
     * exchange). Applied in the BOOTSTRAP-token phase, alongside app-context/
     * service-principal creation — NOT the in-context load (see
     * {@link BlueprintIssuerSchema}).
     */
    issuers: z.array(BlueprintIssuerSchema).optional(),
  })
  .strict()
  .superRefine((bp, ctx) => {
    lintSelfTokenPlacement(bp, ctx);
    lintIdentityRefs(bp, ctx);
    lintIdentityOverrides(bp, ctx);
    lintNamespacedScopeArrays(bp, ctx);
    lintDataScopeKeys(bp, ctx);
    lintSeedSurfaces(bp, ctx);
  });

export type Blueprint = z.infer<typeof BlueprintSchema>;
export type BlueprintFieldDef = z.infer<typeof BlueprintFieldDefSchema>;
export type BlueprintSchemaDef = z.infer<typeof BlueprintSchemaSchema>;
/** A single seed entry — a record seed OR a document seed (discriminated on `surface`). */
export type BlueprintSeed = z.infer<typeof BlueprintSeedRecordSchema>;
/** The record-surface seed variant (`surface: 'record'`; the default). */
export type BlueprintRecordSeed = z.infer<typeof RecordSeedSchema>;
/** The document-surface seed variant (`surface: 'document'`; carries `title` + `text`). */
export type BlueprintDocumentSeed = z.infer<typeof DocumentSeedSchema>;
/** @deprecated The element type of `seed[]`, now a union — use {@link BlueprintSeed}. */
export type BlueprintSeedRecord = BlueprintSeed;
export type BlueprintValidationRules = z.infer<typeof ValidationRulesSchema>;
export type BlueprintRenderHints = z.infer<typeof RenderHintsSchema>;
export type BlueprintLookupField = z.infer<typeof BlueprintLookupFieldSchema>;
/** A single trusted-issuer entry, applied in the loader's bootstrap-token phase. */
export type BlueprintIssuer = z.infer<typeof BlueprintIssuerSchema>;
export type BlueprintRoleClause = z.infer<typeof BlueprintRoleClauseSchema>;
export type BlueprintRoles = z.infer<typeof BlueprintRolesSchema>;
export type IdentityDecl = z.infer<typeof IdentityDeclSchema>;
export type IdentitiesDecl = z.infer<typeof IdentitiesDeclSchema>;

/**
 * A single structural validation problem, flattened to a readable field path +
 * message. Exposed on {@link BlueprintValidationError.issues} so programmatic
 * callers (a future web authoring UI, CI annotations) get structure without
 * re-parsing the rendered message.
 */
export interface BlueprintIssue {
  /** Dotted/bracketed path, e.g. `schemas[0].fields[1].fieldType`, or `(root)`. */
  path: string;
  message: string;
}

/** Render a zod issue path (`['schemas', 0, 'fields', 1]`) → `schemas[0].fields[1]`. */
function formatIssuePath(path: ReadonlyArray<string | number>): string {
  let out = '';
  for (const seg of path) {
    if (typeof seg === 'number') out += `[${seg}]`;
    else out += out.length ? `.${seg}` : seg;
  }
  return out.length ? out : '(root)';
}

/** Flatten a {@link z.ZodError} into readable, ordered {path, message} entries. */
function toBlueprintIssues(error: z.ZodError): BlueprintIssue[] {
  return error.issues.map((i) => ({ path: formatIssuePath(i.path), message: i.message }));
}

/** Render issues into the multi-line, teach-by-error message body. */
function renderIssues(issues: BlueprintIssue[]): string {
  return issues.map((i) => `  • ${i.path}: ${i.message}`).join('\n');
}

export class BlueprintValidationError extends Error {
  /**
   * Structured per-field issues. Populated for STRUCTURAL failures (a bad
   * shape); empty for a JSON/YAML *parse* failure (where there's no field path,
   * just a syntax error in {@link Error.message}).
   */
  readonly issues: BlueprintIssue[];
  constructor(message: string, issues: BlueprintIssue[] = []) {
    super(message);
    this.name = 'BlueprintValidationError';
    this.issues = issues;
  }
}

/**
 * Structurally parse + validate an untrusted blueprint object. Throws
 * {@link BlueprintValidationError} on a malformed shape — with a readable,
 * multi-line `path: message` body and the structured issues on `.issues`. Does
 * NOT run the scope gate — that's the CLI's job (the trust boundary).
 */
export function parseBlueprint(input: unknown): Blueprint {
  const result = BlueprintSchema.safeParse(input);
  if (!result.success) {
    const issues = toBlueprintIssues(result.error);
    throw new BlueprintValidationError(`Malformed blueprint:\n${renderIssues(issues)}`, issues);
  }
  return result.data;
}

/**
 * Parse a blueprint from a JSON string (e.g. a file an agent assembled or
 * a community blueprint). Throws {@link BlueprintValidationError} on bad
 * JSON or a bad shape.
 */
export function parseBlueprintJson(json: string): Blueprint {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    throw new BlueprintValidationError(
      `Blueprint is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return parseBlueprint(parsed);
}

/** The app-context display name, defaulting to `MCP — <name>` when {@link Blueprint.contextName} is absent. */
export function contextNameOf(blueprint: Blueprint): string {
  return blueprint.contextName ?? `MCP — ${blueprint.name}`;
}
