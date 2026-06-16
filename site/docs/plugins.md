---
title: Plugins
description: A tiny core, plus add-ons you switch on by name and remove with one command.
---

The **core** is your notes plus `ingest`, `recall`, and `check`. Every other behavior is a **plugin** you add when you want it and remove with one command. The core never knows the plugins exist.

## The one rule

**The core never knows a plugin exists.** Plugins know about the core. The core knows nothing about them.

The test for the whole design:

> You can add or remove any plugin without editing a single line of core code.

If adding a plugin forces you to touch the core, the **plugin** is wrong. This is what keeps imprnt from slowly growing to know about every add-on, the thing that bloats this kind of system over time.

A plugin depends on two things: your `vault/` notes (and their header format) and its own folder. Not core internals, not another plugin, not another plugin's folder.

## Add and remove

Each plugin is its own package, `imprnt-plugin-<name>`. **Adding** one copies its files into `plugins/<name>/` and wires one import line into `CLAUDE.local.md`, your per-machine on-off file.

```sh
imprnt plugin list            # what is installed, and what you can add
imprnt plugin add anti-slop   # fetch, copy in, wire the import line
imprnt plugin rm anti-slop    # unwire it (--purge deletes the folder too)
```

A fresh clone with no `CLAUDE.local.md` loads zero plugins. Opt-in for real. You can hand-edit that file too. It stays the single source of truth for what is on.

## The gallery

One page each. Click through for what it does, how it works, and the commands.

- [Anti-slop](/plugins/anti-slop/) - rules that keep your assistant's prose from reading like AI.
- [Character](/plugins/character/) - a voice and standards your assistant works in. Scribe is the default you copy and make yours.
- [Whenful](/plugins/whenful/) - a local mirror of your [Whenful](https://whenful.com) tasks, shown inline when you read a note.
- [Timemachine](/plugins/timemachine/) - snapshots your work before each change, so you can recover what the agent breaks.
- [Statusline](/plugins/statusline/) - a status line: model, branch, context, cost, rate-limit windows, clock.
- [Telegram](/plugins/telegram/) - your vault from your phone. Text a bot, the answer comes from your notes.
- [Kleinanzeigen watcher](/plugins/kleinanzeigen/) - a marketplace inbox watcher. Code sorts hostile messages, the model drafts the rest, you press send.
- [Session host](/plugins/session-host/) - a warm browser that holds your logged-in sessions and hands out a fresh token over localhost.

## Three kinds of plugin

- **Data plugins** keep a local copy of an outside service and refresh it with a `sync` command you run. They **propose** summary notes into the vault, never write directly. Whenful and the kleinanzeigen watcher are these.
- **Behavior plugins** hand the assistant a fixed chunk of text you wire into its **prompt**. The vault never force-feeds the assistant. Remove is deleting the line. anti-slop and character are these. There is no referee for clashing behaviors, so you own how they combine.
- **Harness plugins** change the assistant's **runtime**: a hook that blocks dangerous commands, the status line. Same folder, same on-off switch. Plain `claude` stays plain. The changes exist only on sessions you start with `imp`.

## The contract

A few rules keep plugins composable and the core blind.

- **Reads the format, not the code.** A plugin opens your notes and reads the **headers** like any script would. The core keeps the note format stable and publishes no importable code for plugins to lean on.
- **One writer per file.** A plugin writes only inside its own folder. To change a note it hands you a suggested edit you approve through `ingest`. Exactly one thing ever writes your notes.
- **Search stays on your vault.** `recall` only ever looks at your real notes, never plugin folders, never `raw/`. To make something findable, a plugin **proposes** a real note you approve. That is the only way in.
- **Everything is a command you run.** Nothing runs in the background just by being installed. Want hourly sync? You schedule it.
- **Namespaced labels.** Any label a plugin adds to a note is prefixed with its name (`whenful.synced`), and it reads only its own. The core ignores labels it does not recognize.

## Project scope or global

By default a plugin loads for the **project** you install it in, and `imp` carries it into the sessions it launches. A universal behavior, like a house style, can instead load in every session, even a plain `claude` in an unrelated repo:

```sh
imprnt global add anti-slop   # wire it at user scope
imprnt global rm anti-slop
```

`global add` copies the plugin to a machine-local path and adds one import line inside a managed block in your user-level `CLAUDE.md`, so every session reads it. The core stays blind either way: it wires by convention, never by naming a plugin.

## How the core touches plugins at all

In two places only, both dumb and uniform, found by **filename**:

- `imprnt check --all` runs the core check, then runs each `plugins/*/check.js` and reads its exit code only, forwarding the plugin's own output. It never parses or interprets what a plugin says.
- `imprnt ingest --apply` files a ready-made note a plugin has staged in `plugins/*/proposed/`. The propose-then-approve path, made real.

Neither imports a plugin or names one. The **fence**: the core may provide read-only aggregation, never write or orchestration.
