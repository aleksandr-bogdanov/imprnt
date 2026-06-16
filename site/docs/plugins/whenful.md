---
title: Whenful
description: A local mirror of your Whenful tasks, shown inline on the notes they belong to.
---

> **In one line.** It shows the current status of your [Whenful](https://whenful.com) tasks right on the vault notes they relate to, read from a local mirror you refresh, without putting task management into the vault.

## What it's for

Your tasks live in Whenful. Your knowledge lives in the vault. This plugin links the two so that when you open a note, the assistant can show the tasks attached to it: their title, state, and due date. Tasks stay in Whenful. The vault stays knowledge.

## How it works

This is a data plugin. The bridge is two pieces in `plugins/whenful/`:

- `links.tsv`, a join table with one row per task-to-note link (`task_id`, `note_slug`, an optional step label). This is the only place the link is recorded. It never writes into your notes.
- `mirror/<task_id>.md`, a local cache of each linked task's state, one file per task.

When you ask about a note's tasks, the assistant reads the matching rows from `links.tsv`, then reads each task's mirror file and shows its status. It reads from the cache, never the server. Only `sync` crosses the network.

To put something durable in the vault, the plugin proposes a summary note into `proposed/`, which you approve with `imprnt ingest --apply`. It is used sparingly, a summary, never one note per task.

## Commands

```sh
# the only command that touches the network: refresh the mirror from Whenful
WHENFUL_TOKEN=<your-device-token> imprnt whenful sync

# run offline against fixtures, zero network
WHENFUL_FIXTURES=<dir> imprnt whenful sync

# the plugin's own integrity check (mirror staleness, orphan links)
node plugins/whenful/check.js
```

`sync` calls the real Whenful API and rewrites each linked task's mirror file. You schedule it yourself (cron or launchd) if you want it periodic. Nothing runs on its own. The core finds the check via `imprnt check --all`.

## Install

```sh
imprnt plugin add whenful
```

Then add your task-to-note rows to `plugins/whenful/links.tsv` and run a sync. Remove with `imprnt plugin rm whenful`.
