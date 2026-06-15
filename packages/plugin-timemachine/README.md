# imprnt-plugin-timemachine

An opt-in local snapshot safety net. Before any mutating tool runs, timemachine snapshots your git
working tree to a side ref, so the agent can never lose work git cannot otherwise bring back: an
untracked file, an uncommitted change. It is built for sessions you run with
`--dangerously-skip-permissions`, where there is no prompt between the agent and your files.

It never blocks a tool, it never captures anything `.gitignore` hides, and it never leaves your
machine. Recovery is plain git.

## What it captures

- Tracked changes plus untracked-but-not-ignored files. Exactly what `git add -A` would stage, and
  nothing more.
- **Not** anything in `.gitignore` (your `.env`, keys, build output), and **not** obvious secret
  shapes (`.env`, `*.pem`, `*.key`, `*.p12`, `*credentials*`) even if you forgot to ignore them. A
  properly ignored secret is structurally impossible to capture.
- Snapshots are commits under `refs/timemachine/`, on no branch, never pushed. They stay in your repo's
  `.git`, local only. It keeps the most recent 200 and prunes the rest.

## Install

Installing this is a conscious decision: it watches every mutating tool and writes snapshots into
your repo. Nothing happens until you opt in.

```sh
imprnt plugin add timemachine
```

This copies the plugin into `plugins/timemachine/` and wires it. Timemachine is a **native Claude Code
plugin**: its `hooks/hooks.json` registers `timemachine.js --hook` as a PreToolUse hook on the mutating
tools, and `imp` passes the folder to every session it launches via `--plugin-dir`. Nothing is ever
written into your Claude settings.

Not using `imp`? Load it with `claude --plugin-dir plugins/timemachine`, or point a PreToolUse hook in
your own `settings.json` at `node plugins/timemachine/timemachine.js --hook`.

## Recover

```sh
node plugins/timemachine/timemachine.js list                 # snapshots here, newest first
node plugins/timemachine/timemachine.js restore <id> <path>  # bring a file back into the working tree
node plugins/timemachine/timemachine.js show <id>            # what a snapshot holds (git show --stat)
node plugins/timemachine/timemachine.js status               # count, location, last snapshot time
node plugins/timemachine/timemachine.js wipe                 # delete every timemachine snapshot in this repo
```

## Remove

```sh
imprnt plugin rm timemachine
```

Or delete the import line by hand. Add `--purge` to also delete `plugins/timemachine/`. The hook lives
inside the plugin folder, so removal undoes the wiring. Existing snapshots stay in `.git` until you
`wipe` them.

## Limits

It protects files inside a git repo only, so it pairs with keeping your work in git. It is damage
recovery, not security and not an off-machine backup: it does nothing for npm supply-chain risk or
anything outside the repo. And it is a snapshot of the pre-tool state, not prevention - the agent
still does the thing, you just get to undo it.
