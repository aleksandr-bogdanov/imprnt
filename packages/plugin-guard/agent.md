# Guard - dangerous-command blocklist

> A deterministic safety plugin. Every Bash command the agent runs is checked by a PreToolUse hook
> against a small regex blocklist, and an obvious foot-gun (force-push to main, `rm -rf` of a
> home/system path, and similar) is blocked before it executes. No LLM, no analysis - just a short
> list of "don't do the obviously dumb thing".

## How it runs

This plugin is a native Claude Code plugin: its `hooks/hooks.json` wires `guard.js --hook` as a
PreToolUse hook on Bash, and `imp` loads it into every session via `--plugin-dir` while it is
enabled. A blocked command exits 2 and the reason comes back to the agent. There is nothing to
configure and nothing for the agent to do - when a command is blocked, take the reason at face
value and find a safer way.

## Checking a command by hand

```sh
node plugins/guard/guard.js "git push --force origin main"   # exits 2, prints the reason
echo "ls -la" | node plugins/guard/guard.js                   # exits 0, prints ok
```
