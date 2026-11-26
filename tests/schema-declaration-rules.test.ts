/**
 * The schema rules the platform applies at schema write that depend only on the blueprint's own text: each is refused
 * offline, and each has an accepted neighbour so a rule cannot pass by refusing everything.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBlueprint, BlueprintValidationError } from '../src/types.js';

function bp(schema: Record<string, unknown>, extra: Record<string, unknown> = {}): unknown {
  return {
    name: 'demo',
    version: '1.0.0',
    description: 'demo blueprint',
    contextId: 'mcp',
    schemas: [{ typeName: 'listing', displayName: 'Listing', fields: [{ fieldId: 'title', fieldType: 'string' }], ...schema }],
    accessProfile: { allowedActions: ['records:r'] },
    servicePrincipal: { externalId: 'demo-sp', displayName: 'Demo SP' },
    ...extra,
  };
}

function issues(input: unknown): string[] {
  try {
    parseBlueprint(input);
    return [];
  } catch (err) {
    assert.ok(err instanceof BlueprintValidationError, `expected BlueprintValidationError, got ${err}`);
    return err.issues.map((i) => `${i.path}: ${i.message}`);
  }
}

function refused(input: unknown, pattern: RegExp): void {
  const found = issues(input);
  assert.ok(found.some((i) => pattern.test(i)), `expected an issue matching ${pattern}, got ${JSON.stringify(found)}`);
}

test('identifier grammar: typeName, fieldId, lookup and reference names', () => {
  refused(bp({ typeName: 'has space' }), /typeName 'has space' must be 1 to 64 letters/);
  refused(bp({ typeName: 'a'.repeat(65) }), /typeName .* must be 1 to 64/);
  refused(bp({ fields: [{ fieldId: 'bad.name', fieldType: 'string' }] }), /fieldId 'bad.name'/);
  refused(bp({ lookupFields: ['bad.name'], fields: [{ fieldId: 'bad.name', fieldType: 'string' }] }), /lookupField 'bad.name'/);
  refused(
    bp({ fields: [{ fieldId: 'ref', fieldType: 'reference', targetTypeName: 'other type', targetField: 'id' }] }),
    /targetTypeName 'other type'/,
  );
  assert.deepEqual(issues(bp({ typeName: 'patient_visit-2', fields: [{ fieldId: 'source-Url_1', fieldType: 'string' }] })), []);
  assert.deepEqual(issues(bp({ typeName: 'a'.repeat(64) })), []);
});

test("a 'pv_' type name is not refused by the format (a type created before the prefix was kept may still be edited)", () => {
  assert.deepEqual(issues(bp({ typeName: 'pv_listing' })), []);
});

test('writePolicy: {} on an owned schema declares no fence, and is not refused', () => {
  assert.deepEqual(issues(bp({ scopes: ['org:acme'], writePolicy: {} })), []);
});

test('allowedSurfaces cannot mix identity and record or document surfaces', () => {
  refused(bp({ allowedSurfaces: ['record', 'entity'] }), /cannot mix 'user' or 'entity'/);
  refused(bp({ allowedSurfaces: ['document', 'user'] }), /cannot mix/);
  assert.deepEqual(issues(bp({ allowedSurfaces: ['record', 'document'] })), []);
  assert.deepEqual(issues(bp({ allowedSurfaces: ['entity'] })), []);
});

test('sensitive and searchable together are refused on an ordinary field', () => {
  refused(bp({ fields: [{ fieldId: 'note', fieldType: 'string', sensitive: true, searchable: true }] }), /cannot be both sensitive and searchable/);
  assert.deepEqual(issues(bp({ fields: [{ fieldId: 'note', fieldType: 'string', sensitive: true }] })), []);
  assert.deepEqual(issues(bp({ fields: [{ fieldId: 'note', fieldType: 'string', searchable: true }] })), []);
});

test('a reference field cannot be searchable', () => {
  const ref = { fieldId: 'owner', fieldType: 'reference', targetTypeName: 'person', targetField: 'email', targetSurface: 'record' };
  refused(bp({ fields: [{ ...ref, searchable: true }] }), /reference field 'owner' cannot be searchable/);
  assert.deepEqual(issues(bp({ fields: [ref] })), []);
});

test('a lookup declared twice is refused; a plain lookup beside a composite of it is not', () => {
  const fields = [{ fieldId: 'status', fieldType: 'string' }, { fieldId: 'area', fieldType: 'string' }];
  refused(bp({ fields, lookupFields: ['status', { fieldName: 'status' }] }), /lookupField 'status' is declared more than once/);
  refused(bp({ fields, lookupFields: [{ fieldNames: ['status', 'area'] }, { fieldNames: ['status', 'area'] }] }), /'status,area' is declared more than once/);
  assert.deepEqual(issues(bp({ fields, lookupFields: ['status', { fieldNames: ['status', 'area'] }] })), []);
});

test('sortBy cannot name a sensitive, array or object field; rangeEnabled cannot be on a sensitive field', () => {
  const fields = [
    { fieldId: 'email', fieldType: 'string' },
    { fieldId: 'secret', fieldType: 'string', sensitive: true },
    { fieldId: 'tags', fieldType: 'array' },
    { fieldId: 'meta', fieldType: 'object' },
    { fieldId: 'when', fieldType: 'date' },
  ];
  refused(bp({ fields, lookupFields: [{ fieldName: 'email', sortBy: 'secret' }] }), /sortBy cannot be 'secret': it is a sensitive field/);
  refused(bp({ fields, lookupFields: [{ fieldName: 'email', sortBy: 'tags' }] }), /an array field has no order/);
  refused(bp({ fields, lookupFields: [{ fieldName: 'email', sortBy: 'meta' }] }), /an object field has no order/);
  refused(bp({ fields, lookupFields: [{ fieldName: 'secret', rangeEnabled: true }] }), /'secret' cannot be rangeEnabled/);
  assert.deepEqual(issues(bp({ fields, lookupFields: [{ fieldName: 'email', sortBy: 'when' }, { fieldName: 'when', rangeEnabled: true }] })), []);
  assert.deepEqual(issues(bp({ fields, lookupFields: [{ fieldName: 'email', sortBy: 'createdAt' }] })), []);
});

test('a customization (basedOn) must declare an owner', () => {
  refused(bp({ basedOn: 'sch_base' }), /a customization \(basedOn\) must declare an owner/);
  assert.deepEqual(issues(bp({ basedOn: 'sch_base', scopes: ['org:acme'] })), []);
  assert.deepEqual(issues(bp({ basedOn: 'sch_base', userId: 'usr_1' })), []);
});

const shipped = { scripts: { moderate: { source: 'export default function run() { return 1; }' } } };

test('writePolicy only on a schema with no owner, and no via entry twice', () => {
  const fence = { create: { via: [{ script: 'moderate' }] } };
  refused(bp({ scopes: ['org:acme'], writePolicy: fence }, shipped), /writePolicy can be declared only on a schema with no userId and no scopes/);
  refused(
    bp({ writePolicy: { create: { via: [{ script: 'moderate' }, { script: 'moderate' }] } } }, shipped),
    /admits script 'moderate' twice with the same seal/,
  );
  assert.deepEqual(issues(bp({ writePolicy: fence }, shipped)), []);
});

test('writePolicy lists at most 50 triggers or agent ids per entry', () => {
  const many = Array.from({ length: 51 }, (_, i) => `agt_${i}`);
  refused(bp({ writePolicy: { create: { via: [{ script: 'moderate', paths: ['tool'], agentIds: many }] } } }, shipped), /agentIds/);
  assert.deepEqual(issues(bp({ writePolicy: { create: { via: [{ script: 'moderate', paths: ['tool'], agentIds: many.slice(0, 50) }] } } }, shipped)), []);
});

test('a dataScope dimension with an empty value list is refused', () => {
  const role = (dataScope: unknown) => ({ roles: { reader: [{ allowedActions: ['records:r'], dataScope }] } });
  refused(bp({}, role({ 'scope:org': [] })), /a dataScope dimension lists at least one value/);
  assert.deepEqual(issues(bp({}, role({ 'scope:org': ['acme'] }))), []);
});
