/**
 * A record KEY that fails its schema must still be reported with the key schema's own message
 * (the identity-name grammar, the forgery-character rule), not zod's generic "Invalid key in
 * record". zod 4 nests the real message under an `invalid_key` issue; `parseBlueprint` reports it
 * at the key's path.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBlueprint, BlueprintValidationError, type BlueprintIssue } from '../src/types.js';
import { resolveBlueprintIdentities, BlueprintIdentityError } from '../src/identities.js';

function doc(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    name: 'demo',
    version: '1.0.0',
    description: 'demo',
    contextId: 'mcp',
    accessProfile: { allowedActions: ['records:r'] },
    servicePrincipal: { externalId: 'demo-sp', displayName: 'Demo' },
    ...overrides,
  };
}

function issuesOf(input: Record<string, unknown>): BlueprintIssue[] {
  try {
    parseBlueprint(input);
  } catch (err) {
    assert.ok(err instanceof BlueprintValidationError, 'expected a BlueprintValidationError');
    return err.issues;
  }
  assert.fail('expected the blueprint to be rejected');
}

test('a hyphenated identity name is reported with the identity-name grammar, at the name', () => {
  const issues = issuesOf(doc({ identities: { 'demo-org': { kind: 'org', externalId: 'o-1' } } }));
  const hit = issues.find((i) => i.path === 'identities.demo-org' && /identity name must match letters\/digits\/underscore/.test(i.message));
  assert.ok(hit, `expected the grammar message at identities.demo-org, got ${JSON.stringify(issues)}`);
  assert.ok(!issues.some((i) => /Invalid key in record/.test(i.message)), 'the generic record-key message must not surface');
});

test('a role id carrying a bidi control character is reported with the forgery-character rule', () => {
  const issues = issuesOf(doc({ roles: { 'admin\u202e': [{ allowedActions: ['records:r'] }] } }));
  const hit = issues.find((i) => i.path.startsWith('roles.') && /must not contain control characters/.test(i.message));
  assert.ok(hit, `expected the forgery-character message at the role key, got ${JSON.stringify(issues)}`);
  assert.ok(!issues.some((i) => /Invalid key in record/.test(i.message)), 'the generic record-key message must not surface');
});

test('a trigger name carrying a zero-width character is reported with the forgery-character rule', () => {
  const issues = issuesOf(doc({ triggers: { 't\u200b1': {} } }));
  const hit = issues.find((i) => i.path.startsWith('triggers.') && /must not contain control characters/.test(i.message));
  assert.ok(hit, `expected the forgery-character message at the trigger key, got ${JSON.stringify(issues)}`);
  assert.ok(!issues.some((i) => /Invalid key in record/.test(i.message)), 'the generic record-key message must not surface');
});

test('the apply-time identities check reports the identity-name grammar, not the generic record-key message', async () => {
  await assert.rejects(
    () =>
      resolveBlueprintIdentities(doc({ identities: { 'demo-org': { kind: 'org', externalId: 'o-1' } } }), async () => 'id'),
    (err: unknown) => {
      assert.ok(err instanceof BlueprintIdentityError);
      const msgs = err.issues.map((i) => i.message);
      assert.ok(msgs.some((m) => /identity name must match letters\/digits\/underscore/.test(m)), JSON.stringify(err.issues));
      assert.ok(!msgs.some((m) => /Invalid key in record/.test(m)), JSON.stringify(err.issues));
      return true;
    },
  );
});
