// The live engine proof's own logic, offline: its arguments, its marker matching, its verdict, and that its observer leaves the production
// adapter and session exactly as they were while writing nothing but normalized metadata. No engine, no store, no box, no network.

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Adapter, AdapterSession, TurnEnd } from "../src/adapters/types.ts";
import { observeAdapters, type Observed } from "../live/engine-observer.ts";
import { disposeScratch, judge, macBoxReadable, markerIn, parseArgs, SCRATCH_PREFIX, type ProofFacts, type RunnerFacts, type TurnFacts } from "../live/prove-engine-runner.ts";

const BASE = ["--adapter", "claude-code", "--model", "claude-haiku-4-5-20251001", "--provider", "anthropic", "--credential-kind", "claude-login",
  "--credential-file", "/home/someone/runner-login/.credentials.json", "--evidence-dir", "/var/evidence", "--allow-paid-call"];

describe("arguments", () => {
  test("a paid run is never started without saying so", () => {
    const parsed = parseArgs(BASE.filter(arg => arg !== "--allow-paid-call"), "/tmp");
    expect(parsed).toMatchObject({ ok: false, refusal: "paid_call_not_allowed" });
  });

  test("Claude on its own login gets the plan, low effort and the host's scratch by default", () => {
    const parsed = parseArgs(BASE, "/private/tmp");
    if (!parsed.ok) throw new Error(parsed.refusal);
    expect(parsed.options).toMatchObject({ adapter: "claude-code", paid: "plan", effort: "low", scratchParent: "/private/tmp", bin: null, baseUrl: null });
  });

  test("diagnostics are kept only on request", () => {
    const plain = parseArgs(BASE, "/tmp");
    if (!plain.ok) throw new Error(plain.refusal);
    expect(plain.options).toMatchObject({ keepScratch: false, keepStderr: false });
    const kept = parseArgs([...BASE, "--keep-scratch", "--keep-stderr"], "/tmp");
    if (!kept.ok) throw new Error(kept.refusal);
    expect(kept.options).toMatchObject({ keepScratch: true, keepStderr: true });
  });

  test("OpenCode on its own model key, with an endpoint, is a per-token key", () => {
    const parsed = parseArgs(["--adapter", "opencode", "--model", "gpt-5.5", "--provider", "openai", "--credential-kind", "model-key",
      "--credential-file", "/home/someone/keys/openai.key", "--base-url", "https://api.example.test/v1", "--evidence-dir", "/var/evidence",
      "--bin", "/home/someone/.local/bin/opencode", "--label", "opencode-root", "--allow-paid-call"], "/tmp");
    if (!parsed.ok) throw new Error(parsed.refusal);
    expect(parsed.options).toMatchObject({ adapter: "opencode", credentialKind: "model-key", paid: "key", baseUrl: "https://api.example.test/v1",
      bin: "/home/someone/.local/bin/opencode", label: "opencode-root" });
  });

  test("an engine is never handed another engine's credential kind", () => {
    const swapped = BASE.map(arg => (arg === "claude-login" ? "model-key" : arg));
    expect(parseArgs(swapped, "/tmp")).toMatchObject({ ok: false, refusal: "credential_kind_mismatch" });
    const codexOnLogin = BASE.map(arg => (arg === "claude-code" ? "codex" : arg));
    expect(parseArgs(codexOnLogin, "/tmp")).toMatchObject({ ok: false, refusal: "credential_kind_mismatch" });
  });

  test("an endpoint is a model key's only, and only a plain https origin", () => {
    expect(parseArgs([...BASE, "--base-url", "https://api.example.test"], "/tmp")).toMatchObject({ ok: false, refusal: "base_url_unsupported" });
    const key = ["--adapter", "codex", "--model", "m", "--provider", "openai", "--credential-kind", "model-key", "--credential-file", "/k/key",
      "--evidence-dir", "/e", "--allow-paid-call"];
    for (const url of ["http://api.example.test", "https://user:pw@api.example.test", "https://api.example.test/v1?x=1"]) {
      expect(parseArgs([...key, "--base-url", url], "/tmp")).toMatchObject({ ok: false, refusal: "base_url_invalid" });
    }
  });

  test("paths are absolute and normal, so the path checked is the path used", () => {
    for (const path of ["relative/.credentials.json", "/home/someone/../other/.credentials.json", "/home//someone/.credentials.json"]) {
      const parsed = parseArgs(BASE.map(arg => (arg.endsWith(".credentials.json") ? path : arg)), "/tmp");
      expect(parsed).toMatchObject({ ok: false, refusal: "path_not_absolute" });
    }
  });

  test("an unknown, repeated or empty flag is refused by name, and the bounds are bounded", () => {
    expect(parseArgs([...BASE, "--no-box"], "/tmp")).toMatchObject({ ok: false, refusal: "unknown_argument", detail: "--no-box" });
    expect(parseArgs([...BASE, "--model", "other"], "/tmp")).toMatchObject({ ok: false, refusal: "repeated_flag" });
    expect(parseArgs([...BASE, "--bin"], "/tmp")).toMatchObject({ ok: false, refusal: "missing_value" });
    expect(parseArgs([...BASE, "--turn-timeout-ms", "5"], "/tmp")).toMatchObject({ ok: false, refusal: "bound_invalid" });
    expect(parseArgs([...BASE, "--turn-timeout-ms=600000"], "/tmp")).toMatchObject({ ok: true });
  });
});

describe("marker", () => {
  test("a recall is found however the model wraps or spaces it", () => {
    expect(markerIn("Кодовое слово: «zephyr 1a2b3c4d».", "ZEPHYR-1A2B3C4D")).toBe(true);
    expect(markerIn("ZEPHYR-1A2B3C4D", "ZEPHYR-1A2B3C4D")).toBe(true);
  });

  test("a different or partial word is not a recall", () => {
    expect(markerIn("ZEPHYR-1A2B3C4E", "ZEPHYR-1A2B3C4D")).toBe(false);
    expect(markerIn("ZEPHYR", "ZEPHYR-1A2B3C4D")).toBe(false);
    expect(markerIn("anything", "")).toBe(false);
  });
});

test("a pinned binary outside what the macOS box reads is told apart from one inside it", () => {
  expect(macBoxReadable("/Users/someone/.local/share/claude/versions/2.1.286", "/Users/someone")).toBe(true);
  expect(macBoxReadable("/private/tmp/pinned/codex-0.160.0/codex", "/Users/someone")).toBe(true);
  expect(macBoxReadable("/opt/homebrew/Cellar/opencode/1.18.34/bin/opencode", "/Users/someone")).toBe(true);
  expect(macBoxReadable("/Users/someone/Downloads/codex", "/Users/someone")).toBe(false);
  expect(macBoxReadable("/opt/homebrew/var/codex", "/Users/someone")).toBe(false);
});

describe("scratch disposal", () => {
  test("the run's own directories go, a gone one counts as gone, and anything else is kept and named", () => {
    const parent = mkdtempSync(join(tmpdir(), "scratch-disposal-"));
    try {
      const own = mkdtempSync(join(parent, SCRATCH_PREFIX));
      mkdirSync(join(own, "state", "sessions"), { recursive: true });
      writeFileSync(join(own, "state", "sessions", "transcript.jsonl"), "{}\n");
      const outside = join(parent, "household");
      mkdirSync(outside);
      writeFileSync(join(outside, "keep.txt"), "keep");
      // A link that carries the prefix and points elsewhere is not removed, and neither is what it points at.
      const link = join(parent, `${SCRATCH_PREFIX}link`);
      symlinkSync(outside, link);
      const gone = join(parent, `${SCRATCH_PREFIX}gone`);

      const result = disposeScratch([own, gone, outside, link]);
      expect(result.removed).toEqual([own, gone]);
      expect(result.errors).toEqual([`not this run's scratch, kept: ${outside}`, `not this run's scratch, kept: ${link}`]);
      expect(existsSync(own)).toBe(false);
      expect(existsSync(join(outside, "keep.txt"))).toBe(true);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});

describe("verdict", () => {
  const turn = (n: number, over: Partial<TurnFacts> = {}): TurnFacts => ({
    n, inbound: `fake:test-chat:${n}`, outcome: "settled", detail: null, execution_state: "completed", executions: 1, incarnation: n < 3 ? "inc-a" : "inc-b",
    native_session: "native-1", reply_chunks: 1, reply_chars: 15, posts_per_chunk: [1], marker_recalled: n > 1, marker_in_reply: n > 1,
    receipts: 1, turn_ends: 1, actions: n === 1 ? 1 : 0, action_results: n === 1 ? 1 : 0, engine_session: "native-1", refused: null,
    runner: n < 3 ? 1 : 2, elapsed_ms: 1000, ...over,
  });
  const runner = (n: number, resume: boolean, over: Partial<RunnerFacts> = {}): RunnerFacts => ({
    n, pid: 100 + n, ready: true, ready_error: null, stop: "graceful", plans: [{ start: 1, id: "native-1", resume }], start_failures: [], starts: 1,
    exits: [{ start: 1, confirmed: true, basis: "process-group", survivors: [], error: null }], survivors: [], reaped: [], unreaped: [], ...over,
  });
  const passing = (): ProofFacts => ({
    interrupted: null, turns: [turn(1), turn(2), turn(3)], runners: [runner(1, false), runner(2, true)], inbound_rows: 3,
    marker_leaked_before_recall: false, duplicate_receipts: [], codex_threads: [null, null], expect_codex_thread: false, scenario_errors: [], cleanup_errors: [],
  });

  test("a tool read, two tool-free recalls across a resumed restart, one of everything and every process gone is PASS_SCOPED", () => {
    expect(judge(passing())).toEqual({ verdict: "PASS_SCOPED", failures: [] });
  });

  test("a marker repeated in the first reply cannot prove a recall", () => {
    const facts = passing();
    facts.turns[0] = turn(1, { marker_in_reply: true });
    expect(judge(facts)).toMatchObject({ verdict: "FAIL", failures: expect.arrayContaining(["turn_1_marker_echoed"]) });
  });

  test("a recall that used a tool, or a first turn that used none, fails by name", () => {
    const facts = passing();
    facts.turns[0] = turn(1, { actions: 0, action_results: 0 });
    facts.turns[2] = turn(3, { actions: 1 });
    expect(judge(facts).failures).toEqual(expect.arrayContaining(["turn_1_no_tool_action", "turn_3_tool_used"]));
  });

  test("a restart that started a fresh session, or another id, is not a resume", () => {
    const fresh = passing();
    fresh.runners[1] = runner(2, false);
    expect(judge(fresh).failures).toContain("restart_not_resumed");
    const other = passing();
    other.runners[1] = runner(2, true, { plans: [{ start: 1, id: "native-2", resume: true }] });
    expect(judge(other).failures).toContain("restart_not_resumed");
  });

  test("an input taken twice or posted twice is a duplicate", () => {
    const facts = passing();
    facts.turns[1] = turn(2, { posts_per_chunk: [2], receipts: 2 });
    facts.duplicate_receipts = ["fake:test-chat:2"];
    expect(judge(facts).failures).toEqual(expect.arrayContaining(["turn_2_reply_not_posted_exactly_once", "turn_2_engine_took_it_twice", "duplicate_engine_input"]));
  });

  test("a Codex thread that changed or could not be read fails", () => {
    const changed = { ...passing(), expect_codex_thread: true, codex_threads: ["thread-a", "thread-b"] };
    expect(judge(changed).failures).toContain("codex_thread_changed");
    const unread = { ...passing(), expect_codex_thread: true, codex_threads: ["thread-a", null] };
    expect(judge(unread).failures).toContain("codex_thread_unread");
  });

  test("cleanup overrides a pass: a survivor, a killed runner or a missing exit is CLEANUP_UNVERIFIED", () => {
    for (const over of [{ survivors: [4243] }, { stop: "killed" as const }, { exits: [] }]) {
      const facts = passing();
      facts.runners[1] = runner(2, true, over);
      expect(judge(facts).verdict).toBe("CLEANUP_UNVERIFIED");
    }
  });

  test("an interrupted run says so first, whatever else held", () => {
    expect(judge({ ...passing(), interrupted: "signal SIGINT" })).toEqual({ verdict: "INTERRUPTED", failures: ["interrupted: signal SIGINT"] });
  });
});

describe("observer", () => {
  const usage = { input_tokens: 10, cached_input_tokens: null, output_tokens: 3, plan_usage: null, resolved_model_ids: ["model-x"], raw: { result: "secret answer" } };

  function engine() {
    const receipts: ((id: string) => void)[] = [];
    const progress: ((event: { kind: "text" | "action" | "action_result"; text: string }) => void)[] = [];
    const ends: ((end: TurnEnd) => void)[] = [];
    const session: AdapterSession = {
      get sessionId() { return "native-1"; },
      get reportedSessionId() { return "engine-native-1"; },
      get pid() { return 4242; },
      lacks: [],
      async feed() {},
      onReceipt(handler) { receipts.push(handler); },
      onProgress(handler) { progress.push(handler); },
      onTurnEnd(handler) { ends.push(handler); },
      async close() {},
      processes: () => [4242, 4243],
      group: () => 4242,
      exitEvidence: async () => ({ confirmed: true, leader: "exited", descendants: "none", pids: [4242, 4243], survivors: [], basis: "process-group", group: 4242, via: "test" }),
    };
    let given: unknown = null;
    const adapter: Adapter = { name: "probe-engine", async start(options) { given = options; return session; } };
    return { session, adapter, receipts, progress, ends, given: () => given };
  }

  const options = {
    preset: { adapter: "probe-engine", model: "model-x", provider: "p", effort: "low", paid: "key" },
    sessionId: null, session: { id: "native-1", resume: false },
    argv: ["/some/where/codex", "app-server", "--secret-flag"], env: { MODEL_KEY: "secret-key" }, wrap: (argv: string[]) => argv,
  } as unknown as Parameters<Adapter["start"]>[0];

  test("the production start is handed the very options and its very session comes back", async () => {
    const it = engine();
    const observer = observeAdapters({ "probe-engine": it.adapter }, () => {});
    expect(observer.adapters["probe-engine"].name).toBe("probe-engine");
    const returned = await observer.adapters["probe-engine"].start(options);
    expect(returned).toBe(it.session);
    expect(it.given()).toBe(options);
    expect(returned.reportedSessionId).toBe("engine-native-1");
  });

  test("it journals counts and identities, never a text, an argument, an environment value or a usage raw", async () => {
    const it = engine();
    const lines: Observed[] = [];
    const observer = observeAdapters({ "probe-engine": it.adapter }, line => lines.push(line));
    await observer.adapters["probe-engine"].start(options);
    it.receipts.forEach(handler => handler("fake:test-chat:1"));
    it.progress.forEach(handler => handler({ kind: "text", text: "secret partial" }));
    it.progress.forEach(handler => handler({ kind: "action", text: "Read" }));
    it.progress.forEach(handler => handler({ kind: "action_result", text: "" }));
    it.ends.forEach(handler => handler({ text: "secret answer", session_id: "native-1", usage, refused: null }));
    await observer.recordExits(1_000);
    expect(JSON.stringify(lines)).not.toContain("secret");
    expect(lines.find(line => line.kind === "start")).toMatchObject({ plan: { id: "native-1", resume: false }, command: "codex", boxed: true });
    expect(lines.find(line => line.kind === "turn_end")).toMatchObject({
      message: "fake:test-chat:1", reported: "engine-native-1", actions: 1, action_results: 1, text_events: 1, text_chars: 13,
      input_tokens: 10, output_tokens: 3, processes: [4242, 4243],
    });
    expect(lines.find(line => line.kind === "exit")).toMatchObject({ evidence: { confirmed: true, basis: "process-group", group: 4242 } });
  });

  test("a start that fails is journaled scrubbed and still fails", async () => {
    const lines: Observed[] = [];
    const failing: Adapter = { name: "probe-engine", async start() { throw new Error("cannot open /home/someone/keys/openai.key"); } };
    const observer = observeAdapters({ "probe-engine": failing }, line => lines.push(line), ["/home/someone/keys/openai.key"]);
    await expect(observer.adapters["probe-engine"].start(options)).rejects.toThrow("cannot open");
    expect(lines.find(line => line.kind === "start_failed")).toMatchObject({ error: "cannot open <redacted>" });
  });
});
