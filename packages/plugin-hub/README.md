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
- `src/` is the hub: the store, the records, the registry, the wake path, the door that carries a message both ways, the runner that drives a turn, the chat log, and `adapters/`, one file per loop behind five verbs.

## Run the checks

```
bun test
```

65 checks against a throwaway Postgres 17. Needs bun and the Postgres binaries (`initdb`, `pg_ctl`, `psql`, `postgres`) in one directory: Homebrew on the Mac, apt on the Pi. No model login and no chat token: the platform is a fake the test owns and the loop is a scripted adapter, and both are driven through the real door and the real runner.

```
bun run test:live
```

Two more, by hand, on a machine with the Claude Code login. They drive the real loop through the same fake platform, so they need no chat token either. `bunfig.toml` keeps `bun test` from finding them, because the machine that runs the suite on every change has no login.

The two real platforms have no automated check on purpose. A synthetic test message is forbidden, so the acceptance is a person sending one real message and getting a real answer.

## Layout of the roadmap

Milestone one, one message one database: the store and the records, one message one answer, the machines, no unexplained silence. Milestone two, daily life: harvest, watchers and gates, backup and the board. Milestone three: the OpenCode adapter, then Codex and the ACL.

---

<img src=".github/mark.svg" height="15" alt=""> built by [bogdanov.wtf](https://bogdanov.wtf)
