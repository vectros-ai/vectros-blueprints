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

1. **RECALL first — the KB outranks your own re-derivation.** Before you propose a
   change, design something, or debug a failure, query the knowledge base and treat
   a hit as authoritative over what you'd reconstruct from the code alone. A cold
   start is exactly when you most need the decision/convention/gotcha you can't
   re-derive. Don't re-litigate a settled decision, re-invent an existing
   convention, or re-discover a known trap — a two-second `rag_ask` is cheaper than
   repeating a mistake the team already wrote down. If recall turns up nothing,
   *then* proceed from first principles (and capture what you learn, per step 3).
2. **ACT** using what you recalled — follow the conventions and controls, reuse the
   runbook, respect the supersede chain.
3. **CAPTURE after.** When you make a durable decision, learn a convention, hit a
   gotcha, write or revise a runbook, or run a post-mortem, write it back (a
   document or a record, per below) so the next session inherits it. **Record the
   *why*, not just the *what*** — the reasoning is the most-recalled content. And
   when the durable source of a KB item is a repo file you just edited, re-ingest it
   (see *Keep the KB in sync* below) — an edit that doesn't propagate silently forks
   the KB from the repo, which is worse than no KB at all.

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

**Reach for the most precise tool first.** If the ask is *enumerable* — "which
critical controls are active?", "the convention for area X", "the definition of
term Y" — use **`record_query`**: it is exact, cheap, and compact. Fall back to
**`hybrid_search`** (recall by meaning) only when you don't know the exact filter,
and to **`rag_ask`** when you want a grounded *answer* over document bodies rather
than the raw hits. Ordering matters — a `record_query` that returns three tight
rows beats a `hybrid_search` that spends thousands of tokens to surface the same
fact.

**Query compactly by default.** `hybrid_search` hits carry the surrounding passage
(`contextText`), so a wide search is *heavy* — a handful of hits can be tens of KB.
Start with **`limit: 3` + `uniqueDocuments: true`** and escalate only if recall is
insufficient. Prefer a `record_query` or a tighter filter over a bigger `limit`.

- **Recall by meaning / grounded answer** — `rag_ask` for a cited answer over the
  document bodies: *"why did we choose X?"*, *"have we hit this before?"*.
- **Search documents** — `hybrid_search` with `contentTypes: ["documents"]`. Scope
  to one document *type* with **`typeName: "decision"`** (or `"runbook"`,
  `"postmortem"`, …) — `typeName` narrows documents and records alike. Add `filters`
  to narrow further (`{ area: "search" }`, `{ tags: "tenant-isolation" }`).
- **Query records** — `record_query` for exact enumeration; the record type is the
  tool's `type` argument, plus field filters:
  `record_query control { kind: "control", criticality: "critical", status: "active" }`;
  `record_query term { term: "AccessProfile" }` (unique lookup);
  `record_query convention { area: "auth", status: "active" }`.
  Range/sort on a record's date field (`order: "desc"`) for "latest" / "since".
  *(Type facet by tool: `hybrid_search` uses `typeName`; `record_query` uses `type`.)*

**Mind the keyword leg.** `hybrid_search` defaults to `mode: HYBRID` with
`textMode: PHRASE` (slop 3), so a long natural-language query often matches nothing
on the BM25 (keyword) leg and you silently get a semantic-only ranking. Use a short
**keyword phrase** for the text leg, or pass **`textMode: "OR"`** for a
natural-language query. Tell-tale: if `textScore` is `0` across every hit, the
keyword leg contributed nothing — re-shape the query or switch `textMode`.

**Recall cheat-sheet** (map the question to the tightest query):

| You want… | Query |
|---|---|
| The active rule/standard for area X | `record_query convention { area: "X", status: "active" }` · `record_query control { area: "X", status: "active" }` |
| "Have we hit this failure before?" | `hybrid_search { contentTypes: ["documents"], typeName: "postmortem" }` + `record_query gotcha { area: "X", status: "active" }` |
| The definition of a term | `record_query term { term: "…" }` (unique) |
| The *why* behind a decision | `rag_ask "why did we …?"` or `hybrid_search { contentTypes: ["documents"], typeName: "decision" }` |
| Latest N of a dated type | `record_query <type> { … , order: "desc" }` (range/sort on the date field) |
| Everything tagged to an issue | `record_query`/`hybrid_search` with `filters: { tags: "issue:<id>" }` |

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
  - If the record is **extracted from a repo file**, add `sourceRef: "<that file>"` so a
    later edit to the source can find and re-extract exactly its records (see the sync
    convention below).
- **To retire** — re-write with `status` flipped (a decision to `superseded`, a
  gotcha to `resolved`). Don't delete.

## Conventions

- **Idempotent + upsert:** reuse the same `externalId` so re-runs never duplicate — a
  plain re-create returns the existing record **unchanged** (`created: false`); to apply
  edits, send the change with `upsert: true`. Pick stable slugs/numbers.
- **Write a reference target before the record that points at it.**
- **Keep the KB in sync with its source (self-describing, no side index).** If a document
  mirrors a repo file, stamp the file with a top-of-file `<!-- vectros-kb-id: <externalId> -->`
  comment; if a file is *extracted* into records, stamp it with
  `<!-- vectros-kb-records: <type> ref=<path> -->` and give each record a `sourceRef` equal to
  that `ref`. On a source edit, re-ingest the document or re-extract the records by
  `externalId` with `upsert: true`. The markers are invisible HTML comments (they never
  render), and they mean the KB needs no separate map of what came from where. On a
  re-extract, if a record's source heading has disappeared, flip that orphaned record to
  `resolved`/`superseded` rather than leaving it active — a re-sync that only refreshes
  and never retires still serves stale answers.
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

## Promoting what you learn (memory → repo → KB)

If you keep private working notes or an always-loaded memory file, treat it as a
**staging area, not a second home**. A lesson lives in exactly one tier:

- **Working memory** — where a lesson lands *first*, while it's still fresh or
  agent-personal.
- **Your repo docs** — the **golden**, shared, reviewable copy. When a memory note
  matures into durable, shareable knowledge, **promote it one-way** into the right
  doc (a conventions file, a troubleshooting reference, a post-mortem) under the
  broadest type that fits — don't fragment one nugget into its own file when a
  broader home exists.
- **This KB** — the queryable projection, fed *from* the repo doc (stamp it with a
  marker and ingest, per *Keep the KB in sync*).

Promotion is terminal: once the repo doc is committed **and** the KB ingest is
confirmed, collapse the memory note to a one-line pointer at the repo path. Order
matters — remove the working copy **only after** the two durable copies exist, since
working notes usually aren't version-controlled. Keep in memory, in full, only what
has no repo/KB home by design (personal credentials, in-flight status).

[Customize: your `area` vocabulary, which schemas your team uses, naming
conventions for `externalId`, your tracker tag prefix, and any house rules — e.g.
"every control names the test that enforces it in `evidence`."]
