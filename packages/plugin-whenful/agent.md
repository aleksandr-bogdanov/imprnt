# Plugin: Whenful (tasks)

> This is the **agent fragment** — the plugin's entry point. The core code never reads it; you (the
> assistant) do. Install = add `@plugins/whenful/agent.md` as an import to the project `CLAUDE.md`.
> Remove = delete that import line and `rm -rf plugins/whenful`.

## What this plugin is

Whenful is the user's task scheduler (whenful.com). This plugin lets an imprnt note show the **live
status of the tasks attached to it** without putting task management into the vault. Tasks stay in
Whenful; the vault stays knowledge. The bridge is a join table plus a local mirror of task state.

## Where its data lives

- `plugins/whenful/links.tsv` — the **join table**. One row per task↔note link:
  `task_id<TAB>note_slug<TAB>step_label?` (the third column is optional). This is the only place the
  plugin records which tasks belong to which notes. It never writes into the notes themselves.
- `plugins/whenful/mirror/<task_id>.md` — the **local mirror** (cache) of each linked task's state,
  one file per task. Refreshed only by `sync`. **Render task status at read time off these files —
  never call the Whenful server to display status.** The server is touched only by `sync`.
- `plugins/whenful/proposed/` — staging for any note the plugin proposes into the vault (you approve
  it via `imprnt ingest --apply`). Used sparingly — only to graduate a *summary*, never one note per
  task.

## Commands (you run these; nothing runs on its own)

- `node plugins/whenful/whenful.js sync` — the **only command that crosses the wire**. It refreshes the
  `mirror/<id>.md` files from Whenful. The user schedules it (cron/launchd) or runs it by hand. It is
  never a daemon. *(Today this is a documented stub — it makes no live call yet. Live wiring is the
  next session.)*
- `node plugins/whenful/check.js` — the plugin's own integrity check (mirror staleness + orphan links).
  The core finds it via `imprnt check --all`.

## How to surface a note's tasks

When the user opens or asks about a vault note and wants its tasks:

1. Read `plugins/whenful/links.tsv`, select the rows whose `note_slug` matches this note's slug.
2. For each matched `task_id`, read `plugins/whenful/mirror/<task_id>.md` and show its live status
   (title, state, due, the optional step label from the join table).
3. If the mirror is stale (the plugin's `check` will say so) or a task's mirror file is missing, tell
   the user to run `node plugins/whenful/whenful.js sync` — do **not** reach for the server yourself.

## Rules (always-on while this fragment is installed)

- **Render-at-read off the mirror, never the server.** Only `sync` talks to Whenful.
- **Never write task state into vault notes.** The link lives in `links.tsv`; the state lives in the
  mirror. To put something durable in the vault, propose a summary note into `proposed/` and let the
  user `imprnt ingest --apply` it.
- **Slug-namespace any label** you ever add to a note (`whenful.*`) — but prefer the join table over
  labels-in-notes; v1 keeps the link out of the note body entirely.
