/**
 * `filterable: true` field ids that collide with a platform-owned search-index metadata key
 * (0.43.0). Such a field shadows the platform's own value in the index, silently costing recall and
 * precision on type-scoped searches, so the platform now rejects it with a 400 — which means a
 * blueprint declaring one FAILS TO APPLY. Caught here at authoring time instead.
 *
 * The reserved sets are per BIND SURFACE and are checked against only the surface(s) a schema
 * actually declares — never the union. That is not an optimization: checking the union rejects a
 * real document-only blueprint over `recordType`, a key the document model never writes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBlueprint, BlueprintValidationError } from '../src/types.js';
import { BUNDLED_BLUEPRINTS } from '../src/index.js';

function withSchema(schema: Record<string, unknown>): unknown {
  return {
    name: 'demo',
    version: '1.0.0',
    description: 'demo blueprint',
    contextId: 'mcp',
    schemas: [schema],
    accessProfile: { allowedActions: ['records:r'] },
    servicePrincipal: { externalId: 'demo-sp', displayName: 'Demo SP' },
  };
}

function issuePaths(input: unknown): string[] {
  try {
    parseBlueprint(input);
    return [];
  } catch (err) {
    assert.ok(err instanceof BlueprintValidationError, `expected BlueprintValidationError, got ${err}`);
    return err.issues.map((i) => i.path);
  }
}

const field = (fieldId: string, filterable = true) => ({ fieldId, fieldType: 'string', filterable });

test('REJECTS a filterable field colliding with a record-surface index key', () => {
  for (const reserved of ['tenantId', 'owner_id', 'folderId', 'rootFolderId', 'recordType']) {
    assert.deepEqual(
      issuePaths(withSchema({ typeName: 't', displayName: 'T', fields: [field(reserved)] })),
      ['schemas[0].fields[0].filterable'],
      `expected filterable '${reserved}' to be rejected on a record schema`,
    );
  }
});

test('allowedSurfaces defaults to [record] — an omitted value is still checked', () => {
  // Reading "omitted" as "no surfaces" would skip the check for the single most common blueprint
  // shape. The CLI loader sends ['record'] for an omitted value, so the lint must assume the same.
  assert.deepEqual(
    issuePaths(withSchema({ typeName: 't', displayName: 'T', fields: [field('recordType')] })),
    ['schemas[0].fields[0].filterable'],
  );
});

test('a NON-filterable field of a reserved name is fine — it never reaches the index', () => {
  assert.deepEqual(
    issuePaths(withSchema({ typeName: 't', displayName: 'T', fields: [field('recordType', false)] })),
    [],
  );
  // Omitting `filterable` entirely is the same case.
  assert.deepEqual(
    issuePaths(withSchema({ typeName: 't', displayName: 'T', fields: [{ fieldId: 'title', fieldType: 'string' }] })),
    [],
  );
});

test('the sets are PER SURFACE, never the union', () => {
  // `title`/`model_type` are document-only keys. A record-only schema may filter on them, and the
  // union check that once rejected a real shipping document blueprint must not come back.
  for (const documentOnly of ['title', 'model_type']) {
    assert.deepEqual(
      issuePaths(withSchema({ typeName: 't', displayName: 'T', allowedSurfaces: ['record'], fields: [field(documentOnly)] })),
      [],
      `'${documentOnly}' is document-only and must be allowed on a record-only schema`,
    );
    assert.deepEqual(
      issuePaths(withSchema({ typeName: 't', displayName: 'T', allowedSurfaces: ['document'], fields: [field(documentOnly)] })),
      ['schemas[0].fields[0].filterable'],
      `'${documentOnly}' must be rejected on a document schema`,
    );
  }
});

test('an entity-only schema reserves NOTHING — identity models are not index-backed', () => {
  // `entity` is the only identity surface a blueprint may declare: a separate, pre-existing lint
  // forbids `user` outright (account-global, needs a root key no blueprint credential holds), so
  // there is no user-surfaced case for this lint to reach.
  assert.deepEqual(
    issuePaths(withSchema({ typeName: 't', displayName: 'T', allowedSurfaces: ['entity'], fields: [field('recordType')] })),
    [],
  );
});

test('a mixed-surface schema is checked against BOTH sets', () => {
  const paths = issuePaths(
    withSchema({ typeName: 't', displayName: 'T', allowedSurfaces: ['record', 'document'], fields: [field('title')] }),
  );
  assert.deepEqual(paths, ['schemas[0].fields[0].filterable']);
});

test('`status` is reserved on NEITHER surface — a schema may filter on it', () => {
  // Records stopped publishing a lifecycle `status` index key and documents never did (they use
  // `lifecycleStatus`). The bundled library depends on this; see the guard below.
  for (const surfaces of [['record'], ['document'], ['record', 'document']]) {
    assert.deepEqual(
      issuePaths(withSchema({ typeName: 't', displayName: 'T', allowedSurfaces: surfaces, fields: [field('status')] })),
      [],
      `filterable 'status' must be allowed on ${surfaces.join('+')}`,
    );
  }
});

test('every BUNDLED blueprint still parses — the lint must not reject the shipping library', () => {
  // The regression guard that matters: this lint rejects at APPLY-equivalent strictness, so a set
  // transcribed one key too wide would break blueprints customers already run. Several bundled
  // schemas declare a filterable `status`, which is exactly the key 0.43.0 freed.
  assert.ok(BUNDLED_BLUEPRINTS.length > 0, 'expected at least one bundled blueprint');
  for (const bp of BUNDLED_BLUEPRINTS) {
    assert.doesNotThrow(() => parseBlueprint(bp), `bundled blueprint '${bp.name}' no longer parses`);
  }
});
