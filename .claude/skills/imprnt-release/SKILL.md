---
name: imprnt-release
description: Cut a stable imprnt release to npm `latest`. Detects affected packages since the last release, patch-bumps each, and fires the gated release workflow. Use when the user says "imprnt-release", "/imprnt-release", "ship imprnt", "release imprnt", "promote imprnt to latest". DEFAULT IS NO PROSE, just ship.
---

# imprnt release skill

Promote a **stable** release to npm `latest`. (Edge auto-publishes on every push to master, so you
never touch that here.) For how the whole pipeline works (channels, versioning, OIDC, the gate), read
[`dev/releasing.md`](../../../dev/releasing.md). This skill only drives the stable cut, so that
architecture lives in one place and can't go stale here.

## THE ONE RULE: no prose by default

**Default = ship. No articles, no blog drafts, no release-note essays.** The GitHub Release gets the
minimal auto-notes the workflow generates, and that's it. Unprompted prose is the single most common
frustration with release commands, so only write it on an explicit `--article`.

- `imprnt-release` → preflight, show the plan, fire the gated workflow, report. Silent on prose.
- `imprnt-release --dry-run` → plan only, publishes nothing.
- `imprnt-release status` → show what's on `latest` vs `edge`.
- `imprnt-release --article` → see the section at the end. Opt-in only.

## Steps

Run from the imprnt repo root. Find it, don't assume a path.

1. **Preflight.** The workflow releases from origin/master, so confirm local is clean and pushed:
   ```sh
   git branch --show-current            # must be master
   git status --porcelain               # must be empty
   git fetch origin --tags --quiet
   git rev-parse HEAD; git rev-parse origin/master   # must match, push first if not
   ```
   If master is dirty or behind origin, stop and tell the user. Don't release a surprise state.

2. **Show the plan (read-only).** Compute exactly what the workflow will, so the bumps are visible
   before anyone approves:
   ```sh
   if git rev-parse -q --verify refs/tags/last-release >/dev/null; then
     BASE=$(git rev-parse last-release); else BASE=$(git rev-list --max-parents=0 HEAD | tail -1); fi
   # export (not inline): inline env before a pipeline reaches only the first command, not node.
   export TURBO_SCM_BASE=$BASE TURBO_SCM_HEAD=HEAD GITHUB_OUTPUT=/dev/stdout
   bunx turbo ls --affected --output=json | node .github/scripts/release-matrix.mjs
   ```
   Print the per-package bumps plainly. If `any=false`, say nothing changed since the last release and
   stop.

3. **Fire the workflow.**
   ```sh
   gh workflow run publish.yml -f mode=release                    # normal
   gh workflow run publish.yml -f mode=release -f dry_run=true    # for --dry-run
   ```
   Surface the run URL and tell the user to **approve the `npm-production` gate** in the Actions UI
   (`gh run list --workflow=publish.yml --limit 1`). The release proceeds on approval. Don't wait
   silently.

4. **Report.** When it finishes, show the new versions (`gh release list --limit 1`, or
   `npm view imprnt version`). Done. **No prose.**

## `status`

```sh
for p in imprnt imprnt-plugin-anti-slop imprnt-plugin-character imprnt-plugin-guard imprnt-plugin-whenful; do
  echo "$p  latest=$(npm view "$p" version 2>/dev/null)  edge=$(npm view "$p"@edge version 2>/dev/null)"
done
```

## `--article` (only when explicitly asked)

After firing the release, draft ONE raw post as building-in-public material, then ask the user
where to save it (an output directory or path). Do not assume any location. Use whatever draft
conventions exist at that destination. It is raw material the user turns into final prose. Never
publish it. If the user gave no path, print it to the conversation instead of writing a file.

## Rollback (npm can't unpublish)

To undo a bad `latest`, point the tag back to the last good version and deprecate the bad one (needs
the user's npm auth, run in their Terminal with the passkey). Details in
[`dev/releasing.md`](../../../dev/releasing.md#rollback):
```sh
npm dist-tag add imprnt@<last-good> latest
npm deprecate imprnt@<bad> "broken release, use <last-good>"
```
