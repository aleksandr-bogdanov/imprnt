// The hub's tool facade: identity is the runner's binding and never an argument,
// the model holds no database login, source evidence is the one thing code can
// verify about an owner's choice, and a repeated call is one request.
//
// The handlers run on the RUNNER's role connection, so a grant the runner does
// not have shows up here as a failure and not in production.

import { afterAll, beforeAll, expect, test } from "bun:test"
import { join } from "node:path"
import { startCluster, type Cluster } from "./helpers/cluster.ts"
import { CHAT, DOOR, PERSON, stageHub } from "./helpers/hub-fixture.ts"
import { ToolError, readTopicRequest } from "../src/mcp/contracts.ts"
import { callTool, type McpBinding } from "../src/mcp/handlers.ts"
import { bindFacade } from "../src/runner/ipc.ts"
import { endAttempt } from "../src/runner/execution.ts"
import { loadRegistry } from "../src/registry/load.ts"
import { conversationFor, markFeedIntent, openExecution, registerIncarnation } from "../src/store/conversations.ts"
import type { StoreLike } from "../src/store/connect.ts"
import type { ExitEvidence } from "../src/adapters/types.ts"

let cluster: Cluster
beforeAll(async () => { cluster = await startCluster() })
afterAll(async () => { await cluster?.stop() })

const GONE: ExitEvidence = { confirmed: true, leader: "exited", descendants: "none", pids: [], survivors: [], via: "test" }

/** A master with one interrupted attempt held, and the owner's messages around it. */
async function staged() {
  const it = await stageHub(cluster, { people: [{ id: PERSON, allowed_senders: { [DOOR]: [PERSON, "the-other-allowed"] } } as never] })
  const su = cluster.connect(it.db)
  const store = { sql: cluster.connectAs("hub_runner", it.db), url: cluster.url(it.db) } as StoreLike
  const human = async (id: string, over: { agent?: string; person?: string; sender?: string; kind?: string } = {}) => {
    await su`insert into inbound (id, person, agent, body, kind, source) values (${id}, ${over.person ?? PERSON}, ${over.agent ?? "p1-lair"}, ${`words of ${id}`}, ${over.kind ?? "human"},
      ${{ log_id: id, at: new Date().toISOString(), door: DOOR, chat: CHAT, sender_id: over.sender ?? PERSON, text: `words of ${id}` }}::jsonb)`
  }
  await human("h1")
  const conversation = await conversationFor(store, { row: { id: "h1", person: PERSON, agent: "p1-lair", kind: "human" }, adapter: "claude-code", machine: "pi" })
  // The attempt is opened by the runner that holds the claim, and by its current incarnation.
  await su`update inbound set claimed_by = 'runner-a', claim_deadline = now() + interval '1 hour' where id = 'h1'`
  await registerIncarnation(store, { runner: "runner-a", incarnation: "one", machine: "pi", bootId: null })
  const attempt = await openExecution(store, { row: { id: "h1", agent: "p1-lair" }, conversation, runner: "runner-a", incarnation: "one", digest: "d", nativeSession: null })
  await markFeedIntent(store, attempt, "words of h1")
  await endAttempt(store, { execution: attempt.id, evidence: GONE, cause: "gone" })
  await Bun.sleep(20)
  const binding: McpBinding = { store, person: PERSON, agent: "p1-lair", conversation: conversation.id, kind: "master",
    registry: () => loadRegistry(it.registryFile), attempt: () => null }
  const count = async (table: string) => Number((await su.unsafe(`select count(*)::int as n from ${table}`))[0].n)
  return { it, su, store, human, conversation, attempt, binding, count }
}

const resume = (over: Record<string, unknown> = {}, decision: Record<string, unknown> = {}) => ({
  action: "resume", request_key: "key-1", source_message_ids: ["h2"],
  recovery_decision: { attempt_id: "", expected_recovery_revision: 1, choice: "continue", ...decision }, ...over,
})

async function code(run: Promise<unknown>): Promise<string> {
  try { await run; return "no error" } catch (error) { return error instanceof ToolError ? error.code : `not a ToolError: ${(error as Error).message}` }
}

test("a call names nothing but its arguments: an argument that would name whose it is, or a tool or action that is not there, is refused by name", async () => {
  const s = await staged()
  for (const extra of [{ person: "p2" }, { agent: "p2-lair" }, { conversation: "other" }, { route: "door/chat" }, { approved: true }]) {
    expect(await code(callTool(s.binding, "hub_topic", { action: "inspect", ...extra }))).toBe("invalid_arguments")
  }
  expect(await code(callTool(s.binding, "hub_topic", { action: "resume", ...{ recovery_decision: { attempt_id: "a", expected_recovery_revision: 1, choice: "continue", by: "p1" } }, request_key: "k", source_message_ids: ["h2"] }))).toBe("invalid_arguments")
  expect(await code(callTool(s.binding, "hub_council", { action: "start" }))).toBe("invalid_arguments")
  expect(await code(callTool(s.binding, "hub_council", { action: "start", request_key: "k", authority: { source_message_ids: ["h2"] }, question: "q", person: "p2" }))).toBe("invalid_arguments")
  expect(await code(callTool(s.binding, "not_a_tool", { action: "start" }))).toBe("unknown_tool")
  expect(await code(callTool(s.binding, "hub_topic", { action: "erase" }))).toBe("unsupported_action")
  expect(await code(callTool(s.binding, "hub_topic", { action: "resume", request_key: "k", source_message_ids: [], recovery_decision: { attempt_id: "a", expected_recovery_revision: 1, choice: "continue" } }))).toBe("invalid_arguments")
  expect(await code(callTool(s.binding, "hub_topic", { action: "resume", request_key: "k", source_message_ids: ["h2"], recovery_decision: { attempt_id: "a", expected_recovery_revision: 1, choice: "carry-on" } }))).toBe("invalid_arguments")
  // Nothing of the above wrote anything.
  expect([await s.count("tool_invocation"), await s.count("source_consumption")]).toEqual([0, 0])
})

test("inspect shows what is held, what is known about it, and the owner's messages a choice can cite", async () => {
  const s = await staged()
  await s.human("h2")
  const seen = await callTool(s.binding, "hub_topic", { action: "inspect" })
  expect(seen).toMatchObject({ status: "complete", stage: "held_work" })
  const holds = seen.holds as { attempt_id: string; recovery_revision: number; cause: string; state: string; original_input: string; known_effects: string }[]
  expect(holds).toEqual([expect.objectContaining({ attempt_id: s.attempt.id, recovery_revision: 1, cause: "interrupted", state: "held", original_input: "words of h1" })])
  expect(holds[0].known_effects).toContain("No tool action was observed")
  expect((seen.owner_messages_since as { id: string }[]).map(m => m.id)).toEqual(["h2"])
  // A conversation with nothing held says so and shows no messages.
  const other = await callTool({ ...s.binding, agent: "p1-nobody", conversation: "no-such-conversation" }, "hub_topic", { action: "inspect" })
  expect(other).toMatchObject({ stage: "nothing_held", holds: [] })
})

test("source evidence: only an owner message to this agent, from an allowed sender, newer than the interruption, and only for one request", async () => {
  const s = await staged()
  // Older than the interruption it would decide: written before it, so it cannot be the owner's answer to it.
  await s.su`insert into inbound (id, person, agent, body, kind, source, received_at) values ('early', ${PERSON}, 'p1-lair', 'too early', 'human',
    ${{ log_id: "early", at: new Date().toISOString(), door: DOOR, chat: CHAT, sender_id: PERSON, text: "too early" }}::jsonb, now() - interval '1 hour')`
  await s.human("h2")
  await s.human("from-a-stranger", { sender: "not-allowed" })
  await s.human("to-another-agent", { agent: "p1-other" })
  await s.human("about-another-person", { person: "p2" })
  await s.human("a-report", { kind: "report" })
  const decision = { attempt_id: s.attempt.id }
  for (const [id, why] of [["missing", "no such message"], ["early", "older than the interruption"], ["from-a-stranger", "an unlisted sender"],
    ["to-another-agent", "another agent's"], ["about-another-person", "another person's"], ["a-report", "not a person's message"]] as const) {
    expect(await code(callTool(s.binding, "hub_topic", resume({ source_message_ids: [id] }, decision))), why).toBe("source_invalid")
  }
  // A worker's conversation has no owner in it, so it cannot record the owner's choice at all.
  expect(await code(callTool({ ...s.binding, kind: "worker" }, "hub_topic", resume({}, decision)))).toBe("not_owner_conversation")
  // Another conversation's hold is not this one's to decide, even for a real conversation of the same owner.
  await s.human("x1", { agent: "p1-other" })
  const elsewhere = await conversationFor(s.store, { row: { id: "x1", person: PERSON, agent: "p1-other", kind: "human" }, adapter: "claude-code", machine: "pi" })
  expect(await callTool({ ...s.binding, agent: "p1-other", conversation: elsewhere.id }, "hub_topic", resume({}, decision)))
    .toMatchObject({ status: "failed", cause: "unknown_attempt" })
  // No refusal left a trace, so the same message is still good for the real request.
  expect([await s.count("tool_invocation"), await s.count("source_consumption")]).toEqual([0, 0])

  // A stale revision is a reply and not a spent message.
  expect(await callTool(s.binding, "hub_topic", resume({}, { ...decision, expected_recovery_revision: 4 }))).toMatchObject({ status: "failed", cause: "stale_revision" })
  expect([await s.count("tool_invocation"), await s.count("source_consumption")]).toEqual([0, 0])

  // NOTHING WAS MEASURED about the native context (no runner has looked), so the choice is recorded and the
  // reply says the continuation is waiting on verification: it is NOT "queued behind the current turn".
  const reply = await callTool(s.binding, "hub_topic", resume({}, decision))
  expect(reply).toMatchObject({ status: "accepted", stage: "waiting_native_context", object_id: s.attempt.id, revision: 1, next_event_id: "continue:h1:1",
    native_context: { state: "pending" } })
  expect(String(reply.status_message)).toContain("pending verification")
  expect(String(reply.status_message)).not.toContain("queued behind")
  // One message, one intent: it cannot decide a different request.
  expect(await code(callTool(s.binding, "hub_topic", resume({ request_key: "key-2" }, { ...decision, choice: "keep_held" })))).toBe("source_already_used")
})

test("what a held conversation is waiting for is the runner's measurement, said the same way by inspect and by the reply to a choice: unavailable names its cause, pending says so, and only a measured-usable context is called queued", async () => {
  const s = await staged()
  await s.human("h2")
  const context = async () => ((await callTool(s.binding, "hub_topic", { action: "inspect" })).holds as { native_context: { state: string; cause?: string; status_message: string } }[])[0].native_context
  // Never measured: pending verification, not ready.
  expect(await context()).toMatchObject({ state: "pending" })
  expect((await context()).status_message).toContain("pending verification")
  // Measured unavailable, for this attempt at this revision.
  const measure = async (value: Record<string, unknown> | null) => {
    await s.su`update replay_hold set native_context = ${value}::jsonb where execution_id = ${s.attempt.id}`
  }
  await measure({ state: "unavailable", cause: "safe-resume-unvalidated", engine: "claude-code:daily:9.9.9", at: new Date().toISOString() })
  expect(await context()).toMatchObject({ state: "unavailable", cause: "safe-resume-unvalidated" })
  expect((await context()).status_message).toContain("waiting for native context (safe-resume-unvalidated")
  // The choice is recorded, not refused, and says what it waits for. No executor was started by it.
  const waiting = await callTool(s.binding, "hub_topic", resume({}, { attempt_id: s.attempt.id }))
  expect(waiting).toMatchObject({ status: "accepted", stage: "waiting_native_context", cause: "safe-resume-unvalidated", native_context: { state: "unavailable" } })
  expect(String(waiting.status_message)).not.toContain("queued behind")
  expect((await s.su`select state, choice from replay_hold where inbound_id = 'h1'`)[0]).toMatchObject({ state: "continuing", choice: "continue" })
  expect((await s.su`select id from inbound where id like 'continue:%'`).length).toBe(1)
  // A malformed or foreign value is pending, never ready.
  await measure({ state: "ready-ish" })
  expect(await context()).toMatchObject({ state: "pending" })

  // Only a measured-usable context is called queued behind the current turn.
  const t = await staged()
  await t.human("h2")
  await t.su`update replay_hold set native_context = ${{ state: "ready", engine: "claude-code:daily:2.1.285", at: new Date().toISOString() }}::jsonb where execution_id = ${t.attempt.id}`
  expect(await callTool(t.binding, "hub_topic", resume({}, { attempt_id: t.attempt.id })))
    .toMatchObject({ status: "queued", stage: "continuation_queued", next_event_id: "continue:h1:1" })
})

test("a repeated call is one request: the same key and arguments meet the recorded answer, a changed argument under the key is a conflict", async () => {
  const s = await staged()
  await s.human("h2")
  const decision = { attempt_id: s.attempt.id, continuation_context: "keep the edits" }
  const first = await callTool(s.binding, "hub_topic", resume({}, decision))
  // The model restarted and asked again, with its arguments in another order.
  const again = await callTool(s.binding, "hub_topic", { recovery_decision: { continuation_context: "keep the edits", choice: "continue", expected_recovery_revision: 1, attempt_id: s.attempt.id },
    source_message_ids: ["h2"], request_key: "key-1", action: "resume" })
  expect(again).toEqual(first)
  expect(await s.count("tool_invocation")).toBe(1)
  expect((await s.su`select id from inbound where id like 'continue:%'`).length, "one continuation, not two").toBe(1)
  expect(await code(callTool(s.binding, "hub_topic", resume({}, { ...decision, choice: "keep_held" })))).toBe("idempotency_conflict")
  expect(await code(callTool(s.binding, "hub_topic", resume({ source_message_ids: ["h2", "h1"] }, decision)))).toBe("idempotency_conflict")
  // The owner's words made it into the continuation the model will be handed.
  const [queued] = await s.su`select body from inbound where id = 'continue:h1:1'`
  expect(queued.body).toContain("keep the edits")
  expect((await s.su`select chosen_by, state from replay_hold where inbound_id = 'h1'`)[0]).toMatchObject({ chosen_by: PERSON, state: "continuing" })
})

type Sink = { write(data: string): number; flush(): Promise<number> | number }

async function speak(child: ReturnType<typeof Bun.spawn>) {
  const reader = (child.stdout as unknown as ReadableStream<Uint8Array>).getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  const next = async (): Promise<any> => {
    for (;;) {
      const cut = buffer.indexOf("\n")
      if (cut >= 0) { const line = buffer.slice(0, cut); buffer = buffer.slice(cut + 1); return JSON.parse(line) }
      const { value, done } = await reader.read()
      if (done) throw new Error("the facade closed its output")
      buffer += decoder.decode(value, { stream: true })
    }
  }
  return {
    async call(message: Record<string, unknown>) {
      const sink = child.stdin as unknown as Sink
      sink.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n")
      await sink.flush()
      return await next()
    },
    async notify(message: Record<string, unknown>) {
      const sink = child.stdin as unknown as Sink
      sink.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n")
      await sink.flush()
    },
  }
}

test("over the socket: the engine's stdio server is bound to the launch, holds no database login, and answers only what the runner's binding lets it", async () => {
  const s = await staged()
  await s.human("h2")
  const facade = await bindFacade(s.binding)
  const server = join(import.meta.dir, "../src/mcp/server.ts")
  // The engine is given the socket and a token and nothing else of the hub's.
  expect(Object.keys(facade.server.env).sort()).toEqual(["HUB_MCP_SOCKET", "HUB_MCP_TOKEN"])
  expect(facade.server.args).toEqual([server])
  const child = Bun.spawn([process.execPath, server], { stdin: "pipe", stdout: "pipe", stderr: "pipe",
    env: { PATH: process.env.PATH ?? "", ...facade.server.env } })
  try {
    const talk = await speak(child)
    const started = await talk.call({ id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1" } } })
    expect(started.result.serverInfo.name).toBe("hub")
    await talk.notify({ method: "notifications/initialized" })
    const listed = await talk.call({ id: 2, method: "tools/list" })
    expect(listed.result.tools.map((tool: { name: string }) => tool.name)).toEqual(["hub_topic", "hub_council", "hub_outbound"])
    expect(listed.result.tools[1].inputSchema.additionalProperties).toBe(false)
    const schema = listed.result.tools[0].inputSchema
    expect(schema.additionalProperties).toBe(false)
    expect(Object.keys(schema.properties).sort()).toEqual(["action", "creation_decision", "destination_machine", "expected_revision", "move_decision",
      "recovery_decision", "request_key", "setup", "source_message_ids", "topic_id"])
    expect(schema.properties.action.enum).toEqual(["inspect", "resume", "create", "archive", "reopen", "move", "delete"])
    expect(schema.properties.move_decision.additionalProperties).toBe(false)
    expect(schema.properties.move_decision.properties.choice.enum).toEqual(["withdraw", "continue"])
    // The model is told the owner's own chat answers a waiting move through the door's commands, and that a move is not held back for want of a General.
    const described = String(listed.result.tools[0].description)
    expect(described).toContain("/move withdraw <move-id>")
    expect(described).toContain("/move seen")
    expect(described).not.toMatch(/only started when General/)

    const inspected = await talk.call({ id: 3, method: "tools/call", params: { name: "hub_topic", arguments: { action: "inspect" } } })
    expect(inspected.result.isError).toBeUndefined()
    const body = JSON.parse(inspected.result.content[0].text)
    expect(body.holds.map((h: { attempt_id: string }) => h.attempt_id)).toEqual([s.attempt.id])

    // A model that tries to say whose call it is gets a refusal, and the socket does not care what it claims.
    const forged = await talk.call({ id: 4, method: "tools/call", params: { name: "hub_topic", arguments: { action: "inspect", person: "p2" } } })
    expect(forged.result.isError).toBe(true)
    expect(JSON.parse(forged.result.content[0].text).code).toBe("invalid_arguments")
    const chosen = await talk.call({ id: 5, method: "tools/call", params: { name: "hub_topic", arguments: resume({}, { attempt_id: s.attempt.id }) } })
    expect(JSON.parse(chosen.result.content[0].text)).toMatchObject({ status: "accepted", stage: "waiting_native_context" })
    expect((await s.su`select id from inbound where id like 'continue:%'`).length).toBe(1)
  } finally { child.kill(); await facade.close() }

  // A process that finds the socket without the launch's token is refused.
  const rogue = await bindFacade(s.binding)
  try {
    const { createConnection } = await import("node:net")
    const said = await new Promise<string>((resolve, reject) => {
      const socket = createConnection(rogue.server.env.HUB_MCP_SOCKET)
      socket.setEncoding("utf8")
      socket.on("data", data => { resolve(String(data)); socket.destroy() })
      socket.on("error", reject)
      socket.on("connect", () => socket.write(JSON.stringify({ id: 1, token: "guessed", tool: "hub_topic", args: { action: "inspect" } }) + "\n"))
    })
    expect(JSON.parse(said)).toMatchObject({ ok: false, error: { code: "invalid_arguments" } })
  } finally { await rogue.close() }
}, 60_000)

// The reader of `move` is pure: what it accepts is exactly one of a named machine or a decision, with the owner's own words cited.
const asked = (over: Record<string, unknown> = {}) => ({ action: "move", request_key: "k", source_message_ids: ["m1"], ...over })
const readCode = (args: unknown): string => {
  try { readTopicRequest(args); return "read" } catch (error) { return error instanceof ToolError ? error.code : `not a ToolError: ${(error as Error).message}` }
}

test("move is read strictly: exactly one of a named machine or a decision, the evidence always, and the attempt fields only for continue", () => {
  expect(readTopicRequest(asked({ destination_machine: "mac" }))).toEqual({ action: "move", request_key: "k", source_message_ids: ["m1"], destination_machine: "mac" })
  expect(readTopicRequest(asked({ topic_id: "t1", expected_revision: 3, destination_machine: "mac" }))).toMatchObject({ topic_id: "t1", expected_revision: 3 })
  expect(readTopicRequest(asked({ move_decision: { choice: "withdraw" } }))).toMatchObject({ move_decision: { choice: "withdraw" } })
  expect(readTopicRequest(asked({ move_decision: { choice: "continue", attempt_id: "a1", expected_recovery_revision: 2 } })))
    .toMatchObject({ move_decision: { choice: "continue", attempt_id: "a1", expected_recovery_revision: 2 } })

  // Both or neither is refused, and no default machine is read in.
  expect(readCode(asked())).toBe("invalid_arguments")
  expect(readCode(asked({ destination_machine: "mac", move_decision: { choice: "withdraw" } }))).toBe("invalid_arguments")
  expect(readCode(asked({ destination_machine: "" }))).toBe("invalid_arguments")
  expect(readCode(asked({ destination_machine: "x".repeat(101) }))).toBe("invalid_arguments")
  expect(readCode(asked({ destination_machine: 7 }))).toBe("invalid_arguments")

  // The evidence is required, as it is for archive: a move is the owner's explicit request.
  expect(readCode({ action: "move", source_message_ids: ["m1"], destination_machine: "mac" })).toBe("invalid_arguments")
  expect(readCode({ action: "move", request_key: "k", destination_machine: "mac" })).toBe("invalid_arguments")
  expect(readCode(asked({ source_message_ids: [], destination_machine: "mac" }))).toBe("invalid_arguments")

  // A withdrawal takes no attempt fields; a continue needs both, and nothing else is a choice.
  expect(readCode(asked({ move_decision: { choice: "withdraw", attempt_id: "a1" } }))).toBe("invalid_arguments")
  expect(readCode(asked({ move_decision: { choice: "withdraw", expected_recovery_revision: 1 } }))).toBe("invalid_arguments")
  expect(readCode(asked({ move_decision: { choice: "continue" } }))).toBe("invalid_arguments")
  expect(readCode(asked({ move_decision: { choice: "continue", attempt_id: "a1" } }))).toBe("invalid_arguments")
  expect(readCode(asked({ move_decision: { choice: "continue", expected_recovery_revision: 1 } }))).toBe("invalid_arguments")
  expect(readCode(asked({ move_decision: { choice: "continue", attempt_id: "a1", expected_recovery_revision: 0 } }))).toBe("invalid_arguments")
  expect(readCode(asked({ move_decision: { choice: "continue", attempt_id: "", expected_recovery_revision: 1 } }))).toBe("invalid_arguments")
  expect(readCode(asked({ move_decision: { choice: "keep_held", attempt_id: "a1", expected_recovery_revision: 1 } }))).toBe("invalid_arguments")
  expect(readCode(asked({ move_decision: { choice: "continue", attempt_id: "a1", expected_recovery_revision: 1, by: "p1" } }))).toBe("invalid_arguments")
  expect(readCode(asked({ move_decision: "withdraw" }))).toBe("invalid_arguments")

  // The keys of a move are the move's own: no other action reads them, and a move reads none of the others'.
  expect(readCode({ action: "archive", request_key: "k", source_message_ids: ["m1"], destination_machine: "mac" })).toBe("invalid_arguments")
  expect(readCode({ action: "reopen", request_key: "k", source_message_ids: ["m1"], move_decision: { choice: "withdraw" } })).toBe("invalid_arguments")
  expect(readCode(asked({ destination_machine: "mac", recovery_decision: { attempt_id: "a", expected_recovery_revision: 1, choice: "continue" } }))).toBe("invalid_arguments")
  expect(readCode(asked({ destination_machine: "mac", setup: { chat_name: "x", initial_request: "y" } }))).toBe("invalid_arguments")
  expect(readCode(asked({ destination_machine: "mac", person: "p2" }))).toBe("invalid_arguments")
})

test("fresh_context is an explicit owner-evidenced MCP choice, idempotent and never a continuation", async () => {
  const s = await staged()
  try {
    await s.human("h2")
    const request = resume({}, { attempt_id: s.attempt.id, choice: "fresh_context" })
    const result = await callTool(s.binding, "hub_topic", request)
    expect(result).toMatchObject({ status: "accepted", stage: "fresh_context", revision: 2 })
    expect(await callTool(s.binding, "hub_topic", request)).toEqual(result)
    expect((await s.su`select native_session from conversation where id = ${s.conversation.id}`)[0].native_session).not.toBe(s.conversation.native_session)
    expect(await s.su`select id from inbound where id like 'continue:%'`).toHaveLength(0)
    expect((await s.su`select hub_row_held('h1') as held`)[0].held).toBe(true)
    const { parseHoldChoice } = await import("../src/door/recovery.ts")
    expect(parseHoldChoice(`/recover p1-lair ${s.attempt.id} 1 fresh-context`)).toMatchObject({ choice: "fresh_context", revision: 1 })
  } finally { await s.store.sql.close(); await s.su.close(); await s.it.stop() }
})
