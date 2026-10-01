// DISPOSABLE native-session portability MEASUREMENT harness (IMP-231). Not a production exporter, not a runtime,
// not CI. Operator usage: live/claude-session-portability.md. Importing this module has no side effects.
//
//   bun live/claude-session-portability.ts <phase> [flags]
//
// Phases, each run explicitly, one host step at a time, each leaving durable evidence the next one checks:
//   source     SOURCE host. Synthetic person/tree, production makeLoopLaunch + production claude-code adapter, two bounded
//              turns (random marker + one fixture tool call + recall control). Inventory of the owned session tree.
//   calibrate  DESTINATION host. One bounded fresh synthetic invocation at the destination's own session path, to MEASURE
//              where the CLI keeps a transcript for that realpath. Never substitutes for the resumed source.
//   export     SOURCE host, no model call. Root's reviewed exact file manifest -> bundle (transfer library), bound to run.
//   import     DESTINATION host, no model call. Reviewed bundle -> an ABSENT session directory (exclusive create).
//   resume     DESTINATION host. `--resume <source uuid>`; asks for the marker and tool result without giving either.
//
// Exit codes (the cleanup override is the rule: a started process not verified gone is 4 whatever else is true):
//   0 PASS_SCOPED  1 FAIL  2 REFUSED (named, exactly scoped)  3 STOPPED_QUOTA  4 CLEANUP_UNVERIFIED or INTERRUPTED
//
// What a PASS_SCOPED is: the listed judgments held for ONE observed pair. It validates no table entry and asserts no
// portability beyond that pair. Nothing here retries, substitutes a model, or starts a fresh session after a failed resume.

import { createHash, randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync } from "node:fs";
import { arch, homedir, hostname, release } from "node:os";
import { basename, dirname, isAbsolute, join, sep } from "node:path";
import { parseArgs } from "node:util";
import type { Adapter, AdapterSession, AdapterUsage, ExitEvidence, PreparedLaunch, TurnEnd } from "../src/adapters/types.ts";
import { claudeCode, VALIDATED_ORDINARY_PROFILES, VALIDATED_SAFE_RESUME, VALIDATED_TOOL_CONTROL } from "../src/adapters/claude-code.ts";
import { loopCapabilitiesFor, NATIVE_DELEGATION_TOOLS, type LoopLaunchInput } from "../src/adapters/launch.ts";
import type { CredentialEntry } from "../src/registry/load.ts";
import type { Preset } from "../src/registry/presets.ts";
import { sha256Hex } from "../src/transfer/bundle.ts";
import {
  describe, diffInventory, exportNative, fileSha256, freshTranscripts, importNative, inventoryTree, isUnchanged, jsonlFiles, makeRedactor, NONCE, parseReviewedManifest,
  persistJson, prefixPreserved, projectDirOf, readEffects, readJournal, readJson, rec, Refusal, RUN_ID, scanForLeaks, SHA256, text, transcriptsNamed, UUID,
  validateReviewed, writeExclusive, type Effects, type HostFacts, type Inventory, type InventoryView, type Journal, type Redactor,
} from "./claude-session-portability-files.ts";

export const SCHEMA = "claude-session-portability/1";
export const PERSON = "p1";
export const AGENT = "p1-lair";
export const MODEL = "claude-sonnet-5-5";
export const EFFORT = "low";
export const QUOTA_STOP_PCT = 95;
export const TURN_TIMEOUT_MS = 120_000;
export const FIXTURE_TOOL = "mcp__fixture__fixture_effect";
const PRESET: Preset = { adapter: "claude-code", model: MODEL, provider: "anthropic", effort: EFFORT, paid: "plan" };

/** The only environment keys a production launch hands the CLI. Anything else in a launch is refused, by name. */
const ALLOWED_ENV = new Set([
  "PATH", "LANG", "LC_ALL", "TZ", "HOME", "TMPDIR", "CLAUDE_CONFIG_DIR", "CLAUDE_SECURESTORAGE_CONFIG_DIR",
  "CLAUDE_CODE_DISABLE_AUTO_MEMORY", "CLAUDE_CODE_DISABLE_CLAUDE_MDS", "CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS",
  "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "IMPRNT_VAULT",
]);

export const SCOPE =
  "Measurement of ONE (source host/OS/CLI build -> destination host/OS/CLI build) pair with a synthetic session, one synthetic MCP " +
  "fixture and the production boxed launch (production makeLoopLaunch + claude-code adapter; the agent names no tools, so production " +
  "injects the build's VALIDATED_ORDINARY_PROFILES entry as an explicit list; delegation denied in every phase). The model is told to use " +
  "no tool except the one fixture call in source turn 1, and any other tool action or tool result in any phase is a failure. This is " +
  "test fidelity to the launch ordinary masters get, not a grant of new access in the product. " +
  "A PASS_SCOPED says only what the listed judgments observed. It validates no VALIDATED_* table entry and is not evidence for " +
  "another version, OS pair, tool set, session length, real transcript or real person.";
export const LIMITS_TEXT = [
  "The production adapter does not expose raw init or stream events: observed are the engine-reported session id (at the first receipt/progress and at the result), each turn's result, tool action names and the fixture's own effect log. Init tools, mcp_servers and cwd are NOT observed here.",
  "Tool calls are counted from the adapter's progress events (tool_use block starts) and, independently, from the fixture's fsynced effect log.",
  "Process cleanup is the production adapter's exitEvidence (the loop's own process group and every process seen under it). A process that left the group unseen, or an effect outside the process table, is not covered.",
  "Weekly utilization is the highest of the adapter's window reading and the seven_day window after each completed turn (a fraction is read as a share of 1.0); a reading can lag the provider.",
  "The adapter inherits the CLI's stderr: run each phase with stderr redirected to a file under your own scratch, never to the coordinator.",
  "Raw assistant text is kept only under private/ (0600) in the run directory and is never printed or put in a report.",
  "Archiving the calibration directory is a rename onto a name verified absent immediately before, inside a 0700 directory this run created; rename is not an atomic no-replace.",
  "An inventory diff says what changed on disk, not what is session-owned. Ownership is the reviewer's decision in the export manifest.",
  "With builtin tools present, a tool used against the prompt is detected after the fact (a failure) and bounded by the production box; it is not prevented here.",
  "The imported-prefix judgment is a bounded synthetic measurement of this one resume: it is not a universal or permanent prohibition on a CLI's legitimate compaction, and not a native transcript editor.",
  "A symlink anywhere in the session tree makes the inventory refuse by name; there is no guessed ignore list and no whole-directory exporter.",
  "The process record `phase-<kind>.process.json` is diagnostic only (pid, group and processes as the production session reported them); nothing is ever signalled from it.",
];
export const UNKNOWNS = [
  "whether the CLI's transcript locator is deterministic in the destination realpath (measured once by calibrate, for one path)",
  "whether any file beyond the transcript is needed to resume (the resume outcome is the only measurement)",
  "whether a native path-resume route exists in this CLI build (not assumed, not used)",
  "behaviour for other CLI builds, other OS pairs, long transcripts and sessions with real tools",
];

// ---------------------------------------------------------------------------------------------------------
// Dependencies: everything that touches a process, the clock, randomness or the host. Production values are built
// lazily by productionDeps(); tests pass fakes. Nothing here runs at import.

export interface LaunchAdapter {
  prepareLaunch(input: LoopLaunchInput): Promise<PreparedLaunch>;
  start: Adapter["start"];
}
export interface Deps {
  adapter: LaunchAdapter;
  /** What the installed CLI says about itself, asked of the production capability probe (no model call). */
  preflight(credential: CredentialEntry, cli: string): Promise<{ version: string; native: readonly string[] }>;
  /** A named refusal when `claude` on PATH is not the real file `--cli` names, else null. */
  resolveCli(cli: string): string | null;
  host(): HostFacts;
  uid(): number | null;
  bwrapPresent(): boolean;
  uuid(): string;
  hex(bytes: number): string;
  now(): Date;
  /** Resolves with a signal name when the operator interrupts. Never rejects. */
  interrupt: Promise<string>;
  /** The first signal's name, synchronously and stickily (set by the same handler that resolves `interrupt`), else null. Checked at every action boundary. */
  interrupted(): string | null;
  /** How long `session.close()` is waited for before the production exitEvidence/interrupt are asked anyway. */
  closeBoundMs: number;
  fixtureCommand: string;
  fixtureScript: string;
}

export const CLOSE_BOUND_MS = 10_000;

export function productionDeps(): Deps {
  let signalled: (name: string) => void = () => {};
  const interrupt = new Promise<string>(resolve => { signalled = resolve; });
  let first: string | null = null;
  // `on`, not `once`: a second signal must not take the default action in the middle of the cleanup this one asks for.
  // The first is the reason; a harness that is stuck can still be ended with SIGKILL, and its evidence stays on disk.
  for (const name of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(name, () => { if (first === null) first = name; signalled(first); });
  return {
    adapter: {
      prepareLaunch: input => {
        if (!claudeCode.prepareLaunch) throw new Error("adapter-without-prepareLaunch");
        return claudeCode.prepareLaunch(input);
      },
      start: options => claudeCode.start(options),
    },
    preflight: async (credential) => {
      const found = await loopCapabilitiesFor(credential, { bin: "claude" });
      return { version: found.version, native: found.native };
    },
    resolveCli: cli => {
      try {
        const found = Bun.which("claude", { PATH: process.env.PATH ?? "" });
        if (!found) return "claude_not_on_path";
        return realpathSync(found) === realpathSync(cli) ? null : "claude_on_path_is_not_cli_flag";
      } catch { return "cli_unresolvable"; }
    },
    host: () => ({ platform: process.platform, arch: arch(), release: release(), bun: Bun.version,
      machine: createHash("sha256").update(hostname()).digest("hex").slice(0, 12) }),
    uid: () => process.getuid?.() ?? null,
    bwrapPresent: () => existsSync("/usr/bin/bwrap"),
    uuid: () => crypto.randomUUID(),
    hex: bytes => randomBytes(bytes).toString("hex"),
    now: () => new Date(),
    interrupt,
    interrupted: () => first,
    closeBoundMs: CLOSE_BOUND_MS,
    fixtureCommand: process.execPath,
    fixtureScript: join(import.meta.dir, "claude-session-portability-fixture.ts"),
  };
}

// ---------------------------------------------------------------------------------------------------------
// Verdict: cleanup overrides everything

export type Phase = "source" | "calibrate" | "export" | "import" | "resume";
export type Verdict = "PASS_SCOPED" | "FAIL" | "REFUSED" | "STOPPED_QUOTA" | "INTERRUPTED" | "CLEANUP_UNVERIFIED";

export function decide(input: { failures: readonly string[]; refusals: readonly string[]; quota: boolean; interrupted: string | null;
  processStarted: boolean; cleanupConfirmed: boolean }): { verdict: Verdict; code: number; outcome: string } {
  const would = input.interrupted ? `interrupted by ${input.interrupted}` : input.quota ? "weekly quota stop" : input.refusals.length > 0
    ? `refused: ${input.refusals.join(", ")}` : input.failures.length > 0 ? `failed: ${input.failures.join(", ")}` : "every judgment held";
  if (input.processStarted && !input.cleanupConfirmed) {
    return { verdict: "CLEANUP_UNVERIFIED", code: 4, outcome: `cleanup-unverified: the started loop is not verified gone (evidence kept; would have been: ${would})` };
  }
  if (input.interrupted) {
    return { verdict: "INTERRUPTED", code: 4, outcome: `interrupted by ${input.interrupted}; ${input.processStarted ? "cleanup verified" : "no process was started"}; nothing was handed off` };
  }
  if (input.quota) return { verdict: "STOPPED_QUOTA", code: 3, outcome: "stopped: weekly utilization reached the guard or the window refused; no retry" };
  if (input.refusals.length > 0) return { verdict: "REFUSED", code: 2, outcome: would };
  if (input.failures.length > 0) return { verdict: "FAIL", code: 1, outcome: would };
  return { verdict: "PASS_SCOPED", code: 0, outcome: "every judgment held for this pair; nothing beyond it is claimed" };
}

// ---------------------------------------------------------------------------------------------------------
// Turn driving and cleanup, over the production AdapterSession

export type StopReason = "timeout" | "exited" | "refused" | "quota" | "feed-failed" | "feed-unsettled" | "interrupted";

export interface TurnFacts {
  /** `fed`: the feed resolved, or the engine answered it (so the message demonstrably arrived). `feed_settled`: the feed promise itself had settled when last looked at (it may settle late). */
  n: number; fed: boolean; feed_settled: boolean; ended: boolean; timed_out: boolean; exited_early: boolean; feed_error: string | null;
  refused_cause: string | null; refused_said: string; text: string;
  session_id: string | null; reported_at_first_event: string | null; reported_at_end: string | null;
  tool_actions: string[]; tool_results: number; resolved_models: string[];
  num_turns: number | null; output_tokens: number | null; weekly_pct: number | null;
}
export interface Driven { turns: TurnFacts[]; stopped: StopReason | null; interrupted_by: string | null }

const blankTurn = (n: number): TurnFacts => ({
  n, fed: false, feed_settled: false, ended: false, timed_out: false, exited_early: false, feed_error: null, refused_cause: null, refused_said: "", text: "",
  session_id: null, reported_at_first_event: null, reported_at_end: null, tool_actions: [], tool_results: 0, resolved_models: [],
  num_turns: null, output_tokens: null, weekly_pct: null,
});

const message = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 200);

export function weeklyPercent(usage: AdapterUsage): number | null {
  const seen: number[] = [];
  const add = (value: unknown) => { if (typeof value === "number" && Number.isFinite(value)) seen.push(value <= 1 ? value * 100 : value); };
  add(usage.window?.utilization);
  add((usage.plan_usage as { seven_day?: { utilization?: unknown } } | null)?.seven_day?.utilization);
  return seen.length > 0 ? Math.max(...seen) : null;
}

export interface DriveOptions { timeoutMs: number; interrupt: Promise<string>; interrupted: () => string | null }

/**
 * Feed each prompt once and wait for its end, ONE bounded deadline per turn that starts before the feed (so a feed that never
 * settles times out like a result that never comes), and stop before the next on a refusal, quota reading, exit, timeout, feed
 * failure or interrupt. The interrupt flag is read before every feed. A feed still pending when the engine's result arrives is
 * recorded as such and nothing further is fed (a flush the harness cannot account for is never followed by a second message).
 * The feed promise is always consumed here, so a late rejection can neither be unhandled nor turn into a feed success.
 */
export async function driveTurns(session: AdapterSession, prompts: readonly string[], options: DriveOptions): Promise<Driven> {
  const turns: TurnFacts[] = [];
  let current: TurnFacts | null = null;
  let deliver: ((end: TurnEnd) => void) | null = null;
  const early = () => {
    if (current && current.reported_at_first_event === null) current.reported_at_first_event = session.reportedSessionId ?? null;
  };
  session.onReceipt(early);
  session.onProgress(event => {
    early();
    if (!current) return;
    if (event.kind === "action") current.tool_actions.push(event.text);
    else if (event.kind === "action_result") current.tool_results++;
  });
  session.onTurnEnd(end => { deliver?.(end); });
  let stopped: StopReason | null = null;
  let interruptedBy: string | null = null;
  for (const [index, prompt] of prompts.entries()) {
    const already = options.interrupted();
    if (already !== null) { interruptedBy = already; stopped = "interrupted"; break; }
    const facts = blankTurn(index + 1);
    turns.push(facts);
    current = facts;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settle!: (got: TurnEnd | "exited" | "timeout" | "feed-failed" | { interrupted: string }) => void;
    const outcome = new Promise<TurnEnd | "exited" | "timeout" | "feed-failed" | { interrupted: string }>(resolve => {
      settle = resolve;
      deliver = end => resolve(end);
      void session.exited?.then(() => resolve("exited"), () => resolve("exited"));
      void options.interrupt.then(name => resolve({ interrupted: name }));
      timer = setTimeout(() => resolve("timeout"), options.timeoutMs);
    });
    // The feed is started, not awaited: its settling is one more way for the turn's outcome to be decided, never a wait of its own.
    void (async () => {
      try { await session.feed({ id: `turn-${index + 1}`, text: prompt }); facts.feed_settled = true; facts.fed = true; }
      catch (error) { facts.feed_settled = true; facts.feed_error = message(error); settle("feed-failed"); }
    })();
    const got = await outcome;
    clearTimeout(timer);
    deliver = null;
    if (got === "feed-failed") { stopped = "feed-failed"; break; }
    if (got === "exited") { facts.exited_early = true; stopped = "exited"; break; }
    if (got === "timeout") { facts.timed_out = true; stopped = "timeout"; break; }
    if ("interrupted" in got) { interruptedBy = got.interrupted; stopped = "interrupted"; break; }
    if (!facts.feed_settled) facts.fed = true; // the engine answered: the message arrived whatever its flush is still doing
    facts.ended = true;
    facts.text = got.text;
    facts.session_id = got.session_id;
    facts.reported_at_end = session.reportedSessionId ?? null;
    facts.refused_cause = got.refused?.cause ?? null;
    facts.refused_said = got.refused?.said ?? "";
    facts.resolved_models = got.usage.resolved_model_ids ?? [];
    facts.num_turns = typeof got.usage.raw.num_turns === "number" ? got.usage.raw.num_turns : null;
    facts.output_tokens = got.usage.output_tokens;
    facts.weekly_pct = weeklyPercent(got.usage);
    if (facts.refused_cause !== null) { stopped = facts.refused_cause === "window" ? "quota" : "refused"; break; }
    if ((facts.weekly_pct ?? 0) >= QUOTA_STOP_PCT) { stopped = "quota"; break; }
    if (!facts.feed_settled) { stopped = "feed-unsettled"; break; }
  }
  return { turns, stopped, interrupted_by: interruptedBy };
}

export interface CleanupFacts {
  attempted: boolean; confirmed: boolean; close_error: string | null; close_timed_out: boolean; interrupt_used: boolean; evidence: ExitEvidence | null;
  evidence_error: string | null; observed_before_close: number[] | null;
}

/**
 * After the phase is over (or was stopped): close the session (waited for at most `closeBoundMs`, because production `shut`
 * has no bound of its own), ask the production exitEvidence, and only when that is not confirmed ask the production interrupt
 * (its own verified group, tools first), then ask again. A close that outlives its bound is recorded (`close_timed_out`) and
 * left running; a failure of it that arrives later is consumed into `close_error`. Nothing is signalled by pid or group
 * number from here. Anything unconfirmed stays unconfirmed, with its evidence.
 */
export async function stopAndVerify(session: AdapterSession, closeBoundMs: number): Promise<CleanupFacts> {
  const facts: CleanupFacts = { attempted: true, confirmed: false, close_error: null, close_timed_out: false, interrupt_used: false, evidence: null,
    evidence_error: null, observed_before_close: null };
  facts.observed_before_close = safe(() => session.processes?.() ?? null);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const closing = (async () => { await session.close(); })().then(() => "closed" as const, error => { facts.close_error = message(error); return "closed" as const; });
  const bound = new Promise<"timeout">(resolve => { timer = setTimeout(() => resolve("timeout"), closeBoundMs); });
  if (await Promise.race([closing, bound]) === "timeout") facts.close_timed_out = true;
  clearTimeout(timer);
  try {
    if (!session.exitEvidence) throw new Error("session-has-no-exitEvidence");
    facts.evidence = await session.exitEvidence();
    if (!facts.evidence.confirmed && session.interrupt) {
      facts.interrupt_used = true;
      facts.evidence = await session.interrupt({ graceMs: 3000 });
    }
  } catch (error) { facts.evidence_error = message(error); }
  facts.confirmed = facts.evidence?.confirmed === true && facts.evidence_error === null;
  return facts;
}

// ---------------------------------------------------------------------------------------------------------
// Launch guards, prompts, judges (pure)

/** The tools a launch carries, read from its own argv (null when there is no `--tools`). The reported profile is this, never a fixed string. */
export const toolsOf = (launch: PreparedLaunch): string[] | null => {
  const argv = launch.argv ?? [], at = argv.indexOf("--tools");
  return at >= 0 && typeof argv[at + 1] === "string" ? argv[at + 1].split(",").filter(one => one !== "") : null;
};

/** `want.version` is the build the harness's own preflight reported: the profile the launch must carry is that build's production entry. */
export function checkLaunch(launch: PreparedLaunch, want: { sessionDir: string; model: string; effort: string; version: string }): string[] {
  const bad: string[] = [];
  const argv = launch.argv ?? [], env = launch.env ?? {};
  const after = (flag: string) => { const at = argv.indexOf(flag); return at >= 0 ? argv[at + 1] : undefined; };
  const inside = (value: string | undefined) => typeof value === "string" && (value === want.sessionDir || value.startsWith(`${want.sessionDir}${sep}`));
  if (typeof launch.wrap !== "function") bad.push("no_box_wrap");
  if (launch.cwd !== want.sessionDir) bad.push("cwd_is_not_session_dir");
  if (argv[0] !== "claude") bad.push("argv0_is_not_claude");
  if (after("--model") !== want.model) bad.push("model_not_requested");
  if (after("--effort") !== want.effort) bad.push("effort_not_requested");
  // Not an empty list and not the harness's own choice: exactly what production injects for an ordinary agent that names no tools on this build.
  const profile = VALIDATED_ORDINARY_PROFILES[want.version];
  if (profile === undefined || profile.length === 0) bad.push("ordinary_profile_unvalidated_for_version");
  else if (after("--tools") !== profile.join(",")) bad.push("tools_not_validated_ordinary_profile");
  if (after("--disallowedTools") !== NATIVE_DELEGATION_TOOLS.join(",")) bad.push("delegation_not_denied");
  if (after("--setting-sources") !== "") bad.push("setting_sources_not_empty");
  if (!argv.includes("--strict-mcp-config")) bad.push("mcp_not_strict");
  if (argv.some(arg => /^--(fallback|advisor)/i.test(arg) || arg === "--resume" || arg === "--session-id" || arg === "--continue")) bad.push("unexpected_routing_or_session_flag");
  if (Object.keys(env).some(key => !ALLOWED_ENV.has(key))) bad.push("unexpected_env_key");
  if (!inside(env.CLAUDE_CONFIG_DIR)) bad.push("config_dir_not_in_session");
  if (!inside(env.HOME)) bad.push("home_not_in_session");
  if (!inside(env.TMPDIR)) bad.push("tmp_not_in_session");
  if (typeof env.CLAUDE_SECURESTORAGE_CONFIG_DIR !== "string" || env.CLAUDE_SECURESTORAGE_CONFIG_DIR === "") bad.push("login_dir_not_set");
  return bad;
}

export const sourcePrompts = (marker: string): string[] => [
  `Synthetic portability test. Remember this marker exactly: ${marker}. Call the tool ${FIXTURE_TOOL} exactly once with no arguments, wait for its result, then reply with only the word DONE. Use no other tool.`,
  "Without using any tools: reply with the marker I gave you and the exact text the tool returned, separated by a single space, and nothing else.",
];
export const CALIBRATION_PROMPT = "Reply with the single word OK. Do not use any tools.";
export const RESUME_PROMPT =
  "This is a resumed conversation. Do not use any tools and do not repeat any earlier action. Reply with the marker I gave you earlier and the exact text the fixture tool returned earlier, separated by a single space, and nothing else.";

/** The engine's own statement of its session: at the first event of the turn, else at the end of it. */
const engineId = (turn: JudgedTurn) => turn.reported_at_first_event ?? turn.reported_at_end;

export interface Judged { failures: string[]; refusals: string[] }

/** A turn as judged: the live facts, or the public ones a saved report keeps (which count the text's characters instead of holding the text). */
export type JudgedTurn = Omit<TurnFacts, "text" | "refused_said"> & { text?: string; text_chars?: number };
const emptyText = (turn: JudgedTurn) => (turn.text !== undefined ? turn.text.trim() === "" : (turn.text_chars ?? 0) === 0);

function turnChecks(turns: readonly JudgedTurn[], stopped: StopReason | null, requested: string, expected: number, model: string, out: Judged): void {
  for (let n = 1; n <= expected; n++) {
    const turn = turns[n - 1];
    if (!turn || !turn.ended) {
      out.failures.push(`turn_${n}_not_completed:${turn ? (stopped ?? "no_result") : "not_started"}`);
      continue;
    }
    if (turn.feed_error !== null) out.failures.push(`turn_${n}_feed_error`);
    else if (!turn.feed_settled) out.failures.push(`turn_${n}_feed_unsettled`);
    if (turn.refused_cause !== null) { out.failures.push(`turn_${n}_refused_${turn.refused_cause}`); continue; }
    if (emptyText(turn)) out.failures.push(`turn_${n}_empty_result`);
    const id = engineId(turn);
    if (id === null) out.failures.push(`turn_${n}_engine_session_id_missing`);
    else if (id !== requested) out.refusals.push(`turn_${n}_engine_session_id_mismatch`);
    if (turn.session_id === null) out.failures.push(`turn_${n}_result_session_id_missing`);
    else if (turn.session_id !== requested) out.refusals.push(`turn_${n}_result_session_id_mismatch`);
    if (turn.resolved_models.length === 0) out.failures.push(`turn_${n}_model_not_reported`);
    else if (turn.resolved_models.some(one => one !== model)) out.failures.push(`turn_${n}_model_mismatch`);
  }
}

export function judgeSource(f: { requested: string; marker: string; turns: TurnFacts[]; stopped: StopReason | null; effects: Effects | null; transcripts: string[] | null }): Judged {
  const out: Judged = { failures: [], refusals: [] };
  turnChecks(f.turns, f.stopped, f.requested, 2, MODEL, out);
  const [one, two] = f.turns;
  if (one?.ended) {
    if (one.tool_actions.length !== 1 || one.tool_actions[0] !== FIXTURE_TOOL) out.failures.push(`turn_1_expected_exactly_one_fixture_call_got_${one.tool_actions.length}`);
    if (one.tool_results !== 1) out.failures.push(`turn_1_tool_results_${one.tool_results}_not_1`);
  }
  if (f.effects === null) out.failures.push("effects_log_unreadable");
  else {
    if (f.effects.count !== 1) out.failures.push(`effect_count_${f.effects.count}_not_1`);
    if (f.effects.malformed > 0) out.failures.push("effects_log_malformed");
  }
  if (two?.ended) {
    if (two.tool_actions.length > 0 || two.tool_results > 0) out.failures.push("turn_2_used_tools");
    if (!two.text.includes(f.marker)) out.failures.push("source_recall_marker_missing");
    const result = f.effects?.results[0];
    if (result === undefined || !two.text.includes(result)) out.failures.push("source_recall_tool_result_missing");
  }
  // A transcript that cannot be located is a finding only for a run that otherwise completed; a run that did not is simply a failure.
  if (f.transcripts !== null && f.turns.length === 2 && f.turns.every(turn => turn.ended && turn.refused_cause === null)) {
    if (f.transcripts.length === 0) out.refusals.push("source_transcript_unlocated");
    if (f.transcripts.length > 1) out.refusals.push("source_transcript_ambiguous");
  }
  return out;
}

export function judgeCalibration(f: { requested: string; turns: TurnFacts[]; stopped: StopReason | null; effects: Effects | null; transcripts: string[] | null }): Judged {
  const out: Judged = { failures: [], refusals: [] };
  turnChecks(f.turns, f.stopped, f.requested, 1, MODEL, out);
  if (f.turns[0] && (f.turns[0].tool_actions.length > 0 || f.turns[0].tool_results > 0)) out.failures.push("calibration_used_tools");
  if (f.effects === null) out.failures.push("effects_log_unreadable");
  else if (f.effects.count !== 0) out.failures.push(`calibration_effect_count_${f.effects.count}_not_0`);
  if (f.turns[0]?.ended && f.turns[0].refused_cause === null) {
    if (f.transcripts === null) out.refusals.push("locator_unmeasured");
    else if (f.transcripts.length !== 1) out.refusals.push(f.transcripts.length === 0 ? "locator_unmeasured" : "locator_ambiguous");
    else if (projectDirOf(f.transcripts[0]) === null) out.refusals.push("locator_layout_unrecognized");
  }
  return out;
}

/** What the resume judgments read. The recall of the marker and of the tool result arrives as booleans: the text is not needed past that. */
export interface ResumeEvidence {
  native: string; turns: readonly JudgedTurn[]; stopped: StopReason | null; effects: Effects | null;
  before: InventoryView | null; after: InventoryView | null; imported_transcript: string; prefix_preserved: boolean | null;
}

export function judgeResume(f: ResumeEvidence & { marker: string; tool_result: string; turns: readonly TurnFacts[] }): Judged {
  const turn = f.turns[0];
  return judgeResumeEvidence(f, { marker: turn?.text.includes(f.marker) ?? false, tool_result: turn?.text.includes(f.tool_result) ?? false });
}

/**
 * The resume judgments over observed facts. A transcript counts as new only when it is transcript-shaped (see `transcriptShaped`):
 * a new conversation in the imported project directory or in any other is a refusal, while a timestamp-named MCP log the CLI keeps
 * under `home/.cache/` is not a conversation and is not one.
 */
export function judgeResumeEvidence(f: ResumeEvidence, recalled: { marker: boolean; tool_result: boolean }): Judged {
  const out: Judged = { failures: [], refusals: [] };
  turnChecks(f.turns, f.stopped, f.native, 1, MODEL, out);
  const turn = f.turns[0];
  if (turn && !turn.ended && turn.exited_early) out.refusals.push("resume_engine_exited_without_result");
  if (turn?.ended && turn.refused_cause === null) {
    if (turn.tool_actions.length > 0 || turn.tool_results > 0) out.failures.push("resume_used_tools");
    if (!recalled.marker) out.refusals.push("marker_not_recalled");
    if (!recalled.tool_result) out.refusals.push("tool_result_not_recalled");
  }
  if (f.effects === null) out.failures.push("effects_log_unreadable");
  else if (f.effects.count !== 0) out.failures.push(`resume_effect_count_${f.effects.count}_not_0`);
  if (f.before && f.after) {
    const was = new Map(f.before.entries.filter(one => one.kind === "file").map(one => [one.path, one] as const));
    if (freshTranscripts(f.before, f.after).length > 0) out.refusals.push("fresh_transcript_elsewhere");
    const old = was.get(f.imported_transcript), now = f.after.entries.find(one => one.path === f.imported_transcript);
    if (!old || !now) out.failures.push("imported_transcript_missing_from_inventory");
    else if (turn?.ended && (now.size ?? 0) <= (old.size ?? 0)) out.failures.push("imported_transcript_not_appended");
  }
  // The imported bytes must still be the prefix of the transcript after the resume. Bounded to this synthetic measurement: it says
  // nothing about legitimate compaction a CLI might do on a real session, and no native transcript editor is implied.
  if (f.prefix_preserved === false) out.refusals.push("imported_prefix_not_preserved");
  else if (f.prefix_preserved === null) out.failures.push("imported_prefix_evidence_missing");
  return out;
}

/** The codes `judgeResumeEvidence` itself can emit; any other judgment in a saved report came from elsewhere and is carried over untouched. */
const RESUME_JUDGED = /^(turn_\d+_|resume_|marker_not_recalled$|tool_result_not_recalled$|effects_log_unreadable$|fresh_transcript_elsewhere$|imported_)/;

/**
 * Pure rejudgment of a SAVED resume report (the report itself is never modified or written): its public facts are mapped back onto
 * `judgeResumeEvidence` and nothing is reconstructed. The report keeps no text, only `text_chars` and whether the marker and the tool
 * result were in it, and it keeps only its `.jsonl` inventory entries (path, size) and the effect count: exactly what the judge reads.
 * No model call, no host access. Judgments the report holds that this judge never emits (a failed inventory, a launch guard) are carried.
 */
export function rejudgeResumeReport(report: unknown): Judged & { carried: Judged; decision: ReturnType<typeof decide> } {
  const top = rec(report, "report");
  if (top.phase !== "resume") throw new Refusal("report_not_a_resume");
  const turns = top.turns, transcripts = rec(top.transcripts, "report_transcripts"), fixture = rec(top.fixture, "report_fixture");
  const engine = rec(top.engine, "report_engine"), proc = rec(top.process, "report_process"), quota = rec(top.quota, "report_quota");
  if (!Array.isArray(turns) || turns.length === 0) throw new Refusal("report_turns_malformed");
  const turn = rec(turns[0], "report_turn");
  if (typeof turn.marker_in_text !== "boolean" || typeof turn.tool_result_in_text !== "boolean") throw new Refusal("report_recall_not_recorded");
  const listed = (value: unknown, what: string): InventoryView | null => {
    if (value === null) return null;
    if (!Array.isArray(value)) throw new Refusal(`${what}_malformed`);
    return { entries: value.map(item => {
      const one = rec(item, what);
      return { path: text(one.path, what), kind: "file" as const, size: typeof one.size === "number" ? one.size : null };
    }) };
  };
  const count = fixture.effect_count_at_destination;
  const judged = judgeResumeEvidence({
    native: text(engine.asked_session_id, "report_session", UUID), turns: [turn as unknown as JudgedTurn], stopped: (top.stopped ?? null) as StopReason | null,
    effects: typeof count === "number" ? { count, results: [], malformed: 0 } : null,
    before: listed(transcripts.before, "report_before"), after: listed(transcripts.after, "report_after"),
    imported_transcript: text(transcripts.imported_transcript, "report_imported_transcript"),
    prefix_preserved: typeof transcripts.imported_prefix_preserved === "boolean" ? transcripts.imported_prefix_preserved : null,
  }, { marker: turn.marker_in_text, tool_result: turn.tool_result_in_text });
  const was = rec(top.judgments, "report_judgments");
  const kept = (value: unknown) => (Array.isArray(value) ? value.filter((one): one is string => typeof one === "string" && !RESUME_JUDGED.test(one)) : []);
  const carried: Judged = { failures: kept(was.failures), refusals: kept(was.refusals) };
  // An interrupt is recorded only in the saved verdict (a late one, after the turn ended) or in `stopped` (mid-turn); carry it so a rejudge cannot turn it into a pass or a fail.
  const savedInterrupt = top.verdict === "INTERRUPTED" || top.stopped === "interrupted" ? "saved_report" : null;
  const decision = decide({ failures: [...judged.failures, ...carried.failures], refusals: [...judged.refusals, ...carried.refusals], quota: quota.stopped === true,
    interrupted: savedInterrupt, processStarted: proc.attempted === true, cleanupConfirmed: proc.confirmed === true });
  return { ...judged, carried, decision };
}

// ---------------------------------------------------------------------------------------------------------
// Run scaffolding

export interface Layout { run: string; tree: string; stateRoot: string; sessionsParent: string; sessionDir: string; fixtureDir: string; privateDir: string; mcpFile: string }

export function layoutOf(runReal: string, conversation: string): Layout {
  const stateRoot = join(runReal, "state", PERSON), sessionsParent = join(stateRoot, "sessions", AGENT);
  return { run: runReal, tree: join(runReal, "tree", PERSON), stateRoot, sessionsParent, sessionDir: join(sessionsParent, conversation),
    fixtureDir: join(runReal, "fixture"), privateDir: join(runReal, "private"), mcpFile: join(runReal, "fixture", "mcp.json") };
}

function prepareDirs(l: Layout): void {
  for (const dir of [join(l.tree, "vault"), l.sessionsParent, l.fixtureDir, l.privateDir]) mkdirSync(dir, { recursive: true, mode: 0o700 });
}

const stampOf = (when: Date) => when.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "").replace("T", "-");

interface Ctx {
  phase: Phase; failures: string[]; refusals: string[]; quota: boolean; interrupted: string | null;
  processStarted: boolean; cleanupConfirmed: boolean; redactor: Redactor; started_at: string;
}
const newCtx = (phase: Phase, redactor: Redactor, deps: Deps): Ctx =>
  ({ phase, failures: [], refusals: [], quota: false, interrupted: null, processStarted: false, cleanupConfirmed: false, redactor, started_at: deps.now().toISOString() });

export interface PhaseResult {
  exit_code: number; verdict: Verdict; outcome: string; report: Record<string, unknown>;
  report_path: string | null; report_sha256: string | null; run_dir: string | null; summary: string;
}

/** Folds the operator's sticky first signal into the context. Called wherever a decision is taken, so an interrupt can never be outranked by a PASS. */
const noteInterrupt = (ctx: Ctx, deps: Deps): void => { if (ctx.interrupted === null) ctx.interrupted = deps.interrupted(); };

/** The decision as it stands now, with any interrupt folded in: what a handoff or an archive must be gated on. */
const preview = (ctx: Ctx, deps: Deps) => { noteInterrupt(ctx, deps); return decide(ctx); };

/** Writes `phase-<name>.report.json` (source and calibrate: one per run directory) or `phase-<name>.<k>.report.json` (export, import, resume) and builds the one-line summary. */
function conclude(ctx: Ctx, deps: Deps, runDir: string | null, body: Record<string, unknown>, indexed = false): PhaseResult {
  const decision = preview(ctx, deps);
  const report = {
    schema: SCHEMA, phase: ctx.phase, ...body, verdict: decision.verdict, exit_code: decision.code, outcome: decision.outcome,
    judgments: { failures: [...ctx.failures], refusals: [...ctx.refusals] }, scope: SCOPE, limits: LIMITS_TEXT, unknowns: UNKNOWNS,
    started_at: ctx.started_at, finished_at: deps.now().toISOString(),
  };
  let path: string | null = null, sha: string | null = null, persistError: string | null = null;
  if (runDir !== null) {
    for (let k = 1; k <= (indexed ? 99 : 1); k++) {
      const file = join(runDir, indexed ? `phase-${ctx.phase}.${k}.report.json` : `phase-${ctx.phase}.report.json`);
      try { sha = persistJson(file, report, ctx.redactor); path = file; break; } catch (error) {
        persistError = (error as { code?: string })?.code === "EEXIST" ? "report_exists" : message(error);
        if (!indexed || persistError !== "report_exists") break;
      }
    }
  }
  const summary = ctx.redactor.scrub(JSON.stringify({ phase: ctx.phase, verdict: decision.verdict, exit_code: decision.code, outcome: decision.outcome,
    failures: ctx.failures, refusals: ctx.refusals, run_dir: runDir, report: path, report_error: path === null && runDir !== null ? persistError : null }));
  return { exit_code: decision.code, verdict: decision.verdict, outcome: decision.outcome, report, report_path: path, report_sha256: sha, run_dir: runDir, summary };
}

export interface PaidOptions { evidenceDir: string; loginFile: string; cli: string; expectVersion: string; allowPaid: boolean; turnTimeoutMs: number }

export function paidPreconditions(o: { allowPaid: boolean; loginFile: string; cli: string; expectVersion: string }, deps: Deps): string | null {
  if (!o.allowPaid) return "paid_call_not_opted_in";
  const host = deps.host();
  if (host.platform !== "darwin" && host.platform !== "linux") return "platform_unsupported";
  if (deps.uid() === 0) return "running_as_root";
  if (!isAbsolute(o.loginFile) || basename(o.loginFile) !== ".credentials.json") return "login_file_shape";
  if (!isAbsolute(o.cli)) return "cli_not_absolute";
  if (!/^\d+(?:\.\d+)+$/.test(o.expectVersion)) return "expect_version_shape";
  if (host.platform === "linux" && !deps.bwrapPresent()) return "bwrap_missing";
  return deps.resolveCli(o.cli);
}

/** The evidence root: an existing dedicated directory, not `/`, not the home or above it, not overlapping the login (compared as strings; the login is never opened). */
export function evidenceRootProblem(dir: string, loginFile: string): { real: string } | { code: string } {
  if (!isAbsolute(dir)) return { code: "evidence_dir_not_absolute" };
  let real: string;
  try { real = realpathSync(dir); if (!lstatSync(real).isDirectory()) return { code: "evidence_dir_not_a_directory" }; } catch { return { code: "evidence_dir_missing" }; }
  let home = homedir();
  try { home = realpathSync(home); } catch { /* compare as given */ }
  if (real === "/" || real === home || home.startsWith(`${real}${sep}`)) return { code: "evidence_dir_is_root_or_home" };
  const loginDir = dirname(loginFile);
  for (const one of [dir, real]) {
    if (one === loginDir || one.startsWith(`${loginDir}${sep}`) || loginFile.startsWith(`${one}${sep}`)) return { code: "evidence_dir_overlaps_login" };
  }
  return { real };
}

async function preflightVersion(o: { cli: string; expectVersion: string }, deps: Deps, credential: CredentialEntry, ctx: Ctx):
  Promise<{ version: string; native: readonly string[] } | null> {
  let found: { version: string; native: readonly string[] };
  try { found = await deps.preflight(credential, o.cli); } catch (error) {
    ctx.refusals.push(`preflight_failed:${ctx.redactor.scrub(message(error))}`);
    return null;
  }
  const before = ctx.refusals.length;
  if (found.version !== o.expectVersion) ctx.refusals.push(`cli_version_${found.version}_is_not_expected_${o.expectVersion}`);
  if (!VALIDATED_SAFE_RESUME.includes(found.version)) ctx.refusals.push("cli_version_not_in_VALIDATED_SAFE_RESUME");
  if (!VALIDATED_TOOL_CONTROL.includes(found.version)) ctx.refusals.push("cli_version_not_in_VALIDATED_TOOL_CONTROL");
  if (!found.native.includes("--session-id") || !found.native.includes("--resume")) ctx.refusals.push("cli_lacks_session_flags");
  return ctx.refusals.length === before ? found : null;
}

function launchInput(l: Layout, credential: CredentialEntry): LoopLaunchInput {
  return {
    registry: null, preset: PRESET, credential, purpose: "ordinary", sessionDir: l.sessionDir,
    // The agent names NO tools (`tools` omitted), so production prepareLaunch hands makeLoopLaunch this build's VALIDATED_ORDINARY_PROFILES
    // entry as the explicit list, exactly as for an ordinary master; delegation is denied by makeLoopLaunch itself in every phase.
    agent: { id: AGENT, person: PERSON, preset: "daily", runner: "r1", mcp: l.mcpFile },
    box: { agent: AGENT, person: PERSON, tree: l.tree, stateRoot: l.stateRoot, otherTrees: [], otherStateRoots: [], writePaths: [l.fixtureDir],
      secretPaths: [], sessionDir: l.sessionDir, purpose: "ordinary" },
  };
}

/**
 * The fixture's MCP config, regenerated from local parameters. The fixture script is COPIED into the run's own fixture
 * directory (a path the box grants), because the boxed interpreter may read only granted paths and a checkout elsewhere
 * is not one on macOS. A copy or config already there (calibrate wrote them) must be byte-identical or the phase refuses.
 */
function writeMcp(l: Layout, deps: Deps): void {
  const script = join(l.fixtureDir, "fixture.ts");
  const source = readFileSync(deps.fixtureScript);
  if (!existsSync(script)) writeExclusive(script, source);
  else if (!readFileSync(script).equals(source)) throw new Refusal("fixture_script_differs");
  const wanted = JSON.stringify({ mcpServers: { fixture: { type: "stdio", command: deps.fixtureCommand, args: [script, l.fixtureDir] } } });
  if (!existsSync(l.mcpFile)) { writeExclusive(l.mcpFile, wanted); return; }
  if (readFileSync(l.mcpFile, "utf8") !== wanted) throw new Refusal("mcp_config_differs");
}

function makeJournal(deps: Deps, role: Journal["role"], runId: string, l: Layout, conversation: string, source: Journal["source"]): Journal {
  return { version: 1, kind: "claude-session-portability-journal", role, run_id: runId, nonce: deps.hex(16), created_at: deps.now().toISOString(), run_dir: l.run,
    host: deps.host(), ids: { person: PERSON, agent: AGENT, conversation },
    paths: { tree: l.tree, state_root: l.stateRoot, session_dir: l.sessionDir, fixture_dir: l.fixtureDir }, source };
}

const summarize = (inv: Inventory | null) => (inv ? { files: inv.files, dirs: inv.dirs, bytes: inv.bytes, withheld: inv.entries.filter(one => one.withheld).length } : null);

const publicTurn = (t: TurnFacts, secrets: { marker?: string; result?: string } = {}) => ({
  n: t.n, fed: t.fed, feed_settled: t.feed_settled, ended: t.ended, timed_out: t.timed_out, exited_early: t.exited_early, feed_error: t.feed_error, refused_cause: t.refused_cause,
  text_chars: t.text.length, session_id: t.session_id, reported_at_first_event: t.reported_at_first_event, reported_at_end: t.reported_at_end,
  tool_actions: t.tool_actions, tool_results: t.tool_results, resolved_models: t.resolved_models, num_turns: t.num_turns, output_tokens: t.output_tokens,
  weekly_pct: t.weekly_pct,
  marker_in_text: secrets.marker === undefined ? null : t.text.includes(secrets.marker),
  tool_result_in_text: secrets.result === undefined ? null : t.text.includes(secrets.result),
});

const maxPct = (turns: TurnFacts[]) => turns.reduce<number | null>((top, t) => (t.weekly_pct === null ? top : Math.max(top ?? 0, t.weekly_pct)), null);

const argvAfter = (launch: PreparedLaunch, flag: string): string | undefined => { const argv = launch.argv ?? [], at = argv.indexOf(flag); return at >= 0 ? argv[at + 1] : undefined; };

function launchFacts(launch: PreparedLaunch | null, l: Layout) {
  if (!launch) return null;
  const env = launch.env ?? {};
  const rel = (value: string | undefined) => (value && value.startsWith(`${l.sessionDir}${sep}`) ? value.slice(l.sessionDir.length + 1) : value === l.sessionDir ? "." : "<outside-session>");
  return { cwd_realpath: launch.cwd ?? null, argv: launch.argv ?? [], env_keys: Object.keys(env).sort(),
    env_in_session: { HOME: rel(env.HOME), TMPDIR: rel(env.TMPDIR), CLAUDE_CONFIG_DIR: rel(env.CLAUDE_CONFIG_DIR) },
    login_dir_set: typeof env.CLAUDE_SECURESTORAGE_CONFIG_DIR === "string", login_path_recorded: false,
    tools_from_argv: toolsOf(launch), tools_source: "production VALIDATED_ORDINARY_PROFILES[preflight version], read back from the actual argv",
    delegation_denied_from_argv: argvAfter(launch, "--disallowedTools")?.split(",") ?? null, delegation_denied_expected: NATIVE_DELEGATION_TOOLS };
}

interface SessionRun {
  ctx: Ctx; deps: Deps; l: Layout; runDir: string; credential: CredentialEntry; kind: "source" | "calibration" | "resume";
  /** The build the harness's own preflight reported: the launch is guarded against THIS build's production profile. */
  version: string;
  session: { id: string; resume: boolean }; prompts: string[]; timeoutMs: number; secrets: string[];
}
interface SessionOutcome { launch: PreparedLaunch | null; before: Inventory | null; after: Inventory | null; driven: Driven | null; cleanup: CleanupFacts | null }

/**
 * One production launch and one bounded child: prepare, guard, inventory, write-ahead record, start, process record, drive,
 * verify cleanup, inventory. Every step that can refuse does so BEFORE the child starts; once it has started, cleanup is always
 * attempted. The operator's interrupt flag is read before prepare and again before the inventory/write-ahead/start run (that
 * stretch has no await, so nothing can change between the check and the start), and before every feed inside `driveTurns`.
 * `adapter.start` has no timeout of its own here: production `open` throws only before it spawns, and a timeout around it
 * could abandon a child that appears afterwards.
 */
async function runSession(r: SessionRun): Promise<SessionOutcome> {
  const { ctx, deps, l } = r;
  const out: SessionOutcome = { launch: null, before: null, after: null, driven: null, cleanup: null };
  const startedFile = join(r.runDir, `phase-${r.kind}.started.json`);
  if (existsSync(startedFile)) { ctx.refusals.push("phase_already_started"); return out; }
  noteInterrupt(ctx, deps);
  if (ctx.interrupted !== null) return out;
  try { out.launch = await deps.adapter.prepareLaunch(launchInput(l, r.credential)); } catch (error) {
    ctx.refusals.push(`launch_refused:${ctx.redactor.scrub(message(error))}`);
    return out;
  }
  noteInterrupt(ctx, deps);
  if (ctx.interrupted !== null) return out;
  const launch = out.launch;
  const problems = checkLaunch(launch, { sessionDir: l.sessionDir, model: MODEL, effort: EFFORT, version: r.version });
  if (problems.length > 0) { ctx.refusals.push(...problems.map(one => `launch_guard:${one}`)); return out; }
  if (r.secrets.length > 0) {
    const instructions = join(l.sessionDir, "instructions.md");
    let prompt = "";
    try { if (existsSync(instructions)) prompt = readFileSync(instructions, "utf8"); } catch { prompt = ""; }
    const leaked = scanForLeaks([{ label: "argv", text: (launch.argv ?? []).join("\n") }, { label: "env", text: Object.values(launch.env ?? {}).join("\n") },
      { label: "instructions", text: prompt }, { label: "prompts", text: r.prompts.join("\n") }], r.secrets);
    if (leaked.length > 0) { ctx.refusals.push(...leaked.map(one => `fixture_answer_in_${one}`)); return out; }
  }
  try {
    out.before = inventoryTree(l.sessionDir);
    persistJson(join(r.runDir, `inventory.${r.kind}.before.json`), out.before, ctx.redactor);
  } catch (error) { ctx.refusals.push(`inventory_before:${describe(error)}`); return out; }
  try {
    writeExclusive(startedFile, `${JSON.stringify({ kind: r.kind, session_id: r.session.id, resume: r.session.resume, prompts: r.prompts.length, started_at: deps.now().toISOString() }, null, 2)}\n`);
  } catch { ctx.refusals.push("phase_already_started"); return out; }
  let session: AdapterSession;
  try {
    session = await deps.adapter.start({ preset: PRESET, sessionId: null, session: r.session, ...(launch.credentialId ? { credentialId: launch.credentialId } : {}),
      ...(launch.cwd ? { cwd: launch.cwd } : {}), ...(launch.argv ? { argv: launch.argv } : {}), ...(launch.env ? { env: launch.env } : {}),
      ...(launch.wrap ? { wrap: launch.wrap } : {}) });
  } catch (error) { ctx.failures.push(`start_failed:${ctx.redactor.scrub(message(error))}`); return out; }
  ctx.processStarted = true;
  // From here on cleanup is unconditional: the process record, the turns and anything else that can throw sit inside this try.
  try {
    // The diagnostic record is written first, before any feed, so an operator can find the child by hand if this harness is killed.
    // If it cannot be written nothing is fed (no spend without it), and cleanup below still happens.
    let recorded = false;
    try {
      persistJson(join(r.runDir, `phase-${r.kind}.process.json`), {
        kind: r.kind, session_id: r.session.id, pid: session.pid ?? null, group: safe(() => session.group?.() ?? null), observed_processes: safe(() => session.processes?.() ?? null),
        partial: safe(() => session.partial?.() ?? null), recorded_at: deps.now().toISOString(),
        note: "diagnostic only, as the production session reported it at start; nothing is ever signalled from this record",
      }, ctx.redactor);
      recorded = true;
    } catch (error) { ctx.failures.push(`process_record_failed:${describe(error)}`); }
    if (recorded) out.driven = await driveTurns(session, r.prompts, { timeoutMs: r.timeoutMs, interrupt: deps.interrupt, interrupted: deps.interrupted });
  } catch (error) { ctx.failures.push(`drive_crashed:${ctx.redactor.scrub(message(error))}`); } finally {
    out.cleanup = await stopAndVerify(session, deps.closeBoundMs);
    ctx.cleanupConfirmed = out.cleanup.confirmed;
  }
  if (out.driven?.stopped === "quota") ctx.quota = true;
  if (out.driven?.stopped === "interrupted") ctx.interrupted = out.driven.interrupted_by ?? "signal";
  noteInterrupt(ctx, deps); // a signal during the result callback, the close or the finalization below still overrides a pass
  try {
    out.after = inventoryTree(l.sessionDir);
    persistJson(join(r.runDir, `inventory.${r.kind}.after.json`), out.after, ctx.redactor);
  } catch (error) { ctx.refusals.push(`inventory_after:${describe(error)}`); }
  if (out.driven) {
    try { persistJson(join(l.privateDir, `turns.${r.kind}.json`), { turns: out.driven.turns.map(t => ({ n: t.n, text: t.text, refused_said: t.refused_said })) }, ctx.redactor); }
    catch (error) { ctx.failures.push(`turns_record_failed:${describe(error)}`); }
  }
  noteInterrupt(ctx, deps);
  return out;
}

const safe = <T>(run: () => T): T | null => { try { return run(); } catch { return null; } };

// ---------------------------------------------------------------------------------------------------------
// Phase: source

export interface Handoff {
  version: 1; kind: "claude-session-handoff"; source_run_id: string; source_nonce: string; created_at: string;
  host: HostFacts; cli_version: string; model: string; ids: { person: string; agent: string; conversation: string };
  native_session: string; cwd_realpath: string; fixture: { marker: string; tool_result: string }; weekly_pct_seen: number | null;
}

export function parseHandoff(data: unknown): Handoff {
  const top = rec(data, "handoff");
  if (top.version !== 1 || top.kind !== "claude-session-handoff") throw new Refusal("handoff_kind");
  const host = rec(top.host, "handoff_host"), ids = rec(top.ids, "handoff_ids"), fixture = rec(top.fixture, "handoff_fixture");
  const pct = top.weekly_pct_seen;
  if (pct !== null && typeof pct !== "number") throw new Refusal("handoff_malformed");
  const sourceRun = text(top.source_run_id, "handoff_run", RUN_ID);
  if (!sourceRun.startsWith("source-")) throw new Refusal("handoff_run_malformed");
  const cwd = text(top.cwd_realpath, "handoff_cwd");
  if (!isAbsolute(cwd)) throw new Refusal("handoff_cwd_malformed");
  if (ids.person !== PERSON || ids.agent !== AGENT) throw new Refusal("handoff_ids_malformed");
  return {
    version: 1, kind: "claude-session-handoff", source_run_id: sourceRun, source_nonce: text(top.source_nonce, "handoff_nonce", NONCE),
    created_at: text(top.created_at, "handoff_created"),
    host: { platform: text(host.platform, "handoff_platform"), arch: text(host.arch, "handoff_arch"), release: text(host.release, "handoff_release"),
      bun: text(host.bun, "handoff_bun"), machine: text(host.machine, "handoff_machine") },
    cli_version: text(top.cli_version, "handoff_version"), model: text(top.model, "handoff_model"),
    ids: { person: PERSON, agent: AGENT, conversation: text(ids.conversation, "handoff_conversation", UUID) },
    native_session: text(top.native_session, "handoff_session", UUID), cwd_realpath: cwd,
    fixture: { marker: text(fixture.marker, "handoff_marker", /^MARK-[0-9a-f]{24}$/), tool_result: text(fixture.tool_result, "handoff_result", /^RESULT-[0-9a-f]{24}$/) },
    weekly_pct_seen: pct,
  };
}

export async function runSource(o: PaidOptions, deps: Deps): Promise<PhaseResult> {
  const redactor = makeRedactor([o.loginFile, dirname(o.loginFile)]);
  const ctx = newCtx("source", redactor, deps);
  const early = (code: string) => { ctx.refusals.push(code); return conclude(ctx, deps, null, { run_id: null }); };
  const pre = paidPreconditions(o, deps);
  if (pre) return early(pre);
  const root = evidenceRootProblem(o.evidenceDir, o.loginFile);
  if ("code" in root) return early(root.code);

  const runId = `source-${stampOf(deps.now())}-${deps.hex(4)}`;
  let runReal: string;
  try { const made = join(root.real, runId); mkdirSync(made, { mode: 0o700 }); runReal = realpathSync(made); } catch { return early("run_dir_not_created"); }
  const conversation = deps.uuid();
  const l = layoutOf(runReal, conversation);
  const body: Record<string, unknown> = { run_id: runId, role: "source", host: deps.host() };
  const steps = async () => {
    prepareDirs(l);
    const journal = makeJournal(deps, "source", runId, l, conversation, null);
    persistJson(join(runReal, "journal.json"), journal);
    body.ids = journal.ids;
    body.login = { path_recorded: false, read_by_harness: false, source: "explicit local path handed to the production launch; never opened, copied or logged here" };
    const credential: CredentialEntry = { id: "loop-login", kind: "claude-login", file: o.loginFile, owner: PERSON };
    const found = await preflightVersion(o, deps, credential, ctx);
    body.cli = { expected_version: o.expectVersion, reported_version: found?.version ?? null, native_flags: found?.native ?? null,
      in_VALIDATED_SAFE_RESUME: found ? VALIDATED_SAFE_RESUME.includes(found.version) : null };
    if (!found) return;
    writeMcp(l, deps);
    const requested = deps.uuid(), marker = `MARK-${deps.hex(12)}`;
    writeExclusive(join(l.privateDir, "secrets.json"), `${JSON.stringify({ session_id: requested, marker })}\n`);
    const ran = await runSession({ ctx, deps, l, runDir: runReal, credential, kind: "source", version: found.version, session: { id: requested, resume: false },
      prompts: sourcePrompts(marker), timeoutMs: o.turnTimeoutMs, secrets: [] });
    body.launch = launchFacts(ran.launch, l);
    body.invocations = [{ kind: "source", session_id: requested, resume: false, processes: ctx.processStarted ? 1 : 0,
      feeds_attempted: ran.driven?.turns.length ?? 0, turns_fed: ran.driven?.turns.filter(t => t.fed).length ?? 0 }];
    body.session = { requested_id: requested };
    body.process = ran.cleanup;
    if (!ctx.processStarted || !ran.driven) return;
    const effects = safe(() => readEffects(l.fixtureDir));
    const transcripts = ran.after ? transcriptsNamed(ran.after, requested) : null;
    const judged = judgeSource({ requested, marker, turns: ran.driven.turns, stopped: ran.driven.stopped, effects, transcripts });
    ctx.failures.push(...judged.failures);
    ctx.refusals.push(...judged.refusals);
    const pct = maxPct(ran.driven.turns);
    body.turns = ran.driven.turns.map(t => publicTurn(t, { marker, result: effects?.results[0] }));
    body.stopped = ran.driven.stopped;
    body.quota = { weekly_pct_seen: pct, guard_pct: QUOTA_STOP_PCT, stopped: ctx.quota };
    body.fixture = { effect_count: effects?.count ?? null, effects_log_malformed: effects?.malformed ?? null };
    body.inventory = { before: summarize(ran.before), after: summarize(ran.after), diff: ran.before && ran.after ? diffInventory(ran.before, ran.after) : null,
      transcripts_named_by_session: transcripts, project_dir_measured: transcripts && transcripts.length === 1 ? projectDirOf(transcripts[0]) : null,
      ownership: "not inferred: the reviewer chooses the export manifest from this evidence", files: { before: `inventory.source.before.json`, after: `inventory.source.after.json` } };
    // The interrupt flag is folded in here, so a signal that arrived at any point can never publish a handoff.
    if (preview(ctx, deps).verdict === "PASS_SCOPED" && effects && ran.launch?.cwd) {
      const handoff: Handoff = { version: 1, kind: "claude-session-handoff", source_run_id: runId, source_nonce: journal.nonce, created_at: deps.now().toISOString(),
        host: journal.host, cli_version: found.version, model: MODEL, ids: journal.ids, native_session: requested, cwd_realpath: ran.launch.cwd,
        fixture: { marker, tool_result: effects.results[0] }, weekly_pct_seen: pct };
      try { body.handoff = { file: "handoff.json", sha256: persistJson(join(runReal, "handoff.json"), handoff), note: "synthetic marker and tool result: the only content-bearing artifact; transfer after review" }; }
      catch (error) { ctx.failures.push(`handoff_write_failed:${describe(error)}`); }
    }
  };
  try { await steps(); } catch (error) { ctx.failures.push(`crash:${describe(error)}`); }
  return conclude(ctx, deps, runReal, body);
}

// ---------------------------------------------------------------------------------------------------------
// Phase: calibrate (destination host)

export interface CalibrateOptions extends Omit<PaidOptions, "turnTimeoutMs"> { handoff: string; turnTimeoutMs: number }

function archiveCalibration(runReal: string, l: Layout, conversation: string): { archived_to: string; identity: { dev: number; ino: number } } {
  const root = join(runReal, "calibration-archive");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const target = join(root, conversation);
  let absent = false;
  try { lstatSync(target); } catch (error) { absent = (error as { code?: string })?.code === "ENOENT"; }
  if (!absent) throw new Refusal("archive_target_exists");
  const from = lstatSync(l.sessionDir);
  if (from.isSymbolicLink() || !from.isDirectory()) throw new Refusal("archive_source_invalid");
  renameSync(l.sessionDir, target);
  const to = lstatSync(target);
  let gone = false;
  try { lstatSync(l.sessionDir); } catch (error) { gone = (error as { code?: string })?.code === "ENOENT"; }
  if (!gone || to.dev !== from.dev || to.ino !== from.ino) throw new Refusal("archive_unverified");
  return { archived_to: `calibration-archive/${conversation}`, identity: { dev: to.dev, ino: to.ino } };
}

export async function runCalibrate(o: CalibrateOptions, deps: Deps): Promise<PhaseResult> {
  const redactor = makeRedactor([o.loginFile, dirname(o.loginFile)]);
  const ctx = newCtx("calibrate", redactor, deps);
  const early = (code: string) => { ctx.refusals.push(code); return conclude(ctx, deps, null, { run_id: null }); };
  const pre = paidPreconditions(o, deps);
  if (pre) return early(pre);
  const root = evidenceRootProblem(o.evidenceDir, o.loginFile);
  if ("code" in root) return early(root.code);
  let handoff: Handoff, handoffSha: string, handoffBytes: Buffer;
  try {
    if (!isAbsolute(o.handoff)) return early("handoff_not_absolute");
    fileSha256(o.handoff, 64 * 1024); // regular file, bounded: refuses a link or an oversize file before the one read below
    handoffBytes = readFileSync(o.handoff);
    handoffSha = sha256Hex(handoffBytes);
    handoff = parseHandoff(JSON.parse(handoffBytes.toString("utf8")));
  } catch (error) { return early(`handoff_refused:${describe(error)}`); }
  if ((handoff.weekly_pct_seen ?? 0) >= QUOTA_STOP_PCT) { ctx.quota = true; return conclude(ctx, deps, null, { run_id: null, quota: { weekly_pct_seen: handoff.weekly_pct_seen, guard_pct: QUOTA_STOP_PCT } }); }

  const runId = `dest-${stampOf(deps.now())}-${deps.hex(4)}`;
  let runReal: string;
  try { const made = join(root.real, runId); mkdirSync(made, { mode: 0o700 }); runReal = realpathSync(made); } catch { return early("run_dir_not_created"); }
  const conversation = handoff.ids.conversation;
  const l = layoutOf(runReal, conversation);
  const body: Record<string, unknown> = { run_id: runId, role: "destination", host: deps.host() };
  const steps = async () => {
    prepareDirs(l);
    writeExclusive(join(runReal, "source-handoff.json"), handoffBytes);
    const journal = makeJournal(deps, "destination", runId, l, conversation, { run_id: handoff.source_run_id, nonce: handoff.source_nonce,
      native_session: handoff.native_session, cwd_realpath: handoff.cwd_realpath, os: handoff.host.platform, machine: handoff.host.machine,
      cli_version: handoff.cli_version, handoff_sha256: handoffSha });
    persistJson(join(runReal, "journal.json"), journal);
    body.ids = journal.ids;
    body.source = journal.source;
    const credential: CredentialEntry = { id: "loop-login", kind: "claude-login", file: o.loginFile, owner: PERSON };
    const found = await preflightVersion(o, deps, credential, ctx);
    body.cli = { expected_version: o.expectVersion, reported_version: found?.version ?? null, source_cli_version: handoff.cli_version };
    if (!found) return;
    writeMcp(l, deps);
    const calibrationId = deps.uuid();
    const ran = await runSession({ ctx, deps, l, runDir: runReal, credential, kind: "calibration", version: found.version, session: { id: calibrationId, resume: false },
      prompts: [CALIBRATION_PROMPT], timeoutMs: o.turnTimeoutMs, secrets: [] });
    body.launch = launchFacts(ran.launch, l);
    body.invocations = [{ kind: "calibration", session_id: calibrationId, resume: false, processes: ctx.processStarted ? 1 : 0,
      feeds_attempted: ran.driven?.turns.length ?? 0,
      note: "fresh independent fixture session at the destination's own session path; never the resumed source" }];
    body.process = ran.cleanup;
    if (!ctx.processStarted || !ran.driven) return;
    const effects = safe(() => readEffects(l.fixtureDir));
    const transcripts = ran.after ? transcriptsNamed(ran.after, calibrationId) : null;
    const judged = judgeCalibration({ requested: calibrationId, turns: ran.driven.turns, stopped: ran.driven.stopped, effects, transcripts });
    ctx.failures.push(...judged.failures);
    ctx.refusals.push(...judged.refusals);
    body.turns = ran.driven.turns.map(t => publicTurn(t));
    body.stopped = ran.driven.stopped;
    body.quota = { weekly_pct_seen: maxPct(ran.driven.turns), guard_pct: QUOTA_STOP_PCT, stopped: ctx.quota };
    const projectDir = transcripts && transcripts.length === 1 ? projectDirOf(transcripts[0]) : null;
    const cwd = ran.launch?.cwd ?? l.sessionDir;
    body.locator = {
      measured: projectDir !== null, project_dir: projectDir, transcript_relative: transcripts && transcripts.length === 1 ? transcripts[0] : null,
      cwd_realpath: cwd, source_cwd_realpath: handoff.cwd_realpath, cwd_differs_from_source: cwd !== handoff.cwd_realpath,
      same_machine_as_source: deps.host().machine === handoff.host.machine, os_pair: `${handoff.host.platform}->${deps.host().platform}`,
      measured_for: "this one destination realpath only; no encoding rule is inferred",
    };
    body.acceptance_eligible = deps.host().machine !== handoff.host.machine && cwd !== handoff.cwd_realpath
      ? "different machine and different realpath: eligible as a measured pair" : "NOT eligible: same machine or same realpath (harness debugging only)";
    body.layout_files_written_by_a_fresh_session = ran.before && ran.after ? diffInventory(ran.before, ran.after) : null;
    body.inventory = { before: summarize(ran.before), after: summarize(ran.after), files: { before: "inventory.calibration.before.json", after: "inventory.calibration.after.json" } };
    // Same gate as the handoff: an interrupt folded in here means the calibration directory is never archived on a signalled run.
    if (preview(ctx, deps).verdict === "PASS_SCOPED") {
      try { body.archive = archiveCalibration(runReal, l, conversation); } catch (error) { ctx.failures.push(`calibration_archive_failed:${describe(error)}`); }
    }
  };
  try { await steps(); } catch (error) { ctx.failures.push(`crash:${describe(error)}`); }
  return conclude(ctx, deps, runReal, body);
}

// ---------------------------------------------------------------------------------------------------------
// Phase: export (source host, no model call)

export interface ExportOptions { runDir: string; manifest: string; calibrationReport: string }

/** A calibration report root copied here: the destination run's own PASS_SCOPED measurement, bound to THIS source run. */
function readCalibrationReport(file: string, source: Journal): { run_id: string; sha256: string; project_dir: string; cwd_realpath: string } {
  const sha256 = fileSha256(file, 4 * 1024 * 1024);
  const report = rec(readJson(file, 4 * 1024 * 1024), "calibration_report");
  const locator = rec(report.locator, "calibration_locator"), src = rec(report.source, "calibration_source"), ids = rec(report.ids, "calibration_ids");
  if (report.schema !== SCHEMA || report.phase !== "calibrate" || report.verdict !== "PASS_SCOPED") throw new Refusal("calibration_not_passed");
  const runId = text(report.run_id, "calibration_run", RUN_ID);
  if (!runId.startsWith("dest-")) throw new Refusal("calibration_run_malformed");
  if (src.run_id !== source.run_id || src.nonce !== source.nonce || ids.conversation !== source.ids.conversation) throw new Refusal("calibration_not_for_this_source");
  if (locator.measured !== true) throw new Refusal("locator_unmeasured");
  const projectDir = text(locator.project_dir, "calibration_project_dir");
  if (projectDir.includes("/")) throw new Refusal("calibration_project_dir_malformed");
  return { run_id: runId, sha256, project_dir: projectDir, cwd_realpath: text(locator.cwd_realpath, "calibration_cwd") };
}

export async function runExport(o: ExportOptions, deps: Deps): Promise<PhaseResult> {
  const ctx = newCtx("export", makeRedactor([]), deps);
  const body: Record<string, unknown> = { role: "source", model_calls: 0 };
  let runDir: string | null = null;
  try {
    if (![o.runDir, o.manifest, o.calibrationReport].every(isAbsolute)) throw new Refusal("paths_not_absolute");
    const journal = readJournal(o.runDir, "source");
    runDir = journal.run_dir;
    body.run_id = journal.run_id;
    const sourceReport = rec(readJson(join(runDir, "phase-source.report.json"), 4 * 1024 * 1024), "source_report");
    if (sourceReport.verdict !== "PASS_SCOPED" || sourceReport.run_id !== journal.run_id) throw new Refusal("source_not_passed");
    const reportSha = fileSha256(join(runDir, "phase-source.report.json"), 4 * 1024 * 1024);
    const recorded = readJson(join(runDir, "inventory.source.after.json"), 8 * 1024 * 1024) as Inventory;
    const live = inventoryTree(journal.paths.session_dir);
    if (!isUnchanged(diffInventory(recorded, live))) throw new Refusal("source_changed_since_evidence");
    const calibration = readCalibrationReport(o.calibrationReport, journal);
    const manifestSha = fileSha256(o.manifest, 1024 * 1024);
    const manifest = parseReviewedManifest(readJson(o.manifest, 1024 * 1024));
    const session = text(readJsonKey(join(runDir, "private", "secrets.json"), "session_id"), "source_session", UUID);
    const mapped = validateReviewed(manifest, { run_id: journal.run_id, nonce: journal.nonce, native_session: session, inventory: live },
      { run_id: calibration.run_id, report_sha256: calibration.sha256, project_dir: calibration.project_dir });
    const handoff = parseHandoff(readJson(join(runDir, "handoff.json"), 64 * 1024));
    if (handoff.native_session !== session || handoff.source_run_id !== journal.run_id) throw new Refusal("handoff_not_for_this_run");
    noteInterrupt(ctx, deps);
    if (ctx.interrupted !== null) throw new Refusal("interrupted_before_export");
    const exportId = deps.hex(8);
    const made = exportNative({ sessionDir: journal.paths.session_dir, runDir, exportId, manifest, manifestSha256: manifestSha, mapped,
      source: { run_id: journal.run_id, journal_nonce: journal.nonce, native_session: session, os: journal.host.platform, cli_version: handoff.cli_version,
        cwd_realpath: journal.paths.session_dir, report_sha256: reportSha },
      calibration: { run_id: calibration.run_id, report_sha256: calibration.sha256, project_dir: calibration.project_dir, cwd_realpath: calibration.cwd_realpath } });
    body.export = { dir: basename(made.dir), export_id: exportId, files: made.bundle.manifest.files, total_bytes: made.bundle.manifest.totalBytes,
      source_bundle_digest: made.envelope.source_bundle_digest, bundle_digest: made.envelope.bundle_digest, reviewed_manifest_sha256: manifestSha,
      mapping: mapped.map(one => ({ from: one.from, to: one.to, sha256: one.sha256, size: one.size, mode: one.mode })),
      locator: made.envelope.locator, cwd_realpath_source: journal.paths.session_dir, cwd_realpath_destination: calibration.cwd_realpath,
      transcript_bytes_rewritten: false, copy: "root copies this directory to the destination host; nothing is sent from here" };
  } catch (error) { ctx.refusals.push(describe(error)); }
  return conclude(ctx, deps, runDir, body, true);
}

function readJsonKey(file: string, key: string): unknown { return rec(readJson(file, 64 * 1024), "private")[key]; }

// ---------------------------------------------------------------------------------------------------------
// Phase: import (destination host, no model call)

/** `expectBundleDigest` is the operator's own selection: the `export.bundle_digest` of the reviewed `phase-export.<k>.report.json`. Nothing picks "the latest export". */
export interface ImportOptions { runDir: string; exportDir: string; expectBundleDigest: string }

function calibrationOf(runDir: string, journal: Journal): { sha256: string; project_dir: string; run_id: string } {
  const file = join(runDir, "phase-calibrate.report.json");
  const report = rec(readJson(file, 4 * 1024 * 1024), "calibration_report");
  if (report.verdict !== "PASS_SCOPED" || report.run_id !== journal.run_id) throw new Refusal("calibration_not_passed");
  const locator = rec(report.locator, "calibration_locator");
  if (locator.measured !== true) throw new Refusal("locator_unmeasured");
  return { sha256: fileSha256(file, 4 * 1024 * 1024), project_dir: text(locator.project_dir, "calibration_project_dir"), run_id: journal.run_id };
}

export async function runImport(o: ImportOptions, deps: Deps): Promise<PhaseResult> {
  const ctx = newCtx("import", makeRedactor([]), deps);
  const body: Record<string, unknown> = { role: "destination", model_calls: 0 };
  let runDir: string | null = null;
  try {
    if (![o.runDir, o.exportDir].every(isAbsolute)) throw new Refusal("paths_not_absolute");
    const journal = readJournal(o.runDir, "destination");
    runDir = journal.run_dir;
    body.run_id = journal.run_id;
    if (!journal.source) throw new Refusal("journal_without_source");
    if (existsSync(join(runDir, "import.json"))) throw new Refusal("already_imported");
    if (!SHA256.test(o.expectBundleDigest)) throw new Refusal("expect_bundle_digest_shape");
    const calibration = calibrationOf(runDir, journal);
    noteInterrupt(ctx, deps);
    if (ctx.interrupted !== null) throw new Refusal("interrupted_before_import");
    const imported = importNative({ exportDir: o.exportDir, sessionDir: journal.paths.session_dir, operation: `native-import:${journal.run_id}`,
      expect: { source_run_id: journal.source.run_id, source_nonce: journal.source.nonce, native_session: journal.source.native_session,
        calibration_run_id: calibration.run_id, calibration_report_sha256: calibration.sha256, calibration_project_dir: calibration.project_dir,
        bundle_digest: o.expectBundleDigest } });
    const after = inventoryTree(journal.paths.session_dir);
    persistJson(join(runDir, "inventory.import.after.json"), after);
    const receipt = { status: "ok", export_id: imported.envelope.export_id, bundle_digest: imported.envelope.bundle_digest, files: imported.files, stage_receipt: imported.receipt,
      stage_reused: imported.reused, session_dir: journal.paths.session_dir };
    persistJson(join(runDir, "import.json"), receipt);
    body.import = { export_id: imported.envelope.export_id, bundle_digest: imported.envelope.bundle_digest, selected_by_operator_digest: o.expectBundleDigest, files: imported.files, session_dir_created_by: "transfer library exclusive mkdir",
      library_marker_present: after.entries.some(one => one.path === ".imprnt-transfer.json"), inventory: summarize(after), nothing_replaced: true,
      calibration_archive: "retained, never deleted" };
  } catch (error) { ctx.refusals.push(describe(error)); }
  return conclude(ctx, deps, runDir, body, true);
}

// ---------------------------------------------------------------------------------------------------------
// Phase: resume (destination host)

export interface ResumeOptions extends Omit<PaidOptions, "evidenceDir"> { runDir: string }

export async function runResume(o: ResumeOptions, deps: Deps): Promise<PhaseResult> {
  const redactor = makeRedactor([o.loginFile, dirname(o.loginFile)]);
  const ctx = newCtx("resume", redactor, deps);
  const early = (code: string, runDir: string | null = null) => { ctx.refusals.push(code); return conclude(ctx, deps, runDir, { run_id: null }); };
  const pre = paidPreconditions(o, deps);
  if (pre) return early(pre);
  if (!isAbsolute(o.runDir)) return early("run_dir_not_absolute");
  const loginDir = dirname(o.loginFile);
  if (o.runDir === loginDir || o.runDir.startsWith(`${loginDir}${sep}`) || loginDir.startsWith(`${o.runDir}${sep}`)) return early("run_dir_overlaps_login");
  let journal: Journal;
  try { journal = readJournal(o.runDir, "destination"); } catch (error) { return early(describe(error)); }
  const runDir = journal.run_dir;
  const body: Record<string, unknown> = { run_id: journal.run_id, role: "destination", host: deps.host(), ids: journal.ids, source: journal.source };
  const l = layoutOf(runDir, journal.ids.conversation);
  const steps = async () => {
    if (!journal.source) throw new Refusal("journal_without_source");
    if (l.sessionDir !== journal.paths.session_dir || l.fixtureDir !== journal.paths.fixture_dir) throw new Refusal("journal_paths_differ_from_layout");
    const handoffFile = join(runDir, "source-handoff.json");
    if (fileSha256(handoffFile, 64 * 1024) !== journal.source.handoff_sha256) throw new Refusal("handoff_changed");
    const handoff = parseHandoff(readJson(handoffFile, 64 * 1024));
    const imp = rec(readJson(join(runDir, "import.json"), 4 * 1024 * 1024), "import_receipt");
    if (imp.status !== "ok" || imp.session_dir !== l.sessionDir) throw new Refusal("import_not_ok");
    const calibration = calibrationOf(runDir, journal);
    const calibrationReport = rec(readJson(join(runDir, "phase-calibrate.report.json"), 4 * 1024 * 1024), "calibration_report");
    const seen = rec(calibrationReport.quota, "calibration_quota").weekly_pct_seen;
    if (typeof seen === "number" && seen >= QUOTA_STOP_PCT) { ctx.quota = true; return; }
    if ((handoff.weekly_pct_seen ?? 0) >= QUOTA_STOP_PCT) { ctx.quota = true; return; }
    const imported = readJson(join(runDir, "inventory.import.after.json"), 8 * 1024 * 1024) as Inventory;
    const now = inventoryTree(l.sessionDir);
    if (!isUnchanged(diffInventory(imported, now))) throw new Refusal("destination_changed_since_import");
    const credential: CredentialEntry = { id: "loop-login", kind: "claude-login", file: o.loginFile, owner: PERSON };
    const found = await preflightVersion(o, deps, credential, ctx);
    body.cli = { expected_version: o.expectVersion, reported_version: found?.version ?? null, source_cli_version: handoff.cli_version };
    if (!found) return;
    writeMcp(l, deps);
    const transcript = `config/projects/${calibration.project_dir}/${handoff.native_session}.jsonl`;
    const ran = await runSession({ ctx, deps, l, runDir, credential, kind: "resume", version: found.version, session: { id: handoff.native_session, resume: true },
      prompts: [RESUME_PROMPT], timeoutMs: o.turnTimeoutMs, secrets: [handoff.fixture.marker, handoff.fixture.tool_result] });
    body.launch = launchFacts(ran.launch, l);
    body.invocations = [{ kind: "resume", session_id: handoff.native_session, resume: true, processes: ctx.processStarted ? 1 : 0,
      feeds_attempted: ran.driven?.turns.length ?? 0, prompt_contains_marker_or_result: false, original_input_replayed: false }];
    body.process = ran.cleanup;
    if (!ctx.processStarted || !ran.driven) return;
    const effects = safe(() => readEffects(l.fixtureDir));
    const before = ran.before?.entries.find(one => one.path === transcript);
    const preserved = before && before.sha256 !== null && before.size !== null ? prefixPreserved(l.sessionDir, transcript, before.size, before.sha256) : null;
    const judged = judgeResume({ native: handoff.native_session, marker: handoff.fixture.marker, tool_result: handoff.fixture.tool_result, turns: ran.driven.turns,
      stopped: ran.driven.stopped, effects, before: ran.before, after: ran.after, imported_transcript: transcript, prefix_preserved: preserved });
    ctx.failures.push(...judged.failures);
    ctx.refusals.push(...judged.refusals);
    body.turns = ran.driven.turns.map(t => publicTurn(t, { marker: handoff.fixture.marker, result: handoff.fixture.tool_result }));
    body.stopped = ran.driven.stopped;
    body.quota = { weekly_pct_seen: maxPct(ran.driven.turns), guard_pct: QUOTA_STOP_PCT, stopped: ctx.quota };
    body.fixture = { effect_count_at_destination: effects?.count ?? null, effect_count_at_source_run: 1, expected_new_effects: 0 };
    body.engine = { asked_session_id: handoff.native_session, reported_at_first_event: ran.driven.turns[0]?.reported_at_first_event ?? null,
      reported_at_end: ran.driven.turns[0]?.reported_at_end ?? null, result_session_id: ran.driven.turns[0]?.session_id ?? null };
    body.transcripts = { imported_transcript: transcript, before: ran.before ? jsonlFiles(ran.before) : null, after: ran.after ? jsonlFiles(ran.after) : null,
      imported_prefix_preserved: preserved, cwd_realpath_destination: ran.launch?.cwd ?? null, cwd_realpath_source: handoff.cwd_realpath };
    body.inventory = { before: summarize(ran.before), after: summarize(ran.after), diff: ran.before && ran.after ? diffInventory(ran.before, ran.after) : null,
      files: { before: "inventory.resume.before.json", after: "inventory.resume.after.json" } };
    body.pair = { source: { os: handoff.host.platform, machine: handoff.host.machine, cli: handoff.cli_version },
      destination: { os: deps.host().platform, machine: deps.host().machine, cli: found.version },
      same_machine: handoff.host.machine === deps.host().machine,
      acceptance_note: handoff.host.machine === deps.host().machine ? "same machine: harness debugging only, not Mac<->Pi acceptance" : "observed pair only" };
  };
  try { await steps(); } catch (error) { ctx.refusals.push(describe(error)); }
  // Indexed: a refusal before launch leaves a report and must not hide the report of a later attempt. What allows ONE process per
  // destination run is the write-ahead `phase-resume.started.json`, not the report's name.
  return conclude(ctx, deps, runDir, body, true);
}

// ---------------------------------------------------------------------------------------------------------
// Command line

export const USAGE = [
  "usage: bun live/claude-session-portability.ts <phase> [flags]   (see live/claude-session-portability.md)",
  "  source     --evidence-dir D --login-file L --cli C --expect-cli-version V --allow-paid-call [--turn-timeout-ms N]",
  "  calibrate  --evidence-dir D --handoff H --login-file L --cli C --expect-cli-version V --allow-paid-call [--turn-timeout-ms N]",
  "  export     --run-dir SOURCE_RUN --manifest M --calibration-report R",
  "  import     --run-dir DEST_RUN --export-dir E --expect-bundle-digest SHA256_HEX64   (the export.bundle_digest of the reviewed export report)",
  "  resume     --run-dir DEST_RUN --login-file L --cli C --expect-cli-version V --allow-paid-call [--turn-timeout-ms N]",
].join("\n");

export class UsageError extends Error {}

export function parseCli(argv: string[]): { phase: Phase; flags: Record<string, string | boolean | undefined> } {
  const parsed = (() => {
    try {
      return parseArgs({ args: argv, allowPositionals: true, strict: true, options: {
        "evidence-dir": { type: "string" }, "login-file": { type: "string" }, cli: { type: "string" }, "expect-cli-version": { type: "string" },
        "allow-paid-call": { type: "boolean" }, "turn-timeout-ms": { type: "string" }, handoff: { type: "string" }, "run-dir": { type: "string" },
        manifest: { type: "string" }, "calibration-report": { type: "string" }, "export-dir": { type: "string" }, "expect-bundle-digest": { type: "string" },
      } });
    } catch (error) { throw new UsageError(message(error)); }
  })();
  const phase = parsed.positionals[0];
  if (parsed.positionals.length !== 1 || !["source", "calibrate", "export", "import", "resume"].includes(phase)) throw new UsageError("exactly one phase is required");
  const need: Record<Phase, string[]> = {
    source: ["evidence-dir", "login-file", "cli", "expect-cli-version"], calibrate: ["evidence-dir", "handoff", "login-file", "cli", "expect-cli-version"],
    export: ["run-dir", "manifest", "calibration-report"], import: ["run-dir", "export-dir", "expect-bundle-digest"], resume: ["run-dir", "login-file", "cli", "expect-cli-version"],
  };
  const flags = parsed.values as Record<string, string | boolean | undefined>;
  const missing = need[phase as Phase].filter(name => typeof flags[name] !== "string");
  if (missing.length > 0) throw new UsageError(`missing: ${missing.map(name => `--${name}`).join(" ")}`);
  if (phase === "import" && !SHA256.test(flags["expect-bundle-digest"] as string)) throw new UsageError("--expect-bundle-digest must be 64 lowercase hex characters");
  return { phase: phase as Phase, flags };
}

function timeoutOf(flags: Record<string, string | boolean | undefined>): number {
  const raw = flags["turn-timeout-ms"];
  const value = raw === undefined ? TURN_TIMEOUT_MS : Number(raw);
  if (!Number.isInteger(value) || value < 5_000 || value > 180_000) throw new UsageError("--turn-timeout-ms must be an integer from 5000 to 180000");
  return value;
}

export async function main(argv: string[], deps?: Deps): Promise<number> {
  let cli: ReturnType<typeof parseCli>;
  try { cli = parseCli(argv); } catch (error) {
    process.stderr.write(`${message(error)}\n${USAGE}\n`);
    return 2;
  }
  const f = cli.flags;
  const str = (name: string) => f[name] as string;
  let result: PhaseResult;
  try {
    const d = deps ?? productionDeps();
    const paid = { loginFile: str("login-file"), cli: str("cli"), expectVersion: str("expect-cli-version"), allowPaid: f["allow-paid-call"] === true, turnTimeoutMs: timeoutOf(f) };
    switch (cli.phase) {
      case "source": result = await runSource({ ...paid, evidenceDir: str("evidence-dir") }, d); break;
      case "calibrate": result = await runCalibrate({ ...paid, evidenceDir: str("evidence-dir"), handoff: str("handoff") }, d); break;
      case "export": result = await runExport({ runDir: str("run-dir"), manifest: str("manifest"), calibrationReport: str("calibration-report") }, d); break;
      case "import": result = await runImport({ runDir: str("run-dir"), exportDir: str("export-dir"), expectBundleDigest: str("expect-bundle-digest") }, d); break;
      case "resume": result = await runResume({ ...paid, runDir: str("run-dir") }, d); break;
      default: throw new UsageError("unknown phase");
    }
  } catch (error) {
    process.stderr.write(`${message(error)}\n${USAGE}\n`);
    return error instanceof UsageError ? 2 : 4;
  }
  console.log(result.summary);
  return result.exit_code;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
