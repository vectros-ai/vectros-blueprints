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
 * Characters that would corrupt or FORGE a line in a rendered, human-reviewed context, or
 * hide/misrepresent text within one via an invisible or reordering character.
 * `vectros bootstrap`'s pre-apply plan preview (`@vectros-ai/cli`'s `buildPlan`/`renderPlan`)
 * interpolates blueprint-authored free text directly into single printed lines, and an
 * operator approves a real mint based on reading them. A string containing a raw newline/CR,
 * a Unicode line/paragraph separator, an ANSI escape (also a C0 control — `\x1b` is the
 * escape-sequence lead-in), a bidi-override/isolate character, an invisible/zero-width
 * character, or a bidi MARK (which reorders neutral characters around it, even without a
 * full override) can forge an extra fake line, hide or reorder adjacent text, or otherwise
 * make the rendered preview show something other than what will actually be minted —
 * defeating the review the preview exists to provide.
 *
 * Rejected AT PARSE TIME (`safeDisplayString` below), rather than sanitized at each render
 * site: a per-site strip-and-continue means every NEW field added to a future preview (or any
 * other rendered surface) is a new forgery surface, guarded only by whoever remembers to
 * sanitize it there. A schema-level reject closes it once, for every current and future sink,
 * and fails loudly on a hostile blueprint instead of quietly rendering a cleaned-up version of
 * one — an operator who approves a plan is trusting that the schema already made this
 * impossible, not that every renderer downstream remembered to defend against it.
 *
 *   C0 controls + DEL:         \x00-\x1f, \x7f (incl. \n, \r, \t, \x1b — the ANSI escape lead-in)
 *   C1 controls:               \x80-\x9f
 *   Soft hyphen:               U+00AD
 *   Arabic Letter Mark:        U+061C
 *   Zero-width + BOM:          U+200B-U+200D (ZWSP/ZWNJ/ZWJ), U+2060 (word joiner), U+FEFF
 *   Bidi MARKS (reorder only): U+200E, U+200F (LRM/RLM)
 *   Line/paragraph separators: U+2028, U+2029
 *   Bidi control characters:   U+202A-U+202E (embed/override), U+2066-U+2069 (isolate)
 *   Unicode tag characters:    U+E0000-U+E007F (render invisibly; two distinct byte sequences
 *                              can look identical on screen)
 *
 * ⚠️ WHAT THIS DOES **NOT** CLOSE — state plainly, not implied by omission:
 *
 *   1. LENGTH is not bounded here at all (no `.max`). A very long value pushes real content
 *      off-screen in a rendered line, the same practical spoofing effect as a forged line —
 *      see `@vectros-ai/cli`'s `loader.ts` `sanitizeForPlanDisplay`, which caps length as a
 *      render-site concern this schema layer does not attempt.
 *   2. HOMOGLYPHS are not closed for a general free-text field by any blocklist — Unicode's
 *      confusable-character space (Cyrillic/Greek/Latin look-alikes, etc.) is far larger than
 *      any enumerable list, so a field like `name`/`contextName`/`fieldId` can still be
 *      authored to visually resemble different text than it is. The three URL-shaped fields
 *      below (`issuer`/`jwksUri`/`userinfoUri`) close this for THEMSELVES via a different,
 *      positive mechanism (`safeUrlString`) — printable-ASCII-only plus a parsed-URL check —
 *      because a URL host is exactly the place a homoglyph is weaponized (a domain an operator
 *      reads and trusts). That mechanism does not generalize to prose/identifier fields, which
 *      have no equivalent "must be ASCII" constraint a legitimate author could always satisfy.
 */
const FORGERY_CHARS_RE =
  /[\x00-\x1f\x7f-\x9f\u00ad\u061c\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060\u2066-\u2069\ufeff\u{e0000}-\u{e007f}]/u;

/**
 * Wrap a `z.string()` schema — AFTER any shape constraints (`.min`/`.max`/etc.) are already
 * applied, never before: `.refine()` returns a `ZodEffects`, which drops `ZodString`'s own
 * chainable methods, so this must be the LAST call in the chain (matching every other
 * `.refine()` use in this file). For any field a rendered, human-reviewed surface (today:
 * the CLI's plan preview; potentially others later) may interpolate into a single line — see
 * `FORGERY_CHARS_RE`'s own doc for why this lives at the schema, not at each renderer, AND for
 * what it does and does NOT close (length; homoglyphs on a non-URL field). For a field whose
 * value is itself a URL (`issuer`/`jwksUri`/`userinfoUri`), use `safeUrlString` below instead —
 * it closes the homoglyph class for those three specifically, which this function cannot.
 *
 * ⚠️ UNSUITABLE for any field authored as a YAML block scalar (`>` folded or `|` literal) — the
 * idiom every multi-line prose field naturally reaches for. YAML's default (clip) chomping
 * always leaves exactly ONE trailing `\n` on the parsed value, which `FORGERY_CHARS_RE` rejects
 * as a C0 control indistinguishable from an embedded forgery newline. `description`-shaped
 * fields (a schema's, a field's, a script's `declaredInputContract`/`source`, …) are exactly
 * this class — a real multi-line blueprint description authored this way broke this validator
 * (the top-level `description`) before the wrap was removed from that field. A "just strip a
 * trailing newline first" fix is NOT safe in general:
 * this wrapper is a schema-level primitive with no visibility into where its value ends up
 * rendered — a trailing newline is harmless only when the value is the LAST thing on its own
 * rendered line, which is true for some call sites here (a bare `description` step) but not
 * others (e.g. `contextName`, immediately followed by `${projection}` and a closing paren on
 * the SAME rendered line — a trailing newline THERE forges exactly the mid-line break this
 * wrapper exists to prevent). Before wrapping a NEW field with this function, either confirm it
 * is never authored as a block scalar, or don't — do not add a trailing-newline exception here
 * to make it fit.
 */
function safeDisplayString<T extends z.ZodString>(base: T) {
  return base.refine((v) => !FORGERY_CHARS_RE.test(v), {
    message:
      'must not contain control characters, invisible/zero-width characters, line/paragraph ' +
      'separators, or bidi marks/overrides — these can forge, hide, or reorder text in a ' +
      'rendered plan preview',
  });
}

/**
 * A tighter, POSITIVE check for a field whose value must itself be a URL a human reads and
 * trusts (today: an issuer's `issuer`/`jwksUri`/`userinfoUri` — the trust-anchor fields the
 * plan preview exists to disclose). Requires the ENTIRE raw string to be printable ASCII
 * (`\x20`-`\x7e`), to start with `https://` (case-insensitive; `http:` is NOT accepted — see
 * below), and its AUTHORITY (the substring between `://` and the first `/`, `?`, or `#`) to
 * match `[A-Za-z0-9.-]+(:\d+)?` — letters, digits, dot, dash, and an optional numeric port.
 *
 * WHY A GRAMMAR ON THE AUTHORITY, NOT A CALL TO `new URL()` FOLLOWED BY MORE CHECKS: an earlier
 * version of this function parsed the value with `new URL()` and checked the RESULT — that
 * approach has two bypasses `new URL()` itself creates, both closed by never calling it at all:
 *
 *   1. HOMOGLYPH-VIA-PERCENT-ENCODING: `new URL()` percent-DECODES the authority as part of
 *      parsing, then IDNA/punycode-normalizes the decoded host. So `https://%D0%B0pple.example/`
 *      (percent-encoded Cyrillic 'а') decodes to the same Cyrillic host `new URL()` would also
 *      punycode-encode from a literal Cyrillic character — the parsed `.hostname` is ASCII
 *      either way, and an ASCII-only check on it cannot tell "the author wrote punycode
 *      deliberately" from "IDNA produced punycode from a homoglyph the percent-encoding hid."
 *      The authority grammar here rejects `%` outright, so the encoded form never reaches a
 *      decoder in the first place.
 *   2. USERINFO PHISHING: `https://jwks.trusted-idp.example@evil.example/keys` parses to
 *      `.hostname === 'evil.example'` with `.username === 'jwks.trusted-idp.example'` — but the
 *      RAW STRING an operator reads in the rendered plan shows the trusted-looking prefix
 *      immediately after `jwksUri:`, before the `@`, which is exactly where a human eye stops
 *      reading a URL as "the domain." A `.hostname`-only check never inspects that raw string
 *      shape at all. The authority grammar rejects `@` outright, so userinfo syntax can't appear.
 *
 * This closes the HOMOGLYPH class `safeDisplayString`/`FORGERY_CHARS_RE` cannot: a Unicode
 * look-alike host (e.g. a Cyrillic 'а' in place of Latin 'a') is invisible to any character
 * BLOCKLIST — no enumerable list of "forgery characters" contains an ordinary-looking letter
 * from a different script. This POSITIVE grammar closes it instead: an author who needs a
 * genuine internationalized domain must supply its already-punycode (`xn--…`) ASCII form, which
 * is what every real IdP presents on the wire — and with percent-encoding and userinfo excluded
 * by the grammar, what the operator reads in the rendered plan IS the actual authority, `xn--`
 * prefix included, restoring the property this field's disclosure was meant to have.
 *
 * `https:` ONLY, not `http:`: the platform hard-refuses a non-`https` issuer/jwksUri/userinfoUri
 * at registration, so accepting `http:` here would repeat this package's own established anti-
 * pattern — a blueprint that lints clean and then 400s at apply — for a field this exact
 * function exists to catch problems in before that point. `@vectros-ai/cli`'s own tests pin
 * an `http://` value being rejected, so this choice is a tested decision, not an implicit one.
 *
 * RESIDUALS — named, not chased: a trailing-dot host (`good.example.`) still passes (cosmetic,
 * not a homoglyph risk); a bare IPv4 literal (`192.0.2.1`) still passes (a platform-side fetch
 * concern this preview isn't positioned to evaluate, not a display-forgery one); a bracketed
 * IPv6 literal (`[::1]`) is REJECTED as a side effect of excluding `[`/`]`/extra `:` from the
 * authority grammar (an IdP is never realistically IPv6-literal-addressed in practice, so this
 * is an acceptable false-reject, not a gap worth widening the grammar for).
 *
 * LENGTH is still not bounded here (see `FORGERY_CHARS_RE`'s own doc on that axis, which
 * applies here too) — this function closes the homoglyph and forgery-character classes for
 * these three fields specifically, and nothing else.
 */
function safeUrlString<T extends z.ZodString>(base: T) {
  return base.refine(
    (v) => {
      if (!/^[\x20-\x7e]*$/.test(v)) return false;
      const authorityMatch = /^https:\/\/([^/?#]*)/i.exec(v);
      if (!authorityMatch) return false;
      return /^[A-Za-z0-9.-]+(:\d+)?$/.test(authorityMatch[1]);
    },
    {
      message:
        'must be a printable-ASCII https:// URL whose authority is only letters, digits, dot, ' +
        "dash, and an optional port — no userinfo ('@'), percent-encoding, or non-ASCII host " +
        '(including a look-alike/homoglyph domain) is accepted; supply an internationalized ' +
        'domain in its punycode (xn--…) form',
    },
  );
}

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
    fieldId: safeDisplayString(z.string().min(1)),
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
    // Keep this field on the RECORD ROW when the payload is stored out of line (a large record, or a
    // LARGE_PAYLOAD storage profile), so it appears in list/lookup projections without
    // `includePayload`.
    //
    // Load-bearing for triggers: a trigger rule's `fields` may name a field only if it is `inline`,
    // `filterable`, or a lookup field — and never `sensitive`. So this is the flag that makes an
    // otherwise-ordinary field projectable into a triggered script's `input.record`. Mutually
    // exclusive with `sensitive` (the platform refuses the combination). The platform also refuses,
    // with a 409, removing whatever keeps a field projectable while a live trigger rule still
    // projects it — dropping `inline` OR `filterable` OR the lookup that carried it, not just this
    // flag.
    //
    // Format passthrough — the loader forwards it to createSchema. Default false.
    inline: z.boolean().optional(),
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
    // The platform refuses `inline` together with `sensitive`: a sensitive field is blind-indexed
    // and masked, so keeping a readable copy on the row would defeat it. Caught here so it is an
    // authoring error rather than a 400 partway through an apply.
    if (field.inline === true && field.sensitive === true) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['inline'],
        message:
          "a field cannot be both 'inline' and 'sensitive' — a sensitive field is blind-indexed and " +
          'masked in responses, so it can never be projected into a trigger script; drop one of the two',
      });
    }
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
// safeDisplayString on every string leaf below: a schema's `lookupFields` renders raw into
// `buildPlan`'s schema-step summary line (the `lookupNote`, alongside `fieldId`'s
// sensitive-fields note on that same line) — a gap found after the rest of this file's
// forgery-character pass had already shipped.
const BlueprintLookupFieldSchema = z.union([
  safeDisplayString(z.string().min(1)),
  z
    .object({
      // A lookup field declares either ONE field (fieldName) or 2-3 fields
      // matched together (fieldNames) — never both, never neither. `.strict()`
      // below only rejects unknown KEYS; it does not enforce this combination,
      // so the `.superRefine()` after it carries the actual rule.
      fieldName: safeDisplayString(z.string().min(1)).optional(),
      // Composite (conjunctive) lookup: match on all of these fields at once —
      // "every record where `status` is `open` AND `area` is `billing`", exact,
      // in a stable order. Order is significant and locked at create: a query
      // may match a leading run of the list (the first field alone, the first
      // two together, …) but never a later field alone — declare a separate
      // lookup for that. Record-only: the schema's `allowedSurfaces` must be
      // exactly `['record']` (checked at the schema level below) — the
      // platform's composite index has no document/user/entity reader yet.
      fieldNames: z.array(safeDisplayString(z.string().min(1))).min(2).max(3).optional(),
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

// Schema capabilities. We surface these so a blueprint's posture is
// self-documenting + reviewable rather than set out of band.
//
// `auditHistory` — platform default true.
//
// `triggersEnabled` — platform default FALSE, opt-in. Records of a schema only
// fire async trigger rules when their schema declares this. It is deliberately
// an ENABLE and not a place to define triggers: the rules themselves are their
// own `triggers[]` entries and their own server-side rows. Two consequences a
// blueprint author sees directly: declaring a `triggers[]` entry against a
// schema that has not opted in is REFUSED (here at plan time, and again by the
// platform), and the two capabilities are independent — turning audit history
// off does not turn triggers off.
//
// Note that a schema update replaces `capabilities` in full when the block is
// supplied, so declaring other capabilities without `triggersEnabled` clears it.
// The platform refuses that while trigger rules still reference the schema, but
// keep it declared rather than relying on the refusal.
const BlueprintCapabilitiesSchema = z
  .object({
    auditHistory: z.boolean().optional(),
    triggersEnabled: z.boolean().optional(),
  })
  .strict();

const BlueprintSchemaSchema = z
  .object({
    // safeDisplayString: buildPlan's schema step renders this raw into a single summary
    // line (`schema '${s.typeName}' (...)`) — a gap found after the rest of this file's
    // forgery-character pass had already shipped, the same "unconstrained free-text field
    // reaches a rendered plan line" shape as issuer/allowedActions/etc. `displayName`
    // here is NOT wrapped: unlike
    // servicePrincipal's own displayName, this one is never interpolated into a rendered
    // summary anywhere in loader.ts today (only forwarded to the schema-upsert payload).
    typeName: safeDisplayString(z.string().min(1)),
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
    // ADVISORY ONLY — not sent to the platform, never runtime-enforced. The
    // ownership dimensions this schema's records are typically scoped by
    // (e.g. ['org', 'client']), declared so the CLI's blueprint lint can warn
    // when a role clause grants r/u/d on this type but its `dataScope` names
    // only SOME of these dims — a schema author's easiest way to leave a
    // dimension unintentionally unconstrained, since reads (unlike creates)
    // never require full-dimension `dataScope` coverage — this helps an
    // author NOTICE that read/write asymmetry, not change it; the asymmetry
    // itself is a ratified, deliberate platform behavior.
    // Same grammar as a `dataScope` key with the `scope:` prefix stripped:
    // a bare namespace name, or 'userId' for the principal dimension.
    // Structural-only here (validated below by `lintExpectedScopeDims`); the
    // cross-referencing lint against role clauses lives in `packages/cli`.
    expectedScopeDims: z.array(z.string().min(1)).max(MAX_SCOPE_DIMENSIONS).optional(),
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

// Capability-name grammar — mirrors the platform's PUBLIC grammar
// (`Capability.NAME_PATTERN`): lowercase, kebab-case, no colon, never `'*'`.
// This is the STRUCTURAL shape only. Deliberately NOT the closed set of
// grantable names (e.g. `'member-lifecycle'`) — that set is a platform
// property that moves as new capabilities ship ("a capability that cannot be
// given a clear name gets split, or is not created" is the platform's own
// admission test for minting one), and baking a copy of it into a published
// package guarantees the next new entry finds a stale mirror here — the same
// failure mode as any grammar hand-transcribed into several places with
// nothing checking any copy against its source. The closed-set /
// not-yet-enforced checks are the CLI scope gate's job, against the live
// registry, at apply time — a separate package, out of scope for this format
// layer.
const CAPABILITY_NAME_RE = /^[a-z][a-z0-9-]*$/;

/**
 * A `capabilities` list — format passthrough to the platform's
 * `granted_capabilities` (`ScopeClause.capabilities`). Structural validation
 * only, mirroring the SHAPE half of the platform's own per-entry grammar check
 * (blank / `'*'` / colon / case / duplicate) — deliberately NOT its
 * closed-registry lookup, which only the platform can answer without going
 * stale (see `CAPABILITY_NAME_RE` above). A well-formed but unrecognized name
 * (a typo, or a name from a newer platform release) parses here without
 * error — same forward-compatible posture this package already takes with
 * `allowedActions`.
 *
 * ⚠️ THIS PACKAGE ENFORCES NOTHING. A successful parse is not the same as
 * the capability being granted: whether an unrecognized or not-yet-grantable
 * name is actually rejected depends entirely on whether the CLIENT consuming
 * this package reads `capabilities` at all and checks it against the live
 * platform registry before minting anything. A client that does not (yet)
 * read this field will silently ignore a declared grant, with no error at
 * any layer — do not assume `capabilities` has any effect until you have
 * confirmed your client's own release notes say it does.
 */
const GrantedCapabilitiesSchema = z
  .array(z.string().min(1))
  .optional()
  .superRefine((caps, ctx) => {
    if (!caps) return;
    const seen = new Set<string>();
    caps.forEach((name, i) => {
      // Blank already gets its own issue from the array item schema's
      // `.min(1)` above — don't pile a second, redundant "not a valid name"
      // issue onto the same index.
      if (name === '') return;
      if (name === '*') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [i],
          message:
            "'*' is not a capability — granted_capabilities has no wildcard, and a '*' in allowedActions " +
            'confers zero capabilities. Name each capability explicitly.',
        });
      } else if (!CAPABILITY_NAME_RE.test(name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [i],
          message: `'${name}' is not a valid capability name (expected lowercase letters, digits and hyphens, starting with a letter, and no ':' — a capability is not an action)`,
        });
      }
      if (seen.has(name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [i],
          message: `'${name}' is declared more than once`,
        });
      }
      seen.add(name);
    });
  });

/**
 * `assignable_roles` — the designated-roleId allow-list restricting WHICH named roles a clause may
 * compose into a delegated AccessProfile (`roleIds` composition). Orthogonal to
 * `allowedActions`/`dataScope`: it narrows which roles this clause's authority may hand out, not how
 * much data it reaches.
 *
 * Bounds transcribed from the platform's own role-id validation. Three rules that are easy to
 * get wrong, all deliberate platform-side:
 *
 * - **Absent means UNRESTRICTED** (default-open), matching `data_scope`'s own posture. A tenant opts
 *   INTO the restriction by adding the field.
 * - **An EMPTY list is rejected**, not read as "restricted to nothing" — an empty list states no
 *   rule, so the platform makes you omit the field instead. Collapsing `[]` and absent into two
 *   different meanings is exactly the silent misreading this refuses to allow.
 * - **A duplicate is rejected**, not deduplicated.
 *
 * Entries are NOT lint-checked against this blueprint's own `roles` block: a clause may legitimately
 * name a roleId that already exists in the context, or one another blueprint declares. Only the
 * FORMAT is knowable offline.
 */
const MAX_ASSIGNABLE_ROLES = 20;
const ROLE_ID_RE = /^[a-z][a-z0-9-]{2,30}$/;

const AssignableRolesSchema = z
  .array(
    z.string().regex(ROLE_ID_RE, {
      message:
        "an assignableRoles entry must be a roleId: 3-31 chars, a lowercase letter first, then " +
        "lowercase letters/digits/dashes (e.g. 'case-handler')",
    }),
  )
  .min(1, {
    message:
      'assignableRoles must either be omitted (no roleId restriction) or name at least one roleId — ' +
      'an empty list states no rule',
  })
  .max(MAX_ASSIGNABLE_ROLES, {
    message: `assignableRoles accepts at most ${MAX_ASSIGNABLE_ROLES} entries`,
  })
  .optional()
  .superRefine((roleIds: readonly string[] | undefined, ctx: z.RefinementCtx) => {
    if (!roleIds) return;
    const seen = new Set<string>();
    roleIds.forEach((rid, i) => {
      if (seen.has(rid)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [i],
          message: `assignableRoles names '${rid}' more than once — list it once`,
        });
      }
      seen.add(rid);
    });
  });

const BlueprintAccessProfileSchema = z
  .object({
    // Validated structurally here; the SCOPE GATE (in @vectros-ai/cli) is
    // what enforces the data-plane-only security boundary.
    //
    // Optional now: mutually exclusive with `roleIds` below (the
    // `.superRefine` on this schema enforces the XOR, mirroring the platform's
    // own access-profile scopes/role-composition XOR check). Exactly one of
    // the two authors this profile's grant.
    allowedActions: z.array(safeDisplayString(z.string().min(1))).min(1).optional(),
    // Additive role composition: this profile's effective grant is
    // each named role's own clauses, concatenated in the order listed, instead of
    // an inline clause authored here. Every id must name a role this SAME
    // blueprint declares in `roles` (`lintAccessProfileRoleIds` below — the
    // authoring-time mirror of the platform's same-`(tenantId, contextId)`
    // check, trivially satisfied here since a blueprint's own `roles` are
    // always created in its own `contextId`); duplicates are rejected outright
    // rather than silently deduplicated. Mutually exclusive
    // with `allowedActions`/`dataScope`/`capabilities` — a role-referencing
    // profile has no inline clause of its own to carry a dataScope or
    // capability grant; author those on the referenced Role instead, where
    // every profile referencing it picks them up uniformly (mirrors how
    // `assumable` already works for a `roleId`-referencing profile).
    roleIds: z.array(z.string().min(1)).min(1).optional(),
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
    // safeDisplayString on the value: not currently rendered by VALUE anywhere in buildPlan
    // (only `Object.keys(...)` of a profile's dataScope is shown today, unlike a role clause's
    // dataScope, which `renderPlanDataScope` prints values for — the reason that sibling field
    // WAS wrapped). Wrapped anyway for consistency with every other dataScope-shaped field in
    // this file, and so a future preview enhancement that starts showing these values (a very
    // plausible one, given the existing renderPlanDataScope precedent) doesn't silently reopen
    // this exact class on a field that looks, byte-for-byte, like every other one already closed.
    dataScope: z.record(z.array(z.union([safeDisplayString(z.string().min(1)), z.null()]))).optional(),
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
    // Optional capabilities granted to the blueprint's own service-principal
    // profile. DECISION: allowed here, not role-clause-only. On the platform,
    // an access profile's scopes are themselves a list of clauses — the exact
    // same wire shape a role clause carries — and the loader already builds
    // this profile as ONE such clause. Refusing `capabilities` here while
    // allowing it on a role clause would be an asymmetry this FORMAT package
    // has no basis to invent: nothing on the platform side distinguishes the
    // two, and whether granting a capability to a blueprint's own service key
    // is sound POLICY is exactly the question the CLI's scope gate exists to
    // answer (a separate package, out of scope for this format layer) — the
    // same posture this package already takes with `allowedActions` above.
    //
    // Worth naming for whoever writes that gate: this profile is a long-lived,
    // non-human-attributable machine credential (typically stored in CI/CD
    // secrets), not an ephemeral human session — a materially different
    // blast-radius question from granting the same capability to a role that
    // a person is bound to. The gate should weigh the two separately rather
    // than reuse one policy for both.
    capabilities: GrantedCapabilitiesSchema,
    // Optional roleId allow-list on this profile's own inline clause — see
    // {@link AssignableRolesSchema}. Allowed here for the same symmetry reason `capabilities` is:
    // the platform models an access profile's scopes as a list of the SAME ScopeClause a role clause
    // uses, and the loader already builds this profile as one such clause. Only meaningful when the
    // clause grants role-composing authority in the first place (`profiles:c`-shaped); on a
    // clause that grants none it is inert rather than an error, exactly as on the platform.
    assignableRoles: AssignableRolesSchema,
  })
  .strict()
  .superRefine((ap, ctx) => {
    // The XOR: exactly one of an inline clause (allowedActions,
    // optionally paired with dataScope/capabilities) or a role-composed
    // reference (roleIds). Mirrors the platform's own access-profile
    // scopes/role-composition XOR check server-side — caught here, at
    // authoring time, rather than left to 400 at mint.
    const hasInline = ap.allowedActions !== undefined;
    const hasRoleIds = ap.roleIds !== undefined;
    if (hasInline === hasRoleIds) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['roleIds'],
        message: hasInline
          ? "accessProfile carries both 'allowedActions' and 'roleIds' — provide exactly one: an " +
            "inline clause (allowedActions, optionally dataScope/capabilities) OR a role composition " +
            "(roleIds), never both"
          : "accessProfile carries neither 'allowedActions' nor 'roleIds' — provide exactly one: an " +
            "inline clause (allowedActions, optionally dataScope/capabilities) OR a role composition " +
            "(roleIds)",
      });
      return;
    }
    // A roleIds-composed profile has no inline clause to hang a dataScope or
    // capability grant on — the same reason `assumable` is rejected alongside
    // a `roleId`-referencing profile (AccessProfileRequest's own doc). Author
    // these on the referenced Role's own clauses instead.
    if (hasRoleIds) {
      if (ap.dataScope !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['dataScope'],
          message:
            "accessProfile.dataScope is not valid alongside 'roleIds' — a role-composed profile has " +
            'no inline clause of its own; author dataScope on the referenced role\'s clause instead',
        });
      }
      if (ap.capabilities !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['capabilities'],
          message:
            "accessProfile.capabilities is not valid alongside 'roleIds' — a role-composed profile has " +
            'no inline clause of its own; author capabilities on the referenced role\'s clause instead',
        });
      }
      if (ap.assignableRoles !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['assignableRoles'],
          message:
            "accessProfile.assignableRoles is not valid alongside 'roleIds' — a role-composed " +
            'profile has no inline clause of its own; author assignableRoles on the referenced ' +
            "role's clause instead",
        });
      }
    }
  });

// A single role clause — mirrors the platform/SDK ScopeClause, now THREE-part:
// allowedActions + optional per-clause dataScope + optional per-clause
// capabilities (`allowed_actions` / `data_scope` / `granted_capabilities` on
// the wire). Multi-clause roles let one role grant
// several (action-set, data-scope, capability-set) rules at once, evaluated
// per-clause server-side.
// `${{ self.* }}` placeholders are legal in a clause's dataScope: they are a
// RUNTIME sentinel the platform resolves per-principal at request time
// — the install-time resolver leaves them literal (see inputs.ts),
// and a top-level lint (BlueprintSchema) confines them to here. Every KEY is
// also validated (`lintDataScopeKeys`) — `userId` or a grammar-valid
// `scope:<ns>`, no other shape, same rule as `accessProfile.dataScope` above.
//
// `dataScopeRef` is AUTHORING-ONLY sugar: name a
// top-level `fragments.<name>` entry instead of repeating an identical
// `dataScope` map verbatim across several clauses (the exact shape a role with
// several similarly-scoped clauses hits — e.g. four clauses all repeating
// `scope:org: ['${{ self.scope.org }}']`). Mutually exclusive with
// `dataScope` on the SAME clause (this schema's own `.superRefine` below) — never
// both, and expanded to a literal `dataScope` (the ref itself never survives)
// by {@link expandDataScopeRefs} before `parseBlueprint` returns, so nothing
// downstream — `@vectros-ai/cli`'s loader, the wire payload it sends to
// `createRole` — ever sees a `dataScopeRef`. `lintDataScopeRefs` (below)
// checks the name resolves against a declared `fragments` entry.
const BlueprintRoleClauseSchema = z
  .object({
    allowedActions: z.array(safeDisplayString(z.string().min(1))).min(1),
    dataScope: z.record(z.array(z.union([safeDisplayString(z.string().min(1)), z.null()]))).optional(),
    dataScopeRef: z.string().min(1).optional(),
    capabilities: GrantedCapabilitiesSchema,
    assignableRoles: AssignableRolesSchema,
  })
  .strict()
  .superRefine((c, ctx) => {
    if (c.dataScope !== undefined && c.dataScopeRef !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['dataScopeRef'],
        message:
          "a clause may declare 'dataScope' OR 'dataScopeRef', not both — dataScopeRef is sugar for " +
          "an inline dataScope fragment, so the two are alternatives for the same slot, not additive",
      });
    }
  });

// A fragment is exactly a `dataScope` map (same shape,
// same key/value grammar — `lintDataScopeKeys`/`lintSelfTokenPlacement` below
// cover it identically to `roles[].dataScope`), named once at the top level
// and referenced from any clause via `dataScopeRef: <name>`. Purely a local
// authoring convenience: it is never sent anywhere, never itself a
// provisioned resource (absent from `BLUEPRINT_FIELD_PHASES`), and does not
// survive `parseBlueprint` as a live reference — only as expanded literals.
const BlueprintFragmentsSchema = z.record(
  z.record(z.array(z.union([safeDisplayString(z.string().min(1)), z.null()]))),
);

// Optional top-level `roles`: a map of roleId → ordered clauses. Authored in the
// blueprint and bound to principals via `vectros access grant --role <id>`.
// DISTINCT from `accessProfile` (the least-privilege scope the bootstrap mints
// for the blueprint's own service-principal key). Roles are identity-agnostic,
// reusable, multi-clause rules (architecture §6).
//
// The KEY (roleId) is safeDisplayString'd via the two-argument `z.record(keySchema,
// valueSchema)` form: `buildPlan`'s role step renders roleId raw (`role '${roleId}' (...)`),
// and every OTHER string leaf in this file got
// the forgery-character guard via `safeDisplayString` wrapping a VALUE; a map KEY is the one
// shape that pattern doesn't reach, since `safeDisplayString` wraps a `ZodString`, not a
// `ZodRecord`'s key type. `z.record`'s two-arg form takes exactly that: a key schema, validated
// the same way a value would be, reporting the key itself in `.path`.
const BlueprintRolesSchema = z.record(safeDisplayString(z.string().min(1)), z.array(BlueprintRoleClauseSchema).min(1));

// A role-level `assumable` grant map: the
// `POST /v1/auth/token/assume` entitlement the platform's role create/update
// request and response already carry server-side, wired through blueprint
// authoring here for the first time. Deliberately NARROWER than `dataScope`'s
// grammar (`lintRoleAssumable` below, mirroring the platform's own
// authoring-time grammar check for this field): every KEY must be a
// `scope:<namespace>` — the principal (`userId`) can NEVER be named, unlike
// `dataScope`, where it is the one non-namespaced key allowed — and no value
// may be `null` (assumable has no tenant-level/owner-less reading to opt
// into; `/assume` always requests one concrete value).
const BlueprintRoleAssumableSchema = z.record(z.array(safeDisplayString(z.string().min(1))).min(1));

// `roleAssumable` is a SEPARATE top-level map (roleId →
// grant), not a field folded into a `roles[roleId]` entry. Deliberate: a
// role's wire shape has always been a bare clause array, and `assumable` is
// role-LEVEL (a sibling of the clause list on `RoleRequest`, per that DTO's
// own doc), not a clause field — folding it in would force `roles[roleId]`
// into a `{ clauses, assumable }` object for every author and every existing
// TypeScript consumer indexing it directly, a real breaking change for a
// feature meant to be purely additive (mirrors `dataScopeRef`'s own
// top-level-map-plus-reference shape, just keyed by roleId instead of a
// fragment name — `lintRoleAssumable` below is this field's twin of
// `lintDataScopeRefs`, checking every key names a DECLARED role).
const BlueprintRoleAssumableMapSchema = z.record(BlueprintRoleAssumableSchema);

// The blueprint-authoring surface for an async trigger rule: "when a schema record fires this
// event, invoke this script version under this grant/manifest." The rule FIRES: a matching record
// write on a `triggersEnabled` schema dispatches the script asynchronously, under the grant declared
// here, so this clause is live authority rather than a dormant declaration.
//
// `schemaName` is the schema's declared `typeName` — the blueprint author writes the NAME, not a
// platform-assigned id, the same self-reference pattern `seed[].typeName` already uses
// (`lintTriggerFiringSourceSchemas` below resolves it against this SAME blueprint's `schemas`; the
// CLI loader resolves the name to a schemaId at apply time, mirroring how a schema reference already
// works — see `TriggerRuleRequest.FiringSourceRequest` server-side, which takes the resolved id).
const BlueprintTriggerFiringSourceSchema = z
  .object({
    schemaName: z.string().min(1),
    event: z.enum(['CREATE', 'UPDATE', 'DELETE']),
  })
  .strict();

// A trigger's script reference — `version` is either a pinned decimal-integer string (the default,
// auditable-forever shape) or the literal 'latest' (the floating opt-in, resolved at FIRE time;
// declare-time only checks the script NAME has at least one version).
const SCRIPT_VERSION_INTEGER_RE = /^[1-9][0-9]*$/;
const BlueprintTriggerScriptRefSchema = z
  .object({
    // safeDisplayString: rendered raw into buildPlan's trigger step (`${scriptRef.name}@...`).
    // When naming a script THIS blueprint ships, `name` is transitively safe already (it must
    // equal a `scripts` map key, itself grammar-pinned by SCRIPT_NAME_RE) — but a scriptRef
    // naming a script this blueprint does NOT ship is, by design, "entirely unrestricted" (see
    // this file's own doc on that case), so the wrap is load-bearing for exactly that path.
    name: safeDisplayString(z.string().min(1)),
    version: z.string().min(1),
  })
  .strict()
  .superRefine((ref, ctx) => {
    if (ref.version !== 'latest' && !SCRIPT_VERSION_INTEGER_RE.test(ref.version)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['version'],
        message:
          `scriptRef.version '${ref.version}' is invalid — must be a positive decimal integer ` +
          "(as a string, e.g. '3') or the literal 'latest'",
      });
    }
  });

// A trigger's operation manifest — declared and shape-validated here, and ENFORCED AT EXECUTION by
// the platform: a host-object verb outside the manifest is refused even where the grant would permit
// it, and the execution is recorded as a manifest violation. (This comment said "NOT ENFORCED until
// a dispatcher exists" while that was true; dispatch and manifest enforcement both ship as of the
// release that made triggers fire.)
//
// SHAPE-only validation here, the same posture `capabilities` (GrantedCapabilitiesSchema, above)
// already takes in this package: this FORMAT package does not hold the platform's live host-object
// verb catalog, so a well-formed but not-yet-recognized verb parses without error here rather than
// going stale against a platform release this package doesn't track. The platform rejects an
// unrecognized verb at declare time and names the set it accepts.
const MANIFEST_VERB_RE = /^[a-z]+(?:\.[a-z]+)+$/;
const BlueprintTriggerManifestSchema = z
  .array(
    z.string().min(1).regex(MANIFEST_VERB_RE, {
      message: "a manifest entry must be '<noun>.<verb>' (e.g. 'records.update')",
    }),
  )
  .optional();

// A single trigger declaration. Grant is XOR — exactly one of `roleIds` (role composition) or an
// inline clause (`allowedActions`, optionally `dataScope`/`capabilities`) — mirroring
// `BlueprintAccessProfileSchema`'s XOR above byte-for-byte: a trigger's grant reuses the exact same
// platform shape an access profile's `roleIds`/`scopes` XOR already uses, rather than a bespoke
// grant syntax, so the authoring surface mirrors it too.
const BlueprintTriggerEntrySchema = z
  .object({
    firingSource: BlueprintTriggerFiringSourceSchema,
    scriptRef: BlueprintTriggerScriptRefSchema,
    allowedActions: z.array(safeDisplayString(z.string().min(1))).min(1).optional(),
    roleIds: z.array(z.string().min(1)).min(1).optional(),
    dataScope: z.record(z.array(z.union([safeDisplayString(z.string().min(1)), z.null()]))).optional(),
    capabilities: GrantedCapabilitiesSchema,
    manifest: BlueprintTriggerManifestSchema,
    /**
     * REQUIRED. The record fields this rule projects into its script's `input.record` — and, on an
     * UPDATE firing, `input.previous` (the same fields as they were before the write). On a DELETE
     * firing `input.record` carries these fields from the deleted row, which is the only way a
     * script can see anything of it.
     *
     * **An empty list is the "I project nothing" declaration**, not an omission: the script still
     * receives `input.recordId`. It is required rather than defaulted precisely so that projecting
     * nothing is something an author STATES, not something they get by forgetting the field.
     *
     * Every entry must name a field the schema keeps INLINE — declared `inline: true`, or
     * `filterable`, or used as a lookup field (a leg of one, or its `sortBy` target) — and never one
     * marked `sensitive`.
     * `lintTriggerFields` checks that against the schema this blueprint declares; the platform
     * checks it again, and refuses a schema update that would un-inline a field a live rule still
     * projects.
     *
     * A field the record does not carry arrives as `undefined`, never null. `record` and `previous`
     * together are capped at 224 KB serialised — a firing whose projected input exceeds that is not
     * run, and is recorded as an `INPUT_TOO_LARGE` failure naming the size.
     */
    fields: z.array(safeDisplayString(z.string().min(1))),
  })
  .strict()
  .superRefine((entry, ctx) => {
    const hasInline = entry.allowedActions !== undefined;
    const hasRoleIds = entry.roleIds !== undefined;
    if (hasInline === hasRoleIds) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['roleIds'],
        message: hasInline
          ? "a trigger entry carries both 'allowedActions' and 'roleIds' — provide exactly one: an " +
            "inline clause (allowedActions, optionally dataScope/capabilities) OR a role composition " +
            "(roleIds), never both"
          : "a trigger entry carries neither 'allowedActions' nor 'roleIds' — provide exactly one: an " +
            "inline clause (allowedActions, optionally dataScope/capabilities) OR a role composition " +
            "(roleIds)",
      });
      return;
    }
    // A roleIds-composed entry has no inline clause to hang a dataScope/capability grant on — same
    // reasoning as BlueprintAccessProfileSchema's identical carve-out above.
    if (hasRoleIds) {
      if (entry.dataScope !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['dataScope'],
          message:
            "a trigger entry's dataScope is not valid alongside 'roleIds' — a role-composed entry has " +
            "no inline clause of its own; author dataScope on the referenced role's clause instead",
        });
      }
      if (entry.capabilities !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['capabilities'],
          message:
            "a trigger entry's capabilities is not valid alongside 'roleIds' — a role-composed entry " +
            "has no inline clause of its own; author capabilities on the referenced role's clause instead",
        });
      }
    }
  });

// Optional top-level `triggers`: a map of triggerName -> declaration. Applied
// in-context (the same phase as roles/accessProfile — see BLUEPRINT_FIELD_PHASES below). Shaped
// like `BlueprintRolesSchema` above (a top-level record keyed by name), but each VALUE is a single
// declaration object, not a clause array — a trigger has exactly one firing rule, not a list of
// alternative ones.
//
// The KEY (triggerName) is safeDisplayString'd for the same reason `BlueprintRolesSchema`'s
// roleId key is, just above: `buildPlan`'s trigger steps render it raw (`trigger '${triggerName}'
// ...`), AND it is concatenated into a synthesized principal name sent to the platform
// (`${blueprint.name}-trigger-${triggerName}`) — a second, non-display reason this key must be clean.
const BlueprintTriggersSchema = z.record(safeDisplayString(z.string().min(1)), BlueprintTriggerEntrySchema);

// ---------------------------------------------------------------------------
// `scripts` — the source a blueprint SHIPS, as opposed to the `scriptRef` a
// trigger merely NAMES.
// ---------------------------------------------------------------------------
//
// A trigger's `scriptRef` is a pure reference: it names a script that must already exist in the
// target context, and the platform validates that AT DECLARE TIME (a rule naming a script with no
// versions is refused with a 400). Without this block a blueprint could name a script it had no way
// to ship, so the documented adoption flow broke in the middle — declare the rule here, drop to the
// raw API to create the script it runs, come back.
//
// WHAT AN ENTRY DECLARES, AND WHAT IT DELIBERATELY DOES NOT. A script is versioned and IMMUTABLE per
// version: the platform assigns `scriptVersion` itself, auto-incrementing from 1 on every push, and
// there is no update surface. So an entry declares a name (the map key) and the CURRENT SOURCE for
// that name — never a version number, which is not the author's to choose.
//
// SOURCE IS INLINE, NOT A PATH, AND THAT IS A SECURITY PROPERTY RATHER THAN A LIMITATION. A shipped
// script runs under a trigger's declared grant, so it is live authority; a blueprint is a versioned,
// REVIEWED bundle. Keeping the source inside the bundle keeps what runs inside what was reviewed —
// a path indirection would let a blueprint pull in code the reviewer of this file never saw. (It is
// also what lets this package stay filesystem-free, which it must: it is a pure format + validation
// library, and its own bundled blueprints are objects with no file to resolve a path against.)
const SCRIPT_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
// Both caps are the platform's own, in UTF-8 BYTES — measured with TextEncoder rather than
// `.max()`, which counts UTF-16 code units and would let a multi-byte source past a byte limit.
const SCRIPT_SOURCE_MAX_BYTES = 300_000;
const SCRIPT_INPUT_CONTRACT_MAX_BYTES = 50_000;

const utf8Bytes = (s: string): number => new TextEncoder().encode(s).length;

const BlueprintScriptEntrySchema = z
  .object({
    /**
     * The script's source text, shipped verbatim.
     *
     * NOTHING PARSES THIS — not this package, and not the platform, which stores it as-is. A syntax
     * error is therefore invisible until the version first RUNS, where it surfaces as a
     * `SCRIPT_ERROR` from the trigger rule that dispatched it. Validation here is limited to what
     * can be checked without a JS parser: non-blank, and within the platform's byte cap.
     */
    source: z
      .string()
      // No `.min(1)` in front of this: it would ALSO fire on '', so an empty source reported two
      // issues for one mistake. The blank check subsumes it and says the more useful thing.
      .refine((s) => s.trim().length > 0, { message: "'source' must not be blank" })
      .refine((s) => utf8Bytes(s) <= SCRIPT_SOURCE_MAX_BYTES, {
        message:
          `'source' exceeds the platform's ${SCRIPT_SOURCE_MAX_BYTES.toLocaleString('en-US')}-byte ` +
          'cap (measured in UTF-8 bytes, not characters)',
      }),
    /**
     * Optional free-text description of the input shape this script expects.
     *
     * DESCRIPTIVE ONLY — neither this package nor the platform validates a firing's input against
     * it. It documents the contract for a human reading the blueprint; it does not enforce one.
     */
    declaredInputContract: z
      .string()
      .min(1)
      .refine((s) => utf8Bytes(s) <= SCRIPT_INPUT_CONTRACT_MAX_BYTES, {
        message:
          `'declaredInputContract' exceeds the platform's ` +
          `${SCRIPT_INPUT_CONTRACT_MAX_BYTES.toLocaleString('en-US')}-byte cap (measured in UTF-8 ` +
          'bytes, not characters)',
      })
      .optional(),
  })
  .strict();

// Optional top-level `scripts`: a map of scriptName -> declaration, keyed by name exactly as
// `triggers` and `roles` are. Applied IN-CONTEXT and, critically, BEFORE the triggers that may
// reference it — see BLUEPRINT_FIELD_PHASES and the loader's own ordering note.
const BlueprintScriptsSchema = z.record(BlueprintScriptEntrySchema);

// A namespace name: a lowercase letter first, then lowercase letters,
// digits, `_` or `-`, 2-32 chars — mirrors the platform's own namespace-
// registry grammar. The fixed surfaces are not namespaces and can never be
// entity kinds.
const IDENTITY_NAMESPACE_RE = /^[a-z][a-z0-9_-]{1,31}$/;
const FORBIDDEN_IDENTITY_NAMESPACES = new Set(['record', 'document', 'entity', 'user']);

// A declared identity's `kind`: the fixed `user` surface, OR an entity namespace
// (`org`/`client` — reserved, not built-in — or one you registered). Orgs and clients fold into
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
    // safeDisplayString: `@vectros-ai/cli`'s `runBootstrapCli` and `blueprint plan` both print
    // this RAW to stdout ("~ <name> (<kind>) — external id '<externalId>'"), immediately before
    // the "Apply this plan? [y/N]" confirmation gate itself — the highest-severity gap found in
    // this pass, since it sits at the confirmation prompt's own disclosure text, not merely
    // somewhere upstream of it. `displayName` is wrapped too though not currently
    // rendered in any preview (defense-in-depth, matching this file's practice for its adjacent
    // sibling fields) — it does reach a platform API payload as an entity's `name`.
    externalId: safeDisplayString(z.string().min(1)),
    displayName: safeDisplayString(z.string().min(1)).optional(),
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
    externalId: safeDisplayString(z.string().min(1)),
    displayName: safeDisplayString(z.string().min(1)),
  })
  .strict();

// issuerId grammar mirrors the platform's stored issuer-key format (SDK
// `IssuerRequest.issuerId` doc: "3-31 characters, a lowercase letter first, then
// lowercase letters, digits, or hyphens") — identical to CONTEXT_ID_RE, reused
// rather than duplicated.
const ISSUER_ID_RE = CONTEXT_ID_RE;

/**
 * A lowercase ASCII DNS name with at least two labels, each 1-63 characters of letters, digits and
 * dashes (no leading/trailing dash), at most 253 characters overall.
 *
 * A POSITIVE grammar, for the same reason `safeUrlString` is one: a domain is read and trusted by the
 * human approving a plan, and only a "must be plain ASCII" rule — not a blocklist — closes a
 * look-alike (Cyrillic/Greek) domain. Lowercase-only because the platform stores the lowercased form
 * and compares a token's `hd` claim against it, so accepting `Acme.com` would show the reviewer text
 * that is not what gets scoped.
 */
const RESTRICTED_DOMAIN_RE = /^(?=.{3,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/**
 * Whether `value` is a lowercase ASCII DNS name of the shape a blueprint's `restrictedToDomain`
 * accepts. Exported so a tool that takes the same value from another place (the CLI's
 * `--restricted-to-domain` flag) validates with THIS grammar rather than a copy that can drift.
 * Case is the caller's concern: lowercase a mixed-case input before asking.
 */
export function isRestrictedToDomainName(value: string): boolean {
  return RESTRICTED_DOMAIN_RE.test(value);
}

/**
 * Structural bounds on a captured/projected identity-claim NAME list, transcribed from the
 * platform's own captured-claim count and name-length limits.
 *
 * Duplicated here (rather than inferred) for the same reason every other grammar in this file is:
 * the blueprint is validated at AUTHORING time, offline, with no platform round trip — so a bound
 * the platform enforces has to be re-stated to be caught before apply time. Keep in lockstep with the
 * platform; a divergence surfaces as a blueprint that lints clean and then 400s at apply, which is
 * precisely what authoring-time validation exists to prevent.
 */
const MAX_CAPTURED_CLAIMS = 20;
const MAX_CAPTURED_CLAIM_NAME_LENGTH = 64;

/**
 * A `superRefine` that rejects a repeated claim name, reporting the SECOND occurrence's own index so
 * the message points at the entry the author should delete rather than at the list as a whole.
 *
 * The platform rejects duplicates rather than deduplicating them, and this mirrors that: a repeated
 * name is never unsafe (two loop iterations resolve the same map key), but it is a caller-visible
 * sign the declaration does not mean what its author thinks. Shared by `issuers[].capturedClaims`
 * and the top-level `identityProjectionClaims`, which have the identical rule.
 */
function assertNoDuplicateClaimNames(field: string) {
  return (claims: readonly string[] | undefined, ctx: z.RefinementCtx): void => {
    if (!claims) return;
    const seen = new Set<string>();
    claims.forEach((name, i) => {
      if (seen.has(name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [i],
          message: `${field} repeats '${name}' — each claim name may appear only once`,
        });
      }
      seen.add(name);
    });
  };
}

// A trusted third-party IdP issuer, registered in the blueprint's BOOTSTRAP-token
// phase — alongside app-context/service-principal creation, NOT folded into the
// in-context load with schemas/accessProfile/roles. Tenant-wide provisioning
// config: needs the bootstrap credential's owner-only `provisioning:c`, the same
// gate the app-context create itself requires, never an ordinary partner-grantable
// scope. Shape mirrors the SDK's `IssuerRequest` 1:1 so the loader forwards it
// without a transform.
const BlueprintIssuerSchema = z
  .object({
    /** Short slug identifying this issuer within your account. Immutable once registered. */
    issuerId: z.string().regex(ISSUER_ID_RE, {
      message:
        "issuerId must be 3-31 chars, start with a lowercase letter, then lowercase letters/digits/dashes (e.g. 'auth0-prod')",
    }),
    /**
     * The IdP's `iss` claim value, exactly as it appears in tokens it issues. `safeUrlString`,
     * not `safeDisplayString`: this is the trust-anchor field the plan preview exists to
     * disclose, so it gets the stronger positive check (see that function's own doc) rather
     * than the blocklist every OTHER free-text field uses — a homoglyph host here is exactly
     * what an operator approving a plan must be able to trust reading. Virtually every real
     * OIDC issuer is URL-shaped in practice, even though the spec does not strictly require it.
     */
    issuer: safeUrlString(z.string().min(1)),
    /** The IdP's remote JWKS endpoint, used to verify presented tokens' signatures. `safeUrlString` — see `issuer`'s own comment just above. */
    jwksUri: safeUrlString(z.string().min(1)),
    /**
     * The `aud` claim value a presented subject_token must carry. Must be globally
     * unique in combination with `issuer` — use a distinct audience per
     * environment/context sharing one IdP account (most OIDC providers support
     * this as an ordinary per-API/application default).
     */
    audience: z.string().min(1),
    /**
     * Which app context an exchanged token targets. **Must equal the blueprint's own
     * `contextId`** — an issuer is a trust anchor, so a blueprint may only attach one to the
     * context it actually provisions. One IdP account serving several contexts needs one entry
     * per context, each in that context's own blueprint.
     */
    contextId: z.string().regex(CONTEXT_ID_RE, {
      message:
        "contextId must be 3-31 chars, start with a lowercase letter, then lowercase letters/digits/dashes (e.g. 'casework')",
    }),
    /** The claim carrying the subject identifier. Platform defaults to 'sub' when omitted. */
    subClaim: z.string().min(1).optional(),
    /** The claim carrying the subject's email (first-login invite matching). Platform defaults to 'email' when omitted. */
    emailClaim: z.string().min(1).optional(),
    /**
     * The IdP's OIDC userinfo endpoint. Optional. Presented tokens are access tokens, which under
     * OIDC don't carry `email` unless the IdP was specifically configured to add it — if
     * `emailClaim` misses on the presented token, and `userinfoUri` is configured, Vectros falls
     * back to calling this endpoint (with the presented token as the bearer credential) and reads
     * `emailClaim` from its JSON response instead. Omit to leave the fallback disabled.
     */
    // `safeUrlString` — see `issuer`'s own comment above for why these three trust-anchor
    // fields get the stronger positive check instead of `safeDisplayString`'s blocklist.
    userinfoUri: safeUrlString(z.string().min(1)).optional(),
    /**
     * Opt-in domain scope: a domain ALREADY VERIFIED for your account (verified once, by the
     * account owner, in the developer portal). The registration's `(issuer, audience)` uniqueness
     * is then scoped to that domain, so an unrelated registration of the same pair never blocks
     * it, and a presented token matches only when its `hd` claim equals the domain (Google
     * Workspace emits `hd` natively; other identity providers need a claims-mapping rule that
     * emits a claim named exactly `hd`). A token with no matching `hd` claim is not matched at all,
     * so scoping an issuer that already has users signing in without one locks those users out.
     *
     * Written the way the platform stores it: a lowercase, ASCII DNS name (`acme.com`), never a URL.
     * An internationalized domain must be given in its punycode (`xn--…`) form, the same rule
     * `issuer` follows, so what an operator reads in the plan preview is the domain that is
     * actually scoped. An unverified domain fails the apply with the platform's `400`.
     *
     * Omit to register a domain-less issuer. Omitting it on a re-apply leaves an existing scope
     * unchanged; removing a scope is `vectros issuers update --clear-restricted-to-domain`.
     */
    restrictedToDomain: z
      .string()
      .regex(RESTRICTED_DOMAIN_RE, {
        message:
          "restrictedToDomain must be a lowercase DNS name such as 'acme.com' — letters, digits and dashes " +
          'in dot-separated labels, at least two labels, no scheme, path, port or uppercase; write an ' +
          'internationalized domain in its punycode (xn--…) form',
      })
      .optional(),
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
    /**
     * Opt-in ADDITIONAL identity-claim capture: OIDC claim names — beyond `emailClaim`, which keeps
     * its own dedicated field — read from this issuer's tokens on every successful token exchange
     * and stored as your tenant's golden IdP-asserted identity copy for the signed-in user.
     *
     * Deliberately NOT a fixed set: name whatever claims your IdP actually asserts (standard ones
     * like `name`/`phone_number`, or your provider's own custom claims). Each name is read from the
     * verified token first, falling back to `userinfoUri` (when configured) only for names still
     * missing after that — so a claim your IdP puts only on the userinfo response still resolves,
     * provided you configured that endpoint.
     *
     * Omit entirely to capture nothing beyond email (the default, and the behaviour of every
     * registration authored before this field existed). Capped at 20 entries, each a non-blank name
     * of at most 64 characters; a duplicate is REJECTED rather than silently deduplicated, because a
     * repeated name is a sign the declaration does not mean what its author thinks.
     *
     * Pairs with the top-level `identityProjectionClaims`, which decides which of these captured
     * names are then projected onto access profiles in this context — capture and projection are
     * separate opt-ins, and capturing a claim does not by itself expose it on a profile.
     */
    capturedClaims: z
      .array(
        // `safeDisplayString` (a `.refine`) then the blank-name `.refine` — both ordered AFTER
        // `.max`, since `.refine` returns a ZodEffects, which has no `.max` (`.refine` itself
        // chains fine onto a ZodEffects — it's on the ZodType base, not ZodString-specific).
        // `.min(1)` would be a LENGTH check and would admit a whitespace-only name while the
        // message claims "non-blank"; the platform rejects on isBlank(). Note the value is
        // REJECTED, not trimmed — it reaches the wire exactly as authored, matching how the
        // platform stores it.
        safeDisplayString(
          z.string().max(MAX_CAPTURED_CLAIM_NAME_LENGTH, {
            message: `a capturedClaims entry must be at most ${MAX_CAPTURED_CLAIM_NAME_LENGTH} characters`,
          }),
        ).refine((name) => name.trim().length > 0, {
          message: 'a capturedClaims entry must be a non-blank OIDC claim name',
        }),
      )
      .max(MAX_CAPTURED_CLAIMS, {
        message: `capturedClaims accepts at most ${MAX_CAPTURED_CLAIMS} entries`,
      })
      .optional()
      .superRefine(assertNoDuplicateClaimNames('capturedClaims')),
  })
  .strict();

/**
 * A namespace this blueprint needs REGISTERED before anything can reference it
 * via `scope:<namespace>`, use it as a `dataScope`/`identityOverrides` key, or
 * create entities in it. Closely mirrors the platform's own `NamespaceRequest`
 * wire shape (0.40.0's namespace-registration change) — see that endpoint's
 * own docs for the full semantics; this is authoring-time validation only.
 *
 * `org`/`client` are reserved namespace names, not built-ins — registered
 * the same way as any other name, with no permanent exclusion. A
 * context-owned `org` registration is exactly as valid as a context-owned
 * `team` registration. They DO already exist tenant-wide in every account
 * (`specificityRank` 1000/2000, below) — a context-owned registration of
 * either needs a different rank, and shadows the tenant-wide one for this
 * context's own callers.
 *
 * **Registered OWNED by this blueprint's own `contextId` by default** — a
 * blueprint applies under the CLI's bootstrap credential, and the platform's
 * namespace-registration endpoint confines an ordinary request to its own
 * context unconditionally (the same confinement issuer registration already
 * has: an untrusted blueprint's declared namespace must land only in the
 * context IT provisions, never elsewhere in the tenant, unless it opts in
 * below to something visible tenant-wide).
 *
 * `tenantWide: true` opts a namespace OUT of that per-context confinement,
 * requesting the platform's own `NamespaceRequest` tenant-wide form instead
 * (an omitted `contextId` on the wire — see the CLI loader). This is a
 * DELIBERATE, narrow escape hatch, not the default: it requires the applying
 * credential to hold a capability granted only to an account OWNER (never a
 * blueprint's own say-so), and the CLI additionally refuses to request it at
 * all unless invoked with an explicit opt-in flag — a blueprint declaring
 * `tenantWide: true` cannot silently create a namespace visible to every
 * context in the tenant. A namespace-name collision with another blueprint's
 * (or a manual) tenant-wide registration is a hard failure, never a silent
 * adopt — a tenant-wide row is co-owned by no single blueprint, so quietly
 * treating an existing one as "this blueprint's" would subject this
 * blueprint's entities to whichever registration got there first, untested
 * and unreviewed. See the CLI's `--allow-tenant-wide-namespaces` flag for the
 * full mechanism.
 *
 * Applied in the BOOTSTRAP-token phase (same as `issuers` — registration
 * requires the platform's `provisioning:c` capability, which only the
 * bootstrap credential carries; see the CLI loader), before schemas/seed,
 * since an `entityBacked` namespace's entities and an `allowedSurfaces:
 * ['entity']` schema both need the registration to already exist.
 */
const BlueprintNamespaceSchema = z
  .object({
    /** The namespace to register — same grammar as a `scope:<namespace>` key. */
    namespace: z.string().min(1),
    /**
     * When `true`, every value in this namespace must resolve to an existing
     * identity entity (create via `entities:c` at the in-context phase, or a
     * declared `identities:` entry). When `false`/omitted, values are
     * free-form strings validated by grammar only.
     */
    entityBacked: z.boolean().optional(),
    /**
     * Request the platform's TENANT-WIDE registration form instead of this
     * blueprint's own context — visible to every context in the account, not
     * just the one this blueprint provisions. `false`/omitted (the default)
     * is the ordinary, context-owned registration every other namespace here
     * gets. Mutually exclusive with any future context-targeting field this
     * schema may grow — there is exactly one way to say "not my own context"
     * today.
     *
     * A blueprint declaring this does NOT get it automatically: the applying
     * credential must separately hold a platform capability granted only to
     * an account OWNER, and the CLI refuses to even request it unless
     * explicitly told to (see `--allow-tenant-wide-namespaces`) — no flag,
     * no request, regardless of what this field says. Setting this to `true`
     * states the blueprint's INTENT; it is not, on its own, a grant of
     * anything.
     */
    tenantWide: z.boolean().optional(),
    /**
     * This namespace's position in your account's specificity order (used to
     * break a tie when a caller holds two scope dimensions at once). Required
     * by the platform on registration; MUST be unique across every namespace
     * in the account, including `org` (1000) and `client` (2000) — pick a
     * value outside that pair, and outside any other namespace this same
     * account might register (its own, or another blueprint's).
     */
    specificityRank: z.number().int().min(0).max(1_000_000),
    /**
     * Optional membership backing — declares which record type + field hold
     * grants of THIS namespace's values. Supply together with
     * `membershipTargetField`, or omit both. Declaring this grants nobody
     * anything on its own: a role opts in explicitly with
     * `${{ member.scope.<namespace> }}` in its `dataScope`.
     */
    membershipRecordType: z.string().min(1).optional(),
    /** The field on `membershipRecordType` naming the user a grant is FOR. Required alongside `membershipRecordType`. */
    membershipTargetField: z.string().min(1).optional(),
    /**
     * The field on `membershipRecordType` naming a grant's LEVEL, so the same
     * user can hold different levels in different values of this namespace.
     * Supply together with `membershipLevels`, or omit both for plain
     * in-or-out membership.
     */
    membershipLevelField: z.string().min(1).optional(),
    /** The complete set of level labels this namespace allows. Required alongside `membershipLevelField`. */
    membershipLevels: z.array(z.string().min(1)).optional(),
  })
  .strict();

/**
 * `namespaces[]` validation: grammar (mirrors `scopeNamespaceGrammarError`,
 * the same table `dataScope`/`identityOverrides` keys are checked against
 * below — one grammar, not a second copy; `org`/`client` are reserved
 * names, not built-ins, checked the same as any other), the membership field
 * co-occurrence rules the platform's own `NamespaceRequest` documents,
 * `specificityRank` uniqueness WITHIN this blueprint (a partial check — the
 * platform is the only party that can see the rest of the account's
 * namespaces, including `org`=1000/`client`=2000 IF the account has actually
 * registered them (the platform does not auto-provision org/client at
 * signup — those ranks are only taken once an account explicitly registers
 * them), so a collision with those or another blueprint's registration still
 * surfaces at apply, same as the platform's own non-idempotent-registration
 * collision), and `namespace` uniqueness within this blueprint's own list.
 */
/** The platform's own DDB-key-embeddable identifier grammar — 1-64 chars, letters/digits/underscore/hyphen. */
const MEMBERSHIP_FIELD_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;

function lintNamespaces(value: unknown, ctx: z.RefinementCtx): void {
  if (!value || typeof value !== 'object' || !('namespaces' in value)) return;
  const namespaces = (value as { namespaces?: unknown }).namespaces;
  if (!Array.isArray(namespaces)) return;
  // For the membershipRecordType-names-an-own-schema check below — the ONE
  // case a blueprint's namespaces[] can act on data it did not itself bring:
  // membership resolution reads whatever record type is named here, and
  // that record type's OWNER (whether created by this blueprint or already
  // present in the target context) is never re-derived — it is the pack's
  // say-so alone. Requiring the type to be one of THIS blueprint's own
  // schemas keeps the reach bounded to what the blueprint ships, the same
  // "never mint on the pack's say-so alone" principle scope-gate.ts's
  // KNOWN_CONTROL_PLANE_RESOURCES note draws for this same feature.
  const rawSchemas = (value as { schemas?: unknown }).schemas;
  const declaredSchemaTypes = new Set(
    (Array.isArray(rawSchemas) ? rawSchemas : [])
      .map((s: unknown) => (s && typeof s === 'object' && 'typeName' in s ? (s as { typeName: unknown }).typeName : undefined))
      .filter((t): t is string => typeof t === 'string'),
  );
  const seenNames = new Set<string>();
  const seenRanks = new Map<number, number>();
  namespaces.forEach((entry, i) => {
    if (!entry || typeof entry !== 'object') return;
    const ns = entry as {
      namespace?: unknown;
      specificityRank?: unknown;
      membershipRecordType?: unknown;
      membershipTargetField?: unknown;
      membershipLevelField?: unknown;
      membershipLevels?: unknown;
    };
    const path = ['namespaces', i] as const;
    if (typeof ns.namespace === 'string') {
      const err = scopeNamespaceGrammarError(ns.namespace);
      if (err) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [...path, 'namespace'], message: err });
      if (seenNames.has(ns.namespace)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [...path, 'namespace'],
          message: `'${ns.namespace}' is declared more than once in namespaces[]`,
        });
      }
      seenNames.add(ns.namespace);
    }
    if (typeof ns.specificityRank === 'number') {
      const prior = seenRanks.get(ns.specificityRank);
      if (prior !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [...path, 'specificityRank'],
          message: `specificityRank ${ns.specificityRank} is already used by namespaces[${prior}] — every namespace's rank must be unique`,
        });
      }
      seenRanks.set(ns.specificityRank, i);
    }
    const hasRecordType = ns.membershipRecordType !== undefined;
    const hasTargetField = ns.membershipTargetField !== undefined;
    if (hasRecordType !== hasTargetField) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...path, 'membershipRecordType'],
        message: 'membershipRecordType and membershipTargetField must be declared together, or neither',
      });
    }
    if (typeof ns.membershipRecordType === 'string' && !declaredSchemaTypes.has(ns.membershipRecordType)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...path, 'membershipRecordType'],
        message:
          `membershipRecordType '${ns.membershipRecordType}' must name a typeName this blueprint declares in ` +
          `schemas[] — a namespace's membership can only resolve over a record type the blueprint itself ships, ` +
          `never a type that merely happens to already exist in the target context.`,
      });
    }
    // membershipRecordType/membershipTargetField/membershipLevelField are each
    // validated by the platform as a DDB-key-embeddable identifier (1-64 chars,
    // letters/digits/underscore/hyphen) — the same grammar a schema fieldId or
    // lookup fieldName uses, distinct from a namespace/level's own grammar. Not
    // checking this client-side is the same "lints clean, 400s at apply" class
    // the rest of this function exists to prevent.
    for (const [field, value] of [
      ['membershipRecordType', ns.membershipRecordType],
      ['membershipTargetField', ns.membershipTargetField],
      ['membershipLevelField', ns.membershipLevelField],
    ] as const) {
      if (typeof value === 'string' && !MEMBERSHIP_FIELD_NAME_RE.test(value)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [...path, field],
          message: `${field} '${value}' is invalid — must be 1-64 characters of letters, digits, underscores, or hyphens`,
        });
      }
    }
    const hasLevelField = ns.membershipLevelField !== undefined;
    // Matches the platform's own definition exactly (levels != null &&
    // !levels.isEmpty()) — an EMPTY array is "no levels declared", the same
    // as omitting the key entirely, not "levels declared, zero of them".
    // `!== undefined` alone disagreed: `{ membershipLevelField: 'x',
    // membershipLevels: [] }` linted clean (both "present") but 400'd at
    // apply (the platform's all-or-nothing check saw the field with no
    // labels) — exactly the "lints clean, fails at apply" class this rule
    // exists to prevent.
    const hasLevels = Array.isArray(ns.membershipLevels) && ns.membershipLevels.length > 0;
    if (hasLevelField !== hasLevels) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...path, 'membershipLevelField'],
        message: 'membershipLevelField and a non-empty membershipLevels must be declared together, or neither',
      });
    }
    if ((hasLevelField || hasLevels) && !hasRecordType) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...path, 'membershipLevelField'],
        message: 'membershipLevelField/membershipLevels require membershipRecordType + membershipTargetField too',
      });
    }
    if (Array.isArray(ns.membershipLevels)) {
      const seenLevels = new Set<string>();
      for (const level of ns.membershipLevels) {
        if (typeof level !== 'string') continue;
        const err = scopeNamespaceGrammarError(level);
        if (err) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [...path, 'membershipLevels'],
            message: `level '${level}': ${err}`,
          });
        } else if (seenLevels.has(level)) {
          // Matches the platform's own duplicate-level rejection.
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [...path, 'membershipLevels'],
            message: `membershipLevels contains '${level}' twice`,
          });
        }
        seenLevels.add(level);
      }
    }
  });
}

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
  /**
   * The schema typeName this seed instantiates (should match a declared schema).
   * `safeDisplayString`, matching `BlueprintSchemaSchema.typeName`: NOT currently
   * rendered into any plan-preview line (the seed step only counts records/documents),
   * but it is the same field concept and costs nothing to close now rather than leave
   * as a silent gap the next preview enhancement reopens.
   */
  typeName: safeDisplayString(z.string().min(1)),
  /**
   * Stable, caller-supplied id — the loader's idempotency key AND the value other
   * seeds resolve a `reference` against (across surfaces: a record seed may
   * reference a document seed by its externalId, and vice versa).
   * `safeDisplayString`: not currently rendered in a plan-preview line (same as this schema's
   * `typeName` just above until this pass), but the same "costs nothing to close now" standard
   * applies — a short caller-supplied id, not free-form prose, so no YAML block-scalar
   * collision risk like `description`'s.
   */
  externalId: safeDisplayString(z.string().min(1)),
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
// `member.*` joins this lint for the same reason (found in review):
// `${{ member.scope.<ns> }}` (and its `:<level>` selector form) is
// the equivalent runtime per-membership placeholder, resolved server-side —
// also only meaningful inside a role's dataScope, so a misplaced/typo'd one
// gets the same teach-by-error here that self/under already got. (inputs.ts's
// DEFERRED_NAMESPACES gained the matching entry in the same commit, so the
// token also survives install-time resolution to reach this lint and the
// server at all.)
//
// Two features widened the legal zone further, both PLACEMENT
// only (see `lintRoleAssumable` below for the narrower per-form grammar
// `roleAssumable` additionally enforces):
//   - `fragments.<name>` — a fragment IS a dataScope map (same
//     shape `roles[].dataScope` is), so wherever it lands via `dataScopeRef`
//     it must already have been legal to write inline.
//   - `roleAssumable.<roleId>` — a SEPARATE top-level map (not
//     nested under `roles` at all — see that field's own doc comment for
//     why), so it needs its own path check distinct from `roles[].dataScope`.
//
// Broader than a strict single-segment match — the runtime grammar allows
// deeper dotted paths (`self.scope.<ns>`, `under.self.<field>`, `member.scope.<ns>`
// — see inputs.ts's DEFERRED_NAMESPACES), so a strict `self\.[A-Za-z_]\w*` shape
// would silently miss them. Same reasoning as IDENTITY_REF_LOOSE_RE below:
// captures ANYTHING between the `self.`/`under.`/`member.` prefix and the closing
// `}}` (never crossing a literal `}`), so a token this lint's narrower form
// couldn't parse is still DETECTED here rather than silently invisible —
// landing as a dead, unresolved literal wherever it was misplaced.
// 'input' joins the alternation: `${{ input.* }}` is a fourth runtime placeholder family, resolved
// against the record that fired a trigger rather than the caller's own identity. Sharing this regex
// means it inherits the SAME placement confinement (and the same generic "not recognized here"
// rejection in contexts like `roleAssumable`, where an input-fired-record concept is meaningless)
// without a second, parallel token-detection regex to keep in sync.
const SELF_TOKEN_RE = /\$\{\{\s*(?:self|under|member|input)\.[^}]*?\s*\}\}/;

// The IDENTITY-DERIVED families (`self.*`, `under.self.*`, `member.*`) — everything in
// SELF_TOKEN_RE's alternation EXCEPT `input`. Detected separately so they can be rejected inside
// `triggers[].dataScope`, where they are the exact inverse of `input.*`: legal-looking, and resolved
// against the WRONG principal.
//
// A trigger's grant is resolved at fire time against the TRIGGER PRINCIPAL's identity, not the
// author's. So `${{ self.scope.org }}` in a trigger dataScope does not mean "my org" — it means "the
// trigger principal's org", which the platform cannot verify the author has any reach into. The
// platform refuses it; this lint reports it offline, at validate/plan, instead of letting an
// apply fail partway through a provisioning run.
//
// Use `${{ input.* }}` to confine a trigger's grant to the record that fired it, or name literals.
const IDENTITY_DERIVED_TOKEN_RE = /\$\{\{\s*(?:self|under|member)\.[^}]*?\s*\}\}/;

// `${{ input.* }}` alone, detected separately so it can be rejected in a subtree where
// `self`/`under`/`member` are fine but `input` specifically is not (`input.*` resolves against a
// firing record, which exists ONLY on a trigger's own dataScope clause — everywhere else it is
// inert, matching nothing forever). Sharing SELF_TOKEN_RE's broad "anything to the closing `}}`"
// capture style so a malformed `input.*` token is still DETECTED, not silently missed.
const INPUT_TOKEN_RE = /\$\{\{\s*input\.[^}]*?\s*\}\}/;

function lintSelfTokenPlacement(value: unknown, ctx: z.RefinementCtx): void {
  // 'none': no self-family placeholder is valid here at all.
  // 'self-family': self/under/member are valid (roles[].dataScope, roleAssumable[], fragments[]) —
  //   `input.*` is NOT, because none of these clauses ever see a firing record.
  // 'trigger': triggers[].dataScope — the one subtree where `input.*` is valid, and the ONLY one
  //   where the identity-derived families (self/under/member) are NOT: everywhere else they resolve
  //   against the caller, here they would resolve against the trigger's own principal.
  type PlacementZone = 'none' | 'self-family' | 'trigger';
  const walk = (node: unknown, path: (string | number)[], zone: PlacementZone): void => {
    if (typeof node === 'string') {
      if (zone === 'none' && SELF_TOKEN_RE.test(node)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path,
          message:
            "'${{ self.* }}' / '${{ member.* }}' / '${{ input.* }}' is a runtime placeholder — it is " +
            "only valid inside a roles[].dataScope value, a roleAssumable[] value, a fragments[] " +
            "value, or a triggers[].dataScope value ('${{ input.* }}' specifically is valid ONLY in " +
            "triggers[].dataScope)",
        });
      } else if (zone === 'trigger' && IDENTITY_DERIVED_TOKEN_RE.test(node)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path,
          message:
            "'${{ self.* }}' / '${{ under.self.* }}' / '${{ member.* }}' resolve against the TRIGGER " +
            "PRINCIPAL's identity, not yours \u2014 a trigger's grant is resolved at fire time under its own " +
            "principal. The platform refuses them in a trigger grant for that reason: the reach they " +
            "describe is not bounded by your own. Use '${{ input.* }}' to confine the grant to the " +
            'record that fired the rule, or name literal values.',
        });
      } else if (zone === 'self-family' && INPUT_TOKEN_RE.test(node)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path,
          message:
            "'${{ input.* }}' resolves against the record that fired a trigger — it is only valid " +
            "inside a triggers[].dataScope value. It is inert (never resolved, matches nothing) in " +
            "roles[].dataScope, roleAssumable[], and fragments[] values; use '${{ self.* }}' / " +
            "'${{ under.self.* }}' / '${{ member.* }}' there instead.",
        });
      }
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((v, i) => walk(v, [...path, i], zone));
      return;
    }
    if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        // path === ['roles', <roleId>, <clauseIndex>] and key 'dataScope' opens
        // the only per-clause subtree where self.* is allowed.
        const inRoleDataScopeClause =
          path.length === 3 && path[0] === 'roles' && k === 'dataScope';
        // `roleAssumable.<roleId>` — the whole subtree under the
        // top-level 'roleAssumable' key is a grant map; the zone's
        // stickiness (`nextZone` below) then covers every value under it,
        // same mechanism `fragments` uses below.
        const inRoleAssumable = path.length === 0 && k === 'roleAssumable';
        // `fragments.<name>` — the whole subtree under the top-level
        // 'fragments' key is a dataScope map, same reasoning.
        const inFragments = path.length === 0 && k === 'fragments';
        // `triggers.<name>.dataScope` (path === ['triggers', <name>], key 'dataScope') is the
        // trigger analogue of `inRoleDataScopeClause` — the one subtree where `${{ input.* }}` is
        // meaningful, since only a trigger's own grant clause has a firing record to resolve it
        // against.
        const inTriggerDataScope = path.length === 2 && path[0] === 'triggers' && k === 'dataScope';
        const nextZone: PlacementZone =
          zone === 'trigger' || inTriggerDataScope
            ? 'trigger'
            : zone === 'self-family' || inRoleDataScopeClause || inRoleAssumable || inFragments
              ? 'self-family'
              : 'none';
        walk(v, [...path, k], nextZone);
      }
    }
  };
  walk(value, [], 'none');
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
// byte-for-byte (both verified independently against the platform's own
// namespace pattern and forbidden set, not against each
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
 * (mirrors the platform's own namespace-grammar check, same check order — forbidden set FIRST, so a
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
// identity-overrides validation rule, not just the value half:
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
// platform's own scope-value parsing — splitting on the LAST
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
// authored-scopes validation rejects the same shape; an exact repeat (same
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

/**
 * Platform-owned search-index metadata keys, per BIND SURFACE. A schema-declared `filterable: true`
 * field whose `fieldId` collides with one for a surface the schema binds to would shadow the
 * platform's own value in the index — silently costing recall and precision on type-scoped searches
 * — so the platform rejects it with a `400`.
 *
 * Transcribed from the platform's own reserved-metadata-field-name lists for records and
 * documents. Three things here are deliberate and must not be "simplified":
 *
 * - **The two sets stay SEPARATE, and a schema is checked against only the surface(s) it declares.**
 *   Checking the UNION rejects a real, shipping document-only blueprint over `recordType`, a key the
 *   document model never writes. That regression is on the record platform-side; do not reintroduce
 *   it here.
 * - **`status` is on NEITHER set.** Documents always kept lifecycle on their own `lifecycleStatus`
 *   field, and records stopped publishing a lifecycle `status` key, so a filterable `status` field is
 *   now legitimate on both surfaces. The bundled agentic-sdlc blueprints rely on exactly this.
 * - **An identity-only schema (`user`/`entity`) reserves NOTHING.** Identity models are not indexed
 *   through the indexable-metadata path at all, so there is no platform map to collide with.
 *
 * A non-filterable field of any name is unaffected — it never reaches the index metadata map.
 */
const RECORD_RESERVED_FILTERABLE_FIELD_IDS: ReadonlySet<string> = new Set([
  'tenantId', 'owner_id', 'folderId', 'rootFolderId', 'recordType',
]);
const DOCUMENT_RESERVED_FILTERABLE_FIELD_IDS: ReadonlySet<string> = new Set([
  'tenantId', 'model_type', 'owner_id', 'title', 'folderId', 'rootFolderId', 'recordType',
]);

/**
 * Reject a `filterable: true` field whose id is a platform-owned index key for a surface this schema
 * binds to. Reported at authoring time so `blueprint validate`/`plan` catches it, rather than the
 * apply failing partway through provisioning — the same "lints clean, then 400s at apply" class this
 * package's other placement lints exist to close.
 *
 * `allowedSurfaces` defaults to `['record']` when omitted, matching what the CLI loader actually
 * sends; reading an omitted value as "no surfaces" would silently skip the check for the single most
 * common blueprint shape.
 */
function lintReservedFilterableFieldIds(value: unknown, ctx: z.RefinementCtx): void {
  const bp = value as { schemas?: Array<{ typeName?: string; allowedSurfaces?: string[];
    fields?: Array<{ fieldId?: string; filterable?: boolean }> }> };
  bp.schemas?.forEach((schema, si) => {
    const surfaces = schema.allowedSurfaces ?? ['record'];
    schema.fields?.forEach((field, fi) => {
      if (!field?.filterable || !field.fieldId) return;
      const collidesWith = new Set<string>();
      if (surfaces.includes('record') && RECORD_RESERVED_FILTERABLE_FIELD_IDS.has(field.fieldId)) {
        for (const k of RECORD_RESERVED_FILTERABLE_FIELD_IDS) collidesWith.add(k);
      }
      if (surfaces.includes('document') && DOCUMENT_RESERVED_FILTERABLE_FIELD_IDS.has(field.fieldId)) {
        for (const k of DOCUMENT_RESERVED_FILTERABLE_FIELD_IDS) collidesWith.add(k);
      }
      if (collidesWith.size === 0) return;
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['schemas', si, 'fields', fi, 'filterable'],
        message:
          `schema '${schema.typeName ?? si}': field '${field.fieldId}' cannot be declared filterable — ` +
          `'${field.fieldId}' is a platform-owned search-index metadata key ` +
          `(${[...collidesWith].sort().join(', ')}) for a surface this schema binds to ` +
          `(${surfaces.join(', ')}), and a filterable payload field of the same name would shadow it ` +
          `in the index. Choose a different fieldId, or leave this field non-filterable.`,
      });
    });
  });
}

function lintDataScopeKeys(value: unknown, ctx: z.RefinementCtx): void {
  const bp = value as {
    accessProfile?: { dataScope?: Record<string, unknown> };
    roles?: Record<string, Array<{ dataScope?: Record<string, unknown> }>>;
    fragments?: Record<string, Record<string, unknown>>;
    triggers?: Record<string, { dataScope?: Record<string, unknown> }>;
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
  // A fragment is exactly a dataScope map; its keys
  // follow the identical grammar `roles[].dataScope`'s keys do.
  for (const [name, fragment] of Object.entries(bp.fragments ?? {})) {
    for (const key of Object.keys(fragment ?? {})) {
      lintDataScopeKey(key, ['fragments', name, key], ctx);
    }
  }
  // A trigger's inline dataScope follows the identical key grammar.
  for (const [name, trigger] of Object.entries(bp.triggers ?? {})) {
    for (const key of Object.keys(trigger.dataScope ?? {})) {
      lintDataScopeKey(key, ['triggers', name, 'dataScope', key], ctx);
    }
  }
}

// Structural-only grammar check for `schemas[].expectedScopeDims` (advisory):
// each entry must be a valid `dataScope`-KEY dimension name with the
// `scope:` prefix already stripped — 'userId', or a grammar-valid,
// non-forbidden namespace (the identical check `lintDataScopeKey` applies to
// an actual `scope:<ns>` key, run here on the bare namespace instead). Also
// rejects a duplicate dimension listed twice — meaningless, and would make
// the CLI's coverage-cross-reference lint (packages/cli) count it once
// either way, silently masking a copy/paste mistake.
function lintExpectedScopeDims(value: unknown, ctx: z.RefinementCtx): void {
  const bp = value as { schemas?: Array<{ typeName?: string; expectedScopeDims?: unknown[] }> };
  (bp.schemas ?? []).forEach((schema, i) => {
    const dims = schema.expectedScopeDims;
    if (!dims) return;
    const seen = new Set<string>();
    dims.forEach((raw, j) => {
      const dim = String(raw);
      const path = ['schemas', i, 'expectedScopeDims', j];
      if (seen.has(dim)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path,
          message: `schema '${schema.typeName}': expectedScopeDims lists '${dim}' more than once.`,
        });
      }
      seen.add(dim);
      if (dim === 'userId') return;
      const nsError = scopeNamespaceGrammarError(dim);
      if (nsError !== null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path,
          message: `schema '${schema.typeName}': expectedScopeDims['${dim}'] ${nsError}`,
        });
      }
    });
  });
}

// Every `dataScopeRef` must name a declared
// `fragments` entry. Caught offline (parse/lint), not left to resolve to
// `undefined` at expansion time (`expandDataScopeRefs`, below `parseBlueprint`)
// — an unresolved ref there would either throw an unhelpful internal error or,
// worse, silently mint a clause with NO dataScope at all (unconstrained reach),
// depending on how the expansion step were written. Rejecting it here means
// expansion can assume every ref it sees already resolves.
function lintDataScopeRefs(value: unknown, ctx: z.RefinementCtx): void {
  const bp = value as {
    fragments?: Record<string, unknown>;
    roles?: Record<string, Array<{ dataScopeRef?: string }>>;
  };
  const declared = new Set(Object.keys(bp.fragments ?? {}));
  for (const [roleId, clauses] of Object.entries(bp.roles ?? {})) {
    clauses.forEach((clause, i) => {
      if (clause.dataScopeRef === undefined) return;
      if (!declared.has(clause.dataScopeRef)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['roles', roleId, i, 'dataScopeRef'],
          message:
            `dataScopeRef '${clause.dataScopeRef}' is not declared in fragments — declared fragments: ` +
            (declared.size ? [...declared].join(', ') : '(none)'),
        });
      }
    });
  }
}

// `roles[].assumable`'s grammar, mirroring the platform's own
// authoring-time grammar check for this field server-side.
//
// The rule the accepted forms satisfy, stated once because it decides every
// future case rather than just today's: an `assumable` grant may depend on a
// plain literal, or on the credential's own PRINCIPAL, and on nothing else.
// The principal is the one identity dimension `/v1/auth/token/assume` can
// never change, so a grant keyed on it means the same thing before and after
// an assume. Three consequences:
//
//  - a bare `${{ self.<dim> }}` is meaningless here (it can only ever equal
//    whatever identity already is, never a distinct value to become);
//  - `${{ any }}` is not a concrete value;
//  - `${{ under.self.scope.<ns> }}` resolves against the credential's own
//    current value for a namespace an assume CAN move — so what the grant
//    admitted would depend on what was last assumed, and where a profile
//    composes several roles they all share one identity, so one role's grant
//    would silently widen or narrow another's. Still legal in `dataScope`,
//    where it is re-derived per write.
//
// So the legal forms are `${{ under.self.userId }}`,
// `${{ member.scope.<ns>[:level] }}` (membership is resolved server-side
// against the principal, not against a movable dimension), or a literal.
const BARE_SELF_PLACEHOLDER_RE = /^\$\{\{\s*self\.[^}]*?\s*\}\}$/;
const UNDER_SELF_PLACEHOLDER_RE = /^\$\{\{\s*under\.self\.userId\s*\}\}$/;
const UNDER_SELF_SCOPE_PLACEHOLDER_RE =
  /^\$\{\{\s*under\.self\.scope\.[a-z][a-z0-9_-]{1,31}\s*\}\}$/;
// The `:level` selector shares the namespace segment's own grammar
// byte-for-byte (lowercase-first, 2-32 chars) — a looser client-side pattern
// here (e.g. tolerating uppercase or unbounded length) would lint clean and
// pass `blueprint plan`, then 400 deep inside `vectros bootstrap`'s
// `createRole` call, possibly after other resources already provisioned —
// exactly the fail-fast promise this lint exists to keep.
const MEMBER_SCOPE_PLACEHOLDER_RE =
  /^\$\{\{\s*member\.scope\.[a-z][a-z0-9_-]{1,31}(?::[a-z][a-z0-9_-]{1,31})?\s*\}\}$/;
const ANY_PLACEHOLDER_RE = /^\$\{\{\s*any\s*\}\}$/;

/** `null` when `v` is a legal `assumable` value for the (already namespace-validated) public key, else why not. */
function assumableValueError(publicKey: string, v: string): string | null {
  if (UNDER_SELF_PLACEHOLDER_RE.test(v) || MEMBER_SCOPE_PLACEHOLDER_RE.test(v)) return null;
  if (UNDER_SELF_SCOPE_PLACEHOLDER_RE.test(v)) {
    return (
      `assumable['${publicKey}'] value '${v}' resolves against your own current value for that ` +
      'namespace, which an assume can itself change — so what this grant admits would depend on ' +
      "what was last assumed. Use '${{ under.self.userId }}', " +
      "'${{ member.scope.<namespace>[:level] }}', or a plain literal, all of which mean the same " +
      "thing before and after an assume. ('${{ under.self.scope.<namespace> }}' remains valid in " +
      'dataScope, where it is re-derived per write)'
    );
  }
  if (ANY_PLACEHOLDER_RE.test(v)) {
    return (
      `assumable['${publicKey}'] value '${v}' is not a concrete value and cannot be authored as an ` +
      'assumable grant — name the specific value(s) holders of this role may become'
    );
  }
  if (BARE_SELF_PLACEHOLDER_RE.test(v)) {
    return (
      `assumable['${publicKey}'] value '${v}' is the bare self placeholder, which is tautological here ` +
      '— it can only ever equal whatever identity currently is, never a distinct value to become. Use ' +
      "'${{ under.self.userId }}', '${{ member.scope.<namespace>[:level] }}', or a plain literal " +
      'instead'
    );
  }
  if (SELF_TOKEN_RE.test(v)) {
    return (
      `assumable['${publicKey}'] value '${v}' is not a recognized runtime placeholder — use ` +
      "'${{ under.self.userId }}' or '${{ member.scope.<namespace>[:level] }}'"
    );
  }
  if (!SCOPE_VALUE_RE.test(v)) {
    return (
      `assumable['${publicKey}'] value '${v}' is not a valid scope value — 1-128 characters, starting ` +
      "with a letter or digit and continuing with letters, digits, '_' or '-'"
    );
  }
  return null;
}

/**
 * Authoring-time mirror of the platform's own access-profile roleIds
 * validation: every `accessProfile.roleIds` entry must name a role this SAME
 * blueprint declares in `roles` (the same-`(tenantId, contextId)` check is trivially
 * satisfied by construction — a blueprint's own `roles` are always created in
 * its own `contextId`, so there is no OTHER context to reference), and no id
 * may repeat — rejected outright, never silently deduplicated.
 * `.min(1)` on the schema already covers non-empty; this only checks resolution
 * + duplicates.
 */
function lintAccessProfileRoleIds(value: unknown, ctx: z.RefinementCtx): void {
  const bp = value as { roles?: Record<string, unknown>; accessProfile?: { roleIds?: string[] } };
  const roleIds = bp.accessProfile?.roleIds;
  if (!roleIds) return;
  const declaredRoles = new Set(Object.keys(bp.roles ?? {}));
  const seen = new Set<string>();
  roleIds.forEach((roleId, i) => {
    const path: (string | number)[] = ['accessProfile', 'roleIds', i];
    if (!declaredRoles.has(roleId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path,
        message:
          `accessProfile.roleIds names '${roleId}', which is not a role this blueprint declares in ` +
          `roles — ` +
          (declaredRoles.size ? `declared roles: ${[...declaredRoles].join(', ')}` : 'declared roles: (none)'),
      });
    }
    if (seen.has(roleId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path,
        message: `accessProfile.roleIds names '${roleId}' more than once — remove the duplicate`,
      });
    }
    seen.add(roleId);
  });
}

/**
 * Every entry in a trigger's `fields` must name a field the firing schema keeps INLINE — declared
 * `inline: true`, or `filterable`, or used as a lookup field — and never one marked `sensitive`.
 * The platform rejects anything else with a 400 listing the projectable fields.
 *
 * Checked here because the blueprint declares BOTH halves: the schema and the rule that projects
 * from it. That is the same "lints clean, then 400s partway through an apply" class every other
 * lint in this file exists to close, and it is worse for triggers than most — the apply has already
 * created a service principal and a profile by the time the trigger create is attempted.
 *
 * Deliberately silent when the schema is not resolvable from this blueprint: an unknown
 * `schemaName` already has its own issue from `lintTriggers`, and piling a second, derived
 * complaint on top of it just obscures the real one.
 */
function lintTriggerFields(value: unknown, ctx: z.RefinementCtx): void {
  const bp = value as {
    schemas?: Array<{
      typeName?: string;
      fields?: Array<{ fieldId?: string; inline?: boolean; filterable?: boolean; sensitive?: boolean }>;
      lookupFields?: Array<string | { fieldName?: string; fieldNames?: string[]; sortBy?: string }>;
    }>;
    triggers?: Record<string, { firingSource?: { schemaName?: string }; fields?: string[] }>;
  };
  for (const [triggerName, entry] of Object.entries(bp.triggers ?? {})) {
    const declared = entry?.fields;
    if (!declared?.length) continue; // [] is the valid "project nothing" declaration
    const schema = bp.schemas?.find((sc) => sc.typeName === entry.firingSource?.schemaName);
    if (!schema) continue; // lintTriggers already reports the unknown schemaName

    // Everything a LOOKUP makes projectable. Transcribed from the platform's own
    // rule for what a lookup makes projectable, which adds three things — and the third is easy to miss:
    //   - a bare-string lookup's name;
    //   - every leg of an object lookup, composite included;
    //   - the lookup's `sortBy` TARGET, unless it is the built-in createdAt/lastUpdated. A sortBy
    //     target need not itself be inline, filterable, or a leg, so this is a fourth projectable
    //     path that reading the field-level flags alone will not find.
    const lookupNames = new Set<string>();
    for (const lf of schema.lookupFields ?? []) {
      if (typeof lf === 'string') {
        lookupNames.add(lf);
        continue;
      }
      if (lf?.fieldName) lookupNames.add(lf.fieldName);
      for (const n of lf?.fieldNames ?? []) lookupNames.add(n);
      if (lf?.sortBy && lf.sortBy !== 'createdAt' && lf.sortBy !== 'lastUpdated') {
        lookupNames.add(lf.sortBy);
      }
    }

    // The platform rejects a repeated entry outright; every sibling list in this file (roleIds,
    // manifest) already checks this, and leaving it out here would let the exact "lints clean, 400s
    // partway through the apply" case this lint exists to close straight through.
    const seenFields = new Set<string>();

    declared.forEach((fieldId, i) => {
      const def = schema.fields?.find((f) => f.fieldId === fieldId);
      const path = ['triggers', triggerName, 'fields', i];
      if (seenFields.has(fieldId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path,
          message: `triggers['${triggerName}'].fields names '${fieldId}' more than once — list it once`,
        });
        return;
      }
      seenFields.add(fieldId);
      // SENSITIVE FIRST, before the lookup shortcut below. The platform subtracts sensitive from
      // the WHOLE projectable set — lookup legs included — and a sensitive lookup field is a
      // supported, blind-indexed shape, so returning early on `lookupNames` would wave through a
      // combination that 400s at createTrigger, AFTER the apply has already minted the trigger's
      // service principal and placeholder profile. That is exactly the expensive failure this lint
      // exists to move earlier.
      if (def?.sensitive === true) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path,
          message:
            `triggers['${triggerName}'].fields names '${fieldId}', which is marked 'sensitive'. A ` +
            'sensitive field is blind-indexed and masked, and can never be projected into a trigger ' +
            "script — drop it from 'fields', or make the field non-sensitive",
        });
        return;
      }
      // A lookup leg (or sortBy target) is projectable REGARDLESS of whether a FieldDef exists for
      // it: `fields` on a schema is optional, and the platform requires a declaration only for a
      // sortBy target. Checked BEFORE the not-declared branch, which would otherwise reject a
      // perfectly legal lookup-only schema.
      if (lookupNames.has(fieldId)) return;
      if (!def) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path,
          message:
            `triggers['${triggerName}'].fields names '${fieldId}', which schema ` +
            `'${schema.typeName}' neither declares nor uses as a lookup`,
        });
        return;
      }
      if (def.inline !== true && def.filterable !== true) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path,
          message:
            `triggers['${triggerName}'].fields names '${fieldId}', which schema '${schema.typeName}' ` +
            "does not keep inline. A rule may project only a field that is 'inline: true', " +
            "'filterable: true', or used as a lookup field — mark it 'inline: true' on the schema, " +
            "or drop it from 'fields'",
        });
      }
    });
  }
}

/**
 * Authoring-time checks for the `scripts` block — the two things a `z.record` value schema cannot
 * reach on its own.
 *
 * 1. **The map KEY is the script's name**, and `z.record`'s value schema never sees it, so the
 *    platform's name grammar has to be checked here or not at all. Unchecked, a bad name is a 400
 *    partway through an apply that has already created a service principal and an access profile.
 *
 * 2. **A trigger naming a script THIS blueprint ships must use `version: 'latest'`.** A pinned
 *    integer means "run a version this bundle does not define": the platform assigns version
 *    numbers itself, so an author cannot know which number their `source` will land on, and the
 *    pin they wrote is at best a guess about the target context's history. The trap is what
 *    happens NEXT — edit `source`, the push mints version 2, and the rule pinned to `1` goes on
 *    running the OLD code with nothing to observe. Shipping the script and pinning away from it
 *    are contradictory intents, so this refuses rather than warns (this package has no warning
 *    channel, and a restriction is cheap to relax later and breaking to add later).
 *
 * A `scriptRef` naming a script this blueprint does NOT ship stays entirely unrestricted, pin and
 * all — that is the pre-existing "reference a script someone else pushed" case, and it is the only
 * form that worked before this block existed.
 */
function lintScripts(value: unknown, ctx: z.RefinementCtx): void {
  const bp = value as {
    scripts?: Record<string, unknown>;
    // `version` is NOT optional here, matching `BlueprintTriggerScriptRefSchema`'s own
    // `z.string().min(1)`. Typing it optional invited a `version === undefined` guard below that
    // could never fire — and a dead guard reads to the next person as though the case is reachable.
    // A nested parse failure aborts before this top-level refinement runs, so by the time we are
    // here every `scriptRef` present has a `version`.
    triggers?: Record<string, { scriptRef?: { name?: string; version: string } }>;
  };
  const scripts = bp.scripts;
  if (!scripts) return;

  for (const name of Object.keys(scripts)) {
    if (!SCRIPT_NAME_RE.test(name)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['scripts', name],
        message:
          `scripts['${name}'] is not a valid script name — use 1-64 characters of letters, digits, ` +
          "underscores ('_') and hyphens ('-'). The map key IS the name the platform stores and a " +
          "trigger's scriptRef.name resolves against.",
      });
    }
  }

  for (const [triggerName, trigger] of Object.entries(bp.triggers ?? {})) {
    const ref = trigger?.scriptRef;
    if (!ref?.name) continue;
    // Only constrains a reference to a script THIS blueprint ships, keyed on the declared key SET
    // rather than on name validity. So a blueprint that both misnames a script and pins it reports
    // BOTH issues — deliberately, because they are independent: correcting the name does not
    // correct the pin, and suppressing the second would hide a fix the author still owes.
    if (!Object.prototype.hasOwnProperty.call(scripts, ref.name)) continue;
    if (ref.version !== 'latest') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['triggers', triggerName, 'scriptRef', 'version'],
        message:
          `triggers['${triggerName}'].scriptRef pins version '${ref.version}' of '${ref.name}', ` +
          "which is a script THIS blueprint ships — use version: 'latest' instead. Version numbers " +
          'are assigned by the platform, so a pin cannot be known to name the source declared here; ' +
          'and once that source is edited the pin would keep running the superseded version. Pin a ' +
          'version only for a script this blueprint does not ship.',
      });
    }
  }
}

/**
 * Authoring-time checks for the `triggers` block, mirroring `lintAccessProfileRoleIds`'s two shapes
 * (name resolution + no-duplicates) for the two references a trigger entry can carry:
 * - `firingSource.schemaName` must name a `typeName` this SAME blueprint declares in `schemas`
 *   (the identical same-blueprint self-reference `lintSeedSurfaces` already relies on for
 *   `seed[].typeName`).
 * - `roleIds` (when the entry is role-composed) must each name a role this SAME blueprint declares
 *   in `roles` — byte-for-byte the same check `lintAccessProfileRoleIds` runs for
 *   `accessProfile.roleIds`, just walked once per trigger entry instead of once for the singular
 *   service-principal profile.
 */
function lintTriggers(value: unknown, ctx: z.RefinementCtx): void {
  const bp = value as {
    schemas?: Array<{ typeName?: string; capabilities?: { triggersEnabled?: boolean } }>;
    roles?: Record<string, Array<{ dataScope?: Record<string, unknown> }>>;
    triggers?: Record<string, { firingSource?: { schemaName?: string }; roleIds?: string[] }>;
  };
  const triggers = bp.triggers;
  if (!triggers) return;

  const declaredSchemas = new Set((bp.schemas ?? []).map((s) => s.typeName).filter(Boolean));
  // Schemas that have opted in to firing triggers. A trigger may only name a schema THIS blueprint
  // declares (checked below), so this set is exact — there is no "declared elsewhere, can't tell"
  // case to fall through on.
  const triggerEnabledSchemas = new Set(
    (bp.schemas ?? [])
      .filter((s) => s.capabilities?.triggersEnabled === true)
      .map((s) => s.typeName)
      .filter(Boolean),
  );
  const declaredRoles = new Set(Object.keys(bp.roles ?? {}));

  for (const [name, trigger] of Object.entries(triggers)) {
    const schemaName = trigger.firingSource?.schemaName;
    if (schemaName && !declaredSchemas.has(schemaName)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['triggers', name, 'firingSource', 'schemaName'],
        message:
          `triggers['${name}'].firingSource.schemaName names '${schemaName}', which is not a schema ` +
          `this blueprint declares in schemas — ` +
          (declaredSchemas.size ? `declared schemas: ${[...declaredSchemas].join(', ')}` : 'declared schemas: (none)'),
      });
    } else if (schemaName && !triggerEnabledSchemas.has(schemaName)) {
      // Records only fire triggers when their schema opts in, so a rule against a schema that has
      // not would be created, hold a service principal and a grant, and never fire — a state that
      // reads as working. Caught here at plan time, and refused again by the platform on apply.
      // Reported only when the schema RESOLVES, so an author fixing a typo'd schemaName sees one
      // clear error rather than two describing the same mistake.
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['triggers', name, 'firingSource', 'schemaName'],
        message:
          `triggers['${name}'].firingSource.schemaName names '${schemaName}', which does not enable ` +
          `triggers — records of that schema would never fire it. Set ` +
          `capabilities.triggersEnabled: true on the '${schemaName}' schema.`,
      });
    }

    const roleIds = trigger.roleIds;
    if (!roleIds) continue;
    const seen = new Set<string>();
    roleIds.forEach((roleId, i) => {
      const path: (string | number)[] = ['triggers', name, 'roleIds', i];
      if (!declaredRoles.has(roleId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path,
          message:
            `triggers['${name}'].roleIds names '${roleId}', which is not a role this blueprint ` +
            `declares in roles — ` +
            (declaredRoles.size ? `declared roles: ${[...declaredRoles].join(', ')}` : 'declared roles: (none)'),
        });
      }
      if (seen.has(roleId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path,
          message: `triggers['${name}'].roleIds names '${roleId}' more than once — remove the duplicate`,
        });
      }
      seen.add(roleId);

      // The COMPOSED leg of the identity-derived refusal. lintSelfTokenPlacement walks the blueprint
      // by SUBTREE, so it sees a trigger's own inline `dataScope` (zone 'trigger') but never the
      // dataScope of a role the trigger merely NAMES — that role sits under `roles`, in the
      // 'self-family' zone, where self/under/member are correct and must stay legal for its ordinary
      // use as an access-profile grant.
      //
      // The platform gate is not subtree-shaped: it runs on BOTH the inline-scopes leg and the
      // roleIds leg, because the escalation is in what the
      // grant RESOLVES to at fire time and a composed role carries a clause exactly as an inline one
      // does. Without this, a blueprint composing a role whose dataScope carries
      // `${{ self.scope.org }}` lints clean and then 400s partway through applying it — the
      // failure this lint exists to prevent, and the same "one leg over" miss that produced the
      // platform finding in the first place.
      for (const clause of bp.roles?.[roleId] ?? []) {
        for (const [dim, raw] of Object.entries(clause?.dataScope ?? {})) {
          for (const v of Array.isArray(raw) ? raw : [raw]) {
            if (typeof v !== 'string' || !IDENTITY_DERIVED_TOKEN_RE.test(v)) continue;
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path,
              message:
                `triggers['${name}'].roleIds names '${roleId}', whose dataScope['${dim}'] uses '${v}'. ` +
                "'${{ self.* }}' / '${{ under.self.* }}' / '${{ member.* }}' resolve against the " +
                'TRIGGER PRINCIPAL\'s identity, not yours, so the platform refuses them in a trigger ' +
                `grant — inline or composed. The role itself is fine for ordinary use; it just cannot ` +
                'be the grant for a trigger. Give the trigger an inline grant using ' +
                "'${{ input.* }}' or literal values, or compose a role without an identity-derived " +
                'dataScope.',
            });
          }
        }
      }
    });
  }
}

function lintRoleAssumable(value: unknown, ctx: z.RefinementCtx): void {
  const bp = value as {
    roles?: Record<string, unknown>;
    roleAssumable?: Record<string, Record<string, unknown>>;
  };
  const declaredRoles = new Set(Object.keys(bp.roles ?? {}));
  for (const [roleId, assumable] of Object.entries(bp.roleAssumable ?? {})) {
    if (!declaredRoles.has(roleId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['roleAssumable', roleId],
        message:
          `roleAssumable names '${roleId}', which is not a role this blueprint declares in roles — ` +
          (declaredRoles.size ? `declared roles: ${[...declaredRoles].join(', ')}` : 'declared roles: (none)'),
      });
      continue;
    }
    for (const [key, values] of Object.entries(assumable)) {
      const path: (string | number)[] = ['roleAssumable', roleId, key];
      if (key === 'userId') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path,
          message:
            "assumable cannot name the principal ('userId') — the principal is never assumable via " +
            '/assume, and a grant for it would save but could never be exercised',
        });
        continue;
      }
      const ns = key.startsWith('scope:') ? key.slice('scope:'.length) : null;
      const nsError = ns === null ? null : scopeNamespaceGrammarError(ns);
      if (ns === null || nsError !== null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path,
          message:
            ns === null
              ? `'${key}' is not allowed — assumable keys must be a namespaced 'scope:<namespace>' key ` +
                '(the principal cannot be named)'
              : `assumable['${key}'] ${nsError}`,
        });
        continue;
      }
      if (!Array.isArray(values)) continue; // shape error — caught by the field schema itself
      values.forEach((v, i) => {
        if (typeof v !== 'string') return;
        const err = assumableValueError(key, v);
        if (err) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [...path, i], message: err });
      });
    }
  }
}

/**
 * Expand every `dataScopeRef` to the literal `dataScope`
 * the named fragment declares, so `dataScopeRef` never survives past
 * `parseBlueprint`. Runs AFTER `BlueprintSchema`'s superRefine has already
 * confirmed every ref resolves (`lintDataScopeRefs`) — a lookup miss here
 * would be this function's own bug, not an authoring error, so it is a
 * defensive `??` fallback to an empty dataScope rather than a second
 * validation pass.
 *
 * Deliberately NOT a zod `.transform()` on `BlueprintSchema` itself: that
 * would change `z.infer<typeof BlueprintSchema>` — the exported `Blueprint`
 * type every consumer (this package's own tests, `@vectros-ai/cli`) already
 * writes fixtures against — from the schema's literal object shape to
 * whatever the transform returns, a much bigger blast radius than this one
 * feature needs. A plain post-parse function keeps `Blueprint` describing
 * exactly what a blueprint LOOKS like (dataScopeRef included), while
 * {@link parseBlueprint}'s documented behavior is that the value it RETURNS
 * has already resolved every ref.
 */
function expandDataScopeRefs(bp: Blueprint): Blueprint {
  if (!bp.roles) return bp;
  const fragments = bp.fragments ?? {};
  let changedAnyRole = false;
  const roles: Record<string, BlueprintRoleClause[]> = {};
  for (const [roleId, clauses] of Object.entries(bp.roles)) {
    let changedThisRole = false;
    const expandedClauses = clauses.map((clause) => {
      if (clause.dataScopeRef === undefined) return clause;
      changedThisRole = true;
      const { dataScopeRef, ...rest } = clause;
      if (!(dataScopeRef in fragments)) {
        // Never reachable through the public parseBlueprint() API — the
        // superRefine pass that runs first in the same call already rejects
        // any dataScopeRef that doesn't resolve. This is a defensive check
        // for a caller that ever invokes this function on its own or a
        // future refactor that lets the two drift: falling back to an empty
        // dataScope here would silently mint an UNCONSTRAINED clause, the
        // worse of the two bad outcomes this lint's own doc comment already
        // reasons through — so this throws instead of guessing.
        throw new Error(
          `expandDataScopeRefs: dataScopeRef '${dataScopeRef}' does not resolve against fragments — ` +
            'this should have been caught by lintDataScopeRefs before parseBlueprint reaches this function',
        );
      }
      return { ...rest, dataScope: fragments[dataScopeRef] };
    });
    roles[roleId] = changedThisRole ? expandedClauses : clauses;
    changedAnyRole = changedAnyRole || changedThisRole;
  }
  return changedAnyRole ? { ...bp, roles } : bp;
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
 * A schema bound to the `user` surface can never be applied by a blueprint.
 *
 * WHY THIS IS A LINT AND NOT A RUNTIME SURPRISE. Without it, `blueprint validate` passes such a schema
 * and `blueprint plan` previews it as provisionable, while the apply fails with a 403 every time — the
 * author finds out against a live tenant, with no way to have known earlier. This performs the platform's
 * own authorization check at author time instead.
 *
 * WHY ONLY `user`, AND NOT `entity`. A user is account-global: it is the same person across every one of
 * your app contexts, so its schema has no single context that could own it, lives account-wide, and can
 * only be written with a root API key. A blueprint never applies with one. An `entity` schema is
 * different — it is owned by the app context that creates it, which is exactly the context a blueprint
 * applies into, so a blueprint CAN provision one and this lint must not reject it.
 *
 * If `user` ever gains per-context ownership the way entities have it, revisit this: it encodes an
 * authorization property of the platform, not a syntax rule.
 */
function lintIdentitySurfaces(value: unknown, ctx: z.RefinementCtx): void {
  const bp = value as { schemas?: Array<{ typeName?: string; allowedSurfaces?: string[] }> };
  if (!Array.isArray(bp.schemas)) return;
  bp.schemas.forEach((schema, i) => {
    if (!schema.allowedSurfaces?.includes('user')) return;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['schemas', i, 'allowedSurfaces'],
      message:
        `schema '${schema.typeName}': allowedSurfaces cannot include 'user' — a user-surfaced schema ` +
        'is account-global and requires a root API key, which no blueprint credential ever holds, so ' +
        "this would fail at apply with a 403. Model the data as a 'record' scoped to the user, or as " +
        "an 'entity' schema (which a blueprint CAN provision, in its own app context).",
    });
  });
}

/**
 * An issuer must target the blueprint's own app context.
 *
 * `contextId` on an issuer entry is the ONE place a blueprint can name an app context other than its
 * own. Schemas, roles, the access profile, the service principal and seed records all land in the
 * blueprint's `contextId`; an issuer could name any other. That asymmetry is a smuggling channel rather
 * than a feature: someone reviewing a pack reads that it provisions `casework` and has no reason to
 * check each issuer entry for a different target, so a pack could attach an identity provider — with
 * self-signup onto a real role — to an app context the reader never associated with it.
 *
 * It matters because a pack may be authored by a third party or generated, and because an issuer is a
 * trust anchor: whoever controls its `jwksUri` can mint identities the platform will accept.
 *
 * Requiring equality costs nothing real. One IdP account serving several app contexts still registers
 * one issuer per context — the `(issuer, audience)` pair must be unique, so each context needs its own
 * audience and therefore its own entry, which belongs in that context's own blueprint.
 */
function lintIssuerContext(value: unknown, ctx: z.RefinementCtx): void {
  const bp = value as { contextId?: string; issuers?: Array<{ issuerId?: string; contextId?: string }> };
  if (!Array.isArray(bp.issuers)) return;
  bp.issuers.forEach((issuer, i) => {
    // `contextId === undefined` is defensive, not a tolerated shape: the field is required, and a
    // missing required string aborts the object parse before superRefine runs. Kept so this reads
    // as a total function if the field ever becomes optional; it is not an escape hatch.
    if (issuer.contextId === undefined || issuer.contextId === bp.contextId) return;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['issuers', i, 'contextId'],
      message:
        `issuer '${issuer.issuerId}' targets app context '${issuer.contextId}', but this blueprint ` +
        `provisions '${bp.contextId}'. An issuer must target the blueprint's own context — everything ` +
        `else a blueprint creates does, and an issuer that points elsewhere attaches an identity ` +
        `provider to an app context the blueprint never mentions. Set it to '${bp.contextId}', or move ` +
        `this issuer into a blueprint for '${issuer.contextId}'.`,
    });
  });
}

/**
 * Which loader-phase a top-level blueprint field's resources are applied in
 * (`@vectros-ai/cli`'s `runLoader`):
 *   - `'bootstrap'` — applied under a narrow, owner-only bootstrap credential
 *     (`provisioning:c`), before the per-context wildcard re-mint. Tenant-wide
 *     provisioning config, the same category as the app-context create itself.
 *     `issuers` specifically applies under a SECOND bootstrap-scoped mint,
 *     re-pinned to the blueprint's own context (`@vectros-ai/cli` 0.16.0+) — the
 *     platform requires that combination (`provisioning:c` AND context
 *     confinement) for `POST/GET/DELETE /v1/auth/issuers`, which neither the
 *     first (default-pinned) bootstrap mint nor the per-context wildcard mint
 *     alone can satisfy for a non-`default` blueprint. Still the SAME phase as
 *     `servicePrincipal` from this map's point of view — the re-mint is a CLI
 *     implementation detail of "the bootstrap phase", not a third phase value.
 *   - `'in-context'` — applied under the wildcard per-context token re-minted
 *     AFTER the bootstrap phase. Ordinary data-plane provisioning, confined to
 *     the blueprint's own `contextId`.
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
 * Deliberately covers only the fields the bootstrap/in-context split actually
 * applies to. `identities` is NOT here: declared identities are ensured by a
 * separate, EARLIER pass (the CLI's `resolveApplyTimeIdentities`, before
 * `runLoader` ever runs — see `assertNoUnresolvedIdentities`), not by either
 * loader phase, so shoehorning it into this two-value enum would misdescribe
 * it rather than document it. `name`/`version`/`description`/`contextId`/
 * `contextName`/`companyName` are the blueprint's own scalar identity, not a
 * nested resource block — no phase applies to them individually.
 */
export type LoaderPhase = 'bootstrap' | 'in-context';

export const BLUEPRINT_FIELD_PHASES: Readonly<Record<string, LoaderPhase>> = Object.freeze({
  servicePrincipal: 'bootstrap',
  issuers: 'bootstrap',
  // Registration requires the platform's provisioning:c capability, which
  // only the bootstrap credential carries — same reasoning as issuers.
  namespaces: 'bootstrap',
  schemas: 'in-context',
  accessProfile: 'in-context',
  roles: 'in-context',
  seed: 'in-context',
  // Pushed on the same in-context token as the schemas/roles above, and — load-bearing — BEFORE
  // `triggers`, because a trigger's `scriptRef` is validated AT DECLARE TIME: a rule naming a script
  // with no versions in the context is refused with a 400. This map does not order the loader (a
  // plain object's key order is not a contract); the loader orders itself, and a test pins it.
  scripts: 'in-context',
  // A trigger's principal + grant are provisioned exactly like the roles: block is (N service-
  // principal/AccessProfile pairs instead of one), so it applies in the identical in-context phase,
  // under the same re-minted context-confined token.
  triggers: 'in-context',
  // Setting it requires the platform provisioning capability, which only the bootstrap credential
  // carries — the same reasoning as issuers/namespaces above. It is applied to the app context
  // itself, which the bootstrap phase already creates, so there is nothing for the in-context pass
  // to do with it.
  identityProjectionClaims: 'bootstrap',
});

export const BlueprintSchema = z
  .object({
    /** Stable blueprint id (the `--blueprint <name>` selector + idempotency key). */
    name: safeDisplayString(z.string().min(1)),
    version: safeDisplayString(z.string().min(1)),
    // NOT safeDisplayString — deliberately, after that wrap broke a real, multi-line-authored
    // blueprint's `description` in review. `description` is never interpolated into any
    // rendered plan-preview line (`buildPlan`'s header prints
    // `name`/`version`/`contextId`, never `description` — confirmed by grep, not assumed), so
    // wrapping it protected a sink that does not exist. It also actively broke real content:
    // this is exactly the field authors reach for a YAML folded (`>`) or literal (`|`) block
    // scalar to write, and clip chomping (the YAML default) always leaves exactly one trailing
    // `\n` — which `safeDisplayString` rejects as a C0 control, indistinguishable from a
    // forgery attempt. See `safeDisplayString`'s own doc for why this is a property of the
    // wrapper, not a one-off carve-out for this field alone.
    description: z.string().min(1),
    /** The app-context the profile + scoped key bind to (e.g. "mcp"). */
    contextId: z.string().regex(CONTEXT_ID_RE, {
      message:
        "contextId must be 3-31 chars, start with a lowercase letter, then lowercase letters/digits/dashes (e.g. 'mcp')",
    }),
    /**
     * Human-readable app-context name; defaults to `MCP — <name>` (see {@link contextNameOf})
     * when absent. `safeDisplayString`: `contextNameOf` renders this raw into the FIRST line of
     * every `buildPlan` summary (the `context '...' (...)` step) — a gap found after the rest
     * of this file's forgery-character pass had already shipped; same shape as
     * `name`/`version`/`description` right above it.
     */
    contextName: safeDisplayString(z.string().min(1)).optional(),
    /**
     * The deploying organization's own display name — distinct from {@link contextName}.
     * `contextName` is the blueprint author's fixed identity for the app (the same for every
     * deployer); `companyName` is meant to vary per install, typically templated from a
     * deployer-supplied `${{ inputs.x }}` value rather than hardcoded. Used for branding on
     * platform-sent correspondence (e.g. invite emails) alongside `contextName` — not a
     * replacement for it. See {@link companyNameOf}.
     *
     * `safeDisplayString`: not interpolated into any CLI plan-preview line today (confirmed —
     * `loader.ts` never reads `companyName`), but it IS forwarded to the platform for the
     * invite-email correspondence described above, a second class of human-read surface this
     * value reaches. Wrapped for the same reason as every sibling scalar identity field here.
     */
    companyName: safeDisplayString(z.string().min(1)).optional(),
    schemas: z.array(BlueprintSchemaSchema).default([]),
    accessProfile: BlueprintAccessProfileSchema,
    servicePrincipal: BlueprintServicePrincipalSchema,
    seed: z.array(BlueprintSeedRecordSchema).optional(),
    /** Optional multi-clause roles, bound to principals via `access grant --role`. */
    roles: BlueprintRolesSchema.optional(),
    /**
     * Optional roleId → `POST /v1/auth/token/assume`
     * entitlement grant, mirroring the platform's role create/update request
     * and response shape for this field. Kept separate from `roles` rather
     * than folded into a role entry — see {@link BlueprintRoleAssumableMapSchema}'s
     * own doc comment for why. Every key must name a role this blueprint
     * declares in `roles` (`lintRoleAssumable`).
     */
    roleAssumable: BlueprintRoleAssumableMapSchema.optional(),
    /**
     * Optional named `dataScope` fragments, each
     * referenceable from a role clause via `dataScopeRef: <name>` instead of
     * repeating the same map inline. Purely local authoring sugar: not a
     * provisioned resource (absent from `BLUEPRINT_FIELD_PHASES`), and never
     * survives `parseBlueprint` as a live reference — see
     * {@link expandDataScopeRefs}.
     */
    fragments: BlueprintFragmentsSchema.optional(),
    /** Optional principals ensured-exist at apply; referenced via ${{ identities.* }}. */
    identities: IdentitiesDeclSchema.optional(),
    /**
     * Optional trusted third-party IdP issuers to register (BYO-IdP token
     * exchange). Applied in the BOOTSTRAP-token phase, alongside app-context/
     * service-principal creation — NOT the in-context load (see
     * {@link BlueprintIssuerSchema}).
     */
    issuers: z.array(BlueprintIssuerSchema).optional(),
    /**
     * Optional namespaces to register before anything else needs them — see
     * {@link BlueprintNamespaceSchema}. Applied in the BOOTSTRAP-token phase,
     * alongside app-context/service-principal creation and issuers, BEFORE
     * schemas/seed (an `entityBacked` namespace's entities, and an
     * `allowedSurfaces: ['entity']` schema, both need the registration to
     * already exist). `org`/`client` need no entry — they exist already.
     */
    namespaces: z.array(BlueprintNamespaceSchema).optional(),
    /**
     * Declares which of the golden IdP-asserted claim names captured by this tenant's issuers (see
     * `issuers[].capturedClaims`) are projected, read-only, onto access profiles in THIS context.
     * Applied to the app context in the BOOTSTRAP-token phase, alongside the context's own create.
     *
     * Capture and projection are deliberately separate opt-ins: capturing a claim stores it against
     * the user, projecting it exposes it on a profile in this context. Declaring a name here that no
     * issuer captures is not an error — it simply never fills.
     *
     * <p><b>Fills once, then freezes.</b> A profile's projection is written the first time a sign-in
     * for that principal can supply a value — usually at profile creation, but for an INVITED member
     * not until they actually accept and sign in, since there is nothing to project before that.
     * Once filled it never updates again, even if this declaration or the underlying identity data
     * changes later. So editing this list affects only profiles that have not been filled yet; it is
     * not a backfill, and re-applying a blueprint does not re-project existing profiles.
     *
     * <p><b>Authority.</b> Setting this needs the platform provisioning capability — the same
     * authority the bootstrap credential already uses to register issuers and declare namespaces.
     * An ordinary `app-contexts:u` credential may rename its own context but may not opt it into
     * projecting IdP-golden identity data, so this field is only settable on the bootstrap phase's
     * own token, never on the per-context wildcard the in-context load runs under.
     *
     * <p>Omit to leave the context's existing declaration unchanged; declare an empty list to
     * disable future projection. Capped at 20 entries, each a non-blank name of at most 64
     * characters, duplicates rejected — the same bounds `capturedClaims` carries.
     *
     * <p><b>Applies only when this blueprint CREATES the app context.</b> The condition is the
     * context being created, not the apply being the first one: creating the context separately
     * beforehand means even the first apply does not set it. Re-applying against a context that
     * already exists does not change it, in either direction. Edit the declaration on an existing context through the platform API instead. (A
     * tool applying this blueprint could in principle reconcile it, but doing so also overwrites the
     * context's name and needs a broader scope — see `@vectros-ai/cli`'s own notes.)
     */
    identityProjectionClaims: z
      .array(
        // safeDisplayString: rendered raw into buildPlan's context step (`identity projection:
        // [...]`) — same rendered-plan-preview shape as `capturedClaims` (its structural pair,
        // and fixed alongside it originally), missed here in the first pass; same ordering rule
        // applies (safeDisplayString's own `.refine` before the blank-name `.refine` below,
        // both after `.max` since `.refine` returns a ZodEffects with no `.max`).
        safeDisplayString(
          z.string().max(MAX_CAPTURED_CLAIM_NAME_LENGTH, {
            message: `an identityProjectionClaims entry must be at most ${MAX_CAPTURED_CLAIM_NAME_LENGTH} characters`,
          }),
        ).refine((name) => name.trim().length > 0, {
          message: 'an identityProjectionClaims entry must be a non-blank claim name',
        }),
      )
      .max(MAX_CAPTURED_CLAIMS, {
        message: `identityProjectionClaims accepts at most ${MAX_CAPTURED_CLAIMS} entries`,
      })
      .optional()
      .superRefine(assertNoDuplicateClaimNames('identityProjectionClaims')),
    /**
     * Optional scripts this blueprint SHIPS: scriptName -> `{ source, declaredInputContract? }`.
     *
     * Distinct from a trigger's `scriptRef`, which only NAMES a script and requires it to already
     * exist. Pushed BEFORE the `triggers` block, because a `scriptRef` is validated at declare time.
     *
     * Each entry is the CURRENT SOURCE for that name, not a version — the platform assigns versions
     * itself and they are immutable. Re-applying an unchanged blueprint pushes nothing; editing
     * `source` pushes a new version, which every `version: 'latest'` rule then picks up.
     */
    scripts: BlueprintScriptsSchema.optional(),
    /**
     * Optional async trigger rules: triggerName -> declaration.
     *
     * These FIRE. A record write on a schema that opts in via `capabilities.triggersEnabled`
     * dispatches the rule's script, which runs asynchronously in a sandbox under the grant declared
     * here — so a trigger's `allowedActions`/`dataScope`/`capabilities` (or the roles its `roleIds`
     * composes) are live authority, not a declaration awaiting a future release. Author the grant as
     * narrowly as you would any other credential's.
     */
    triggers: BlueprintTriggersSchema.optional(),
  })
  .strict()
  .superRefine((bp, ctx) => {
    lintSelfTokenPlacement(bp, ctx);
    lintIdentityRefs(bp, ctx);
    lintIdentityOverrides(bp, ctx);
    lintNamespacedScopeArrays(bp, ctx);
    lintDataScopeKeys(bp, ctx);
    lintReservedFilterableFieldIds(bp, ctx);
    lintExpectedScopeDims(bp, ctx);
    lintDataScopeRefs(bp, ctx);
    lintRoleAssumable(bp, ctx);
    lintAccessProfileRoleIds(bp, ctx);
    lintSeedSurfaces(bp, ctx);
    lintIdentitySurfaces(bp, ctx);
    lintIssuerContext(bp, ctx);
    lintNamespaces(bp, ctx);
    lintTriggers(bp, ctx);
    lintTriggerFields(bp, ctx);
    lintScripts(bp, ctx);
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
/** A single namespace-registration entry, applied in the loader's bootstrap-token phase. */
export type BlueprintNamespace = z.infer<typeof BlueprintNamespaceSchema>;
export type BlueprintRoleClause = z.infer<typeof BlueprintRoleClauseSchema>;
export type BlueprintRoles = z.infer<typeof BlueprintRolesSchema>;
/** A single trigger declaration — the value type of `triggers[triggerName]`. */
export type BlueprintTriggerEntry = z.infer<typeof BlueprintTriggerEntrySchema>;
/** The top-level `triggers` map. */
export type BlueprintTriggers = z.infer<typeof BlueprintTriggersSchema>;
/** A single shipped-script declaration — the value type of `scripts[scriptName]`. */
export type BlueprintScriptEntry = z.infer<typeof BlueprintScriptEntrySchema>;
/** The top-level `scripts` map: scriptName -> declaration. */
export type BlueprintScripts = z.infer<typeof BlueprintScriptsSchema>;
/** A named, reusable `dataScope` map, referenced via a clause's `dataScopeRef`. */
export type BlueprintFragments = z.infer<typeof BlueprintFragmentsSchema>;
/** One role's `POST /v1/auth/token/assume` entitlement grant — the value type of `roleAssumable[roleId]`. */
export type BlueprintRoleAssumable = z.infer<typeof BlueprintRoleAssumableSchema>;
/** The top-level `roleAssumable` map: roleId → grant. */
export type BlueprintRoleAssumableMap = z.infer<typeof BlueprintRoleAssumableMapSchema>;
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
 *
 * The returned `Blueprint` has already had every
 * `dataScopeRef` expanded to its fragment's literal `dataScope`
 * ({@link expandDataScopeRefs}) — a caller (e.g. `@vectros-ai/cli`'s loader)
 * never sees a `dataScopeRef` survive past this function.
 */
export function parseBlueprint(input: unknown): Blueprint {
  const result = BlueprintSchema.safeParse(input);
  if (!result.success) {
    const issues = toBlueprintIssues(result.error);
    throw new BlueprintValidationError(`Malformed blueprint:\n${renderIssues(issues)}`, issues);
  }
  return expandDataScopeRefs(result.data);
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

/**
 * The deploying organization's own display name, or `undefined` when the blueprint doesn't declare
 * {@link Blueprint.companyName}. Deliberately has NO forced default (unlike {@link contextNameOf}'s
 * `MCP — <name>` fallback) — an absent company name should mean "not supplied," not a placeholder
 * string baked into provisioned data.
 */
export function companyNameOf(blueprint: Blueprint): string | undefined {
  return blueprint.companyName;
}
