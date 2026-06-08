# Ingest — workflow

Vault defaults to `./vault`; pass `--vault <dir>` through every CLI call if the user named one.
Let `KF` = the imprnt repo (run the CLI as `bun $KF/scripts/cli.ts ...`, or `imprnt ...` if linked).

The 8 types: **people · orgs · projects · things · principles · notes · mistakes · events**.
Three orthogonal axes: **type** (folder) = what object · **kind** (field) = what form · **tags** = what topic.

## Step 0 — seed the vocab from your domains before first ingest (one-time)

Before the first ingest into a fresh vault, make sure `vault/_tags.md` covers YOUR actual domains —
not just the default set. The template ships with a small generic seed (identity, health, finances,
work, life, projects); if a domain you'll file is missing, add the tag + its synonyms as one
human-approved line each. A recall on a domain with
no seeded tag falls through to body-only literal matching with no synonym normalization — seed first.

## Step 1 — snapshot + skeleton (CLI, no LLM)

```sh
imprnt ingest <file-path> [--vault DIR]          # a file on disk (transcript, doc, export)
imprnt ingest --text "<bytes>" [--vault DIR]     # an inline fact or pasted prose (no temp file)
imprnt ingest --stdin --slug <s> [--vault DIR]   # pipe bytes in; --slug names the snapshot
```

Input is **shape-agnostic** — file path, `--text`, `--stdin`, or a bare arg that isn't a path (treated
AS the bytes). EVERY shape gets the same provenance: copied verbatim into `raw/` (immutable,
content-hashed, incremental — identical bytes are a no-op). Use `--text`/`--stdin`/inline for a spoken
or typed fact and for pasting migration prose (TELOS, identity, finances, health) — never bypass the CLI
and lose the snapshot/hash/manifest.

For a **transcript file** the CLI also writes `vault/events/<date>-<slug>.md` — a dated occurrence, so
it commits to `type: event` and leaves `## Summary / Decisions / Action items / Open questions` marked
`pending`, with `tags: []`, `source:` pointing at the raw/ snapshot, and the content hash. It flags
unrecognized participants into `vault/_needs-review.md`. Note the output path, snapshot path, flagged entities.

For **inline bytes / a pasted doc / a single fact**, the CLI only snapshots into `raw/` and prints the
snapshot path — it does **not** guess the type. It also flags `- [ ] unclassified source ...` into
`vault/_needs-review.md` (the coverage ledger) so a half-migrated source can't sit unseen in `raw/`.
Classifying that source is your job in Step 2 — clear that line when you create the note.

## Step 2 — the conscious pass (you, the LLM — the only paid step)

Read the source from `raw/` (and the skeleton note if one was produced), then:

1. **Classify the TYPE** — the conscious decision. Pick one of the 8 by what kind of object it is:
   a human → `people`; an institution → `orgs`; a bounded effort with a status → `projects` (its
   artifact is a field, not a separate note); an owned/used object → `things`; a held position/belief/
   model/strategy → `principles`; reference knowledge that isn't an entity → `notes`; a lesson
   (believed/found_false/true_now) → `mistakes`; a dated occurrence worth its own note → `events`.
   For a non-transcript source, CREATE the note in the right folder with the type's frontmatter (see
   the contract). For a transcript, the skeleton is already `events/`.
   - **Dense multi-topic source → split, don't blob.** If the source covers multiple objects (a dense
     PAI overview file: med stack + mental-health profile + a BU decision + the psychiatrist), split it
     into one atomic note per object across the right types, link them together, and keep the single
     `raw/` snapshot as the shared provenance for all. Don't file the whole file as one `notes/` blob —
     that loses the entity graph (the doctor never becomes a `people/`, the decision never becomes
     linkable). One source can produce many notes.
2. **Set `kind`** where the type has one (`orgs`, `things`, `principles`, `notes`) — e.g. a note that's
   a how-to → `kind: howto`; an insurer → `kind: insurer`.
3. **Summary** — a few sentences of what this is / what happened and what's at stake.
4. **Decisions / Action items / Open questions** (events) or the body (other types) — extract with
   judgment, not keywords. Attribute owners. Mark `{extracted}` vs `{inferred}`. Empty → say so.
5. **Tags** — set `tags:` using ONLY values from `vault/_tags.md`, mapped through its synonym map
   (`pipeline → etl`). Need a tag that isn't there? Ask before adding one line. Never free-form.
   Prefer the specific tag over a broad one — BM25 weights a rare tag above a common one, so a specific tag discriminates; a tag on most notes barely scores.
6. **Resolve entities** — for each flagged item in `_needs-review.md` (and any entity the note names):
   grep the relevant folder for the name and for `aliases:` matches.
   - Found → fix the `[[type/<slug>]]` link to the canonical slug; add the new name variant to that
     entity's `aliases:` if new (rename = old name to `aliases`, keep the slug).
   - Not found → create `vault/<type>/<slug>.md` with the type's frontmatter; `{inferred}` on guesses.
   - Remove the now-resolved `- [ ]` line(s) from `vault/_needs-review.md` — including the
     `- [ ] unclassified source ...` line the CLI wrote for an inline/--text/stdin source, once you've
     created its note.
   Ensure the note links **≥1 non-owner entity**. Link project(s) on an event via `project:`.
7. Set `status: enriched` (events) and bump `updated:`.

If the source is **already an enriched note** (e.g. a PAI KNOWLEDGE note), map its fields onto this
contract and PRESERVE the enrichment — don't re-derive from scratch.

## Step 3 — wire it into the vault

- Add the note (and any new entities) to `vault/index.md` under the right type heading.
- Append one line to `vault/log.md`: `YYYY-MM-DD — ingested <topic>`.

## Step 4 — report

State: the note path + chosen TYPE; tags applied; entities resolved vs created; links made; and
anything genuinely unresolvable still in `_needs-review.md` for the user to settle.
