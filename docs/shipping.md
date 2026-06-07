# Shipping model

How imprint is distributed and how the personal-vs-generic split works. Evergreen.

## One package, one gallery

imprint ships as a single npm package: the core CLI plus a bundled gallery of generic plugins. Not a
monorepo of hidden bundles, not a separate gallery repo. The core lives in `scripts/`, the gallery in
`plugins/`. Distribution is `bunx imprint` or `npm i -g imprint`.

The core stays tiny and plugin-blind. It never imports a plugin and never names one. Everything past
the three core commands (`ingest`, `recall`, `check`) is a plugin you drop in or delete.

## Plugins install by one generic command

`imprint plugin add/rm/list` is the install mechanism. It operates on `plugins/<name>/` by convention
and appends or removes one `@import` line in `CLAUDE.local.md`, with zero per-plugin logic in core:

```sh
imprint plugin list                    # available plugins + which are enabled
imprint plugin add anti-slop           # wires @plugins/anti-slop/agent.md
imprint plugin add character/scribe.md # wires that exact file (multi-file plugins)
imprint plugin rm anti-slop            # removes the wiring line
```

`CLAUDE.local.md` is the gitignored, per-machine toggle file Claude Code auto-loads after the
committed `CLAUDE.md`. It stays the single source of truth for what's enabled. The command just edits
it for you; you can hand-edit it instead. A fresh clone has no `CLAUDE.local.md`, so it loads zero
plugins by default. Opt-in for real.

The litmus the model holds to: adding a gallery plugin is dropping a dir, never a `scripts/` edit.

## Generic ships, personal stays private

The gallery is generic and shippable. The shipped character is **Scribe**, a generalized default DA.
The shipped anti-slop is the universal anti-AI-slop core. Both are starting points you copy and make
yours.

Your private instance lives in `plugins/_personal/`, which is **gitignored** and never ships. It holds
your own DA (a personalized copy of Scribe) and your own voice overlay (a personalized copy of the
anti-slop core). To personalize: copy a gallery plugin into `_personal/`, edit it, and
`imprint plugin add _personal/<file>.md`. `imprint plugin list` skips `_personal/`, so your private
cast never shows up in the public listing.

Because `_personal/` is gitignored, npm won't pack it either. The package ships `scripts`, `templates`,
`plugins` (the generic gallery), `CLAUDE.md`, and `README.md`. Your private content stays on your disk.
