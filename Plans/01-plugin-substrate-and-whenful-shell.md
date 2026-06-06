# Implementation plan — plugin substrate + Whenful plugin shell

> Transient build spec (lives in `Plans/`, not `docs/` — docs/ is evergreen). Built 2026-06-06 from the decided module-access contract. The contract itself is evergreen in `plugins/README.md` + `docs/architecture.md`.
> **Scope tonight:** the substrate every plugin needs + the Whenful plugin SHELL. **NOT** live Whenful sync (gated on the Whenful API surface — next session).

## The decided contract (what we're implementing)

One rule: **the core *code* never knows a plugin exists.** Litmus: add/remove any plugin with **zero edits to `scripts/`**. A plugin depends only on (a) `vault/` notes + their frontmatter *format* and (b) its own sibling folder. The *agent* (not core code) is the integrator — it learns about a plugin from a fragment the user wires in.

Two surfaces: the **vault** (single-writer: only `ingest`/user writes notes; plugins propose) and the **agent context** (where plugin fragments wire in — the off-switch).

Resolved decisions feeding this build:
- **Read** vault directly; **never write** it (propose instead).
- **Copy, share no core code** — plugins vendor the ~12-line frontmatter reader; `scripts/lib` is private, not a published contract.
- **Render-at-read off a local mirror** — the agent reads the plugin's local cache, never the server; only `sync` crosses the wire, batched + user-scheduled.
- **No physical labels-in-notes in v1** (agent-first browsing → render from the join table; revisit only if Obsidian-without-agent becomes a habit).
- **No daemon** — commands only.

## Work items

### 1. Rename `modules/` → `plugins/`
- `git mv modules plugins` (keeps `guard/`).
- Update every reference: `scripts/cli.ts` (help text line ~82 "modules/"), project `CLAUDE.md` (Modules section + "modules/README.md" pointers), `docs/architecture.md` ("modules/README.md"), any other grep hits for `modules/`.
- Grep `rg -n "modules/" --type ts --type md` after, confirm only intended/historical references remain (dated docs in `docs/` describing history may keep "modules" in prose — use judgment; code + live contract must say `plugins/`).

### 2. `plugins/README.md` — the contract (evergreen, co-located with code)
Replace the current `plugins/README.md` (the old module README, already updated to the contract) with the FINAL contract reflecting all locks. Keep the existing structure (the 8 rules + two decisions + 3 instances + out-of-scope) and ADD:
- **The entry point = the agent fragment.** Each plugin ships `plugins/<name>/agent.md` — a fixed-size fragment telling the AGENT: what the plugin is, where its data/mirror/join-table lives, its commands, any always-on rules. Install = add one `@plugins/<name>/agent.md` import line to the project `CLAUDE.md` (or paste it). Remove = delete that line + `rm -rf plugins/<name>`. The core *code* never reads agent.md; the *agent* does.
- **Core ↔ plugin contact = exactly two convention-based aggregators**, both dumb/uniform/zero per-plugin logic: `check --all` (globs `plugins/*/check.ts`) and `ingest --apply` (files staged notes from `plugins/*/proposed/`). Both discover by filename/dir convention, never by import.
- **The MCP boundary** (article-grade, keep it): no protocol between agent and vault; a network client (REST, or MCP if the service offers it) is allowed ONLY at a plugin's remote-sync edge, batched, results cached locally. "MCP is a way to query; a plugin is a way to not have to query."

### 3. Core: `imprint check --all`
- Extend `scripts/check.ts` (or `cli.ts`) so `imprint check --all` runs the existing core check, THEN globs `plugins/*/check.ts`, spawns each as a Bun subprocess (`bun <path>`), **reads exit code only** (0 = sound, non-zero = issue), and **forwards each plugin's stdout verbatim**. Aggregate: overall exit non-zero if any plugin failed. Never parse plugin output.
- Fence (document inline): core may provide read-only AGGREGATION helpers, never write/orchestration helpers.
- `imprint check` (no `--all`) keeps current behavior (core only).

### 4. Core: `imprint ingest --apply`
- Add to `scripts/ingest.ts` (+ `cli.ts` dispatch): `imprint ingest --apply <file>` and `imprint ingest --apply-all`.
- `--apply <file>` takes a **pre-enriched** staged note (real frontmatter: `type`, `domain`/folder, `summary`, `tags`, body). It:
  1. Snapshots the staged note into `raw/` for provenance (reuse existing snapshot+hash+manifest path).
  2. Files it into `vault/` at the folder implied by its `type`/`domain` (entity → people/orgs/holdings; domain note → its domain folder; form → events/mistakes).
  3. Runs the existing resolve step (participants/links → needs-review on miss).
  4. On success, deletes the staged copy from `plugins/*/proposed/`.
  5. **Idempotent:** if the target note already exists with identical content hash, no-op; if it exists with different content, fall through to the existing contradiction discipline (do NOT silently overwrite).
- `--apply-all` globs `plugins/*/proposed/*.md` and applies each (convention-based discovery, uniform handling — no per-plugin logic).
- Reuse `lib/manifest.ts`, `lib/resolve.ts`, `lib/moc.ts` as the existing ingest does.

### 5. Whenful plugin SHELL (`plugins/whenful/`)
Proves the whole contract end-to-end **without live API**. Files:
- `plugins/whenful/agent.md` — the fragment. States: task↔note links live in `links.tsv`; the task mirror (local cache) is in `mirror/<id>.md`; **render-at-read off the mirror, never the server**; sync via `bun plugins/whenful/whenful.ts sync` (user-scheduled, the only wire-crosser); how the agent should surface a note's tasks (read links.tsv for this note's slug → read mirror files → show live status).
- `plugins/whenful/links.tsv` — the join table. Header comment + format: `task_id<TAB>note_slug<TAB>step_label?`. Starts empty (just the format doc).
- `plugins/whenful/whenful.ts` — commands: `sync` = **STUB** that documents the Whenful API contract it WILL call (auth, list-tasks-since-timestamp endpoint, the `updated_at` client-server model from the Whenful repo) and writes/refreshes `mirror/<id>.md` files; clearly marked `// TODO(next session): wire the real Whenful API — see docs link`. Must NOT make live network calls tonight. `check` = the plugin's own integrity: mirror staleness (last-sync timestamp), orphan links in links.tsv (a note_slug that doesn't exist in vault), exit non-zero with a human-readable stdout message if anything's off.
- `plugins/whenful/check.ts` — either the `check` subcommand above or a thin file the aggregator finds; pick one and be consistent with how `check --all` globs (`plugins/*/check.ts` → so a standalone `check.ts` is simplest).
- `plugins/whenful/mirror/.gitkeep` and `plugins/whenful/proposed/.gitkeep` — the cache + staged-note dirs.
- A short `plugins/whenful/README.md` with `## Install` (add the `@plugins/whenful/agent.md` line) and `## Remove` (`rm -rf` + delete the line), per the lifecycle rule.

## Verification (Forge must run these and report evidence)
- `bun scripts/cli.ts check --all` against the repo's vault → core check runs + whenful/check.ts runs, exit code aggregated, whenful's stdout shown. Capture output.
- Create a throwaway pre-enriched staged note in `plugins/whenful/proposed/`, run `bun scripts/cli.ts ingest --apply <that file>` → confirm it lands in the right vault folder, gets a raw/ snapshot, staged copy deleted; run again → confirm idempotent no-op. Capture output. (Clean up the throwaway after.)
- `rg -n "modules/" scripts/ plugins/ CLAUDE.md docs/architecture.md` → confirm no stale `modules/` refs in code/live-contract.
- `bun scripts/cli.ts check` (no --all) still works unchanged.
- Confirm litmus by inspection: nothing in `scripts/` names "whenful" or any specific plugin (only the `plugins/*` glob convention).

## Out of scope tonight (do NOT build)
Live Whenful API sync · physical label-stamping into notes · documents plugin · behavior plugin · any registry/manifest · any daemon/scheduler · the typed-patch label mechanism. These are later sessions or rejected-for-v1.
