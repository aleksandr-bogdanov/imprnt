# imprnt

> "You can think of the model as the brain, the harness as the body, and the tools it uses working in
> a runtime."
> - Jensen Huang, NVIDIA (GTC Taipei keynote, June 2026)

imprnt is the long-term memory your AI assistant uses. You talk to Claude in plain language, and Claude
uses imprnt to file what you tell it and recall what you need later. The knowledge lives as plain
markdown files on your disk that you own. There is a command-line engine underneath, but you do not run
it by hand. Claude runs it for you. imprnt is the tool layer Huang is pointing at, holding the part
that lasts.

It is the memory your assistant is missing: one that survives the session, that you can read with your
own eyes, that no company can switch off.

> Sibling to [Whenful](https://whenful.com): Whenful answers *when* do I do my tasks, imprnt holds
> *what* I know.

## What it feels like to use

You do not learn commands. You talk to your assistant, and it keeps your knowledge for you.

```
You:    Here is my 1:1 with Boris from this morning. [paste or drop the transcript]
Claude: Filed it. Created people/boris-carter, updated projects/access-platform with the new
        cutover date, and logged the meeting under events/.

(weeks later)

You:    What did we decide about the access-platform cutover?
Claude: From your notes: the cutover moved to July 15, gated on the two-week parallel-run numbers.
        Boris owns it. The earlier June date is marked superseded.
```

Behind those two replies, Claude ran the imprnt engine: it filed the transcript into structured notes,
then ranked your vault to answer the question. You saw a conversation. The work was plain, cheap, local
code.

## Why plain files (the idea in one minute)

Your assistant could keep your knowledge in a vector database or a hidden memory feature. imprnt keeps
it as plain files instead, for a practical reason: it makes your assistant cheap, honest, and yours.

- **Your assistant reads the files directly.** To find something it runs a local search over a folder,
  about 100 tokens. The same lookup through a vector database or an MCP server costs orders of magnitude
  more and goes stale every time a note changes. Plain files keep the read path almost free, so your
  assistant can lean on your whole history.
- **The model is spent only where it is irreplaceable.** Reading a messy transcript and deciding what
  it means is worth the model, and it happens once per source. Searching happens thousands of times, so
  it stays plain local code. Frequency draws the line.
- **The note keeps the real data.** Tables stay tables. Numbers, dates, IDs, and exact wording are
  preserved in full, with a summary added on top, so Claude answers from facts, not a paraphrase.
- **You own it.** Plain text on your disk. It cannot 404, cannot bloat, cannot hold your context
  hostage, and it opens in [Obsidian](https://obsidian.md) for a human graph view of the same folder.

## Setup (once)

You install the engine so your assistant has the tool, point your vault at a folder, and then you just
talk. Runs on [Node](https://nodejs.org) version 18 or newer.

```sh
npm i -g imprnt        # install the engine Claude will drive
imprnt init            # scaffold your vault and drop CLAUDE.md, the contract Claude reads
```

`imprnt init` writes a `CLAUDE.md` into the project. That file teaches your assistant how your vault
works (the note formats and conventions), and Claude loads it automatically whenever it works in that
folder. From then on you talk to Claude and it does the rest.

Point your vault at a folder elsewhere if you like:

```sh
export IMPRNT_VAULT=~/notes/vault   # defaults to ./vault
```

The first thing to ask your assistant: "file a person note for me." You appear in nearly every
transcript, so a self-note lets it link you to everything from then on.

## What your assistant does for you

These are the engine's jobs. You trigger them by asking, in plain language. Claude picks the right one.

| You say something like | Claude runs | What happens |
|------------------------|-------------|--------------|
| "Save this transcript / note / doc." | ingest | Snapshots the source untouched, files structured notes into your vault. |
| "What do I know about X?" / "What did we decide on Y?" | recall | Ranks your notes locally (BM25) and answers from the top hits. |
| "Tidy up / what needs my attention?" | check, hot | Rebuilds the index, syncs tags, surfaces anything that needs review. |

The engine itself uses no AI for any of this. The model sits only at the two ends: turning your ask
into a search at the front, reading the results at the back. Everything in between is free local code.

## Plugins (give your assistant new behavior)

Core is your vault plus the file, recall, and tidy jobs. Everything else is a behavior you add to your
assistant with one ask ("add the anti-slop plugin"), each a separate `imprnt-plugin-*` package:

| Package | What it gives your assistant |
|---------|------------------------------|
| `imprnt-plugin-character` | A voice and standards to write in. "Scribe" is the default you copy and personalize. |
| `imprnt-plugin-anti-slop` | Rules that keep its prose from reading like AI. |
| `imprnt-plugin-whenful` | A local mirror of your [Whenful](https://whenful.com) tasks, shown inline at read. |
| `imprnt-plugin-guard` | A deterministic blocklist for dangerous shell commands. |

Adding one copies it into your project and wires it into `CLAUDE.local.md`, the per-machine file your
assistant loads each session. A fresh setup loads zero plugins until you add them. The contract is in
[`plugins/README.md`](plugins/README.md).

## Memory vs. vault, the one thing newcomers conflate

Your assistant has its own **memory** feature, a private scratchpad it writes to itself. That is a
different thing from the imprnt vault, and treating them as one defeats the point.

| | imprnt **vault** | assistant **memory** |
|---|---|---|
| Holds | your knowledge: finances, health, people, projects | the agent's working notes about helping you |
| Lives | plain files on your disk, the version of record | inside the assistant, opaque to you |
| You can | read it, edit it, trace each note to its source | barely see it |

Anything durable and about your life goes in the vault, where it is yours and you can read it. Keep the
assistant's private memory thin.

## Examples

Two worked vaults live in [`examples/`](examples/), each showing the same flow of talking to an
assistant that files and recalls for you:

- **[`digital-assistant/`](examples/digital-assistant/)** is a personal vault for one person: identity,
  health, finances, people, daily life.
- **[`organization/`](examples/organization/)** is a small company's vault: employees, a customer, a
  project with a ranked backlog, a decision, and a postmortem.

## Docs

- [`docs/architecture.md`](docs/architecture.md), how the whole thing works, in plain English. Start here.
- [`docs/design-decisions.md`](docs/design-decisions.md), the durable calls and why they were made.
- [`docs/releasing.md`](docs/releasing.md), how a change becomes a published package.
- [`CLAUDE.md`](CLAUDE.md), the contract your assistant reads inside the vault: note formats, conventions.

## Hacking on imprnt

The engine is built with [Bun](https://bun.sh) and [Turborepo](https://turborepo.com) (dev tools only,
never needed by people who use it through their assistant). Clone, `bun install`, `bun run build`,
`bun run test`. The architecture and the contributor map are in
[`docs/architecture.md`](docs/architecture.md).

## License

MIT (c) 2026 Aleksandr Bogdanov
