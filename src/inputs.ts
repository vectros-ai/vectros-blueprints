/**
 * Blueprint variable substitution — the install-time resolver
 * (spec `blueprint-variable-substitution`).
 *
 * A blueprint can declare a top-level `inputs:` block and reference its values
 * (and a tiny reserved `vectros.*` built-in namespace) with GitHub-Actions-style
 * `${{ inputs.x }}` tokens in any STRING value. This module resolves those
 * tokens against supplied install-time values, BEFORE structural validation —
 * so the typed {@link Blueprint}, the loader, and bootstrap never see `inputs`
 * or an unresolved token. It is the FORMAT half of the feature: pure,
 * dependency-free (no node, no IO); the CLI owns YAML parsing + `--set`/`--values`.
 *
 * Two tiers — DO NOT conflate (spec §1):
 *   - install-time substitution (HERE): `${{ inputs.x }}`, `${{ vectros.* }}`,
 *     resolved by the trusted loader before any API call.
 *   - the runtime sentinel `$self` (agent-memory): a literal value the platform
 *     resolves per-principal at use. This resolver MUST leave `$self` and ANY
 *     `$`-prefixed value untouched — it only ever matches the `${{ … }}` form.
 *
 * Security (spec §3): pure string replacement, no eval/template engine → no
 * template injection. The scope gate (the CLI trust boundary) runs on the
 * RESOLVED document, so a parameter cannot smuggle a control-plane scope past
 * it. Built-ins are intentionally tiny (`context`, `suffix`) — see the
 * auto-binding invariant in the spec §4: data-record externalIds are bound to
 * `(tenant, context[, identity])` server-side, so they need no namespace; only
 * tenant-wide service-principal externalIds do, which is what `vectros.suffix`
 * is for.
 */
import { z } from 'zod';
import type { BlueprintIssue } from './types.js';

/** Allowed input names: identifier-like (so they read cleanly inside `${{ inputs.x }}`). */
const INPUT_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Scalar value types an input may declare / resolve to (V1 — no objects/arrays). */
export type InputScalar = string | number | boolean;

/** A single declared input (one entry under the top-level `inputs:` block). */
const InputDeclSchema = z
  .object({
    type: z.enum(['string', 'number', 'boolean']),
    required: z.boolean().optional(),
    default: z.union([z.string(), z.number(), z.boolean()]).optional(),
    description: z.string().optional(),
  })
  .strict();

/** The top-level `inputs:` declaration block — a map of name → declaration. */
export const InputsDeclSchema = z.record(InputDeclSchema);

export type InputDecl = z.infer<typeof InputDeclSchema>;
export type InputsDecl = z.infer<typeof InputsDeclSchema>;

/**
 * A variable-resolution failure (declaration, missing value, unknown reference,
 * malformed token). Carries structured {@link BlueprintIssue}s — same teach-by-error
 * `path: message` shape as {@link BlueprintValidationError}.
 */
export class BlueprintInputError extends Error {
  readonly issues: BlueprintIssue[];
  constructor(message: string, issues: BlueprintIssue[] = []) {
    super(message);
    this.name = 'BlueprintInputError';
    this.issues = issues;
  }
}

function renderIssues(issues: BlueprintIssue[]): string {
  return issues.map((i) => `  • ${i.path}: ${i.message}`).join('\n');
}

function scalarType(v: unknown): 'string' | 'number' | 'boolean' | 'other' {
  if (typeof v === 'string') return 'string';
  if (typeof v === 'number') return 'number';
  if (typeof v === 'boolean') return 'boolean';
  return 'other';
}

/**
 * A short, STABLE, non-cryptographic token derived from the install context id.
 * FNV-1a (32-bit) → base36. Deterministic: same contextId ⇒ same suffix ⇒
 * idempotent re-installs (matches the seeding-and-idempotency upsert contract).
 * Used ONLY to namespace tenant-wide service-principal externalIds so two
 * installs of one blueprint in the same tenant (different contexts) don't
 * collide. Not security-sensitive.
 */
export function deriveSuffix(contextId: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < contextId.length; i++) {
    h ^= contextId.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36).padStart(7, '0');
}

interface ResolveCtx {
  declared: InputsDecl;
  /** Resolved input values, by name (absent = declared but has no value). */
  values: Record<string, InputScalar>;
  /** Built-ins, or undefined when contextId is not a usable literal. */
  builtins?: { context: string; suffix: string };
  issues: BlueprintIssue[];
}

/** Matches a string that is EXACTLY one `${{ ns.name }}` token (→ type-coerced value). */
const WHOLE_TOKEN_RE = /^\$\{\{\s*([A-Za-z_]\w*)\.([A-Za-z_]\w*)\s*\}\}$/;
/**
 * General scan, ordered alternation (longest/most-specific first):
 *   1. `$${{`              the escape → literal `${{`
 *   2. `${{ … }}`          a complete token (inner validated separately)
 *   3. `${{`               a DANGLING opener with no close → reported, never silent
 */
const TOKEN_SCAN_RE = /\$\$\{\{|\$\{\{([\s\S]*?)\}\}|\$\{\{/g;
/** A valid inner reference body once trimmed: `namespace.name`. */
const INNER_REF_RE = /^([A-Za-z_]\w*)\.([A-Za-z_]\w*)$/;

/**
 * Namespaces this INSTALL-TIME resolver deliberately leaves UNRESOLVED — their
 * `${{ ns.x }}` tokens are re-emitted literally so a later pass / the platform
 * resolves them. `self` is the RUNTIME per-principal sentinel (platform-resolved
 * per request; a top-level lint in types.ts confines it to role
 * dataScope). `identities` is the creds-bearing APPLY-time namespace — its tokens
 * resolve to a principal id in a later pass (resolveBlueprintIdentities), so the
 * install-time resolver leaves them literal too. A deferred token is NOT an
 * "unknown namespace" error — distinct from `$`-prefixed values, which are never
 * matched by the `${{ … }}` scanner at all.
 */
const DEFERRED_NAMESPACES = new Set(['self', 'identities']);

/** Resolve one `ns.name` reference to its value, or push an issue + return undefined. */
function resolveRef(ns: string, name: string, ctx: ResolveCtx, path: string): InputScalar | undefined {
  if (ns === 'inputs') {
    if (!(name in ctx.declared)) {
      ctx.issues.push({
        path,
        message: `unknown input 'inputs.${name}' — declare it in the top-level 'inputs:' block`,
      });
      return undefined;
    }
    if (!(name in ctx.values)) {
      ctx.issues.push({
        path,
        message: `input 'inputs.${name}' has no value — supply it (--set ${name}=… or --values) or give it a default`,
      });
      return undefined;
    }
    return ctx.values[name];
  }
  if (ns === 'vectros') {
    if (name !== 'context' && name !== 'suffix') {
      ctx.issues.push({
        path,
        message: `unknown built-in 'vectros.${name}' (available: vectros.context, vectros.suffix)`,
      });
      return undefined;
    }
    if (!ctx.builtins) {
      ctx.issues.push({
        path,
        message: `'vectros.${name}' is unavailable: contextId must be a literal string to derive built-ins`,
      });
      return undefined;
    }
    return ctx.builtins[name];
  }
  ctx.issues.push({
    path,
    message: `unknown namespace '${ns}' in '\${{ ${ns}.${name} }}' (available: inputs, vectros)`,
  });
  return undefined;
}

/** Interpolate every token in a multi-token / embedded string → a STRING result. */
function interpolate(str: string, ctx: ResolveCtx, path: string): string {
  let out = '';
  let last = 0;
  TOKEN_SCAN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TOKEN_SCAN_RE.exec(str)) !== null) {
    out += str.slice(last, m.index);
    if (m[0] === '$${{') {
      out += '${{'; // escape → literal
    } else if (m[0] === '${{' && m[1] === undefined) {
      // Dangling opener (alternative 3): no closing `}}`. Report, don't drop.
      ctx.issues.push({
        path,
        message: `unterminated token '\${{' — expected a closing '}}' (escape a literal with '$\${{')`,
      });
    } else {
      const inner = (m[1] ?? '').trim();
      const ref = inner.match(INNER_REF_RE);
      if (!ref) {
        ctx.issues.push({
          path,
          message: `malformed reference '\${{ ${inner} }}' — expected '\${{ namespace.name }}' (escape a literal with '$\${{')`,
        });
      } else if (DEFERRED_NAMESPACES.has(ref[1])) {
        out += m[0]; // deferred namespace → re-emit the token verbatim (resolved later)
      } else {
        const v = resolveRef(ref[1], ref[2], ctx, path);
        if (v !== undefined) out += String(v);
      }
    }
    last = TOKEN_SCAN_RE.lastIndex;
  }
  out += str.slice(last);
  return out;
}

/** Recursively substitute tokens through the document tree (values only, not keys). */
function substituteValue(val: unknown, ctx: ResolveCtx, path: string): unknown {
  if (typeof val === 'string') {
    const whole = val.match(WHOLE_TOKEN_RE);
    if (whole) {
      // A deferred namespace (e.g. self.*) is left literal for a later pass.
      if (DEFERRED_NAMESPACES.has(whole[1])) return val;
      // Exactly one token → return the TYPED value (so a boolean input stays a
      // boolean, not the string "true"). undefined (on error) collapses to the
      // raw string so the doc stays parseable for downstream issue reporting.
      const v = resolveRef(whole[1], whole[2], ctx, path);
      return v === undefined ? val : v;
    }
    return interpolate(val, ctx, path);
  }
  if (Array.isArray(val)) {
    return val.map((v, i) => substituteValue(v, ctx, `${path}[${i}]`));
  }
  if (val !== null && typeof val === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
      out[k] = substituteValue(v, ctx, path ? `${path}.${k}` : k);
    }
    return out;
  }
  return val;
}

/** Coerce a supplied value (string from `--set`, typed from a `--values` file) to the declared type. */
function coerce(raw: unknown, type: InputDecl['type'], name: string, issues: BlueprintIssue[]): InputScalar | undefined {
  const path = `inputs.${name}`;
  if (type === 'string') {
    if (typeof raw === 'string') return raw;
    if (typeof raw === 'number' || typeof raw === 'boolean') return String(raw);
    issues.push({ path, message: `expected a string value` });
    return undefined;
  }
  if (type === 'number') {
    if (typeof raw === 'number') return raw;
    if (typeof raw === 'string') {
      const n = Number(raw.trim());
      if (raw.trim() === '' || Number.isNaN(n)) {
        issues.push({ path, message: `expected a number, got '${raw}'` });
        return undefined;
      }
      return n;
    }
    issues.push({ path, message: `expected a number` });
    return undefined;
  }
  // boolean
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'string') {
    const t = raw.trim().toLowerCase();
    if (t === 'true') return true;
    if (t === 'false') return false;
    issues.push({ path, message: `expected a boolean ('true'|'false'), got '${raw}'` });
    return undefined;
  }
  issues.push({ path, message: `expected a boolean` });
  return undefined;
}

/** Build the resolved-values map from declarations + supplied values (precedence handled by the caller). */
function resolveValues(
  declared: InputsDecl,
  supplied: Record<string, unknown>,
  issues: BlueprintIssue[],
): Record<string, InputScalar> {
  const values: Record<string, InputScalar> = {};

  // Reject supplied values that aren't declared (typo / stale --set).
  for (const k of Object.keys(supplied)) {
    if (!(k in declared)) {
      issues.push({ path: `inputs.${k}`, message: `no input named '${k}' is declared (cannot set it)` });
    }
  }

  for (const [name, decl] of Object.entries(declared)) {
    if (name in supplied) {
      const c = coerce(supplied[name], decl.type, name, issues);
      if (c !== undefined) values[name] = c;
    } else if (decl.default !== undefined) {
      values[name] = decl.default;
    } else if (decl.required) {
      issues.push({
        path: `inputs.${name}`,
        message: `required input '${name}' was not supplied (--set ${name}=… or in --values)`,
      });
    }
    // else: optional with no default → no value; a reference to it errors at use.
  }
  return values;
}

/**
 * Resolve a blueprint's `inputs:` variables against supplied install-time
 * values and return the substituted document tree WITH the `inputs:` block
 * stripped — ready for {@link parseBlueprint}. Throws {@link BlueprintInputError}
 * (with structured `.issues`) on any declaration / value / reference problem.
 *
 * `supplied` is the merged value map (the CLI applies `--set` > `--values` >
 * declared `default` precedence before calling this; declared defaults are
 * applied here). A blueprint with no `inputs:` block and no `${{ … }}` tokens
 * passes through unchanged (back-compat) — but a stray `${{ … }}` or an unknown
 * reference is still reported (never silently empty).
 *
 * Built-ins are derived from the document's LITERAL `contextId` (it cannot
 * itself use `${{ … }}` — it is the source of `vectros.*`).
 */
export function resolveBlueprintInputs(raw: unknown, supplied: Record<string, unknown> = {}): unknown {
  // Not an object → not a blueprint shape; let parseBlueprint produce the
  // structural error. (Supplying values here would be meaningless.)
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return raw;

  const issues: BlueprintIssue[] = [];
  const { inputs: rawInputs, ...body } = raw as Record<string, unknown> & { inputs?: unknown };

  // 1. Validate the inputs declaration block (if present).
  let declared: InputsDecl = {};
  if (rawInputs !== undefined) {
    const parsed = InputsDeclSchema.safeParse(rawInputs);
    if (!parsed.success) {
      for (const i of parsed.error.issues) {
        const p = i.path.length ? `inputs.${i.path.join('.')}` : 'inputs';
        issues.push({ path: p, message: i.message });
      }
    } else {
      declared = parsed.data;
      for (const [name, decl] of Object.entries(declared)) {
        if (!INPUT_NAME_RE.test(name)) {
          issues.push({
            path: `inputs.${name}`,
            message: `invalid input name '${name}' — letters/digits/underscore, not starting with a digit`,
          });
        }
        if (decl.default !== undefined && scalarType(decl.default) !== decl.type) {
          issues.push({
            path: `inputs.${name}.default`,
            message: `default is a ${scalarType(decl.default)} but the declared type is '${decl.type}'`,
          });
        }
      }
    }
  }

  // 2. Derive built-ins from the LITERAL contextId.
  let builtins: { context: string; suffix: string } | undefined;
  const ctxId = (body as Record<string, unknown>).contextId;
  if (typeof ctxId === 'string' && ctxId.length > 0) {
    if (ctxId.includes('${{')) {
      issues.push({
        path: 'contextId',
        message: `contextId must be a literal — it cannot use '\${{ … }}' (it is the source of vectros.* built-ins)`,
      });
    } else {
      builtins = { context: ctxId, suffix: deriveSuffix(ctxId) };
    }
  }
  // contextId missing / non-string → builtins stay undefined; parseBlueprint
  // separately reports the missing/invalid contextId.

  // 3. Resolve values, then substitute through the body.
  const values = resolveValues(declared, supplied, issues);
  const ctx: ResolveCtx = { declared, values, builtins, issues };
  const substituted = substituteValue(body, ctx, '');

  if (issues.length) {
    throw new BlueprintInputError(`Blueprint variable resolution failed:\n${renderIssues(issues)}`, issues);
  }
  return substituted;
}
