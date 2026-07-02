# imprnt-plugin-session-host

A warm, user-started browser that holds your logged-in sessions and provides the **authed-session**
capability to other modules. One place you log into every site you want the system to manage; the site
keeps its own session fresh; automation reads a fresh token on demand. Reliable (no per-site token
reverse-engineering), general (any site/channel enrolls the same way), and auditable (one profile, one
action log, one trust boundary).

It's the answer to "how do we log in reliably across all sites," and the first **capability module** in
imprnt: it provides something other modules consume, through a localhost broker, with graceful
fallback. Full design: `Plans/06-session-host.md`.

## Why a separate browser

Your daily browser (Arc) rotates its tokens on its own schedule; reading them from disk races that
rotation and fails. A dedicated browser, used only by the system, holds only what you enroll, keeps
each site's session warm so the site's own JavaScript refreshes its short-lived token, and is isolated
from your primary identity — so a compromise of the automation can't touch your real accounts beyond
what you enrolled. It runs on a box you control (a Pi is the endgame), localhost-bound, with an
append-only audit log.

## How it's safer than a resident agent (the OpenClaw question)

A resident LLM agent that reads your inbox and can act is injectable: hostile message → LLM → action.
The session host removes the middle — **deterministic code drives the browser, the LLM only drafts text
you approve.** The residual risk is credential concentration, dangerous only if the driving code is
compromised; the fences are isolation, a localhost-only port, the audit log, and minimal pinned
dependencies.

## Commands

| Command | What it does |
|---|---|
| `session-host serve` | Start the warm browser + broker on `127.0.0.1:8787`. You start it; Ctrl-C stops it. |
| `session-host login <url\|site>` | Open the dedicated browser to sign into a site ONCE, by hand (run with `serve` stopped). |
| `session-host status` | Health + which sites are enrolled. |

The broker: `GET http://127.0.0.1:8787/session/token?site=<host>` → `{ token }`. Consumers copy the
tiny `client.js` (`sessionToken(site)` → string | null) and fall back when it returns null.

## Install

```sh
npm i -g playwright-core      # uses your installed system Chrome — no browser download
imprnt plugin add session-host
node plugins/session-host/session-host.js login https://www.kleinanzeigen.de/m-einloggen.html  # sign in once
node plugins/session-host/session-host.js serve   # leave running (or schedule on a Pi)
```

Then a consumer like the kleinanzeigen watcher gets its token from the host automatically — its `sync`
no longer depends on your Arc session or a ~1h token.

## Enrolling a new site

One entry in `src/sites.ts` (login URL, a warm URL to keep loaded, the token cookie + domain), then
`session-host login <site>`. Everything else is generic.

## Environment

- `SESSION_HOST_PORT` — broker port (default 8787, localhost only).

## Audit

Every token handout and miss appends to `audit.log`: `{ ts, event, site, fingerprint }` — the token's
SHA-256 prefix, never the token. `profile/` and `audit.log` are gitignored.

## Building

```sh
bun install        # pulls playwright-core
bun run build      # src/*.ts -> session-host.js + client.js (node banner)
bunx tsc --noEmit
```

`playwright-core` is the one runtime dependency, fenced behind this module's interface (consumers never
import it). License MIT.

## Remove

```sh
imprnt plugin rm session-host --purge   # unwire + delete the folder (and the browser profile)
```

Consumers degrade gracefully the moment it's gone — they fall back to their own direct auth.
