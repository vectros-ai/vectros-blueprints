/**
 * Variable-substitution resolver tests (blueprint-variable-substitution slice).
 *
 * Pure FORMAT-half coverage: declaration validation, value precedence/coercion,
 * `${{ inputs.x }}` + `${{ vectros.* }}` resolution, whole-token type coercion,
 * the `$self`/`$`-sentinel pass-through, escaping, and teach-by-error issues.
 * The CLI wiring (--set/--values, file IO) is covered in @vectros-ai/cli.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveBlueprintInputs,
  BlueprintInputError,
  deriveSuffix,
} from '../src/inputs.js';

/** A minimal blueprint-shaped tree with an inputs block + token usages. */
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

function resolved(raw: Record<string, unknown>, supplied: Record<string, unknown> = {}) {
  return resolveBlueprintInputs(raw, supplied) as Record<string, any>;
}

// ── pass-through / back-compat ───────────────────────────────────────────────

test('no inputs block + no tokens → strips nothing, returns an equivalent tree', () => {
  const r = resolved(doc());
  assert.equal(r.name, 'demo');
  assert.equal(r.inputs, undefined);
  assert.deepEqual(r.accessProfile.allowedActions, ['records:r']);
});

test('inputs block is stripped from the output (downstream never sees it)', () => {
  const r = resolved(doc({ inputs: { x: { type: 'string', default: 'v' } } }));
  assert.equal('inputs' in r, false);
});

test('non-object input passes through untouched (parseBlueprint handles the shape)', () => {
  assert.equal(resolveBlueprintInputs('nope'), 'nope');
  assert.equal(resolveBlueprintInputs(null), null);
  assert.deepEqual(resolveBlueprintInputs([1, 2]), [1, 2]);
});

// ── inputs.* resolution + precedence ─────────────────────────────────────────

test('resolves ${{ inputs.x }} from a default', () => {
  const r = resolved(
    doc({
      inputs: { companyName: { type: 'string', default: 'Acme' } },
      description: 'For ${{ inputs.companyName }}',
    }),
  );
  assert.equal(r.description, 'For Acme');
});

test('--set/supplied overrides the default', () => {
  const r = resolved(
    doc({
      inputs: { companyName: { type: 'string', default: 'Acme' } },
      description: 'For ${{ inputs.companyName }}',
    }),
    { companyName: 'Globex' },
  );
  assert.equal(r.description, 'For Globex');
});

test('embedded token interpolates to a string; multiple tokens in one value', () => {
  const r = resolved(
    doc({
      inputs: {
        a: { type: 'string', default: 'X' },
        b: { type: 'string', default: 'Y' },
      },
      description: '${{ inputs.a }}-${{ inputs.b }}!',
    }),
  );
  assert.equal(r.description, 'X-Y!');
});

// ── whole-token type coercion ────────────────────────────────────────────────

test('whole-token boolean input coerces to a real boolean', () => {
  const r = resolved(
    doc({
      inputs: { flag: { type: 'boolean', default: true } },
      schemas: [{ typeName: 't', displayName: 'T', active: '${{ inputs.flag }}' }],
    }),
  );
  assert.strictEqual(r.schemas[0].active, true);
});

test('whole-token number input coerces to a real number (from --set string)', () => {
  const r = resolved(
    doc({
      inputs: { n: { type: 'number' } },
      schemas: [{ typeName: 't', displayName: 'T', order: '${{ inputs.n }}' }],
    }),
    { n: '42' },
  );
  assert.strictEqual(r.schemas[0].order, 42);
});

test('a token EMBEDDED in a larger string always renders to a string (no coercion)', () => {
  const r = resolved(
    doc({
      inputs: { n: { type: 'number', default: 7 } },
      description: 'count=${{ inputs.n }}',
    }),
  );
  assert.strictEqual(r.description, 'count=7');
});

// ── vectros.* built-ins ──────────────────────────────────────────────────────

test('vectros.context resolves to the literal contextId', () => {
  const r = resolved(doc({ contextId: 'sales', description: 'ctx ${{ vectros.context }}' }));
  assert.equal(r.description, 'ctx sales');
});

test('vectros.suffix is stable per contextId + namespaces a service-principal externalId', () => {
  const suffix = deriveSuffix('sales');
  const r = resolved(
    doc({
      contextId: 'sales',
      servicePrincipal: { externalId: 'demo-sp-${{ vectros.suffix }}', displayName: 'Demo' },
    }),
  );
  assert.equal(r.servicePrincipal.externalId, `demo-sp-${suffix}`);
  // Deterministic: same context ⇒ same suffix (idempotent re-installs).
  assert.equal(deriveSuffix('sales'), suffix);
  assert.notEqual(deriveSuffix('sales'), deriveSuffix('support'));
});

// ── $self / $-sentinel pass-through ──────────────────────────────────────────

test('$self and $-prefixed sentinels pass through UNTOUCHED', () => {
  const r = resolved(
    doc({
      inputs: { who: { type: 'string', default: 'team' } },
      accessProfile: { allowedActions: ['records:r'], dataScope: { userId: ['$self'] } },
      description: '$self stays, ${{ inputs.who }} resolves',
    }),
  );
  assert.deepEqual(r.accessProfile.dataScope.userId, ['$self']);
  assert.equal(r.description, '$self stays, team resolves');
});

// ── escaping ─────────────────────────────────────────────────────────────────

test('$${{ … }} escapes to a literal ${{ … }}', () => {
  const r = resolved(doc({ description: 'literal $${{ inputs.x }} here' }));
  assert.equal(r.description, 'literal ${{ inputs.x }} here');
});

// ── error cases (teach-by-error) ─────────────────────────────────────────────

function issuesOf(fn: () => unknown): string[] {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof BlueprintInputError, 'expected BlueprintInputError');
    return err.issues.map((i) => `${i.path}: ${i.message}`);
  }
  throw new Error('expected a throw');
}

test('unknown input reference → error', () => {
  const msgs = issuesOf(() => resolved(doc({ description: '${{ inputs.nope }}' })));
  assert.ok(msgs.some((m) => /unknown input 'inputs.nope'/.test(m)), msgs.join('\n'));
});

test('unknown namespace → error', () => {
  const msgs = issuesOf(() => resolved(doc({ description: '${{ env.HOME }}' })));
  assert.ok(msgs.some((m) => /unknown namespace 'env'/.test(m)), msgs.join('\n'));
});

test('unknown built-in → error', () => {
  const msgs = issuesOf(() => resolved(doc({ description: '${{ vectros.tenant }}' })));
  assert.ok(msgs.some((m) => /unknown built-in 'vectros.tenant'/.test(m)), msgs.join('\n'));
});

test('malformed token (no dot) → error', () => {
  const msgs = issuesOf(() => resolved(doc({ description: '${{ inputs }}' })));
  assert.ok(msgs.some((m) => /malformed reference/.test(m)), msgs.join('\n'));
});

test('required input not supplied → error', () => {
  const msgs = issuesOf(() =>
    resolved(doc({ inputs: { req: { type: 'string', required: true } }, description: '${{ inputs.req }}' })),
  );
  assert.ok(msgs.some((m) => /required input 'req' was not supplied/.test(m)), msgs.join('\n'));
});

test('declared-but-unsupplied optional with no default, referenced → error', () => {
  const msgs = issuesOf(() =>
    resolved(doc({ inputs: { opt: { type: 'string' } }, description: '${{ inputs.opt }}' })),
  );
  assert.ok(msgs.some((m) => /has no value/.test(m)), msgs.join('\n'));
});

test('supplying an undeclared value → error', () => {
  const msgs = issuesOf(() => resolved(doc({ inputs: { a: { type: 'string', default: 'x' } } }), { b: 'y' }));
  assert.ok(msgs.some((m) => /no input named 'b' is declared/.test(m)), msgs.join('\n'));
});

test('non-numeric value for a number input → coercion error', () => {
  const msgs = issuesOf(() =>
    resolved(doc({ inputs: { n: { type: 'number' } }, description: '${{ inputs.n }}' }), { n: 'abc' }),
  );
  assert.ok(msgs.some((m) => /expected a number/.test(m)), msgs.join('\n'));
});

test('default type mismatch → declaration error', () => {
  const msgs = issuesOf(() =>
    resolved(doc({ inputs: { n: { type: 'number', default: 'oops' } } })),
  );
  assert.ok(msgs.some((m) => /default is a string but the declared type is 'number'/.test(m)), msgs.join('\n'));
});

test('unknown key in an input declaration → strict error', () => {
  const msgs = issuesOf(() => resolved(doc({ inputs: { x: { type: 'string', frob: 1 } } })));
  assert.ok(msgs.length > 0, 'expected a strict declaration error');
});

test('contextId using a token → error (it is the source of built-ins)', () => {
  const msgs = issuesOf(() =>
    resolved(doc({ contextId: '${{ inputs.c }}', inputs: { c: { type: 'string', default: 'x' } } })),
  );
  assert.ok(msgs.some((m) => /contextId must be a literal/.test(m)), msgs.join('\n'));
});

test('unterminated ${{ (no closing }}) → error, never silently dropped', () => {
  const msgs = issuesOf(() => resolved(doc({ description: 'oops ${{ inputs.x' })));
  assert.ok(msgs.some((m) => /unterminated token/.test(m)), msgs.join('\n'));
});

test('vectros.* unavailable when contextId is absent → error', () => {
  const raw = doc({ description: '${{ vectros.suffix }}' });
  delete (raw as Record<string, unknown>).contextId;
  const msgs = issuesOf(() => resolveBlueprintInputs(raw));
  assert.ok(msgs.some((m) => /is unavailable: contextId must be a literal/.test(m)), msgs.join('\n'));
});

test('inputs declared as a non-object → declaration error', () => {
  const msgs = issuesOf(() => resolved(doc({ inputs: 'not-an-object' })));
  assert.ok(msgs.length > 0, 'expected a declaration error');
});

// ── nesting / structural coverage ────────────────────────────────────────────

test('substitutes tokens deep in nested objects + arrays (schemas, seed records)', () => {
  const r = resolved(
    doc({
      contextId: 'crm',
      inputs: {
        label: { type: 'string', default: 'Title' },
        company: { type: 'string', default: 'Acme' },
        order: { type: 'number', default: 3 },
      },
      schemas: [
        {
          typeName: 'thing',
          displayName: 'Thing',
          fields: [
            { fieldId: 'title', fieldType: 'string', renderHints: { label: '${{ inputs.label }}', order: '${{ inputs.order }}' } },
          ],
        },
      ],
      seed: [
        { typeName: 'thing', externalId: 'a', fields: { title: 'Welcome to ${{ inputs.company }}' } },
        { typeName: 'thing', externalId: 'b', fields: { tags: ['${{ inputs.company }}', 'static'] } },
      ],
    }),
  );
  assert.equal(r.schemas[0].fields[0].renderHints.label, 'Title');
  assert.strictEqual(r.schemas[0].fields[0].renderHints.order, 3); // whole-token number coercion deep in the tree
  assert.equal(r.seed[0].fields.title, 'Welcome to Acme');
  assert.deepEqual(r.seed[1].fields.tags, ['Acme', 'static']);
});

test('object KEYS are NOT substituted — only values', () => {
  const r = resolved(
    doc({
      inputs: { k: { type: 'string', default: 'resolved' } },
      seed: [{ typeName: 't', externalId: 'a', fields: { '${{ inputs.k }}': 'v' } }],
    }),
  );
  // The key stays literal; only the value would resolve.
  assert.deepEqual(Object.keys(r.seed[0].fields), ['${{ inputs.k }}']);
});

test('error path points at the deep location of the bad token', () => {
  const msgs = issuesOf(() =>
    resolved(
      doc({
        schemas: [{ typeName: 't', displayName: 'T', fields: [{ fieldId: 'x', fieldType: 'string', description: '${{ inputs.ghost }}' }] }],
      }),
    ),
  );
  assert.ok(
    msgs.some((m) => /^schemas\[0\]\.fields\[0\]\.description:/.test(m)),
    msgs.join('\n'),
  );
});

// ── falsy + edge values (must survive coercion correctly) ────────────────────

test('whole-token falsy values survive: false, 0, empty string', () => {
  const r = resolved(
    doc({
      inputs: {
        b: { type: 'boolean', default: false },
        n: { type: 'number', default: 0 },
        s: { type: 'string', default: '' },
      },
      schemas: [{ typeName: 't', displayName: 'T', active: '${{ inputs.b }}', order: '${{ inputs.n }}', note: '${{ inputs.s }}' }],
    }),
  );
  assert.strictEqual(r.schemas[0].active, false);
  assert.strictEqual(r.schemas[0].order, 0);
  assert.strictEqual(r.schemas[0].note, '');
});

test('whitespace around an otherwise-whole token → treated as embedded (string)', () => {
  const r = resolved(doc({ inputs: { n: { type: 'number', default: 5 } }, description: '  ${{ inputs.n }}  ' }));
  assert.strictEqual(r.description, '  5  '); // string, not the number 5
});

test('no-space token form ${{inputs.x}} resolves', () => {
  const r = resolved(doc({ inputs: { x: { type: 'string', default: 'ok' } }, description: '${{inputs.x}}' }));
  assert.equal(r.description, 'ok');
});

test('number coercion: negative, float, and whitespace-trimmed integers', () => {
  for (const [input, expected] of [['-5', -5], ['3.14', 3.14], [' 42 ', 42]] as const) {
    const r = resolved(doc({ inputs: { n: { type: 'number' } }, schemas: [{ typeName: 't', displayName: 'T', order: '${{ inputs.n }}' }] }), { n: input });
    assert.strictEqual(r.schemas[0].order, expected, `${input}`);
  }
});

test('boolean coercion is case-insensitive (TRUE/False)', () => {
  for (const [input, expected] of [['TRUE', true], ['False', false], [' true ', true]] as const) {
    const r = resolved(doc({ inputs: { b: { type: 'boolean' } }, schemas: [{ typeName: 't', displayName: 'T', active: '${{ inputs.b }}' }] }), { b: input });
    assert.strictEqual(r.schemas[0].active, expected, `${input}`);
  }
});

test('string input accepts a typed (number/boolean) supplied value, coerced to string', () => {
  const r = resolved(doc({ inputs: { s: { type: 'string' } }, description: 'v=${{ inputs.s }}' }), { s: 5 });
  assert.equal(r.description, 'v=5');
});

test('null / object supplied for a scalar input → coercion error', () => {
  const msgsNull = issuesOf(() => resolved(doc({ inputs: { s: { type: 'string' } }, description: '${{ inputs.s }}' }), { s: null }));
  assert.ok(msgsNull.some((m) => /expected a string/.test(m)), msgsNull.join('\n'));
  const msgsObj = issuesOf(() => resolved(doc({ inputs: { n: { type: 'number' } }, description: '${{ inputs.n }}' }), { n: { a: 1 } }));
  assert.ok(msgsObj.some((m) => /expected a number/.test(m)), msgsObj.join('\n'));
});

// ── escaping + mixed ─────────────────────────────────────────────────────────

test('escape + real token in one string: $${{ … }} literal alongside a resolved token', () => {
  const r = resolved(
    doc({ inputs: { x: { type: 'string', default: 'V' } }, description: 'lit $${{ inputs.x }} and real ${{ inputs.x }}' }),
  );
  assert.equal(r.description, 'lit ${{ inputs.x }} and real V');
});

// ── aggregation + immutability (enterprise-grade guarantees) ─────────────────

test('ALL issues are aggregated into one throw (not fail-fast on the first)', () => {
  const msgs = issuesOf(() =>
    resolved(doc({ description: '${{ inputs.a }} ${{ env.b }} ${{ vectros.c }}' })),
  );
  assert.ok(msgs.some((m) => /unknown input 'inputs.a'/.test(m)), msgs.join('\n'));
  assert.ok(msgs.some((m) => /unknown namespace 'env'/.test(m)), msgs.join('\n'));
  assert.ok(msgs.some((m) => /unknown built-in 'vectros.c'/.test(m)), msgs.join('\n'));
  assert.ok(msgs.length >= 3, `expected ≥3 aggregated issues, got ${msgs.length}`);
});

test('resolveBlueprintInputs does NOT mutate the input tree', () => {
  const raw = doc({
    inputs: { x: { type: 'string', default: 'V' } },
    description: '${{ inputs.x }}',
    seed: [{ typeName: 't', externalId: 'a', fields: { title: '${{ inputs.x }}' } }],
  });
  const snapshot = JSON.parse(JSON.stringify(raw));
  resolveBlueprintInputs(raw);
  assert.deepEqual(raw, snapshot, 'input tree must be left untouched');
});

test('empty inputs block + no tokens → clean strip, no error', () => {
  const r = resolved(doc({ inputs: {} }));
  assert.equal('inputs' in r, false);
  assert.equal(r.name, 'demo');
});

test('BlueprintInputError carries structured issues (programmatic consumers)', () => {
  try {
    resolved(doc({ description: '${{ inputs.nope }}' }));
    assert.fail('expected throw');
  } catch (err) {
    assert.ok(err instanceof BlueprintInputError);
    assert.ok(Array.isArray(err.issues) && err.issues.length === 1);
    assert.equal(typeof err.issues[0].path, 'string');
    assert.equal(typeof err.issues[0].message, 'string');
    assert.match(err.message, /Blueprint variable resolution failed/);
  }
});

// ── deferred namespaces: ${{ self.* }} is left literal (runtime sentinel) ─────

test('self.*: a whole-value ${{ self.userId }} token is left literal (not resolved, not an error)', () => {
  const r = resolved(
    doc({ roles: { member: [{ allowedActions: ['records:r'], dataScope: { userId: ['${{ self.userId }}'] } }] } }),
  );
  assert.equal(r.roles.member[0].dataScope.userId[0], '${{ self.userId }}');
});

test('self.*: an embedded ${{ self.* }} token is re-emitted verbatim within the string', () => {
  const r = resolved(doc({ description: 'owner=${{ self.userId }} ok' }));
  assert.equal(r.description, 'owner=${{ self.userId }} ok');
});

test('self.* coexists with inputs: inputs resolve, self is preserved, inputs block stripped', () => {
  const r = resolved(
    doc({
      inputs: { team: { type: 'string', required: true } },
      description: 'team ${{ inputs.team }} owner ${{ self.userId }}',
    }),
    { team: 'Acme' },
  );
  assert.equal(r.description, 'team Acme owner ${{ self.userId }}');
  assert.equal(r.inputs, undefined);
});

test('a genuinely-unknown namespace still errors (deferral is allow-listed, not open)', () => {
  assert.throws(() => resolved(doc({ description: '${{ bogus.x }}' })), BlueprintInputError);
});
