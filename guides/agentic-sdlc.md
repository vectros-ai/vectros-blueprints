# Guide — the `agentic-sdlc` blueprint

`agentic-sdlc` is a bundled blueprint: a **whole-SDLC system of record**
for an AI development team. It provisions **nine schemas, split by content vs
structure** — `decision` (ADRs), `design`, `reference`, `runbook`, and
`postmortem` as **documents** (the markdown body is the artifact); `control`,
`convention`, `gotcha`, and `term` (glossary) as **records** (the typed fields are
the artifact) — linked into a **cross-surface knowledge graph** and recalled by
hybrid search + grounded `rag_ask`. This guide takes you from bootstrap to a
populated, queryable KB, and to wiring an agent to use it day-to-day.

> Companion: [`prompts/agentic-sdlc-agent.md`](../prompts/agentic-sdlc-agent.md) —
> the drop-in agent orientation prompt (the recall-before-acting / capture-after
> loop). Apply this guide to stand the KB up; apply that prompt to make an agent
> use it.

## 1. What you get

- **9 schemas, content vs structure.** The prose artifacts — `decision` (ADR),
  `design`, `reference`, `runbook`, `postmortem` — are **documents** (the markdown
  body is searched + answered over). The structured artifacts — `control`,
  `convention`, `gotcha`, `term` — are **records** (typed fields, exact-queryable).
  Every item has a stable `externalId`, so re-ingesting never duplicates: an
  unchanged item is returned as-is, and re-ingesting **edited** source with
  `upsert: true` overwrites it in place — the KB is *rebuildable* and *syncable*.
- **A cross-surface knowledge graph** — typed `reference` edges where **records
  point at documents** (`control.verifiedBy` → the `runbook` that proves it;
  `convention.establishedBy` / `term.relatedDecision` → the `decision` behind them)
  and **documents point at documents** (`decision.supersedes`,
  `design.relatedDecision`, `runbook.bornFrom` → a `postmortem`). Provenance is
  navigable, not just searchable.
- **A least-privilege key** — `records:r/c/u`, `search:r`, `schemas:r`,
  `inference:r`, `documents:r/c/u`, `folders:r/c`. No hard delete: knowledge is
  superseded/retired via a reversible status flip (and `documents:u` re-ingests an
  edited body to keep the KB in sync with its source), so the audit trail stays intact.
- **An `editor` role for you, the human** — the key's data-plane scope plus hard
  delete (`records:d` / `documents:d` / `folders:d`), ready to bind to your user so you
  can browse and curate the KB in the app (see "Browse it as yourself" below). A human
  curator can permanently remove genuine strays; the agent key only archives.
- **Range/sort on every artifact's date**, a governance `control` that records its
  own evidence, a `convention` with distinct rule/why/howToApply fields, and a
  glossary `term` with a `unique` exact-lookup.

## 2. Quickstart — install, sign in, provision

Install the public CLI, sign in once (browser), and provision the context + the nine
schemas + a scoped key (and wire your MCP client). `production` is the default
environment — add `--env staging` only to target staging.

**Bash (macOS / Linux / Git Bash):**

```bash
npm i -g @vectros-ai/cli
vectros login                                          # one-time, browser sign-in
vectros bootstrap --blueprint agentic-sdlc --no-seed --yes
vectros whoami                                         # confirm tenant + scoped key
```

**PowerShell (Windows):**

```powershell
npm i -g "@vectros-ai/cli"
vectros login                                          # one-time, browser sign-in
vectros bootstrap --blueprint agentic-sdlc --no-seed --yes
vectros whoami
```

`bootstrap` provisions the context + schemas + a least-privilege `ssk_*` (written
once to `~/.vectros/agentic-sdlc.key.json`) and safe-merges the Vectros MCP server
into your **Claude Desktop** config; use `--client code` for **Claude Code**, or
`--print` to emit the snippet without writing a file. Restart your MCP client to load
it. (Prefer not to install globally? Prefix each command with `npx -y`, e.g.
`npx -y @vectros-ai/cli bootstrap …` — on PowerShell quote the spec:
`npx -y "@vectros-ai/cli" …`.)

Add `--tenant test` to provision into the **test tenant** first (useful for a
dry-run before committing to your live tenant). Omit for live (the default).

### Browse it as yourself — grant your user access

`bootstrap` provisions the context and a scoped key for your **agent** (the MCP
server), but it does **not** join **you** — the signed-in human — to the new
context. So when you open the data-plane app the context switcher won't list it
yet: the app shows only contexts your user holds access in, and bootstrap grants
your user none by default. Do this once so you can browse and curate the KB
yourself. `bootstrap` already provisioned an **`editor`** role in the context
(read + write + hard delete — the agent key's data-plane scope plus `records:d` /
`documents:d` / `folders:d`, so a human curator can permanently remove strays where the
agent only archives); bind it to your user two ways:

- **In the admin app (easiest):** go to **Access → Contexts → `agentic-sdlc` →
  Profiles → Create profile**, pick **yourself** (users list by email), choose the
  **`editor`** role, and save.
- **From the CLI:** `--principal me` resolves to your own user, so no id lookup is
  needed:

  ```bash
  vectros access grant --principal me --context agentic-sdlc --role editor
  ```

  (Prefer an explicit id? `vectros identity list --type user` lists every tenant
  user's id + email; your principal is `usr_` + the id next to your email.) Reopen
  the data-plane app and `agentic-sdlc` now appears in the switcher with your data.

### Seeds

This blueprint ships **without bundled seeds** — it provisions the nine schemas +
the scoped key, and you fill it from your own corpus (next section). So the context
starts clean; there's no synthetic data to remove. (If you fork a blueprint that
*does* ship seeds and want a clean production context, `vectros bootstrap
--no-seed` provisions the schemas + key and skips the seed step.)

## 3. Ingest your corpus

There are two ingest paths, by surface — both driven by the **ingest agent**
(point it at your source files with the
[orientation prompt](../prompts/agentic-sdlc-agent.md); an LLM maps your
semi-structured docs to the right type far better than a brittle parser, and it's
idempotent by `externalId`).

### Documents — the prose artifacts (ADRs, designs, references, runbooks, post-mortems)

These keep their markdown **body as-is**; the agent fills the typed metadata and
ingests via `document_ingest` against the matching schema:

```text
document_ingest:
  title:    <the document's title — intrinsic; documents don't repeat it as metadata>
  text:     <the raw markdown file — the body is the artifact>
  schemaId: <the bound `decision` (or design/reference/runbook/postmortem) schema id>
  payload:  { summary, status: "accepted", area: "search",
              tags: ["..."], date: "YYYY-MM-DD" }   # metadata only; + refs, e.g. supersedes
```

Scope later searches to one type with `contentTypes: ["documents"], typeName:
"decision"` — `typeName` narrows documents and records alike (equivalently
`filters: { recordType: "decision" }`), plus more `filters` for `area`/`tags`.

### Records — the structured artifacts (controls, conventions, gotchas, terms)

These are typed fields, not prose — the agent extracts the fields and calls
`record_create` per item (e.g. a `convention`'s distinct rule/why/howToApply, a
`control`'s evidence + `verifiedBy` runbook, a `term`'s unique key + definition).

A one-shot backfill is that agent looped over your `docs/`/ADRs/memory; an ongoing
sync re-runs it on change, re-ingesting edited source with `upsert: true` so the
same `externalId`s overwrite in place (a plain re-create returns the existing item
unchanged, so use `upsert` to propagate edits). Cross-surface edges (a record's
reference to a document) resolve by the target's `externalId`, so ingest the
referenced documents before the records that point at them.

### Throttle the backfill — it's rate-limited

A bulk backfill is exactly the workload that trips the API's **per-minute rate
limit**. Two things to know:

- The limit is **per tenant**, counts **writes + searches** (read-only `GET`s are
  exempt), and is **shared across all of a tenant's keys** — so don't try to go
  faster by running parallel ingests under different keys; they share one bucket.
- The **free tier allows only tens of writes per minute**; higher plans allow more.
  Check your plan's exact limit in the API rate-limits documentation.

So pace the ingest: keep writes **well under your plan's per-minute limit** — for
the free tier, roughly one record every couple of seconds is safe (a plain `sleep`
between `record_create` calls is enough); go faster on higher tiers. On an HTTP
**429**, **honor the `Retry-After` header** (seconds until the window resets; the
response also carries `X-RateLimit-*`); if it's absent, back off exponentially with
jitter, then resume. Because ingest is idempotent by `externalId`, a backfill that
pauses or restarts simply converges — it never double-writes.

## 4. Query it

Reach for the most precise tool first: `record_query` for anything *enumerable*
(exact, cheap, compact), `hybrid_search` to recall by meaning when you don't know
the exact filter, `rag_ask` for a grounded *answer* over document bodies. Scope by
type per tool: `hybrid_search` uses `typeName` (which narrows documents and records
alike), `record_query` uses its `type` argument.

Two `hybrid_search` gotchas worth knowing up front: hits carry the surrounding
passage, so searches are *heavy* — start `limit:3` + `uniqueDocuments:true` and
escalate only if needed; and the default `mode:HYBRID` uses `textMode:PHRASE`, so a
long natural-language query can contribute nothing on the keyword leg (a `textScore`
of `0` on every hit is the tell) — use a short keyword phrase or `textMode:"OR"`.

| You want… | Call |
|---|---|
| "Why did we decide X?" (grounded, cited) | `rag_ask "why did we choose X?"` (answers over document bodies) |
| "Which critical controls are active, and how is each proven?" | `record_query control { kind:"control", criticality:"critical", status:"active" }` → follow `verifiedBy` to the runbook |
| "What's the active rule for area X?" | `record_query convention { area:"<area>", status:"active" }` |
| "Have we hit this failure before?" | `hybrid_search "<symptom>" contentTypes:["documents"], typeName:"postmortem"`; plus `record_query gotcha { area:"deploy", status:"active" }` |
| "Define X" | `record_query term { term:"X" }` (unique lookup) |
| "Latest decisions / search the designs" | `hybrid_search "<topic>" contentTypes:["documents"], typeName:"decision"` (or `"design"`, plus `filters:{ area:"<area>" }`) |
| "What supersedes a given decision?" | document lookup on `decision` by `supersedes:"<externalId>"` |

## 5. Customize

This is a starting point — fork it for your org:

- **`area` vocabulary** — swap in your subsystems.
- **Add/remove schemas** — keep what fits; the format is the same as the bundled
  source (`src/blueprints/agentic-sdlc.ts`).
- **Enum vocabularies** — adjust `status`/`severity`/`category` to your lifecycle.
- **Surface (document vs record)** — content-heavy types belong on the document
  surface (`allowedSurfaces: ['document']`), structure-heavy types are records. Add
  a separate type when the *shape* differs, when a distinct first-class type
  strengthens *references*, or when it's a distinct thing humans **browse** — not
  for a near-identical clone (use a filterable field for sub-kinds, as `reference`
  does with `category`).
- **Lookups are migration-locked** — the equality-vs-range choice and the 7 fast
  equality slots per schema are fixed once a schema is live; choose deliberately
  (see the package README § "The format, field by field").
- **Sensitive fields** — SDLC knowledge generally isn't PHI, so this blueprint
  marks nothing sensitive; if a field needs redaction (e.g. an internal endpoint in
  a post-mortem), mark it `sensitive` (see the `clinical-intake` blueprint).

## 6. Bridging your issue tracker — don't mirror it

Your issue tracker (GitLab, Jira, Linear) and this knowledge base are **two planes
with different jobs** — keep them separate:

- **Tracker = live status** (open/closed, assignee, the board). Volatile; it stays
  the source of truth for *what's in flight*.
- **Knowledge base = durable recall** (why/how/lessons). Stable; the source of truth
  for *what we know*.

Mirroring issues into the KB creates a stale shadow copy and buries your decisions
under issue churn. Instead, **promote by reference**:

1. **When you close out work that carries durable knowledge**, distill it into the
   right type — a settled call → `decision`, a trap → `gotcha`, an outage + lesson →
   `postmortem`, a new rule → `convention`/`control`, a procedure → `runbook`.
2. **Tag it `issue:<id>`** — e.g. `tags: ["auth", "issue:147"]` (`jira:ENG-12` /
   `linear:OPS-9` work the same way). This is the link back to the live item.
3. **Note the `externalId` back in the tracker** ("captured as `adr-token-rotation`")
   — the return link.

Then recall an issue's knowledge with `filters:{ tags:"issue:147" }`, and jump to its
live status via the tag. **Be selective** — most issues (a dependency bump, a
flaky-test fix) promote *nothing*; only the durable why/how/lesson belongs here. That
selectivity is what keeps recall high-signal instead of drowning your decisions in
tracker chatter. The KB never stores status (no open/closed/assignee): status lives
in the tracker, knowledge lives here, and the tag + back-ref are the seam. (No schema
change — every type already has `tags`.)

## 7. Keep it healthy

- **Record the why** — rationale is the most-recalled field; a statement without it
  is a log entry, not knowledge.
- **Supersede, don't delete** — flip `status` so the evolution trail survives.
- **Re-ingest is keyed on `externalId`** — a backfill never double-writes (an
  unchanged item returns as-is), re-ingesting edited source with `upsert: true` keeps
  the KB in sync, and the KB can be rebuilt from source at any time.

### Keep it in sync with your source — the self-describing marker

If your knowledge lives in a repo (docs, decision records, runbooks) and the KB mirrors
it, the two drift the moment someone edits a file. A durable pattern keeps them together
without a fragile side-index.

**Stamp each mirrored file with its KB id, in the file itself** — a one-line HTML comment
at the top:

```markdown
<!-- vectros-kb-id: ref-data-model -->
# Data model reference
```

- **It's invisible.** An HTML comment renders to nothing in Markdown — on your docs site
  and in the repository view alike — so it never shows on the page, even for files that
  are also documentation-site source.
- **The id travels with the file.** Move or rename the file and the binding is unchanged;
  because references resolve by `externalId`, your cross-links never break.
- **No side ledger to maintain.** The file is self-describing — there is no separate
  path-to-id map to keep in lockstep with every add, move, and rename.

**Sync is then a one-liner:** on change, re-ingest the file under the id in its marker with
`upsert: true` — the body re-indexes while the id, typed fields, and edges stay put. A
merge hook that re-ingests every changed marked file keeps the KB fresh automatically.

**The marker is also your membership signal:** a file belongs in the KB exactly when it
carries a marker, so "add this to the KB" is a one-line edit and unmarked files are simply
never mirrored — the KB stays a curated subset, not a copy of the whole repo.

### The same, for records extracted from a file

Records are *distilled* from a source — a glossary becomes many `term` records, a
conventions doc becomes many `convention` records — so one file maps to many records, and
there's no single line to stamp with one id. Two small conventions keep them in sync
anyway:

**1. Each record carries a `sourceRef`** — the identifier of the file it was distilled from.
So "which records came from this file?" is one query:

```text
record_query  type:term  field:sourceRef  value:<ref>
```

**2. The source file declares itself** with a companion marker that names the record
type(s) it feeds and pins that `ref`:

```markdown
<!-- vectros-kb-records: term ref=glossary.md -->
# Glossary
```

Sync is then symmetric with documents: on a change to a marked source file, read its
marker, query its existing records by `sourceRef`, re-distill, and `upsert` each by its
stable `externalId` — refreshing changed ones, adding new headings, superseding any that
disappeared. Because the `ref` is pinned in the marker (not read from the path), moving the
file never breaks the link.

**Two markers, one model:** `vectros-kb-id` marks a file that *is* a KB document;
`vectros-kb-records` marks a file that *feeds* KB records. A file can carry either. With
both, nothing about your KB lives in a separate index — every synced file says what it is,
right in the file.

### Promote durable knowledge into your repo, then the KB

If your agent keeps a private memory or working-notes file, treat it as a **staging area**,
not a second home for knowledge. When a note matures into something durable and shareable,
**promote it one-way** into the right repo doc (a conventions file, a troubleshooting
reference, a post-mortem) — the broadest type that fits — then let the marker + `sourceRef`
sync above carry it into the KB. Once the repo doc is committed and the ingest is confirmed,
collapse the memory note to a one-line pointer at the repo path (and only then — working
notes usually aren't version-controlled). The result: one golden copy per lesson (the repo),
one queryable projection (the KB), and a breadcrumb in memory — never the same prose in three
places.
