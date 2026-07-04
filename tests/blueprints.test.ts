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
  BlueprintValidationError,
  type Blueprint,
} from '../src/types.js';
import { BUNDLED_BLUEPRINTS, BLUEPRINT_NAMES, getBlueprint } from '../src/index.js';

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

test('bundled registry includes the curated library + getBlueprint works', () => {
  assert.ok(BUNDLED_BLUEPRINTS.length >= 5);
  assert.ok(BLUEPRINT_NAMES.includes('task-management'));
  assert.ok(BLUEPRINT_NAMES.includes('coding-agent-memory'));
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
  assert.ok(!bp.accessProfile.allowedActions.some((a) => a.includes(':s')));
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
        if (sensitiveIds.has(lf.fieldName)) {
          assert.ok(
            !lf.rangeEnabled,
            `${b.name}.${s.typeName}.${lf.fieldName}: a sensitive lookup cannot be rangeEnabled (a blind hash is not orderable)`,
          );
        }
        assert.ok(
          !(lf.sortBy && sensitiveIds.has(lf.sortBy)),
          `${b.name}.${s.typeName}.${lf.fieldName}: sortBy must not name a sensitive field (its plaintext would land in a sort key)`,
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
  // Every range-enabled bundled lookup names an ISO-8601 date field (lexical order ==
  // chronological order — safe to lock). Pins the audit decision that ordinal enums
  // (e.g. task priority low<urgent) were deliberately left as equality, not range.
  const rangeFields: string[] = [];
  for (const b of BUNDLED_BLUEPRINTS) {
    for (const s of b.schemas) {
      for (const lf of s.lookupFields ?? []) {
        if (typeof lf === 'string' || !lf.rangeEnabled) continue;
        rangeFields.push(lf.fieldName);
        const fld = s.fields.find((f) => f.fieldId === lf.fieldName);
        assert.equal(
          fld?.fieldType,
          'date',
          `${b.name}.${s.typeName}.${lf.fieldName}: range lookups are reserved for date fields (lexical==chronological)`,
        );
      }
    }
  }
  assert.ok(rangeFields.length >= 4, `expected the range showcase across blueprints, saw ${rangeFields.join(', ')}`);
});

test('SHOWCASE: coding-agent-memory links a convention to its decision via a typed reference', () => {
  const cam = getBlueprint('coding-agent-memory')!;
  const convention = cam.schemas.find((s) => s.typeName === 'convention')!;
  const ref = convention.fields.find((f) => f.fieldId === 'establishedByDecision');
  assert.equal(ref?.fieldType, 'reference');
  assert.equal(ref?.targetTypeName, 'decision');
  assert.equal(ref?.targetSurface, 'record'); // platform requires it; would 400 without
  // declared as an equality lookup so "conventions established by decision X" enumerates
  const isLookup = (convention.lookupFields ?? []).some(
    (lf) => (typeof lf === 'string' ? lf : lf.fieldName) === 'establishedByDecision',
  );
  assert.ok(isLookup, 'establishedByDecision is an equality lookup');
  // A seeded convention resolves the link at bootstrap (decision seeded first; the
  // loader sends externalId top-level so the target's first-class externalId resolves).
  const seed = (cam.seed ?? []).find((r) => r.typeName === 'convention');
  assert.equal(seed?.fields.establishedByDecision, 'seed-use-vectros-for-memory');
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
        const name = typeof lf === 'string' ? lf : lf.fieldName;
        assert.ok(
          !RESERVED.has(name),
          `${b.name}.${s.typeName}: '${name}' is a reserved identifier and must not be a lookup field — look it up via its first-class finder`,
        );
      }
    }
  }
});

test('second-brain pins inference:r (the scope behind its documented rag_ask flow)', () => {
  // The walkthrough sells "ask your notes" via rag_ask; the data-plane scope-gate guard
  // only checks data-plane-ness, so without this a regression dropping inference:r would
  // break the documented flow with no failing test.
  const sb = getBlueprint('second-brain')!;
  assert.ok(sb.accessProfile.allowedActions.includes('inference:r'));
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

test('agentic-sdlc: 9 schemas split content (documents) vs structure (records)', () => {
  const bp = getBlueprint('agentic-sdlc')!;
  const typeNames = bp.schemas.map((s) => s.typeName).sort();
  assert.deepEqual(typeNames, [
    'control',
    'convention',
    'decision',
    'design',
    'gotcha',
    'postmortem',
    'reference',
    'runbook',
    'term',
  ]);
  // Content-dominant artifacts bind the DOCUMENT surface (body is the artifact).
  const documents = ['decision', 'design', 'reference', 'runbook', 'postmortem'];
  // Structure-dominant artifacts are records (typed fields are the artifact).
  const records = ['control', 'convention', 'gotcha', 'term'];
  const byType = new Map(bp.schemas.map((s) => [s.typeName, s]));
  for (const t of documents) {
    assert.deepEqual(byType.get(t)!.allowedSurfaces, ['document'], `${t} must bind the document surface`);
  }
  for (const t of records) {
    assert.equal(byType.get(t)!.allowedSurfaces, undefined, `${t} is a record (defaults to ['record'])`);
  }
  // Every schema is HYBRID (keyword + semantic recall is the whole pitch).
  for (const s of bp.schemas) assert.equal(s.indexMode, 'HYBRID', `${s.typeName} should be HYBRID`);
  // The retired types from earlier drafts are gone.
  for (const gone of ['handoff', 'incident', 'doc']) {
    assert.ok(!byType.has(gone), `${gone} should no longer be a schema`);
  }
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
  const actions = getBlueprint('agentic-sdlc')!.accessProfile.allowedActions;
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
  for (const a of bp.accessProfile.allowedActions) {
    assert.ok(editorActions.includes(a), `editor role must include the service-key action ${a}`);
  }
  // PLUS hard delete across the data plane (the whole point of the human-owner role).
  for (const del of ['records:d', 'documents:d', 'folders:d']) {
    assert.ok(editorActions.includes(del), `editor role must grant ${del}`);
  }
  // No dataScope: the owner sees + deletes across the whole context (not an ownership slice).
  // A per-user ownership-restricted delete is a separate concern (needs an identity on the
  // credential) and is intentionally NOT modeled here.
  assert.equal(editor![0].dataScope, undefined, 'editor role is unscoped (whole-context access)');
  // Still data-plane only: no control-plane action leaks in via the role.
  assert.ok(
    !editorActions.some((a) => a.startsWith('provisioning') || a.startsWith('app-contexts') || a.includes('users:') || a.includes('orgs:') || a.includes('clients:') || a.includes('keys:') || a.includes('profiles:') || a.includes('billing') || a.includes('admin')),
    'editor role carries no control-plane action',
  );
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
    assert.equal(ranges.length, 1, `${s.typeName} should have exactly one range/sort date lookup`);
    const fieldName = typeof ranges[0] === 'string' ? ranges[0] : ranges[0].fieldName;
    assert.equal(
      s.fields.find((f) => f.fieldId === fieldName)?.fieldType,
      'date',
      `${s.typeName}.${fieldName} range lookup must be a date`,
    );
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

test('GUARD: any lookup sortBy names a required field or a platform timestamp (never an optional user field)', () => {
  // Sorting an equality lookup by an OPTIONAL field silently drops records lacking it
  // (README § lookupFields). A safe sortBy is either a `required` declared field or a
  // platform-managed always-present timestamp. Guard the whole library against the class.
  const PLATFORM_TIMESTAMPS = new Set(['createdAt', 'lastUpdated']);
  for (const b of BUNDLED_BLUEPRINTS) {
    for (const s of b.schemas) {
      const requiredFields = new Set(s.fields.filter((f) => f.required).map((f) => f.fieldId));
      for (const lf of s.lookupFields ?? []) {
        if (typeof lf === 'string' || !lf.sortBy) continue;
        assert.ok(
          PLATFORM_TIMESTAMPS.has(lf.sortBy) || requiredFields.has(lf.sortBy),
          `${b.name}.${s.typeName}.${lf.fieldName}: sortBy '${lf.sortBy}' must be a required field or a platform timestamp (else optional-field rows drop)`,
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
        const value = seed.fields[rf.fieldId];
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
    for (const action of b.accessProfile.allowedActions) {
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
        const targetSurfaces = target!.allowedSurfaces ?? ['record']; // default surface is record
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
