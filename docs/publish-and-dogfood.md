# Publish imprnt and reinstall it as a real user

A runbook for shipping the monorepo to npm, then removing the local dev setup and installing from npm
the way any user would. Follow it by hand, or paste it into a fresh Claude Code session as the task.

The point is honesty: prove the published packages install and run on Node alone, with the personal
cast (your private character + voice) restored from local files that never go to npm.

As of June 2026 the package is unpublished from npm, so Part 3's `npm i -g imprnt` 404s until Part 1
runs again.

## What ships

- `imprnt` - the core CLI (package `packages/imprnt`). Runs on Node, no Bun needed by the user.
- `imprnt-plugin-anti-slop`, `imprnt-plugin-character`, `imprnt-plugin-guard`,
  `imprnt-plugin-whenful` - the gallery (each under `packages/plugin-*`).

Bun is a dev/build tool only. The user side is Node + npm + tar (npm and tar ship with Node and the OS).

## Part 1 - publish (needs your npm account)

```sh
# from the repo root
npm whoami                      # confirm you are logged in (else: npm login)
bun install && bun test         # all green
bun run build                   # core + plugins build clean

# names must be free on the registry - check first
npm view imprnt version 2>/dev/null || echo "imprnt is free"
for n in anti-slop character guard whenful; do
  npm view "imprnt-plugin-$n" version 2>/dev/null || echo "imprnt-plugin-$n is free"
done

# publish core (its prepublishOnly runs shipdocs + typecheck + test + build)
( cd packages/imprnt && npm publish --access public )

# publish each plugin (their prepack builds check.js / guard.js / whenful.js first)
for p in plugin-anti-slop plugin-character plugin-guard plugin-whenful; do
  ( cd "packages/$p" && npm publish --access public )
done
```

If a name is taken, scope the packages (e.g. `@yourname/imprnt`) by editing each `package.json`
`name`, and update `OFFICIAL` + the fetch spec in `packages/imprnt/scripts/lib/install.ts`
accordingly (it builds `imprnt-plugin-<name>`). Unscoped is simpler if the names are free.

## Part 2 - remove the local dev install

The clone stays for development. We only drop any GLOBAL install so the reinstall is honest.

```sh
npm rm -g imprnt 2>/dev/null || true   # no-op if you never installed/linked it globally
which imprnt || echo "no global imprnt - good, clean slate"
```

## Part 3 - install and set up as a real user

```sh
npm i -g imprnt
imprnt --help        # runs on Node, no Bun on PATH required

# go to your VAULT PROJECT dir - the parent of the vault, where CLAUDE.local.md + plugins/ live
cd ~/imprint-vault
export IMPRNT_VAULT=~/imprint-vault/vault   # (keep this in your shell profile)

imprnt init          # drops CLAUDE.md + missing control files, registers this dir as imp's default
```

Reinstall the gallery from npm:

```sh
imprnt plugin add anti-slop character whenful guard
imprnt plugin list   # all four [on], copied into ./plugins/
```

Restore the PERSONAL cast (your private character + voice) - private, never published, copied from
the clone:

```sh
mkdir -p plugins/_personal
CHAR=my-character VOICE=my-voice     # set to your actual _personal file names
cp ~/IdeaProjects/imprnt/plugins/_personal/$CHAR.md plugins/_personal/
cp ~/IdeaProjects/imprnt/plugins/_personal/$VOICE.md plugins/_personal/
imprnt plugin add _personal/$CHAR.md _personal/$VOICE.md

# if you run a personal character, drop the generic one so they don't both load
imprnt plugin rm character --purge
```

## Part 4 - verify

```sh
imprnt plugin list                 # gallery + _personal cast, on/off as expected
imprnt check --all                 # core integrity + each plugin's check.js under Node
imprnt recall "tax"                # a real query returns ranked hits
imprnt context | head              # prints the vault contract from any directory
ls plugins/whenful                  # built check.js + whenful.js, agent.md, no src/
```

Then the front door, from a directory that is NOT the vault project:

```sh
cd ~/some-coding-repo
imp                                # opens claude with your cast + the vault pointer riding along
imp lair                           # opens claude in the vault project itself
```

If all four behave, the published install path is proven end to end.

## Notes

- Project root is found by walking up for `vault/` or `CLAUDE.local.md`, or set `IMPRNT_ROOT`.
- `plugin add <name>` fetches `imprnt-plugin-<name>` with `npm pack`, copies its shipped files into
  `plugins/<name>/`, and wires `@plugins/<name>/agent.md` into `CLAUDE.local.md`. It is idempotent.
  `--force` refreshes, `--from <dir>` installs from a local package dir instead of the registry.
- `plugin rm <name>` unwires. Add `--purge` to also delete `plugins/<name>/` (it never touches
  `_personal/`).
