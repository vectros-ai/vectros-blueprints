/**
 * Readable validation errors — the teach-by-error contract.
 *
 * parseBlueprint must turn zod's internal issue objects into a readable
 * multi-line `path: message` body (NOT a JSON.stringify dump) AND expose the
 * structured issues on `.issues` for programmatic callers.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBlueprint, parseBlueprintJson, BlueprintValidationError } from '../src/types.js';

const base = {
  name: 'x',
  version: '1.0.0',
  description: 'x',
  contextId: 'mcp',
  schemas: [],
  accessProfile: { allowedActions: ['records:r'] },
  servicePrincipal: { externalId: 'a', displayName: 'b' },
};

function caught(fn: () => unknown): BlueprintValidationError {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof BlueprintValidationError, 'expected BlueprintValidationError');
    return e;
  }
  throw new assert.AssertionError({ message: 'expected a throw' });
}

test('message is readable (not a raw JSON dump) for a missing required field', () => {
  const { name, ...noName } = base;
  void name;
  const e = caught(() => parseBlueprint(noName));
  // Readable bullet line, not a `[ { "code": ... } ]` blob.
  assert.match(e.message, /Malformed blueprint:/);
  assert.match(e.message, /•\s+name:/);
  assert.doesNotMatch(e.message, /"code"|"path"|invalid_type/);
});

test('.issues exposes structured {path, message} entries', () => {
  const { name, ...noName } = base;
  void name;
  const e = caught(() => parseBlueprint(noName));
  assert.ok(Array.isArray(e.issues));
  const nameIssue = e.issues.find((i) => i.path === 'name');
  assert.ok(nameIssue, 'expected an issue with path "name"');
  assert.equal(typeof nameIssue!.message, 'string');
});

test('nested paths render with bracket+dot notation', () => {
  const e = caught(() =>
    parseBlueprint({
      ...base,
      schemas: [{ typeName: 't', displayName: 'T', fields: [{ fieldId: 'a', fieldType: 'string', bogus: 1 }] }],
    }),
  );
  const issue = e.issues.find((i) => i.path === 'schemas[0].fields[0]');
  assert.ok(issue, `expected schemas[0].fields[0]; got ${e.issues.map((i) => i.path).join(', ')}`);
  assert.match(e.message, /schemas\[0\]\.fields\[0\]:/);
});

test('the custom contextId message is preserved verbatim', () => {
  const e = caught(() => parseBlueprint({ ...base, contextId: 'X' }));
  const issue = e.issues.find((i) => i.path === 'contextId');
  assert.ok(issue);
  assert.match(issue!.message, /3-31 chars/);
});

test('multiple problems are all reported, one per line', () => {
  const { name, ...noName } = base;
  void name;
  const e = caught(() => parseBlueprint({ ...noName, contextId: 'X' }));
  assert.ok(e.issues.length >= 2, `expected >=2 issues, got ${e.issues.length}`);
  const lines = e.message.split('\n').filter((l) => l.trim().startsWith('•'));
  assert.equal(lines.length, e.issues.length);
});

test('a bad-JSON parse error has an empty .issues (no field path) but a clear message', () => {
  const e = caught(() => parseBlueprintJson('{not json'));
  assert.deepEqual(e.issues, []);
  assert.match(e.message, /not valid JSON/);
});

test('(root) path is used when the issue has no field path (non-object input)', () => {
  const e = caught(() => parseBlueprint('totally not an object'));
  assert.ok(e.issues.some((i) => i.path === '(root)'));
});
