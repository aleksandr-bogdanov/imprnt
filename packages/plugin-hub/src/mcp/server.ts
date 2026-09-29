import { createConnection, type Socket } from "node:net";
import { TOOLS } from "./contracts.ts";

/**
 * The hub's tool facade, the small stdio MCP server the engine starts.
 *
 * It holds no store, no credential and no identity. Every call is sent over a
 * local socket to the RUNNER that launched this engine, with a token that
 * launch was given, and the runner answers it from the conversation and the turn
 * it bound that launch to. What a model writes into a call is arguments and
 * nothing else: there is no field that names a person, an agent or a route.
 *
 * Newline-delimited JSON-RPC on stdin and stdout, the transport MCP defines for
 * a child process. Only the three requests a tool server needs are answered.
 */
export interface FacadeOptions {
  socket: string;
  token: string;
  input: AsyncIterable<string | Uint8Array>;
  write(line: string): void;
}

interface Pending { resolve(value: { ok: boolean; result?: unknown; error?: { code: string; message: string } }): void }

export async function runFacade(options: FacadeOptions): Promise<void> {
  let connection: Socket | null = null;
  let buffer = "";
  let next = 1;
  const pending = new Map<number, Pending>();
  const closed = (why: string) => {
    for (const one of pending.values()) one.resolve({ ok: false, error: { code: "runner_unreachable", message: why } });
    pending.clear();
    connection = null;
  };
  const connect = (): Promise<Socket> => new Promise((resolve, reject) => {
    if (connection) return resolve(connection);
    const made = createConnection(options.socket);
    made.setEncoding("utf8");
    made.once("connect", () => { connection = made; resolve(made); });
    made.once("error", (error) => { closed(error.message); reject(error); });
    made.on("close", () => closed("the runner closed the connection"));
    made.on("data", (chunk: string) => {
      buffer += chunk;
      for (let cut = buffer.indexOf("\n"); cut >= 0; cut = buffer.indexOf("\n")) {
        const line = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 1);
        if (line === "") continue;
        const said = JSON.parse(line) as { id: number; ok: boolean; result?: unknown; error?: { code: string; message: string } };
        pending.get(said.id)?.resolve(said);
        pending.delete(said.id);
      }
    });
  });
  const ask = async (tool: string, args: unknown) => {
    try {
      const socket = await connect();
      const id = next++;
      const answered = new Promise<Parameters<Pending["resolve"]>[0]>((resolve) => pending.set(id, { resolve }));
      socket.write(JSON.stringify({ id, token: options.token, tool, args }) + "\n");
      return await answered;
    } catch (error) {
      return { ok: false as const, error: { code: "runner_unreachable", message: (error as Error).message } };
    }
  };
  const reply = (id: unknown, result: unknown) => options.write(JSON.stringify({ jsonrpc: "2.0", id, result }));
  const fail = (id: unknown, code: number, message: string) => options.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }));

  const decoder = new TextDecoder();
  let held = "";
  for await (const chunk of options.input) {
    held += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    for (let cut = held.indexOf("\n"); cut >= 0; cut = held.indexOf("\n")) {
      const line = held.slice(0, cut).trim();
      held = held.slice(cut + 1);
      if (line === "") continue;
      let message: { id?: unknown; method?: string; params?: { name?: string; arguments?: unknown; protocolVersion?: string } };
      try { message = JSON.parse(line); } catch { continue; }
      if (message.method === "initialize") {
        reply(message.id, { protocolVersion: message.params?.protocolVersion ?? "2024-11-05", capabilities: { tools: {} },
          serverInfo: { name: "hub", version: "1" } });
      } else if (message.method === "ping") {
        reply(message.id, {});
      } else if (message.method === "tools/list") {
        reply(message.id, { tools: TOOLS });
      } else if (message.method === "tools/call") {
        const answer = await ask(String(message.params?.name ?? ""), message.params?.arguments ?? {});
        reply(message.id, answer.ok
          ? { content: [{ type: "text", text: JSON.stringify(answer.result) }] }
          : { isError: true, content: [{ type: "text", text: JSON.stringify(answer.error) }] });
      } else if (message.id !== undefined) {
        fail(message.id, -32601, "unknown method");
      }
    }
  }
  // `connection` is set from callbacks, so what the loop above left it as is not
  // what the analysis of this function can see.
  (connection as Socket | null)?.destroy();
}

if (import.meta.main) {
  const socket = process.env.HUB_MCP_SOCKET;
  const token = process.env.HUB_MCP_TOKEN;
  if (!socket || !token) {
    process.stderr.write("hub-mcp: launched without the runner's binding\n");
    process.exit(2);
  }
  await runFacade({ socket, token, input: process.stdin as unknown as AsyncIterable<Uint8Array>, write: line => process.stdout.write(line + "\n") });
}
