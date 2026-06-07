# imprint-plugin-guard

A deterministic blocklist for dangerous shell commands. No LLM, no analysis - a short regex list
that catches the obvious foot-guns (force-push to main/master, `rm -rf` of a home or system path,
and similar) and exits non-zero so a hook can stop the command.

## Install

```sh
imprint plugin add guard
```

This copies the built `guard.js` and `agent.md` into your project's `plugins/guard/`.

## Use

```sh
node plugins/guard/guard.js "git push --force origin main"   # exits 2, prints the reason
echo "ls -la" | node plugins/guard/guard.js                   # exits 0, prints ok
```

Guard does its real job as a **PreToolUse hook on Bash**, configured in `settings.json` (the harness
runs the hook). Point the hook at `node plugins/guard/guard.js` and let its exit code gate the
command. That wiring is a conscious one-time settings change you make yourself.

## Limits

It is a regex blocklist, not a shell parser. A command whose quoted argument merely mentions a
dangerous pattern can false-positive. Guard errs toward blocking, which is the right default for a
safety hook.
