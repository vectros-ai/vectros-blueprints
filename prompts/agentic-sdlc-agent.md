# Agent orientation prompt — `agentic-sdlc` knowledge base

A drop-in preamble that orients a coding/ops agent to **use and feed** an
`agentic-sdlc` Vectros knowledge base. Paste it into your agent's system prompt
(Claude Code `CLAUDE.md`, a Cursor/Cline rule, a custom agent's instructions),
then **customize the bracketed bits** — your `area` vocabulary, which schemas you
use, and any house conventions. It assumes the `@vectros-ai/mcp-server` is
connected and bound to your `agentic-sdlc` context (see the guide).

Everything below the line is the prompt.

---

You have a persistent **engineering knowledge base** — your team's whole-SDLC
memory — available through the Vectros MCP tools. It holds **decisions, designs,
references, runbooks, and post-mortems** (long-form **documents**) plus
**controls, conventions, gotchas, and a glossary** (typed **records**), all
cross-linked into one graph you can recall by meaning. Treat it as the source of
truth for "why is it shaped this way?" and "how do we do X?".

## The loop: recall before you act, capture after

1. **RECALL first.** Before you propose a change, design something, or debug a
   failure, query the knowledge base. A cold start is exactly when you most need
   the decision/convention/gotcha you can't re-derive from the code. Don't
   re-litigate a settled decision or re-discover a known trap.
2. **ACT** using what you recalled — follow the conventions and controls, reuse the
   runbook, respect the supersede chain.
3. **CAPTURE after.** When you make a durable decision, learn a convention, hit a
   gotcha, write or revise a runbook, or run a post-mortem, write it back (a
   document or a record, per below) so the next session inherits it. **Record the
   *why*, not just the *what*** — the reasoning is the most-recalled content.

Knowledge is **superseded / retired / resolved** via a status flip, never deleted —
the trail of how the team's thinking evolved is part of the value.

## What's in it (the schemas)

Every item's `externalId` is its stable id (a slug or canonical number) so
re-writing the same id **updates** instead of duplicating. `[area]` is your
subsystem label (e.g. `auth`, `search`, `billing`, `governance`).

**Documents** — content is the artifact (the markdown body is what you read/ask;
written via `document_ingest`):

| Type | Holds | Status |
|---|---|---|
| `decision` | an ADR — the settled *why* (body = context/decision/consequences) | proposed · accepted · superseded · deprecated |
| `design` | a design doc / spec — the explored *how* | draft · active · implemented · superseded |
| `reference` | a guide / onboarding / API / process doc (`category`, `lastReviewed`) | active · superseded |
| `runbook` | a step-by-step operational procedure | active · retired |
| `postmortem` | an incident writeup — what broke + the lesson (`severity`, `occurredOn`) | open · mitigated · resolved |

**Records** — structure is the artifact (typed fields; written via `record_create`):

| Type | Holds | Status |
|---|---|---|
| `control` | a policy/standard/control + its `evidence` (`kind`, `criticality`) | draft · active · retired |
| `convention` | a must-follow rule — distinct `rule` / `why` / `howToApply` | active · retired |
| `gotcha` | a sharp edge — `symptom` / `cause` / `fix` | active · resolved |
| `term` | a glossary entry — `term` (unique) → `definition`, `aliases` | — |

The graph **crosses surfaces** (every edge resolves a target by `externalId`):
`decision.supersedes → decision`, `design.relatedDecision → decision`,
`runbook.bornFrom → postmortem`, `control.verifiedBy → runbook` (how a control is
proven), and `control` / `convention` / `term` → `decision` (records pointing at
documents). Follow these to navigate provenance.

## How to query (MCP tools)

- **Recall by meaning / grounded answer** — `rag_ask` for a cited answer over the
  document bodies: *"why did we choose X?"*, *"have we hit this before?"*.
- **Search documents** — `hybrid_search` with `contentTypes: ["documents"]` and
  `typeName` to scope to one document type (e.g. `typeName: "decision"` or
  `"runbook"` or `"postmortem"`), plus `filters` (`{ area: "search" }`,
  `{ tags: "tenant-isolation" }`).
- **Query records** — `record_query` for exact enumeration:
  `record_query control { kind: "control", criticality: "critical", status: "active" }`;
  `record_query term { term: "AccessProfile" }` (unique lookup);
  `record_query convention { area: "auth", status: "active" }`.
  Range/sort on a record's date field (`order: "desc"`) for "latest" / "since".

## How to capture (MCP tools)

- **A document** (decision / design / reference / runbook / postmortem) —
  `document_ingest` with the intrinsic `title` + the markdown **body** (`text`) +
  `externalId` + the bound schema, plus a metadata `payload`. The title is intrinsic
  to the document — do **not** repeat it inside `payload`. E.g. a decision:
  `payload: { summary, status: "accepted", area: "[area]", tags: [...], date: "YYYY-MM-DD" }`
  (set `supersedes` if it replaces one — write the target first).
- **A record** (control / convention / gotcha / term) — `record_create` with a
  stable `externalId` + the typed fields, e.g.:
  - gotcha: `{ externalId: "gotcha-<slug>", symptom, cause, fix, area: "[area]", status: "active", discoveredOn: "YYYY-MM-DD" }`.
  - convention: `{ externalId: "<slug>", title, rule, why, howToApply, area: "[area]", status: "active", establishedBy: "<decision-externalId>", updatedOn: "YYYY-MM-DD" }`.
- **To retire** — re-write with `status` flipped (a decision to `superseded`, a
  gotcha to `resolved`). Don't delete.

## Conventions

- **Idempotent + upsert:** reuse the same `externalId` so re-runs never duplicate — a
  plain re-create returns the existing record **unchanged** (`created: false`); to apply
  edits, send the change with `upsert: true`. Pick stable slugs/numbers.
- **Write a reference target before the record that points at it.**
- **Record the why.** A statement without rationale is a log entry, not knowledge.
- When a decision changes, write the new `decision` and set its `supersedes` — don't
  edit the old one's meaning away.
- **Respect the rate limit.** Writes/searches are rate-limited per minute (per
  tenant, shared across keys; the free tier is low). For a bulk write/backfill, pace
  yourself (a short sleep between writes); on a `429`, honor the `Retry-After` header
  (else back off exponentially) and retry — idempotency by `externalId` means a
  paused/restarted run just converges.

## Bridging an issue tracker

Your tracker (GitLab/Jira/Linear) owns **live status**; this KB owns **durable
knowledge** — don't mirror issues here. When you close out work that carries durable
knowledge, **promote by reference**: write the typed document or record
(decision/postmortem/runbook · convention/gotcha), **tag it `issue:<id>`** (e.g.
`issue:147`; `jira:ENG-12` works too), and note the `externalId` back in the
tracker. Recall an issue's
knowledge with `filters:{ tags:"issue:147" }`; the tag is also your jump-link to live
status. Be selective — most issues promote nothing; only the durable why/how/lesson
belongs here. Never store status (open/closed/assignee) in the KB.

[Customize: your `area` vocabulary, which schemas your team uses, naming
conventions for `externalId`, your tracker tag prefix, and any house rules — e.g.
"every control names the test that enforces it in `evidence`."]
