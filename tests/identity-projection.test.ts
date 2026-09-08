/**
 * Top-level `identityProjectionClaims` (0.43.0) — declares which of the golden IdP-asserted claim
 * names captured by this tenant's issuers (`issuers[].capturedClaims`) are projected, read-only,
 * onto access profiles in this context.
 *
 * Structural (zod) validation only. Its BOUNDS are deliberately the same as `capturedClaims`' —
 * both name OIDC claims and both are transcribed from the platform's own
 * MAX_CAPTURED_CLAIMS / MAX_CAPTURED_CLAIM_NAME_LENGTH — so the two blocks are asserted to agree
 * rather than each being spot-checked against a number written down twice.
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

test('identityProjectionClaims: omitting it is valid — leaves the context declaration unchanged', () => {
  const bp = parseBlueprint(minimal());
  assert.equal(bp.identityProjectionClaims, undefined);
});

test('identityProjectionClaims: accepts a list of claim names and preserves order', () => {
  const bp = parseBlueprint(minimal({ identityProjectionClaims: ['name', 'phone'] }));
  assert.deepEqual(bp.identityProjectionClaims, ['name', 'phone']);
});

test('identityProjectionClaims: an explicit empty list is accepted — it DISABLES future projection', () => {
  // Distinct in meaning from omitting the field, which leaves the stored declaration alone. Both
  // parse; only the empty list is an instruction.
  const bp = parseBlueprint(minimal({ identityProjectionClaims: [] }));
  assert.deepEqual(bp.identityProjectionClaims, []);
});

test('identityProjectionClaims: REJECTS a blank entry', () => {
  assert.deepEqual(issuePaths(minimal({ identityProjectionClaims: ['name', ''] })), [
    'identityProjectionClaims[1]',
  ]);
});

test('identityProjectionClaims: REJECTS a name above 64 characters, and accepts one at exactly 64', () => {
  assert.deepEqual(issuePaths(minimal({ identityProjectionClaims: ['a'.repeat(65)] })), [
    'identityProjectionClaims[0]',
  ]);
  assert.deepEqual(issuePaths(minimal({ identityProjectionClaims: ['a'.repeat(64)] })), []);
});

test('identityProjectionClaims: REJECTS more than 20 entries, and accepts exactly 20', () => {
  const names = (n: number) => Array.from({ length: n }, (_, i) => `claim_${i}`);
  assert.deepEqual(issuePaths(minimal({ identityProjectionClaims: names(21) })), [
    'identityProjectionClaims',
  ]);
  assert.deepEqual(issuePaths(minimal({ identityProjectionClaims: names(20) })), []);
});

test('identityProjectionClaims: REJECTS a duplicate, naming the SECOND occurrence', () => {
  assert.deepEqual(issuePaths(minimal({ identityProjectionClaims: ['name', 'phone', 'name'] })), [
    'identityProjectionClaims[2]',
  ]);
});

test('identityProjectionClaims: applies in the BOOTSTRAP phase — it needs the provisioning capability', () => {
  // Not cosmetic metadata: the in-context pass runs under the per-context wildcard token, which
  // does NOT carry `provisioning:c`. Declaring this in-context would 403 at apply. Same phase as
  // `issuers` and `namespaces`, for the identical reason.
  assert.equal(BLUEPRINT_FIELD_PHASES.identityProjectionClaims, 'bootstrap');
  assert.equal(BLUEPRINT_FIELD_PHASES.issuers, 'bootstrap');
});

test('identityProjectionClaims and capturedClaims enforce the SAME bounds', () => {
  // Both transcribe the platform's MAX_CAPTURED_CLAIMS / MAX_CAPTURED_CLAIM_NAME_LENGTH. Asserting
  // they AGREE catches one being widened without the other, which a per-block spot-check would not.
  const issuer = {
    issuerId: 'auth0-prod',
    issuer: 'https://t.us.auth0.com/',
    jwksUri: 'https://t.us.auth0.com/.well-known/jwks.json',
    audience: 'https://api.example.com',
    contextId: 'mcp',
  };
  const overLong = ['a'.repeat(65)];
  const tooMany = Array.from({ length: 21 }, (_, i) => `claim_${i}`);
  const dupes = ['name', 'name'];

  for (const bad of [overLong, tooMany, dupes]) {
    const viaProjection = issuePaths(minimal({ identityProjectionClaims: bad }));
    const viaCapture = issuePaths(minimal({ issuers: [{ ...issuer, capturedClaims: bad }] }));
    assert.equal(
      viaProjection.length,
      viaCapture.length,
      `the two blocks disagree on whether ${JSON.stringify(bad).slice(0, 40)} is valid`,
    );
    assert.ok(viaProjection.length > 0, 'expected both blocks to reject this shape');
  }
});

test('identityProjectionClaims: REJECTS a whitespace-only name, same as capturedClaims', () => {
  assert.deepEqual(issuePaths(minimal({ identityProjectionClaims: [' '] })), [
    'identityProjectionClaims[0]',
  ]);
  assert.deepEqual(issuePaths(minimal({ identityProjectionClaims: ['given name'] })), []);
});
