// A deterministic App Server protocol peer. No model, credentials or network.
import { createInterface } from "node:readline";
import { appendFileSync } from "node:fs";
const config = JSON.parse(process.env.HUB_CODEX_CONFIG!);
const mode = process.env.CODEX_FIXTURE_MODE ?? "normal";
if (mode === "preferences") { process.stderr.write("Error: Failed to synchronize managed preferences\n"); process.exit(1); }
let thread = "thread-fixture", turn = 0;
const send = (value: unknown) => process.stdout.write(JSON.stringify(value) + "\n");
const note = (method: string, params: unknown) => send({ method, params });
const answer = (id: unknown, result: unknown) => send({ id, result });
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  const { id, method, params } = JSON.parse(line);
  if (process.env.CODEX_FIXTURE_LOG) appendFileSync(process.env.CODEX_FIXTURE_LOG, JSON.stringify({ method, params }) + "\n");
  if (method === "initialize") answer(id, { userAgent: "codex/0.160.0 (fixture)" });
  if (method === "config/read") answer(id, { config: mode === "config-drift" ? { ...config, agents: { enabled: true } } : config });
  if (method === "thread/read") answer(id, { thread: { id: params.threadId, turns: [{ id: "old", status: mode === "unfinished" ? "inProgress" : "completed" }] } });
  if (method === "thread/start" || method === "thread/resume") answer(id, { thread: { id: params.threadId ?? thread }, model: mode === "model-drift" ? "other-model" : params.model, modelProvider: params.modelProvider });
  if (method === "turn/interrupt") answer(id, {});
  if (method === "turn/start") {
    turn++;
    const turnId = `turn-${turn}`, paramsBase = { threadId: thread, turnId };
    note("turn/completed", { threadId: "foreign-thread", turn: { id: turnId, status: "completed", items: [{ type: "agentMessage", id: "foreign", text: "WRONG", phase: "final_answer" }] } });
    note("item/started", { ...paramsBase, item: { type: "commandExecution", id: "command" } });
    note("item/agentMessage/delta", { ...paramsBase, itemId: "commentary", delta: "Working" });
    note("item/completed", { ...paramsBase, item: { type: "agentMessage", id: "commentary", text: "Not the answer", phase: "commentary" } });
    answer(id, { turn: { id: turnId, status: "inProgress", items: [] } });
    if (mode === "disconnect") process.exit(0);
    if (mode === "hang") continue;
    note("item/completed", { ...paramsBase, item: { type: "commandExecution", id: "command" } });
    note("thread/tokenUsage/updated", { ...paramsBase, tokenUsage: { total: { inputTokens: 15 * turn, cachedInputTokens: 5 * turn, outputTokens: 7 * turn }, last: { inputTokens: 5, cachedInputTokens: 2, outputTokens: 3 } } });
    const item = { type: "agentMessage", id: "final", text: `result ${params.input[0].text}`, phase: "final_answer" };
    note("item/completed", { ...paramsBase, item });
    note("turn/completed", { threadId: thread, turn: { id: turnId, status: mode === "failed" ? "failed" : "completed", items: [item] } });
  }
}
