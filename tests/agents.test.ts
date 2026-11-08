/**
 * The `agents` blueprint block and the `formatVersion` that introduced it.
 *
 * What these tests pin:
 *
 *  - **A newer format is refused up front with an "upgrade" message**, before the structural parse
 *    would report the newer format's keys as unrecognized.
 *  - **An `agents` section needs `formatVersion: 2`.** Older tools reject the section outright; the
 *    format version is what lets a tool tell "you need a newer tool" from "this file is broken".
 *  - **The map KEY is the agent name**, so its grammar is checked by a lint, not the value schema.
 *  - **A write grant needs a write cap, and a tool list needs a tool-call cap**, or the agent could
 *    never use what it declares.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseBlueprint,
  assertSupportedFormatVersion,
  BlueprintValidationError,
  BLUEPRINT_FIELD_PHASES,
  BLUEPRINT_FORMAT_VERSION,
  type Blueprint,
} from '../src/types.js';

function minimal(overrides: Record<string, unknown> = {}): Blueprint {
  return {
    name: 'demo',
    version: '1.0.0',
    description: 'demo blueprint',
    contextId: 'mcp',
    schemas: [],
    accessProfile: { allowedActions: ['records:r'] },
    servicePrincipal: { externalId: 'demo-sp', displayName: 'Demo SP' },
    ...overrides,
  } as unknown as Blueprint;
}

function issues(input: unknown): Array<{ path: string; message: string }> {
  try {
    parseBlueprint(input);
    return [];
  } catch (err) {
    assert.ok(err instanceof BlueprintValidationError, `expected BlueprintValidationError, got ${err}`);
    return err.issues;
  }
}

const triage = { model: 'claude-sonnet-5-5', system: 'You triage.', tools: [{ name: 'records_get' }] };

test('a valid agents section at formatVersion 2 parses', () => {
  const bp = parseBlueprint(minimal({ formatVersion: 2, agents: { 'intake-triage': triage } }));
  assert.equal(bp.agents?.['intake-triage']?.model, 'claude-sonnet-5-5');
});

test('an agents section without formatVersion 2 is refused', () => {
  const found = issues(minimal({ agents: { triage } }));
  assert.ok(found.some((i) => i.path === 'formatVersion'), JSON.stringify(found));
});

test('a newer formatVersion is refused with an upgrade message before the structural parse', () => {
  const input = minimal({ formatVersion: BLUEPRINT_FORMAT_VERSION + 1, somethingNew: true });
  assert.throws(
    () => assertSupportedFormatVersion(input),
    (err: unknown) => err instanceof BlueprintValidationError && /Upgrade @vectros-ai\/cli/.test(err.message),
  );
  assert.throws(
    () => parseBlueprint(input),
    (err: unknown) => err instanceof BlueprintValidationError && /format version/.test(err.message) && !/somethingNew/.test(err.message),
  );
});

test('a missing formatVersion is format 1 and still parses without agents', () => {
  assert.doesNotThrow(() => parseBlueprint(minimal()));
});

test('an invalid agent name is refused', () => {
  const found = issues(minimal({ formatVersion: 2, agents: { 'bad name!': triage } }));
  assert.ok(found.some((i) => i.path.startsWith('agents')), JSON.stringify(found));
});

test('authority is an open set: any upper-case name passes offline (the platform decides which it supports)', () => {
  assert.deepEqual(issues(minimal({ formatVersion: 2, agents: { a: { ...triage, authority: 'CALLER' } } })), []);
  assert.deepEqual(issues(minimal({ formatVersion: 2, agents: { a: { ...triage, authority: 'AGENT' } } })), []);
});

test('authority must be an upper-case name', () => {
  for (const authority of ['caller', '', 'CALLER!', 42]) {
    const found = issues(minimal({ formatVersion: 2, agents: { a: { ...triage, authority } } }));
    assert.ok(found.some((i) => i.path.includes('authority')), JSON.stringify({ authority, found }));
  }
});

test('a tool listed twice is refused', () => {
  const found = issues(minimal({ formatVersion: 2, agents: { a: { ...triage, tools: [{ name: 'records_get' }, { name: 'records_get' }] } } }));
  assert.ok(found.some((i) => /listed twice/.test(i.message)), JSON.stringify(found));
});

test('allowWrites needs limits.maxWrites of at least 1', () => {
  const tools = [{ name: 'records_update', allowWrites: true }];
  assert.ok(issues(minimal({ formatVersion: 2, agents: { a: { ...triage, tools } } })).some((i) => /maxWrites/.test(i.message)));
  assert.doesNotThrow(() => parseBlueprint(minimal({ formatVersion: 2, agents: { a: { ...triage, tools, limits: { maxWrites: 2 } } } })));
});

test('listed tools need limits.maxToolCalls of at least 1', () => {
  const found = issues(minimal({ formatVersion: 2, agents: { a: { ...triage, limits: { maxToolCalls: 0 } } } }));
  assert.ok(found.some((i) => /maxToolCalls/.test(i.message)), JSON.stringify(found));
});

test('the platform limits are checked offline', () => {
  assert.ok(issues(minimal({ formatVersion: 2, agents: { a: { ...triage, budget: { maxInferenceCents: 501 } } } })).length > 0);
  assert.ok(issues(minimal({ formatVersion: 2, agents: { a: { ...triage, system: 'x'.repeat(32_001) } } })).length > 0);
  assert.ok(issues(minimal({ formatVersion: 2, agents: { a: { ...triage, limits: { maxSteps: 26 } } } })).length > 0);
  assert.ok(issues(minimal({ formatVersion: 2, agents: { a: { ...triage, unknownField: 1 } } })).length > 0);
});

test('agents is an in-context field', () => {
  assert.equal(BLUEPRINT_FIELD_PHASES.agents, 'in-context');
});

test('a model id with a line break, a terminal escape or an invisible character is refused (it is shown in the plan)', () => {
  const hostile = [
    'claude-sonnet-5-5\n  agent \'forged\' (ensure the stored definition matches',
    'claude\u001b[2J',
    'claude\u202eevil',
    'claude\u200bzero',
    'claude\r',
    'claude\u0085next',
    'claude\u{e0041}tag',
    'claude-sonnet-5-5\n',
    'claude\u2028line',
  ];
  for (const model of hostile) {
    const found = issues(minimal({ formatVersion: 2, agents: { a: { model } } }));
    assert.ok(found.some((i) => i.path.includes('model')), JSON.stringify({ model, found }));
  }
  assert.deepEqual(issues(minimal({ formatVersion: 2, agents: { a: { model: 'claude-sonnet-5-5' } } })), []);
});

function failureText(input: unknown): string {
  try {
    parseBlueprint(input);
    return '';
  } catch (err) {
    assert.ok(err instanceof BlueprintValidationError);
    return `${err.message}\n${err.issues.map((i) => `${i.path}: ${i.message}`).join('\n')}`;
  }
}

test('a hostile agent map key cannot forge a line in the error that refuses it', () => {
  const key = 'x\n  ✖ RESULT: PASS\u001b[2J';
  const text = failureText(minimal({ formatVersion: 2, agents: { [key]: triage } }));
  assert.notEqual(text, '', 'the blueprint is refused');
  assert.doesNotMatch(text, /[^\P{Cc}\n]/u);
  const lines = text.split('\n');
  assert.equal(lines.filter((l) => /^\s*✖/.test(l)).length, 0, 'no line of its own starts with the forged mark');
  assert.ok(lines.every((l) => l === '' || /^( {2}• )?agents\.|^Malformed blueprint:$/.test(l)), JSON.stringify(lines));
  assert.ok(lines.some((l) => l.includes('agents.x?  ✖ RESULT: PASS?[2J')), 'the key is shown with the odd characters marked');
  assert.match(text, /must not contain control characters/, 'the key schema itself refuses it, not only the path printer');
});

test('a name that is not a valid agent name is echoed as typed, and a duplicate tool name is named', () => {
  const dup = issues(minimal({ formatVersion: 2, agents: { a: { model: 'm', tools: [{ name: 'records_get' }, { name: 'records_get' }] } } }));
  assert.ok(dup.some((i) => /tool 'records_get' is listed twice/.test(i.message)));
  const bad = failureText(minimal({ formatVersion: 2, agents: { 'bad name!': triage } }));
  assert.match(bad, /agents\['bad name!'\] is not a valid agent name/);
});

test('the invisible characters the changelog promises to refuse are refused in a model id', () => {
  for (const code of [0x2061, 0x2062, 0x2063, 0x2064, 0x206a, 0x206f, 0xfff9, 0xfffb, 0x180e]) {
    const found = issues(minimal({ formatVersion: 2, agents: { a: { model: `claude${String.fromCodePoint(code)}x` } } }));
    assert.ok(found.some((i) => i.path.includes('model')), `U+${code.toString(16)}`);
  }
});

test('an unrecognized key in an agent entry is named in the error without its forgery characters', () => {
  const hostile = 'x\n  ✖ RESULT: PASS\u001b[2J';
  const text = failureText(minimal({ formatVersion: 2, agents: { a: { model: 'm', [hostile]: 1 } } }));
  assert.notEqual(text, '');
  assert.doesNotMatch(text, /[^\P{Cc}\n]/u);
  assert.equal(text.split('\n').filter((l) => /^\s*✖/.test(l)).length, 0, 'the quoted key did not start a line of its own');
  assert.match(text, /Unrecognized key: "x\? {2}✖ RESULT: PASS\?\[2J"/);
});

test('a long map key is shown in full in the issue path, not cut', () => {
  const longName = 'n'.repeat(100);
  const found = issues(minimal({ formatVersion: 2, agents: { [longName]: triage } }));
  assert.ok(found.some((i) => i.path === `agents.${longName}`), JSON.stringify(found.map((i) => i.path)));
});

test('the refused invisible ranges are refused at both ends and in between, and the characters next to them are not', () => {
  const modelIsRefused = (code: number): boolean =>
    issues(minimal({ formatVersion: 2, agents: { a: { model: `m${String.fromCodePoint(code)}x` } } })).some((i) => i.path.includes('model'));
  const refused = [0x2061, 0x2062, 0x2063, 0x2064, 0x206a, 0x206b, 0x206c, 0x206d, 0x206e, 0x206f, 0xfff9, 0xfffa, 0xfffb, 0x180e, 0x115f, 0x1160, 0x3164, 0xffa0, 0x1bca0, 0x1bca1, 0x1bca2, 0x1bca3, 0x1d173, 0x1d17a];
  for (const code of refused) assert.equal(modelIsRefused(code), true, `U+${code.toString(16)} is refused`);
  for (const code of [0x2065, 0x180d, 0xfffc, 0xfff8, 0x115e, 0x1161, 0x3163, 0x3165, 0xff9f, 0xffa1, 0x1bc9f, 0x1bca4, 0x1d172, 0x1d17b, 0xfe0f, 0x0600, 0x034f]) assert.equal(modelIsRefused(code), false, `U+${code.toString(16)} is next to a refused range, not in one`);
});
