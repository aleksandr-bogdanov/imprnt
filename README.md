# imprnt

> The long-term memory your AI assistant is missing. Plain markdown, on your disk, yours forever.

[![CI](https://github.com/aleksandr-bogdanov/imprnt/actions/workflows/ci.yml/badge.svg?event=pull_request)](https://github.com/aleksandr-bogdanov/imprnt/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![node >= 18](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org)
[![npm](https://img.shields.io/npm/v/imprnt.svg)](https://www.npmjs.com/package/imprnt)

Your assistant starts every chat blank. You re-explain your projects, your people, and your
decisions every time, and whatever it learns dies with the session. imprnt fixes that. You talk,
your assistant files what matters into plain text files on your disk, and weeks later it answers
from your real history. You can read every note with your own eyes, and no company can switch
them off. Sibling to [Whenful](https://whenful.com): Whenful answers *when* do I do my tasks,
imprnt holds *what* I know.

<picture><source media="(prefers-color-scheme: dark)" srcset=".github/assets/recall-dark.svg"><img src=".github/assets/recall-light.svg" alt="imprnt recall: ranked results from a local BM25 search" width="830"></picture>

That is the whole read path. Term frequencies and a bit of arithmetic over a folder, with no model
in the loop.

## See it work

You do not learn commands. You talk, and your assistant keeps your knowledge for you.

```
You:    Here is my 1:1 with Boris from this morning. [paste or drop the transcript]
Claude: Filed it. Created people/boris-carter, updated projects/access-platform with the new
        cutover date, and logged the meeting under events/.

(weeks later)

You:    What did we decide about the access-platform cutover?
Claude: From your notes: the cutover moved to July 15, gated on the two-week parallel-run numbers.
        Boris owns it. The earlier June date is marked superseded.
```

Behind those two replies, Claude ran the imprnt engine: it filed the transcript into structured,
linked notes, then ranked your vault to answer the question. You saw a conversation. The work was
plain, cheap, local code.

## Why plain files win

<picture><source media="(prefers-color-scheme: dark)" srcset=".github/assets/lanes-dark.svg"><img src=".github/assets/lanes-light.svg" alt="The write path runs once per source and uses the model. The read path runs thousands of times and uses grep plus BM25." width="830"></picture>

A vector database or a hidden memory feature could hold your knowledge too. Plain files make your
assistant cheap, honest, and yours:

- **Reads cost almost nothing.** Your assistant finds a note by running a local ranked search
  (BM25) over a folder, about 100 tokens, on any machine that has the files, with no server
  running and no index to rebuild. A vector store pays an embedding pass every time a note
  changes and leaves your knowledge readable only by its own stack. Cheap, dependency-free
  reads mean your assistant can lean on your whole history, every session.
- **The model works once, where it counts.** Reading a messy transcript and deciding what it means
  is worth the model, and it happens once per source. Searching happens thousands of times, so it
  stays plain local code. Frequency draws the line.
- **The data survives in full.** Tables stay tables. Numbers, dates, IDs, and exact wording are
  kept verbatim, with a summary added on top, so your assistant answers from facts, not a
  paraphrase.
- **Corrections cost one edit.** Notes link by permanent ID. Fix a person's note once and every
  meeting, project, and decision that mentions them is right.
- **Yours, in the strongest sense.** Plain text on your disk. It opens in any editor, graphs in
  [Obsidian](https://obsidian.md), and cannot 404, bloat, or hold your context hostage.

## The numbers, including the one we lose

LoCoMo is the benchmark this category is rated on, 1,540 questions about conversations that ran
for months. On the same answering model Letta published with, imprnt scores 58.6 against their
74.0. We lose that comparison by about fifteen points, and the confidence intervals do not
overlap.

Running it turned up something worth more than the score. Take one fixed set of imprnt's answers,
change only the LLM judge, and the result moves 9 points: 68.4 with Claude grading, 77.6 with
gpt-4.1. That single swap is wider than the entire published spread in the category (mem0 68.44,
Letta 74.0, Zep 75.14). A LoCoMo number without a named judge is close to meaningless, ours
included.

On the paper's own scorer, token F1 across all five categories, imprnt gets 64.2%. The human
baseline on the same questions is 87.9%, and the paper's own GPT-4-turbo baseline is 32.1%.

imprnt also ships a retrieval eval over the two example vaults: the right note comes back first
for 89.7% of questions and appears in the top five for 97.4%, across 39 hand-written questions.
Small corpus, and we wrote the questions, so run it yourself with `bun run eval`.

Every run, interval, and reproduction step is written up in
[`docs/benchmark-2026-08.md`](docs/benchmark-2026-08.md). The tool-by-tool read lives at
[imprnt.dev/comparison](https://imprnt.dev/comparison/).

Prior art, by name: Letta/MemGPT, mem0, and Zep run memory as a service with their own store and
their own retrieval. Khoj indexes your files with embeddings. Obsidian gives you the plain-file
vault without an agent contract on top. PAI wires an assistant into a fixed personal structure.
imprnt keeps both halves: plain markdown you own, and an agent contract that files into it and reads it back with grep and BM25.

## Known limits

BM25 is lexical. It ranks on the words a note actually contains, so imprnt bridges vocabulary at
ingest: the model assigns tags, proposes aliases, and records synonyms once per note, and every
later search rides on that one pass. Embeddings pay that cost per query instead. The bridge has
holes. Ask "what do I do for work" when the note says "freelance designer" and nothing connects
the two, and you can miss. The vault is single-user by design. That is the trade for a read path
that is free, local, and identical every time you run it.

## The robot does the work. You stay the boss.

The current crop of AI tools wants the wheel. Resident agents (OpenClaw and friends) read your
inbox and act on your behalf. Auto-schedulers rearrange your calendar while you sleep. imprnt
takes the other side, the same side its sibling [Whenful](https://whenful.com) takes against
auto-planners like Motion. The rule, in full:

> The model never takes an action you didn't approve.

In practice: plain code does every read, so it's cheap, auditable, and immune to prompt injection
hiding in your data. The model writes and drafts where judgment pays. And anything that touches
the world - filing a note, sending a reply - ends with you pressing the button. A watcher built
on imprnt can triage a hostile inbox all day for free. The send button stays human.

## Start in two minutes

```sh
npm i -g imprnt        # install the engine your assistant drives
imprnt init            # scaffold your vault, drop CLAUDE.md (the contract your assistant reads)
imp                    # open your assistant and talk
```

`imprnt init` scaffolds the vault, writes the `CLAUDE.md` contract that teaches your assistant
how it works, and registers the folder so `imp` finds it from anywhere. Runs on
[Node](https://nodejs.org) 18 or newer, driving [Claude Code](https://claude.com/claude-code) as
the assistant.

`imp` is the front door, and you can type it instead of `claude` in any directory:

- **`imp`** opens Claude where you stand. Your enabled plugins ride along, and your vault is
  within reach, so a coding session can answer "who owns the downstream consumers?" from your
  own notes. Typing `imp` instead of `claude` is the whole opt-in: stock `claude` stays stock,
  and nothing is ever injected into sessions you didn't ask it into.
- **`imp lair`** opens Claude inside the vault project, your assistant's home. The full contract
  loads there, and your personal conversations accumulate in one resumable place.

Want the vault folder somewhere other than `./vault`? Set `export IMPRNT_VAULT=~/notes/vault` in
your shell profile and both the engine and imp follow it.

The first thing to ask your assistant: "file a person note for me." You appear in nearly every
transcript, so a self-note lets it link you to everything from then on.

## What your assistant runs

These are the engine's jobs. You trigger them by asking, in plain language. Claude picks the
right one.

| You say something like | Claude runs | What happens |
|------------------------|-------------|--------------|
| "Save this transcript / note / doc." | ingest | Snapshots the source untouched, files structured notes into your vault. |
| "What do I know about X?" / "What did we decide on Y?" | recall | Ranks your notes locally (BM25) and answers from the top hits. |
| "Tidy up / what needs my attention?" | check, hot | Rebuilds the index, syncs tags, surfaces anything that needs review. |

The engine itself uses no AI for any of this. The model sits only at the two ends: turning your
ask into a search at the front, reading the results at the back. Everything in between is free
local code.

## Plugins: new behavior with one ask

Core is your vault plus the file, recall, and tidy jobs. Everything else is a behavior you add by
asking ("add the anti-slop plugin"), each a separate `imprnt-plugin-*` package:

| Package | What it gives your assistant |
|---------|------------------------------|
| `imprnt-plugin-anti-slop` | Rules that keep its prose from reading like AI. |
| `imprnt-plugin-character` | A voice and standards to write in. "Scribe" is the default you copy and personalize. |
| `imprnt-plugin-statusline` | A customizable status line: model, branch, context, cost, rate limits, clock. |
| `imprnt-plugin-timemachine` | Snapshots your work before each change so you can recover what the agent breaks. |

Adding one copies it into your project and wires it into `CLAUDE.local.md`, the per-machine file
your assistant loads each session. A fresh setup loads zero plugins until you add them. The full
contract is in [`plugins/README.md`](plugins/README.md).

## Vault vs assistant memory

Your assistant ships its own memory feature, a private scratchpad it writes for itself. That is a
different thing from the vault, and treating them as one defeats the point.

| | imprnt **vault** | assistant **memory** |
|---|---|---|
| Holds | your knowledge: finances, health, people, projects | the agent's working notes about helping you |
| Lives | plain files on your disk, the version of record | inside the assistant, opaque to you |
| You can | read it, edit it, trace each note to its source | barely see it |

Anything durable and about your life goes in the vault, where it is yours and you can read it.
Keep the assistant's private memory thin.

## Examples

Two worked vaults live in [`examples/`](examples/), each showing the same flow of talking to an
assistant that files and recalls for you:

- **[`digital-assistant/`](examples/digital-assistant/)** is a personal vault for one person:
  identity, health, finances, people, daily life.
- **[`organization/`](examples/organization/)** is a small company's vault: employees, a customer,
  a project with a ranked backlog, a decision, and a postmortem.

## Docs

The docs are the website, [imprnt.dev](https://imprnt.dev), built straight from markdown in
[`site/docs/`](site/docs/) (the single source): getting started, how it works, the model, plugins,
design decisions, and contributing. Edit a file there and the site updates on the next
deploy.

- [`CLAUDE.md`](CLAUDE.md), the contract your assistant reads inside the vault: note formats, conventions.
- [`plugins/README.md`](plugins/README.md), the plugin contract.

## Hacking on imprnt

The engine is built with [Bun](https://bun.sh) and [Turborepo](https://turborepo.com) (dev tools
only, never needed by people who use it through their assistant). Clone, `bun install`,
`bun run build`, `bun run test`. The reasoning behind the design and the build-and-release model are in the
[design decisions](https://imprnt.dev/design-decisions/) and [contributing](https://imprnt.dev/contributing/) docs.

## License

MIT (c) 2026 Aleksandr Bogdanov

---

<img src=".github/mark.svg" height="15" alt=""> built by [bogdanov.wtf](https://bogdanov.wtf)
