// Synthetic stdio MCP server for the native-session portability harness. One tool, one local effect.
//
// `fixture_effect` generates its OWN random result at call time (the harness never supplies it and never sends it
// to the model), appends one fsynced line to <fixture dir>/effects.jsonl, and returns the result as text. The
// effect log is outside the session tree, so it is never part of anything exported. Every call is one more line:
// a replayed tool call after a resume shows up as a second effect.
//
// argv[2] is the fixture directory (absolute, harness-owned). It exits when stdin closes and after 120 s as an
// orphan guard. It touches no network and no file other than effects.jsonl.
import { closeSync, fsyncSync, openSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";

const fixtureDir = process.argv[2];
if (!fixtureDir || !fixtureDir.startsWith("/")) process.exit(2);
const EFFECTS = join(fixtureDir, "effects.jsonl");

const TOOL = {
  name: "fixture_effect",
  description: "Synthetic fixture tool. Records one local effect and returns a generated result string.",
  inputSchema: { type: "object", properties: {} },
};

const send = (message: unknown) => process.stdout.write(`${JSON.stringify(message)}\n`);

setTimeout(() => process.exit(0), 120_000).unref();

let calls = 0;
function record(): string {
  const result = `RESULT-${randomBytes(12).toString("hex")}`;
  const fd = openSync(EFFECTS, "a", 0o600);
  try {
    writeSync(fd, `${JSON.stringify({ n: ++calls, ts: Date.now(), pid: process.pid, tool: TOOL.name, result })}\n`);
    fsyncSync(fd);
  } finally { closeSync(fd); }
  return result;
}

const decoder = new TextDecoder();
let buffer = "";
for await (const chunk of Bun.stdin.stream()) {
  buffer += decoder.decode(chunk, { stream: true });
  let at: number;
  while ((at = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, at);
    buffer = buffer.slice(at + 1);
    let message: { method?: string; id?: unknown; params?: { protocolVersion?: string; name?: string } } | null;
    try { message = JSON.parse(line); } catch { continue; }
    if (message === null || typeof message !== "object") continue;
    const { method, id, params } = message;
    if (method === undefined || id === undefined) continue; // notifications and client replies need no answer
    if (method === "initialize") {
      send({ jsonrpc: "2.0", id, result: {
        protocolVersion: params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "fixture", version: "0.0.1" },
      } });
    } else if (method === "ping") send({ jsonrpc: "2.0", id, result: {} });
    else if (method === "tools/list") send({ jsonrpc: "2.0", id, result: { tools: [TOOL] } });
    else if (method === "tools/call" && params?.name === TOOL.name) {
      send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: record() }], isError: false } });
    } else if (method === "tools/call") send({ jsonrpc: "2.0", id, error: { code: -32602, message: "unknown tool" } });
    else send({ jsonrpc: "2.0", id, error: { code: -32601, message: "method not found" } });
  }
}
process.exit(0);
