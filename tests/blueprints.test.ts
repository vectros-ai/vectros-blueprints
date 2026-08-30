/**
 * Blueprint format tests — structural validation + the bundled-library
 * guard. (The scope-gate / security tests live in @vectros-ai/cli, which
 * owns enforcement.)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseBlueprint,
  parseBlueprintJson,
  contextNameOf,
  companyNameOf,
  BlueprintValidationError,
  type Blueprint,
} from '../src/types.js';
import { BUNDLED_BLUEPRINTS, BLUEPRINT_NAMES, getBlueprint } from '../src/index.js';

/** Every field name a lookup entry references — one for a plain/bare entry, 2-3 for a composite. */
function lookupLegs(lf: string | { fieldName?: string; fieldNames?: string[] }): string[] {
  if (typeof lf === 'string') return [lf];
  if (lf.fieldNames !== undefined) return lf.fieldNames;
  return lf.fieldName !== undefined ? [lf.fieldName] : [];
}

function minimal(overrides: Partial<Blueprint> = {}): Blueprint {
  return {
    name: 'demo',
    version: '1.0.0',
    description: 'demo blueprint',
    contextId: 'mcp',
    schemas: [],
    accessProfile: { allowedActions: ['records:r'] },
    servicePrincipal: { externalId: 'demo-sp', displayName: 'Demo SP' },
    ...overrides,
  };
}

test('parseBlueprint accepts a minimal well-formed blueprint', () => {
  const b = parseBlueprint(minimal());
  assert.equal(b.name, 'demo');
  assert.equal(b.contextId, 'mcp');
  assert.deepEqual(b.schemas, []);
});

test('parseBlueprint rejects non-objects + missing required fields', () => {
  assert.throws(() => parseBlueprint(null), BlueprintValidationError);
  assert.throws(() => parseBlueprint('nope'), BlueprintValidationError);
  const { name, ...noName } = minimal();
  void name;
  assert.throws(() => parseBlueprint(noName), BlueprintValidationError);
});

test('parseBlueprint rejects unknown top-level fields (strict) + empty allowedActions', () => {
  assert.throws(() => parseBlueprint({ ...minimal(), bonus: 1 }), BlueprintValidationError);
  assert.throws(
    () => parseBlueprint(minimal({ accessProfile: { allowedActions: [] } })),
    BlueprintValidationError,
  );
});

test('parseBlueprint enforces the contextId format', () => {
  assert.throws(() => parseBlueprint(minimal({ contextId: 'X' })), BlueprintValidationError);
  assert.throws(() => parseBlueprint(minimal({ contextId: '1mcp' })), BlueprintValidationError);
  assert.doesNotThrow(() => parseBlueprint(minimal({ contextId: 'task-tracker-1' })));
});

test('parseBlueprintJson rejects bad JSON, round-trips a serialized blueprint', () => {
  assert.throws(() => parseBlueprintJson('{nope'), BlueprintValidationError);
  assert.equal(parseBlueprintJson(JSON.stringify(minimal({ name: 'rt' }))).name, 'rt');
});

test('contextNameOf prefers explicit contextName, else derives from name', () => {
  assert.equal(contextNameOf(minimal({ contextName: 'Custom' })), 'Custom');
  assert.equal(contextNameOf(minimal({ name: 'widgets' })), 'MCP — widgets');
});

test('companyName is accepted as an optional top-level field, sibling to contextName', () => {
  const b = parseBlueprint(minimal({ contextName: 'Widgets App', companyName: 'Acme Corp' }));
  assert.equal(b.contextName, 'Widgets App');
  assert.equal(b.companyName, 'Acme Corp');
  // The two fields are genuinely distinct — one isn't derived from or overwriting the other.
  assert.notEqual(b.contextName, b.companyName);
});

test('companyName is genuinely optional — absent is valid, unlike contextId/name', () => {
  const b = parseBlueprint(minimal());
  assert.equal(b.companyName, undefined);
});

test('companyName rejects an empty string (min(1), same posture as contextName)', () => {
  assert.throws(() => parseBlueprint(minimal({ companyName: '' })), BlueprintValidationError);
});

test('companyNameOf returns the field verbatim, with NO forced default unlike contextNameOf', () => {
  assert.equal(companyNameOf(minimal({ companyName: 'Acme Corp' })), 'Acme Corp');
  // Deliberate asymmetry vs contextNameOf's `MCP — <name>` fallback: an absent companyName
  // means "not supplied," not a placeholder baked into provisioned data.
  assert.equal(companyNameOf(minimal()), undefined);
});

test('bundled registry includes the curated library + getBlueprint works', () => {
  assert.ok(BUNDLED_BLUEPRINTS.length >= 4);
  assert.ok(BLUEPRINT_NAMES.includes('task-management'));
  assert.ok(BLUEPRINT_NAMES.includes('agentic-sdlc'));
  assert.ok(BLUEPRINT_NAMES.includes('second-brain'));
  assert.ok(BLUEPRINT_NAMES.includes('clinical-intake'));
  assert.ok(getBlueprint('task-management'));
  assert.equal(getBlueprint('does-not-exist'), undefined);
});

test('clinical-intake declares sensitive PHI fields (the redaction exemplar)', () => {
  const bp = getBlueprint('clinical-intake')!;
  const fields = bp.schemas[0].fields;
  const sensitive = fields.filter((f) => f.sensitive).map((f) => f.fieldId);
  // The PHI fields that demonstrate redact-at-write / search-exclusion.
  assert.ok(sensitive.includes('ssn'));
  assert.ok(sensitive.includes('clinicalNote'));
  // The working/searchable fields must NOT be sensitive (else the demo can't search).
  assert.ok(!fields.find((f) => f.fieldId === 'presentingConcern')?.sensitive);
  // No reveal scope on the profile — the demo key cannot un-redact.
  assert.ok(!bp.accessProfile.allowedActions!.some((a) => a.includes(':s')));
});

test('bundled blueprint names are unique', () => {
  assert.equal(new Set(BLUEPRINT_NAMES).size, BLUEPRINT_NAMES.length);
});

test('GUARD: a sensitive field is never searchable, never range/sort-indexed (but MAY be an equality blind-index lookup)', () => {
  // A sensitive field is destroyed before the audit snapshot and EXCLUDED from the
  // search index — so marking it `searchable` is a contradiction (it can never be
  // found that way). It MAY, however, be an EQUALITY lookup: the platform HMAC's the
  // value into a per-tenant blind index, so exact find-by-value works WITHOUT storing
  // the value in the clear (clinical-intake's find-by-client-name). What's forbidden,
  // and permanent if shipped wrong, is ordering a blind hash: a sensitive lookup must
  // never be `rangeEnabled`, and no lookup's `sortBy` may name a sensitive field
  // (its plaintext would be written into a GSI sort key — the platform rejects both).
  for (const b of BUNDLED_BLUEPRINTS) {
    for (const s of b.schemas) {
      const sensitiveIds = new Set(s.fields.filter((f) => f.sensitive).map((f) => f.fieldId));
      for (const f of s.fields) {
        if (f.sensitive) {
          assert.ok(!f.searchable, `${b.name}.${s.typeName}.${f.fieldId}: sensitive field must not be searchable`);
        }
      }
      for (const lf of s.lookupFields ?? []) {
        if (typeof lf === 'string') continue;
        // Per-leg, not per-entry: a composite's sensitivity/rangeEnabled
        // constraint applies to EVERY leg, not just a single fieldName.
        const legs = lookupLegs(lf);
        for (const leg of legs) {
          if (sensitiveIds.has(leg)) {
            assert.ok(
              !lf.rangeEnabled,
              `${b.name}.${s.typeName}.${leg}: a sensitive lookup cannot be rangeEnabled (a blind hash is not orderable)`,
            );
          }
        }
        assert.ok(
          !(lf.sortBy && sensitiveIds.has(lf.sortBy)),
          `${b.name}.${s.typeName}.${legs.join(',')}: sortBy must not name a sensitive field (its plaintext would land in a sort key)`,
        );
      }
    }
  }
});

test('AUDIT: every bundled schema stays within the 7-slot equality-lookup budget', () => {
  // The platform gives each schema 7 fast equality-lookup GSI slots.
  // Equality (non-range) lookups consume slots in declaration order; range-enabled
  // lookups use a relationship row instead and do NOT count. A schema beyond the
  // budget is rejected at createSchema unless each over-budget field opts in with
  // allowOverflow. Audit it here so the bundled library can never silently exceed it.
  const MAX_EQUALITY_SLOTS = 7;
  for (const b of BUNDLED_BLUEPRINTS) {
    for (const s of b.schemas) {
      const equality = (s.lookupFields ?? []).filter(
        (lf) => typeof lf === 'string' || (!lf.rangeEnabled && !lf.allowOverflow),
      );
      assert.ok(
        equality.length <= MAX_EQUALITY_SLOTS,
        `${b.name}.${s.typeName}: ${equality.length} equality lookups exceed the ${MAX_EQUALITY_SLOTS}-slot budget`,
      );
    }
  }
});

test('SHOWCASE: clinical-intake finds an intake by PHI via a sensitive blind-index lookup', () => {
  const ci = getBlueprint('clinical-intake')!;
  const intake = ci.schemas[0];
  const clientName = intake.fields.find((f) => f.fieldId === 'clientName');
  assert.ok(clientName?.sensitive, 'clientName is a sensitive (PHI) field');
  const asLookup = (intake.lookupFields ?? []).some(
    (lf) => (typeof lf === 'string' ? lf : lf.fieldName) === 'clientName',
  );
  assert.ok(asLookup, 'clientName is declared as a lookup field (blind-index exact match)');
});

test('SHOWCASE: bundled date fields are range-queryable and re-model nothing that sorts wrong', () => {
  // Every range-enabled bundled lookup names a SORT-SAFE field: a `date` (ISO-8601, lexical
  // order == chronological) or a `number` (agentic-sdlc `memory.priority` band — the
  // platform's encodeSortableValue lexically encodes both). Pins the audit decision that
  // ordinal enum STRINGS (e.g. task priority low<urgent) are deliberately left as equality,
  // NOT range — they don't sort lexically; a numeric band does.
  const rangeFields: string[] = [];
  for (const b of BUNDLED_BLUEPRINTS) {
    for (const s of b.schemas) {
      for (const lf of s.lookupFields ?? []) {
        // rangeEnabled is refused on a composite ('fieldNames') lookup (schema-enforced), so a
        // range-enabled entry always has a single fieldName — but that's a runtime invariant,
        // not one TS can see through the optional type, hence the explicit guard.
        if (typeof lf === 'string' || !lf.rangeEnabled || lf.fieldName === undefined) continue;
        rangeFields.push(lf.fieldName);
        const fld = s.fields.find((f) => f.fieldId === lf.fieldName);
        assert.ok(
          fld?.fieldType === 'date' || fld?.fieldType === 'number',
          `${b.name}.${s.typeName}.${lf.fieldName}: range lookups are reserved for sort-safe types (date | number); saw ${fld?.fieldType}`,
        );
      }
    }
  }
  assert.ok(rangeFields.length >= 4, `expected the range showcase across blueprints, saw ${rangeFields.join(', ')}`);
});

test('SHOWCASE: agentic-sdlc links a convention to its decision via a typed, cross-surface reference', () => {
  const sdlc = getBlueprint('agentic-sdlc')!;
  const convention = sdlc.schemas.find((s) => s.typeName === 'convention')!;
  const ref = convention.fields.find((f) => f.fieldId === 'establishedBy');
  assert.equal(ref?.fieldType, 'reference');
  assert.equal(ref?.targetTypeName, 'decision');
  assert.equal(ref?.targetSurface, 'document'); // record → document: the cross-surface edge
  // declared as an equality lookup so "conventions established by decision X" enumerates
  const isLookup = (convention.lookupFields ?? []).some(
    (lf) => (typeof lf === 'string' ? lf : lf.fieldName) === 'establishedBy',
  );
  assert.ok(isLookup, 'establishedBy is an equality lookup');
  // (no seed-resolution sub-case here — agentic-sdlc ships with no seed data, unlike the
  // blueprint this test previously showcased; the schema-shape assertions above are the
  // durable coverage that matters.)
});

test('GUARD: no bundled schema declares a reserved identifier as a lookup field', () => {
  // externalId and the ownership ids are first-class identifiers with their own
  // finders — the platform REJECTS redeclaring them as schema lookups (a redeclared
  // index is written-but-unreachable, billed yet unqueryable). A bundled blueprint
  // that ships one fails `vectros bootstrap` against the live API. Pin it so the
  // whole class can't regress silently (one bundled schema once slipped through).
  const RESERVED = new Set(['externalId', 'partnerUserId', 'userId', 'clientId', 'orgId']);
  for (const b of BUNDLED_BLUEPRINTS) {
    for (const s of b.schemas) {
      for (const lf of s.lookupFields ?? []) {
        // Every leg, not just the leading one — a composite carrying a reserved name in a
        // NON-leading position is exactly the shape a leading-only check would miss.
        for (const name of lookupLegs(lf)) {
          assert.ok(
            !RESERVED.has(name),
            `${b.name}.${s.typeName}: '${name}' is a reserved identifier and must not be a lookup field — look it up via its first-class finder`,
          );
        }
      }
    }
  }
});

test('second-brain pins inference:r (the scope behind its documented rag_ask flow)', () => {
  // The walkthrough sells "ask your notes" via rag_ask; the data-plane scope-gate guard
  // only checks data-plane-ness, so without this a regression dropping inference:r would
  // break the documented flow with no failing test.
  const sb = getBlueprint('second-brain')!;
  assert.ok(sb.accessProfile.allowedActions!.includes('inference:r'));
});

test('GUARD: every bundled blueprint is structurally valid', () => {
  for (const b of BUNDLED_BLUEPRINTS) {
    assert.doesNotThrow(() => parseBlueprint(b), `bundled blueprint '${b.name}' must parse`);
  }
});

test('GUARD: every bundled field uses a platform-supported fieldType', () => {
  // The blueprint format keeps fieldType free-form (forward-compat), but the live
  // partner API rejects unknown types at createSchema time — e.g. `string[]` →
  // 400 "Allowed: [enum, boolean, number, array, reference, date, object, string]".
  // The fake-client harness can't catch that, so guard it here at change-time
  // (a string array is `array`, not `string[]`).
  const ALLOWED = new Set(['enum', 'boolean', 'number', 'array', 'reference', 'date', 'object', 'string']);
  for (const b of BUNDLED_BLUEPRINTS) {
    for (const s of b.schemas) {
      for (const f of s.fields) {
        assert.ok(
          ALLOWED.has(f.fieldType),
          `${b.name}.${s.typeName}.${f.fieldId}: fieldType '${f.fieldType}' is not platform-supported`,
        );
      }
    }
  }
});

test('task-management requests exactly the documented least-privilege scopes', () => {
  const tm = getBlueprint('task-management')!;
  assert.deepEqual(tm.accessProfile.allowedActions, [
    'records:r',
    'records:c',
    'records:u',
    'search:r',
    'schemas:r',
  ]);
  assert.ok(!tm.accessProfile.allowedActions.includes('records:d'));
});

test('agentic-sdlc: 11 schemas split content (documents) vs structure (records) + isolated memory + its staging area', () => {
  const bp = getBlueprint('agentic-sdlc')!;
  const typeNames = bp.schemas.map((s) => s.typeName).sort();
  assert.deepEqual(typeNames, [
    'candidate',
    'control',
    'convention',
    'decision',
    'design',
    'gotcha',
    'memory',
    'postmortem',
    'reference',
    'runbook',
    'term',
  ]);
  // Content-dominant artifacts bind the DOCUMENT surface (body is the artifact).
  const documents = ['decision', 'design', 'reference', 'runbook', 'postmortem'];
  // Structure-dominant records (typed fields are the artifact). `memory` is a
  // record too, but a DIFFERENT genre — per-principal isolated agent memory (the
  // private tier), distinct from the team's curated shared knowledge above.
  const records = ['control', 'convention', 'gotcha', 'term', 'memory', 'candidate'];
  const byType = new Map(bp.schemas.map((s) => [s.typeName, s]));
  for (const t of documents) {
    assert.deepEqual(byType.get(t)!.allowedSurfaces, ['document'], `${t} must bind the document surface`);
  }
  for (const t of records) {
    assert.equal(byType.get(t)!.allowedSurfaces, undefined, `${t} is a record (defaults to ['record'])`);
  }
  /**
   * Everything RECALLABLE is HYBRID (keyword + semantic recall is the whole pitch)
   * — and `candidate` is the deliberate exception, not an oversight.
   *
   * A candidate is an UNVERIFIED proposal. Store-only (`NONE`) means it is never
   * indexed, so no search and no grounded answer can return it: the separation
   * between unchecked claims and curated knowledge is enforced by the platform,
   * not by every caller remembering a filter. Flip this to HYBRID and the corpus
   * of unverified claims starts competing with the KB for retrieval slots.
   *
   * Asserted as an exhaustive partition rather than a loop with a skip, so ADDING
   * a schema forces a conscious choice about which side it lands on.
   */
  const searchable = bp.schemas.filter((s) => s.typeName !== 'candidate');
  for (const s of searchable) assert.equal(s.indexMode, 'HYBRID', `${s.typeName} should be HYBRID`);
  assert.equal(searchable.length, 10, 'exactly one schema is non-searchable');
  assert.equal(byType.get('candidate')!.indexMode, 'NONE',
    'candidate MUST be store-only — unverified proposals must never be reachable by search');
  // The retired types from earlier drafts are gone.
  for (const gone of ['handoff', 'incident', 'doc']) {
    assert.ok(!byType.has(gone), `${gone} should no longer be a schema`);
  }
});

/**
 * `candidate`'s composite lookup, pinned by SHAPE and by ORDER.
 *
 * Both halves are migration-locked once a record is written, and the order is the half a
 * reader is likely to "tidy". `sessionId` MUST lead: the leading field becomes the partition
 * key, so leading with `disposition` — a four-value enum — would sort every candidate ever
 * proposed into four partitions. Reversing the pair is silent (identical field set, valid
 * declaration, tests that only check membership stay green) and unfixable afterwards, so the
 * assertion is on the exact array, not on its contents.
 */
test('agentic-sdlc: `candidate` declares a (sessionId, disposition) composite lookup, in that order', () => {
  const bp = getBlueprint('agentic-sdlc')!;
  const candidate = bp.schemas.find((s) => s.typeName === 'candidate')!;
  const lookups = candidate.lookupFields ?? [];

  // Narrow to entries that actually carry `fieldNames`, re-stating it as present so the
  // assertions below read it directly. `Extract<typeof lf, { fieldNames: string[] }>` cannot
  // do this: the union member declares `fieldNames?`, so extracting on a REQUIRED property
  // matches no member and collapses to `never` — which then types the whole array as
  // `never[]` and every read off it as an error. Invisible here until `tsc` is run, because
  // these suites execute through tsx with the types stripped.
  const composites = lookups.flatMap((lf) =>
    typeof lf === 'object' && lf.fieldNames !== undefined
      ? [{ ...lf, fieldNames: lf.fieldNames }]
      : [],
  );
  assert.equal(composites.length, 1, 'exactly one composite lookup');
  assert.deepEqual(composites[0].fieldNames, ['sessionId', 'disposition'],
    'sessionId must LEAD — it becomes the partition key, and the order is migration-locked');

  // No `sortBy`: the default (record creation time) is already the order the review queue
  // reads in. Naming `proposedAt` would order by the worker's queue-time clock instead.
  assert.equal(composites[0].sortBy, undefined,
    'composite must not name a sortBy — the createdAt default is the intended order');

  // The plain `sessionId` lookup is kept DELIBERATELY even though the composite's leading
  // run also answers it: under a partial tuple the unspecified field joins the ordering, so
  // results come back grouped by `disposition` rather than as one oldest-first run.
  const plain = lookups.map((lf) => (typeof lf === 'string' ? lf : (lf as { fieldName?: string }).fieldName));
  assert.ok(plain.includes('sessionId'),
    'the plain sessionId lookup must remain — the composite groups a partial tuple, it does not sequence it');
  assert.ok(plain.includes('disposition'), 'the queue-wide pending lookup must remain');

  // Legs must be declarable AS legs: present, and neither array/object-typed nor rangeEnabled.
  const fieldsById = new Map(candidate.fields.map((f) => [f.fieldId, f]));
  for (const leg of composites[0].fieldNames) {
    const f = fieldsById.get(leg);
    assert.ok(f, `composite leg '${leg}' must be a declared field`);
    assert.ok(!['array', 'object'].includes(f!.fieldType), `leg '${leg}' must not be array/object-typed`);
    const rangeDeclared = lookups.some(
      (lf) => typeof lf === 'object' && (lf as { fieldName?: string }).fieldName === leg
        && (lf as { rangeEnabled?: boolean }).rangeEnabled,
    );
    assert.equal(rangeDeclared, false, `leg '${leg}' must not also be declared rangeEnabled`);
  }

  // A composite is record-only at the platform; `candidate` qualifies by omitting surfaces.
  const surfaces = (candidate as { allowedSurfaces?: string[] }).allowedSurfaces;
  assert.ok(surfaces === undefined || (surfaces.length === 1 && surfaces[0] === 'record'),
    'a schema declaring a composite must be record-only');
});

test('agentic-sdlc: document schemas declare NO typed `title` field (a document carries an intrinsic title)', () => {
  // A document's title is intrinsic (the ingest title, surfaced as document.title) —
  // declaring a typed `title` field on a document schema is redundant AND a footgun:
  // the top-level ingest `title` does not satisfy a typed required `title` field, so
  // bootstrap/ingest 400s ("title cannot be empty") unless the title is duplicated
  // into the payload. Documents therefore declare only the metadata BEYOND title/body.
  // Records (no intrinsic title) may keep a `title` field where it's the headline.
  const bp = getBlueprint('agentic-sdlc')!;
  const byType = new Map(bp.schemas.map((s) => [s.typeName, s]));
  for (const t of ['decision', 'design', 'reference', 'runbook', 'postmortem']) {
    assert.ok(
      !byType.get(t)!.fields.some((f) => f.fieldId === 'title'),
      `${t} (document) must NOT declare a typed 'title' field — it has an intrinsic title`,
    );
  }
});

test('agentic-sdlc: SHOWCASE — a cross-surface knowledge graph (records → documents + doc → doc)', () => {
  const bp = getBlueprint('agentic-sdlc')!;
  const byType = new Map(bp.schemas.map((s) => [s.typeName, s]));
  const ref = (type: string, field: string) =>
    byType.get(type)!.fields.find((f) => f.fieldId === field);

  // Every edge as (schema.field) → targetTypeName. Targets are all DOCUMENTS, so the
  // records (control/convention/term) form record→document edges, and the documents
  // form document→document edges. That cross-surface graph is the showcase.
  const edges: Array<[string, string, string]> = [
    ['decision', 'supersedes', 'decision'], // doc → doc (the ADR chain)
    ['design', 'relatedDecision', 'decision'],
    ['design', 'supersedes', 'design'],
    ['reference', 'relatedDecision', 'decision'],
    ['runbook', 'bornFrom', 'postmortem'],
    ['runbook', 'relatedDecision', 'decision'],
    ['postmortem', 'relatedDecision', 'decision'],
    ['control', 'verifiedBy', 'runbook'], // record → document (the compliance-evidence edge)
    ['control', 'relatedDecision', 'decision'], // record → document
    ['convention', 'establishedBy', 'decision'], // record → document
    ['term', 'relatedDecision', 'decision'], // record → document
  ];
  for (const [type, field, target] of edges) {
    const f = ref(type, field);
    assert.equal(f?.fieldType, 'reference', `${type}.${field} must be a reference`);
    assert.equal(f?.targetTypeName, target, `${type}.${field} must target ${target}`);
    // Every edge targets a DOCUMENT-surface type — so targetSurface must say so
    // (else it 400s at createSchema / resolves the wrong surface).
    assert.equal(f?.targetSurface, 'document', `${type}.${field} must set targetSurface: 'document'`);
    assert.equal(f?.targetField, 'externalId', `${type}.${field} resolves by externalId`);
    const isLookup = (byType.get(type)!.lookupFields ?? []).some(
      (lf) => (typeof lf === 'string' ? lf : lf.fieldName) === field,
    );
    assert.ok(isLookup, `${type}.${field} should be an equality lookup (forward link query)`);
  }
  // The defining feature: at least the record→document edges (control/convention/term
  // → a document). Confirm the records carry references into the document surface.
  const recordToDoc = edges.filter(([t]) => ['control', 'convention', 'term'].includes(t));
  assert.ok(recordToDoc.length >= 4, 'expected record→document edges (control/convention/term → documents)');
});

test('agentic-sdlc: SHOWCASE — a governance `control` (record) is proven by a `runbook` (document)', () => {
  const control = getBlueprint('agentic-sdlc')!.schemas.find((s) => s.typeName === 'control')!;
  assert.equal(control.allowedSurfaces, undefined, 'control is a record');
  // The policy → implementation spectrum in one filterable field.
  const kind = control.fields.find((f) => f.fieldId === 'kind');
  assert.deepEqual(kind?.enumValues, ['policy', 'standard', 'control']);
  // Inline evidence (free text) + the typed, cross-surface runbook that proves it.
  assert.ok(control.fields.some((f) => f.fieldId === 'evidence'));
  const verifiedBy = control.fields.find((f) => f.fieldId === 'verifiedBy');
  assert.equal(verifiedBy?.targetTypeName, 'runbook');
  assert.equal(verifiedBy?.targetSurface, 'document', 'verifiedBy is a record→document edge');
});

test('agentic-sdlc: `convention` keeps rule / why / howToApply as separate fields', () => {
  // The durable operating-memory: the rule, the reasoning, and the application are
  // distinct fields (not one prose blob) so an agent recalls each independently.
  const convention = getBlueprint('agentic-sdlc')!.schemas.find((s) => s.typeName === 'convention')!;
  const ids = convention.fields.map((f) => f.fieldId);
  for (const f of ['rule', 'why', 'howToApply']) {
    assert.ok(ids.includes(f), `convention must have a distinct '${f}' field`);
  }
  // All three are searchable (recalled by meaning).
  for (const f of ['rule', 'why', 'howToApply']) {
    assert.equal(convention.fields.find((x) => x.fieldId === f)?.searchable, true, `${f} searchable`);
  }
});

test('agentic-sdlc: pins inference:r + the document/folder scopes its documented flows need', () => {
  const actions = getBlueprint('agentic-sdlc')!.accessProfile.allowedActions!;
  // Grounded rag_ask over rationale/lesson bodies.
  assert.ok(actions.includes('inference:r'));
  // The SAME scoped key ingests narrative docs (the `doc` surface + folders).
  for (const a of ['documents:r', 'documents:c', 'folders:r', 'folders:c']) {
    assert.ok(actions.includes(a), `agentic-sdlc must request ${a} (the doc-ingest path)`);
  }
});

test('agentic-sdlc: SHOWCASE — `term` (glossary) uses a UNIQUE exact-lookup', () => {
  // The one uniqueness-constraint exemplar in the library: exact "define X" + a
  // one-record-per-term guarantee.
  const term = getBlueprint('agentic-sdlc')!.schemas.find((s) => s.typeName === 'term')!;
  const termLookup = (term.lookupFields ?? []).find(
    (lf) => typeof lf !== 'string' && lf.fieldName === 'term',
  );
  assert.ok(termLookup && typeof termLookup !== 'string' && termLookup.unique === true, 'term is a unique lookup');
  assert.equal(term.fields.find((f) => f.fieldId === 'term')?.renderHints?.displayField, true, 'term is the display field');
});

test('agentic-sdlc: requests EXACTLY its documented least-privilege scopes (the broadest bundled profile, pinned)', () => {
  // This is the most-copied exemplar and the broadest profile in the library (11 scopes
  // incl. documents:c/documents:u/folders:c). documents:u is the reversible curation
  // scope (archive + body re-ingest); documents:d is deliberately ABSENT (editor-only).
  // Pin the exact array (mirrors the task-management pin) so a stray scope — a reorder,
  // an unintended documents:d, or inference:c — is caught.
  assert.deepEqual(getBlueprint('agentic-sdlc')!.accessProfile.allowedActions, [
    'records:r',
    'records:c',
    'records:u',
    'search:r',
    'schemas:r',
    'inference:r',
    'documents:r',
    'documents:c',
    'documents:u',
    'folders:r',
    'folders:c',
  ]);
});

test('agentic-sdlc: editor role = service-key data plane PLUS hard delete (the human-owner join target)', () => {
  // The empty-app-after-bootstrap fix: `bootstrap` never grants the signed-in
  // human owner an access profile, so the data-plane app's switcher (which lists
  // only contexts the user holds an active profile in) shows nothing. The blueprint
  // declares a reusable `editor` role the owner binds to themselves post-bootstrap
  // (`vectros access grant --role editor`). The trusted human owner gets the full
  // data plane: every action the service key has, PLUS hard delete — the service
  // key itself deliberately lacks delete and archives (soft-retract) instead.
  const bp = getBlueprint('agentic-sdlc')!;
  const editor = bp.roles?.editor;
  assert.ok(editor, 'agentic-sdlc must declare an `editor` role for the owner join');
  assert.equal(editor!.length, 1, 'the editor role is a single clause');
  const editorActions = editor![0].allowedActions;
  // Superset of the service-key set — a human curator can do everything the agent can.
  for (const a of bp.accessProfile.allowedActions!) {
    assert.ok(editorActions.includes(a), `editor role must include the service-key action ${a}`);
  }
  // PLUS hard delete across the data plane (the whole point of the human-owner role).
  for (const del of ['records:d', 'documents:d', 'folders:d']) {
    assert.ok(editorActions.includes(del), `editor role must grant ${del}`);
  }
  // No dataScope dimensions: the owner sees + deletes across the whole context (not an
  // ownership slice). A per-user ownership-restricted delete is a separate concern (needs
  // an identity on the credential) and is intentionally NOT modeled here. `dataScope: {}`
  // (present, empty) is the explicit marker for this and is equally "unscoped" to `undefined`.
  assert.deepEqual(editor![0].dataScope ?? {}, {}, 'editor role is unscoped (whole-context access)');
  // Still data-plane only: no control-plane action leaks in via the role.
  assert.ok(
    !editorActions.some((a) => a.startsWith('provisioning') || a.startsWith('app-contexts') || a.includes('users:') || a.includes('orgs:') || a.includes('clients:') || a.includes('keys:') || a.includes('profiles:') || a.includes('billing') || a.includes('admin')),
    'editor role carries no control-plane action',
  );
});

test('agentic-sdlc: the `member` role composes two memory tiers (shared KB + private) as UNIONed clauses', () => {
  const bp = getBlueprint('agentic-sdlc')!;
  const member = bp.roles?.member;
  assert.ok(member, 'agentic-sdlc must declare a `member` role');
  assert.equal(member!.length, 2, 'member is two clauses: shared-KB recall + private memory');

  // Clause 1 — the CURATED shared KB (+ semantic recall). UNSCOPED, but safe:
  // TYPE-SCOPED away from `memory`, and search/inference admission is per-row
  // gated by the clause's typed record grants — so recall admits only the
  // curated types + documents, never any principal's private memory.
  const shared = member![0];
  // `dataScope: {}` (present, empty) is the explicit marker for this and is
  // equally "unscoped" to `undefined`.
  assert.deepEqual(shared.dataScope ?? {}, {}, 'shared-KB clause is UNSCOPED (recall bounded by per-type grants, not by org)');
  for (const a of shared.allowedActions) {
    assert.ok(a !== 'records:r', 'shared-read must be TYPE-SCOPED, never blanket records:r');
    assert.ok(!/^records:[a-z]+:memory$/.test(a), `shared clause must not touch the memory type (${a})`);
  }
  for (const a of [
    'records:r:control',
    'records:r:convention',
    'records:r:gotcha',
    'records:r:term',
    'documents:r',
    'search:r',
    'inference:r',
  ]) {
    assert.ok(shared.allowedActions.includes(a), `member shared clause should include ${a}`);
  }

  // Clause 2 — PRIVATE memory: the member's own records only, on the stable
  // principal (userId) dimension.
  const priv = member![1];
  assert.deepEqual(priv.dataScope, { userId: ['${{ self.userId }}'] }, 'private memory is self-scoped by userId');
  assert.ok(priv.allowedActions.includes('records:cru:memory'), 'member owns full CRU over its memory');
  assert.ok(priv.allowedActions.includes('search:r'), 'member can semantically recall its own memory');
  // `inference:r` must live in THIS self-scoped clause too (not only the curated
  // clause 1, which excludes the memory type) — otherwise `rag_ask` could not
  // ground on the member's own private memory. The read grant + inference travel
  // together in one clause, so grounding is independent of cross-clause admission.
  assert.ok(priv.allowedActions.includes('inference:r'), 'member can rag_ask/ground over its OWN memory');

  /**
   * `candidate` is READ-ONLY in the same self-scoped clause — a deliberate asymmetry
   * against `memory`'s full CRU.
   *
   * A candidate's disposition is the OUTPUT of a verification step, so it is written
   * by the runtime that performed the check. A human editing that field directly
   * would record a verdict nothing actually verified, which is the one thing the
   * staging area exists to prevent. Reading is the point: the queue, the verdicts
   * and the corrections stay browsable.
   */
  assert.ok(priv.allowedActions.includes('records:r:candidate'), 'member can browse its own candidates');
  for (const forbidden of ['records:cru:candidate', 'records:c:candidate', 'records:u:candidate']) {
    assert.ok(!priv.allowedActions.includes(forbidden),
      `member must not WRITE candidates (${forbidden}) — a verdict is written by the verifier, not by hand`);
  }
  // Self-scoped, so one principal never sees another's proposals — same fence as memory.
  assert.deepEqual(priv.dataScope, { userId: ['${{ self.userId }}'] });

  // No org/team scope is baked in this version (the shared-scope ownership axis
  // is being finalized) — the team tier is a deliberate future addition.
  for (const clause of member!) {
    assert.ok(!('orgId' in (clause.dataScope ?? {})), 'no orgId scope baked into the member role this version');
  }

  // Role-wide invariants: no hard delete (memory is superseded, never purged);
  // data-plane only.
  for (const clause of member!) {
    assert.ok(
      !clause.allowedActions.some((a) => a.startsWith('records:d') || a.startsWith('documents:d') || a.startsWith('folders:d')),
      'member never hard-deletes',
    );
    assert.ok(
      !clause.allowedActions.some((a) => a.startsWith('provisioning') || a.startsWith('app-contexts') || a.includes('keys:') || a.includes('profiles:') || a.includes('billing') || a.includes('admin')),
      'member role carries no control-plane action',
    );
  }

  // ⚠ LOAD-BEARING INVARIANT: no member clause may grant document CREATE/UPDATE.
  // The shared clause is unscoped and documents have no per-type qualifier fence,
  // so `documents:r` reads EVERY document — safe only because no member can mint
  // one (no private doc can exist). Adding documents:c to the member role
  // requires documents to first gain a per-type read qualifier.
  for (const clause of member!) {
    assert.ok(
      !clause.allowedActions.some((a) => /^documents:[a-z]*[cu]/.test(a)),
      `member must not create/update documents (unscoped doc read has no type fence): ${clause.allowedActions.join(',')}`,
    );
  }
});

test('agentic-sdlc: this version bakes NO org/team ownership (deferred to the shared-scope model)', () => {
  const bp = getBlueprint('agentic-sdlc')!;
  // No org identity declared, and the service key stamps no org override — the
  // curated KB is owner-plain and the member shared clause reads it unscoped.
  assert.equal(bp.identities, undefined, 'no identities block (no team org) this version');
  assert.equal(bp.accessProfile.identityOverrides, undefined, 'service key stamps no org override');
});

test('agentic-sdlc: memory keeps a LEAN lookup set — structure axes stay filterable, only deterministic-enumeration fields are lookups', () => {
  const memory = getBlueprint('agentic-sdlc')!.schemas.find((s) => s.typeName === 'memory')!;
  const byId = new Map(memory.fields.map((f) => [f.fieldId, f]));
  // The structure axes are all `filterable` (typed SEARCH metadata — they narrow recall).
  for (const f of ['kind', 'area', 'agent', 'status', 'threadId']) {
    assert.ok(byId.get(f)?.filterable, `memory.${f} must be filterable`);
  }
  const lookups = (memory.lookupFields ?? []).map((l) => (typeof l === 'string' ? l : l.fieldName));
  // memory is the HIGHEST-VOLUME record, so lookups are reserved for fields we ENUMERATE
  // deterministically (a per-write lookup row is expensive at volume).
  for (const f of ['kind', 'threadId', 'updatedOn', 'priority']) {
    assert.ok(lookups.includes(f), `memory lookupFields must include ${f}`);
  }
  // area/agent/status/sourceRef are filterable-only (or plain) — NOT lookups. Pin the lean
  // decision so a future re-add is a conscious, reviewed choice, not silent write bloat.
  for (const f of ['area', 'agent', 'status', 'sourceRef']) {
    assert.ok(!lookups.includes(f), `memory.${f} must NOT be a lookup (keep the high-volume write lean)`);
  }
});

test('agentic-sdlc: candidate carries exactly the lookups its enumerations need — and no filterable flags', () => {
  const candidate = getBlueprint('agentic-sdlc')!.schemas.find((s) => s.typeName === 'candidate')!;
  /**
   * Render each entry to a STABLE IDENTITY — a composite has no `fieldName`, and mapping
   * straight to `.fieldName` yields `undefined`, which `sort()` shuffles to the end and
   * `deepEqual` then reports as a mystery element. That is the same shape the CLI's plan
   * renderer was fixed for; a test is not exempt from it.
   */
  // NonNullable: `lookupFields` is optional, and `[number]` cannot index a `| undefined` type.
  const identity = (l: NonNullable<typeof candidate.lookupFields>[number]) =>
    typeof l === 'string' ? l : l.fieldNames?.join(',') ?? l.fieldName;
  const lookups = (candidate.lookupFields ?? []).map(identity);
  // Three questions, four declarations — the two single-field enumerations ("what is waiting
  // anywhere?", "what belongs to this conversation?"), the composite that answers the
  // conjunction of them, and the date range every artifact type here carries.
  assert.deepEqual([...lookups].sort(),
    ['disposition', 'proposedAt', 'sessionId', 'sessionId,disposition']);
  // The range belongs on proposedAt specifically: a review queue is worked by AGE, which
  // is a range read rather than a filter over everything ever proposed.
  const ranges = (candidate.lookupFields ?? []).filter((l) => typeof l !== 'string' && l.rangeEnabled);
  assert.deepEqual(ranges.map((l) => (l as { fieldName: string }).fieldName), ['proposedAt']);
  /**
   * NO field declares `filterable`, and that is a consequence of store-only.
   *
   * `filterable` is SEARCH metadata — it narrows recall. A `NONE` type is never
   * indexed, so the flag would be inert: config that reads as a query capability
   * the type does not have. Contrast `memory` directly above, where the same flags
   * are load-bearing precisely because it IS searchable.
   */
  for (const f of candidate.fields) {
    assert.ok(!f.filterable, `candidate.${f.fieldId} must not be filterable — the type is never indexed`);
  }
});

test('agentic-sdlc: candidate keeps supersession SEPARATE from disposition (they are different facts)', () => {
  const candidate = getBlueprint('agentic-sdlc')!.schemas.find((s) => s.typeName === 'candidate')!;
  const byId = new Map(candidate.fields.map((f) => [f.fieldId, f]));
  // Dismissal is REVERSIBLE; supersession is not. Resurrecting a claim that a later run
  // already corrected would re-offer the version known to be wrong, so `disposition` must
  // NOT carry a 'superseded' value — folding them into one enum makes the distinction
  // unrepresentable exactly when it matters.
  const disposition = byId.get('disposition')!.enumValues!;
  assert.deepEqual(disposition, ['pending', 'stored', 'documented', 'ignored']);
  assert.ok(!disposition.includes('superseded'), 'supersession is not a disposition');
  // It is a reference instead — both directions, because there is no reverse-reference
  // read: `revises` is written on the corrector at create, `supersededBy` on the corrected
  // so "is this still open?" is answerable without asking what points at it.
  for (const f of ['revises', 'supersededBy']) {
    assert.equal(byId.get(f)?.fieldType, 'reference', `candidate.${f} is a typed reference`);
    assert.equal(byId.get(f)?.targetTypeName, 'candidate', `candidate.${f} is a self-reference`);
    assert.equal(byId.get(f)?.targetSurface, 'record');
  }
});

test('agentic-sdlc: candidate.kind mirrors memory.kind exactly (a verified candidate maps 1:1)', () => {
  const byType = new Map(getBlueprint('agentic-sdlc')!.schemas.map((s) => [s.typeName, s]));
  const kindOf = (t: string) => byType.get(t)!.fields.find((f) => f.fieldId === 'kind')!.enumValues;
  // A candidate becomes a memory when it is verified. Divergent vocabularies would put a
  // translation step in that path, which is where a mapping bug would live.
  assert.deepEqual(kindOf('candidate'), kindOf('memory'));
});

test('agentic-sdlc: candidate and memory agree on every field they share (promotion is a copy, not a translation)', () => {
  const byType = new Map(getBlueprint('agentic-sdlc')!.schemas.map((s) => [s.typeName, s]));
  const cand = new Map(byType.get('candidate')!.fields.map((f) => [f.fieldId, f]));
  const mem = new Map(byType.get('memory')!.fields.map((f) => [f.fieldId, f]));

  /**
   * THE CARRY-OVER SET IS PINNED BY NAME, not computed from the intersection — and that
   * is the whole point of the test.
   *
   * Verifying a candidate COPIES it into a memory. Any field the proposer filled in that
   * `candidate` does not model is dropped in transit, and it is dropped at the worst
   * possible moment: a reviewer decides whether the claim is true, and the provenance
   * that would settle it (`sourceRef`, `area`) is the part that went missing. A test
   * written as "for each shared field, the types agree" would pass trivially on a
   * `candidate` that had quietly stopped modelling any of them — the intersection would
   * just get smaller. So the list is stated.
   */
  const shared = [...cand.keys()].filter((k) => mem.has(k)).sort();
  assert.deepEqual(shared, ['area', 'body', 'kind', 'sourceRef', 'supersededBy', 'tags', 'title']);

  for (const id of shared) {
    assert.equal(cand.get(id)!.fieldType, mem.get(id)!.fieldType,
      `candidate.${id} and memory.${id} must be the same type — a promotion that has to convert is a mapping bug waiting to happen`);
  }

  // `dest` is the one field with no counterpart, and legitimately so: it asks WHICH tier
  // this belongs in, a question that stops existing once the answer is acted on.
  assert.ok(!mem.has('dest'), 'dest is a candidate-only question');
  assert.deepEqual(cand.get('dest')!.enumValues, ['memory', 'doc']);
});

test('agentic-sdlc: every status/severity/criticality/docType enum is pinned (drift breaks documented queries)', () => {
  // DESIGN frames enum drift as a real defect — the query patterns + GTM narrative cite
  // these exact vocabularies. Silently narrowing one (dropping `deprecated`, `mitigated`,
  // …) would ship green. Pin them all.
  const bp = getBlueprint('agentic-sdlc')!;
  const byType = new Map(bp.schemas.map((s) => [s.typeName, s]));
  const enumOf = (type: string, field: string) =>
    byType.get(type)!.fields.find((f) => f.fieldId === field)?.enumValues;
  const expected: Array<[string, string, string[]]> = [
    ['decision', 'status', ['proposed', 'accepted', 'superseded', 'deprecated']],
    ['design', 'status', ['draft', 'active', 'implemented', 'superseded']],
    ['reference', 'category', ['guide', 'onboarding', 'api', 'process', 'other']],
    ['reference', 'status', ['active', 'superseded']],
    ['runbook', 'status', ['active', 'retired']],
    ['postmortem', 'severity', ['low', 'medium', 'high', 'critical']],
    ['postmortem', 'status', ['open', 'mitigated', 'resolved']],
    ['control', 'kind', ['policy', 'standard', 'control']],
    ['control', 'criticality', ['low', 'medium', 'high', 'critical']],
    ['control', 'status', ['draft', 'active', 'retired']],
    ['convention', 'status', ['active', 'retired']],
    ['gotcha', 'status', ['active', 'resolved']],
    // `memory` (the private tier): `kind` mirrors the file-memory frontmatter
    // vocabulary 1:1 (the documented migration target), and `status` drives the
    // supersede lifecycle — either drifting silently would break recall/migration.
    ['memory', 'kind', ['user', 'feedback', 'project', 'reference', 'observation']],
    ['memory', 'status', ['active', 'superseded']],
  ];
  for (const [type, field, values] of expected) {
    assert.deepEqual(enumOf(type, field), values, `${type}.${field} enum drifted`);
  }
});

test('agentic-sdlc: every schema carries exactly one range/sort date lookup (range on the when of every artifact)', () => {
  // The pitch promises a range/sort lookup on every artifact's date. A schema silently
  // losing its rangeEnabled row would pass the "ranges-are-dates" guard but break the
  // promise — so assert each of the 9 schemas HAS exactly one, naming a date field.
  for (const s of getBlueprint('agentic-sdlc')!.schemas) {
    const ranges = (s.lookupFields ?? []).filter((lf) => typeof lf !== 'string' && lf.rangeEnabled);
    // Every schema keeps exactly one range/sort DATE lookup (the "when"). A schema MAY carry
    // additional non-date range lookups (e.g. memory's `priority` band) — those don't count
    // against the date guarantee.
    const dateRanges = ranges.filter(
      (lf) => s.fields.find((f) => f.fieldId === (lf as { fieldName: string }).fieldName)?.fieldType === 'date',
    );
    assert.equal(dateRanges.length, 1, `${s.typeName} should have exactly one range/sort DATE lookup (the "when")`);
  }
});

test('agentic-sdlc: every RECORD schema carries `sourceRef` as a non-range equality lookup (the sync-back index)', () => {
  // sourceRef is what makes record re-extraction work: on a source-file edit,
  // `record_query {type, field:sourceRef, value:<path>}` returns exactly that file's records
  // to re-distill. It MUST be a plain equality lookup (the file/path is the sync unit; the
  // section lives in the externalId) and must NOT be rangeEnabled (that would steal the
  // schema's single range slot from its date row). A silent removal would ship green and
  // break the documented KB↔repo sync flow — so pin it.
  for (const type of ['control', 'convention', 'gotcha', 'term']) {
    const s = getBlueprint('agentic-sdlc')!.schemas.find((x) => x.typeName === type)!;
    const lf = (s.lookupFields ?? []).find(
      (l) => (typeof l === 'string' ? l : l.fieldName) === 'sourceRef',
    );
    assert.ok(lf, `${type} must carry a sourceRef lookup (the record sync-back index)`);
    assert.ok(
      typeof lf === 'string' || !lf.rangeEnabled,
      `${type}.sourceRef must be a plain equality lookup, never rangeEnabled`,
    );
    assert.equal(
      s.fields.find((f) => f.fieldId === 'sourceRef')?.fieldType,
      'string',
      `${type}.sourceRef must be a string field`,
    );
  }
});

test('agentic-sdlc: ships seedless in this version (the cross-surface graph is populated by ingest)', () => {
  // The content artifacts live on the document surface; the cross-surface graph is filled
  // by the ingest agent (document_ingest / record_create), not the bootstrap seed step
  // (the loader seeds records only — tracked separately). Prod uses --no-seed regardless.
  const bp = getBlueprint('agentic-sdlc')!;
  assert.ok(!bp.seed || bp.seed.length === 0, 'agentic-sdlc carries no bundled seed in this version');
});

test('agentic-sdlc: each record schema has exactly one displayField headline (the positive half of content-vs-structure)', () => {
  // Documents carry an intrinsic title (no typed field); records have no intrinsic
  // title, so each must declare exactly one displayField headline — else it renders
  // blank in a list view. control/convention use a typed `title`; gotcha/term use
  // their domain key (`symptom`/`term`), where a literal `title` would be redundant.
  const byType = new Map(getBlueprint('agentic-sdlc')!.schemas.map((s) => [s.typeName, s]));
  const displayOf = (type: string) =>
    byType.get(type)!.fields.filter((f) => f.renderHints?.displayField).map((f) => f.fieldId);
  assert.deepEqual(displayOf('control'), ['title'], 'control headline is title');
  assert.deepEqual(displayOf('convention'), ['title'], 'convention headline is title');
  assert.deepEqual(displayOf('gotcha'), ['symptom'], 'gotcha headline is symptom');
  assert.deepEqual(displayOf('term'), ['term'], 'term headline is term');
  // The record `title` is a real first-class field (required + searchable), not decoration.
  for (const t of ['control', 'convention']) {
    const title = byType.get(t)!.fields.find((f) => f.fieldId === 'title')!;
    assert.equal(title.required, true, `${t}.title must be required`);
    assert.equal(title.searchable, true, `${t}.title must be searchable`);
  }
});

test('agentic-sdlc: each schema ranges on its OWN semantic date field (pin the per-schema date map)', () => {
  // Every schema has exactly one range/sort date (guarded elsewhere), but the schemas
  // use deliberately DIFFERENT date semantics — a silent rename (occurredOn→updatedOn)
  // would pass the "range is a date" guard yet break the documented query. Pin the map.
  const byType = new Map(getBlueprint('agentic-sdlc')!.schemas.map((s) => [s.typeName, s]));
  const rangeFieldOf = (type: string) => {
    const r = (byType.get(type)!.lookupFields ?? []).find((lf) => typeof lf !== 'string' && lf.rangeEnabled);
    return r && typeof r !== 'string' ? r.fieldName : undefined;
  };
  const expected: Record<string, string> = {
    decision: 'date',
    design: 'updatedOn',
    reference: 'lastReviewed',
    runbook: 'updatedOn',
    postmortem: 'occurredOn',
    control: 'reviewedOn',
    convention: 'updatedOn',
    gotcha: 'discoveredOn',
    term: 'updatedOn',
  };
  for (const [type, field] of Object.entries(expected)) {
    assert.equal(rangeFieldOf(type), field, `${type} must range on '${field}'`);
  }
});

test('agentic-sdlc: `gotcha` is intentionally reference-free (the standalone trap type)', () => {
  // gotcha is the one type with no typed edge (a trap is self-contained). Pin that
  // intent so a future stray reference is flagged as a deliberate change, not a slip.
  const gotcha = getBlueprint('agentic-sdlc')!.schemas.find((s) => s.typeName === 'gotcha')!;
  assert.ok(!gotcha.fields.some((f) => f.fieldType === 'reference'), 'gotcha must declare no reference field');
});

test('GUARD: any lookup sortBy names a platform timestamp or a declared, order-bearing field', () => {
  // A sortBy must name something the platform can order by, permanently. The server enforces
  // THREE rules, all migration-locked, so a blueprint that breaks any of them cannot be
  // corrected in place — the schema would need a new field name. This test owns two:
  //   1. The target must be DECLARED on the schema (or be a platform timestamp).
  //   2. It must have a meaningful order: `array` and `object` are rejected outright.
  // The third — a sortBy must never name a `sensitive` field, whose plaintext would land in
  // a GSI sort key — is enforced by 'GUARD: a sensitive field is never searchable, never
  // range/sort-indexed' above, which owns the whole sensitive surface. Named here because
  // this comment previously read as if it enumerated the complete rule set, which is how a
  // reader concludes a rule is unguarded when it is merely guarded elsewhere.
  //
  // ⚠️ Both assertions below are VACUOUS against today's corpus: the only bundled sortBy is
  // `lastUpdated`, which returns at the PLATFORM_TIMESTAMPS check before reaching either.
  // They are forward guards on blueprints not yet written, not evidence about what ships.
  //
  // The field does NOT need to be `required` — an earlier version of this guard enforced
  // that, on the belief that sorting by an optional field "silently drops" records lacking
  // it. That was never true (an equality lookup resolves on the partition key; sortBy only
  // orders within it), and the platform now gives value-less records their own ordered
  // position ahead of the rest.
  const PLATFORM_TIMESTAMPS = new Set(['createdAt', 'lastUpdated']);
  const UNORDERABLE = new Set(['array', 'object']);
  for (const b of BUNDLED_BLUEPRINTS) {
    for (const s of b.schemas) {
      const byId = new Map(s.fields.map((f) => [f.fieldId, f]));
      for (const lf of s.lookupFields ?? []) {
        if (typeof lf === 'string' || !lf.sortBy) continue;
        if (PLATFORM_TIMESTAMPS.has(lf.sortBy)) continue;
        const target = byId.get(lf.sortBy);
        assert.ok(
          target,
          `${b.name}.${s.typeName}.${lf.fieldName}: sortBy '${lf.sortBy}' names no declared field`,
        );
        assert.ok(
          !UNORDERABLE.has(target.fieldType),
          `${b.name}.${s.typeName}.${lf.fieldName}: sortBy '${lf.sortBy}' is '${target.fieldType}', which has no meaningful order`,
        );
      }
    }
  }
});

test('GUARD: every seed reference resolves to an earlier seed of the right type', () => {
  // The platform enforces write-time existence: a reference target must exist when
  // the referencing record is written, and the loader creates seeds in array order.
  // So every seed reference value must name an EARLIER seed whose typeName matches the
  // reference's targetTypeName. A mis-ordered seed fails `vectros bootstrap` against the
  // live API but parses fine here — pin the ordering so it can't regress silently.
  for (const b of BUNDLED_BLUEPRINTS) {
    const schemaByType = new Map(b.schemas.map((s) => [s.typeName, s]));
    const seen = new Map<string, string>(); // externalId → typeName, of seeds already created
    for (const seed of b.seed ?? []) {
      const schema = schemaByType.get(seed.typeName);
      const refFields = (schema?.fields ?? []).filter((f) => f.fieldType === 'reference');
      for (const rf of refFields) {
        const value = seed.fields?.[rf.fieldId];
        if (value === undefined || value === null) continue; // optional references may be unset
        assert.equal(typeof value, 'string', `${b.name} seed ${seed.externalId}.${rf.fieldId} must be an externalId string`);
        const targetType = seen.get(value as string);
        assert.ok(
          targetType !== undefined,
          `${b.name} seed ${seed.externalId}.${rf.fieldId}='${value}' references a target not seeded earlier`,
        );
        assert.equal(
          targetType,
          rf.targetTypeName,
          `${b.name} seed ${seed.externalId}.${rf.fieldId}='${value}' targets a ${targetType}, expected ${rf.targetTypeName}`,
        );
      }
      seen.set(seed.externalId, seed.typeName);
    }
  }
});

test('GUARD: no bundled blueprint requests a delete or control-plane scope', () => {
  // These ship to prospects as least-privilege exemplars; a stray records:d or
  // a control-plane verb would be both a bad example and a scope-gate failure.
  const controlPlane = ['keys', 'profiles', 'app-contexts', 'users', 'billing', 'admin', 'clients', 'orgs'];
  for (const b of BUNDLED_BLUEPRINTS) {
    for (const action of b.accessProfile.allowedActions!) {
      assert.ok(!action.includes(':d'), `${b.name} must not request a delete scope (${action})`);
      const resource = action.split(':')[0];
      assert.ok(
        !controlPlane.includes(resource),
        `${b.name} must stay data-plane-only (${action})`,
      );
    }
  }
});

test('GUARD: every reference targets a declared schema whose surface includes targetSurface', () => {
  // Cross-surface references are the agentic-sdlc showcase, but the format does no
  // cross-reference linting at parse time — a typo'd targetTypeName, or a targetSurface
  // that disagrees with the target schema's allowedSurfaces, parses fine here and only
  // 400s at live createSchema (or resolves the wrong surface). Pin both library-wide.
  for (const b of BUNDLED_BLUEPRINTS) {
    const byType = new Map(b.schemas.map((s) => [s.typeName, s]));
    for (const s of b.schemas) {
      for (const f of s.fields) {
        if (f.fieldType !== 'reference') continue;
        const target = byType.get(f.targetTypeName!);
        assert.ok(
          target !== undefined,
          `${b.name}.${s.typeName}.${f.fieldId}: targetTypeName '${f.targetTypeName}' is not a declared schema`,
        );
        // targetSurface is a free string (a fixed surface OR an entity namespace,
        // data-driven), while allowedSurfaces is the closed bind-surface enum — widen
        // to string[] for the membership check (the bundled edges are all record/document).
        const targetSurfaces: string[] = target!.allowedSurfaces ?? ['record']; // default surface is record
        const declared = f.targetSurface ?? 'record';
        assert.ok(
          targetSurfaces.includes(declared),
          `${b.name}.${s.typeName}.${f.fieldId}: targetSurface '${declared}' not in ${f.targetTypeName}'s allowedSurfaces [${targetSurfaces.join(', ')}]`,
        );
      }
    }
  }
});

test('GUARD: no document-surface schema declares a typed `title` field (documents carry an intrinsic title)', () => {
  // A document's title is intrinsic (the ingest title); a typed `title` field on a
  // document schema duplicates it AND is a 400-on-ingest footgun (the top-level ingest
  // title does not satisfy a typed required field). Generalize the agentic-sdlc check.
  for (const b of BUNDLED_BLUEPRINTS) {
    for (const s of b.schemas) {
      if (!(s.allowedSurfaces ?? ['record']).includes('document')) continue;
      assert.ok(
        !s.fields.some((f) => f.fieldId === 'title'),
        `${b.name}.${s.typeName} binds the document surface and must NOT declare a typed 'title' field`,
      );
    }
  }
});

// ── seed surface discriminator (record vs document) ──────────────────────────

/** A base blueprint object (untyped) for exercising raw seed shapes via parseBlueprint. */
function withSeed(seed: unknown, schemas: unknown[] = [{ typeName: 'decision', displayName: 'Decision', allowedSurfaces: ['document'], fields: [] }]): Record<string, unknown> {
  return {
    name: 'demo',
    version: '1.0.0',
    description: 'demo blueprint',
    contextId: 'mcp',
    schemas,
    accessProfile: { allowedActions: ['records:r'] },
    servicePrincipal: { externalId: 'demo-sp', displayName: 'Demo SP' },
    seed,
  };
}

test('seed: accepts a record seed (surface record) with fields', () => {
  const b = parseBlueprint(
    withSeed(
      [{ surface: 'record', typeName: 'task', externalId: 'r1', fields: { a: 1 } }],
      [{ typeName: 'task', displayName: 'Task', fields: [] }], // record surface (default)
    ),
  );
  assert.equal(b.seed?.[0].surface, 'record');
});

test('seed: accepts a document seed (surface document) with title + text + optional fields', () => {
  const b = parseBlueprint(
    withSeed([{ surface: 'document', typeName: 'decision', externalId: 'd1', title: 'ADR 1', text: 'because', fields: { status: 'accepted' } }]),
  );
  const seed = b.seed?.[0];
  assert.equal(seed?.surface, 'document');
  // The discriminated union narrows: title/text are first-class on a document seed.
  assert.equal(seed?.surface === 'document' ? seed.title : undefined, 'ADR 1');
});

test('seed: a document seed may OMIT fields (title + text are the only content)', () => {
  const b = parseBlueprint(withSeed([{ surface: 'document', typeName: 'decision', externalId: 'd1', title: 'ADR 1', text: 'because' }]));
  assert.equal(b.seed?.[0].surface, 'document');
});

test('seed: REJECTS a document seed missing text (the ingest path requires it)', () => {
  assert.throws(
    () => parseBlueprint(withSeed([{ surface: 'document', typeName: 'decision', externalId: 'd1', title: 'ADR 1' }])),
    BlueprintValidationError,
  );
});

test('seed: REJECTS a document seed missing title', () => {
  assert.throws(
    () => parseBlueprint(withSeed([{ surface: 'document', typeName: 'decision', externalId: 'd1', text: 'because' }])),
    BlueprintValidationError,
  );
});

test('seed: REJECTS title/text on a RECORD seed (strict — those are document-only)', () => {
  assert.throws(
    () => parseBlueprint(withSeed([{ surface: 'record', typeName: 'decision', externalId: 'r1', fields: {}, title: 'nope', text: 'nope' }])),
    BlueprintValidationError,
  );
});

test('seed: REJECTS a missing/invalid surface discriminator', () => {
  assert.throws(
    () => parseBlueprint(withSeed([{ typeName: 'decision', externalId: 'r1', fields: {} }])),
    BlueprintValidationError,
  );
  assert.throws(
    () => parseBlueprint(withSeed([{ surface: 'user', typeName: 'decision', externalId: 'r1', fields: {} }])),
    BlueprintValidationError,
  );
});

test('seed: REJECTS a surface the schema does not allow (document seed of a record-only type)', () => {
  const e = caught(() =>
    parseBlueprint(
      withSeed(
        [{ surface: 'document', typeName: 'task', externalId: 'd1', title: 'T', text: 'x' }],
        [{ typeName: 'task', displayName: 'Task', fields: [] }], // defaults to allowedSurfaces ['record']
      ),
    ),
  );
  assert.match(e.message, /surface 'document'/);
  assert.match(e.message, /allows only \[record\]/);
});

// ── composite ('fieldNames') lookups — SCHEMA/FORMAT support only; no bundled
// blueprint adopts one yet (a separate, deliberate content decision) ────────

/** A minimal blueprint carrying one schema with the given lookupFields + allowedSurfaces. */
function withLookup(
  lookupFields: unknown[],
  allowedSurfaces?: ('record' | 'document' | 'user' | 'entity')[],
): unknown {
  return minimal({
    schemas: [
      {
        typeName: 'widget',
        displayName: 'Widget',
        fields: [
          { fieldId: 'status', fieldType: 'enum', enumValues: ['open', 'closed'] },
          { fieldId: 'area', fieldType: 'string' },
          { fieldId: 'owner', fieldType: 'string' },
        ],
        lookupFields: lookupFields as never,
        ...(allowedSurfaces ? { allowedSurfaces } : {}),
      },
    ],
  });
}

test('composite lookup: a 2-field fieldNames entry is accepted', () => {
  assert.doesNotThrow(() => parseBlueprint(withLookup([{ fieldNames: ['status', 'area'] }])));
});

test('composite lookup: a 3-field fieldNames entry is accepted', () => {
  assert.doesNotThrow(() => parseBlueprint(withLookup([{ fieldNames: ['status', 'area', 'owner'] }])));
});

test('composite lookup: REJECTS both fieldName and fieldNames set', () => {
  const e = caught(() => parseBlueprint(withLookup([{ fieldName: 'status', fieldNames: ['status', 'area'] }])));
  assert.match(e.message, /never both and never neither/);
});

test('composite lookup: REJECTS neither fieldName nor fieldNames set', () => {
  const e = caught(() => parseBlueprint(withLookup([{ unique: true }])));
  assert.match(e.message, /never both and never neither/);
});

test('composite lookup: REJECTS a 1-element fieldNames (not a spelling of the scalar form)', () => {
  assert.throws(() => parseBlueprint(withLookup([{ fieldNames: ['status'] }])), BlueprintValidationError);
});

test('composite lookup: REJECTS a 4-element fieldNames (arity bounded at 3)', () => {
  assert.throws(
    () => parseBlueprint(withLookup([{ fieldNames: ['status', 'area', 'status', 'area'] }])),
    BlueprintValidationError,
  );
});

test('composite lookup: REJECTS unique on a composite', () => {
  const e = caught(() => parseBlueprint(withLookup([{ fieldNames: ['status', 'area'], unique: true }])));
  assert.match(e.message, /'unique' is not available on a composite/);
});

test('composite lookup: REJECTS rangeEnabled on a composite', () => {
  const e = caught(() => parseBlueprint(withLookup([{ fieldNames: ['status', 'area'], rangeEnabled: true }])));
  assert.match(e.message, /'rangeEnabled' is not available on a composite/);
});

test('composite lookup: sortBy and allowOverflow ARE available on a composite', () => {
  assert.doesNotThrow(() =>
    parseBlueprint(withLookup([{ fieldNames: ['status', 'area'], sortBy: 'status', allowOverflow: true }])),
  );
});

test('composite lookup: ACCEPTS on a schema whose allowedSurfaces is omitted (defaults to record)', () => {
  assert.doesNotThrow(() => parseBlueprint(withLookup([{ fieldNames: ['status', 'area'] }])));
});

test('composite lookup: ACCEPTS on a schema whose allowedSurfaces is explicitly ["record"]', () => {
  assert.doesNotThrow(() => parseBlueprint(withLookup([{ fieldNames: ['status', 'area'] }], ['record'])));
});

test('composite lookup: REJECTS on a schema whose allowedSurfaces includes document', () => {
  const e = caught(() => parseBlueprint(withLookup([{ fieldNames: ['status', 'area'] }], ['document'])));
  assert.match(e.message, /allowedSurfaces to be exactly \['record'\]/);
});

test('composite lookup: REJECTS on a schema whose allowedSurfaces is record PLUS another surface', () => {
  // Exactly ['record'], not merely including it — a schema bound to record+document still
  // cannot carry a composite, because the composite index has no document reader at all.
  const e = caught(() => parseBlueprint(withLookup([{ fieldNames: ['status', 'area'] }], ['record', 'document'])));
  assert.match(e.message, /allowedSurfaces to be exactly \['record'\]/);
});

test('composite lookup: a schema with NO composite is unaffected by the allowedSurfaces check', () => {
  // Negative control — the schema-level allowedSurfaces refinement must not fire on a
  // perfectly ordinary single-field lookup, regardless of what allowedSurfaces says.
  assert.doesNotThrow(() => parseBlueprint(withLookup(['status'], ['document'])));
});

test('composite lookup: the BUNDLED adoption inventory is exactly one, and enumerated', () => {
  /**
   * This pin was previously "no bundled blueprint declares one yet" — the negative held while
   * the format support landed and the content decision was deliberately deferred. That decision
   * has now been made for ONE schema (`agentic-sdlc.candidate`, over `sessionId` +
   * `disposition`), so the pin becomes an INVENTORY rather than a prohibition.
   *
   * Kept as an exhaustive list on purpose. Each composite costs one of a schema's ten permanently
   * migration-locked lookup declarations, so adoption is a decision that should show up as a diff
   * in this file every single time — which a "0 or more" assertion would stop doing the moment the
   * first one landed.
   */
  const declared: string[] = [];
  for (const b of BUNDLED_BLUEPRINTS) {
    for (const s of b.schemas) {
      for (const lf of s.lookupFields ?? []) {
        if (typeof lf !== 'string' && lf.fieldNames !== undefined) {
          declared.push(`${b.name}.${s.typeName}:${lf.fieldNames.join(',')}`);
        }
      }
    }
  }
  assert.deepEqual(declared.sort(), ['agentic-sdlc.candidate:sessionId,disposition'],
    'a new bundled composite must be added here deliberately — one of ten migration-locked slots');
});

/** Capture a thrown BlueprintValidationError (mirrors error-format.test.ts). */
function caught(fn: () => unknown): BlueprintValidationError {
  try {
    fn();
  } catch (e) {
    if (e instanceof BlueprintValidationError) return e;
    throw e;
  }
  throw new Error('expected a BlueprintValidationError');
}
