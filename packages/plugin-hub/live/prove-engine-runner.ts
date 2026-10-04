// LIVE, PAID, DISPOSABLE: one real engine driven through the real hub exactly as an ordinary agent's chat is. Not CI, not a test file.
// Importing this module has no side effects; nothing runs unless it is the entry point.
//
//   BUN_FEATURE_FLAG_DISABLE_SQL_AUTO_PIPELINING=1 bun live/prove-engine-runner.ts \
//     --adapter <claude-code|codex|opencode> --model <id> --provider <id> [--effort <e>] [--paid plan|key] \
//     --credential-kind <claude-login|model-key> --credential-file <abs> [--base-url <https url>] \
//     [--bin <abs engine executable>] --evidence-dir <abs existing dir> [--scratch-parent <abs dir>] \
//     [--turn-timeout-ms N] [--stop-timeout-ms N] [--deadline-ms N] [--label <lane>] [--keep-stderr] [--keep-scratch] --allow-paid-call
//
// WHAT IS REAL: a throwaway Postgres with the shipped schema (`startCluster`, `freshDatabase`), a registry file (`writeRegistry`) with
// disposable `test-<hex>` person, agent, door, runner, chat and credential ids, the production door (`runDoor`) on the in-memory fake
// platform (every input is `fake.deliver`, so it is the door's own ingestion that writes it), and the production runner (`runRunner`) with
// the production `ADAPTERS` in a process of its own (`live/prove-engine-runner-child.ts`), so its stop and its start are a real restart.
// The launch is production's: `loopLaunch` prepares it, the box wraps it, the credential is opened by the launch and by nothing here.
//
// WHAT IS ADDED, AND ONLY THIS: the adapters are wrapped by the pure observer of `live/engine-observer.ts` (listeners, nothing replaced),
// and `--bin` pins the executable the way production finds it, by `PATH`: a directory holding one symlink named after the engine command
// (`claude`, `codex`, `opencode`) is put first on the runner process's `PATH`. `runRunner` has no binary option and `loopLaunch` resolves
// the command by name, so this is the one way to pin a build without replacing the production launch.
//
// THE SCENARIO (`turns`): T1 asks the model to read a random marker file in the person's tree with its own tool and NOT to repeat it; the
// file is deleted once T1 has settled. T2 (Russian) asks for the word with no tool. The runner is stopped (production `stop`, then each
// session's exit evidence) and a NEW runner process is started; T3 (Russian) asks again. Then the runner and the door are stopped and the
// store is read. The marker is never in any input, so a recall after T1 can only come from the engine's own session: T2 from the live child,
// T3 from the resumed native session (a resumed master is fed no history; the judge also requires that the restart RESUMED the same id).
//
// WHAT IS WRITTEN: `<evidence>/engine-proof-<adapter>-<stamp>-<tag>/` with `steps.jsonl` (write-ahead, so a killed run leaves a trail),
// `runner-<n>.journal.jsonl` (normalized observations), `report.json`, `replies.json` (mode 0600: each turn's delivered reply, the only
// message text written, so the Russian answers outlive the store; it carries the disposable marker), and `private/` (mode 0700; runner
// stderr only with --keep-stderr: it may carry engine diagnostics, never share it). Otherwise no message text, tool output, argv or env
// value, usage `raw`, or credential path; the marker is kept as its sha256. The report is written FIRST; then everything disposable goes:
// the database with its cluster, the scratch tree (registry, state with the engines' native sessions, person tree; under the OS temp
// directory unless --scratch-parent says otherwise) and the PATH shim (on macOS under /private/tmp, the box's scratch grant), and the
// report is written again with what the removal did. --keep-scratch keeps the tree and the shim for diagnosis. A tree is never removed
// while a process the sessions recorded is still alive: it is kept, and the run is CLEANUP_UNVERIFIED.
//
// EXIT: 0 PASS_SCOPED, 1 FAIL, 2 REFUSED (preflight, nothing started), 4 CLEANUP_UNVERIFIED or INTERRUPTED. Cleanup overrides everything:
// an engine process the production session recorded and that is not shown gone is 4 whatever else held.

import { createHash, randomBytes } from "node:crypto";
import { accessSync, appendFileSync, closeSync, constants, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, rmdirSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, isAbsolute, join, normalize, resolve } from "node:path";
import { ADAPTERS } from "../src/adapters/index.ts";
import { codexSessionMapPath } from "../src/adapters/codex.ts";
import { runDoor } from "../src/door/run.ts";
import { sessionDirFor } from "../src/runner/run.ts";
import { inboundId } from "../src/store/inbound.ts";
import { freshDatabase, hubPath, startCluster, type Cluster } from "../test/helpers/cluster.ts";
import { createFakePlatform, type FakePlatform } from "../test/helpers/fake-platform.ts";
import { chatLogLines, storeReader, userlessStoreUrl, type StoreReader } from "../test/helpers/hub-fixture.ts";
import { writeRegistry, type RegistrySpec } from "../test/helpers/registry.ts";
import { scrub, type Observed } from "./engine-observer.ts";

// ---------------------------------------------------------------------------------------------------------
// Arguments (pure)
// ---------------------------------------------------------------------------------------------------------

/** The command each engine's production launch runs, by name. A pinned `--bin` is reached under this name. */
export const ENGINE_COMMAND: Readonly<Record<string, string>> = { "claude-code": "claude", codex: "codex", opencode: "opencode" };
/** The one credential kind each production launch accepts. */
export const CREDENTIAL_KIND: Readonly<Record<string, "claude-login" | "model-key">> = { "claude-code": "claude-login", codex: "model-key", opencode: "model-key" };
/** The sender id the fake platform stamps on every delivered message; the harness checks it on the first delivery. */
export const FAKE_SENDER = "fixture-sender";

export interface ProofOptions {
  adapter: string;
  model: string;
  provider: string;
  effort: string;
  paid: "plan" | "key";
  credentialKind: "claude-login" | "model-key";
  credentialFile: string;
  baseUrl: string | null;
  bin: string | null;
  evidenceDir: string;
  scratchParent: string;
  turnTimeoutMs: number;
  stopTimeoutMs: number;
  deadlineMs: number;
  label: string | null;
  keepStderr: boolean;
  keepScratch: boolean;
}

export type Parsed = { ok: true; options: ProofOptions } | { ok: false; refusal: string; detail: string };

const VALUE_FLAGS = new Set(["--adapter", "--model", "--provider", "--effort", "--paid", "--credential-kind", "--credential-file", "--base-url",
  "--bin", "--evidence-dir", "--scratch-parent", "--turn-timeout-ms", "--stop-timeout-ms", "--deadline-ms", "--label"]);
const SWITCHES = new Set(["--allow-paid-call", "--keep-stderr", "--keep-scratch"]);
const BOUNDS: Record<string, [number, number, number]> = {
  "--turn-timeout-ms": [10_000, 1_800_000, 300_000],
  "--stop-timeout-ms": [5_000, 300_000, 60_000],
  "--deadline-ms": [60_000, 7_200_000, 2_400_000],
};

/** The command line, checked whole before anything is touched. `scratchDefault` is the host's temp directory, as its realpath. */
export function parseArgs(argv: readonly string[], scratchDefault: string): Parsed {
  const refuse = (refusal: string, detail: string): Parsed => ({ ok: false, refusal, detail });
  const values = new Map<string, string>();
  const switches = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (SWITCHES.has(arg)) { switches.add(arg); continue; }
    const eq = arg.indexOf("=");
    const name = eq > 0 ? arg.slice(0, eq) : arg;
    if (!VALUE_FLAGS.has(name)) return refuse("unknown_argument", name.startsWith("--") ? name : "a positional argument");
    const value = eq > 0 ? arg.slice(eq + 1) : argv[++i];
    if (value === undefined || value === "" || (eq < 0 && value.startsWith("--"))) return refuse("missing_value", name);
    if (values.has(name)) return refuse("repeated_flag", name);
    values.set(name, value);
  }
  if (!switches.has("--allow-paid-call")) return refuse("paid_call_not_allowed", "this harness makes real model calls; pass --allow-paid-call to say so");

  const adapter = values.get("--adapter") ?? "";
  if (!Object.hasOwn(ENGINE_COMMAND, adapter)) return refuse("adapter_unsupported", `--adapter is one of ${Object.keys(ENGINE_COMMAND).join(", ")}`);
  const kind = values.get("--credential-kind") ?? "";
  if (kind !== CREDENTIAL_KIND[adapter]) return refuse("credential_kind_mismatch", `${adapter} launches with a ${CREDENTIAL_KIND[adapter]} credential (--credential-kind)`);
  const model = values.get("--model") ?? "";
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$/.test(model)) return refuse("model_invalid", "--model is required: letters, digits and . _ : / @ -");
  const provider = values.get("--provider") ?? "";
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(provider)) return refuse("provider_invalid", "--provider is required: letters, digits, _ and -");
  const effort = values.get("--effort") ?? "low";
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(effort)) return refuse("effort_invalid", "--effort: letters, digits, _ and -");
  const paid = values.get("--paid") ?? (kind === "claude-login" ? "plan" : "key");
  if (paid !== "plan" && paid !== "key") return refuse("paid_invalid", "--paid is plan or key");

  const absolute = (flag: string, required: boolean): string | null | Parsed => {
    const value = values.get(flag);
    if (value === undefined) return required ? refuse("missing_flag", flag) : null;
    // Absolute and already normal: no `.` or `..` segment and no doubled separator, so the path checked is the path used.
    const bare = value.length > 1 ? value.replace(/\/+$/, "") : value;
    if (!isAbsolute(value) || normalize(bare) !== bare) return refuse("path_not_absolute", flag);
    return bare;
  };
  const credentialFile = absolute("--credential-file", true);
  if (typeof credentialFile !== "string") return credentialFile as Parsed;
  const evidenceDir = absolute("--evidence-dir", true);
  if (typeof evidenceDir !== "string") return evidenceDir as Parsed;
  const bin = absolute("--bin", false);
  if (bin !== null && typeof bin !== "string") return bin;
  const scratchParent = absolute("--scratch-parent", false);
  if (scratchParent !== null && typeof scratchParent !== "string") return scratchParent;

  const baseUrl = values.get("--base-url") ?? null;
  if (baseUrl !== null) {
    if (kind !== "model-key") return refuse("base_url_unsupported", "--base-url is a model-key's only");
    let url: URL;
    try { url = new URL(baseUrl); } catch { return refuse("base_url_invalid", "--base-url is not a URL"); }
    if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
      return refuse("base_url_invalid", "--base-url must be a plain https origin with no login, query or fragment");
    }
  }
  const numbers: Record<string, number> = {};
  for (const [flag, [low, high, fallback]] of Object.entries(BOUNDS)) {
    const said = values.get(flag);
    const value = said === undefined ? fallback : Number(said);
    if (!Number.isInteger(value) || value < low || value > high) return refuse("bound_invalid", `${flag} is a whole number of ms from ${low} to ${high}`);
    numbers[flag] = value;
  }
  if (numbers["--stop-timeout-ms"] >= numbers["--deadline-ms"] || numbers["--turn-timeout-ms"] >= numbers["--deadline-ms"]) {
    return refuse("bound_invalid", "--deadline-ms must exceed the turn and stop bounds");
  }
  const label = values.get("--label") ?? null;
  if (label !== null && !/^[a-z0-9][a-z0-9-]{0,31}$/.test(label)) return refuse("label_invalid", "--label: lower case letters, digits and -, at most 32");

  return { ok: true, options: {
    adapter, model, provider, effort, paid, credentialKind: kind as "claude-login" | "model-key", credentialFile, baseUrl, bin,
    evidenceDir, scratchParent: scratchParent ?? scratchDefault,
    turnTimeoutMs: numbers["--turn-timeout-ms"], stopTimeoutMs: numbers["--stop-timeout-ms"], deadlineMs: numbers["--deadline-ms"],
    label, keepStderr: switches.has("--keep-stderr"), keepScratch: switches.has("--keep-scratch"),
  } };
}

/**
 * Whether a binary's real path is one the macOS box lets a launched command read, by the grants `src/box/index.ts` writes on this date
 * (MAC_SYSTEM, macTools, MAC_WRITABLE_SCRATCH). A preflight courtesy so a pinned build outside them is refused by name before any paid
 * call; the box itself stays the authority and a binary it cannot read fails the launch however this answers.
 */
export function macBoxReadable(real: string, home: string): boolean {
  const roots = ["/usr/", "/bin/", "/sbin/", "/private/tmp/", `${home}/.local/`, `${home}/.bun/`,
    ...["bin", "opt", "Cellar", "lib", "libexec", "share"].map(dir => `/opt/homebrew/${dir}/`)];
  return roots.some(root => real.startsWith(root));
}

/** The prefix of every directory this harness makes with `mkdtemp`; nothing else is ever removed. */
export const SCRATCH_PREFIX = "hub-prove-";

/**
 * Removes the run's own disposable directories, and only those: each must be named by this harness's `mkdtemp` prefix and be a real
 * directory, not a link to one. A directory already gone counts as removed. What could not be removed, or is still there afterwards, is
 * named in `errors` and stays where it is.
 */
export function disposeScratch(dirs: readonly string[]): { removed: string[]; errors: string[] } {
  const removed: string[] = [];
  const errors: string[] = [];
  for (const dir of dirs) {
    if (!existsSync(dir)) { removed.push(dir); continue; }
    if (!basename(dir).startsWith(SCRATCH_PREFIX) || !lstatSync(dir).isDirectory()) { errors.push(`not this run's scratch, kept: ${dir}`); continue; }
    try { rmSync(dir, { recursive: true, force: true }); } catch (error) { errors.push(`${dir}: ${error instanceof Error ? error.message : String(error)}`); continue; }
    if (existsSync(dir)) errors.push(`still present after removal: ${dir}`);
    else removed.push(dir);
  }
  return { removed, errors };
}

// ---------------------------------------------------------------------------------------------------------
// Marker and judgment (pure)
// ---------------------------------------------------------------------------------------------------------

const folded = (text: string): string => text.toUpperCase().replace(/[^A-Z0-9]/g, "");

/** Whether `text` carries the marker, ignoring case, spacing, punctuation and quoting (a model writes `zephyr 1a2b...` as readily as the word). */
export function markerIn(text: string, marker: string): boolean {
  const wanted = folded(marker);
  return wanted !== "" && folded(text).includes(wanted);
}

export type Verdict = "PASS_SCOPED" | "FAIL" | "REFUSED" | "CLEANUP_UNVERIFIED" | "INTERRUPTED";
export const EXIT_CODE: Readonly<Record<Verdict, number>> = { PASS_SCOPED: 0, FAIL: 1, REFUSED: 2, CLEANUP_UNVERIFIED: 4, INTERRUPTED: 4 };

export interface TurnFacts {
  n: number;
  inbound: string | null;
  /** How the wait for this turn ended. `settled` means the attempt reached a terminal state (and, completed, its reply was delivered). */
  outcome: "settled" | "timeout" | "runner_exited" | "aborted" | "engine_refused_start" | "not_sent";
  detail: string | null;
  execution_state: string | null;
  executions: number;
  incarnation: string | null;
  native_session: string | null;
  reply_chunks: number;
  reply_chars: number;
  /** How many accepted posts in the chat equal each chunk exactly, in chunk order. */
  posts_per_chunk: number[];
  marker_recalled: boolean;
  /** The marker in this turn's own reply. Expected for T2 and T3; a failure for T1. */
  marker_in_reply: boolean;
  receipts: number;
  turn_ends: number;
  actions: number | null;
  action_results: number | null;
  engine_session: string | null;
  refused: { cause: string; said: string } | null;
  runner: number | null;
  elapsed_ms: number | null;
}

export interface RunnerFacts {
  n: number;
  pid: number | null;
  ready: boolean;
  ready_error: string | null;
  stop: "graceful" | "killed" | "exited_early" | "not_started";
  plans: { start: number; id: string; resume: boolean }[];
  start_failures: string[];
  starts: number;
  exits: { start: number; confirmed: boolean; basis: string | null; survivors: number[]; error: string | null }[];
  /** Processes the sessions recorded that were still alive after this runner process was gone, before any reap. */
  survivors: number[];
  reaped: number[];
  unreaped: number[];
}

export interface ProofFacts {
  interrupted: string | null;
  turns: TurnFacts[];
  runners: RunnerFacts[];
  inbound_rows: number;
  /** The marker anywhere in the chat (posts, edits, chat log, outbox) after T1 settled and before T2 was sent. */
  marker_leaked_before_recall: boolean;
  /** Message ids an engine took twice (receipts, across every start), and ones that ended twice. */
  duplicate_receipts: string[];
  /** Codex only: the thread its map named after each runner stopped (null: unreadable, or not this hub id's map). */
  codex_threads: (string | null)[];
  /** Whether the engine keeps a thread map whose thread must stay the same across the restart (Codex). */
  expect_codex_thread: boolean;
  /** A step of the scenario that threw (the store would not start, the marker could not be removed, ...). */
  scenario_errors: string[];
  /** Something that stops processes or the store did not do so. Any of these makes the run CLEANUP_UNVERIFIED. */
  cleanup_errors: string[];
}

/** The judgment over observed facts. Cleanup and interruption override everything; then every failure is named. */
export function judge(facts: ProofFacts): { verdict: Verdict; failures: string[] } {
  const failures: string[] = [];
  const turn = (n: number) => facts.turns.find(one => one.n === n);
  for (const n of [1, 2, 3]) {
    const t = turn(n);
    if (!t || t.outcome === "not_sent") { failures.push(`turn_${n}_not_run`); continue; }
    if (t.outcome !== "settled") failures.push(`turn_${n}_${t.outcome}`);
    else if (t.execution_state !== "completed") failures.push(`turn_${n}_not_completed`);
    if (t.executions > 1) failures.push(`turn_${n}_executed_${t.executions}_times`);
    if (t.outcome === "settled" && t.execution_state === "completed") {
      if (t.reply_chunks === 0) failures.push(`turn_${n}_no_reply`);
      if (t.posts_per_chunk.some(count => count !== 1)) failures.push(`turn_${n}_reply_not_posted_exactly_once`);
    }
    if (t.receipts > 1 || t.turn_ends > 1) failures.push(`turn_${n}_engine_took_it_twice`);
    if (t.execution_state === "completed" && t.actions === null) failures.push(`turn_${n}_actions_unobserved`);
  }
  const [t1, t2, t3] = [turn(1), turn(2), turn(3)];
  if (t1 && t1.actions !== null && t1.actions < 1) failures.push("turn_1_no_tool_action");
  if (t1?.marker_in_reply) failures.push("turn_1_marker_echoed");
  if (facts.marker_leaked_before_recall) failures.push("marker_reached_chat_before_recall");
  for (const t of [t2, t3]) {
    if (!t) continue;
    if ((t.actions ?? 0) > 0 || (t.action_results ?? 0) > 0) failures.push(`turn_${t.n}_tool_used`);
    if (!t.marker_recalled) failures.push(`turn_${t.n}_marker_not_recalled`);
  }
  // The restart: the new runner's first start resumed the very native id the first runner started.
  const first = facts.runners.find(one => one.n === 1)?.plans[0] ?? null;
  const second = facts.runners.find(one => one.n === 2)?.plans[0] ?? null;
  if (first === null) failures.push("native_session_unplanned");
  else if (first.resume) failures.push("first_start_was_a_resume");
  if (first !== null && (second === null || !second.resume || second.id !== first.id)) failures.push("restart_not_resumed");
  for (const runner of facts.runners) {
    if (runner.start_failures.length > 0) failures.push(`runner_${runner.n}_engine_start_failed`);
    if (!runner.ready) failures.push(`runner_${runner.n}_not_ready`);
  }
  // Every turn ran in the same native conversation, as the engine itself reported it.
  const sessions = new Set(facts.turns.map(one => one.engine_session).filter((one): one is string => one !== null));
  if (sessions.size > 1) failures.push("engine_session_changed");
  const threads = new Set(facts.codex_threads.filter((one): one is string => one !== null));
  if (threads.size > 1) failures.push("codex_thread_changed");
  if (facts.expect_codex_thread && (facts.codex_threads.length === 0 || facts.codex_threads.some(one => one === null))) failures.push("codex_thread_unread");
  if (facts.inbound_rows !== 3) failures.push(`inbound_rows_${facts.inbound_rows}`);
  if (facts.duplicate_receipts.length > 0) failures.push("duplicate_engine_input");
  if (facts.scenario_errors.length > 0) failures.push("scenario_error");

  const unclean = facts.runners.some(runner => runner.stop === "killed" || runner.survivors.length > 0 || runner.unreaped.length > 0 ||
    runner.exits.length < runner.starts || runner.exits.some(exit => !exit.confirmed)) || facts.cleanup_errors.length > 0;
  if (unclean) failures.push("cleanup_unverified");
  if (facts.interrupted !== null) return { verdict: "INTERRUPTED", failures: [`interrupted: ${facts.interrupted}`, ...failures] };
  if (unclean) return { verdict: "CLEANUP_UNVERIFIED", failures };
  return { verdict: failures.length === 0 ? "PASS_SCOPED" : "FAIL", failures };
}

// ---------------------------------------------------------------------------------------------------------
// The prompts. The marker is in none of them.
// ---------------------------------------------------------------------------------------------------------

export function promptsFor(markerPath: string): [string, string, string] {
  return [
    // Measured on MiniMax (Codex and OpenCode): a "code word" never to be written makes the model refuse the recalls as confidential,
    // and "use your tool" alone lets it answer DONE unread. So this is an openly non-secret memory test, the read is a required step,
    // and only THIS reply is asked to leave the label out.
    `This is a memory test of our conversation; nothing in it is secret. Step 1: call your file-reading tool now on the file ${markerPath}. ` +
      "Its content cannot be guessed, so you must actually read it. Step 2: remember the test label it holds; I will ask for it in a later " +
      "message of this same conversation. For the test, leave the label out of this reply only. After reading, reply with exactly one word: DONE",
    "Это продолжение нашей проверки памяти, метка не секретная. Не открывай никаких файлов и не используй никакие инструменты. Напиши " +
      "тестовую метку из файла, который ты прочитал по моей первой просьбе в этом разговоре. Ответь одним коротким предложением по-русски, " +
      "в котором есть эта метка.",
    "Снова без файлов и без инструментов: напиши ту же тестовую метку ещё раз. Ответь одним коротким предложением по-русски, в котором " +
      "есть эта метка.",
  ];
}

// ---------------------------------------------------------------------------------------------------------
// Processes
// ---------------------------------------------------------------------------------------------------------

interface RunnerChild {
  n: number;
  proc: ReturnType<typeof spawnChild>;
  journal: string;
  pid: number | null;
  exited: boolean;
  stopping: boolean;
}

function spawnChild(args: string[], env: Record<string, string | undefined>, stderr: number | "ignore") {
  return Bun.spawn([process.execPath, "run", hubPath("live/prove-engine-runner-child.ts"), ...args], {
    cwd: hubPath("."), env, stdin: "ignore", stdout: "pipe", stderr,
  });
}

/** The child's one ready line, bounded. Its stdout keeps being drained afterwards so a full pipe never blocks it. */
export async function readyLine(stream: ReadableStream<Uint8Array>, boundMs: number): Promise<{ ready: boolean; pid?: number; error?: string }> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let seen = "";
  const deadline = Date.now() + boundMs;
  try {
    for (;;) {
      const left = deadline - Date.now();
      if (left <= 0) return { ready: false, error: `no ready line within ${boundMs} ms` };
      const step = await Promise.race([reader.read(), Bun.sleep(left).then(() => null)]);
      if (step === null) return { ready: false, error: `no ready line within ${boundMs} ms` };
      if (step.value) seen += decoder.decode(step.value, { stream: true });
      for (const line of seen.split("\n").slice(0, -1)) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("{")) continue;
        try {
          const said = JSON.parse(trimmed) as { ready?: unknown; pid?: unknown; error?: unknown };
          if (typeof said.ready === "boolean") {
            return { ready: said.ready, ...(typeof said.pid === "number" ? { pid: said.pid } : {}), ...(typeof said.error === "string" ? { error: said.error } : {}) };
          }
        } catch { /* not the ready line */ }
      }
      if (step.done) return { ready: false, error: "the runner process exited without a ready line" };
    }
  } finally {
    void (async () => { try { for (;;) { if ((await reader.read()).done) return; } } catch { /* gone */ } })();
  }
}

export function alive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 1) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return (error as { code?: string }).code === "EPERM"; }
}

export function readJournal(file: string): Observed[] {
  if (!existsSync(file)) return [];
  const out: Observed[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    try { out.push(JSON.parse(line) as Observed); } catch { /* a line cut by a kill */ }
  }
  return out;
}

/** Every engine process and group the production sessions recorded in one journal. */
export function recorded(lines: Observed[]): { pids: number[]; groups: number[] } {
  const pids = new Set<number>();
  const groups = new Set<number>();
  for (const line of lines) {
    if (line.kind === "started") {
      if (line.pid !== null) pids.add(line.pid);
      for (const pid of line.processes) pids.add(pid);
      if (line.group !== null) groups.add(line.group);
    } else if (line.kind === "turn_end") {
      for (const pid of line.processes) pids.add(pid);
    } else if (line.kind === "exit" && line.evidence) {
      for (const pid of line.evidence.pids) pids.add(pid);
      if (line.evidence.group !== null) groups.add(line.evidence.group);
    }
  }
  return { pids: [...pids], groups: [...groups] };
}

/**
 * The LAST resort, run only after the runner process is gone and only on processes its own sessions recorded: their groups (as the
 * adapter verified them) and their pids, terminated and then killed. Never this process or its group. A run that needed it is
 * CLEANUP_UNVERIFIED whatever else held, because the production stop did not show them gone.
 */
async function reap(pids: number[], groups: number[]): Promise<{ reaped: number[]; unreaped: number[] }> {
  const living = pids.filter(alive);
  if (living.length === 0) return { reaped: [], unreaped: [] };
  const safeGroups = groups.filter(group => Number.isSafeInteger(group) && group > 1 && group !== process.pid);
  const signal = (name: NodeJS.Signals) => {
    for (const group of safeGroups) { try { process.kill(-group, name); } catch { /* empty */ } }
    for (const pid of living) { if (pid !== process.pid) { try { process.kill(pid, name); } catch { /* gone */ } } }
  };
  signal("SIGTERM");
  await Bun.sleep(2_000);
  signal("SIGKILL");
  await Bun.sleep(500);
  const unreaped = living.filter(alive);
  return { reaped: living.filter(pid => !unreaped.includes(pid)), unreaped };
}

// ---------------------------------------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------------------------------------

const TERMINAL = new Set(["completed", "failed", "interrupted", "stopped", "stop_unknown"]);
const READY_BOUND_MS = 90_000;
const DOOR_BOUND_MS = 60_000;
const POLL_MS = 500;
/** How long an agent may stand unhealthy with nothing claimed before the turn is called refused at start. */
const HEALTH_GRACE_MS = 20_000;

export interface ProofResult { verdict: Verdict; exitCode: number; failures: string[]; report: string | null }

async function sha256File(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  const reader = Bun.file(path).stream().getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    hasher.update(value);
  }
  return hasher.digest("hex");
}

/** The installed build's own word for its version, through the production offline probes (no login, no model). */
async function engineVersion(adapter: string, executable: string): Promise<string> {
  if (adapter === "codex") return (await import("../src/adapters/codex-launch.ts")).probeCodexVersion(executable);
  if (adapter === "opencode") return (await import("../src/adapters/opencode-launch.ts")).probeOpenCodeVersion(executable);
  return (await (await import("../src/adapters/launch.ts")).probeLoopCapabilities(executable)).version;
}

export async function runEngineProof(options: ProofOptions, log: (line: string) => void = line => { process.stderr.write(line + "\n"); }): Promise<ProofResult> {
  const refused = (refusal: string, detail: string): ProofResult => {
    log(`REFUSED ${refusal}: ${detail}`);
    return { verdict: "REFUSED", exitCode: EXIT_CODE.REFUSED, failures: [refusal], report: null };
  };
  const redactions = [options.credentialFile];
  const command = ENGINE_COMMAND[options.adapter];

  // PREFLIGHT: nothing is written, started or opened before every one of these holds. The credential is looked at by metadata alone.
  if (process.env.BUN_FEATURE_FLAG_DISABLE_SQL_AUTO_PIPELINING !== "1") return refused("pipelining_not_disabled", "start with BUN_FEATURE_FLAG_DISABLE_SQL_AUTO_PIPELINING=1");
  const adapter = ADAPTERS[options.adapter];
  if (!adapter) return refused("adapter_missing", `${options.adapter} is not a production adapter`);
  if (adapter.activationBlock) return refused("adapter_activation_blocked", scrub(adapter.activationBlock.cause, redactions));
  const boxTool = process.platform === "darwin" ? "/usr/bin/sandbox-exec" : process.platform === "linux" ? "/usr/bin/bwrap" : null;
  if (boxTool === null || !existsSync(boxTool)) return refused("box_unavailable", `this host needs ${boxTool ?? "macOS or Linux"}`);
  const home = homedir();
  const dirOk = (path: string) => existsSync(path) && statSync(path).isDirectory();
  if (!dirOk(options.evidenceDir) || ["/", home, resolve(home, "..")].includes(resolve(options.evidenceDir))) {
    return refused("evidence_dir_invalid", "--evidence-dir must be an existing dedicated directory (not /, not the home or above it)");
  }
  if (!dirOk(options.scratchParent)) return refused("scratch_parent_invalid", "--scratch-parent must be an existing directory");
  if (!existsSync(options.credentialFile) || !statSync(options.credentialFile).isFile()) return refused("credential_file_missing", "--credential-file is not a file");
  const evidenceReal = realpathSync(options.evidenceDir);
  const credentialReal = realpathSync(options.credentialFile);
  if (credentialReal.startsWith(evidenceReal + "/") || options.credentialFile.startsWith(evidenceReal + "/")) {
    return refused("credential_inside_evidence", "keep the credential outside --evidence-dir");
  }
  let pinned: string | null = null;
  if (options.bin !== null) {
    try { accessSync(options.bin, constants.X_OK); } catch { return refused("bin_not_executable", "--bin is not an executable file"); }
    if (!statSync(options.bin).isFile()) return refused("bin_not_executable", "--bin is not an executable file");
    pinned = realpathSync(options.bin);
    if (process.platform === "darwin" && !macBoxReadable(pinned, home)) {
      return refused("bin_not_box_readable", "on macOS the box reads binaries only under /usr, /bin, /private/tmp, ~/.local, ~/.bun or the Homebrew prefix");
    }
  } else if (!Bun.which(command)) {
    return refused("engine_command_missing", `${command} is not on PATH; pass --bin`);
  }

  // RUN DIRECTORY and SCRATCH.
  const tag = randomBytes(4).toString("hex");
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const runDir = join(evidenceReal, `engine-proof-${options.adapter}-${stamp}-${tag}`);
  mkdirSync(runDir, { mode: 0o700 });
  const privateDir = join(runDir, "private");
  mkdirSync(privateDir, { mode: 0o700 });
  const stepsFile = join(runDir, "steps.jsonl");
  const step = (name: string, detail: Record<string, unknown> = {}): void => {
    appendFileSync(stepsFile, JSON.stringify({ at: new Date().toISOString(), step: name, ...detail }) + "\n", { mode: 0o600 });
    log(`[engine-proof] ${name}${Object.keys(detail).length ? ` ${JSON.stringify(detail)}` : ""}`);
  };
  const scratch = realpathSync(mkdtempSync(join(realpathSync(options.scratchParent), SCRATCH_PREFIX)));
  const ids = { person: `test-${tag}`, agent: `test-${tag}-lair`, door: `test-door-${tag}`, runner: `test-runner-${tag}`,
    chat: `test-chat-${tag}`, credential: `test-cred-${tag}` };
  const stateDir = join(scratch, "state");
  const tree = join(scratch, "trees", ids.person);
  const registryDir = join(scratch, "registry");
  for (const dir of [stateDir, join(tree, "notes"), registryDir]) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const marker = `ZEPHYR-${randomBytes(4).toString("hex").toUpperCase()}`;
  const markerFile = join(tree, "notes", `proof-${tag}.txt`);
  writeFileSync(markerFile, `${marker}\n`, { mode: 0o600 });
  const markerSha = createHash("sha256").update(marker).digest("hex");
  step("staged", { run: runDir, scratch, ids, marker_sha256: markerSha });

  // THE PIN: one symlink, named as production runs it, first on the runner's PATH. Checked to resolve to the pin before anything starts.
  // On macOS the shim sits in a box scratch grant (`/private/tmp`, MAC_WRITABLE_SCRATCH) and nothing else of this run does; on Linux the
  // host is bound read-only, so the scratch tree's own `bin/` is readable inside the box.
  let path = process.env.PATH ?? "";
  let shim: string | null = null;
  if (options.bin !== null) {
    if (process.platform === "darwin") shim = realpathSync(mkdtempSync(`/private/tmp/${SCRATCH_PREFIX}bin-`));
    else { shim = join(scratch, "bin"); mkdirSync(shim, { mode: 0o700 }); }
    symlinkSync(options.bin, join(shim, command));
    path = `${shim}:${path}`;
  }
  const executable = Bun.which(command, { PATH: path });
  if (!executable || (pinned !== null && realpathSync(executable) !== pinned)) {
    const disposed = options.keepScratch ? null : disposeScratch(shim !== null && !shim.startsWith(scratch + "/") ? [scratch, shim] : [scratch]);
    step("refused", { refusal: "pin_not_resolved", scratch_removed: disposed?.errors.length === 0 });
    return { verdict: "REFUSED", exitCode: EXIT_CODE.REFUSED, failures: ["pin_not_resolved"], report: null };
  }
  const binary: Record<string, unknown> = { command, pinned: pinned !== null, shim, path: executable, realpath: realpathSync(executable) };
  try { binary.size = statSync(binary.realpath as string).size; binary.sha256 = await sha256File(binary.realpath as string); } catch (error) { binary.hash_error = scrub(error, redactions); }
  try { binary.version = await engineVersion(options.adapter, executable); } catch (error) { binary.version_error = scrub(error, redactions); }
  step("engine", binary);

  // SIGNALS AND THE DEADLINE. The first signal (or the deadline) stops the scenario and the cleanup below runs, bounded; a second signal
  // kills the runner process and leaves (the cluster helper stops its server on exit). The cluster helper's own signal handlers are
  // replaced after it starts, because they end the process at once, before a runner could be stopped.
  let interrupted: string | null = null;
  const children: RunnerChild[] = [];
  const onSignal = (name: NodeJS.Signals) => {
    if (interrupted === null) { interrupted = `signal ${name}`; log(`[engine-proof] ${name}: stopping, cleanup follows (send again to abandon it)`); return; }
    for (const child of children) { if (!child.exited) { try { child.proc.kill("SIGKILL"); } catch { /* gone */ } } }
    process.exit(EXIT_CODE.INTERRUPTED);
  };
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  const listen = () => { for (const name of signals) { process.removeAllListeners(name); process.on(name, onSignal); } };
  listen();
  const deadline = setTimeout(() => { if (interrupted === null) { interrupted = `deadline ${options.deadlineMs} ms`; log("[engine-proof] deadline reached: stopping"); } }, options.deadlineMs);

  const facts: ProofFacts = { interrupted: null, turns: [], runners: [], inbound_rows: 0, marker_leaked_before_recall: false,
    duplicate_receipts: [], codex_threads: [], expect_codex_thread: options.adapter === "codex", scenario_errors: [], cleanup_errors: [] };
  const store: Record<string, unknown> = {};
  let cluster: Cluster | null = null;
  let read: StoreReader | null = null;
  let door: { stop(): Promise<void> } | null = null;
  let fake: FakePlatform | null = null;
  let registryFile = "";
  let database = "never_started";
  /** Each turn's delivered reply, written to `replies.json` the moment it is seen, so the answers outlive the store and the scratch. */
  const replies: { turn: number; chunks: string[] }[] = [];
  const repliesFile = join(runDir, "replies.json");
  const saveReplies = (): void => { writeFileSync(repliesFile, JSON.stringify({ marker_sha256: markerSha, replies }, null, 2) + "\n", { mode: 0o600 }); };
  /** The agent's master conversation, once the store has it. A holder, because it is filled in from inside the closures below. */
  const seen: { conversation: { id: string; native_session: string } | null } = { conversation: null };

  const startRunner = async (n: number): Promise<RunnerChild> => {
    const journal = join(runDir, `runner-${n}.journal.jsonl`);
    const stderr = options.keepStderr ? openSync(join(privateDir, `runner-${n}.stderr`), "a", 0o600) : "ignore";
    const proc = spawnChild([registryFile, ids.runner, journal], {
      ...process.env, PATH: path, PROVE_REDACT: JSON.stringify(redactions), BUN_FEATURE_FLAG_DISABLE_SQL_AUTO_PIPELINING: "1",
      // Inside the parent's own bound, so the child's fallback (each session's own interrupt) has room before a SIGKILL.
      PROVE_STOP_BOUND_MS: String(Math.max(1_000, options.stopTimeoutMs - 20_000)),
    }, stderr);
    if (typeof stderr === "number") closeSync(stderr);
    const child: RunnerChild = { n, proc, journal, pid: null, exited: false, stopping: false };
    children.push(child);
    void proc.exited.then(() => { child.exited = true; });
    const said = await readyLine(proc.stdout, READY_BOUND_MS);
    const facts1: RunnerFacts = { n, pid: said.pid ?? null, ready: said.ready, ready_error: said.ready ? null : scrub(said.error ?? "", redactions),
      stop: "not_started", plans: [], start_failures: [], starts: 0, exits: [], survivors: [], reaped: [], unreaped: [] };
    facts.runners.push(facts1);
    child.pid = said.pid ?? null;
    step(`runner_${n}_${said.ready ? "ready" : "refused"}`, { pid: child.pid, ...(said.ready ? {} : { error: facts1.ready_error }) });
    return child;
  };

  const stopRunner = async (child: RunnerChild): Promise<void> => {
    const mine = facts.runners.find(one => one.n === child.n)!;
    if (child.exited && !child.stopping) mine.stop = "exited_early";
    else {
      child.stopping = true;
      try { child.proc.kill("SIGTERM"); } catch { /* gone */ }
      const done = await Promise.race([child.proc.exited.then(() => true), Bun.sleep(options.stopTimeoutMs).then(() => false)]);
      if (done) mine.stop = "graceful";
      else {
        try { child.proc.kill("SIGKILL"); } catch { /* gone */ }
        await Promise.race([child.proc.exited, Bun.sleep(10_000)]);
        mine.stop = "killed";
      }
    }
    // What the journal says, now that the process is gone.
    const lines = readJournal(child.journal);
    for (const line of lines) {
      if (line.kind === "start") { mine.starts += 1; if (line.plan) mine.plans.push({ start: line.start, ...line.plan }); }
      if (line.kind === "start_failed") mine.start_failures.push(line.error);
      if (line.kind === "runner" && line.event === "stop_failed") facts.cleanup_errors.push(`runner ${child.n}: ${line.error ?? "stop failed"}`);
      if (line.kind === "exit") {
        mine.exits.push({ start: line.start, confirmed: line.evidence?.confirmed === true, basis: line.evidence?.basis ?? null,
          survivors: line.evidence?.survivors ?? [], error: line.error ?? null });
      }
    }
    // Starts that failed before a session existed have no process and no exit to show.
    mine.starts -= mine.start_failures.length;
    const { pids, groups } = recorded(lines);
    mine.survivors = pids.filter(alive);
    if (mine.survivors.length > 0) {
      const outcome = await reap(pids, groups);
      mine.reaped = outcome.reaped;
      mine.unreaped = outcome.unreaped;
    }
    step(`runner_${child.n}_stopped`, { stop: mine.stop, starts: mine.starts, plans: mine.plans, exits: mine.exits, survivors: mine.survivors,
      reaped: mine.reaped, unreaped: mine.unreaped });
  };

  /** Codex's own thread for the conversation, from the map the adapter keeps (read, never written): `hub` must be the conversation's id. */
  const codexThread = (): string | null => {
    const conversation = seen.conversation;
    if (options.adapter !== "codex" || conversation === null) return null;
    try {
      const dir = realpathSync(sessionDirFor(stateDir, ids.person, ids.agent, conversation.id));
      const map = JSON.parse(readFileSync(codexSessionMapPath(dir, conversation.native_session), "utf8")) as { hub?: unknown; thread?: unknown };
      return map.hub === conversation.native_session && typeof map.thread === "string" ? map.thread : null;
    } catch { return null; }
  };

  const readConversation = async (): Promise<void> => {
    if (!read || seen.conversation !== null) return;
    const [row] = await read.sql("select id, native_session from conversation where agent = $1 and kind = 'master'", [ids.agent]);
    if (row) seen.conversation = { id: String(row.id), native_session: String(row.native_session) };
  };

  const markerAnywhere = async (): Promise<boolean> => {
    if (!fake || !read) return false;
    if (fake.posts().some(post => markerIn(post.text, marker)) || fake.edits().some(edit => markerIn(edit.text, marker))) return true;
    if (chatLogLines(stateDir, ids.person, ids.agent).some(line => markerIn(String(line.text ?? ""), marker))) return true;
    return (await read.outbox()).some(row => markerIn(String(row.body ?? ""), marker));
  };

  /** One turn: delivered as the platform hands it to the door, then waited for until its attempt is terminal and its reply delivered. */
  const runTurn = async (n: number, text: string, child: RunnerChild): Promise<TurnFacts> => {
    const facts1: TurnFacts = { n, inbound: null, outcome: "not_sent", detail: null, execution_state: null, executions: 0, incarnation: null,
      native_session: null, reply_chunks: 0, reply_chars: 0, posts_per_chunk: [], marker_recalled: false, marker_in_reply: false, receipts: 0,
      turn_ends: 0, actions: null, action_results: null, engine_session: null, refused: null, runner: child.n, elapsed_ms: null };
    facts.turns.push(facts1);
    if (!fake || !read || interrupted !== null) { facts1.outcome = interrupted !== null ? "aborted" : "not_sent"; return facts1; }
    const began = Date.now();
    // Only posts made after this delivery are this turn's: an earlier reply with the same text ("DONE") is not a duplicate of it.
    const postsBefore = fake.posts().length;
    const message = fake.deliver({ text, chat: ids.chat });
    if (message.sender_id !== FAKE_SENDER) {
      facts1.outcome = "aborted";
      facts1.detail = "the fake platform's sender is not the one the person allows";
      return facts1;
    }
    const id = inboundId(fake.platform.name, message.chat, message.platform_message_id);
    facts1.inbound = id;
    step(`turn_${n}_sent`, { inbound: id, runner: child.n });
    const bound = began + options.turnTimeoutMs;
    let unhealthySince: number | null = null;
    for (;;) {
      if (interrupted !== null) { facts1.outcome = "aborted"; facts1.detail = interrupted; break; }
      const executions = await read.sql("select id, state, native_session, incarnation from execution where inbound_id = $1 order by started_at", [id]);
      facts1.executions = executions.length;
      const last = executions.at(-1);
      if (last) {
        facts1.execution_state = String(last.state);
        facts1.incarnation = last.incarnation === null ? null : String(last.incarnation);
        facts1.native_session = last.native_session === null ? null : String(last.native_session);
        if (TERMINAL.has(facts1.execution_state)) {
          if (facts1.execution_state !== "completed") { facts1.outcome = "settled"; break; }
          const chunks = await read.sql("select body, delivered_at from outbox where inbound_id = $1 order by seq_in_reply", [id]);
          if (chunks.length > 0 && chunks.every(row => row.delivered_at !== null)) {
            const bodies = chunks.map(row => String(row.body));
            facts1.reply_chunks = bodies.length;
            facts1.reply_chars = bodies.reduce((total, body) => total + body.length, 0);
            const posted = fake!.posts().slice(postsBefore).filter(post => post.chat === ids.chat);
            facts1.posts_per_chunk = bodies.map(body => posted.filter(post => post.text === body).length);
            facts1.marker_in_reply = bodies.some(body => markerIn(body, marker));
            facts1.marker_recalled = facts1.marker_in_reply;
            replies.push({ turn: n, chunks: bodies });
            saveReplies();
            facts1.outcome = "settled";
            break;
          }
        }
      } else {
        // The runner's own record of an agent it cannot serve (`agent_health`: `status` retry or blocked, and its `cause`).
        const [health] = await read.sql("select data from state_row where sheet = 'agent_health' and id = $1", [ids.agent]);
        const data = health?.data as Record<string, unknown> | undefined;
        if (data && (data.status === "retry" || data.status === "blocked")) {
          unhealthySince ??= Date.now();
          if (Date.now() - unhealthySince >= HEALTH_GRACE_MS) {
            facts1.outcome = "engine_refused_start";
            facts1.detail = scrub(`${String(data.status)}: ${String(data.cause ?? "")}`, redactions);
            break;
          }
        } else unhealthySince = null;
      }
      if (child.exited) { facts1.outcome = "runner_exited"; facts1.detail = `runner ${child.n} exited during the turn`; break; }
      if (Date.now() >= bound) {
        facts1.outcome = "timeout";
        const [row] = await read.sql("select state, claimed_by from inbound where id = $1", [id]);
        const recent = await read.sql("select stream, kind from ledger_event where subject in ($1, $2, $3) order by seq desc limit 8", [ids.agent, ids.runner, id]);
        facts1.detail = scrub(`inbound=${row ? `${String(row.state)}/${row.claimed_by === null ? "unclaimed" : "claimed"}` : "absent"} ` +
          `execution=${facts1.execution_state ?? "none"} recent=${recent.map(one => `${String(one.stream)}.${String(one.kind)}`).join(",")}`, redactions);
        break;
      }
      await Bun.sleep(POLL_MS);
    }
    facts1.elapsed_ms = Date.now() - began;
    // What the engine itself did with it, from the journal of the runner that served it.
    const lines = readJournal(child.journal);
    facts1.receipts = lines.filter(line => line.kind === "receipt" && line.message === id).length;
    const ends = lines.filter((line): line is Extract<Observed, { kind: "turn_end" }> => line.kind === "turn_end" && line.message === id);
    facts1.turn_ends = ends.length;
    const end = ends.at(-1);
    if (end) {
      facts1.actions = end.actions;
      facts1.action_results = end.action_results;
      // The engine's own word for its session first; the turn end's id where the engine never said one.
      facts1.engine_session = end.reported ?? end.session_id;
      facts1.refused = end.refused;
    }
    step(`turn_${n}_${facts1.outcome}`, { state: facts1.execution_state, executions: facts1.executions, reply_chunks: facts1.reply_chunks,
      posts_per_chunk: facts1.posts_per_chunk, marker_recalled: facts1.marker_recalled, actions: facts1.actions, action_results: facts1.action_results,
      engine_session: facts1.engine_session, refused: facts1.refused, elapsed_ms: facts1.elapsed_ms, ...(facts1.detail ? { detail: facts1.detail } : {}) });
    return facts1;
  };

  const prompts = promptsFor(markerFile);
  const settledOk = (t: TurnFacts) => t.outcome === "settled" && t.execution_state === "completed";
  try {
    cluster = await startCluster();
    listen();
    const db = await freshDatabase(cluster);
    read = storeReader(cluster, db);
    const spec: RegistrySpec = {
      hub: { store_url: userlessStoreUrl(cluster, db), state_dir: stateDir },
      people: [{ id: ids.person, tree, allowed_senders: { [ids.door]: [FAKE_SENDER] } }],
      credentials: [{ id: ids.credential, kind: options.credentialKind, file: options.credentialFile, owner: ids.person,
        ...(options.baseUrl !== null ? { base_url: options.baseUrl } : {}) }],
      presets: { proof: { adapter: options.adapter, model: options.model, provider: options.provider, effort: options.effort, paid: options.paid,
        credential: ids.credential } },
      agents: [{ id: ids.agent, person: ids.person, preset: "proof", chat: ids.chat, door: ids.door, runner: ids.runner }],
    };
    registryFile = writeRegistry(registryDir, spec);
    step("store_ready", { registry: registryFile });

    fake = createFakePlatform({ name: "fake" });
    const doorStart = new AbortController();
    const doorTimer = setTimeout(() => doorStart.abort(), DOOR_BOUND_MS);
    try { door = await runDoor({ door: ids.door, registryFile, platform: fake.platform, signal: doorStart.signal }); }
    finally { clearTimeout(doorTimer); }
    step("door_ready");

    const first = await startRunner(1);
    if (facts.runners[0].ready) {
      const t1 = await runTurn(1, prompts[0], first);
      // The file goes once T1 is over, whatever happened: a later recall cannot be a later read.
      try { unlinkSync(markerFile); step("marker_removed"); } catch (error) { facts.scenario_errors.push(`marker removal: ${scrub(error, redactions)}`); }
      await readConversation();
      if (settledOk(t1)) {
        facts.marker_leaked_before_recall = await markerAnywhere();
        await runTurn(2, prompts[1], first);
      }
    }
    await stopRunner(first);
    await readConversation();
    facts.codex_threads.push(codexThread());

    const t2 = facts.turns.find(one => one.n === 2);
    if (interrupted === null && t2 && settledOk(t2)) {
      const second = await startRunner(2);
      if (facts.runners[1].ready) await runTurn(3, prompts[2], second);
      await stopRunner(second);
      facts.codex_threads.push(codexThread());
    }
  } catch (error) {
    facts.scenario_errors.push(scrub(error, redactions));
    step("scenario_error", { error: scrub(error, redactions) });
  } finally {
    clearTimeout(deadline);
    // Whatever is still running is stopped, in the order a stop needs: runners (their engines with them), then the door, then the store.
    for (const child of children) {
      const mine = facts.runners.find(one => one.n === child.n);
      if (!mine) {
        // Spawned and never accounted for: nothing it started is known, so it is killed and the run cannot be called clean.
        try { child.proc.kill("SIGKILL"); } catch { /* gone */ }
        facts.cleanup_errors.push(`runner ${child.n} was never accounted for and was killed`);
      } else if (mine.stop === "not_started") {
        try { await stopRunner(child); } catch (error) { facts.cleanup_errors.push(`runner ${child.n}: ${scrub(error, redactions)}`); }
      }
    }
    if (door) {
      const stopped = await Promise.race([door.stop().then(() => true, () => false), Bun.sleep(30_000).then(() => false)]);
      if (!stopped) facts.cleanup_errors.push("the door did not stop within 30 s");
      step("door_stopped", { stopped });
    }
    if (read) {
      try {
        const inbound = await read.sql("select id, state from inbound where agent = $1 order by received_at", [ids.agent]);
        facts.inbound_rows = inbound.length;
        store.inbound = inbound.map(row => ({ id: String(row.id), state: String(row.state) }));
        store.executions = (await read.sql(
          "select id, inbound_id, state, runner, incarnation, native_session, started_at, ended_at from execution where agent = $1 order by started_at", [ids.agent],
        )).map(row => ({ id: String(row.id), inbound: String(row.inbound_id), state: String(row.state), incarnation: String(row.incarnation),
          native_session: row.native_session === null ? null : String(row.native_session), started_at: row.started_at, ended_at: row.ended_at }));
        store.conversations = (await read.sql(
          "select id, kind, adapter, machine, native_session, native_state from conversation where agent = $1", [ids.agent],
        )).map(row => ({ id: String(row.id), kind: String(row.kind), adapter: String(row.adapter), machine: row.machine === null ? null : String(row.machine),
          native_session: String(row.native_session), native_state: String(row.native_state) }));
        store.incarnations = (await read.sql(
          "select detail from ledger_event where stream = 'runner' and subject = $1 and kind = 'incarnation' order by seq", [ids.runner],
        )).map(row => String((row.detail as Record<string, unknown>).incarnation ?? ""));
        const kinds = await read.sql("select stream, kind, count(*)::int as n from ledger_event group by stream, kind order by stream, kind");
        store.ledger_kinds = Object.fromEntries(kinds.map(row => [`${String(row.stream)}.${String(row.kind)}`, Number(row.n)]));
        const [health] = await read.sql("select data from state_row where sheet = 'agent_health' and id = $1", [ids.agent]);
        const data = health?.data as Record<string, unknown> | undefined;
        store.agent_health = data ? scrub(`${String(data.status ?? "")}: ${String(data.cause ?? "")}`, redactions) : null;
      } catch (error) { facts.cleanup_errors.push(`store read: ${scrub(error, redactions)}`); }
      await read.close().catch(() => {});
    }
    if (cluster) {
      // The cluster helper removes its own directory once the server is shown stopped, and keeps it otherwise.
      database = await cluster.stop().then(() => "removed", error => { facts.cleanup_errors.push(`cluster stop: ${scrub(error, redactions)}`); return "stop_failed_kept"; });
    }
    for (const name of signals) process.removeAllListeners(name);
  }

  // Receipts and turn ends across every runner's journal: an engine that took one message twice is a duplicate, whichever runner fed it.
  const taken = new Map<string, number>();
  for (const child of children) {
    for (const line of readJournal(child.journal)) {
      if (line.kind === "receipt") taken.set(line.message, (taken.get(line.message) ?? 0) + 1);
    }
  }
  facts.duplicate_receipts = [...taken.entries()].filter(([, count]) => count > 1).map(([message]) => message);
  facts.interrupted = interrupted;
  const disposable = shim !== null && !shim.startsWith(scratch + "/") ? [scratch, shim] : [scratch];
  const reportFile = join(runDir, "report.json");
  const writeReport = (cleanup: Record<string, unknown>): { verdict: Verdict; failures: string[] } => {
    const { verdict, failures } = judge(facts);
    const report = {
      version: 1, kind: "engine-runner-proof", scenario: "turns", verdict, exit_code: EXIT_CODE[verdict], failures,
      label: options.label, adapter: options.adapter,
      preset: { model: options.model, provider: options.provider, effort: options.effort, paid: options.paid },
      credential: { kind: options.credentialKind, base_url: options.baseUrl !== null },
      host: { os: process.platform, arch: process.arch, bun: Bun.version },
      binary, ids, scratch, cleanup,
      // The macOS box grants every launched engine read and write on /private/tmp: evidence kept there is within a tool's reach.
      evidence_box_writable: process.platform === "darwin" && (runDir.startsWith("/private/tmp/") || runDir.startsWith("/tmp/")),
      marker: { sha256: markerSha, removed_after_turn_1: !existsSync(markerFile) },
      replies: { file: replies.length > 0 ? "replies.json" : null, turns: replies.map(one => one.turn) },
      native: {
        conversation: seen.conversation?.id ?? null,
        hub_native_session: seen.conversation?.native_session ?? null,
        plans: facts.runners.map(runner => ({ runner: runner.n, plans: runner.plans })),
        engine_sessions: facts.turns.map(turn => ({ turn: turn.n, engine_session: turn.engine_session })),
        codex_threads: facts.codex_threads,
      },
      facts, store,
      claims: "PASS_SCOPED means only: on this host, this build and this preset, one tool turn read a marker that no input carried, the same " +
        "conversation recalled it with no tool in a live child and again after a real runner process restart that resumed the same native " +
        "session id, every input was taken and answered once, every engine process the sessions recorded was shown gone, and (unless " +
        "--keep-scratch) the run's database, scratch tree and PATH shim were removed.",
    };
    writeFileSync(reportFile, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
    return { verdict, failures };
  };

  // The compact proof is saved FIRST; only then does anything disposable go, and the report is written again with what that did.
  writeReport({ database, scratch: options.keepScratch ? "kept_on_request" : "pending", dirs: disposable });
  step("report_saved", { report: reportFile, replies: replies.length });
  let scratchState: string;
  if (options.keepScratch) scratchState = "kept_on_request";
  else {
    // Never under a living process: a runner process not shown gone, or any engine process a session recorded that is still alive.
    const living = [...children.filter(child => !child.exited).map(child => child.pid ?? -1),
      ...children.flatMap(child => recorded(readJournal(child.journal)).pids).filter(alive)];
    if (living.length > 0) {
      scratchState = "kept_process_alive";
      facts.cleanup_errors.push(`scratch kept: ${living.length} recorded process(es) still alive`);
    } else {
      const disposed = disposeScratch(disposable);
      facts.cleanup_errors.push(...disposed.errors.map(error => `scratch: ${scrub(error, redactions)}`));
      scratchState = disposed.errors.length === 0 ? "removed" : "removal_failed";
    }
  }
  if (!options.keepStderr) { try { if (readdirSync(privateDir).length === 0) rmdirSync(privateDir); } catch { /* left as it is */ } }
  const { verdict, failures } = writeReport({ database, scratch: scratchState, dirs: disposable });
  step("scratch_" + scratchState, { dirs: disposable });
  log(`[engine-proof] ${verdict} (${failures.length === 0 ? "no failures" : failures.join(", ")}) report=${reportFile}`);
  return { verdict, exitCode: EXIT_CODE[verdict], failures, report: reportFile };
}

const USAGE = `usage: BUN_FEATURE_FLAG_DISABLE_SQL_AUTO_PIPELINING=1 bun live/prove-engine-runner.ts \\
  --adapter <claude-code|codex|opencode> --model <id> --provider <id> [--effort low] [--paid plan|key] \\
  --credential-kind <claude-login|model-key> --credential-file <abs> [--base-url <https origin>] \\
  [--bin <abs executable>] --evidence-dir <abs dir> [--scratch-parent <abs dir>] \\
  [--turn-timeout-ms 300000] [--stop-timeout-ms 60000] [--deadline-ms 2400000] [--label <lane>] [--keep-stderr] [--keep-scratch] --allow-paid-call`;

if (import.meta.main) {
  // The OS temp directory, as the production capability probe uses: the box grants none of it but the paths a launch names.
  const parsed = parseArgs(process.argv.slice(2), realpathSync(tmpdir()));
  if (!parsed.ok) {
    process.stderr.write(`REFUSED ${parsed.refusal}: ${parsed.detail}\n${USAGE}\n`);
    process.exit(EXIT_CODE.REFUSED);
  }
  const result = await runEngineProof(parsed.options);
  process.exit(result.exitCode);
}
