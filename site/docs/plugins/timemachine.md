---
title: Timemachine
description: Snapshots your working tree before each change, so you can recover what the agent breaks.
---

Before the agent runs any tool that changes files, it **snapshots** your working tree to a hidden git ref, so you can bring back anything it deletes or overwrites. Run a session with `--dangerously-skip-permissions` and there is no prompt between the agent and your files. If it deletes an untracked file or overwrites uncommitted work, plain git cannot bring it back. Timemachine takes a snapshot first, so you can.

## How it works

A **harness** plugin. It registers a **PreToolUse** hook that fires before any mutating tool (Edit, Write, Bash, and the rest). The hook snapshots your tree to a commit under `refs/timemachine/`, on no branch, then lets the tool run. It never blocks. A safety net, not a gate.

It captures exactly what `git add -A` would stage: tracked changes plus untracked-but-not-ignored files. It never captures anything `.gitignore` hides (your `.env`, keys, build output), and it skips obvious secret shapes (`.env`, `*.pem`, `*.key`, `*.p12`, `*credentials*`) even if you forgot to ignore them. Snapshots stay in your repo's `.git`, local only, never pushed. It keeps the most recent 200 and prunes the rest.

## Commands

```sh
node plugins/timemachine/timemachine.js list                 # snapshots, newest first
node plugins/timemachine/timemachine.js restore <id> <path>  # bring a file back into the working tree
node plugins/timemachine/timemachine.js show <id>            # what a snapshot holds
node plugins/timemachine/timemachine.js status               # count, location, last snapshot time
node plugins/timemachine/timemachine.js wipe                 # delete every snapshot in this repo
```

If the agent clobbered something, run `list`, find a recent snapshot, and `restore` the path. **Commit** once the file is back.

## Install

```sh
imprnt plugin add timemachine
```

This copies the plugin into `plugins/timemachine/` and wires it as a native Claude Code plugin. `imp` passes the folder to every session it launches, so the hook is active without touching your Claude settings. Remove with `imprnt plugin rm timemachine` (add `--purge` to delete the folder too). Existing snapshots stay in `.git` until you `wipe` them.

## Limits

It protects files inside a git repo only, so it pairs with keeping your work in git. It is **damage recovery**, not security and not an off-machine backup. It snapshots the pre-tool state, so the agent still does the thing. You just get to undo it.
