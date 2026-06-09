# How imprnt works (the plain version)

imprnt is a personal knowledge base you own. It is a folder of plain text files on your disk. No
database, no cloud, no app to log into.

You do not use it by typing commands. You talk to your AI assistant (Claude), and it drives imprnt for
you: it files what you tell it and recalls what you ask for. The command-line engine described below is
what the assistant runs under the hood. You almost never run it by hand.

If you read one thing, read "The core idea."

---

## The problem

Your life and work throw off a steady stream of context: meetings, decisions, who owns what, lessons
you learned the hard way. It piles up, and two things go wrong.

1. You cannot find anything. Six months later you know you discussed something, but you cannot dig it
   out.
2. Your AI assistant starts every chat blank. You re-explain your projects, your people, and your
   history every single time.

imprnt fixes both. You drop things in, and later you ask "what do I know about X?" and get a real
answer, including from an assistant that can then help you act on it.

## The core idea

**The AI builds the tools, the tools do the work.**

An AI model costs money to run and forgets everything between sessions. So you keep it out of the
mechanical jobs (parsing, filing, searching) and let small free programs do those. You spend the AI
only on the one job that truly needs understanding.

It is the same reason you do not add up a spreadsheet by hand. You build the spreadsheet once, then it
adds itself up for free. Here the AI builds and maintains the small programs and does the roughly 20%
that is real thinking. The rest is plain code running at no cost.

What decides which side a step falls on is **how often it runs**. A step that runs once per item (read
the text, decide what it is, write a one-line summary) is worth the AI. A step that runs thousands of
times (search) stays plain local code. That is all "deterministic-first" means: spend the AI by
frequency, not a blanket rule to avoid it.

## Where the data lives

Plain markdown (`.md`) text files in folders on your disk. There are three kinds of folder, each with
a different reason to exist:

```
# entities - things referenced from everywhere, one home each
people/      a person
orgs/        an institution: employer, insurer, bank, government office, vendor
holdings/    an owned thing with changing state: a policy, a medication and dose, an account

# domains - your life-areas (you choose these), most content lives here
identity/    the spine: mission, goals, beliefs, the positions you hold
health/   finances/   work/   life/   projects/

# forms - set apart by how you use them
events/      a dated occurrence (a 1:1, a meeting)
mistakes/    a lesson learned
```

The folders are browse-drawers, not the search index. Search ignores folders completely (it is grep
plus ranking), so you file things the way you would actually look for them: by life-area. Entities get
their own folders because they show up across many areas and need one canonical home.

The domain set is yours. The example above is one person's. A consultant would have `clients/`, a
researcher `topics/`. You can open any of it in a plain editor or in Obsidian. It is yours forever,
with nothing to lock into and nothing that can vanish or bill you.

## What a note looks like

Every note has two parts: a structured header a program can read, and a human body below it.

```markdown
---
type: person
updated: 2026-06-04
tags: [identity, access-platform]
summary: Director of Identity, owns the access-platform migration
role: Director, Identity
aliases: [Carl Carter, B. Carter, Boris]   # every name this person has gone by
---

# Boris Carter

Director of Identity. Owns the access-platform migration.

## Notes
- Owns the [[projects/access-platform]] migration
- Seen in [[events/2026-06-02-access-sync]]
```

- The header (the `---` block) is simple `key: value` lines. Every note has `type`, `tags`, and a
  one-line `summary`. The `# Title` line is the title, so there is no `title:` field. A note in a
  domain folder also carries a `domain:` field so it describes itself, and `imprnt check` complains if
  the folder and the field disagree. Entity references are links too, like `owner: "[[people/sam]]"`.
- The body is for you: a title, sections, prose, and `[[links]]` to other notes.
- The file name is the note's permanent ID, like `people/boris-carter.md`. Other notes link to that
  ID, never to the display name. That one rule is what makes corrections cheap (see below).

## The one moving part: ingest

When you ask your assistant to file a source, it runs one pass that turns the source into filed notes.
Four steps, and only one spends the AI:

1. **Snapshot (plain code, instant).** Copy the source into `raw/` untouched, hash it, and pull any
   obvious structure like speakers and dates. Free.
2. **Understand (the AI, the only paid step).** For each thing in the source, pick its type and folder,
   write a one-line summary, pull out decisions and actions, and tag it with the words you will later
   search for even if the source never used them. A dense source fans out into several small notes
   here. The doctor becomes a `people/` note, a tracked drug a `holdings/` note, all sharing the one
   snapshot.
3. **File (plain code).** Match names and aliases against the entity folders. If this person is already
   on file under a nickname, merge instead of making a duplicate. Write the note.
4. **Tidy and flag (plain code).** `imprnt check` rebuilds the index and flags any note that links
   nothing, matches no entity, or has no tags. It never blocks and never silently drops anything.

## The cardinal rule: the data is the knowledge

Search looks at `vault/` only. Anything left behind in `raw/` is invisible. So a note has to carry the
real payload, not a prose wave at it.

- Copy catalogs, price tables, account numbers, and exact legal wording into the note in full. Never
  round them, never replace a table with a sentence. The rows are the note.
- Enrich means add (summary, tags, links). It never means remove. Reformatting prose is fine. Dropping
  a table or a figure is data loss.
- The anti-slop prose rules do not touch data. A rated list or a record table stays structured.
- The test before a note is done: could you answer a specific question from the note alone? If the
  answer is only in `raw/`, you dropped it. Put it back.

## Corrections cost one edit

Say you ingest a meeting and learn that the colleague you had filed as **Carl** is really **Boris**,
and a Director, not an Engineer. That sounds like it should mean hunting down every note that mentions
him. It does not.

1. Ingest looks him up by his aliases, finds the existing note, and does not make a second one.
2. It fixes that one note (name and role) and adds "Carl" to the aliases so old references still
   resolve.
3. Nothing else needs touching. Every other note points at him by his permanent ID, so the instant you
   fix the one person-note, every meeting and project that mentions him shows the right name and role.
   Fix once, everyone benefits.

The special case is a contradiction. If a new meeting says a date moved, ingest updates the project
note and stamps the old line as superseded, so search can tell the current fact from the stale one.
Old information is marked, never quietly overwritten. The raw sources stay untouched, so you can always
trace where any claim came from.

## Finding things: BM25 ranking

Search is ranked lookup over the files, with the AI only at the two ends. The AI turns your plain
question into keywords at the front and reads the top hits at the back. In between sits `recall`, which
runs BM25 and returns a tight ranked set (about the top 15).

BM25 is the standard ranking that rewards a term appearing often in a note and being rare across the
whole vault, with a boost when the match is in the title or aliases. It is plain local arithmetic with
no AI and no dependencies, so it is the cheap default the read path runs thousands of times. You can
also see exactly why something matched.

Why this and not the usual options:

- A database or a product like Notion locks your knowledge inside someone's app, and an AI agent
  cannot read it cheaply because every query goes through an API and costs tokens. Plain files the
  agent reads directly cost almost nothing.
- Vector or "semantic" search sounds smarter but costs more, goes stale every time you edit (you keep
  re-indexing), and hides why it returned something. BM25 over plain text is free, transparent, and
  good enough once notes are tagged well on the way in. If it ever falls short, the fix is a faster
  local index, never a model.
- Plain text you own cannot be locked in, cannot 404, cannot bloat, and works with any tool: today's
  AI, tomorrow's, or just grep and your eyes.

Search works because of step 2 of ingest: the right search words were written into the note when it
was created. Search "cost" later and the note that never said "cost" still comes up, because it was
tagged for it.

## Tags: a vocabulary that grows itself

Free-form tags are where these systems quietly rot. One note gets `pipeline`, the next `ingestion`,
the next `etl`, and now a search for one misses the other two. imprnt does not fix this with a gate
that blocks new tags. It uses a vocabulary that grows on its own and an audit that keeps it lean.

At ingest the AI applies the best existing tag, or coins a new one if none fits. There is no approval
gate, because a tag is just a word the note already holds. `imprnt check` then folds every tag the
notes use into `vault/_tags.md` for free. A new area (wardrobe, a client) never hits a wall.

What keeps the list lean is a non-blocking audit, not a gate. `check` flags near-duplicate tags
(`finance` and `finances`, `shoe` and `shoes`) so you can merge them into a synonym on purpose. It
never auto-merges, because choosing the canonical word is a judgment call, the one tag step a human
keeps.

## Why it does not turn into a junk drawer

The usual death of a notes system: you have to remember to tag, link, and file things, you forget, and
it rots. Here the program files and links on the way in, so your discipline is not the load-bearing
part. Anything it could not resolve shows up at the top of your "what's hot" file every time you open
the system. A problem in your face gets fixed. A problem buried in a report nobody reads does not.

## Built in pieces: core plus plugins

The only thing always present is the core: the vault plus `ingest`, `recall`, and the tidy-up `check`.
Everything else is an optional plugin you install or delete with one command.

The plugins follow one rule that stops the core from quietly bloating: **the core never knows a plugin
exists.** The test is simple. You can add or delete any plugin without editing one line of core code.
A plugin reads your notes like any script would, writes only inside its own folder, and runs only when
you run it.

The shipped gallery:

- **character** is your assistant's voice and standards. Scribe is the default you copy and make your
  own.
- **anti-slop** is the ruleset that keeps the assistant's writing from reading like AI.
- **whenful** keeps a local mirror of your Whenful tasks, shown at read time.
- **guard** is a deterministic blocklist for dangerous shell commands.

A behavior plugin works by handing the assistant a fixed chunk of text wired into its config through
`CLAUDE.local.md`, a gitignored per-machine file Claude Code loads each session. `imprnt plugin add`
writes the one import line, and `rm` removes it. A fresh clone loads zero plugins. The point: the
system imprnt replaces forced its features on you, imprnt lets you compose only the ones you want, with
a real off-switch. Full rules are in `plugins/README.md`.

## Safety net: the originals are never touched

Your raw sources are kept forever, one folder per source under `raw/`. So if you ever want to change
how notes are structured, you re-run ingest over the originals and get the new layout for free. You are
never stuck in an old format, and any claim in a note traces back to its snapshot.

## How a session starts: imp

You reach your assistant through one command, `imp`, installed alongside the engine. It works
from any directory, in two forms:

- `imp` opens a Claude session where you stand. Your enabled plugins (your assistant's voice and
  standards) ride along, plus a small pointer that tells the assistant three things: your vault
  exists, search it with `imprnt recall` when you reference your own world, and run
  `imprnt context` before writing anything into it. The directory's own context loads as normal,
  so a coding session stays a coding session that can also reach your memory.
- `imp lair` opens the session inside the vault project itself, your assistant's home. The
  contract and plugin wiring load natively from the folder, and your personal conversations
  accumulate in one place, so resuming yesterday's thread works.

Typing `imp` instead of `claude` is the entire opt-in. Stock `claude` stays stock, and nothing
is ever wired into your global assistant config. The full contract (the filing rules) is never
paid for up front outside the lair either: a session that decides to file something runs
`imprnt context` at that moment and reads the rules then. The same frequency rule that keeps the
model out of the read path keeps the contract out of sessions that only read.

`imprnt init` registers the vault project in `~/.config/imprnt/` so imp can find it from
anywhere. `IMPRNT_ROOT` overrides that for scripts, and standing inside any vault project always
beats the registered default, so a second vault (a team's, in a work repo) needs no setup at all.

## Using it with an AI assistant

You talk to your assistant, the assistant runs the tools. It reads your "what's hot" file first,
searches the notes when it needs to, and helps you draft something grounded in your real history
instead of generic advice. You speak plain language, the tools do the rest.

---

The whole design is one trade: do the boring work in cheap, transparent code, spend the expensive and
forgetful AI only where understanding is unavoidable, and own every file at the end.
