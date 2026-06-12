# Module: session-host (the authed-session capability)

> The agent fragment. Core never reads it; you (the assistant) do. Install =
> `imprnt plugin add session-host`. Remove = `imprnt plugin rm session-host` (`--purge` deletes the
> folder, including the browser profile). Needs `playwright-core` + system Chrome installed.

## What this is

A warm, user-started browser that holds the user's logged-in sessions, separate from their daily Arc.
It provides the **authed-session** capability: other modules ask it for a fresh login token for a site
and it hands one back, read from a live session the site keeps refreshing itself. This is how the
kleinanzeigen watcher (and future tenants: mail, channels) get reliable auth without reverse-engineering
each site's token flow. Deterministic code drives it; the LLM is never in the loop; it never acts on its
own, it answers requests.

It is a **module like any other** (install/remove the same way), that happens to provide a shared
capability and run as a warm service rather than a one-shot command. It is not "core" and not special-
cased — consumers reach it through its localhost broker, declared as an edge, with graceful fallback.

## Commands (you run these; nothing runs on its own)

- `node plugins/session-host/session-host.js serve` — start the warm browser + localhost broker on
  `127.0.0.1:8787` (override `SESSION_HOST_PORT`). You start it; Ctrl-C stops it. Not resident, no boot
  hook. Localhost-bind only — never exposed to the network.
- `node plugins/session-host/session-host.js login <url|site>` — open the dedicated browser headful to
  sign into a site ONCE, by hand. Run with `serve` stopped (they share one profile). Automation never
  types a password — this is the one human step.
- `node plugins/session-host/session-host.js status` — health + which sites are enrolled.

## The broker (how consumers use it)

A consumer asks `GET http://127.0.0.1:8787/session/token?site=<host>` and gets `{ token }` (a fresh
bearer) or an error. A module copies the tiny client in `client.js` (`sessionToken(site)` → string |
null) rather than hard-importing this module — and treats a null as "host down, fall back," never a
hard failure. That is the contract's graceful-degradation rule: removing this provider must not break a
consumer.

## Enrolling a new site

Add one entry to `sites.ts` (loginUrl, warmUrl, the token cookie + domain), then
`session-host login <site>`. The broker, the warm loop, and the audit log are generic — that one entry
plus a manual login is the whole onboarding.

## Rules (always-on while installed)

- **You start it; you can kill it.** Never resident by default. The off switch is real.
- **Localhost only.** The credential surface is never bound to a network interface.
- **Auditable.** Every token handout and miss appends to `audit.log` (timestamp, site, token
  FINGERPRINT — never the token itself). Read it to confirm nothing rogue ran.
- **Deterministic only.** No LLM drives the browser. It answers requests; it doesn't act on its own,
  never auto-injects into the agent or the vault.
- **The profile is private.** `profile/` (real sessions) and `audit.log` are gitignored — never
  committed, never in the vault.
