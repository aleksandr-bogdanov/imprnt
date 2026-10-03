import { existsSync, readFileSync, renameSync, writeFileSync, openSync, fsyncSync, closeSync } from "node:fs";
import { join } from "node:path";
import { CODEX_BUILD, CODEX_CONFIG } from "./codex-config.ts";
import { watchChild } from "./opencode-process.ts";
import { FeedNotWritten, type Adapter, type AdapterProgress, type AdapterSession, type AdapterUsage, type TurnEnd } from "./types.ts";

type Json = Record<string, any>;
interface Saved { version: 1; hub: string; thread: string; model: string; provider: string; endpoint: string; dirty: boolean; sent: boolean; totals?: Record<string, number> | null }
function includesConfig(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(expected)) return Array.isArray(actual) && actual.length === expected.length && expected.every((value, index) => includesConfig(actual[index], value));
  if (expected && typeof expected === "object") return actual !== null && typeof actual === "object" && Object.entries(expected).every(([key, value]) => includesConfig((actual as Json)[key], value));
  return actual === expected;
}
const nullUsage = (): AdapterUsage => ({ input_tokens: null, cached_input_tokens: null, output_tokens: null, plan_usage: null, raw: {} });

/** Codex's app-server owns the model/tool loop. The hub drives one thread and one turn at a time. */
async function open(options: Parameters<Adapter["start"]>[0], timeoutMs: number): Promise<AdapterSession> {
  if (!options.cwd || !options.argv || !options.env?.[CODEX_CONFIG] || !options.wrap || !options.session || !options.privateModelKey) throw new Error("codex-launch-required");
  const config = JSON.parse(options.env[CODEX_CONFIG]) as Json;
  const model = options.preset.model, provider = options.preset.provider;
  const endpoint = config.model_providers?.[provider]?.base_url;
  if (config.model !== model || config.model_provider !== provider || typeof endpoint !== "string" || config.agents?.enabled !== false ||
      config.cli_auth_credentials_store !== "ephemeral" || config.model_providers?.[provider]?.requires_openai_auth !== true ||
      config.model_providers?.[provider]?.env_key !== undefined) throw new Error("codex-identity-mismatch");
  const effort = options.preset.effort;
  if (typeof effort !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(effort)) throw new Error("codex-effort-unsupported");
  const path = join(options.cwd, "codex", "hub-session.json");
  let saved: Saved | null = null;
  if (existsSync(path)) {
    try { saved = JSON.parse(readFileSync(path, "utf8")) as Saved; } catch { throw new Error("codex-session-map-unreadable"); }
    if (!saved || saved.version !== 1 || typeof saved.hub !== "string" || !saved.hub || typeof saved.thread !== "string" || !saved.thread || typeof saved.dirty !== "boolean" || typeof saved.sent !== "boolean" ||
        saved.model !== model || saved.provider !== provider || saved.endpoint !== endpoint) throw new Error("codex-session-identity-mismatch");
    // The runner replaces a launched-but-unacknowledged native ID on restart.
    // Only our durable pre-input state proves the old thread has no input or
    // tool effects. A sent/dirty/foreign resume mapping is never discarded.
    if (saved.hub !== options.session.id) {
      if (!options.session.resume && !saved.dirty && !saved.sent) saved = null;
      else throw new Error("codex-session-identity-mismatch");
    }
  }
  if (options.session.resume ? !saved : saved !== null) throw new Error("codex-session-map-mismatch");
  if (saved?.dirty) throw new Error("codex-resume-unverified");
  const save = () => {
    writeFileSync(path + ".next", JSON.stringify(saved), { mode: 0o600 });
    const file = openSync(path + ".next", "r");
    try { fsyncSync(file); } finally { closeSync(file); }
    renameSync(path + ".next", path);
    const directory = openSync(join(options.cwd!, "codex"), "r");
    try { fsyncSync(directory); } finally { closeSync(directory); }
  };
  const child = Bun.spawn(options.wrap(options.argv), { cwd: options.cwd, env: options.env, stdin: "pipe", stdout: "pipe", stderr: "pipe", ...({ detached: true } as object) });
  let watch: ReturnType<typeof watchChild>;
  try { watch = watchChild(child); } catch (error) { child.kill(); await child.exited; throw error; }
  watch.snapshot();
  // Only a closed startup label is exported; arbitrary engine diagnostics can contain secrets.
  let diagnosticTail = "", preferencesUnavailable = false;
  const diagnostics = (async () => {
    const decoder = new TextDecoder();
    for await (const bytes of child.stderr) {
      diagnosticTail = (diagnosticTail + decoder.decode(bytes, { stream: true })).slice(-4096);
      if (diagnosticTail.includes("Failed to synchronize managed preferences")) preferencesUnavailable = true;
    }
  })().catch(() => {});
  let closed = false, nextId = 0;
  const waiting = new Map<number, { resolve(value: Json): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  const receipts: ((id: string) => void)[] = [];
  const progress: ((event: AdapterProgress) => void)[] = [];
  const ends: ((end: TurnEnd) => void)[] = [];
  let active: { message: string; turn: string | null; buffered: Json[]; bytes: number; final: Map<string, string>; usage: AdapterUsage; totals: Record<string, number> | null } | null = null;
  const write = (value: Json) => { child.stdin.write(JSON.stringify(value) + "\n"); return child.stdin.flush(); };
  const rpc = (method: string, params: Json): Promise<Json> => new Promise((resolve, reject) => {
    if (closed || watch.gone()) { reject(new Error("codex-connection-closed")); return; }
    const id = ++nextId;
    const timer = setTimeout(() => { waiting.delete(id); reject(new Error("codex-rpc-timeout")); }, timeoutMs);
    waiting.set(id, { resolve, reject, timer });
    try { Promise.resolve(write({ id, method, params })).catch(() => { clearTimeout(timer); waiting.delete(id); reject(new Error("codex-write-uncertain")); }); }
    catch { clearTimeout(timer); waiting.delete(id); reject(new Error("codex-write-uncertain")); }
  });
  const notify = (message: Json) => {
    const current = active, p = message.params as Json | undefined;
    if (!current || !p || p.threadId !== saved?.thread) return;
    if (current.turn === null) {
      current.bytes += JSON.stringify(message).length;
      if (current.bytes > 1_000_000) throw new Error("codex-event-overflow");
      current.buffered.push(message); return;
    }
    if ((p.turnId ?? p.turn?.id) !== current.turn) return;
    if (message.method === "item/agentMessage/delta" && typeof p.delta === "string") progress.forEach(fn => fn({ kind: "text", text: p.delta }));
    if (["item/started", "item/completed"].includes(message.method)) {
      const item = p.item;
      if (item?.type === "agentMessage" && message.method === "item/completed" && (item.phase === "final_answer" || item.phase === null) && typeof item.text === "string") current.final.set(item.id, item.text);
      if (["commandExecution", "fileChange", "mcpToolCall", "dynamicToolCall"].includes(item?.type)) {
        progress.forEach(fn => fn({ kind: message.method === "item/started" ? "action" : "action_result", text: message.method === "item/started" ? item.type : "" }));
      }
    }
    if (message.method === "thread/tokenUsage/updated") {
      // `last` may describe only the latest model request in a tool-using turn.
      // Price only the cumulative thread-counter delta from the prior completed turn.
      const usage = p.tokenUsage?.total;
      const count = (key: string) => Number.isFinite(usage?.[key]) && Number.isFinite(saved?.totals?.[key]) && usage[key] >= saved!.totals![key] ? usage[key] - saved!.totals![key] : null;
      current.totals = usage && ["inputTokens", "cachedInputTokens", "outputTokens"].every(key => Number.isFinite(usage[key]) && usage[key] >= 0) ? usage : null;
      current.usage = { input_tokens: count("inputTokens"), cached_input_tokens: count("cachedInputTokens"), output_tokens: count("outputTokens"), plan_usage: null, raw: { tokenUsage: p.tokenUsage } };
    }
    if (message.method === "turn/completed") {
      // Completion payload is authoritative when it contains final items; streamed commentary is never the answer.
      for (const item of p.turn.items ?? []) if (item.type === "agentMessage" && (item.phase === "final_answer" || item.phase === null) && typeof item.text === "string") current.final.set(item.id, item.text);
      const text = [...current.final.values()].at(-1) ?? "";
      const succeeded = p.turn.status === "completed" && text !== "";
      // Only a successful terminal turn makes this mapping eligible for ordinary continuation.
      if (succeeded) { saved!.dirty = false; saved!.totals = current.totals; save(); }
      active = null;
      ends.forEach(fn => fn({ text: succeeded ? text : "", session_id: options.session!.id, usage: current.usage,
        refused: succeeded ? null : { cause: p.turn.error?.codexErrorInfo === "unauthorized" ? "login" : "other", said: `codex-turn-${["failed", "interrupted", "completed"].includes(p.turn.status) ? p.turn.status : "unknown"}` } }));
    }
  };
  const cancelPending = () => {
    for (const entry of waiting.values()) { clearTimeout(entry.timer); entry.reject(new Error("codex-connection-lost")); }
    waiting.clear();
  };
  const fail = () => {
    if (closed) return;
    closed = true; cancelPending();
    void watch.stop(100).catch(() => {});
  };
  void (async () => {
    const decoder = new TextDecoder(); let pending = "";
    for await (const chunk of child.stdout) {
      pending += decoder.decode(chunk, { stream: true });
      if (pending.length > 4_000_000) throw new Error("codex-frame-overflow");
      for (;;) {
        const at = pending.indexOf("\n"); if (at < 0) break;
        const line = pending.slice(0, at); pending = pending.slice(at + 1);
        if (!line.trim()) continue;
        const message = JSON.parse(line) as Json;
        if (message.id !== undefined && message.method) {
          // No approval or external tool implementation is invented by this adapter.
          await write({ id: message.id, error: { code: -32601, message: "Hub does not provide interactive approvals" } });
        } else if (message.id !== undefined) {
          const entry = waiting.get(message.id); if (!entry) continue;
          waiting.delete(message.id); clearTimeout(entry.timer);
          if (message.error) entry.reject(new Error("codex-rpc-refused")); else entry.resolve(message.result);
        } else notify(message);
      }
    }
    fail();
  })().catch(fail);
  void child.exited.then(fail);
  try {
    const initialized = await rpc("initialize", { clientInfo: { name: "imprnt_hub", title: "imprnt Hub", version: "3.0.0" }, capabilities: { experimentalApi: true } });
    if (typeof initialized.userAgent !== "string" || !initialized.userAgent.includes(`/${CODEX_BUILD} `)) throw new Error("codex-build-unvalidated");
    await write({ method: "initialized", params: {} });
    const read = await rpc("config/read", { includeLayers: false, cwd: options.cwd });
    if (read.config?.agents?.enabled !== false || read.config?.model !== model || read.config?.model_provider !== provider ||
        read.config?.model_providers?.[provider]?.base_url !== endpoint || !includesConfig(read.config, config) ||
        JSON.stringify(Object.keys(read.config?.mcp_servers ?? {}).sort()) !== JSON.stringify(Object.keys(config.mcp_servers ?? {}).sort())) throw new Error("codex-effective-config-mismatch");
    // Only after the engine confirms memory-only credential storage. The key
    // travels over the private stdio RPC, never a parent-visible environment,
    // command line, config/auth file or model input. Every restart logs in anew.
    const login = await rpc("account/login/start", { type: "apiKey", apiKey: options.privateModelKey() });
    if (login.type !== "apiKey") throw new Error("codex-auth-mode-mismatch");
    if (saved?.sent) {
      const prior = await rpc("thread/read", { threadId: saved.thread, includeTurns: true });
      if (prior.thread?.id !== saved.thread || prior.thread?.turns?.some((turn: Json) => turn.status !== "completed")) throw new Error("codex-resume-unverified");
    }
    // An empty Codex thread is not materialized until its first input. The durable
    // sent=false marker proves there are no input/tool effects to resume or replay.
    const resume = saved?.sent === true;
    const started = await rpc(resume ? "thread/resume" : "thread/start", {
      ...(resume ? { threadId: saved!.thread } : { historyMode: "legacy" }), model, modelProvider: provider, cwd: options.cwd,
      approvalPolicy: "never", sandbox: "danger-full-access", ...(config.developer_instructions ? { developerInstructions: config.developer_instructions } : {}),
    });
    if (started.model !== model || started.modelProvider !== provider || typeof started.thread?.id !== "string" ||
        (resume && started.thread.id !== saved!.thread)) throw new Error("codex-model-mismatch");
    saved = { version: 1, hub: options.session.id, thread: started.thread.id, model, provider, endpoint, dirty: false, sent: resume, totals: resume ? saved!.totals ?? null : { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 } };
    save();
  } catch (error) { closed = true; cancelPending(); await watch.stop(100); await Promise.race([diagnostics, Bun.sleep(1000)]);
    if (preferencesUnavailable) throw new Error("codex-managed-preferences-unavailable");
    throw error; }
  return {
    sessionId: options.session.id, reportedSessionId: options.session.id, pid: child.pid, exited: child.exited, lacks: [],
    processes: watch.snapshot, partial: watch.partial, group: () => watch.ownGroup, exitEvidence: watch.exitEvidence,
    async feed(message) {
      if (closed || watch.gone()) throw new FeedNotWritten("codex-closed");
      if (active) throw new FeedNotWritten("codex-busy");
      saved!.dirty = true; saved!.sent = true; save(); // crash barrier before any input byte; no blind retry/replay
      active = { message: message.id, turn: null, buffered: [], bytes: 0, final: new Map(), usage: nullUsage(), totals: null };
      const started = await rpc("turn/start", { threadId: saved!.thread, clientUserMessageId: message.id,
        model, ...(effort === "default" ? {} : { effort }), input: [{ type: "text", text: message.text, text_elements: [] }] });
      if (typeof started.turn?.id !== "string") throw new Error("codex-turn-unidentified");
      const current = active;
      current.turn = started.turn.id;
      receipts.forEach(fn => fn(message.id));
      for (const event of current.buffered) notify(event);
      current.buffered = [];
    },
    onReceipt(fn) { receipts.push(fn); }, onProgress(fn) { progress.push(fn); }, onTurnEnd(fn) { ends.push(fn); },
    async interrupt({ graceMs }) {
      if (active?.turn && !closed) { try { await Promise.race([rpc("turn/interrupt", { threadId: saved!.thread, turnId: active.turn }), Bun.sleep(Math.min(graceMs, 1000))]); } catch { /* process evidence decides */ } }
      closed = true; cancelPending(); return await watch.stop(graceMs);
    },
    async close() { closed = true; cancelPending(); await watch.stop(200); },
  };
}

export function createCodex(options: { timeoutMs?: number } = {}): Adapter {
  return {
    name: "codex",
    async capabilities(context) {
      const { credentialSource } = await import("./launch.ts");
      const { readModelKey } = await import("./opencode-launch.ts");
      const { probeCodexVersion } = await import("./codex-launch.ts");
      readModelKey(credentialSource(context.registry, context.preset));
      const version = probeCodexVersion(context.probe?.bin, context.probe?.timeoutMs);
      return { version, stableSession: version === CODEX_BUILD, delegationDisabled: version === CODEX_BUILD, safeResume: false };
    },
    async prepareLaunch(input, probe) {
      const { probeCodexVersion, makeCodexLaunch } = await import("./codex-launch.ts");
      if (probeCodexVersion(probe?.bin, probe?.timeoutMs) !== CODEX_BUILD) throw new Error("codex-build-unvalidated");
      return makeCodexLaunch(input, probe?.bin);
    },
    start: args => open(args, options.timeoutMs ?? 30_000),
  };
}
export const codex = createCodex();
