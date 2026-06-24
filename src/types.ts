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

// Field-level validation rules — mirrors the platform `ValidationRules`
// (platform/common-core/.../template/ValidationRules.java). Passed straight
// through to `SchemaRequest.FieldDef.validation` so the backend enforces them.
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
    // lookup resolves the link (SchemaRequest.FieldDef.targetSurface).
    targetSurface: z.enum(['record', 'document', 'user', 'org', 'client']).optional(),
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
          "a 'reference' field requires 'targetSurface' (which surface the target lives on: record | document | user | org | client)",
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
// index, an exact-match sort key, or an opt-in past the fast-index budget. The
// loader normalizes both to the partner-API `LookupDef` shape ([SV5]).
const BlueprintLookupFieldSchema = z.union([
  z.string().min(1),
  z
    .object({
      fieldName: z.string().min(1),
      unique: z.boolean().optional(),
      // Opt this field into ordered range + prefix lookups (from/to/prefix) on
      // top of exact match. Billed at the range-index rate; not valid on a
      // sensitive field (a blind index is not orderable). Locked at create.
      rangeEnabled: z.boolean().optional(),
      // Sort key for the exact-match index: 'createdAt' (default), 'lastUpdated',
      // or a declared field on this schema. Locked at create.
      sortBy: z.string().min(1).optional(),
      // Opt a field past the fixed fast-index budget into a higher-cost
      // secondary index. No effect on a field that fits within the budget.
      allowOverflow: z.boolean().optional(),
    })
    .strict(),
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
    indexMode: z.enum(['HYBRID', 'SEMANTIC', 'TEXT']).optional(),
    fields: z.array(BlueprintFieldDefSchema).default([]),
    lookupFields: z.array(BlueprintLookupFieldSchema).max(10).optional(),
    // Which typed surfaces may bind this schema. REQUIRED + non-empty on
    // the platform `SchemaRequest` (0.23+); the loader defaults it to ['record']
    // when a blueprint omits it (blueprints provision record types + seed records).
    allowedSurfaces: z.array(z.enum(['record', 'document', 'user', 'org', 'client'])).min(1).optional(),
    // NEW (format passthrough) — mirror the platform `SchemaRequest` shape 1:1.
    capabilities: BlueprintCapabilitiesSchema.optional(),
    // Whether the schema is active; inactive schemas reject new record creation.
    active: z.boolean().optional(),
    // Schema-level ownership defaults — flat, matching `SchemaRequest`
    // userId/orgId/clientId. With a scoped token these must be consistent with
    // the profile's dataScope (a cross-consistency lint is deferred to the lint slice).
    userId: z.string().min(1).optional(),
    orgId: z.string().min(1).optional(),
    clientId: z.string().min(1).optional(),
  })
  .strict();

const BlueprintAccessProfileSchema = z
  .object({
    // Validated structurally here; the SCOPE GATE (in @vectros-ai/cli) is
    // what enforces the data-plane-only security boundary.
    allowedActions: z.array(z.string().min(1)).min(1),
    // Optional ownership binding: { userId: [...], orgId: [...], clientId: [...] }.
    // A `null` element in a value list is the documented NULL SENTINEL — it
    // grants access to TENANT-LEVEL (owner-less) records IN ADDITION to the
    // listed owner ids. `null` is the literal matched value: a tenant-level
    // record has a genuinely-null ownership field, and the platform's scope
    // matcher tests `allowedValues.contains(null)` against the tenant-level
    // null sentinel (+ ScopeClause). e.g. `{ orgId: ["org_x", null] }` =
    // "org_x's records AND tenant-shared records". Omitting null restricts to
    // the listed owners ONLY (the key will NOT see tenant-level/seed records).
    dataScope: z.record(z.array(z.union([z.string().min(1), z.null()]))).optional(),
  })
  .strict();

// A single role clause — mirrors the platform/SDK ScopeClause (allowedActions +
// optional per-clause dataScope). Multi-clause roles let one role grant several
// (action-set, data-scope) rules at once, evaluated per-clause server-side.
// `${{ self.* }}` placeholders are legal in a clause's dataScope: they are a
// RUNTIME sentinel the platform resolves per-principal at request time
// — the install-time resolver leaves them literal (see inputs.ts),
// and a top-level lint (BlueprintSchema) confines them to here.
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

// A declared identity — a principal the blueprint expects to exist, ensured
// (idempotently, by externalId) at APPLY time by a creds-bearing pass (the CLI
// install orchestrator). Referenced elsewhere via `${{ identities.<name> }}`,
// which the install-time resolver leaves literal and the apply pass substitutes
// with the resolved principal id. The schema is FORMAT/shape only; resolution
// (resolveBlueprintIdentities) lives in identities.ts.
const IdentityDeclSchema = z
  .object({
    kind: z.enum(['user', 'org', 'client']),
    externalId: z.string().min(1),
    displayName: z.string().min(1).optional(),
    metadata: z.record(z.unknown()).optional(),
  })
  .strict();

// Optional top-level `identities` block — a map of local name → declaration.
// Exported so the apply-time resolver (identities.ts) validates the block too.
export const IdentitiesDeclSchema = z.record(IdentityDeclSchema);

const BlueprintServicePrincipalSchema = z
  .object({
    externalId: z.string().min(1),
    displayName: z.string().min(1),
  })
  .strict();

const BlueprintSeedRecordSchema = z
  .object({
    typeName: z.string().min(1),
    externalId: z.string().min(1),
    fields: z.record(z.unknown()),
  })
  .strict();

// `${{ self.* }}` is a RUNTIME per-principal placeholder (platform-resolved at
// request time). It is only meaningful inside a role clause's
// dataScope; anywhere else in a blueprint it would never resolve. This walk
// confines it there (teach-by-error), running on the already-input-resolved doc
// (the install-time resolver leaves self tokens literal — see inputs.ts).
const SELF_TOKEN_RE = /\$\{\{\s*self\.[A-Za-z_]\w*\s*\}\}/;

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

function lintIdentityRefsDeclared(value: unknown, ctx: z.RefinementCtx): void {
  const declared = new Set(
    value && typeof value === 'object' && 'identities' in value && (value as { identities?: unknown }).identities
      ? Object.keys((value as { identities: Record<string, unknown> }).identities)
      : [],
  );
  const walk = (node: unknown, path: (string | number)[]): void => {
    if (typeof node === 'string') {
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
  })
  .strict()
  .superRefine((bp, ctx) => {
    lintSelfTokenPlacement(bp, ctx);
    lintIdentityRefsDeclared(bp, ctx);
  });

export type Blueprint = z.infer<typeof BlueprintSchema>;
export type BlueprintFieldDef = z.infer<typeof BlueprintFieldDefSchema>;
export type BlueprintSchemaDef = z.infer<typeof BlueprintSchemaSchema>;
export type BlueprintSeedRecord = z.infer<typeof BlueprintSeedRecordSchema>;
export type BlueprintValidationRules = z.infer<typeof ValidationRulesSchema>;
export type BlueprintRenderHints = z.infer<typeof RenderHintsSchema>;
export type BlueprintLookupField = z.infer<typeof BlueprintLookupFieldSchema>;
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
