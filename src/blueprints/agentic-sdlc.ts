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
 * Agent memory comes in two tiers here, both governed by ownership — never by an
 * app-enforced field:
 *   - The CURATED, SHARED knowledge base is the record/document types above —
 *     operating rules (`convention`), how-tos (`reference`), traps (`gotcha`),
 *     decisions (`decision`). Written by the service key / human editor; read and
 *     semantically recalled by every member. The crystallized tier.
 *   - PRIVATE memory is the `memory` type owned by the principal alone: episodic
 *     session scratch (`threadId`), low-confidence observations being staged,
 *     personal working notes. A memory matures by PROMOTION — supersede the
 *     private record and re-create it as a curated type — leaving an auditable
 *     trail.
 * A third tier — TEAM working memory (the same `memory` type shared at a group
 * scope, the fresher layer members write for each other) — is a planned
 * addition, deferred while the shared-scope ownership axis is finalized so the
 * blueprint does not bake a shape that is about to change. When it lands, the
 * SAME `memory` type serves it (the tier is a role clause + a write-time scope
 * choice, not a new schema). Meanwhile: status of tracked work belongs in your
 * issue tracker; memory holds the context AROUND it.
 *
 * No bundled SEED in this version: the content artifacts live on the document
 * surface and the cross-surface graph is populated by the ingest agent (the
 * `document_ingest` / `record_create` path), not the bootstrap seed step — so the
 * context provisions empty and is filled from your corpus. (Production contexts
 * use `vectros bootstrap --no-seed` regardless.)
 *
 * allowedActions = [records:r, records:c, records:u, search:r, schemas:r,
 *                   inference:r, documents:r, documents:c, documents:u,
 *                   folders:r, folders:c].
 * Knowledge is SUPERSEDED / RETIRED via a reversible status flip (records:u for
 * records, documents:u to archive/re-ingest a document body), never hard-deleted
 * (no :d for the service key — that stays on the human `editor` role).
 */
import type { Blueprint } from '../types.js';

// The base data-plane action set — the scope of the `ssk_*` service-principal key
// the bootstrap mints (the MCP/API runtime). r/c/u records + search + schema
// discovery + inference:r (grounded recall over document bodies) + document r/c/u +
// folder r/c. `documents:u` is load-bearing, not incidental: it is what lets the
// agent (a) SOFT-RETRACT a document via a reversible status flip (`ARCHIVED` pulls it
// from recall while keeping the row + body — the document-surface analog of the
// `records:u` supersede the agent already does), and (b) RE-INGEST a changed document
// body (`document_ingest` with `upsert`), which is the repo↔KB sync primitive the
// bundled guide documents. Without it the agent could create docs but never keep them
// fresh or retire them — it would only ever accrete stale content.
// Intentionally NO :d for the service key: the agent curates by that reversible
// archive, never a hard delete — so the trail of how the team's thinking evolved
// stays intact, and a compromised or mistaken key cannot PURGE the KB (an archived
// document is always restorable). The human `editor` role additionally gets delete.
const DATA_PLANE_ACTIONS = [
  'records:r',
  'records:c',
  'records:u',
  'search:r',
  'schemas:r',
  'inference:r',
  'documents:r',
  'documents:c',
  'documents:u',
  'folders:r',
  'folders:c',
];

// The human owner's `editor` role: the base data-plane set PLUS hard delete across
// the data plane. A human curator is trusted to permanently remove genuine strays /
// mistakes; the agent service key is not — it archives (reversible) instead. Deleting
// only your own data (rather than any in the context) is a tighter grant that needs a
// per-user ownership identity on the credential; that variant is a separate concern.
const EDITOR_ACTIONS = [...DATA_PLANE_ACTIONS, 'records:d', 'documents:d', 'folders:d'];

// The shared-KB clause a `member` gets — the team's curated knowledge, WITH
// semantic recall. Record reads are TYPE-SCOPED to the shared record types so
// this clause never grants the `memory` type: search and grounded answers are
// enforced per row against the per-type action qualifier, so a member's recall
// over this clause admits only the curated types + documents — never another
// principal's private `memory`. (`memory` recall comes from the member role's
// own-memory clause instead.)
//
// ⚠ INVARIANT (load-bearing for the document surface): this clause is UNSCOPED,
// so `documents:r` — which has no per-type qualifier fence like records do —
// reads EVERY document in the context. That is safe ONLY because members have
// NO document-CREATE grant anywhere in the role, so no private (scopes: [])
// document can exist here. Do NOT add `documents:c`/`documents:u` to any member
// clause until documents gain a per-type read qualifier; a test pins this.
const MEMBER_SHARED_READ_ACTIONS = [
  'records:r:control',
  'records:r:convention',
  'records:r:gotcha',
  'records:r:term',
  'documents:r',
  'search:r',
  'inference:r',
  'schemas:r',
  'folders:r',
];

const agenticSdlc: Blueprint = {
  name: 'agentic-sdlc',
  version: '1.6.0',
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
    {
      // ISOLATED AGENT MEMORY (the "other half" of the KB). Distinct from the
      // shared records above — which are the team's GLOBAL, curated knowledge —
      // `memory` is per-principal: a fact an agent (or the human it works for)
      // records for ITSELF, isolated by ownership via a `${{ self.userId }}`
      // role dataScope (the private tier; a team tier keyed on a shared scope is
      // a deliberate future addition, not baked in this version). Deliberately a
      // SINGLE flexible type so the recall hook queries ONE typeName; the flavor
      // is the `kind` field, mirroring the file-memory taxonomy it replaces, so
      // migration is 1:1. Isolation is enforced by the ROLE (type-scoped
      // `records:*:memory` actions + owner dataScope), NOT the schema — the
      // schema is tier-agnostic.
      typeName: 'memory',
      displayName: 'Memory',
      indexMode: 'HYBRID', // keyword on the title + semantic on the body (the recalled fact)
      fields: [
        {
          fieldId: 'title',
          fieldType: 'string',
          required: true,
          searchable: true,
          validation: { minLength: 1, maxLength: 200 },
          description: 'A short handle for the memory (the file-memory "name" slug analog).',
          renderHints: { label: 'Title', widget: 'text', order: 1, displayField: true },
        },
        {
          fieldId: 'body',
          fieldType: 'string',
          searchable: true,
          description: 'The memory itself — the durable fact, retrieved by meaning. The RAG-able body.',
          renderHints: { label: 'Body', widget: 'textarea', order: 2 },
        },
        {
          // The flavor of memory — mirrors the file-memory frontmatter `type:` so
          // a migration maps 1:1. `observation` is the episodic/scratch flavor
          // (TTL-able when the thread tier lands); the rest are durable.
          fieldId: 'kind',
          fieldType: 'enum',
          filterable: true,
          enumValues: ['user', 'feedback', 'project', 'reference', 'observation'],
          renderHints: { label: 'Kind', widget: 'select', order: 3 },
        },
        {
          // Structure axis 2 of 4: WHAT the memory is about — the same
          // subsystem/topic label every curated KB type carries, so one `area`
          // filter narrows recall across curated + memory content uniformly.
          fieldId: 'area',
          fieldType: 'string',
          filterable: true,
          description: 'Subsystem/topic the memory applies to (e.g. "auth", "search") — matches the shared types\' area vocabulary.',
          renderHints: { label: 'Area', widget: 'text', order: 4 },
        },
        {
          // Structure axis 3: WHICH FUNCTION recorded it. A small stable ROLE
          // vocabulary (e.g. "pm", "builder", "reviewer") — not an instance id:
          // instances are already distinguished by the owning principal (who)
          // + threadId (which conversation).
          fieldId: 'agent',
          fieldType: 'string',
          filterable: true,
          description: 'The agent role that recorded it (e.g. "pm", "builder") — the function, not the instance.',
          renderHints: { label: 'Agent', widget: 'text', order: 5 },
        },
        {
          fieldId: 'tags',
          fieldType: 'array',
          filterable: true,
          description: 'Freeform labels for filtering recall (e.g. "auth", "testing").',
          renderHints: { label: 'Tags', order: 6 },
        },
        {
          // The reversible supersede pattern shared with the records above — a
          // memory is retired by a status flip, never hard-deleted, so how the
          // agent's understanding evolved stays inspectable. Promotion to a
          // higher tier = supersede here + re-create at the new scope.
          fieldId: 'status',
          fieldType: 'enum',
          filterable: true,
          enumValues: ['active', 'superseded'],
          renderHints: { label: 'Status', widget: 'select', order: 7 },
        },
        {
          // Structure axis 4: WHICH CONVERSATION (episodic slice). The caller's
          // session/thread identifier — whatever the agent runtime calls it. A
          // lookup filter WITHIN what the principal owns, NOT an isolation
          // boundary; sessions of the same principal share trust.
          fieldId: 'threadId',
          fieldType: 'string',
          filterable: true,
          description: 'Optional conversation/thread id (your runtime\'s session identifier) — slices episodic memory within your own store.',
          renderHints: { label: 'Thread', widget: 'text', order: 8 },
        },
        {
          fieldId: 'updatedOn',
          fieldType: 'date',
          description: 'ISO-8601 — when last revised. Range-queryable — "what did I learn this week".',
          renderHints: { label: 'Updated on', widget: 'date', order: 9 },
        },
        {
          // Importance BAND for the always-load pinned set + recall ranking. Coarse bands
          // (0 normal / 10 pinned / 20 high / 30 critical) — pick a band, not a fiddly
          // integer, to avoid priority inflation. NULLABLE and set only on the elevated
          // subset, so the range-index cost lands only on that low-cardinality set (normal
          // memories write no range row). Orientation enumerates `priority order=desc
          // limit=X` — the read query IS the cap (overflow falls below the cutoff, never
          // evicted). MEMORY-ONLY: a pin is a memory that REFERENCES a curated item, it
          // never pins the curated item in place (pins = always-load; curated KB = recalled
          // when relevant).
          fieldId: 'priority',
          fieldType: 'number',
          filterable: true,
          description: 'Importance band (0/10/20/30) for the always-load pinned set + recall ranking. Optional — set only on elevated memories.',
          renderHints: { label: 'Priority', order: 10 },
        },
        {
          // Opaque provenance — the file / issue / URL this memory is ABOUT (records parity
          // with the curated types' sourceRef). Not a typed graph edge.
          fieldId: 'sourceRef',
          fieldType: 'string',
          description: 'Provenance: the file path / issue / URL this memory is about.',
          renderHints: { label: 'Source ref', widget: 'text', order: 11 },
        },
        {
          // The evolution/promotion trail WITHIN memory (self-ref, SAME owner): the memory
          // that replaced this one. Pairs with ARCHIVE-retire. Promotion to the curated tier
          // is copy-up + archive-down with NO shared->private back-reference, so a curated
          // (shared) artifact never embeds a private memory's id/slug.
          fieldId: 'supersededBy',
          fieldType: 'reference',
          targetTypeName: 'memory',
          targetSurface: 'record',
          targetField: 'externalId',
          cardinality: 'one',
          description: 'The memory that superseded this one (by externalId) — the evolution trail.',
          renderHints: { label: 'Superseded by', order: 12 },
        },
        {
          // The `[[see-also]]` link between a principal's own memories (self-ref, SAME
          // owner). One-cardinality in this version (the proven reference shape); a
          // many-cardinality see-also graph is a later extension.
          fieldId: 'relatedTo',
          fieldType: 'reference',
          targetTypeName: 'memory',
          targetSurface: 'record',
          targetField: 'externalId',
          cardinality: 'one',
          description: 'A related memory (by externalId) — the see-also link within your own store.',
          renderHints: { label: 'Related to', order: 13 },
        },
      ],
      // externalId is the memory's stable slug (the file-memory `name:`) — the idempotent
      // upsert key — sent top-level, not declared as a field.
      // ⚖ LEAN by design: `memory` is the HIGHEST-VOLUME, churniest record here, so it only
      // carries lookups for fields we ENUMERATE DETERMINISTICLY. `area`/`agent`/`status` are
      // `filterable` (typed SEARCH metadata — narrow recall without a per-write lookup row),
      // NOT lookups; `sourceRef` is a plain provenance field. A typical write pays just
      // `kind` (eq) + `updatedOn` (range); `threadId`/`priority` cost only when set (both
      // nullable). Contrast the curated types, which carry more lookups because they are
      // low-volume and repo-synced (`sourceRef` enumeration).
      lookupFields: [
        'kind',
        'threadId',
        { fieldName: 'updatedOn', rangeEnabled: true },
        { fieldName: 'priority', rangeEnabled: true },
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
    // The human curator. NOTE: this role is deliberately UNSCOPED (whole-context),
    // which includes members' private memory — the trusted-administrator tradeoff,
    // called out in the bundled guide. Scope it down if your deployment wants
    // curator access without private-memory visibility.
    editor: [{ allowedActions: EDITOR_ACTIONS }],
    // A team member (or their agent) — TWO memory tiers as two UNIONed clauses
    // (a record is accessible when ANY clause grants it; within one clause every
    // dataScope dimension must match):
    //   1) the CURATED shared KB (+ semantic recall). UNSCOPED, but safe: search
    //      and grounded answers are enforced per row against the per-type action
    //      qualifier, so recall over this clause admits only the content it grants
    //      a TYPED read for (the curated record types + documents) — never the
    //      `memory` type, so a member's recall never returns another principal's
    //      private memory.
    //   2) PRIVATE memory: the member's OWN `memory` records, isolated per-request
    //      by `${{ self.userId }}` (the principal dimension — the stable ownership
    //      axis, unaffected by the evolution of shared/team scopes).
    // Team-shared *working* memory (a group-owned tier every member reads and
    // writes) is a planned addition, intentionally NOT in this version: it rides
    // the ownership axis for shared scopes, which is being finalized, and this
    // blueprint avoids baking a shape that is about to change. Bind with
    // `vectros join agentic-sdlc --role member`; verify a binding with
    // `vectros access explain --principal me --context agentic-sdlc`.
    member: [
      { allowedActions: MEMBER_SHARED_READ_ACTIONS },
      {
        // `inference:r` is IN this self-scoped clause (not only clause 1) so a
        // member's `rag_ask` can ground on its OWN private memory — the read
        // grant (`records:r:memory`) and the inference capability travel in the
        // SAME clause, so grounding works regardless of cross-clause admission
        // semantics. Still self-fenced by dataScope: never another principal's.
        allowedActions: ['records:cru:memory', 'search:r', 'inference:r'],
        dataScope: { userId: ['${{ self.userId }}'] },
      },
    ],
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
