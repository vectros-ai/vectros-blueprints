/**
 * The platform settings a blueprint can now declare: the app context's own settings, an array field's item type, and a
 * schema's storage profile. What the platform limits is refused offline; everything else is passed on.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBlueprint, BlueprintValidationError } from '../src/types.js';

function bp(extra: Record<string, unknown> = {}, schema: Record<string, unknown> = {}): unknown {
  return {
    name: 'demo',
    version: '1.0.0',
    description: 'demo',
    contextId: 'mcp',
    schemas: [{ typeName: 'listing', displayName: 'Listing', fields: [{ fieldId: 'title', fieldType: 'string' }], ...schema }],
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

test('appContext: every setting is declarable, within the platform limits', () => {
  const appContext = {
    description: 'Case management for the north office',
    readAccessLogDefault: true,
    meteringAxis: 'scope:org',
    principalBurstLimit: 60,
    principalUsageCap: 10000,
    allowSelfErasure: true,
    selfErasureGraceDays: 14,
  };
  assert.deepEqual(parseBlueprint(bp({ appContext })).appContext, appContext);
  assert.deepEqual(parseBlueprint(bp({ appContext: { meteringAxis: 'user' } })).appContext, { meteringAxis: 'user' });
  // an empty description is accepted, as the platform accepts it
  assert.deepEqual(parseBlueprint(bp({ appContext: { description: '' } })).appContext, { description: '' });
  for (const [bad, pattern] of [
    [{ meteringAxis: 'org' }, /meteringAxis is 'user' or 'scope:<namespace>'/],
    [{ principalBurstLimit: 0 }, /principalBurstLimit/],
    [{ principalUsageCap: -1 }, /principalUsageCap/],
    [{ selfErasureGraceDays: 31 }, /selfErasureGraceDays/],
    [{ description: 'x'.repeat(501) }, /description/],
    [{ notASetting: true }, /notASetting|Unrecognized/],
  ] as const) {
    assert.ok(issues(bp({ appContext: bad })).some((i) => pattern.test(i)), JSON.stringify(bad));
  }
});

test('storageProfile is declarable; record-mode public view with LARGE_PAYLOAD is refused offline', () => {
  for (const storageProfile of ['STANDARD', 'LOW_LATENCY', 'LARGE_PAYLOAD']) {
    assert.equal(parseBlueprint(bp({}, { storageProfile })).schemas[0].storageProfile, storageProfile);
  }
  assert.ok(issues(bp({}, { storageProfile: 'COLD' })).length > 0);
  const view = { mode: 'record', ownedBy: ['userId'] };
  assert.ok(issues(bp({}, { storageProfile: 'LARGE_PAYLOAD', publicView: view })).some((i) => /cannot be combined with storageProfile LARGE_PAYLOAD/.test(i)));
  assert.deepEqual(issues(bp({}, { storageProfile: 'LARGE_PAYLOAD', publicView: { fields: ['title'], ownedBy: ['userId'] } })), [], 'projection mode is fine');
});
