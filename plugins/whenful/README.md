# whenful — task mirror plugin

Surfaces the live status of your Whenful tasks on the imprint notes they belong to, without putting
task management into the vault. Tasks stay in Whenful; the vault stays knowledge. The bridge is a join
table (`links.tsv`) plus a local mirror (`mirror/`) of task state, refreshed only when you run `sync`.

> **Status:** shell only. `sync` is a documented **stub** — it makes no live Whenful call yet. Wiring
> the real API is the next session. Everything else (the join table, the mirror, render-at-read, the
> integrity check, the `check --all` and `ingest --apply` contact points) works today.

## Layout

- `agent.md` — the entry-point fragment the assistant reads (what the plugin is, where its data lives,
  its commands, its always-on rules). The core code never reads this; only the agent does.
- `links.tsv` — the join table: `task_id<TAB>note_slug<TAB>step_label?`, one row per task↔note link.
- `mirror/<task_id>.md` — the local cache of each linked task's state. Render status at read off these;
  never call the server to display. Safe to delete and rebuild from a full sync.
- `proposed/` — staging for notes the plugin proposes into the vault (you approve via
  `imprint ingest --apply`). Used sparingly — a summary, never one note per task.
- `whenful.ts` — `sync` (the only wire-crosser) and `check` (delegates to `check.ts`).
- `check.ts` — the plugin's own integrity check; `imprint check --all` finds and runs it.

## Install

1. Wire the entry-point fragment in:
   ```sh
   imprint plugin add whenful
   ```
   That wires `@plugins/whenful/agent.md` into `CLAUDE.local.md` (gitignored, per-machine - Claude Code
   auto-loads it right after the committed `CLAUDE.md`). Or hand-edit `CLAUDE.local.md` and add the line
   yourself. Never wire it into the committed `CLAUDE.md`, that keeps personal wiring out of the shipped
   contract.
2. Add task->note rows to `plugins/whenful/links.tsv`.
3. Refresh the mirror: `bun plugins/whenful/whenful.ts sync` *(stub today)*.

That's the whole on-switch. Schedule `sync` yourself (cron/launchd) if you want it periodic. There is
no daemon.

## Remove

```sh
imprint plugin rm whenful
```

Or delete the import line by hand. To drop the files entirely, `rm -rf plugins/whenful`. Nothing in the
core (`scripts/`) references this plugin, so removing it touches no core code.
