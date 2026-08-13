/**
 * `schemas[].scopes` and `seed[].scopes` — the array `<namespace>:<value>` form
 * of the ownership-scope grammar, ≤2 entries. Same platform rule as
 * `identityOverrides` (namespace grammar + forbidden set, scope-value grammar,
 * placeholder-aware on the value half), different wire shape: an array of
 * colon-joined strings rather than a `scope:<ns>`-keyed map.
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

function withSchemaScopes(scopes: unknown[]): unknown {
  return minimal({
    schemas: [{ typeName: 'task', displayName: 'Task', scopes } as never],
  });
}

function withSeedScopes(scopes: unknown[]): unknown {
  return minimal({
    schemas: [{ typeName: 'task', displayName: 'Task' }],
    seed: [{ surface: 'record', typeName: 'task', externalId: 's1', fields: {}, scopes } as never],
  });
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

// ── shape: must be '<namespace>:<value>' ────────────────────────────────────────

test('schemas[].scopes: REJECTS an entry with no colon', () => {
  const paths = issuePaths(withSchemaScopes(['org']));
  assert.ok(
    paths.includes('schemas[0].scopes[0]'),
    `expected a schemas[0].scopes[0] issue, got ${JSON.stringify(paths)}`,
  );
});

test('seed[].scopes: REJECTS an entry with no colon', () => {
  const paths = issuePaths(withSeedScopes(['org']));
  assert.ok(paths.includes('seed[0].scopes[0]'), `expected a seed[0].scopes[0] issue, got ${JSON.stringify(paths)}`);
});

test('schemas[].scopes: REJECTS an entry with an empty namespace (":value")', () => {
  const paths = issuePaths(withSchemaScopes([':value']));
  assert.ok(paths.includes('schemas[0].scopes[0]'), `expected an issue, got ${JSON.stringify(paths)}`);
});

test('schemas[].scopes: REJECTS an entry with an empty value ("org:")', () => {
  const paths = issuePaths(withSchemaScopes(['org:']));
  assert.ok(paths.includes('schemas[0].scopes[0]'), `expected an issue, got ${JSON.stringify(paths)}`);
});

// A malformed value containing a SECOND colon must be rejected as a bad VALUE
// (via the value grammar, which excludes ':'), not silently reinterpreted by
// splitting on a different colon — mirrors the platform's own
// ScopeNamespaces.parseScopeValue, which splits on the FIRST colon only.
test('schemas[].scopes: REJECTS "org:a:b" as a bad value, not a reinterpreted namespace/value pair', () => {
  const paths = issuePaths(withSchemaScopes(['org:a:b']));
  assert.ok(paths.includes('schemas[0].scopes[0]'), `expected an issue, got ${JSON.stringify(paths)}`);
});

// ── namespace half ───────────────────────────────────────────────────────────

test('schemas[].scopes: REJECTS a forbidden namespace ("entity" collides with the schema bind surface)', () => {
  const paths = issuePaths(withSchemaScopes(['entity:x']));
  assert.ok(paths.includes('schemas[0].scopes[0]'), `expected an issue, got ${JSON.stringify(paths)}`);
});

// Every forbidden namespace, individually — behavioral coverage for the full
// FORBIDDEN_SCOPE_NAMESPACES set (module-private, not re-exported, so this is
// a behavioral pin rather than a `.source`/set-equality lockstep test; the
// deeper cross-copy drift risk this only partially closes is tracked
// separately). Keep this list in lockstep with types.ts's own set by hand.
const FORBIDDEN_NAMESPACES_FOR_TEST = [
  'user', 'record', 'document', 'entity', 'self', 'tenant', 'context', 'scope', 'versions', 'lookup',
];
for (const ns of FORBIDDEN_NAMESPACES_FOR_TEST) {
  test(`schemas[].scopes: REJECTS the forbidden namespace "${ns}"`, () => {
    const paths = issuePaths(withSchemaScopes([`${ns}:x`]));
    assert.ok(paths.includes('schemas[0].scopes[0]'), `expected an issue for '${ns}', got ${JSON.stringify(paths)}`);
  });
}

test('schemas[].scopes: ACCEPTS the reserved "org" namespace with a grammar-valid value', () => {
  const bp = parseBlueprint(withSchemaScopes(['org:org_acme-1']));
  assert.deepEqual(bp.schemas[0].scopes, ['org:org_acme-1']);
});

test('schemas[].scopes: ACCEPTS an open, grammar-valid custom namespace', () => {
  const bp = parseBlueprint(withSchemaScopes(['team:eng-1']));
  assert.deepEqual(bp.schemas[0].scopes, ['team:eng-1']);
});

// ── value half ───────────────────────────────────────────────────────────────

test('seed[].scopes: REJECTS a colon-bearing value', () => {
  // Already covered by "org:a:b" above via a different route (no separator search
  // difference), but seed[] is a structurally distinct field from schemas[] — this
  // proves lintNamespacedScopeArrays actually walks BOTH, not just one.
  const paths = issuePaths(withSeedScopes(['team:a:b']));
  assert.ok(paths.includes('seed[0].scopes[0]'), `expected an issue, got ${JSON.stringify(paths)}`);
});

test('seed[].scopes: ACCEPTS the documented ${{ identities.<name> }} substitution token as the value', () => {
  const input = withSeedScopes(['team:${{ identities.team }}']) as Record<string, unknown>;
  (input as { identities: unknown }).identities = { team: { kind: 'org', externalId: 'o-9' } };
  const bp = parseBlueprint(input);
  assert.deepEqual(bp.seed?.[0].scopes, ['team:${{ identities.team }}']);
});

// The accept-path was tested on seed[].scopes but not schemas[].scopes — same
// lintScopeEntries walk, but nothing pinned that schemas[] actually gets it too.
test('schemas[].scopes: ACCEPTS the documented ${{ identities.<name> }} substitution token as the value', () => {
  const input = withSchemaScopes(['team:${{ identities.team }}']) as Record<string, unknown>;
  (input as { identities: unknown }).identities = { team: { kind: 'org', externalId: 'o-9' } };
  const bp = parseBlueprint(input);
  assert.deepEqual(bp.schemas[0].scopes, ['team:${{ identities.team }}']);
});

test('seed[].scopes: REJECTS a ${{ identities.<name> }} token referencing an undeclared identity', () => {
  const paths = issuePaths(withSeedScopes(['team:${{ identities.ghost }}']));
  assert.ok(paths.length > 0, `expected an issue for the undeclared identity, got none`);
});

// ── ≤2 cap ───────────────────────────────────────────────────────────────────

test('schemas[].scopes: REJECTS a 3rd entry (structural .max(2))', () => {
  const paths = issuePaths(withSchemaScopes(['org:a', 'client:b', 'team:c']));
  assert.ok(paths.some((p) => p.startsWith('schemas[0].scopes')), `expected a cap issue, got ${JSON.stringify(paths)}`);
});

// seed[].scopes previously had NO .max(2) despite its own docstring saying '≤2' —
// this pins the fix.
test('seed[].scopes: REJECTS a 3rd entry (structural .max(2), previously unenforced)', () => {
  const paths = issuePaths(withSeedScopes(['org:a', 'client:b', 'team:c']));
  assert.ok(paths.some((p) => p.startsWith('seed[0].scopes')), `expected a cap issue, got ${JSON.stringify(paths)}`);
});

// ── one value per namespace ─────────────────────────────────────────────────
//
// Found in review: the platform's own applyAuthoredScopes rejects a namespace
// repeated with a conflicting value — this array previously accepted it.

test('schemas[].scopes: REJECTS the same namespace twice with DIFFERENT values', () => {
  const paths = issuePaths(withSchemaScopes(['org:a', 'org:b']));
  assert.ok(
    paths.some((p) => p.startsWith('schemas[0].scopes')),
    `expected a duplicate-namespace issue, got ${JSON.stringify(paths)}`,
  );
});

test('schemas[].scopes: ACCEPTS the same namespace repeated with the IDENTICAL value (harmless redundancy)', () => {
  const bp = parseBlueprint(withSchemaScopes(['org:a', 'org:a']));
  assert.deepEqual(bp.schemas[0].scopes, ['org:a', 'org:a']);
});

// ── the empty-array private-item form must still work ────────────────────────

test('seed[].scopes: ACCEPTS an empty array (documented "private, user-owned item" form)', () => {
  const bp = parseBlueprint(withSeedScopes([]));
  assert.deepEqual(bp.seed?.[0].scopes, []);
});
