# Timemachine - local snapshot safety net

> An opt-in safety plugin, built for skip-permissions sessions. Before any mutating tool (Edit,
> Write, Bash, ...) runs, a PreToolUse hook snapshots the git working tree to a side ref, so
> anything the agent deletes or overwrites that git could not otherwise recover - an untracked file,
> an uncommitted change - can be brought back. It never blocks a tool, and it never captures
> anything `.gitignore` hides. Deterministic, no LLM.

## What it captures, and what it never touches

- **Captures:** tracked changes plus untracked-but-not-ignored files - exactly what `git add -A`
  would, and nothing more.
- **Never captures:** anything in `.gitignore` (your `.env`, keys, build output), plus obvious
  secret shapes (`.env`, `*.pem`, `*.key`, `*credentials*`) even if they were not ignored.
- **Never leaves the machine:** snapshots are git refs under `refs/timemachine/`, which git does not push.
- **Never blocks:** the hook always allows the tool. It is a safety net, not a gate.

## Recovery (you run these)

```sh
node plugins/timemachine/timemachine.js list                 # snapshots here, newest first
node plugins/timemachine/timemachine.js restore <id> <path>  # bring a file back from a snapshot
node plugins/timemachine/timemachine.js show <id>            # what a snapshot holds
node plugins/timemachine/timemachine.js status               # count, where they live, last time
node plugins/timemachine/timemachine.js wipe                 # delete every snapshot in this repo
```

If the user says the agent deleted or clobbered something, run `list`, find a recent snapshot, and
`restore` the path. Suggest committing once the file is back.

## Rules (always-on while installed)

- It only protects files inside a git repo. It pairs with keeping work in git.
- It is local damage-recovery, not security and not backup. It does nothing for npm supply-chain or
  anything outside the repo.
- If a real secret is not gitignored, the fix is to gitignore it. Do not rely on the skip-list alone.
