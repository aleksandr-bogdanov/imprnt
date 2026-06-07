# imprint - how it works (the plain version)

A personal knowledge base you own, built to be used by you and by an AI assistant. No database,
no cloud, and no paying an AI to do boring work.

This explains the whole thing in plain terms. If you read one section, read "The core idea."

---

## The problem

Your work generates a stream of context: 1:1s, meeting transcripts, decisions, who-owns-what,
lessons learned the hard way. It piles up, and two things go wrong:

1. **You cannot find anything.** Six months in, you know you discussed something, but you
   cannot dig it out.
2. **Your AI assistant knows nothing.** Every chat starts cold. You re-explain your projects,
   your team, and your history every time.

imprint fixes both. Dump things in, and later ask "what do I know about X?" to get a real
answer, including from an AI agent that can then help you act on it.

## The core idea

**The AI builds the tools, the tools do the work.**

An AI model is expensive and forgets everything between sessions. So you keep it out of the
mechanical work (parsing, filing, searching) and write small programs that do that for free.
You spend the AI only on the one thing that genuinely needs understanding.

It is the same reason you do not add up a spreadsheet by hand: you build the spreadsheet. The
AI's job here is to build and maintain the small programs, and to do the roughly 20% that is
real thinking. Everything else is plain code running for free.

The line between the two is drawn by **how often a step runs**. A step that runs once per item
(read prose, decide the type, write the summary) earns the AI. A step that runs thousands of
times (search) stays pure local code. That is what "deterministic-first" means here: ration the
AI by frequency, not a blanket rule to avoid it.

## Where the data lives: plain text files

No database. No app lock-in. Just markdown (`.md`) text files in folders on your disk:

```
# entities - cross-cutting, one canonical home each, linked from everywhere
people/      a person
orgs/        an institution: employer, insurer, Behörde, bank, vendor
holdings/    an owned thing with tracked, changing state: a policy, a med + dose, an account, a subscription

# domains - your life-areas (you define these), most content lives here
identity/    the spine: mission, goals, beliefs, mental models, the positions you hold
health/  ·  finances/  ·  work/  ·  life/  ·  projects/

# forms - distinct by how you use them
events/      a dated occurrence (a 1:1, a meeting)
mistakes/    a lesson learned
```

Three kinds of folder, each a genuinely different reason to exist. **The folders are
browse-drawers, not the search axis.** Search is grep plus BM25 ranking and ignores folders
entirely. So you organize by life-area, the way you actually look for your own knowledge.
Entities get one cross-cutting home each because they are referenced from everywhere. A note's
`type:` field records what it is (a principle, a policy) even when it lives in a domain folder.

The domain set is yours to define. These are one person's. A consultant's would be `clients/`,
a researcher's `topics/`. Open them in any editor, or in Obsidian. They are yours forever, with
nothing to lock into and nothing that can disappear or send you a bill.

## What a note actually looks like

Every note is a markdown file with two parts. The top, fenced by `---` lines, is the
**frontmatter**: structured fields a program can read. Everything below is the human body.

```markdown
---
type: person
updated: 2026-06-04
tags: [identity, bigquery]
role: Director, Identity
team: Tech Foundations
aliases: [Carl Carter, B. Carter, Boris]   # every name this person has been called
status: active
---

# Boris Carter

Director of Identity, owns the access-platform project.

## Notes
- Owns the [[projects/access-platform]] migration
- Seen in [[events/2026-06-02-access-sync]]
```

- **Frontmatter** (the `---` block) is YAML: simple `key: value` lines. Every note has `type`,
  `tags`, and a one-line `summary` (the AI writes it once, a deterministic pass reads it to
  build `index.md`). The **H1 (`# Title`) is the title**, so there is no `title:` key. A note in
  a domain folder also carries `domain:` so it is self-describing, and `imprint check` fails if
  folder and field disagree. `source:` is a clickable wikilink back to the immutable snapshot
  the note came from. Entity-valued fields are links too (`owner: "[[people/alex]]"`). This is
  the part the tools read and query.
- **The body** is for humans: a `#` title, `##` sections, prose, and `[[links]]` to other
  notes. Provenance markers tag only the exceptions: `{inferred}` means the AI concluded it
  rather than reading it in the source, `{ambiguous}` means it needs review. Unmarked is the
  common case and means straight from the source.
- **The file's name is its permanent ID** (its slug, for example `people/boris-carter.md`).
  Other notes link to that ID, never to the display name, which is what makes corrections cheap
  (see below).

## The one moving part: "ingest"

When you drop in a source, a single pass turns it into filed notes. The steps, and which use
the AI:

1. **Snapshot and parse (plain code, no AI, instant).** Copy the source into `raw/<source>/`
   untouched, hash it, update the manifest, and pull any regular structure (speakers, dates).
   Free.
2. **Classify and enrich (the AI, the only paid step).** For each object in the source: pick
   its `type` and folder, write a one-line summary, pull decisions and actions with judgment,
   tag the note with the words you will later search for even if the source never used them, and
   wire at least one link to another note. A dense multi-topic source fans out into many atomic
   notes here (the doctor becomes a `people/` note, a tracked drug becomes a `holdings/` note),
   all sharing the one `raw/` snapshot.
3. **Resolve and file (plain code, no AI).** Grep names and `aliases` across the entity folders.
   If this person is already on file under a nickname, merge rather than create a duplicate.
   Write the note, append the one chronological line to `log.md`.
4. **Regenerate and soft-fail (plain code).** `imprint check` rebuilds `index.md` and flags any
   note that links nothing, resolves no entity, has an orphan link, or carries no tags into
   `needs-review`. It never blocks and never silently drops.

## The cardinal rule: the data is the knowledge

`recall` searches `vault/` only. Anything left in `raw/` is invisible. So a note must carry the
source's structured payload, not a prose gesture at it.

- **Never summarize a catalog to prose and point at the snapshot.** A rated list, a price
  table, a backlog, an account number, a verbatim legal clause: copy it into the note, in full,
  never rounded or paraphrased. "The live table lives in the source" is the failure that
  silently deletes knowledge, because the rows are the note.
- **Enrich means add (summary, tags, links), never remove.** Reformatting prose is fine.
  Dropping a table, an enumeration, or a specific figure is data loss. Tables stay tables,
  enumerations stay enumerations.
- **The anti-slop rules govern prose, not data.** A rated catalog or a record table is data:
  keep it structured, it is exempt.
- **The lookup test, applied before a note is done:** could you answer a specific question from
  the vault note alone? If the answer is only in `raw/`, you dropped the knowledge. Re-derive
  it.

## Updating and corrections

Say you ingest a new meeting and learn that a colleague you had on file as **Carl** is actually
**Boris**, and a **Director**, not an Engineer. That sounds like it should force you to hunt
down every note that mentions him. It does not, and that is the whole point of one-file-per-thing:

1. Ingest looks him up by his **aliases**, finds the existing note, and does not create a second
   one.
2. It updates that **one** note: fixes the name and role, and adds the old name `Carl` to the
   `aliases` list so older references still resolve.
3. Nothing else needs touching. Every other note links to him by his permanent ID, not his
   name, so the moment you fix the one person-note, every meeting and project that points at him
   shows the corrected name and role automatically. Correct once, everyone benefits.

The one special case is a **contradiction**: a new meeting says the cutover date moved. Then
ingest updates the project note and stamps the old line `> superseded by [[...]]`, so search can
tell the current fact from the stale one. Old information is marked, never silently overwritten.
Because the raw sources are kept untouched, you can always trace where any claim came from.

## Finding things: BM25 ranking

Retrieval is ranked search over the files, and the AI sits only at the two ends. The AI shapes
your plain question into keywords at the front, and reads the top hits at the back. In the
middle is `recall`, which runs **BM25** and returns a tight ranked set (about the top 15).

BM25 is the standard term-frequency-times-inverse-document-frequency ranking, with field boosts
so a term in the title or aliases outweighs the same term in tags, which outweighs the body. It
is pure local arithmetic with zero LLM and zero dependencies, so it is the cheap default the
read path runs thousands of times. Its idf already floats a rare matched term above a common
one, and a single matched term still scores, so it returns a tight, well-separated set rather
than the whole vault. You can also see exactly why something matched, with no black box.

Why this and not the alternatives:

- **A database or SaaS (Notion and the like)** locks your knowledge inside someone's product,
  and an AI agent cannot cheaply read it, because every query goes through an API and costs
  tokens. Here it is plain files the agent reads directly, for almost nothing.
- **Vector or "semantic" search** sounds smarter, but it is expensive, it goes stale on every
  edit (you re-index constantly), and you cannot see why it returned something. BM25 over plain
  text is free, transparent, and good enough once the notes are tagged well on the way in. If it
  ever falls short, the scaling path is a faster local index (grep-prefilter, then a persistent
  inverted index), never a model.
- **Plain text you own** cannot be locked in, cannot 404, cannot bloat, and works with any tool:
  today's AI, tomorrow's, or just `grep` and your eyes.

The reason search works is step 2 of ingest: the right search words were written into the note
when it was created. So when you later search "cost," the partitioning note is already tagged
for it.

## Tags: an auto-growing vocabulary

Free-form tags are where these systems quietly rot. One note gets `pipeline`, the next
`ingestion`, the next `etl`, and now a search for any one of them misses the other two. The fix
is not a gated allowlist that blocks new tags. It is an auto-growing vocabulary that an audit
keeps lean.

`vault/_tags.md` holds the tag values plus a bidirectional synonym map. At ingest the AI applies
the best-fitting tag. If none fits, it coins a new one (kebab-case, one concept) and uses it.
There is no human-approval gate, because a tag is just a string the note already holds.
`imprint check` then syncs every tag the notes carry into `_tags.md` for free. So a new domain
(wardrobe, shoes, a client) never hits a wall: tag the note, run `check`, the vocabulary catches
up.

The discipline that keeps the list lean moved off the write path to a non-blocking audit.
`check` flags near-duplicate tags (a shared prefix, or one edit apart, like `finance` and
`finances`, or `shoe` and `shoes`) so you can fold them into a synonym consciously. It never
auto-merges, because picking the canonical term is judgment, not arithmetic, and that is the one
tag step that stays a human call. The synonym map is applied the same way at write and at
search, so one concept resolves to one tag in both places.

## Why it does not become a junk drawer

The usual death of a notes system: you have to remember to tag, link, and file things, you do
not, and it rots into a mess.

Here, the program files and links on the way in, so your discipline is not required. Anything it
could not resolve (a person it could not match, a note with no connections, a note with no tags)
shows up at the top of your "what's hot right now" file every time you open the system. A problem
in your face gets fixed. A problem in a report nobody runs does not.

## Correction is the only learning

The system does not grade itself or score whether retrieval "worked." That would burn the AI on
navel-gazing. The one learning loop runs when you correct a match ("no, I meant the tax office,
not beer ratings"): that correction folds a synonym into `_tags.md`, deterministically and for
free. The map improves only when you fix something. No background analysis, no evals, ever.

## Built in pieces: core plus plugins

The only thing that is always there is the core: the vault plus `ingest`, `recall`, and the
tidy-up `check`. Everything else is an optional plugin you install or delete with one command:
task sync, a file librarian, an anti-slop ruleset for your assistant, a connections viewer.
Nothing is forced on you. The core stays small, and anyone who forks it keeps only what they
use.

The plugins follow one rule that keeps the core from quietly bloating, the way these systems
usually die: **the core never knows any plugin exists.** The test is simple. You can add or
delete any plugin without editing a single line of core code (`scripts/`). A plugin reads your
notes like any script would, writes only inside its own folder (to change a note it proposes the
change and you approve it), keeps its data out of search unless it proposes a real note you
accept, and runs only when you run it, never as a hidden background process.

The shipped gallery lives in `plugins/`:

- **character** is your assistant's voice and standards. Scribe is the generalized default
  you copy and personalize.
- **anti-slop/** is the ruleset that keeps the assistant's prose from reading like AI.
- **whenful/** keeps a local mirror of your Whenful tasks, rendered at read time (live sync is
  deferred).
- **guard/** is a deterministic blocklist for dangerous shell commands.

A behavior plugin like `character/` or `anti-slop/` works by handing the assistant a fixed chunk
of text that you wire into its config. The mechanism is `CLAUDE.local.md`, a gitignored
per-machine file Claude Code auto-loads right after the committed `CLAUDE.md`. `imprint plugin
add <name>` appends the one `@import` line for you, and `rm` strips it back out. A fresh clone
has no `CLAUDE.local.md`, so it loads zero plugins by default. Deleting the line is the real
off-switch the old system never had. The whole point: the system imprint replaces imposed its
features on you, imprint lets you compose only the ones you want, with a real off-switch. Full
rules are in `plugins/README.md`.

## Safety net: the originals are never touched

Your raw sources are kept untouched, forever, one folder per source under `raw/`. So if you ever
want to change how notes are structured, you re-run ingest over the originals and get the new
layout for free. You are never trapped in an old format, and any claim in a note traces back to
its snapshot.

## Using it with an AI assistant

You talk to your AI assistant, the assistant runs the tools. It reads your "what's hot right
now" file first, searches the notes when it needs to, and helps you draft a plan grounded in
your actual history rather than generic advice. You speak plain language, the tools do the rest.

---

The whole design is one trade: do the boring work in cheap, transparent code, spend the
expensive and forgetful AI only where understanding is unavoidable, and own every file at the
end.
