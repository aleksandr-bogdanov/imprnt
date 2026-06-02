# knowful — vault contract

> This file is the schema for the vault. When an agent (Claude Code, etc.) works inside a
> knowful vault, this is the only standing context it needs. Keep it small.

## First action, every session

**Read `vault/hot.md`.** It is a ~500-token primer of what is active right now (current
workstream, recent decisions, what you're waiting on, what's next). It is the only file you
load by default. Everything else is retrieved on demand.

## The one rule: deterministic-first

Code does the bulk transform at ~zero token cost. The LLM is a scarce, expensive resource —
spend it only on the irreducibly-semantic ~20% (clean, extract insight, synthesize, draft).

- **Ingestion** is deterministic: `knowful ingest <transcript>` parses a raw dump into a
  structured note (frontmatter, participants, extracted decisions/actions/questions) with
  **no LLM call**. The note ships with a `## Summary` marked `<!-- semantic-clean: pending -->`.
- **Semantic clean** is the LLM's only job here: fill the Summary, sharpen extracted items,
  create/extend the `people/` and `workstreams/` notes the meeting touched.
- **Retrieval** is deterministic: `knowful recall "<query>"` (tiered grep) or just `rg` over
  the vault. **Never put an MCP server, a vector DB, or embeddings over this vault.** Grep is
  ~100 tokens; MCP-over-vault is ~millions. Files are the interface.

## Layout

```
raw/                     immutable source dumps (transcripts, exports). Never edited.
vault/
  index.md               map of content (MOC) — entry point, links to everything
  hot.md                 ~500-tok current-context primer (load first)
  log.md                 running append-only log
  people/<slug>.md       one per colleague: role, team, owns, notable quotes
  workstreams/<slug>.md   one per project/initiative: status, decisions, links
  meetings/<date>-<slug>.md   one per 1:1 / meeting
  mistakes/<slug>.md     bi-temporal lessons (believed / found-false / true-now)
```

## Note conventions (all grep-friendly, no DB)

- **Frontmatter** every note: `type`, `date`, `tags`, plus type-specific keys. Tags drive tiered recall.
- **Wikilinks** `[[people/maya-tanaka]]` connect notes. A link to a not-yet-existing note is a TODO.
- **Provenance markers** inline: `^[extracted]` (deterministic), `^[inferred]` (LLM guess),
  `^[ambiguous]` (needs confirmation). Grep-filterable confidence.
- **Conflict-as-relationship**: when a note supersedes another, stamp the old one
  `> superseded by [[...]]` so retrieval can demote stale content.

## Mistake notes (bi-temporal)

The highest-value note type. Before a task, `recall` the mistakes folder. Format:

```markdown
- believed (YYYY-MM-DD): <what I thought was true>
- found-false (YYYY-MM-DD): <what actually happened>
- true-now (YYYY-MM-DD): <the corrected belief>
```

## Out of scope (on purpose)

No task management (that lives in a separate tool). No coding-agent scaffolding. No modules
you didn't opt into. Every part of knowful is a self-contained dir you can `rm -rf` with zero
cross-deps. If a feature wants to sneak in because "it belongs" — it doesn't.
