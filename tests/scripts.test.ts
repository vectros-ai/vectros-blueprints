/**
 * The `scripts` blueprint block — the source a blueprint SHIPS, as opposed to the `scriptRef` a
 * trigger merely NAMES.
 *
 * Three things here are not obvious from the schema and are what these tests pin:
 *
 *  - **The caps are UTF-8 BYTES, not characters.** zod's `.max()` counts UTF-16 code units, so a
 *    multi-byte source can sit under a character limit and over the platform's byte limit. The
 *    multi-byte cases below fail against a `.max()` implementation and pass against a
 *    `TextEncoder` one, which is the whole point of measuring them separately.
 *  - **The map KEY is the script name**, and a `z.record` value schema never sees it — so the name
 *    grammar is checked by a lint or not at all.
 *  - **A trigger may not PIN a version of a script this blueprint ships.** Version numbers are the
 *    platform's to assign, and a pin silently keeps running superseded code once `source` is edited.
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
  } as Blueprint;
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

const SOURCE = 'export default function (input) { return { ok: true }; }';
const firingSource = { schemaName: 'intake', event: 'CREATE' as const };

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

test('scripts: is entirely optional — omitting it is fine', () => {
  const bp = parseBlueprint(minimal());
  assert.equal(bp.scripts, undefined);
});

test('scripts: a minimal entry parses and carries its source through verbatim', () => {
  const bp = parseBlueprint(minimal({ scripts: { 'notify-assignee': { source: SOURCE } } }));
  assert.equal(bp.scripts!['notify-assignee'].source, SOURCE);
  assert.equal(bp.scripts!['notify-assignee'].declaredInputContract, undefined);
});

test('scripts: declaredInputContract is optional and passes through', () => {
  const bp = parseBlueprint(
    minimal({ scripts: { notify: { source: SOURCE, declaredInputContract: '{ recordId: string }' } } }),
  );
  assert.equal(bp.scripts!.notify.declaredInputContract, '{ recordId: string }');
});

test('scripts: an entry is .strict() — an unknown key is an authoring error, not a silent no-op', () => {
  // Specifically guards `path:`, the shape a reader may expect and which this format deliberately
  // does NOT have: a shipped script must be reviewable inside the bundle that ships it.
  // zod reports an unrecognized key at the OBJECT's path, not at the offending key's, so assert the
  // message rather than a `scripts.notify.path` that will never be produced.
  const msgs = issueMessages(minimal({ scripts: { notify: { source: SOURCE, path: './notify.js' } } } as never));
  assert.equal(msgs.length, 1);
  assert.match(msgs[0], /Unrecognized key\(s\) in object: 'path'/);
});

test('scripts: a version number is NOT declarable — the platform assigns it', () => {
  const msgs = issueMessages(minimal({ scripts: { notify: { source: SOURCE, version: '1' } } } as never));
  assert.equal(msgs.length, 1);
  assert.match(msgs[0], /Unrecognized key\(s\) in object: 'version'/);
});

// ---------------------------------------------------------------------------
// source
// ---------------------------------------------------------------------------

test('scripts: source is required', () => {
  const paths = issuePaths(minimal({ scripts: { notify: {} } } as never));
  assert.deepEqual(paths, ['scripts.notify.source']);
});

test('scripts: an EMPTY source is rejected, with exactly ONE issue', () => {
  // The count is the assertion. A `.min(1)` in front of the blank refinement would ALSO fire here,
  // reporting the same mistake twice; the schema drops it for that reason.
  const msgs = issueMessages(minimal({ scripts: { notify: { source: '' } } }));
  assert.equal(msgs.length, 1);
  assert.match(msgs[0], /must not be blank/);
});

test('scripts: a WHITESPACE-ONLY source is rejected — the platform requires non-blank', () => {
  // Distinct from the empty case: `.min(1)` passes here, so only the blank refinement catches it.
  const msgs = issueMessages(minimal({ scripts: { notify: { source: '   \n\t  ' } } }));
  assert.equal(msgs.length, 1);
  assert.match(msgs[0], /must not be blank/);
});

test('scripts: a source at exactly the 300,000-byte cap is ACCEPTED', () => {
  const bp = parseBlueprint(minimal({ scripts: { notify: { source: 'a'.repeat(300_000) } } }));
  assert.equal(bp.scripts!.notify.source.length, 300_000);
});

test('scripts: a source one byte OVER the cap is rejected', () => {
  const paths = issuePaths(minimal({ scripts: { notify: { source: 'a'.repeat(300_001) } } }));
  assert.deepEqual(paths, ['scripts.notify.source']);
});

test('scripts: the source cap is measured in UTF-8 BYTES, not characters', () => {
  // 100,001 x '€' is 100,001 UTF-16 code units (well under 300,000, so `.max(300_000)` would let it
  // through) but 300,003 UTF-8 bytes — over the platform's real cap. This test is the reason the
  // schema uses TextEncoder rather than `.max()`; it fails against the naive implementation.
  const euros = '€'.repeat(100_001);
  assert.ok(euros.length < 300_000, 'precondition: under the cap by CHARACTER count');
  assert.equal(new TextEncoder().encode(euros).length, 300_003);
  const msgs = issueMessages(minimal({ scripts: { notify: { source: euros } } }));
  assert.equal(msgs.length, 1);
  assert.match(msgs[0], /UTF-8 bytes, not characters/);
});

// ---------------------------------------------------------------------------
// declaredInputContract
// ---------------------------------------------------------------------------

test('scripts: a declaredInputContract at exactly the 50,000-byte cap is ACCEPTED', () => {
  const bp = parseBlueprint(
    minimal({ scripts: { notify: { source: SOURCE, declaredInputContract: 'b'.repeat(50_000) } } }),
  );
  assert.equal(bp.scripts!.notify.declaredInputContract!.length, 50_000);
});

test('scripts: a declaredInputContract over the cap is rejected', () => {
  const paths = issuePaths(
    minimal({ scripts: { notify: { source: SOURCE, declaredInputContract: 'b'.repeat(50_001) } } }),
  );
  assert.deepEqual(paths, ['scripts.notify.declaredInputContract']);
});

test('scripts: the declaredInputContract cap is measured in UTF-8 BYTES too', () => {
  const euros = '€'.repeat(16_667); // 50,001 UTF-8 bytes, 16,667 code units.
  assert.equal(new TextEncoder().encode(euros).length, 50_001);
  const msgs = issueMessages(minimal({ scripts: { notify: { source: SOURCE, declaredInputContract: euros } } }));
  assert.equal(msgs.length, 1);
  assert.match(msgs[0], /UTF-8 bytes, not characters/);
});

// ---------------------------------------------------------------------------
// The map key IS the script name
// ---------------------------------------------------------------------------

test('scripts: the platform name grammar is enforced on the map KEY', () => {
  for (const bad of ['', 'has space', 'has.dot', 'has/slash', 'a'.repeat(65), 'café']) {
    const paths = issuePaths(minimal({ scripts: { [bad]: { source: SOURCE } } }));
    assert.deepEqual(paths, [`scripts.${bad}`], `expected '${bad}' to be rejected as a script name`);
  }
});

test('scripts: the full legal name alphabet is ACCEPTED', () => {
  for (const ok of ['a', 'A', '9', 'notify-assignee', 'notify_assignee', 'a'.repeat(64), 'Mixed-Case_9']) {
    const bp = parseBlueprint(minimal({ scripts: { [ok]: { source: SOURCE } } }));
    assert.ok(bp.scripts![ok], `expected '${ok}' to be a legal script name`);
  }
});

test('scripts: a bad NAME and a pin on it are reported as TWO independent issues', () => {
  // The pin lint keys on the declared key SET, not on name validity, so both fire. That is
  // deliberate rather than incidental: they are independent authoring errors, and correcting the
  // name does not correct the pin. Suppressing the second as "derived" would hide a fix the author
  // still owes and produce a second failed apply right after the first was fixed.
  const paths = issuePaths(
    minimal({
      scripts: { 'bad name': { source: SOURCE } },
      triggers: {
        notify: {
          firingSource,
          scriptRef: { name: 'bad name', version: '2' },
          fields: [],
          allowedActions: ['records:r'],
        },
      },
    }),
  );
  assert.deepEqual(paths, ['scripts.bad name', 'triggers.notify.scriptRef.version']);
});

// ---------------------------------------------------------------------------
// The scriptRef pin lint
// ---------------------------------------------------------------------------

test("scripts: a trigger on a SHIPPED script must use version 'latest'", () => {
  const paths = issuePaths(
    minimal({
      scripts: { notify: { source: SOURCE } },
      triggers: {
        'on-create': {
          firingSource,
          scriptRef: { name: 'notify', version: '1' },
          fields: [],
          allowedActions: ['records:r'],
        },
      },
    }),
  );
  assert.deepEqual(paths, ['triggers.on-create.scriptRef.version']);
});

test("scripts: 'latest' against a shipped script is the accepted form", () => {
  const bp = parseBlueprint(
    minimal({
      scripts: { notify: { source: SOURCE } },
      triggers: {
        'on-create': {
          firingSource,
          scriptRef: { name: 'notify', version: 'latest' },
          fields: [],
          allowedActions: ['records:r'],
        },
      },
    }),
  );
  assert.equal(bp.triggers!['on-create'].scriptRef.version, 'latest');
});

test('scripts: a PIN against a script this blueprint does NOT ship stays legal', () => {
  // The pre-existing case, and the only form that worked before this block existed — referencing a
  // script someone else pushed. Restricting it would break every blueprint written until now.
  const bp = parseBlueprint(
    minimal({
      scripts: { notify: { source: SOURCE } },
      triggers: {
        'on-create': {
          firingSource,
          scriptRef: { name: 'someone-elses-script', version: '3' },
          fields: [],
          allowedActions: ['records:r'],
        },
      },
    }),
  );
  assert.equal(bp.triggers!['on-create'].scriptRef.version, '3');
});

test('scripts: a pin is still legal when the blueprint declares NO scripts block at all', () => {
  const bp = parseBlueprint(
    minimal({
      triggers: {
        'on-create': {
          firingSource,
          scriptRef: { name: 'notify', version: '3' },
          fields: [],
          allowedActions: ['records:r'],
        },
      },
    }),
  );
  assert.equal(bp.triggers!['on-create'].scriptRef.version, '3');
});

test('scripts: the pin lint reports EVERY offending trigger, not just the first', () => {
  const paths = issuePaths(
    minimal({
      scripts: { notify: { source: SOURCE } },
      triggers: {
        a: { firingSource, scriptRef: { name: 'notify', version: '1' }, fields: [], allowedActions: ['records:r'] },
        b: { firingSource, scriptRef: { name: 'notify', version: '2' }, fields: [], allowedActions: ['records:r'] },
      },
    }),
  );
  assert.deepEqual(paths, ['triggers.a.scriptRef.version', 'triggers.b.scriptRef.version']);
});

// ---------------------------------------------------------------------------
// Phase
// ---------------------------------------------------------------------------

test('scripts: is an IN-CONTEXT block, like the triggers that reference it', () => {
  assert.equal(BLUEPRINT_FIELD_PHASES.scripts, 'in-context');
  assert.equal(BLUEPRINT_FIELD_PHASES.scripts, BLUEPRINT_FIELD_PHASES.triggers);
});
