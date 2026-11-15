/**
 * The geo field type's declaration rules, and the search-index names the platform keeps for itself, refused offline as the
 * platform refuses them on a schema write. The pilot flag (whether geo is enabled for the account) is the platform's alone.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBlueprint, BlueprintValidationError } from '../src/types.js';

function withSchema(schema: Record<string, unknown>): unknown {
  return {
    name: 'demo', version: '1.0.0', description: 'demo blueprint', contextId: 'mcp',
    schemas: [{ typeName: 'place', displayName: 'Place', fields: [{ fieldId: 'name', fieldType: 'string' }], ...schema }],
    accessProfile: { allowedActions: ['records:r'] }, servicePrincipal: { externalId: 'demo-sp', displayName: 'Demo SP' },
  };
}
function issues(input: unknown): string[] {
  try {
    parseBlueprint(input);
    return [];
  } catch (err) {
    assert.ok(err instanceof BlueprintValidationError, String(err));
    return err.issues.map((i) => `${i.path}: ${i.message}`);
  }
}
const has = (got: string[], re: RegExp) => assert.ok(got.some((i) => re.test(i)), JSON.stringify(got));
const geo = { fieldId: 'where', fieldType: 'geo' };

test('geo: a geo field parses on a record schema', () => {
  assert.deepEqual(issues(withSchema({ fields: [{ fieldId: 'name', fieldType: 'string' }, geo] })), []);
  assert.deepEqual(issues(withSchema({ fields: [geo], allowedSurfaces: ['document'] })), []);
});

test('geo: not sensitive, searchable, an enum or a reference; record or document schemas only', () => {
  has(issues(withSchema({ fields: [{ ...geo, sensitive: true }] })), /cannot be both geo and sensitive/);
  has(issues(withSchema({ fields: [{ ...geo, searchable: true }] })), /cannot be both geo and searchable/);
  has(issues(withSchema({ fields: [{ ...geo, enumValues: ['x'] }] })), /cannot declare enumValues/);
  has(issues(withSchema({ fields: [{ ...geo, targetTypeName: 'x' }] })), /only valid on a field with fieldType: 'reference'/);
  has(issues(withSchema({ fields: [geo], allowedSurfaces: ['entity'] })), /record and document schemas only/);
});

test('geo: no lookup on a geo field (single or composite), and no sortBy naming one', () => {
  const fields = [{ fieldId: 'name', fieldType: 'string' }, geo];
  has(issues(withSchema({ fields, lookupFields: ['where'] })), /lookupField cannot use 'where': it is a geo field/);
  has(issues(withSchema({ fields, lookupFields: [{ fieldNames: ['name', 'where'] }] })), /lookupField cannot use 'where'/);
  has(issues(withSchema({ fields, lookupFields: [{ fieldName: 'name', sortBy: 'where' }] })), /sortBy cannot be 'where'/);
});

test('reserved search-index names: a filterable _geo_* field, or one named publicCopy / public_copy_owner in any case, is refused', () => {
  has(issues(withSchema({ fields: [{ fieldId: '_geo_x', fieldType: 'string', filterable: true }] })), /the '_geo_' prefix is reserved/);
  has(issues(withSchema({ fields: [{ fieldId: 'PublicCopy', fieldType: 'string', filterable: true }] })), /publicCopy and public_copy_owner are reserved/);
  has(issues(withSchema({ fields: [{ fieldId: 'public_copy_owner', fieldType: 'string', filterable: true }] })), /reserved/);
  has(issues(withSchema({ fields: [{ fieldId: '_geo_x', fieldType: 'geo' }] })), /'_geo_' prefix is reserved/); // geo is filterable by default
  assert.deepEqual(issues(withSchema({ fields: [{ fieldId: '_geo_x', fieldType: 'string' }] })), [], 'not filterable: fine');
  assert.deepEqual(issues(withSchema({ fields: [{ fieldId: '_geo_x', fieldType: 'geo', filterable: false }] })), []);
  assert.deepEqual(issues(withSchema({ fields: [{ fieldId: 'publicCopy', fieldType: 'string', filterable: true }], allowedSurfaces: ['entity'] })), [], 'an identity surface is not indexed');
});

test('reserved names: a geo field is filterable by default, so one named after a reserved metadata key is refused without filterable', () => {
  has(issues(withSchema({ fields: [{ fieldId: 'tenantId', fieldType: 'geo' }] })), /tenantId/);
  assert.deepEqual(issues(withSchema({ fields: [{ fieldId: 'tenantId', fieldType: 'geo', filterable: false }] })), []);
  // The prefix is matched as written: only the two public-copy names ignore case.
  assert.deepEqual(issues(withSchema({ fields: [{ fieldId: '_GEO_x', fieldType: 'string', filterable: true }] })), []);
});

// geocode.from offline validation (same-schema, non-sensitive string/enum/number sources)
test('geocode: a geo field filled from same-schema address fields parses', () => {
  const schema = {
    fields: [
      { fieldId: 'street', fieldType: 'string' },
      { fieldId: 'city', fieldType: 'string' },
      { fieldId: 'zip', fieldType: 'number' },
      { fieldId: 'loc', fieldType: 'geo', geocode: { from: ['street', 'city', 'zip'] } },
    ],
  };
  assert.deepEqual(issues(withSchema(schema)), []);
});

test('geocode: only a geo field can be geocoded', () => {
  has(issues(withSchema({ fields: [{ fieldId: 'name', fieldType: 'string', geocode: { from: ['name'] } }] })),
    /only a geo field can be geocoded/);
});

test('geocode: from must name same-schema, non-sensitive string/enum/number fields, not the geo field itself', () => {
  const f = (from: string[], extra: Record<string, unknown>[] = []) =>
    withSchema({ fields: [...extra, { fieldId: 'loc', fieldType: 'geo', geocode: { from } }] });
  has(issues(f([])), /at least one field/);
  has(issues(f(['nope'])), /not a field of this schema/);
  has(issues(f(['loc'])), /geo field itself/);
  has(issues(f(['street', 'street'], [{ fieldId: 'street', fieldType: 'string' }])), /more than once/);
  has(issues(f(['secret'], [{ fieldId: 'secret', fieldType: 'string', sensitive: true }])), /because it is sensitive/);
  has(issues(f(['flag'], [{ fieldId: 'flag', fieldType: 'boolean' }])), /string, enum or number/);
  const many = Array.from({ length: 11 }, (_, i) => ({ fieldId: `f${i}`, fieldType: 'string' }));
  has(issues(f(many.map((m) => m.fieldId), many)), /at most 10/);
});

test('geocode: an unknown key inside geocode is refused (strict)', () => {
  has(issues(withSchema({ fields: [{ fieldId: 'loc', fieldType: 'geo', geocode: { from: ['x'], provider: 'y' } }] })),
    /Unrecognized key|provider/);
});

test('geocode: refused on a document schema (geocoding is record schemas only)', () => {
  has(issues(withSchema({ allowedSurfaces: ['document'], fields: [{ fieldId: 'street', fieldType: 'string' }, { fieldId: 'loc', fieldType: 'geo', geocode: { from: ['street'] } }] })),
    /record schemas only/);
});
