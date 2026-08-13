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

test('REJECTS a malformed identities block (reserved surface name as kind)', async () => {
  // kind is 'user' or an entity namespace (data-driven, not a closed
  // enum) — but a reserved surface word ('entity'/'record'/'document') can never
  // be a namespace and is rejected.
  await assert.rejects(
    () =>
      resolveBlueprintIdentities(
        doc({ identities: { owner: { kind: 'entity', externalId: 'u-1' } } }),
        fakeResolver(),
      ),
    BlueprintIdentityError,
  );
});

test('ACCEPTS a custom-namespace kind — org/client generalize to any namespace', async () => {
  const resolved = (await resolveBlueprintIdentities(
    doc({ identities: { squad: { kind: 'team', externalId: 't-1' } }, description: '${{ identities.squad }}' }),
    fakeResolver(),
  )) as { description?: string };
  // fakeResolver substitutes a deterministic id; the token resolves rather than erroring.
  assert.ok(resolved.description && !resolved.description.includes('${{'), 'custom-namespace identity token resolved');
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

// ── hyphenated names + dotted property access (silent no-op → loud) ───────────
//
// Both bugs share a root cause: the substitution/lint token grammar
// (`[A-Za-z_]\w*`) is stricter than what could previously be DECLARED (no key
// constraint) or WRITTEN as a reference (any string). A shape outside that
// grammar used to match nothing anywhere — not the declared-identity lint, not
// apply-time substitution — so it silently reached apply time as a literal,
// unresolved '${{ ... }}' string instead of erroring.

test('parseBlueprint REJECTS a hyphenated identity NAME in the identities: block', () => {
  try {
    parseBlueprint(minimalBlueprint({ identities: { 'demo-org': { kind: 'org', externalId: 'o-1' } } }));
    assert.fail('expected throw');
  } catch (err) {
    assert.ok(err instanceof BlueprintValidationError);
    assert.ok(
      err.issues.some((i) => i.message.includes('demo-org') || i.path.includes('demo-org')),
      `expected an issue naming 'demo-org', got ${JSON.stringify(err.issues)}`,
    );
  }
});

test('resolveBlueprintIdentities ALSO rejects a hyphenated identity name (same IdentitiesDeclSchema)', async () => {
  await assert.rejects(
    () => resolveBlueprintIdentities(doc({ identities: { 'demo-org': { kind: 'org', externalId: 'o-1' } } }), fakeResolver()),
    BlueprintIdentityError,
  );
});

test('parseBlueprint REJECTS a reference to a hyphenated name with a SPECIFIC "not a valid identities reference" message (not "undeclared")', () => {
  // The name can no longer even be DECLARED (previous test), but the reference-
  // side check must fire independently and give its own diagnostic — not the
  // generic "references an undeclared identity" message, which would be
  // misleading here (the real problem is the shape, not a missing declaration).
  try {
    parseBlueprint(minimalBlueprint({ description: '${{ identities.demo-org }}' }));
    assert.fail('expected throw');
  } catch (err) {
    assert.ok(err instanceof BlueprintValidationError);
    const msg = err.issues.map((i) => i.message).join(' | ');
    assert.match(msg, /not a valid identities reference/);
    assert.doesNotMatch(msg, /undeclared/);
  }
});

test('parseBlueprint REJECTS dotted property access on an identity reference, even when the name IS declared', () => {
  try {
    parseBlueprint(
      minimalBlueprint({
        identities: { owner: { kind: 'user', externalId: 'u-1' } },
        description: '${{ identities.owner.externalId }}',
      } as Partial<Blueprint>),
    );
    assert.fail('expected throw');
  } catch (err) {
    assert.ok(err instanceof BlueprintValidationError);
    const msg = err.issues.map((i) => i.message).join(' | ');
    assert.match(msg, /property access/);
    assert.match(msg, /not supported/);
    // Must name what WOULD work — the bare reference, no trailing property.
    assert.match(msg, /\$\{\{ identities\.owner \}\}/);
  }
});

test('END TO END: resolveBlueprintIdentities leaves a dotted-access token untouched (its own regex cannot match it) — the FOLLOWING parseBlueprint call is what actually catches it', async () => {
  // Documents the real two-stage pipeline (identities.ts's own header comment):
  // apply-time resolution runs BEFORE parseBlueprint. A malformed token survives
  // the first stage unchanged (nothing there recognizes it either), and is
  // refused loudly by the second — still before any live mutation happens, just
  // one call-frame later than the purely-offline `validate` path above.
  const resolved = await resolveBlueprintIdentities(
    doc({
      identities: { owner: { kind: 'user', externalId: 'u-1' } },
      description: '${{ identities.owner.externalId }}',
    }),
    fakeResolver(),
  );
  assert.equal(
    (resolved as { description?: string }).description,
    '${{ identities.owner.externalId }}',
    'resolveBlueprintIdentities alone does not (and cannot) touch a malformed token',
  );
  assert.throws(() => parseBlueprint(resolved), BlueprintValidationError, 'parseBlueprint catches it next');
});
