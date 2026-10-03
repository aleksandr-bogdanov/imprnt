// Synthetic stdio MCP used only by prove-codex-box.ts, inside the actual box.
import { createInterface } from "node:readline";
import { readFileSync, writeFileSync } from "node:fs";
import { probeKey } from "./codex-key-probe.ts";
const denied = (path: string): boolean => {
  try { readFileSync(path); return false; }
  catch (error) { return ["EACCES", "EPERM", "ENOENT"].includes((error as NodeJS.ErrnoException).code ?? ""); }
};
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  let result: unknown = {};
  if (request.method === "initialize") result = { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "hub-offline-fixture", version: "1" } };
  else if (request.method === "tools/list") result = { tools: [{ name: "hub_probe", description: "Offline synthetic Hub fixture", inputSchema: { type: "object", properties: {}, additionalProperties: false } }] };
  else if (request.method === "tools/call") {
    try {
      const fences = { secret_denied: denied(process.env.FIXTURE_SECRET!), other_person_denied: denied(process.env.FIXTURE_OTHER!),
        key_probe: await probeKey(process.env.FIXTURE_PID_FILE!),
        ...(process.env.FIXTURE_BREW_DATA ? { brew_data_denied: denied(process.env.FIXTURE_BREW_DATA) } : {}) };
      writeFileSync(process.env.FIXTURE_MARKER!, JSON.stringify(fences));
      result = { content: [{ type: "text", text: "synthetic Hub tool result" }] };
    } catch (error) {
      writeFileSync(process.env.FIXTURE_MARKER!, JSON.stringify({ probe_error: String((error as Error).message) }));
      result = { isError: true, content: [{ type: "text", text: "synthetic probe failed" }] };
    }
  }
  if (request.id !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n");
}
