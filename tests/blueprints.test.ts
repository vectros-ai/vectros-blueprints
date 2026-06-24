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
  assert.ok(BUNDLED_BLUEPRINTS.length >= 4);
  assert.ok(BLUEPRINT_NAMES.includes('task-management'));
  assert.ok(BLUEPRINT_NAMES.includes('coding-agent-memory'));
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
