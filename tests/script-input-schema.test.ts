/**
 * A script version's enforced `inputSchema`: the offline mirror of the platform's dialect check, rule by rule, and the stored
 * form the CLI compares against. Plus the two new script-entry keys in a blueprint.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inputSchemaIssue, storedInputSchemaForm, sameJson } from '../src/script-input-schema.js';
import { parseBlueprint, BlueprintValidationError } from '../src/types.js';

const obj = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({ type: 'object', ...extra });

test('inputSchema: a schema in the dialect is accepted', () => {
  assert.equal(
    inputSchemaIssue(
      obj({
        description: 'Find a listing',
        properties: {
          q: { type: 'string', description: 'text' },
          limit: { type: 'integer', enum: [10, 20] },
          tags: { type: 'array', items: { type: 'string', enum: ['a', 'b'] } },
          where: { type: 'object', properties: { lat: { type: 'number' } }, required: ['lat'], additionalProperties: true },
          ok: { type: 'boolean' },
        },
        required: ['q'],
        additionalProperties: false,
      }),
    ),
    null,
  );
});

test('inputSchema: each platform rule refuses with its own message', () => {
  const cases: Array<[unknown, RegExp]> = [
    [[], /must be a JSON object/],
    ['x', /must be a JSON object/],
    [{ type: 'string' }, /root must declare "type": "object"/],
    [{}, /root must declare "type": "object"/],
    [obj({ properties: { a: { type: 'date' } } }), /properties\.a\.type must be one of array, boolean, integer, number, object, string/],
    [obj({ properties: { a: 'x' } }), /properties\.a must be an object/],
    [obj({ $ref: '#/x' }), /uses "\$ref", which this schema dialect does not support/],
    [obj({ properties: { a: { type: 'string', pattern: 'x' } } }), /uses "pattern"/],
    [obj({ items: { type: 'string' } }), /uses "items"/],
    [obj({ properties: { a: { type: 'string', properties: {} } } }), /uses "properties"/],
    [obj({ description: 'x'.repeat(2001) }), /description must be a string of at most 2000/],
    [obj({ description: 3 }), /description must be a string/],
    [obj({ properties: { a: { type: 'string', enum: [] } } }), /enum must list 1 to 100 values/],
    [obj({ properties: { a: { type: 'string', enum: Array.from({ length: 101 }, (_, i) => `v${i}`) } } }), /enum must list 1 to 100/],
    [obj({ properties: { a: { type: 'string', enum: [1] } } }), /enum values must be string values/],
    [obj({ properties: { a: { type: 'integer', enum: [1.5] } } }), /enum values must be integer values/],
    [obj({ properties: { a: { type: 'array', enum: [['x']] } } }), /enum values must be array values/],
    [obj({ properties: { a: { type: 'string', enum: ['x', 'x'] } } }), /enum lists a value twice/],
    [obj({ properties: [] }), /properties must be an object/],
    [obj({ properties: Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`p${i}`, { type: 'string' }])) }), /more than 100 members/],
    [obj({ properties: { ['x'.repeat(65)]: { type: 'string' } } }), /member name must be 1 to 64 characters/],
    [obj({ properties: { '': { type: 'string' } } }), /member name must be 1 to 64 characters/],
    [obj({ required: 'q' }), /required must be an array of member names/],
    [obj({ properties: { q: { type: 'string' } }, required: ['nope'] }), /required names a member its properties do not declare/],
    [obj({ properties: { q: { type: 'string' } }, required: ['q', 'q'] }), /required names a member twice/],
    [obj({ additionalProperties: 'no' }), /additionalProperties must be true or false/],
  ];
  for (const [schema, re] of cases) {
    const issue = inputSchemaIssue(schema);
    assert.ok(issue !== null && re.test(issue), `${JSON.stringify(schema).slice(0, 80)} -> ${issue}`);
  }
});

test('inputSchema: at most 5 levels deep, and at most 16,384 bytes as compact JSON', () => {
  const nest = (depth: number): Record<string, unknown> =>
    depth === 1 ? { type: 'string' } : { type: 'object', properties: { n: nest(depth - 1) } };
  assert.equal(inputSchemaIssue(nest(5)), null);
  assert.match(inputSchemaIssue(nest(6)) ?? '', /nests deeper than 5 levels/);
  const big = obj({ description: 'x'.repeat(1990), properties: Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`p${i}`, { type: 'string', description: 'y'.repeat(1990) }])) });
  assert.match(inputSchemaIssue(big) ?? '', /too large \(max 16384 bytes\)/);
});

test('storedInputSchemaForm writes additionalProperties: false into every object node that omits it, and nothing else', () => {
  const declared = obj({ properties: { w: { type: 'object', properties: {} }, l: { type: 'array', items: { type: 'object' } }, s: { type: 'string' } }, additionalProperties: true });
  const stored = storedInputSchemaForm(declared);
  assert.equal(stored.additionalProperties, true, 'a stated value is kept');
  const props = stored.properties as Record<string, Record<string, unknown>>;
  assert.equal(props.w.additionalProperties, false);
  assert.equal((props.l.items as Record<string, unknown>).additionalProperties, false);
  assert.equal('additionalProperties' in props.s, false);
  assert.equal('additionalProperties' in (declared.properties as Record<string, Record<string, unknown>>).w, false, 'the input is not mutated');
});

test('sameJson ignores member order and nothing else', () => {
  assert.ok(sameJson({ a: 1, b: [1, { c: 2, d: 3 }] }, { b: [1, { d: 3, c: 2 }], a: 1 }));
  assert.ok(!sameJson({ a: [1, 2] }, { a: [2, 1] }), 'array order matters');
  assert.ok(!sameJson({ a: 1 }, { a: '1' }));
  assert.ok(!sameJson({ a: null }, {}));
});

function withScript(entry: Record<string, unknown>): unknown {
  return {
    name: 'demo', version: '1.0.0', description: 'demo blueprint', contextId: 'mcp', schemas: [],
    accessProfile: { allowedActions: ['records:r'] }, servicePrincipal: { externalId: 'demo-sp', displayName: 'Demo SP' },
    scripts: { find: { source: '({ ok: true });', ...entry } },
  };
}
function issues(input: unknown): string[] {
  try {
    parseBlueprint(input);
    return [];
  } catch (err) {
    assert.ok(err instanceof BlueprintValidationError, String(err));
    return err.issues.map((i) => `${i.path}: ${i.message}`);
  }
}

test('a blueprint script entry takes inputSchema (checked offline) and optInOperations (strings)', () => {
  assert.deepEqual(issues(withScript({ inputSchema: obj({ properties: { q: { type: 'string' } } }), optInOperations: ['a', 'b'] })), []);
  assert.ok(issues(withScript({ inputSchema: { type: 'string' } })).some((i) => /scripts\.find\.inputSchema: inputSchema: the root must declare/.test(i)));
  assert.ok(issues(withScript({ inputSchema: obj({ oneOf: [] }) })).some((i) => /uses "oneOf"/.test(i)));
  assert.ok(issues(withScript({ optInOperations: [1] })).length > 0);
  assert.deepEqual(issues(withScript({ optInOperations: [] })), [], 'an empty list is the same as none');
});

test('optInOperations: each entry is a non-empty string; which names is the platform\'s decision', () => {
  // An empty name is never an operation: refused offline, at the entry's own path.
  assert.ok(issues(withScript({ optInOperations: [''] })).some((i) => /scripts\.find\.optInOperations\[0\]: an operation name cannot be empty/.test(i)));
  assert.ok(issues(withScript({ optInOperations: ['a', ''] })).some((i) => /optInOperations\[1\]: an operation name cannot be empty/.test(i)));
  // A repeated entry is accepted: the platform stores the declaration distinct and sorted, so it is the same declaration.
  assert.deepEqual(issues(withScript({ optInOperations: ['a', 'a'] })), []);
  // Names are not checked against any list, and case is kept as written (the platform compares exactly).
  assert.deepEqual(issues(withScript({ optInOperations: ['Some.Name', 'some.name'] })), []);
  // A non-string and a non-list are refused.
  assert.ok(issues(withScript({ optInOperations: [null] })).length > 0);
  assert.ok(issues(withScript({ optInOperations: 'a' })).length > 0);
});

test('inputSchema: enum on an object node, enum [null] and required with no properties are refused as the platform does', () => {
  assert.match(inputSchemaIssue(obj({ properties: { a: { type: 'object', enum: [{}] } } })) ?? '', /enum values must be object values/);
  assert.match(inputSchemaIssue(obj({ properties: { a: { type: 'string', enum: [null] } } })) ?? '', /enum values must be string values/);
  assert.match(inputSchemaIssue(obj({ required: ['q'] })) ?? '', /required names a member its properties do not declare/);
});

test('inputSchema: the 16,384-byte limit counts UTF-8 bytes of the compact JSON, at the boundary', () => {
  // 'é' is 2 bytes. A description over 2,000 characters is its own refusal, so the bytes are spread over several members:
  // measure the document with an empty padding member, then fill it to exactly `bytes`.
  const spread = (bytes: number): Record<string, unknown> => {
    const props: Record<string, Record<string, unknown>> = {};
    for (let i = 0; i < 8; i++) props[`p${i}`] = { type: 'string', description: 'é'.repeat(900) };
    props.pad = { type: 'string', description: '' };
    const room = bytes - new TextEncoder().encode(JSON.stringify(obj({ properties: props }))).length;
    props.pad.description = 'é'.repeat(Math.floor(room / 2)) + 'x'.repeat(room % 2);
    return obj({ properties: props });
  };
  const size = (s: unknown) => new TextEncoder().encode(JSON.stringify(s)).length;
  const at = spread(16384);
  const over = spread(16385);
  assert.equal(size(at), 16384);
  assert.equal(size(over), 16385);
  assert.equal(inputSchemaIssue(at), null);
  assert.match(inputSchemaIssue(over) ?? '', /too large/);
});

test('inputSchema: a member set to undefined is not sent, so it is neither checked nor compared', () => {
  const declared = obj({ properties: { a: { type: 'string', properties: undefined, description: undefined } } });
  assert.equal(inputSchemaIssue(declared), null);
  const stored = { type: 'object', additionalProperties: false, properties: { a: { type: 'string' } } };
  assert.ok(sameJson(stored, storedInputSchemaForm(declared)), 'an undefined member must not make every apply push');
  assert.ok(sameJson({ a: 1, b: undefined }, { a: 1 }));
  assert.ok(!sameJson({ a: null }, {}), 'null is sent, so it still counts');
});

test('optInOperations: at most 16 entries, counted as sent (repeats count), as the platform counts them', () => {
  const ops = (n: number, name?: string) => Array.from({ length: n }, (_, i) => name ?? `op${i}`);
  assert.deepEqual(issues(withScript({ optInOperations: ops(16) })), []);
  const tooMany = issues(withScript({ optInOperations: ops(17) }));
  assert.ok(tooMany.some((i) => /^scripts\.find\.optInOperations: an operation list has more entries than a version may declare$/.test(i)), tooMany.join('\n'));
  // The platform counts the list before removing repeats, so 17 copies of one name are refused too.
  assert.ok(issues(withScript({ optInOperations: ops(17, 'same') })).some((i) => /more entries than a version may declare/.test(i)));
  assert.deepEqual(issues(withScript({ optInOperations: ops(16, 'same') })), []);
  // The message names no number and no operation.
  for (const i of tooMany) assert.doesNotMatch(i.replace(/^[^:]*:/, ''), /\d/);
});

test('destinations: aliases by the platform rule, no repeats; optional; not part of the version', () => {
  assert.deepEqual(issues(withScript({ destinations: ['crm', 'billing-api', 'a1'] })), []);
  assert.deepEqual(issues(withScript({ destinations: [] })), []);
  assert.deepEqual(issues(withScript({})), []);
  // The alias rule's edges: a lowercase letter first, then 1 to 39 more.
  assert.deepEqual(issues(withScript({ destinations: ['a'.repeat(40)] })), []);
  assert.ok(issues(withScript({ destinations: ['a'.repeat(41)] })).some((i) => /destinations\[0\]: a destination alias is/.test(i)));
  for (const bad of ['a', '1crm', 'Crm', 'crm_api', '-crm', '']) {
    assert.ok(issues(withScript({ destinations: [bad] })).some((i) => /scripts\.find\.destinations\[0\]: a destination alias is/.test(i)), bad);
  }
  assert.ok(issues(withScript({ destinations: ['crm', 'mail', 'crm'] })).some((i) => /destinations\[2\]: destination 'crm' is listed twice/.test(i)));
  assert.ok(issues(withScript({ destinations: 'crm' })).length > 0);
});
