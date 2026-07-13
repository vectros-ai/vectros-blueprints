# Agent orientation prompt — `agentic-sdlc` knowledge base

A drop-in system-prompt preamble that orients an agent to **use and feed** an
`agentic-sdlc` Vectros knowledge base over the MCP tools. Paste it into your agent's
instructions (Claude Code `CLAUDE.md`, a Cursor/Cline rule, a custom agent's
system prompt) and **customize the bracketed bits** at the end. Assumes
`@vectros-ai/mcp-server` is connected and bound to your context.

This preamble is the **operating layer** — the disciplines an agent needs in
context. The full mechanics (per-type field lists, capture payload shapes, the
repo↔KB sync markers) live in the **bundled guide** (`guides/agentic-sdlc.md`); this
points at them rather than restating them.

Everything below the line is the prompt.

---

You have a governed **engineering knowledge base** over the Vectros MCP tools: the
team's curated **decisions, designs, references, runbooks, post-mortems** (documents)
and **controls, conventions, gotchas, glossary** (records), cross-linked into one
graph — plus your **own private `memory`** tier. It is the source of truth for "why
is it shaped this way?" and "how do we do X?".

## The loop — recall before you act, capture after

1. **RECALL first.** Before you design, change, or debug, query the KB and treat a
   hit as **authoritative over what you'd re-derive from the code**. A cold start is
   exactly when you most need the decision/convention/gotcha you can't reconstruct —
   don't re-litigate a settled decision, re-invent a convention, or re-hit a known
   trap. Found nothing → proceed from first principles (then capture what you learn).
2. **ACT** on what you recalled — follow the conventions and controls, reuse the
   runbook, respect the supersede chain.
3. **CAPTURE after.** A durable decision, a new convention, a gotcha, a runbook, a
   post-mortem → write it back so the next session inherits it, and **record the
   *why*, not just the *what*** (the reasoning is the most-recalled content). If the
   source is a repo file you edited, re-ingest it to keep the KB in sync (guide).

Knowledge is **superseded / retired / resolved** by a status flip, never deleted —
the trail of how the team's thinking evolved is part of the value.

## What's in it

- **Documents** (the markdown body is the artifact): `decision` (ADRs), `design`,
  `reference`, `runbook`, `postmortem`.
- **Records** (typed fields are the artifact): `control`, `convention`, `gotcha`,
  `term` (glossary).
- **Private `memory`** — your OWN working notes, isolated to you by the `member`
  role so only you read or ground on them. `kind` ∈ user / feedback / project /
  reference / observation; a `priority` band marks the always-load pinned set.
- The graph **crosses surfaces** — records point at the documents that justify them,
  documents at the ones they supersede or derive from. Follow the typed references.

Every item's `externalId` is its stable id: re-writing the same id **updates**,
never duplicates. Per-type field lists are in the guide.

## How to query

- **Enumerable ask** ("which critical controls are active?", "the convention for
  area X", "define term Y") → **`record_query`** (`type` + field filters;
  `order:"desc"` for latest). Exact, cheap, compact — prefer it whenever you know the
  filter.
- **Recall by meaning** → **`hybrid_search`**, then **reason over the returned
  passages yourself**. **Query in natural language, NOT keywords:** the default
  `textMode:PHRASE` means a full-sentence question rides the semantic leg, and a
  `textScore` of `0` on the keyword leg is **expected and fine**, not a failure to
  fix. Do NOT shrink to keywords — that buries the answer. Add `textMode:"OR"` only
  when you also want an exact term / id / slug hit.
- **`rag_ask`** is an *optional* cited-answer layer on top. It **consumes inference
  balance and may `402` on the free tier**, so never make recall depend on it — the
  `hybrid_search` passages already carry the answer.
- **Query compact:** hits carry heavy passages — start `limit:3` +
  `uniqueDocuments:true`, tighten the filter before you widen the limit. Type-facet
  by tool: `hybrid_search` uses `typeName`, `record_query` uses `type`.

(Worked query recipes: the guide's cheat-sheet.)

## How to capture

- **Document** (decision / design / reference / runbook / postmortem) →
  `document_ingest` with `title` + markdown `text` + `externalId` + a metadata
  `payload` (don't repeat the title in `payload`). Set `supersedes` if it replaces
  one — write the target first.
- **Record** (control / convention / gotcha / term) or **memory** → `record_create`
  with a stable `externalId` + typed fields. For a record extracted from a repo
  file, add `sourceRef:"<that file>"` so a later edit can find and re-extract it.
- **Retire** by flipping `status` (a decision → `superseded`, a gotcha →
  `resolved`); never delete.
- **Idempotent:** a plain re-create returns the existing item unchanged
  (`created:false`) — send `upsert:true` to apply an edit. Pick stable slugs.
- Payload shapes per type, and the `<!-- vectros-kb-* -->` markers that keep a
  mirrored repo and its KB in sync, are in the guide.

## Bridging your issue tracker

Your tracker (GitLab / Jira / Linear) owns **live status**; the KB owns **durable
knowledge** — don't mirror issues here. When you close work that carries a durable
lesson, **promote by reference**: write the typed doc/record, **tag it
`issue:<id>`**, and note the `externalId` back in the tracker. Recall with
`filters:{ tags:"issue:<id>" }`. Be selective — most issues promote nothing; never
store status (open/closed/assignee) in the KB.

## Promoting what you learn (memory → repo → KB)

A lesson lives in **one** tier. **Working memory** (the private `memory` tier, or a
local memory file) is where it lands first, while it's fresh or agent-personal. When
it matures into durable, shareable knowledge, **promote it one-way** into the right
**repo doc** — the golden, reviewable copy, under the broadest type that fits — then
project that doc into the **KB** (ingest with a sync marker, per the guide).
Promotion is terminal: once the repo doc and the KB ingest both exist, collapse the
memory note to a one-line pointer — remove the working copy **only after** the two
durable copies exist. Keep in memory, in full, only what has no repo/KB home by
design (personal context, in-flight status).

## Respect the rate limit

Writes and searches are rate-limited per minute per tenant (shared across keys; the
free tier is low). Pace bulk work; on a `429` honor `Retry-After` (else back off),
and retry — idempotency by `externalId` means a paused run just converges.

[Customize: your `area` vocabulary (e.g. `auth`, `search`, `billing`), which schemas
your team actually uses, your `externalId` naming, your tracker tag prefix, and any
house rules — e.g. "every control names the test that enforces it in `evidence`."]
