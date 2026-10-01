// The native-session portability MEASUREMENT harness (live/claude-session-portability.ts), driven end to end with a FAKE
// production adapter: no Claude, no network, no box, no database, no service manager. The fake CLI keeps its transcript
// under a locator derived from its own cwd and can only resume what it finds there, so a wrongly placed import really
// fails to resume. Fault scenarios (omitted init, wrong id, no result, quota, refusal, replayed tool, unverified
// cleanup, ...) are injected into the fake and judged by the real harness code.

import { afterAll, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Adapter, AdapterProgress, AdapterSession, ExitEvidence, TurnEnd } from "../src/adapters/types.ts";
import { VALIDATED_ORDINARY_PROFILES } from "../src/adapters/claude-code.ts";
import { NATIVE_DELEGATION_TOOLS, type LoopLaunchInput } from "../src/adapters/launch.ts";
import { sha256Hex } from "../src/transfer/bundle.ts";
import type { Inventory } from "../live/claude-session-portability-files.ts";
import {
  checkLaunch, decide, EFFORT, FIXTURE_TOOL, judgeResume, main, MODEL, parseCli, rejudgeResumeReport, RESUME_PROMPT, runCalibrate, runExport, runImport, runResume, runSource, toolsOf,
  weeklyPercent, type Deps, type LaunchAdapter, type PhaseResult, type TurnFacts,
} from "../live/claude-session-portability.ts";

const made: string[] = [];
afterAll(() => { for (const dir of made) rmSync(dir, { recursive: true, force: true }); });
// A rejection nobody handled (a feed or close that fails after the harness moved on) is a defect, not noise: collected and asserted on.
const unhandled: unknown[] = [];
process.on("unhandledRejection", reason => { unhandled.push(reason); });
const settleLate = () => new Promise(resolve => setTimeout(resolve, 260)); // longer than the 150 ms late failures the fake injects
const scratch = () => { const dir = realpathSync(mkdtempSync(join(tmpdir(), "csp-phase-"))); made.push(dir); return dir; };
const json = (file: string): any => JSON.parse(readFileSync(file, "utf8"));
const rep = (result: PhaseResult): any => result.report;

// A login path that does not exist and must never appear in any artifact.
const LOGIN = "/nonexistent-login-dir-for-tests/runner-login-secret/.credentials.json";

// ---------------------------------------------------------------------------------------------------------
// The fake production adapter. Its "CLI" is a few lines of file behaviour, not a model.

interface Scenario {
  omitInit?: boolean; wrongInit?: string; noResult?: boolean; silent?: boolean; refuse?: "login" | "window"; pct?: number;
  effectsPerCall?: number; toolOnTurn2?: boolean; toolOnResume?: boolean; resumeStartsFresh?: boolean; noTranscript?: boolean;
  unverified?: boolean; interruptFixes?: boolean; throwOnStart?: boolean; leakIntoArgv?: () => string | undefined;
  /** Feed that never settles and delivers nothing / that never settles but the engine answers anyway / that rejects at once / that rejects after the harness moved on. */
  hangFeed?: boolean; feedNeverSettles?: boolean; feedRejects?: "now" | "late";
  /** Close that never settles / that rejects at once / that rejects long after its bound. */
  hangClose?: boolean; closeRejects?: "now" | "late";
  /** The fake CLI rewrites the first byte of the transcript it resumes, then appends. */
  rewritePrefix?: boolean;
  /** Extra progress events (a builtin tool action, a bare tool result) at the start of a turn. */
  emit?: (info: { turn: number; resume: boolean; text: string }) => AdapterProgress[];
  onPrepare?: (input: LoopLaunchInput) => void; onTurnEnd?: (turn: number) => void; onClose?: () => void;
}
interface FakeCli {
  scenario: Scenario; version: string; prepares: number; closes: number; interrupts: number; prepared: LoopLaunchInput[];
  starts: { id: string; resume: boolean; cwd: string }[]; feeds: { id: string; prompt: string; resume: boolean }[]; adapter: LaunchAdapter;
}
type StartOptions = Parameters<Adapter["start"]>[0];
const enc = (cwd: string) => cwd.replace(/[^A-Za-z0-9]/g, "-"); // THIS FAKE's locator rule; the harness never computes one
const usage = (pct: number) => ({ input_tokens: 1, cached_input_tokens: 0, output_tokens: 2, plan_usage: { seven_day: { utilization: pct / 100 } },
  window: { utilization: pct / 100, resets_at: null }, resolved_model_ids: [MODEL], primary_model_id: MODEL, raw: { num_turns: 1 } });

function fakeCli(scenario: Scenario = {}): FakeCli {
  const fixtureOf = new Map<string, string>();
  const cli: FakeCli = { scenario, version: "2.1.286", prepares: 0, closes: 0, interrupts: 0, prepared: [], starts: [], feeds: [], adapter: null as unknown as LaunchAdapter };
  cli.adapter = {
    async prepareLaunch(input) {
      cli.prepares++;
      cli.prepared.push(input);
      cli.scenario.onPrepare?.(input);
      // What production prepareLaunch does for an ordinary agent: its own list as configured, else this build's validated profile, else a named refusal.
      const profile = VALIDATED_ORDINARY_PROFILES[cli.version];
      const tools = input.agent.tools ?? (profile ? [...profile] : undefined);
      if (tools === undefined) throw new Error("ordinary-tool-profile-unvalidated");
      mkdirSync(input.sessionDir, { recursive: true, mode: 0o700 });
      const cwd = realpathSync(input.sessionDir);
      for (const dir of ["config", "home", "tmp"]) mkdirSync(join(cwd, dir), { recursive: true });
      writeFileSync(join(cwd, "box.sb"), "(version 1)\n");
      writeFileSync(join(cwd, "instructions.md"), "fixed instructions\n");
      fixtureOf.set(cwd, dirname(input.agent.mcp!));
      const leak = cli.scenario.leakIntoArgv?.();
      return {
        cwd, credentialId: input.credential!.id, wrap: argv => argv,
        argv: ["claude", "--print", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--model", MODEL, "--effort", EFFORT,
          "--setting-sources", "", "--settings", "{}", "--strict-mcp-config", "--mcp-config", input.agent.mcp!, "--tools", tools.join(","), "--disable-slash-commands",
          "--disallowedTools", NATIVE_DELEGATION_TOOLS.join(","), ...(leak ? ["--note", leak] : []), "--dangerously-skip-permissions"],
        env: { PATH: "/usr/bin", HOME: join(cwd, "home"), TMPDIR: join(cwd, "tmp"), CLAUDE_CONFIG_DIR: join(cwd, "config"),
          CLAUDE_SECURESTORAGE_CONFIG_DIR: dirname(input.credential!.file), CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" },
      };
    },
    async start(options: StartOptions) {
      cli.starts.push({ id: options.session!.id, resume: options.session!.resume, cwd: options.cwd! });
      if (cli.scenario.throwOnStart) throw new Error("spawn failed");
      return session(cli, options, fixtureOf.get(options.cwd!)!);
    },
  };
  return cli;
}

function session(cli: FakeCli, options: StartOptions, fixtureDir: string): AdapterSession {
  const cwd = options.cwd!, cfg = options.env!.CLAUDE_CONFIG_DIR!, asked = options.session!;
  const receipts: ((id: string) => void)[] = [], progress: ((event: AdapterProgress) => void)[] = [], ends: ((end: TurnEnd) => void)[] = [];
  let leave!: (value: unknown) => void;
  const exited = new Promise<unknown>(resolve => { leave = resolve; });
  let reported: string | null = null, sid = asked.id, turn = 0, closed = false;
  const transcript = (id: string) => join(cfg, "projects", enc(cwd), `${id}.jsonl`);
  const append = (id: string, ...lines: object[]) => {
    mkdirSync(dirname(transcript(id)), { recursive: true });
    appendFileSync(transcript(id), lines.map(line => `${JSON.stringify(line)}\n`).join(""));
  };
  const evidence = (fixed = false): ExitEvidence => ({ confirmed: cli.scenario.unverified ? fixed : true, leader: "exited",
    descendants: cli.scenario.unverified && !fixed ? "unverified" : "none", pids: [4242], survivors: [], via: "fake", basis: "process-group", group: 4242 });

  const run = (message: { id: string; text: string }) => {
    const s = cli.scenario;
    if (closed || s.silent) return; // a closed child does nothing more
    if (s.noResult) { leave({ cause: "child-exited" }); return; }
    if (asked.resume && !s.resumeStartsFresh && !existsSync(transcript(asked.id))) { leave({ cause: "child-exited" }); return; } // "no conversation found"
    if (asked.resume && s.resumeStartsFresh) sid = crypto.randomUUID();
    reported = s.omitInit ? null : (s.wrongInit ?? sid);
    for (const handler of receipts) handler(message.id);
    for (const event of s.emit?.({ turn, resume: asked.resume, text: message.text }) ?? []) for (const handler of progress) handler(event);
    if (asked.resume && s.rewritePrefix) { // a CLI that rewrote what it was given, then appended
      const bytes = Buffer.from(readFileSync(transcript(sid)));
      bytes[0] = 0x58;
      writeFileSync(transcript(sid), bytes);
    }
    // Files a loop writes that are NOT the session's own.
    writeFileSync(join(cfg, ".claude.json"), "{\"userID\":\"x\"}");
    writeFileSync(join(cwd, "home", "cache.txt"), "cache");
    const calls = message.text.includes(FIXTURE_TOOL) || (s.toolOnTurn2 && turn === 2) || (asked.resume && s.toolOnResume);
    let result = "";
    if (calls) {
      for (const handler of progress) handler({ kind: "action", text: FIXTURE_TOOL });
      result = `RESULT-${randomBytes(12).toString("hex")}`;
      for (let n = 0; n < (s.effectsPerCall ?? 1); n++) appendFileSync(join(fixtureDir, "effects.jsonl"), `${JSON.stringify({ n, ts: 0, pid: 1, tool: "fixture_effect", result })}\n`);
      for (const handler of progress) handler({ kind: "action_result", text: "" });
    }
    const prior = existsSync(transcript(sid)) ? readFileSync(transcript(sid), "utf8") : "";
    let answer = "OK";
    if (message.text.includes("Remember this marker")) answer = "DONE";
    else if (/marker|tool returned|resumed/i.test(message.text)) {
      answer = `${prior.match(/MARK-[0-9a-f]{24}/)?.[0] ?? "unknown"} ${prior.match(/RESULT-[0-9a-f]{24}/)?.[0] ?? "unknown"}`;
    }
    if (!s.noTranscript) append(sid, { role: "user", text: message.text }, ...(calls ? [{ tool_result: result }] : []), { role: "assistant", text: answer });
    const end: TurnEnd = s.refuse
      ? { text: "", session_id: sid, refused: { cause: s.refuse, said: "Not logged in" }, usage: usage(s.pct ?? 12) }
      : { text: answer, session_id: sid, refused: null, usage: usage(s.pct ?? 12) };
    s.onTurnEnd?.(turn);
    for (const handler of ends) handler(end);
  };
  return {
    exited, get sessionId() { return sid; }, get reportedSessionId() { return reported; }, pid: 4242, lacks: [],
    onReceipt: handler => { receipts.push(handler); }, onProgress: handler => { progress.push(handler); }, onTurnEnd: handler => { ends.push(handler); },
    async feed(message) {
      const s = cli.scenario;
      cli.feeds.push({ id: message.id, prompt: message.text, resume: asked.resume });
      turn++;
      if (s.hangFeed) return new Promise<void>(() => {}); // a flush that never returns, nothing delivered
      setTimeout(() => run(message), 0);
      if (s.feedNeverSettles) return new Promise<void>(() => {}); // the engine answers, the flush never reports
      if (s.feedRejects === "now") throw new Error("pipe broke");
      if (s.feedRejects === "late") return new Promise<void>((_, reject) => setTimeout(() => reject(new Error("late flush failure")), 150));
    },
    async close() {
      const s = cli.scenario;
      closed = true; cli.closes++; leave({ cause: "closed" });
      s.onClose?.();
      if (s.hangClose) return new Promise<void>(() => {}); // production `shut` waits for the child with no bound of its own
      if (s.closeRejects === "now") throw new Error("close failed");
      if (s.closeRejects === "late") return new Promise<void>((_, reject) => setTimeout(() => reject(new Error("late close failure")), 150));
    },
    processes: () => [4242], group: () => 4242, partial: () => false,
    async exitEvidence() { return evidence(); },
    async interrupt() { cli.interrupts++; return evidence(cli.scenario.interruptFixes === true); },
  };
}

// ---------------------------------------------------------------------------------------------------------
// A world: one fake CLI, a "source host" and a "destination host" (different evidence roots, different machine ids)

function deps(cli: FakeCli, machine: string, over: Partial<Deps> = {}): Deps {
  return {
    adapter: cli.adapter,
    preflight: async () => ({ version: cli.version, native: ["--session-id", "--resume", "--disallowedTools"] }),
    resolveCli: () => null, host: () => ({ platform: "linux", arch: "x64", release: "test", bun: "test", machine }), uid: () => 1000, bwrapPresent: () => true,
    uuid: () => crypto.randomUUID(), hex: bytes => randomBytes(bytes).toString("hex"), now: () => new Date(), interrupt: new Promise<string>(() => {}),
    interrupted: () => null, closeBoundMs: 60, // short injected bound: the offline suite never waits the production 10 s
    fixtureCommand: "bun", fixtureScript: join(import.meta.dir, "..", "live", "claude-session-portability-fixture.ts"), ...over,
  };
}
interface World { cli: FakeCli; src: Deps; dst: Deps; srcEvidence: string; dstEvidence: string }
function world(scenario: Scenario = {}, over: { src?: Partial<Deps>; dst?: Partial<Deps> } = {}, dstMachine = "bbbbbbbbbbbb"): World {
  const cli = fakeCli(scenario);
  return { cli, srcEvidence: scratch(), dstEvidence: scratch(), src: deps(cli, "aaaaaaaaaaaa", over.src), dst: deps(cli, dstMachine, over.dst) };
}
const paid = (evidenceDir: string, extra: Record<string, unknown> = {}) =>
  ({ evidenceDir, loginFile: LOGIN, cli: "/usr/local/bin/claude", expectVersion: "2.1.286", allowPaid: true, turnTimeoutMs: 5000, ...extra });
const secrets = (run: string): { session_id: string; marker: string } => json(join(run, "private", "secrets.json"));

function reviewed(srcRun: string, calRun: string, over: { files?: string[]; drop_mapping?: boolean; extra?: any[] } = {}): string {
  const journal = json(join(srcRun, "journal.json")), inv = json(join(srcRun, "inventory.source.after.json")) as Inventory;
  const calFile = join(calRun, "phase-calibrate.report.json"), cal = json(calFile);
  const session = secrets(srcRun).session_id;
  const transcript = inv.entries.find(one => one.path.endsWith(`${session}.jsonl`))!.path;
  const srcDir = transcript.split("/")[2], destDir = cal.locator.project_dir as string, prefix = `config/projects/${srcDir}/`;
  const file = (path: string) => {
    const entry = inv.entries.find(one => one.path === path)!;
    const mapping = path.startsWith(prefix) && srcDir !== destDir && !over.drop_mapping ? { dest_path: `config/projects/${destDir}/${path.slice(prefix.length)}` } : {};
    return { path, sha256: entry.sha256, size: entry.size, mode: entry.mode, ...mapping };
  };
  const manifest = { version: 1, kind: "claude-session-export-manifest", run_id: journal.run_id, journal_nonce: journal.nonce, native_session: session,
    files: [...(over.files ?? [transcript]).map(file), ...(over.extra ?? [])],
    locator: { source_project_dir: srcDir, dest_project_dir: destDir, calibration_run_id: cal.run_id, calibration_report_sha256: sha256Hex(readFileSync(calFile)) } };
  const path = join(scratch(), "manifest.json");
  writeFileSync(path, JSON.stringify(manifest));
  return path;
}

interface Pipeline { w: World; s: PhaseResult; sRun: string; c: PhaseResult; cRun: string; session: string; marker: string }
async function throughCalibrate(scenario: Scenario = {}, over: { src?: Partial<Deps>; dst?: Partial<Deps> } = {}, dstMachine?: string): Promise<Pipeline> {
  const w = world(scenario, over, dstMachine);
  const s = await runSource(paid(w.srcEvidence) as any, w.src);
  expect(s.verdict).toBe("PASS_SCOPED");
  const sRun = s.run_dir!;
  const c = await runCalibrate({ ...paid(w.dstEvidence), handoff: join(sRun, "handoff.json") } as any, w.dst);
  expect(c.verdict).toBe("PASS_SCOPED");
  return { w, s, sRun, c, cRun: c.run_dir!, session: secrets(sRun).session_id, marker: secrets(sRun).marker };
}
async function throughImport(scenario: Scenario = {}) {
  const p = await throughCalibrate(scenario);
  const e = await runExport({ runDir: p.sRun, manifest: reviewed(p.sRun, p.cRun), calibrationReport: join(p.cRun, "phase-calibrate.report.json") }, p.w.src);
  expect(e.verdict).toBe("PASS_SCOPED");
  const exportDir = join(p.sRun, `export-${rep(e).export.export_id}`);
  const i = await runImport({ runDir: p.cRun, exportDir, expectBundleDigest: rep(e).export.bundle_digest }, p.w.dst);
  expect(i.verdict).toBe("PASS_SCOPED");
  return { ...p, e, exportDir, i };
}
/** An operator-style interrupt: a promise and the synchronous sticky flag the production handler sets together. */
function signalling() {
  let name: string | null = null;
  let resolve!: (value: string) => void;
  const interrupt = new Promise<string>(done => { resolve = done; });
  return { deps: { interrupt, interrupted: () => name } as Pick<Deps, "interrupt" | "interrupted">, fire: (which = "SIGINT") => { if (name === null) name = which; resolve(name); } };
}
/** The run directory of a launch, from its session directory (run/state/p1/sessions/p1-lair/<conversation>). */
const runOf = (sessionDir: string) => [1, 2, 3, 4, 5].reduce(dir => dirname(dir), sessionDir);
const resume = (p: { w: World; cRun: string }, extra: Record<string, unknown> = {}) =>
  runResume({ ...paid(p.w.dstEvidence, extra), runDir: p.cRun } as any, p.w.dst);
const everyFile = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(one => (one.isDirectory() ? everyFile(join(dir, one.name)) : [join(dir, one.name)]));

// ---------------------------------------------------------------------------------------------------------

test("a source, calibration, export, import and resume across two different realpaths: one process each, nothing copied but the reviewed transcript, the engine resumes its own session and no secret reaches a prompt or an artifact", async () => {
  const p = await throughImport();
  const { w, s, sRun, c, cRun, session, marker } = p;
  const toolResult = json(join(sRun, "handoff.json")).fixture.tool_result as string;

  // Source: two bounded turns, one fixture call, exactly one effect, the engine's own id, a transcript found by name.
  expect(s.exit_code).toBe(0);
  expect(rep(s).fixture.effect_count).toBe(1);
  expect(rep(s).turns.map((t: any) => t.tool_actions)).toEqual([[FIXTURE_TOOL], []]);
  expect(rep(s).turns[0].reported_at_first_event).toBe(session);
  expect(rep(s).process.confirmed).toBe(true);
  expect(rep(s).inventory.transcripts_named_by_session.length).toBe(1);
  expect(rep(s).inventory.ownership).toContain("not inferred");
  expect(rep(s).launch).toMatchObject({ login_path_recorded: false, login_dir_set: true, env_in_session: { HOME: "home", TMPDIR: "tmp", CLAUDE_CONFIG_DIR: "config" } });
  // The launch is the ordinary master's: the agent names no tools, production injects the build's profile, and the report reads it back from argv.
  expect(w.cli.prepared.length).toBe(2); // source, calibration; the resume below is the third
  expect(w.cli.prepared.every(input => input.agent.tools === undefined)).toBe(true);
  expect(rep(s).launch.tools_from_argv).toEqual([...VALIDATED_ORDINARY_PROFILES["2.1.286"]]);
  expect(rep(c).launch.tools_from_argv).toEqual([...VALIDATED_ORDINARY_PROFILES["2.1.286"]]);
  expect(rep(s).launch.delegation_denied_from_argv).toEqual([...NATIVE_DELEGATION_TOOLS]);
  expect(JSON.stringify(rep(s).launch)).not.toContain("none (--tools");
  // The process diagnostic record exists for every started child, with the production session's own pid, group and process list.
  expect(json(join(sRun, "phase-source.process.json"))).toMatchObject({ kind: "source", pid: 4242, group: 4242, observed_processes: [4242] });
  expect(rep(s).process).toMatchObject({ confirmed: true, close_timed_out: false, observed_before_close: [4242] });
  // The coordinator-facing report carries neither the marker nor the tool result.
  const srcReport = readFileSync(s.report_path!, "utf8");
  expect(srcReport).not.toContain(marker);
  expect(srcReport).not.toContain(toolResult);
  expect(rep(s).turns[1]).toMatchObject({ marker_in_text: true, tool_result_in_text: true });

  // Calibration: a fresh independent session at the destination's own path, never the source session.
  expect(rep(c).locator).toMatchObject({ measured: true, cwd_differs_from_source: true, same_machine_as_source: false });
  expect(rep(c).locator.project_dir).not.toBe(rep(s).inventory.project_dir_measured);
  expect(rep(c).invocations[0].session_id).not.toBe(session);
  const journal = json(join(cRun, "journal.json"));
  expect(rep(c).archive.archived_to).toBe(`calibration-archive/${journal.ids.conversation}`);
  expect(existsSync(join(cRun, "calibration-archive", journal.ids.conversation))).toBe(true);

  // Resume.
  const r = await resume(p);
  expect(r.verdict).toBe("PASS_SCOPED");
  expect(r.exit_code).toBe(0);
  expect(rep(r).fixture).toMatchObject({ effect_count_at_destination: 0, expected_new_effects: 0 });
  expect(rep(r).engine).toMatchObject({ asked_session_id: session, reported_at_first_event: session, result_session_id: session });
  expect(rep(r).turns[0]).toMatchObject({ marker_in_text: true, tool_result_in_text: true, tool_actions: [], tool_results: 0 });
  expect(rep(r).transcripts.imported_prefix_preserved).toBe(true);
  const after = rep(r).transcripts.after.map((one: any) => one.path);
  expect(after).toEqual(rep(r).transcripts.before.map((one: any) => one.path)); // no transcript anywhere else: not a fresh session
  expect(rep(r).pair.acceptance_note).toBe("observed pair only");
  expect(w.cli.prepared.length).toBe(3);
  expect(w.cli.prepared.every(input => input.agent.tools === undefined)).toBe(true);
  expect(rep(r).launch.tools_from_argv).toEqual([...VALIDATED_ORDINARY_PROFILES["2.1.286"]]);

  // Counts and identities, with no silent extra call: source, calibration, resume, one process each.
  expect(w.cli.starts.map(one => one.resume)).toEqual([false, false, true]);
  expect(w.cli.starts[0].id).toBe(session);
  expect(w.cli.starts[2].id).toBe(session);
  expect(new Set(w.cli.starts.map(one => one.id)).size).toBe(2);
  expect(w.cli.starts[0].cwd).not.toBe(w.cli.starts[2].cwd);
  expect(w.cli.feeds.map(one => one.resume)).toEqual([false, false, false, true]);
  expect(w.cli.interrupts).toBe(0);
  // The resumed prompt carries neither answer, and replays no original input.
  const resumed = w.cli.feeds[3].prompt;
  expect(resumed).toBe(RESUME_PROMPT);
  expect(resumed).not.toContain(marker);
  expect(resumed).not.toContain(toolResult);
  expect(w.cli.feeds.slice(0, 3).some(one => one.prompt === resumed)).toBe(false);

  // The login path (and its directory) is in no artifact of either run, however deep.
  for (const run of [sRun, cRun]) {
    for (const file of everyFile(run)) expect([file, readFileSync(file, "utf8").includes("runner-login-secret")]).toEqual([file, false]);
  }
});

test("the same machine and the same realpath are reported as harness debugging, never as an acceptance pair", async () => {
  const same = await throughCalibrate({}, {}, "aaaaaaaaaaaa");
  expect(rep(same.c).locator.same_machine_as_source).toBe(true);
  expect(rep(same.c).acceptance_eligible).toContain("NOT eligible");
});

test("the verdict is decided with cleanup first: a started loop that is not verified gone is exit 4 whatever else is true", () => {
  const base = { failures: [], refusals: [], quota: false, interrupted: null, processStarted: true, cleanupConfirmed: true };
  expect(decide(base)).toMatchObject({ verdict: "PASS_SCOPED", code: 0 });
  expect(decide({ ...base, failures: ["x"] })).toMatchObject({ verdict: "FAIL", code: 1 });
  expect(decide({ ...base, failures: ["x"], refusals: ["y"] })).toMatchObject({ verdict: "REFUSED", code: 2 });
  expect(decide({ ...base, refusals: ["y"], quota: true })).toMatchObject({ verdict: "STOPPED_QUOTA", code: 3 });
  expect(decide({ ...base, quota: true, interrupted: "SIGINT" })).toMatchObject({ verdict: "INTERRUPTED", code: 4 });
  for (const over of [{}, { failures: ["x"] }, { refusals: ["y"] }, { quota: true }, { interrupted: "SIGTERM" }]) {
    expect(decide({ ...base, ...over, cleanupConfirmed: false })).toMatchObject({ verdict: "CLEANUP_UNVERIFIED", code: 4 });
  }
  // No process started: nothing to clean up, and a refusal stays a refusal.
  expect(decide({ ...base, refusals: ["y"], processStarted: false, cleanupConfirmed: false })).toMatchObject({ verdict: "REFUSED", code: 2 });
  expect(weeklyPercent({ ...usage(0), window: { utilization: 0.96, resets_at: null }, plan_usage: null })).toBeCloseTo(96, 6);
  expect(weeklyPercent({ ...usage(0), window: null, plan_usage: { seven_day: { utilization: 97 } } })).toBeCloseTo(97, 6);
  expect(weeklyPercent({ ...usage(0), window: null, plan_usage: null })).toBeNull();
});

test("the source phase judges what was observed: omitted or wrong init, missing or refused results, a wrong effect count and a replayed tool are never a pass and leave no handoff", async () => {
  const cases: [string, Scenario, string, string][] = [
    ["omitted init", { omitInit: true }, "FAIL", "turn_1_engine_session_id_missing"],
    ["wrong init", { wrongInit: "99999999-9999-4999-8999-999999999999" }, "REFUSED", "turn_1_engine_session_id_mismatch"],
    ["no result", { noResult: true }, "FAIL", "turn_1_not_completed:exited"],
    ["timeout", { silent: true }, "FAIL", "turn_1_not_completed:timeout"],
    ["refused login", { refuse: "login" }, "FAIL", "turn_1_refused_login"],
    ["two effects", { effectsPerCall: 2 }, "FAIL", "effect_count_2_not_1"],
    ["tool again on turn 2", { toolOnTurn2: true }, "FAIL", "turn_2_used_tools"],
    ["no transcript", { noTranscript: true }, "REFUSED", "source_transcript_unlocated"],
    ["start fails", { throwOnStart: true }, "FAIL", "start_failed:spawn failed"],
  ];
  for (const [name, scenario, verdict, named] of cases) {
    const w = world(scenario);
    const result = await runSource(paid(w.srcEvidence, name === "timeout" ? { turnTimeoutMs: 40 } : {}) as any, w.src);
    const all = [...rep(result).judgments.failures, ...rep(result).judgments.refusals];
    expect([name, result.verdict, all.some((one: string) => one === named || one.startsWith(named))]).toEqual([name, verdict, true]);
    expect(existsSync(join(result.run_dir!, "handoff.json"))).toBe(false);
    expect(w.cli.starts.length).toBe(1); // never a second launch, retry or fallback
    if (["no result", "timeout", "refused login"].includes(name)) expect(w.cli.feeds.length).toBe(1); // stopped before the second turn
    if (name === "start fails") expect(w.cli.feeds.length).toBe(0);
    expect(existsSync(join(result.run_dir!, "journal.json"))).toBe(true);
  }
});

test("a weekly reading at the guard stops after that turn with no retry; a window refusal is the same stop", async () => {
  for (const scenario of [{ pct: 96 }, { refuse: "window" as const }]) {
    const w = world(scenario);
    const result = await runSource(paid(w.srcEvidence) as any, w.src);
    expect(result.verdict).toBe("STOPPED_QUOTA");
    expect(result.exit_code).toBe(3);
    expect(w.cli.feeds.length).toBe(1);
    expect(w.cli.starts.length).toBe(1);
    expect(existsSync(join(result.run_dir!, "handoff.json"))).toBe(false);
  }
  // A destination that learns of the guard from the source's own reading never starts a process.
  const p = await throughCalibrate();
  const handoff = json(join(p.sRun, "handoff.json"));
  const stale = join(scratch(), "handoff.json");
  writeFileSync(stale, JSON.stringify({ ...handoff, weekly_pct_seen: 96 }));
  const before = p.w.cli.starts.length;
  const stopped = await runCalibrate({ ...paid(p.w.dstEvidence), handoff: stale } as any, p.w.dst);
  expect(stopped.verdict).toBe("STOPPED_QUOTA");
  expect(p.w.cli.starts.length).toBe(before);
});

test("cleanup overrides a pass: an unverified loop is exit 4 with every artifact kept, only the production interrupt is tried, and a handoff is never made", async () => {
  const w = world({ unverified: true });
  const result = await runSource(paid(w.srcEvidence) as any, w.src);
  expect(result.verdict).toBe("CLEANUP_UNVERIFIED");
  expect(result.exit_code).toBe(4);
  expect(rep(result).judgments).toEqual({ failures: [], refusals: [] }); // everything else held
  expect(rep(result).process).toMatchObject({ confirmed: false, interrupt_used: true });
  expect(w.cli.interrupts).toBe(1);
  expect(w.cli.closes).toBe(1);
  expect(existsSync(join(result.run_dir!, "handoff.json"))).toBe(false);
  for (const kept of ["journal.json", "inventory.source.before.json", "inventory.source.after.json", "private/turns.source.json", "phase-source.started.json", "phase-source.report.json"]) {
    expect([kept, existsSync(join(result.run_dir!, kept))]).toEqual([kept, true]);
  }
  // When the production interrupt does bring the evidence to confirmed, that, and only that, is a pass.
  const fixed = world({ unverified: true, interruptFixes: true });
  expect((await runSource(paid(fixed.srcEvidence) as any, fixed.src)).verdict).toBe("PASS_SCOPED");
  expect(fixed.cli.interrupts).toBe(1);
});

test("an interrupt is read at every action boundary and can never publish a pass or launch a next turn: before prepare, inside prepare, between turns, in the last result callback, in close, during a wait; an unverified loop still outranks it", async () => {
  const run = async (scenario: Scenario, arm: (sig: ReturnType<typeof signalling>, cli: FakeCli) => void) => {
    const sig = signalling();
    const w = world(scenario, { src: sig.deps });
    arm(sig, w.cli);
    return { w, sig, result: await runSource(paid(w.srcEvidence) as any, w.src) };
  };
  const nothingHandedOff = (result: PhaseResult) => expect(existsSync(join(result.run_dir!, "handoff.json"))).toBe(false);

  // Interrupted before anything: nothing is prepared, started or fed (the old expectation of one start was wrong).
  const first = await run({}, sig => sig.fire("SIGTERM"));
  expect([first.result.verdict, first.result.exit_code]).toEqual(["INTERRUPTED", 4]);
  expect(first.result.outcome).toContain("no process was started");
  expect([first.w.cli.prepares, first.w.cli.starts.length, first.w.cli.feeds.length]).toEqual([0, 0, 0]);
  nothingHandedOff(first.result);

  // Inside prepare: prepared once, never written ahead, never started or fed.
  const inPrepare = await run({}, (sig, cli) => { cli.scenario.onPrepare = () => sig.fire(); });
  expect(inPrepare.result.verdict).toBe("INTERRUPTED");
  expect([inPrepare.w.cli.prepares, inPrepare.w.cli.starts.length, inPrepare.w.cli.feeds.length]).toEqual([1, 0, 0]);
  expect(existsSync(join(inPrepare.result.run_dir!, "phase-source.started.json"))).toBe(false);
  nothingHandedOff(inPrepare.result);

  // Between the callbacks of turn 1 and turn 2: exactly one feed, the loop still closed and verified.
  const between = await run({}, (sig, cli) => { cli.scenario.onTurnEnd = n => { if (n === 1) sig.fire(); }; });
  expect(between.result.verdict).toBe("INTERRUPTED");
  expect([between.w.cli.starts.length, between.w.cli.feeds.length, between.w.cli.closes]).toEqual([1, 1, 1]);
  expect(rep(between.result).stopped).toBe("interrupted");
  expect(rep(between.result).process.confirmed).toBe(true);
  nothingHandedOff(between.result);

  // Inside the LAST result callback, with every judgment otherwise holding: still not a pass, no handoff.
  const last = await run({}, (sig, cli) => { cli.scenario.onTurnEnd = n => { if (n === 2) sig.fire(); }; });
  expect(last.result.verdict).toBe("INTERRUPTED");
  expect(last.w.cli.feeds.length).toBe(2);
  expect(rep(last.result).judgments).toEqual({ failures: [], refusals: [] });
  nothingHandedOff(last.result);

  // Inside close: the cleanup that was asked for still completes and is verified, and the verdict is not a pass.
  const inClose = await run({}, (sig, cli) => { cli.scenario.onClose = () => sig.fire(); });
  expect(inClose.result.verdict).toBe("INTERRUPTED");
  expect(rep(inClose.result).process.confirmed).toBe(true);
  nothingHandedOff(inClose.result);

  // While a turn is being waited for (the promise path): the same stop, one feed.
  const waiting = await run({ silent: true }, sig => { setTimeout(() => sig.fire(), 30); });
  expect(waiting.result.verdict).toBe("INTERRUPTED");
  expect([waiting.w.cli.feeds.length, waiting.w.cli.closes]).toEqual([1, 1]);

  // An unverified loop outranks the interrupt, and cleanup was still attempted after the signal.
  const unverified = await run({ unverified: true }, (sig, cli) => { cli.scenario.onClose = () => sig.fire(); });
  expect(unverified.result.verdict).toBe("CLEANUP_UNVERIFIED");
  expect(unverified.w.cli.interrupts).toBe(1);

  // Calibration: a signal during cleanup leaves the destination directory where it is, never archived.
  const w = world({});
  const s = await runSource(paid(w.srcEvidence) as any, w.src);
  expect(s.verdict).toBe("PASS_SCOPED");
  const sig = signalling();
  w.cli.scenario.onClose = () => sig.fire();
  const c = await runCalibrate({ ...paid(w.dstEvidence), handoff: join(s.run_dir!, "handoff.json") } as any, { ...w.dst, ...sig.deps });
  expect(c.verdict).toBe("INTERRUPTED");
  expect(rep(c).archive).toBeUndefined();
  expect(existsSync(join(c.run_dir!, "calibration-archive"))).toBe(false);
  expect(existsSync(json(join(c.run_dir!, "journal.json")).paths.session_dir)).toBe(true);
});

test("an interrupt before an import or an export is a refusal to start it, with nothing created", async () => {
  const p = await throughCalibrate();
  const manifest = reviewed(p.sRun, p.cRun);
  const sig = signalling();
  sig.fire();
  const e = await runExport({ runDir: p.sRun, manifest, calibrationReport: join(p.cRun, "phase-calibrate.report.json") }, { ...p.w.src, ...sig.deps });
  expect(e.verdict).toBe("INTERRUPTED");
  expect(readdirSync(p.sRun).filter(name => name.startsWith("export-"))).toEqual([]);
  const good = await runExport({ runDir: p.sRun, manifest, calibrationReport: join(p.cRun, "phase-calibrate.report.json") }, p.w.src);
  const exportDir = join(p.sRun, `export-${rep(good).export.export_id}`);
  const i = await runImport({ runDir: p.cRun, exportDir, expectBundleDigest: rep(good).export.bundle_digest }, { ...p.w.dst, ...sig.deps });
  expect(i.verdict).toBe("INTERRUPTED");
  expect(existsSync(json(join(p.cRun, "journal.json")).paths.session_dir)).toBe(false);
  expect(existsSync(join(p.cRun, "import.json"))).toBe(false);
});

test("nothing starts without the explicit opt-in or with a precondition unmet, and a refusal never spends a call", async () => {
  const w = world();
  const attempt = async (extra: Record<string, unknown>, over: Partial<Deps> = {}, evidenceDir = w.srcEvidence) =>
    runSource(paid(evidenceDir, extra) as any, { ...w.src, ...over });
  const cases: [string, PhaseResult][] = [
    ["paid_call_not_opted_in", await attempt({ allowPaid: false })],
    ["running_as_root", await attempt({}, { uid: () => 0 })],
    ["platform_unsupported", await attempt({}, { host: () => ({ platform: "win32", arch: "x", release: "r", bun: "b", machine: "m" }) })],
    ["bwrap_missing", await attempt({}, { host: () => ({ platform: "linux", arch: "x", release: "r", bun: "b", machine: "m" }), bwrapPresent: () => false })],
    ["login_file_shape", await attempt({ loginFile: "/x/not-a-login.json" })],
    ["cli_not_absolute", await attempt({ cli: "claude" })],
    ["claude_on_path_is_not_cli_flag", await attempt({}, { resolveCli: () => "claude_on_path_is_not_cli_flag" })],
    ["evidence_dir_is_root_or_home", await attempt({}, {}, "/")],
    ["evidence_dir_missing", await attempt({}, {}, join(w.srcEvidence, "nope"))],
    ["evidence_dir_overlaps_login", await attempt({ loginFile: join(w.srcEvidence, "login", ".credentials.json") })],
  ];
  for (const [code, result] of cases) expect([code, result.verdict, rep(result).judgments.refusals]).toEqual([code, "REFUSED", [code]]);
  expect(w.cli.prepares).toBe(0);
  expect(w.cli.starts.length).toBe(0);

  // A build outside the validated lists, or not the expected one, is refused after the run is journaled and before any launch.
  for (const [version, named] of [["2.1.200", "cli_version_2.1.200_is_not_expected_2.1.286"], ["2.1.286", ""]] as const) {
    const result = await runSource(paid(w.srcEvidence, version === "2.1.286" ? { expectVersion: "2.1.285" } : {}) as any,
      { ...w.src, preflight: async () => ({ version, native: ["--session-id", "--resume"] }) });
    expect(result.verdict).toBe("REFUSED");
    expect(rep(result).judgments.refusals.some((one: string) => one.startsWith(named || "cli_version_2.1.286_is_not_expected_2.1.285"))).toBe(true);
    expect(existsSync(join(result.run_dir!, "journal.json"))).toBe(true);
  }
  const lacking = await runSource(paid(w.srcEvidence) as any, { ...w.src, preflight: async () => ({ version: "2.1.286", native: ["--session-id"] }) });
  expect(rep(lacking).judgments.refusals).toEqual(["cli_lacks_session_flags"]);
  expect(w.cli.prepares).toBe(0);

  // A preflight message that names the login path is scrubbed before it is written or printed.
  const leaky = await runSource(paid(w.srcEvidence) as any, { ...w.src, preflight: async () => { throw new Error(`cannot access ${LOGIN}`); } });
  expect(leaky.verdict).toBe("REFUSED");
  expect(leaky.summary).not.toContain("runner-login-secret");
  expect(readFileSync(leaky.report_path!, "utf8")).not.toContain("runner-login-secret");
  expect(leaky.summary).toContain("preflight_failed:cannot access <login>");
});

test("a launch that is not the production boxed shape (an empty or wrong tool profile, delegation not denied, an ambient or unknown environment key) is refused before any process", async () => {
  const profile = [...VALIDATED_ORDINARY_PROFILES["2.1.286"]];
  const bad: [string, (launch: any) => void][] = [
    ["tools_not_validated_ordinary_profile", launch => { launch.argv[launch.argv.indexOf("--tools") + 1] = ""; }], // the v1 harness's own empty list
    ["tools_not_validated_ordinary_profile", launch => { launch.argv[launch.argv.indexOf("--tools") + 1] = "Bash"; }],
    ["tools_not_validated_ordinary_profile", launch => { launch.argv[launch.argv.indexOf("--tools") + 1] = [...profile, "Agent"].join(","); }],
    ["tools_not_validated_ordinary_profile", launch => { launch.argv[launch.argv.indexOf("--tools") + 1] = profile.slice(1).join(","); }],
    ["delegation_not_denied", launch => { launch.argv[launch.argv.indexOf("--disallowedTools") + 1] = "Agent"; }],
    ["unexpected_routing_or_session_flag", launch => { launch.argv.push("--fallback-model", "x"); }],
    ["unexpected_env_key", launch => { launch.env.ANTHROPIC_API_KEY = "x"; }],
    ["config_dir_not_in_session", launch => { launch.env.CLAUDE_CONFIG_DIR = "/home/someone/.claude"; }],
    ["no_box_wrap", launch => { delete launch.wrap; }],
    ["model_not_requested", launch => { launch.argv[launch.argv.indexOf("--model") + 1] = "other"; }],
  ];
  for (const [named, mutate] of bad) {
    const w = world();
    const real = w.cli.adapter.prepareLaunch;
    w.cli.adapter.prepareLaunch = async input => { const launch: any = await real(input); mutate(launch); return launch; };
    const result = await runSource(paid(w.srcEvidence) as any, w.src);
    expect([named, result.verdict, rep(result).judgments.refusals.includes(`launch_guard:${named}`)]).toEqual([named, "REFUSED", true]);
    expect(w.cli.starts.length).toBe(0);
    expect(w.cli.feeds.length).toBe(0);
  }

  // The guard is bound to the version the harness's own preflight reported: a build with no production profile has nothing to compare with.
  const launch: any = await fakeCli().adapter.prepareLaunch({ registry: null, preset: { adapter: "claude-code", model: MODEL, provider: "anthropic", effort: EFFORT, paid: "plan" },
    credential: { id: "x", kind: "claude-login", file: LOGIN, owner: "p1" }, purpose: "ordinary", sessionDir: join(scratch(), "s"), agent: { id: "p1-lair", person: "p1", preset: "daily", runner: "r1", mcp: join(scratch(), "mcp.json") },
    box: { agent: "p1-lair", person: "p1", tree: scratch(), stateRoot: scratch(), otherTrees: [], otherStateRoots: [], writePaths: [], secretPaths: [], sessionDir: "x", purpose: "ordinary" } } as any);
  const want = { sessionDir: launch.cwd, model: MODEL, effort: EFFORT };
  expect(checkLaunch(launch, { ...want, version: "2.1.286" })).toEqual([]);
  expect(toolsOf(launch)).toEqual(profile);
  expect(checkLaunch(launch, { ...want, version: "2.1.285" })).toEqual([]); // that build's own entry is the same list
  expect(checkLaunch(launch, { ...want, version: "9.9.9" })).toContain("ordinary_profile_unvalidated_for_version");
  expect(toolsOf({ ...launch, argv: ["claude"] })).toBeNull();
});

test("calibration refuses what it cannot measure: no transcript is an unmeasured locator, and the destination is left where it is", async () => {
  const w = world({ noTranscript: false });
  const s = await runSource(paid(w.srcEvidence) as any, w.src);
  w.cli.scenario.noTranscript = true;
  const c = await runCalibrate({ ...paid(w.dstEvidence), handoff: join(s.run_dir!, "handoff.json") } as any, w.dst);
  expect(c.verdict).toBe("REFUSED");
  expect(rep(c).judgments.refusals).toContain("locator_unmeasured");
  expect(rep(c).archive).toBeUndefined();
  expect(rep(c).locator.measured).toBe(false);
  // A malformed handoff never starts anything.
  const starts = w.cli.starts.length;
  const bad = join(scratch(), "handoff.json");
  writeFileSync(bad, JSON.stringify({ ...json(join(s.run_dir!, "handoff.json")), fixture: { marker: "x", tool_result: "y" } }));
  const refused = await runCalibrate({ ...paid(w.dstEvidence), handoff: bad } as any, w.dst);
  expect(refused.verdict).toBe("REFUSED");
  expect(rep(refused).judgments.refusals[0]).toContain("handoff_refused:handoff_marker_malformed");
  expect(w.cli.starts.length).toBe(starts);
});

test("export refuses by name: a credential or account file, a missing locator mapping, a calibration for another run, a changed source, a source that did not pass", async () => {
  const p = await throughCalibrate();
  const calFile = join(p.cRun, "phase-calibrate.report.json");
  const exportWith = (manifest: string, calibrationReport = calFile, runDir = p.sRun) => runExport({ runDir, manifest, calibrationReport }, p.w.src);
  const refusals = (r: PhaseResult): string[] => rep(r).judgments.refusals;
  const inv = json(join(p.sRun, "inventory.source.after.json")) as Inventory;
  const entry = (path: string) => { const e = inv.entries.find(one => one.path === path)!; return { path, sha256: e.sha256, size: e.size, mode: e.mode }; };

  const account = await exportWith(reviewed(p.sRun, p.cRun, { extra: [entry("config/.claude.json")] }));
  expect([account.verdict, refusals(account)[0]]).toEqual(["REFUSED", "export_account_config (config/.claude.json)"]);
  const launchFile = await exportWith(reviewed(p.sRun, p.cRun, { extra: [entry("home/cache.txt")] }));
  expect(refusals(launchFile)[0]).toBe("export_launch_generated (home/cache.txt)");
  const unmapped = await exportWith(reviewed(p.sRun, p.cRun, { drop_mapping: true }));
  expect(refusals(unmapped)[0]).toMatch(/^locator_mapping_missing/);
  expect(readdirSync(p.sRun).filter(name => name.startsWith("export-"))).toEqual([]);

  // A calibration measured for a different source run.
  const other = await runSource(paid(p.w.srcEvidence) as any, p.w.src);
  const foreign = await exportWith(reviewed(other.run_dir!, p.cRun), calFile, other.run_dir!);
  expect(refusals(foreign)[0]).toBe("calibration_not_for_this_source");

  // The source session changed after its evidence was taken.
  const transcript = inv.entries.find(one => one.path.endsWith(`${p.session}.jsonl`))!.path;
  const manifest = reviewed(p.sRun, p.cRun);
  appendFileSync(join(json(join(p.sRun, "journal.json")).paths.session_dir, transcript), "x\n");
  expect(refusals(await exportWith(manifest))[0]).toBe("source_changed_since_evidence");

  // A source run that did not pass cannot be exported at all.
  const failed = world({ effectsPerCall: 2 });
  const bad = await runSource(paid(failed.srcEvidence) as any, failed.src);
  expect(bad.verdict).toBe("FAIL");
  expect(refusals(await runExport({ runDir: bad.run_dir!, manifest, calibrationReport: calFile }, failed.src))[0]).toBe("source_not_passed");
  expect(refusals(await runExport({ runDir: join(p.sRun, "..", "no-such-run"), manifest, calibrationReport: calFile }, p.w.src))[0]).toContain("run_dir_missing");
});

test("import never touches a destination that is already there, and does not import twice", async () => {
  const p = await throughCalibrate();
  const manifest = reviewed(p.sRun, p.cRun);
  const e = await runExport({ runDir: p.sRun, manifest, calibrationReport: join(p.cRun, "phase-calibrate.report.json") }, p.w.src);
  const exportDir = join(p.sRun, `export-${rep(e).export.export_id}`);
  const sessionDir = json(join(p.cRun, "journal.json")).paths.session_dir as string;
  mkdirSync(sessionDir);
  writeFileSync(join(sessionDir, "foreign.txt"), "not ours");
  const refused = await runImport({ runDir: p.cRun, exportDir, expectBundleDigest: rep(e).export.bundle_digest }, p.w.dst);
  expect(refused.verdict).toBe("REFUSED");
  expect(rep(refused).judgments.refusals).toEqual(["dest_session_collision"]);
  expect(readdirSync(sessionDir)).toEqual(["foreign.txt"]);
  expect(readFileSync(join(sessionDir, "foreign.txt"), "utf8")).toBe("not ours");
  expect(existsSync(join(p.cRun, "import.json"))).toBe(false);
  // The foreign directory is not a resumable destination either.
  const before = p.w.cli.starts.length;
  expect((await resume(p)).verdict).toBe("REFUSED");
  expect(p.w.cli.starts.length).toBe(before);
});

test("a resume that does not continue the source session is a named refusal: the engine's other id, a lost marker and a transcript elsewhere, with no fresh-session fallback and no second call", async () => {
  const p = await throughImport({});
  p.w.cli.scenario.resumeStartsFresh = true;
  const r = await resume(p);
  expect(r.verdict).toBe("REFUSED");
  expect(r.exit_code).toBe(2);
  expect(rep(r).judgments.refusals).toEqual(expect.arrayContaining(["turn_1_engine_session_id_mismatch", "turn_1_result_session_id_mismatch", "marker_not_recalled", "tool_result_not_recalled", "fresh_transcript_elsewhere"]));
  expect(p.w.cli.starts.filter(one => one.resume).length).toBe(1);
  expect(p.w.cli.feeds.filter(one => one.resume).length).toBe(1);
  expect(rep(r).process.confirmed).toBe(true);
});

test("a resume the engine cannot start is a named refusal with the imported bytes kept, and the destination is spent: a second attempt starts nothing", async () => {
  const p = await throughImport({});
  p.w.cli.scenario.noResult = true;
  const r = await resume(p);
  expect(r.verdict).toBe("REFUSED");
  expect(rep(r).judgments.refusals).toContain("resume_engine_exited_without_result");
  const started = p.w.cli.starts.length;
  const again = await resume(p);
  expect(again.verdict).toBe("REFUSED");
  expect(rep(again).judgments.refusals.some((one: string) => one.startsWith("phase_already_started") || one.startsWith("destination_changed_since_import"))).toBe(true);
  expect(p.w.cli.starts.length).toBe(started);
  expect(existsSync(join(p.cRun, "inventory.import.after.json"))).toBe(true);
});

test("a replayed tool call or a new effect on resume fails, even though the answer was right", async () => {
  const p = await throughImport({});
  p.w.cli.scenario.toolOnResume = true;
  const r = await resume(p);
  expect(r.verdict).toBe("FAIL");
  expect(rep(r).judgments.failures).toEqual(expect.arrayContaining(["resume_used_tools", "resume_effect_count_1_not_0"]));
  expect(rep(r).turns[0]).toMatchObject({ marker_in_text: true, tool_result_in_text: true });
});

test("the fixture answers cannot reach a resumed launch: a marker in argv refuses before any process, and a destination changed since import is not launched into", async () => {
  const leaking = await throughImport({});
  const marker = leaking.marker;
  leaking.w.cli.scenario.leakIntoArgv = () => marker;
  const before = leaking.w.cli.starts.length;
  const refused = await resume(leaking);
  expect(refused.verdict).toBe("REFUSED");
  expect(rep(refused).judgments.refusals).toContain("fixture_answer_in_argv");
  expect(leaking.w.cli.starts.length).toBe(before);

  const changed = await throughImport({});
  const sessionDir = json(join(changed.cRun, "journal.json")).paths.session_dir as string;
  writeFileSync(join(sessionDir, "foreign.txt"), "added after import");
  const count = changed.w.cli.starts.length;
  const r = await resume(changed);
  expect(rep(r).judgments.refusals).toEqual(["destination_changed_since_import"]);
  expect(changed.w.cli.starts.length).toBe(count);
  expect(readFileSync(join(sessionDir, "foreign.txt"), "utf8")).toBe("added after import");
});

test("an unverified loop after a resume is exit 4 with the imported session and every artifact kept", async () => {
  const p = await throughImport({});
  p.w.cli.scenario.unverified = true;
  const r = await resume(p);
  expect(r.verdict).toBe("CLEANUP_UNVERIFIED");
  expect(r.exit_code).toBe(4);
  expect(rep(r).judgments).toEqual({ failures: [], refusals: [] });
  const dir = json(join(p.cRun, "journal.json")).paths.session_dir as string;
  expect(statSync(dir).isDirectory()).toBe(true);
  expect(existsSync(join(p.cRun, "calibration-archive"))).toBe(true);
  expect(existsSync(join(p.cRun, "inventory.resume.after.json"))).toBe(true);
});

test("a feed that never settles, rejects at once or rejects late is bounded by the one turn deadline, consumed, and never a feed success; a result before the flush settles stops any further feed", async () => {
  const before = unhandled.length;
  const run = async (scenario: Scenario, turnTimeoutMs = 40) => {
    const w = world(scenario);
    return { w, result: await runSource(paid(w.srcEvidence, { turnTimeoutMs }) as any, w.src) };
  };
  const noHandoff = (result: PhaseResult) => expect(existsSync(join(result.run_dir!, "handoff.json"))).toBe(false);

  // Never settles: the deadline that started before the feed ends the turn, cleanup follows, nothing is called a feed success.
  const t0 = Date.now();
  const hung = await run({ hangFeed: true });
  expect(Date.now() - t0).toBeLessThan(2500);
  expect(hung.result.verdict).toBe("FAIL");
  expect(rep(hung.result).judgments.failures).toContain("turn_1_not_completed:timeout");
  expect(rep(hung.result).turns[0]).toMatchObject({ fed: false, feed_settled: false, timed_out: true, ended: false });
  expect(rep(hung.result).invocations[0]).toMatchObject({ feeds_attempted: 1, turns_fed: 0 });
  expect([hung.w.cli.feeds.length, hung.w.cli.closes]).toEqual([1, 1]);
  expect(rep(hung.result).process.confirmed).toBe(true);
  noHandoff(hung.result);

  // Rejects after the harness moved on: consumed, still not a feed success.
  const late = await run({ silent: true, feedRejects: "late" });
  expect(rep(late.result).judgments.failures).toContain("turn_1_not_completed:timeout");
  expect(rep(late.result).turns[0]).toMatchObject({ fed: false, timed_out: true });

  // Rejects at once: stops without waiting for the deadline, no second feed.
  const now = await run({ silent: true, feedRejects: "now" }, 5000);
  expect(rep(now.result).judgments.failures).toContain("turn_1_not_completed:feed-failed");
  expect(rep(now.result).turns[0]).toMatchObject({ fed: false, feed_settled: true, feed_error: "pipe broke", timed_out: false });
  expect([now.w.cli.feeds.length, now.w.cli.closes]).toEqual([1, 1]);

  // The engine's result arrives while the flush never reports: the turn is real, the accounting says so, and no second message follows.
  const unsettled = await run({ feedNeverSettles: true }, 5000);
  expect(unsettled.result.verdict).toBe("FAIL");
  expect(rep(unsettled.result).stopped).toBe("feed-unsettled");
  expect(rep(unsettled.result).judgments.failures).toEqual(expect.arrayContaining(["turn_1_feed_unsettled", "turn_2_not_completed:not_started"]));
  expect(rep(unsettled.result).turns[0]).toMatchObject({ fed: true, feed_settled: false, ended: true });
  expect(unsettled.w.cli.feeds.length).toBe(1);
  expect(rep(unsettled.result).process.confirmed).toBe(true);
  noHandoff(unsettled.result);

  await settleLate();
  expect(unhandled.length).toBe(before);
});

test("a close that never returns is waited for only the injected bound and recorded, then the production evidence decides; a late close failure is consumed", async () => {
  const before = unhandled.length;
  const run = async (scenario: Scenario) => {
    const w = world(scenario, { src: { closeBoundMs: 40 } });
    return { w, result: await runSource(paid(w.srcEvidence) as any, w.src) };
  };
  const t0 = Date.now();
  const verified = await run({ hangClose: true });
  expect(Date.now() - t0).toBeLessThan(3000);
  expect(verified.result.verdict).toBe("PASS_SCOPED"); // the production evidence confirms the child gone; the timeout is recorded, not hidden
  expect(rep(verified.result).process).toMatchObject({ confirmed: true, close_timed_out: true, interrupt_used: false });
  expect(verified.w.cli.interrupts).toBe(0);

  const stuck = await run({ hangClose: true, unverified: true });
  expect([stuck.result.verdict, stuck.result.exit_code]).toEqual(["CLEANUP_UNVERIFIED", 4]);
  expect(rep(stuck.result).process).toMatchObject({ confirmed: false, close_timed_out: true, interrupt_used: true });
  expect(stuck.w.cli.interrupts).toBe(1);
  expect(existsSync(join(stuck.result.run_dir!, "handoff.json"))).toBe(false);

  const fixed = await run({ hangClose: true, unverified: true, interruptFixes: true });
  expect(fixed.result.verdict).toBe("PASS_SCOPED");
  expect(rep(fixed.result).process).toMatchObject({ confirmed: true, close_timed_out: true, interrupt_used: true });

  const lateFailure = await run({ closeRejects: "late" });
  expect(rep(lateFailure.result).process).toMatchObject({ close_timed_out: true, confirmed: true });
  const immediate = await run({ closeRejects: "now" });
  expect(rep(immediate.result).process).toMatchObject({ close_timed_out: false, close_error: "close failed", confirmed: true });

  await settleLate();
  expect(unhandled.length).toBe(before);
});

test("the process record is written before any feed; when it cannot be written nothing is fed, and the child is still cleaned up with cleanup deciding the verdict", async () => {
  const blocked = (scenario: Scenario) => {
    const w = world(scenario);
    w.cli.scenario.onPrepare = input => { mkdirSync(join(runOf(input.sessionDir), "phase-source.process.json")); }; // a directory where the record goes: the exclusive create fails
    return w;
  };
  const w = blocked({});
  const r = await runSource(paid(w.srcEvidence) as any, w.src);
  expect(r.verdict).toBe("FAIL");
  expect(rep(r).judgments.failures.some((one: string) => one.startsWith("process_record_failed:"))).toBe(true);
  expect([w.cli.starts.length, w.cli.feeds.length, w.cli.closes]).toEqual([1, 0, 1]);
  expect(rep(r).process).toMatchObject({ confirmed: true });
  expect(existsSync(join(r.run_dir!, "handoff.json"))).toBe(false);

  const u = blocked({ unverified: true });
  const unverified = await runSource(paid(u.srcEvidence) as any, u.src);
  expect([unverified.verdict, unverified.exit_code]).toEqual(["CLEANUP_UNVERIFIED", 4]);
  expect([u.cli.feeds.length, u.cli.closes, u.cli.interrupts]).toEqual([0, 1, 1]);
});

test("with builtin tools in the launch, any tool action or bare tool result beyond the one fixture call fails in every phase, and an answer found with a tool is never a pass", async () => {
  const read: AdapterProgress = { kind: "action", text: "Read" };
  const bare: AdapterProgress = { kind: "action_result", text: "" };
  const failures = (result: PhaseResult): string[] => rep(result).judgments.failures;

  // Source turn 1: a builtin beside the fixture call. Turn 2: a tool result with no action at all.
  const beside = world({ emit: info => (info.text.includes(FIXTURE_TOOL) ? [read] : []) });
  const one = await runSource(paid(beside.srcEvidence) as any, beside.src);
  expect(one.verdict).toBe("FAIL");
  expect(failures(one)).toContain("turn_1_expected_exactly_one_fixture_call_got_2");
  expect(existsSync(join(one.run_dir!, "handoff.json"))).toBe(false);
  const bareTwo = world({ emit: info => (info.turn === 2 ? [bare] : []) });
  const two = await runSource(paid(bareTwo.srcEvidence) as any, bareTwo.src);
  expect(two.verdict).toBe("FAIL");
  expect(failures(two)).toContain("turn_2_used_tools");
  expect(rep(two).turns[1]).toMatchObject({ tool_actions: [], tool_results: 1 });

  // Calibration: a bare tool result fails it, and a failed calibration is never archived.
  const w = world({});
  const s = await runSource(paid(w.srcEvidence) as any, w.src);
  w.cli.scenario.emit = info => (info.text.includes("single word OK") ? [bare] : []);
  const c = await runCalibrate({ ...paid(w.dstEvidence), handoff: join(s.run_dir!, "handoff.json") } as any, w.dst);
  expect(c.verdict).toBe("FAIL");
  expect(failures(c)).toContain("calibration_used_tools");
  expect(rep(c).archive).toBeUndefined();

  // Resume: the answer is right, but it was reached with a tool (a bare result; a builtin Read of the handoff or transcript).
  for (const [name, events, expected] of [["bare result", [bare], { tool_actions: [], tool_results: 1 }], ["builtin read", [read, bare], { tool_actions: ["Read"], tool_results: 1 }]] as const) {
    const p = await throughImport({});
    p.w.cli.scenario.emit = info => (info.resume ? [...events] : []);
    const r = await resume(p);
    expect([name, r.verdict, failures(r).includes("resume_used_tools")]).toEqual([name, "FAIL", true]);
    expect(rep(r).turns[0]).toMatchObject({ marker_in_text: true, tool_result_in_text: true, ...expected });
    expect(p.w.cli.feeds.filter(feed => feed.resume).length).toBe(1);
  }
  // Nothing about the answers was in the resumed launch or prompt to find by any means other than the transcript.
  const p = await throughImport({});
  const resumed = await resume(p);
  expect(resumed.verdict).toBe("PASS_SCOPED");
  const secretsHere = json(join(p.sRun, "handoff.json")).fixture;
  const last = p.w.cli.feeds[p.w.cli.feeds.length - 1].prompt;
  expect([last.includes(secretsHere.marker), last.includes(secretsHere.tool_result)]).toEqual([false, false]);
  expect(JSON.stringify(rep(resumed).launch)).not.toContain(secretsHere.marker);
  expect(JSON.stringify(rep(resumed).launch)).not.toContain(secretsHere.tool_result);
});

test("an import needs the export the operator selected: a wrong or malformed digest is refused before any session directory is made, and a foreign destination stays untouched", async () => {
  const p = await throughCalibrate();
  const e = await runExport({ runDir: p.sRun, manifest: reviewed(p.sRun, p.cRun), calibrationReport: join(p.cRun, "phase-calibrate.report.json") }, p.w.src);
  const exportDir = join(p.sRun, `export-${rep(e).export.export_id}`);
  const digest = rep(e).export.bundle_digest as string;
  const sessionDir = json(join(p.cRun, "journal.json")).paths.session_dir as string;

  const wrong = await runImport({ runDir: p.cRun, exportDir, expectBundleDigest: digest === "0".repeat(64) ? "1".repeat(64) : "0".repeat(64) }, p.w.dst);
  expect([wrong.verdict, rep(wrong).judgments.refusals]).toEqual(["REFUSED", ["export_not_the_selected_bundle"]]);
  expect(existsSync(sessionDir)).toBe(false);
  expect(existsSync(join(p.cRun, "import.json"))).toBe(false);
  const malformed = await runImport({ runDir: p.cRun, exportDir, expectBundleDigest: "not-a-digest" }, p.w.dst);
  expect(rep(malformed).judgments.refusals).toEqual(["expect_bundle_digest_shape"]);
  expect(existsSync(sessionDir)).toBe(false);

  // A foreign destination with a wrong digest is refused for the digest first, and is not touched.
  mkdirSync(sessionDir);
  writeFileSync(join(sessionDir, "foreign.txt"), "not ours");
  const foreign = await runImport({ runDir: p.cRun, exportDir, expectBundleDigest: "2".repeat(64) }, p.w.dst);
  expect(rep(foreign).judgments.refusals).toEqual(["export_not_the_selected_bundle"]);
  expect(readdirSync(sessionDir)).toEqual(["foreign.txt"]);
  expect(readFileSync(join(sessionDir, "foreign.txt"), "utf8")).toBe("not ours");
  rmSync(sessionDir, { recursive: true, force: true }); // the test's own scratch directory, removed so the selected export can be imported

  const starts = p.w.cli.starts.length;
  const good = await runImport({ runDir: p.cRun, exportDir, expectBundleDigest: digest }, p.w.dst);
  expect(good.verdict).toBe("PASS_SCOPED");
  expect(rep(good).import).toMatchObject({ bundle_digest: digest, selected_by_operator_digest: digest });
  expect(p.w.cli.starts.length).toBe(starts); // an import never starts a process
});

test("a resume whose CLI rewrote the imported transcript while appending is a named refusal, and an unmeasurable prefix is a failure", async () => {
  const p = await throughImport({});
  p.w.cli.scenario.rewritePrefix = true;
  const r = await resume(p);
  expect(r.verdict).toBe("REFUSED");
  expect(rep(r).judgments.refusals).toContain("imported_prefix_not_preserved");
  expect(rep(r).transcripts.imported_prefix_preserved).toBe(false);
  expect(rep(r).turns[0]).toMatchObject({ marker_in_text: true, tool_result_in_text: true }); // the answer was right: only the prefix judgment refuses
  expect(rep(r).judgments.failures).toEqual([]);

  const turn: TurnFacts = { n: 1, fed: true, feed_settled: true, ended: true, timed_out: false, exited_early: false, feed_error: null, refused_cause: null, refused_said: "",
    text: "MARK RESULT", session_id: "s", reported_at_first_event: "s", reported_at_end: "s", tool_actions: [], tool_results: 0, resolved_models: [MODEL],
    num_turns: 1, output_tokens: 1, weekly_pct: 1 };
  const judge = (prefix_preserved: boolean | null) => judgeResume({ native: "s", marker: "MARK", tool_result: "RESULT", turns: [turn], stopped: null,
    effects: { count: 0, results: [], malformed: 0 }, before: null, after: null, imported_transcript: "x", prefix_preserved });
  expect(judge(true)).toEqual({ failures: [], refusals: [] });
  expect(judge(false)).toEqual({ failures: [], refusals: ["imported_prefix_not_preserved"] });
  expect(judge(null)).toEqual({ failures: ["imported_prefix_evidence_missing"], refusals: [] });
});

// The public facts of the one measured Mac 2.1.286 -> Pi 2.1.285 resume (native-resume-pi-v1-result.json, resume report), nothing else:
// the engine kept the source session, recalled both answers with no tools and no effects, appended to the imported transcript and kept its prefix;
// the only new .jsonl was the fixture MCP server's own timestamp-named log under home/.cache.
const OBSERVED_PROJECT = "-tmp-hub-move-native-pi-20261001T015446Z-evidence-dest-20261001-015449-99f2b7d0-state-p1-sessions-p1-lair-df5fb5fd-32eb-45b1-9d35-c59ccaa2a97c";
const OBSERVED_SESSION = "c56fd0e8-4878-4293-9bee-8f37549e7169";
const OBSERVED_TRANSCRIPT = `config/projects/${OBSERVED_PROJECT}/${OBSERVED_SESSION}.jsonl`;
const OBSERVED_MCP_LOG = `home/.cache/claude-cli-nodejs/${OBSERVED_PROJECT}/mcp-logs-fixture/2026-10-01T01-58-44-582Z.jsonl`;
const observedReport = (extraAfter: { path: string; size: number }[] = []): any => ({
  phase: "resume", verdict: "REFUSED", exit_code: 2, outcome: "refused: fresh_transcript_elsewhere",
  judgments: { failures: [], refusals: ["fresh_transcript_elsewhere"] },
  turns: [{
    n: 1, fed: true, feed_settled: true, ended: true, timed_out: false, exited_early: false, feed_error: null, refused_cause: null, text_chars: 61,
    session_id: OBSERVED_SESSION, reported_at_first_event: OBSERVED_SESSION, reported_at_end: OBSERVED_SESSION, tool_actions: [], tool_results: 0,
    resolved_models: ["claude-sonnet-5-5"], num_turns: 1, output_tokens: 48, weekly_pct: 81, marker_in_text: true, tool_result_in_text: true,
  }],
  stopped: null, quota: { weekly_pct_seen: 81, guard_pct: 95, stopped: false },
  process: { attempted: true, confirmed: true },
  fixture: { effect_count_at_destination: 0, effect_count_at_source_run: 1, expected_new_effects: 0 },
  engine: { asked_session_id: OBSERVED_SESSION },
  transcripts: {
    imported_transcript: OBSERVED_TRANSCRIPT, imported_prefix_preserved: true,
    before: [{ path: OBSERVED_TRANSCRIPT, size: 45552 }],
    after: [{ path: OBSERVED_TRANSCRIPT, size: 50387 }, { path: OBSERVED_MCP_LOG, size: 1125 }, ...extraAfter],
  },
});

test("the measured Mac->Pi resume is not refused for the MCP server's own log, but a new conversation anywhere still is (saved facts rejudged, report untouched)", () => {
  const saved = observedReport();
  const frozen = JSON.stringify(saved);
  // Before the fix this exact evidence was REFUSED: the timestamp-named MCP log under home/.cache counted as "a fresh transcript".
  const now = rejudgeResumeReport(saved);
  expect(now.failures).toEqual([]);
  expect(now.refusals).toEqual([]);
  expect(now.carried).toEqual({ failures: [], refusals: [] });
  expect(now.decision).toMatchObject({ verdict: "PASS_SCOPED", code: 0 });
  expect(JSON.stringify(saved)).toBe(frozen); // the saved report is only read

  const refused = (extra: { path: string; size: number }[]) => rejudgeResumeReport(observedReport(extra));
  // A genuine extra session (a new UUID) in the imported project directory, in another project directory, and a second copy of the same id elsewhere.
  expect(refused([{ path: `config/projects/${OBSERVED_PROJECT}/11111111-2222-4333-8444-555555555555.jsonl`, size: 10 }]).refusals).toEqual(["fresh_transcript_elsewhere"]);
  expect(refused([{ path: "config/projects/-some-other-project/11111111-2222-4333-8444-555555555555.jsonl", size: 10 }]).refusals).toEqual(["fresh_transcript_elsewhere"]);
  expect(refused([{ path: `config/projects/-some-other-project/${OBSERVED_SESSION}.jsonl`, size: 10 }]).refusals).toEqual(["fresh_transcript_elsewhere"]);
  expect(refused([{ path: "config/projects/-some-other-project/11111111-2222-4333-8444-555555555555.jsonl", size: 10 }]).decision).toMatchObject({ verdict: "REFUSED", code: 2 });
  // A transcript-shaped name is a conversation wherever it is written; only a differently shaped log outside the namespace is let through.
  expect(refused([{ path: "home/.cache/11111111-2222-4333-8444-555555555555.jsonl", size: 10 }]).refusals).toEqual(["fresh_transcript_elsewhere"]);
  expect(refused([{ path: `home/.cache/claude-cli-nodejs/${OBSERVED_PROJECT}/mcp-logs-fixture/2026-10-01T01-59-00-000Z.jsonl`, size: 10 }]).refusals).toEqual([]);

  // The other retained checks still bite on the same facts.
  const mutate = (change: (report: any) => void) => { const report = observedReport(); change(report); return rejudgeResumeReport(report); };
  expect(mutate(r => { r.transcripts.after = r.transcripts.after.slice(1); }).failures).toContain("imported_transcript_missing_from_inventory");
  expect(mutate(r => { r.transcripts.after[0].size = 45552; }).failures).toContain("imported_transcript_not_appended");
  expect(mutate(r => { r.transcripts.imported_prefix_preserved = false; }).refusals).toEqual(["imported_prefix_not_preserved"]);
  expect(mutate(r => { r.transcripts.imported_prefix_preserved = null; }).failures).toEqual(["imported_prefix_evidence_missing"]);
  expect(mutate(r => { r.turns[0].marker_in_text = false; }).refusals).toEqual(["marker_not_recalled"]);
  expect(mutate(r => { r.turns[0].tool_results = 1; }).failures).toEqual(["resume_used_tools"]);
  expect(mutate(r => { r.fixture.effect_count_at_destination = 1; }).failures).toEqual(["resume_effect_count_1_not_0"]);
  expect(mutate(r => { r.turns[0].reported_at_first_event = "other"; }).refusals).toEqual(["turn_1_engine_session_id_mismatch"]);
  expect(mutate(r => { r.process.confirmed = false; }).decision.verdict).toBe("CLEANUP_UNVERIFIED");
  expect(mutate(r => { r.judgments.refusals.push("inventory_after:inventory_unreadable"); }).decision.verdict).toBe("REFUSED"); // carried, not erased
  expect(() => rejudgeResumeReport({ phase: "import" })).toThrow("report_not_a_resume");
  expect(() => mutate(r => { delete r.turns[0].marker_in_text; })).toThrow("report_recall_not_recorded");

  // An interrupt is carried, never rejudged away: late (after the turn and cleanup: saved INTERRUPTED, empty judgments, stopped null) ...
  const lateInterrupt = (r: any) => { r.verdict = "INTERRUPTED"; r.exit_code = 4; r.outcome = "interrupted by SIGINT; cleanup verified; nothing was handed off"; r.judgments = { failures: [], refusals: [] }; };
  expect(mutate(lateInterrupt).decision).toMatchObject({ verdict: "INTERRUPTED", code: 4 });
  // ... and mid-turn (stopped "interrupted"; the turn did not end, which must not surface as a turn failure).
  const midTurn = mutate(r => { r.stopped = "interrupted"; r.turns[0].ended = false; });
  expect(midTurn.decision).toMatchObject({ verdict: "INTERRUPTED", code: 4 });
  // Unverified cleanup still outranks the interrupt.
  expect(mutate(r => { lateInterrupt(r); r.process.confirmed = false; }).decision).toMatchObject({ verdict: "CLEANUP_UNVERIFIED", code: 4 });
  expect(mutate(r => { r.stopped = "interrupted"; r.process.confirmed = false; }).decision.verdict).toBe("CLEANUP_UNVERIFIED");

  // The live judge and the saved-report judge agree on the same facts: the live one reads the text, the report keeps only the booleans.
  const turn: TurnFacts = { n: 1, fed: true, feed_settled: true, ended: true, timed_out: false, exited_early: false, feed_error: null, refused_cause: null, refused_said: "",
    text: "MARK RESULT", session_id: OBSERVED_SESSION, reported_at_first_event: OBSERVED_SESSION, reported_at_end: OBSERVED_SESSION, tool_actions: [], tool_results: 0,
    resolved_models: [MODEL], num_turns: 1, output_tokens: 48, weekly_pct: 81 };
  const view = (paths: [string, number][]) => ({ entries: paths.map(([path, size]) => ({ path, kind: "file" as const, size })) });
  const live = judgeResume({ native: OBSERVED_SESSION, marker: "MARK", tool_result: "RESULT", turns: [turn], stopped: null, effects: { count: 0, results: [], malformed: 0 },
    before: view([[OBSERVED_TRANSCRIPT, 45552]]), after: view([[OBSERVED_TRANSCRIPT, 50387], [OBSERVED_MCP_LOG, 1125]]), imported_transcript: OBSERVED_TRANSCRIPT, prefix_preserved: true });
  expect(live).toEqual({ failures: [], refusals: [] });
});

test("the command line wants exactly one phase and its flags, and without --allow-paid-call a paid phase refuses before any launch", async () => {
  const w = world();
  expect(() => parseCli([])).toThrow("exactly one phase");
  expect(() => parseCli(["source", "--evidence-dir", "/x"])).toThrow("missing: --login-file --cli --expect-cli-version");
  expect(() => parseCli(["bogus"])).toThrow("exactly one phase");
  expect(() => parseCli(["source", "--no-such-flag"])).toThrow();
  expect(parseCli(["import", "--run-dir", "/a", "--export-dir", "/b", "--expect-bundle-digest", "a".repeat(64)]).phase).toBe("import");
  // The import names the export it was shown: the digest is required, and must be 64 lowercase hex characters.
  expect(() => parseCli(["import", "--run-dir", "/a", "--export-dir", "/b"])).toThrow("missing: --expect-bundle-digest");
  expect(() => parseCli(["import", "--run-dir", "/a", "--export-dir", "/b", "--expect-bundle-digest", "ABC"])).toThrow("64 lowercase hex");
  expect(() => parseCli(["import", "--run-dir", "/a", "--export-dir", "/b", "--expect-bundle-digest", "A".repeat(64)])).toThrow("64 lowercase hex");
  expect(await main(["source"], w.src)).toBe(2);
  const code = await main(["source", "--evidence-dir", w.srcEvidence, "--login-file", LOGIN, "--cli", "/usr/local/bin/claude", "--expect-cli-version", "2.1.286"], w.src);
  expect(code).toBe(2);
  expect(await main(["source", "--evidence-dir", w.srcEvidence, "--login-file", LOGIN, "--cli", "/c", "--expect-cli-version", "2.1.286", "--turn-timeout-ms", "10"], w.src)).toBe(2);
  expect(w.cli.prepares).toBe(0);
  expect(w.cli.starts.length).toBe(0);
});

test("the fixture MCP server makes exactly one fsynced local effect per call, generates its own result, and exits when stdin closes", async () => {
  const dir = scratch();
  const script = join(import.meta.dir, "..", "live", "claude-session-portability-fixture.ts");
  const child = Bun.spawn([process.execPath, script, dir], { stdin: "pipe", stdout: "pipe", stderr: "ignore" });
  try {
    const send = (message: object) => child.stdin.write(`${JSON.stringify(message)}\n`);
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "fixture_effect", arguments: {} } });
    send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "no_such_tool" } });
    await child.stdin.flush();
    const replies = new Map<number, any>();
    const reader = child.stdout.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const deadline = Date.now() + 15_000;
    while (replies.size < 4 && Date.now() < deadline) {
      const chunk = await Promise.race([reader.read(), new Promise<null>(resolve => setTimeout(() => resolve(null), 2000))]);
      if (chunk === null || chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 1);
        if (line.trim() !== "") { const message = JSON.parse(line); replies.set(message.id, message); }
      }
    }
    expect([...replies.keys()].sort()).toEqual([1, 2, 3, 4]);
    expect(replies.get(2).result.tools.map((tool: any) => tool.name)).toEqual(["fixture_effect"]);
    const text = replies.get(3).result.content[0].text as string;
    expect(text).toMatch(/^RESULT-[0-9a-f]{24}$/);
    expect(replies.get(4).error.code).toBe(-32602);
    const lines = readFileSync(join(dir, "effects.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(lines.length).toBe(1);
    expect(lines[0]).toMatchObject({ n: 1, tool: "fixture_effect", result: text });
    child.stdin.end();
    expect(await Promise.race([child.exited, new Promise(resolve => setTimeout(() => resolve("still running"), 10_000))])).toBe(0);
  } finally { child.kill(); }
});
