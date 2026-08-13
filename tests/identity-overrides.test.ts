/**
 * `accessProfile.identityOverrides` — the FULL platform rule, not just the value
 * half: every KEY must be a grammar-valid, non-forbidden `scope:<ns>`; the map
 * carries at most 2 dimensions; and every VALUE is either the
 * documented `${{ identities.<name> }}` substitution token (placeholder-aware —
 * the platform grammar's excluded `$`/`{`/`}` would otherwise reject every
 * blueprint using one) or must satisfy the platform's literal scope-value
 * grammar.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBlueprint, BlueprintValidationError, type Blueprint } from '../src/types.js';
import { resolveBlueprintIdentities, type IdentityResolver } from '../src/identities.js';

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

function issueMessages(input: unknown): string[] {
  try {
    parseBlueprint(input);
    return [];
  } catch (err) {
    assert.ok(err instanceof BlueprintValidationError, `expected BlueprintValidationError, got ${err}`);
    return err.issues.map((i) => i.message);
  }
}

// ── literals ──────────────────────────────────────────────────────────────────

test('identityOverrides: ACCEPTS a grammar-valid literal value', () => {
  const bp = parseBlueprint(
    minimal({ accessProfile: { allowedActions: ['records:r'], identityOverrides: { 'scope:org': 'org_acme-1' } } }),
  );
  assert.equal(bp.accessProfile.identityOverrides?.['scope:org'], 'org_acme-1');
});

// A colon-bearing value used to round-trip clean and 400 at apply (the value
// becomes an entity id inside a colon-split storage key).
test('identityOverrides: REJECTS a literal value containing a colon', () => {
  const paths = issuePaths(
    minimal({ accessProfile: { allowedActions: ['records:r'], identityOverrides: { 'scope:org': 'a:b' } } }),
  );
  assert.ok(
    paths.includes('accessProfile.identityOverrides.scope:org'),
    `expected an accessProfile.identityOverrides issue, got ${JSON.stringify(paths)}`,
  );
});

test('identityOverrides: REJECTS a literal value shaped like a placeholder but not a real identities token', () => {
  // '$', '{', '}' are excluded from the literal grammar because a stored value is
  // re-parsed for placeholders server-side — a placeholder-shaped literal would
  // read back as a matcher and widen the credential to a whole compartment. This
  // string is NOT the documented '${{ identities.<name> }}' shape (no 'identities.'
  // segment), so it must fall through to the literal grammar and be rejected, not
  // silently waved through as "looks like a token".
  const paths = issuePaths(
    minimal({ accessProfile: { allowedActions: ['records:r'], identityOverrides: { 'scope:org': '${{ any }}' } } }),
  );
  assert.ok(
    paths.includes('accessProfile.identityOverrides.scope:org'),
    `expected an accessProfile.identityOverrides issue, got ${JSON.stringify(paths)}`,
  );
});

// Found in review: the placeholder-recognition check must match the WHOLE
// value, not just a substring of it. An unanchored check let a value like
// this skip the literal grammar entirely, with its colon-bearing suffix
// intact — exactly the shape the whole change exists to catch. This is the
// regression pin for that bug (must fail with the anchor removed — verified
// by hand, see the branch's review notes).
test('identityOverrides: REJECTS a literal value that merely EMBEDS a well-formed, declared identities token', () => {
  const paths = issuePaths(
    minimal({
      identities: { team: { kind: 'org', externalId: 'o-9' } },
      accessProfile: {
        allowedActions: ['records:r'],
        identityOverrides: { 'scope:org': '${{ identities.team }}-x:y' },
      },
    } as Partial<Blueprint>),
  );
  assert.ok(
    paths.includes('accessProfile.identityOverrides.scope:org'),
    `expected the embedded-token value to be rejected, got ${JSON.stringify(paths)}`,
  );
});

test('identityOverrides: REJECTS a literal value with a well-formed, declared identities token as a PREFIX', () => {
  const paths = issuePaths(
    minimal({
      identities: { team: { kind: 'org', externalId: 'o-9' } },
      accessProfile: {
        allowedActions: ['records:r'],
        identityOverrides: { 'scope:org': 'x${{identities.team}}' },
      },
    } as Partial<Blueprint>),
  );
  assert.ok(
    paths.includes('accessProfile.identityOverrides.scope:org'),
    `expected the embedded-token value to be rejected, got ${JSON.stringify(paths)}`,
  );
});

// ── length boundary + character class (mirrors the platform's own bound —
// pins the grammar so a drift in either copy goes red here, not just at apply) ──

test('identityOverrides: ACCEPTS a literal value at the 128-char length boundary', () => {
  const bp = parseBlueprint(
    minimal({
      accessProfile: { allowedActions: ['records:r'], identityOverrides: { 'scope:org': `v${'a'.repeat(127)}` } },
    }),
  );
  assert.equal(bp.accessProfile.identityOverrides?.['scope:org'].length, 128);
});

test('identityOverrides: REJECTS a literal value one character past the 128-char boundary', () => {
  const paths = issuePaths(
    minimal({
      accessProfile: { allowedActions: ['records:r'], identityOverrides: { 'scope:org': `v${'a'.repeat(128)}` } },
    }),
  );
  assert.ok(
    paths.includes('accessProfile.identityOverrides.scope:org'),
    `expected a length-boundary issue, got ${JSON.stringify(paths)}`,
  );
});

test('identityOverrides: REJECTS a literal value starting with "-" (must start letter-or-digit)', () => {
  const paths = issuePaths(
    minimal({ accessProfile: { allowedActions: ['records:r'], identityOverrides: { 'scope:org': '-lead' } } }),
  );
  assert.ok(
    paths.includes('accessProfile.identityOverrides.scope:org'),
    `expected a leading-char issue, got ${JSON.stringify(paths)}`,
  );
});

// ── multiple keys: every entry must be checked, not just the first ─────────────

test('identityOverrides: REJECTS when the SECOND key is the bad one (a first-entry-only check would pass this)', () => {
  const paths = issuePaths(
    minimal({
      accessProfile: {
        allowedActions: ['records:r'],
        identityOverrides: { 'scope:org': 'org_acme-1', 'scope:client': 'a:b' },
      },
    }),
  );
  assert.ok(
    paths.includes('accessProfile.identityOverrides.scope:client'),
    `expected an issue on the second key, got ${JSON.stringify(paths)}`,
  );
});

// ── keys: must be a grammar-valid, non-forbidden 'scope:<ns>' ──────────────────

test('identityOverrides: REJECTS the retired bare "orgId" key (the legacy spelling was dropped)', () => {
  const paths = issuePaths(
    minimal({ accessProfile: { allowedActions: ['records:r'], identityOverrides: { orgId: 'org_acme-1' } } }),
  );
  assert.ok(
    paths.includes('accessProfile.identityOverrides.orgId'),
    `expected an issue on the orgId key, got ${JSON.stringify(paths)}`,
  );
});

test('identityOverrides: REJECTS a forbidden namespace key ("scope:tenant" would shadow the partition axis)', () => {
  const paths = issuePaths(
    minimal({ accessProfile: { allowedActions: ['records:r'], identityOverrides: { 'scope:tenant': 'x' } } }),
  );
  assert.ok(
    paths.includes('accessProfile.identityOverrides.scope:tenant'),
    `expected an issue on the scope:tenant key, got ${JSON.stringify(paths)}`,
  );
});

test('identityOverrides: REJECTS a namespace key that fails the shape grammar (uppercase)', () => {
  const paths = issuePaths(
    minimal({ accessProfile: { allowedActions: ['records:r'], identityOverrides: { 'scope:Team': 'x' } } }),
  );
  assert.ok(
    paths.includes('accessProfile.identityOverrides.scope:Team'),
    `expected an issue on the scope:Team key, got ${JSON.stringify(paths)}`,
  );
});

test('identityOverrides: ACCEPTS an open, grammar-valid custom namespace key', () => {
  const bp = parseBlueprint(
    minimal({ accessProfile: { allowedActions: ['records:r'], identityOverrides: { 'scope:team': 'eng-1' } } }),
  );
  assert.equal(bp.accessProfile.identityOverrides?.['scope:team'], 'eng-1');
});

// ── ≤2-dimension cap ───────────────────────────────────────────────────────────────────────────────────────────────────────

test('identityOverrides: ACCEPTS exactly 2 dimensions (the cap, not one past it)', () => {
  const bp = parseBlueprint(
    minimal({
      accessProfile: {
        allowedActions: ['records:r'],
        identityOverrides: { 'scope:org': 'org_acme-1', 'scope:client': 'client_x' },
      },
    }),
  );
  assert.equal(Object.keys(bp.accessProfile.identityOverrides ?? {}).length, 2);
});

test('identityOverrides: REJECTS a 3rd scope dimension (a record carries at most 2 scope values)', () => {
  const paths = issuePaths(
    minimal({
      accessProfile: {
        allowedActions: ['records:r'],
        identityOverrides: { 'scope:org': 'org_acme-1', 'scope:client': 'client_x', 'scope:team': 'eng-1' },
      },
    }),
  );
  assert.ok(
    paths.includes('accessProfile.identityOverrides'),
    `expected a whole-map cap issue, got ${JSON.stringify(paths)}`,
  );
});

// ── the documented substitution token ────────────────────────────────────────

test('identityOverrides: ACCEPTS the documented ${{ identities.<name> }} substitution token (declared identity)', () => {
  const bp = parseBlueprint(
    minimal({
      identities: { team: { kind: 'org', externalId: 'o-9' } },
      accessProfile: { allowedActions: ['records:r'], identityOverrides: { 'scope:org': '${{ identities.team }}' } },
    } as Partial<Blueprint>),
  );
  assert.equal(bp.accessProfile.identityOverrides?.['scope:org'], '${{ identities.team }}');
});

test('identityOverrides: REJECTS a ${{ identities.<name> }} token referencing an undeclared identity', () => {
  // The token SHAPE is exempt from the literal grammar, but it still owes the
  // existing declared-identity lint (lintIdentityRefs) — the two checks compose
  // rather than the placeholder shape bypassing validation altogether. Assert on
  // the MESSAGE, not just the path — a path-only check can't tell this issue
  // apart from one lintIdentityOverrideValues itself would raise, so it can't
  // prove the two checks are actually composing rather than one masking the
  // other's absence.
  const messages = issueMessages(
    minimal({
      accessProfile: { allowedActions: ['records:r'], identityOverrides: { 'scope:org': '${{ identities.ghost }}' } },
    }),
  );
  assert.ok(
    messages.some((m) => m.includes('undeclared identity')),
    `expected an "undeclared identity" issue, got ${JSON.stringify(messages)}`,
  );
});

test('identityOverrides: ACCEPTS a value with no identityOverrides at all (field omitted)', () => {
  const bp = parseBlueprint(minimal({ accessProfile: { allowedActions: ['records:r'] } }));
  assert.equal(bp.accessProfile.identityOverrides, undefined);
});

// ── the substituted (apply-time) value is checked too — pins the claim in the
// module's own comment, which had no test until review flagged it as untested ──

test('identityOverrides: the SUBSTITUTED value is validated when parseBlueprint re-runs post-identity-resolution', async () => {
  // resolveBlueprintIdentities only guards that a resolver returns a non-empty
  // string (identities.ts) — it does not itself apply the scope-value grammar,
  // so a resolver returning a colon-bearing id is representable here exactly as
  // an external identity-provisioning system could return one for real.
  const badResolver: IdentityResolver = async () => 'a:b';
  const resolved = await resolveBlueprintIdentities(
    minimal({
      identities: { team: { kind: 'org', externalId: 'o-9' } },
      accessProfile: { allowedActions: ['records:r'], identityOverrides: { 'scope:org': '${{ identities.team }}' } },
    } as Partial<Blueprint>),
    badResolver,
  );
  assert.throws(() => parseBlueprint(resolved), BlueprintValidationError);
});
