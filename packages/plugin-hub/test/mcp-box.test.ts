// The hub's tool facade from INSIDE a person's box (IMP-227).
//
// mcp-facade.test.ts runs the stdio server as a plain child. In production the
// engine starts it as a child of a boxed loop, so it has to run under that box's
// own wrapper and still reach the runner's socket. The wrapper here is the one
// `makeLoopLaunch` returns for a launch carrying `bindFacade`'s own `hubMcp`
// (sandbox-exec on a Mac, bwrap on Linux), and the server's command, arguments and
// environment are read back out of the `mcp.json` that launch wrote, so what is
// tried is what the engine would have been handed. A box that does not let the
// interpreter, the file or the socket through fails here, and nothing is granted
// for the test's sake.
//
// No engine and no model: the boxed process is the facade alone, and the login
// the launch names is a synthetic file that is never read by anything.

import { afterAll, beforeAll, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { startCluster, type Cluster } from "./helpers/cluster.ts"
import { boxGate } from "./helpers/box-gate.ts"
import { CHAT, DOOR, PERSON, stageHub } from "./helpers/hub-fixture.ts"
import { launchInput, launchSeam, loopFixture } from "./helpers/rollout-loop.ts"
import { type McpBinding } from "../src/mcp/handlers.ts"
import { bindFacade } from "../src/runner/ipc.ts"
import { endAttempt } from "../src/runner/execution.ts"
import { loadRegistry } from "../src/registry/load.ts"
import { conversationFor, markFeedIntent, openExecution, registerIncarnation } from "../src/store/conversations.ts"
import type { StoreLike } from "../src/store/connect.ts"
import type { ExitEvidence } from "../src/adapters/types.ts"

let cluster: Cluster
beforeAll(async () => { cluster = await startCluster() })
afterAll(async () => { await cluster?.stop() })

const gate = boxGate()
const GONE: ExitEvidence = { confirmed: true, leader: "exited", descendants: "none", pids: [], survivors: [], via: "test" }

test.skipIf(!gate.ok)(`the engine's facade command runs inside the person's box and reaches the runner's socket: initialize, tools/list and a bound inspect answer, with no database login in its environment${gate.ok ? "" : ` [skipped: ${gate.reason}]`}`, async () => {
  // A master with one interrupted attempt held, for the inspect call to find.
  const it = await stageHub(cluster, { people: [{ id: PERSON, allowed_senders: { [DOOR]: [PERSON] } } as never] })
  const su = cluster.connect(it.db)
  const store = { sql: cluster.connectAs("hub_runner", it.db), url: cluster.url(it.db) } as StoreLike
  const f = loopFixture()
  let facade: Awaited<ReturnType<typeof bindFacade>> | undefined
  let child: ReturnType<typeof Bun.spawn> | undefined
  try {
    await su`insert into inbound (id, person, agent, body, kind, source) values ('h1', ${PERSON}, 'p1-lair', 'words of h1', 'human',
      ${{ log_id: "h1", at: new Date().toISOString(), door: DOOR, chat: CHAT, sender_id: PERSON, text: "words of h1" }}::jsonb)`
    const conversation = await conversationFor(store, { row: { id: "h1", person: PERSON, agent: "p1-lair", kind: "human" }, adapter: "claude-code", machine: "pi" })
    // What an attempt needs to exist at all: the runner's current incarnation is registered and the row
    // is claimed by it. The facade under test is granted nothing for this; it is the ordinary opening.
    await registerIncarnation(store, { runner: "runner-a", incarnation: "one", machine: "pi", bootId: null })
    await su`update inbound set claimed_by = 'runner-a', claim_deadline = now() + interval '1 hour' where id = 'h1'`
    const attempt = await openExecution(store, { row: { id: "h1", agent: "p1-lair" }, conversation, runner: "runner-a", incarnation: "one", digest: "d", nativeSession: null })
    await markFeedIntent(store, attempt, "words of h1")
    await endAttempt(store, { execution: attempt.id, evidence: GONE, cause: "gone" })
    const binding: McpBinding = { store, person: PERSON, agent: "p1-lair", conversation: conversation.id, kind: "master",
      registry: () => loadRegistry(it.registryFile), attempt: () => null }
    facade = await bindFacade(binding)

    // The production launch, carrying the production facade's own server entry.
    const input = launchInput(f)
    const launch = await (await launchSeam())({ ...input, hubMcp: facade.server })
    const entry = JSON.parse(readFileSync(join(launch.cwd, "mcp.json"), "utf8")).mcpServers.hub as { command: string; args: string[]; env: Record<string, string> }
    expect(entry).toEqual({ command: facade.server.command, args: facade.server.args, env: facade.server.env })
    // The engine gives the server its own PATH, HOME and TMPDIR beside the entry's env, and nothing of the hub's.
    const env: Record<string, string> = { ...Object.fromEntries(["PATH", "HOME", "TMPDIR"].filter(key => launch.env[key]).map(key => [key, launch.env[key] as string])), ...entry.env }
    expect(Object.keys(entry.env).sort()).toEqual(["HUB_MCP_SOCKET", "HUB_MCP_TOKEN"])
    expect(Object.values(env).some(value => value.includes(cluster.url(it.db)) || /^postgres(ql)?:/.test(value))).toBe(false)

    const argv: string[] = launch.wrap([entry.command, ...entry.args])
    expect(argv[0]).toBe(gate.tool === "bwrap" ? "/usr/bin/bwrap" : "/usr/bin/sandbox-exec")
    child = Bun.spawn(argv, { cwd: launch.cwd, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" })
    const stdin = child.stdin as unknown as { write(data: string): number; flush(): Promise<number> | number }
    const reader = (child.stdout as unknown as ReadableStream<Uint8Array>).getReader()
    const decoder = new TextDecoder()
    let buffer = ""
    const line = async (): Promise<any> => {
      for (;;) {
        const cut = buffer.indexOf("\n")
        if (cut >= 0) { const said = buffer.slice(0, cut); buffer = buffer.slice(cut + 1); return JSON.parse(said) }
        const { value, done } = await reader.read()
        if (done) throw new Error("the boxed facade closed its output")
        buffer += decoder.decode(value, { stream: true })
      }
    }
    const send = async (message: Record<string, unknown>) => { stdin.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n"); await stdin.flush() }
    const call = async (message: Record<string, unknown>) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await send(message)
        return await Promise.race([line(), new Promise<never>((_, no) => { timer = setTimeout(() => no(new Error(`no answer to ${message.method} within 15 s`)), 15_000) })])
      } finally { clearTimeout(timer) }
    }

    try {
      const started = await call({ id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1" } } })
      expect(started.result.serverInfo.name).toBe("hub")
      await send({ method: "notifications/initialized" })
      const listed = await call({ id: 2, method: "tools/list" })
      expect(listed.result.tools.map((tool: { name: string }) => tool.name)).toEqual(["hub_topic"])
      // Only a call the runner answered proves the socket: initialize and tools/list never leave the box.
      const inspected = await call({ id: 3, method: "tools/call", params: { name: "hub_topic", arguments: { action: "inspect" } } })
      expect(inspected.result.isError, inspected.result.content?.[0]?.text).toBeUndefined()
      const body = JSON.parse(inspected.result.content[0].text)
      expect(body).toMatchObject({ status: "complete", stage: "held_work" })
      expect(body.holds.map((hold: { attempt_id: string }) => hold.attempt_id)).toEqual([attempt.id])
    } catch (error) {
      // A box that denied the interpreter, the file or the socket says so on the child's stderr.
      child.kill()
      const said = (await new Response(child.stderr as unknown as ReadableStream).text()).trim().slice(0, 600)
      throw new Error(`${(error as Error).message}${said ? `\nboxed facade stderr: ${said}` : ""}`)
    }
  } finally {
    child?.kill()
    await child?.exited.catch(() => {})
    await facade?.close()
    await store.sql.close().catch(() => {})
    await su.close().catch(() => {})
    await it.stop()
    f.stop()
  }
}, 60_000)
