# Architecture revisit — 2026-06-06

> Outcome of session 3. Supersedes the type-first layout in the current contract.
> Status: **decided** where marked; **open** items flagged. Not yet folded into `CLAUDE.md` / `docs/architecture.md` — that's the next step.

## The core reversal: domain-first, not type-first

v2 organized the vault by **entity type** (`people/ orgs/ projects/ things/ principles/ notes/ mistakes/ events/`). That produced a junk drawer: `notes/` grew to ~45% of the vault because *reference-about-a-domain* — most of life's content — had no type-home and fell into one typeless bucket.

The fix, taken from PAI's `USER/` layout: **organize by life-area (domain), the way a human actually looks for their own knowledge.** The machine doesn't care — `recall` is grep + BM25 and ignores folders entirely — so folder layout is a pure human-browsing choice, and domain is what humans browse by.

The one thing kept from v2 (and PAI's actual gap): **entities get their own cross-cutting folders.** A person/institution/holding is referenced from many domains, so it needs one canonical home, not duplication across domain folders. That's the single improvement knowful has over PAI, which never had resolvable entities.

### Proposed layout

```
vault/
  # entities — cross-cutting, one canonical home, linked from everywhere
  people/      a human
  orgs/        an institution (employer, insurer, bank, authority, vendor)
  holdings/    owned things with changing state (policies, meds, assets)   # was things/

  # domains — life-areas; all topical/reference content lives here (USER-DEFINED, not fixed)
  identity/    the spine: mission, goals, beliefs, models, positions held  # was principles/ + telos
  health/      ·  finances/  ·  work/  ·  life/  ·  projects/

  # forms — distinct by use, not topic
  events/      dated occurrences (chronological)
  mistakes/    lessons learned

  index.md  hot.md  log.md  _tags.md     # generated / control
```

`type:` stays in frontmatter, so a note still knows *what it is* (a principle, a policy) even when it lives in a domain folder. Folders are drawers; tags carry topic for search; links carry the graph.

### Decided
- **Domain-first vault layout**, PAI-style, frontmatter/tags/links retained.
- **`people/` + `orgs/` stay as entity folders** (defended; not dissolved into domains).
- **`identity/`** as the name for the spine (not `telos/` — jargon; `identity/` reads for a fresh user too).
- **`notes/` dissolves** — every reference note moves to its domain. No catch-all bucket survives.
- **Folders are drawers, not the browse/retrieve axis.** Not going fully flat (churn for ~nothing; loses ID-namespacing).

### Open
- **`holdings/`** — rename of `things/`, tightened to "owned things with changing state"; eject tools (terminal, dotfiles) to `life/` reference. Fix off-contract `kind: record`.
- **`out/` zone** for produced deliverables vs. sending them to `~/Documents/artifacts/` + a note-pointer.
- **`security/`** — fold into `life/`/`work/` (lean) vs. own folder.
- **Domain set is user-defined** — health/finances/work/life are Alex's; a consultant's would be clients, a researcher's would be topics. Ship mechanism + sensible defaults, not hardcoded domains.

## raw/ — keyed by source, copies everything, never searched

`raw/` is the evidence locker. Confirmed in code: `recall` greps `vault/` only, so `raw/` sits outside the search corpus — meaning binary/tabular sources cost disk and **zero retrieval pollution**.

Consistency rule (resolved this session): if we freeze a transcript for provenance, we freeze *every* derived-from source for the same reason. Pointers were rejected — a path into `~/Documents/` rots the moment you reorganize, and provenance that can silently break isn't provenance.

```
raw/
  pai/<mirror of PAI's original tree>          migration, self-documenting
  transcripts/2026-06-06-sts2-sync.md          ad-hoc dumps, dated + slugged
  tax-2025/<the 50 CSVs + 20 PDFs, untouched>  evidence bundles, as-is
```

Rule: **one folder per source. Originals dropped in untouched, immutable. A vault note points back with `source: raw/...`.** A single multi-domain source stays ONE raw entry even when it fans out into many vault notes — provenance is keyed to origin, not topic. Replaces the flat `source--name.md` smear.

**The 50-CSV case:** you do *not* ingest 50 CSVs as 50 notes. The CSVs land in `raw/tax-2025/` (archived, not searched); `vault/finances/tax-return-2025.md` holds the one derived note. Full receipts, clean search.

## Scaling (the one real technical trade)

`recall` today is a naive full scan (read all files, tokenize, score per query). Numbers:
- **153 notes:** ~10ms, instant.
- **50k notes, naive:** ~2–4s/query (tokenization dominates). Sluggish, not broken.

Scaling path — gets *faster at local arithmetic*, never adds a model:
1. **≤~10k:** full-scan BM25. Do nothing.
2. **~10k–100k:** grep-prefilter (ripgrep narrows 50k→hundreds at C speed, ~100ms) then BM25 on survivors. No new deps, no index, stays sub-second. Carries past 50k comfortably.
3. **>100k (won't hit personally):** persistent inverted index, built incrementally at ingest. ~10ms at any scale. Still local, zero deps, zero LLM.

**Invariant:** scaling is a local index, never embeddings/vectors/LLM.

## What to steal from PAI's "robot" — exactly two functions

Audited every PAI hook/subsystem. Two are worth having, **both as explicit commands, not hooks/daemons**:

1. **Conversation → vault harvest.** Finish the `wrapitup` skill so it feeds `knowful ingest` — consciously persist a chat's learnings into the vault at session end. (90% built; needs the last inch.)
2. **Integrity check + regenerate.** `knowful check` — flag orphaned `[[links]]`, notes resolving no entity, and regenerate `index.md` (deterministic, on demand).

Everything else (LoadContext auto-inject, satisfaction/learning self-scoring, relationship memory, security pipeline, observability, Pulse daemon, voice) is either out of scope for a private local vault or the auto-magic knowful deliberately rejects. Reason the robot felt useless: it was a filing cabinet inside a robot suit, and the suit billed rent (token tax + misfires).

## TODO

### knowful core — build (lean, explicit commands)
- [ ] **harvest:** finish `wrapitup` → `knowful ingest` bridge (conversation → vault)
- [ ] **integrity:** `knowful check` (orphan links + unresolved entities + regenerate `index.md`)
- [ ] **restructure:** migrate vault from type-first to domain-first (entities + domains + forms); `notes/` dissolves; `things/`→`holdings/`; `principles/`+telos→`identity/`
- [ ] **raw/ rework:** by-source structure (mirror-tree / `transcripts/` / bundles); copy all source kinds; replace `--` flattening
- [ ] **contract:** fold all the above into `CLAUDE.md` + `docs/architecture.md` (+ regenerate the d2 diagram)

### Pluggable modules — opt-in, NOT core
> Resolved: these aren't knowful core and aren't PAI-only either — they're **pluggable modules**. Self-contained, opt-in, `rm -rf`-able dirs that compose onto the lean vault. This is the moat (opt-in composability): core never grows to absorb them; you add what you want. Each is its own module spec when/if built.
- [ ] DA persona (e.g. Taylor) — pluggable
- [ ] notifications / voice — pluggable
- [ ] Algorithm / ISA (verification methodology) — pluggable
- [ ] skill + delegation + agent systems (powers Council, RedTeam, etc.) — pluggable
