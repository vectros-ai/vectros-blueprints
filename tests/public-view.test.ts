/**
 * A schema's `publicView`: what the blueprint refuses offline, before anything is sent. The platform re-checks every
 * rule (and the ones that depend on field details or stored state) and is the authority.
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
    schemas: [
      {
        typeName: 'listing',
        displayName: 'Listing',
        fields: [
          { fieldId: 'title', fieldType: 'string' },
          { fieldId: 'state', fieldType: 'string', filterable: true },
        ],
        lookupFields: ['state'],
        ...schema,
      },
    ],
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

test('publicView: record mode with ownedBy parses, and is kept as written', () => {
  const bp = parseBlueprint(withSchema({ publicView: { mode: 'record', ownedBy: ['scope:org'] } }));
  assert.deepEqual(bp.schemas[0].publicView, { mode: 'record', ownedBy: ['scope:org'] });
});

test('publicView: projection mode with fields, publishWhen and search parses', () => {
  const pv = {
    mode: 'projection',
    fields: ['title'],
    ownedBy: ['userId', 'scope:org'],
    publishWhen: { field: 'state', in: ['open', 'featured'] },
    search: ['text'],
  };
  assert.deepEqual(parseBlueprint(withSchema({ publicView: pv })).schemas[0].publicView, pv);
});

test('publicView: null (an explicit removal) parses; omitted stays undefined', () => {
  assert.equal(parseBlueprint(withSchema({ publicView: null })).schemas[0].publicView, null);
  assert.equal(parseBlueprint(withSchema({})).schemas[0].publicView, undefined);
});

test('publicView: the default mode (projection) requires fields', () => {
  assert.ok(issues(withSchema({ publicView: { ownedBy: ['scope:org'] } })).some((i) => i.includes('requires')));
});

test('publicView: record mode refuses fields', () => {
  assert.ok(
    issues(withSchema({ publicView: { mode: 'record', fields: ['title'], ownedBy: ['scope:org'] } })).some((i) =>
      i.includes("omit 'fields'"),
    ),
  );
});

test('publicView.cacheSeconds and purgeListsOnChange: 0 to 86400 seconds, and a boolean, in either mode', () => {
  const view = (extra: Record<string, unknown>) => withSchema({ publicView: { mode: 'record', ownedBy: ['scope:org'], ...extra } });
  assert.equal(parseBlueprint(view({ cacheSeconds: 60, purgeListsOnChange: true })).schemas[0].publicView?.cacheSeconds, 60);
  assert.deepEqual(issues(view({ cacheSeconds: 0 })), []);
  assert.deepEqual(issues(view({ cacheSeconds: 86_400 })), []);
  for (const bad of [-1, 86_401, 1.5, '60']) assert.ok(issues(view({ cacheSeconds: bad })).length > 0, String(bad));
  assert.ok(issues(view({ purgeListsOnChange: 'yes' })).length > 0);
  assert.deepEqual(issues(withSchema({ publicView: { fields: ['title'], ownedBy: ['userId'], cacheSeconds: 300 } })), []);
});

test('publicView: an unknown key is refused, as the platform refuses it', () => {
  assert.ok(issues(withSchema({ publicView: { mode: 'record', ownedBy: ['scope:org'], listBy: ['title'] } })).length > 0);
  assert.ok(
    issues(withSchema({ publicView: { mode: 'record', ownedBy: ['scope:org'], publishWhen: { field: 'state', in: ['open'], not: [] } } }))
      .length > 0,
  );
});

test('publicView.ownedBy: required, each entry userId or scope:<namespace>, no repeats, at most two scopes', () => {
  assert.ok(issues(withSchema({ publicView: { mode: 'record' } })).length > 0, 'ownedBy is required');
  assert.ok(issues(withSchema({ publicView: { mode: 'record', ownedBy: ['org'] } })).some((i) => i.includes("'userId' or 'scope:")));
  assert.ok(issues(withSchema({ publicView: { mode: 'record', ownedBy: ['scope:org', 'scope:org'] } })).some((i) => i.includes('twice')));
  assert.ok(
    issues(withSchema({ publicView: { mode: 'record', ownedBy: ['scope:org', 'scope:client', 'scope:team'] } })).some((i) =>
      i.includes('at most 2 scope namespaces'),
    ),
  );
});

test('publicView: fields and publishWhen.field must be declared fields of the schema', () => {
  assert.ok(
    issues(withSchema({ publicView: { fields: ['nope'], ownedBy: ['scope:org'] } })).some((i) => i.includes("'nope'")),
  );
  assert.ok(
    issues(withSchema({ publicView: { mode: 'record', ownedBy: ['scope:org'], publishWhen: { field: 'nope', in: ['x'] } } })).some(
      (i) => i.includes("'nope'"),
    ),
  );
});

test('publicView: publishWhen.in holds 1 to 20 values', () => {
  const base = { mode: 'record', ownedBy: ['scope:org'] };
  assert.ok(issues(withSchema({ publicView: { ...base, publishWhen: { field: 'state', in: [] } } })).length > 0);
  const many = Array.from({ length: 21 }, (_, i) => `v${i}`);
  assert.ok(issues(withSchema({ publicView: { ...base, publishWhen: { field: 'state', in: many } } })).length > 0);
});

test('publicView.search: known modes only, each once', () => {
  const base = { mode: 'record', ownedBy: ['scope:org'] };
  assert.ok(issues(withSchema({ publicView: { ...base, search: ['fuzzy'] } })).length > 0);
  assert.ok(issues(withSchema({ publicView: { ...base, search: ['text', 'text'] } })).some((i) => i.includes('more than once')));
});

test('publicView: refused on a customization (basedOn), which uses its base', () => {
  assert.ok(
    issues(withSchema({ basedOn: 'schema-base-id', publicView: { mode: 'record', ownedBy: ['scope:org'] } })).some((i) =>
      i.includes('base schema only'),
    ),
  );
});

test('publicView.ownedBy accepts a namespace with an underscore (the platform grammar)', () => {
  assert.deepEqual(issues(withSchema({ publicView: { mode: 'record', ownedBy: ['scope:org_unit'] } })), []);
});

test('publicView: a repeated field or publishWhen value, an empty value, and over 50 fields are refused offline', () => {
  assert.ok(issues(withSchema({ publicView: { fields: ['title', 'title'], ownedBy: ['userId'] } })).some((i) => i.includes('more than once')));
  const base = { mode: 'record', ownedBy: ['scope:org'] };
  assert.ok(issues(withSchema({ publicView: { ...base, publishWhen: { field: 'state', in: ['open', 'open'] } } })).some((i) => i.includes('more than once')));
  assert.ok(issues(withSchema({ publicView: { ...base, publishWhen: { field: 'state', in: [''] } } })).length > 0);
  // 51 DISTINCT declared fields, so only the 50-field cap can refuse it (not the repeat or the declared-field rule).
  const ids = Array.from({ length: 51 }, (_, i) => `f${i}`);
  const fields = [...ids.map((fieldId) => ({ fieldId, fieldType: 'string' })), { fieldId: 'state', fieldType: 'string' }];
  const over = issues(withSchema({ fields, publicView: { fields: ids, ownedBy: ['userId'] } }));
  assert.equal(over.length, 1, JSON.stringify(over));
  assert.match(over[0], /publicView\.fields: .*<=50 items/);
  assert.deepEqual(issues(withSchema({ fields, publicView: { fields: ids.slice(0, 50), ownedBy: ['userId'] } })), []);
});

test('publicView: publicViewVersion (server-managed) is accepted, so a view copied from a read can be pasted in', () => {
  assert.deepEqual(issues(withSchema({ publicView: { mode: 'record', ownedBy: ['scope:org'], publicViewVersion: 3 } })), []);
});

test('publicView offline limits at their edges: values, fields, ownedBy, search, mode', () => {
  const rec = { mode: 'record', ownedBy: ['scope:org'] };
  const pw = (values: unknown[], fieldType = 'string') =>
    withSchema({
      fields: [{ fieldId: 'title', fieldType: 'string' }, { fieldId: 'state', fieldType, filterable: true }],
      publicView: { ...rec, publishWhen: { field: 'state', in: values } },
    });
  assert.deepEqual(issues(pw(['x'.repeat(256)])), []);
  assert.ok(issues(pw(['x'.repeat(257)])).length > 0, 'a value over 256 characters');
  for (const bad of [{}, [], null]) assert.ok(issues(pw([bad])).length > 0, `item ${JSON.stringify(bad)}`);
  // A value must have the field's type, as the platform requires, so a number and a string cannot share one field
  assert.ok(issues(pw([1, '1'])).some((i) => i.includes('to match field')), 'a number on a string field');
  // The platform's storable-number contract: the signed 64-bit range for every number, and a nonzero magnitude >= 1e-130.
  assert.deepEqual(issues(pw([0, -5, 1e-130, 1.5, 9.2e18, -9.2e18, 2 ** 63 - 1024], 'number')), []);
  for (const n of [2 ** 63, -(2 ** 63), 9.3e18, 1e20, 1e125, 1e126, -1e126, 1e-131]) {
    assert.ok(issues(pw([n], 'number')).some((i) => i.includes('magnitude')), `the platform cannot store ${n}`);
  }
  assert.ok(issues(withSchema({ publicView: { fields: [], ownedBy: ['userId'] } })).length > 0, 'fields: [] is refused');
  assert.deepEqual(issues(withSchema({ publicView: { mode: 'projection', fields: ['title'], ownedBy: ['userId'] } })), []);
  assert.deepEqual(issues(withSchema({ publicView: { ...rec, search: [] } })), [], 'search: [] offers none');
  const own = (ownedBy: string[]) => issues(withSchema({ publicView: { mode: 'record', ownedBy } }));
  assert.ok(own(['userId', 'scope:a1', 'scope:b1', 'scope:c1']).length > 0, 'four entries');
  assert.ok(own(['userId', 'userId']).some((i) => i.includes('twice')));
  assert.ok(own(['scope:']).length > 0);
  assert.ok(own(['scope:Org']).some((i) => i.includes('not a valid namespace')));
  assert.ok(own(['scope:tenant']).some((i) => i.includes('reserved namespace')), 'a forbidden namespace');
  assert.deepEqual(issues(withSchema({ publicView: { ...rec, publicViewVersion: 1.5 } })), [], 'publicViewVersion is ignored, as the platform ignores it');
  assert.ok(issues(withSchema({ publicView: { ...rec, mode: 'mirror' } })).length > 0, 'an unknown mode');
  assert.ok(issues(pw([true, true], 'boolean')).some((i) => i.includes('more than once')), 'a repeated boolean');
  assert.deepEqual(issues(pw([true, false], 'boolean')), [], 'true and false');
  assert.ok(issues(pw([true, false, 'true'], 'boolean')).some((i) => i.includes('to match field')), 'the string "true" on a boolean field');
});

test('publicView: null alongside basedOn is accepted (a removal is not a declaration)', () => {
  assert.deepEqual(issues(withSchema({ basedOn: 'listing-base', scopes: ['org:acme'], publicView: null })), []);
});

test('publicView: the schema-level rules a blueprint shows by itself are refused offline', () => {
  const rec = { mode: 'record', ownedBy: ['scope:org'] };
  const proj = { fields: ['title'], ownedBy: ['userId'] };
  const one = (schema: Record<string, unknown>, pattern: RegExp) => {
    const got = issues(withSchema(schema));
    assert.ok(got.some((i) => pattern.test(i)), `${JSON.stringify(schema)} -> ${JSON.stringify(got)}`);
  };
  one({ allowedSurfaces: ['record', 'document'], publicView: rec }, /allowedSurfaces.*exactly \['record'\]/);
  assert.deepEqual(issues(withSchema({ allowedSurfaces: ['record'], publicView: rec })), []);
  // Projection mode only on an unowned schema, and its copy type name must fit.
  one({ userId: '${{ self.userId }}', publicView: proj }, /only on a schema no user or scope owns/);
  one({ scopes: ['org:o1'], publicView: proj }, /only on a schema no user or scope owns/);
  assert.deepEqual(issues(withSchema({ scopes: ['org:o1'], publicView: rec })), [], 'record mode on an owned schema is fine');
  one({ typeName: 'a'.repeat(62), publicView: proj }, /typeName of at most 61/);
  assert.deepEqual(issues(withSchema({ typeName: 'a'.repeat(61), publicView: proj })), [], 'exactly 61 is accepted');
  // storageProfile is not part of the blueprint format, so the platform's LARGE_PAYLOAD rule for record mode cannot be
  // shown offline: the key itself is refused.
  assert.ok(issues(withSchema({ storageProfile: 'LARGE_PAYLOAD', publicView: rec })).length > 0);
  // Fields that can never be public.
  const fields = [
    { fieldId: 'title', fieldType: 'string' },
    { fieldId: 'state', fieldType: 'string' },
    { fieldId: 'secret', fieldType: 'string', sensitive: true },
    { fieldId: 'parent', fieldType: 'reference', targetTypeName: 'listing', targetField: 'id', targetSurface: 'record', cardinality: 'one' },
    { fieldId: 'where', fieldType: 'geo' },
  ];
  one({ fields, publicView: { fields: ['secret'], ownedBy: ['userId'] } }, /'secret' is sensitive/);
  one({ fields, publicView: { fields: ['parent'], ownedBy: ['userId'] } }, /'parent' is a reference/);
  one({ fields, publicView: { fields: ['where'], ownedBy: ['userId'] } }, /'where' is a geo field: set publicView.geoPrecision.where/);
  one({ fields, publicView: rec }, /mode 'record' makes every declared field public, and field 'secret' is sensitive/);
  one({ fields, publicView: rec }, /field 'parent' is a reference/);
  // A geo field is fine in record mode (it is served exactly, by design).
  const geoOnly = [{ fieldId: 'title', fieldType: 'string' }, { fieldId: 'state', fieldType: 'string' }, { fieldId: 'where', fieldType: 'geo' }];
  assert.deepEqual(issues(withSchema({ fields: geoOnly, publicView: rec })), []);
  one(
    { fields: [{ fieldId: 'title', fieldType: 'string' }, { fieldId: 'externalId', fieldType: 'string' }], publicView: { fields: ['externalId'], ownedBy: ['userId'] } },
    /'externalId' is an ownership or identity name/,
  );
});

test('publicView.geoPrecision: a listed geo field needs a declared precision, in the domain, and only a listed geo field takes one', () => {
  const fields = [
    { fieldId: 'title', fieldType: 'string' },
    { fieldId: 'state', fieldType: 'string' },
    { fieldId: 'where', fieldType: 'geo' },
    { fieldId: 'home', fieldType: 'geo' },
  ];
  const view = (geoPrecision?: unknown, listed: string[] = ['title', 'where']) =>
    withSchema({ fields, publicView: { fields: listed, ownedBy: ['userId'], ...(geoPrecision === undefined ? {} : { geoPrecision }) } });
  // accepted: 'exact', and whole metres at both edges, kept as written
  for (const ok of ['exact', 100, 1000, 100_000]) {
    assert.deepEqual(issues(view({ where: ok })), [], `value ${String(ok)}`);
    assert.deepEqual(parseBlueprint(view({ where: ok })).schemas[0].publicView?.geoPrecision, { where: ok });
  }
  // required for every listed geo field
  assert.ok(issues(view()).some((i) => /'where' is a geo field: set publicView.geoPrecision.where/.test(i)), String(issues(view())));
  assert.ok(issues(view({})).some((i) => /'where' is a geo field/.test(i)));
  assert.ok(issues(view({ where: 1000 }, ['title', 'where', 'home'])).some((i) => /'home' is a geo field/.test(i)), 'each listed geo field');
  // the value domain
  for (const bad of [99, 100_001, 0, -1000, 1000.5, '1000', 'EXACT', true, null]) {
    assert.ok(
      issues(view({ where: bad })).some((i) => /'exact' or a whole number of metres from 100 to 100000/.test(i)),
      `value ${String(bad)}: ${issues(view({ where: bad })).join('; ')}`,
    );
  }
  // only a listed geo field takes an entry
  assert.ok(issues(view({ where: 1000, title: 1000 })).some((i) => /names 'title', which is not a geo field listed/.test(i)), 'a non-geo field');
  assert.ok(issues(view({ where: 1000, home: 1000 })).some((i) => /names 'home', which is not a geo field listed/.test(i)), 'an unlisted geo field');
  assert.ok(issues(view({ where: 1000, nowhere: 'exact' })).some((i) => /names 'nowhere'/.test(i)), 'an undeclared field');
  // record mode serves a geo field exactly and takes no precision
  assert.deepEqual(issues(withSchema({ fields, publicView: { mode: 'record', ownedBy: ['userId'] } })), []);
  assert.ok(
    issues(withSchema({ fields, publicView: { mode: 'record', ownedBy: ['userId'], geoPrecision: {} } })).some((i) =>
      /mode 'record' serves every field as stored/.test(i),
    ),
    'even an empty map',
  );
  assert.ok(
    issues(withSchema({ fields, publicView: { mode: 'record', ownedBy: ['userId'], geoPrecision: { where: 1000 } } })).some((i) =>
      /mode 'record' serves every field as stored, a geo field exactly; omit 'geoPrecision'/.test(i),
    ),
  );
});

test('a geocoded geo field on a projection view: both declarations on one schema validate offline and parse intact', () => {
  const fields = [
    { fieldId: 'title', fieldType: 'string' },
    { fieldId: 'street', fieldType: 'string' },
    { fieldId: 'city', fieldType: 'string' },
    { fieldId: 'where', fieldType: 'geo', geocode: { from: ['street', 'city'] } },
  ];
  const bp = withSchema({ fields, publicView: { fields: ['title', 'where'], ownedBy: ['userId'], geoPrecision: { where: 1000 } } });
  assert.deepEqual(issues(bp), []);
  const schema = parseBlueprint(bp).schemas[0];
  assert.deepEqual(schema.fields.find((f) => f.fieldId === 'where')?.geocode, { from: ['street', 'city'] });
  assert.deepEqual(schema.publicView?.geoPrecision, { where: 1000 });
  // the precision rule still applies to a geocoded field
  assert.ok(
    issues(withSchema({ fields, publicView: { fields: ['title', 'where'], ownedBy: ['userId'] } })).some((i) => /'where' is a geo field: set publicView.geoPrecision.where/.test(i)),
  );
  // listing an address field next to a coarse geo field is not refused (the CLI plan flags it)
  assert.deepEqual(issues(withSchema({ fields, publicView: { fields: ['title', 'where', 'city'], ownedBy: ['userId'], geoPrecision: { where: 1000 } } })), []);
});

// The platform's publishWhen rules that depend on the field, checked offline as the platform checks them
function pwIssues(fields: unknown[], publishWhen: unknown, lookupFields: unknown[] = ['state']): string[] {
  return issues(withSchema({ fields, lookupFields, publicView: { mode: 'record', ownedBy: ['scope:org'], publishWhen } }));
}

test('publishWhen: a valid string, enum, number and boolean field each pass', () => {
  assert.deepEqual(pwIssues([{ fieldId: 'state', fieldType: 'string', filterable: true }], { field: 'state', in: ['open'] }), []);
  assert.deepEqual(
    pwIssues([{ fieldId: 'state', fieldType: 'enum', filterable: true, enumValues: ['open', 'closed'] }], { field: 'state', in: ['open'] }),
    [],
  );
  assert.deepEqual(pwIssues([{ fieldId: 'state', fieldType: 'number', filterable: true }], { field: 'state', in: [1, 2] }), []);
  assert.deepEqual(pwIssues([{ fieldId: 'state', fieldType: 'boolean', filterable: true }], { field: 'state', in: [true] }), []);
  assert.deepEqual(pwIssues([{ fieldId: 'state', fieldType: 'string', filterable: true }], { field: 'state', in: ['open'] }, [{ fieldName: 'state' }]), []);
});

test('publishWhen: the field may not be sensitive', () => {
  const hit = pwIssues([{ fieldId: 'state', fieldType: 'string', filterable: true, sensitive: true }], { field: 'state', in: ['open'] });
  assert.ok(hit.some((m) => /is sensitive; publication cannot depend on a sensitive field/.test(m)), hit.join('\n'));
});

test('publishWhen: the field must be a string, enum, number or boolean field', () => {
  const hit = pwIssues([{ fieldId: 'state', fieldType: 'date', filterable: true }], { field: 'state', in: ['2026-01-01'] });
  assert.ok(hit.some((m) => /has type 'date'; it must be one of boolean, enum, number, string/.test(m)), hit.join('\n'));
});

test('publishWhen: the field must be filterable (an omitted filterable is false)', () => {
  const hit = pwIssues([{ fieldId: 'state', fieldType: 'string' }], { field: 'state', in: ['open'] });
  assert.ok(hit.some((m) => /must be filterable/.test(m)), hit.join('\n'));
});

test('publishWhen: the field must be a single-field lookup of its own (not absent, not only a composite leg)', () => {
  const f = [{ fieldId: 'state', fieldType: 'string', filterable: true }, { fieldId: 'area', fieldType: 'string' }];
  const none = pwIssues(f, { field: 'state', in: ['open'] }, []);
  assert.ok(none.some((m) => /must be declared as a lookup field of its own/.test(m)), none.join('\n'));
  const composite = pwIssues(f, { field: 'state', in: ['open'] }, [{ fieldNames: ['state', 'area'] }]);
  assert.ok(composite.some((m) => /must be declared as a lookup field of its own/.test(m)), composite.join('\n'));
});

test('publishWhen: each value has the field type, and an enum value is one of enumValues', () => {
  const num = pwIssues([{ fieldId: 'state', fieldType: 'number', filterable: true }], { field: 'state', in: [1, 'two'] });
  assert.ok(num.some((m) => /in\[1\]: .*values must be numbers, to match field 'state' of type 'number'/.test(m)), num.join('\n'));
  const bool = pwIssues([{ fieldId: 'state', fieldType: 'boolean', filterable: true }], { field: 'state', in: ['true'] });
  assert.ok(bool.some((m) => /values must be booleans/.test(m)), bool.join('\n'));
  const str = pwIssues([{ fieldId: 'state', fieldType: 'string', filterable: true }], { field: 'state', in: [1] });
  assert.ok(str.some((m) => /values must be non-empty strings of at most 256 characters/.test(m)), str.join('\n'));
  const en = pwIssues(
    [{ fieldId: 'state', fieldType: 'enum', filterable: true, enumValues: ['open', 'closed'] }],
    { field: 'state', in: ['open', 'archived'] },
  );
  assert.ok(en.some((m) => /in\[1\]: .*and each one of the field's enumValues/.test(m)), en.join('\n'));
  assert.equal(en.length, 1, 'only the non-member is refused');
});
