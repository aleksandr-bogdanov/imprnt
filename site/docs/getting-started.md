---
title: Getting started
description: Install imprnt, make a vault, and start talking to it.
---

> **In one line.** imprnt is a folder of plain notes on your computer. You talk to your AI, it writes the notes, and later it answers from them. Nothing it learns gets lost when the chat closes.

You talk to your assistant in plain language. It files what matters into markdown notes on your disk. Later it answers from your real history.

You never type these commands in normal use. Your assistant runs them for you. They are here so you can see what is happening, and drive it yourself when you want.

## What you need

- [Node](https://nodejs.org) 18 or newer.
- [Claude Code](https://claude.com/claude-code), the assistant imprnt drives.

## Install it

Two commands. The first installs the engine. The second makes your vault.

```sh
npm i -g imprnt
imprnt init
```

`imprnt init` does three things:

1. Makes the vault folder (`./vault` by default).
2. Writes a `CLAUDE.md` file that teaches your assistant how the vault works.
3. Registers the folder so the `imp` command can find it from anywhere.

Want the vault somewhere else? Point one variable at it and everything follows.

```sh
export IMPRNT_VAULT=~/notes/vault
```

## Open it with `imp`

`imp` opens your assistant with imprnt wired in. Type it instead of `claude`, in any folder.

```sh
imp
```

- `imp` opens Claude where you stand, with your plugins and your vault in reach. A coding session can answer "who owns this service?" from your own notes. Plain `claude` stays plain, so nothing is added to a session you did not ask for.
- `imp lair` opens Claude inside the vault itself, its home. The full contract loads there, and your personal chats pile up in one place you can resume.

> **First thing to ask it.** "File a person note for me." You show up in almost every transcript, so a note about you lets the assistant link you to everything else from then on.

## The three things it does

You talk. Behind your words, the engine runs one of three commands.

### File something: `ingest`

A source is anything: a meeting transcript, a pasted doc, a prose dump, a single fact. Hand it over.

```
You: Save this transcript and file what matters.
     [paste or drop the source]
```

What happens:

1. The original is copied untouched into `raw/`, so it is always traceable.
2. The model reads it, decides where each note goes, writes a one-line summary, pulls out decisions and actions, tags it, and links the people and projects it mentions.
3. The notes are filed, and one line lands in `log.md`.

A dense source splits into several linked notes from one copy. Tables, numbers, dates, and exact wording are kept in full. The summary is added on top, never instead of the data.

### Find something: `recall`

Ask in plain words.

```
You: What did we decide about the access-platform cutover?
```

The engine ranks your notes with BM25, a plain local formula with no model and no embeddings, and hands the best ones to the assistant to read and answer. It searches your real notes only. The `raw/` archive is never searched, so nothing leaks from a snapshot into an answer.

### Tidy up: `check`

After filing or hand-editing, ask for a tidy pass.

```
You: Tidy up. What needs my attention?
```

It rebuilds the index, learns any new tags, and flags notes that link nothing or have a broken link. It only ever touches the control files, never your notes.

## Add a plugin

The core is your vault plus those three commands. Everything else is an opt-in plugin, and a fresh setup has none.

```sh
imprnt plugin list            # what is installed, and what you can add
imprnt plugin add anti-slop   # fetch it, copy it in, switch it on
imprnt plugin rm anti-slop    # switch it off (--purge deletes the folder too)
```

Or just ask: "add the anti-slop plugin." The full gallery is in [Plugins](/plugins/).
