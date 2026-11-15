/**
 * Composing one blueprint from several files.
 *
 * A root blueprint file may list part files under `include:`. A part is a
 * partial blueprint that declares only collections (schemas, roles, triggers,
 * and so on). The root alone declares the blueprint's identity and the grants
 * it carries (`name`, `contextId`, `servicePrincipal`, `accessProfile`, ...),
 * so a reviewer always finds those in one place.
 *
 * Composition never overrides. A list entry or map key declared in two files
 * is an error naming both places, so a role, schema or trigger is always
 * written in exactly one file and reading that file is reading all of it.
 *
 * A root may also group its parts into named `stacks:`. A stack is a subset of
 * the blueprint that can be applied on its own; this module only records
 * which resources each stack declares. Every apply still validates the whole
 * composed blueprint.
 *
 * This module is pure: the caller reads the files, expands the include
 * patterns, and supplies a line locator per file. The composed document is
 * then resolved and parsed exactly as a single-file blueprint is.
 */
import { BlueprintValidationError, displaySafe, type BlueprintIssue } from './types.js';

/** The top-level keys a part file may declare. */
export const BLUEPRINT_PART_KEYS = [
  'schemas',
  'roles',
  'roleAssumable',
  'fragments',
  'identities',
  'issuers',
  'namespaces',
  'scripts',
  'triggers',
  'agents',
  'seed',
] as const;

export type BlueprintPartKey = (typeof BLUEPRINT_PART_KEYS)[number];

/** The keys only the root file may declare. A part declaring one is refused. */
export const BLUEPRINT_ROOT_ONLY_KEYS = [
  'name',
  'version',
  'description',
  'contextId',
  'contextName',
  'companyName',
  'servicePrincipal',
  'accessProfile',
  'identityProjectionClaims',
  'formatVersion',
  'inputs',
  'include',
  'stacks',
] as const;

/** The stack that holds what the root file itself declares, including its access profile. */
export const ROOT_STACK = 'root';

const STACK_NAME_RE = /^[a-z][a-z0-9-]{0,62}$/;

/** List-valued part keys, and the field that names an entry for duplicate detection. */
const LIST_IDENTITY: Record<'schemas' | 'issuers' | 'namespaces' | 'seed', (entry: unknown) => string | undefined> = {
  schemas: (e) => stringField(e, 'typeName'),
  issuers: (e) => stringField(e, 'issuerId'),
  namespaces: (e) => stringField(e, 'namespace'),
  seed: (e) => {
    const typeName = stringField(e, 'typeName');
    const externalId = stringField(e, 'externalId');
    return typeName !== undefined && externalId !== undefined ? `${typeName}/${externalId}` : undefined;
  },
};

type ListKey = keyof typeof LIST_IDENTITY;

function isListKey(key: BlueprintPartKey): key is ListKey {
  return key in LIST_IDENTITY;
}

function stringField(entry: unknown, field: string): string | undefined {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return undefined;
  const v = (entry as Record<string, unknown>)[field];
  return typeof v === 'string' ? v : undefined;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** One file of a blueprint bundle, already parsed. */
export interface BlueprintSource {
  /** The path shown in messages, relative to the root file's directory for a part. */
  path: string;
  /** The parsed YAML or JSON document. */
  document: unknown;
  /**
   * The 1-based line of the deepest node along `path` that exists in this file's
   * document, or `undefined` when even the first segment is absent. Optional: a
   * source without one reports its path without a line.
   */
  lineOf?: (path: ReadonlyArray<string | number>) => number | undefined;
}

/** The `include:` and `stacks:` keys of a root document, before any pattern is expanded. */
export interface BlueprintIncludeDirective {
  include: string[];
  /** Stack name to its include patterns, in declaration order. Absent when the root declares no stacks. */
  stacks?: Record<string, string[]>;
}

/** Thrown when a bundle cannot be composed. A subclass of the validation error, so every caller that reports one reports this. */
export class BlueprintCompositionError extends BlueprintValidationError {
  constructor(message: string, issues: BlueprintIssue[] = []) {
    super(message, issues);
    this.name = 'BlueprintCompositionError';
  }
}

function fail(message: string): never {
  throw new BlueprintCompositionError(message);
}

/**
 * The `include:`/`stacks:` directive of a root document, validated for shape only. Returns
 * `undefined` when the document declares neither key: such a file is a single-file blueprint and
 * takes exactly the path it always did.
 */
export function readIncludeDirective(root: unknown): BlueprintIncludeDirective | undefined {
  if (!isPlainObject(root)) return undefined;
  const hasInclude = Object.prototype.hasOwnProperty.call(root, 'include');
  const hasStacks = Object.prototype.hasOwnProperty.call(root, 'stacks');
  // No `include:` is a single-file blueprint, read exactly as before: a stray `stacks:` is refused there by the
  // structural validation, as any unknown key always was.
  if (!hasInclude) return undefined;
  const include = root.include;
  if (!Array.isArray(include) || include.length === 0 || !include.every((p) => typeof p === 'string' && p.length > 0)) {
    fail("'include' must be a non-empty list of part file paths or patterns (for example 'schemas/*.part.yaml').");
  }
  if (!hasStacks) return { include: [...include] };
  const stacksRaw = root.stacks;
  if (!isPlainObject(stacksRaw) || Object.keys(stacksRaw).length === 0) {
    fail("'stacks' must map each stack name to a list of part file paths or patterns.");
  }
  const stacks: Record<string, string[]> = {};
  for (const [name, patterns] of Object.entries(stacksRaw)) {
    if (!STACK_NAME_RE.test(name)) {
      fail(
        `stack name '${displaySafe(name, 80)}' is not valid: use lowercase letters, digits and dashes, starting with a letter.`,
      );
    }
    if (name === ROOT_STACK) {
      fail(`'${ROOT_STACK}' is reserved for what the root file itself declares; give this stack another name.`);
    }
    if (!Array.isArray(patterns) || patterns.length === 0 || !patterns.every((p) => typeof p === 'string' && p.length > 0)) {
      fail(`stack '${name}' must list at least one part file path or pattern.`);
    }
    stacks[name] = [...patterns];
  }
  return { include: [...include], stacks };
}

/** What one stack declares, by resource kind and name. `seed` holds indexes into the composed `seed` list. */
export interface StackContents {
  schemas: Set<string>;
  roles: Set<string>;
  roleAssumable: Set<string>;
  fragments: Set<string>;
  identities: Set<string>;
  issuers: Set<string>;
  namespaces: Set<string>;
  scripts: Set<string>;
  triggers: Set<string>;
  agents: Set<string>;
  seed: Set<number>;
  /** The files of this stack, in composition order. */
  files: string[];
}

function emptyStack(): StackContents {
  return {
    schemas: new Set(),
    roles: new Set(),
    roleAssumable: new Set(),
    fragments: new Set(),
    identities: new Set(),
    issuers: new Set(),
    namespaces: new Set(),
    scripts: new Set(),
    triggers: new Set(),
    agents: new Set(),
    seed: new Set(),
    files: [],
  };
}

/** Where one top-level entry of the composed document came from. */
interface EntryOrigin {
  source: BlueprintSource;
  /** The entry's own key in its file: a list index there, or the map key. */
  localKey: string | number;
}

/** The result of {@link composeBlueprint}. */
export interface ComposedBlueprint {
  /** The single document the bundle stands for, with `include` and `stacks` removed. */
  document: Record<string, unknown>;
  /** Every file, root first, in composition order. */
  files: string[];
  /** Each stack's contents, including {@link ROOT_STACK}. Present only when the root declares `stacks`. */
  stacks?: Record<string, StackContents>;
  /**
   * `file:line` (or `file`) for a path into the composed document, such as an issue path
   * `schemas[7].fields[2]`. Undefined when the path names nothing a file declared.
   */
  locate(path: string | ReadonlyArray<string | number>): string | undefined;
  /**
   * `file:line` for the first resource a message names, as in `role 'vendor-admin' clause 0` or
   * `schema 'invoice': ...`. Undefined when the message names no declared resource.
   */
  declaredAt(text: string): string | undefined;
}

function describe(source: BlueprintSource, path: ReadonlyArray<string | number>): string {
  const line = source.lineOf?.(path);
  return line === undefined ? displaySafe(source.path) : `${displaySafe(source.path)}:${line}`;
}

/**
 * Compose a root document and its parts into one document.
 *
 * `parts` are in include order (each pattern's matches already sorted by the caller). `stackFiles`,
 * when the root declares stacks, maps each stack name to the paths of the parts it covers; every
 * part must be covered by exactly one stack.
 *
 * Root entries come first, then each part's, in order. Nothing is overridden: an entry declared
 * twice, in two files or in one, is refused with both locations.
 *
 * Every field that names a resource or refers to one (a schema `typeName`, a trigger's `schemaName`,
 * a role id in `roleIds`, and the like) must be literal in a split blueprint: duplicates and stack
 * membership are decided by those names here, before inputs are resolved, so a `${{ ... }}` there
 * could hide a duplicate or move a resource out of its stack.
 *
 * With stacks, a fragment must be in the same stack as every role that uses it, and a `roleAssumable`
 * entry in the same stack as its role: both are written as part of the role, so declaring them in
 * another stack would make that stack's apply change nothing and the role's stack write them.
 */
export function composeBlueprint(
  root: BlueprintSource,
  parts: ReadonlyArray<BlueprintSource>,
  stackFiles?: Readonly<Record<string, ReadonlyArray<string>>>,
): ComposedBlueprint {
  if (!isPlainObject(root.document)) fail(`'${displaySafe(root.path)}' must be a blueprint object.`);

  const seenFiles = new Set<string>();
  for (const part of parts) {
    if (seenFiles.has(part.path)) fail(`'${displaySafe(part.path)}' is included more than once.`);
    seenFiles.add(part.path);
  }

  const stackOfFile = new Map<string, string>();
  let stacks: Record<string, StackContents> | undefined;
  if (stackFiles) {
    stacks = { [ROOT_STACK]: emptyStack() };
    stacks[ROOT_STACK].files.push(root.path);
    for (const [name, files] of Object.entries(stackFiles)) {
      if (name === ROOT_STACK || !STACK_NAME_RE.test(name)) {
        fail(`stack name '${displaySafe(name, 80)}' is reserved or not valid.`);
      }
      stacks[name] = emptyStack();
      for (const file of files) {
        if (!seenFiles.has(file)) {
          fail(`stack '${name}' lists '${displaySafe(file)}', which is not one of the files under 'include'.`);
        }
        const other = stackOfFile.get(file);
        if (other !== undefined && other !== name) {
          fail(`'${displaySafe(file)}' belongs to two stacks, '${other}' and '${name}'; a part file belongs to exactly one.`);
        }
        stackOfFile.set(file, name);
      }
    }
    const uncovered = parts.filter((p) => !stackOfFile.has(p.path)).map((p) => `'${displaySafe(p.path)}'`);
    if (uncovered.length > 0) {
      fail(`every included file must belong to a stack when 'stacks' is declared; not covered: ${uncovered.join(', ')}.`);
    }
  }

  const document: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(root.document)) {
    if (key === 'include' || key === 'stacks') continue;
    // A section the parts add to is copied, so composing never changes the caller's root document.
    Object.defineProperty(document, key, {
      value: Array.isArray(value) ? [...value] : isPlainObject(value) ? { ...value } : value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }

  const listOrigins: Partial<Record<ListKey, EntryOrigin[]>> = {};
  const mapOrigins: Partial<Record<BlueprintPartKey, Map<string, EntryOrigin>>> = {};
  const listNames: Partial<Record<ListKey, Map<string, EntryOrigin>>> = {};

  const absorb = (source: BlueprintSource, isRoot: boolean): void => {
    const doc = source.document as Record<string, unknown>;
    const stackName = isRoot ? ROOT_STACK : stackOfFile.get(source.path);
    const stack = stacks && stackName !== undefined ? stacks[stackName] : undefined;
    if (stack && !isRoot) stack.files.push(source.path);
    for (const key of BLUEPRINT_PART_KEYS) {
      if (!Object.prototype.hasOwnProperty.call(doc, key)) continue;
      const value = doc[key];
      if (isListKey(key)) {
        if (!Array.isArray(value)) {
          fail(`${describe(source, [key])}: '${key}' must be a list.`);
        }
        const origins = (listOrigins[key] ??= []);
        const names = (listNames[key] ??= new Map());
        const target = (document[key] as unknown[] | undefined) ?? [];
        value.forEach((entry, localIndex) => {
          const name = LIST_IDENTITY[key](entry);
          if (name !== undefined) {
            const first = names.get(name);
            if (first !== undefined) {
              fail(
                `${key} entry '${displaySafe(name, 120)}' is declared twice: ` +
                  `${describe(first.source, [key, first.localKey])} and ${describe(source, [key, localIndex])}. ` +
                  `Declare it in one file only.`,
              );
            }
            if (first === undefined) names.set(name, { source, localKey: localIndex });
          }
          const composedIndex = origins.length;
          origins.push({ source, localKey: localIndex });
          if (!isRoot) target.push(entry);
          if (stack) {
            if (key === 'seed') stack.seed.add(composedIndex);
            else if (name !== undefined) stack[key].add(name);
          }
        });
        if (!isRoot) document[key] = target;
      } else {
        if (!isPlainObject(value)) {
          fail(`${describe(source, [key])}: '${key}' must be a map of names to definitions.`);
        }
        const origins = (mapOrigins[key] ??= new Map());
        const target = (document[key] as Record<string, unknown> | undefined) ?? {};
        for (const [name, entry] of Object.entries(value)) {
          const first = origins.get(name);
          if (first !== undefined) {
            fail(
              `${key} entry '${displaySafe(name, 120)}' is declared twice: ` +
                `${describe(first.source, [key, name])} and ${describe(source, [key, name])}. ` +
                `Declare it in one file only.`,
            );
          }
          origins.set(name, { source, localKey: name });
          // Defined, not assigned: a key such as `__proto__` is an ordinary entry, never the target's prototype.
          if (!isRoot) Object.defineProperty(target, name, { value: entry, enumerable: true, writable: true, configurable: true });
          if (stack) stack[key].add(name);
        }
        if (!isRoot) document[key] = target;
      }
    }
  };

  absorb(root, true);
  for (const part of parts) {
    if (!isPlainObject(part.document)) {
      fail(`'${displaySafe(part.path)}' must be a map of blueprint sections (for example 'schemas:' or 'roles:').`);
    }
    for (const key of Object.keys(part.document)) {
      if ((BLUEPRINT_ROOT_ONLY_KEYS as readonly string[]).includes(key)) {
        const where = describe(part, [key]);
        fail(
          key === 'include' || key === 'stacks'
            ? `${where}: a part file cannot declare '${key}'; only the root file lists parts and stacks.`
            : `${where}: '${key}' can only be declared in the root file, so a blueprint's identity and grants stay in one place.`,
        );
      }
      if (!(BLUEPRINT_PART_KEYS as readonly string[]).includes(key)) {
        fail(
          `${describe(part, [key])}: '${displaySafe(key, 80)}' is not a section a part file can declare. ` +
            `A part may declare: ${BLUEPRINT_PART_KEYS.join(', ')}.`,
        );
      }
    }
    absorb(part, false);
  }

  const sourceOf = (segments: ReadonlyArray<string | number>): { origin: EntryOrigin; rest: Array<string | number> } | undefined => {
    const [key, entryKey, ...rest] = segments;
    if (typeof key !== 'string' || entryKey === undefined) return undefined;
    if ((BLUEPRINT_PART_KEYS as readonly string[]).includes(key)) {
      const partKey = key as BlueprintPartKey;
      if (isListKey(partKey)) {
        if (typeof entryKey !== 'number') return undefined;
        const origin = listOrigins[partKey]?.[entryKey];
        return origin ? { origin, rest } : undefined;
      }
      const origin = mapOrigins[partKey]?.get(String(entryKey));
      return origin ? { origin, rest } : undefined;
    }
    return undefined;
  };

  const locate = (path: string | ReadonlyArray<string | number>): string | undefined => {
    const segments = typeof path === 'string' ? parseIssuePath(path) : path;
    if (segments.length === 0) return undefined;
    const found = sourceOf(segments);
    if (found) {
      return describe(found.origin.source, [segments[0] as string, found.origin.localKey, ...found.rest]);
    }
    const top = segments[0];
    const namesAnEntry = segments.length > 1 && (BLUEPRINT_PART_KEYS as readonly string[]).includes(String(top));
    if (!namesAnEntry && typeof top === 'string' && Object.prototype.hasOwnProperty.call(root.document, top)) {
      return describe(root, segments);
    }
    return undefined;
  };

  const declaredAt = (text: string): string | undefined => {
    const match = DECLARED_RE.exec(text);
    if (!match) return undefined;
    const [, kind, name] = match;
    const key = KIND_TO_KEY[kind];
    if (isListKey(key)) {
      const origin = listNames[key]?.get(name);
      return origin ? describe(origin.source, [key, origin.localKey]) : undefined;
    }
    const origin = mapOrigins[key]?.get(name);
    return origin ? describe(origin.source, [key, name]) : undefined;
  };

  const located = (path: Array<string | number>): string => locate(path) ?? displaySafe(root.path);

  for (const [path, value] of namingFields(document)) {
    if (typeof value === 'string' && value.includes('${{')) {
      fail(
        `${located(path)}: '${path.join('.')}' names a resource, so it must be written out in a split blueprint, ` +
          `not taken from '\${{ ... }}': duplicates and stacks are decided by these names before inputs are resolved.`,
      );
    }
  }

  if (stacks) {
    const stackOf = (key: 'roles' | 'fragments' | 'roleAssumable', name: string): string | undefined =>
      Object.entries(stacks!).find(([, s]) => s[key].has(name))?.[0];
    for (const [roleId, clauses] of Object.entries((document.roles as Record<string, unknown> | undefined) ?? {})) {
      const roleStack = stackOf('roles', roleId);
      if (!Array.isArray(clauses)) continue;
      clauses.forEach((clause, i) => {
        const ref = stringField(clause, 'dataScopeRef');
        if (ref === undefined) return;
        const fragmentStack = stackOf('fragments', ref);
        if (fragmentStack !== undefined && fragmentStack !== roleStack) {
          fail(
            `${located(['roles', roleId, i, 'dataScopeRef'])}: role '${displaySafe(roleId, 120)}' (stack '${roleStack}') uses fragment ` +
              `'${displaySafe(ref, 120)}' from stack '${fragmentStack}' (${located(['fragments', ref])}). A fragment is written as part ` +
              `of the roles that use it, so it must be in the same stack as each of them: move it, or give each stack its own.`,
          );
        }
      });
    }
    for (const roleId of Object.keys((document.roleAssumable as Record<string, unknown> | undefined) ?? {})) {
      const roleStack = stackOf('roles', roleId);
      const entryStack = stackOf('roleAssumable', roleId);
      if (roleStack !== undefined && roleStack !== entryStack) {
        fail(
          `${located(['roleAssumable', roleId])}: the roleAssumable entry for role '${displaySafe(roleId, 120)}' is in stack ` +
            `'${entryStack}', but the role is in stack '${roleStack}' (${located(['roles', roleId])}). It is written with the ` +
            `role, so declare it in the same stack.`,
        );
      }
    }
  }

  return {
    document,
    files: [root.path, ...parts.map((p) => p.path)],
    ...(stacks ? { stacks } : {}),
    locate,
    declaredAt,
  };
}

/**
 * Every field of a composed document that names a resource or refers to one by name, with its path.
 * These must be literal in a split blueprint (see {@link composeBlueprint}).
 *
 * A new field that refers to a resource by name belongs here, and in the CLI's cross-stack dependency
 * check, at the same time: a reference left out of either is one a stack apply cannot see.
 */
function namingFields(doc: Record<string, unknown>): Array<[Array<string | number>, unknown]> {
  const out: Array<[Array<string | number>, unknown]> = [];
  const list = (key: string): unknown[] => (Array.isArray(doc[key]) ? (doc[key] as unknown[]) : []);
  const map = (key: string): Record<string, unknown> => (isPlainObject(doc[key]) ? (doc[key] as Record<string, unknown>) : {});
  const at = (v: unknown, ...keys: string[]): unknown =>
    keys.reduce<unknown>((o, k) => (isPlainObject(o) ? o[k] : undefined), v);
  const each = (v: unknown, path: Array<string | number>): void => {
    if (Array.isArray(v)) v.forEach((x, i) => out.push([[...path, i], x]));
  };
  list('schemas').forEach((s, i) => {
    out.push([['schemas', i, 'typeName'], at(s, 'typeName')]);
    // A public view's `ownedBy` names the namespaces its ownership is read from (`scope:<ns>`), a stack dependency.
    each(at(s, 'publicView', 'ownedBy'), ['schemas', i, 'publicView', 'ownedBy']);
    const fields = at(s, 'fields');
    if (Array.isArray(fields)) {
      fields.forEach((f, j) => {
        out.push([['schemas', i, 'fields', j, 'targetTypeName'], at(f, 'targetTypeName')]);
        each(at(f, 'documentTypes'), ['schemas', i, 'fields', j, 'documentTypes']);
      });
    }
  });
  list('issuers').forEach((iss, i) => {
    out.push([['issuers', i, 'issuerId'], at(iss, 'issuerId')]);
    const policies = at(iss, 'selfSignupPolicies');
    if (Array.isArray(policies)) {
      policies.forEach((p, j) => {
        out.push([['issuers', i, 'selfSignupPolicies', j, 'roleId'], at(p, 'roleId')]);
        each(at(p, 'additionalRoleIds'), ['issuers', i, 'selfSignupPolicies', j, 'additionalRoleIds']);
      });
    }
  });
  list('namespaces').forEach((n, i) => out.push([['namespaces', i, 'namespace'], at(n, 'namespace')]));
  list('seed').forEach((r, i) => {
    out.push([['seed', i, 'typeName'], at(r, 'typeName')]);
    out.push([['seed', i, 'externalId'], at(r, 'externalId')]);
  });
  for (const [name, t] of Object.entries(map('triggers'))) {
    out.push([['triggers', name, 'firingSource', 'schemaName'], at(t, 'firingSource', 'schemaName')]);
    out.push([['triggers', name, 'scriptRef', 'name'], at(t, 'scriptRef', 'name')]);
    each(at(t, 'roleIds'), ['triggers', name, 'roleIds']);
  }
  for (const [name, clauses] of Object.entries(map('roles'))) {
    if (!Array.isArray(clauses)) continue;
    clauses.forEach((c, i) => {
      out.push([['roles', name, i, 'dataScopeRef'], at(c, 'dataScopeRef')]);
      each(at(c, 'assignableRoles'), ['roles', name, i, 'assignableRoles']);
    });
  }
  for (const [name, decl] of Object.entries(map('identities'))) out.push([['identities', name, 'kind'], at(decl, 'kind')]);
  for (const [name, agent] of Object.entries(map('agents'))) {
    const tools = at(agent, 'tools');
    if (Array.isArray(tools)) tools.forEach((tool, i) => out.push([['agents', name, 'tools', i, 'script', 'name'], at(tool, 'script', 'name')]));
  }
  each(at(doc, 'accessProfile', 'roleIds'), ['accessProfile', 'roleIds']);
  each(at(doc, 'accessProfile', 'assignableRoles'), ['accessProfile', 'assignableRoles']);
  return out;
}

const KIND_TO_KEY: Record<string, BlueprintPartKey> = {
  schema: 'schemas',
  role: 'roles',
  trigger: 'triggers',
  script: 'scripts',
  agent: 'agents',
  namespace: 'namespaces',
  issuer: 'issuers',
  identity: 'identities',
  fragment: 'fragments',
};

const DECLARED_RE = /\b(schema|role|trigger|script|agent|namespace|issuer|identity|fragment) '([^']+)'/;

/**
 * Split an issue path such as `schemas[7].fields[2].fieldType` or `roles.vendor-admin[0]` into
 * segments. A map key containing `.` or `[` cannot be told apart from structure, so such a path
 * locates only as deep as it can be read unambiguously.
 */
export function parseIssuePath(path: string): Array<string | number> {
  const out: Array<string | number> = [];
  const re = /([^.[\]]+)|\[(\d+)\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(path)) !== null) {
    if (m[1] !== undefined) out.push(m[1]);
    else out.push(Number(m[2]));
  }
  return out;
}

/** A stack selection's contents merged, for an apply of several stacks at once. */
export function mergeStacks(stacks: Record<string, StackContents>, names: ReadonlyArray<string>): StackContents {
  const merged = emptyStack();
  for (const name of names) {
    const s = Object.prototype.hasOwnProperty.call(stacks, name) ? stacks[name] : undefined;
    if (!s) {
      const known = Object.keys(stacks).map((k) => `'${k}'`).join(', ');
      fail(`unknown stack '${displaySafe(name, 80)}'. This blueprint declares: ${known}.`);
    }
    for (const key of [...BLUEPRINT_PART_KEYS.filter((k) => k !== 'seed')] as Array<Exclude<BlueprintPartKey, 'seed'>>) {
      for (const v of s[key]) merged[key].add(v);
    }
    for (const i of s.seed) merged.seed.add(i);
    merged.files.push(...s.files);
  }
  return merged;
}
