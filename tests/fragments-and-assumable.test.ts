/**
 * Blueprint-authoring reuse features:
 *   `fragments:` + a role clause's `dataScopeRef` (dataScope reuse sugar)
 *   `roleAssumable` (the `POST /v1/auth/token/assume` entitlement grant)
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

// ── fragments / dataScopeRef ────────────────────────────────────────

test('fragments: a clause dataScopeRef expands to the fragment\'s literal dataScope', () => {
  const bp = parseBlueprint(
    minimal({
      fragments: { ownOrg: { 'scope:org': ['${{ self.scope.org }}'] } },
      roles: {
        case_handler: [{ allowedActions: ['records:cru:case'], dataScopeRef: 'ownOrg' }],
      },
    } as Partial<Blueprint>),
  );
  const clause = bp.roles?.case_handler[0];
  assert.deepEqual(clause?.dataScope, { 'scope:org': ['${{ self.scope.org }}'] });
});

test('fragments: dataScopeRef never survives parseBlueprint — the wire only ever sees a literal dataScope', () => {
  const bp = parseBlueprint(
    minimal({
      fragments: { ownOrg: { 'scope:org': ['${{ self.scope.org }}'] } },
      roles: { r: [{ allowedActions: ['records:r'], dataScopeRef: 'ownOrg' }] },
    } as Partial<Blueprint>),
  );
  assert.equal('dataScopeRef' in (bp.roles?.r[0] as object), false);
});

test('fragments: the SAME fragment referenced from several clauses expands independently (the casework.blueprint.yaml motivating case)', () => {
  const bp = parseBlueprint(
    minimal({
      fragments: { ownOrg: { 'scope:org': ['${{ self.scope.org }}'] } },
      roles: {
        case_handler: [
          { allowedActions: ['records:cru:case'], dataScopeRef: 'ownOrg' },
          { allowedActions: ['records:cru:case_note', 'documents:cr', 'search:r', 'inference:r'], dataScopeRef: 'ownOrg' },
          { allowedActions: ['entities:r:org'], dataScopeRef: 'ownOrg' },
          { allowedActions: ['entities:cr:client'], dataScopeRef: 'ownOrg' },
        ],
      },
    } as Partial<Blueprint>),
  );
  const clauses = bp.roles?.case_handler ?? [];
  assert.equal(clauses.length, 4);
  for (const c of clauses) {
    assert.deepEqual(c.dataScope, { 'scope:org': ['${{ self.scope.org }}'] });
  }
  // Byte-identical to the hand-inlined equivalent (the acceptance bar's own phrasing).
  const inlined = parseBlueprint(
    minimal({
      roles: {
        case_handler: [
          { allowedActions: ['records:cru:case'], dataScope: { 'scope:org': ['${{ self.scope.org }}'] } },
          {
            allowedActions: ['records:cru:case_note', 'documents:cr', 'search:r', 'inference:r'],
            dataScope: { 'scope:org': ['${{ self.scope.org }}'] },
          },
          { allowedActions: ['entities:r:org'], dataScope: { 'scope:org': ['${{ self.scope.org }}'] } },
          { allowedActions: ['entities:cr:client'], dataScope: { 'scope:org': ['${{ self.scope.org }}'] } },
        ],
      },
    } as Partial<Blueprint>),
  );
  assert.deepEqual(bp.roles?.case_handler, inlined.roles?.case_handler);
});

test('fragments: REJECTS a dataScopeRef naming an undeclared fragment', () => {
  const paths = issuePaths(
    minimal({ roles: { r: [{ allowedActions: ['records:r'], dataScopeRef: 'nope' }] } } as Partial<Blueprint>),
  );
  assert.ok(
    paths.some((p) => p === 'roles.r[0].dataScopeRef'),
    `expected a roles.r[0].dataScopeRef issue, got ${JSON.stringify(paths)}`,
  );
});

test('fragments: REJECTS a clause declaring BOTH dataScope and dataScopeRef', () => {
  const paths = issuePaths(
    minimal({
      fragments: { ownOrg: { 'scope:org': ['org_1'] } },
      roles: {
        r: [{ allowedActions: ['records:r'], dataScope: { userId: ['u_1'] }, dataScopeRef: 'ownOrg' }],
      },
    } as Partial<Blueprint>),
  );
  assert.ok(
    paths.some((p) => p.includes('dataScopeRef')),
    `expected a dataScopeRef issue, got ${JSON.stringify(paths)}`,
  );
});

test('fragments: a fragment\'s KEYS are validated with the same grammar as roles[].dataScope', () => {
  const paths = issuePaths(
    minimal({ fragments: { bad: { 'scope:tenant': ['x'] } } } as Partial<Blueprint>),
  );
  assert.ok(
    paths.some((p) => p.startsWith('fragments.bad')),
    `expected a fragments.bad issue, got ${JSON.stringify(paths)}`,
  );
});

test('fragments: ${{ self.* }} / ${{ under.self.* }} / ${{ member.* }} are legal inside a fragment value', () => {
  const bp = parseBlueprint(
    minimal({
      fragments: {
        f: {
          userId: ['${{ self.userId }}'],
          'scope:org': ['${{ under.self.scope.org }}'],
          'scope:team': ['${{ member.scope.team:lead }}'],
        },
      },
    } as Partial<Blueprint>),
  );
  assert.deepEqual(bp.fragments?.f.userId, ['${{ self.userId }}']);
});

test('fragments: omitting fragments entirely is fine when no clause uses dataScopeRef (unaffected — the existing behavior)', () => {
  const bp = parseBlueprint(
    minimal({ roles: { r: [{ allowedActions: ['records:r'], dataScope: { userId: ['u_1'] } }] } } as Partial<Blueprint>),
  );
  assert.equal(bp.fragments, undefined);
  assert.deepEqual(bp.roles?.r[0].dataScope, { userId: ['u_1'] });
});

// ── roleAssumable ────────────────────────────────────────────────────

test('roleAssumable: accepts a grant naming a declared role, round-tripping the map unchanged', () => {
  const bp = parseBlueprint(
    minimal({
      roles: { hr_admin: [{ allowedActions: ['records:r:case'] }] },
      roleAssumable: { hr_admin: { 'scope:org': ['org_engineering', 'org_sales'] } },
    } as Partial<Blueprint>),
  );
  assert.deepEqual(bp.roleAssumable, { hr_admin: { 'scope:org': ['org_engineering', 'org_sales'] } });
});

test('roleAssumable: ACCEPTS the documented runtime matchers plus a plain literal', () => {
  const bp = parseBlueprint(
    minimal({
      roles: { hr_admin: [{ allowedActions: ['records:r:case'] }] },
      roleAssumable: {
        hr_admin: {
          'scope:org': [
            '${{ under.self.userId }}',
            '${{ member.scope.org }}',
            '${{ member.scope.org:lead }}',
            'org_literal',
          ],
        },
      },
    } as Partial<Blueprint>),
  );
  assert.equal(bp.roleAssumable?.hr_admin['scope:org'].length, 4);
});

// The accepted forms all depend on a plain literal or on the credential's own
// PRINCIPAL, which an assume can never change. `${{ under.self.scope.<ns> }}`
// does not: it reads the credential's current value for a namespace an assume
// CAN move, so what the grant admitted would depend on what was last assumed —
// and where one profile composes several roles they share one identity, so one
// role's grant would silently widen or narrow another's. The server rejects it
// at role-authoring time, so linting it clean here would pass `blueprint plan`
// and then 400 inside `vectros bootstrap`, possibly after other resources were
// already provisioned. Both halves are asserted: rejected in `assumable`, and
// still ACCEPTED in `dataScope`, where it is re-derived per write.
test('roleAssumable: REJECTS ${{ under.self.scope.<ns> }} — it depends on a dimension an assume can move', () => {
  const paths = issuePaths(
    minimal({
      roles: { hr_admin: [{ allowedActions: ['records:r:case'] }] },
      roleAssumable: { hr_admin: { 'scope:org': ['${{ under.self.scope.org }}'] } },
    } as Partial<Blueprint>),
  );
  assert.deepEqual(paths, ['roleAssumable.hr_admin.scope:org[0]']);
});

test('dataScope still ACCEPTS ${{ under.self.scope.<ns> }} — the narrowing is scoped to assumable', () => {
  const bp = parseBlueprint(
    minimal({
      roles: {
        hr_admin: [
          { allowedActions: ['records:r:case'], dataScope: { 'scope:org': ['${{ under.self.scope.org }}'] } },
        ],
      },
    } as Partial<Blueprint>),
  );
  assert.deepEqual(bp.roles?.hr_admin[0].dataScope, { 'scope:org': ['${{ under.self.scope.org }}'] });
});

test('roleAssumable: REJECTS an uppercase member.scope level — the server\'s level grammar is lowercase-first, same as a namespace', () => {
  const paths = issuePaths(
    minimal({
      roles: { hr_admin: [{ allowedActions: ['records:r:case'] }] },
      roleAssumable: { hr_admin: { 'scope:org': ['${{ member.scope.org:Lead }}'] } },
    } as Partial<Blueprint>),
  );
  assert.ok(
    paths.some((p) => p === 'roleAssumable.hr_admin.scope:org[0]'),
    `expected a roleAssumable.hr_admin.scope:org[0] issue, got ${JSON.stringify(paths)}`,
  );
});

test('roleAssumable: REJECTS a key naming the principal (userId) — the principal is never assumable', () => {
  const paths = issuePaths(
    minimal({
      roles: { hr_admin: [{ allowedActions: ['records:r:case'] }] },
      roleAssumable: { hr_admin: { userId: ['u_1'] } },
    } as Partial<Blueprint>),
  );
  assert.ok(
    paths.some((p) => p === 'roleAssumable.hr_admin.userId'),
    `expected a roleAssumable.hr_admin.userId issue, got ${JSON.stringify(paths)}`,
  );
});

test('roleAssumable: REJECTS a key naming a namespace this grammar forbids (same forbidden set as dataScope)', () => {
  const paths = issuePaths(
    minimal({
      roles: { hr_admin: [{ allowedActions: ['records:r:case'] }] },
      roleAssumable: { hr_admin: { 'scope:tenant': ['x'] } },
    } as Partial<Blueprint>),
  );
  assert.ok(
    paths.some((p) => p === 'roleAssumable.hr_admin.scope:tenant'),
    `expected a roleAssumable.hr_admin.scope:tenant issue, got ${JSON.stringify(paths)}`,
  );
});

test('roleAssumable: REJECTS a bare ${{ self.<dim> }} value — tautological, never a distinct value to become', () => {
  const paths = issuePaths(
    minimal({
      roles: { hr_admin: [{ allowedActions: ['records:r:case'] }] },
      roleAssumable: { hr_admin: { 'scope:org': ['${{ self.scope.org }}'] } },
    } as Partial<Blueprint>),
  );
  assert.ok(
    paths.some((p) => p === 'roleAssumable.hr_admin.scope:org[0]'),
    `expected a roleAssumable.hr_admin.scope:org[0] issue, got ${JSON.stringify(paths)}`,
  );
});

test('roleAssumable: REJECTS ${{ any }} — not a concrete value', () => {
  const paths = issuePaths(
    minimal({
      roles: { hr_admin: [{ allowedActions: ['records:r:case'] }] },
      roleAssumable: { hr_admin: { 'scope:org': ['${{ any }}'] } },
    } as Partial<Blueprint>),
  );
  assert.ok(
    paths.some((p) => p === 'roleAssumable.hr_admin.scope:org[0]'),
    `expected a roleAssumable.hr_admin.scope:org[0] issue, got ${JSON.stringify(paths)}`,
  );
});

test('roleAssumable: REJECTS a roleId this blueprint does not declare in roles', () => {
  const paths = issuePaths(
    minimal({
      roles: { hr_admin: [{ allowedActions: ['records:r:case'] }] },
      roleAssumable: { ghost_role: { 'scope:org': ['org_x'] } },
    } as Partial<Blueprint>),
  );
  assert.ok(
    paths.some((p) => p === 'roleAssumable.ghost_role'),
    `expected a roleAssumable.ghost_role issue, got ${JSON.stringify(paths)}`,
  );
});

test('roleAssumable: REJECTS an empty value list (structural — a dimension with nothing granted should be omitted)', () => {
  const paths = issuePaths(
    minimal({
      roles: { hr_admin: [{ allowedActions: ['records:r:case'] }] },
      roleAssumable: { hr_admin: { 'scope:org': [] } },
    } as Partial<Blueprint>),
  );
  assert.ok(
    paths.some((p) => p.startsWith('roleAssumable.hr_admin.scope:org')),
    `expected a roleAssumable.hr_admin.scope:org issue, got ${JSON.stringify(paths)}`,
  );
});

test('roleAssumable: omitting it entirely is fine — an existing blueprint with no assumable grant is unaffected', () => {
  const bp = parseBlueprint(
    minimal({ roles: { hr_admin: [{ allowedActions: ['records:r:case'] }] } } as Partial<Blueprint>),
  );
  assert.equal(bp.roleAssumable, undefined);
});

test('roleAssumable: a role with no assumable grant at all is untouched — `roles` itself never changes shape for this feature', () => {
  const bp = parseBlueprint(
    minimal({
      roles: { editor: [{ allowedActions: ['records:cru'] }], viewer: [{ allowedActions: ['records:r'] }] },
      roleAssumable: { editor: { 'scope:org': ['org_x'] } },
    } as Partial<Blueprint>),
  );
  assert.equal(Array.isArray(bp.roles?.editor), true);
  assert.equal(Array.isArray(bp.roles?.viewer), true);
  assert.deepEqual(bp.roleAssumable, { editor: { 'scope:org': ['org_x'] } });
});
