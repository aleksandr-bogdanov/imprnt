---
title: Contributing
description: How imprnt is built, structured, and released, for anyone hacking on it.
---

imprnt is open source ([MIT](https://github.com/aleksandr-bogdanov/imprnt/blob/main/LICENSE)). This page is for people working on the engine and the plugins, not for using the vault day to day.

## The monorepo

imprnt is a [bun workspaces](https://bun.sh/docs/install/workspaces) monorepo. One git repo, one `bun install`, develop everything together. At publish time it produces several independent npm packages:

- **`imprnt`** (`packages/imprnt/`) is the core CLI: `ingest`, `recall`, `check`, plus `init`, `snapshot`, `hot`, `context`, and `plugin`. It installs two commands from one dispatcher, `imprnt` for machinery and `imp` for humans.
- **`imprnt-plugin-*`** (`packages/plugin-*/`) is the gallery, each plugin its own package. The naming convention is the same shape ESLint uses, so anyone can publish a plugin later without joining an npm org. The core never imports a plugin and never names one.

```sh
bun install
bun run build      # compile each package
bun run test       # bun test across the workspace
bun run check      # typecheck + test + build
```

## Ship Node, build with Bun

What a user installs runs on **Node**, the runtime everyone already has, so `npm i -g imprnt` works with no "first install Bun" wall. Bun is a dev and build tool only: develop and test in Bun, then `bun build --target=node` compiles the TypeScript into a self-contained file Node runs. The package ships `dist/`, never `src/`. A code plugin builds the same way, emitting a Node-runnable `check.js` so the read path needs no Bun either.

## Generic ships, personal stays private

The gallery is generic and shippable. The shipped character is **Scribe**, a generalized default you copy and make yours, and the shipped anti-slop is the universal core. Your private instance lives in `plugins/_personal/`, which is gitignored and never published. To personalize, copy a gallery plugin into `_personal/`, edit it, and wire the local file directly. `imprnt plugin list` skips `_personal/`, so your private cast never shows in the public listing.

## Releasing

imprnt publishes to npm on two [dist-tags](https://docs.npmjs.com/cli/v10/commands/npm-dist-tag):

| Channel | Install | What it is |
|---------|---------|------------|
| `latest` | `npm i -g imprnt` | Stable. What a normal user gets. Promoted deliberately. |
| `edge` | `npm i -g imprnt@edge` | Every push to master. May be rough. |

It is the same package with two pointers, not a separate beta registry. Versions are independent per package, decided by [Turborepo's](https://turborepo.com) `--affected`, so a package whose files did not change is never republished. An edge build is dogfooded against edge plugins automatically.

All publishing runs through one GitHub Actions workflow that authenticates to npm with OIDC trusted publishing (no long-lived tokens) and signs a provenance attestation on every package:

```
push to master              -> edge: affected packages -> @edge  (automatic)
run publish.yml mode=release -> latest: affected since release    (gated, then tag + Release)
```

A stable release pauses at a GitHub Environment for a required reviewer's approval, so even an automated trigger cannot reach `latest` without a human clicking approve. Trusted publishing is configured once per package on npmjs.com.

To cut a stable release, use the `imprnt-release` skill (it fires the workflow and reports), or run it by hand:

```sh
gh workflow run publish.yml -f mode=release                 # then approve the npm-production gate
gh workflow run publish.yml -f mode=release -f dry_run=true # plan only, publishes nothing
```

npm only allows a full unpublish within 72 hours, so for a normal release you cannot count on it. To undo a bad `latest`, point the tag back to the last good version and deprecate the bad one:

```sh
npm dist-tag add imprnt@<last-good> latest
npm deprecate imprnt@<bad> "broken release, use <last-good>"
```

## Where the rest lives

The deep design rationale is in [Design decisions](/design-decisions/), the system shape in [Architecture](/architecture/), and the full plugin contract in [Plugins](/plugins/).
