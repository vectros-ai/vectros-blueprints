/**
 * Apply-time identity resolution (resolveBlueprintIdentities) +
 * the offline "every ${{ identities.* }} is declared" lint in parseBlueprint.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveBlueprintIdentities,
  collectIdentityReferences,
  BlueprintIdentityError,
  type IdentityResolver,
} from '../src/identities.js';
import { parseBlueprint, BlueprintValidationError, type Blueprint } from '../src/types.js';

/** A blueprint-shaped tree (post-input-resolution: identities tokens still literal). */
function doc(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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

/** Deterministic injected resolver: id is `<kind>_<externalId>`; records calls. */
function fakeResolver(calls: string[] = []): IdentityResolver {
  return async (name, decl) => {
    calls.push(name);
    return `${decl.kind}_${decl.externalId}`;
  };
}

function minimalBlueprint(overrides: Partial<Blueprint> = {}): unknown {
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

// ── collectIdentityReferences ────────────────────────────────────────────────

test('collectIdentityReferences finds distinct names across nested strings', () => {
  const refs = collectIdentityReferences(
    doc({ seed: [{ fields: { a: '${{ identities.owner }}', b: 'x ${{ identities.team }} y' } }] }),
  );
  assert.deepEqual(refs.sort(), ['owner', 'team']);
});

// ── resolveBlueprintIdentities ───────────────────────────────────────────────

test('resolves declared identities, substitutes tokens, strips the identities block', async () => {
  const calls: string[] = [];
  const out = (await resolveBlueprintIdentities(
    doc({
      identities: { owner: { kind: 'user', externalId: 'u-1' } },
      seed: [{ surface: 'record', typeName: 'task', externalId: 's1', fields: { owner: '${{ identities.owner }}' } }],
    }),
    fakeResolver(calls),
  )) as Record<string, any>;
  assert.equal(out.seed[0].fields.owner, 'user_u-1');
  assert.equal(out.identities, undefined, 'identities block is stripped');
  assert.deepEqual(calls, ['owner']);
});

test('resolves an embedded token within a larger string', async () => {
  const out = (await resolveBlueprintIdentities(
    doc({
      identities: { team: { kind: 'org', externalId: 'o-9' } },
      description: 'owned by ${{ identities.team }}!',
    }),
    fakeResolver(),
  )) as Record<string, any>;
  assert.equal(out.description, 'owned by org_o-9!');
});

test('ensures EVERY declared identity exists, even if not token-referenced', async () => {
  const calls: string[] = [];
  await resolveBlueprintIdentities(
    doc({ identities: { a: { kind: 'user', externalId: 'ua' }, b: { kind: 'client', externalId: 'cb' } } }),
    fakeResolver(calls),
  );
  assert.deepEqual(calls.sort(), ['a', 'b']);
});

test('REJECTS a token that references an undeclared identity', async () => {
  await assert.rejects(
    () =>
      resolveBlueprintIdentities(
        doc({ identities: { owner: { kind: 'user', externalId: 'u-1' } }, description: '${{ identities.ghost }}' }),
        fakeResolver(),
      ),
    BlueprintIdentityError,
  );
});

test('REJECTS a malformed identities block (bad kind)', async () => {
  await assert.rejects(
    () =>
      resolveBlueprintIdentities(
        doc({ identities: { owner: { kind: 'robot', externalId: 'u-1' } } }),
        fakeResolver(),
      ),
    BlueprintIdentityError,
  );
});

test('surfaces a resolver failure as BlueprintIdentityError (teach-by-error)', async () => {
  const failing: IdentityResolver = async () => {
    throw new Error('tenant quota exceeded');
  };
  await assert.rejects(
    () => resolveBlueprintIdentities(doc({ identities: { owner: { kind: 'user', externalId: 'u-1' } } }), failing),
    (err: unknown) => {
      assert.ok(err instanceof BlueprintIdentityError);
      assert.match(err.message, /tenant quota exceeded/);
      return true;
    },
  );
});

test('REJECTS a resolver that returns a non-string id (would silently write "undefined")', async () => {
  const badResolver = (async () => undefined) as unknown as IdentityResolver;
  await assert.rejects(
    () => resolveBlueprintIdentities(doc({ identities: { owner: { kind: 'user', externalId: 'u-1' } } }), badResolver),
    BlueprintIdentityError,
  );
});

test('no identities block + no references → returns the tree unchanged (back-compat)', async () => {
  const input = doc({ description: 'plain' });
  const out = await resolveBlueprintIdentities(input, fakeResolver());
  assert.equal((out as Record<string, unknown>).description, 'plain');
});

// ── offline lint (parseBlueprint) ────────────────────────────────────────────

test('parseBlueprint accepts a declared identity reference', () => {
  const bp = parseBlueprint(
    minimalBlueprint({
      identities: { owner: { kind: 'user', externalId: 'u-1' } },
      seed: [{ surface: 'record', typeName: 'task', externalId: 's1', fields: { owner: '${{ identities.owner }}' } }],
    } as Partial<Blueprint>),
  );
  assert.equal((bp as Record<string, any>).identities.owner.kind, 'user');
});

test('parseBlueprint REJECTS an undeclared identity reference (offline, at validate)', () => {
  try {
    parseBlueprint(minimalBlueprint({ description: '${{ identities.ghost }}' }));
    assert.fail('expected throw');
  } catch (err) {
    assert.ok(err instanceof BlueprintValidationError);
    assert.ok(err.issues.some((i) => i.message.includes('ghost')), 'expected a ghost-reference issue');
  }
});
