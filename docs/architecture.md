# knowful — how it works (the plain version)

A personal knowledge base you own, designed to be used *by you and by an AI assistant* — without a database, without the cloud, and without paying an AI to do boring work.

This explains the whole thing in plain terms. If you read one section, read **"The core idea."**

---

## The problem

Your work generates a stream of context: 1:1s, meeting transcripts, decisions, who-owns-what, lessons learned the hard way. It piles up. Two things go wrong:

1. **You can't find anything.** Six months in, you *know* you discussed something, but you can't dig it out.
2. **Your AI assistant knows nothing.** Every chat starts cold. You re-explain your projects, your team, your history — every time.

knowful fixes both: dump things in, and later ask "what do I know about X?" — and get a real answer, including from an AI agent that can then help you act on it.

## The core idea

**The AI builds the tools; the tools do the work.**

An AI model is expensive, and it forgets everything between sessions. So you don't make it do mechanical work — parsing, filing, searching. You write small programs that do that for free, and you spend the AI only on the one thing that genuinely needs understanding.

It's the same reason you don't add up a spreadsheet by hand — you build the spreadsheet. The AI's job here is to *build and maintain the small programs*, and to do the ~20% that's real thinking. Everything else is plain code running for free.

## Where the data lives: plain text files

No database. No app lock-in. Just markdown (`.md`) text files in folders on your disk:

```
# entities — cross-cutting, one canonical home each, linked from everywhere
people/      a person
orgs/        an institution: employer, insurer, Behörde, bank, vendor
holdings/    an owned thing with tracked, changing state: a policy, a med + dose, an account, a subscription

# domains — your life-areas (you define these); most content lives here
identity/    the spine: mission, goals, beliefs, mental models, the positions you hold
health/  ·  finances/  ·  work/  ·  life/  ·  projects/

# forms — distinct by how you use them
events/      a dated occurrence (a 1:1, a meeting)
mistakes/    a lesson learned
```

Three kinds of folder, each a genuinely different reason to exist. **The folders are browse-drawers, not the search axis** — search is grep + BM25 and ignores them entirely. So you organize by *life-area* (the way you actually look for your own knowledge); entities get one cross-cutting home each because they're referenced from everywhere; and a note's `type:` field records *what it is* (a principle, a policy) even when it lives in a domain folder. The domain set is yours to define — these are one person's; a consultant's would be `clients/`, a researcher's `topics/`. Open them in any editor, or in Obsidian. They're yours forever — nothing to lock into, nothing that can disappear or send you a bill.

## What a note actually looks like

Every note is a markdown file with two parts. The top, fenced by `---` lines, is the **frontmatter**: structured fields a program can read. Everything below is the human body.

```markdown
---
type: person
updated: 2026-06-04
tags: [identity, bigquery]                 # only from the approved tag list (see below)
role: Director, Identity
team: Tech Foundations
aliases: [Carl Carter, B. Carter, Boris]   # every name this person has been called
status: active
---

# Boris Carter

Director of Identity; owns the access-platform project.

## Notes
- Owns the [[projects/access-platform]] migration  {extracted}
- Seen in [[events/2026-06-02-access-sync]]
```

- **Frontmatter** (the `---` block) is YAML — simple `key: value` lines. Every note has `type`, `tags`, and a one-line `summary` (the AI writes it once; a deterministic pass reads it to build `index.md`). The **H1 (`# Title`) is the title** (no `title:` key). A note in a domain folder also carries `domain:` so it's self-describing (and `knowful check` fails if folder and field disagree); `source:` is a clickable wikilink back to the immutable snapshot it came from; entity-valued fields are links too (`owner: "[[people/alex]]"`). Then fields specific to its type. **This is the part the tools read and query.**
- **The body** is for humans: a `#` title, `##` sections, prose, and `[[links]]` to other notes. `{extracted}` = taken straight from the source; `{inferred}` = the AI concluded it — so you can always tell facts from guesses.
- **The file's name is its permanent ID** (its "slug", e.g. `people/boris-carter.md`). Other notes link to that ID, never to the display name — which is what makes corrections cheap (see below).

## The one moving part: "ingest"

When you drop in a transcript, a single pass turns it into filed notes. Three steps, and notice which use the AI:

1. **Clean & file (plain code, no AI, instant).** Fix known typos, pull out who was there and the date, write the note into the right folder. Free.
2. **Enrich (the AI — the only paid step).** Write a short summary, and — the important part — **tag the note with the words you'll later search for, even if the transcript never used them.** A note about "the query scanned the whole table, 40× too much" gets tagged `cost`. The AI also notes who and what the meeting connects to.
3. **Resolve & check (plain code, no AI).** Using the tags the AI just wrote: is this person already on file under a nickname? Then *merge* — don't create a duplicate. Does the note connect to at least one person and one project? If not, flag it.

The clever bit: steps 1–3 share the same fields, so they're really one pass. Recognizing people, tagging for search, and checking links aren't three systems — they fall out of the same ingest.

## Updating and corrections

Say you ingest a new meeting and learn that a colleague you had on file as **Carl** is actually **Boris**, and he's a **Director**, not an Engineer. That sounds like it should force you to hunt down every note that mentions him. It doesn't — and that's the whole point of one-file-per-thing:

1. Ingest looks him up by his **aliases**, finds the existing note, and does **not** create a second one.
2. It updates that **one** note: fixes the name and role, and adds the old name `Carl` to the `aliases` list, so older references still resolve.
3. **Nothing else needs touching.** Every other note links to him by his permanent ID, not his name — so the moment you fix the one person-note, every meeting and project that points at him shows the corrected name and role automatically. **Correct once, everyone benefits.**

The one special case is a **contradiction** — a new meeting says the cutover date moved. Then ingest updates the project note and stamps the old line `> superseded by [[...]]`, so search can tell the current fact from the stale one. Old information is *marked*, never silently overwritten — and because the raw transcripts are kept untouched, you can always trace where any claim came from.

## Finding things

Plain text search (`grep`) over the files. Instant, free, and **you can see exactly why something matched** — no black box. The reason search actually works is step 2: the right search words were written into the note when it was created. So when you later search "cost," the partitioning note is already tagged for it.

If plain search ever falls short, you can add smarter ranking, or — as a last resort — AI-style meaning-based search. But you start with plain search, and it covers almost everything.

## Tags come from a fixed list (not whatever the AI feels like)

Free-form tags are where these systems quietly rot: one note gets `pipeline`, the next `ingestion`, the next `etl` — three words for one thing — and now a search for any one of them misses the other two. So tags are **not** free-form here. There's a small **approved list of tag values**, plus a **synonym map** that folds variants into the canonical one:

```
pipeline, ingestion, data-pipeline   →   etl
```

The ingest step may only apply tags from that approved list. If it wants a genuinely new tag, that's a deliberate one-line addition to the list — human-approved — not a drifting free-for-all. The payoff: **one concept = one tag, always.** Search stays reliable because there's exactly one word to look for, and it's already on every relevant note.

## Why it doesn't become a junk drawer

The usual death of a notes system: you have to *remember* to tag, link, and file things — and you don't — so it rots into a mess.

Here, the **program** files and links on the way in, so your discipline isn't required. And anything it *couldn't* resolve — a person it couldn't match, a note with no connections — shows up at the top of your **"what's hot right now"** file every time you open the system. A problem in your face gets fixed; a problem in a report nobody runs does not.

## Correction is the only learning (no self-grading)

The system does **not** grade itself or score whether retrieval "worked" — that would burn the AI on navel-gazing. The one learning loop: when you correct a match ("no, I meant the tax office, not beer ratings"), that correction deterministically appends a synonym to the approved tag list — for free. The map improves only when you fix something. No background analysis, no evals, ever.

## Built in pieces

The only thing that's always there is the **ingest** tool (plus search and a tidy-up check). Everything else — task sync, a file librarian, an anti-slop ruleset for your assistant, a connections viewer — is an **optional add-on** ("plugin") you install or delete with one command. Nothing is forced on you. It stays small, and anyone who forks it keeps only what they use.

The add-ons follow one rule that keeps the core from quietly bloating (the way these systems usually die): **the core never knows any add-on exists.** The test is simple — you can add or delete any add-on without editing a single line of core code. An add-on reads your notes like any script would, writes only inside its own folder (to change a note it *suggests* the change and you approve it), keeps its data out of search unless it proposes a real note you accept, and runs only when you run it — never as a hidden background process. An "always-on" add-on (like a behavior ruleset for your assistant) hands you a chunk of text *you* paste into your assistant's settings; deleting that line turns it off. The whole point: **the old system imposed its features on you; knowful lets you compose only the ones you want, with a real off-switch.** Full rules: `plugins/README.md`.

## Safety net: the originals are never touched

Your raw transcripts are kept untouched, forever. So if you ever want to change how notes are structured, you just **re-run ingest over the originals** and get the new layout for free. You're never trapped in an old format.

## Using it with an AI assistant

You talk to your AI assistant; the assistant runs the tools. It reads your "what's hot right now" file first, searches the notes when it needs to, and helps you draft a plan grounded in *your actual history* — not generic advice. You speak plain language; the tools do the rest.

---

## "Why not just use a database / Notion / a vector search thing?"

Fair question. Short version:

- **A database or SaaS (Notion, etc.)** locks your knowledge inside someone's product, and an AI agent can't cheaply read it — every query goes through an API and costs tokens. Here it's plain files the agent reads directly, for almost nothing.
- **Vector / "semantic" search** sounds smarter but it's expensive, it goes stale on every edit (you re-index constantly), and you can't see *why* it returned something. Plain text + search is free, transparent, and good enough once the notes are tagged well on the way in.
- **Plain text you own** can't be locked in, can't 404, can't bloat, and works with literally any tool — today's AI, tomorrow's, or just `grep` and your eyes.

The whole design is one trade: do the boring work in cheap, transparent code, spend the expensive, forgetful AI only where understanding is unavoidable — and own every file at the end.
