---
name: imprnt-ingest
description: Ingest any source (meeting transcript, pasted doc, prose dump, or a single fact) into the imprnt vault. The CLI snapshots the source verbatim into raw/ and, for transcripts, writes the deterministic event skeleton. You then do the ONE conscious LLM pass — classify the note's TYPE among the 8, write the summary, extract decisions/actions/questions with judgment, assign tags from the approved vocabulary, set kind, resolve or create the entities the note touches, and clear them from needs-review. USE WHEN ingest, eat this, add to imprnt, process meeting, log this 1:1, file this note, save this, imprnt ingest.
---

# imprnt — Ingest

Turn a raw source into a typed, resolved, tagged vault note.
The CLI does the mechanical structure (snapshot, hash, transcript skeleton — free); you do the meaning,
including **the note's TYPE** — the conscious ~20% (the only paid step).

Read the vault contract (`<imprnt>/CLAUDE.md`) once, then execute `Workflows/Ingest.md`.

**The code/LLM split (from the contract):**
- **Code, free:** snapshot source → `raw/` (immutable, hash, incremental skip), parse structured input,
  file the note, update `index.md`/`log.md`, entity-resolution grep + MERGE.
- **You, the conscious step:** decide the TYPE (people · orgs · projects · things · principles · notes ·
  mistakes · events), set `kind`, write the summary, extract decisions/actions with judgment, assign tags,
  adjudicate genuinely ambiguous identities, ensure ≥1 link to a non-owner entity.

**Hard rules:** tags come only from `vault/_tags.md` (use the synonym map; if a needed tag is missing,
ask before adding it). Mark facts `{extracted}` (from source) vs `{inferred}` (your conclusion). Never
invent. Resolve entities by alias before creating a new note. If a source is already an enriched note,
preserve its enrichment — don't re-derive from scratch.
