/**
 * Format-passthrough tests (blueprint-format-passthrough slice).
 *
 * Guards the NEW format-v2 fields the loader stopped dropping:
 *   - field-level `validation` (ValidationRules) + `renderHints`
 *   - schema-level `capabilities` (auditHistory) + `ownership`
 *   - `lookupFields` object form ({ fieldName, unique? }) alongside the
 *     back-compat bare-string form
 *
 * Structural validation only — the loader-side passthrough is guarded in
 * @vectros-ai/cli (tests/loader-passthrough.test.ts).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBlueprint, BlueprintValidationError, type Blueprint } from '../src/types.js';

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

function withSchema(schema: Record<string, unknown>): unknown {
  return {
    ...minimal(),
    schemas: [
      {
        typeName: 'thing',
        displayName: 'Thing',
        fields: [{ fieldId: 'externalId', fieldType: 'string', required: true }],
        ...schema,
      },
    ],
  };
}

test('accepts field-level validation + renderHints (passthrough)', () => {
  const bp = parseBlueprint(
    withSchema({
      fields: [
        {
          fieldId: 'title',
          fieldType: 'string',
          required: true,
          searchable: true,
          validation: { minLength: 1, maxLength: 200, pattern: '^[A-Z]' },
          renderHints: { label: 'Title', widget: 'text', order: 1, section: 'Body' },
        },
        {
          fieldId: 'email',
          fieldType: 'string',
          validation: { email: true, maxLength: 254 },
          renderHints: { label: 'Email', widget: 'text' },
        },
      ],
    }),
  );
  const f0 = bp.schemas[0].fields[0];
  assert.equal(f0.validation?.minLength, 1);
  assert.equal(f0.validation?.maxLength, 200);
  assert.equal(f0.renderHints?.widget, 'text');
  assert.equal(bp.schemas[0].fields[1].validation?.email, true);
});

test('accepts field-level sensitive (PHI/PII passthrough)', () => {
  const bp = parseBlueprint(
    withSchema({
      fields: [
        { fieldId: 'ssn', fieldType: 'string', sensitive: true },
        { fieldId: 'title', fieldType: 'string', searchable: true },
      ],
    }),
  );
  assert.equal(bp.schemas[0].fields[0].sensitive, true);
  // Omitted on a non-sensitive field — the platform default (false) applies.
  assert.equal(bp.schemas[0].fields[1].sensitive, undefined);
});

test('rejects a non-boolean sensitive value (strict)', () => {
  assert.throws(
    () =>
      parseBlueprint(
        withSchema({ fields: [{ fieldId: 'x', fieldType: 'string', sensitive: 'yes' }] }),
      ),
    BlueprintValidationError,
  );
});

test('rejects an unknown validation rule key (strict)', () => {
  assert.throws(
    () =>
      parseBlueprint(
        withSchema({
          fields: [{ fieldId: 'x', fieldType: 'string', validation: { bogusRule: 5 } }],
        }),
      ),
    BlueprintValidationError,
  );
});

test('accepts renderHints.displayField (headline-field passthrough)', () => {
  const bp = parseBlueprint(
    withSchema({
      fields: [
        { fieldId: 'title', fieldType: 'string', renderHints: { label: 'Title', displayField: true } },
      ],
    }),
  );
  assert.equal(bp.schemas[0].fields[0].renderHints?.displayField, true);
});

test('rejects a non-boolean renderHints.displayField (strict)', () => {
  assert.throws(
    () =>
      parseBlueprint(
        withSchema({ fields: [{ fieldId: 'x', fieldType: 'string', renderHints: { displayField: 'yes' } }] }),
      ),
    BlueprintValidationError,
  );
});

test('rejects a renderHints widget outside the allowed enum (strict)', () => {
  assert.throws(
    () =>
      parseBlueprint(
        withSchema({
          fields: [{ fieldId: 'x', fieldType: 'string', renderHints: { widget: 'wysiwyg' } }],
        }),
      ),
    BlueprintValidationError,
  );
});

test('accepts schema-level capabilities + active + flat ownership (passthrough)', () => {
  const bp = parseBlueprint(
    withSchema({
      capabilities: { auditHistory: false },
      active: true,
      orgId: 'org_acme',
    }),
  );
  assert.equal(bp.schemas[0].capabilities?.auditHistory, false);
  assert.equal(bp.schemas[0].active, true);
  assert.equal(bp.schemas[0].orgId, 'org_acme');
});

test('rejects an unknown capabilities key (strict)', () => {
  assert.throws(
    () => parseBlueprint(withSchema({ capabilities: { auditHistory: true, ttl: 30 } })),
    BlueprintValidationError,
  );
});

test('accepts lookupFields in object form (+ unique) and mixed with strings', () => {
  const bp = parseBlueprint(
    withSchema({
      lookupFields: ['externalId', { fieldName: 'email', unique: true }],
    }),
  );
  assert.deepEqual(bp.schemas[0].lookupFields, [
    'externalId',
    { fieldName: 'email', unique: true },
  ]);
});

test('accepts the range/index lookup attributes (rangeEnabled, sortBy, allowOverflow)', () => {
  const bp = parseBlueprint(
    withSchema({
      lookupFields: [
        { fieldName: 'created', rangeEnabled: true, sortBy: 'lastUpdated' },
        { fieldName: 'sku', unique: true, allowOverflow: true },
      ],
    }),
  );
  assert.deepEqual(bp.schemas[0].lookupFields, [
    { fieldName: 'created', rangeEnabled: true, sortBy: 'lastUpdated' },
    { fieldName: 'sku', unique: true, allowOverflow: true },
  ]);
});

test('rejects an unknown key inside a lookupFields object (strict)', () => {
  assert.throws(
    () =>
      parseBlueprint(
        withSchema({ lookupFields: [{ fieldName: 'email', uniqueX: true }] }),
      ),
    BlueprintValidationError,
  );
});

test('BACK-COMPAT: a v1-flat blueprint (string lookupFields, no new fields) still parses', () => {
  const bp = parseBlueprint(
    withSchema({
      fields: [{ fieldId: 'externalId', fieldType: 'string', required: true }],
      lookupFields: ['externalId'],
    }),
  );
  assert.deepEqual(bp.schemas[0].lookupFields, ['externalId']);
  assert.equal(bp.schemas[0].fields[0].validation, undefined);
  assert.equal(bp.schemas[0].fields[0].renderHints, undefined);
  assert.equal(bp.schemas[0].fields[0].sensitive, undefined);
  assert.equal(bp.schemas[0].capabilities, undefined);
  assert.equal(bp.schemas[0].active, undefined);
  assert.equal(bp.schemas[0].userId, undefined);
  assert.equal(bp.schemas[0].orgId, undefined);
  assert.equal(bp.schemas[0].clientId, undefined);
});

test('rejects an unknown top-level schema key (strict)', () => {
  assert.throws(
    () => parseBlueprint(withSchema({ bogusSchemaKey: true })),
    BlueprintValidationError,
  );
});
