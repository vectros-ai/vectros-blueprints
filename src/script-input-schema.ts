/**
 * A script version's `inputSchema`: the small JSON Schema dialect the platform enforces on every call of the script. This
 * mirrors the platform's own check of a pushed schema, rule for rule and in the same order, so a blueprint is refused before
 * anything is sent; the platform checks it again and is the authority.
 *
 * The dialect: the root is `{ "type": "object", ... }`; any node carries `type` (`string`, `number`, `integer`, `boolean`,
 * `array`, `object`), and may carry `description` (at most 2,000 characters) and `enum` (1 to 100 distinct scalars of the
 * node's type); an `object` node may also carry `properties` (at most 100 members, each named 1 to 64 characters), `required`
 * (names it declares, each once) and `additionalProperties` (`true` or `false`); an `array` node may carry `items`. No other
 * keyword, at most 5 levels deep, at most 16,384 bytes as compact JSON.
 */

const MAX_BYTES = 16_384;
const MAX_DEPTH = 5;
const MAX_PROPERTIES = 100;
const MAX_ENUM = 100;
const MAX_DESCRIPTION_CHARS = 2_000;
const TYPES = ['array', 'boolean', 'integer', 'number', 'object', 'string'];
const COMMON = new Set(['type', 'description', 'enum']);
const OBJECT_ONLY = new Set(['properties', 'required', 'additionalProperties']);
const ARRAY_ONLY = new Set(['items']);

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function matchesType(type: string, v: unknown): boolean {
  if (typeof v === 'number' && !Number.isFinite(v)) return false;
  switch (type) {
    case 'string':
      return typeof v === 'string';
    case 'number':
      return typeof v === 'number';
    case 'integer':
      return typeof v === 'number' && Number.isInteger(v);
    case 'boolean':
      return typeof v === 'boolean';
    default:
      return false; // an enum value is a scalar: `array` and `object` nodes admit none
  }
}

function checkNode(node: unknown, path: string, depth: number): string | null {
  if (!isObject(node)) return `${path} must be an object.`;
  if (depth > MAX_DEPTH) return `${path} nests deeper than ${MAX_DEPTH} levels.`;
  const type = node.type;
  if (typeof type !== 'string' || !TYPES.includes(type)) return `${path}.type must be one of ${TYPES.join(', ')}.`;
  for (const k of Object.keys(node)) {
    const allowed = COMMON.has(k) || (type === 'object' && OBJECT_ONLY.has(k)) || (type === 'array' && ARRAY_ONLY.has(k));
    if (!allowed) return `${path} uses "${k}", which this schema dialect does not support.`;
  }
  const desc = node.description;
  if (desc !== undefined && (typeof desc !== 'string' || desc.length > MAX_DESCRIPTION_CHARS)) {
    return `${path}.description must be a string of at most ${MAX_DESCRIPTION_CHARS} characters.`;
  }
  const en = node.enum;
  if (en !== undefined) {
    if (!Array.isArray(en) || en.length === 0 || en.length > MAX_ENUM) return `${path}.enum must list 1 to ${MAX_ENUM} values.`;
    const seen = new Set<string>();
    for (const v of en) {
      if (!matchesType(type, v)) return `${path}.enum values must be ${type} values.`;
      const key = JSON.stringify(v);
      if (seen.has(key)) return `${path}.enum lists a value twice.`;
      seen.add(key);
    }
  }
  if (type === 'object') {
    const props = node.properties;
    const declared = new Set<string>();
    if (props !== undefined) {
      if (!isObject(props)) return `${path}.properties must be an object.`;
      const entries = Object.entries(props);
      if (entries.length > MAX_PROPERTIES) return `${path}.properties declares more than ${MAX_PROPERTIES} members.`;
      for (const [name, child] of entries) {
        if (name.length === 0 || name.length > 64) return `${path}.properties: a member name must be 1 to 64 characters.`;
        declared.add(name);
        const inner = checkNode(child, `${path}.properties.${name}`, depth + 1);
        if (inner !== null) return inner;
      }
    }
    const req = node.required;
    if (req !== undefined) {
      if (!Array.isArray(req)) return `${path}.required must be an array of member names.`;
      const seen = new Set<string>();
      for (const r of req) {
        if (typeof r !== 'string' || !declared.has(r)) return `${path}.required names a member its properties do not declare.`;
        if (seen.has(r)) return `${path}.required names a member twice.`;
        seen.add(r);
      }
    }
    const ap = node.additionalProperties;
    if (ap !== undefined && typeof ap !== 'boolean') return `${path}.additionalProperties must be true or false.`;
  }
  if (type === 'array' && node.items !== undefined) {
    const inner = checkNode(node.items, `${path}.items`, depth + 1);
    if (inner !== null) return inner;
  }
  return null;
}

/** The value as the request carries it: members set to `undefined` (possible in a blueprint written in code) are dropped. */
function asSent(value: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

/** Why the platform would refuse `schema` as a script version's `inputSchema`, or null when it accepts it. */
export function inputSchemaIssue(declared: unknown): string | null {
  if (!isObject(declared)) return 'inputSchema must be a JSON object.';
  const schema = asSent(declared);
  const bytes = new TextEncoder().encode(JSON.stringify(schema)).length;
  if (bytes > MAX_BYTES) return `inputSchema is too large (max ${MAX_BYTES} bytes).`;
  if (schema.type !== 'object') return 'inputSchema: the root must declare "type": "object".';
  return checkNode(schema, 'inputSchema', 1);
}

/**
 * The schema as the platform stores it: every `object` node that does not state `additionalProperties` gets `false` written in
 * (the enforced default). Comparing a declared schema to a stored one must compare this form, or an unchanged schema reads as a
 * change on every apply.
 */
export function storedInputSchemaForm(schema: Record<string, unknown>): Record<string, unknown> {
  const close = (node: unknown): unknown => {
    if (!isObject(node)) return node;
    const out: Record<string, unknown> = { ...node };
    if (out.type === 'object' && !('additionalProperties' in out)) out.additionalProperties = false;
    if (isObject(out.properties)) {
      out.properties = Object.fromEntries(Object.entries(out.properties).map(([k, v]) => [k, close(v)]));
    }
    if (out.items !== undefined) out.items = close(out.items);
    return out;
  };
  return close(asSent(schema)) as Record<string, unknown>;
}

/** Deep equality of two JSON values, with object members compared regardless of their order. */
export function sameJson(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => sameJson(v, b[i]));
  }
  if (isObject(a) || isObject(b)) {
    if (!isObject(a) || !isObject(b)) return false;
    // A member set to `undefined` is not sent, so it counts as absent.
    const ka = Object.keys(a).filter((k) => a[k] !== undefined);
    const kb = Object.keys(b).filter((k) => b[k] !== undefined);
    return ka.length === kb.length && ka.every((k) => b[k] !== undefined && sameJson(a[k], b[k]));
  }
  return a === b;
}
