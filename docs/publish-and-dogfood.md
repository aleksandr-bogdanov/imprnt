# Publish imprint and reinstall it as a real user

A runbook for shipping the monorepo to npm, then removing the local dev setup and installing from npm
the way any user would. Follow it by hand, or paste it into a fresh Claude Code session as the task.

The point is honesty: prove the published packages install and run on Node alone, with the personal
cast (Taylor + voice) restored from local files that never go to npm.

## What ships

- `imprint` - the core CLI (package `packages/imprint`). Runs on Node, no Bun needed by the user.
- `imprint-plugin-anti-slop`, `imprint-plugin-character`, `imprint-plugin-guard`,
  `imprint-plugin-whenful` - the gallery (each under `packages/plugin-*`).

Bun is a dev/build tool only. The user side is Node + npm + tar (npm and tar ship with Node and the OS).

## Part 1 - publish (needs your npm account)

```sh
# from the repo root
npm whoami                      # confirm you are logged in (else: npm login)
bun install && bun test         # all green
bun run build                   # core + plugins build clean

# names must be free on the registry - check first
npm view imprint version 2>/dev/null || echo "imprint is free"
for n in anti-slop character guard whenful; do
  npm view "imprint-plugin-$n" version 2>/dev/null || echo "imprint-plugin-$n is free"
done

# publish core (its prepublishOnly runs shipdocs + typecheck + test + build)
( cd packages/imprint && npm publish --access public )

# publish each plugin (their prepack builds check.js / guard.js / whenful.js first)
for p in plugin-anti-slop plugin-character plugin-guard plugin-whenful; do
  ( cd "packages/$p" && npm publish --access public )
done
```

If a name is taken, scope the packages (e.g. `@yourname/imprint`) by editing each `package.json`
`name`, and update `OFFICIAL` + the fetch spec in `packages/imprint/scripts/lib/install.ts`
accordingly (it builds `imprint-plugin-<name>`). Unscoped is simpler if the names are free.

## Part 2 - remove the local dev install

The clone stays for development. We only drop any GLOBAL install so the reinstall is honest.

```sh
npm rm -g imprint 2>/dev/null || true   # no-op if you never installed/linked it globally
which imprint || echo "no global imprint - good, clean slate"
```

## Part 3 - install and set up as a real user

```sh
npm i -g imprint
imprint --help        # runs on Node, no Bun on PATH required

# go to your VAULT PROJECT dir - the parent of the vault, where CLAUDE.local.md + plugins/ live
cd ~/imprint-vault
export IMPRINT_VAULT=~/imprint-vault/vault   # (keep this in your shell profile)

imprint init          # drops CLAUDE.md + any missing control files, never overwrites your notes
```

Reinstall the gallery from npm:

```sh
imprint plugin add anti-slop character whenful guard
imprint plugin list   # all four [on], copied into ./plugins/
```

Restore the PERSONAL cast (Taylor + voice) - private, never published, copied from the clone:

```sh
mkdir -p plugins/_personal
cp ~/IdeaProjects/imprint/plugins/_personal/taylor.md plugins/_personal/
cp ~/IdeaProjects/imprint/plugins/_personal/voice.md  plugins/_personal/
imprint plugin add _personal/taylor.md _personal/voice.md

# if you run Taylor, drop the generic character so they don't both load
imprint plugin rm character --purge
```

## Part 4 - verify

```sh
imprint plugin list                 # gallery + _personal cast, on/off as expected
imprint check --all                 # core integrity + each plugin's check.js under Node
imprint recall "tax"                # a real query returns ranked hits
ls plugins/whenful                  # built check.js + whenful.js, agent.md, no src/
```

If all four behave, the published install path is proven end to end.

## Notes

- Project root is found by walking up for `vault/` or `CLAUDE.local.md`, or set `IMPRINT_ROOT`.
- `plugin add <name>` fetches `imprint-plugin-<name>` with `npm pack`, copies its shipped files into
  `plugins/<name>/`, and wires `@plugins/<name>/agent.md` into `CLAUDE.local.md`. It is idempotent.
  `--force` refreshes, `--from <dir>` installs from a local package dir instead of the registry.
- `plugin rm <name>` unwires. Add `--purge` to also delete `plugins/<name>/` (it never touches
  `_personal/`).
