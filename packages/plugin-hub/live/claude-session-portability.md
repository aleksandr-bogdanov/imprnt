# Native-session portability MEASUREMENT harness (IMP-231, disposable)

`live/claude-session-portability.ts` measures whether a Claude Code session started on one host can be resumed on another,
at a **different realpath**, from an exact reviewed set of its own files. It is **not** a production exporter or runtime,
it validates **no** `VALIDATED_*` table entry, and a pass says nothing beyond the one observed pair. It is not part of CI.
Importing it has no side effects; nothing runs until a phase is invoked by name with `--allow-paid-call` (paid phases).

Companions: `live/claude-session-portability-files.ts` (inventory, manifest, export/import over the accepted transfer
library), `live/claude-session-portability-fixture.ts` (the stdio MCP fixture), `test/claude-session-portability*.test.ts`
(offline, fake adapter, no Claude/network/box).

## Facts, assumptions, unknowns

**Facts relied on** (from the code, not measured here): the production launch (`makeLoopLaunch` via the `claude-code`
adapter) runs in `realpath(sessionDir)` with `CLAUDE_CONFIG_DIR=<sessionDir>/config`, `HOME=<sessionDir>/home`, the login in
a separate directory; it rewrites `box.sb`, `mcp.json`-config and `instructions.md` at every launch; the adapter reports
the engine's session id, results, tool-action names, and a production `exitEvidence`.

**Assumptions made by this harness (review them):**
- **Tool profile = what an ordinary master gets.** The harness's agent names NO tools, so production `prepareLaunch` injects the
  build's `VALIDATED_ORDINARY_PROFILES[version]` as the explicit `--tools` list (the nine builtins), beside the fixture MCP tool,
  with delegation denied by the production launch in every phase. `checkLaunch` is bound to the version the harness's own
  preflight reported and refuses (before any process) an empty list, any other list, or a build with no profile. The report's
  `launch.tools_from_argv` is read back from the actual argv. This is **test fidelity** to the launch ordinary masters get; it grants the
  model nothing new in the product.
- **Tool use is judged, not blocked.** The prompts ask for no tool except the one fixture call in source turn 1. Source turn 1
  must show exactly one action (the fixture) and exactly one tool result; source turn 2, calibration and resume must show no tool
  action and no tool result (counted independently, so a bare result fails too). A builtin could in principle read the handoff
  or a transcript: that is detected afterwards as a failure and bounded by the production box, not prevented here, and a resume
  that reached its answer with any tool is a failure whatever it said. Neither answer is ever in the resumed argv, env,
  instructions or prompt (refused before any process otherwise).
- **Interrupts.** The first SIGINT/SIGTERM/SIGHUP sets a synchronous sticky flag (a promise resolves too). It is read before
  prepare, before the write-ahead record and start, before every feed, and again when the decision is taken, so a signal at any
  point (prepare, a result callback, close, finalization) yields `INTERRUPTED` and can never publish a handoff, archive the
  calibration or feed the next turn. Cleanup after a signal is still done and bounded; an unverified loop (exit 4,
  `CLEANUP_UNVERIFIED`) takes precedence. A second signal does nothing; SIGKILL remains the only way out of a stuck harness.
- **Bounds.** One deadline per turn (`--turn-timeout-ms`) covers the feed as well as the result, so a feed that never settles
  times out like a missing result. A feed that rejects late is consumed; a result that arrives before the flush settles is recorded
  (`feed_settled: false`, failure `turn_N_feed_unsettled`) and nothing further is fed. `session.close()` is waited for 10 s, then
  `close_timed_out: true` is recorded and the production `exitEvidence`, then (if unconfirmed) `interrupt`, decide; a late
  close failure is consumed. There is **no** timeout around `adapter.start`: production `open` throws only before it spawns, and
  a timeout there could orphan a late child. The production `exitEvidence`/`interrupt` are bounded by production, not here.
- **Process record.** Right after the child is acquired, before any feed, `phase-<kind>.process.json` records its pid, process
  group and observed processes as the production session reports them, so an operator can look by hand if the harness is
  killed. It is diagnostic only: **nothing is ever signalled from it**. If it cannot be written, nothing is fed and cleanup
  still happens.
- Weekly quota is the highest of the adapter's window reading and its `seven_day` window, checked after each completed turn.
- The conversation id (the session directory's last segment) is carried to the destination, as it would be in a real move;
  only the state root differs, so the realpaths differ by that prefix.

**Unknowns this measures (named, never assumed):** where the CLI keeps a transcript for a given realpath (measured once per
destination path by `calibrate`; no encoding rule is computed anywhere); which files beyond the transcript a resume needs
(the resume outcome is the only evidence); behaviour across builds and OS pairs.
**Not observed** (the production adapter does not expose them): init `tools`, `mcp_servers`, `cwd`. The engine-reported
session id is read at the first receipt/progress of the turn and again at the result.
A native path-resume route is **not** assumed or used; inspect `claude --help` yourself if you want to propose one.

## Prerequisites on each host

- This checkout of `packages/plugin-hub`, `bun`, run as the runner's own non-root account. Linux needs `/usr/bin/bwrap`.
- The CLI build under test, exactly: `--cli <abs path>` must be the real file `claude` resolves to on `PATH`
  (`env PATH=<dir with claude first>:$PATH ...`), and `--expect-cli-version` must equal what it reports and be in
  `VALIDATED_SAFE_RESUME` and `VALIDATED_TOOL_CONTROL`. No fallback model: the model is fixed (`claude-sonnet-5-5`, effort low).
- A LOCAL login FILE you select explicitly (`<dir>/.credentials.json`; one made with
  `CLAUDE_CONFIG_DIR=<dir>/config CLAUDE_SECURESTORAGE_CONFIG_DIR=<dir> claude auth login` has that shape). Pass it as `--login-file`.
  **The harness never opens, copies or logs it**; the production launch does. Its path and directory are scrubbed from every
  artifact and printed line. Keep the evidence directory outside `<dir>`.
  *Operational note:* the CLI the production launch starts may refresh or rewrite that login while it runs, which is a side effect
  on whatever else uses the same file. Nothing here establishes how refresh tokens behave under concurrent use, so none is claimed.
  A dedicated probe login made beforehand is one option; it is not required by this harness and is not a reason to stop or change
  any live runner. This harness creates no authentication, copies no credentials and stops nothing. The actual preflight choice
  (which login, which host) is made by the person running it, on their own evidence and authorization.
- **A symlink anywhere inside the session tree** (for instance one the CLI itself makes) makes the inventory refuse the whole run by
  name (`inventory_...`): conservative, no guessed ignore list, no whole-directory exporter. The paid run would then have produced no
  exportable measurement; that is a named finding, not something the harness works around.
- An existing, dedicated evidence directory. **Do not put these words in its path: credential, secret, token, oauth, keychain,
  login, passw, api-key, setting, account** (the CLI encodes the cwd into a project-directory name, and the export refuses
  credential-shaped names, including that one).
- Run every phase with stderr redirected to a file under your scratch: the adapter inherits the CLI's stderr.
- The fixture MCP script is copied into the run's `fixture/` directory (a path the box grants for writing, hence reading) and run
  by `bun` (`process.execPath`). On macOS the box reads only `/private/tmp`, `~/.bun`, `~/.local`, the brew prefix and granted
  paths, so `bun` must live in one of those. The evidence directory itself may be anywhere else that passes the checks above.

## Order, one host step at a time

Substitute `H=packages/plugin-hub`, `E=<evidence dir on that host>`, `L=<login file>`, `C=<cli path>`, `V=<version>`.

1. **SOURCE host — `source`** (paid: ONE process, TWO turns). Synthetic person/tree, fresh UUID, random marker, one fixture
   effect, a recall control turn, inventory of the owned session tree before/after, process-exit evidence.
   ```
   bun $H/live/claude-session-portability.ts source --evidence-dir $E --login-file $L --cli $C --expect-cli-version $V --allow-paid-call 2>$E/source.stderr
   ```
   Inspect `$E/source-*/phase-source.report.json` (verdict `PASS_SCOPED`, `fixture.effect_count` 1, `process.confirmed` true,
   `weekly_pct_seen`) and `inventory.source.after.json` (what a session writes). The diff in the report is **a question, not
   an ownership claim**. If the verdict is not `PASS_SCOPED` there is no `handoff.json` and nothing may go further.
2. **Transfer `source-*/handoff.json`** (synthetic marker + tool result; the only content-bearing artifact) to the destination host.
3. **DESTINATION host — `calibrate`** (paid: ONE process, ONE turn, fresh independent UUID, asked to use no tool; any tool action or result fails it). Measures where this CLI
   puts a transcript at the destination's own session path (same conversation id, destination state root), then archives that
   directory under `calibration-archive/` so the import finds the session path absent. It is never the resumed source.
   ```
   bun $H/live/claude-session-portability.ts calibrate --evidence-dir $E --handoff <handoff.json> --login-file $L --cli $C --expect-cli-version $V --allow-paid-call 2>$E/calibrate.stderr
   ```
   Inspect `dest-*/phase-calibrate.report.json`: `locator.project_dir`, `locator.cwd_realpath` vs `source_cwd_realpath`,
   `locator.cwd_differs_from_source`, `same_machine_as_source` / `acceptance_eligible`. Same machine or same realpath is harness
   debugging only, **not** Mac↔Pi acceptance.
4. **Transfer `dest-*/phase-calibrate.report.json`** to the source host.
5. **ROOT writes the reviewed manifest** (see below), after inspecting steps 1 and 3.
6. **SOURCE host — `export`** (no model call).
   ```
   bun $H/live/claude-session-portability.ts export --run-dir $E/source-<id> --manifest <manifest.json> --calibration-report <phase-calibrate.report.json>
   ```
   Re-inventories the live source tree and refuses if it changed since step 1; checks the manifest; captures exactly the named
   files with the transfer library's stable, link-refusing reads; writes `source-<id>/export-<export id>/` (`export.json`,
   `manifest.json`, `blobs/<sha256>`). Bytes are verbatim; the only change is the explicitly reviewed project-directory path segment.
   Each run of `export` writes its own indexed `phase-export.<k>.report.json`; **its `export.bundle_digest` identifies the export root
   reviewed.** Note that digest (64 hex).
7. **Transfer `export-<export id>/`** to the destination host (nothing is sent by the harness).
8. **DESTINATION host — `import`** (no model call).
   ```
   bun $H/live/claude-session-portability.ts import --run-dir $E/dest-<id> --export-dir <export-dir> --expect-bundle-digest <64 hex bundle_digest from the reviewed export report>
   ```
   `--expect-bundle-digest` is **required** and is the operator's own selection: nothing picks "the latest" or "the only" export. It is
   matched against the envelope AND the independently verified bundle read back from the export directory, before the destination is
   looked at, created or staged; a wrong or malformed digest is a named refusal (`export_not_the_selected_bundle`,
   `expect_bundle_digest_shape`), an absent destination stays absent and a foreign one is untouched. Then it binds the export to this
   destination's journal, the source run and this calibration; creates the **absent** session directory with the library's exclusive
   mkdir. An existing directory, empty or not, is `dest_session_collision` and is left untouched.
9. **DESTINATION host — `resume`** (paid: ONE process, ONE turn). `--resume <source uuid>` through a regenerated launch from
   local parameters and the local login; asks for the marker and the earlier tool result **without including either**, with no
   original input replay and any tool action or tool result a failure. Refuses first if either answer would appear in argv, env, instructions or the prompt, or
   if the destination changed since the import.
   ```
   bun $H/live/claude-session-portability.ts resume --run-dir $E/dest-<id> --login-file $L --cli $C --expect-cli-version $V --allow-paid-call 2>$E/resume.stderr
   ```
   For the other direction, swap the hosts (Pi source, Mac destination) and run the whole sequence again.

Total paid processes per direction: **3** (source 1, calibration 1, resume 1). A retry is not built in; a refused or failed
resume spends the destination run (a new `calibrate` makes a new one). Reports list `invocations` with kind, UUID and counts.

## The reviewed export manifest (root writes it)

Exact keys, nothing guessed. `run_id`/`journal_nonce` are in the source `journal.json` (`run_id`, `nonce`); `native_session` is
`session.requested_id` in the source report; `source_project_dir` is `inventory.project_dir_measured` there; `dest_project_dir`,
`calibration_run_id` are `locator.project_dir`, `run_id` in the calibration report; the sha is `shasum -a 256` of that report file.
```json
{ "version": 1, "kind": "claude-session-export-manifest",
  "run_id": "source-…", "journal_nonce": "<32 hex>", "native_session": "<uuid>",
  "files": [ { "path": "config/projects/<src dir>/<uuid>.jsonl", "sha256": "…", "size": 0, "mode": 420,
               "dest_path": "config/projects/<dest dir>/<uuid>.jsonl" } ],
  "locator": { "source_project_dir": "<src dir>", "dest_project_dir": "<dest dir>",
               "calibration_run_id": "dest-…", "calibration_report_sha256": "…" } }
```
- `path`/`sha256`/`size`/`mode` come from `inventory.source.after.json`. 1–64 regular files, ≤16 MiB each, ≤64 MiB total, all under `config/`.
- `dest_path` is **required** exactly when the measured project directories differ, and then must be that one segment renamed;
  otherwise it must be absent. A mapping without measured evidence, or missing where needed, is a named refusal.
- Refused by name, regardless of the manifest: credential-shaped names, `.claude.json*`, `settings*`, `backups/`, anything named
  `account`, `home/`, `tmp/`, `box.sb`, `mcp.json`, `instructions.md`, the library marker, links, files not in the measured
  inventory or whose size/mode/sha256 differ, and a manifest that omits the session's own `<uuid>.jsonl`.

## Artifacts and what may travel

| artifact | where | travels? |
|---|---|---|
| `handoff.json` | source run | yes, to the destination (synthetic marker/result) |
| `phase-calibrate.report.json` | dest run | yes, to the source (for the export) |
| `export-<id>/` | source run | yes, to the destination |
| `phase-source.report.json`, `phase-calibrate.report.json`; `phase-{export,import,resume}.<k>.report.json`; `inventory.*.json` | each run | root reads them; coordinator-safe (no marker, result, assistant text or login path) |
| `private/` (`secrets.json`, `turns.*.json`), `fixture/effects.jsonl` | each run | **never** (raw fixture evidence, mode 0600) |
| `journal.json`, `phase-*.started.json` | each run | no (immutable run identity / write-ahead record) |
| `phase-{source,calibration,resume}.process.json` | each run | no (diagnostic pid/group/processes of the started child; never a basis for signalling) |

Nothing here deletes anything: runs, evidence, archived calibration directories and imported sessions are all kept.

## Verdicts and exit codes

`0 PASS_SCOPED` · `1 FAIL` (a judgment did not hold) · `2 REFUSED` (a named, exactly-scoped refusal; includes measured negatives
such as `turn_1_engine_session_id_mismatch`, `marker_not_recalled`, `fresh_transcript_elsewhere`, `locator_unmeasured`,
`resume_engine_exited_without_result`, `imported_prefix_not_preserved`) · `3 STOPPED_QUOTA` (weekly ≥95% or a window refusal; no retry) · `4` `CLEANUP_UNVERIFIED`
or `INTERRUPTED`. **Cleanup overrides everything**: a started loop not confirmed gone by the production `exitEvidence` (after one
production `interrupt` if it was not) is 4 whatever else held, and no handoff is made. Nothing is ever killed by a pid or group
number this harness chose. A failed resume never starts a fresh session.

The resume also judges that the imported transcript's bytes are still the prefix of the transcript after the resume
(`imported_prefix_not_preserved` is a refusal; an unmeasurable prefix, `imported_prefix_evidence_missing`, is a failure). This is a
bounded synthetic measurement of this one resume, **not** a universal or permanent prohibition on legitimate CLI compaction of a
real session, and not a native transcript editor.

An `INTERRUPTED` verdict (exit 4) means a signal was seen and nothing was handed off or archived; with no process started the
outcome says so. A `close_timed_out` in `process` is a recorded fact; the verdict still follows the production exit evidence.

## Offline checks (root runs these first)

```
cd packages/plugin-hub
bun test test/claude-session-portability.test.ts test/claude-session-portability-files.test.ts
bun run typecheck
```
They spawn only the local fixture MCP server; no Claude, network, box, database or service manager.
