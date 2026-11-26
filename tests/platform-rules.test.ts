/**
 * The platform rules outside the schemas that depend only on the blueprint's text, refused offline. Each refusal has an accepted
 * neighbour.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBlueprint, BlueprintValidationError } from '../src/types.js';

function bp(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'demo',
    version: '1.0.0',
    description: 'demo blueprint',
    contextId: 'mcp',
    schemas: [
      { typeName: 'intake', displayName: 'Intake', fields: [{ fieldId: 'title', fieldType: 'string' }], capabilities: { triggersEnabled: true } },
    ],
    accessProfile: { allowedActions: ['records:r'] },
    servicePrincipal: { externalId: 'demo-sp', displayName: 'Demo SP' },
    ...extra,
  };
}

function issues(input: unknown): string[] {
  try {
    parseBlueprint(input);
    return [];
  } catch (err) {
    assert.ok(err instanceof BlueprintValidationError, `expected BlueprintValidationError, got ${err}`);
    return err.issues.map((i) => `${i.path}: ${i.message}`);
  }
}

const has = (found: string[], pattern: RegExp) => assert.ok(found.some((i) => pattern.test(i)), `expected ${pattern} in ${JSON.stringify(found)}`);

const trigger = { firingSource: { schemaName: 'intake', event: 'CREATE' }, scriptRef: { name: 'notify', version: '3' }, fields: [], allowedActions: ['records:r'] };
const issuer = {
  issuerId: 'auth0-prod',
  issuer: 'https://your-tenant.us.auth0.com/',
  jwksUri: 'https://your-tenant.us.auth0.com/.well-known/jwks.json',
  audience: 'https://api.your-app.example.com',
  contextId: 'mcp',
};

test("contextId 'vectros-admin' is reserved", () => {
  has(issues(bp({ contextId: 'vectros-admin' })), /contextId 'vectros-admin' is reserved/);
});

test('the app context name is at most 100 characters, including the default it takes from the name', () => {
  has(issues(bp({ contextName: 'x'.repeat(101) })), /contextName: the app context name is at most 100 characters/);
  assert.deepEqual(issues(bp({ contextName: 'x'.repeat(100) })), []);
  // the default is 'MCP — <name>': 6 characters plus the name
  has(issues(bp({ name: 'n'.repeat(95) })), /^name: the app context name is at most 100/);
  assert.deepEqual(issues(bp({ name: 'n'.repeat(94) })), []);
});

test('companyName is at most 100 characters', () => {
  has(issues(bp({ companyName: 'c'.repeat(101) })), /^companyName: companyName is at most 100 characters/);
  assert.deepEqual(issues(bp({ companyName: 'c'.repeat(100) })), []);
});

test('a blueprint that manages triggers, scripts or agents needs an identifier name; one that does not is unaffected', () => {
  has(issues(bp({ name: 'my app', triggers: { notify: trigger } })), /needs a name of 1 to 64 letters/);
  assert.deepEqual(issues(bp({ name: 'my app' })), []);
  assert.deepEqual(issues(bp({ name: 'my-app_2', triggers: { notify: trigger } })), []);
});

test('a trigger name follows the identifier grammar', () => {
  has(issues(bp({ triggers: { 'on create': trigger } })), /trigger name 'on create' must be 1 to 64/);
  assert.deepEqual(issues(bp({ triggers: { 'on-create_1': trigger } })), []);
});

test('at most one issuer, at most 20 self-signup policies, each signupType once', () => {
  has(issues(bp({ issuers: [issuer, { ...issuer, issuerId: 'okta-prod' }] })), /at most one issuer/);
  assert.deepEqual(issues(bp({ issuers: [issuer] })), []);
  const policy = (n: number) => ({ signupType: `kind-${n}`, roleId: 'member-role' });
  const roles = { roles: { 'member-role': [{ allowedActions: ['records:r'] }] } };
  has(
    issues(bp({ ...roles, issuers: [{ ...issuer, selfSignupPolicies: Array.from({ length: 21 }, (_, i) => policy(i)) }] })),
    /selfSignupPolicies lists at most 20/,
  );
  has(issues(bp({ ...roles, issuers: [{ ...issuer, selfSignupPolicies: [policy(1), policy(1)] }] })), /signupType 'kind-1' is listed more than once/);
  assert.deepEqual(issues(bp({ ...roles, issuers: [{ ...issuer, selfSignupPolicies: [policy(1), policy(2)] }] })), []);
});
