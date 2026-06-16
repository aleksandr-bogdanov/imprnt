---
title: Plugins
description: A tiny core, plus add-ons you switch on by name and remove with one command.
---

The **core** is your notes plus `ingest`, `recall`, and `check`. Every other behavior is a **plugin** you add when you want it and remove with one command. The core never knows a plugin exists.

## The one rule

You can add or remove **any** plugin without editing one line of core code. If a plugin forces a core edit, the plugin is wrong. That is what stops imprnt from growing to know about every add-on, the rot that bloats this kind of system over time. A plugin leans on two things only: your `vault/` notes (and their header format) and its own folder.

## Add and remove

Each plugin is its own package, `imprnt-plugin-<name>`. **Adding** one copies its files into `plugins/<name>/` and wires one import line into `CLAUDE.local.md`, your per-machine on-off file.

```sh
imprnt plugin list            # what is installed, and what you can add
imprnt plugin add anti-slop   # fetch, copy in, wire the import line
imprnt plugin rm anti-slop    # unwire it (--purge deletes the folder too)
```

A fresh clone with no `CLAUDE.local.md` loads zero plugins. Hand-edit that file any time. It is the single source of truth for what is on.

## The plugins

One page each, with the commands and how it works.

- [Anti-slop](/plugins/anti-slop/) - rules that keep your assistant's prose from reading like AI.
- [Character](/plugins/character/) - a voice and standards your assistant works in. Scribe is the default you copy and make yours.
- [Whenful](/plugins/whenful/) - a local mirror of your [Whenful](https://whenful.com) tasks, shown inline when you read a note.
- [Timemachine](/plugins/timemachine/) - snapshots your work before each change, so you can recover what the agent breaks.
- [Statusline](/plugins/statusline/) - model, branch, context, cost, rate-limit windows, clock.
- [Telegram](/plugins/telegram/) - your vault from your phone. Text a bot, the answer comes from your notes.
- [Kleinanzeigen watcher](/plugins/kleinanzeigen/) - code sorts hostile marketplace messages, the model drafts the rest, you press send.
- [Session host](/plugins/session-host/) - a warm browser that holds your logged-in sessions and hands out a fresh token over localhost.

## Architecture

Every plugin is one of three kinds:

- **Data** - mirrors an outside service locally, refreshed by a `sync` command you run. Proposes summary notes, never writes them. (Whenful, Kleinanzeigen)
- **Behavior** - feeds the assistant a fixed prompt fragment you wire in. (anti-slop, character)
- **Harness** - changes the session runtime, like a hook or the status line. Plain `claude` stays plain. The change applies only to sessions you start with `imp`. (timemachine, statusline)

Four rules keep them composable and the core blind:

- A plugin reads your note **headers**, never core code. The core exports nothing for a plugin to import.
- **One writer per note.** A plugin writes only its own folder. To change a note it proposes an edit you approve through `ingest`.
- `recall` searches `vault/` only. A plugin reaches search by proposing a real note you approve.
- Every action is a **command you run** or schedule. Nothing runs just by being installed. Any label a plugin adds is namespaced (`whenful.synced`) and read only by it.

**Scope.** A plugin loads for its **project** by default, and `imp` carries it into the sessions it launches. `imprnt global add <name>` wires a universal one, like a house style, into every session through your user `CLAUDE.md`.

**Where the core meets a plugin.** Two spots, both found by filename, never by import. `imprnt check --all` runs each `plugins/*/check.js` and reads its exit code. `imprnt ingest --apply` files the notes a plugin staged in `plugins/*/proposed/`.
