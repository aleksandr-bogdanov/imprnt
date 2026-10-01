// The owner's move command (`hub_topic move`): asking for a move to a machine the owner named, seeing where it stands, withdrawing it, and
// the one decision the store has for an interruption it stopped on.
//
// Real store (the roles the processes use), the real tool handlers and the real registry loader over the topics stage. What is PLANTED, and
// decides nothing the code under test decides: the owner's messages, a runner's session on the store (the connection a runner holds), the
// attempts and holds a runner would have written, and, for one check, the stages of a move a runner and the hub would have taken it through
// (the store fixture's own steps). Nothing here moves a file or starts a process.

import { afterAll, afterEach, beforeAll, expect, test } from "bun:test"
import { startCluster, type Cluster } from "./helpers/cluster.ts"
import { closeStages, removeEffectDirs } from "./helpers/effects-fixture.ts"
import { DOOR, GENERAL, OWNER, PERSON, RUNNER_MAC, RUNNER_PI, STRANGER, stageTopics, type TopicsOptions, type TopicsStage } from "./helpers/topics-fixture.ts"
import { MACHINERY_LINES } from "../src/door/lines.ts"
import { DST, moveStage } from "./helpers/move-store-stage.ts"
import { bindTopics } from "../src/hub/topics.ts"
import { loadRegistry } from "../src/registry/load.ts"
import { ToolError } from "../src/mcp/contracts.ts"
import { callTool, type McpBinding } from "../src/mcp/handlers.ts"
import { activateProtocol } from "../src/store/conversations.ts"
import { blockMove, readMove, unblockMove } from "../src/store/moves.ts"
import { readTopic, rebindLegacyTopic, type TopicRow } from "../src/store/topics.ts"

let cluster: Cluster
const mine: { close(): Promise<void> }[] = []
const track = <T extends { close(): Promise<void> }>(sql: T): T => { mine.push(sql); return sql }
beforeAll(async () => { cluster = await startCluster() })
afterEach(async () => {
  await closeStages()
  for (const one of mine.splice(0)) await one.close().catch(() => {})
})
afterAll(async () => {
  removeEffectDirs()
  await cluster?.stop()
})

const REQUEST = "Compare the two vendors, and keep it short."
const code = async (run: Promise<unknown>): Promise<string> => {
  try { await run; return "no error" } catch (error) { return error instanceof ToolError ? error.code : `not a ToolError: ${(error as Error).message}` }
}
const count = async (s: TopicsStage, table: string, where = "true") =>
  Number((await s.admin.unsafe(`select count(*)::int as n from ${table} where ${where}`))[0].n)
const topicOf = async (s: TopicsStage, id: string): Promise<TopicRow> => (await readTopic(s.as("hub_hub"), id))!
const rows = (result: unknown) => Array.from(result as Record<string, unknown>[]).map(row => ({ ...row }))

/** A topic taken all the way: asked for, confirmed by the owner's check, made, bound and announced. */
async function bound(s: TopicsStage): Promise<TopicRow> {
  const master = await s.binding()
  const reply = await s.ask(master, { action: "create", setup: { chat_name: "coffee", initial_request: REQUEST } })
  await s.deliver()
  await s.react(String(reply.operation_id))
  await s.topicPass()
  await bindTopics({ store: s.as("hub_hub"), registryFile: s.registryFile, machine: "pi", load: () => loadRegistry(s.registryFile, { machine: "pi" }) })
  await s.topicPass()
  await s.deliver()
  return await topicOf(s, String(reply.object_id))
}

/** A process has a session on the store: the connection it holds, under its role and named as it names itself. It is what "not offline" means to the tool. */
async function hold(s: TopicsStage, role: "hub_runner" | "hub_door", name: string) {
  const held = s.fresh(role)
  await held.sql.unsafe("select set_config('application_name', $1, false)", [name])
  return held
}
/** A runner is connected: the session it holds, under its own id. */
const online = (s: TopicsStage, runner: string) => hold(s, "hub_runner", runner)
/** A door is connected: the session it opens under its own id and role (`door/run.ts`). The registry declaring a door says nothing about this. */
const doorOnline = (s: TopicsStage, door: string) => hold(s, "hub_door", door)

interface Over {
  stage?: TopicsOptions
  protocol?: boolean
  source?: boolean
  generalLive?: boolean
  /** The door every chat here is behind has a session on the store (default); any other door is connected only by the check that uses it. */
  doorLive?: boolean
  /** Another ordinary chat of the same person, which exists on the server. */
  other?: boolean
}

/**
 * A topic master on the source machine, a General, and the store at protocol 4 with both runners registered (as `move-store-stage.ts` does). General's runner
 * and the door both chats are behind are connected, each as a session of its own; a check that puts General behind another door connects that one itself.
 */
async function staged(over: Over = {}) {
  const s = await stageTopics(cluster, over.stage)
  // The door watches every ordinary master it finds, and a chat that is not there is a chat that is gone: so the other chat is a real channel.
  if (over.other) {
    const chat = s.fake.addChannel({ name: "other" })
    s.rewrite({ ...over.stage, agents: [{ id: "p1-other", person: PERSON, preset: "daily", chat, door: DOOR, runner: RUNNER_PI }] })
  }
  const topic = await bound(s)
  const fix = await moveStage(cluster, track, { database: s.db })
  if (over.protocol !== false) {
    if (over.source === false) {
      // The source never registered: what ran there before the request is unknown.
      await activateProtocol(fix.tool)
      await fix.register(DST, "dst-1")
    } else {
      await fix.fleet()
    }
  }
  const general = await s.binding()
  const own = await s.binding(topic.agent_id)
  if (over.generalLive !== false) await online(s, RUNNER_PI)
  if (over.doorLive !== false) await doorOnline(s, DOOR)
  return { s, fix, topic, general, own }
}
type Stage = Awaited<ReturnType<typeof staged>>

let counter = 0
/** One call of the hub tool as `binding`, citing a message the owner just said to that agent (or the one given), under a key (or the one given). */
async function call(s: TopicsStage, binding: McpBinding, args: Record<string, unknown>, over: { key?: string; said?: string } = {}) {
  const said = over.said ?? await s.said(`asked ${++counter}`, { agent: binding.agent })
  return await callTool(binding, "hub_topic", { request_key: over.key ?? `key-${++counter}`, source_message_ids: [said], ...args }) as Record<string, unknown>
}
const moveOf = (t: Stage, args: Record<string, unknown> = {}) => ({ action: "move", topic_id: t.topic.id, ...args })
const inspectOf = async (t: Stage) => await callTool(t.general, "hub_topic", { action: "inspect", topic_id: t.topic.id }) as Record<string, unknown>
const moves = (s: TopicsStage) => s.admin`select id, operation_id, topic_id, agent, person, requested_by, route, evidence, stage, block, failure, source_runner, source_machine,
  dest_runner, dest_machine, acknowledged_failures from topic_move order by created_at`
const moveCalls = (s: TopicsStage) => count(s, "tool_invocation", "action = 'move'")
const openGates = async (s: TopicsStage, agent: string) =>
  rows(await s.admin`select operation_id from claim_gate where scope_kind = 'agent' and scope_id = ${agent} and state = 'open' order by operation_id`).map(row => row.operation_id)

/** An attempt of the topic's master as a runner would have left it, and, for an interrupted one, the hold the runner would have written. */
async function plant(s: TopicsStage, topic: TopicRow, id: string, state: string) {
  await s.admin`insert into inbound (id, person, agent, body, kind) values (${`in-${id}`}, ${PERSON}, ${topic.agent_id}, 'working on it', 'human')`
  await s.admin`insert into execution (id, inbound_id, conversation_id, agent, runner, incarnation, placement_generation, state, input_digest)
    values (${id}, ${`in-${id}`}, ${topic.conversation_id}, ${topic.agent_id}, ${RUNNER_PI}, 'inc-1', 1, ${state}, 'd')`
  if (state === "interrupted") {
    await s.admin`insert into replay_hold (inbound_id, execution_id, conversation_id, cause) values (${`in-${id}`}, ${id}, ${topic.conversation_id}, 'interrupted')`
  }
}
const settle = (s: TopicsStage, id: string) => s.admin`update execution set state = 'stopped', ended_at = now() where id = ${id}`

/** Nothing of a refused request is left: no invocation of the move action, no move, and no gate of a move. */
async function nothingLeft(s: TopicsStage) {
  expect(await moveCalls(s), "a refusal records no invocation").toBe(0)
  expect(await count(s, "topic_move"), "a refusal makes no move").toBe(0)
  expect(await count(s, "claim_gate", "cause = 'move'"), "a refusal leaves no gate").toBe(0)
}

test("asked in the topic's own chat with a machine the owner named, a move is made at once: its row, its gate and its evidence are the owner's, and the same key is the same answer", async () => {
  const t = await staged()
  const said = await t.s.said("move this chat to the mac", { agent: t.own.agent })
  const reply = await call(t.s, t.own, { action: "move", destination_machine: "mac" }, { key: "move-1", said })
  expect(reply).toMatchObject({ status: "accepted", stage: "move_requested", object_id: t.topic.id, revision: t.topic.lifecycle_generation })
  expect(reply.move).toMatchObject({ from: "pi", to: "mac", family: null, withdrawable: true, turn_finishing: false, actions: ["withdraw"] })
  expect(String(reply.status_message)).toContain("the turn already being answered finishes")

  const [row] = rows(await moves(t.s))
  expect(row).toMatchObject({ topic_id: t.topic.id, agent: t.topic.agent_id, person: PERSON, requested_by: OWNER, stage: "waiting",
    source_runner: RUNNER_PI, source_machine: "pi", dest_runner: RUNNER_MAC, dest_machine: "mac", block: null })
  // Where it was asked is the caller's own door and chat; what it was asked with is the owner's message and the call's key, in the caller's conversation.
  expect(row.route).toEqual({ door: DOOR, chat: t.topic.chat })
  expect(row.evidence).toEqual({ request_key: "move-1", messages: [said], conversation: t.own.conversation })
  // The gate is the move's own and it is open: the agent takes no new work on the source.
  expect(await openGates(t.s, t.topic.agent_id)).toEqual([`move:${row.id}`])

  // The same key is the same request: its own answer, and no second move.
  expect(await call(t.s, t.own, { action: "move", destination_machine: "mac" }, { key: "move-1", said })).toEqual(reply)
  expect(await count(t.s, "topic_move")).toBe(1)
  // A changed argument under the same key is a conflict, and a message that already authorized a request cannot authorize another.
  expect(await code(call(t.s, t.own, { action: "move", destination_machine: "pi" }, { key: "move-1", said }))).toBe("idempotency_conflict")
  expect(await code(call(t.s, t.own, { action: "move", destination_machine: "mac" }, { key: "move-2", said }))).toBe("source_already_used")
  expect(await count(t.s, "topic_move")).toBe(1)
  // Nothing a model writes names the identity: the reply and the row carry no person, agent or route it supplied.
  expect(await code(callTool(t.own, "hub_topic", { action: "move", request_key: "k", source_message_ids: [said], destination_machine: "mac", agent: "p9-x" }))).toBe("invalid_arguments")
})

test("a move without a named destination is refused even when a default machine is configured, and a machine that cannot be used is refused by name with nothing left behind", async () => {
  const t = await staged()
  // `topic_machine` is set for this person, and a move never reads it.
  expect(t.s.load().people.find(one => one.id === PERSON)?.topic_machine).toBe("pi")
  expect(await code(call(t.s, t.general, moveOf(t)))).toBe("invalid_arguments")
  expect(await code(call(t.s, t.own, { action: "move" }))).toBe("invalid_arguments")
  await nothingLeft(t.s)

  expect(await call(t.s, t.general, moveOf(t, { destination_machine: "venus" }))).toMatchObject({ status: "failed", cause: "execution_machine_unknown" })
  // The machine it is on already: nothing to move, and it is said so.
  expect(await call(t.s, t.general, moveOf(t, { destination_machine: "pi" }))).toMatchObject({ status: "failed", cause: "already_there" })
  // A revision the caller did not look at.
  expect(await call(t.s, t.general, moveOf(t, { destination_machine: "mac", expected_revision: t.topic.lifecycle_generation + 5 }))).toMatchObject({ status: "failed", cause: "stale_revision" })
  expect(await call(t.s, t.general, { action: "move", topic_id: "no-such-topic", destination_machine: "mac" })).toMatchObject({ status: "failed", cause: "unknown_topic" })
  await nothingLeft(t.s)
  // A refusal spends neither the owner's message nor the key.
  const said = await t.s.said("to the mac, then")
  expect(await call(t.s, t.general, moveOf(t, { destination_machine: "venus" }), { key: "again", said })).toMatchObject({ cause: "execution_machine_unknown" })
  expect(await count(t.s, "source_consumption", `source_id = '${said}'`)).toBe(0)
  expect(await call(t.s, t.general, moveOf(t, { destination_machine: "mac" }), { key: "again", said })).toMatchObject({ status: "accepted" })
})

// One staged topic per test: each stage is closed after its test, so none of them holds connections while the next is built.
test("a destination with no running runner is refused by name", async () => {
  const stopped = await staged({ stage: { runner: { [RUNNER_MAC]: { enabled: false } } } })
  expect(await call(stopped.s, stopped.general, moveOf(stopped, { destination_machine: "mac" }))).toMatchObject({ status: "failed", cause: "execution_machine_has_no_runner" })
  await nothingLeft(stopped.s)
})

test("a store that is not at protocol 4 refuses a move by name", async () => {
  const inactive = await staged({ protocol: false })
  expect(await call(inactive.s, inactive.general, moveOf(inactive, { destination_machine: "mac" }))).toMatchObject({ status: "failed", cause: "move_unavailable" })
  await nothingLeft(inactive.s)
})

test("a chat that is not active refuses a move by name", async () => {
  const archiving = await staged()
  expect(await call(archiving.s, archiving.general, { action: "archive", topic_id: archiving.topic.id })).toMatchObject({ status: "stopping" })
  const refused = await call(archiving.s, archiving.general, moveOf(archiving, { destination_machine: "mac" }))
  expect(refused).toMatchObject({ status: "failed", cause: "not_active" })
  expect(String(refused.status_message)).toContain("archiving")
  expect(await count(archiving.s, "topic_move")).toBe(0)
  expect(await count(archiving.s, "claim_gate", "cause = 'move'")).toBe(0)
})

test("an offline destination is accepted and waited for, and General's inspect says it is waiting for that machine and not for the one the chat is on", async () => {
  const t = await staged()
  const reply = await call(t.s, t.own, { action: "move", destination_machine: "mac" })
  expect(reply).toMatchObject({ status: "accepted", stage: "move_requested" })

  const waiting = await inspectOf(t)
  expect(waiting).toMatchObject({ status: "queued", stage: "waiting_for_machine", object_id: t.topic.id })
  expect(String(waiting.status_message)).toContain("Waiting for mac:")
  expect(String(waiting.status_message)).not.toContain("Waiting for pi")
  expect(String(waiting.status_message)).toContain("nothing moves to another machine")
  expect(waiting.topic).toMatchObject({ execution_machine: "pi", moving_to: "mac" })
  expect(waiting.move).toMatchObject({ from: "pi", to: "mac", actions: ["withdraw"] })
  expect(waiting.owner_status).toBe(waiting.status_message)
  // No id of the move, the agent or the operation is in what the owner reads.
  const [row] = rows(await moves(t.s))
  for (const id of [String(row.id), String(row.operation_id), t.topic.agent_id, t.topic.id]) expect(String(waiting.owner_status)).not.toContain(id)
  expect(String(waiting.owner_status)).toContain(`<#${t.topic.chat}>`)
  // Nothing was queued as a later try, and the chat was not moved anywhere else.
  expect(await count(t.s, "topic_move")).toBe(1)
  expect((await topicOf(t.s, t.topic.id)).machine).toBe("pi")

  // The destination connects: it is the same move, now waiting for that machine to take the chat over.
  await online(t.s, RUNNER_MAC)
  const connected = await inspectOf(t)
  expect(connected).toMatchObject({ status: "queued", stage: "waiting_for_destination" })
  expect(String(connected.status_message)).toContain("Waiting for mac to take")
  expect(String(connected.status_message)).not.toContain("Bring")
})

test("what the owner reads is in their language, and a move whose source was never known shows that straight away, with a withdrawal as the only next step", async () => {
  const t = await staged({ stage: { person: { language: "ru" } }, source: false })
  const said = await t.s.said("move this chat to the mac", { agent: t.own.agent })
  const reply = await call(t.s, t.own, { action: "move", destination_machine: "mac" }, { key: "move-blocked", said })
  // The standing the owner is told is the move's own, not an acceptance that reads as going well: the request is still recorded.
  expect(reply).toMatchObject({ status: "waiting_owner", stage: "blocked", cause: "owner_unknown", recorded: true })
  expect(reply.move).toMatchObject({ family: "owner_unknown", withdrawable: true, actions: ["withdraw"] })
  expect(await inspectOf(t)).toMatchObject({ status: reply.status, stage: reply.stage, cause: reply.cause })
  // A blocked move is a real recorded move and not a rolled-back refusal: the move, its gate, the call and the message it spent all stand.
  expect(await count(t.s, "topic_move")).toBe(1)
  expect(await openGates(t.s, t.topic.agent_id)).toHaveLength(1)
  expect(await moveCalls(t.s)).toBe(1)
  expect(await count(t.s, "source_consumption", `source_id = '${said}'`)).toBe(1)
  // The same key is the recorded answer, and the message is not spent twice.
  expect(await call(t.s, t.own, { action: "move", destination_machine: "mac" }, { key: "move-blocked", said })).toEqual(reply)
  expect(await code(call(t.s, t.own, { action: "move", destination_machine: "mac" }, { key: "move-other", said }))).toBe("source_already_used")
  // Asking again for the same machine with new words is the request already being true, and does not hide that it stands blocked.
  const again = await call(t.s, t.own, { action: "move", destination_machine: "mac" })
  expect(again).toMatchObject({ status: "waiting_owner", stage: "blocked", cause: "owner_unknown", recorded: true })
  expect(again.move).toMatchObject({ family: "owner_unknown", actions: ["withdraw"] })
  expect(String(again.status_message)).toContain("already open")
  expect(await count(t.s, "topic_move")).toBe(1)
  expect(await openGates(t.s, t.topic.agent_id)).toHaveLength(1)
  // The model is told in English, the owner in Russian, and neither carries an id.
  expect(String(reply.status_message)).toContain("The only way forward is to withdraw the move")
  expect(String(reply.owner_status)).toContain("Единственный путь — отозвать перенос")
  expect(String(reply.owner_status)).not.toContain(t.topic.agent_id)
  const [row] = rows(await moves(t.s))
  expect(row.block).toMatchObject({ code: "drain_owner_unknown", by: "store" })
  expect(await inspectOf(t)).toMatchObject({ status: "waiting_owner", stage: "blocked", cause: "owner_unknown" })
  // Withdrawing is the way out, and it is available.
  expect(await call(t.s, t.general, moveOf(t, { move_decision: { choice: "withdraw" } }))).toMatchObject({ status: "complete", stage: "withdrawn" })
  expect(await openGates(t.s, t.topic.agent_id)).toEqual([])
})

test("only the topic's own chat or General may ask, and a worker may not", async () => {
  const t = await staged({ other: true })
  const other = await t.s.binding("p1-other")
  const worker: McpBinding = { ...t.general, kind: "worker" }
  expect(await call(t.s, other, moveOf(t, { destination_machine: "mac" }))).toMatchObject({ status: "failed", cause: "not_permitted" })
  expect(await code(call(t.s, worker, moveOf(t, { destination_machine: "mac" })))).toBe("not_owner_conversation")
  await nothingLeft(t.s)
  // The same request from the topic's own chat is made, and nothing about another chat was needed.
  expect(await call(t.s, t.own, { action: "move", destination_machine: "mac" })).toMatchObject({ status: "accepted", stage: "move_requested" })
})

test("General moves itself: asked in its own chat, the move is made, its gate is placed, and the owner is told the door's commands", async () => {
  const t = await staged()
  const reply = await call(t.s, t.general, { action: "move", destination_machine: "mac" })
  expect(reply).toMatchObject({ status: "accepted", stage: "move_requested" })
  const [row] = rows(await moves(t.s))
  expect(row).toMatchObject({ agent: GENERAL, stage: "waiting", dest_machine: "mac", requested_by: OWNER })
  expect(await openGates(t.s, GENERAL)).toEqual([`move:${row.id}`])
  // Said in General's own chat about General itself, "this chat" is General's: the line is the door's to answer, with no other chat to point at.
  expect(String(reply.owner_status)).toContain("/move")
  expect(String(reply.owner_status)).not.toMatch(/General \(|in General/)
  expect(reply.move).toMatchObject({ from: "pi", to: "mac", actions: ["withdraw"] })
  // It is withdrawn through the very same store routine as any other chat's.
  const generalTopic = (await t.s.admin`select id from topic where agent_id = ${GENERAL}`)[0].id as string
  expect(await call(t.s, t.general, { action: "move", topic_id: generalTopic, move_decision: { choice: "withdraw" } })).toMatchObject({ status: "complete", stage: "withdrawn" })
  expect(await openGates(t.s, GENERAL)).toEqual([])
})

// Each cause is a test of its own. Every staged topic holds a database, a handful of sessions and a stage of the hub, and they are all closed after
// the test (`afterEach`); one test that staged all of them would hold them open together and exhaust the server's connection slots, which is a fixture
// that does not clean up and not a limit to raise.
const OWNER_B = "200000000000000001"
type GeneralCase = { name: string; arrange: (t: Stage) => Promise<void>; over?: Over }
const GENERAL_CASES: GeneralCase[] = [
  // The registry names no General at all.
  { name: "no General", arrange: async t => { t.s.rewrite({ person: { general: undefined }, withoutGeneralAgent: true }) } },
  // General's runner has no session on the store.
  { name: "General's runner offline", over: { generalLive: false }, arrange: async () => {} },
  // The door the chats are behind has no session on the store.
  { name: "door offline", over: { doorLive: false }, arrange: async () => {} },
  // General is configured asleep.
  { name: "General asleep", arrange: async t => { t.s.rewrite({ agents: [agentOf(t.topic), { ...generalAgent(DOOR, t.s.general), sleeping: true }], withoutGeneralAgent: true }) } },
  // General is behind another door, which the registry keeps stopped, and the owner has no sender there.
  { name: "General's door off and the owner not on it", arrange: async t => {
    t.s.rewrite({ person: { allowed_senders: { [DOOR]: [OWNER] } }, moreDoors: ["door-b"], moreDoor: { "door-b": { enabled: false } }, withoutGeneralAgent: true,
      agents: [agentOf(t.topic), generalAgent("door-b", t.s.general)] })
    await generalAdoptedBehind(t.s, "door-b")
  } },
  // General is behind another door that has no session at all, and the owner's id there is another one.
  { name: "General's door offline", arrange: async t => {
    t.s.rewrite({ person: { allowed_senders: { [DOOR]: [OWNER], "door-b": [OWNER_B] } }, moreDoors: ["door-b"], withoutGeneralAgent: true,
      agents: [agentOf(t.topic), generalAgent("door-b", t.s.general)] })
    await generalAdoptedBehind(t.s, "door-b")
  } },
  // General's own agent is gated by a move of its own.
  { name: "General itself moving", arrange: async t => {
    expect(await call(t.s, t.general, { action: "move", destination_machine: "mac" })).toMatchObject({ status: "accepted" })
  } },
  // General's chat is archived.
  { name: "General archived", arrange: async t => {
    expect(await call(t.s, t.general, { action: "archive", topic_id: GENERAL })).toMatchObject({ status: "stopping" })
    await t.s.admin`update topic set lifecycle = 'archived' where agent_id = ${GENERAL}`
  } },
]
for (const one of GENERAL_CASES) {
  test(`with ${one.name}, the topic's own chat's move is accepted, places the gate, and says the door's commands, as no cause that used to refuse it for want of a usable General does`, async () => {
    const t = await staged(one.over ?? {})
    await one.arrange(t)
    const before = await count(t.s, "claim_gate", "cause = 'move'")
    const reply = await call(t.s, t.own, { action: "move", destination_machine: "mac" })
    expect(reply).toMatchObject({ status: "accepted", stage: "move_requested" })
    expect(reply.cause).toBeUndefined()
    expect(await openGates(t.s, t.topic.agent_id)).toHaveLength(1)
    expect(await count(t.s, "claim_gate", "cause = 'move'")).toBe(before + 1)
    // The owner reads where it can be followed and withdrawn: this chat, by the door's commands (the withdrawal names the move), and never another chat that may be unusable.
    // "General itself moving" has already made a move of General's own, so the topic's move is the one that names this topic and its agent, not the first row.
    const made = rows(await moves(t.s)).find(row => row.topic_id === t.topic.id && row.agent === t.topic.agent_id)
    expect(made, "the topic's own move was made").toMatchObject({ topic_id: t.topic.id, agent: t.topic.agent_id, stage: "waiting", dest_machine: "mac" })
    expect(String(reply.owner_status)).toContain(`/move withdraw ${made?.id}`)
    expect(String(reply.owner_status)).not.toContain("General")
  })
}

test("the same request from General about another topic has a neutral line: it does not say \"this chat\" and offers no command to send here", async () => {
  const t = await staged()
  const neutral = await call(t.s, t.general, moveOf(t, { destination_machine: "mac" }))
  expect(neutral).toMatchObject({ status: "accepted", stage: "move_requested" })
  expect(String(neutral.owner_status)).toContain(`<#${t.topic.chat}>`)
  expect(String(neutral.owner_status)).not.toContain("this chat")
  expect(String(neutral.owner_status)).not.toMatch(/\/move/)
})

test("the same destination again is the request already being true, another destination is refused and never re-targets, and an open move is told apart from anything else going on", async () => {
  const t = await staged()
  const first = await call(t.s, t.general, moveOf(t, { destination_machine: "mac" }))
  expect(first).toMatchObject({ status: "accepted", stage: "move_requested" })
  const again = await call(t.s, t.own, { action: "move", destination_machine: "mac" })
  expect(again).toMatchObject({ status: "accepted", stage: "already_moving", object_id: t.topic.id })
  expect(String(again.status_message)).toContain("already open")
  expect(await count(t.s, "topic_move")).toBe(1)
  expect(await count(t.s, "claim_gate", "cause = 'move' and state = 'open'")).toBe(1)

  const elsewhere = await call(t.s, t.general, moveOf(t, { destination_machine: "pi" }))
  expect(elsewhere).toMatchObject({ status: "failed", cause: "move_in_progress" })
  expect(String(elsewhere.status_message)).toContain("never re-targeted")
  expect(String(elsewhere.status_message)).toContain("Withdraw that move first")
  expect(String(elsewhere.owner_status)).toContain("a move is never changed on its own")
  const [row] = rows(await moves(t.s))
  expect(row).toMatchObject({ dest_machine: "mac", stage: "waiting" })
  expect(await count(t.s, "topic_move")).toBe(1)

  // While a turn is finishing the move cannot be withdrawn, and the refusal does not suggest it.
  await plant(t.s, t.topic, "turn-1", "running")
  const blocked = await call(t.s, t.general, moveOf(t, { destination_machine: "pi" }))
  expect(blocked).toMatchObject({ status: "failed", cause: "move_in_progress" })
  expect(String(blocked.status_message)).toContain("cannot be withdrawn right now")
  expect(String(blocked.status_message)).not.toContain("Withdraw that move first")
  expect(String(blocked.owner_status)).not.toContain("You can withdraw")
})

test("withdrawn from General while idle: the move ends, only its own gate is released, the chat it was asked in is told once, and what the owner already decided is untouched", async () => {
  const t = await staged()
  await call(t.s, t.own, { action: "move", destination_machine: "mac" })
  const [made] = rows(await moves(t.s))
  const reply = await call(t.s, t.general, moveOf(t, { move_decision: { choice: "withdraw" } }))
  expect(reply).toMatchObject({ status: "complete", stage: "withdrawn", object_id: t.topic.id })
  expect(String(reply.status_message)).toContain("still held until the owner decides about it with resume")
  expect(String(reply.owner_status)).toContain("was withdrawn")
  expect(String(reply.owner_status)).not.toContain(String(made.id))

  const [after] = rows(await moves(t.s))
  expect(after).toMatchObject({ stage: "withdrawn", block: null })
  expect(await openGates(t.s, t.topic.agent_id)).toEqual([])
  expect(rows(await t.s.admin`select state from claim_gate where operation_id = ${`move:${made.id}`}`)).toMatchObject([{ state: "released" }])
  // One notice, to the chat the move was asked in (not the chat the owner withdrew in), by the shared mechanism and under the move's own key.
  const notices = rows(await t.s.admin`select agent, body, route, notice_key from outbox where notice_key = ${`topic-move:${made.id}:withdrawn`}`)
  expect(notices).toHaveLength(1)
  expect(notices[0]).toMatchObject({ agent: t.topic.agent_id, route: { door: DOOR, chat: t.topic.chat } })
  expect(String(notices[0].body).startsWith("[door] ")).toBe(true)
  expect(String(notices[0].body)).toContain(`<#${t.topic.chat}>`)
  expect(String(notices[0].body)).toContain("was withdrawn")
  expect(String(notices[0].body)).not.toContain(String(made.id))
  // The chat is where it was: on the source, active, with no copy of anything moved.
  expect(await topicOf(t.s, t.topic.id)).toMatchObject({ machine: "pi", runner: RUNNER_PI, lifecycle: "active" })

  // Asked again, nothing is open: it is said so, and the message is not spent.
  const said = await t.s.said("withdraw it")
  expect(await call(t.s, t.general, moveOf(t, { move_decision: { choice: "withdraw" } }), { said })).toMatchObject({ status: "failed", cause: "no_open_move" })
  expect(await count(t.s, "source_consumption", `source_id = '${said}'`)).toBe(0)

  // A move asked for in General and withdrawn in General has no chat to tell but the one the owner is in: no second notice.
  await call(t.s, t.general, moveOf(t, { destination_machine: "mac" }))
  const [, second] = rows(await moves(t.s))
  expect(await call(t.s, t.general, moveOf(t, { move_decision: { choice: "withdraw" } }))).toMatchObject({ status: "complete" })
  expect(await count(t.s, "outbox", `notice_key = 'topic-move:${second.id}:withdrawn'`)).toBe(0)
  expect(await count(t.s, "topic_move", "stage = 'withdrawn'")).toBe(2)
})

test("while a turn is still finishing a withdrawal is refused and records nothing, the request itself is accepted, and asking again once the turn ended works with the same words", async () => {
  const t = await staged()
  await plant(t.s, t.topic, "turn-1", "running")
  const asked = await call(t.s, t.general, moveOf(t, { destination_machine: "mac" }))
  // The turn already fed finishes: the move is accepted and says so.
  expect(asked).toMatchObject({ status: "accepted", stage: "move_requested" })
  expect(asked.move).toMatchObject({ turn_finishing: true, actions: [] })
  expect(String(asked.owner_status)).toContain("still finishing")
  expect(String(asked.owner_status)).not.toContain("You can withdraw")
  expect(await inspectOf(t)).toMatchObject({ status: "queued", stage: "turn_finishing" })

  const calls = await moveCalls(t.s)
  const said = await t.s.said("never mind")
  const refused = await call(t.s, t.general, moveOf(t, { move_decision: { choice: "withdraw" } }), { said })
  expect(refused).toMatchObject({ status: "failed", cause: "turn_still_finishing" })
  expect(String(refused.status_message)).toContain("ask again once that turn has ended")
  expect(String(refused.owner_status)).toContain("nothing is retried")
  // Nothing was recorded: the move and its gate stand, the call left no invocation and the owner's message is not spent.
  expect(await moveCalls(t.s)).toBe(calls)
  expect(await count(t.s, "source_consumption", `source_id = '${said}'`)).toBe(0)
  expect(rows(await moves(t.s))).toMatchObject([{ stage: "waiting" }])
  expect(await openGates(t.s, t.topic.agent_id)).toHaveLength(1)
  expect(await count(t.s, "outbox", "notice_key like 'topic-move:%'")).toBe(0)

  await settle(t.s, "turn-1")
  expect(await call(t.s, t.general, moveOf(t, { move_decision: { choice: "withdraw" } }), { said })).toMatchObject({ status: "complete", stage: "withdrawn" })
  expect(await openGates(t.s, t.topic.agent_id)).toEqual([])
})

test("source evidence: an owner message older than the move cannot withdraw it, one that withdrew cannot be used again, and another agent's message is not the owner's to this one", async () => {
  const t = await staged()
  const before = await t.s.said("sure, let's move it", { agent: GENERAL })
  expect(await call(t.s, t.general, moveOf(t, { destination_machine: "mac" }), { said: before })).toMatchObject({ status: "accepted" })
  // The words that asked for the move are not the words that withdraw it, and the refusal leaves the move as it was.
  expect(await code(call(t.s, t.general, moveOf(t, { move_decision: { choice: "withdraw" } }), { said: before }))).toBe("source_invalid")
  const unrelated = await t.s.said("hello", { agent: t.own.agent })
  expect(await code(call(t.s, t.general, moveOf(t, { move_decision: { choice: "withdraw" } }), { said: unrelated }))).toBe("source_invalid")
  expect(rows(await moves(t.s))).toMatchObject([{ stage: "waiting" }])
  // A stranger's message is not the owner's.
  const stranger = await t.s.said("withdraw it", { sender: "100000000000000777" })
  expect(await code(call(t.s, t.general, moveOf(t, { move_decision: { choice: "withdraw" } }), { said: stranger }))).toBe("source_invalid")
  expect(rows(await moves(t.s))).toMatchObject([{ stage: "waiting" }])

  const after = await t.s.said("on second thought, no")
  expect(await call(t.s, t.general, moveOf(t, { move_decision: { choice: "withdraw" } }), { said: after })).toMatchObject({ status: "complete" })
  // Spent: it cannot authorize a different request.
  expect(await code(call(t.s, t.general, moveOf(t, { destination_machine: "mac" }), { said: after }))).toBe("source_already_used")
  expect(rows(await moves(t.s))).toMatchObject([{ stage: "withdrawn" }])
  expect(await openGates(t.s, t.topic.agent_id)).toEqual([])
})

test("continue only records that the owner saw the interruption: it is bound to that failure and revision, needs the owner's later words, releases nothing, authorizes nothing and replays nothing", async () => {
  const t = await staged()
  await call(t.s, t.own, { action: "move", destination_machine: "mac" })
  const early = await t.s.said("keep going with it")
  // The turn is interrupted while the move waits: the store notes a failure that needs the owner, and the gate stays.
  await plant(t.s, t.topic, "late-exec", "interrupted")
  const [stopped] = rows(await moves(t.s))
  expect(stopped).toMatchObject({ stage: "awaiting_owner", failure: { execution: "late-exec", revision: 1 } })
  const standing = await inspectOf(t)
  expect(standing).toMatchObject({ status: "waiting_owner", stage: "awaiting_owner" })
  expect(standing.move).toMatchObject({ failure: { attempt_id: "late-exec", recovery_revision: 1 }, actions: ["continue", "withdraw"] })
  expect(String(standing.owner_status)).toContain("does not continue the interrupted work")
  expect(String(standing.owner_status)).not.toContain("late-exec")
  const hold = async () => rows(await t.s.admin`select state, choice, chosen_by, revision, cause, continuation_id from replay_hold where execution_id = 'late-exec'`)
  const held = { state: "held", choice: null, chosen_by: null, revision: 1, cause: "interrupted", continuation_id: null }
  expect(await hold()).toMatchObject([held])
  const decide = (over: Record<string, unknown> = {}) => moveOf(t, { move_decision: { choice: "continue", attempt_id: "late-exec", expected_recovery_revision: 1, ...over } })

  // Words from before the interruption are not an answer to it.
  expect(await code(call(t.s, t.general, decide(), { said: early }))).toBe("source_invalid")
  // A revision or an attempt other than the one shown is void.
  expect(await call(t.s, t.general, decide({ expected_recovery_revision: 2 }))).toMatchObject({ status: "failed", cause: "stale_revision" })
  expect(await call(t.s, t.general, decide({ attempt_id: "some-other-attempt" }))).toMatchObject({ status: "failed", cause: "stale_revision" })
  // A turn that is still being answered is not resolved, and nothing is recorded.
  await plant(t.s, t.topic, "turn-2", "running")
  const said = await t.s.said("yes, I saw it")
  const busy = await call(t.s, t.general, decide(), { said })
  expect(busy).toMatchObject({ status: "failed", cause: "turn_still_finishing" })
  expect(await count(t.s, "source_consumption", `source_id = '${said}'`)).toBe(0)
  expect(rows(await moves(t.s))).toMatchObject([{ stage: "awaiting_owner" }])
  await settle(t.s, "turn-2")

  const reply = await call(t.s, t.general, decide(), { said })
  expect(reply).toMatchObject({ status: "accepted", stage: "failure_acknowledged" })
  expect(String(reply.status_message)).toContain("did not resume, release or replay the interrupted work")
  expect(String(reply.status_message)).toContain("decided separately with resume")
  expect(String(reply.status_message)).not.toMatch(/resumed|is being resumed|will resume|replayed|will be replayed/i)
  expect(reply.move).toMatchObject({ from: "pi", to: "mac" })
  const [after] = rows(await moves(t.s))
  expect(after).toMatchObject({ stage: "waiting", failure: null })
  expect(after.acknowledged_failures).toMatchObject([{ execution: "late-exec", revision: 1, by: OWNER }])

  // It acknowledged that failure and nothing else: the hold is exactly as it was, no continuation was made, nothing was fed or replayed, and the gate stays.
  expect(await hold()).toMatchObject([held])
  expect(await count(t.s, "inbound", "id like 'continue:%'")).toBe(0)
  expect(await count(t.s, "execution", "id = 'late-exec' and state = 'interrupted'")).toBe(1)
  expect(rows(await t.s.admin`select claimed_by from inbound where id = 'in-late-exec'`)).toMatchObject([{ claimed_by: null }])
  expect(await openGates(t.s, t.topic.agent_id)).toHaveLength(1)

  // Asked again it is the same acknowledgement; an interruption the move is not waiting on has nothing to acknowledge.
  expect(await call(t.s, t.general, decide())).toMatchObject({ status: "accepted", stage: "failure_acknowledged" })
  expect(await call(t.s, t.general, decide({ attempt_id: "other-attempt" }))).toMatchObject({ status: "failed", cause: "nothing_to_decide" })
  expect(await hold()).toMatchObject([held])
  expect(await inspectOf(t)).toMatchObject({ status: "queued", stage: "waiting_for_machine" })

  // The owner can still withdraw, and withdrawing releases only the move's gate: the interrupted work stays held for `resume`.
  expect(await call(t.s, t.general, moveOf(t, { move_decision: { choice: "withdraw" } }))).toMatchObject({ status: "complete" })
  expect(await hold()).toMatchObject([held])
  expect(await openGates(t.s, t.topic.agent_id)).toEqual([])
})

test("a move that is past activation cannot be withdrawn, says it is past, and a block of the side's own there offers the owner nothing", async () => {
  const t = await staged()
  await online(t.s, RUNNER_MAC)
  await call(t.s, t.own, { action: "move", destination_machine: "mac" })
  const [made] = rows(await moves(t.s))
  const move = (await readMove(t.fix.tool, String(made.id)))!
  const activated = await t.fix.reach(move, "activated")
  expect(activated.stage).toBe("activated")

  const refused = await call(t.s, t.general, moveOf(t, { move_decision: { choice: "withdraw" } }))
  expect(refused).toMatchObject({ status: "failed", cause: "too_late" })
  expect(String(refused.status_message)).toContain("nothing is to be retried")
  expect(String(refused.owner_status)).toContain("past the point of withdrawal")
  expect(String(refused.owner_status)).not.toMatch(/ask again|try again|reopen/i)
  expect(rows(await moves(t.s))).toMatchObject([{ stage: "activated" }])

  expect(await inspectOf(t)).toMatchObject({ status: "running", stage: "switching_over" })
  expect((await inspectOf(t)).move).toMatchObject({ withdrawable: false, actions: [] })
  // The hub's own block at this step: said as the registry's, with no way out offered, and no promise.
  expect(await blockMove(t.fix.hub, move.id, null, "registry_conflict", { runner: "x" })).toBe("blocked")
  const blocked = await inspectOf(t)
  expect(blocked).toMatchObject({ status: "queued", stage: "blocked", cause: "registry" })
  expect(String(blocked.status_message)).toContain("the registry could not be updated")
  expect(String(blocked.status_message)).toContain("past the point of withdrawal")
  expect(String(blocked.status_message)).not.toContain("registry_conflict")
  expect((blocked.move as { actions: string[] }).actions).toEqual([])
})

// ---------------------------------------------------------------------------------------------
// where a line is said, who may use General, what is unresolved
// ---------------------------------------------------------------------------------------------

/** What the registry says of a topic's agent once the hub has bound it (the tests that rewrite the registry keep it there). */
const agentOf = (topic: TopicRow) => ({ id: topic.agent_id, person: PERSON, preset: topic.preset, chat: topic.chat!, door: topic.door, runner: topic.runner })
const generalAgent = (door: string, chat: string, runner = RUNNER_PI) => ({ id: GENERAL, person: PERSON, preset: "daily", chat, door, runner })
/** Telegram doors, which have no mention: the loader takes a door with none of Discord's own settings. */
const TELEGRAM = { platform: "telegram", guild: undefined, archive_category: undefined, archive_readonly_roles: undefined }

/**
 * General's registry entry was edited onto another door and that door has adopted it, as the shipped door task does for an adopted master whose entry
 * moved: the one topic (and its conversation) is rebound by the store's own route change, so the registry and the store say the same of where General
 * answers. The registry edit alone leaves the topic on the door it was linked on, which is a stale binding and is refused (the stale-binding test below).
 */
async function generalAdoptedBehind(s: TopicsStage, door: string) {
  expect(await rebindLegacyTopic(s.as("hub_hub"), GENERAL, s.general, { door, person: PERSON, requireChange: true })).toBe("rebound")
  expect(await readTopic(s.as("hub_hub"), (await s.admin`select id from topic where agent_id = ${GENERAL}`)[0].id)).toMatchObject({ door, chat: s.general, origin: "legacy", lifecycle: "active" })
}

test("asked in the topic's own chat, a move names the door's commands for following and withdrawing it, whatever becomes of General, and sends nothing of its own", async () => {
  const t = await staged()
  const sent = await count(t.s, "outbox")
  const reply = await call(t.s, t.own, { action: "move", destination_machine: "mac" })
  expect(reply).toMatchObject({ status: "accepted", stage: "move_requested" })
  // The owner reads the commands this chat answers itself, and the model reads the same.
  const [made] = rows(await moves(t.s))
  expect(String(reply.owner_status)).toContain("Send /move here to see where it stands")
  expect(String(reply.owner_status)).toContain(`by sending /move withdraw ${made.id} here`)
  expect(String(reply.owner_status)).not.toContain("General")
  expect(String(reply.status_message)).toContain(`/move withdraw ${made.id}`)
  expect(reply.move).toMatchObject({ actions: ["withdraw"] })
  // Inspected in the same chat it says the same, and in General's own chat it is a line for the model to relay: no command is pointed at.
  const inside = await callTool(t.own, "hub_topic", { action: "inspect", topic_id: t.topic.id }) as Record<string, unknown>
  expect(String(inside.owner_status)).toContain(`/move withdraw ${made.id}`)
  expect(String((await inspectOf(t)).owner_status)).not.toMatch(/General|\/move/)
  // Nothing was said or queued on the way: the answer is the tool's, and there is no unsolicited message.
  expect(await count(t.s, "outbox")).toBe(sent)

  // General's chat is archived while the move waits: that changes nothing about what the owner can do in the chat being moved.
  expect(await call(t.s, t.general, { action: "archive", topic_id: GENERAL })).toMatchObject({ status: "stopping" })
  const after = await callTool(t.own, "hub_topic", { action: "inspect", topic_id: t.topic.id }) as Record<string, unknown>
  expect(String(after.owner_status)).toContain(`by sending /move withdraw ${made.id} here`)
  expect(String(after.owner_status)).not.toContain("General")
  expect(after.move).toMatchObject({ actions: ["withdraw"] })
})

test("the structured reading the model gets names the block and its family, and the owner's words never carry the block's code", async () => {
  const t = await staged()
  await call(t.s, t.own, { action: "move", destination_machine: "mac" })
  const [made] = rows(await moves(t.s))
  for (const [codeName, family] of [["workspace_unpushed", "source_workspace"], ["config_mismatch", "config_differs"]] as const) {
    expect(await blockMove(t.fix.tool, String(made.id), { runner: RUNNER_PI, incarnation: "src-1" }, codeName, { sections: ["x"] })).toBe("blocked")
    const standing = await inspectOf(t)
    expect(standing).toMatchObject({ status: "queued", stage: "blocked", cause: family })
    expect(standing.move).toMatchObject({ family, block: { code: codeName, family } })
    expect(String(standing.owner_status)).not.toContain(codeName)
    expect(String(standing.owner_status)).not.toContain("has not shown that everything of this chat has stopped")
    expect(await unblockMove(t.fix.tool, String(made.id), { runner: RUNNER_PI, incarnation: "src-1" }, codeName)).toBe("cleared")
  }
  expect((await inspectOf(t)).move).not.toHaveProperty("block")
})

// One language per test, so each stage (and General's second door) is closed before the next is built.
for (const language of ["en", "ru"] as const) {
  test(`on a platform with no mention, an adopted chat is 'this chat' only where the line is delivered in it and the chat being moved in General's, in ${language} and in the notice that falls back to General`, async () => {
    const HERE = language === "en" ? "“this chat”" : "«этот чат»"
    const MOVED = language === "en" ? "“the chat being moved”" : "«переносимый чат»"
    const t = await staged()
    // An adopted chat is named by its agent's own id, and its door speaks Telegram; General is behind another Telegram door.
    await t.s.admin`update topic set display_name = agent_id where id = ${t.topic.id}`
    t.s.rewrite({
      person: { language, allowed_senders: { [DOOR]: [OWNER], "door-g": [OWNER] } }, door: TELEGRAM, moreDoors: ["door-g"], withoutGeneralAgent: true,
      agents: [agentOf(t.topic), generalAgent("door-g", t.s.general)],
    })
    await generalAdoptedBehind(t.s, "door-g")
    await doorOnline(t.s, "door-g")
    const clean = (text: unknown) => {
      expect(String(text), language).not.toContain(t.topic.agent_id)
      expect(String(text), language).not.toContain(t.topic.id)
    }

    // Asked from General: its words, and not "this chat". The owner said it in General's chat, on General's door.
    const inGeneral = await t.s.said("to the mac", { agent: GENERAL, door: "door-g", chat: t.s.general, sender: OWNER })
    const asked = await call(t.s, t.general, moveOf(t, { destination_machine: "mac" }), { said: inGeneral })
    expect(asked, language).toMatchObject({ status: "accepted", stage: "move_requested" })
    expect(String(asked.owner_status), language).toContain(MOVED)
    expect(String(asked.owner_status), language).not.toContain(HERE)
    clean(asked.owner_status)
    // Inspected from General.
    const seen = await inspectOf(t)
    expect(String(seen.owner_status), language).toContain(MOVED)
    expect(String(seen.owner_status), language).not.toContain(HERE)
    clean(seen.owner_status)
    // Inspected in the chat itself, where it is "this chat" and the door's own commands are what it points at, in the person's language.
    const inside = await callTool(t.own, "hub_topic", { action: "inspect", topic_id: t.topic.id }) as Record<string, unknown>
    expect(String(inside.owner_status), language).toContain(HERE)
    const [opened] = rows(await moves(t.s))
    expect(String(inside.owner_status), language).toContain(`${language === "en" ? "/move withdraw" : "/перенос отозвать"} ${opened.id}`)
    expect(String(inside.owner_status), language).not.toContain("General")
    expect(String(inside.owner_status), language).not.toContain(MOVED)
    clean(inside.owner_status)

    // What production does: the chat's own turn, the one answering the owner, is a running attempt, so a withdrawal said in the chat itself is refused as
    // still finishing, nothing is recorded, the move stands, and the owner is told to send the door's command again.
    await plant(t.s, t.topic, `turn-${language}`, "running")
    const inTopic = await t.s.said("never mind", { agent: t.own.agent, door: DOOR, chat: t.topic.chat!, sender: OWNER })
    const calls = await moveCalls(t.s)
    const refused = await call(t.s, t.own, moveOf(t, { move_decision: { choice: "withdraw" } }), { said: inTopic })
    expect(refused, language).toMatchObject({ status: "failed", cause: "turn_still_finishing" })
    expect(String(refused.owner_status), language).toContain(language === "en" ? `send /move withdraw ${opened.id} here again once it has ended` : `отправьте /перенос отозвать ${opened.id} здесь ещё раз`)
    clean(refused.owner_status)
    expect(await moveCalls(t.s), language).toBe(calls)
    expect(await count(t.s, "source_consumption", `source_id = '${inTopic}'`), language).toBe(0)
    expect(rows(await moves(t.s)), language).toMatchObject([{ stage: "waiting" }])
    expect(await count(t.s, "outbox", "notice_key like 'topic-move:%'"), language).toBe(0)

    // Wording coverage only: with the attempt settled, which a chat answering its owner never is, the reply says "this chat", and the one notice goes to
    // General, which says the chat being moved. This is not a path the running system takes for the chat's own withdrawal.
    await settle(t.s, `turn-${language}`)
    const withdrawn = await call(t.s, t.own, moveOf(t, { move_decision: { choice: "withdraw" } }), { said: inTopic })
    expect(withdrawn, language).toMatchObject({ status: "complete", stage: "withdrawn" })
    expect(String(withdrawn.owner_status), language).toContain(HERE)
    clean(withdrawn.owner_status)
    const [made] = rows(await moves(t.s))
    const [notice] = rows(await t.s.admin`select agent, body, route from outbox where notice_key = ${`topic-move:${made.id}:withdrawn`}`)
    expect(notice, language).toMatchObject({ agent: GENERAL, route: { door: "door-g", chat: t.s.general } })
    expect(String(notice.body).startsWith(`${MACHINERY_LINES[language]} `), language).toBe(true)
    expect(String(notice.body), language).toContain(MOVED)
    expect(String(notice.body), language).not.toContain(HERE)
    clean(notice.body)
  })
}

test("the evidence a move is asked with is still the owner's: a stranger's message, or the id the owner has on another door, never starts a move, and a refusal spends nothing", async () => {
  const t = await staged()
  const OWNER_B = "200000000000000001"
  const ask = async (said: string) => await call(t.s, t.own, { action: "move", destination_machine: "mac" }, { said })
  // Not on the topic's own door, and not by another door's id read as this door's.
  expect(await code(ask(await t.s.said("move it", { agent: t.own.agent, sender: STRANGER })))).toBe("source_invalid")
  expect(await code(ask(await t.s.said("move it", { agent: t.own.agent, door: "door-b", sender: STRANGER })))).toBe("source_invalid")
  expect(await code(ask(await t.s.said("move it", { agent: t.own.agent, sender: OWNER_B })))).toBe("source_invalid")
  await nothingLeft(t.s)
  expect(await ask(await t.s.said("move it", { agent: t.own.agent }))).toMatchObject({ status: "accepted", stage: "move_requested" })
  expect(rows(await moves(t.s))).toMatchObject([{ requested_by: OWNER, stage: "waiting" }])
})

test("an attempt the runner lost track of is unresolved and not 'still finishing': status and refusals agree, say to restore the source's report, and neither promise an ending nor release or replay anything", async () => {
  const t = await staged({ stage: { person: { language: "ru" } } })
  await plant(t.s, t.topic, "lost-1", "unknown")
  const asked = await call(t.s, t.general, moveOf(t, { destination_machine: "mac" }))
  expect(asked).toMatchObject({ status: "accepted", stage: "move_requested" })
  expect(asked.move).toMatchObject({ turn_finishing: false, turn_unresolved: true, actions: [] })
  expect(await inspectOf(t)).toMatchObject({ status: "queued", stage: "turn_unresolved" })
  for (const text of [String(asked.status_message), String(asked.owner_status)]) {
    expect(text).not.toMatch(/still finishing|ещё не закончен/)
    expect(text).not.toMatch(/You can withdraw|Перенос можно отозвать/)
  }
  expect(String(asked.status_message)).toContain("is unresolved")
  expect(String(asked.status_message)).toContain("Until pi reports on it again")
  expect(String(asked.owner_status)).toContain("не прояснено")
  expect(String(asked.owner_status)).toContain("Пока pi снова не сообщит об этом")

  // A withdrawal and an answer are refused the same way, as unresolved, and nothing is recorded, released or retried.
  const calls = await moveCalls(t.s)
  const said = await t.s.said("never mind")
  const refused = await call(t.s, t.general, moveOf(t, { move_decision: { choice: "withdraw" } }), { said })
  expect(refused).toMatchObject({ status: "failed", cause: "turn_unresolved" })
  expect(String(refused.status_message)).toContain("is unresolved")
  expect(String(refused.status_message)).not.toContain("still finishing")
  expect(String(refused.owner_status)).toContain("не прояснено")
  expect(String(refused.owner_status)).not.toMatch(/попросите снова|ещё идёт/)
  expect(await moveCalls(t.s)).toBe(calls)
  expect(await count(t.s, "source_consumption", `source_id = '${said}'`)).toBe(0)
  expect(rows(await moves(t.s))).toMatchObject([{ stage: "waiting" }])
  expect(await openGates(t.s, t.topic.agent_id)).toHaveLength(1)
  expect(await count(t.s, "outbox", "notice_key like 'topic-move:%'")).toBe(0)

  // An interruption the move stops on, while that attempt is still unresolved: the answer is refused the same way and is not offered.
  await plant(t.s, t.topic, "late-exec", "interrupted")
  expect(rows(await moves(t.s))).toMatchObject([{ stage: "awaiting_owner", failure: { execution: "late-exec", revision: 1 } }])
  const standing = await inspectOf(t)
  expect(standing).toMatchObject({ status: "waiting_owner", stage: "awaiting_owner" })
  expect(standing.move).toMatchObject({ turn_unresolved: true, actions: [] })
  const heard = await t.s.said("yes, I saw it")
  const decide = moveOf(t, { move_decision: { choice: "continue", attempt_id: "late-exec", expected_recovery_revision: 1 } })
  const unanswered = await call(t.s, t.general, decide, { said: heard })
  expect(unanswered).toMatchObject({ status: "failed", cause: "turn_unresolved" })
  expect(String(unanswered.status_message)).toContain("is unresolved")
  expect(String(unanswered.owner_status)).toContain("не прояснено")
  expect(await count(t.s, "source_consumption", `source_id = '${heard}'`)).toBe(0)
  expect(rows(await t.s.admin`select state from execution where id in ('lost-1', 'late-exec') order by id`)).toMatchObject([{ state: "interrupted" }, { state: "unknown" }])
  expect(await count(t.s, "inbound", "id like 'continue:%'")).toBe(0)
  expect(await count(t.s, "replay_hold", "state = 'held'")).toBe(1)

  // Once the attempt is resolved the same words are the ordinary request, and withdrawing releases only the move's gate.
  await settle(t.s, "lost-1")
  expect(await call(t.s, t.general, moveOf(t, { move_decision: { choice: "withdraw" } }), { said })).toMatchObject({ status: "complete", stage: "withdrawn" })
  expect(await count(t.s, "replay_hold", "state = 'held'")).toBe(1)
})

test("a healthy owned attempt on a source that is not connected is unresolved too: it says to bring the source machine online, and a connected source is still 'finishing'", async () => {
  // General is on the other runner, so that the source can be offline while General can still be asked.
  const t = await staged({ generalLive: false })
  t.s.rewrite({ agents: [agentOf(t.topic), generalAgent(DOOR, t.s.general, RUNNER_MAC)], withoutGeneralAgent: true })
  await online(t.s, RUNNER_MAC)
  await plant(t.s, t.topic, "turn-1", "running")
  const asked = await call(t.s, t.general, moveOf(t, { destination_machine: "mac" }))
  expect(asked).toMatchObject({ status: "accepted", stage: "move_requested" })
  expect(asked.move).toMatchObject({ turn_finishing: false, turn_unresolved: true, actions: [] })
  expect(String(asked.owner_status)).toContain("is unresolved")
  expect(String(asked.owner_status)).toContain("pi is not connected")
  expect(String(asked.owner_status)).toContain("Bring pi online so that it can be observed again")
  expect(String(asked.owner_status)).not.toContain("still finishing")
  expect(await inspectOf(t)).toMatchObject({ status: "queued", stage: "turn_unresolved" })
  const refused = await call(t.s, t.general, moveOf(t, { move_decision: { choice: "withdraw" } }))
  expect(refused).toMatchObject({ status: "failed", cause: "turn_unresolved" })
  expect(String(refused.owner_status)).toContain("Bring pi online so that it can be observed again")
  expect(rows(await moves(t.s))).toMatchObject([{ stage: "waiting" }])

  // The source is connected again: the same attempt is a healthy turn that is finishing, said as that and refused as that.
  await online(t.s, RUNNER_PI)
  expect((await inspectOf(t)).move).toMatchObject({ turn_finishing: true, turn_unresolved: false, actions: [] })
  expect(await inspectOf(t)).toMatchObject({ status: "queued", stage: "turn_finishing" })
  expect(await call(t.s, t.general, moveOf(t, { move_decision: { choice: "withdraw" } }))).toMatchObject({ status: "failed", cause: "turn_still_finishing" })
})

test("a block only the other side can clear is queued even while the owner could withdraw", async () => {
  const t = await staged()
  await call(t.s, t.own, { action: "move", destination_machine: "mac" })
  const [made] = rows(await moves(t.s))
  // The hub's own block at the first step: only the hub clears it, and withdrawing is possible but is not what the move waits for.
  expect(await blockMove(t.fix.hub, String(made.id), null, "registry_conflict", { runner: "x" })).toBe("blocked")
  const blocked = await inspectOf(t)
  expect(blocked).toMatchObject({ status: "queued", stage: "blocked", cause: "registry" })
  expect((blocked.move as { actions: string[] }).actions).toEqual(["withdraw"])
  expect(String(blocked.owner_status)).toContain("It stays on hold until that is sorted out there")
})

test("a block the owner can clear (a source that was never known) is waiting for the owner", async () => {
  const unknown = await staged({ source: false })
  expect(await call(unknown.s, unknown.own, { action: "move", destination_machine: "mac" })).toMatchObject({ status: "waiting_owner", stage: "blocked", cause: "owner_unknown" })
})
