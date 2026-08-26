# memrot

A read-only checkup for markdown agent memory.

Your agent remembers things by writing markdown files — an OpenClaw workspace, a nanobot
workspace, a pile of notes in a vault. Nothing ever checks those files. Links go dead when
files get renamed. The same fact gets saved three times and the copies drift. A "renew by
March" line sits there in August still reading as pending. Two files quietly disagree about
your timezone. That's rot, and it compounds: the agent reads this stuff back as truth.

`memrot` points at the folder and reports what's rotten in it.

```
npx memrot ~/.openclaw/workspace
```

No install, no config. It needs Node (which you have — your agent runs on it), touches
nothing, sends nothing anywhere, and doesn't need the agent's runtime — it reads the files
on disk.

## What it checks

- **broken links** — wikilinks and relative markdown links whose target doesn't exist,
  plus links that only match by letter-case (they break the day the folder lands on a
  case-sensitive disk), with a "moved?" suggestion when a same-named file exists elsewhere
- **duplicated content** — near-duplicate files (the same record saved twice, drifting
  apart) and identical long lines copied across many files
- **stale dates** — due/renew/expire/review lines whose date has passed but still read as
  pending; "yesterday" / "next week" written into durable memory where it means nothing;
  `observed:` markers that are months old but still say `active`
- **facts that disagree** — the same key with different values across your durable files,
  and always/never-style directives that overlap but point in opposite directions
- **file hygiene** — unresolved git merge-conflict markers, unclosed frontmatter, empty
  files, template placeholders never filled in, filename case collisions, stray terminal
  escape codes
- **unreferenced files** — notes nothing links to and no runtime convention loads: only
  findable by search, or not at all
- **context bloat** (OpenClaw-style layouts) — how many tokens the always-loaded file set
  costs you at the start of every single session

Findings come in three buckets: **broken now**, **worth a look**, and **FYI**. Every line
is `file:line` plus a plain-language reason. `--json` if you'd rather feed it to something.

## It knows what a store is — and refuses to guess

Pointed at a code repository, memrot refuses rather than reporting on source and docs as
if they were memory (`--force` overrides). Pointed at a repo that *contains* a store
(a `vault/`, a workspace), it finds the store and scans that. And it knows the difference
between rot and history: a dead link on a dated log line is a historical reference, prose
about a past date is a record, a whole namespace of links pointing beside the scanned
folder is architecture — each of those is one calm FYI line, not a wall of alarms.
Calibrated on real, months-old stores until a healthy one produces a near-empty report.

## What it deliberately is not

- It never writes, moves, or deletes anything. It's a report, not a repair.
- No network, no embeddings, no index, no LLM. Pure local file reads and arithmetic.
- No semantic judgment: it flags that two lines *disagree*, not which one is true.
- Precision over recall: a phrasing like "must be booked until \<date\>" is deliberately
  not matched, because the keywords loose enough to catch it drown real findings in noise.

## Usage

```
memrot [dir] [--json] [--force] [--stale-days N]
```

`dir` defaults to `~/.openclaw/workspace` when it exists, else the current directory.
Exit code is 1 when something is broken now, 0 otherwise, so it slots into a cron or a CI
job on the private repo your workspace is (hopefully) backed up in.

memrot is part of [imprnt](https://github.com/aleksandr-bogdanov/imprnt); when memory
follows a contract, these heuristics become checkable invariants — that's `imprnt check`.
