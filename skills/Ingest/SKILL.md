---
name: imprnt-ingest
description: Ingest any source (meeting transcript, pasted doc, prose dump, or a single fact) into the imprnt vault. The CLI snapshots the source verbatim into raw/ and, for transcripts, writes the deterministic event skeleton. You then do the ONE conscious LLM pass: classify the note's TYPE among the 8, write the summary, extract decisions/actions/questions with judgment, assign tags (coin a new one if none fits), set kind, resolve or create the entities the note touches, and clear them from needs-review. USE WHEN ingest, eat this, add to imprnt, process meeting, log this 1:1, file this note, save this, imprnt ingest.
---

# imprnt — Ingest

Turn a raw source into a typed, resolved, tagged vault note.
The CLI does the mechanical structure (snapshot, hash, transcript skeleton — free); you do the meaning,
including **the note's TYPE** — the conscious ~20% (the only paid step).

Read the vault contract (`<imprnt>/CLAUDE.md`) once, then execute `Workflows/Ingest.md`.

**The code/LLM split (from the contract):**
- **Code, free:** snapshot source → `raw/` (immutable, hash, incremental skip), parse structured input,
  file the note, rebuild `index.md` (`imprnt check`), entity-resolution grep + MERGE.
- **You, the conscious step:** decide the TYPE (person · org · holding · project · principle · note ·
  mistake · event), set `kind`, write the summary, extract decisions/actions with judgment, assign tags,
  append the one `log.md` line, adjudicate genuinely ambiguous identities, ensure ≥1 link to a non-owner
  entity.

**Hard rules:** apply the best-fitting tag from `vault/_tags.md` (use the synonym map). If none fits,
coin a new kebab-case tag and use it - `imprnt check` syncs it into `_tags.md`, no approval gate. Mark
only the exceptions: `{inferred}` (your conclusion, not in the source) and `{ambiguous}` (uncertain).
Unmarked = straight from the source. Never invent. Resolve entities by alias before creating a new note.
If a source is already an enriched note, preserve its enrichment. Do not re-derive from scratch.
