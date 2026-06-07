# Guard - dangerous-command blocklist

> A deterministic safety plugin. It checks a shell command against a small regex blocklist and
> exits non-zero on an obvious foot-gun (force-push to main, `rm -rf` of a home/system path, and
> similar). No LLM, no analysis - just a short list of "don't do the obviously dumb thing".

## What it is

`guard.js` is a standalone checker, not an agent behavior. It reads a command (as an argument or on
stdin), prints `ok` and exits 0 when the command is fine, or prints `BLOCKED (<reason>)` and exits 2
when it matches the blocklist. It errs toward blocking, which is the right default for a safety hook.

## How to run it

```sh
node plugins/guard/guard.js "git push --force origin main"   # exits 2, prints the reason
echo "ls -la" | node plugins/guard/guard.js                   # exits 0, prints ok
```

## Wiring it as a real guard

Guard does its job as a **PreToolUse hook on Bash**, configured in `settings.json` (the harness runs
the hook, not the agent). Point the hook at `node plugins/guard/guard.js` and let its exit code gate
the command. That wiring is a conscious, one-time settings change you make yourself. Installing this
plugin only copies the checker into your project and records it. It does not auto-wire the hook.
