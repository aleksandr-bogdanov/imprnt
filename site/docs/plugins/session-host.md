---
draft: true
title: Session host
description: A warm browser that holds your logged-in sessions and hands out a fresh token over localhost.
---

A dedicated, user-started **browser** that holds your logged-in sessions and hands a fresh login token to other plugins over a localhost port, so they get reliable auth without reverse-engineering each site. Other plugins (the kleinanzeigen watcher today, mail and channels later) need to act on a site you are logged into. Reading the token from your daily browser races that browser's own token rotation and fails. The session host is one place you log into every site you want the system to manage. It keeps each site's session **warm** so the site refreshes its own short-lived token, and automation reads a fresh one on demand.

It is isolated from your primary identity, so a compromise of the automation cannot touch your real accounts beyond the sites you enrolled.

## How it works

A **capability** module. It runs a warm browser plus a **broker** on `127.0.0.1:8787`, localhost only. A consumer asks `GET /session/token?site=<host>` and gets `{ token }`, a fresh bearer, or an error. Consumers copy a tiny client and treat a null as "host down, fall back," so removing the host degrades them gracefully rather than breaking them.

Deterministic code drives the browser. The model is never in the loop. It answers requests and never acts on its own. Every token handout appends to `audit.log` with the token's **fingerprint**, never the token itself. The browser profile and the audit log are gitignored, never committed, never in the vault.

## Commands

```sh
node plugins/session-host/session-host.js serve          # start the warm browser + broker. you start it, Ctrl-C stops it
node plugins/session-host/session-host.js login <site>   # open the browser to sign into a site ONCE, by hand
node plugins/session-host/session-host.js status         # health + which sites are enrolled
```

Run `login` with `serve` stopped, since they share one profile. Automation never types a password. The login is the one **human** step. To enroll a new site, add one entry to `src/sites.ts` (login URL, a warm URL, the token cookie and domain), then run `login`.

## Install

```sh
npm i -g playwright-core      # uses your installed system Chrome, no browser download
imprnt plugin add session-host
node plugins/session-host/session-host.js login https://www.kleinanzeigen.de/m-einloggen.html
node plugins/session-host/session-host.js serve
```

Then a consumer like the kleinanzeigen watcher gets its token from the host automatically. Remove with `imprnt plugin rm session-host --purge`, which unwires it and deletes the folder including the browser profile.
