/**
 * A public-media document type (`fileProfile: 'PUBLIC_MEDIA'`): what the blueprint refuses offline, mirroring the platform's
 * own schema-write rules. Adding the profile to a type that already has documents or variants needs stored state, so the
 * platform alone decides it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBlueprint, BlueprintValidationError } from '../src/types.js';

function withSchema(schema: Record<string, unknown>): unknown {
  return {
    name: 'demo',
    version: '1.0.0',
    description: 'demo blueprint',
    contextId: 'mcp',
    schemas: [{ typeName: 'photo', displayName: 'Photo', fields: [], ...schema }],
    accessProfile: { allowedActions: ['records:r'] },
    servicePrincipal: { externalId: 'demo-sp', displayName: 'Demo SP' },
  };
}
function issues(input: unknown): string[] {
  try {
    parseBlueprint(input);
    return [];
  } catch (err) {
    assert.ok(err instanceof BlueprintValidationError, `expected BlueprintValidationError, got ${err}`);
    return err.issues.map((i) => `${i.path}: ${i.message}`);
  }
}
const media = { fileProfile: 'PUBLIC_MEDIA', allowedSurfaces: ['document'] };
const has = (got: string[], re: RegExp) => assert.ok(got.some((i) => re.test(i)), JSON.stringify(got));

test('public media: a declaration with every key parses and is kept as written', () => {
  const s = { ...media, indexMode: 'NONE', mediaKinds: ['image'], maxBytes: 5_000_000, contentTypes: ['image/png', 'image/jpeg'] };
  assert.deepEqual(issues(withSchema(s)), []);
  const bp = parseBlueprint(withSchema(s));
  assert.equal(bp.schemas[0].fileProfile, 'PUBLIC_MEDIA');
  assert.deepEqual(bp.schemas[0].contentTypes, ['image/png', 'image/jpeg']);
  assert.deepEqual(issues(withSchema(media)), [], 'the profile alone (the defaults: image, 10 MiB, all four types)');
});

test('public media: fileProfile takes only PUBLIC_MEDIA; the three settings need it', () => {
  assert.ok(issues(withSchema({ ...media, fileProfile: 'PRIVATE' })).length > 0);
  for (const [k, v] of [['mediaKinds', ['image']], ['maxBytes', 10], ['contentTypes', ['image/png']]] as const) {
    has(issues(withSchema({ allowedSurfaces: ['document'], [k]: v })), new RegExp(`${k} needs fileProfile .PUBLIC_MEDIA. declared alongside it`));
  }
});

test('public media: the surface must be exactly document, the index NONE or omitted, and no basedOn', () => {
  has(issues(withSchema({ fileProfile: 'PUBLIC_MEDIA' })), /needs allowedSurfaces exactly \['document'\]/);
  has(issues(withSchema({ fileProfile: 'PUBLIC_MEDIA', allowedSurfaces: ['record'] })), /needs allowedSurfaces exactly/);
  has(issues(withSchema({ fileProfile: 'PUBLIC_MEDIA', allowedSurfaces: ['document', 'record'] })), /needs allowedSurfaces exactly/);
  has(issues(withSchema({ ...media, indexMode: 'HYBRID' })), /never indexed: indexMode must be 'NONE' or omitted/);
  assert.deepEqual(issues(withSchema({ ...media, indexMode: 'NONE' })), []);
  has(issues(withSchema({ ...media, basedOn: 'sch_1' })), /cannot be a customization \(basedOn\)/);
});

test('public media: mediaKinds is a non-empty list of distinct kinds, image only; video is named as not available', () => {
  has(issues(withSchema({ ...media, mediaKinds: [] })), /at least one kind/);
  has(issues(withSchema({ ...media, mediaKinds: ['image', 'image'] })), /may not list a kind twice/);
  has(issues(withSchema({ ...media, mediaKinds: [''] })), /may contain only .image./);
  has(issues(withSchema({ ...media, mediaKinds: ['video'] })), /'video' is not supported/);
  has(issues(withSchema({ ...media, mediaKinds: ['audio'] })), /only 'image'/);
});

test('public media: maxBytes is a whole number from 1 to 10 MiB', () => {
  assert.deepEqual(issues(withSchema({ ...media, maxBytes: 1 })), []);
  assert.deepEqual(issues(withSchema({ ...media, maxBytes: 10485760 })), []);
  has(issues(withSchema({ ...media, maxBytes: 0 })), /between 1 and 10485760/);
  has(issues(withSchema({ ...media, maxBytes: 10485761 })), /between 1 and 10485760/);
  assert.ok(issues(withSchema({ ...media, maxBytes: 1.5 })).length > 0);
});

test('public media: contentTypes is a non-empty subset of the four image types, compared trimmed and lower-cased', () => {
  assert.deepEqual(issues(withSchema({ ...media, contentTypes: ['IMAGE/PNG', ' image/gif ', 'image/webp'] })), []);
  has(issues(withSchema({ ...media, contentTypes: [] })), /at least one type/);
  has(issues(withSchema({ ...media, contentTypes: ['image/bmp'] })), /may contain only image\/jpeg, image\/png, image\/webp, image\/gif/);
  has(issues(withSchema({ ...media, contentTypes: ['image/png', 'IMAGE/PNG'] })), /may not list a type twice/);
});

// ── asset / assets fields ──

const listing = (fields: unknown[], extra: Record<string, unknown> = {}) => ({
  name: 'demo', version: '1.0.0', description: 'demo blueprint', contextId: 'mcp',
  schemas: [
    { typeName: 'photo', displayName: 'Photo', fields: [], ...media },
    { typeName: 'listing', displayName: 'Listing', fields: [{ fieldId: 'title', fieldType: 'string' }, ...fields], publicView: { mode: 'record', ownedBy: ['userId'] }, ...extra },
  ],
  accessProfile: { allowedActions: ['records:r'] },
  servicePrincipal: { externalId: 'demo-sp', displayName: 'Demo SP' },
});

test('asset fields: asset and assets with documentTypes parse, and documentTypes is kept', () => {
  const ok = listing([
    { fieldId: 'cover', fieldType: 'asset', documentTypes: ['photo'] },
    { fieldId: 'gallery', fieldType: 'assets', documentTypes: ['photo'], validation: { maxItems: 20 } },
  ]);
  assert.deepEqual(issues(ok), []);
  assert.deepEqual(parseBlueprint(ok).schemas[1].fields[1].documentTypes, ['photo']);
});

test('asset fields: documentTypes is required, non-empty, each named once, and allowed only on asset fields', () => {
  has(issues(listing([{ fieldId: 'cover', fieldType: 'asset' }])), /must list the document types it accepts in documentTypes/);
  has(issues(listing([{ fieldId: 'cover', fieldType: 'asset', documentTypes: [] }])), /must list the document types/);
  has(issues(listing([{ fieldId: 'cover', fieldType: 'assets', documentTypes: ['photo', 'photo'] }])), /each document type once, by name/);
  has(issues(listing([{ fieldId: 'cover', fieldType: 'asset', documentTypes: [' '] }])), /each document type once, by name/);
  has(issues(listing([{ fieldId: 'name', fieldType: 'string', documentTypes: ['photo'] }])), /documentTypes is allowed only on a field of type 'asset' or 'assets'/);
});

test('asset fields: not sensitive, searchable, an enum or a reference; maxItems only on assets, 1 to 20', () => {
  const a = { fieldId: 'cover', fieldType: 'asset', documentTypes: ['photo'] };
  has(issues(listing([{ ...a, sensitive: true }])), /cannot be sensitive/);
  has(issues(listing([{ ...a, searchable: true }])), /cannot be searchable/);
  has(issues(listing([{ ...a, enumValues: ['x'] }])), /cannot declare enumValues/);
  has(issues(listing([{ ...a, targetTypeName: 'photo' }])), /only valid on a field with fieldType: 'reference'/);
  has(issues(listing([{ ...a, cardinality: 'one' }])), /only valid on a field with fieldType: 'reference'/);
  has(issues(listing([{ ...a, validation: { maxItems: 2 } }])), /maxItems applies only to a field of type 'assets'/);
  const many = { fieldId: 'gallery', fieldType: 'assets', documentTypes: ['photo'] };
  has(issues(listing([{ ...many, validation: { maxItems: 0 } }])), /must be from 1 to 20/);
  has(issues(listing([{ ...many, validation: { maxItems: 21 } }])), /must be from 1 to 20/);
  assert.deepEqual(issues(listing([{ ...many, validation: { maxItems: 1 } }])), []);
});

test('asset fields: refused on a customization (basedOn); the public-view requirement is left to the platform', () => {
  has(issues(listing([{ fieldId: 'cover', fieldType: 'asset', documentTypes: ['photo'] }], { basedOn: 'sch_1', publicView: undefined })), /only on a base schema, not on a customization/);
  // No publicView key: a stored view may serve the field (omitted keeps it), so only the platform can decide.
  assert.deepEqual(issues(listing([{ fieldId: 'cover', fieldType: 'asset', documentTypes: ['photo'] }], { publicView: undefined })), []);
});
