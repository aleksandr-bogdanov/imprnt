---
title: Plugins
description: A tiny core plus opt-in plugins you add by name and remove with one command.
---

The core is your notes plus three commands: `ingest`, `recall`, and `check`. Every other behavior is a plugin you add when you want it and remove with one command.

## The one rule

**The core never knows a plugin exists.** Plugins know about the core. The core knows nothing about them.

The litmus for the whole contract:

> You can add or remove any plugin without editing a single line of core code.

If adding a plugin forces you to touch the core, the plugin is wrong, not the core. This is the rule that keeps imprnt from slowly growing to know about every plugin, which is what bloats this kind of system over time.

A plugin depends on exactly two things: your `vault/` notes (and their frontmatter format) and its own sibling folder. Not core internals, not another plugin, not another plugin's folder.

## Add and remove

Each plugin is its own package, `imprnt-plugin-<name>`. Installing one copies its files into your project's `plugins/<name>/` and wires one import line into `CLAUDE.local.md`, your per-machine toggle file.

```sh
imprnt plugin list            # installed plugins and official ones available to add
imprnt plugin add anti-slop   # fetch, copy in, wire the import line
imprnt plugin rm anti-slop    # unwire it (add --purge to delete the folder too)
```

A fresh clone with no `CLAUDE.local.md` loads zero plugins. Opt-in for real. You can also hand-edit that file, it stays the single source of truth for what is on.

## The gallery

| Plugin | What it adds |
|--------|--------------|
| `anti-slop` | Rules that keep your assistant's prose from reading like AI. |
| `character` | A voice and standards to write in. Scribe is the default you copy and make yours. |
| `whenful` | A live mirror of your [Whenful](https://whenful.com) tasks, shown inline when you read a note. |
| `guard` | A hook that blocks dangerous shell commands before they run. |
| `statusline` | A status line: model, branch, context, cost, rate-limit windows, clock. |
| `telegram` | Your vault from your phone. Text a bot, the answer comes from your notes. |
| `kleinanzeigen` | A marketplace inbox watcher. Code sorts hostile messages, the model drafts the residue, you press send. |
| `session-host` | A warm browser that holds your logged-in sessions and brokers a fresh token over localhost. |

## The contract

A handful of rules keep plugins composable and the core blind.

- **Reads the format, not the code.** A plugin opens your notes and reads the frontmatter like any script would. The core guarantees the note format stays stable and publishes no importable code as a contract.
- **Single writer per path.** A plugin writes only inside its own folder. To change a note it hands you a suggested edit you approve through `ingest`. Exactly one thing ever writes your notes.
- **Search stays on your vault.** `recall` only ever looks at your real notes, never plugin folders, never `raw/`. For something findable, a plugin proposes a real note you approve. That is the only path in.
- **Everything is a command you run.** Nothing runs in the background by being installed. Want hourly sync? You schedule it.
- **Slug-namespaced labels.** Any label a plugin adds to a note is prefixed with its name (`whenful.synced`), and it reads only its own. The core ignores labels it does not recognize.

## Project scope or global

By default a plugin loads for the project you install it in, and `imp` carries it into the sessions it launches. A universal behavior (a house style, an anti-slop ruleset) can instead load in every session, even a plain `claude` in an unrelated repo:

```sh
imprnt global add anti-slop   # wire it at user scope
imprnt global rm anti-slop
```

`global add` copies the plugin to a machine-local path and adds one import line inside a managed block in your user-level `CLAUDE.md`, so every session reads it. The core stays blind either way: it wires by convention, never by naming a plugin, so the litmus holds at global scope too.

## Three classes of plugin

- **Data plugins** keep a local mirror of an outside service and refresh it with a `sync` command you run. They propose summary notes into the vault, never write directly. Whenful and the kleinanzeigen watcher are examples.
- **Behavior plugins** hand the assistant a fixed chunk of text you wire into its prompt. The vault never force-feeds the assistant. Remove is deleting the line. anti-slop and character are examples. There is no referee for conflicting behaviors, you own composition.
- **Harness plugins** customize the assistant's runtime: a hook that blocks dangerous commands, the status line. Same folder, same on-off switch. Stock `claude` stays stock, the flags exist only on sessions you start with `imp`.

## How the core touches plugins

In exactly two places, both dumb and uniform, discovered by filename convention:

- `imprnt check --all` runs the core check, then runs each `plugins/*/check.js` and reads its exit code only, forwarding the plugin's own output. It never parses or interprets what a plugin says.
- `imprnt ingest --apply` files a pre-enriched note a plugin has staged in `plugins/*/proposed/`. The propose-then-approve path, made concrete.

Neither imports a plugin or names one. The fence: the core may provide read-only aggregation, never write or orchestration.
