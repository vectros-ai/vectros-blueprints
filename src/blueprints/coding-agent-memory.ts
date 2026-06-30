/**
 * Bundled blueprint: coding-agent-memory.
 *
 * Persistent, governed project memory for a coding agent (Claude Desktop,
 * Cursor, Cline…). The agent records the decisions, conventions, and gotchas
 * it learns about a codebase so they survive across sessions — instead of
 * re-asking and re-breaking the same things every cold start.
 *
 * Demonstrates the agent-memory FACTS/ENTITIES + EPISODIC flavors on the
 * Vectros substrate: schema'd records (typed facts), exact lookup (idempotent
 * upsert by a caller-stable key), HYBRID search + grounded `rag_ask` (recall by
 * meaning — "why did we decide X?"), version history (how a decision evolved),
 * RANGE lookups on the "when" of each memory ("decisions from this quarter"),
 * and a typed REFERENCE link between record types (a convention cites the
 * decision that established it — a small knowledge graph). It is pure no-code: a
 * `vectros bootstrap` provisions the schemas + a narrow `ssk_*`, and the agent
 * drives it through the MCP server's data-plane tools.
 *
 * allowedActions = [records:r, records:c, records:u, search:r, schemas:r, inference:r].
 * Note the deliberate ABSENCE of records:d: decisions are SUPERSEDED (status
 * flips to `superseded`), never deleted, so the audit trail of how the project's
 * thinking changed stays intact (least privilege). `inference:r` powers the
 * grounded "why did we do X?" recall (`rag_ask`) over the captured rationale.
 */
import type { Blueprint } from '../types.js';

const codingAgentMemory: Blueprint = {
  name: 'coding-agent-memory',
  version: '1.0.0',
  description:
    'Persistent project memory for a coding agent — decisions, conventions, and gotchas that survive across sessions.',

  contextId: 'coding-memory',
  contextName: 'Coding Agent — Project Memory',

  schemas: [
    {
      // A durable architectural/product decision: what was decided, and WHY.
      // The rationale is the high-value, RAG-able body — "why did we do X?"
      // is the question a cold-context agent most needs answered.
      typeName: 'decision',
      displayName: 'Decision',
      indexMode: 'HYBRID', // keyword on titles + semantic on statement/rationale
      fields: [
        {
          fieldId: 'title',
          fieldType: 'string',
          required: true,
          searchable: true,
          validation: { minLength: 1, maxLength: 200 },
          renderHints: { label: 'Title', widget: 'text', order: 1, displayField: true },
        },
        {
          fieldId: 'statement',
          fieldType: 'string',
          searchable: true,
          description: 'What was decided, in one or two sentences.',
          renderHints: { label: 'Statement', widget: 'textarea', order: 2 },
        },
        {
          fieldId: 'rationale',
          fieldType: 'string',
          searchable: true,
          description: 'Why — the trade-offs and the context. The most-recalled field.',
          renderHints: { label: 'Rationale', widget: 'textarea', order: 3 },
        },
        {
          fieldId: 'status',
          fieldType: 'enum',
          filterable: true,
          enumValues: ['proposed', 'active', 'superseded'],
          renderHints: { label: 'Status', widget: 'select', order: 4 },
        },
        {
          fieldId: 'area',
          fieldType: 'string',
          filterable: true,
          description: 'Subsystem / module the decision applies to (e.g. "auth", "search").',
          renderHints: { label: 'Area', widget: 'text', order: 5 },
        },
        {
          fieldId: 'decidedOn',
          fieldType: 'date',
          description: 'ISO-8601 date. Range-queryable — "decisions made this quarter".',
          renderHints: { label: 'Decided on', widget: 'date', order: 6 },
        },
        // externalId is the record's FIRST-CLASS identifier (the dedup/upsert key + the
        // value a `reference` resolves against) — it is NOT a payload field, so it is not
        // declared here; the loader sends it top-level on the RecordRequest.
      ],
      // `externalId` is a first-class identifier with its own finder (exact
      // get/upsert) — look it up directly, never redeclare it as a schema lookup.
      // The choice below is MIGRATION-LOCKED once the schema is live:
      //   • `area`/`status` — EQUALITY (categorical): "list active decisions",
      //     "all decisions in the auth area". 2 of the 7 fast index slots.
      //   • `decidedOn` — RANGE: ordered `from`/`to`/`prefix` over the date.
      lookupFields: ['area', 'status', { fieldName: 'decidedOn', rangeEnabled: true }],
    },
    {
      // A coding convention the team follows — the agent reads these before it
      // writes code so it matches the surrounding style instead of inventing one.
      typeName: 'convention',
      displayName: 'Convention',
      indexMode: 'HYBRID',
      fields: [
        {
          fieldId: 'name',
          fieldType: 'string',
          required: true,
          searchable: true,
          validation: { minLength: 1, maxLength: 200 },
          renderHints: { label: 'Name', widget: 'text', order: 1, displayField: true },
        },
        {
          fieldId: 'rule',
          fieldType: 'string',
          searchable: true,
          description: 'The convention itself, stated as an imperative.',
          renderHints: { label: 'Rule', widget: 'textarea', order: 2 },
        },
        {
          fieldId: 'area',
          fieldType: 'string',
          filterable: true,
          renderHints: { label: 'Area', widget: 'text', order: 3 },
        },
        {
          // Parallels `decision.status` so a convention can be RETIRED rather than
          // deleted (the blueprint omits records:d — memory is superseded, not lost).
          fieldId: 'status',
          fieldType: 'enum',
          filterable: true,
          enumValues: ['active', 'retired'],
          renderHints: { label: 'Status', widget: 'select', order: 4 },
        },
        {
          // A typed REFERENCE to the decision that established this convention — a
          // foreign-key link between record types (the knowledge-graph edge). The
          // platform requires both the target type AND its surface; the value is the
          // target decision's externalId (the default `targetField`). Provenance:
          // "why does this convention exist? → open the decision behind it." Not
          // searchable (a foreign-key id is search noise); declared as an equality
          // lookup below so you can also enumerate "conventions from decision X".
          fieldId: 'establishedByDecision',
          fieldType: 'reference',
          targetTypeName: 'decision',
          targetSurface: 'record',
          targetField: 'externalId',
          cardinality: 'one',
          renderHints: { label: 'Established by (decision)', order: 5 },
        },
        {
          fieldId: 'adoptedOn',
          fieldType: 'date',
          description: 'ISO-8601 — when this convention was adopted. Range-queryable.',
          renderHints: { label: 'Adopted on', widget: 'date', order: 6 },
        },
        // externalId: first-class identifier, not a payload field (see `decision`).
      ],
      // externalId has its own first-class finder for exact get — look it up
      // directly, not as a schema lookup. Locked equality-vs-range choices:
      //   • `area`/`status` — EQUALITY: "active conventions for auth".
      //   • `establishedByDecision` — EQUALITY on the reference value: enumerate
      //     "conventions established by decision X" (a forward link query; the
      //     platform has no reverse-reference index on this surface).
      //   • `adoptedOn` — RANGE over the adoption date.
      // 3 equality lookups (of 7 fast slots) + 1 range row.
      lookupFields: ['area', 'status', 'establishedByDecision', { fieldName: 'adoptedOn', rangeEnabled: true }],
    },
    {
      // A gotcha / sharp edge: a symptom, its cause, and the fix. Saves the
      // agent (and the human) from re-discovering the same trap.
      typeName: 'gotcha',
      displayName: 'Gotcha',
      indexMode: 'HYBRID',
      fields: [
        {
          fieldId: 'symptom',
          fieldType: 'string',
          required: true,
          searchable: true,
          validation: { minLength: 1, maxLength: 500 },
          renderHints: { label: 'Symptom', widget: 'textarea', order: 1, displayField: true },
        },
        {
          fieldId: 'cause',
          fieldType: 'string',
          searchable: true,
          renderHints: { label: 'Cause', widget: 'textarea', order: 2 },
        },
        {
          fieldId: 'fix',
          fieldType: 'string',
          searchable: true,
          renderHints: { label: 'Fix', widget: 'textarea', order: 3 },
        },
        {
          fieldId: 'area',
          fieldType: 'string',
          filterable: true,
          renderHints: { label: 'Area', widget: 'text', order: 4 },
        },
        {
          // A gotcha can be RETIRED once the underlying trap is fixed for good —
          // superseded, not deleted (the blueprint omits records:d).
          fieldId: 'status',
          fieldType: 'enum',
          filterable: true,
          enumValues: ['active', 'retired'],
          renderHints: { label: 'Status', widget: 'select', order: 5 },
        },
        {
          fieldId: 'discoveredOn',
          fieldType: 'date',
          description: 'ISO-8601 — when this gotcha was first hit. Range-queryable.',
          renderHints: { label: 'Discovered on', widget: 'date', order: 6 },
        },
        // externalId: first-class identifier, not a payload field (see `decision`).
      ],
      // externalId has its own first-class finder for exact get — look it up
      // directly, not as a schema lookup. `area`/`status` EQUALITY ("active
      // gotchas in search"); `discoveredOn` RANGE over the discovery date.
      lookupFields: ['area', 'status', { fieldName: 'discoveredOn', rangeEnabled: true }],
    },
  ],

  // Least-privilege profile — MUST pass the CLI scope gate.
  // r/c/u + search + schema discovery + inference:r (grounded "why did we do X?"
  // recall over the captured rationale). NOT records:d: memory is superseded,
  // not deleted, so the project's decision history stays auditable.
  accessProfile: {
    allowedActions: ['records:r', 'records:c', 'records:u', 'search:r', 'schemas:r', 'inference:r'],
  },

  servicePrincipal: {
    externalId: 'coding-agent-memory',
    displayName: 'Coding Agent — Project Memory',
  },

  seed: [
    {
      // Seeded FIRST so the convention below resolves its reference to it — the
      // loader creates seeds in array order, and a reference target must exist when
      // the referencing record is written.
      surface: 'record',
      typeName: 'decision',
      externalId: 'seed-use-vectros-for-memory',
      fields: {
        title: 'Use Vectros as the coding agent’s project memory',
        statement:
          'Persist decisions, conventions, and gotchas as Vectros records so they survive across agent sessions.',
        rationale:
          'A coding agent loses context every cold start. A governed, searchable memory lets it recall prior decisions by meaning instead of re-asking — and the version history shows how the thinking evolved.',
        status: 'active',
        area: 'getting-started',
        decidedOn: '2026-06-14',
      },
    },
    {
      // Demonstrates a live typed link at bootstrap: this convention references the
      // decision above by its externalId, so "open the decision behind this rule"
      // works the moment the blueprint is applied.
      surface: 'record',
      typeName: 'convention',
      externalId: 'seed-record-the-why',
      fields: {
        name: 'Record the why, not just the what',
        rule: 'When you record a decision or convention, always capture the rationale — the trade-offs a future session cannot re-derive from the code.',
        area: 'getting-started',
        status: 'active',
        establishedByDecision: 'seed-use-vectros-for-memory',
        adoptedOn: '2026-06-14',
      },
    },
  ],
};

export default codingAgentMemory;
