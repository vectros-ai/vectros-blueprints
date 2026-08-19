/**
 * `capabilities` (format passthrough to the platform's `granted_capabilities`)
 * on a role clause and on `accessProfile`. Structural validation ONLY — this
 * package deliberately does not know the closed set of grantable names
 * (that's the CLI scope gate's job, against the live registry, a separate
 * package), so these tests assert the SHAPE checks (grammar / '*' /
 * duplicates) and specifically that an unrecognized-but-well-formed name is
 * NOT rejected here.
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

function issueMessages(input: unknown): string[] {
  try {
    parseBlueprint(input);
    return [];
  } catch (err) {
    assert.ok(err instanceof BlueprintValidationError, `expected BlueprintValidationError, got ${err}`);
    return err.issues.map((i) => i.message);
  }
}

// ── omitted / passthrough ────────────────────────────────────────────────────

test('capabilities: omitted entirely on both role clause and accessProfile — parses fine (optional)', () => {
  const bp = parseBlueprint(
    minimal({
      roles: { member: [{ allowedActions: ['records:r:task'] }] },
    } as Partial<Blueprint>),
  );
  assert.equal(bp.roles?.member[0].capabilities, undefined);
  assert.equal(bp.accessProfile.capabilities, undefined);
});

test('capabilities: accepts a well-formed list on a role clause', () => {
  const bp = parseBlueprint(
    minimal({
      roles: {
        hr_admin: [{ allowedActions: ['records:cru:case'], capabilities: ['member-lifecycle'] }],
      },
    } as Partial<Blueprint>),
  );
  assert.deepEqual(bp.roles?.hr_admin[0].capabilities, ['member-lifecycle']);
});

test('capabilities: accepts a well-formed list on accessProfile (DECISION — allowed here too, not role-clause-only)', () => {
  const bp = parseBlueprint(
    minimal({ accessProfile: { allowedActions: ['records:r'], capabilities: ['member-lifecycle'] } }),
  );
  assert.deepEqual(bp.accessProfile.capabilities, ['member-lifecycle']);
});

test('capabilities: an unrecognized-but-well-formed name is NOT rejected here (forward-compatible; the CLI scope gate refuses it, not this package)', () => {
  const bp = parseBlueprint(
    minimal({
      roles: { member: [{ allowedActions: ['records:r:task'], capabilities: ['some-future-capability'] }] },
    } as Partial<Blueprint>),
  );
  assert.deepEqual(bp.roles?.member[0].capabilities, ['some-future-capability']);
});

// ── structural rejections ────────────────────────────────────────────────────

test("capabilities: REJECTS '*' — not a wildcard, an unknown name", () => {
  const paths = issuePaths(
    minimal({ roles: { member: [{ allowedActions: ['records:r:task'], capabilities: ['*'] }] } } as Partial<Blueprint>),
  );
  assert.ok(
    paths.some((p) => p.includes('capabilities')),
    `expected a capabilities issue, got ${JSON.stringify(paths)}`,
  );
});

test('capabilities: REJECTS an uppercase name', () => {
  const paths = issuePaths(
    minimal({
      roles: { member: [{ allowedActions: ['records:r:task'], capabilities: ['Member-Lifecycle'] }] },
    } as Partial<Blueprint>),
  );
  assert.ok(paths.some((p) => p.includes('capabilities')), `expected a capabilities issue, got ${JSON.stringify(paths)}`);
});

test('capabilities: REJECTS a colon-bearing entry (a capability is not an action)', () => {
  const paths = issuePaths(
    minimal({
      roles: { member: [{ allowedActions: ['records:r:task'], capabilities: ['records:r'] }] },
    } as Partial<Blueprint>),
  );
  assert.ok(paths.some((p) => p.includes('capabilities')), `expected a capabilities issue, got ${JSON.stringify(paths)}`);
});

test('capabilities: REJECTS a name starting with a digit', () => {
  const paths = issuePaths(
    minimal({
      roles: { member: [{ allowedActions: ['records:r:task'], capabilities: ['1st-capability'] }] },
    } as Partial<Blueprint>),
  );
  assert.ok(paths.some((p) => p.includes('capabilities')), `expected a capabilities issue, got ${JSON.stringify(paths)}`);
});

test('capabilities: REJECTS a blank entry', () => {
  const paths = issuePaths(
    minimal({ roles: { member: [{ allowedActions: ['records:r:task'], capabilities: [''] }] } } as Partial<Blueprint>),
  );
  assert.ok(paths.some((p) => p.includes('capabilities')), `expected a capabilities issue, got ${JSON.stringify(paths)}`);
});

test('capabilities: REJECTS a duplicate entry', () => {
  const messages = issueMessages(
    minimal({
      roles: {
        member: [{ allowedActions: ['records:r:task'], capabilities: ['member-lifecycle', 'member-lifecycle'] }],
      },
    } as Partial<Blueprint>),
  );
  assert.ok(
    messages.some((m) => m.includes('more than once')),
    `expected a duplicate-entry message, got ${JSON.stringify(messages)}`,
  );
});

test('capabilities: REJECTS a non-string array element', () => {
  const paths = issuePaths(
    minimal({
      roles: { member: [{ allowedActions: ['records:r:task'], capabilities: ['member-lifecycle', 123] }] },
    } as unknown as Partial<Blueprint>),
  );
  assert.ok(paths.some((p) => p.includes('capabilities')), `expected a capabilities issue, got ${JSON.stringify(paths)}`);
});

// ── interactions between the '*' / grammar / duplicate checks ───────────────

test("capabilities: REJECTS a repeated '*' with BOTH a wildcard issue and a duplicate issue", () => {
  const messages = issueMessages(
    minimal({ roles: { member: [{ allowedActions: ['records:r:task'], capabilities: ['*', '*'] }] } } as Partial<Blueprint>),
  );
  assert.ok(messages.some((m) => m.includes('not a capability')), `expected the wildcard message, got ${JSON.stringify(messages)}`);
  assert.ok(messages.some((m) => m.includes('more than once')), `expected the duplicate message, got ${JSON.stringify(messages)}`);
});

test('capabilities: REJECTS a repeated invalid-grammar name with BOTH a grammar issue on each entry and a duplicate issue', () => {
  const messages = issueMessages(
    minimal({
      roles: { member: [{ allowedActions: ['records:r:task'], capabilities: ['Bad!Name', 'Bad!Name'] }] },
    } as Partial<Blueprint>),
  );
  const grammarHits = messages.filter((m) => m.includes('not a valid capability name'));
  assert.equal(grammarHits.length, 2, `expected a grammar issue on EACH entry, got ${JSON.stringify(messages)}`);
  assert.ok(messages.some((m) => m.includes('more than once')), `expected the duplicate message, got ${JSON.stringify(messages)}`);
});

// ── accessProfile: full grammar parity with the role-clause field ───────────
// (the two fields share ONE `GrantedCapabilitiesSchema` instance today — these
// pin that parity so a future refactor that replaces one with a drifted inline
// copy is caught here, not just on the '*' case above.)

test('capabilities: REJECTS on accessProfile the same way as on a role clause (grammar violation)', () => {
  const paths = issuePaths(minimal({ accessProfile: { allowedActions: ['records:r'], capabilities: ['*'] } }));
  assert.ok(
    paths.some((p) => p.startsWith('accessProfile.capabilities')),
    `expected an accessProfile.capabilities issue, got ${JSON.stringify(paths)}`,
  );
});

test('capabilities: REJECTS an uppercase name on accessProfile', () => {
  const paths = issuePaths(minimal({ accessProfile: { allowedActions: ['records:r'], capabilities: ['Member-Lifecycle'] } }));
  assert.ok(
    paths.some((p) => p.startsWith('accessProfile.capabilities')),
    `expected an accessProfile.capabilities issue, got ${JSON.stringify(paths)}`,
  );
});

test('capabilities: REJECTS a colon-bearing entry on accessProfile', () => {
  const paths = issuePaths(minimal({ accessProfile: { allowedActions: ['records:r'], capabilities: ['records:r'] } }));
  assert.ok(
    paths.some((p) => p.startsWith('accessProfile.capabilities')),
    `expected an accessProfile.capabilities issue, got ${JSON.stringify(paths)}`,
  );
});

test('capabilities: REJECTS a name starting with a digit on accessProfile', () => {
  const paths = issuePaths(minimal({ accessProfile: { allowedActions: ['records:r'], capabilities: ['1st-capability'] } }));
  assert.ok(
    paths.some((p) => p.startsWith('accessProfile.capabilities')),
    `expected an accessProfile.capabilities issue, got ${JSON.stringify(paths)}`,
  );
});

test('capabilities: REJECTS a blank entry on accessProfile', () => {
  const paths = issuePaths(minimal({ accessProfile: { allowedActions: ['records:r'], capabilities: [''] } }));
  assert.ok(
    paths.some((p) => p.startsWith('accessProfile.capabilities')),
    `expected an accessProfile.capabilities issue, got ${JSON.stringify(paths)}`,
  );
});

test('capabilities: REJECTS a duplicate entry on accessProfile', () => {
  const messages = issueMessages(
    minimal({ accessProfile: { allowedActions: ['records:r'], capabilities: ['member-lifecycle', 'member-lifecycle'] } }),
  );
  assert.ok(
    messages.some((m) => m.includes('more than once')),
    `expected a duplicate-entry message, got ${JSON.stringify(messages)}`,
  );
});

test('capabilities: an unrecognized-but-well-formed name is NOT rejected on accessProfile either', () => {
  const bp = parseBlueprint(
    minimal({ accessProfile: { allowedActions: ['records:r'], capabilities: ['some-future-capability'] } }),
  );
  assert.deepEqual(bp.accessProfile.capabilities, ['some-future-capability']);
});
