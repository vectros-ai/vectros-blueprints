/**
 * Text an author supplies never reaches an error message as a line break or an escape: the schema's messages, the
 * input resolver's, the identity resolver's and the JSON parse error all show such characters as `?`. The error classes
 * enforce the same on whatever they are handed, so a message added later is covered without remembering to clean it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBlueprint, parseBlueprintJson, BlueprintValidationError } from '../src/types.js';
import { resolveBlueprintInputs, BlueprintInputError } from '../src/inputs.js';
import { resolveBlueprintIdentities, BlueprintIdentityError } from '../src/identities.js';

const HOSTILE = 'x\n  ✖ RESULT: PASS\u001b[2J';

function minimal(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'demo',
    version: '1.0.0',
    description: 'demo',
    contextId: 'mcp',
    schemas: [],
    accessProfile: { allowedActions: ['records:r'] },
    servicePrincipal: { externalId: 'demo-sp', displayName: 'Demo SP' },
    ...overrides,
  };
}

/** Everything an error carries that a caller might print: its message and each issue's path and message. */
function printable(err: { message: string; issues: Array<{ path: string; message: string }> }): string[] {
  return [err.message, ...err.issues.flatMap((i) => [i.path, i.message])];
}

function assertClean(texts: string[], where: string): void {
  for (const t of texts) {
    assert.doesNotMatch(t, /[^\P{Cc}\n]/u, `${where}: no control character in ${JSON.stringify(t)}`);
  }
  const lines = texts.join('\n').split('\n');
  assert.deepEqual(lines.filter((l) => /^\s*✖/.test(l)), [], `${where}: no line of its own`);
}

function caught<E extends Error>(fn: () => unknown, type: new (...a: never[]) => E): E {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof type, `expected ${type.name}, got ${String(err)}`);
    return err;
  }
  assert.fail('expected an error');
}

test('a hostile capability name is quoted without its line break or escape', () => {
  const err = caught(() => parseBlueprint(minimal({ accessProfile: { allowedActions: ['records:r'], capabilities: [HOSTILE] } })), BlueprintValidationError);
  assertClean(printable(err), 'capability');
  assert.match(err.issues.map((i) => i.message).join(' '), /'x\? {2}✖ RESULT: PASS\?\[2J' is not a valid capability name/);
});

test('a hostile ${{ }} body is quoted without its line break or escape', () => {
  const err = caught(() => resolveBlueprintInputs(minimal({ description: `Intake \${{ ${HOSTILE} }}` })), BlueprintInputError);
  assertClean(printable(err), 'malformed reference');
  assert.match(err.message, /malformed reference/);
});

test('a hostile input name is quoted without forgery characters', () => {
  const err = caught(() => resolveBlueprintInputs(minimal({ inputs: { [HOSTILE]: { type: 'string', default: 'v' } } })), BlueprintInputError);
  assertClean(printable(err), 'invalid input name');
  assert.match(printable(err).join('\n'), /invalid input name 'x\? {2}✖ RESULT: PASS\?\[2J'/);
});

test('a JSON syntax error that quotes the source is quoted without its line breaks or escapes', () => {
  const err = caught(() => parseBlueprintJson(`{"name": x\n  ✖ RESULT: PASS\u001b[2J}`), BlueprintValidationError);
  assertClean(printable(err), 'JSON');
});

test('an identity name and a resolver failure are quoted without forgery characters', async () => {
  // A hostile externalId or name is refused by the schema before anything is resolved; the resolver's own failure is what
  // can still carry outside text into the message.
  const raw = minimal({ identities: { owner: { kind: 'user', externalId: 'owner-1' } } });
  await assert.rejects(
    resolveBlueprintIdentities(raw, async () => {
      throw new Error(`resolver said ${HOSTILE}`);
    }),
    (err: BlueprintIdentityError) => {
      assertClean(printable(err), 'identity resolver');
      assert.match(err.message, /Failed to resolve identity 'owner'/);
      return true;
    },
  );
});

test('an SDK error envelope from the identity resolver keeps its lines readable on one line, not as ? characters', async () => {
  const envelope = 'BadRequestError\nStatus code: 400\nBody: {"message":"externalId is already taken"}';
  await assert.rejects(
    resolveBlueprintIdentities(minimal({ identities: { owner: { kind: 'user', externalId: 'owner-1' } } }), async () => {
      throw new Error(envelope);
    }),
    (err: BlueprintIdentityError) => {
      assert.match(err.message, /BadRequestError Status code: 400 Body: \{"message":"externalId is already taken"\}/);
      assert.equal(err.issues[0].message, 'BadRequestError Status code: 400 Body: {"message":"externalId is already taken"}');
      assert.doesNotMatch(err.message, /\?/);
      return true;
    },
  );
});

test('a bidirectional override and a zero-width character in a quoted name are shown as ?, not dropped and not kept', () => {
  const name = 'cap\u202ename\u200bx';
  const err = caught(() => parseBlueprint(minimal({ accessProfile: { allowedActions: ['records:r'], capabilities: [name] } })), BlueprintValidationError);
  const text = err.issues.map((i) => i.message).join('\n');
  assert.match(text, /'cap\?name\?x' is not a valid capability name/);
  assert.doesNotMatch(`${err.message}${text}`, /[\u200b-\u200f\u202a-\u202e\u2066-\u2069]/u);
});

test('an unknown-keys message that quotes very many long keys is cut', () => {
  const keys = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`unknown_key_number_${i}_${'k'.repeat(40)}`, 1]));
  const err = caught(() => parseBlueprint(minimal({ servicePrincipal: { externalId: 'demo-sp', displayName: 'Demo SP', ...keys } })), BlueprintValidationError);
  const longest = Math.max(...err.issues.map((i) => i.message.length));
  assert.ok(longest <= 303, `an issue message of ${longest} characters`);
  assert.match(err.issues.map((i) => i.message).join(' '), /Unrecognized key/);
});

test('the error classes clean what they are handed, whatever built it', () => {
  const v = new BlueprintValidationError(`Malformed:\n  • a${HOSTILE}`, [{ path: `p${HOSTILE}`, message: `m${HOSTILE}` }]);
  assert.doesNotMatch(v.message, /[^\P{Cc}\n]/u);
  assert.equal(v.issues[0].path.includes('\n'), false);
  assert.equal(v.issues[0].message.includes('\n'), false);
  const i = new BlueprintInputError(`x${HOSTILE}`, [{ path: HOSTILE, message: HOSTILE }]);
  assert.doesNotMatch(i.message, /[^\P{Cc}\n]/u);
  assert.equal(i.issues[0].message.includes('\n'), false);
  const d = new BlueprintIdentityError(`x${HOSTILE}`, [{ path: HOSTILE, message: HOSTILE }]);
  assert.doesNotMatch(d.message, /[^\P{Cc}\n]/u);
  assert.equal(d.issues[0].path.includes('\n'), false);
});

test('a message with CRLF line breaks keeps them as line breaks, not as ? characters', () => {
  const v = new BlueprintValidationError('one\r\ntwo');
  assert.equal(v.message, 'one\ntwo');
});

test('a legitimate multi-line error message keeps its own line breaks', () => {
  const v = new BlueprintValidationError('Malformed blueprint:\n  • schemas[0]: bad\n  • roles.r: worse');
  assert.equal(v.message.split('\n').length, 3);
});

test('a lookup field\'s sortBy is held to the displayed-text rule, since lint findings print it', () => {
  const schema = (sortBy: string) => ({ typeName: 't', displayName: 'T', fields: [{ fieldId: 'a', fieldType: 'string' }], lookupFields: [{ fieldName: 'a', sortBy }] });
  const err = caught(() => parseBlueprint(minimal({ schemas: [schema(HOSTILE)] })), BlueprintValidationError);
  assertClean(printable(err), 'sortBy');
  assert.ok(err.issues.some((i) => /sortBy/.test(i.path)), JSON.stringify(err.issues));
  assert.doesNotThrow(() => parseBlueprint(minimal({ schemas: [schema('createdAt')] })));
});
