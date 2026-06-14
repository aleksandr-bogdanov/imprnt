---
title: Getting started
description: Install imprnt, scaffold a vault, and start talking to it.
---

imprnt is a knowledge vault you own and run locally. You talk to your assistant in plain language, it files what matters into markdown notes on your disk, and later it answers from your real history.

You never run the CLI by hand in normal use. Your assistant runs it for you when you ask. The commands below are here so you understand what is happening and can drive it directly when you want to.

## Requirements

- [Node](https://nodejs.org) 18 or newer.
- [Claude Code](https://claude.com/claude-code) as the assistant imprnt drives.

## Install and init

Install the engine, then scaffold a vault.

```sh
npm i -g imprnt
imprnt init
```

`imprnt init` does three things:

1. Scaffolds the vault folder (`./vault` by default) with its control files.
2. Writes the `CLAUDE.md` contract that teaches your assistant how the vault works.
3. Registers the folder so the `imp` front door finds it from anywhere.

Want the vault somewhere else? Set the path in your shell profile and both the engine and `imp` follow it.

```sh
export IMPRNT_VAULT=~/notes/vault
```

## The imp front door

`imp` is how you open your assistant with imprnt wired in. Type it instead of `claude` in any directory.

```sh
imp
```

- `imp` opens Claude where you stand, with your enabled plugins along for the ride and your vault within reach. A coding session can answer "who owns the downstream consumers?" from your own notes. Stock `claude` stays stock, so nothing is injected into sessions you did not ask it into.
- `imp lair` opens Claude inside the vault project, your assistant's home. The full contract loads there, and your personal conversations accumulate in one resumable place.

The first thing to ask: "file a person note for me." You appear in nearly every transcript, so a self-note lets the assistant link you to everything from then on.

## Ingest a source

A source is anything: a meeting transcript, a pasted document, a prose dump, or a single fact. You hand it over and ask the assistant to file it.

```
You: Save this transcript and file what matters.
     [paste or drop the source]
```

Behind that, the engine runs `ingest`:

1. Snapshots the source untouched into `raw/<source>/`, so the original is always traceable.
2. The model reads it, picks the note type, writes a one-line summary, pulls out decisions and actions, assigns tags, and wires links to people, orgs, and projects.
3. The note is filed into the right folder, and one line is appended to `log.md`.

A dense source that covers many things splits into several linked notes from one snapshot. Tables, numbers, IDs, dates, and exact wording are kept verbatim. The summary is added on top, never instead of the data.

## Recall what you know

Ask in plain language. The engine runs `recall`, which ranks your notes with BM25 (a local term-frequency formula, no model, no embeddings) and hands the top hits back to the assistant to read and answer.

```
You: What did we decide about the access-platform cutover?
```

`recall` searches your real notes (`vault/`) only. The `raw/` archive is never searched, so nothing leaks from a snapshot into your answers.

## Tidy up and review

After an ingest or a hand-edit, run a tidy pass.

```
You: Tidy up. What needs my attention?
```

The engine runs `check`, which rebuilds the index from each note's summary, syncs new tags into the vocabulary, and surfaces anything that links nothing or has a broken link. It writes only the control files and never touches a note.

## Install a plugin

The core is your vault plus `ingest`, `recall`, and `check`. Every other behavior is an opt-in plugin. A fresh setup loads zero plugins.

```sh
imprnt plugin list            # installed plugins (on/off) and official ones available to add
imprnt plugin add anti-slop   # fetch the package, copy it in, wire it into CLAUDE.local.md
imprnt plugin rm anti-slop    # unwire it (add --purge to delete the copied folder too)
```

You can also ask your assistant: "add the anti-slop plugin." See [Plugins](/plugins/) for the full gallery and the contract behind it.
