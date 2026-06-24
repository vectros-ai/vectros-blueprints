/**
 * Bundled blueprint: clinical-intake.
 *
 * A behavioral-health intake record — the healthcare-lead exemplar. It exists
 * to make Vectros's compliance posture VISIBLE in a no-code demo: fields marked
 * `sensitive` (PHI) are, by the platform, redacted from audit history AT WRITE
 * TIME (destroyed, not masked — unrecoverable regardless of scope), excluded
 * from the search index, blind-indexed for exact lookup, and masked in
 * responses unless the token carries the `s` reveal scope.
 *
 * The "aha" walkthrough: bootstrap → create an intake with a `sensitive` SSN
 * and clinical note → open the record's version history (in app.vectros.ai or
 * via the MCP server) and see the sensitive fields show `[redacted]` in EVERY
 * historical row → search for a phrase from the note and get zero hits → AND
 * STILL find the record by exact client name via the blind-index lookup
 * (the value is HMAC'd into the index, never stored in the clear). The
 * compliance story you can run in 60 seconds, on synthetic data only.
 *
 * `capabilities.auditHistory: true` is explicit (it is the platform default,
 * but a compliance exemplar should self-document its audit posture).
 *
 * PHI HYGIENE: the seed and every example use SYNTHETIC data only. Never enter
 * real PHI into a demo tenant.
 *
 * allowedActions = [records:r, records:c, records:u, search:r, schemas:r].
 * Deliberately NO records:d (intake records are retained, not deleted) and NO
 * `s` reveal scope — so the bootstrapped key itself cannot un-redact sensitive
 * fields, which is the point of the demo. No `inference:r` either: a PHI corpus
 * is the one place we do NOT hand the demo key a RAG capability.
 */
import type { Blueprint } from '../types.js';

const clinicalIntake: Blueprint = {
  name: 'clinical-intake',
  version: '1.0.0',
  description:
    'Behavioral-health intake with PHI fields — demonstrates redact-at-write, audit history, blind-index lookup, and search exclusion. Synthetic data only.',

  contextId: 'clinical-intake',
  contextName: 'Clinical Intake',

  schemas: [
    {
      typeName: 'intake',
      displayName: 'Intake',
      indexMode: 'HYBRID',
      capabilities: { auditHistory: true }, // self-documenting compliance posture
      fields: [
        // --- Non-sensitive, searchable/filterable working fields ---
        {
          fieldId: 'caseId',
          fieldType: 'string',
          required: true,
          description: 'Caller-stable intake id; the dedup/lookup key.',
          validation: { minLength: 1, maxLength: 64 },
          renderHints: { label: 'Case ID', widget: 'text', order: 1, section: 'Intake', displayField: true },
        },
        {
          fieldId: 'presentingConcern',
          fieldType: 'string',
          searchable: true,
          description: 'Non-PHI summary of the presenting concern — safe to index + search.',
          validation: { maxLength: 2000 },
          renderHints: { label: 'Presenting concern', widget: 'textarea', order: 2, section: 'Intake' },
        },
        {
          fieldId: 'program',
          fieldType: 'string',
          filterable: true,
          description: 'Program / service line the intake is routed to.',
          renderHints: { label: 'Program', widget: 'text', order: 3, section: 'Intake' },
        },
        {
          fieldId: 'status',
          fieldType: 'enum',
          filterable: true,
          enumValues: ['new', 'in_review', 'scheduled', 'closed'],
          renderHints: { label: 'Status', widget: 'select', order: 4, section: 'Intake' },
        },
        {
          fieldId: 'submittedAt',
          fieldType: 'date',
          description: 'ISO-8601. Range-queryable — a coordinator can pull "intakes submitted this week".',
          renderHints: { label: 'Submitted', widget: 'date', order: 5, section: 'Intake' },
        },

        // --- Sensitive (PHI) fields: redacted-at-write, search-excluded, masked-on-read ---
        {
          fieldId: 'clientName',
          fieldType: 'string',
          sensitive: true,
          description: 'PHI. Blind-indexed for EXACT lookup (a lookup field below); never in the search index or audit log.',
          renderHints: { label: 'Client name', widget: 'text', order: 10, section: 'Client (PHI)' },
        },
        {
          fieldId: 'dateOfBirth',
          fieldType: 'string',
          sensitive: true,
          description: 'PHI. ISO-8601. Redacted from audit history at write time.',
          renderHints: { label: 'Date of birth', widget: 'date', order: 11, section: 'Client (PHI)' },
        },
        {
          fieldId: 'ssn',
          fieldType: 'string',
          sensitive: true,
          description: 'PHI. Destroyed before the audit snapshot is written — unrecoverable.',
          validation: { pattern: '^\\d{3}-\\d{2}-\\d{4}$' },
          renderHints: { label: 'SSN', widget: 'text', order: 12, section: 'Client (PHI)' },
        },
        {
          fieldId: 'clinicalNote',
          fieldType: 'string',
          sensitive: true,
          description: 'PHI free-text. Excluded from search so a note phrase never leaks via results.',
          renderHints: { label: 'Clinical note', widget: 'textarea', order: 13, section: 'Client (PHI)' },
        },
      ],
      // Lookup fields back access patterns without a search. The equality-vs-range
      // (and sensitive-blind-index) choice per field is MIGRATION-LOCKED once the
      // schema is live — chosen deliberately:
      //   • `caseId` (unique) — EQUALITY: exact get by the stable intake id.
      //   • `program`/`status` — EQUALITY (categorical): a coordinator ENUMERATES a
      //     worklist ("all outpatient-counseling intakes", "all new intakes").
      //   • `clientName` — a SENSITIVE equality lookup: the value is HMAC'd into a
      //     per-tenant BLIND INDEX, so "find the intake for this exact client name"
      //     works WITHOUT the name ever being stored in the clear or entering search.
      //     A sensitive lookup is equality-only — a blind hash is not orderable, so
      //     it can never be range-enabled.
      //   • `submittedAt` — RANGE: ordered `from`/`to`/`prefix` for a date worklist.
      // 4 equality lookups (of 7 fast slots) + 1 range row. The OTHER PHI fields
      // (dateOfBirth/ssn/clinicalNote) are deliberately NOT lookups here.
      lookupFields: [
        { fieldName: 'caseId', unique: true },
        'program',
        'status',
        'clientName',
        { fieldName: 'submittedAt', rangeEnabled: true },
      ],
    },
  ],

  // Least-privilege, data-plane only. No records:d (retain intakes), NO `s`
  // reveal qualifier (the demo key literally cannot un-redact the PHI fields),
  // and NO inference:r (we never point a RAG capability at a PHI corpus here).
  accessProfile: {
    allowedActions: ['records:r', 'records:c', 'records:u', 'search:r', 'schemas:r'],
  },

  servicePrincipal: {
    externalId: 'clinical-intake',
    displayName: 'Clinical Intake',
  },

  seed: [
    {
      typeName: 'intake',
      externalId: 'seed-synthetic-intake',
      fields: {
        caseId: 'seed-synthetic-intake',
        presentingConcern: 'Sleep difficulty and low mood over the past month; seeking counseling.',
        program: 'outpatient-counseling',
        status: 'new',
        submittedAt: '2026-06-14',
        // SYNTHETIC PHI — illustrative only, not a real person.
        clientName: 'Jordan Sample',
        dateOfBirth: '1990-01-01',
        ssn: '000-00-0000',
        clinicalNote:
          'Synthetic note for demonstration. Reports difficulty sleeping; no acute safety concerns noted.',
      },
    },
  ],
};

export default clinicalIntake;
