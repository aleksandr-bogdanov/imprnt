# imprnt-plugin-hub

> The household chat hub: people talk to their agents on Discord or Telegram, and no message is ever lost or silently ignored.

Version 3, built from a blank page. One Postgres on the Pi is the record and the queue. The operating system runs every process. An agent produces text, the machinery delivers it.

## The rules it is built to

- `docs/SPEC.md` is the spec: one line per rule, with the `Forbidden` and `Check` lines every test is derived from.
- `the decisions record (private, in the vault: raw/adhoc/2026-09-13-hub-v3-shape/DECISIONS.md)` holds every decision in the owner's words, one entry each, edited in place. A ruled entry is closed.

## How it is built

Every phase starts as failing tests. Two different agents confirm they are red for the right reason. Only then is the code written, until the tests are green. One branch and one pull request per phase, reviewed by hand.

- `.planning/` holds the roadmap, the requirements and each phase's plans (GSD Core).
- `test/` holds the checks. `test/helpers/cluster.ts` starts a throwaway Postgres 17 for each run, nothing is mocked.
- `src/` is the hub. It does not exist until the first phase is built.

## Run the checks

```
bun test
```

Needs bun and Postgres 17 binaries (`initdb`, `pg_ctl`, `psql`, `postgres`) in one directory: Homebrew on the Mac, apt on the Pi.

## Layout of the roadmap

Milestone one, one message one database: the store and the records, one message one answer, the machines, no unexplained silence. Milestone two, daily life: harvest, watchers and gates, backup and the board. Milestone three: the OpenCode adapter, then Codex and the ACL.

---

<img src=".github/mark.svg" height="15" alt=""> built by [bogdanov.wtf](https://bogdanov.wtf)
