# Releasing imprnt

How a change becomes a published package. Two channels, one entry point, zero tokens.

## Two channels

imprnt publishes to npm on two [dist-tags](https://docs.npmjs.com/cli/v10/commands/npm-dist-tag):

| Channel | Install | What it is |
|---------|---------|------------|
| `latest` | `npm i -g imprnt` | Stable. What a normal user gets. Promoted deliberately. |
| `edge` | `npm i -g imprnt@edge` | Bleeding edge. Every push to `master`. May be rough. |

There is no separate beta registry. It is the same package with two pointers. `npm i -g imprnt@edge`
opts in, and plain `npm i -g imprnt` never sees edge builds.

As of June 2026 the package is temporarily unpublished while the installer is polished, so both
install commands 404 until the next release.

## Versions are independent per package

The repo holds five packages (the `imprnt` core plus four `imprnt-plugin-*`). They version on their
own, so a package whose files did not change is never republished or bumped. The core can sit on
`0.6.x` while a stable plugin stays at `0.1.0` for a year. What changed is decided by
[Turborepo's](https://turborepo.com) `--affected`, diffed against a baseline.

- Edge version is `{last stable + 1 patch}-edge.{run number}`, so stable `0.3.2` gives edge
  `0.3.3-edge.418`. The base is frozen until the next stable cut, and only the run number climbs. Semver
  forces this anyway: a pre-release sorts before its base, so basing edge on last-stable+1 keeps each
  edge build newer than the last release and older than the eventual stable.
- Stable version is one patch above the package's current `latest`.

A core build knows its own channel from its version string. An edge core installs plugins from the
`@edge` tag (falling back to `@latest`), and a stable core installs `@latest`. So a bleeding-edge core
is dogfooded against bleeding-edge plugins automatically, with no extra flags.

## One entry point, no tokens

All publishing runs through a single GitHub Actions workflow, `.github/workflows/publish.yml`, which
authenticates to npm with OIDC trusted publishing (no long-lived tokens anywhere) and signs a
[provenance](https://docs.npmjs.com/generating-provenance-statements) attestation on every package.
`publish.yml` calls the reusable `_publish.yml` to do the actual `npm publish`.

```
push to master            -> edge: affected packages -> @edge      (automatic, ungated)
run publish.yml mode=edge -> edge: ALL packages -> @edge           (manual escape hatch / re-publish)
run publish.yml mode=release -> latest: affected-since-release     (gated, then tag + GitHub Release)
```

Stable releases pause at the `npm-production` GitHub Environment for a required reviewer's approval, so
even an automated trigger cannot reach `latest` without a human clicking approve.

## Cutting a stable release

Use the `imprnt-release` skill (it fires the workflow and reports, no prose by default), or trigger it
by hand:

```sh
gh workflow run publish.yml -f mode=release                 # then approve the npm-production gate
gh workflow run publish.yml -f mode=release -f dry_run=true # plan only, publishes nothing
```

A moving `last-release` git tag marks the baseline the next release diffs against. Finalize pushes a
`<pkg>-v<version>` tag per released package and cuts one GitHub Release with minimal auto-notes.

## Rollback

npm only lets you fully unpublish within 72 hours of a publish, which is what happened to `imprnt` in
June 2026. After that window a version is permanent. So for a normal release you cannot count on
unpublish. To undo a bad `latest`, point the tag back to the last good version and deprecate the bad
one (needs your npm auth, interactive, with your passkey):

```sh
npm dist-tag add imprnt@<last-good> latest
npm deprecate imprnt@<bad> "broken release, use <last-good>"
```

## One-time setup (per package, on npmjs.com)

Trusted publishing must be configured once for each of the five packages, under Settings then Trusted
Publisher:

- Repository: `aleksandr-bogdanov/imprnt`
- Workflow: `publish.yml`. This is the entry point. npm validates the caller workflow, not the reusable
  `_publish.yml`.
- Environment: blank, since both edge and release flow through `publish.yml`.
- Allowed action: Publish

Plus a `npm-production` GitHub Environment with a required reviewer for the stable gate. With "Require
2FA and disallow tokens" set on each package, OIDC is the only automated path that can publish, and a
stolen token can do nothing.
