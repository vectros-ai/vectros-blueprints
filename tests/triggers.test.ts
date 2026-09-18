/**
 * The `triggers` blueprint block: firingSource/scriptRef declaration, the
 * roleIds/inline-clause grant XOR (mirrors accessProfile's), the manifest verb-shape check, and the
 * `${{ input.* }}` placement lint (confined to `triggers[].dataScope`, the same way `${{ self.* }}`
 * is confined to `roles[].dataScope`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseBlueprint,
  BlueprintValidationError,
  BLUEPRINT_FIELD_PHASES,
  type Blueprint,
} from '../src/types.js';

function minimal(overrides: Partial<Blueprint> = {}): Blueprint {
  return {
    name: 'demo',
    version: '1.0.0',
    description: 'demo blueprint',
    contextId: 'mcp',
    // `triggersEnabled` is required for any schema a trigger fires on — records only fire
    // triggers when their schema opts in, so a rule against a schema without it would be
    // created and then never fire. See the dedicated tests at the bottom of this file.
    schemas: [
      {
        typeName: 'intake',
        displayName: 'Intake',
        fields: [],
        capabilities: { triggersEnabled: true },
      },
    ],
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

const firingSource = { schemaName: 'intake', event: 'CREATE' as const };
const scriptRef = { name: 'notify-assignee', version: '3' };

test('triggers: is entirely optional — omitting it is fine', () => {
  const bp = parseBlueprint(minimal());
  assert.equal(bp.triggers, undefined);
});

test('triggers: accepts a minimal roleIds-composed entry, resolving firingSource against a declared schema', () => {
  const bp = parseBlueprint(
    minimal({
      roles: { 'case-worker': [{ allowedActions: ['records:u'] }] },
      triggers: { 'on-intake-create': { firingSource, scriptRef, fields: [], roleIds: ['case-worker'] } },
    }),
  );
  assert.deepEqual(bp.triggers?.['on-intake-create'].firingSource, firingSource);
  assert.deepEqual(bp.triggers?.['on-intake-create'].scriptRef, scriptRef);
  assert.deepEqual(bp.triggers?.['on-intake-create'].roleIds, ['case-worker']);
});

test('triggers: accepts an inline allowedActions + dataScope + capabilities entry', () => {
  const bp = parseBlueprint(
    minimal({
      triggers: {
        'on-intake-update': {
          firingSource: { schemaName: 'intake', event: 'UPDATE' },
          scriptRef,
          fields: [],
          allowedActions: ['records:u'],
          dataScope: { 'scope:org': ['org_a'] },
          capabilities: ['forensic-read'],
        },
      },
    }),
  );
  const entry = bp.triggers?.['on-intake-update'];
  assert.deepEqual(entry?.allowedActions, ['records:u']);
  assert.deepEqual(entry?.dataScope, { 'scope:org': ['org_a'] });
  assert.deepEqual(entry?.capabilities, ['forensic-read']);
});

// ── grant XOR ────────────────────────────────────────────────────────────────

test('triggers: REJECTS both allowedActions and roleIds on the same entry (XOR)', () => {
  const paths = issuePaths(
    minimal({
      roles: { r: [{ allowedActions: ['records:r'] }] },
      triggers: { t: { firingSource, scriptRef, fields: [], allowedActions: ['records:r'], roleIds: ['r'] } },
    }),
  );
  assert.ok(paths.some((p) => p.includes('triggers') && p.includes('roleIds')), JSON.stringify(paths));
});

test('triggers: REJECTS neither allowedActions nor roleIds on an entry (XOR, other direction)', () => {
  const paths = issuePaths(minimal({ triggers: { t: { firingSource, scriptRef, fields: [] } as never } }));
  assert.ok(paths.some((p) => p.includes('triggers') && p.includes('roleIds')), JSON.stringify(paths));
});

test('triggers: REJECTS dataScope alongside roleIds — a role-composed entry has no inline clause of its own', () => {
  const paths = issuePaths(
    minimal({
      roles: { r: [{ allowedActions: ['records:r'] }] },
      triggers: { t: { firingSource, scriptRef, fields: [], roleIds: ['r'], dataScope: { 'scope:org': ['org_a'] } } },
    }),
  );
  assert.ok(paths.some((p) => p.includes('dataScope')), JSON.stringify(paths));
});

test('triggers: REJECTS capabilities alongside roleIds', () => {
  const paths = issuePaths(
    minimal({
      roles: { r: [{ allowedActions: ['records:r'] }] },
      triggers: { t: { firingSource, scriptRef, fields: [], roleIds: ['r'], capabilities: ['forensic-read'] } },
    }),
  );
  assert.ok(paths.some((p) => p.includes('capabilities')), JSON.stringify(paths));
});

// ── reference resolution ────────────────────────────────────────────────────

test('triggers: REJECTS a firingSource.schemaName this blueprint does not declare in schemas', () => {
  const paths = issuePaths(
    minimal({
      roles: { r: [{ allowedActions: ['records:r'] }] },
      triggers: {
        t: { firingSource: { schemaName: 'ghost', event: 'CREATE' }, scriptRef, fields: [], roleIds: ['r'] },
      },
    }),
  );
  assert.ok(
    paths.some((p) => p.includes('firingSource') && p.includes('schemaName')),
    JSON.stringify(paths),
  );
});

test('triggers: REJECTS a roleIds entry this blueprint does not declare in roles', () => {
  const paths = issuePaths(minimal({ triggers: { t: { firingSource, scriptRef, fields: [], roleIds: ['ghost'] } } }));
  assert.ok(paths.some((p) => p.includes('roleIds')), JSON.stringify(paths));
});

test('triggers: REJECTS a duplicate roleIds entry (never silently deduplicated)', () => {
  const paths = issuePaths(
    minimal({
      roles: { r: [{ allowedActions: ['records:r'] }] },
      triggers: { t: { firingSource, scriptRef, fields: [], roleIds: ['r', 'r'] } },
    }),
  );
  assert.ok(paths.some((p) => p.includes('roleIds')), JSON.stringify(paths));
});

// ── scriptRef.version grammar ───────────────────────────────────────────────

test("triggers: ACCEPTS scriptRef.version 'latest' and a positive decimal integer string", () => {
  const bpLatest = parseBlueprint(
    minimal({
      roles: { r: [{ allowedActions: ['records:r'] }] },
      triggers: { t: { firingSource, scriptRef: { name: 's', version: 'latest' }, fields: [], roleIds: ['r'] } },
    }),
  );
  assert.equal(bpLatest.triggers?.t.scriptRef.version, 'latest');

  const bpPinned = parseBlueprint(
    minimal({
      roles: { r: [{ allowedActions: ['records:r'] }] },
      triggers: { t: { firingSource, scriptRef: { name: 's', version: '12' }, fields: [], roleIds: ['r'] } },
    }),
  );
  assert.equal(bpPinned.triggers?.t.scriptRef.version, '12');
});

test("triggers: REJECTS a scriptRef.version that is neither 'latest' nor a positive decimal integer", () => {
  for (const bad of ['v3', '0', '-1', '3.5', '', 'LATEST']) {
    const paths = issuePaths(
      minimal({
        roles: { r: [{ allowedActions: ['records:r'] }] },
        triggers: { t: { firingSource, scriptRef: { name: 's', version: bad }, fields: [], roleIds: ['r'] } },
      }),
    );
    assert.ok(paths.length > 0, `expected '${bad}' to be rejected`);
  }
});

// ── manifest ─────────────────────────────────────────────────────────────────

test("triggers: ACCEPTS a well-formed manifest ('<noun>.<verb>' entries)", () => {
  const bp = parseBlueprint(
    minimal({
      roles: { r: [{ allowedActions: ['records:r'] }] },
      triggers: { t: { firingSource, scriptRef, fields: [], roleIds: ['r'], manifest: ['records.get', 'records.update'] } },
    }),
  );
  assert.deepEqual(bp.triggers?.t.manifest, ['records.get', 'records.update']);
});

test("triggers: REJECTS a manifest entry with no '.' (not '<noun>.<verb>' shaped)", () => {
  const paths = issuePaths(
    minimal({
      roles: { r: [{ allowedActions: ['records:r'] }] },
      triggers: { t: { firingSource, scriptRef, fields: [], roleIds: ['r'], manifest: ['recordsupdate'] } },
    }),
  );
  assert.ok(paths.some((p) => p.includes('manifest')), JSON.stringify(paths));
});

// ── ${{ input.* }} placement (design §6.2) — confined to triggers[].dataScope, same posture
// ${{ self.* }}/${{ member.* }} already have for roles[].dataScope. ───────────────────────────

test('triggers: ACCEPTS ${{ input.scope.org }} inside a trigger entry dataScope', () => {
  const bp = parseBlueprint(
    minimal({
      triggers: {
        t: {
          firingSource,
          scriptRef,
          fields: [],
          allowedActions: ['records:u'],
          dataScope: { 'scope:org': ['${{ input.scope.org }}'] },
        },
      },
    }),
  );
  assert.deepEqual(bp.triggers?.t.dataScope, { 'scope:org': ['${{ input.scope.org }}'] });
});

// A trigger's grant is resolved at fire time against the TRIGGER PRINCIPAL's identity, not the
// author's, and nothing checks the author has authority over that principal. So the identity-derived
// families mean something different here than they do anywhere else they are legal, and the platform
// refuses them. These three cases pin that this lint agrees with the platform: an earlier
// revision ACCEPTED `${{ self.scope.org }}` here, on the
// reasoning that "both value sources are legal there" \u2014 true of the grammar, false of the semantics.
test('triggers: REJECTS ${{ self.scope.org }} inside a trigger entry dataScope (resolves against the trigger principal, not the author)', () => {
  const paths = issuePaths(
    minimal({
      triggers: {
        t: {
          firingSource,
          scriptRef,
          fields: [],
          allowedActions: ['records:u'],
          dataScope: { 'scope:org': ['${{ self.scope.org }}'] },
        },
      },
    }),
  );
  assert.ok(paths.some((p) => p.includes('dataScope')), JSON.stringify(paths));
});

test('triggers: REJECTS ${{ under.self.scope.org }} inside a trigger entry dataScope (same hole, one spelling over)', () => {
  const paths = issuePaths(
    minimal({
      triggers: {
        t: {
          firingSource,
          scriptRef,
          fields: [],
          allowedActions: ['records:u'],
          dataScope: { 'scope:org': ['${{ under.self.scope.org }}'] },
        },
      },
    }),
  );
  assert.ok(paths.some((p) => p.includes('dataScope')), JSON.stringify(paths));
});

// The COMPOSED leg. lintSelfTokenPlacement is subtree-shaped and cannot see this: the offending value
// lives under `roles`, where it is legal. The platform gate is not subtree-shaped and refuses BOTH legs,
// so without these the lint blesses a blueprint that 400s partway through being applied.
test('triggers: REJECTS a roleIds-composed role whose dataScope carries ${{ self.scope.org }}', () => {
  const paths = issuePaths(
    minimal({
      roles: { r: [{ allowedActions: ['records:r'], dataScope: { 'scope:org': ['${{ self.scope.org }}'] } }] },
      triggers: { t: { firingSource, scriptRef, fields: [], roleIds: ['r'] } },
    }),
  );
  assert.ok(paths.some((p) => p.includes('roleIds')), JSON.stringify(paths));
});

test('triggers: REJECTS a roleIds-composed role whose dataScope carries ${{ member.scope.org }}', () => {
  const paths = issuePaths(
    minimal({
      roles: { r: [{ allowedActions: ['records:r'], dataScope: { 'scope:org': ['${{ member.scope.org }}'] } }] },
      triggers: { t: { firingSource, scriptRef, fields: [], roleIds: ['r'] } },
    }),
  );
  assert.ok(paths.some((p) => p.includes('roleIds')), JSON.stringify(paths));
});

// THE CONTROL. Every case above asserts a rejection, and all of them would pass against a lint that
// refused every roleIds-composed trigger outright. A composed role with a literal dataScope is the
// ordinary, correct shape and must still lint clean.
test('triggers: ACCEPTS a roleIds-composed role whose dataScope is literal', () => {
  const bp = parseBlueprint(
    minimal({
      roles: { r: [{ allowedActions: ['records:r'], dataScope: { 'scope:org': ['org_123'] } }] },
      triggers: { t: { firingSource, scriptRef, fields: [], roleIds: ['r'] } },
    }),
  );
  assert.deepEqual(bp.triggers?.t.roleIds, ['r']);
});

// And the role stays legal for its ORDINARY use — the refusal is about being a trigger's grant, not
// about the value. Without this, the fix above could have been implemented by banning self.* in roles.
test('triggers: a role with ${{ self.scope.org }} is still fine when NO trigger composes it', () => {
  const bp = parseBlueprint(
    minimal({
      roles: { r: [{ allowedActions: ['records:r'], dataScope: { 'scope:org': ['${{ self.scope.org }}'] } }] },
    }),
  );
  assert.deepEqual(bp.roles?.r[0].dataScope, { 'scope:org': ['${{ self.scope.org }}'] });
});

test('triggers: REJECTS ${{ member.scope.org }} inside a trigger entry dataScope', () => {
  const paths = issuePaths(
    minimal({
      triggers: {
        t: {
          firingSource,
          scriptRef,
          fields: [],
          allowedActions: ['records:u'],
          dataScope: { 'scope:org': ['${{ member.scope.org }}'] },
        },
      },
    }),
  );
  assert.ok(paths.some((p) => p.includes('dataScope')), JSON.stringify(paths));
});

test('triggers: REJECTS ${{ input.* }} outside triggers[].dataScope (e.g. accessProfile.dataScope)', () => {
  const paths = issuePaths(
    minimal({
      accessProfile: { allowedActions: ['records:r'], dataScope: { 'scope:org': ['${{ input.scope.org }}'] } },
    }),
  );
  assert.ok(
    paths.some((p) => p.includes('accessProfile') && p.includes('dataScope')),
    JSON.stringify(paths),
  );
});

/**
 * Before this was fixed, `${{ input.* }}` was silently ACCEPTED inside
 * `roles[].dataScope` (the "self-family" zone: `self`/`under`/`member` are legal there, and the lint
 * did not distinguish `input` from that group), even though it is inert everywhere except
 * `triggers[].dataScope` — an author would get no error and a role that reads zero rows forever.
 * `accessProfile.dataScope` (the test above) was already caught by the generic "not valid here"
 * branch (zone 'none'); this pins the specific self-family zone that gap named.
 */
test('triggers: REJECTS ${{ input.* }} inside roles[].dataScope — inert there, valid only in triggers[].dataScope', () => {
  const paths = issuePaths(
    minimal({
      roles: {
        r: [{ allowedActions: ['records:r'], dataScope: { 'scope:org': ['${{ input.scope.org }}'] } }],
      },
    }),
  );
  assert.ok(
    paths.some((p) => p.includes('roles')),
    JSON.stringify(paths),
  );
});

test('triggers: REJECTS ${{ input.* }} inside roleAssumable[] — same self-family confinement', () => {
  const paths = issuePaths(
    minimal({
      roles: { r: [{ allowedActions: ['records:r'] }] },
      roleAssumable: { r: { 'scope:org': ['${{ input.scope.org }}'] } },
    }),
  );
  assert.ok(
    paths.some((p) => p.includes('roleAssumable')),
    JSON.stringify(paths),
  );
});

test('triggers: ACCEPTS ${{ self.scope.org }} inside roles[].dataScope unaffected by the input-scoping fix', () => {
  const bp = parseBlueprint(
    minimal({
      roles: {
        r: [{ allowedActions: ['records:r'], dataScope: { 'scope:org': ['${{ self.scope.org }}'] } }],
      },
    }),
  );
  assert.deepEqual(bp.roles?.r[0].dataScope, { 'scope:org': ['${{ self.scope.org }}'] });
});

// ── phase + structural ──────────────────────────────────────────────────────

test('BLUEPRINT_FIELD_PHASES: triggers is in-context, same phase as roles/accessProfile', () => {
  assert.equal(BLUEPRINT_FIELD_PHASES.triggers, 'in-context');
});

test('triggers: REJECTS an unknown key on an entry (.strict())', () => {
  const paths = issuePaths(
    minimal({
      roles: { r: [{ allowedActions: ['records:r'] }] },
      triggers: { t: { firingSource, scriptRef, fields: [], roleIds: ['r'], bogus: true } as never },
    }),
  );
  assert.ok(paths.length > 0, JSON.stringify(paths));
});

// ── triggersEnabled: the schema must opt in to firing triggers ──────────────
// Records only fire triggers when their schema declares
// `capabilities.triggersEnabled`, because that flag is what the dispatcher gates
// on. Without this lint a blueprint could declare a rule that is created, holds a
// service principal and a grant, and silently never fires — a state that reads as
// working. The platform refuses the same shape on apply; this catches it at plan
// time. Every other test in this file is the control: they all pass with the
// capability set, and would fail if this lint fired on an opted-in schema.

test('triggers: REJECTS a trigger against a schema that does not enable triggers', () => {
  const paths = issuePaths(
    minimal({
      schemas: [{ typeName: 'intake', displayName: 'Intake', fields: [] }],
      roles: { r: [{ allowedActions: ['records:r'] }] },
      triggers: { t: { firingSource, scriptRef, fields: [], roleIds: ['r'] } },
    }),
  );
  assert.deepEqual(paths, ['triggers.t.firingSource.schemaName'], JSON.stringify(paths));
});

test('triggers: REJECTS an explicit triggersEnabled: false, same as omitting it', () => {
  const paths = issuePaths(
    minimal({
      schemas: [
        { typeName: 'intake', displayName: 'Intake', fields: [], capabilities: { triggersEnabled: false } },
      ],
      roles: { r: [{ allowedActions: ['records:r'] }] },
      triggers: { t: { firingSource, scriptRef, fields: [], roleIds: ['r'] } },
    }),
  );
  assert.deepEqual(paths, ['triggers.t.firingSource.schemaName'], JSON.stringify(paths));
});

test('triggers: the error names the capability the author has to set', () => {
  try {
    parseBlueprint(
      minimal({
        schemas: [{ typeName: 'intake', displayName: 'Intake', fields: [] }],
        roles: { r: [{ allowedActions: ['records:r'] }] },
        triggers: { t: { firingSource, scriptRef, fields: [], roleIds: ['r'] } },
      }),
    );
    assert.fail('expected the blueprint to be rejected');
  } catch (err) {
    assert.ok(err instanceof BlueprintValidationError);
    assert.match(err.issues[0].message, /capabilities\.triggersEnabled: true/);
  }
});

test('triggers: an UNKNOWN schemaName reports only the unknown-schema issue, not both', () => {
  const paths = issuePaths(
    minimal({
      roles: { r: [{ allowedActions: ['records:r'] }] },
      triggers: {
        t: { firingSource: { schemaName: 'nope', event: 'CREATE' }, scriptRef, fields: [], roleIds: ['r'] },
      },
    }),
  );
  assert.deepEqual(paths, ['triggers.t.firingSource.schemaName'], JSON.stringify(paths));
});

test('triggers: auditHistory and triggersEnabled are independent — audit off still fires', () => {
  const bp = parseBlueprint(
    minimal({
      schemas: [
        {
          typeName: 'intake',
          displayName: 'Intake',
          fields: [],
          capabilities: { auditHistory: false, triggersEnabled: true },
        },
      ],
      roles: { r: [{ allowedActions: ['records:r'] }] },
      triggers: { t: { firingSource, scriptRef, fields: [], roleIds: ['r'] } },
    }),
  );
  assert.equal(bp.schemas?.[0].capabilities?.triggersEnabled, true);
  assert.equal(bp.schemas?.[0].capabilities?.auditHistory, false);
});

// ── `fields` and `inline` (the trigger input contract) ───────────────────

test('fields: is REQUIRED on a trigger entry — omitting it is an authoring error', () => {
  // Required rather than defaulted on purpose: projecting nothing is something an author STATES
  // (`fields: []`), not something they get by forgetting the key. The schema is .strict(), so this
  // is a loud error rather than a silent drop that 400s partway through an apply.
  assert.deepEqual(
    issuePaths(minimal({ triggers: { t: { firingSource, scriptRef, roleIds: ['r'] } },
      roles: { r: [{ allowedActions: ['records:r'] }] } })),
    ['triggers.t.fields'],
  );
});

test('fields: an EMPTY list is valid — it is the "project nothing" declaration', () => {
  const bp = parseBlueprint(
    minimal({ roles: { r: [{ allowedActions: ['records:r'] }] },
      triggers: { t: { firingSource, scriptRef, fields: [], roleIds: ['r'] } } }),
  );
  assert.deepEqual(bp.triggers?.t.fields, []);
});

test('fields: REJECTS a field the firing schema does not declare', () => {
  assert.deepEqual(
    issuePaths(minimal({
      roles: { r: [{ allowedActions: ['records:r'] }] },
      triggers: { t: { firingSource, scriptRef, fields: ['ghost'], roleIds: ['r'] } },
    })),
    ['triggers.t.fields[0]'],
  );
});

test('fields: REJECTS a field the schema does not keep INLINE', () => {
  // The platform projects only inline/filterable/lookup fields. A plain field 400s at apply, after
  // the apply has already created a service principal and a profile — so it is caught here.
  const paths = issuePaths(minimal({
    schemas: [{ typeName: 'intake', displayName: 'Intake',
      fields: [{ fieldId: 'note', fieldType: 'string' }],
      capabilities: { triggersEnabled: true } }],
    roles: { r: [{ allowedActions: ['records:r'] }] },
    triggers: { t: { firingSource, scriptRef, fields: ['note'], roleIds: ['r'] } },
  }));
  assert.deepEqual(paths, ['triggers.t.fields[0]']);
});

test('fields: ACCEPTS an inline, a filterable, and a lookup field — all three are projectable', () => {
  const bp = parseBlueprint(minimal({
    schemas: [{ typeName: 'intake', displayName: 'Intake',
      fields: [
        { fieldId: 'a', fieldType: 'string', inline: true },
        { fieldId: 'b', fieldType: 'string', filterable: true },
        { fieldId: 'c', fieldType: 'string' },
      ],
      lookupFields: ['c'],
      capabilities: { triggersEnabled: true } }],
    roles: { r: [{ allowedActions: ['records:r'] }] },
    triggers: { t: { firingSource, scriptRef, fields: ['a', 'b', 'c'], roleIds: ['r'] } },
  }));
  assert.deepEqual(bp.triggers?.t.fields, ['a', 'b', 'c']);
});

test('fields: REJECTS a SENSITIVE field even when it is otherwise projectable', () => {
  // A sensitive field is blind-indexed and masked; it can never reach a script. Asserted on a field
  // that is ALSO filterable, so the sensitive check cannot be passing by accident.
  const paths = issuePaths(minimal({
    schemas: [{ typeName: 'intake', displayName: 'Intake',
      fields: [{ fieldId: 'ssn', fieldType: 'string', filterable: true, sensitive: true }],
      capabilities: { triggersEnabled: true } }],
    roles: { r: [{ allowedActions: ['records:r'] }] },
    triggers: { t: { firingSource, scriptRef, fields: ['ssn'], roleIds: ['r'] } },
  }));
  assert.ok(paths.includes('triggers.t.fields[0]'));
});

test('inline: cannot be combined with sensitive', () => {
  // The platform refuses the pair — a readable row copy would defeat the masking.
  assert.deepEqual(
    issuePaths(minimal({
      schemas: [{ typeName: 'intake', displayName: 'Intake',
        fields: [{ fieldId: 'ssn', fieldType: 'string', inline: true, sensitive: true }],
        capabilities: { triggersEnabled: true } }],
    })),
    ['schemas[0].fields[0].inline'],
  );
});

test('fields: an unknown schemaName reports only the unknown-schema issue, not a derived one', () => {
  // Piling a "field not projectable" complaint on top of "that schema does not exist" obscures the
  // real error. lintTriggerFields stays silent when the schema is unresolvable.
  const paths = issuePaths(minimal({
    roles: { r: [{ allowedActions: ['records:r'] }] },
    triggers: { t: { firingSource: { schemaName: 'nope', event: 'CREATE' }, scriptRef,
      fields: ['whatever'], roleIds: ['r'] } },
  }));
  assert.equal(paths.filter((p) => p.startsWith('triggers.t.fields')).length, 0);
});

test('fields: ACCEPTS a lookup-only field the schema never declares in fields[]', () => {
  // `schemas[].fields` is optional and a lookup leg need not have a FieldDef — the platform adds
  // every leg to the projectable set unconditionally. A not-declared check running BEFORE the
  // lookup check rejected this legal shape.
  const bp = parseBlueprint(minimal({
    schemas: [{ typeName: 'intake', displayName: 'Intake', lookupFields: ['email'],
      capabilities: { triggersEnabled: true } }],
    roles: { r: [{ allowedActions: ['records:r:intake'] }] },
    triggers: { t: { firingSource, scriptRef, fields: ['email'], roleIds: ['r'] } },
  }));
  assert.deepEqual(bp.triggers?.t.fields, ['email']);
});

test("fields: ACCEPTS a lookup's sortBy TARGET — the fourth projectable path", () => {
  // getInlineProjectionFieldNames() adds the sortBy target unless it is createdAt/lastUpdated, and
  // that target need not be inline, filterable, or a leg. Reading the field-level flags alone
  // misses it, which is how the rule got stated too narrowly in five places.
  const bp = parseBlueprint(minimal({
    schemas: [{ typeName: 'intake', displayName: 'Intake',
      fields: [
        { fieldId: 'email', fieldType: 'string' },
        { fieldId: 'priority', fieldType: 'string' },
      ],
      lookupFields: [{ fieldName: 'email', sortBy: 'priority' }],
      capabilities: { triggersEnabled: true } }],
    roles: { r: [{ allowedActions: ['records:r:intake'] }] },
    triggers: { t: { firingSource, scriptRef, fields: ['priority'], roleIds: ['r'] } },
  }));
  assert.deepEqual(bp.triggers?.t.fields, ['priority']);
});

test('fields: a BUILT-IN sortBy does not make an arbitrary field projectable', () => {
  // createdAt/lastUpdated are excluded platform-side, so they must not widen the set here either —
  // otherwise the fix for the previous case would admit anything.
  const paths = issuePaths(minimal({
    schemas: [{ typeName: 'intake', displayName: 'Intake',
      fields: [{ fieldId: 'email', fieldType: 'string' }, { fieldId: 'plain', fieldType: 'string' }],
      lookupFields: [{ fieldName: 'email', sortBy: 'createdAt' }],
      capabilities: { triggersEnabled: true } }],
    roles: { r: [{ allowedActions: ['records:r:intake'] }] },
    triggers: { t: { firingSource, scriptRef, fields: ['plain'], roleIds: ['r'] } },
  }));
  assert.deepEqual(paths, ['triggers.t.fields[0]']);
});

test('fields: REJECTS a duplicate entry, as the platform does', () => {
  // The platform rejects "declared more than once"; every sibling list here (roleIds, manifest)
  // already checks it, so omitting it left the exact lints-clean-then-400s case open.
  const paths = issuePaths(minimal({
    schemas: [{ typeName: 'intake', displayName: 'Intake',
      fields: [{ fieldId: 'status', fieldType: 'string', inline: true }],
      capabilities: { triggersEnabled: true } }],
    roles: { r: [{ allowedActions: ['records:r:intake'] }] },
    triggers: { t: { firingSource, scriptRef, fields: ['status', 'status'], roleIds: ['r'] } },
  }));
  assert.deepEqual(paths, ['triggers.t.fields[1]']);
});

test('fields: REJECTS a SENSITIVE field that is also a LOOKUP leg', () => {
  // The gap the lookup shortcut opened: the platform subtracts sensitive from the WHOLE projectable
  // set, lookups included, and a sensitive lookup field is a supported blind-indexed shape — so
  // this is reachable, and returning early on the lookup would 400 at createTrigger AFTER the
  // service principal and placeholder profile exist.
  const paths = issuePaths(minimal({
    schemas: [{ typeName: 'intake', displayName: 'Intake',
      fields: [{ fieldId: 'ssn', fieldType: 'string', sensitive: true }],
      lookupFields: ['ssn'],
      capabilities: { triggersEnabled: true } }],
    roles: { r: [{ allowedActions: ['records:r:intake'] }] },
    triggers: { t: { firingSource, scriptRef, fields: ['ssn'], roleIds: ['r'] } },
  }));
  assert.deepEqual(paths, ['triggers.t.fields[0]']);
});

test('fields: REJECTS a SENSITIVE sortBy target too — every projectable path is subtracted', () => {
  const paths = issuePaths(minimal({
    schemas: [{ typeName: 'intake', displayName: 'Intake',
      fields: [
        { fieldId: 'email', fieldType: 'string' },
        { fieldId: 'secret', fieldType: 'string', sensitive: true },
      ],
      lookupFields: [{ fieldName: 'email', sortBy: 'secret' }],
      capabilities: { triggersEnabled: true } }],
    roles: { r: [{ allowedActions: ['records:r:intake'] }] },
    triggers: { t: { firingSource, scriptRef, fields: ['secret'], roleIds: ['r'] } },
  }));
  assert.deepEqual(paths, ['triggers.t.fields[0]']);
});
