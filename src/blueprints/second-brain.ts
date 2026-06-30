/**
 * Bundled blueprint: second-brain.
 *
 * A personal knowledge base — capture every note, idea, and link, then just
 * ask it. The most universally legible AI-data use case there is, and the
 * canonical exemplar of the agent-memory LONG-TERM / SEMANTIC-RECALL flavor:
 * one `note` schema, HYBRID-indexed, recalled by meaning rather than exact
 * keywords.
 *
 * Pure no-code: `vectros bootstrap` provisions the schema + a narrow `ssk_*`,
 * and you drive it through the MCP server ("capture this thought", "what did I
 * note about X?") or the generic data-plane app. Notes are archived via a
 * status flip, not deleted — so the profile omits records:d (least privilege).
 *
 * Beyond semantic recall it shows the DIRECT-access patterns an agent reaches
 * for between searches: enumerate notes by `source` (most-recent first), and a
 * `capturedAt` RANGE index for "what did I capture last week?". The
 * equality-vs-range choice per lookup field is permanent (see lookupFields).
 *
 * allowedActions = [records:r, records:c, records:u, search:r, schemas:r, inference:r].
 */
import type { Blueprint } from '../types.js';

const secondBrain: Blueprint = {
  name: 'second-brain',
  version: '1.0.0',
  description: 'A personal knowledge base — capture notes, ideas, and links, then ask them anything.',

  contextId: 'second-brain',
  contextName: 'Second Brain',

  schemas: [
    {
      typeName: 'note',
      displayName: 'Note',
      indexMode: 'HYBRID', // keyword on title + semantic on body — recall by meaning
      fields: [
        {
          fieldId: 'title',
          fieldType: 'string',
          required: true,
          searchable: true,
          validation: { minLength: 1, maxLength: 200 },
          renderHints: { label: 'Title', widget: 'text', order: 1, section: 'Note', displayField: true },
        },
        {
          fieldId: 'body',
          fieldType: 'string',
          searchable: true,
          description: 'The note itself — the RAG-able body you ask questions against.',
          validation: { maxLength: 20000 },
          renderHints: { label: 'Body', widget: 'textarea', order: 2, section: 'Note' },
        },
        {
          fieldId: 'tags',
          fieldType: 'array',
          filterable: true,
          description: 'Freeform string labels for filtering (e.g. "idea", "reading", "work").',
          renderHints: { label: 'Tags', order: 3, section: 'Organize' },
        },
        {
          // An enum (not freeform) so enumeration-by-source is reliable — a
          // `record_query` lookup on `source` only works if values are consistent.
          // `other` keeps it from being a straitjacket for a personal brain-dump.
          fieldId: 'source',
          fieldType: 'enum',
          filterable: true,
          enumValues: ['thought', 'web', 'meeting', 'book', 'article', 'other'],
          description: 'Where it came from.',
          renderHints: { label: 'Source', widget: 'select', order: 4, section: 'Organize' },
        },
        {
          fieldId: 'status',
          fieldType: 'enum',
          filterable: true,
          enumValues: ['active', 'archived'],
          description: 'Archive instead of delete, so nothing is ever lost.',
          renderHints: { label: 'Status', widget: 'select', order: 5, section: 'Organize' },
        },
        {
          fieldId: 'capturedAt',
          fieldType: 'date',
          description: 'ISO-8601 capture date. Range-queryable — "notes from last week".',
          renderHints: { label: 'Captured', widget: 'date', order: 6, section: 'Organize' },
        },
        // externalId is the record's FIRST-CLASS identifier (the dedup/upsert key + the
        // value a `reference` resolves against) — not a payload field; the loader sends
        // it top-level on the RecordRequest.
      ],
      // Lookup shapes are MIGRATION-LOCKED once the schema is live (a field cannot
      // flip equality↔range later), so each is chosen on purpose:
      //   • `source` — EQUALITY, sorted by `lastUpdated`: enumerate notes from one
      //     source, most-recently-touched first. `lastUpdated` is always present, so
      //     the sort never drops a note (sorting an equality lookup by an OPTIONAL
      //     field would silently exclude rows that lack it).
      //   • `status` — EQUALITY: "show archived notes".
      //   • `capturedAt` — RANGE: ordered `from`/`to`/`prefix` ("captured in 2026-06").
      // `externalId` has a built-in first-class finder — look it up directly, never
      // redeclare it here. Equality lookups use the 7 fast index slots (2 used here);
      // range lookups use a relationship row, billed at the range rate.
      lookupFields: [
        { fieldName: 'source', sortBy: 'lastUpdated' },
        'status',
        { fieldName: 'capturedAt', rangeEnabled: true },
      ],
    },
  ],

  // Least-privilege profile — r/c/u + search + schema discovery + inference:r
  // (so the agent can `rag_ask` a grounded, cited question over your notes). No
  // records:d: notes are archived (status → 'archived'), never deleted.
  accessProfile: {
    allowedActions: ['records:r', 'records:c', 'records:u', 'search:r', 'schemas:r', 'inference:r'],
  },

  servicePrincipal: {
    externalId: 'second-brain',
    displayName: 'Second Brain',
  },

  seed: [
    {
      surface: 'record',
      typeName: 'note',
      externalId: 'seed-welcome',
      fields: {
        title: 'Welcome to your Second Brain',
        body: 'Capture anything here — ideas, links, meeting notes — then ask your agent things like "what did I note about onboarding?" and it recalls by meaning, not just keywords.',
        tags: ['getting-started'],
        source: 'thought',
        status: 'active',
        capturedAt: '2026-06-14',
      },
    },
  ],
};

export default secondBrain;
