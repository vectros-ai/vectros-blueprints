/**
 * The publishWhen rules that depend on the field's declaration are refused offline, as the platform refuses them when it
 * writes the schema: a field that is not filterable, one that is not a single-field lookup of its own (a composite lookup
 * does not count), and `in` values of another type than the field's.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBlueprint } from '../src/types.js';

function listingMedia(stateField: Record<string, unknown>, lookupFields: unknown[] | undefined): unknown {
  return {
    name: 'demo',
    version: '1.0.0',
    description: 'demo blueprint',
    contextId: 'mcp',
    schemas: [
      {
        typeName: 'listing_media',
        displayName: 'Listing media',
        fields: [
          { fieldId: 'title', fieldType: 'string' },
          { fieldId: 'state', fieldType: 'string', ...stateField },
          { fieldId: 'area', fieldType: 'string', filterable: true },
        ],
        ...(lookupFields ? { lookupFields } : {}),
        publicView: { mode: 'record', ownedBy: ['userId'], publishWhen: { field: 'state', in: ['published'] } },
      },
    ],
    accessProfile: { allowedActions: ['records:r'] },
    servicePrincipal: { externalId: 'demo-sp', displayName: 'Demo SP' },
  };
}

test('a publishWhen field that is not filterable is refused offline', () => {
  assert.throws(() => parseBlueprint(listingMedia({}, ['state'])), /publishWhen.field 'state' must be filterable/);
  assert.doesNotThrow(() => parseBlueprint(listingMedia({ filterable: true }, ['state'])), 'filterable with its own lookup is accepted');
});

test('a filterable publishWhen field with no lookup of its own is refused offline', () => {
  assert.throws(() => parseBlueprint(listingMedia({ filterable: true }, undefined)), /must be declared as a lookup field of its own/);
});

test('a publishWhen field only in a composite lookup is refused offline', () => {
  assert.throws(() => parseBlueprint(listingMedia({ filterable: true }, [{ fieldNames: ['state', 'area'] }])), /must be declared as a lookup field of its own/);
});

test('publishWhen.in values of another type than the field are refused offline', () => {
  const bp = listingMedia({ filterable: true }, ['state']) as { schemas: { publicView: { publishWhen: { in: unknown[] } } }[] };
  bp.schemas[0].publicView.publishWhen.in = ['published', 1, true];
  assert.throws(() => parseBlueprint(bp), /publishWhen.in values must be/);
});

// ── field types, item types and capabilities ──

function oneField(field: Record<string, unknown>, extra: Record<string, unknown> = {}): unknown {
  return {
    name: 'demo',
    version: '1.0.0',
    description: 'demo blueprint',
    contextId: 'mcp',
    schemas: [{ typeName: 'shift', displayName: 'Shift', fields: [{ fieldId: 'f', ...field }], ...extra }],
    accessProfile: { allowedActions: ['records:r'] },
    servicePrincipal: { externalId: 'demo-sp', displayName: 'Demo SP' },
  };
}

test('itemType is declarable on an array field, and only there', () => {
  assert.equal(parseBlueprint(oneField({ fieldType: 'array', itemType: 'date' })).schemas[0].fields[0].itemType, 'date');
  assert.throws(() => parseBlueprint(oneField({ fieldType: 'string', itemType: 'date' })), /itemType applies only to an array field/);
});

test('fieldType instant is accepted offline', () => {
  assert.doesNotThrow(() => parseBlueprint(oneField({ fieldType: 'instant' })));
});

test('an unknown fieldType is accepted by the format (the CLI lint warns; the platform decides)', () => {
  assert.doesNotThrow(() => parseBlueprint(oneField({ fieldType: 'not-a-type' })));
});

test('capabilities: ttlEligible, strict, validateReferences and readAccessLog are declarable', () => {
  const bp = parseBlueprint(oneField({ fieldType: 'string' }, { capabilities: { ttlEligible: true, strict: false, validateReferences: false, readAccessLog: true } }));
  assert.deepEqual(bp.schemas[0].capabilities, { ttlEligible: true, strict: false, validateReferences: false, readAccessLog: true });
  assert.throws(() => parseBlueprint(oneField({ fieldType: 'string' }, { capabilities: { notACapability: true } })), /notACapability|Unrecognized/);
});
