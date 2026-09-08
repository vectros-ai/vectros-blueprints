/**
 * `assignableRoles` (0.43.0) — the designated-roleId allow-list on a scope clause, restricting WHICH
 * named roles that clause may compose into a delegated AccessProfile (`roleIds` composition).
 * Orthogonal to `allowedActions`/`dataScope`: it narrows which roles the clause's authority may hand
 * out, not how much data it reaches.
 *
 * Structural validation only, transcribed from the platform's `ScopeClause.validateAssignableRoles`
 * and `RoleDB.ROLE_ID_PATTERN`. Entries are deliberately NOT resolved against this blueprint's own
 * `roles` block — a clause may legitimately name a roleId that already exists in the context, so
 * only the format is knowable offline.
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

const withRole = (clause: Record<string, unknown>) => minimal({ roles: { admin: [clause as never] } });

test('assignableRoles: omitting it is valid — absent means UNRESTRICTED (default-open)', () => {
  const bp = parseBlueprint(withRole({ allowedActions: ['profiles:c'] }));
  assert.equal(bp.roles?.admin[0].assignableRoles, undefined);
});

test('assignableRoles: accepts a roleId list on a role clause and preserves order', () => {
  const bp = parseBlueprint(
    withRole({ allowedActions: ['profiles:c'], assignableRoles: ['case-handler', 'hr-admin'] }),
  );
  assert.deepEqual(bp.roles?.admin[0].assignableRoles, ['case-handler', 'hr-admin']);
});

test('assignableRoles: an EMPTY list is REJECTED — absent is how you say "no restriction"', () => {
  // The platform refuses to let [] and absent mean two different things. Asserted explicitly
  // because "restricted to nothing" is the intuitive-but-wrong reading of [].
  assert.deepEqual(issuePaths(withRole({ allowedActions: ['profiles:c'], assignableRoles: [] })), [
    'roles.admin[0].assignableRoles',
  ]);
});

test('assignableRoles: REJECTS a roleId outside the platform roleId grammar', () => {
  // 'ab' is two characters: the pattern is a leading letter PLUS 2..30 more, so 3 is the floor.
  for (const bad of ['Case-Handler', 'ab', '9lives', 'has_underscore', 'a'.repeat(32)]) {
    assert.deepEqual(
      issuePaths(withRole({ allowedActions: ['profiles:c'], assignableRoles: [bad] })),
      ['roles.admin[0].assignableRoles[0]'],
      `expected '${bad}' to be rejected`,
    );
  }
  // The boundaries of the same pattern, accepted.
  for (const ok of ['abc', 'a'.repeat(31), 'a-b-c', 'a1b']) {
    assert.deepEqual(
      issuePaths(withRole({ allowedActions: ['profiles:c'], assignableRoles: [ok] })),
      [],
      `expected '${ok}' to be accepted`,
    );
  }
});

test('assignableRoles: REJECTS more than 20 entries, and accepts exactly 20', () => {
  const ids = (n: number) => Array.from({ length: n }, (_, i) => `role-${i}`);
  assert.deepEqual(issuePaths(withRole({ allowedActions: ['profiles:c'], assignableRoles: ids(21) })), [
    'roles.admin[0].assignableRoles',
  ]);
  assert.deepEqual(issuePaths(withRole({ allowedActions: ['profiles:c'], assignableRoles: ids(20) })), []);
});

test('assignableRoles: REJECTS a duplicate rather than deduplicating, naming the second occurrence', () => {
  assert.deepEqual(
    issuePaths(withRole({ allowedActions: ['profiles:c'], assignableRoles: ['hr-admin', 'x-role', 'hr-admin'] })),
    ['roles.admin[0].assignableRoles[2]'],
  );
});

test('assignableRoles: an entry need NOT name a role this blueprint declares', () => {
  // Deliberate: a clause may name a roleId that already exists in the context, or one another
  // blueprint declares. Only the FORMAT is knowable offline, so a resolution lint here would
  // reject valid blueprints.
  assert.deepEqual(
    issuePaths(withRole({ allowedActions: ['profiles:c'], assignableRoles: ['not-in-this-blueprint'] })),
    [],
  );
});

test('assignableRoles: is accepted on an accessProfile inline clause too', () => {
  const bp = parseBlueprint(
    minimal({ accessProfile: { allowedActions: ['profiles:c'], assignableRoles: ['hr-admin'] } }),
  );
  assert.deepEqual(bp.accessProfile.assignableRoles, ['hr-admin']);
});

test('assignableRoles: REJECTED on a roleIds-composed accessProfile — there is no inline clause to carry it', () => {
  // Same carve-out dataScope and capabilities already have: a role-composed profile has no clause
  // of its own, so the field belongs on the referenced role's clause.
  assert.deepEqual(
    issuePaths(minimal({ roles: { admin: [{ allowedActions: ['profiles:c'] }] },
      accessProfile: { roleIds: ['admin'], assignableRoles: ['hr-admin'] } })),
    ['accessProfile.assignableRoles'],
  );
});
