# Live engine proof through the real runner (`live/prove-engine-runner.ts`)

One real engine is driven through the real hub as an ordinary agent's chat is: the production door on the fake platform, a throwaway
Postgres, and the production runner with the production adapters, in a process of its own. It is paid, disposable, and not part of CI.
Importing the module has no side effects.

Files:
- `live/prove-engine-runner.ts`: the CLI and orchestration, plus a programmatic `runEngineProof` and the pure `parseArgs`, `judge` and `markerIn`.
- `live/prove-engine-runner-child.ts`: the runner process.
- `live/engine-observer.ts`: the pure adapter observer.
- `test/prove-engine-runner.test.ts`: the offline checks.

## Scenario (`turns`)

1. **T1 (English).** "Read `<tree>/notes/proof-<tag>.txt` with your tool, do not repeat it, reply DONE." The marker is a random
   `ZEPHYR-XXXXXXXX`. The file is deleted once T1 settles.
2. **T2 (Russian).** "No files, no tools: what was the word?"
3. **Restart.** The runner process gets SIGTERM, which runs the production `stop()` and then each session's own `exitEvidence`. A
   new runner process is started.
4. **T3 (Russian).** "Again, no tools: the same word."
5. **Close.** The runner gets SIGTERM, the door stops, the store is read, and the database is removed with its cluster. The report is
   saved, and only then are the scratch tree and the PATH shim removed (see Output).

The marker is never in any input. A resumed master is fed no chat history; only a fresh master start gets recovery context. The judge
also requires that the second runner's first start resumed the first runner's native id. So a recall in T3 can only have come from the
engine's own native session.

## What is real, and what is added

**Real (production code):**
- `loopLaunch`, the box, the adapters' `prepareLaunch`, `capabilities` and `start`, the door's ingestion (`fake.deliver`), the claim,
  the settle and the outbox.
- The credential is opened only by the production launch. The harness looks at its metadata (exists, is a file) and nothing more.

**Added, and only this:**
- **The observer.** It adds listeners and returns the very session.
- **The pin.** `runRunner` has no binary option, and `loopLaunch` runs `claude`, `codex` or `opencode` by name from `PATH`. So
  `--bin` is reached through a scratch directory holding one symlink of that name, put first on the runner process's `PATH`. The
  harness checks that it resolves to the pinned file before anything starts.
- On macOS, the shim lives under `/private/tmp`, and the pinned binary's real path must be one the box reads: `/usr`, `/bin`,
  `/private/tmp`, `~/.local`, `~/.bun` or the Homebrew prefix. Anything else is refused by name.

## Prerequisites

- `bun` (the repo's `.bun-version`) and Postgres 15+ binaries in one directory (see `test/helpers/cluster.ts`).
- The box tool: macOS `/usr/bin/sandbox-exec`, Linux `/usr/bin/bwrap`.
- Start the process with `BUN_FEATURE_FLAG_DISABLE_SQL_AUTO_PIPELINING=1`; the store refuses a process started without it.
- An engine build the production launch accepts:

  | Engine | Accepted build | Credential |
  |---|---|---|
  | Claude | `2.1.285` or `2.1.286` (`VALIDATED_TOOL_CONTROL`, `VALIDATED_ORDINARY_PROFILES`) | a runner login file named `.credentials.json`; see `loginCommand` in `src/adapters/launch.ts` |
  | Codex | exactly `0.160.0` (`CODEX_BUILD`) | a `model-key` file; the provider `openai`, or `--base-url` |
  | OpenCode | the build its production launch accepts | `model-key`, as for Codex |

  An adapter that production blocks (`activationBlock`) is refused by name (`adapter_activation_blocked`).
- The credential file is outside `--evidence-dir`. The registry names it, and the launch reads it. The harness never opens it.

## Usage

```sh
cd packages/plugin-hub
# Claude, its own runner login, a pinned build:
BUN_FEATURE_FLAG_DISABLE_SQL_AUTO_PIPELINING=1 bun live/prove-engine-runner.ts \
  --adapter claude-code --model <model id> --provider anthropic --effort low \
  --credential-kind claude-login --credential-file <abs runner login dir>/.credentials.json \
  --bin <abs claude 2.1.286 executable> --evidence-dir <abs evidence dir> --label claude-mac --allow-paid-call

# Codex 0.160.0 on a model key:
BUN_FEATURE_FLAG_DISABLE_SQL_AUTO_PIPELINING=1 bun live/prove-engine-runner.ts \
  --adapter codex --model <model id> --provider openai --effort low \
  --credential-kind model-key --credential-file <abs key file> \
  --bin <abs codex 0.160.0 executable> --evidence-dir <abs evidence dir> --label codex-mac --allow-paid-call

# OpenCode on its own model key:
BUN_FEATURE_FLAG_DISABLE_SQL_AUTO_PIPELINING=1 bun live/prove-engine-runner.ts \
  --adapter opencode --model <model id> --provider <provider id> \
  --credential-kind model-key --credential-file <abs key file> [--base-url https://<origin>] \
  --bin <abs opencode executable> --evidence-dir <abs evidence dir> --label opencode-root --allow-paid-call
```

Optional flags:
- `--scratch-parent <dir>`: defaults to the OS temp directory. The box grants none of it beyond the tree, state and session paths
  a launch names, as in production. On macOS only the PATH shim goes under `/private/tmp`.
  - The macOS box grants every engine read and write on all of `/private/tmp`. So keep `--evidence-dir` outside it if a tool must
    not be able to reach the evidence. `report.json` records `evidence_box_writable`.
- `--turn-timeout-ms` (default 300000), `--stop-timeout-ms` (60000), `--deadline-ms` (2400000).
- `--paid plan|key`: defaults to `plan` for a login and `key` for a model key.
- `--keep-stderr`: writes runner stderr, which may hold engine diagnostics, to `private/`. Never share it.
- `--keep-scratch`: keeps the scratch tree and the PATH shim for diagnosis. Without it they are removed at the end of every run, pass
  or fail.

The run uses the same command on Linux (the Pi), with Linux paths.

## Signals and bounds

- The first SIGINT, SIGTERM or SIGHUP, or reaching `--deadline-ms`, ends the scenario. The bounded cleanup then runs.
- A second signal SIGKILLs the runner process and exits with 4.
- The runner process gets SIGTERM and is given `--stop-timeout-ms`:
  - Inside that time, it runs the production `stop()`. If `stop()` hangs, it then calls each session's own `interrupt` or `close`.
  - After the bound, it is SIGKILLed.
- Any engine process the sessions recorded that is still alive is then terminated and killed by its recorded process group and pid.
  This is a last resort, and the run is `CLEANUP_UNVERIFIED`.
- The programmatic `runEngineProof` replaces the process's SIGINT, SIGTERM and SIGHUP listeners while it runs.

## Output

`<evidence>/engine-proof-<adapter>-<stamp>-<tag>/` contains:
- `steps.jsonl`: write-ahead steps.
- `runner-1.journal.jsonl` and `runner-2.journal.jsonl`: normalized observations.
- `report.json`: the verdict, failures, preset, binary (realpath, sha256, the version from the production offline probe), ids, the
  marker's sha256, per-turn facts, native plans, engine-reported session ids, Codex threads, the store's inbound, executions and
  conversations, ledger kind counts, exit evidence, and `cleanup` (what happened to the database, the scratch tree and the shim).
- `replies.json` (mode 0600): each turn's delivered reply, written the moment it is seen. This is the one place message text is
  written, so the Russian answers outlive the store. The recalls carry the disposable marker.

Apart from `replies.json`, no message text, tool output, argv or env value, usage `raw`, credential path or marker plaintext is written.

Cleanup order:
1. Runners (and their engines), then the door, then the cluster. The cluster helper removes its own directory once the server is
   shown stopped.
2. `report.json` is written.
3. The scratch tree (registry, state with the engines' native sessions, person tree) and the PATH shim are removed, unless
   `--keep-scratch` was given. Only directories this run created with its own `hub-prove-` prefix are touched. They are kept if any
   runner or recorded engine process is still alive; that run is `CLEANUP_UNVERIFIED`.
4. An empty `private/` is removed.
5. `report.json` is written again, with `cleanup.scratch` set to `removed`, `kept_on_request`, `kept_process_alive` or
   `removal_failed`. A failed removal is `CLEANUP_UNVERIFIED`.

Exit codes:

| Code | Verdict |
|---|---|
| 0 | `PASS_SCOPED` |
| 1 | `FAIL` (every failure named) |
| 2 | `REFUSED` (preflight; nothing started) |
| 4 | `CLEANUP_UNVERIFIED` or `INTERRUPTED` (cleanup overrides everything) |

## Two hosts: the return move (`live/prove-return-move.ts`)

One real Claude conversation is moved Mac → Pi → Mac by the shipped movement machinery. The second move is a RETURN onto the Mac's
retained copy. The script runs on the Mac and reaches the Pi over ssh only (BatchMode, strict host keys).

**What runs:**
- One throwaway Postgres on the Mac. The Pi reaches it through an ssh reverse forward bound to the Pi's loopback.
- A registry with two machines (`store_machine = "mac"`), each with its own state directory, person tree and credential path. It is
  cloned to the Pi once; after that, only `deliverRegistry` changes the Pi's copy.
- On each host, as separate processes:
  - the hub's registry delivery (`live/prove-hub-loop.ts`: `deliverRegistry`, `recordRegistryDigest`, `registerMoves`, in
    `hub/run.ts` order);
  - the production runner (`live/prove-engine-runner-child.ts`, stopped over ssh by closing its stdin).
- The door, on the Mac, on the fake platform.

**How the move is asked for:** the model itself calls the production `hub_topic` tool, because the owner asked in the chat. The owner's
message states its own id, because the shipped feed does not show the model message ids.

**Scenario:**
1. Mac: read marker A with a tool, without saying it.
2. Mac: the owner asks to move to pi. Wait until the move is active.
3. Pi: recall A, with no tool.
4. Pi: read marker B with a tool, without saying it.
5. Pi: the owner asks to move back. Wait until the move is active.
6. Mac: recall A and B, with no tool.

**Also judged:**
- The Mac's retained archive holds A and not B: it is the old copy.
- The current session holds both.
- Every start on the Pi and after the return resumed the same native id.
- Both source engines were gone after their move.
- The ledger has `move.return-archived` and `move.return-reconciled`.

Each marker sits at the top of its tree and is removed before the move that leaves that tree. The move refuses any tree entry it neither
carries nor verifies (`workspace_carriage_required`), and that includes an emptied directory.

```sh
BUN_FEATURE_FLAG_DISABLE_SQL_AUTO_PIPELINING=1 bun live/prove-return-move.ts --pi <user@host> \
  --pi-src <abs packages/plugin-hub on the pi> --pi-bun <abs bun on the pi> \
  --mac-bin <abs claude 2.1.286> --pi-bin <abs claude 2.1.285> \
  --mac-credential <abs .credentials.json> --pi-credential <abs .credentials.json on the pi> \
  --model <id> [--effort low] --evidence-dir <abs dir> [--move-timeout-ms 900000] [--keep-scratch] [--keep-stderr] --allow-paid-call
```

**Output and cleanup:**
- Output goes to `<evidence>/return-move-<stamp>-<tag>/`, with the same exit codes as above.
- The report and replies are saved first.
- Then the runners, the door, the hubs, the forward, the cluster and both hosts' scratch are removed.

## Not covered

- A Codex or OpenCode move: Codex and OpenCode have no native session port (`native_port_missing`).
- Interrupted-tool recovery (`safeResume`).
- Long or compacted sessions.
