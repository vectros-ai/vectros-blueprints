/**
 * Edges of numeric and length validation that are part of the format's contract:
 *  - an integer field refuses a value beyond JavaScript's safe-integer range;
 *  - a number field refuses Infinity;
 *  - a string length limit counts characters (code points), not UTF-16 units.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBlueprint, BlueprintValidationError } from '../src/types.js';
import { InputsDeclSchema } from '../src/inputs.js';

function minimal(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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

function withRule(rule: Record<string, unknown>): Record<string, unknown> {
  return minimal({
    schemas: [
      {
        typeName: 'note',
        displayName: 'Note',
        fields: [{ fieldId: 'body', fieldType: 'string', validation: rule }],
      },
    ],
  });
}

function issuePaths(input: unknown): string[] {
  try {
    parseBlueprint(input);
    return [];
  } catch (err) {
    assert.ok(err instanceof BlueprintValidationError);
    return err.issues.map((i) => i.path);
  }
}

test('an integer validation rule within the safe-integer range is accepted', () => {
  assert.deepEqual(issuePaths(withRule({ maxLength: Number.MAX_SAFE_INTEGER })), []);
});

test('an integer validation rule beyond the safe-integer range is refused, at the rule', () => {
  const paths = issuePaths(withRule({ maxLength: Number.MAX_SAFE_INTEGER + 2 }));
  assert.ok(paths.some((p) => p.endsWith('validation.maxLength')), JSON.stringify(paths));
});

test('a non-integer validation rule is refused, at the rule', () => {
  const paths = issuePaths(withRule({ minLength: 1.5 }));
  assert.ok(paths.some((p) => p.endsWith('validation.minLength')), JSON.stringify(paths));
});

test('an input default of Infinity is refused; a finite number is accepted', () => {
  assert.equal(InputsDeclSchema.safeParse({ x: { type: 'number', default: Number.POSITIVE_INFINITY } }).success, false);
  assert.equal(InputsDeclSchema.safeParse({ x: { type: 'number', default: 5 } }).success, true);
});

test('a string length limit counts characters, not UTF-16 units', () => {
  const agents = (description: string): Record<string, unknown> =>
    minimal({
      formatVersion: 2,
      agents: { triage: { model: 'claude-sonnet-5-5', description, tools: [{ name: 'records_get' }] } },
    });
  // 500 is the description limit: 300 emoji are 300 characters (600 UTF-16 units) and are within it;
  // 501 are over it.
  assert.deepEqual(issuePaths(agents('\u{1F600}'.repeat(300))), []);
  assert.ok(issuePaths(agents('\u{1F600}'.repeat(501))).some((p) => p.endsWith('description')));
});
