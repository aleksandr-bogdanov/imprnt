# Shipping model

How imprnt is built and distributed, and how the personal-vs-generic split works. Evergreen.

## A monorepo that publishes many packages

imprnt is a [bun workspaces](https://bun.sh/docs/install/workspaces) monorepo. One git repo, one
`bun install`, develop everything together. At publish time it produces several independent npm
packages:

- **`imprnt`** (`packages/imprnt/`) - the core CLI. The three commands `ingest`, `recall`, `check`,
  plus `init`, `snapshot`, `hot`, `context`, and `plugin`. The package installs two bin names from
  one dispatcher: `imprnt` for machinery (bare prints help, safe for scripts and agents) and `imp`
  for humans (bare opens a Claude session, `imp lair` opens it in the vault project). The split
  lives in a tiny second entry file (`scripts/imp.ts`) rather than argv sniffing, because npm's
  Windows shims rewrite argv.
- **`imprnt-plugin-anti-slop`, `imprnt-plugin-character`, `imprnt-plugin-guard`,
  `imprnt-plugin-statusline`, `imprnt-plugin-whenful`** (`packages/plugin-*/`) - the gallery,
  each its own package.

The naming convention is `imprnt-plugin-<name>`, the same shape ESLint uses (`eslint-plugin-*`). It
means anyone can publish a plugin later without joining an npm org. The core stays plugin-blind: it
never imports a plugin and never names one. Everything past the core commands is a package you install
or skip.

This reverses an earlier call ("one package, one bundled gallery"). The reason for the change: a
bundled gallery is not "separate installables". Making each plugin its own package is what lets
`imprnt plugin add anti-slop` pull exactly that one thing, and lets the gallery grow without bloating
the core download.

## Ship Node, build with Bun

The thing a user installs runs on **Node** (the runtime everyone already has), so `npm i -g imprnt`
works with no "first go install Bun" wall. Bun is a dev and build tool only:

- Develop and test in Bun (fast, `bun test`, run the `.ts` source directly).
- Build with `bun build --target=node`, which compiles the TypeScript into a single self-contained
  `dist/cli.js` that Node runs. Source is detached from the deliverable: the package ships `dist/`,
  not `scripts/`.

The same split applies to a code plugin: its `src/*.ts` is the source, and its build emits a Node-
runnable `check.js` / `guard.js` / `whenful.js` that ships. The `check --all` aggregator runs a
plugin's `check.js` with `node`, so the read path needs no Bun either.

## Plugins install by fetch-and-copy

Claude Code's `@import` in `CLAUDE.local.md` resolves files only inside the project root, never
`node_modules`. So a plugin's `agent.md` has to physically live at `plugins/<name>/agent.md` in your
project. `imprnt plugin add <name>` makes that happen:

```sh
imprnt plugin list                  # installed plugins (on/off) + official ones available to add
imprnt plugin add anti-slop         # fetch imprnt-plugin-anti-slop, copy into plugins/, wire it
imprnt plugin add whenful --from packages/plugin-whenful   # install from a local dir (pre-publish/dev)
imprnt plugin rm anti-slop          # unwire (add --purge to also delete plugins/anti-slop/)
```

Under the hood `add` runs `npm pack <spec>` (a registry name, or a local dir with `--from`), which
yields a tarball of exactly the package's `files[]` - the built artifacts, never `src/`. It extracts
that, copies the tree into `plugins/<name>/` (minus the npm manifest), and wires
`@plugins/<name>/agent.md` into `CLAUDE.local.md`. The project `plugins/` dir is the self-contained,
offline, `rm`-able source of truth. npm is just the transport.

`CLAUDE.local.md` is the gitignored, per-machine toggle file Claude Code auto-loads after the
project's `CLAUDE.md`. It stays the single record of what is enabled. A fresh install has none, so it
loads zero plugins by default. Opt-in for real. The litmus the core holds to: adding a plugin is
`imprnt plugin add`, never a `packages/imprnt/` edit.

## Generic ships, personal stays private

The gallery is generic and shippable. The shipped character is **Scribe**, a generalized default
digital assistant. The shipped anti-slop is the universal anti-AI-slop core. Both are starting points
you copy and make yours.

Your private instance lives in your project's `plugins/_personal/`, which is **gitignored** and never
published. It holds your own DA (a personalized copy of Scribe) and your own voice overlay. To
personalize: copy a gallery plugin into `_personal/`, edit it, and `imprnt plugin add
_personal/<file>.md` (a bare `<name>/<file.md>` spec wires a local file directly, no fetch). `imprnt
plugin list` skips `_personal/`, so your private cast never shows up in the public listing.

## What each package ships

| Package | Ships | Built? |
|---------|-------|--------|
| `imprnt` | `dist/cli.js`, `dist/imp.js`, `templates/`, `CLAUDE.md`, `README.md`, `LICENSE` | both bundles via `bun build` |
| `imprnt-plugin-anti-slop` | `agent.md`, `README.md` | no (markdown only) |
| `imprnt-plugin-character` | `agent.md`, `README.md` | no (markdown only) |
| `imprnt-plugin-guard` | `agent.md`, `guard.js`, `.claude-plugin/plugin.json`, `hooks/hooks.json`, `README.md` | `guard.js` via `prepack` |
| `imprnt-plugin-statusline` | `agent.md`, `statusline.js`, `imp-settings.json`, `README.md` | `statusline.js` via `prepack` |
| `imprnt-plugin-whenful` | `agent.md`, `check.js`, `whenful.js`, `links.tsv`, `proposed/`, `mirror/`, `README.md` | `check.js`+`whenful.js` via `prepack` |

Core builds and ships its docs through `prepublishOnly` (it runs `shipdocs` to copy `CLAUDE.md` /
`README.md` / `LICENSE` from the repo root, then typecheck, test, build). Each code plugin builds its
artifacts through `prepack`, so a published tarball always carries the compiled `.js`.

## Publishing

The step-by-step runbook - publish all packages, then wipe the local install and reinstall from npm as
a real user - lives in [`publish-and-dogfood.md`](publish-and-dogfood.md).
