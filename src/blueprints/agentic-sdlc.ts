/**
 * Bundled blueprint: agentic-sdlc.
 *
 * A system of record for the whole software-delivery lifecycle,
 * built for an AI development team. It primarily serves AGENTS working on behalf
 * of humans (and the humans themselves) — the durable, governed, searchable
 * memory a coding/ops agent needs so it stops re-deriving decisions and
 * re-breaking the same things every cold start.
 *
 * The organizing principle is CONTENT vs STRUCTURE:
 *   - DOCUMENTS are content-dominant — the markdown body IS the artifact, and the
 *     typed metadata supports recall + the graph. ADRs, design docs, reference
 *     guides, runbooks, and post-mortems are documents (you read them; you ask
 *     them questions). They bind a schema on the `document` surface, are ingested
 *     via `document_ingest`, and their prose is what hybrid search + `rag_ask`
 *     answer over.
 *   - RECORDS are structure-dominant — the typed fields ARE the artifact. Controls
 *     (compliance rows), conventions (operating rules), gotchas (symptom/cause/fix),
 *     and glossary terms are records: short, exact-queryable, enumerable.
 *
 * The knowledge graph deliberately CROSSES surfaces: a `control` (record) is
 * proven by a `runbook` (document); a `convention` (record) cites the `decision`
 * (document) that established it; a `term` (record) links to the `decision` that
 * defines it; and documents reference documents (a design → its decision, a
 * runbook → the post-mortem it was born from, an ADR → the one it supersedes).
 * Record→document and document→document typed references are the showcase — typed
 * documents are first-class graph nodes, not opaque blobs.
 *
 * Agent memory is a first-class concern here, but it is NOT a separate "memory"
 * type: the durable, shareable things a team teaches its agents ARE operating
 * rules (`convention`), how-tos (`reference`), traps (`gotcha`), and decisions
 * (`decision`). Per-user PRIVATE/isolated memory (userId-scoped) is a deliberate
 * future chapter, not in this version.
 *
 * No bundled SEED in this version: the content artifacts live on the document
 * surface and the cross-surface graph is populated by the ingest agent (the
 * `document_ingest` / `record_create` path), not the bootstrap seed step — so the
 * context provisions empty and is filled from your corpus. (Production contexts
 * use `vectros bootstrap --no-seed` regardless.)
 *
 * allowedActions = [records:r, records:c, records:u, search:r, schemas:r,
 *                   inference:r, documents:r, documents:c, folders:r, folders:c].
 * Knowledge is SUPERSEDED / RETIRED via a status flip, never deleted (no :d).
 */
import type { Blueprint } from '../types.js';

// The base data-plane action set — the scope of the `ssk_*` service-principal key
// the bootstrap mints (the MCP/API runtime). r/c/u records + search + schema
// discovery + inference:r (grounded recall over document bodies) + document/folder
// r/c. Intentionally NO :d for the service key: the agent curates by superseding /
// retiring knowledge via a reversible status flip (archive), never a hard delete —
// so the trail of how the team's thinking evolved stays intact, and a compromised or
// mistaken key cannot purge the KB. The human `editor` role additionally gets delete.
const DATA_PLANE_ACTIONS = [
  'records:r',
  'records:c',
  'records:u',
  'search:r',
  'schemas:r',
  'inference:r',
  'documents:r',
  'documents:c',
  'folders:r',
  'folders:c',
];

// The human owner's `editor` role: the base data-plane set PLUS hard delete across
// the data plane. A human curator is trusted to permanently remove genuine strays /
// mistakes; the agent service key is not — it archives (reversible) instead. Deleting
// only your own data (rather than any in the context) is a tighter grant that needs a
// per-user ownership identity on the credential; that variant is a separate concern.
const EDITOR_ACTIONS = [...DATA_PLANE_ACTIONS, 'records:d', 'documents:d', 'folders:d'];

const agenticSdlc: Blueprint = {
  name: 'agentic-sdlc',
  version: '1.2.0',
  description:
    "A whole-SDLC system of record for an AI development team — decisions, designs, references, runbooks, post-mortems (as documents) plus controls, conventions, gotchas, and a glossary (as records), cross-linked and recalled by meaning.",

  contextId: 'agentic-sdlc',
  contextName: 'Agentic SDLC Knowledge Base',

  schemas: [
    // ============================ DOCUMENTS ============================
    // Content-dominant: the markdown body is the artifact; fields are metadata.
    // Each binds the `document` surface and is ingested via `document_ingest`.

    {
      // An architecture/product DECISION (an ADR). The body is the prose —
      // Context / Decision / Consequences — and is what `rag_ask` answers over;
      // the fields below are filter/sort metadata + the supersede chain. The
      // anchor of the graph: most other types link back to a decision.
      typeName: 'decision',
      displayName: 'Decision (ADR)',
      indexMode: 'HYBRID',
      allowedSurfaces: ['document'],
      // A document carries an INTRINSIC title (the ingest title) + body; the schema
      // declares only the metadata BEYOND those. (No typed `title` field — that
      // would duplicate the document's own title.)
      fields: [
        {
          fieldId: 'summary',
          fieldType: 'string',
          searchable: true,
          description: 'A one-paragraph abstract of the decision. The full reasoning is the document body.',
          renderHints: { label: 'Summary', widget: 'textarea', order: 2 },
        },
        {
          fieldId: 'status',
          fieldType: 'enum',
          filterable: true,
          enumValues: ['proposed', 'accepted', 'superseded', 'deprecated'],
          renderHints: { label: 'Status', widget: 'select', order: 3 },
        },
        {
          fieldId: 'area',
          fieldType: 'string',
          filterable: true,
          description: 'Subsystem the decision applies to (e.g. "search", "auth", "billing").',
          renderHints: { label: 'Area', widget: 'text', order: 4 },
        },
        {
          fieldId: 'tags',
          fieldType: 'array',
          filterable: true,
          description: 'Freeform labels (e.g. "security", "schema"). Search-side filter.',
          renderHints: { label: 'Tags', order: 5 },
        },
        {
          // Self-reference (document → document): the decision this one supersedes.
          fieldId: 'supersedes',
          fieldType: 'reference',
          targetTypeName: 'decision',
          targetSurface: 'document',
          targetField: 'externalId',
          cardinality: 'one',
          description: 'The decision this one supersedes (by externalId).',
          renderHints: { label: 'Supersedes', order: 6 },
        },
        {
          fieldId: 'date',
          fieldType: 'date',
          description: 'ISO-8601 decision date. Range-queryable / sortable.',
          renderHints: { label: 'Date', widget: 'date', order: 7 },
        },
      ],
      lookupFields: ['status', 'area', 'supersedes', { fieldName: 'date', rangeEnabled: true }],
    },
    {
      // A DESIGN doc or spec — the exploration that drives a decision. Distinct
      // from `decision` (a different browse genre + it links to the decision it
      // informs). Body = the design narrative.
      typeName: 'design',
      displayName: 'Design',
      indexMode: 'HYBRID',
      allowedSurfaces: ['document'],
      // Intrinsic title + body; schema = metadata beyond those (no typed `title`).
      fields: [
        {
          fieldId: 'summary',
          fieldType: 'string',
          searchable: true,
          description: 'A one-paragraph abstract. The full design is the document body.',
          renderHints: { label: 'Summary', widget: 'textarea', order: 2 },
        },
        {
          fieldId: 'status',
          fieldType: 'enum',
          filterable: true,
          enumValues: ['draft', 'active', 'implemented', 'superseded'],
          renderHints: { label: 'Status', widget: 'select', order: 3 },
        },
        {
          fieldId: 'area',
          fieldType: 'string',
          filterable: true,
          renderHints: { label: 'Area', widget: 'text', order: 4 },
        },
        {
          fieldId: 'tags',
          fieldType: 'array',
          filterable: true,
          renderHints: { label: 'Tags', order: 5 },
        },
        {
          // Cross-document edge: the decision this design informs/produces.
          fieldId: 'relatedDecision',
          fieldType: 'reference',
          targetTypeName: 'decision',
          targetSurface: 'document',
          targetField: 'externalId',
          cardinality: 'one',
          description: 'The decision this design informs (by externalId).',
          renderHints: { label: 'Related decision', order: 6 },
        },
        {
          // Self-reference: a design supersedes an earlier design/spec.
          fieldId: 'supersedes',
          fieldType: 'reference',
          targetTypeName: 'design',
          targetSurface: 'document',
          targetField: 'externalId',
          cardinality: 'one',
          description: 'The design this one supersedes (by externalId).',
          renderHints: { label: 'Supersedes', order: 7 },
        },
        {
          fieldId: 'updatedOn',
          fieldType: 'date',
          description: 'ISO-8601 — when last revised. Range-queryable.',
          renderHints: { label: 'Updated on', widget: 'date', order: 8 },
        },
      ],
      lookupFields: ['status', 'area', 'relatedDecision', 'supersedes', { fieldName: 'updatedOn', rangeEnabled: true }],
    },
    {
      // A REFERENCE doc — maintained "how it works / how to": guides, onboarding,
      // API docs, process docs. Body = the prose. Distinct shape: a `category`
      // (DRY sub-labels — onboarding/api/process are same shape) and `lastReviewed`
      // (freshness is the whole game for reference material).
      typeName: 'reference',
      displayName: 'Reference',
      indexMode: 'HYBRID',
      allowedSurfaces: ['document'],
      // Intrinsic title + body; schema = metadata beyond those (no typed `title`).
      fields: [
        {
          fieldId: 'summary',
          fieldType: 'string',
          searchable: true,
          description: 'A one-paragraph abstract. The full reference is the document body.',
          renderHints: { label: 'Summary', widget: 'textarea', order: 2 },
        },
        {
          // The sub-kind, as a filterable field (not a separate schema — these are
          // the same shape, differing only by label, so a field is the DRY choice).
          fieldId: 'category',
          fieldType: 'enum',
          filterable: true,
          enumValues: ['guide', 'onboarding', 'api', 'process', 'other'],
          renderHints: { label: 'Category', widget: 'select', order: 3 },
        },
        {
          fieldId: 'area',
          fieldType: 'string',
          filterable: true,
          renderHints: { label: 'Area', widget: 'text', order: 4 },
        },
        {
          fieldId: 'tags',
          fieldType: 'array',
          filterable: true,
          renderHints: { label: 'Tags', order: 5 },
        },
        {
          fieldId: 'status',
          fieldType: 'enum',
          filterable: true,
          enumValues: ['active', 'superseded'],
          renderHints: { label: 'Status', widget: 'select', order: 6 },
        },
        {
          // Optional cross-document edge: the decision behind this reference.
          fieldId: 'relatedDecision',
          fieldType: 'reference',
          targetTypeName: 'decision',
          targetSurface: 'document',
          targetField: 'externalId',
          cardinality: 'one',
          description: 'The decision behind this reference, if any (by externalId).',
          renderHints: { label: 'Related decision', order: 7 },
        },
        {
          // Freshness — "references not reviewed since X". The reference-doc signal.
          fieldId: 'lastReviewed',
          fieldType: 'date',
          description: 'ISO-8601 — when this reference was last verified current. Range-queryable.',
          renderHints: { label: 'Last reviewed', widget: 'date', order: 8 },
        },
      ],
      lookupFields: ['category', 'area', 'status', 'relatedDecision', { fieldName: 'lastReviewed', rangeEnabled: true }],
    },
    {
      // A RUNBOOK — a step-by-step operational procedure (deploy, release, recover).
      // Body = the procedure. Distinct browse genre, and often BORN FROM a
      // post-mortem (its resolution, codified) — a cross-document edge.
      typeName: 'runbook',
      displayName: 'Runbook',
      indexMode: 'HYBRID',
      allowedSurfaces: ['document'],
      // Intrinsic title + body; schema = metadata beyond those (no typed `title`).
      fields: [
        {
          fieldId: 'summary',
          fieldType: 'string',
          searchable: true,
          description: 'When to use this runbook — the trigger. The steps are the document body.',
          renderHints: { label: 'Summary', widget: 'textarea', order: 2 },
        },
        {
          fieldId: 'area',
          fieldType: 'string',
          filterable: true,
          renderHints: { label: 'Area', widget: 'text', order: 3 },
        },
        {
          fieldId: 'tags',
          fieldType: 'array',
          filterable: true,
          renderHints: { label: 'Tags', order: 4 },
        },
        {
          fieldId: 'status',
          fieldType: 'enum',
          filterable: true,
          enumValues: ['active', 'retired'],
          renderHints: { label: 'Status', widget: 'select', order: 5 },
        },
        {
          // Cross-document edge: the post-mortem whose resolution this runbook codifies.
          fieldId: 'bornFrom',
          fieldType: 'reference',
          targetTypeName: 'postmortem',
          targetSurface: 'document',
          targetField: 'externalId',
          cardinality: 'one',
          description: 'The post-mortem this runbook was codified from (by externalId).',
          renderHints: { label: 'Born from (post-mortem)', order: 6 },
        },
        {
          fieldId: 'relatedDecision',
          fieldType: 'reference',
          targetTypeName: 'decision',
          targetSurface: 'document',
          targetField: 'externalId',
          cardinality: 'one',
          description: 'A decision this runbook implements, if any (by externalId).',
          renderHints: { label: 'Related decision', order: 7 },
        },
        {
          fieldId: 'updatedOn',
          fieldType: 'date',
          description: 'ISO-8601 — when last revised. Range-queryable.',
          renderHints: { label: 'Updated on', widget: 'date', order: 8 },
        },
      ],
      lookupFields: ['area', 'status', 'bornFrom', 'relatedDecision', { fieldName: 'updatedOn', rangeEnabled: true }],
    },
    {
      // A POST-MORTEM — what broke and the durable lesson. Body = the writeup
      // (impact / root cause / resolution / lesson). Distinct shape: `severity` +
      // `occurredOn` (the incident timeline). "Have we hit this before?" lives here.
      typeName: 'postmortem',
      displayName: 'Post-mortem',
      indexMode: 'HYBRID',
      allowedSurfaces: ['document'],
      // Intrinsic title + body; schema = metadata beyond those (no typed `title`).
      fields: [
        {
          fieldId: 'summary',
          fieldType: 'string',
          searchable: true,
          description: 'What happened, in brief. The full analysis (impact/root cause/resolution/lesson) is the body.',
          renderHints: { label: 'Summary', widget: 'textarea', order: 2 },
        },
        {
          fieldId: 'severity',
          fieldType: 'enum',
          filterable: true,
          enumValues: ['low', 'medium', 'high', 'critical'],
          renderHints: { label: 'Severity', widget: 'select', order: 3 },
        },
        {
          fieldId: 'status',
          fieldType: 'enum',
          filterable: true,
          enumValues: ['open', 'mitigated', 'resolved'],
          renderHints: { label: 'Status', widget: 'select', order: 4 },
        },
        {
          fieldId: 'area',
          fieldType: 'string',
          filterable: true,
          renderHints: { label: 'Area', widget: 'text', order: 5 },
        },
        {
          fieldId: 'tags',
          fieldType: 'array',
          filterable: true,
          renderHints: { label: 'Tags', order: 6 },
        },
        {
          fieldId: 'relatedDecision',
          fieldType: 'reference',
          targetTypeName: 'decision',
          targetSurface: 'document',
          targetField: 'externalId',
          cardinality: 'one',
          description: 'A decision implicated in or addressed by this incident (by externalId).',
          renderHints: { label: 'Related decision', order: 7 },
        },
        {
          fieldId: 'occurredOn',
          fieldType: 'date',
          description: 'ISO-8601 — when it happened. Range-queryable — "incidents this month".',
          renderHints: { label: 'Occurred on', widget: 'date', order: 8 },
        },
      ],
      lookupFields: ['severity', 'status', 'area', 'relatedDecision', { fieldName: 'occurredOn', rangeEnabled: true }],
    },

    // ============================= RECORDS =============================
    // Structure-dominant: the typed fields are the artifact. Short, exact-queryable.

    {
      // A governance CONTROL — a policy/standard/control the codebase must satisfy,
      // WITH its evidence. The compliance instrument: it records what enforces it
      // (`evidence`), the runbook that VERIFIES it (cross-surface → document), and
      // the decision that mandates it. "Which critical controls are active, and how
      // is each proven?"
      typeName: 'control',
      displayName: 'Control',
      indexMode: 'HYBRID',
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
          description: 'The requirement — what must always hold.',
          renderHints: { label: 'Statement', widget: 'textarea', order: 2 },
        },
        {
          fieldId: 'rationale',
          fieldType: 'string',
          searchable: true,
          description: 'Why the control exists — the risk it prevents.',
          renderHints: { label: 'Rationale', widget: 'textarea', order: 3 },
        },
        {
          // The policy → implementation spectrum in one filterable field.
          fieldId: 'kind',
          fieldType: 'enum',
          filterable: true,
          enumValues: ['policy', 'standard', 'control'],
          renderHints: { label: 'Kind', widget: 'select', order: 4 },
        },
        {
          // Ordinal, but EQUALITY (range/prefix order is lexical, so low<critical
          // would sort alphabetically). Enumerate "all critical controls" by equality.
          fieldId: 'criticality',
          fieldType: 'enum',
          filterable: true,
          enumValues: ['low', 'medium', 'high', 'critical'],
          renderHints: { label: 'Criticality', widget: 'select', order: 5 },
        },
        {
          fieldId: 'evidence',
          fieldType: 'string',
          searchable: true,
          description: 'What enforces or proves the control inline (e.g. an architecture test or gate).',
          renderHints: { label: 'Evidence', widget: 'textarea', order: 6 },
        },
        {
          fieldId: 'status',
          fieldType: 'enum',
          filterable: true,
          enumValues: ['draft', 'active', 'retired'],
          renderHints: { label: 'Status', widget: 'select', order: 7 },
        },
        {
          fieldId: 'area',
          fieldType: 'string',
          filterable: true,
          renderHints: { label: 'Area', widget: 'text', order: 8 },
        },
        {
          fieldId: 'tags',
          fieldType: 'array',
          filterable: true,
          renderHints: { label: 'Tags', order: 9 },
        },
        {
          // Cross-surface edge (record → document): the runbook that proves the control.
          fieldId: 'verifiedBy',
          fieldType: 'reference',
          targetTypeName: 'runbook',
          targetSurface: 'document',
          targetField: 'externalId',
          cardinality: 'one',
          description: 'The runbook that verifies this control (by externalId).',
          renderHints: { label: 'Verified by (runbook)', order: 10 },
        },
        {
          // Cross-surface edge (record → document): the decision that mandates it.
          fieldId: 'relatedDecision',
          fieldType: 'reference',
          targetTypeName: 'decision',
          targetSurface: 'document',
          targetField: 'externalId',
          cardinality: 'one',
          description: 'The decision that mandates this control (by externalId).',
          renderHints: { label: 'Related decision', order: 11 },
        },
        {
          fieldId: 'reviewedOn',
          fieldType: 'date',
          description: 'ISO-8601 last-reviewed date. Range-queryable.',
          renderHints: { label: 'Reviewed on', widget: 'date', order: 12 },
        },
        {
          // Provenance for sync: the source file this record was distilled from. A
          // record can't carry an in-file marker the way a document can (many records
          // come from one file), so it names its source instead — a change to that file
          // finds (equality lookup) and re-extracts exactly its records. Equality, not
          // range: file-level is the sync unit (re-extraction reprocesses the whole file),
          // and the schema keeps its single range lookup for the date row.
          fieldId: 'sourceRef',
          fieldType: 'string',
          filterable: true,
          description: 'The source file (repo path) this record was extracted from — its provenance; a change to that file re-extracts its records. The specific section is encoded in the record externalId.',
          renderHints: { label: 'Source ref', widget: 'text', order: 13 },
        },
      ],
      lookupFields: [
        'kind',
        'criticality',
        'status',
        'area',
        'verifiedBy',
        'relatedDecision',
        { fieldName: 'reviewedOn', rangeEnabled: true },
        'sourceRef',
      ],
    },
    {
      // A CONVENTION — a must-follow operating rule the team teaches its agents. The
      // durable, shareable operating-memory. Distinct fields capture how we actually
      // write these: the `rule` (imperative), the `why` (rationale), and `howToApply`
      // (the concrete application) are SEPARATE fields, not one blob — so an agent can
      // recall the rule, the reasoning, and the how independently.
      typeName: 'convention',
      displayName: 'Convention',
      indexMode: 'HYBRID',
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
          fieldId: 'rule',
          fieldType: 'string',
          searchable: true,
          description: 'The convention itself, stated as an imperative.',
          renderHints: { label: 'Rule', widget: 'textarea', order: 2 },
        },
        {
          fieldId: 'why',
          fieldType: 'string',
          searchable: true,
          description: 'Why it matters — the trade-off / the antipattern it prevents.',
          renderHints: { label: 'Why', widget: 'textarea', order: 3 },
        },
        {
          fieldId: 'howToApply',
          fieldType: 'string',
          searchable: true,
          description: 'How to comply in practice — the concrete application steps.',
          renderHints: { label: 'How to apply', widget: 'textarea', order: 4 },
        },
        {
          fieldId: 'area',
          fieldType: 'string',
          filterable: true,
          renderHints: { label: 'Area', widget: 'text', order: 5 },
        },
        {
          fieldId: 'status',
          fieldType: 'enum',
          filterable: true,
          enumValues: ['active', 'retired'],
          renderHints: { label: 'Status', widget: 'select', order: 6 },
        },
        {
          fieldId: 'tags',
          fieldType: 'array',
          filterable: true,
          renderHints: { label: 'Tags', order: 7 },
        },
        {
          // Cross-surface edge (record → document): the decision that established it.
          fieldId: 'establishedBy',
          fieldType: 'reference',
          targetTypeName: 'decision',
          targetSurface: 'document',
          targetField: 'externalId',
          cardinality: 'one',
          description: 'The decision that established this convention (by externalId).',
          renderHints: { label: 'Established by (decision)', order: 8 },
        },
        {
          fieldId: 'updatedOn',
          fieldType: 'date',
          description: 'ISO-8601 — when last revised. Range-queryable.',
          renderHints: { label: 'Updated on', widget: 'date', order: 9 },
        },
        {
          // Provenance for sync — see the note on `control.sourceRef`.
          fieldId: 'sourceRef',
          fieldType: 'string',
          filterable: true,
          description: 'The source file (repo path) this record was extracted from — its provenance; a change to that file re-extracts its records. The specific section is encoded in the record externalId.',
          renderHints: { label: 'Source ref', widget: 'text', order: 10 },
        },
      ],
      lookupFields: [
        'area',
        'status',
        'establishedBy',
        { fieldName: 'updatedOn', rangeEnabled: true },
        'sourceRef',
      ],
    },
    {
      // A GOTCHA / sharp edge: a symptom, its cause, and the fix. A tight typed
      // triple — found by meaning (semantic search on the symptom) + area/status.
      // The most standalone type; no typed edge.
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
          fieldId: 'status',
          fieldType: 'enum',
          filterable: true,
          enumValues: ['active', 'resolved'],
          renderHints: { label: 'Status', widget: 'select', order: 5 },
        },
        {
          fieldId: 'tags',
          fieldType: 'array',
          filterable: true,
          renderHints: { label: 'Tags', order: 6 },
        },
        {
          fieldId: 'discoveredOn',
          fieldType: 'date',
          description: 'ISO-8601 — when first hit. Range-queryable.',
          renderHints: { label: 'Discovered on', widget: 'date', order: 7 },
        },
        {
          // Provenance for sync — see the note on `control.sourceRef`.
          fieldId: 'sourceRef',
          fieldType: 'string',
          filterable: true,
          description: 'The source file (repo path) this record was extracted from — its provenance; a change to that file re-extracts its records. The specific section is encoded in the record externalId.',
          renderHints: { label: 'Source ref', widget: 'text', order: 8 },
        },
      ],
      lookupFields: [
        'area',
        'status',
        { fieldName: 'discoveredOn', rangeEnabled: true },
        'sourceRef',
      ],
    },
    {
      // A glossary TERM — a definition keyed by the term itself. Structure-dominant:
      // `term` is a UNIQUE exact-lookup key (the showcase of a uniqueness constraint),
      // `definition` is the RAG body, `aliases` catch alternate names. Links to the
      // decision that defines/establishes the concept where there is one.
      typeName: 'term',
      displayName: 'Glossary term',
      indexMode: 'HYBRID',
      fields: [
        {
          fieldId: 'term',
          fieldType: 'string',
          required: true,
          searchable: true,
          validation: { minLength: 1, maxLength: 200 },
          renderHints: { label: 'Term', widget: 'text', order: 1, displayField: true },
        },
        {
          fieldId: 'definition',
          fieldType: 'string',
          searchable: true,
          description: 'What the term means — the RAG-able body.',
          renderHints: { label: 'Definition', widget: 'textarea', order: 2 },
        },
        {
          fieldId: 'aliases',
          fieldType: 'array',
          filterable: true,
          description: 'Alternate names / abbreviations for the same concept.',
          renderHints: { label: 'Aliases', order: 3 },
        },
        {
          fieldId: 'area',
          fieldType: 'string',
          filterable: true,
          renderHints: { label: 'Area', widget: 'text', order: 4 },
        },
        {
          fieldId: 'tags',
          fieldType: 'array',
          filterable: true,
          renderHints: { label: 'Tags', order: 5 },
        },
        {
          fieldId: 'relatedDecision',
          fieldType: 'reference',
          targetTypeName: 'decision',
          targetSurface: 'document',
          targetField: 'externalId',
          cardinality: 'one',
          description: 'A decision that defines or establishes this term (by externalId).',
          renderHints: { label: 'Related decision', order: 6 },
        },
        {
          fieldId: 'updatedOn',
          fieldType: 'date',
          description: 'ISO-8601 — when last revised. Range-queryable.',
          renderHints: { label: 'Updated on', widget: 'date', order: 7 },
        },
        {
          // Provenance for sync — see the note on `control.sourceRef`.
          fieldId: 'sourceRef',
          fieldType: 'string',
          filterable: true,
          description: 'The source file (repo path) this record was extracted from — its provenance; a change to that file re-extracts its records. The specific section is encoded in the record externalId.',
          renderHints: { label: 'Source ref', widget: 'text', order: 8 },
        },
      ],
      // `term` is a UNIQUE equality lookup — exact "define X" + a one-per-term
      // guarantee. `area`/`relatedDecision` enumerate; `updatedOn` is the range row.
      lookupFields: [
        { fieldName: 'term', unique: true },
        'area',
        'relatedDecision',
        { fieldName: 'updatedOn', rangeEnabled: true },
        'sourceRef',
      ],
    },
  ],

  // Least-privilege, data-plane only. The scope of the `ssk_*` key the bootstrap
  // mints for THIS blueprint's service principal (the MCP/API runtime). See
  // DATA_PLANE_ACTIONS above for the action set + rationale.
  accessProfile: {
    allowedActions: DATA_PLANE_ACTIONS,
  },

  // A reusable `editor` role for the HUMAN owner — DISTINCT from `accessProfile`
  // (which scopes only the service-principal key). `bootstrap` provisions this
  // role in the context but binds it to no one; the owner joins themselves so the
  // data-plane app (app.vectros.ai) shows their KB — its switcher lists only
  // contexts the signed-in user holds an active access profile in, and bootstrap
  // grants the human none by default. Bind it after bootstrap with:
  //   vectros access grant --principal usr_<your-user-id> --context agentic-sdlc --role editor
  // (or the admin app's Access > Contexts > agentic-sdlc > Profiles > Create).
  // The editor gets the full data plane so a human curator can browse, write/correct,
  // AND hard-delete the KB (EDITOR_ACTIONS = the service key's set + delete). The
  // service key deliberately lacks delete and archives instead; the trusted human
  // owner may permanently remove genuine strays. Still no control-plane action, so
  // the scope gate accepts it as a data-plane-only role.
  roles: {
    editor: [{ allowedActions: EDITOR_ACTIONS }],
  },

  servicePrincipal: {
    externalId: 'agentic-sdlc',
    displayName: 'Agentic SDLC Knowledge Base',
  },

  // No bundled seed in this version: the content artifacts live on the document
  // surface and the cross-surface graph is populated by the ingest agent
  // (document_ingest / record_create), not the bootstrap seed step. Production
  // contexts provision with `vectros bootstrap --no-seed` regardless.
};

export default agenticSdlc;
