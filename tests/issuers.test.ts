/**
 * Top-level `issuers` — trusted third-party IdP issuers, applied in the CLI
 * loader's bootstrap-token phase, NOT the in-context load. Structural (zod)
 * validation only; see reference-and-roles.test.ts for the sibling `roles`
 * block this mirrors in test shape.
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

// NOTE the contextId: it matches `minimal()`'s, and that is now load-bearing rather than incidental.
// This fixture previously read 'casework' while minimal() declared 'mcp' — every test in this file was
// silently exercising an issuer pointed at an app context the blueprint never provisions, which is the
// exact shape the equality lint now rejects. No test asserted on the divergence; it was simply never
// examined, which is a fair summary of why the field could be used that way at all.
const VALID_ISSUER = {
  issuerId: 'auth0-prod',
  issuer: 'https://your-tenant.us.auth0.com/',
  jwksUri: 'https://your-tenant.us.auth0.com/.well-known/jwks.json',
  audience: 'https://api.your-app.example.com',
  contextId: 'mcp',
};

test('issuers: omitted entirely — parses fine (optional, backward-compatible)', () => {
  const bp = parseBlueprint(minimal());
  assert.equal(bp.issuers, undefined);
});

test('issuers: accepts a full entry (required fields + optional subClaim/emailClaim)', () => {
  const bp = parseBlueprint(
    minimal({ issuers: [{ ...VALID_ISSUER, subClaim: 'user_id', emailClaim: 'user_email' }] }),
  );
  assert.equal(bp.issuers?.length, 1);
  assert.equal(bp.issuers?.[0].issuerId, 'auth0-prod');
  assert.equal(bp.issuers?.[0].subClaim, 'user_id');
  assert.equal(bp.issuers?.[0].emailClaim, 'user_email');
});

test('issuers: accepts an entry with only the required fields (subClaim/emailClaim omitted)', () => {
  const bp = parseBlueprint(minimal({ issuers: [VALID_ISSUER] }));
  assert.equal(bp.issuers?.[0].subClaim, undefined);
  assert.equal(bp.issuers?.[0].emailClaim, undefined);
});

test('issuers: REJECTS an issuerId that fails the slug grammar (uppercase)', () => {
  const paths = issuePaths(minimal({ issuers: [{ ...VALID_ISSUER, issuerId: 'Auth0-Prod' }] }));
  assert.ok(paths.some((p) => p.includes('issuerId')), `expected an issuerId issue, got ${JSON.stringify(paths)}`);
});

test('issuers: REJECTS an issuerId shorter than 3 chars', () => {
  const paths = issuePaths(minimal({ issuers: [{ ...VALID_ISSUER, issuerId: 'ab' }] }));
  assert.ok(paths.some((p) => p.includes('issuerId')), `expected an issuerId issue, got ${JSON.stringify(paths)}`);
});

test('issuers: REJECTS a contextId that fails the app-context grammar', () => {
  const paths = issuePaths(minimal({ issuers: [{ ...VALID_ISSUER, contextId: 'Not_Valid' }] }));
  assert.ok(paths.some((p) => p.includes('contextId')), `expected a contextId issue, got ${JSON.stringify(paths)}`);
});

test('issuers: REJECTS an entry missing a required field (jwksUri)', () => {
  const { jwksUri: _jwksUri, ...withoutJwksUri } = VALID_ISSUER;
  const paths = issuePaths(minimal({ issuers: [withoutJwksUri] }));
  assert.ok(paths.some((p) => p.includes('jwksUri')), `expected a jwksUri issue, got ${JSON.stringify(paths)}`);
});

test('issuers: REJECTS an unknown key (.strict())', () => {
  const paths = issuePaths(minimal({ issuers: [{ ...VALID_ISSUER, scopeAction: 'ISSUER_MANAGE' }] }));
  assert.ok(paths.length > 0, `expected an unrecognized-key issue, got ${JSON.stringify(paths)}`);
});

test('issuers: accepts multiple entries (e.g. live + test tenants on one IdP account, distinct audience)', () => {
  const bp = parseBlueprint(
    minimal({
      issuers: [
        VALID_ISSUER,
        { ...VALID_ISSUER, issuerId: 'auth0-test', audience: 'https://api.your-app.example.com/test' },
      ],
    }),
  );
  assert.equal(bp.issuers?.length, 2);
});

// ---------------------------------------------------------------------------
// An issuer must target the blueprint's own app context.
//
// `contextId` on an issuer entry was the ONE field able to name an app context other than the
// blueprint's own — schemas, roles, the access profile, the service principal and seed records all land
// in `blueprint.contextId`. That asymmetry is a smuggling channel: a reviewer reads that a pack
// provisions one context and has no reason to check each issuer entry for a different target, so a pack
// could attach an identity provider — with self-signup onto a real role — to a context the reader never
// associated with it. An issuer is a trust anchor; whoever controls its jwksUri can mint identities the
// platform accepts.
// ---------------------------------------------------------------------------

test('issuers: REJECTS an issuer targeting a different app context than the blueprint', () => {
  const paths = issuePaths(minimal({ issuers: [{ ...VALID_ISSUER, contextId: 'some-other-context' }] }));
  assert.ok(
    paths.some((p) => p.includes('issuers') && p.includes('contextId')),
    `expected an issuers[].contextId issue, got ${JSON.stringify(paths)}`,
  );
});

test('issuers: the rejection names both contexts, so the fix is obvious without reading the schema', () => {
  try {
    parseBlueprint(minimal({ issuers: [{ ...VALID_ISSUER, contextId: 'some-other-context' }] }));
    assert.fail('expected a validation error');
  } catch (err) {
    assert.ok(err instanceof BlueprintValidationError);
    const text = err.issues.map((i) => i.message).join('\n');
    assert.ok(text.includes('some-other-context'), `message must name the offending context: ${text}`);
    assert.ok(text.includes('mcp'), `message must name the blueprint's own context: ${text}`);
  }
});

test('issuers: ACCEPTS an issuer whose context matches the blueprint (the positive control)', () => {
  // Guard-the-guard: without this, the rejection above could pass because issuers were rejected
  // wholesale rather than because the contexts differ.
  const bp = parseBlueprint(minimal({ contextId: 'casework', issuers: [{ ...VALID_ISSUER, contextId: 'casework' }] }));
  assert.equal(bp.issuers?.[0].contextId, 'casework');
});

test('issuers: the check is per-entry — a valid entry does not excuse a divergent sibling', () => {
  const paths = issuePaths(
    minimal({
      issuers: [
        VALID_ISSUER,
        { ...VALID_ISSUER, issuerId: 'auth0-elsewhere', audience: 'https://api.your-app.example.com/x', contextId: 'elsewhere' },
      ],
    }),
  );
  // Exact path, not a substring: `includes('1')` also matches `issuers[10].contextId` or any path
  // that happens to contain a 1. And assert there is exactly ONE issue — without that, a rule that
  // wrongly flagged the VALID sibling at index 0 as well would still pass this test, which would
  // defeat the "per-entry" claim the test's own name makes.
  assert.deepEqual(paths, ['issuers[1].contextId'],
    `expected exactly one issue, at index 1, got ${JSON.stringify(paths)}`);
});
