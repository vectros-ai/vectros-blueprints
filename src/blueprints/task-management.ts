/**
 * Bundled blueprint: task-management.
 *
 * The canonical first blueprint (design doc Appendix A). Structured task
 * tracking, shareable across sessions, agents, and users. Demonstrates the
 * full contract: a HYBRID-indexed schema, a data-plane-only profile that
 * passes the CLI scope gate, a service principal, and deterministic seed
 * data — all with stable identifiers so a loader re-run is idempotent.
 *
 * Bundled blueprints are TRUSTED (they ship in the reviewed packages), but
 * the CLI's scope gate still applies — `tests/blueprints.test.ts` asserts
 * this blueprint is structurally valid, and the CLI's gate test asserts it
 * stays data-plane-only.
 *
 * It is the "copy me to start" exemplar, so it stays a SINGLE schema — but it
 * is a complete one: it shows render hints (so the no-code UI renders a real
 * form), write-time validation, and BOTH lookup shapes — equality (enumerate a
 * project's tasks) and an ordered RANGE index on the due date (list tasks due
 * in a window). The equality-vs-range choice per field is permanent once a
 * schema is live (see the lookupFields note below), so it is made deliberately.
 *
 * allowedActions = [records:r, records:c, records:u, search:r, schemas:r] —
 * all data-plane. Note the deliberate ABSENCE of records:d (tasks are
 * marked done, not deleted — least privilege).
 */
import type { Blueprint } from '../types.js';

const taskManagement: Blueprint = {
  name: 'task-management',
  version: '1.0.0',
  description: 'Structured task tracking, shareable across sessions, agents, and users.',

  contextId: 'task-management',
  contextName: 'Task Management',

  schemas: [
    {
      typeName: 'task',
      displayName: 'Task',
      indexMode: 'HYBRID', // keyword on titles + semantic on descriptions
      fields: [
        {
          fieldId: 'title',
          fieldType: 'string',
          required: true,
          searchable: true,
          validation: { minLength: 1, maxLength: 200 },
          renderHints: { label: 'Title', widget: 'text', order: 1, section: 'Task', displayField: true },
        },
        {
          fieldId: 'description',
          fieldType: 'string',
          searchable: true,
          description: 'Free-text detail — the RAG-able body.',
          validation: { maxLength: 8000 },
          renderHints: { label: 'Description', widget: 'textarea', order: 2, section: 'Task' },
        },
        {
          fieldId: 'status',
          fieldType: 'enum',
          filterable: true,
          enumValues: ['todo', 'in_progress', 'blocked', 'done'],
          renderHints: { label: 'Status', widget: 'select', order: 3, section: 'Tracking' },
        },
        {
          fieldId: 'priority',
          fieldType: 'enum',
          filterable: true,
          enumValues: ['low', 'medium', 'high', 'urgent'],
          // Equality, NOT range: the values are an ordinal vocabulary but they sort
          // LEXICALLY (high < low < medium < urgent), not by severity — a range
          // index here would be permanently wrong. Filter by exact priority instead.
          renderHints: { label: 'Priority', widget: 'select', order: 4, section: 'Tracking' },
        },
        {
          fieldId: 'assignee',
          fieldType: 'string',
          filterable: true,
          description: 'userId or display name.',
          renderHints: { label: 'Assignee', widget: 'text', order: 5, section: 'Tracking' },
        },
        {
          fieldId: 'project',
          fieldType: 'string',
          filterable: true,
          description: 'Grouping key for cross-session continuity.',
          renderHints: { label: 'Project', widget: 'text', order: 6, section: 'Tracking' },
        },
        {
          fieldId: 'dueDate',
          fieldType: 'date',
          description: 'ISO-8601. Range-queryable (see lookupFields) — list tasks due in a window.',
          renderHints: { label: 'Due date', widget: 'date', order: 7, section: 'Tracking' },
        },
        {
          fieldId: 'tags',
          fieldType: 'array',
          filterable: true,
          renderHints: { label: 'Tags', order: 8, section: 'Tracking' },
        },
        // externalId is the record's FIRST-CLASS identifier (the dedup/lookup key + the
        // value a `reference` resolves against) — not a payload field; the loader sends
        // it top-level on the RecordRequest.
      ],
      // Two lookup shapes, chosen deliberately because the equality-vs-range choice
      // per field is MIGRATION-LOCKED once the schema is live (you cannot flip a
      // field slot↔range later, even by removing and re-adding it):
      //   • `project` — EQUALITY (a grouping key, not ordered): enumerate one
      //     project's tasks directly, no search. Each equality lookup uses 1 of the
      //     schema's 7 fast index slots.
      //   • `dueDate` — RANGE: ordered `from`/`to`/`prefix` queries ("tasks due this
      //     week", "due in 2026-06"). Range lookups use a relationship row, not a
      //     slot, and are billed at the range rate. ISO-8601 sorts chronologically,
      //     so the order is correct.
      // `externalId` has a built-in first-class finder and must NOT be redeclared here.
      lookupFields: ['project', { fieldName: 'dueDate', rangeEnabled: true }],
    },
  ],

  // Least-privilege profile — MUST pass the CLI scope gate.
  // r/c/u + search + schema discovery. NOT records:d (least privilege).
  accessProfile: {
    allowedActions: ['records:r', 'records:c', 'records:u', 'search:r', 'schemas:r'],
    // dataScope omitted → tenant-level shared tracker. Add a `scope:org`
    // entry for per-org isolation.
  },

  servicePrincipal: {
    externalId: 'task-management',
    displayName: 'Task Management',
  },

  seed: [
    {
      surface: 'record',
      typeName: 'task',
      externalId: 'seed-welcome',
      fields: {
        title: 'Welcome to your Vectros task tracker',
        description: 'Created by the bootstrap loader. Ask your agent to add tasks.',
        status: 'todo',
        priority: 'low',
        project: 'getting-started',
        dueDate: '2026-06-30',
      },
    },
  ],
};

export default taskManagement;
