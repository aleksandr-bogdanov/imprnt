import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createCodex, codexSessionMapPath } from "../src/adapters/codex.ts";
import { FeedNotWritten, type Adapter, type AdapterSession, type TurnEnd } from "../src/adapters/types.ts";
const dirs: string[] = [], sessions: AdapterSession[] = [];
afterEach(async () => { for (const s of sessions.splice(0)) await s.close(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const adapter = createCodex({ timeoutMs: 2000 });
function options(mode = "normal") {
  const cwd = mkdtempSync(join(tmpdir(), "hub-codex-test-")); dirs.push(cwd); mkdirSync(join(cwd, "codex"));
  const config = { model: "explicit-model", model_provider: "provider", agents: { enabled: false }, cli_auth_credentials_store: "ephemeral", model_providers: { provider: { base_url: "http://127.0.0.1:9/v1", requires_openai_auth: true } } };
  return { cwd, argv: [process.execPath, join(import.meta.dir, "helpers/codex-server.ts")], wrap: (args: string[]) => args, privateModelKey: () => "synthetic-codex-key",
    preset: { adapter: "codex", model: "explicit-model", provider: "provider", effort: "high", paid: "token" },
    session: { id: "hub-job-1", resume: false }, sessionId: "hub-job-1",
    env: { PATH: process.env.PATH, HUB_CODEX_CONFIG: JSON.stringify(config), CODEX_FIXTURE_MODE: mode, CODEX_FIXTURE_LOG: join(cwd, "wire.jsonl") },
  } as Parameters<Adapter["start"]>[0];
}
async function start(args: Parameters<Adapter["start"]>[0]) { const s = await adapter.start(args); sessions.push(s); return s; }
function next(s: AdapterSession) { return new Promise<TurnEnd>(resolve => s.onTurnEnd(resolve)); }

test("Codex maps shared job identity, correlates early events, separates progress/final and resumes only its own completed thread", async () => {
  const args = options(); let s = await start(args);
  const receipt: string[] = [], progress: string[] = [];
  s.onReceipt(id => receipt.push(id)); s.onProgress(event => progress.push(event.kind));
  const result = next(s); await s.feed({ id: "job-1", text: "first" });
  expect(await result).toMatchObject({ text: "result first", refused: null, session_id: "hub-job-1", usage: { input_tokens: 15, cached_input_tokens: 5, output_tokens: 7 } });
  expect(receipt).toEqual(["job-1"]); expect(progress).toEqual(["action", "text", "action_result"]);
  expect(s.reportedSessionId).toBe("hub-job-1");
  await s.close();
  s = await start({ ...args, session: { id: "hub-job-1", resume: true } });
  const continued = next(s); await s.feed({ id: "followup", text: "second" }); expect((await continued).text).toBe("result second");
  const wire = readFileSync(join(args.cwd!, "wire.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
  expect(wire.filter(x => x.method === "thread/start")).toHaveLength(1);
  expect(wire.find(x => x.method === "thread/resume").params.threadId).toBe("thread-fixture");
  expect(wire.filter(x => x.method === "turn/start").map(x => x.params.clientUserMessageId)).toEqual(["job-1", "followup"]);
  expect(wire.filter(x => x.method === "turn/start").every(x => x.params.model === "explicit-model" && x.params.effort === "high")).toBe(true);
});

test("Codex refuses identity/config drift and missing/unfinished mappings without feeding or replacing a conversation", async () => {
  for (const mode of ["config-drift", "model-drift"]) await expect(start(options(mode))).rejects.toThrow();
  await expect(start(options("preferences"))).rejects.toThrow("codex-managed-preferences-unavailable");
  const insecure = options("auth-store-drift");
  let keyRead = false;
  await expect(start({ ...insecure, privateModelKey: () => { keyRead = true; return "synthetic-codex-key"; } })).rejects.toThrow("effective-config-mismatch");
  expect(keyRead).toBe(false);
  expect(readFileSync(join(insecure.cwd!, "wire.jsonl"), "utf8")).not.toContain("account/login/start");
  const args = options(); await expect(start({ ...args, session: { id: "hub-job-1", resume: true } })).rejects.toThrow("map-mismatch");
  const s = await start(args), end = next(s); await s.feed({ id: "one", text: "one" }); await end; await s.close();
  await expect(start({ ...args, preset: { ...args.preset, model: "other" } })).rejects.toThrow("identity-mismatch");
  await expect(start({ ...args, session: { id: "hub-job-1", resume: true }, env: { ...args.env, CODEX_FIXTURE_MODE: "unfinished" } })).rejects.toThrow("resume-unverified");
});

test("Codex lost connection and failed turn retain dirty marker, never replay; closed feed is provably unwritten", async () => {
  for (const mode of ["disconnect", "failed"]) {
    const args = options(mode), s = await start(args);
    const done = mode === "failed" ? next(s) : s.exited;
    await s.feed({ id: mode, text: "one" });
    const result = await done;
    if (mode === "failed") expect(result).toMatchObject({ text: "", refused: { cause: "other" } });
    await s.close();
    expect(JSON.parse(readFileSync(codexSessionMapPath(args.cwd!, args.session!.id), "utf8")).dirty).toBe(true);
    await expect(start({ ...args, session: { id: "hub-job-1", resume: true } })).rejects.toThrow("resume-unverified");
    await expect(s.feed({ id: "retry", text: "one" })).rejects.toBeInstanceOf(FeedNotWritten);
  }
});

test("Codex explicit stop asks turn/interrupt and retains uncertain turn rather than treating it as completed", async () => {
  const args = options("hang"), s = await start(args); await s.feed({ id: "stop-me", text: "wait" });
  await s.interrupt!({ graceMs: 100 });
  const wire = readFileSync(join(args.cwd!, "wire.jsonl"), "utf8");
  expect(wire).toContain('"method":"turn/interrupt"');
  expect(JSON.parse(readFileSync(codexSessionMapPath(args.cwd!, args.session!.id), "utf8")).dirty).toBe(true);
});

test("fresh native identities keep prior dirty maps and never resume or replay them", async () => {
  const args = options("failed"), first = await start(args), failed = next(first);
  await first.feed({ id: "failed-input", text: "old input" }); await failed; await first.close();
  const oldPath = codexSessionMapPath(args.cwd!, args.session!.id), oldBytes = readFileSync(oldPath, "utf8");
  const replacement = { ...args, env: { ...args.env, CODEX_FIXTURE_MODE: "normal" }, session: { id: "replacement", resume: false } };
  const second = await start(replacement), done = next(second);
  await second.feed({ id: "fresh-input", text: "new input" }); await done; await second.close();
  expect(readFileSync(oldPath, "utf8")).toBe(oldBytes);
  expect(JSON.parse(oldBytes).dirty).toBe(true);
  expect(JSON.parse(readFileSync(codexSessionMapPath(args.cwd!, "replacement"), "utf8"))).toMatchObject({ hub: "replacement", dirty: false, sent: true });
  await expect(start({ ...args, session: { id: args.session!.id, resume: true } })).rejects.toThrow("resume-unverified");
  await expect(start({ ...args, session: { id: "missing", resume: true } })).rejects.toThrow("map-mismatch");
  await expect(start(replacement)).rejects.toThrow("map-mismatch");
  const wire = readFileSync(join(args.cwd!, "wire.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
  expect(wire.filter(x => x.method === "thread/start")).toHaveLength(2);
  expect(wire.filter(x => x.method === "thread/resume")).toHaveLength(0);
  expect(wire.filter(x => x.method === "turn/start").map(x => x.params.clientUserMessageId)).toEqual(["failed-input", "fresh-input"]);
});

test("legacy maps remain readable only for their own identity and survive fresh context", async () => {
  const args = options(), first = await start(args), done = next(first);
  await first.feed({ id: "legacy", text: "legacy input" }); await done; await first.close();
  const keyed = codexSessionMapPath(args.cwd!, args.session!.id), legacy = join(args.cwd!, "codex/hub-session.json");
  const bytes = readFileSync(keyed, "utf8"); writeFileSync(legacy, bytes); rmSync(keyed);
  const resumed = await start({ ...args, session: { id: args.session!.id, resume: true } }); await resumed.close();
  const fresh = await start({ ...args, session: { id: "fresh-after-legacy", resume: false } }); await fresh.close();
  expect(readFileSync(legacy, "utf8")).toBe(bytes);
  await expect(start({ ...args, session: { id: "foreign", resume: true } })).rejects.toThrow("map-mismatch");
});
