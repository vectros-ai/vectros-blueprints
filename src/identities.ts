/**
 * Identity resolution — the APPLY-time (creds-bearing) half of the blueprint
 * identity feature.
 *
 * A blueprint may declare a top-level `identities:` block (principals it expects
 * to exist) and reference them with `${{ identities.<name> }}` tokens anywhere a
 * principal id is valid (seed-record ownership, schema/profile dataScope, a role
 * clause). Resolution has TWO tiers — DO NOT conflate (mirrors inputs.ts):
 *   - install-time (creds-free): {@link resolveBlueprintInputs} resolves
 *     `${{ inputs.* }}`/`${{ vectros.* }}` and LEAVES `${{ identities.* }}` literal
 *     (it is a deferred namespace).
 *   - apply-time (creds): THIS module ensures each declared identity exists
 *     (idempotently, by externalId — the injected `resolve` does the API call,
 *     wired by the CLI install orchestrator) and substitutes the tokens with
 *     the resolved principal ids.
 *
 * This module is the FORMAT half: the resolver is pure given an injected
 * `resolve` (so `plan` can dry-run/echo and tests can assert without creds). The
 * `identities` block shape lives in types.ts so {@link BlueprintSchema} validates
 * it offline (incl. the "every reference is declared" lint).
 */
import { IdentitiesDeclSchema, type IdentityDecl, type BlueprintIssue } from './types.js';

/** A `${{ identities.<name> }}` reference (global, for scan/replace). */
const IDENTITY_TOKEN_RE = /\$\{\{\s*identities\.([A-Za-z_]\w*)\s*\}\}/g;

/** Resolves a declared identity to its concrete principal id (idempotent, by externalId). */
export type IdentityResolver = (name: string, decl: IdentityDecl) => Promise<string>;

/** A creds-bearing identity-resolution failure (undeclared ref, bad block, resolver error). */
export class BlueprintIdentityError extends Error {
  readonly issues: BlueprintIssue[];
  constructor(message: string, issues: BlueprintIssue[] = []) {
    super(message);
    this.name = 'BlueprintIdentityError';
    this.issues = issues;
  }
}

/** Every distinct identity name referenced by `${{ identities.<name> }}` in the tree. */
export function collectIdentityReferences(value: unknown): string[] {
  const found = new Set<string>();
  const walk = (node: unknown): void => {
    if (typeof node === 'string') {
      for (const m of node.matchAll(IDENTITY_TOKEN_RE)) found.add(m[1]);
    } else if (Array.isArray(node)) {
      node.forEach(walk);
    } else if (node && typeof node === 'object') {
      Object.values(node as Record<string, unknown>).forEach(walk);
    }
  };
  walk(value);
  return [...found];
}

/** Substitute every `${{ identities.<name> }}` in the tree with `idMap[name]` (values only). */
function substitute(node: unknown, idMap: Record<string, string>): unknown {
  if (typeof node === 'string') {
    return node.replace(IDENTITY_TOKEN_RE, (_full, name: string) => idMap[name]);
  }
  if (Array.isArray(node)) return node.map((v) => substitute(v, idMap));
  if (node && typeof node === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) out[k] = substitute(v, idMap);
    return out;
  }
  return node;
}

/**
 * Resolve a blueprint's `identities:` against an injected creds-bearing resolver
 * and return the substituted tree WITH the `identities:` block stripped — ready
 * for {@link parseBlueprint}. Operates on the install-time-resolved tree (where
 * `${{ identities.* }}` tokens are still literal). Throws
 * {@link BlueprintIdentityError} on a malformed block, an undeclared reference,
 * or a resolver failure.
 *
 * EVERY declared identity is resolved (ensure-exist), not only referenced ones,
 * so a blueprint can provision a principal it doesn't token-reference. A token
 * that references an undeclared identity is an error (also caught offline by
 * {@link BlueprintSchema}).
 */
export async function resolveBlueprintIdentities(raw: unknown, resolve: IdentityResolver): Promise<unknown> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const { identities: rawIdentities, ...body } = raw as Record<string, unknown> & { identities?: unknown };

  // No block + no references → nothing to do (back-compat with non-identity blueprints).
  const refs = collectIdentityReferences(body);
  if (rawIdentities === undefined && refs.length === 0) return raw;

  const parsed = IdentitiesDeclSchema.safeParse(rawIdentities ?? {});
  if (!parsed.success) {
    throw new BlueprintIdentityError(
      'Blueprint identities block is invalid',
      parsed.error.issues.map((i) => ({
        path: i.path.length ? `identities.${i.path.join('.')}` : 'identities',
        message: i.message,
      })),
    );
  }
  const declared = parsed.data;

  const undeclared = refs.filter((name) => !(name in declared));
  if (undeclared.length) {
    throw new BlueprintIdentityError(
      `Blueprint references undeclared identities: ${undeclared.join(', ')}`,
      undeclared.map((name) => ({
        path: `identities.${name}`,
        message: `'\${{ identities.${name} }}' is referenced but not declared in the 'identities' block`,
      })),
    );
  }

  // Ensure-exist every DECLARED identity (idempotent by externalId) → id map.
  const idMap: Record<string, string> = {};
  for (const [name, decl] of Object.entries(declared)) {
    try {
      const id = await resolve(name, decl);
      if (typeof id !== 'string' || id.length === 0) {
        // Guard a misbehaving resolver — substituting undefined/'' would write the
        // literal "undefined"/"" into ownership fields silently.
        throw new Error(`resolver returned a non-string id (${JSON.stringify(id)})`);
      }
      idMap[name] = id;
    } catch (err) {
      throw new BlueprintIdentityError(
        `Failed to resolve identity '${name}' (${decl.kind} externalId=${decl.externalId}): ${
          err instanceof Error ? err.message : String(err)
        }`,
        [{ path: `identities.${name}`, message: err instanceof Error ? err.message : String(err) }],
      );
    }
  }

  return substitute(body, idMap);
}
