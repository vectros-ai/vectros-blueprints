/**
 * `publicView.search`: the coverage the platform needs before it offers a public search, refused offline. Each refusal has an
 * accepted neighbour.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBlueprint, BlueprintValidationError } from '../src/types.js';

function bp(schema: Record<string, unknown>): unknown {
  return {
    name: 'demo',
    version: '1.0.0',
    description: 'demo blueprint',
    contextId: 'mcp',
    schemas: [
      {
        typeName: 'listing',
        displayName: 'Listing',
        fields: [
          { fieldId: 'title', fieldType: 'string', searchable: true },
          { fieldId: 'count', fieldType: 'number' },
        ],
        ...schema,
      },
    ],
    accessProfile: { allowedActions: ['records:r'] },
    servicePrincipal: { externalId: 'demo-sp', displayName: 'Demo SP' },
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

const record = (search: string[], extra: Record<string, unknown> = {}) => ({ publicView: { mode: 'record', ownedBy: ['userId'], search, ...extra } });

test('record mode: indexMode must cover each offered search mode', () => {
  // left out, a re-apply keeps the stored mode, which the format cannot see: not checked
  assert.ok(!issues(bp({ ...record(['text']) })).some((i) => /offers 'text'/.test(i)), 'no indexMode declared');
  assert.ok(issues(bp({ indexMode: 'NONE', ...record(['text']) })).some((i) => /offers 'text', but indexMode is NONE/.test(i)));
  assert.ok(issues(bp({ indexMode: 'SEMANTIC', ...record(['text']) })).some((i) => /offers 'text'/.test(i)));
  assert.ok(issues(bp({ indexMode: 'TEXT', ...record(['semantic']) })).some((i) => /offers 'semantic'/.test(i)));
  assert.ok(issues(bp({ indexMode: 'TEXT', ...record(['hybrid']) })).some((i) => /offers 'hybrid'/.test(i)));
  for (const [indexMode, mode] of [['TEXT', 'text'], ['HYBRID', 'text'], ['SEMANTIC', 'semantic'], ['SEMANTIC', 'hybrid'], ['HYBRID', 'hybrid']]) {
    assert.deepEqual(issues(bp({ indexMode, ...record([mode]) })), [], `${indexMode}/${mode}`);
  }
});

test('record mode: needs a searchable field that is not sensitive', () => {
  const fields = [{ fieldId: 'title', fieldType: 'string' }, { fieldId: 'note', fieldType: 'string', sensitive: true }];
  assert.ok(issues(bp({ indexMode: 'TEXT', fields, ...record(['text']) })).some((i) => /at least one searchable field that is not sensitive/.test(i)));
});

test('projection mode: needs a listed string field; the indexMode does not bind it', () => {
  const projection = (fields: string[]) => ({ publicView: { fields, ownedBy: ['userId'], search: ['text'] } });
  assert.ok(issues(bp(projection(['count']))).some((i) => /at least one listed field of type string/.test(i)));
  assert.deepEqual(issues(bp(projection(['title', 'count']))), []);
});

test('a filterable field or a publishWhen field may not carry a name the search engine keeps', () => {
  const fields = [
    { fieldId: 'title', fieldType: 'string', searchable: true },
    { fieldId: 'Scope', fieldType: 'string', filterable: true },
  ];
  assert.ok(issues(bp({ indexMode: 'TEXT', fields, ...record(['text']) })).some((i) => /filterable field named 'Scope'/.test(i)), 'case-insensitive');
  const geo = [{ fieldId: 'title', fieldType: 'string', searchable: true }, { fieldId: '_geo_x', fieldType: 'string', filterable: true }];
  assert.ok(issues(bp({ indexMode: 'TEXT', fields: geo, ...record(['text']) })).some((i) => /'_geo_x'/.test(i)));
  const pw = [{ fieldId: 'title', fieldType: 'string', searchable: true }, { fieldId: 'text', fieldType: 'string' }];
  assert.ok(
    issues(bp({ indexMode: 'TEXT', fields: pw, ...record(['text'], { publishWhen: { field: 'text', in: ['open'] } }) })).some((i) =>
      /cannot publish by 'text'/.test(i),
    ),
  );
  // without public search the names are harmless
  assert.ok(!issues(bp({ fields, publicView: { mode: 'record', ownedBy: ['userId'] } })).some((i) => /search engine/.test(i)));
});
