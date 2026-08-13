/**
 * BLUEPRINT_FIELD_PHASES — the self-documenting phase metadata for the
 * bootstrap/in-context phase split. A consistency guard, not a
 * loader-behavior test (that's `@vectros-ai/cli`'s drift-guard in
 * tests/plan.test.ts): every key here must name a real top-level
 * `BlueprintSchema` field, so the map can never claim a phase for a field
 * that doesn't (or no longer) exists.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BlueprintSchema, BLUEPRINT_FIELD_PHASES, type LoaderPhase } from '../src/types.js';

const VALID_PHASES: ReadonlySet<LoaderPhase> = new Set(['bootstrap', 'in-context']);

// BlueprintSchema is `z.object({...}).strict().superRefine(...)` — the
// superRefine wraps it in a ZodEffects, which has no `.shape` of its own; the
// object shape lives on the wrapped inner schema (`_def.schema`).
function topLevelFieldNames(): Set<string> {
  const inner = (BlueprintSchema as unknown as { _def: { schema: { shape: Record<string, unknown> } } })._def
    .schema.shape;
  return new Set(Object.keys(inner));
}

test('every BLUEPRINT_FIELD_PHASES key names a real top-level BlueprintSchema field', () => {
  const declaredFields = topLevelFieldNames();
  for (const field of Object.keys(BLUEPRINT_FIELD_PHASES)) {
    assert.ok(declaredFields.has(field), `BLUEPRINT_FIELD_PHASES names '${field}', which is not a BlueprintSchema field`);
  }
});

test('every phase value is one of the two loader phases', () => {
  for (const [field, phase] of Object.entries(BLUEPRINT_FIELD_PHASES)) {
    assert.ok(VALID_PHASES.has(phase), `'${field}' declares an unrecognized phase '${phase}'`);
  }
});

test('the map is frozen (Object.freeze) — cannot be mutated at runtime', () => {
  assert.throws(() => {
    (BLUEPRINT_FIELD_PHASES as Record<string, LoaderPhase>).schemas = 'bootstrap';
  });
});

test('issuers and servicePrincipal are bootstrap-phase; schemas/accessProfile/roles/seed are in-context', () => {
  assert.equal(BLUEPRINT_FIELD_PHASES.issuers, 'bootstrap');
  assert.equal(BLUEPRINT_FIELD_PHASES.servicePrincipal, 'bootstrap');
  assert.equal(BLUEPRINT_FIELD_PHASES.schemas, 'in-context');
  assert.equal(BLUEPRINT_FIELD_PHASES.accessProfile, 'in-context');
  assert.equal(BLUEPRINT_FIELD_PHASES.roles, 'in-context');
  assert.equal(BLUEPRINT_FIELD_PHASES.seed, 'in-context');
});

test('identities is deliberately absent (resolved by an earlier, non-loader pass — not either loader phase)', () => {
  assert.equal('identities' in BLUEPRINT_FIELD_PHASES, false);
});
