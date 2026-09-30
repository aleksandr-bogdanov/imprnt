import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { safeValue } from "../door/lines.ts";
import { ToolError } from "../mcp/contracts.ts";
import { callTool, type McpBinding } from "../mcp/handlers.ts";
import type { HubMcpServer } from "../adapters/launch.ts";

/**
 * The runner's end of the hub's tool facade: one local socket per launch,
 * answered from the conversation and the turn that launch is bound to.
 *
 * The socket is what carries the identity, and the token is what keeps another
 * process that finds the path from using it. Nothing a call says can change
 * whose call it is, and the model behind it never holds a database login: the
 * handler runs here, in the runner, with the runner's own store.
 */
export interface FacadeBinding {
  /** How the engine is told to start the facade. */
  server: HubMcpServer;
  close(): Promise<void>;
}

const FACADE = new URL("../mcp/server.ts", import.meta.url).pathname;

export async function bindFacade(binding: McpBinding): Promise<FacadeBinding> {
  // In the temporary directory because a socket path is short-limited and this
  // is the one place both boxes let a process reach, and mode 0700 by `mkdtemp`.
  const dir = mkdtempSync(join(tmpdir(), "hub-mcp-"));
  const path = join(dir, "s");
  const token = crypto.randomUUID();
  const connections = new Set<import("node:net").Socket>();
  const server = createServer((socket) => {
    connections.add(socket);
    socket.setEncoding("utf8");
    socket.on("close", () => connections.delete(socket));
    socket.on("error", () => {});
    let buffer = "";
    const answer = async (line: string) => {
      let id = 0;
      try {
        const request = JSON.parse(line) as { id?: number; token?: string; tool?: string; args?: unknown };
        id = Number(request.id ?? 0);
        if (request.token !== token) throw new ToolError("invalid_arguments", "this call does not carry the launch's token");
        const result = await callTool(binding, String(request.tool ?? ""), request.args ?? {});
        socket.write(JSON.stringify({ id, ok: true, result }) + "\n");
      } catch (error) {
        // What is not a `ToolError` is the hub's own fault, and its words (a
        // query, a path) are for the runner's log and never for a model.
        if (!(error instanceof ToolError)) process.stderr.write(`hub-mcp: ${safeValue((error as Error)?.message)}\n`);
        socket.write(JSON.stringify({ id, ok: false, error: error instanceof ToolError
          ? { code: error.code, message: error.message }
          : { code: "internal_error", message: "the hub could not apply this call" } }) + "\n");
      }
    };
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      for (let cut = buffer.indexOf("\n"); cut >= 0; cut = buffer.indexOf("\n")) {
        const line = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 1);
        if (line !== "") void answer(line);
      }
    });
  });
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(path, () => resolve()); });
    chmodSync(path, 0o600);
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
  return {
    server: {
      command: process.execPath,
      args: [FACADE],
      env: { HUB_MCP_SOCKET: path, HUB_MCP_TOKEN: token },
      reads: [process.execPath, dirname(FACADE)],
      writes: [dir],
    },
    async close() {
      for (const socket of connections) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
