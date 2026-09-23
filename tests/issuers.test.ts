/**
 * Top-level `issuers` — trusted third-party IdP issuers, applied in the CLI
 * loader's bootstrap-token phase, NOT the in-context load. Structural (zod)
 * validation only; see reference-and-roles.test.ts for the sibling `roles`
 * block this mirrors in test shape.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBlueprint, BlueprintValidationError, isRestrictedToDomainName, type Blueprint } from '../src/types.js';

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
  // Deliberately malformed (missing a required field) — same `as never` escape
  // this file's own sibling assertions need, matching scope-entries.test.ts's
  // established convention for feeding an intentionally-invalid shape to a
  // helper typed against the VALID Blueprint shape.
  const paths = issuePaths(minimal({ issuers: [withoutJwksUri as never] }));
  assert.ok(paths.some((p) => p.includes('jwksUri')), `expected a jwksUri issue, got ${JSON.stringify(paths)}`);
});

test('issuers: REJECTS an unknown key (.strict())', () => {
  const paths = issuePaths(minimal({ issuers: [{ ...VALID_ISSUER, scopeAction: 'ISSUER_MANAGE' } as never] }));
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

// ── capturedClaims (0.43.0) ──────────────────────────────────────────────
// The platform half shipped in 0.43.0; this block is the blueprint-authoring half, unblocked by the
// SDK pin the field's own deferral NOTE named as its precondition. Bounds are transcribed from
// the platform's own captured-claim count and name-length limits.

test('capturedClaims: omitting it is valid — the default is "capture nothing beyond email"', () => {
  const bp = parseBlueprint(minimal({ issuers: [VALID_ISSUER] }));
  assert.equal(bp.issuers?.[0].capturedClaims, undefined);
});

test('capturedClaims: accepts a list of claim names and preserves order', () => {
  const bp = parseBlueprint(
    minimal({ issuers: [{ ...VALID_ISSUER, capturedClaims: ['name', 'phone_number'] }] }),
  );
  assert.deepEqual(bp.issuers?.[0].capturedClaims, ['name', 'phone_number']);
});

test('capturedClaims: an explicit empty list is accepted (states "capture nothing" outright)', () => {
  const bp = parseBlueprint(minimal({ issuers: [{ ...VALID_ISSUER, capturedClaims: [] }] }));
  assert.deepEqual(bp.issuers?.[0].capturedClaims, []);
});

test('capturedClaims: REJECTS a blank entry', () => {
  assert.deepEqual(
    issuePaths(minimal({ issuers: [{ ...VALID_ISSUER, capturedClaims: ['name', ''] }] })),
    ['issuers[0].capturedClaims[1]'],
  );
});

test('capturedClaims: REJECTS a name above the 64-character platform limit, and accepts one at exactly 64', () => {
  assert.deepEqual(issuePaths(minimal({ issuers: [{ ...VALID_ISSUER, capturedClaims: ['a'.repeat(65)] }] })), [
    'issuers[0].capturedClaims[0]',
  ]);
  assert.deepEqual(issuePaths(minimal({ issuers: [{ ...VALID_ISSUER, capturedClaims: ['a'.repeat(64)] }] })), []);
});

test('capturedClaims: REJECTS more than 20 entries, and accepts exactly 20', () => {
  const names = (n: number) => Array.from({ length: n }, (_, i) => `claim_${i}`);
  assert.deepEqual(issuePaths(minimal({ issuers: [{ ...VALID_ISSUER, capturedClaims: names(21) }] })), [
    'issuers[0].capturedClaims',
  ]);
  assert.deepEqual(issuePaths(minimal({ issuers: [{ ...VALID_ISSUER, capturedClaims: names(20) }] })), []);
});

test('capturedClaims: REJECTS a duplicate rather than deduplicating, naming the SECOND occurrence', () => {
  // The platform rejects rather than dedupes; the index points at the entry to delete, not at the list.
  assert.deepEqual(
    issuePaths(minimal({ issuers: [{ ...VALID_ISSUER, capturedClaims: ['name', 'phone', 'name'] }] })),
    ['issuers[0].capturedClaims[2]'],
  );
});

test('capturedClaims: is still subject to .strict() siblings — an unknown issuer key is rejected', () => {
  assert.deepEqual(
    issuePaths(minimal({ issuers: [{ ...VALID_ISSUER, capturedClaims: ['name'], capturedClaim: ['x'] }] })),
    ['issuers[0]'],
  );
});

test('capturedClaims: REJECTS a whitespace-only name, not just an empty one', () => {
  // The message says "non-blank", so the check must be non-BLANK. `z.string().min(1)` is a LENGTH
  // check and admits ' ' — the platform rejects on isBlank(), and the CLI's own --captured-claim
  // rejects a blank one, so a length-only check here made the two adopters of one platform rule disagree
  // and produced the "lints clean, then 400s at apply" shape this package exists to prevent.
  // '\t' and '\n' ALSO trip the schema's separate forgery-character guard (safeDisplayString —
  // see types.ts), landing a SECOND issue at the same path, so this checks presence rather than
  // an exact single-element array (same idiom as the roleAssumable/triggers[].fields duplicate-
  // issue cases elsewhere in this suite).
  for (const blank of [' ', '   ', '\t', '\n']) {
    const paths = issuePaths(minimal({ issuers: [{ ...VALID_ISSUER, capturedClaims: [blank] }] }));
    assert.ok(
      paths.includes('issuers[0].capturedClaims[0]'),
      `expected ${JSON.stringify(blank)} to be rejected, got ${JSON.stringify(paths)}`,
    );
  }
  // A name with INTERIOR whitespace is not blank and stays valid — trim, not "no spaces".
  assert.deepEqual(
    issuePaths(minimal({ issuers: [{ ...VALID_ISSUER, capturedClaims: ['given name'] }] })),
    [],
  );
});

// --- restrictedToDomain ---------------------------------------------------------------------------

test('issuers[].restrictedToDomain: accepts a lowercase DNS name, a subdomain, and a punycode label', () => {
  for (const domain of ['acme.com', 'eng.acme.co.uk', 'a-b.example.org', 'xn--bcher-kva.example', '1.example.io']) {
    const bp = parseBlueprint(minimal({ issuers: [{ ...VALID_ISSUER, restrictedToDomain: domain }] }));
    assert.equal(bp.issuers?.[0].restrictedToDomain, domain, `expected '${domain}' to parse`);
  }
});

test('issuers[].restrictedToDomain: omitted stays undefined — a domain-less issuer is the default', () => {
  const bp = parseBlueprint(minimal({ issuers: [VALID_ISSUER] }));
  assert.equal(bp.issuers?.[0].restrictedToDomain, undefined);
});

test('issuers[].restrictedToDomain: REJECTS anything that is not a lowercase ASCII DNS name', () => {
  const bad: Array<[string, string]> = [
    ['', 'empty'],
    ['acme', 'a single label'],
    ['Acme.com', 'uppercase — the platform stores the lowercase form, so the reviewer must read that'],
    ['https://acme.com', 'a URL, not a domain'],
    ['acme.com/path', 'a path'],
    ['acme.com:443', 'a port'],
    ['acme.com.', 'a trailing dot'],
    ['.acme.com', 'a leading dot'],
    ['acme..com', 'an empty label'],
    ['-acme.com', 'a label starting with a dash'],
    ['acme-.com', 'a label ending with a dash'],
    ['acme_corp.com', 'an underscore'],
    [' acme.com', 'leading whitespace'],
    ['acme.com\n', 'a trailing newline'],
    // Assembled at runtime so no literal email-shaped string appears in the source.
    [`user${'@'}acme.com`, 'userinfo'],
    ['аcme.com', 'a Cyrillic homoglyph of "a"'],
    [`${'a'.repeat(64)}.com`, 'a 64-character label'],
    [`${Array(60).fill('abcd').join('.')}.com`, 'a name over 253 characters'],
  ];
  for (const [value, why] of bad) {
    assert.deepEqual(
      issuePaths(minimal({ issuers: [{ ...VALID_ISSUER, restrictedToDomain: value }] })),
      ['issuers[0].restrictedToDomain'],
      `expected rejection for ${why}: ${JSON.stringify(value)}`,
    );
  }
});

test('issuers[].restrictedToDomain: the length limits are exact — a 63-character label and a 253-character name pass, one more fails', () => {
  // Labels of 63 characters are the most a label may carry; three of them, a shorter fourth and
  // three dots make exactly 253 (63 * 3 + 61 + 3). A 254th character must fail on total length alone.
  const build = (last: number): string => [...Array(3).fill('a'.repeat(63)), 'b'.repeat(last)].join('.');
  const at253 = build(61);
  const at254 = build(62);
  assert.equal(at253.length, 253);
  assert.equal(at254.length, 254);
  for (const domain of [`${'a'.repeat(63)}.com`, at253]) {
    const bp = parseBlueprint(minimal({ issuers: [{ ...VALID_ISSUER, restrictedToDomain: domain }] }));
    assert.equal(bp.issuers?.[0].restrictedToDomain, domain, `expected a ${domain.length}-character name to parse`);
  }
  for (const domain of [`${'b'.repeat(64)}.com`, at254]) {
    assert.deepEqual(
      issuePaths(minimal({ issuers: [{ ...VALID_ISSUER, restrictedToDomain: domain }] })),
      ['issuers[0].restrictedToDomain'],
      `expected a ${domain.length}-character name to be rejected`,
    );
  }
});

test('isRestrictedToDomainName is the schema grammar: it accepts and rejects exactly what an issuer entry does', () => {
  // The CLI validates its own flag with this function instead of a copy of the regex, so the two cannot drift.
  const values = ['acme.com', 'eng.acme.co.uk', 'xn--bcher-kva.example', 'Acme.com', 'acme', 'acme.com.', '.acme.com',
    '-acme.com', 'acme-.com', 'acme.com/x', 'https://acme.com', 'аcme.com', ''];
  for (const value of values) {
    let parses = true;
    try {
      parseBlueprint(minimal({ issuers: [{ ...VALID_ISSUER, restrictedToDomain: value }] }));
    } catch {
      parses = false;
    }
    assert.equal(isRestrictedToDomainName(value), parses, `disagreement for ${JSON.stringify(value)}`);
  }
});
