/**
 * Top-level `namespaces` — namespace registrations, applied in the CLI
 * loader's bootstrap-token phase (same phase as `issuers`), before schemas/
 * seed. Structural (zod) validation only; see issuers.test.ts for the
 * sibling bootstrap-phase block this mirrors in test shape.
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

const VALID_NAMESPACE = { namespace: 'team', specificityRank: 500 };
/** membershipRecordType must name a schema the blueprint declares — the fixture for that. */
const WITH_TEAM_GRANT_SCHEMA = [{ typeName: 'team_grant', displayName: 'Team Grant', fields: [] }];

test('accepts a minimal, valid namespace entry', () => {
  const b = parseBlueprint(minimal({ namespaces: [VALID_NAMESPACE] }));
  assert.deepEqual(b.namespaces, [VALID_NAMESPACE]);
});

test('accepts entityBacked', () => {
  const b = parseBlueprint(minimal({ namespaces: [{ ...VALID_NAMESPACE, entityBacked: true }] }));
  assert.equal(b.namespaces?.[0].entityBacked, true);
});

test('accepts full membership declaration (record type + target field + level field + levels)', () => {
  const b = parseBlueprint(
    minimal({
      schemas: WITH_TEAM_GRANT_SCHEMA,
      namespaces: [
        {
          ...VALID_NAMESPACE,
          membershipRecordType: 'team_grant',
          membershipTargetField: 'userId',
          membershipLevelField: 'level',
          membershipLevels: ['admin', 'viewer'],
        },
      ],
    }),
  );
  assert.equal(b.namespaces?.[0].membershipRecordType, 'team_grant');
  assert.deepEqual(b.namespaces?.[0].membershipLevels, ['admin', 'viewer']);
});

test('accepts plain in-or-out membership (record type + target field, no level)', () => {
  const b = parseBlueprint(
    minimal({
      schemas: WITH_TEAM_GRANT_SCHEMA,
      namespaces: [{ ...VALID_NAMESPACE, membershipRecordType: 'team_grant', membershipTargetField: 'userId' }],
    }),
  );
  assert.equal(b.namespaces?.[0].membershipLevelField, undefined);
});

test('REJECTS membershipRecordType naming a type NOT declared in this blueprint\'s schemas[]', () => {
  const paths = issuePaths(
    minimal({
      // schemas: [] (default) — 'team_grant' is not declared anywhere.
      namespaces: [{ ...VALID_NAMESPACE, membershipRecordType: 'team_grant', membershipTargetField: 'userId' }],
    }),
  );
  assert.ok(paths.includes('namespaces[0].membershipRecordType'), paths.join(', '));
});

test('REJECTS an invalid namespace shape (grammar)', () => {
  const paths = issuePaths(minimal({ namespaces: [{ namespace: 'Team', specificityRank: 500 }] }));
  assert.ok(paths.includes('namespaces[0].namespace'), paths.join(', '));
});

test('REJECTS a forbidden namespace name (shares the scope-namespace forbidden set)', () => {
  const paths = issuePaths(minimal({ namespaces: [{ namespace: 'user', specificityRank: 500 }] }));
  assert.ok(paths.includes('namespaces[0].namespace'), paths.join(', '));
});

test("accepts 'org' or 'client' — registered the same as any other name, always context-owned", () => {
  for (const name of ['org', 'client']) {
    const b = parseBlueprint(minimal({ namespaces: [{ namespace: name, specificityRank: 500 }] }));
    assert.deepEqual(b.namespaces, [{ namespace: name, specificityRank: 500 }]);
  }
});

test('REJECTS a duplicate namespace name within one blueprint', () => {
  const paths = issuePaths(
    minimal({
      namespaces: [
        { namespace: 'team', specificityRank: 500 },
        { namespace: 'team', specificityRank: 600 },
      ],
    }),
  );
  assert.ok(paths.includes('namespaces[1].namespace'), paths.join(', '));
});

test('REJECTS a duplicate specificityRank within one blueprint', () => {
  const paths = issuePaths(
    minimal({
      namespaces: [
        { namespace: 'team', specificityRank: 500 },
        { namespace: 'project', specificityRank: 500 },
      ],
    }),
  );
  assert.ok(paths.includes('namespaces[1].specificityRank'), paths.join(', '));
});

test('REJECTS specificityRank out of the platform-documented 0..1_000_000 range', () => {
  assert.ok(issuePaths(minimal({ namespaces: [{ namespace: 'team', specificityRank: -1 }] })).length > 0);
  assert.ok(issuePaths(minimal({ namespaces: [{ namespace: 'team', specificityRank: 1_000_001 }] })).length > 0);
});

test('REJECTS membershipRecordType without membershipTargetField, and vice versa', () => {
  const p1 = issuePaths(minimal({ namespaces: [{ ...VALID_NAMESPACE, membershipRecordType: 'team_grant' }] }));
  assert.ok(p1.includes('namespaces[0].membershipRecordType'), p1.join(', '));
  const p2 = issuePaths(minimal({ namespaces: [{ ...VALID_NAMESPACE, membershipTargetField: 'userId' }] }));
  assert.ok(p2.includes('namespaces[0].membershipRecordType'), p2.join(', '));
});

test("REJECTS contextOwned and membershipContextId — every blueprint namespace is unconditionally context-owned, no such fields exist", () => {
  // A blueprint applies under the CLI's bootstrap credential, and the
  // platform confines namespace registration to the caller's own context
  // unconditionally — even for a tenant-wide contextId:null request — so a
  // tenant-wide registration is reachable only with a root API key, outside
  // any blueprint. Both fields are `.strict()`-rejected as unknown rather
  // than silently accepted and failing later at apply.
  assert.throws(
    () => parseBlueprint(minimal({ namespaces: [{ ...VALID_NAMESPACE, contextOwned: true }] } as unknown as Partial<Blueprint>)),
    BlueprintValidationError,
  );
  assert.throws(
    () =>
      parseBlueprint(
        minimal({
          namespaces: [
            {
              ...VALID_NAMESPACE,
              membershipRecordType: 't',
              membershipTargetField: 'u',
              membershipContextId: 'mcp',
            },
          ],
        } as unknown as Partial<Blueprint>),
      ),
    BlueprintValidationError,
  );
});

test('REJECTS membershipLevelField without membershipLevels, and vice versa', () => {
  const p1 = issuePaths(
    minimal({
      namespaces: [
        { ...VALID_NAMESPACE, membershipRecordType: 't', membershipTargetField: 'u', membershipLevelField: 'level' },
      ],
    }),
  );
  assert.ok(p1.includes('namespaces[0].membershipLevelField'), p1.join(', '));
  const p2 = issuePaths(
    minimal({
      namespaces: [
        { ...VALID_NAMESPACE, membershipRecordType: 't', membershipTargetField: 'u', membershipLevels: ['admin'] },
      ],
    }),
  );
  assert.ok(p2.includes('namespaces[0].membershipLevelField'), p2.join(', '));
});

test('REJECTS membershipLevelField with an EMPTY membershipLevels array — matches the platform: empty means "not declared", not "declared, zero labels"', () => {
  // The platform's own definition of "has levels" is `levels != null &&
  // !levels.isEmpty()`. A naive `!== undefined` check would let this
  // structurally-empty declaration lint clean and then 400 at apply.
  const paths = issuePaths(
    minimal({
      namespaces: [
        { ...VALID_NAMESPACE, membershipRecordType: 't', membershipTargetField: 'u', membershipLevelField: 'level', membershipLevels: [] },
      ],
    }),
  );
  assert.ok(paths.includes('namespaces[0].membershipLevelField'), paths.join(', '));
});

test('REJECTS a duplicate level label in membershipLevels', () => {
  const paths = issuePaths(
    minimal({
      namespaces: [
        {
          ...VALID_NAMESPACE,
          membershipRecordType: 't',
          membershipTargetField: 'u',
          membershipLevelField: 'level',
          membershipLevels: ['admin', 'viewer', 'admin'],
        },
      ],
    }),
  );
  assert.ok(paths.includes('namespaces[0].membershipLevels'), paths.join(', '));
});

test('REJECTS an invalid membershipRecordType/membershipTargetField/membershipLevelField — must be a valid field identifier', () => {
  for (const field of ['membershipRecordType', 'membershipTargetField', 'membershipLevelField'] as const) {
    const paths = issuePaths(
      minimal({
        namespaces: [
          {
            ...VALID_NAMESPACE,
            membershipRecordType: 't',
            membershipTargetField: 'u',
            [field]: 'not a valid identifier!',
          },
        ],
      }),
    );
    assert.ok(paths.includes(`namespaces[0].${field}`), `${field}: ${paths.join(', ')}`);
  }
});

test('ACCEPTS membershipRecordType/membershipTargetField/membershipLevelField using the full identifier grammar (letters, digits, underscore, hyphen)', () => {
  const b = parseBlueprint(
    minimal({
      schemas: [{ typeName: 'team_grant-v2', displayName: 'Team Grant v2', fields: [] }],
      namespaces: [
        {
          ...VALID_NAMESPACE,
          membershipRecordType: 'team_grant-v2',
          membershipTargetField: 'targetUserId',
          membershipLevelField: 'grant-level_2',
          membershipLevels: ['admin', 'viewer'],
        },
      ],
    }),
  );
  assert.equal(b.namespaces?.[0].membershipRecordType, 'team_grant-v2');
});

test('REJECTS membershipLevelField/membershipLevels without the base membershipRecordType/membershipTargetField', () => {
  const paths = issuePaths(
    minimal({
      namespaces: [{ ...VALID_NAMESPACE, membershipLevelField: 'level', membershipLevels: ['admin', 'viewer'] }],
    }),
  );
  assert.ok(paths.includes('namespaces[0].membershipLevelField'), paths.join(', '));
});

test('REJECTS an invalid level label in membershipLevels (same grammar as namespace names)', () => {
  const paths = issuePaths(
    minimal({
      namespaces: [
        {
          ...VALID_NAMESPACE,
          membershipRecordType: 't',
          membershipTargetField: 'u',
          membershipLevelField: 'level',
          membershipLevels: ['Admin'],
        },
      ],
    }),
  );
  assert.ok(paths.includes('namespaces[0].membershipLevels'), paths.join(', '));
});

test('namespaces is entirely optional — omitting it is fine', () => {
  const b = parseBlueprint(minimal());
  assert.equal(b.namespaces, undefined);
});

test('BLUEPRINT_FIELD_PHASES: namespaces is bootstrap-phase, same as issuers', async () => {
  const { BLUEPRINT_FIELD_PHASES } = await import('../src/types.js');
  assert.equal(BLUEPRINT_FIELD_PHASES.namespaces, 'bootstrap');
});
