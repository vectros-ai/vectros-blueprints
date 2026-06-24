/**
 * Reference-field surface + multi-clause roles + the `${{ self.* }}`
 * runtime-sentinel placement lint (all structural, in @vectros-ai/blueprints).
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

/** A blueprint whose single schema carries one field (merged with the given props). */
function withField(field: Record<string, unknown>): unknown {
  return minimal({
    schemas: [
      {
        typeName: 'task',
        displayName: 'Task',
        fields: [{ fieldId: 'link', fieldType: 'string', ...field } as never],
      },
    ],
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

// ── reference fields ─────────────────────────────────────────────────────────

test('reference: accepts a reference field with targetTypeName + targetSurface (+ optional targetField/cardinality)', () => {
  const bp = parseBlueprint(
    withField({
      fieldType: 'reference',
      targetTypeName: 'project',
      targetSurface: 'record',
      targetField: 'externalId',
      cardinality: 'one',
    }),
  );
  const f = bp.schemas[0].fields[0];
  assert.equal(f.fieldType, 'reference');
  assert.equal(f.targetTypeName, 'project');
  assert.equal(f.targetSurface, 'record');
  assert.equal(f.cardinality, 'one');
});

test('reference: REJECTS a reference field missing targetTypeName', () => {
  const paths = issuePaths(withField({ fieldType: 'reference', targetSurface: 'record' }));
  assert.ok(
    paths.some((p) => p.includes('targetTypeName')),
    `expected a targetTypeName issue, got ${JSON.stringify(paths)}`,
  );
});

test('reference: REJECTS a reference field missing targetSurface (platform requires it — would 400 at createSchema)', () => {
  const paths = issuePaths(withField({ fieldType: 'reference', targetTypeName: 'project' }));
  assert.ok(
    paths.some((p) => p.includes('targetSurface')),
    `expected a targetSurface issue, got ${JSON.stringify(paths)}`,
  );
});

test('reference: REJECTS an invalid targetSurface value (strict enum)', () => {
  const paths = issuePaths(
    withField({ fieldType: 'reference', targetTypeName: 'project', targetSurface: 'galaxy' }),
  );
  assert.ok(
    paths.some((p) => p.includes('targetSurface')),
    `expected a targetSurface issue, got ${JSON.stringify(paths)}`,
  );
});

test('reference: REJECTS target* keys on a non-reference field', () => {
  const paths = issuePaths(withField({ fieldType: 'string', targetTypeName: 'project' }));
  assert.ok(paths.some((p) => p.includes('fieldType')), `expected a fieldType issue, got ${JSON.stringify(paths)}`);
  const paths2 = issuePaths(withField({ fieldType: 'string', targetSurface: 'record' }));
  assert.ok(paths2.some((p) => p.includes('fieldType')), `expected a fieldType issue, got ${JSON.stringify(paths2)}`);
});

test('reference: REJECTS an invalid cardinality value', () => {
  const paths = issuePaths(withField({ fieldType: 'reference', targetTypeName: 'project', cardinality: 'lots' }));
  assert.ok(paths.some((p) => p.includes('cardinality')), `expected a cardinality issue, got ${JSON.stringify(paths)}`);
});

// ── multi-clause roles ───────────────────────────────────────────────────────

test('roles: accepts a multi-clause role map (clauses with allowedActions + dataScope null-sentinel)', () => {
  const bp = parseBlueprint(
    minimal({
      roles: {
        member: [
          { allowedActions: ['records:cru:task'], dataScope: { userId: ['u_1'] } },
          { allowedActions: ['records:r:task'], dataScope: { orgId: ['org_1', null] } },
        ],
      },
    } as Partial<Blueprint>),
  );
  assert.equal(bp.roles?.member.length, 2);
  assert.deepEqual(bp.roles?.member[1].dataScope?.orgId, ['org_1', null]);
});

test('roles: REJECTS a role with no clauses (empty array)', () => {
  const paths = issuePaths(minimal({ roles: { empty: [] } } as Partial<Blueprint>));
  assert.ok(paths.some((p) => p.startsWith('roles.empty')), `expected a roles.empty issue, got ${JSON.stringify(paths)}`);
});

test('roles: REJECTS a clause with empty allowedActions', () => {
  const paths = issuePaths(minimal({ roles: { member: [{ allowedActions: [] }] } } as Partial<Blueprint>));
  assert.ok(
    paths.some((p) => p.includes('allowedActions')),
    `expected an allowedActions issue, got ${JSON.stringify(paths)}`,
  );
});

// ── ${{ self.* }} placement lint ─────────────────────────────────────────────

test('self: ACCEPTS ${{ self.* }} inside a role clause dataScope (the runtime sentinel)', () => {
  const bp = parseBlueprint(
    minimal({
      roles: { member: [{ allowedActions: ['records:r:task'], dataScope: { userId: ['${{ self.userId }}'] } }] },
    } as Partial<Blueprint>),
  );
  assert.equal(bp.roles?.member[0].dataScope?.userId[0], '${{ self.userId }}');
});

test('self: REJECTS ${{ self.* }} in accessProfile.dataScope (not a per-principal scope)', () => {
  const paths = issuePaths(
    minimal({ accessProfile: { allowedActions: ['records:r'], dataScope: { userId: ['${{ self.userId }}'] } } }),
  );
  assert.ok(
    paths.some((p) => p.startsWith('accessProfile.dataScope')),
    `expected an accessProfile.dataScope issue, got ${JSON.stringify(paths)}`,
  );
});

test('self: REJECTS ${{ self.* }} in a seed record field (never resolves there)', () => {
  const paths = issuePaths(
    minimal({
      seed: [{ typeName: 'task', externalId: 'seed-1', fields: { owner: '${{ self.userId }}' } }],
    }),
  );
  assert.ok(paths.some((p) => p.startsWith('seed')), `expected a seed issue, got ${JSON.stringify(paths)}`);
});
