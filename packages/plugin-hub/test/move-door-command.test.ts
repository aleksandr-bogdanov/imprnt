// The owner's move commands as the door reads them (`/move`, `/move withdraw <move-id>`, `/move seen <attempt> <revision>`, and the Russian verbs), in the
// owner's own chat, while the chat's agent is gated.
//
// Real store (the role the door uses), the real registry loader, the real chat log, and the door's own ingestion (`acceptBatch`), which is where the
// command is read. What is PLANTED, and decides nothing the code under test decides: the platform (a recorder that is handed batches and keeps what the
// door posts), the attempts and holds a runner would have written, a runner's session on the store, and the stages of a move the runner and the hub
// would have taken it through (the store fixture's own steps). Nothing here starts a runner or moves a file.
//
// WHAT IS BEING HELD AGAINST THE DOOR: a command is bound to ONE move and to its own message. A withdrawal NAMES its move, so a first delivery of an old
// `/move withdraw <move-id>` after a NEW move exists (even one stamped ahead of it) cannot reach the new one, and the bare `/move withdraw` only reads the
// status. An acknowledgement worded for an older interruption after a newer one stands, and a crash on either side of the store's commit must never
// act on anything but what the message was about, once.

import { afterAll, afterEach, beforeAll, expect, test } from "bun:test"
import { backendPid, startCluster, until, type Cluster } from "./helpers/cluster.ts"
import { closeStages, removeEffectDirs } from "./helpers/effects-fixture.ts"
import { chatLogLines } from "./helpers/hub-fixture.ts"
import { moveStage } from "./helpers/move-store-stage.ts"
import { DOOR, GENERAL, OWNER, PERSON, RUNNER_MAC, RUNNER_PI, STRANGER, stageTopics, type TopicsStage } from "./helpers/topics-fixture.ts"
import { appendChatLineOnce } from "../src/chatlog.ts"
import { acceptBatch } from "../src/door/ingest.ts"
import { answerMoveCommand, bindMoveCommand, MOVE_COMMAND_SHEET, parseMoveCommand } from "../src/door/move-command.ts"
import type { Platform, PlatformMessage } from "../src/door/platform.ts"
import { readSlice } from "../src/harvest/slice.ts"
import { bindTopics } from "../src/hub/topics.ts"
import { callTool } from "../src/mcp/handlers.ts"
import { listAgents } from "../src/registry/entries.ts"
import { loadRegistry } from "../src/registry/load.ts"
import type { StoreLike } from "../src/store/connect.ts"
import { inboundId } from "../src/store/inbound.ts"
import { readMove } from "../src/store/moves.ts"
import { readTopic, type TopicRow } from "../src/store/topics.ts"

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

const rows = (result: unknown) => Array.from(result as Record<string, unknown>[]).map(row => ({ ...row }))
const count = async (s: TopicsStage, table: string, where = "true") =>
  Number((await s.admin.unsafe(`select count(*)::int as n from ${table} where ${where}`))[0].n)
const moves = (s: TopicsStage) => s.admin`select id, topic_id, agent, stage, block, failure, evidence, route, acknowledged_failures, created_at::text as made from topic_move order by created_at`
const openGates = async (s: TopicsStage, agent: string) =>
  rows(await s.admin`select operation_id from claim_gate where scope_kind = 'agent' and scope_id = ${agent} and state = 'open' order by operation_id`).map(row => row.operation_id)
/** A moment just after now: a message typed after the move was made, with the database's own microseconds safely behind it. */
const later = (ms = 5): string => new Date(Date.now() + ms).toISOString()
const earlier = (ms = 60_000): string => new Date(Date.now() - ms).toISOString()

/** A topic taken all the way: asked for, confirmed by the owner's check, made, bound and announced. */
async function bound(s: TopicsStage): Promise<TopicRow> {
  const master = await s.binding()
  const reply = await s.ask(master, { action: "create", setup: { chat_name: "coffee", initial_request: "Compare the two vendors." } })
  await s.deliver()
  await s.react(String(reply.operation_id))
  await s.topicPass()
  await bindTopics({ store: s.as("hub_hub"), registryFile: s.registryFile, machine: "pi", load: () => loadRegistry(s.registryFile, { machine: "pi" }) })
  await s.topicPass()
  await s.deliver()
  return (await readTopic(s.as("hub_hub"), String(reply.object_id)))!
}

/** A process has a session on the store under its own name: what "not offline" means to the readings. */
async function connected(s: TopicsStage, role: "hub_runner" | "hub_door", name: string) {
  const held = s.fresh(role)
  await held.sql.unsafe("select set_config('application_name', $1, false)", [name])
  return held
}

/** A topic master on the source machine, the store at protocol 4 with both runners registered, and no runner of this stage started at all. */
async function staged(over: { language?: "en" | "ru" } = {}) {
  const s = await stageTopics(cluster, over.language === undefined ? {} : { person: { language: over.language } })
  const topic = await bound(s)
  const fix = await moveStage(cluster, track, { database: s.db })
  await fix.fleet()
  const own = await s.binding(topic.agent_id)
  const general = await s.binding()
  await connected(s, "hub_runner", RUNNER_PI)
  await connected(s, "hub_door", DOOR)
  return { s, fix, topic, own, general }
}
type Stage = Awaited<ReturnType<typeof staged>>

let counter = 0
/** The owner asks for the move from the topic's own chat (or from General), as the tool is called. Returns the move row. */
async function askMove(t: Stage, from: "own" | "general" = "own") {
  const binding = from === "own" ? t.own : t.general
  const said = await t.s.said("move it to the mac", { agent: binding.agent })
  const reply = await callTool(binding, "hub_topic", { request_key: `ask-${++counter}`, source_message_ids: [said], action: "move",
    ...(from === "general" ? { topic_id: t.topic.id } : {}), destination_machine: "mac" }) as Record<string, unknown>
  expect(reply).toMatchObject({ status: "accepted" })
  return rows(await moves(t.s)).at(-1)!
}

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

/** The door of one agent's chat: handed the owner's messages as a platform would hand them, keeping what it posts. */
function doorOf(t: Stage, agentId = t.topic.agent_id) {
  const posts: string[] = []
  const platform = { name: "fake", async post(options: { chat: string; text: string }) { posts.push(options.text); return { id: null } } } as unknown as Platform
  const registry = () => loadRegistry(t.s.registryFile)
  const agent = () => listAgents(registry()).find(one => one.id === agentId)!
  let n = 0
  const message = (text: string, over: { id?: string; at?: string; sender?: string } = {}): PlatformMessage => ({
    platform_message_id: over.id ?? String(7000 + ++n), chat: agent().chat!, from: "p1", sender_id: over.sender ?? OWNER, media: [], text, at: over.at ?? later(),
  })
  const take = async (m: PlatformMessage) => {
    await acceptBatch({ store: t.s.as("hub_door"), registry: registry(), stateDir: t.s.dir, door: DOOR, agent: agent() as never, platform,
      batch: { messages: [m], cursor: m.platform_message_id }, cursor: null })
  }
  const say = async (text: string, over: { id?: string; at?: string; sender?: string } = {}) => { const m = message(text, over); await take(m); return m }
  const logId = (m: PlatformMessage) => `move:${inboundId("fake", m.chat, m.platform_message_id)}`
  return { posts, say, take, message, logId, agent }
}

const stageOf = async (t: Stage, index = -1) => rows(await moves(t.s)).at(index)!
/** A move row's id as the string the database gave: a row without one is a broken fixture, not a value to compare. */
const idOf = (row: Record<string, unknown>): string => {
  if (typeof row.id !== "string") throw new Error(`move row has no string id: ${String(row.id)}`)
  return row.id
}
/** The exact withdrawal command for a move, as the status shows it. */
const withdrawing = (move: unknown): string => `/move withdraw ${String(move)}`

test("the verbs: `/move` and `/перенос` read as one command, a withdrawal names its move and `seen` the attempt and the revision, and anything else is usage, never a guess", () => {
  expect(parseMoveCommand("/move")).toEqual({ verb: "status" })
  expect(parseMoveCommand("/MOVE  ")).toEqual({ verb: "status" })
  expect(parseMoveCommand("/перенос")).toEqual({ verb: "status" })
  expect(parseMoveCommand("/move withdraw mv-1")).toEqual({ verb: "withdraw", move: "mv-1" })
  expect(parseMoveCommand("/перенос отозвать mv-1")).toEqual({ verb: "withdraw", move: "mv-1" })
  expect(parseMoveCommand("/MOVE  Withdraw  3f2a9c1e-0b7d-4c52-9a8e-1d2f3a4b5c6d ")).toEqual({ verb: "withdraw", move: "3f2a9c1e-0b7d-4c52-9a8e-1d2f3a4b5c6d" })
  // A bare withdrawal changes nothing, whatever the language: it is the status reading, which shows the exact command.
  expect(parseMoveCommand("/move withdraw")).toEqual({ verb: "status" })
  expect(parseMoveCommand("/перенос отозвать")).toEqual({ verb: "status" })
  expect(parseMoveCommand("/move seen late-exec 1")).toEqual({ verb: "seen", attempt: "late-exec", revision: 1 })
  expect(parseMoveCommand("/перенос принято late-exec 12")).toEqual({ verb: "seen", attempt: "late-exec", revision: 12 })
  // A bare `seen` would acknowledge whatever stands: it is not a command. A withdrawal names one move, spelled as an id.
  for (const text of ["/move seen", "/move seen late-exec", "/move seen late-exec 0", "/move seen late-exec x", "/move seen a b 1", "/move withdraw a b", "/move withdraw a;b",
    "/перенос отозвать a b", "/move go", "/move seen a;b 1"]) {
    expect(parseMoveCommand(text), text).toBe("usage")
  }
  // Not this command at all: a different word, or a message that merely mentions it.
  for (const text of ["/moves", "move it", "please /move", "/recover p1-lair", "hello"]) expect(parseMoveCommand(text), text).toBeNull()
})

test("D1 `/move` with no move says so once, is never an inbound row or part of the chat's history for a model, and a redelivery says nothing more", async () => {
  const t = await staged()
  const door = doorOf(t)
  const asked = await door.say("/move")
  expect(door.posts).toHaveLength(1)
  expect(door.posts[0]).toBe("[door] Nothing is being moved in this chat.")
  expect(await count(t.s, "inbound", `id like 'fake:%'`)).toBe(0)
  // The door wrote it down as the owner's line and its own answer, and the slice a model reads leaves the command out.
  const log = chatLogLines(t.s.dir, PERSON, t.topic.agent_id) as unknown as { id?: string; text: string; direction: string }[]
  expect(log.some(line => line.text === "/move" && line.direction === "in")).toBe(true)
  expect((await readSlice({ stateDir: t.s.dir, person: PERSON, agent: t.topic.agent_id, from: null, until: later(60_000) })).map(line => line.text)).not.toContain("/move")
  // The platform hands the same batch again: the same message, the same answer, and nothing is posted twice.
  await door.take(asked)
  await door.take(asked)
  expect(door.posts).toHaveLength(1)
  // Spelled wrong is usage, the same way.
  await door.say("/move seen")
  expect(door.posts).toHaveLength(2)
  expect(door.posts[1]).toContain("/move seen <attempt> <revision>")
})

test("D2 `/move` while the destination is offline says it waits for that machine and offers the withdrawal, as the exact command that names the move, in the door's own words", async () => {
  const t = await staged()
  const made = await askMove(t)
  const door = doorOf(t)
  await door.say("/move")
  expect(door.posts).toHaveLength(1)
  expect(door.posts[0].startsWith("[door] Waiting for mac:")).toBe(true)
  expect(door.posts[0]).toContain(`by sending ${withdrawing(made.id)} here`)
  expect(door.posts[0]).toContain("on mac if it goes through, on pi if it is withdrawn")
  expect(door.posts[0]).not.toContain(t.topic.agent_id)
  expect(door.posts[0]).not.toContain("General")
  // A reading changes nothing.
  expect(await stageOf(t)).toMatchObject({ stage: "waiting" })
  expect(await openGates(t.s, t.topic.agent_id)).toHaveLength(1)
})

test("D3 `/move withdraw` while an attempt is owned is refused as still finishing, records nothing, and the same words work once it has ended", async () => {
  const t = await staged()
  await plant(t.s, t.topic, "turn-1", "running")
  const made = await askMove(t)
  const door = doorOf(t)
  const first = await door.say(withdrawing(made.id))
  expect(door.posts).toHaveLength(1)
  expect(door.posts[0]).toContain("still finishing")
  expect(door.posts[0]).toContain(`send ${withdrawing(made.id)} here again once it has ended`)
  expect(await stageOf(t)).toMatchObject({ stage: "waiting" })
  expect((await stageOf(t)).evidence).not.toHaveProperty("withdrawn")
  expect(await openGates(t.s, t.topic.agent_id)).toEqual([`move:${made.id}`])
  expect(await count(t.s, "outbox", "notice_key like 'topic-move:%'")).toBe(0)
  // A refusal spends nothing: the same command, once the turn has ended, is applied.
  await settle(t.s, "turn-1")
  await door.take(first)
  expect(await stageOf(t)).toMatchObject({ stage: "withdrawn" })
  expect(door.posts).toHaveLength(2)
  expect(door.posts[1]).toContain("was withdrawn")
  // And its redelivery after that is the same withdrawal, said once.
  await door.take(first)
  expect(door.posts).toHaveLength(2)
})

test("D4 `/move withdraw` while idle withdraws it: the gate is released, the evidence is the chat command's and the sender's, only a move that asked from another chat is told, and a hold stays held", async () => {
  const t = await staged()
  // A hold that was there when the move was asked: admitted, and not the move's to release.
  await plant(t.s, t.topic, "old-exec", "interrupted")
  const made = await askMove(t)
  expect(await stageOf(t)).toMatchObject({ stage: "waiting" })
  const door = doorOf(t)
  const m = await door.say(withdrawing(made.id))
  const after = await stageOf(t)
  expect(after).toMatchObject({ stage: "withdrawn", block: null })
  expect(await openGates(t.s, t.topic.agent_id)).toEqual([])
  // The evidence is kept ON the move's own row, so the row is the move it names: the withdrawal's target is this row (the one asked for), and the
  // message that did it is bound to it by the id the door gave that message. No second copy of the move's id is written into its own evidence.
  expect(after.id).toBe(made.id)
  const evidence = (after.evidence as { withdrawn: Record<string, unknown> }).withdrawn
  expect(evidence).toMatchObject({ by: OWNER, source: "chat-command", message: door.logId(m), door: DOOR, chat: t.topic.chat, sent_at: m.at, route: { door: DOOR, chat: t.topic.chat } })
  // The store's own time of the withdrawal is kept beside the platform's time of the message: neither overwrote the other.
  expect(typeof evidence.at).toBe("string")
  expect(evidence.at).not.toBe(m.at)
  expect(door.posts).toHaveLength(1)
  expect(door.posts[0].startsWith("[door] ")).toBe(true)
  expect(door.posts[0]).toContain("was withdrawn")
  expect(door.posts[0]).toContain("messages that waited are handled there")
  expect(door.posts[0]).toContain(`<#${t.topic.chat}>`)
  // Asked in this very chat, so no second chat is told: this reply is the word of it.
  expect(await count(t.s, "outbox", `notice_key = 'topic-move:${made.id}:withdrawn'`)).toBe(0)
  // The hold the move admitted is exactly as it was: withdrawing released nothing of it, and nothing was replayed.
  expect(rows(await t.s.admin`select state, choice, continuation_id from replay_hold where execution_id = 'old-exec'`)).toMatchObject([{ state: "held", choice: null, continuation_id: null }])
  expect(await count(t.s, "inbound", "id like 'continue:%'")).toBe(0)

  // A move asked for in General is told once to General when it is withdrawn in this chat, and only then.
  const second = await askMove(t, "general")
  const there = await door.say(withdrawing(second.id))
  expect(await stageOf(t)).toMatchObject({ id: second.id, stage: "withdrawn" })
  const notices = rows(await t.s.admin`select agent, route from outbox where notice_key = ${`topic-move:${second.id}:withdrawn`}`)
  expect(notices).toMatchObject([{ agent: GENERAL, route: { door: DOOR, chat: t.s.general } }])
  await door.take(there)
  expect(await count(t.s, "outbox", `notice_key = 'topic-move:${second.id}:withdrawn'`)).toBe(1)
})

test("D5 a sender who is not on the allow-list changes nothing: no answer, no record, and the move stands", async () => {
  const t = await staged()
  const made = await askMove(t)
  const door = doorOf(t)
  await door.say(withdrawing(made.id), { sender: STRANGER })
  await door.say("/move", { sender: STRANGER })
  expect(door.posts).toEqual([])
  expect(await stageOf(t)).toMatchObject({ stage: "waiting" })
  expect(await openGates(t.s, t.topic.agent_id)).toEqual([`move:${made.id}`])
  expect((chatLogLines(t.s.dir, PERSON, t.topic.agent_id) as unknown as { text: string }[]).some(line => line.text.startsWith("/move"))).toBe(false)
})

test("D6 after activation the move cannot be withdrawn: it says so, and nothing is changed", async () => {
  const t = await staged()
  await connected(t.s, "hub_runner", RUNNER_MAC)
  const made = await askMove(t)
  const move = (await readMove(t.fix.tool, String(made.id)))!
  await t.fix.reach(move, "activated")
  const door = doorOf(t)
  await door.say(withdrawing(made.id))
  expect(door.posts).toHaveLength(1)
  expect(door.posts[0]).toContain("past the point of withdrawal")
  expect(await stageOf(t)).toMatchObject({ stage: "activated" })
  // A reading at that stage promises the destination and offers no withdrawal.
  await door.say("/move")
  expect(door.posts[1]).toContain("answered after it ends: on mac.")
  expect(door.posts[1]).not.toContain("/move withdraw")
})

test("D7 `/move seen` acknowledges exactly the interruption it names: the one shown, once, and never a newer one, a message older than the move, or another stage", async () => {
  const t = await staged()
  const made = await askMove(t)
  const door = doorOf(t)
  const hold = async (id: string) => rows(await t.s.admin`select state, choice, revision, continuation_id from replay_hold where execution_id = ${id}`)
  // Nothing to acknowledge while the move is only waiting.
  const pre = await door.say("/move seen late-exec 1")
  expect(door.posts.at(-1)).toContain("nothing to acknowledge")

  // The turn is interrupted while the move waits: it stops, and the reading shows the exact command for that attempt and revision.
  await plant(t.s, t.topic, "late-exec", "interrupted")
  expect(await stageOf(t)).toMatchObject({ stage: "awaiting_owner", failure: { execution: "late-exec", revision: 1 } })
  await door.say("/move")
  expect(door.posts.at(-1)).toContain("Send /move seen late-exec 1 here and the move goes back to waiting")
  // THE WORDS SENT BEFORE THE INTERRUPTION WAS THERE, delivered again now that it is, are not an answer to it: their receipt holds no interruption,
  // so nothing about the stage, the failure, the acknowledgements, the gate or the hold changes.
  const frozen = async () => JSON.stringify([await stageOf(t), await hold("late-exec"), await openGates(t.s, t.topic.agent_id), await count(t.s, "inbound", "id like 'continue:%'")])
  const before = await frozen()
  await door.take(pre)
  expect(await frozen()).toBe(before)
  expect(door.posts.at(-1)).toContain("does not stand on that interruption")
  // A bare `seen`, another attempt, another revision, and a message older than the move all change nothing.
  await door.say("/move seen")
  await door.say("/move seen other-exec 1")
  await door.say("/move seen late-exec 2")
  await door.say("/move seen late-exec 1", { at: earlier() })
  expect(await stageOf(t)).toMatchObject({ stage: "awaiting_owner", acknowledged_failures: [] })
  expect(door.posts.slice(-4).map(text => /nothing was (changed|recorded)|<attempt> <revision>/.test(text))).toEqual([true, true, true, true])
  // Evidence has to be strictly newer than the interruption, at the database's microseconds: the same instant and the one before are refused.
  const around = async (offset: string): Promise<string> => String(rows(await t.s.admin.unsafe(
    `select to_char(((failure ->> 'since')::timestamptz + $2::interval) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as at from topic_move where id = $1`, [String(made.id), offset]))[0].at)
  for (const at of [await around("0 microseconds"), await around("-1 microsecond")]) {
    await door.say("/move seen late-exec 1", { at })
    expect(door.posts.at(-1), at).toContain("sent before the interruption it names was shown")
    expect(await stageOf(t), at).toMatchObject({ stage: "awaiting_owner", acknowledged_failures: [] })
  }
  expect(await frozen()).toBe(before)

  // The words that name it, sent a microsecond after it, acknowledge it: back to waiting, the hold exactly as it was, nothing replayed, the gate kept.
  const said = await door.say("/move seen late-exec 1", { at: await around("1 microsecond") })
  expect(await stageOf(t)).toMatchObject({ stage: "waiting", failure: null, acknowledged_failures: [{ execution: "late-exec", revision: 1, by: OWNER }] })
  expect(door.posts.at(-1)).toContain("the interrupted work was not resumed, released or replayed")
  expect(await hold("late-exec")).toMatchObject([{ state: "held", choice: null, revision: 1, continuation_id: null }])
  expect(await count(t.s, "inbound", "id like 'continue:%'")).toBe(0)
  expect(await openGates(t.s, t.topic.agent_id)).toEqual([`move:${made.id}`])

  // A NEW failure stands: the old words, said again as a new message or delivered again, never acknowledge it.
  await plant(t.s, t.topic, "new-exec", "interrupted")
  expect(await stageOf(t)).toMatchObject({ stage: "awaiting_owner", failure: { execution: "new-exec", revision: 1 } })
  const posted = door.posts.length
  await door.take(said)
  expect(door.posts, "a redelivery says nothing twice").toHaveLength(posted)
  await door.say("/move seen late-exec 1")
  expect(door.posts.at(-1)).toContain("That interruption was already acknowledged, and the move now stands on another one")
  expect(door.posts.at(-1)).toContain("/move seen new-exec 1")
  const standing = await stageOf(t)
  expect(standing).toMatchObject({ stage: "awaiting_owner", failure: { execution: "new-exec", revision: 1 }, acknowledged_failures: [{ execution: "late-exec" }] })
  expect((standing.acknowledged_failures as unknown[])).toHaveLength(1)
  expect(await hold("new-exec")).toMatchObject([{ state: "held", choice: null }])
  // A turn that is owned refuses the answer and records nothing; it is refused again the same way and then goes through with the same words.
  await plant(t.s, t.topic, "turn-9", "running")
  const blocked = await door.say("/move seen new-exec 1")
  expect(door.posts.at(-1)).toContain("send /move seen new-exec 1 here again once it has ended")
  expect((await stageOf(t)).acknowledged_failures).toHaveLength(1)
  await settle(t.s, "turn-9")
  await door.take(blocked)
  expect(await stageOf(t)).toMatchObject({ stage: "waiting", failure: null })
  expect((await stageOf(t)).acknowledged_failures).toHaveLength(2)
})

test("an acknowledgement acts on the move it was sent after: a message older than the open move is refused as such, compared by the database at the precision it holds, and one newer is bound to it; a withdrawal names its move and is not decided by its time", async () => {
  const t = await staged()
  const made = await askMove(t)
  const door = doorOf(t)
  // The move keeps what was frozen when it was requested (`created_at` included: the store refuses to change it), so the boundary is built from the
  // instant the database actually stored, at its own microsecond precision, and the platform's message times are offsets from THAT instant.
  const around = async (offset: string): Promise<string> => {
    const [row] = rows(await t.s.admin.unsafe(
      `select to_char((created_at + $2::interval) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as at from topic_move where id = $1`, [String(made.id), offset]))
    return String(row.at)
  }
  const refusedAs = async (at: string) => {
    const posted = door.posts.length
    await door.say("/move seen late-exec 1", { at })
    expect(door.posts, at).toHaveLength(posted + 1)
    expect(door.posts.at(-1), at).toContain("older than the move it would act on")
    expect(door.posts.at(-1), at).toContain("nothing was changed")
    expect(await stageOf(t), at).toMatchObject({ id: made.id, stage: "waiting" })
    expect(await openGates(t.s, t.topic.agent_id), at).toEqual([`move:${made.id}`])
  }
  // The very instant the move was made, and the microsecond before it, are not after it.
  const same = await around("0 microseconds")
  expect(same).toMatch(/\.\d{6}Z$/)
  await refusedAs(same)
  await refusedAs(await around("-1 microsecond"))
  // A time in no zone is not read at all: it is not after anything, and nothing is parsed here that the database does not parse.
  await refusedAs("2999-01-01 00:00:01")
  // The next microsecond is after it, though a millisecond reading of both is the same instant: it is bound to the move, and then refused for what it
  // names (the move is not waiting on that interruption), not as older.
  const after = await around("1 microsecond")
  await door.say("/move seen late-exec 1", { at: after })
  expect(door.posts.at(-1)).toContain("nothing to acknowledge")
  expect(await stageOf(t)).toMatchObject({ id: made.id, stage: "waiting" })
  // A withdrawal is about the move it names and about nothing else, so the time of the message decides nothing about it: even one stamped at the
  // very instant the move was made withdraws exactly that move.
  await door.say(withdrawing(made.id), { at: same })
  expect(await stageOf(t)).toMatchObject({ id: made.id, stage: "withdrawn" })
  expect(door.posts.at(-1)).toContain("was withdrawn")
  expect(door.posts).toHaveLength(5)
})

test("a redelivered or old `/move withdraw <move-id>` never acts on a NEWER move: the one it withdrew is answered as that move, one that was refused for it stays about it whatever its time says, and neither touches the new move", async () => {
  const t = await staged()
  await plant(t.s, t.topic, "turn-1", "running")
  const first = await askMove(t)
  const door = doorOf(t)
  // Refused while the turn finishes: nothing applied, but the message is bound to this move. Its platform time is intentionally AHEAD of the database's,
  // so no later move can look older than it. Then the same owner withdraws with a later message once it has ended.
  const refused = await door.say(withdrawing(first.id), { at: later(60_000) })
  expect(door.posts.at(-1)).toContain("still finishing")
  expect(await count(t.s, "state_row", `sheet = 'move_command' and data -> 'target' ->> 'move' = '${first.id}'`)).toBe(1)
  expect(await count(t.s, "state_row", "sheet = 'move_command_done'")).toBe(0)
  await settle(t.s, "turn-1")
  const applied = await door.say(withdrawing(first.id))
  expect(await stageOf(t)).toMatchObject({ id: first.id, stage: "withdrawn" })
  const withdrawnEvidence = (rows(await moves(t.s))[0].evidence as { withdrawn: unknown }).withdrawn

  // A NEW move is asked for. It is the one open now.
  const second = await askMove(t)
  expect(second.id).not.toBe(first.id)
  const posted = door.posts.length
  // The platform delivers the message that withdrew the first move again: it is that withdrawal and nothing else.
  await door.take(applied)
  expect(await stageOf(t)).toMatchObject({ id: second.id, stage: "waiting" })
  expect(await openGates(t.s, t.topic.agent_id)).toEqual([`move:${second.id}`])
  expect(door.posts).toHaveLength(posted)
  // And the message that was refused, and never applied, is still about the FIRST move, which is withdrawn: it is answered as that and the new move is untouched.
  await door.take(refused)
  expect(await stageOf(t)).toMatchObject({ id: second.id, stage: "waiting" })
  expect(await openGates(t.s, t.topic.agent_id)).toEqual([`move:${second.id}`])
  expect(door.posts.at(-1)).toContain("was withdrawn")
  expect(await count(t.s, "outbox", `notice_key like 'topic-move:${second.id}:%'`)).toBe(0)
  expect(rows(await moves(t.s))[0].evidence).toMatchObject({ withdrawn: withdrawnEvidence })
  expect((await stageOf(t)).evidence).not.toHaveProperty("withdrawn")
  // The new move is withdrawn by a message sent after it, and by nothing else.
  const last = await door.say(withdrawing(second.id))
  expect(await stageOf(t)).toMatchObject({ id: second.id, stage: "withdrawn" })
  // Each move's own evidence names the one message that withdrew it: the first move's the message that applied (not the one that was refused, and
  // not its redelivery's effect on anything), the second's the later one. A message is bound to a move by the row its evidence is kept on.
  expect(rows(await moves(t.s)).map(row => [idOf(row), (row.evidence as { withdrawn: { message: string } }).withdrawn.message]))
    .toEqual([[idOf(first), door.logId(applied)], [idOf(second), door.logId(last)]])
  expect(door.logId(refused)).not.toBe(door.logId(applied))
})

test("crash boundaries: the withdrawal committed and nothing was said is answered from the move's own evidence without a second withdrawal; nothing committed is applied once", async () => {
  const t = await staged()
  const made = await askMove(t, "general")
  const door = doorOf(t)
  const m = door.message(withdrawing(made.id))
  // The process died AFTER the store committed the withdrawal and BEFORE the door wrote or posted anything.
  await answerMoveCommand(t.s.as("hub_door"), { registry: loadRegistry(t.s.registryFile), person: PERSON, door: DOOR, chat: m.chat, agent: t.topic.agent_id,
    sender: OWNER, message: door.logId(m), at: m.at, command: { verb: "withdraw", move: String(made.id) } })
  expect(await stageOf(t)).toMatchObject({ stage: "withdrawn" })
  const noticed = await count(t.s, "outbox", `notice_key = 'topic-move:${made.id}:withdrawn'`)
  expect(noticed).toBe(1)
  expect(door.posts).toEqual([])
  // The platform delivers it again: said once, from what the store recorded, and the store is not asked to withdraw anything.
  await door.take(m)
  expect(door.posts).toHaveLength(1)
  expect(door.posts[0]).toContain("was withdrawn")
  await door.take(m)
  expect(door.posts).toHaveLength(1)
  expect(await count(t.s, "outbox", `notice_key = 'topic-move:${made.id}:withdrawn'`)).toBe(1)

  // The process died after the door wrote the owner's line and BEFORE it acted: the line is the record of the message and not of an action, so the
  // command is still applied, exactly once.
  const next = await askMove(t, "general")
  const lost = door.message(withdrawing(next.id))
  await appendChatLineOnce({ stateDir: t.s.dir, person: PERSON, agent: t.topic.agent_id }, { id: door.logId(lost), at: lost.at, direction: "in", from: PERSON, text: lost.text })
  expect(await stageOf(t)).toMatchObject({ id: next.id, stage: "waiting" })
  await door.take(lost)
  await door.take(lost)
  expect(await stageOf(t)).toMatchObject({ id: next.id, stage: "withdrawn" })
  expect(door.posts).toHaveLength(2)
  expect(await count(t.s, "outbox", `notice_key = 'topic-move:${next.id}:withdrawn'`)).toBe(1)
})

/** The command as the door hands it to the store, for a test that has to stop between the binding and the action. */
function requestOf(t: Stage, door: ReturnType<typeof doorOf>, m: PlatformMessage, move: unknown, over: Partial<Parameters<typeof answerMoveCommand>[1]> = {}) {
  return { registry: loadRegistry(t.s.registryFile), person: PERSON, door: DOOR, chat: m.chat, agent: t.topic.agent_id, sender: OWNER,
    message: door.logId(m), at: m.at, command: { verb: "withdraw", move: String(move) } as const, ...over }
}

// THE RACES BELOW ARE REAL ONES. `t.s.as("hub_door")` is one cached connection of one backend (`max: 1`), so deliveries sent down it queue and run a whole
// transaction at a time and race nothing. Each delivery here has a connection, and so a backend, of its own (asserted by pid), and the overlap is not left to
// scheduling: a superuser transaction on a connection of its own holds the very thing the deliveries need next, the deliveries are started, the check waits
// (bounded, from `pg_stat_activity` and `pg_locks`) until every one of them is blocked on it, looks at what is and is not written meanwhile, and only then lets go.

type LockType = "relation" | "transactionid" | "tuple"
/** What a blocked delivery looks like from the server: the statement it is stopped in (a LIKE pattern) and the kind of lock it is waiting for. */
interface Waiting { query: string; locks: LockType[] }
interface Reserved { unsafe(query: string, values?: unknown[]): Promise<unknown>; release(): void | Promise<void> }

const pidOf = (store: StoreLike): Promise<number> => backendPid(store.sql as unknown as { unsafe(query: string): Promise<unknown> })

/**
 * A superuser transaction that runs one statement and keeps what it took until `release()`. It has a reserved connection of its own (the stage's admin
 * connection stays free to look), and `release()` never throws and may be called twice: it rolls the transaction back (it wrote nothing), hands the
 * connection back and closes the client, whatever state the setup stopped in.
 */
async function holdOpen(s: TopicsStage, statement: string, values: unknown[] = []): Promise<{ pid: number; release(): Promise<void> }> {
  const client = s.cluster.connect(s.db) as unknown as { reserve(): Promise<Reserved>; close(): Promise<void> }
  let held: Reserved | null = null
  let began = false
  const release = async (): Promise<void> => {
    const one = held
    held = null
    if (one !== null) {
      if (began) await one.unsafe("rollback").catch(() => {})
      began = false
      await Promise.resolve(one.release()).catch(() => {})
    }
    await client.close().catch(() => {})
  }
  try {
    held = await client.reserve()
    const pid = await backendPid(held)
    await held.unsafe("begin")
    began = true
    await held.unsafe(statement, values)
    return { pid, release }
  } catch (error) {
    await release()
    throw error
  }
}

/** The backends among `pids` that are stopped on a lock of that kind, in a statement of that shape, as the server reports them now. */
async function lockWaiters(s: TopicsStage, pids: number[], waiting: Waiting): Promise<Record<string, unknown>[]> {
  const list = pids.map(Number).join(", ")
  const kinds = waiting.locks.map(kind => `'${kind}'`).join(", ")
  return rows(await s.admin.unsafe(
    `select a.pid, a.wait_event_type, l.locktype, left(a.query, 100) as query
       from pg_stat_activity a join pg_locks l on l.pid = a.pid and not l.granted
      where a.pid in (${list}) and a.wait_event_type = 'Lock' and l.locktype in (${kinds}) and a.query like $1
      order by a.pid`, [waiting.query]))
}

/**
 * Starts every delivery at once, each on a connection of its own, behind a lock the check holds; waits until all of them are blocked on it; runs
 * `whileBlocked` (what is and is not written while they wait); and releases. The barrier, the waits and the clients are cleaned up in a `finally`, and
 * every started delivery is awaited to its end before this returns or throws, so a failed check leaves no lock held and no delivery running.
 */
async function raceBehind<T>(
  t: Stage,
  hold: { statement: string; values?: unknown[] },
  waiting: Waiting,
  deliveries: ((store: StoreLike) => Promise<T>)[],
  whileBlocked: () => Promise<void>,
): Promise<T[]> {
  const stores = deliveries.map(() => t.s.fresh("hub_door"))
  let barrier: { pid: number; release(): Promise<void> } | null = null
  let runs: Promise<PromiseSettledResult<T>[]> = Promise.resolve([])
  let settled: PromiseSettledResult<T>[] = []
  let finished = 0
  try {
    const pids: number[] = []
    for (const store of stores) pids.push(await pidOf(store))
    expect(new Set(pids).size, `distinct backends: ${pids.join(", ")}`).toBe(stores.length)
    barrier = await holdOpen(t.s, hold.statement, hold.values)
    expect(pids, "the barrier is not one of the deliveries").not.toContain(barrier.pid)
    runs = Promise.allSettled(deliveries.map((go, i) => go(stores[i]).finally(() => { finished += 1 })))
    const blocked = async () => await lockWaiters(t.s, pids, waiting)
    await until("every delivery blocked on the barrier", async () => (await blocked()).length === pids.length, 15_000,
      async () => `${finished} of ${pids.length} finished; blocked now: ${JSON.stringify(await blocked())}`)
    expect(finished, "no delivery got past the barrier").toBe(0)
    await whileBlocked()
  } finally {
    await barrier?.release()
    settled = await runs
    for (const store of stores) await store.sql.close().catch(() => {})
  }
  const failed = settled.find((one): one is PromiseRejectedResult => one.status === "rejected")
  if (failed !== undefined) throw failed.reason
  return settled.map(one => (one as PromiseFulfilledResult<T>).value)
}

/** The state row a message's receipt is kept under (the agent and the message id, as the door keys it). */
const receiptKeyOf = (t: Stage, door: ReturnType<typeof doorOf>, m: PlatformMessage): string => JSON.stringify([t.topic.agent_id, door.logId(m)])
const rowsOf = async (s: TopicsStage, sheet: string, key: string): Promise<number> =>
  Number((await s.admin.unsafe("select count(*)::int as n from state_row where sheet = $1 and id = $2", [sheet, key]))[0].n)

test("two deliveries of one command that reach the receipt at once, each on its own backend, write one receipt, one result, one withdrawal and one notice", async () => {
  const t = await staged()
  const made = await askMove(t, "general")
  const door = doorOf(t)
  const m = door.message(withdrawing(made.id))
  // `share` conflicts with the insert of the receipt and not with a read: both deliveries read, find no receipt, and stop in the same insert.
  const answers = await raceBehind(t, { statement: "lock table state_row in share mode" }, { query: "insert into state_row%", locks: ["relation"] },
    [1, 2].map(() => (store: StoreLike) => answerMoveCommand(store, requestOf(t, door, m, made.id))),
    async () => {
      expect(await count(t.s, "state_row", "sheet = 'move_command'")).toBe(0)
      expect(await count(t.s, "state_row", "sheet = 'move_command_done'")).toBe(0)
      expect(await stageOf(t)).toMatchObject({ id: made.id, stage: "waiting" })
    })
  expect(answers.map(one => one.key)).toEqual(["withdrawn", "withdrawn"])
  expect(await stageOf(t)).toMatchObject({ id: made.id, stage: "withdrawn" })
  expect(await count(t.s, "state_row", "sheet = 'move_command'")).toBe(1)
  expect(await rowsOf(t.s, "move_command", receiptKeyOf(t, door, m))).toBe(1)
  expect(await rowsOf(t.s, "move_command_done", receiptKeyOf(t, door, m))).toBe(1)
  expect(await count(t.s, "state_row", "sheet = 'move_command_done'")).toBe(1)
  expect(await count(t.s, "outbox", `notice_key = 'topic-move:${made.id}:withdrawn'`)).toBe(1)
  expect((await stageOf(t)).evidence).toMatchObject({ withdrawn: { message: door.logId(m) } })
  expect(await openGates(t.s, t.topic.agent_id)).toEqual([])
})

test("three deliveries of one bound command that act at once, each on its own backend, wait on the receipt's row and then withdraw once", async () => {
  const t = await staged()
  const made = await askMove(t, "general")
  const door = doorOf(t)
  const m = door.message(withdrawing(made.id))
  // Bound and committed first: every delivery below finds the receipt and goes straight to the action, which takes the receipt's row first.
  const receipt = await bindMoveCommand(t.s.as("hub_door"), requestOf(t, door, m, made.id), { verb: "withdraw", move: String(made.id) })
  expect(receipt).toMatchObject({ target: { move: made.id, why: null } })
  const key = receiptKeyOf(t, door, m)
  expect(await rowsOf(t.s, "move_command", key)).toBe(1)
  const answers = await raceBehind(t, { statement: "select 1 from state_row where sheet = $1 and id = $2 for update", values: [MOVE_COMMAND_SHEET, key] },
    { query: "%from state_row%for update%", locks: ["transactionid", "tuple"] },
    [1, 2, 3].map(() => (store: StoreLike) => answerMoveCommand(store, requestOf(t, door, m, made.id))),
    async () => {
      expect(await stageOf(t)).toMatchObject({ id: made.id, stage: "waiting" })
      expect(await rowsOf(t.s, "move_command_done", key)).toBe(0)
      expect(await count(t.s, "outbox", `notice_key = 'topic-move:${made.id}:withdrawn'`)).toBe(0)
    })
  expect(answers.map(one => one.key)).toEqual(["withdrawn", "withdrawn", "withdrawn"])
  expect(await stageOf(t)).toMatchObject({ id: made.id, stage: "withdrawn" })
  expect(await count(t.s, "state_row", "sheet = 'move_command'")).toBe(1)
  expect(await rowsOf(t.s, "move_command_done", key)).toBe(1)
  expect(await count(t.s, "state_row", "sheet = 'move_command_done'")).toBe(1)
  expect(await count(t.s, "outbox", `notice_key = 'topic-move:${made.id}:withdrawn'`)).toBe(1)
  expect((await stageOf(t)).evidence).toMatchObject({ withdrawn: { message: door.logId(m) } })
  expect(await openGates(t.s, t.topic.agent_id)).toEqual([])
})

test("two different messages bound to one move, then acted on at once on their own backends: the store withdraws it once and answers the other as the replay, both accounted for on that move", async () => {
  const t = await staged()
  const made = await askMove(t, "general")
  const door = doorOf(t)
  const [a, b] = [door.message(withdrawing(made.id)), door.message(withdrawing(made.id))]
  // BOTH ARE BOUND BEFORE EITHER ACTS, so neither can bind to nothing because the other withdrew first: the race is between the two actions only.
  for (const one of [a, b]) {
    expect(await bindMoveCommand(t.s.as("hub_door"), requestOf(t, door, one, made.id), { verb: "withdraw", move: String(made.id) })).toMatchObject({ target: { move: made.id, why: null } })
  }
  const [keyA, keyB] = [receiptKeyOf(t, door, a), receiptKeyOf(t, door, b)]
  expect(keyA).not.toBe(keyB)
  expect(await count(t.s, "state_row", "sheet = 'move_command'")).toBe(2)
  expect(await count(t.s, "state_row", "sheet = 'move_command_done'")).toBe(0)
  // Each action starts by taking its own receipt's row; holding both rows lets both be started and both be stopped there, and releasing starts both together.
  const answers = await raceBehind(t, { statement: "select 1 from state_row where sheet = $1 and id in ($2, $3) for update", values: [MOVE_COMMAND_SHEET, keyA, keyB] },
    { query: "%from state_row%for update%", locks: ["transactionid", "tuple"] },
    [a, b].map(one => (store: StoreLike) => answerMoveCommand(store, requestOf(t, door, one, made.id))),
    async () => {
      expect(await stageOf(t)).toMatchObject({ id: made.id, stage: "waiting" })
      expect(await count(t.s, "state_row", "sheet = 'move_command_done'")).toBe(0)
    })
  expect(answers.map(one => one.key)).toEqual(["withdrawn", "withdrawn"])
  expect(await stageOf(t)).toMatchObject({ id: made.id, stage: "withdrawn" })
  expect(await count(t.s, "state_row", "sheet = 'move_command'")).toBe(2)
  for (const key of [keyA, keyB]) {
    expect(await rowsOf(t.s, "move_command", key)).toBe(1)
    expect(await rowsOf(t.s, "move_command_done", key)).toBe(1)
  }
  expect(await count(t.s, "state_row", `sheet = 'move_command_done' and data ->> 'move' = '${made.id}'`)).toBe(2)
  expect(await count(t.s, "state_row", "sheet = 'move_command_done'")).toBe(2)
  expect(await count(t.s, "outbox", `notice_key = 'topic-move:${made.id}:withdrawn'`)).toBe(1)
  // One of the two withdrew it, and only one: the move's evidence names exactly one message.
  expect([door.logId(a), door.logId(b)]).toContain(((await stageOf(t)).evidence as { withdrawn: { message: string } }).withdrawn.message)
  expect(await openGates(t.s, t.topic.agent_id)).toEqual([])
})

test("a crash after the binding and before the action leaves the receipt and nothing else, and the redelivery acts on the bound move only", async () => {
  const t = await staged()
  const first = await askMove(t, "general")
  const door = doorOf(t)
  // Bound, committed, and the process died: the receipt names the move that was open, and nothing was applied or recorded as applied.
  const lost = door.message(withdrawing(first.id), { at: later(60_000) })
  const receipt = await bindMoveCommand(t.s.as("hub_door"), requestOf(t, door, lost, first.id), { verb: "withdraw", move: String(first.id) })
  expect(receipt).toMatchObject({ sender: OWNER, command: { verb: "withdraw", move: first.id }, target: { move: first.id, why: null, failure: null } })
  expect(await stageOf(t)).toMatchObject({ id: first.id, stage: "waiting" })
  expect(await count(t.s, "state_row", "sheet = 'move_command_done'")).toBe(0)
  // Another message withdraws that move and a new one is asked for before the first message is delivered again.
  await door.say(withdrawing(first.id))
  const second = await askMove(t, "general")
  await door.take(lost)
  expect(await stageOf(t)).toMatchObject({ id: second.id, stage: "waiting" })
  expect(await openGates(t.s, t.topic.agent_id)).toEqual([`move:${second.id}`])

  // A message bound to the second move, and lost the same way, withdraws exactly that move when it comes again, once.
  const bound = door.message(withdrawing(second.id))
  await bindMoveCommand(t.s.as("hub_door"), requestOf(t, door, bound, second.id), { verb: "withdraw", move: String(second.id) })
  expect(await stageOf(t)).toMatchObject({ id: second.id, stage: "waiting" })
  await door.take(bound)
  await door.take(bound)
  expect(await stageOf(t)).toMatchObject({ id: second.id, stage: "withdrawn" })
  expect(await count(t.s, "outbox", `notice_key = 'topic-move:${second.id}:withdrawn'`)).toBe(1)
})

test("a message bound to no move stays bound to none, and a receipt is the message's own: another person, sender, time, move or command under its id is refused, not taken as a new choice", async () => {
  const t = await staged()
  const door = doorOf(t)
  // It names no move of this chat: the receipt says so, and a move asked for afterwards is not reached by the same message.
  const early = door.message(withdrawing("no-such-move"))
  await door.take(early)
  expect(door.posts.at(-1)).toContain("not a move of this chat")
  const made = await askMove(t, "general")
  await door.take(early)
  expect(await stageOf(t)).toMatchObject({ id: made.id, stage: "waiting" })
  expect(await openGates(t.s, t.topic.agent_id)).toEqual([`move:${made.id}`])

  // The same message id, said again by someone else or as something else, is not the message that was bound.
  const m = door.message(withdrawing(made.id))
  await bindMoveCommand(t.s.as("hub_door"), requestOf(t, door, m, made.id), { verb: "withdraw", move: String(made.id) })
  for (const over of [{ person: "someone-else" }, { sender: STRANGER }, { at: later(120_000) }, { door: "another-door" }, { command: { verb: "seen", attempt: "x", revision: 1 } as const },
    { command: { verb: "withdraw", move: "another-move" } as const }]) {
    const answer = await answerMoveCommand(t.s.as("hub_door"), requestOf(t, door, m, made.id, over))
    expect(answer.key, JSON.stringify(over)).toBe("message_conflict")
    expect(await stageOf(t), JSON.stringify(over)).toMatchObject({ id: made.id, stage: "waiting" })
  }
  expect(await count(t.s, "state_row", "sheet = 'move_command_done'")).toBe(0)
  expect(await count(t.s, "state_row", "sheet = 'move_command'")).toBe(2)
  // The message itself is still applied.
  await door.take(m)
  expect(await stageOf(t)).toMatchObject({ id: made.id, stage: "withdrawn" })
})

test("D8 the Russian verbs work and the door answers in Russian", async () => {
  const t = await staged({ language: "ru" })
  const made = await askMove(t)
  const door = doorOf(t)
  await door.say("/перенос")
  expect(door.posts[0].startsWith("[дверь] Ждём mac:")).toBe(true)
  expect(door.posts[0]).toContain(`/перенос отозвать ${made.id}`)
  expect(door.posts[0]).not.toMatch(/\/move/)
  await plant(t.s, t.topic, "late-exec", "interrupted")
  await door.say("/перенос")
  expect(door.posts[1]).toContain("Напишите /перенос принято late-exec 1 здесь")
  await door.say("/перенос принято late-exec 1")
  expect(await stageOf(t)).toMatchObject({ stage: "waiting", acknowledged_failures: [{ execution: "late-exec", revision: 1 }] })
  expect(door.posts[2].startsWith("[дверь] ")).toBe(true)
  expect(door.posts[2]).toContain("прерванная работа не возобновлялась")
  // The bare Russian withdrawal is a reading: it shows the exact command, and nothing is bound or changed.
  await door.say("/перенос отозвать")
  expect(await stageOf(t)).toMatchObject({ id: made.id, stage: "waiting" })
  expect(door.posts[3].startsWith("[дверь] ")).toBe(true)
  expect(door.posts[3]).toContain(`отправив /перенос отозвать ${made.id} здесь`)
  expect(await count(t.s, "state_row", "sheet = 'move_command'")).toBe(1)
  expect(await openGates(t.s, t.topic.agent_id)).toEqual([`move:${made.id}`])
  await door.say(`/перенос отозвать ${made.id}`)
  expect(await stageOf(t)).toMatchObject({ id: made.id, stage: "withdrawn" })
  expect(door.posts[4]).toContain("отозван")
  expect(await openGates(t.s, t.topic.agent_id)).toEqual([])
})

test("D9 General is the chat being moved and nothing of it runs: `/move` and `/move withdraw <move-id>` work in General's own chat", async () => {
  const t = await staged()
  // General asks to move itself. No runner, and no other chat, is started or needed from here on.
  const said = await t.s.said("move this chat to the mac", { agent: GENERAL })
  const reply = await callTool(t.general, "hub_topic", { request_key: `self-${++counter}`, source_message_ids: [said], action: "move", destination_machine: "mac" }) as Record<string, unknown>
  expect(reply).toMatchObject({ status: "accepted", stage: "move_requested" })
  const [row] = rows(await moves(t.s))
  expect(row).toMatchObject({ agent: GENERAL, stage: "waiting" })
  const door = doorOf(t, GENERAL)
  await door.say("/move")
  expect(door.posts[0].startsWith("[door] Waiting for mac:")).toBe(true)
  expect(door.posts[0]).toContain(`<#${t.s.general}>`)
  expect(door.posts[0]).toContain(`by sending ${withdrawing(row.id)} here`)
  expect(await openGates(t.s, GENERAL)).toEqual([`move:${row.id}`])
  await door.say(withdrawing(row.id))
  expect(await stageOf(t)).toMatchObject({ agent: GENERAL, stage: "withdrawn" })
  expect(await openGates(t.s, GENERAL)).toEqual([])
  expect(door.posts[1]).toContain("was withdrawn")
})

test("a withdrawal for move A first taken after A was withdrawn and move B was made cannot touch B, even stamped ahead of it: it is answered as A, the bare words only read B's status, and the command that names B works", async () => {
  const t = await staged()
  const a = await askMove(t, "general")
  const door = doorOf(t)
  // W is for A and was sent, ahead of everything by its own clock, but this door has not taken it: no receipt, so nothing is bound or ingested yet.
  const w = door.message(withdrawing(a.id), { at: later(60_000) })
  const bare = door.message("/move withdraw", { at: later(60_000) })
  expect(await count(t.s, "state_row", "sheet = 'move_command'")).toBe(0)
  expect(await rowsOf(t.s, "move_command", receiptKeyOf(t, door, w))).toBe(0)
  // Another message withdraws A, and B is asked for.
  await door.say(withdrawing(a.id))
  expect(await stageOf(t)).toMatchObject({ id: a.id, stage: "withdrawn" })
  const b = await askMove(t, "general")
  expect(b.id).not.toBe(a.id)
  const receipts = await count(t.s, "state_row", "sheet = 'move_command'")
  const frozen = async () => JSON.stringify([await stageOf(t), await openGates(t.s, t.topic.agent_id), await count(t.s, "outbox", `notice_key like 'topic-move:${b.id}:%'`)])
  const before = await frozen()
  // W is taken for the first time. Its time compares after B's creation, but it names A: it is bound to A and answered as A, and B is exactly as it was.
  await door.take(w)
  expect(await frozen()).toBe(before)
  expect(await stageOf(t)).toMatchObject({ id: b.id, stage: "waiting" })
  expect(await openGates(t.s, t.topic.agent_id)).toEqual([`move:${b.id}`])
  expect((await stageOf(t)).evidence).not.toHaveProperty("withdrawn")
  const [receipt] = rows(await t.s.admin.unsafe("select data from state_row where sheet = $1 and id = $2", [MOVE_COMMAND_SHEET, receiptKeyOf(t, door, w)]))
  expect(receipt.data).toMatchObject({ command: { verb: "withdraw", move: a.id }, target: { move: a.id, why: null } })
  expect(door.posts.at(-1)).toContain("was withdrawn")
  // The bare words, taken the same way, only read B's status, with the exact command; nothing is bound or changed.
  await door.take(bare)
  expect(await frozen()).toBe(before)
  expect(await count(t.s, "state_row", "sheet = 'move_command'")).toBe(receipts + 1)
  expect(await rowsOf(t.s, "move_command", receiptKeyOf(t, door, bare))).toBe(0)
  expect(door.posts.at(-1)).toContain(`by sending ${withdrawing(b.id)} here`)
  // The command that names B is the one that withdraws B.
  await door.say(withdrawing(b.id))
  expect(await stageOf(t)).toMatchObject({ id: b.id, stage: "withdrawn" })
  expect(await openGates(t.s, t.topic.agent_id)).toEqual([])
  expect(door.posts.at(-1)).toContain("was withdrawn")
})

test("the bare `/move withdraw` never changes a move, however it is stamped: it says where the move stands with the exact command, binds nothing, and a redelivery says nothing twice", async () => {
  const t = await staged()
  const made = await askMove(t)
  const door = doorOf(t)
  const bare = await door.say("/move withdraw")
  await door.say("/move withdraw", { at: later(60_000) })
  expect(door.posts).toHaveLength(2)
  for (const post of door.posts) {
    expect(post.startsWith("[door] Waiting for mac:")).toBe(true)
    expect(post).toContain(`by sending ${withdrawing(made.id)} here`)
  }
  expect(await stageOf(t)).toMatchObject({ id: made.id, stage: "waiting" })
  expect(await openGates(t.s, t.topic.agent_id)).toEqual([`move:${made.id}`])
  expect(await count(t.s, "state_row", "sheet like 'move_command%'")).toBe(0)
  expect(await count(t.s, "outbox", "notice_key like 'topic-move:%'")).toBe(0)
  expect(await count(t.s, "inbound", `id like 'fake:%'`)).toBe(0)
  await door.take(bare)
  expect(door.posts).toHaveLength(2)
  // With no move open it says so, the same way as `/move`.
  await door.say(withdrawing(made.id))
  await door.say("/move withdraw")
  expect(door.posts.at(-1)).toBe("[door] Nothing is being moved in this chat.")
})

test("a withdrawal names a move of THIS chat and nothing else: another agent's move and an id that is no move are bound to none, answered alike, and change nothing", async () => {
  const t = await staged()
  const here = await askMove(t)
  // General moves itself: its move is open too, and is not this chat's.
  const said = await t.s.said("move this chat to the mac", { agent: GENERAL })
  const reply = await callTool(t.general, "hub_topic", { request_key: `self-${++counter}`, source_message_ids: [said], action: "move", destination_machine: "mac" }) as Record<string, unknown>
  expect(reply).toMatchObject({ status: "accepted" })
  const theirs = rows(await moves(t.s)).find(row => row.agent === GENERAL)!
  const door = doorOf(t)
  for (const id of [idOf(theirs), "no-such-move"]) {
    await door.say(withdrawing(id))
    expect(door.posts.at(-1), id).toContain("not a move of this chat")
  }
  expect(await count(t.s, "state_row", "sheet = 'move_command' and data -> 'target' ->> 'move' is null")).toBe(2)
  expect(await count(t.s, "state_row", "sheet = 'move_command_done'")).toBe(0)
  expect(rows(await moves(t.s)).map(row => [row.agent, row.stage])).toEqual([[t.topic.agent_id, "waiting"], [GENERAL, "waiting"]])
  expect(await openGates(t.s, t.topic.agent_id)).toEqual([`move:${here.id}`])
  expect(await openGates(t.s, GENERAL)).toEqual([`move:${theirs.id}`])
  // The id of this chat's own move is the one that works, and General's move is still untouched.
  await door.say(withdrawing(here.id))
  expect(rows(await moves(t.s)).map(row => [row.agent, row.stage])).toEqual([[t.topic.agent_id, "withdrawn"], [GENERAL, "waiting"]])
  expect(await openGates(t.s, GENERAL)).toEqual([`move:${theirs.id}`])
})

test("a receipt written before the withdrawal named its move is never the message's own: even words that happen to match its shape are refused, and nothing is applied", async () => {
  const t = await staged()
  const made = await askMove(t)
  const door = doorOf(t)
  const m = door.message("/move withdraw undefined")
  // The old shape: the command carries no move, and the target was chosen by what was open.
  const old = { person: PERSON, agent: t.topic.agent_id, door: DOOR, chat: m.chat, sender: OWNER, at: m.at, command: { verb: "withdraw" }, target: { move: String(made.id), why: null, failure: null } }
  await t.s.admin.unsafe("insert into state_row (sheet, id, data) values ($1, $2, $3::jsonb)", [MOVE_COMMAND_SHEET, receiptKeyOf(t, door, m), JSON.stringify(old)])
  const answer = await answerMoveCommand(t.s.as("hub_door"), requestOf(t, door, m, "undefined"))
  expect(answer.key).toBe("message_conflict")
  await door.take(m)
  expect(door.posts.at(-1)).toContain("already taken as a different command")
  expect(await stageOf(t)).toMatchObject({ id: made.id, stage: "waiting" })
  expect(await openGates(t.s, t.topic.agent_id)).toEqual([`move:${made.id}`])
  expect(await count(t.s, "state_row", "sheet = 'move_command_done'")).toBe(0)
})
