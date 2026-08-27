/**
 * Additive role composition at the AccessProfile: an
 * `accessProfile.roleIds` reference (plural) as an alternative to an inline
 * `allowedActions` clause. Mirrors `AccessProfileDB`'s `roleId` → `roleIds`
 * shape at the authoring layer.
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

test('roleIds: composes an AccessProfile from 2+ named roles declared in the same blueprint', () => {
  const bp = parseBlueprint(
    minimal({
      accessProfile: { roleIds: ['case-handler', 'hr-admin'] },
      roles: {
        'case-handler': [{ allowedActions: ['records:r:case', 'records:u:case'] }],
        'hr-admin': [{ allowedActions: ['records:r:hr'] }],
      },
    } as Partial<Blueprint>),
  );
  assert.deepEqual(bp.accessProfile.roleIds, ['case-handler', 'hr-admin']);
  assert.equal(bp.accessProfile.allowedActions, undefined);
});

test('roleIds: a single-role composition is accepted (equivalent to the legacy singular roleId on the wire)', () => {
  const bp = parseBlueprint(
    minimal({
      accessProfile: { roleIds: ['engineering-member'] },
      roles: { 'engineering-member': [{ allowedActions: ['records:r'] }] },
    } as Partial<Blueprint>),
  );
  assert.deepEqual(bp.accessProfile.roleIds, ['engineering-member']);
});

test('roleIds: REJECTS both allowedActions and roleIds on the same accessProfile (XOR)', () => {
  const paths = issuePaths(
    minimal({
      accessProfile: { allowedActions: ['records:r'], roleIds: ['case-handler'] },
      roles: { 'case-handler': [{ allowedActions: ['records:r:case'] }] },
    } as Partial<Blueprint>),
  );
  assert.ok(
    paths.some((p) => p === 'accessProfile.roleIds'),
    `expected an accessProfile.roleIds issue, got ${JSON.stringify(paths)}`,
  );
});

test('roleIds: REJECTS neither allowedActions nor roleIds on accessProfile (XOR, other direction)', () => {
  const paths = issuePaths(minimal({ accessProfile: {} } as Partial<Blueprint>));
  assert.ok(
    paths.some((p) => p === 'accessProfile.roleIds'),
    `expected an accessProfile.roleIds issue, got ${JSON.stringify(paths)}`,
  );
});

test('roleIds: REJECTS a roleId this blueprint does not declare in roles (the cross-context/undeclared-reference case)', () => {
  const paths = issuePaths(
    minimal({
      accessProfile: { roleIds: ['ghost-role'] },
      roles: { 'case-handler': [{ allowedActions: ['records:r:case'] }] },
    } as Partial<Blueprint>),
  );
  assert.ok(
    paths.some((p) => p === 'accessProfile.roleIds[0]'),
    `expected an accessProfile.roleIds[0] issue, got ${JSON.stringify(paths)}`,
  );
});

test('roleIds: REJECTS a duplicate entry in roleIds (never silently deduplicated)', () => {
  const paths = issuePaths(
    minimal({
      accessProfile: { roleIds: ['case-handler', 'case-handler'] },
      roles: { 'case-handler': [{ allowedActions: ['records:r:case'] }] },
    } as Partial<Blueprint>),
  );
  assert.ok(
    paths.some((p) => p === 'accessProfile.roleIds[1]'),
    `expected an accessProfile.roleIds[1] duplicate issue, got ${JSON.stringify(paths)}`,
  );
});

test('roleIds: REJECTS an empty roleIds array (structural — mirrors the non-blank-roleId rule)', () => {
  const paths = issuePaths(
    minimal({ accessProfile: { roleIds: [] } } as unknown as Partial<Blueprint>),
  );
  assert.ok(
    paths.some((p) => p.startsWith('accessProfile.roleIds')),
    `expected an accessProfile.roleIds issue, got ${JSON.stringify(paths)}`,
  );
});

test('roleIds: REJECTS dataScope alongside roleIds — a role-composed profile has no inline clause of its own', () => {
  const paths = issuePaths(
    minimal({
      accessProfile: { roleIds: ['case-handler'], dataScope: { 'scope:org': ['org_x'] } },
      roles: { 'case-handler': [{ allowedActions: ['records:r:case'] }] },
    } as Partial<Blueprint>),
  );
  assert.ok(
    paths.some((p) => p === 'accessProfile.dataScope'),
    `expected an accessProfile.dataScope issue, got ${JSON.stringify(paths)}`,
  );
});

test('roleIds: REJECTS capabilities alongside roleIds — author the grant on the referenced role instead', () => {
  const paths = issuePaths(
    minimal({
      accessProfile: { roleIds: ['case-handler'], capabilities: ['member-lifecycle'] },
      roles: { 'case-handler': [{ allowedActions: ['records:r:case'] }] },
    } as Partial<Blueprint>),
  );
  assert.ok(
    paths.some((p) => p === 'accessProfile.capabilities'),
    `expected an accessProfile.capabilities issue, got ${JSON.stringify(paths)}`,
  );
});

test('roleIds: identityOverrides remains valid alongside roleIds — a profile-level field, independent of the clause source', () => {
  const bp = parseBlueprint(
    minimal({
      accessProfile: { roleIds: ['case-handler'], identityOverrides: { 'scope:org': 'org_x' } },
      roles: { 'case-handler': [{ allowedActions: ['records:r:case'] }] },
    } as Partial<Blueprint>),
  );
  assert.deepEqual(bp.accessProfile.identityOverrides, { 'scope:org': 'org_x' });
});

test('roleIds: omitting it entirely is fine — an existing inline-scope blueprint is unaffected', () => {
  const bp = parseBlueprint(minimal());
  assert.equal(bp.accessProfile.roleIds, undefined);
  assert.deepEqual(bp.accessProfile.allowedActions, ['records:r']);
});
