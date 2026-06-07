# imprint — vault contract

> The schema for the vault. When an agent works inside an imprint vault, this is the standing context it needs. Keep it small.
> Headline: **the LLM builds the tools; the tools do the work.**

<!-- Plugins are NOT wired here — this committed contract ships clean. Enable them per-machine in CLAUDE.local.md (gitignored), which Claude Code auto-loads after this file. See ## Modules and plugins/README.md. -->

## Entry point: you talk, the assistant runs the tools

You never run the CLI by hand. You speak in plain language ("ingest this", "load my context on taxes"); the agent runs the CLI underneath. Sources are anything — a meeting transcript, a pasted doc, a prose dump, or a single fact to file.

## Privacy: it's a private vault, full stop

The whole vault is yours, local, owner-only (`chmod 700`), never shared — same model as the system it replaces. There is **no** sensitivity field, no redaction pass, no secret-fencing. It holds everything, including medical/financial/personal data, because that's the point. The only rule: it never goes near a public repo (`.gitignore` guards it if the dir is ever git-init'd). If you ever publish a subset (an article), that's an **export-time** filter you run consciously then — not a tax paid on every note at ingest.

## The one rule: deterministic-first = ration the LLM by WHERE it runs

Deterministic-first does **not** mean "avoid the LLM." It means **invest it where it pays and keep it out of the hot path**. The line is drawn by *how often a step runs*:
- **WRITE path (runs once per item)** — that's where the LLM earns its keep: understand unstructured prose, decide the type, write the summary, pull decisions/actions with judgment, assign tags + `kind`, propose `aliases`, wire links — and optionally clean/rephrase a messy dump into a usable note. Building the content map *well* is the important one-off work; spend the tokens here.
- **IMPORT (one-time bulk)** — a migration is exactly that one-off WRITE work at scale: one pass of LLM understanding/cleaning over the source so every later read is cheap. That's the purpose, not an excess.
- **READ path (runs thousands of times)** — must be **cheap, deterministic, local**: grep + **BM25 ranking (core)**, no LLM in the loop. The LLM only shapes the question into keywords at the front and reads the top-N hits at the end — never re-reads the whole vault (the unconscious trap), never re-ranks per query.

"The dumbest thing that works" is measured **against the LLM**: BM25 is pure local arithmetic (term frequencies + idf), zero LLM, zero deps — so it is the **default ranker**, not an opt-in. The discipline is that you don't pay the LLM on every query, and you don't make code guess at meaning on the write side.

The same line, step by step (note *who* and *why* — frequency is the axis):

| Step | Who | Why |
|------|-----|-----|
| Snapshot source → `raw/<source>/` (one folder per source), hash, manifest (incremental) | **code** | mechanical, must be exact, free |
| Parse structure from *structured* input (speakers, dates, frontmatter, headings) | **code** | reliable when the shape is regular |
| Read *unstructured* prose to find that structure | **LLM** | there's nothing to parse — it takes reading |
| Decide the note's **type** + folder + write `summary` + extract decisions/actions with judgment + assign tags + set `kind` | **LLM** | irreducibly semantic — the conscious ~20% |
| **File** the note into its folder | **code** | once the type + folder are decided, writing is mechanical |
| Generate `index.md` from each note's `summary` + tags + links | **code** | a map-of-content is a deterministic read over frontmatter — `imprint check` rebuilds it |
| Append the one `log.md` chronological line | **LLM** (the conscious step) | the title + one-line gist is a fresh judgment the agent that made the note writes |
| Entity resolution: exact + `aliases[]` grep, MERGE on hit | **code** | the common case is a lookup, not a judgment |
| Adjudicate a *genuinely ambiguous* identity / propose new `aliases` | **LLM** | only the uncertain ones — not every resolution |
| Corpus scan for retrieval (BM25 ranking over title/tags/body) | **code** | fast, free, transparent, runs over 1000s of notes |
| Turn a natural-language question into keywords/tags, and read the top hits to answer | **LLM** | it's the interface; it already has the query and the results in hand |

"Not sure → hand it to the LLM" is a **first-class allowed move on the WRITE side**. The discipline is that you don't make code guess at meaning, and you don't put the LLM in the read loop.

## Retrieval: BM25 ranking (deterministic, local), LLM at the two ends only

1. The LLM (already talking to you) shapes your question into keywords + candidate tags. *(conscious, cheap, front)*
2. `recall` runs **BM25** over each note's title/tags/body and returns a **tight ranked candidate set** (top ~15). *(code, free)*
3. The LLM reads the top hits and answers. *(conscious, back)*

BM25 is the **core** ranker: standard term-frequency × inverse-document-frequency with field boosts (a term in the title/aliases outweighs the same term in tags, which outweighs body), pure local arithmetic, no LLM, no deps. Its idf already floats a rare matched term above common ones and a single matched term still scores — so it returns a tight, well-separated set, not the whole vault. Explicitly: **no per-query LLM re-ranking in core, no embeddings, no vectors, no MCP over the vault.** The LLM shapes the query and reads the top-N — it is never in the middle. `recall` greps `vault/` only — `raw/` is never searched.

## Layout — entities · domains · forms

Three folder groups, each a genuinely different reason to exist. **Folders are browse drawers, not the search axis** — `recall` is grep + BM25 and ignores folders entirely, so layout is a pure human-browsing choice. Humans browse by life-area, so **domains** carry most content; **entities** get cross-cutting homes because they're referenced from everywhere; **forms** are distinct by how you use them.

```
raw/                     immutable source snapshots, ONE FOLDER PER SOURCE — never edited, never searched
  pai/<mirror>           a migrated tree, mirrored as-is
  transcripts/<dated>    ad-hoc dumps, dated + slugged
  <bundle>/              evidence bundles (e.g. tax CSVs / PDFs), untouched
vault/
  index.md               generated map of content — code builds it from each note's `summary`
  hot.md                 ~500-tok primer + needs-review + (optional) review-due list
  log.md                 append-only chronological stream
  _tags.md               auto-growing tag vocabulary + bidirectional synonym map (check syncs it)

  # entities — cross-cutting, one canonical home, linked from every domain
  people/<slug>.md       a human
  orgs/<slug>.md         an institution — employer, insurer, Behörde, bank, vendor
  holdings/<slug>.md     an owned thing with TRACKED CHANGING STATE — a policy, a med+dose, an account+balance, a paid subscription+renewal

  # domains — life-areas; topical/reference content lives here (USER-DEFINED, not fixed)
  identity/<slug>.md     the spine — mission, goals, beliefs, models, frames, strategies, held positions, who you are
  health/  ·  finances/  ·  work/  ·  life/  ·  projects/

  # forms — distinct by how you use them, not by topic
  events/<YYYY-MM-DD>-<slug>.md   a dated occurrence worth its own note
  mistakes/<slug>.md             a lesson — believed / found_false / true_now
```

**Filing decision (the LLM's conscious call, per note):**
1. Is it a **person / org / holding** (a tracked-state owned thing)? → entity folder, regardless of topic.
2. Is it a **dated occurrence** → `events/`; a **lesson learned** → `mistakes/`; a **bounded effort with a status** → `projects/`.
3. Otherwise it's **topical content** → file by **domain (life-area)**: a held position / identity-spine note → `identity/`; everything else by its life-area (`health/`, `finances/`, `work/`, `life/`).

**holdings/ vs reference — the cut is CHANGING STATE, not the word "tool."** Anything you follow over time is a holding: a premium, a dose, a balance, a status, a renewal. A paid subscription with a cost/renewal (a BVG Abo) is a holding even if you'd call it a "service." Static stuff with no state to track is **not** a holding — a free CLI, your dotfiles, tech-stack preferences are pure reference → file them in their domain (`work/`, `health/`). This cut is what keeps `holdings/` a real tracked-entity type instead of drifting back into a `things/` junk drawer.

**Domains are user-defined.** Alex's are `identity/ health/ finances/ work/ life/`; a consultant's would be `clients/`, a researcher's `topics/`. imprint ships the mechanism + sensible defaults, not a fixed domain set. `type:` in frontmatter (below) records *what each note is* even when it sits in a domain folder, so nothing is lost by filing topically.

## Frontmatter contract

`type` is **singular** and records *what the object is*, independent of which folder it browses in: `person`, `org`, `holding`, `project`, `principle`, `note`, `mistake`, `event`. Entities and forms file into a folder of the same name (`person` → `people/`); `principle` and `note` file by **domain** (a belief → `identity/`, a tax fact → `finances/`). The folder is the drawer; `type` is the truth.

Every note carries `type`, `tags`, and **`summary`** — a single line the LLM writes once at ingest. `summary` is the field the READ side leans on deterministically: `imprint check` builds `index.md` purely from each note's `summary` + tags + links, no LLM (it falls back to the H1 title if `summary` is absent). **The H1 (`# Title`) is the title** — no `title:` key, no universal `created:`. Use `updated:` on notes that change; events carry their own time fields.

**Self-describing placement + links.** A note in a **domain folder** (`identity/health/finances/work/life/projects`) carries **`domain: <that folder>`** in frontmatter — so the note knows its life-area without parsing the path; `imprint check` fails if folder and field disagree (the redundancy `type:` already has with entity folders, made a checked invariant). Entity/form notes need **no** `domain` (their `type` already mirrors their folder; an entity is cross-cutting, with no single domain). **`source:` is a wikilink** to the immutable snapshot — `source: "[[raw/pai/...]]"` (no `.md`) — clickable in Obsidian when the vault is opened at the repo root so `raw/` resolves; `recall` never searches `raw/` and `check` never treats a `raw/` link as an orphan. **Entity-valued fields are wikilinks too** — `owner: "[[people/alex]]"`, `participants: ["[[people/...]]"]`, `policyholder`, `beneficiary` — so ownership/authorship edges are real graph links, not bare strings (the principal is a first-class entity: `people/alex`).

- **people**: `team · role` *(opt: `owns[] · aliases[] · status`)*
- **orgs**: `kind(employer|insurer|authority|bank|vendor)` *(opt: `aliases[]`)*
- **holdings**: `kind(policy|med|account|subscription|asset) · owner · status` *(opt: `aliases[] · review_by`)* — `status` carries the tracked state (a balance, a dose, a renewal date, a coverage tier). The `kind` set is deliberately the tracked-state objects; a free tool/dotfile is **not** a holding (no state) — it's a `note` in its domain. (Migration fix: the off-contract `kind: record` maps to the right `kind` here.)
- **projects**: `status · owner · updated` *(opt: `artifact · target · people[] · holdings[]`)* — `status` free string (`active|paused|done`); `artifact` = the app/CLI/output as a string, not a separate note; `target` = a plain date intent marker, NOT a scheduler (no loop reads it).
- **principles**: `kind(belief|model|frame|strategy|mission|narrative|challenge|problem|wisdom)` *(opt: `aliases[]`)* — the identity spine; lives in `identity/`.
- **notes**: `kind(reference|howto|preference|rating|strategy|collection)` *(opt: `aliases[]`)* — reference knowledge; lives in its **domain** folder.
- **mistakes**: `project` — the believed / found-false / true-now lesson lives in the body as prose (mark `{inferred}` only where the conclusion is the LLM's), not frontmatter.
- **events**: `date · participants[] · project · source · source_hash · status · ingested` — emitted by `ingest.ts`; `status` goes `draft-deterministic` → `enriched`.

Three orthogonal axes, each doing real work: **type** (frontmatter) = what object · **kind** (field) = what form · **tags** = what topic. The **folder** is a fourth, human-only axis (where it browses) — never the search axis. (`domain:` as a frontmatter *field* from v1 is dropped — the domain IS the folder for browsing; tags are the topic axis for search.)

Optional on any note: `review_by: <date>` for perishable facts. Surfaced **only on demand** via `hot.md` — never a background loop, never a separate command.

## Tags: an auto-growing vocabulary (not a gated list)

`vault/_tags.md` holds the tag values + a bidirectional synonym map. The vocabulary **grows automatically** — there is **no human-approval gate**. At ingest the LLM applies the **best-fitting tag**; if none fits, it **coins a new one** (kebab-case, one concept) and uses it. `imprint check` then **syncs every tag the notes carry into `_tags.md`** deterministically (a tag is just a string the note already holds — no LLM, no approval). So a new domain (wardrobe, shoes, a client) never hits a wall: tag the note, run `check`, the vocabulary catches up.

The discipline that keeps the list lean moved **off the write path** to a non-blocking audit: `check` flags **near-duplicate tags** (prefix or edit-distance-1, e.g. `finance ~ finances`, `shoe ~ shoes`) so they can be merged into a **synonym** consciously. `check` never auto-merges — picking the canonical is judgment, not arithmetic, and that's the one tag step that stays an LLM/human call. Before coining, the LLM should still scan the existing list + synonyms and reuse a fit; one concept = one tag remains the goal, now enforced by the dedup audit rather than a pre-approval. The synonym map is a deterministic assist applied the same at write and at search — keep it lean, avoid over-broad canonicals that collapse specific terms.

## The ingest pass

1. **snapshot + parse (code)** — copy the source into `raw/<source>/` (one folder per source, immutable), hash, write any deterministic skeleton, update the manifest. Incremental: unchanged sources skip. A multi-topic source stays ONE `raw/` entry even when it fans out into many vault notes — provenance is keyed to origin, not topic.
2. **classify + enrich (LLM, the conscious step)** — for each object in the source: pick `type`, choose the folder (entity / domain / form per the filing decision), write the one-line `summary`, pull decisions/actions/questions with judgment, assign tags + `kind`, propose `aliases`, ensure ≥1 link to another entity.
3. **resolve + file (code)** — grep names + `aliases` across `people/ orgs/ holdings/`, MERGE on hit (never duplicate; rename → old name to `aliases`, keep the slug), write the note. Append the one `log.md` line (the LLM's gist).
4. **regenerate + soft-fail (code)** — `imprint check` rebuilds `index.md` from every `summary`, and flags any note that links nothing / resolves no entity / has an orphan `[[link]]` into `needs-review`, surfaced atop `hot.md`. Never block; never silently drop.

## Fidelity: the data IS the knowledge (the cardinal ingest rule)

**The note must carry the source's structured payload — tables, lists, entries, IDs, numbers, dates, prices, doses, contact details, verbatim legal/clause text.** `recall` searches `vault/` ONLY; anything left in `raw/` is **invisible**. So the summary is *in addition to* the data, never *instead of* it.

- **NEVER summarize a catalog to prose and point at the snapshot.** "The live table lives in the source" is the failure that silently deletes knowledge — the rows ARE the note. A rated list, a price table, a backlog, an account/cadastral/contract/insurance number, a verbatim AVB clause: copy it INTO the note, in full, never rounded or paraphrased.
- **enrich = ADD (summary, tags, links, `kind`), never REMOVE.** Reformatting prose↔prose is fine; dropping a table, an enumeration, or a specific figure is data loss. Preserve tables AS tables, enumerations AS enumerations.
- **Anti-slop governs PROSE, not DATA.** The "no bullet-flood / paragraphs over bullets" rule is about narrative writing. A rated catalog or a record table is data — keep it structured; it is exempt.
- **The lookup test (apply before declaring a note done):** could you answer a specific question from the VAULT note alone — "what tier is Hasseröder", "what's my Sozialversicherungsnummer", "what are the Voronezh flat's cadastral details", "what's the Generali Unfall payout schedule"? If the answer is only in `raw/`, you dropped the knowledge. Re-derive.

## The two robot commands (explicit, never a daemon)

imprint keeps exactly two "robot" helpers stolen from the system it replaces, and both are **commands you run**, never background hooks — the auto-magic is what made that system bill rent.

- **`imprint check`** — integrity + regenerate. Flags orphan `[[links]]`, notes that resolve no entity, **untagged notes** (empty `tags:` — the topic axis is blank), unclassified snapshots, and near-duplicate tags; rebuilds `index.md` deterministically from every note's `summary` + tags + links, and **syncs new tags into `_tags.md`** (the auto-growing vocabulary). Run it after an ingest or any hand-edit. Writes only the two non-note control files (`index.md`, `_tags.md`); never mutates a note. (The dedup audit catches *spelling*-near tags only; *semantic* synonyms like `clothing`/`wardrobe` are the LLM's call at write time + a `_tags.md` synonym entry — code never merges meaning.)
- **harvest** — the conversation→vault bridge: at the end of a chat, `wrapitup` hands the session's durable learnings to `imprint ingest`, so a decision made in conversation becomes a filed note. Conscious, on demand, never automatic.

## Updating & contradictions

Correct the ONE entity note; everything links by ID so the fix propagates. Old name → `aliases`. A contradiction stamps the stale line `> superseded by [[...]]` — marked, never silently overwritten. Because `raw/` is immutable, any claim is traceable to its snapshot, and a schema change is just a `reingest` over `raw/`.

## Migrating existing structured knowledge

A migration is the one-time bulk WRITE — snapshot every chosen source into `raw/<source>/` (immutable, complete), then the LLM fans each source out into atomic, domain-filed, linked notes. Two rules keep it honest:

- **Re-derive from the ORIGINAL source, not a prior vault.** When you rebuild the vault, go back to the original snapshots in `raw/` — don't reshuffle a previous vault's notes (that migrates yesterday's mistakes forward). A schema change is just a `reingest` over `raw/`.
- **But preserve genuine prior enrichment.** When a *source* is already an atomic, enriched note (e.g. PAI's `KNOWLEDGE/` notes), map its fields onto this contract and keep its typed links — don't re-derive it from scratch (that pays the LLM to downgrade good work). Re-deriving from scratch is for *unstructured* sources (the dense prose blobs).

**A dense multi-topic source splits into atomic linked notes — one snapshot, many notes.** Alex's real PAI files are dense blobs covering many objects at once (a health-overview file = the med stack + a mental-health profile + the BU-critical prescription/timing decision + the psychiatrist-as-a-person). Don't file the whole blob as one note — that loses the entity graph (the doctor never becomes a `people/`, the BU decision never becomes a linkable note). Instead: split it into one atomic note per object across the right folders (`people/` for the doctor, `holdings/kind:med` for a tracked drug+dose, `health/`/`identity/` for the profile/decision), link them, and keep the single `raw/` snapshot as the shared provenance for all of them. `ingest` writes one snapshot; the LLM fans it out into the right number of notes.

**TELOS goals route in — no extra folder.** A goal that's a bounded effort with a status (`lock in BU insurance`, `stack cash through April 2027`) → `projects/` with a `status` (and an optional `target:` date string). A north-star *intent* that isn't yet a bounded effort (a mission/narrative) → `identity/` with `type:principle kind:mission`. No `goals/` folder.

## Conventions
- `[[people/boris-carter]]` wikilinks; orphans surface in `needs-review`. Links use the entity folders (`people/ orgs/ holdings/`) as the stable namespace, but any note is linkable by its `folder/slug`.
- Provenance: mark only the **exceptions** — `{inferred}` (the LLM concluded it; not in the source) · `{ambiguous}` (uncertain, needs review). **Unmarked = straight from the source** — the common case carries no marker, because tagging every line is noise that drowns the signal. Plain brace tags, NOT `^[...]` (a leading `^[` is caret-notation for the ESC control char and corrupts on copy/paste).
- Slugs kebab-case ≤60. Filename = permanent ID; links use the ID, never the display name.

## Plugins (opt-in add-ons) — the contract

Core is the vault + `ingest → recall → check`. Everything else (Whenful sync, a documents librarian, an anti-slop behavior ruleset, graph lint, the guard) is a **pluggable plugin**. Full contract + the worked instances: `plugins/README.md`. The standing rules:

- **The one rule:** core never knows a plugin exists. Litmus — **you can add or remove any plugin with zero edits to `scripts/`.** A plugin depends on exactly two things: `vault/` notes (+ their frontmatter *format*) and its own sibling folder. Nothing else — not core code, not another plugin, not another plugin's folder/labels.
- **Entry point = the agent fragment.** Each plugin ships `plugins/<name>/agent.md` — a fixed-size fragment that tells the *agent* (never the core code) what the plugin is, where its data/mirror/join-table lives, its commands, and any always-on rules. Install = add one `@plugins/<name>/agent.md` import line to **`CLAUDE.local.md`** (gitignored, per-machine; Claude Code auto-loads it after this contract — never wire plugins into this committed file); remove = delete that line + `rm -rf plugins/<name>`.
- **Read** direct (parse the note format); core publishes **no importable code as a contract** — plugins **copy** the ~12-line header reader (reversible; promote to a shared lib later only if duplication actually hurts).
- **Write** single-writer-per-path: a plugin writes only its own folder and **proposes** vault-note changes for `ingest`/you to apply — never mutates a note. Frontmatter labels are **slug-namespaced** (`whenful.synced`), read-your-own-only; core ignores unknown keys.
- **`recall` searches `vault/` only, forever** — sibling dirs + `raw/` are outside the corpus by construction. A plugin surfaces into search only by **proposing one low-frequency summary note** (the escape hatch).
- **Behavior plugins** are a separate class: ship a fixed-size fragment the **user wires into the agent's system prompt**; the vault never auto-injects; remove = delete the wire-in. No referee for conflicting fragments — user owns composition. (PAI imposed; imprint composes.)
- **Commands only, no forced daemon** — the user schedules sync. Install/remove is manual (README `## Install` / `## Remove` + `rm -rf`); no registry.
- **Core ↔ plugin contact = exactly two convention-based aggregators**, both dumb and uniform: `imprint check --all` globs `plugins/*/check.ts`, runs each, reads **exit code only**, forwards stdout verbatim — never parses plugin output; `imprint ingest --apply` files staged notes the plugins drop in `plugins/*/proposed/`. Both discover by filename/dir convention, never by import, never by naming a specific plugin. Fence: core may provide read-only *aggregation* helpers, never write/orchestration. (Not k8s liveness/readiness — nothing runs; `check` = "is the data sound.")

## Out of scope (on purpose)
No task management. No auto-injected context. No background loop. No self-grading. No MCP/vector/embeddings on the vault. No sensitivity machinery (it's private by being private). **No `out/` zone for deliverables** — a produced artifact (an article, an export) lives in your artifacts dir and a vault note points to it; the vault holds knowledge, not outputs. Every plugin is a self-contained dir you can `rm -rf`. "It belongs" is not a reason to add it. (Plugin-contract out-of-scope list lives in `plugins/README.md`.)
