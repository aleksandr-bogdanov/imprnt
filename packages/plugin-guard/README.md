# imprnt-plugin-guard

A deterministic blocklist for dangerous shell commands. No LLM, no analysis - a short regex list
that catches the obvious foot-guns (force-push to main/master, `rm -rf` of a home or system path,
and similar) and blocks the command before it runs.

## Install

```sh
imprnt plugin add guard
```

This copies the plugin into your project's `plugins/guard/` and wires it. Guard is a **native
Claude Code plugin** (a harness plugin): its `hooks/hooks.json` registers `guard.js --hook` as a
PreToolUse hook on Bash, and `imp` passes the folder to every session it launches via
`--plugin-dir`. Nothing is ever written into your Claude settings.

Not using `imp`? Load it yourself with `claude --plugin-dir plugins/guard`, or point a PreToolUse
hook in your own `settings.json` at `node plugins/guard/guard.js --hook`.

## Use

Wired in, it just works: a blocked command exits 2 and the reason goes back to the agent. To check
a command by hand:

```sh
node plugins/guard/guard.js "git push --force origin main"   # exits 2, prints the reason
echo "ls -la" | node plugins/guard/guard.js                   # exits 0, prints ok
```

`--hook` is the hook entry point: it reads the PreToolUse JSON payload on stdin and judges only the
command string inside it.

## Remove

```sh
imprnt plugin rm guard
```

Or delete the import line by hand. Add `--purge` to also delete `plugins/guard/`. The hook lives
inside the plugin folder, so removal undoes everything - there is no settings entry to clean up.

## Limits

It is a regex blocklist, not a shell parser. A command whose quoted argument merely mentions a
dangerous pattern can false-positive. Guard errs toward blocking, which is the right default for a
safety hook.
