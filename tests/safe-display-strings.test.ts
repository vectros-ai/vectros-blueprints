/**
 * Schema-level rejection of forgery characters (`safeDisplayString`/`FORGERY_CHARS_RE` in
 * `src/types.ts`) — every blueprint-authored free-text field a rendered, human-reviewed
 * surface (today: the CLI's pre-apply plan preview) may interpolate into a single printed
 * line. Closes the class at parse time rather than trusting every current and future
 * renderer to sanitize its own inputs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBlueprint, BlueprintValidationError, type Blueprint } from '../src/types.js';

function minimal(overrides: Partial<Blueprint> = {}): unknown {
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

// A representative sample of the character classes FORGERY_CHARS_RE covers — not
// exhaustive, but one from each documented band (C0/DEL, C1, line/paragraph separator,
// bidi embed/override, bidi isolate).
const RAW_NEWLINE = 'line1\nline2';
const ANSI_ESCAPE = '\x1b[31mred';
const NUL_BYTE = 'a\x00b';
const C1_CONTROL = 'a\x9bb';
const LINE_SEPARATOR = 'a\u2028b';
const PARAGRAPH_SEPARATOR = 'a\u2029b';
const BIDI_OVERRIDE = 'a\u202eb';
const BIDI_ISOLATE = 'a\u2066b';
const SOFT_HYPHEN = `a${String.fromCodePoint(0x00ad)}b`;
const ARABIC_LETTER_MARK = `a${String.fromCodePoint(0x061c)}b`;
const ZERO_WIDTH_SPACE = `a${String.fromCodePoint(0x200b)}b`;
const LEFT_TO_RIGHT_MARK = `a${String.fromCodePoint(0x200e)}b`;
const WORD_JOINER = `a${String.fromCodePoint(0x2060)}b`;
const BYTE_ORDER_MARK = `a${String.fromCodePoint(0xfeff)}b`;
const TAG_CHARACTER = `a${String.fromCodePoint(0xe0001)}b`;

const FORGERY_SAMPLES: Array<[string, string]> = [
  ['a raw newline', RAW_NEWLINE],
  ['an ANSI escape sequence', ANSI_ESCAPE],
  ['a NUL byte', NUL_BYTE],
  ['a C1 control character', C1_CONTROL],
  ['a Unicode line separator (U+2028)', LINE_SEPARATOR],
  ['a Unicode paragraph separator (U+2029)', PARAGRAPH_SEPARATOR],
  ['a bidi-override character (U+202E)', BIDI_OVERRIDE],
  ['a bidi-isolate character (U+2066)', BIDI_ISOLATE],
  ['a soft hyphen (U+00AD)', SOFT_HYPHEN],
  ['an Arabic Letter Mark (U+061C)', ARABIC_LETTER_MARK],
  ['a zero-width space (U+200B)', ZERO_WIDTH_SPACE],
  ['a left-to-right mark (U+200E)', LEFT_TO_RIGHT_MARK],
  ['a word joiner (U+2060)', WORD_JOINER],
  ['a byte-order mark (U+FEFF)', BYTE_ORDER_MARK],
  ['a Unicode tag character (U+E0001, astral)', TAG_CHARACTER],
];

// ── top-level BlueprintSchema fields ────────────────────────────────────────

for (const [label, value] of FORGERY_SAMPLES) {
  test(`name: REJECTS ${label}`, () => {
    assert.deepEqual(issuePaths(minimal({ name: value })), ['name']);
  });
}

test('version: REJECTS a raw newline', () => {
  assert.deepEqual(issuePaths(minimal({ version: `1.0.0${RAW_NEWLINE}` })), ['version']);
});

test('description: is deliberately UNWRAPPED — an embedded ANSI escape (or any forgery character) parses through unchanged', () => {
  // `description` is NOT safeDisplayString'd (see that function's own doc comment for why):
  // it is never rendered into any plan-preview line, and wrapping it broke a real blueprint
  // whose `description` is authored as a YAML folded (`>`) block scalar — the idiom every
  // multi-line prose field
  // naturally reaches for, and one that always leaves a trailing `\n` after parsing. This test
  // pins the EXCLUSION itself: if a future edit re-wraps this field, it fails here first,
  // before it fails silently against a real file the next time someone runs `blueprint validate`.
  const value = `desc${ANSI_ESCAPE}`;
  const bp = parseBlueprint(minimal({ description: value })) as Blueprint;
  assert.equal(bp.description, value);
});

test('description: tolerates a trailing newline — the exact shape a YAML folded/literal block scalar always produces', () => {
  const value = `Multi-line prose, the way an author actually writes it.${RAW_NEWLINE}`;
  const bp = parseBlueprint(minimal({ description: value })) as Blueprint;
  assert.equal(bp.description, value);
});

// ── servicePrincipal ─────────────────────────────────────────────────────────

test('servicePrincipal.externalId: REJECTS a bidi-override character', () => {
  assert.deepEqual(
    issuePaths(minimal({ servicePrincipal: { externalId: `sp${BIDI_OVERRIDE}`, displayName: 'Demo SP' } })),
    ['servicePrincipal.externalId'],
  );
});

test('servicePrincipal.displayName: REJECTS a raw newline (the plan-preview forgery motivating case)', () => {
  assert.deepEqual(
    issuePaths(minimal({ servicePrincipal: { externalId: 'demo-sp', displayName: `Demo${RAW_NEWLINE}SP` } })),
    ['servicePrincipal.displayName'],
  );
});

// ── issuers: issuer / jwksUri / userinfoUri / capturedClaims ────────────────

const VALID_ISSUER = {
  issuerId: 'auth0-prod',
  issuer: 'https://your-tenant.us.auth0.com/',
  jwksUri: 'https://your-tenant.us.auth0.com/.well-known/jwks.json',
  audience: 'https://api.your-app.example.com',
  contextId: 'mcp',
};

test('issuers[].issuer: REJECTS a raw newline — the trust-anchor field this preview must never show a forged line for', () => {
  assert.deepEqual(
    issuePaths(minimal({ issuers: [{ ...VALID_ISSUER, issuer: `${VALID_ISSUER.issuer}${RAW_NEWLINE}` }] })),
    ['issuers[0].issuer'],
  );
});

test('issuers[].jwksUri: REJECTS an ANSI escape', () => {
  assert.deepEqual(
    issuePaths(minimal({ issuers: [{ ...VALID_ISSUER, jwksUri: `${VALID_ISSUER.jwksUri}${ANSI_ESCAPE}` }] })),
    ['issuers[0].jwksUri'],
  );
});

test('issuers[].userinfoUri: REJECTS a bidi-override character', () => {
  assert.deepEqual(
    issuePaths(
      minimal({
        issuers: [{ ...VALID_ISSUER, userinfoUri: `https://your-tenant.us.auth0.com/userinfo${BIDI_OVERRIDE}` }],
      }),
    ),
    ['issuers[0].userinfoUri'],
  );
});

test('issuers[].issuer: REJECTS a Cyrillic homoglyph host — the class no character blocklist can reach', () => {
  // 'а' here is Cyrillic U+0430, not Latin 'a' (U+0061) — visually identical, a different byte.
  // safeUrlString's printable-ASCII-only check rejects it outright; a blocklist approach
  // (safeDisplayString) would NOT catch this, since an ordinary-looking letter from a different
  // script isn't a "forgery character" by any enumerable definition.
  const homoglyphHost = `https://${String.fromCodePoint(0x0430)}pple-idp.example/`;
  assert.deepEqual(
    issuePaths(minimal({ issuers: [{ ...VALID_ISSUER, issuer: homoglyphHost }] })),
    ['issuers[0].issuer'],
  );
});

test('issuers[].jwksUri: ACCEPTS an already-punycode internationalized domain', () => {
  const bp = parseBlueprint(
    minimal({ issuers: [{ ...VALID_ISSUER, jwksUri: 'https://xn--80ak6aa92e.com/.well-known/jwks.json' }] }),
  ) as Blueprint;
  assert.equal(bp.issuers?.[0].jwksUri, 'https://xn--80ak6aa92e.com/.well-known/jwks.json');
});

test('issuers[].userinfoUri: REJECTS a value that is not a URL at all (no forgery character present)', () => {
  assert.deepEqual(
    issuePaths(minimal({ issuers: [{ ...VALID_ISSUER, userinfoUri: 'not-a-url' }] })),
    ['issuers[0].userinfoUri'],
  );
});

test('issuers[].issuer: REJECTS a non-http(s) scheme', () => {
  assert.deepEqual(
    issuePaths(minimal({ issuers: [{ ...VALID_ISSUER, issuer: 'ftp://good.example/' }] })),
    ['issuers[0].issuer'],
  );
});

// ── safeUrlString's authority grammar: the full enumeration, not a sample ──────
//
// The two real bypasses a first version of this check missed (userinfo phishing, a
// percent-encoded homoglyph host) both worked by exploiting `new URL()`'s own parsing
// behavior (userinfo splitting, percent-decode-then-IDNA-normalize). The fix replaced
// parsing entirely with a grammar on the raw authority substring, so this enumeration
// exists to pin every case that grammar decision was actually reasoned through for —
// not just the two bypasses that were found, but the residuals the grammar deliberately
// accepts or rejects as a side effect.

test('issuers[].jwksUri: REJECTS userinfo-in-authority — B2, canonical URL phishing', () => {
  assert.deepEqual(
    issuePaths(
      minimal({
        issuers: [{ ...VALID_ISSUER, jwksUri: 'https://jwks.trusted-idp.example@evil.example/keys' }],
      }),
    ),
    ['issuers[0].jwksUri'],
  );
});

test('issuers[].jwksUri: REJECTS a percent-encoded homoglyph host — B1, the encoding new URL() would silently decode', () => {
  assert.deepEqual(
    issuePaths(minimal({ issuers: [{ ...VALID_ISSUER, jwksUri: 'https://%D0%B0pple-idp.example/' }] })),
    ['issuers[0].jwksUri'],
  );
});

test('issuers[].jwksUri: REJECTS a backslash-authority variant', () => {
  assert.deepEqual(
    issuePaths(minimal({ issuers: [{ ...VALID_ISSUER, jwksUri: 'https:/\\evil.example/keys' }] })),
    ['issuers[0].jwksUri'],
  );
});

test('issuers[].jwksUri: ACCEPTS a bare IPv4 literal — a named residual, not a gap', () => {
  const bp = parseBlueprint(
    minimal({ issuers: [{ ...VALID_ISSUER, jwksUri: 'https://192.0.2.1/jwks.json' }] }),
  ) as Blueprint;
  assert.equal(bp.issuers?.[0].jwksUri, 'https://192.0.2.1/jwks.json');
});

test('issuers[].jwksUri: REJECTS a bracketed IPv6 literal — a named, accepted false-reject', () => {
  assert.deepEqual(
    issuePaths(minimal({ issuers: [{ ...VALID_ISSUER, jwksUri: 'https://[::1]/jwks.json' }] })),
    ['issuers[0].jwksUri'],
  );
});

test('issuers[].jwksUri: ACCEPTS localhost', () => {
  const bp = parseBlueprint(
    minimal({ issuers: [{ ...VALID_ISSUER, jwksUri: 'https://localhost/jwks.json' }] }),
  ) as Blueprint;
  assert.equal(bp.issuers?.[0].jwksUri, 'https://localhost/jwks.json');
});

test('issuers[].jwksUri: ACCEPTS a trailing-dot host — a named, cosmetic residual', () => {
  const bp = parseBlueprint(
    minimal({ issuers: [{ ...VALID_ISSUER, jwksUri: 'https://good.example./jwks.json' }] }),
  ) as Blueprint;
  assert.equal(bp.issuers?.[0].jwksUri, 'https://good.example./jwks.json');
});

test('issuers[].jwksUri: ACCEPTS an uppercase host', () => {
  const bp = parseBlueprint(
    minimal({ issuers: [{ ...VALID_ISSUER, jwksUri: 'https://GOOD.EXAMPLE/jwks.json' }] }),
  ) as Blueprint;
  assert.equal(bp.issuers?.[0].jwksUri, 'https://GOOD.EXAMPLE/jwks.json');
});

test('issuers[].jwksUri: REJECTS http:// — the platform hard-refuses a non-https issuer/jwksUri/userinfoUri at registration, so this stays a tested decision, not an implicit one', () => {
  assert.deepEqual(
    issuePaths(minimal({ issuers: [{ ...VALID_ISSUER, jwksUri: 'http://good.example/jwks.json' }] })),
    ['issuers[0].jwksUri'],
  );
});

test('issuers[].capturedClaims: REJECTS a raw newline in an entry', () => {
  assert.deepEqual(
    issuePaths(minimal({ issuers: [{ ...VALID_ISSUER, capturedClaims: [`name${RAW_NEWLINE}`] }] })),
    ['issuers[0].capturedClaims[0]'],
  );
});

// ── accessProfile.allowedActions ─────────────────────────────────────────────

test('accessProfile.allowedActions: REJECTS a raw newline in an entry', () => {
  assert.deepEqual(
    issuePaths(minimal({ accessProfile: { allowedActions: [`records:r${RAW_NEWLINE}`] } })),
    ['accessProfile.allowedActions[0]'],
  );
});

// ── roles (BlueprintRoleClauseSchema): allowedActions + dataScope ───────────

test('roles[].allowedActions: REJECTS a NUL byte in an entry', () => {
  assert.deepEqual(
    issuePaths(
      minimal({
        roles: { editor: [{ allowedActions: [`records:r${NUL_BYTE}`] }] },
      }),
    ),
    ['roles.editor[0].allowedActions[0]'],
  );
});

test('roles[].dataScope: REJECTS a line-separator character in a dataScope value', () => {
  assert.deepEqual(
    issuePaths(
      minimal({
        roles: {
          editor: [{ allowedActions: ['records:r'], dataScope: { 'scope:org': [`org_a${LINE_SEPARATOR}`] } }],
        },
      }),
    ),
    ['roles.editor[0].dataScope.scope:org[0]'],
  );
});

test('roles[].dataScope: a null sentinel entry is untouched — the guard only checks strings', () => {
  const bp = parseBlueprint(
    minimal({
      roles: { editor: [{ allowedActions: ['records:r'], dataScope: { 'scope:org': [null] } }] },
    }),
  ) as Blueprint;
  assert.deepEqual(bp.roles?.editor[0].dataScope, { 'scope:org': [null] });
});

// ── fragments (dataScope-shaped reuse map) ───────────────────────────────────

test('fragments: REJECTS a paragraph-separator character in a fragment value', () => {
  assert.deepEqual(
    issuePaths(
      minimal({
        fragments: { ownOrg: { 'scope:org': [`org_a${PARAGRAPH_SEPARATOR}`] } },
        roles: { editor: [{ allowedActions: ['records:r'], dataScopeRef: 'ownOrg' }] },
      } as Partial<Blueprint>),
    ),
    ['fragments.ownOrg.scope:org[0]'],
  );
});

// ── roleAssumable ─────────────────────────────────────────────────────────

test('roleAssumable: REJECTS a bidi-isolate character in a grant value', () => {
  // `roleAssumable` values ALSO run through the pre-existing narrower `SCOPE_VALUE_RE` grammar
  // (`assumableValueError`), which independently rejects anything outside its own charset — so a
  // forgery character here fails BOTH checks and lands two issues at the same path. Assert
  // presence, not an exact single-element array, matching this file's own established idiom for
  // roleAssumable (see fragments-and-assumable.test.ts's `.some()` checks).
  const paths = issuePaths(
    minimal({
      roles: { hr_admin: [{ allowedActions: ['records:r'] }] },
      roleAssumable: { hr_admin: { 'scope:org': [`org_a${BIDI_ISOLATE}`] } },
    } as Partial<Blueprint>),
  );
  assert.ok(
    paths.some((p) => p === 'roleAssumable.hr_admin.scope:org[0]'),
    `expected a roleAssumable.hr_admin.scope:org[0] issue, got ${JSON.stringify(paths)}`,
  );
});

// ── schemas[].fields[].fieldId ────────────────────────────────────────────

test('schemas[].fields[].fieldId: REJECTS an ANSI escape — reachable via the plan preview\'s sensitive-fields/lookup notes', () => {
  assert.deepEqual(
    issuePaths(
      minimal({
        schemas: [
          { typeName: 'task', displayName: 'Task', fields: [{ fieldId: `owner${ANSI_ESCAPE}`, fieldType: 'string' }] },
        ],
      }),
    ),
    ['schemas[0].fields[0].fieldId'],
  );
});

// ── schemas[].typeName ───────────────────────────────────────────────────────

test('schemas[].typeName: REJECTS a raw newline — rendered raw into the plan preview\'s schema-step summary line', () => {
  assert.deepEqual(
    issuePaths(
      minimal({
        schemas: [{ typeName: `task${RAW_NEWLINE}`, displayName: 'Task', fields: [] }],
      }),
    ),
    ['schemas[0].typeName'],
  );
});

// ── seed[].typeName ──────────────────────────────────────────────────────────

test('seed[].typeName: REJECTS a bidi-override character — not currently rendered, but the same field concept as schemas[].typeName', () => {
  assert.deepEqual(
    issuePaths(
      minimal({
        schemas: [{ typeName: 'task', displayName: 'Task', fields: [] }],
        seed: [{ surface: 'record', typeName: `task${BIDI_OVERRIDE}`, externalId: 's1', fields: {} }],
      } as Partial<Blueprint>),
    ),
    ['seed[0].typeName'],
  );
});

// ── triggers: allowedActions / dataScope / fields ───────────────────────────

// `triggers` is a Record<string, TriggerEntry> keyed by trigger name (like `roles`), not an
// array — mirrors tests/triggers.test.ts's own `minimal()` + fixture shape.
function withTrigger(triggerOverrides: Record<string, unknown>): unknown {
  return minimal({
    schemas: [{ typeName: 'intake', displayName: 'Intake', fields: [], capabilities: { triggersEnabled: true } }],
    triggers: {
      'on-intake-create': {
        firingSource: { schemaName: 'intake', event: 'CREATE' },
        scriptRef: { name: 'notify-assignee', version: '3' },
        fields: [],
        ...triggerOverrides,
      },
    },
  } as Partial<Blueprint>);
}

test('triggers[].allowedActions: REJECTS a raw newline in an inline-grant entry', () => {
  assert.deepEqual(
    issuePaths(withTrigger({ allowedActions: [`records:r${RAW_NEWLINE}`] })),
    ['triggers.on-intake-create.allowedActions[0]'],
  );
});

test('triggers[].dataScope: REJECTS a C1 control character in a dataScope value', () => {
  assert.deepEqual(
    issuePaths(
      withTrigger({
        allowedActions: ['records:r'],
        dataScope: { 'scope:org': [`org_a${C1_CONTROL}`] },
      }),
    ),
    ['triggers.on-intake-create.dataScope.scope:org[0]'],
  );
});

test('triggers[].fields: REJECTS a raw newline in a projected field name — the forgery target this fix was built for', () => {
  // `fields` entries ALSO run through `lintTriggerFields` (every projected field must name a
  // field the schema keeps inline), which independently flags 'owner<newline>' as undeclared —
  // so, like roleAssumable above, this lands two issues at the same path. Assert presence.
  const paths = issuePaths(
    minimal({
      schemas: [{ typeName: 'intake', displayName: 'Intake', fields: [], capabilities: { triggersEnabled: true } }],
      roles: { 'case-worker': [{ allowedActions: ['records:u'] }] },
      triggers: {
        'on-intake-create': {
          firingSource: { schemaName: 'intake', event: 'CREATE' },
          scriptRef: { name: 'notify-assignee', version: '3' },
          roleIds: ['case-worker'],
          fields: [`owner${RAW_NEWLINE}`],
        },
      },
    } as Partial<Blueprint>),
  );
  assert.ok(
    paths.some((p) => p === 'triggers.on-intake-create.fields[0]'),
    `expected a triggers.on-intake-create.fields[0] issue, got ${JSON.stringify(paths)}`,
  );
});

// ── contextName ──────────────────────────────────────────────────────────────

test('contextName: REJECTS a raw newline — rendered as the FIRST line of every plan summary', () => {
  assert.deepEqual(
    issuePaths(minimal({ contextName: `My App${RAW_NEWLINE}` })),
    ['contextName'],
  );
});

// ── companyName ──────────────────────────────────────────────────────────────

test('companyName: REJECTS a bidi-isolate character — not a CLI plan-preview sink, but forwarded to the platform for invite-email correspondence', () => {
  assert.deepEqual(
    issuePaths(minimal({ companyName: `Acme${BIDI_ISOLATE}` })),
    ['companyName'],
  );
});

// ── identityProjectionClaims ─────────────────────────────────────────────────

test('identityProjectionClaims: REJECTS an ANSI escape in an entry — capturedClaims\' structural pair, rendered on the same context-step line', () => {
  assert.deepEqual(
    issuePaths(minimal({ identityProjectionClaims: [`name${ANSI_ESCAPE}`] })),
    ['identityProjectionClaims[0]'],
  );
});

// ── schemas[].lookupFields ───────────────────────────────────────────────────

test('schemas[].lookupFields: REJECTS a raw newline in the bare-string form', () => {
  assert.deepEqual(
    issuePaths(
      minimal({
        schemas: [{ typeName: 'task', displayName: 'Task', fields: [], lookupFields: [`owner${RAW_NEWLINE}`] }],
      }),
    ),
    ['schemas[0].lookupFields[0]'],
  );
});

test('schemas[].lookupFields: REJECTS a bidi-override character in the fieldName object form', () => {
  assert.deepEqual(
    issuePaths(
      minimal({
        schemas: [
          {
            typeName: 'task',
            displayName: 'Task',
            fields: [],
            lookupFields: [{ fieldName: `owner${BIDI_OVERRIDE}` }],
          },
        ],
      }),
    ),
    ['schemas[0].lookupFields[0].fieldName'],
  );
});

test('schemas[].lookupFields: REJECTS a NUL byte in a composite fieldNames entry', () => {
  assert.deepEqual(
    issuePaths(
      minimal({
        schemas: [
          {
            typeName: 'task',
            displayName: 'Task',
            fields: [],
            allowedSurfaces: ['record'],
            lookupFields: [{ fieldNames: [`a${NUL_BYTE}`, 'b'] }],
          },
        ],
      }),
    ),
    ['schemas[0].lookupFields[0].fieldNames[0]'],
  );
});

// ── triggers[].scriptRef.name ────────────────────────────────────────────────

test('triggers[].scriptRef.name: REJECTS a raw newline — unrestricted when naming a script this blueprint does not ship', () => {
  assert.deepEqual(
    issuePaths(
      withTrigger({ allowedActions: ['records:r'], scriptRef: { name: `notify${RAW_NEWLINE}`, version: '3' } }),
    ),
    ['triggers.on-intake-create.scriptRef.name'],
  );
});

// ── accessProfile.dataScope ──────────────────────────────────────────────────

test('accessProfile.dataScope: REJECTS a bidi-isolate character in a value (consistency fix — not currently rendered by value, but closes the sibling gap)', () => {
  assert.deepEqual(
    issuePaths(minimal({ accessProfile: { allowedActions: ['records:r'], dataScope: { 'scope:org': [`org_a${BIDI_ISOLATE}`] } } })),
    ['accessProfile.dataScope.scope:org[0]'],
  );
});

// ── roles / triggers: the MAP KEY itself (roleId / triggerName) ─────────────

test('roles: REJECTS a raw newline in the roleId KEY, not just a clause value — rendered raw in the role plan step', () => {
  assert.deepEqual(
    issuePaths(minimal({ roles: { [`editor${RAW_NEWLINE}`]: [{ allowedActions: ['records:r'] }] } })),
    [`roles.editor${RAW_NEWLINE}`],
  );
});

test('triggers: REJECTS an ANSI escape in the triggerName KEY — rendered raw AND folded into a synthesized principal name sent to the platform', () => {
  assert.deepEqual(
    issuePaths(
      minimal({
        schemas: [{ typeName: 'intake', displayName: 'Intake', fields: [], capabilities: { triggersEnabled: true } }],
        triggers: {
          [`on-intake${ANSI_ESCAPE}`]: {
            firingSource: { schemaName: 'intake', event: 'CREATE' },
            scriptRef: { name: 'notify-assignee', version: '3' },
            fields: [],
            allowedActions: ['records:r'],
          },
        },
      } as Partial<Blueprint>),
    ),
    [`triggers.on-intake${ANSI_ESCAPE}`],
  );
});

// ── identities[].externalId / .displayName ──────────────────────────────────

test('identities[].externalId: REJECTS a raw newline — printed raw immediately before the "Apply this plan?" confirmation gate in @vectros-ai/cli', () => {
  assert.deepEqual(
    issuePaths(minimal({ identities: { owner: { kind: 'user', externalId: `u-1${RAW_NEWLINE}` } } })),
    ['identities.owner.externalId'],
  );
});

test('identities[].displayName: REJECTS a bidi-override character (defense-in-depth — not currently rendered in a preview, but reaches a platform API payload)', () => {
  assert.deepEqual(
    issuePaths(minimal({ identities: { owner: { kind: 'user', externalId: 'u-1', displayName: `Owner${BIDI_OVERRIDE}` } } })),
    ['identities.owner.displayName'],
  );
});

// ── clean input is unaffected ────────────────────────────────────────────────

test('a blueprint using only ordinary printable text (incl. non-ASCII letters and punctuation) parses unchanged', () => {
  // Note: a plain space is fine, but a TAB is NOT — \t (0x09) is a C0 control and falls inside
  // FORGERY_CHARS_RE's \x00-\x1f band by design (its own doc comment names \t explicitly), since
  // it can misalign a rendered preview line just as a newline can forge one.
  const description = 'Handles intake for Bob\'s team — "quoted", 100% normal. Ordinary punctuation is fine.';
  const bp = parseBlueprint(
    minimal({
      name: 'demo-café',
      description,
      servicePrincipal: { externalId: 'demo-sp', displayName: 'Démo SP (日本語 OK)' },
    }),
  ) as Blueprint;
  assert.equal(bp.name, 'demo-café');
  assert.equal(bp.description, description);
  assert.equal(bp.servicePrincipal.displayName, 'Démo SP (日本語 OK)');
});

test('a bare TAB (\\t, 0x09) is REJECTED on a wrapped field — the non-obvious inclusion the FORGERY_CHARS_RE doc comment calls out by name, pinned so a future "allow legitimate tabs" edit cannot silently narrow the C0 range', () => {
  // Uses contextName, not description — description is deliberately unwrapped (see the tests
  // above and safeDisplayString's own doc comment) precisely because a real value legitimately
  // needs to carry one of these C0 characters (a trailing \n from a YAML block scalar). A tab
  // has no equivalent legitimate-authoring collision on a short scalar-identifier field like
  // contextName, so it stays a clean pin there.
  assert.deepEqual(issuePaths(minimal({ contextName: 'a\tb' })), ['contextName']);
});
