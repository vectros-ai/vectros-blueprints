/**
 * Composition tests: a root blueprint plus `include:`d part files compose into one document,
 * with no overrides, root-only keys kept in the root, stacks covering every part exactly once,
 * and every location reported as file:line.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  composeBlueprint,
  readIncludeDirective,
  mergeStacks,
  parseIssuePath,
  BlueprintCompositionError,
  ROOT_STACK,
  type BlueprintSource,
} from '../src/compose.js';
import { BlueprintValidationError, parseBlueprint } from '../src/types.js';

function root(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'market',
    version: '1.0.0',
    description: 'A shop',
    contextId: 'market',
    accessProfile: { allowedActions: ['records:r'] },
    servicePrincipal: { externalId: 'market-loader', displayName: 'Market loader' },
    include: ['parts/*.part.yaml'],
    ...extra,
  };
}

/** A source whose locator reports the depth of the path it could follow, so tests can see which file and how deep. */
function src(path: string, document: unknown): BlueprintSource {
  return {
    path,
    document,
    lineOf: (p) => {
      let node: unknown = document;
      let depth = 0;
      for (const seg of p) {
        if (node === null || typeof node !== 'object') break;
        const next = (node as Record<string | number, unknown>)[seg as string];
        if (next === undefined) break;
        node = next;
        depth += 1;
      }
      return depth === 0 ? undefined : depth * 10;
    },
  };
}

const schema = (typeName: string) => ({ typeName, displayName: typeName, fields: [{ fieldId: 'title', fieldType: 'string' }] });
const role = () => [{ allowed_actions: ['records:r'] }];

function compose(rootDoc: Record<string, unknown>, parts: Array<[string, unknown]>, stacks?: Record<string, string[]>) {
  return composeBlueprint(src('market.blueprint.yaml', rootDoc), parts.map(([p, d]) => src(p, d)), stacks);
}

// ── the directive ────────────────────────────────────────────────────────────

test('a document with neither include nor stacks has no directive: the single-file path is untouched', () => {
  const doc = root();
  delete doc.include;
  assert.equal(readIncludeDirective(doc), undefined);
  assert.equal(readIncludeDirective('not an object'), undefined);
});

test('the directive reads include and stacks as given', () => {
  const d = readIncludeDirective(root({ stacks: { sales: ['parts/sales*.part.yaml'] } }));
  assert.deepEqual(d, { include: ['parts/*.part.yaml'], stacks: { sales: ['parts/sales*.part.yaml'] } });
});

test('the directive refuses malformed include and stacks', () => {
  const cases: Array<[Record<string, unknown>, RegExp]> = [
    [{ include: [] }, /non-empty list/],
    [{ include: 'parts/a.part.yaml' }, /non-empty list/],
    [{ include: [3] }, /non-empty list/],
    [{ stacks: { a: ['x'] }, include: undefined }, /non-empty list/],
    [{ stacks: {} }, /must map each stack name/],
    [{ stacks: { Sales: ['x'] } }, /not valid/],
    [{ stacks: { root: ['x'] } }, /reserved/],
    [{ stacks: { sales: [] } }, /at least one/],
  ];
  for (const [extra, re] of cases) {
    assert.throws(() => readIncludeDirective(root(extra)), (e: unknown) => e instanceof BlueprintCompositionError && re.test((e as Error).message));
  }
  // `stacks:` with no `include:` is a single-file blueprint: no directive, and the structural validation refuses the
  // unknown key exactly as it always did.
  const noInclude = root({ stacks: { a: ['x'] } });
  delete noInclude.include;
  assert.equal(readIncludeDirective(noInclude), undefined);
  assert.throws(() => parseBlueprint(noInclude), /Unrecognized key.*stacks/);
});

test('a composition error is a validation error, so every caller that reports one reports it', () => {
  assert.ok(new BlueprintCompositionError('x') instanceof BlueprintValidationError);
});

// ── merging ──────────────────────────────────────────────────────────────────

test('lists concatenate root first then parts in order, maps union, and include/stacks are removed', () => {
  const r = root({ schemas: [schema('vendor')], roles: { viewer: role() } });
  const c = compose(r, [
    ['parts/a.part.yaml', { schemas: [schema('listing')], roles: { donor: role() } }],
    ['parts/b.part.yaml', { schemas: [schema('order')], triggers: { notify: { x: 1 } } }],
  ]);
  assert.deepEqual((c.document.schemas as Array<{ typeName: string }>).map((s) => s.typeName), ['vendor', 'listing', 'order']);
  assert.deepEqual(Object.keys(c.document.roles as object), ['viewer', 'donor']);
  assert.deepEqual(Object.keys(c.document.triggers as object), ['notify']);
  assert.equal('include' in c.document, false);
  assert.equal('stacks' in c.document, false);
  assert.deepEqual(c.files, ['market.blueprint.yaml', 'parts/a.part.yaml', 'parts/b.part.yaml']);
});

test('composing does not change the root document it was given', () => {
  const r = root({ schemas: [schema('vendor')], roles: { viewer: role() } });
  compose(r, [['parts/a.part.yaml', { schemas: [schema('listing')], roles: { donor: role() } }]]);
  assert.equal((r.schemas as unknown[]).length, 1);
  assert.deepEqual(Object.keys(r.roles as object), ['viewer']);
});

test('a section only the parts declare is created in the composed document', () => {
  const c = compose(root(), [['parts/a.part.yaml', { seed: [{ surface: 'record', typeName: 'listing', externalId: 'l1', fields: {} }] }]]);
  assert.equal((c.document.seed as unknown[]).length, 1);
});

test('the composed document parses as a blueprint like a single file would', () => {
  const c = compose(root(), [['parts/a.part.yaml', { schemas: [schema('listing')] }]]);
  const bp = parseBlueprint(c.document);
  assert.deepEqual(bp.schemas.map((s) => s.typeName), ['listing']);
});

// ── no overrides ─────────────────────────────────────────────────────────────

test('a map entry declared in two files is refused, naming both locations', () => {
  assert.throws(
    () =>
      compose(root({ roles: { 'vendor-admin': role() } }), [['parts/a.part.yaml', { roles: { 'vendor-admin': role() } }]]),
    (e: unknown) =>
      e instanceof BlueprintCompositionError &&
      /roles entry 'vendor-admin' is declared twice: market\.blueprint\.yaml:20 and parts\/a\.part\.yaml:20/.test((e as Error).message),
  );
});

test('a list entry declared in two files is refused by its name, naming both locations', () => {
  assert.throws(
    () =>
      compose(root(), [
        ['parts/a.part.yaml', { schemas: [schema('other'), schema('listing')] }],
        ['parts/b.part.yaml', { schemas: [schema('listing')] }],
      ]),
    /schemas entry 'listing' is declared twice: parts\/a\.part\.yaml:20 and parts\/b\.part\.yaml:20/,
  );
});

test('every list and map section refuses a cross-file duplicate', () => {
  const dupes: Array<[string, unknown, unknown]> = [
    ['issuers', [{ issuerId: 'idp' }], [{ issuerId: 'idp' }]],
    ['namespaces', [{ namespace: 'vendor' }], [{ namespace: 'vendor' }]],
    ['seed', [{ typeName: 't', externalId: 'e' }], [{ typeName: 't', externalId: 'e' }]],
    ['fragments', { reach: {} }, { reach: {} }],
    ['identities', { demo: {} }, { demo: {} }],
    ['scripts', { s: {} }, { s: {} }],
    ['agents', { a: {} }, { a: {} }],
    ['roleAssumable', { r: {} }, { r: {} }],
  ];
  for (const [key, a, b] of dupes) {
    assert.throws(
      () => compose(root(), [['parts/a.part.yaml', { [key]: a }], ['parts/b.part.yaml', { [key]: b }]]),
      new RegExp(`${key} entry '.+' is declared twice`),
      key,
    );
  }
});

test('a duplicate within ONE file of a split blueprint is refused too, and so is one between the root and a part', () => {
  assert.throws(
    () => compose(root(), [['parts/a.part.yaml', { schemas: [schema('listing'), schema('listing')] }]]),
    /schemas entry 'listing' is declared twice: parts\/a\.part\.yaml:20 and parts\/a\.part\.yaml:20/,
  );
  assert.throws(
    () => compose(root({ schemas: [schema('listing')] }), [['parts/a.part.yaml', { schemas: [schema('listing')] }]]),
    /schemas entry 'listing' is declared twice: market\.blueprint\.yaml:20 and parts\/a\.part\.yaml:20/,
  );
});

test('a field that names or refers to a resource must be literal in a split blueprint', () => {
  const tok = '${{ inputs.t }}';
  const cases: Array<[Record<string, unknown>, RegExp]> = [
    [{ schemas: [schema(tok)] }, /'schemas\.0\.typeName' names a resource/],
    [{ schemas: [{ ...schema('a'), fields: [{ fieldId: 'r', fieldType: 'reference', targetTypeName: tok }] }] }, /schemas\.0\.fields\.0\.targetTypeName/],
    [{ issuers: [{ issuerId: tok }] }, /issuers\.0\.issuerId/],
    [{ issuers: [{ issuerId: 'idp', selfSignupPolicies: [{ roleId: tok }] }] }, /selfSignupPolicies\.0\.roleId/],
    [{ issuers: [{ issuerId: 'idp', selfSignupPolicies: [{ roleId: 'r', additionalRoleIds: ['a', tok] }] }] }, /selfSignupPolicies\.0\.additionalRoleIds\.1/],
    [{ schemas: [{ typeName: 'a', publicView: { mode: 'record', ownedBy: ['userId', tok] } }] }, /schemas\.0\.publicView\.ownedBy\.1/],
    [{ schemas: [{ typeName: 'a', fields: [{ fieldId: 'c', fieldType: 'asset', documentTypes: [tok] }] }] }, /schemas\.0\.fields\.0\.documentTypes\.0/],
    [{ agents: { h: { tools: [{ name: 't', script: { name: tok, version: 'latest' } }] } } }, /agents\.h\.tools\.0\.script\.name/],
    [{ namespaces: [{ namespace: tok }] }, /namespaces\.0\.namespace/],
    [{ seed: [{ typeName: 'a', externalId: tok }] }, /seed\.0\.externalId/],
    [{ triggers: { t: { firingSource: { schemaName: tok }, scriptRef: { name: 's' } } } }, /triggers\.t\.firingSource\.schemaName/],
    [{ triggers: { t: { firingSource: { schemaName: 'a' }, scriptRef: { name: tok } } } }, /triggers\.t\.scriptRef\.name/],
    [{ triggers: { t: { firingSource: { schemaName: 'a' }, scriptRef: { name: 's' }, roleIds: [tok] } } }, /triggers\.t\.roleIds\.0/],
    [{ roles: { r: [{ dataScopeRef: tok }] } }, /roles\.r\.0\.dataScopeRef/],
    [{ roles: { r: [{ assignableRoles: [tok] }] } }, /roles\.r\.0\.assignableRoles\.0/],
    [{ identities: { demo: { kind: tok } } }, /identities\.demo\.kind/],
  ];
  for (const [part, re] of cases) {
    assert.throws(() => compose(root(), [['parts/a.part.yaml', part]]), (e: unknown) => e instanceof BlueprintCompositionError && re.test((e as Error).message), JSON.stringify(part));
  }
  assert.throws(() => compose(root({ accessProfile: { roleIds: [tok] } }), [['parts/a.part.yaml', {}]]), /accessProfile\.roleIds\.0/);
  // A token anywhere else (a display name, a description) is fine.
  const c = compose(root(), [['parts/a.part.yaml', { schemas: [{ ...schema('a'), displayName: tok }] }]]);
  assert.equal((c.document.schemas as Array<{ displayName: string }>)[0].displayName, tok);
});

test('a __proto__ key in a part is an ordinary entry, kept and validated like any other', () => {
  const part = JSON.parse('{"roles": {"__proto__": [{"allowed_actions": ["records:r"]}]}}');
  const c = compose(root(), [['parts/a.part.yaml', part]]);
  const roles = c.document.roles as Record<string, unknown>;
  assert.deepEqual(Object.keys(roles), ['__proto__']);
  assert.equal(Object.getPrototypeOf(roles), Object.prototype);
});

test('the same file included twice is refused', () => {
  assert.throws(
    () => compose(root(), [['parts/a.part.yaml', {}], ['parts/a.part.yaml', {}]]),
    /'parts\/a\.part\.yaml' is included more than once/,
  );
});

// ── what a part may declare ──────────────────────────────────────────────────

test('a part declaring a root-only key is refused, with its location', () => {
  for (const key of ['name', 'accessProfile', 'servicePrincipal', 'contextId', 'inputs', 'formatVersion', 'identityProjectionClaims']) {
    assert.throws(
      () => compose(root(), [['parts/a.part.yaml', { [key]: 'x' }]]),
      new RegExp(`parts/a\\.part\\.yaml:10: '${key}' can only be declared in the root file`),
      key,
    );
  }
});

test('a part cannot include parts or declare stacks', () => {
  assert.throws(() => compose(root(), [['parts/a.part.yaml', { include: ['x'] }]]), /cannot declare 'include'/);
  assert.throws(() => compose(root(), [['parts/a.part.yaml', { stacks: {} }]]), /cannot declare 'stacks'/);
});

test('a part declaring an unknown section is refused, listing what a part may declare', () => {
  assert.throws(() => compose(root(), [['parts/a.part.yaml', { schemaz: [] }]]), /'schemaz' is not a section a part file can declare/);
});

test('a part that is not a map, or a section of the wrong shape, is refused', () => {
  assert.throws(() => compose(root(), [['parts/a.part.yaml', ['x']]]), /must be a map of blueprint sections/);
  assert.throws(() => compose(root(), [['parts/a.part.yaml', { schemas: {} }]]), /'schemas' must be a list/);
  assert.throws(() => compose(root(), [['parts/a.part.yaml', { roles: [] }]]), /'roles' must be a map/);
});

// ── stacks ───────────────────────────────────────────────────────────────────

test('stacks record what each declares; the root stack holds the root file own sections', () => {
  const c = compose(
    root({ schemas: [schema('vendor')], roles: { viewer: role() } }),
    [
      ['parts/sales.part.yaml', { schemas: [schema('order')], seed: [{ typeName: 'order', externalId: 'p1' }] }],
      ['parts/ticket.part.yaml', { triggers: { notify: {} }, scripts: { notify: {} }, roles: { ticket: role() } }],
    ],
    { sales: ['parts/sales.part.yaml'], support: ['parts/ticket.part.yaml'] },
  );
  const s = c.stacks!;
  assert.deepEqual(Object.keys(s), [ROOT_STACK, 'sales', 'support']);
  assert.deepEqual([...s[ROOT_STACK].schemas], ['vendor']);
  assert.deepEqual([...s[ROOT_STACK].roles], ['viewer']);
  assert.deepEqual([...s.sales.schemas], ['order']);
  assert.deepEqual([...s.sales.seed], [0]);
  assert.deepEqual([...s.support.triggers], ['notify']);
  assert.deepEqual([...s.support.roles], ['ticket']);
  assert.deepEqual(s.sales.files, ['parts/sales.part.yaml']);
});

test('without stacks, no stack contents are reported', () => {
  assert.equal(compose(root(), [['parts/a.part.yaml', {}]]).stacks, undefined);
});

test('a part no stack covers, one covered twice, or a stack naming a file not included is refused', () => {
  const parts: Array<[string, unknown]> = [['parts/a.part.yaml', {}], ['parts/b.part.yaml', {}]];
  assert.throws(() => compose(root(), parts, { one: ['parts/a.part.yaml'] }), /not covered: 'parts\/b\.part\.yaml'/);
  assert.throws(
    () => compose(root(), parts, { one: ['parts/a.part.yaml', 'parts/b.part.yaml'], two: ['parts/b.part.yaml'] }),
    /belongs to two stacks, 'one' and 'two'/,
  );
  assert.throws(() => compose(root(), parts, { one: ['parts/a.part.yaml', 'parts/b.part.yaml', 'parts/c.part.yaml'] }), /not one of the files under 'include'/);
});

test('with stacks, a fragment must share a stack with the roles using it, and roleAssumable with its role', () => {
  const stacks = { one: ['parts/a.part.yaml'], two: ['parts/b.part.yaml'] };
  assert.throws(
    () =>
      compose(root(), [
        ['parts/a.part.yaml', { fragments: { reach: {} } }],
        ['parts/b.part.yaml', { roles: { r: [{ allowed_actions: ['records:r'], dataScopeRef: 'reach' }] } }],
      ], stacks),
    /role 'r' \(stack 'two'\) uses fragment 'reach' from stack 'one'/,
  );
  assert.throws(
    () =>
      compose(root(), [
        ['parts/a.part.yaml', { roleAssumable: { r: {} } }],
        ['parts/b.part.yaml', { roles: { r: role() } }],
      ], stacks),
    /roleAssumable entry for role 'r' is in stack 'one', but the role is in stack 'two'/,
  );
  // The same layout is fine without stacks, and fine when they share a stack.
  compose(root(), [['parts/a.part.yaml', { fragments: { reach: {} } }], ['parts/b.part.yaml', { roles: { r: [{ dataScopeRef: 'reach' }] } }]]);
  compose(root(), [['parts/a.part.yaml', { fragments: { reach: {} }, roles: { r: [{ dataScopeRef: 'reach' }] }, roleAssumable: { r: {} } }]], { one: ['parts/a.part.yaml'] });
});

test('a library caller cannot name a stack root, or an invalid name, in stackFiles', () => {
  assert.throws(() => compose(root(), [['parts/a.part.yaml', {}]], { root: ['parts/a.part.yaml'] }), /reserved or not valid/);
  assert.throws(() => compose(root(), [['parts/a.part.yaml', {}]], { 'Bad Name': ['parts/a.part.yaml'] }), /reserved or not valid/);
});

test('seed indexes in a stack account for seeds the root declares before the parts', () => {
  const c = compose(
    root({ seed: [{ typeName: 'a', externalId: 'r1' }, { typeName: 'a', externalId: 'r2' }] }),
    [['parts/a.part.yaml', { seed: [{ typeName: 'a', externalId: 'p1' }] }]],
    { one: ['parts/a.part.yaml'] },
  );
  assert.deepEqual([...c.stacks!.one.seed], [2]);
  assert.deepEqual([...c.stacks!.root.seed], [0, 1]);
  assert.equal((c.document.seed as Array<{ externalId: string }>)[2].externalId, 'p1');
});

test('mergeStacks unions the selected stacks and refuses an unknown name', () => {
  const c = compose(
    root(),
    [['parts/a.part.yaml', { schemas: [schema('a')] }], ['parts/b.part.yaml', { schemas: [schema('b')] }]],
    { one: ['parts/a.part.yaml'], two: ['parts/b.part.yaml'] },
  );
  assert.deepEqual([...mergeStacks(c.stacks!, ['one', 'two']).schemas], ['a', 'b']);
  assert.throws(() => mergeStacks(c.stacks!, ['three']), /unknown stack 'three'\. This blueprint declares: 'root', 'one', 'two'/);
  for (const name of ['__proto__', 'constructor', 'toString']) {
    assert.throws(() => mergeStacks(c.stacks!, [name]), /unknown stack/, name);
  }
});

// ── locations ────────────────────────────────────────────────────────────────

test('an issue path into the composed document locates the file and the deepest line that exists', () => {
  const c = compose(root({ schemas: [schema('vendor')] }), [
    ['parts/a.part.yaml', { schemas: [schema('listing'), schema('photo')], roles: { donor: role() } }],
  ]);
  // composed schemas[2] is the part's schemas[1]; fields[0] exists, fieldTypo does not.
  assert.equal(c.locate('schemas[2].fields[0].fieldTypo'), 'parts/a.part.yaml:40');
  assert.equal(c.locate('schemas[0]'), 'market.blueprint.yaml:20');
  assert.equal(c.locate('roles.donor[0]'), 'parts/a.part.yaml:30');
  assert.equal(c.locate('accessProfile.allowedActions'), 'market.blueprint.yaml:20');
  assert.equal(c.locate('schemas[9]'), undefined);
  assert.equal(c.locate('(root)'), undefined);
});

test('declaredAt finds the file of the first resource a message names', () => {
  const c = compose(root(), [
    ['parts/a.part.yaml', { schemas: [schema('listing')], roles: { 'vendor-admin': role() }, triggers: { notify: {} } }],
  ]);
  assert.equal(c.declaredAt("role 'vendor-admin' clause 0"), 'parts/a.part.yaml:20');
  assert.equal(c.declaredAt("schema 'listing': composite lookupField ..."), 'parts/a.part.yaml:20');
  assert.equal(c.declaredAt("trigger 'notify'"), 'parts/a.part.yaml:20');
  assert.equal(c.declaredAt("role 'missing'"), undefined);
  assert.equal(c.declaredAt('no resource named here'), undefined);
});

test('parseIssuePath splits keys and indexes', () => {
  assert.deepEqual(parseIssuePath('schemas[7].fields[2].fieldType'), ['schemas', 7, 'fields', 2, 'fieldType']);
  assert.deepEqual(parseIssuePath('roles.vendor-admin[0].allowed_actions'), ['roles', 'vendor-admin', 0, 'allowed_actions']);
});

test('a hostile file name is shown without its control characters', () => {
  assert.throws(
    () => compose(root(), [['parts/\u001b[2Ja.part.yaml', { name: 'x' }]]),
    (e: unknown) =>
      e instanceof Error && !e.message.includes('\u001b') && /parts\/\?\[2Ja\.part\.yaml:10: 'name' can only be declared in the root file/.test(e.message),
  );
});

test('declaredAt finds every kind of declared resource', () => {
  const c = compose(root(), [
    ['parts/a.part.yaml', {
      scripts: { s: {} }, agents: { a: {} }, identities: { demo: {} }, fragments: { f: {} },
      namespaces: [{ namespace: 'team' }], issuers: [{ issuerId: 'idp' }],
    }],
  ]);
  for (const text of ["script 's'", "agent 'a'", "identity 'demo'", "fragment 'f'", "namespace 'team'", "issuer 'idp'"]) {
    assert.match(c.declaredAt(text) ?? '', /^parts\/a\.part\.yaml:\d+$/, text);
  }
});
