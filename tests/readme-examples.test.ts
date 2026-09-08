/**
 * The README's worked YAML examples must actually parse.
 *
 * WHY THIS EXISTS. README.md ships to npm and to the public GitHub mirror, and a partner copies a
 * worked example verbatim — it is the most-executed code in the package and the only code in it
 * that nothing compiled or ran. The trigger example shipped in a state where `parseBlueprint`
 * rejected it, two of the reasons introduced by the very commit whose message claimed the example
 * had been corrected so it would not fail for anyone who copied it. Reviewing prose by reading it
 * is what let that through; an example is code, so it gets executed.
 *
 * It reads the CURRENT README rather than a copy, because drift is the whole failure mode — the
 * example was wrong precisely because one place was changed and the other re-blessed by eye.
 *
 * SCOPE. Only blocks that look like a whole blueprint (they declare a `schemas:` key) are parsed.
 * Fragment snippets — a lone `dataScope:` map, one field definition — are skipped: they are not
 * blueprints, and rejecting them would say nothing about whether the fragment is correct. If that
 * heuristic ever selects nothing the test FAILS rather than passing vacuously, because a guard that
 * silently checks nothing is worse than no guard.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { parseBlueprint, BlueprintValidationError } from '../src/types.js';

const README = join(dirname(fileURLToPath(import.meta.url)), '..', 'README.md');
const FENCE_OPEN = /^```ya?ml\s*$/;
const FENCE_CLOSE = /^```\s*$/;

/**
 * Every fenced YAML block, extracted line-wise rather than with a multiline regex — the regex
 * version was subtly wrong and, worse, failed in a way that read as "the README has no examples"
 * rather than as a bug in the extractor.
 */
function yamlBlocks(markdown: string): string[] {
  const blocks: string[] = [];
  let current: string[] | null = null;
  for (const line of markdown.split(/\r?\n/)) {
    if (current === null) {
      if (FENCE_OPEN.test(line)) current = [];
      continue;
    }
    if (FENCE_CLOSE.test(line)) {
      blocks.push(current.join('\n'));
      current = null;
      continue;
    }
    current.push(line);
  }
  return blocks;
}

/**
 * The fields a focused example omits because they are noise in a snippet. Supplying them lets the
 * example stay about the feature it teaches while still being parsed as a real blueprint. Nothing
 * here can mask a defect in what the example itself declares.
 */
function withScaffolding(doc: Record<string, unknown>): Record<string, unknown> {
  return {
    name: 'readme-example',
    version: '1.0.0',
    description: 'README example',
    contextId: 'mcp',
    servicePrincipal: { externalId: 'readme-sp', displayName: 'README SP' },
    accessProfile: { allowedActions: ['records:r'] },
    ...doc,
  };
}

test('every whole-blueprint YAML example in the README parses', () => {
  const candidates = yamlBlocks(readFileSync(README, 'utf8'))
    .map((block) => {
      let doc: unknown;
      try {
        doc = parseYaml(block);
      } catch {
        return null; // not YAML at all — not this guard's business
      }
      return doc && typeof doc === 'object' && 'schemas' in doc ? (doc as Record<string, unknown>) : null;
    })
    .filter((d): d is Record<string, unknown> => d !== null);

  // Fails rather than passing vacuously: if the heuristic stops selecting anything — a fence
  // relabelled, an example restructured — this guard has quietly stopped guarding.
  assert.ok(
    candidates.length > 0,
    'no whole-blueprint YAML example found in README.md — this guard is checking nothing',
  );

  candidates.forEach((doc, i) => {
    try {
      parseBlueprint(withScaffolding(doc));
    } catch (err) {
      if (err instanceof BlueprintValidationError) {
        const detail = err.issues.map((issue) => `      ${issue.path}: ${issue.message}`).join('\n');
        assert.fail(
          `README blueprint example #${i + 1} does not parse — a partner copying it gets:\n${detail}`,
        );
      }
      throw err;
    }
  });
});
