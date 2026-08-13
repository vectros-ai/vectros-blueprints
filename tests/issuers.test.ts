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

const VALID_ISSUER = {
  issuerId: 'auth0-prod',
  issuer: 'https://your-tenant.us.auth0.com/',
  jwksUri: 'https://your-tenant.us.auth0.com/.well-known/jwks.json',
  audience: 'https://api.your-app.example.com',
  contextId: 'casework',
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
