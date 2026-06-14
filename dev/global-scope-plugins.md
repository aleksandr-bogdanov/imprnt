# Global-scope modules

Some modules are universal. An anti-slop ruleset or a house style should shape the agent in *every*
session in every directory, not just an imp session or the vault project. This is the design for
loading a module at user scope, and the mechanism that ships for behavior modules today.

## The problem with the old hack

Before this, going global meant hand-editing `~/.claude/CLAUDE.md` to add a line like:

```
@~/IdeaProjects/imprnt/packages/plugin-anti-slop/agent.md
```

Three things are wrong with it:

1. It hardcodes an absolute path into a specific dev checkout. Move or rename the repo and it breaks.
2. It is unmanaged. There is no `add`/`rm`, no idempotence, no record of what imprnt put there versus
   what you wrote yourself. Removing it cleanly is a careful manual edit.
3. It only covers a behavior fragment. A universal *hook* (a global guard) cannot be wired through a
   `CLAUDE.md` import at all - hooks live in `settings.json`.

## Why scope is an install-location property, not a new kind of module

A module does not change because it is global. The `agent.md` fragment is the same; only *where it is
wired* differs. This keeps global scope consistent with the plugin/capability model:

- **Project scope** (today's `imprnt plugin add`): the fragment is wired into the project's
  `CLAUDE.local.md` and loads for that project. Outside the project, `imp` inlines it into the
  sessions it launches.
- **User scope** (`imprnt global add`): the fragment is wired into Claude Code's user-level config,
  which every session reads, so it loads even for a plain `claude` in an unrelated repo.

The core stays blind either way: it globs and wires by convention, never importing or naming a
specific module. The litmus holds - you add or remove a global module with zero core edits.

## The mechanism (behavior modules) - shipped

`imprnt global add <name> [--from <dir>]`:

1. Copies the module's shipped files to a stable, machine-local path: `<config>/imprnt/<name>/`, where
   `<config>` is `$CLAUDE_CONFIG_DIR` or `~/.claude`. This is a copy, not a pointer into a dev
   checkout - the same reversibility rule the project plugin install uses. A bare name with no
   `--from` promotes an already-installed project plugin (`plugins/<name>/`) to global scope.
2. Adds a relative import line, `@imprnt/<name>/agent.md`, inside a fenced managed block in
   `<config>/CLAUDE.md`:

   ```
   <!-- imprnt:global BEGIN (managed by imprnt - edit with `imprnt global add/rm`) -->
   @imprnt/anti-slop/agent.md
   <!-- imprnt:global END -->
   ```

   Claude Code resolves the relative import against the directory holding `CLAUDE.md`, so it points at
   the copy from step 1. The fence is HTML comments, invisible when the file renders and never part of
   the instructions the model reads.

`imprnt global rm <name> [--purge]` removes the import line (and the whole block when it was the last
one, leaving no orphan markers); `--purge` also deletes the copied dir. `imprnt global list` shows
what is wired and what is copied-but-not-wired.

The invariant that makes this safe to run against a file you hand-edit: **imprnt only ever touches the
text between its two markers.** Everything outside the fence is yours and is preserved (only the blank
line at the block boundary is normalized to a single blank line, and the file's CRLF/LF ending is
kept). And if it ever finds hand-written lines *inside* the managed block (someone pasted notes between
the markers), it refuses and asks you to resolve them by hand rather than overwrite them. Both are
verified by tests: user content survives an add/remove round-trip, a CRLF file stays CRLF, two
paragraphs that bracketed the block stay two paragraphs, and a block with foreign content is never
clobbered.

### Why `~/.claude/CLAUDE.md` specifically

Claude Code loads `~/.claude/CLAUDE.md` in every session regardless of `CLAUDE_CONFIG_DIR` (that
variable relocates skills and hooks, but the user-level `CLAUDE.md` still loads from `~/.claude`). That
is exactly the property a global behavior module needs: one file every session reads. The lib takes the
config dir as an explicit argument so the whole mechanism is testable against a throwaway directory and
never touches the real `~/.claude` in a test.

## The harness path (global hooks) - the next step

A behavior module wires through `CLAUDE.md`. A *harness* module like guard needs its `PreToolUse` hook
to fire in every session, and hooks live in `settings.json`, not `CLAUDE.md`. The design, consistent
with the block approach:

- `imprnt global add guard` copies `guard/` to `<config>/imprnt/guard/` as above, then merges a
  **managed hook entry** into `<config>/settings.json` under `hooks.PreToolUse`, pointing at the copied
  `guard.js`. The entry carries a marker field (for example `"_imprnt": "guard"`) so removal can find
  and strip exactly imprnt's entry without disturbing the user's own hooks.
- `settings.json` is JSON, not free text, so the managed region is "every array element tagged with the
  marker" rather than a comment fence. The merge is the same shape as `lib/launch.ts` already uses for
  per-session settings, reused against the global file.
- `imprnt global rm guard --purge` removes the tagged entry and the copied dir.

This is deferred, not built, because it needs guard's exact hook shape pinned and a careful JSON merge
that round-trips a hand-edited `settings.json`. The behavior path covers the stated anti-slop case in
full today; the hook path is a known, bounded extension that reuses the settings-merge code already in
the tree.

## What stays out

No global daemon, no auto-start, nothing resident - a global module is still just a fragment (or a
hook) that loads when a session starts, removable with one command. No registry of global modules in
core: `global list` reads the managed block and the copy dir directly, the same convention-discovery
the rest of the contract uses.
