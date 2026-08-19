/**
 * A blueprint may declare an `entity`-surfaced schema, but never a `user`-surfaced one.
 *
 * This is an authorization property expressed as an author-time lint rather than a syntax rule, so each
 * case below names the platform behaviour it mirrors. The point of the lint is that `validate` and
 * `plan` used to pass a schema the apply would always reject — so the negative cases matter, and the
 * positive one matters most, because it is what stops the lint from over-rejecting.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBlueprint, BlueprintValidationError, type Blueprint } from '../src/types.js';

function withSchema(allowedSurfaces: string[]): Blueprint {
  return {
    name: 'demo',
    version: '1.0.0',
    description: 'demo blueprint',
    contextId: 'mcp',
    schemas: [
      {
        typeName: 'profile',
        displayName: 'Profile',
        fields: [{ fieldId: 'name', fieldType: 'string' }],
        allowedSurfaces,
      },
    ],
    accessProfile: { allowedActions: ['records:r'] },
    servicePrincipal: { externalId: 'demo-sp', displayName: 'Demo SP' },
  } as unknown as Blueprint;
}

test('a user-surfaced schema is rejected at author time', () => {
  let caught: unknown;
  try {
    parseBlueprint(withSchema(['user']));
  } catch (e) {
    caught = e;
  }
  assert.ok(caught instanceof BlueprintValidationError, 'must reject, not pass');
  assert.match(
    String((caught as Error).message),
    /allowedSurfaces cannot include 'user'/,
    'the message must say WHY (root-only, no blueprint credential holds one), not just "invalid" — ' +
      'an author who cannot tell why will retry the same shape',
  );
});

test('a user surface is rejected even when combined with entity', () => {
  // The check is "contains user", not "is exactly [user]" — a schema that binds `user` at all is still
  // account-global and still root-only, so listing `entity` alongside it must not launder it through.
  assert.throws(() => parseBlueprint(withSchema(['entity', 'user'])), BlueprintValidationError);
});

/**
 * ⭐ THE CONTROL, and the case this lint exists to get RIGHT rather than merely strict.
 *
 * An entity schema is owned by the app context that writes it, and a blueprint applies with a
 * credential confined to exactly that context — so it provisions cleanly. A lint that rejected `entity`
 * alongside `user` would block a working configuration, which is a worse failure than the one this
 * lint was added to fix: it would break valid blueprints rather than merely fail to warn about
 * invalid ones.
 */
test('an entity-surfaced schema is ACCEPTED — a blueprint can provision one', () => {
  const bp = parseBlueprint(withSchema(['entity']));
  assert.deepEqual(bp.schemas[0].allowedSurfaces, ['entity']);
});

test('ordinary record/document surfaces are untouched', () => {
  assert.deepEqual(parseBlueprint(withSchema(['record'])).schemas[0].allowedSurfaces, ['record']);
  assert.deepEqual(
    parseBlueprint(withSchema(['record', 'document'])).schemas[0].allowedSurfaces,
    ['record', 'document'],
  );
});
