/**
 * `schemas[].expectedScopeDims` — the advisory, structural-only declaration
 * of a schema's intended ownership-scope dimensions. NOT enforced by
 * the runtime, NEVER sent to the platform — this package only validates the
 * grammar (each entry is 'userId' or a grammar-valid, non-forbidden
 * namespace, same as a `dataScope` key with the `scope:` prefix stripped)
 * plus a duplicate check. The cross-reference against role clauses' actual
 * `dataScope` coverage is `packages/cli`'s lint, not this package's.
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

function issuePaths(input: unknown): string[] {
  try {
    parseBlueprint(input);
    return [];
  } catch (err) {
    assert.ok(err instanceof BlueprintValidationError, `expected BlueprintValidationError, got ${err}`);
    return err.issues.map((i) => i.path);
  }
}

test('ACCEPTS grammar-valid namespace dims, preserved verbatim', () => {
  const bp = parseBlueprint(
    minimal({
      schemas: [{ typeName: 'case', displayName: 'Case', expectedScopeDims: ['org', 'client'] }],
    }),
  );
  assert.deepEqual(bp.schemas[0].expectedScopeDims, ['org', 'client']);
});

test('ACCEPTS "userId" alongside a namespace dim', () => {
  const bp = parseBlueprint(
    minimal({
      schemas: [{ typeName: 'note', displayName: 'Note', expectedScopeDims: ['userId', 'org'] }],
    }),
  );
  assert.deepEqual(bp.schemas[0].expectedScopeDims, ['userId', 'org']);
});

test('a schema with no expectedScopeDims at all parses clean (the field is fully optional)', () => {
  const bp = parseBlueprint(minimal({ schemas: [{ typeName: 'case', displayName: 'Case' }] }));
  assert.equal(bp.schemas[0].expectedScopeDims, undefined);
});

test('REJECTS a forbidden namespace ("tenant") — same forbidden set as a dataScope key', () => {
  const paths = issuePaths(
    minimal({ schemas: [{ typeName: 'case', displayName: 'Case', expectedScopeDims: ['tenant'] }] }),
  );
  assert.ok(
    paths.includes('schemas[0].expectedScopeDims[0]'),
    `expected an issue on the tenant dim, got ${JSON.stringify(paths)}`,
  );
});

test('REJECTS a dim that fails the namespace shape grammar (uppercase)', () => {
  const paths = issuePaths(
    minimal({ schemas: [{ typeName: 'case', displayName: 'Case', expectedScopeDims: ['Org'] }] }),
  );
  assert.ok(
    paths.includes('schemas[0].expectedScopeDims[0]'),
    `expected an issue on the Org dim, got ${JSON.stringify(paths)}`,
  );
});

test('REJECTS a "scope:" prefixed dim — dims are bare namespace names, not dataScope keys', () => {
  const paths = issuePaths(
    minimal({ schemas: [{ typeName: 'case', displayName: 'Case', expectedScopeDims: ['scope:org'] }] }),
  );
  assert.ok(
    paths.includes('schemas[0].expectedScopeDims[0]'),
    `expected an issue on the 'scope:org' dim, got ${JSON.stringify(paths)}`,
  );
});

test('REJECTS a duplicate dim listed twice', () => {
  const paths = issuePaths(
    minimal({ schemas: [{ typeName: 'case', displayName: 'Case', expectedScopeDims: ['org', 'org'] }] }),
  );
  assert.ok(
    paths.includes('schemas[0].expectedScopeDims[1]'),
    `expected an issue on the second 'org' dim, got ${JSON.stringify(paths)}`,
  );
});

test('REJECTS more than MAX_SCOPE_DIMENSIONS (2) entries — structural cap, same as dataScope/scopes', () => {
  assert.throws(
    () => parseBlueprint(
      minimal({ schemas: [{ typeName: 'case', displayName: 'Case', expectedScopeDims: ['org', 'client', 'team'] }] }),
    ),
    BlueprintValidationError,
  );
});
