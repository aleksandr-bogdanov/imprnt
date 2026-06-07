# imprint

A deterministic-first, plain-markdown knowledge vault you own. The LLM builds the tools,
the tools do the work. Code does the bulk transform at near-zero token cost. The LLM is
spent only on the irreducibly-semantic part: read unstructured prose, decide what each note
is, write the summary, pull the decisions, wire the links. Retrieval is local BM25 over plain
files. No MCP, no vector DB, no embeddings over the vault. Open the same folder in Obsidian
for a human graph view.

> Sibling to [Whenful](https://whenful.com): Whenful answers *when* do I do my tasks, imprint
> holds *what* I know.

## What it is

A folder of markdown on your disk that both you and an AI assistant read directly. The
assistant never queries a database through a protocol. It greps the files. Grep over the vault
costs about 100 tokens. An MCP or vector layer over the same files costs orders of magnitude
more and goes stale on every edit. So the storage is commodity and the discipline is the
product:

- **Deterministic-first means ration the LLM by where it runs.** A step that runs once per
  item (understand, classify, summarize) earns the LLM. A step that runs thousands of times
  (search) stays pure local code. Frequency draws the line, not a blanket "avoid the LLM."
- **The data is the knowledge.** A note carries the source's structured payload in full:
  tables as tables, IDs, numbers, dates, verbatim clause text. `recall` searches `vault/`
  only, so anything left in `raw/` is invisible. The summary is in addition to the data,
  never instead of it.
- **Opt-in and composable.** Tiny core, three commands. Everything else is a self-contained
  plugin directory you `rm -rf` with zero cross-dependencies. You add the plugins you need.
- **Owned.** Plain files on your disk. They cannot 404, cannot bloat, cannot hold your
  context hostage.

## The core loop

```sh
# 1. ingest - snapshot a source into raw/ (immutable), file structured notes into vault/
imprint ingest raw/transcripts/2026-06-02-sts2-1on1.txt

# 2. recall - BM25 ranking over title/tags/body (deterministic, local, no LLM)
imprint recall "STS2 BigQuery"

# 3. check - integrity + regenerate index.md, sync the tag vocabulary, flag what needs review
imprint check
```

The LLM sits at the two ends of `recall` and nowhere in the middle: it shapes your question
into keywords at the front, reads the top hits at the back. `recall` ranks with BM25 (term
frequency times inverse document frequency, with title and tag field boosts), pure local
arithmetic with zero deps.

## Install

Requires [Bun](https://bun.sh) >= 1.3.

The package distributes via npm. These commands are aspirational until the first publish lands:

```sh
bunx imprint init      # run without installing
npm i -g imprint       # or install the global CLI
```

Until then, run from a clone:

```sh
git clone https://github.com/aleksandr-bogdanov/imprint.git
cd imprint
bun install                  # no runtime deps, this just links the CLI
bun scripts/cli.ts init      # scaffold ./vault and ./raw from templates/
```

The commands below use `imprint` for brevity. From a clone that is `bun scripts/cli.ts`.

## Setup

```sh
imprint init                                       # scaffold vault/ and raw/ from templates/
export IMPRINT_VAULT=~/notes/vault                 # optional: point at a vault elsewhere (defaults to ./vault)
imprint plugin add character/scribe.md anti-slop   # enable the default assistant + anti-slop rules
```

`imprint plugin add` wires each plugin into `CLAUDE.local.md`, your gitignored per-machine
toggle file, so the agent loads them every session. A fresh clone has no `CLAUDE.local.md` and
loads zero plugins by default.

**One-time onboarding: create your own `people/<you>.md`.** You appear in nearly every
transcript, so add a self-note first. Otherwise every ingest flags you into `needs-review`. Ask
the agent to "file a person note for me" once, and entity resolution links you from then on.

## Plugin gallery

Core is the vault plus `ingest`, `recall`, `check`. Everything past that is a plugin you drop
in or delete. The shipped gallery:

| Plugin | What it does | Class |
|--------|--------------|-------|
| `character/` | The assistant's voice and standards. `scribe.md` is the generalized default you copy and personalize. | behavior |
| `anti-slop/` | Banned punctuation, words, phrases, and rhetorical patterns that keep prose from reading like AI. | behavior |
| `whenful/` | A local mirror of your [Whenful](https://whenful.com) tasks, rendered at read. Live sync deferred. | data |
| `guard/` | A deterministic blocklist for dangerous shell commands. Wire it as a PreToolUse hook. | safety |

The one rule the contract holds to: the core never knows a plugin exists. You can add or
remove any plugin with zero edits to `scripts/`. Full contract and the worked instances are in
[`plugins/README.md`](plugins/README.md).

## Commands

| Command | What it does | LLM? |
|---------|--------------|------|
| `imprint init` | Scaffold `vault/` and `raw/` from `templates/` | no |
| `imprint snapshot <src> --dest <relpath>` | Mirror a file or dir into `raw/<relpath>`, immutable and hashed | no |
| `imprint ingest <file> [--vault DIR]` | Snapshot a source into `raw/`, write the deterministic note skeleton | no |
| `imprint recall "<query>" [--vault DIR]` | BM25 ranking over title/tags/body, synonym-aware | no |
| `imprint check [--all] [--vault DIR]` | Integrity, regenerate `index.md`, sync tags; `--all` also runs each `plugins/*/check.ts` | no |
| `imprint hot [--vault DIR]` | Print needs-review and the session primer | no |
| `imprint plugin list \| add \| rm` | Toggle gallery plugins in `CLAUDE.local.md` | no |

## Docs

- [`docs/architecture.md`](docs/architecture.md) - how the whole thing works, in plain English. Start here.
- [`docs/design-decisions.md`](docs/design-decisions.md) - the durable calls and why they were made.
- [`docs/shipping.md`](docs/shipping.md) - the distribution model and the personal-vs-generic split.
- [`CLAUDE.md`](CLAUDE.md) - the vault contract: note formats, frontmatter, conventions. An agent auto-loads it inside the vault.

A minimal worked example lives in [`examples/sts2-demo/`](examples/sts2-demo/): a synthetic
1:1 transcript, the notes ingested from it, and a plan drafted from a `recall`. It is a small
demo of the loop, pending a fuller rebuild.

## License

MIT (c) 2026 Aleksandr Bogdanov
