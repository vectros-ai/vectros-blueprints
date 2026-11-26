/**
 * A schema's `writePolicy` (a write fence): what the blueprint refuses offline, before anything is sent. The platform re-checks
 * every rule and is the authority; who may widen a fence is decided there too.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBlueprint, BlueprintValidationError } from '../src/types.js';

const SEAL = 'a'.repeat(64);

function blueprint(schema: Record<string, unknown>, extra: Record<string, unknown> = {}): unknown {
  return {
    name: 'demo',
    version: '1.0.0',
    description: 'demo blueprint',
    contextId: 'mcp',
    formatVersion: 1,
    accessProfile: { allowedActions: ['records:r'] },
    servicePrincipal: { externalId: 'demo-sp', displayName: 'Demo SP' },
    schemas: [{ typeName: 'shift', displayName: 'Shift', fields: [{ fieldId: 'spotsLeft', fieldType: 'number', inline: true }], ...schema }],
    scripts: { 'signup-shift': { source: '({ ok: true });' }, 'cascade-runner': { source: '({ ok: 2 });' } },
    ...extra,
  };
}

function issues(bp: unknown): string {
  try {
    parseBlueprint(bp);
    return '';
  } catch (e) {
    if (e instanceof BlueprintValidationError) return e.message;
    throw e;
  }
}

test('a fence admitting a shipped script, or any script by its seal, parses', () => {
  assert.equal(issues(blueprint({ writePolicy: { update: { via: [{ script: 'signup-shift' }, { script: 'external', sha256: SEAL }] } } })), '');
  assert.equal(issues(blueprint({ writePolicy: { delete: { via: [] } } })), '', 'fenced shut');
  assert.equal(issues(blueprint({ writePolicy: null })), '', 'null lifts');
});

test('a script the blueprint does not ship needs its seal', () => {
  assert.match(issues(blueprint({ writePolicy: { update: { via: [{ script: 'external' }] } } })), /does not ship/);
});

test('base only, record surface only', () => {
  assert.match(issues(blueprint({ basedOn: 'sch_1', writePolicy: { update: { via: [] } } })), /base schema only/);
  assert.match(issues(blueprint({ allowedSurfaces: ['record', 'document'], writePolicy: { update: { via: [] } } })), /exactly \['record'\]/);
});

test('a trigger admission names the blueprint triggers that run that script, and only with the trigger path', () => {
  const triggers = {
    triggers: {
      'cascade-runner': {
        firingSource: { schemaName: 'shift', event: 'UPDATE' }, scriptRef: { name: 'cascade-runner', version: 'latest' },
        fields: ['spotsLeft'], allowedActions: ['records:u:shift'],
      },
    },
  };
  const ok = blueprint({ capabilities: { triggersEnabled: true }, writePolicy: { update: { via: [{ script: 'cascade-runner', paths: ['trigger'], triggers: ['cascade-runner'] }] } } }, triggers);
  assert.equal(issues(ok), '');
  assert.match(issues(blueprint({ writePolicy: { update: { via: [{ script: 'cascade-runner', paths: ['trigger'] }] } } })), /'triggers' is required/);
  assert.match(issues(blueprint({ writePolicy: { update: { via: [{ script: 'cascade-runner', triggers: ['x'] }] } } })), /'triggers' is required with, and only with/);
  assert.match(issues(blueprint({ capabilities: { triggersEnabled: true }, writePolicy: { update: { via: [{ script: 'cascade-runner', paths: ['trigger'], triggers: ['missing'] }] } } }, triggers)),
    /does not declare/);
  assert.match(issues(blueprint({ capabilities: { triggersEnabled: true }, writePolicy: { update: { via: [{ script: 'signup-shift', paths: ['trigger'], triggers: ['cascade-runner'] }] } } }, triggers)),
    /runs 'cascade-runner'/);
});

test('unknown keys, a malformed seal and an unknown path are refused', () => {
  assert.match(issues(blueprint({ writePolicy: { updates: { via: [] } } })), /updates|Unrecognized/i);
  assert.match(issues(blueprint({ writePolicy: { update: { via: [{ script: 'x', sha256: 'ABC' }] } } })), /64-character/);
  assert.match(issues(blueprint({ writePolicy: { update: { via: [{ script: 'signup-shift', paths: ['webhook'] }] } } })), /paths|Invalid enum/i);
});

test('seeding a type whose create is fenced is refused (the seed would be refused part-way through the apply)', () => {
  const bp = blueprint({ writePolicy: { create: { via: [{ script: 'signup-shift' }] } } }, {
    seed: [{ surface: 'record', typeName: 'shift', externalId: 'seed-shift-1', fields: { spotsLeft: 1 } }],
  });
  assert.match(issues(bp), /fences create/);
  // an update-only fence leaves seeding alone
  assert.equal(issues(blueprint({ writePolicy: { update: { via: [{ script: 'signup-shift' }] } } }, {
    seed: [{ surface: 'record', typeName: 'shift', externalId: 'seed-shift-1', fields: { spotsLeft: 1 } }],
  })), '');
});

test("agentIds may not name 'inline' (an inline run carries caller-chosen tools)", () => {
  assert.match(issues(blueprint({ writePolicy: { update: { via: [{ script: 'external', sha256: SEAL, paths: ['tool'], agentIds: ['inline'] }] } } })),
    /inline/);
});
