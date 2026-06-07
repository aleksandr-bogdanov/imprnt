---
name: imprnt-release
description: Cut a stable imprnt release to npm `latest`. Detects affected packages since the last release, patch-bumps each, and fires the gated release workflow. Use when the user says "imprnt-release", "/imprnt-release", "ship imprnt", "release imprnt", "promote imprnt to latest". DEFAULT IS NO PROSE — just ship.
---

# imprnt release skill

Cut a **stable** imprnt release. Master auto-publishes to the `edge` dist-tag on every push (that's
`edge.yml`, fully automatic — you never touch it here). This skill does the deliberate promotion to
`latest`: the version a normal `npm i -g imprnt` gets.

## THE ONE RULE: no prose by default

**Default = ship. No articles, no blog drafts, no release-note essays.** The GitHub Release gets
minimal auto-notes (the commit list) and that's it. Writing prose is the single most common
frustration with release commands — do not do it unless the user explicitly passes `--article`.

- `imprnt-release` → detect, bump, fire the gated workflow, report. Silent on prose.
- `imprnt-release --article` → after the release is triggered, ALSO draft a building-in-public post
  into `~/IdeaProjects/bogdanov-wtf/docs/drafts/` (raw material; the user writes final prose).
- `imprnt-release --dry-run` → plan only, publish nothing.
- `imprnt-release status` → show what's currently on `latest` vs `edge`.

## How releases actually work (so you know what you're firing)

- 5 independent packages: `imprnt` + `imprnt-plugin-{anti-slop,character,guard,whenful}`.
- **Versions are independent.** Each affected package bumps **one patch** from its current npm
  `latest`. A package whose files didn't change since the last release is NOT bumped or republished.
- "Affected since last release" = Turbo `--affected` diffed against the moving `last-release` git tag.
- Publishing is **OIDC + provenance from CI** (`.github/workflows/publish.yml` → `_publish.yml`). There
  are **no tokens** and you do **not** run `npm publish` locally. The workflow pauses at the
  `npm-production` environment for the user's manual approval before anything hits `latest`.

## Steps (default path)

Run from `~/IdeaProjects/imprnt`.

1. **Preflight.** Confirm clean state and that origin/master has everything (the workflow releases
   from origin master):
   ```sh
   git branch --show-current            # must be master
   git status --porcelain               # must be empty
   git fetch origin --tags --quiet
   git rev-parse HEAD; git rev-parse origin/master   # must match — push first if not
   ```
   If master is behind origin or dirty, stop and tell the user; don't release a surprise state.

2. **Show the plan (local preview, read-only).** Compute exactly what the workflow will, so the user
   sees the bumps before approving:
   ```sh
   if git rev-parse -q --verify refs/tags/last-release >/dev/null; then
     BASE=$(git rev-parse last-release); else BASE=$(git rev-list --max-parents=0 HEAD | tail -1); fi
   # export (not inline) — inline env before a pipeline only reaches the first command, not node.
   export TURBO_SCM_BASE=$BASE TURBO_SCM_HEAD=HEAD GITHUB_OUTPUT=/dev/stdout
   bunx turbo ls --affected --output=json | node .github/scripts/release-matrix.mjs
   ```
   Print the resulting per-package bumps plainly. If `any=false`, tell the user nothing changed since
   the last release and stop.

3. **Fire the workflow.**
   ```sh
   gh workflow run publish.yml -f mode=release                    # normal
   gh workflow run publish.yml -f mode=release -f dry_run=true    # for --dry-run
   ```
   Then surface the run and tell the user to **approve the `npm-production` gate** in the Actions UI:
   ```sh
   gh run list --workflow=publish.yml --limit 1
   ```
   Give them the run URL. The release proceeds once they approve; do not wait silently.

4. **Report.** When the run finishes, show the new `latest` versions (`gh release list --limit 1`,
   or `npm view imprnt version`). Done. **No prose.**

## `--article` (only when explicitly asked)

After step 3, additionally draft ONE raw post into `~/IdeaProjects/bogdanov-wtf/docs/drafts/` named
`<YYYY-MM-DD>-imprnt-release-<summary>.md`, using the same `session-transcript`/draft conventions as
the existing drafts there. It is raw material — the user writes the final prose. Never publish it.

## `status`

```sh
for p in imprnt imprnt-plugin-anti-slop imprnt-plugin-character imprnt-plugin-guard imprnt-plugin-whenful; do
  echo "$p  latest=$(npm view "$p" version 2>/dev/null)  edge=$(npm view "$p"@edge version 2>/dev/null)"
done
```

## Rollback (npm can't unpublish)

You cannot delete a published version. To undo a bad `latest`, point the tag back to the last good
version (needs the user's npm auth — run in their Terminal, passkey):
```sh
npm dist-tag add imprnt@<last-good-version> latest
npm deprecate imprnt@<bad-version> "broken release, use <last-good-version>"
```
