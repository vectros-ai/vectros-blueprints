/**
 * `dataScope` KEYS — on both `accessProfile.dataScope` and every
 * `roles[].*.dataScope` clause. `userId` is the one non-namespaced key this
 * field allows (the principal dimension); every other key must be a
 * grammar-valid, non-forbidden `scope:<ns>`. VALUES are out of scope here
 * (a richer grammar — literal, `null` sentinel, or a runtime `${{ self.* }}`/
 * `${{ under.self.* }}` placeholder, the latter confined by the separate
 * `lintSelfTokenPlacement`).
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

// ── accessProfile.dataScope ─────────────────────────────────────────────────

test('accessProfile.dataScope: ACCEPTS "userId" as a bare key (the principal dimension)', () => {
  const bp = parseBlueprint(
    minimal({ accessProfile: { allowedActions: ['records:r'], dataScope: { userId: ['u_1', null] } } }),
  );
  assert.deepEqual(bp.accessProfile.dataScope?.userId, ['u_1', null]);
});

test('accessProfile.dataScope: ACCEPTS a grammar-valid "scope:<ns>" key', () => {
  const bp = parseBlueprint(
    minimal({ accessProfile: { allowedActions: ['records:r'], dataScope: { 'scope:org': ['org_x', null] } } }),
  );
  assert.deepEqual(bp.accessProfile.dataScope?.['scope:org'], ['org_x', null]);
});

test('accessProfile.dataScope: REJECTS the retired bare "orgId" key', () => {
  const paths = issuePaths(
    minimal({ accessProfile: { allowedActions: ['records:r'], dataScope: { orgId: ['org_x'] } } }),
  );
  assert.ok(
    paths.includes('accessProfile.dataScope.orgId'),
    `expected an issue on the orgId key, got ${JSON.stringify(paths)}`,
  );
});

test('accessProfile.dataScope: REJECTS a forbidden namespace key ("scope:tenant")', () => {
  const paths = issuePaths(
    minimal({ accessProfile: { allowedActions: ['records:r'], dataScope: { 'scope:tenant': ['x'] } } }),
  );
  assert.ok(
    paths.includes('accessProfile.dataScope.scope:tenant'),
    `expected an issue on the scope:tenant key, got ${JSON.stringify(paths)}`,
  );
});

test('accessProfile.dataScope: REJECTS a namespace key that fails the shape grammar (uppercase)', () => {
  const paths = issuePaths(
    minimal({ accessProfile: { allowedActions: ['records:r'], dataScope: { 'scope:Team': ['x'] } } }),
  );
  assert.ok(
    paths.includes('accessProfile.dataScope.scope:Team'),
    `expected an issue on the scope:Team key, got ${JSON.stringify(paths)}`,
  );
});

test('accessProfile.dataScope: REJECTS a key that is neither "userId" nor "scope:<ns>" shaped', () => {
  const paths = issuePaths(
    minimal({ accessProfile: { allowedActions: ['records:r'], dataScope: { garbage: ['x'] } } }),
  );
  assert.ok(
    paths.includes('accessProfile.dataScope.garbage'),
    `expected an issue on the garbage key, got ${JSON.stringify(paths)}`,
  );
});

test('accessProfile.dataScope: values (including the null sentinel) are untouched by the key check', () => {
  const bp = parseBlueprint(
    minimal({
      accessProfile: {
        allowedActions: ['records:r'],
        dataScope: { 'scope:org': ['org_x', null], userId: ['u_1'] },
      },
    }),
  );
  assert.deepEqual(bp.accessProfile.dataScope, { 'scope:org': ['org_x', null], userId: ['u_1'] });
});

// ── roles[].*.dataScope — same rule, different location ────────────────────

test('roles[].dataScope: ACCEPTS "userId" and a grammar-valid "scope:<ns>" key', () => {
  const bp = parseBlueprint(
    minimal({
      roles: { member: [{ allowedActions: ['records:r'], dataScope: { userId: ['u_1'], 'scope:team': ['t_1'] } }] },
    } as Partial<Blueprint>),
  );
  assert.deepEqual(bp.roles?.member[0].dataScope, { userId: ['u_1'], 'scope:team': ['t_1'] });
});

test('roles[].dataScope: REJECTS the retired bare "clientId" key', () => {
  const paths = issuePaths(
    minimal({ roles: { member: [{ allowedActions: ['records:r'], dataScope: { clientId: ['x'] } }] } } as Partial<Blueprint>),
  );
  assert.ok(
    paths.includes('roles.member[0].dataScope.clientId'),
    `expected an issue on the clientId key, got ${JSON.stringify(paths)}`,
  );
});

test('roles[].dataScope: REJECTS a forbidden namespace key ("scope:user")', () => {
  const paths = issuePaths(
    minimal({
      roles: { member: [{ allowedActions: ['records:r'], dataScope: { 'scope:user': ['x'] } }] },
    } as Partial<Blueprint>),
  );
  assert.ok(
    paths.includes('roles.member[0].dataScope.scope:user'),
    `expected an issue on the scope:user key, got ${JSON.stringify(paths)}`,
  );
});

// Every clause, not just the first — a first-clause-only check would miss this.
test('roles[].dataScope: REJECTS a bad key in the SECOND clause of a multi-clause role', () => {
  const paths = issuePaths(
    minimal({
      roles: {
        member: [
          { allowedActions: ['records:r'], dataScope: { userId: ['u_1'] } },
          { allowedActions: ['records:r:task'], dataScope: { orgId: ['x'] } },
        ],
      },
    } as Partial<Blueprint>),
  );
  assert.ok(
    paths.includes('roles.member[1].dataScope.orgId'),
    `expected an issue on the second clause's key, got ${JSON.stringify(paths)}`,
  );
});

// Every ROLE, not just the first declared one.
test('roles[].dataScope: REJECTS a bad key on a role OTHER than the first in the map', () => {
  const paths = issuePaths(
    minimal({
      roles: {
        first: [{ allowedActions: ['records:r'], dataScope: { userId: ['u_1'] } }],
        second: [{ allowedActions: ['records:r'], dataScope: { 'scope:tenant': ['x'] } }],
      },
    } as Partial<Blueprint>),
  );
  assert.ok(
    paths.includes('roles.second[0].dataScope.scope:tenant'),
    `expected an issue on the second role's key, got ${JSON.stringify(paths)}`,
  );
});

// ── composes with the existing self.* placement lint, doesn't replace it ────

test('roles[].dataScope: a valid key with a ${{ self.* }} value still passes (placement + key checks compose)', () => {
  const bp = parseBlueprint(
    minimal({
      roles: {
        member: [{ allowedActions: ['records:r:task'], dataScope: { 'scope:org': ['${{ self.scope.org }}'] } }],
      },
    } as Partial<Blueprint>),
  );
  assert.deepEqual(bp.roles?.member[0].dataScope?.['scope:org'], ['${{ self.scope.org }}']);
});

test('accessProfile.dataScope: a BAD key with a ${{ self.* }} value gets BOTH issues (key check + placement lint)', () => {
  const messages = (() => {
    try {
      parseBlueprint(
        minimal({
          accessProfile: { allowedActions: ['records:r'], dataScope: { 'scope:tenant': ['${{ self.userId }}'] } },
        }),
      );
      return [];
    } catch (err) {
      assert.ok(err instanceof BlueprintValidationError);
      return (err as BlueprintValidationError).issues.map((i) => i.message);
    }
  })();
  assert.ok(
    messages.some((m) => m.includes('scope:tenant')),
    `expected a key-grammar issue, got ${JSON.stringify(messages)}`,
  );
  assert.ok(
    messages.some((m) => m.includes('self.*')),
    `expected a self.* placement issue too, got ${JSON.stringify(messages)}`,
  );
});
