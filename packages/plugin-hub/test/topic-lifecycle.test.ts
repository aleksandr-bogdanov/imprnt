// Archive and reopen as one operation whichever way it is asked for, and a chat that is gone.
//
// Real store, real door task, real tool handlers and the real Discord seam over a fake Discord.
// Time is the fake's clock. What is PLANTED, and decides nothing the code under test decides: a
// running attempt of the master (as the runner would have opened it), the runner's word that it
// stopped or could not prove it, and the edits a person makes in Discord's own app.

import { afterAll, afterEach, beforeAll, expect, test } from "bun:test"
import { startCluster, type Cluster } from "./helpers/cluster.ts"
import { closeStages, removeEffectDirs } from "./helpers/effects-fixture.ts"
import { DOOR, GENERAL, PERSON, RUNNER_PI, STRANGER, stageTopics, type TopicsStage } from "./helpers/topics-fixture.ts"
import { ToolError } from "../src/mcp/contracts.ts"
import { bindTopics } from "../src/hub/topics.ts"
import { loadRegistry } from "../src/registry/load.ts"
import { READONLY_MASK, type ArchivePlan } from "../src/door/archive-plan.ts"
import { topicFindings } from "../src/check/topics.ts"
import { newTopicsMemory, observedTransitionOf, runTopicPass } from "../src/door/topic-task.ts"
import { attentionDebtOf, attentionGapsOf, noteAttention, readTopic, rebindLegacyTopic, reserveIdentity, type TopicRow } from "../src/store/topics.ts"
import type { AgentSpec } from "./helpers/registry.ts"

let cluster: Cluster
beforeAll(async () => { cluster = await startCluster() })
afterEach(closeStages)
afterAll(async () => {
  removeEffectDirs()
  await cluster?.stop()
})

const REQUEST = "Compare the two vendors, and keep it short."
const MASK = READONLY_MASK.toString()
const count = async (s: TopicsStage, table: string, where = "true") =>
  Number((await s.admin.unsafe(`select count(*)::int as n from ${table} where ${where}`))[0].n)
const topicOf = async (s: TopicsStage, id: string): Promise<TopicRow> => (await readTopic(s.as("hub_hub"), id))!
const listings = (s: TopicsStage) => s.fake.requestsTo(new RegExp(`^GET /guilds/${s.fake.guild}/channels$`)).length
const code = async (run: Promise<unknown>): Promise<string> => {
  try { await run; return "no error" } catch (error) { return error instanceof ToolError ? error.code : `not a ToolError: ${(error as Error).message}` }
}

/** A topic taken all the way: asked for, confirmed by the owner's check, made, bound and announced. */
async function bound(s: TopicsStage, over: Record<string, unknown> = {}): Promise<TopicRow> {
  const master = await s.binding()
  const reply = await s.ask(master, { action: "create", setup: { chat_name: "coffee", initial_request: REQUEST, ...over } })
  await s.deliver()
  await s.react(String(reply.operation_id))
  await s.topicPass()
  await bindTopics({ store: s.as("hub_hub"), registryFile: s.registryFile, machine: "pi", load: () => loadRegistry(s.registryFile, { machine: "pi" }) })
  await s.topicPass()
  await s.deliver()
  return await topicOf(s, String(reply.object_id))
}

/** A running attempt of the topic's master, as a runner would have opened it. */
async function plantAttempt(s: TopicsStage, topic: TopicRow, state = "running") {
  await s.admin`insert into inbound (id, person, agent, body, kind) values ('planted-input', ${PERSON}, ${topic.agent_id}, 'working on it', 'human')`
  await s.admin`insert into execution (id, inbound_id, conversation_id, agent, runner, incarnation, placement_generation, state, input_digest)
    values ('planted-attempt', 'planted-input', ${topic.conversation_id}, ${topic.agent_id}, ${RUNNER_PI}, 'inc-1', 1, ${state}, 'd')`
}
const settle = (s: TopicsStage, state: string) =>
  s.admin`update execution set state = ${state}, ended_at = case when ${state} in ('stopped', 'interrupted') then now() else ended_at end where id = 'planted-attempt'`

/** One pass after the channel list is due again. */
async function later(s: TopicsStage, ms = 31_000) {
  s.fake.advance(ms)
  return await s.topicPass()
}

const noticeOf = async (s: TopicsStage, key: string) => (await s.admin`select agent, body, route from outbox where notice_key = ${key}`)[0]
const sorted = (entries: unknown[]) => [...(entries as { id: string }[])].sort((a, b) => (a.id < b.id ? -1 : 1))

/** The columns of `topic_transition` the two "moves" queries read; `Array.from` over a query result loses their types. */
type MoveRow = { id: string; kind: string; source: string; evidence: Record<string, unknown> }
type RequestedMoveRow = MoveRow & { requested_by: string }
type PlannedMoveRow = MoveRow & { channel_plan: ArchivePlan | null }

// The rows the route, disappearance and catch-up checks below read, typed once so no query result is read as anything wider.
/** One `topic_transition` of a topic: what `moves` reads, with its state. */
type RequestRow = { id: string; kind: string; state: string; stage: string; evidence: Record<string, unknown> }
/** One `claim_gate` row. */
type GateRow = { operation_id: string; state: string }
/** One queued notice as the outbox holds it. */
type QueuedRow = { notice_key: string; agent: string; body: string; route: { door: string; chat: string }; delivered_at: Date | null }
/** One line of the diary the door writes a failure to. */
type DiaryRow = { cause: string }
/** How the two timestamps a completed reopen and the last sample of the chat are ordered by compare: in the same millisecond, and which is later, as the store judges them. */
type StampRow = { same_millisecond: boolean; completed_later: boolean }

test("archive from General is one operation: the master is gated and stopped at once with no confirmation, the chat is moved and made read only, and it is archived only when both are shown", async () => {
  const s = await stageTopics(cluster)
  const topic = await bound(s)
  await plantAttempt(s, topic)
  const general = await s.binding()
  const confirmations = await count(s, "confirmation")
  const reply = await s.ask(general, { action: "archive", topic_id: topic.id })
  expect(reply).toMatchObject({ status: "stopping", stage: "archiving" })
  // The owner's explicit request is the whole of it: no preview, no second confirmation.
  expect(await count(s, "confirmation")).toBe(confirmations)
  // At the moment of the request, in that transaction: the gate is closed and the stop is asked for, with no drain.
  const op = String(reply.operation_id)
  expect((await s.admin`select scope_kind, scope_id, cause, state from claim_gate where operation_id = ${op}`)[0])
    .toEqual({ scope_kind: "agent", scope_id: topic.agent_id, cause: "archive", state: "open" })
  expect((await s.admin`select execution_id, state from stop_request where operation_id = ${op}`)[0]).toMatchObject({ execution_id: "planted-attempt", state: "requested" })
  expect((await topicOf(s, topic.id)).lifecycle).toBe("archiving")
  expect(s.fake.channel(topic.chat!)!.parent_id).toBeNull()

  // The door mirrors it: the archive category and a read-only overwrite for the named role, exactly.
  await s.topicPass()
  const channel = s.fake.channel(topic.chat!)!
  expect(channel.parent_id).toBe(s.archive)
  expect(channel.permission_overwrites).toEqual([{ id: s.everyone, type: 0, allow: "0", deny: MASK }])
  // The channel shows it and the attempt is still owned: it is NOT archived, and nothing says it is.
  expect((await topicOf(s, topic.id)).lifecycle).toBe("archiving")
  expect(await noticeOf(s, `topic:archive-done:${op}`)).toBeUndefined()

  // The runner shows the process gone: now, and only now, it is archived and said, once, in General.
  await settle(s, "stopped")
  await s.topicPass()
  await s.topicPass()
  expect((await topicOf(s, topic.id)).lifecycle).toBe("archived")
  const said = await noticeOf(s, `topic:archive-done:${op}`)
  expect(said.agent).toBe(GENERAL)
  expect(said.route).toEqual({ door: DOOR, chat: s.general })
  expect(said.body).toContain(`<#${topic.chat}> is archived`)
  expect(said.body).toContain("The agent is stopped")
  expect(said.body).toContain("Its history is kept")
  expect(await count(s, "outbox", `notice_key = 'topic:archive-done:${op}'`)).toBe(1)
  // History and holds are untouched: nothing was stamped answered, and the stopped input stays held.
  expect(await count(s, "conversation", `id = '${topic.conversation_id}'`)).toBe(1)
  expect((await s.admin`select hub_row_held('planted-input') as held`)[0].held).toBe(true)
  // Asking again is the same answer and starts nothing.
  expect(await s.ask(general, { action: "archive", topic_id: topic.id })).toMatchObject({ status: "complete", stage: "already_archived" })
  expect(await count(s, "topic_transition", `topic_id = '${topic.id}'`)).toBe(1)
})

test("asked in the chat itself it is the same operation, the chat's master is stopped without it seeing the answer, and the notice goes where the person can read it: General", async () => {
  const s = await stageTopics(cluster)
  // Another chat of the same person, that exists on the server (the door watches every ordinary master it finds, and a chat that is not there is a chat that is gone).
  const otherChat = s.fake.addChannel({ name: "other" })
  s.rewrite({ agents: [{ id: "p1-other", person: PERSON, preset: "daily", chat: otherChat, door: DOOR, runner: RUNNER_PI }] })
  const topic = await bound(s)
  await plantAttempt(s, topic)
  const own = await s.binding(topic.agent_id)
  // Another chat of the same person is neither this topic's own chat nor General: it may not archive it.
  const other = await s.binding("p1-other")
  expect(await s.ask(other, { action: "archive", topic_id: topic.id })).toMatchObject({ status: "failed", cause: "not_permitted" })
  expect(await count(s, "claim_gate")).toBe(0)
  // A chat of another topic asked to archive itself is about itself, and nothing else.
  const reply = await s.ask(own, { action: "archive" })
  expect(reply).toMatchObject({ status: "stopping", object_id: topic.id })
  await s.topicPass()
  await settle(s, "stopped")
  await s.topicPass()
  expect((await topicOf(s, topic.id)).lifecycle).toBe("archived")
  const said = await noticeOf(s, `topic:archive-done:${reply.operation_id}`)
  // Not into the chat that was just made read only.
  expect(said.route).toEqual({ door: DOOR, chat: s.general })
  expect(said.agent).toBe(GENERAL)
})

test("an archive cannot be asked for without the owner's words, by a stranger, or where the door has no archive mapping", async () => {
  const s = await stageTopics(cluster, { door: { archive_category: undefined, archive_readonly_roles: undefined } })
  const topic = await bound(s)
  const general = await s.binding()
  // No mapping: refused by name before anything is gated or stopped.
  expect(await s.ask(general, { action: "archive", topic_id: topic.id })).toMatchObject({ status: "failed", cause: "archive_not_configured" })
  expect(await count(s, "claim_gate")).toBe(0)
  expect((await topicOf(s, topic.id)).lifecycle).toBe("active")
  // The owner's words have to be a message the owner sent to this conversation.
  const t = await stageTopics(cluster)
  const other = await bound(t)
  const master = await t.binding()
  const stranger = await t.said("archive it", { sender: STRANGER })
  expect(await code(t.ask(master, { action: "archive", topic_id: other.id }, stranger))).toBe("source_invalid")
  expect(await code(t.ask(master, { action: "archive", topic_id: "no-such-topic" }))).toBe("no error")
  expect(await t.ask(master, { action: "archive", topic_id: "no-such-topic" })).toMatchObject({ status: "failed", cause: "unknown_topic" })
  expect(await t.ask(master, { action: "reopen", topic_id: other.id })).toMatchObject({ status: "failed", cause: "not_archived" })
  expect((await topicOf(t, other.id)).lifecycle).toBe("active")
  expect(await count(t, "claim_gate")).toBe(0)
})

test("a stop that is not shown leaves it archiving with its reason: never archived, said once, a finding, and only proof moves it", async () => {
  const s = await stageTopics(cluster)
  const topic = await bound(s)
  await plantAttempt(s, topic)
  const reply = await s.ask(await s.binding(), { action: "archive", topic_id: topic.id })
  const op = String(reply.operation_id)
  await s.topicPass()
  // The runner could not prove the process is gone: stop_unknown.
  await settle(s, "stop_unknown")
  for (let pass = 0; pass < 3; pass += 1) { s.fake.advance(2000); await s.topicPass() }
  expect((await topicOf(s, topic.id)).lifecycle).toBe("archiving")
  expect((await s.admin`select state from stop_request where operation_id = ${op}`)[0].state).toBe("unknown")
  expect(await noticeOf(s, `topic:archive-done:${op}`)).toBeUndefined()
  const pending = await noticeOf(s, `topic:archive-pending:${op}:stop_unknown:${topic.id}`)
  expect(pending.agent).toBe(GENERAL)
  expect(pending.body).toContain("has not finished")
  expect(pending.body).toContain("not shown to have stopped")
  expect(await count(s, "outbox", `notice_key like 'topic:archive-pending:${op}%'`)).toBe(1)
  // The master stays blocked: the input is held and nothing else of its is claimable.
  expect((await s.admin`select hub_agent_blocked(${topic.agent_id}) as blocked`)[0].blocked).toBe(true)
  // Left alone it is a finding that says what it waits for.
  const findings = await topicFindings({ store: s.as("hub_hub"), registry: s.load(), machine: "pi", now: new Date(Date.now() + 11 * 60 * 1000), doors: new Set([DOOR]), agents: [] })
  expect(findings.map(one => one.kind)).toEqual(["topic-transition-stuck"])
  expect(findings[0].says).toContain("waiting for the agent's process to be shown stopped")
  // Later proof, and only proof, finishes it.
  await settle(s, "stopped")
  await s.topicPass()
  expect((await topicOf(s, topic.id)).lifecycle).toBe("archived")
})

test("reopening puts the channel back exactly as the archive found it, keeps every other role's permissions, releases only the archive's gate and serves what waited", async () => {
  const s = await stageTopics(cluster)
  const topic = await bound(s)
  const projects = s.fake.addChannel({ name: "projects", type: 4 })
  const friend = { id: "500000000000000001", type: 0, allow: "1024", deny: "0" }
  const mine = { id: s.everyone, type: 0, allow: "0", deny: "0" }
  s.fake.editChannelByHand(topic.chat!, { parent_id: projects, permission_overwrites: [friend, mine] })
  await s.admin`insert into inbound (id, person, agent, body, kind) values ('queued-input', ${PERSON}, ${topic.agent_id}, 'a message that waited', 'human')`
  const general = await s.binding()
  const reply = await s.ask(general, { action: "archive", topic_id: topic.id })
  await s.topicPass()
  await s.topicPass()
  expect((await topicOf(s, topic.id)).lifecycle).toBe("archived")
  const archived = s.fake.channel(topic.chat!)!
  expect(archived.parent_id).toBe(s.archive)
  // Only the named role changed, and only by the read-only bits: every other entry is as it was.
  expect(sorted(archived.permission_overwrites)).toEqual(sorted([friend, { id: s.everyone, type: 0, allow: "0", deny: MASK }]))
  // The waiting message is held while it is archived, and not answered to make it look done.
  expect((await s.admin`select hub_row_held('queued-input') as held`)[0].held).toBe(true)
  // An unrelated operation's gate over the same agent survives the reopen.
  await s.admin`select hub_gate_place('op-other', 'agent', ${topic.agent_id}, 'council', '{}'::jsonb)`

  const reopened = await s.ask(general, { action: "reopen", topic_id: topic.id })
  expect(reopened).toMatchObject({ status: "accepted", stage: "reopening" })
  expect(await count(s, "confirmation", "operation_kind = 'topic.reopen'")).toBe(0)
  await s.topicPass()
  await s.topicPass()
  const back = s.fake.channel(topic.chat!)!
  expect(back.parent_id).toBe(projects)
  expect(sorted(back.permission_overwrites)).toEqual(sorted([friend, mine]))
  expect((await topicOf(s, topic.id))).toMatchObject({ lifecycle: "active", lifecycle_generation: 2 })
  expect((await s.admin`select state from claim_gate where operation_id = ${String(reply.operation_id)}`)[0].state).toBe("released")
  expect((await s.admin`select state from claim_gate where operation_id = 'op-other'`)[0].state).toBe("open")
  const said = await noticeOf(s, `topic:reopen-done:${reopened.operation_id}`)
  expect(said.body).toContain("is open again")
  expect(said.body).not.toContain("I left as it is")
})

test("reopening never overwrites somebody else's edit: what was changed since is left as it is and said, and the reopen still completes", async () => {
  const s = await stageTopics(cluster)
  const topic = await bound(s)
  const projects = s.fake.addChannel({ name: "projects", type: 4 })
  const elsewhere = s.fake.addChannel({ name: "elsewhere", type: 4 })
  const friend = { id: "500000000000000001", type: 0, allow: "1024", deny: "0" }
  s.fake.editChannelByHand(topic.chat!, { parent_id: projects, permission_overwrites: [friend] })
  const general = await s.binding()
  await s.ask(general, { action: "archive", topic_id: topic.id })
  await s.topicPass()
  await s.topicPass()
  expect((await topicOf(s, topic.id)).lifecycle).toBe("archived")
  // After the archive: a person moved the chat elsewhere and let the role write again.
  const foreign = [friend, { id: s.everyone, type: 0, allow: "2048", deny: MASK }]
  s.fake.editChannelByHand(topic.chat!, { parent_id: elsewhere, permission_overwrites: foreign })
  const reopened = await s.ask(general, { action: "reopen", topic_id: topic.id })
  await s.topicPass()
  await s.topicPass()
  // Neither was touched.
  const seen = s.fake.channel(topic.chat!)!
  expect(seen.parent_id).toBe(elsewhere)
  expect(seen.permission_overwrites).toEqual(foreign)
  expect(s.fake.requestsTo(new RegExp(`^PATCH /channels/${topic.chat}$`)).length).toBe(1)
  // And it is said, in plain words, what was left.
  expect((await topicOf(s, topic.id)).lifecycle).toBe("active")
  const said = await noticeOf(s, `topic:reopen-done:${reopened.operation_id}`)
  expect(said.body).toContain("I left as it is what was changed after it was archived")
  expect(said.body).toContain("its category")
  expect(said.body).toContain("who can write in it")
  const [transition] = await s.admin`select channel_state, channel_result from topic_transition where id = ${String(reopened.operation_id)}`
  expect(transition.channel_state).toBe("conflict")
  expect(transition.channel_result.left.sort()).toEqual(["category", "permissions"])
})

test("reopening serves what waited, and interrupted work still needs its own scoped choice: the hold is untouched and is said, and nothing reruns by itself", async () => {
  const s = await stageTopics(cluster)
  const topic = await bound(s)
  await plantAttempt(s, topic)
  await s.admin`insert into inbound (id, person, agent, body, kind) values ('queued-input', ${PERSON}, ${topic.agent_id}, 'a message that waited', 'human')`
  const general = await s.binding()
  await s.ask(general, { action: "archive", topic_id: topic.id })
  await s.topicPass()
  // The runner stopped the attempt and held its input for the owner's choice, as it always does.
  await settle(s, "stopped")
  await s.admin`insert into replay_hold (inbound_id, execution_id, conversation_id, cause, state) values ('planted-input', 'planted-attempt', ${topic.conversation_id}, 'stopped', 'held')`
  await s.topicPass()
  expect((await topicOf(s, topic.id)).lifecycle).toBe("archived")
  expect((await s.admin`select hub_row_held('queued-input') as held`)[0].held).toBe(true)

  const reopened = await s.ask(general, { action: "reopen", topic_id: topic.id })
  await s.topicPass()
  await s.topicPass()
  expect((await topicOf(s, topic.id)).lifecycle).toBe("active")
  // What waited is no longer gated. What was interrupted is held by the owner's gate, which nothing here lifts.
  expect((await s.admin`select hub_row_held('queued-input') as held`)[0].held).toBe(false)
  expect((await s.admin`select hub_gate_covers(${topic.agent_id}, ${topic.conversation_id}, 'planted-input') as covered`)[0].covered).toBe(false)
  expect((await s.admin`select hub_row_held('planted-input') as held`)[0].held).toBe(true)
  expect((await s.admin`select state, choice from replay_hold where inbound_id = 'planted-input'`)[0]).toMatchObject({ state: "held", choice: null })
  const said = await noticeOf(s, `topic:reopen-done:${reopened.operation_id}`)
  expect(said.body).toContain("Interrupted work is waiting for your choice")
  expect(said.body).toContain("will not continue on its own")
})

test("a chat moved into the archive category by hand is the same archive with no confirmation, an unrelated edit is nothing, and one listing serves every topic", async () => {
  const s = await stageTopics(cluster)
  const a = await bound(s, { chat_name: "coffee" })
  const b = await bound(s, { chat_name: "tea" })
  expect(b.id).not.toBe(a.id)
  await later(s)
  const confirmations = await count(s, "confirmation")

  // A rename, a new description and a change to who may write are edits, and none of them is an archive.
  s.fake.editChannelByHand(a.chat!, { name: "coffee-2", topic: "what this chat is for", permission_overwrites: [{ id: s.everyone, type: 0, allow: "0", deny: "0" }] })
  await later(s)
  expect(await count(s, "topic_transition")).toBe(0)
  expect((await topicOf(s, a.id)).lifecycle).toBe("active")
  expect((await s.admin`select name from topic_channel_seen where topic_id = ${a.id}`)[0].name).toBe("coffee-2")
  // One listing per interval however many topics there are, and none between intervals.
  const before = listings(s)
  await later(s)
  expect(listings(s) - before).toBe(1)
  await s.topicPass()
  await s.topicPass()
  expect(listings(s) - before).toBe(1)

  // Moved into the archive category by hand: the same operation an owner's request makes, seen on the next look.
  s.fake.editChannelByHand(a.chat!, { parent_id: s.archive })
  await later(s)
  const [asked] = await s.admin`select id, kind, source, requested_by, evidence from topic_transition where topic_id = ${a.id}`
  expect(asked).toMatchObject({ kind: "archive", source: "discord", requested_by: "discord:observed", evidence: { observed_from: null, observed_to: s.archive } })
  expect(asked.id).toBe(`observed:${a.id}:1`)
  expect((await topicOf(s, a.id)).lifecycle).toBe("archiving")
  expect((await s.admin`select state from claim_gate where operation_id = ${asked.id}`)[0].state).toBe("open")
  expect(await count(s, "stop_request", `operation_id = '${asked.id}'`)).toBe(1)
  // The other topic is not touched, and no confirmation was asked for.
  expect((await topicOf(s, b.id)).lifecycle).toBe("active")
  expect(await count(s, "confirmation")).toBe(confirmations)
  await s.topicPass()
  await s.topicPass()
  expect((await topicOf(s, a.id)).lifecycle).toBe("archived")
  // Its read-only overwrite is made too, and said in General.
  expect(s.fake.channel(a.chat!)!.permission_overwrites).toEqual([{ id: s.everyone, type: 0, allow: "0", deny: MASK }])
  const said = await noticeOf(s, `topic:archive-done:${asked.id}`)
  expect(said.body).toContain("is archived")
  expect(said.agent).toBe(GENERAL)
  // Seeing the same category again, and again after a restart, is not another archive.
  await later(s)
  s.restart()
  await later(s)
  expect(await count(s, "topic_transition", `topic_id = '${a.id}'`)).toBe(1)

  // Moved back out by hand: the same reopen, which puts back only what the archive changed.
  s.fake.editChannelByHand(a.chat!, { parent_id: null })
  await later(s)
  expect((await s.admin`select kind, source from topic_transition where topic_id = ${a.id} order by seq desc limit 1`)[0]).toEqual({ kind: "reopen", source: "discord" })
  await s.topicPass()
  await s.topicPass()
  expect((await topicOf(s, a.id)).lifecycle).toBe("active")
  expect(s.fake.channel(a.chat!)!.parent_id).toBeNull()
  expect(s.fake.channel(a.chat!)!.permission_overwrites).toEqual([{ id: s.everyone, type: 0, allow: "0", deny: "0" }])
  expect((await s.admin`select state from claim_gate where operation_id = ${asked.id}`)[0].state).toBe("released")
  expect(await count(s, "confirmation")).toBe(confirmations)
})

test("only a change of category is a transition; the first sight outside the archive is a baseline, the first sight inside it is the current state and says so, and an archived chat is judged by where its archive left it", () => {
  const archive = { category: "900" }
  const active = { lifecycle: "active" as const }
  const archived = { lifecycle: "archived" as const }
  expect(observedTransitionOf(active, { present: true, parent_id: null }, { parent_id: "900" }, archive)).toEqual({ kind: "archive", from: null, to: "900", first: false })
  expect(observedTransitionOf(active, { present: true, parent_id: "700" }, { parent_id: "900" }, archive)).toEqual({ kind: "archive", from: "700", to: "900", first: false })
  expect(observedTransitionOf(archived, { present: true, parent_id: "900" }, { parent_id: "700" }, archive)).toEqual({ kind: "reopen", from: "900", to: "700", first: false })
  // No configured archive, or already in the state it asks for: nothing.
  expect(observedTransitionOf(active, { present: true, parent_id: null }, { parent_id: "900" }, null)).toBeNull()
  expect(observedTransitionOf(active, { present: true, parent_id: "900" }, { parent_id: "900" }, archive)).toBeNull()
  expect(observedTransitionOf(archived, { present: true, parent_id: "900" }, { parent_id: "900" }, archive)).toBeNull()
  // THE FIRST SIGHT. Outside the archive it is a baseline and no history is made up; inside it, an active chat is asked to be archived from its
  // current state, and the answer says there was nothing before it (so where it came from is not known and is not recorded as known).
  expect(observedTransitionOf(active, null, { parent_id: "700" }, archive)).toBeNull()
  expect(observedTransitionOf(active, null, { parent_id: null }, archive)).toBeNull()
  expect(observedTransitionOf(active, null, { parent_id: "900" }, archive)).toEqual({ kind: "archive", from: null, to: "900", first: true })
  // A sample the platform did not show (a record that only ever held an error) is no sample.
  expect(observedTransitionOf(active, { present: false, parent_id: null }, { parent_id: "900" }, archive)).toEqual({ kind: "archive", from: null, to: "900", first: true })
  expect(observedTransitionOf(active, { present: false, parent_id: null }, { parent_id: "700" }, archive)).toBeNull()
  // An archived chat that is not where its archive put it was moved out, whatever was sampled last; where the archive put it is the record's.
  expect(observedTransitionOf(archived, { present: true, parent_id: "700" }, { parent_id: "700" }, archive, "900")).toEqual({ kind: "reopen", from: "900", to: "700", first: false })
  expect(observedTransitionOf(archived, null, { parent_id: null }, archive, "900")).toEqual({ kind: "reopen", from: "900", to: null, first: false })
  expect(observedTransitionOf(archived, { present: true, parent_id: "900" }, { parent_id: "900" }, archive, "900")).toBeNull()
  // Where the archive left it is still where it is: a category the registry names differently now does not reopen it.
  expect(observedTransitionOf(archived, { present: true, parent_id: "800" }, { parent_id: "800" }, archive, "800")).toBeNull()
  // Without the archive's own record the old rule holds: a change out of the archive category, and nothing that was never sampled inside it.
  expect(observedTransitionOf(archived, null, { parent_id: "700" }, archive)).toBeNull()
  // A chat the Hub is already archiving or reopening is not asked again, whichever way the category reads.
  expect(observedTransitionOf({ lifecycle: "archiving" }, { present: true, parent_id: null }, { parent_id: "900" }, archive)).toBeNull()
  expect(observedTransitionOf({ lifecycle: "reopening" }, { present: true, parent_id: "900" }, { parent_id: "700" }, archive)).toBeNull()
  // An active chat that a reopen has just settled is judged from where THAT reopen left it, whatever the older sample says. Inside the
  // category, and left somewhere else by the reopen: it was moved back in while the reopen was open, and that is an archive from there
  // (a category of none is a place too).
  expect(observedTransitionOf(active, { present: true, parent_id: "900" }, { parent_id: "900" }, archive, null, { parent_id: "700" })).toEqual({ kind: "archive", from: "700", to: "900", first: false })
  expect(observedTransitionOf(active, { present: true, parent_id: "900" }, { parent_id: "900" }, archive, null, { parent_id: null })).toEqual({ kind: "archive", from: null, to: "900", first: false })
  // Left inside the category by the reopen itself (it could not know the prior one, and did not move the chat): being where it was left is no change.
  expect(observedTransitionOf(active, { present: true, parent_id: "900" }, { parent_id: "900" }, archive, null, { parent_id: "900" })).toBeNull()
  // Outside the category it is nothing, whatever the reopen left, and with no record of the reopen the sample in hand is all there is.
  expect(observedTransitionOf(active, { present: true, parent_id: "900" }, { parent_id: "700" }, archive, null, { parent_id: "800" })).toBeNull()
  expect(observedTransitionOf(active, { present: true, parent_id: "900" }, { parent_id: "900" }, archive, null, null)).toBeNull()
})

test("delegated work the owner approved is not stopped or hidden by an archive: it runs to its result, the result waits for a reopen, and General is told once", async () => {
  const s = await stageTopics(cluster)
  const topic = await bound(s)
  const at = new Date().toISOString()
  // A worker the master delegated to, already running for it.
  await s.admin`insert into inbound (id, person, agent, body, kind, source) values ('job-1', ${PERSON}, 'p1-worker', 'compare the vendors', 'job',
    ${{ log_id: "job-1", at, from: PERSON, text: "compare the vendors", dispatch: { dispatcher: topic.agent_id, target: "p1-worker",
      approved: { by: PERSON, at, digest: "d", source: "chat-command" }, return: { agent: topic.agent_id, door: DOOR, chat: topic.chat } } }}::jsonb)`
  const general = await s.binding()
  const reply = await s.ask(general, { action: "archive", topic_id: topic.id })
  await s.topicPass()
  await s.topicPass()
  expect((await topicOf(s, topic.id)).lifecycle).toBe("archived")
  // Only the master was frozen and stopped: the worker's job is neither gated nor asked to stop.
  expect((await s.admin`select hub_row_held('job-1') as held`)[0].held).toBe(false)
  expect((await s.admin`select state from inbound where id = 'job-1'`)[0].state).not.toBe("answered")
  expect(await count(s, "stop_request", `operation_id = '${reply.operation_id}'`)).toBe(1)
  expect(await count(s, "claim_gate", `scope_id = 'p1-worker'`)).toBe(0)
  const said = await noticeOf(s, `topic:archive-done:${reply.operation_id}`)
  expect(said.body).toContain("1 delegated job you already approved keep running")

  // The worker's result arrives for the archived master: kept, not claimable, and General is told once.
  await s.admin`insert into inbound (id, person, agent, body, kind) values ('result-1', ${PERSON}, ${topic.agent_id}, 'the comparison', 'report')`
  await later(s)
  await later(s)
  expect((await s.admin`select hub_row_held('result-1') as held`)[0].held).toBe(true)
  const results = await noticeOf(s, `topic:results:1:${topic.id}`)
  expect(results.agent).toBe(GENERAL)
  expect(results.body).toContain("1 result arrived for coffee, which is archived")
  expect(await count(s, "outbox", `notice_key like 'topic:results:%'`)).toBe(1)
  // Reopening lets the master read it.
  await s.ask(general, { action: "reopen", topic_id: topic.id })
  await s.topicPass()
  await s.topicPass()
  expect((await s.admin`select hub_row_held('result-1') as held`)[0].held).toBe(false)
})

test("with no General configured nothing is said in a chat picked for the purpose: it is kept on the operation, and check names it", async () => {
  const s = await stageTopics(cluster, { person: { general: undefined } })
  const topic = await bound(s)
  // Asked in the topic's own chat, which is the chat that is about to be read only: there is nowhere else to say it.
  const own = await s.binding(topic.agent_id)
  const reply = await s.ask(own, { action: "archive" })
  await s.topicPass()
  await s.topicPass()
  expect((await topicOf(s, topic.id)).lifecycle).toBe("archived")
  expect(await noticeOf(s, `topic:archive-done:${reply.operation_id}`)).toBeUndefined()
  const [done] = await s.admin`select evidence from topic_transition where id = ${String(reply.operation_id)}`
  expect(done.evidence.notice).toBe("general_not_configured")
  const findings = await topicFindings({ store: s.as("hub_hub"), registry: s.load(), machine: "pi", now: new Date(), doors: new Set([DOOR]), agents: [] })
  expect(findings.map(one => [one.kind, one.subject])).toEqual([["general-not-configured", PERSON]])
  // A request from a chat that has a place to say it is unaffected, and General cannot be picked at request time either.
  const another = await s.binding()
  expect(await s.ask(another, { action: "reopen", topic_id: topic.id })).toMatchObject({ status: "failed", cause: "not_permitted" })
})

test("a chat that cannot be read is not a chat that is gone: a refusal, a server error and a limit change nothing, and only the platform naming it unknown does", async () => {
  const s = await stageTopics(cluster)
  const topic = await bound(s)
  await later(s)
  const seen = async () => (await s.admin`select present, parent_id, last_error from topic_channel_seen where topic_id = ${topic.id}`)[0]
  expect(await seen()).toMatchObject({ present: true, last_error: null })

  // The whole listing fails: nothing is known, and only when it was tried is recorded.
  s.fake.script(new RegExp(`^GET /guilds/${s.fake.guild}/channels$`), { kind: "server_error" })
  await later(s)
  expect(await seen()).toMatchObject({ present: true, last_error: { code: "http-500" } })
  // A rate limit on it holds the next look for what was said, and records nothing about the chat.
  s.fake.script(new RegExp(`^GET /guilds/${s.fake.guild}/channels$`), { kind: "rate_limit", retryAfter: 40 })
  await later(s)
  const requested = listings(s)
  s.fake.advance(35_000)
  await s.topicPass()
  expect(listings(s)).toBe(requested)
  s.fake.advance(6_000)
  await s.topicPass()
  expect(listings(s)).toBe(requested + 1)
  // The bot cannot see the chat any more (the listing lacks it and a read is refused): access is not deletion.
  s.fake.hideChannel(topic.chat!)
  await later(s)
  expect(await seen()).toMatchObject({ present: true, last_error: { code: "http-403" } })
  expect((await topicOf(s, topic.id)).lifecycle).toBe("active")
  expect(await count(s, "topic_transition")).toBe(0)
  expect(await count(s, "claim_gate")).toBe(0)
  expect(await count(s, "outbox", "notice_key like 'topic:missing:%'")).toBe(0)
})

test("a chat that is gone gates its master and asks once, in General, for the shared deletion flow, which is not available yet: nothing is erased, and it says so", async () => {
  const s = await stageTopics(cluster)
  const topic = await bound(s)
  await s.admin`insert into inbound (id, person, agent, body, kind) values ('queued-input', ${PERSON}, ${topic.agent_id}, 'the history', 'human')`
  s.fake.removeChannel(topic.chat!)
  await later(s)
  const gone = await topicOf(s, topic.id)
  expect(gone.lifecycle).toBe("channel_missing")
  // The vanished master takes no new work, and its rows are all still there.
  expect((await s.admin`select hub_row_held('queued-input') as held`)[0].held).toBe(true)
  expect(await count(s, "inbound", `agent = '${topic.agent_id}'`)).toBe(2)
  expect(await count(s, "conversation", `id = '${topic.conversation_id}'`)).toBe(1)
  expect(await count(s, "topic", `id = '${topic.id}'`)).toBe(1)
  // One request, pending its setup, and one notice in General that does not pretend to have a deletion.
  const requests = await s.admin`select kind, source, state, stage from topic_transition where topic_id = ${topic.id}`
  expect(requests).toEqual([{ kind: "deletion_request", source: "discord", state: "open", stage: "pending_setup" }])
  // The disappearance is an operation of its own, named after the topic and the generation it began at.
  const said = await noticeOf(s, `topic:missing:${topic.id}:1`)
  expect(said.agent).toBe(GENERAL)
  expect(said.body).toContain("was deleted in Discord")
  expect(said.body).toContain("nothing was erased")
  expect(said.body).toContain("nothing is erased before you confirm")
  // Again and after a restart: still one, and the agent is still bound and still gated.
  await later(s)
  s.restart()
  await later(s)
  expect(await count(s, "topic_transition", `topic_id = '${topic.id}'`)).toBe(1)
  expect(await count(s, "outbox", `notice_key = 'topic:missing:${topic.id}:1'`)).toBe(1)
  expect(await count(s, "outbox", `notice_key like 'topic:missing:${topic.id}%'`)).toBe(1)
  // Nothing archives or reopens a chat that is gone, and the finding names it.
  expect(await s.ask(await s.binding(), { action: "archive", topic_id: topic.id })).toMatchObject({ status: "failed", cause: "channel_missing" })
  const findings = await topicFindings({ store: s.as("hub_hub"), registry: s.load(), machine: "pi", now: new Date(), doors: new Set([DOOR]), agents: [] })
  expect(findings.map(one => one.kind)).toEqual(["topic-channel-missing"])
})

test("a disappearance that queues no notice is not recorded as told: a deletion the Hub asked for stands for the request and its notice, and a gap kept earlier is cleared only by a catch-up that exists, never for the disappearance notice that was not queued", async () => {
  const s = await stageTopics(cluster)
  const topic = await bound(s)
  // Nobody could be told once, and a deletion of the Hub's own is in flight for the topic.
  await noteAttention(s.as("hub_door"), topic.id, "missing", "general_unusable")
  await s.admin`update topic set delete_operation = 'op-hub-delete' where id = ${topic.id}`
  s.fake.removeChannel(topic.chat!)
  await later(s)
  expect((await topicOf(s, topic.id)).lifecycle).toBe("channel_missing")
  // General could take a notice now, but the store queued none for the disappearance, so nothing says it was told: no notice, no request.
  expect(await count(s, "outbox", `notice_key like 'topic:missing:${topic.id}%'`)).toBe(0)
  expect(await count(s, "topic_transition", `topic_id = '${topic.id}' and kind = 'deletion_request'`)).toBe(0)
  // The gap was not cleared by the disappearance (there would be nothing left to catch up with): it is paid by the one keyed catch-up
  // notice that names it and where the topic stands, and that notice exists.
  const catchups = await s.admin`select body from outbox where notice_key like ${`topic:attention-catchup:${topic.id}:%`}`
  expect(catchups).toHaveLength(1)
  expect(catchups[0].body).toContain("its chat was reported deleted in Discord")
  expect(catchups[0].body).toContain("its chat is deleted in Discord")
  expect(attentionGapsOf(await topicOf(s, topic.id))).toEqual([])
})

test("a notice and what is recorded of whether it was told commit together: a write of the record that fails takes the notice with it, and the next look queues it once and clears the gap", async () => {
  const s = await stageTopics(cluster)
  const topic = await bound(s)
  await s.ask(await s.binding(), { action: "archive", topic_id: topic.id })
  await s.topicPass()
  await s.topicPass()
  expect((await topicOf(s, topic.id)).lifecycle).toBe("archived")
  // A result that waits for the archived master, and a gap kept for saying so earlier (nobody could be told then).
  await s.admin`insert into inbound (id, person, agent, body, kind) values ('result-1', ${PERSON}, ${topic.agent_id}, 'the comparison', 'report')`
  await noteAttention(s.as("hub_door"), topic.id, "results", "general_unusable")
  await s.admin.unsafe(`create function boom_evidence() returns trigger language plpgsql as $$ begin raise exception 'injected: the record failed'; end $$`)
  await s.admin.unsafe(`create trigger boom before update on topic for each row when (new.create_evidence is distinct from old.create_evidence) execute function boom_evidence()`)
  const key = `topic:results:${(await topicOf(s, topic.id)).lifecycle_generation}:${topic.id}`
  await expect(later(s)).rejects.toThrow("injected")
  // The notice was inside the same transaction as the record, so it is not there either, and the gap still says what it said.
  expect(await count(s, "outbox", `notice_key = '${key}'`)).toBe(0)
  expect(attentionGapsOf(await topicOf(s, topic.id)).map(one => [one.kind, one.cause])).toEqual([["results", "general_unusable"]])
  s.restart()
  await s.admin.unsafe(`drop trigger boom on topic`)
  await later(s)
  expect(await count(s, "outbox", `notice_key = '${key}'`)).toBe(1)
  expect(attentionGapsOf(await topicOf(s, topic.id))).toEqual([])
  await later(s)
  s.restart()
  await later(s)
  expect(await count(s, "outbox", `notice_key = '${key}'`)).toBe(1)
})

test("an adopted master that was never a topic is linked once and keeps its conversation, and a reserved identity is never linked", async () => {
  const s = await stageTopics(cluster)
  const coffee = s.fake.addChannel({ name: "old-coffee" })
  s.rewrite({ agents: [
    { id: "p1-coffee", person: PERSON, preset: "daily", chat: coffee, door: DOOR, runner: RUNNER_PI },
    { id: "p1-tea", person: PERSON, preset: "daily", chat: "1000000088", door: DOOR, runner: RUNNER_PI },
  ] })
  // A retired identity is never given a topic, whoever asks and however the registry names it. (The door links every ordinary master
  // it finds when it passes, so the identity is retired before the first pass: afterwards it would have been linked already.)
  await reserveIdentity(s.as("hub_hub"), "agent", "p1-tea", "topic deleted")
  const legacy = await s.binding("p1-coffee")
  const general = await s.binding()
  const existing = (await s.admin`select id from conversation where agent = 'p1-coffee'`)[0].id
  const reply = await s.ask(general, { action: "archive", topic_id: "p1-coffee" })
  expect(reply).toMatchObject({ status: "stopping" })
  const linked = await readTopic(s.as("hub_hub"), String(reply.object_id))
  expect(linked).toMatchObject({ origin: "legacy", agent_id: "p1-coffee", conversation_id: existing, chat: coffee, create_state: "legacy" })
  expect(await count(s, "conversation", "agent = 'p1-coffee'")).toBe(1)
  await s.topicPass()
  await s.topicPass()
  expect((await topicOf(s, linked!.id)).lifecycle).toBe("archived")
  expect(s.fake.channel(coffee)!.parent_id).toBe(s.archive)
  // Its own master can archive itself the same way, and a stranger's message cannot.
  expect(legacy.agent).toBe("p1-coffee")
  expect(await s.ask(general, { action: "archive", topic_id: "p1-tea" })).toMatchObject({ status: "failed", cause: "identity_reserved" })
  expect(await count(s, "topic", "agent_id = 'p1-tea'")).toBe(0)
  const findings = await topicFindings({ store: s.as("hub_hub"), registry: s.load(), machine: "pi", now: new Date(), doors: new Set([DOOR]), agents: ["p1-tea"] })
  expect(findings.map(one => [one.kind, one.subject])).toContainEqual(["reserved-identity-in-registry", "p1-tea"])
})

test("the deliberate limits of this step are refused by name and offered nowhere: stopping a topic and an `erase` that is not a deletion are not actions of this tool, and nothing here erases", async () => {
  const s = await stageTopics(cluster)
  const master = await s.binding()
  for (const action of ["erase", "stop"]) {
    expect(await code(s.ask(master, { action, topic_id: "x" }))).toBe("unsupported_action")
  }
  // `delete` is the one deletion there is, and it needs the owner's check (topic-deletion.test.ts); nothing here made a topic to erase.
  expect(await count(s, "topic")).toBe(0)
})

// ---------------------------------------------------------------------------------------------
// The masters the registry already had
// ---------------------------------------------------------------------------------------------

const byAgent = async (s: TopicsStage, agent: string): Promise<TopicRow> => (await readTopic(s.as("hub_hub"), String((await s.admin`select id from topic where agent_id = ${agent}`)[0].id)))!

test("the ordinary masters the registry already had are linked as topics without any tool call, keeping their conversations: General included, workers left out, once, and again when the registry gains one", async () => {
  const s = await stageTopics(cluster)
  const coffee = s.fake.addChannel({ name: "old-coffee" })
  s.rewrite({ agents: [
    { id: "p1-coffee", person: PERSON, preset: "daily", chat: coffee, door: DOOR, runner: RUNNER_PI },
    { id: "p1-jobs", person: PERSON, preset: "daily", runner: RUNNER_PI },
  ] })
  // p1-coffee has been talking to its runner for a while, so it has a conversation; General has none yet.
  await s.binding("p1-coffee")
  const existing = (await s.admin`select id from conversation where agent = 'p1-coffee'`)[0].id
  expect(await count(s, "topic")).toBe(0)

  // The very first pass, with no topic on the door at all, links them before it would park for want of any.
  await s.topicPass()
  const topics = await s.admin`select agent_id, origin, create_state, lifecycle, conversation_id, chat from topic order by agent_id`
  expect(topics.map((one: { agent_id: string }) => one.agent_id)).toEqual(["p1-coffee", GENERAL])
  expect(topics[0]).toMatchObject({ origin: "legacy", create_state: "legacy", lifecycle: "active", conversation_id: existing, chat: coffee })
  expect(topics[1]).toMatchObject({ origin: "legacy", lifecycle: "active", chat: s.general })
  expect(await count(s, "conversation", "agent = 'p1-coffee'")).toBe(1)
  expect(await count(s, "conversation", `agent = '${GENERAL}'`)).toBe(1)
  expect(await count(s, "topic", "agent_id = 'p1-jobs'")).toBe(0)
  // Linking a master starts nothing: no gate, no stop, no operation.
  expect(await count(s, "claim_gate")).toBe(0)
  expect(await count(s, "topic_transition")).toBe(0)

  // Again, after a restart, and with the same registry: nothing new. A registry that gains a master gets it, and only it.
  s.restart()
  await s.topicPass()
  await s.topicPass()
  expect(await count(s, "topic")).toBe(2)
  const tea = s.fake.addChannel({ name: "tea" })
  s.rewrite({ agents: [
    { id: "p1-coffee", person: PERSON, preset: "daily", chat: coffee, door: DOOR, runner: RUNNER_PI },
    { id: "p1-tea", person: PERSON, preset: "daily", chat: tea, door: DOOR, runner: RUNNER_PI },
  ] })
  await s.topicPass()
  expect((await s.admin`select agent_id from topic order by agent_id`).map((one: { agent_id: string }) => one.agent_id)).toEqual(["p1-coffee", GENERAL, "p1-tea"])
})

test("a link that fails is owed and tried again, and nothing is half made: the pass says when it will be tried and the masters are linked once the write works", async () => {
  const s = await stageTopics(cluster)
  await s.admin.unsafe(`create function boom_topic() returns trigger language plpgsql as $$ begin raise exception 'injected: the link failed'; end $$`)
  await s.admin.unsafe(`create trigger boom before insert on topic for each row execute function boom_topic()`)
  const next = await s.topicPass()
  expect(next).toBe(s.fake.now() + 30_000)
  expect(await count(s, "topic")).toBe(0)
  expect(await count(s, "conversation")).toBe(0)
  await s.admin.unsafe(`drop trigger boom on topic`)
  s.fake.advance(31_000)
  await s.topicPass()
  expect((await s.admin`select agent_id from topic`).map((one: { agent_id: string }) => one.agent_id)).toEqual([GENERAL])
})

test("a master found already inside the archive category is archived from its current state, with nothing made up about where it came from; one found outside is only a baseline; and an unknown prior category stays unknown on restore", async () => {
  const s = await stageTopics(cluster)
  const inside = s.fake.addChannel({ name: "old-archived", parent_id: s.archive })
  const outside = s.fake.addChannel({ name: "old-outside" })
  s.rewrite({ agents: [
    { id: "p1-old", person: PERSON, preset: "daily", chat: inside, door: DOOR, runner: RUNNER_PI },
    { id: "p1-out", person: PERSON, preset: "daily", chat: outside, door: DOOR, runner: RUNNER_PI },
  ] })
  await s.topicPass()
  const old = await byAgent(s, "p1-old")
  // One operation, from the current state: the same gate and stop as any archive, and no `observed_from` at all.
  const [asked] = await s.admin`select id, kind, source, requested_by, evidence from topic_transition where topic_id = ${old.id}`
  expect(asked).toMatchObject({ kind: "archive", source: "discord", requested_by: "discord:observed" })
  expect(asked.evidence).toMatchObject({ first_observation: true, observed_to: s.archive })
  expect(asked.evidence).not.toHaveProperty("observed_from")
  expect((await s.admin`select state from claim_gate where operation_id = ${asked.id}`)[0].state).toBe("open")
  expect(await count(s, "stop_request", `operation_id = '${asked.id}'`)).toBe(1)
  // A master outside the archive, and General, are a baseline: no history is made up for them.
  expect(await count(s, "topic_transition")).toBe(1)
  await s.topicPass()
  await s.topicPass()
  expect((await topicOf(s, old.id)).lifecycle).toBe("archived")
  const [plan] = await s.admin`select channel_plan from topic_transition where id = ${asked.id}`
  expect(plan.channel_plan).toMatchObject({ prior_parent_known: false, apply_parent: s.archive })
  expect(s.fake.channel(inside)!.permission_overwrites).toEqual([{ id: s.everyone, type: 0, allow: "0", deny: MASK }])
  // Seen again, and after a restart, is not another archive.
  await later(s)
  s.restart()
  await later(s)
  expect(await count(s, "topic_transition", `topic_id = '${old.id}'`)).toBe(1)

  // Reopened by the owner: its permissions come back, its category cannot (nothing recorded where it was), and it says so.
  const general = await s.binding()
  const reopened = await s.ask(general, { action: "reopen", topic_id: old.id })
  await s.topicPass()
  await s.topicPass()
  expect((await topicOf(s, old.id)).lifecycle).toBe("active")
  expect(s.fake.channel(inside)!.parent_id).toBe(s.archive)
  expect(s.fake.channel(inside)!.permission_overwrites).toEqual([])
  expect((await noticeOf(s, `topic:reopen-done:${reopened.operation_id}`)).body).toContain("its category")
  // The reopen recorded where it left the chat: inside the category on purpose, because nothing said where it was before.
  expect((await s.admin`select channel_result from topic_transition where id = ${String(reopened.operation_id)}`)[0].channel_result).toMatchObject({ parent: s.archive })
  // Being in the archive category is not, by itself, an archive of a chat that is active and was seen there: not again, not after a restart.
  await later(s)
  s.restart()
  await later(s)
  expect(await count(s, "topic_transition", `topic_id = '${old.id}'`)).toBe(2)
  expect((await topicOf(s, old.id)).lifecycle).toBe("active")
})

test("an observed archive whose write failed is seen again and recorded exactly once: the change is not remembered before it is recorded, however often it is looked at or whatever restarts", async () => {
  const s = await stageTopics(cluster)
  const topic = await bound(s)
  await later(s)
  const seen = async () => (await s.admin`select parent_id, last_error from topic_channel_seen where topic_id = ${topic.id}`)[0]
  expect((await seen()).parent_id).toBeNull()
  await s.admin.unsafe(`create function boom_transition() returns trigger language plpgsql as $$ begin raise exception 'injected: the write failed'; end $$`)
  await s.admin.unsafe(`create trigger boom before insert on topic_transition for each row execute function boom_transition()`)
  s.fake.editChannelByHand(topic.chat!, { parent_id: s.archive })
  await later(s)
  // Looked at, the write failed, and the category was not remembered: the next look still sees the change.
  expect((await topicOf(s, topic.id)).lifecycle).toBe("active")
  expect(await count(s, "topic_transition")).toBe(0)
  expect(await seen()).toMatchObject({ parent_id: null })
  await later(s)
  s.restart()
  await later(s)
  expect(await count(s, "topic_transition")).toBe(0)
  expect(await seen()).toMatchObject({ parent_id: null })
  // The write works again: the same change is seen once more, and this time it is recorded, and only then remembered.
  await s.admin.unsafe(`drop trigger boom on topic_transition`)
  await later(s)
  expect(Array.from(await s.admin`select id, kind, source from topic_transition where topic_id = ${topic.id}`)).toEqual([{ id: `observed:${topic.id}:1`, kind: "archive", source: "discord" }])
  expect((await topicOf(s, topic.id)).lifecycle).toBe("archiving")
  expect((await seen()).parent_id).toBe(s.archive)
  // And it is exactly once however many looks and restarts follow.
  s.restart()
  await later(s)
  await later(s)
  expect(await count(s, "topic_transition", `topic_id = '${topic.id}'`)).toBe(1)
})

test("a chat that was moved out of the archive while its archive still waited for the stop is reconciled once the archive settles: the edge is not lost, and the chat comes back", async () => {
  const s = await stageTopics(cluster)
  const topic = await bound(s)
  await plantAttempt(s, topic)
  const general = await s.binding()
  const asked = await s.ask(general, { action: "archive", topic_id: topic.id })
  await s.topicPass()
  expect(s.fake.channel(topic.chat!)!.parent_id).toBe(s.archive)
  expect((await topicOf(s, topic.id)).lifecycle).toBe("archiving")
  // The owner moves it out again by hand while the stop is not yet shown. That is looked at while the archive is open, and not turned into anything.
  s.fake.editChannelByHand(topic.chat!, { parent_id: null })
  await later(s)
  await later(s)
  expect((await topicOf(s, topic.id)).lifecycle).toBe("archiving")
  expect(await count(s, "topic_transition", `topic_id = '${topic.id}'`)).toBe(1)
  // The stop is shown. The archive completes (its channel half was done), and the chat is not where the archive left it.
  await settle(s, "stopped")
  await s.topicPass()
  expect((await topicOf(s, topic.id)).lifecycle).toBe("archived")
  // Once settled, the channel is compared with what the archive left, and the difference is a reopen.
  await later(s)
  await s.topicPass()
  await s.topicPass()
  expect(Array.from(await s.admin`select kind, source from topic_transition where topic_id = ${topic.id} order by seq`)).toEqual([
    { kind: "archive", source: "tool" }, { kind: "reopen", source: "discord" },
  ])
  expect(await topicOf(s, topic.id)).toMatchObject({ lifecycle: "active" })
  expect(s.fake.channel(topic.chat!)!.parent_id).toBeNull()
  expect(s.fake.channel(topic.chat!)!.permission_overwrites).toEqual([])
  expect((await s.admin`select state from claim_gate where operation_id = ${String(asked.operation_id)}`)[0].state).toBe("released")
})

test("a chat moved back INTO the archive category while a reopen made in Discord is still waiting on the platform is archived when that reopen settles, from where the owner had put it, and once", async () => {
  const s = await stageTopics(cluster)
  const topic = await bound(s)
  const elsewhere = s.fake.addChannel({ name: "elsewhere", type: 4 })
  const general = await s.binding()
  const first = await s.ask(general, { action: "archive", topic_id: topic.id })
  await s.topicPass()
  await s.topicPass()
  expect((await topicOf(s, topic.id)).lifecycle).toBe("archived")
  await later(s)
  // The owner moves it out, and the platform refuses the reopen's restore of who may write three times over (a limit, and nothing handled).
  s.fake.editChannelByHand(topic.chat!, { parent_id: elsewhere })
  s.fake.script(new RegExp(`^PATCH /channels/${topic.chat}$`), { kind: "rate_limit", retryAfter: 40 }, { times: 3 })
  await later(s)
  const [reopen] = await s.admin`select id, source, evidence from topic_transition where topic_id = ${topic.id} and kind = 'reopen'`
  expect(reopen).toMatchObject({ source: "discord", evidence: { observed_from: s.archive, observed_to: elsewhere } })
  await s.topicPass()
  expect((await topicOf(s, topic.id)).lifecycle).toBe("reopening")
  expect((await s.admin`select channel_state from topic_transition where id = ${reopen.id}`)[0].channel_state).toBe("intent")

  // While it is open the owner puts the chat back into the archive category, and the door restarts before the platform will take the restore.
  s.fake.editChannelByHand(topic.chat!, { parent_id: s.archive })
  await later(s)
  s.restart()
  await later(s)
  expect((await topicOf(s, topic.id)).lifecycle).toBe("reopening")
  // Nothing is made of it while the reopen is open: no second operation, and the first archive's gate is still the only one.
  expect(await count(s, "topic_transition", `topic_id = '${topic.id}'`)).toBe(2)
  expect(s.fake.requestsTo(new RegExp(`^PATCH /channels/${topic.chat}$`)).filter(one => one.fault === "rate_limit")).toHaveLength(3)

  // The platform takes it. The reopen settles, and the chat found inside the category is not where the reopen left it: an archive.
  await later(s)
  await s.topicPass()
  await s.topicPass()
  const moves = Array.from(await s.admin`select id, kind, source, requested_by, evidence from topic_transition where topic_id = ${topic.id} order by seq`) as unknown as RequestedMoveRow[]
  expect(moves.map(one => [one.kind, one.source])).toEqual([["archive", "tool"], ["reopen", "discord"], ["archive", "discord"]])
  expect(moves[2]).toMatchObject({ requested_by: "discord:observed", evidence: { observed_from: elsewhere, observed_to: s.archive } })
  expect(moves[2].evidence).not.toHaveProperty("first_observation")
  expect((await topicOf(s, topic.id)).lifecycle).toBe("archived")
  // The same gate and stop as any archive: its own gate is closed, the reopen released the first one, and one stop was asked for.
  expect((await s.admin`select state from claim_gate where operation_id = ${moves[2].id}`)[0].state).toBe("open")
  expect((await s.admin`select state from claim_gate where operation_id = ${String(first.operation_id)}`)[0].state).toBe("released")
  expect(await count(s, "stop_request", `operation_id = '${moves[2].id}'`)).toBe(1)
  expect(s.fake.channel(topic.chat!)!.parent_id).toBe(s.archive)
  expect(s.fake.channel(topic.chat!)!.permission_overwrites).toEqual([{ id: s.everyone, type: 0, allow: "0", deny: MASK }])
  // Once, however often it is looked at and whatever restarts.
  await later(s)
  s.restart()
  await later(s)
  expect(await count(s, "topic_transition", `topic_id = '${topic.id}'`)).toBe(3)
})

test("a chat put back into the archive category between the step of a reopen made by the tool and the write of its completion is archived once it settles, from where the reopen left it: the reopen's own record, not the sample from before it", async () => {
  const s = await stageTopics(cluster)
  const topic = await bound(s)
  const projects = s.fake.addChannel({ name: "projects", type: 4 })
  s.fake.editChannelByHand(topic.chat!, { parent_id: projects })
  const general = await s.binding()
  const first = await s.ask(general, { action: "archive", topic_id: topic.id })
  await s.topicPass()
  await s.topicPass()
  expect((await topicOf(s, topic.id)).lifecycle).toBe("archived")
  // Sampled inside the archive category, as an archived chat is: this is the record the reopen leaves behind it.
  await later(s)
  expect((await s.admin`select parent_id from topic_channel_seen where topic_id = ${topic.id}`)[0].parent_id).toBe(s.archive)
  // The completion of a transition cannot be written yet: the reopen's own step is done and it stays open.
  await s.admin.unsafe(`create function boom_complete() returns trigger language plpgsql as $$ begin raise exception 'injected: the completion failed'; end $$`)
  await s.admin.unsafe(`create trigger boom before update on topic_transition for each row when (new.state = 'complete') execute function boom_complete()`)
  const reopened = await s.ask(general, { action: "reopen", topic_id: topic.id })
  const reopen = String(reopened.operation_id)
  await s.topicPass()
  expect((await topicOf(s, topic.id)).lifecycle).toBe("reopening")
  expect(s.fake.channel(topic.chat!)!.parent_id).toBe(projects)
  expect((await s.admin`select channel_state, channel_result from topic_transition where id = ${reopen}`)[0]).toMatchObject({ channel_state: "applied", channel_result: { parent: projects } })

  // In that window the owner puts the chat back. It is not made anything of while the reopen is open, across looks and a restart.
  s.fake.editChannelByHand(topic.chat!, { parent_id: s.archive })
  await later(s)
  s.restart()
  await later(s)
  expect((await topicOf(s, topic.id)).lifecycle).toBe("reopening")
  expect(await count(s, "topic_transition", `topic_id = '${topic.id}'`)).toBe(2)

  // The completion can be written. The chat is inside the category and the reopen left it in `projects`: an archive from there.
  await s.admin.unsafe(`drop trigger boom on topic_transition`)
  await later(s)
  await s.topicPass()
  await s.topicPass()
  const moves = Array.from(await s.admin`select id, kind, source, evidence, channel_plan from topic_transition where topic_id = ${topic.id} order by seq`) as unknown as PlannedMoveRow[]
  expect(moves.map(one => [one.kind, one.source])).toEqual([["archive", "tool"], ["reopen", "tool"], ["archive", "discord"]])
  expect(moves[2].evidence).toMatchObject({ observed_from: projects, observed_to: s.archive })
  expect(moves[2].evidence).not.toHaveProperty("first_observation")
  expect((await topicOf(s, topic.id)).lifecycle).toBe("archived")
  // The prior category it was seen in is real (the reopen put it there), so a later reopen has somewhere to send it.
  expect(moves[2].channel_plan).toMatchObject({ prior_parent_known: true, prior_parent: projects, apply_parent: s.archive })
  expect((await s.admin`select state from claim_gate where operation_id = ${moves[2].id}`)[0].state).toBe("open")
  expect((await s.admin`select state from claim_gate where operation_id = ${String(first.operation_id)}`)[0].state).toBe("released")
  expect(await count(s, "stop_request", `operation_id = '${moves[2].id}'`)).toBe(1)
  expect(s.fake.channel(topic.chat!)!.permission_overwrites).toEqual([{ id: s.everyone, type: 0, allow: "0", deny: MASK }])
  await later(s)
  s.restart()
  await later(s)
  expect(await count(s, "topic_transition", `topic_id = '${topic.id}'`)).toBe(3)
})

test("a retired adopted master has no binding to watch: its chat may be deleted and nothing happens to it, and adopted again onto a chat it is watched again", async () => {
  const s = await stageTopics(cluster)
  const chat = s.fake.addChannel({ name: "retiring" })
  s.rewrite({ agents: [{ id: "p1-old", person: PERSON, preset: "daily", chat, door: DOOR, runner: RUNNER_PI }] })
  await s.topicPass()
  await later(s)
  const old = await byAgent(s, "p1-old")
  expect(old).toMatchObject({ origin: "legacy", lifecycle: "active", chat })
  // Retired: the registry no longer names it (the topic is left as it was), and its chat is deleted.
  s.rewrite({})
  s.fake.removeChannel(chat)
  await later(s)
  await later(s)
  expect((await topicOf(s, old.id)).lifecycle).toBe("active")
  expect(await count(s, "claim_gate")).toBe(0)
  expect(await count(s, "topic_transition", `topic_id = '${old.id}'`)).toBe(0)
  expect(s.fake.requestsTo(new RegExp(`^GET /channels/${chat}$`))).toHaveLength(0)

  // Adopted again, onto a chat that exists: the same topic follows the master, and it is watched again.
  const again = s.fake.addChannel({ name: "again" })
  expect(await rebindLegacyTopic(s.as("hub_hub"), "p1-old", again)).toBe("rebound")
  s.rewrite({ agents: [{ id: "p1-old", person: PERSON, preset: "daily", chat: again, door: DOOR, runner: RUNNER_PI }] })
  await later(s)
  expect(await topicOf(s, old.id)).toMatchObject({ lifecycle: "active", chat: again })
  s.fake.removeChannel(again)
  await later(s)
  expect((await topicOf(s, old.id)).lifecycle).toBe("channel_missing")
})

// ---------------------------------------------------------------------------------------------
// Where a notice can go
// ---------------------------------------------------------------------------------------------

test("when neither the chat a notice belongs to nor General can take it, nothing is queued as told: the reason is kept on the operation and the topic, and check and inspect name it", async () => {
  const s = await stageTopics(cluster)
  const topic = await bound(s)
  const general = await s.binding()
  // General is archived: it is an ordinary master, nothing forbids it, and asking from itself is the same operation.
  expect(await s.ask(general, { action: "archive", topic_id: GENERAL })).toMatchObject({ status: "stopping" })
  await s.topicPass()
  await s.topicPass()
  const generalTopic = await byAgent(s, GENERAL)
  expect(generalTopic.lifecycle).toBe("archived")

  // The topic is archived from its own chat: that chat is read only now, and General cannot take a line. There is nowhere to say it.
  const own = await s.binding(topic.agent_id)
  const reply = await s.ask(own, { action: "archive" })
  await s.topicPass()
  await s.topicPass()
  expect((await topicOf(s, topic.id)).lifecycle).toBe("archived")
  expect(await noticeOf(s, `topic:archive-done:${reply.operation_id}`)).toBeUndefined()
  expect(await count(s, "outbox", `notice_key = 'topic:archive-done:${reply.operation_id}'`)).toBe(0)
  const [done] = await s.admin`select evidence from topic_transition where id = ${String(reply.operation_id)}`
  expect(done.evidence.notice).toBe("general_unusable")
  expect(attentionGapsOf(await topicOf(s, topic.id))).toEqual([{ kind: "archive-done", cause: "general_unusable", at: expect.any(String) }])
  const find = () => topicFindings({ store: s.as("hub_hub"), registry: s.load(), machine: "pi", now: new Date(), doors: new Set([DOOR]), agents: [] })
  const found = (await find()).map(one => [one.kind, one.subject]).sort()
  expect(found).toEqual([
    ["general-unusable", PERSON], ["topic-attention-unavailable", `${generalTopic.id}:archive-done`], ["topic-attention-unavailable", `${topic.id}:archive-done`],
  ].sort())
  const inspected = await s.ask(await s.binding(), { action: "inspect", topic_id: topic.id })
  expect(String(inspected.status_message)).toContain("could not be delivered")
  expect(inspected).toMatchObject({ topic: { attention_unavailable: [{ kind: "archive-done", cause: "general_unusable" }] } })
})

test("a General whose model is held still receives the door's notice, exactly once: it is a chat that can take a line, and nothing here treats it as gone", async () => {
  const s = await stageTopics(cluster)
  const topic = await bound(s)
  // General's agent is gated and its input is held: its model cannot run. Its chat is an ordinary place for a line.
  await s.admin`select hub_gate_place('op-hold', 'agent', ${GENERAL}, 'council', '{}'::jsonb)`
  await s.admin`insert into inbound (id, person, agent, body, kind) values ('general-waits', ${PERSON}, ${GENERAL}, 'a message that waits', 'human')`
  expect((await s.admin`select hub_row_held('general-waits') as held`)[0].held).toBe(true)
  const own = await s.binding(topic.agent_id)
  const reply = await s.ask(own, { action: "archive" })
  await s.topicPass()
  await s.topicPass()
  const said = await noticeOf(s, `topic:archive-done:${reply.operation_id}`)
  expect(said.agent).toBe(GENERAL)
  expect(said.route).toEqual({ door: DOOR, chat: s.general })
  await s.topicPass()
  s.restart()
  await s.topicPass()
  expect(await count(s, "outbox", `notice_key = 'topic:archive-done:${reply.operation_id}'`)).toBe(1)
  expect(attentionGapsOf(await topicOf(s, topic.id))).toEqual([])
  expect((await find(s)).filter(one => one.kind === "general-unusable" || one.kind === "topic-attention-unavailable")).toEqual([])
})

const find = (s: TopicsStage) => topicFindings({ store: s.as("hub_hub"), registry: s.load(), machine: "pi", now: new Date(), doors: new Set([DOOR]), agents: [] })

test("General can be archived and reopened like any other master: asked from its own chat, and reopened by moving its channel out of the archive category, with no turn of its model", async () => {
  const s = await stageTopics(cluster)
  const general = await s.binding()
  await s.topicPass()
  const generalTopic = await byAgent(s, GENERAL)
  const reply = await s.ask(general, { action: "archive" })
  expect(reply).toMatchObject({ status: "stopping", object_id: generalTopic.id })
  await s.topicPass()
  await s.topicPass()
  expect((await topicOf(s, generalTopic.id)).lifecycle).toBe("archived")
  expect(s.fake.channel(s.general)!.parent_id).toBe(s.archive)
  // There is nowhere to say it but the chat that just became read only: it is kept as a reason, not queued as told.
  expect(await noticeOf(s, `topic:archive-done:${reply.operation_id}`)).toBeUndefined()
  expect(attentionGapsOf(await topicOf(s, generalTopic.id)).map(one => [one.kind, one.cause])).toEqual([["archive-done", "general_unusable"]])

  // The owner moves the channel out of the archive category in Discord. The door sees it and reopens it; the agent takes no turn.
  s.fake.editChannelByHand(s.general, { parent_id: null })
  await later(s)
  expect((await s.admin`select kind, source from topic_transition where topic_id = ${generalTopic.id} order by seq desc limit 1`)[0]).toEqual({ kind: "reopen", source: "discord" })
  await s.topicPass()
  await s.topicPass()
  expect((await topicOf(s, generalTopic.id)).lifecycle).toBe("active")
  expect(s.fake.channel(s.general)!.permission_overwrites).toEqual([])
  // Restored by the time it is said, so it is said where the person is: in General.
  const said = await s.admin`select agent, route, body from outbox where notice_key like 'topic:reopen-done:%'`
  expect(said).toHaveLength(1)
  expect(said[0]).toMatchObject({ agent: GENERAL, route: { door: DOOR, chat: s.general } })
  expect(said[0].body).toContain("is open again")
  expect(await count(s, "inbound", `agent = '${GENERAL}' and kind = 'human' and id not like 'owner-%'`)).toBe(0)
})

// ---------------------------------------------------------------------------------------------
// An adopted master follows its registry entry
// ---------------------------------------------------------------------------------------------

const MASTER = (chat: string, over: Partial<AgentSpec> = {}): AgentSpec => ({ id: "p1-coffee", person: PERSON, preset: "daily", chat, door: DOOR, runner: RUNNER_PI, ...over })
const conversationsOf = async (s: TopicsStage, agent: string): Promise<string[]> =>
  (Array.from(await s.admin`select id from conversation where agent = ${agent} order by id`) as unknown as { id: string }[]).map(one => one.id)
const diaryOf = async (s: TopicsStage, subject: string): Promise<string[]> =>
  (Array.from(await s.admin`select detail ->> 'cause' as cause from ledger_event where subject = ${subject} and kind = 'failed' order by seq`) as unknown as DiaryRow[])
    .map(one => one.cause)
const openGatesOf = async (s: TopicsStage, agent: string): Promise<Set<string>> =>
  new Set((Array.from(await s.admin`select operation_id, state from claim_gate where scope_id = ${agent} and state = 'open'`) as unknown as GateRow[]).map(one => one.operation_id))
const gateState = async (s: TopicsStage, operation: string): Promise<string> =>
  (Array.from(await s.admin`select operation_id, state from claim_gate where operation_id = ${operation}`) as unknown as GateRow[])[0].state
const requestsOf = async (s: TopicsStage, topic: string): Promise<RequestRow[]> =>
  Array.from(await s.admin`select id, kind, state, stage, evidence from topic_transition where topic_id = ${topic} and kind = 'deletion_request' order by seq`) as unknown as RequestRow[]
const movesOf = async (s: TopicsStage, topic: string): Promise<MoveRow[]> =>
  Array.from(await s.admin`select id, kind, source, evidence from topic_transition where topic_id = ${topic} and kind in ('archive', 'reopen') order by seq`) as unknown as MoveRow[]
const queuedLike = async (s: TopicsStage, pattern: string): Promise<QueuedRow[]> =>
  Array.from(await s.admin`select notice_key, agent, body, route, delivered_at from outbox where notice_key like ${pattern} order by notice_key`) as unknown as QueuedRow[]
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }
const patchesTo = (s: TopicsStage, chat: string) => s.fake.requestsTo(new RegExp(`^PATCH /channels/${chat}$`)).length
const readsOf = (s: TopicsStage, chat: string) => s.fake.requestsTo(new RegExp(`^GET /channels/${chat}$`)).length

test("an adopted master whose registry chat was edited is the same topic on the new chat: the old channel is ignored, moved into the archive or deleted, and the new one is mirrored", async () => {
  const s = await stageTopics(cluster)
  const oldChat = s.fake.addChannel({ name: "old-coffee" })
  const newChat = s.fake.addChannel({ name: "new-coffee" })
  s.rewrite({ agents: [MASTER(oldChat)] })
  await s.binding("p1-coffee")
  const history = await conversationsOf(s, "p1-coffee")
  await later(s)
  const linked = await byAgent(s, "p1-coffee")
  expect(linked).toMatchObject({ origin: "legacy", lifecycle: "active", chat: oldChat, door: DOOR, lifecycle_generation: 0 })
  expect((await s.admin`select name from topic_channel_seen where topic_id = ${linked.id}`)[0].name).toBe("old-coffee")

  // The registry edit the door supports: the entry's chat is changed, and the topic follows it, once, as the same topic.
  s.rewrite({ agents: [MASTER(newChat)] })
  await later(s)
  expect(await byAgent(s, "p1-coffee")).toMatchObject({ id: linked.id, conversation_id: linked.conversation_id, agent_id: "p1-coffee", chat: newChat, door: DOOR,
    lifecycle: "active", lifecycle_generation: 1 })
  expect(await count(s, "topic", "agent_id = 'p1-coffee'")).toBe(1)
  expect(await conversationsOf(s, "p1-coffee")).toEqual(history)
  // What was seen of the old chat went with it: the new chat was looked at as a first sight, so nothing was made of it.
  expect((await s.admin`select name from topic_channel_seen where topic_id = ${linked.id}`)[0].name).toBe("new-coffee")
  expect(await count(s, "topic_transition", `topic_id = '${linked.id}'`)).toBe(0)

  // The old channel is nothing to this master any more: moved into the archive category and then deleted, and nothing happens to it or to the master.
  s.fake.editChannelByHand(oldChat, { parent_id: s.archive })
  await later(s)
  s.fake.removeChannel(oldChat)
  await later(s)
  await later(s)
  expect(await topicOf(s, linked.id)).toMatchObject({ lifecycle: "active", chat: newChat, lifecycle_generation: 1 })
  expect(await count(s, "topic_transition", `topic_id = '${linked.id}'`)).toBe(0)
  expect(await count(s, "claim_gate")).toBe(0)
  expect(await count(s, "outbox", "notice_key like 'topic:missing:%'")).toBe(0)
  expect(readsOf(s, oldChat)).toBe(0)
  expect(patchesTo(s, oldChat)).toBe(0)

  // The new chat is the one that is mirrored: moved into the archive category it is archived, with the same gate and stop as any archive.
  s.fake.editChannelByHand(newChat, { parent_id: s.archive })
  await later(s)
  const [asked] = await movesOf(s, linked.id)
  expect(asked).toMatchObject({ kind: "archive", source: "discord", evidence: { observed_from: null, observed_to: s.archive } })
  expect(await gateState(s, asked.id)).toBe("open")
  await s.topicPass()
  await s.topicPass()
  expect((await topicOf(s, linked.id)).lifecycle).toBe("archived")
  expect(s.fake.channel(newChat)!.permission_overwrites).toEqual([{ id: s.everyone, type: 0, allow: "0", deny: MASK }])
})

test("an entry edited onto another door and chat keeps its one topic, observed only where it now is: the door it left does not look at it again, and the door it went to mirrors the new chat", async () => {
  const s = await stageTopics(cluster, { moreDoors: ["door-2"] })
  const oldChat = s.fake.addChannel({ name: "old-coffee" })
  const newChat = s.fake.addChannel({ name: "new-coffee" })
  s.rewrite({ moreDoors: ["door-2"], agents: [MASTER(oldChat)] })
  const there = newTopicsMemory()
  const second = async () => { s.fake.advance(31_000); return await runTopicPass(s.topicsContext({ door: "door-2" }), there) }
  await later(s)
  const linked = await byAgent(s, "p1-coffee")
  expect(linked).toMatchObject({ door: DOOR, chat: oldChat })

  // The entry is put behind the other door. That door's task finds the topic by its agent, and moves it: one topic, the same conversation.
  s.rewrite({ moreDoors: ["door-2"], agents: [MASTER(newChat, { door: "door-2" })] })
  await second()
  expect(await byAgent(s, "p1-coffee")).toMatchObject({ id: linked.id, conversation_id: linked.conversation_id, door: "door-2", chat: newChat, lifecycle: "active" })
  expect(await count(s, "topic", "agent_id = 'p1-coffee'")).toBe(1)

  // The door it left does not look at it again: the old chat is deleted, that door looks, and a master that is not its own is not gated.
  s.fake.removeChannel(oldChat)
  await later(s)
  await later(s)
  expect(await topicOf(s, linked.id)).toMatchObject({ lifecycle: "active", door: "door-2", chat: newChat })
  expect(await count(s, "claim_gate")).toBe(0)
  expect(await count(s, "topic_transition", `topic_id = '${linked.id}'`)).toBe(0)
  expect(readsOf(s, oldChat)).toBe(0)

  // The door it went to mirrors the new chat, and the door it left still does nothing about it.
  s.fake.editChannelByHand(newChat, { parent_id: s.archive })
  await second()
  expect((await movesOf(s, linked.id)).map(one => [one.kind, one.source])).toEqual([["archive", "discord"]])
  await second()
  await second()
  expect((await topicOf(s, linked.id)).lifecycle).toBe("archived")
  await later(s)
  expect(await count(s, "topic_transition", `topic_id = '${linked.id}'`)).toBe(1)
})

test("an entry removed and added again by hand onto another chat is the same topic: identity, conversation and history are kept, there is never a second topic, and the old chat is nothing to it", async () => {
  const s = await stageTopics(cluster)
  const oldChat = s.fake.addChannel({ name: "old-coffee" })
  const newChat = s.fake.addChannel({ name: "new-coffee" })
  s.rewrite({ agents: [MASTER(oldChat)] })
  await s.binding("p1-coffee")
  const history = await conversationsOf(s, "p1-coffee")
  await later(s)
  const linked = await byAgent(s, "p1-coffee")
  // Removed: there is no binding to watch, so the deleted chat is nothing.
  s.rewrite({})
  s.fake.removeChannel(oldChat)
  await later(s)
  await later(s)
  expect(await topicOf(s, linked.id)).toMatchObject({ lifecycle: "active", chat: oldChat })
  expect(await count(s, "claim_gate")).toBe(0)
  // Added again by hand, on another chat: the topic follows, and it is watched there.
  s.rewrite({ agents: [MASTER(newChat)] })
  await later(s)
  expect(await byAgent(s, "p1-coffee")).toMatchObject({ id: linked.id, conversation_id: linked.conversation_id, lifecycle: "active", chat: newChat })
  expect(await count(s, "topic", "agent_id = 'p1-coffee'")).toBe(1)
  expect(await conversationsOf(s, "p1-coffee")).toEqual(history)
  s.fake.removeChannel(newChat)
  await later(s)
  expect((await topicOf(s, linked.id)).lifecycle).toBe("channel_missing")
})

test("an archived master whose entry was edited onto another chat keeps its archive on the old chat: it is not moved, not watched on the new one, neither channel is touched, it is named, and put back it is watched again", async () => {
  const s = await stageTopics(cluster)
  const oldChat = s.fake.addChannel({ name: "old-coffee" })
  const newChat = s.fake.addChannel({ name: "new-coffee" })
  s.rewrite({ agents: [MASTER(oldChat)] })
  await later(s)
  const linked = await byAgent(s, "p1-coffee")
  const general = await s.binding()
  const archived = String((await s.ask(general, { action: "archive", topic_id: linked.id })).operation_id)
  await s.topicPass()
  await s.topicPass()
  expect((await topicOf(s, linked.id)).lifecycle).toBe("archived")
  expect(s.fake.channel(oldChat)!.parent_id).toBe(s.archive)
  const before = { old: patchesTo(s, oldChat), fresh: patchesTo(s, newChat) }

  // The entry is edited onto another chat while the topic is archived: the archive, its gate and its history belong to the old chat.
  s.rewrite({ agents: [MASTER(newChat)] })
  await later(s)
  s.restart()
  await later(s)
  expect(await topicOf(s, linked.id)).toMatchObject({ lifecycle: "archived", chat: oldChat, door: DOOR, lifecycle_generation: 1 })
  expect(await gateState(s, archived)).toBe("open")
  expect(await count(s, "topic_transition", `topic_id = '${linked.id}'`)).toBe(1)
  expect({ old: patchesTo(s, oldChat), fresh: patchesTo(s, newChat) }).toEqual(before)
  expect(s.fake.channel(newChat)).toMatchObject({ parent_id: null, permission_overwrites: [] })
  // The new chat is not watched: moved into the archive category, nothing is made of it.
  s.fake.editChannelByHand(newChat, { parent_id: s.archive })
  await later(s)
  expect(await count(s, "topic_transition", `topic_id = '${linked.id}'`)).toBe(1)
  // Named, in the diary and in check, and not recorded as reconciled: nothing says it was.
  expect((await diaryOf(s, linked.id)).join("\n")).toContain("topic-binding-mismatch: route_changed_while_archived")
  expect((await find(s)).map(one => [one.kind, one.subject])).toContainEqual(["topic-binding-mismatch", linked.id])

  // The compatible binding put back: it is watched again, and reopens as it always did.
  s.rewrite({ agents: [MASTER(oldChat)] })
  await later(s)
  expect((await find(s)).filter(one => one.kind === "topic-binding-mismatch")).toEqual([])
  await s.ask(general, { action: "reopen", topic_id: linked.id })
  await s.topicPass()
  await s.topicPass()
  expect(await topicOf(s, linked.id)).toMatchObject({ lifecycle: "active", chat: oldChat })
  expect(await gateState(s, archived)).toBe("released")
})

test("an entry edited while its topic is gone from the archive is not repaired by the edit: the archive and both gates stay, the request stays open, no channel is touched, and it is named", async () => {
  const s = await stageTopics(cluster)
  const oldChat = s.fake.addChannel({ name: "old-coffee" })
  const newChat = s.fake.addChannel({ name: "new-coffee" })
  s.rewrite({ agents: [MASTER(oldChat)] })
  await later(s)
  const linked = await byAgent(s, "p1-coffee")
  const general = await s.binding()
  const archived = String((await s.ask(general, { action: "archive", topic_id: linked.id })).operation_id)
  await s.topicPass()
  await s.topicPass()
  expect((await topicOf(s, linked.id)).lifecycle).toBe("archived")
  // The archived chat is deleted in Discord: gone while archived.
  s.fake.removeChannel(oldChat)
  await later(s)
  const gone = `missing:${linked.id}:2`
  expect(await topicOf(s, linked.id)).toMatchObject({ lifecycle: "channel_missing", missing_from: "archived", chat: oldChat, missing_operation: gone })
  const patched = patchesTo(s, newChat)

  s.rewrite({ agents: [MASTER(newChat)] })
  await later(s)
  s.restart()
  await later(s)
  expect(await topicOf(s, linked.id)).toMatchObject({ lifecycle: "channel_missing", missing_from: "archived", chat: oldChat, lifecycle_generation: 2 })
  expect(await openGatesOf(s, "p1-coffee")).toEqual(new Set([archived, gone]))
  expect((await requestsOf(s, linked.id)).map(one => [one.state, one.stage])).toEqual([["open", "pending_setup"]])
  expect(patchesTo(s, newChat)).toBe(patched)
  expect(s.fake.channel(newChat)).toMatchObject({ parent_id: null, permission_overwrites: [] })
  expect((await diaryOf(s, linked.id)).join("\n")).toContain("topic-binding-mismatch: route_changed_while_channel_missing")
  expect((await find(s)).map(one => [one.kind, one.subject]).sort())
    .toEqual([["topic-binding-mismatch", linked.id], ["topic-channel-missing", linked.id]].sort())
})

test("a retired identity is not relinked onto another route, even for a topic that is already linked: the topic, the agent and the conversation are each refused by name and nothing moves", async () => {
  const s = await stageTopics(cluster)
  const names = ["a", "b", "c"] as const
  const chats = Object.fromEntries(names.map(name => [name, { old: s.fake.addChannel({ name: `${name}-old` }), fresh: s.fake.addChannel({ name: `${name}-new` }) }]))
  const entries = (which: "old" | "fresh"): AgentSpec[] => names.map(name => MASTER(chats[name][which], { id: `p1-${name}` }))
  s.rewrite({ agents: entries("old") })
  await later(s)
  const linked = { a: await byAgent(s, "p1-a"), b: await byAgent(s, "p1-b"), c: await byAgent(s, "p1-c") }
  // Each of the three identities of a topic is retired for one of them, after it was linked.
  await reserveIdentity(s.as("hub_hub"), "topic", linked.a.id, "history erased")
  await reserveIdentity(s.as("hub_hub"), "agent", "p1-b", "history erased")
  await reserveIdentity(s.as("hub_hub"), "conversation", linked.c.conversation_id, "history erased")

  s.rewrite({ agents: entries("fresh") })
  await later(s)
  s.restart()
  await later(s)
  for (const name of names) {
    expect(await topicOf(s, linked[name].id)).toMatchObject({ chat: chats[name].old, door: DOOR, lifecycle: "active", lifecycle_generation: 0 })
    expect((await diaryOf(s, linked[name].id)).join("\n")).toContain("topic-binding-mismatch: identity_reserved")
    expect(await count(s, "topic", `agent_id = 'p1-${name}'`)).toBe(1)
  }
  // Nothing watches either route of a retired identity: a deleted chat gates nothing.
  for (const name of names) s.fake.removeChannel(chats[name].old)
  await later(s)
  for (const name of names) expect((await topicOf(s, linked[name].id)).lifecycle).toBe("active")
  expect(await count(s, "claim_gate")).toBe(0)
  expect(await count(s, "topic_transition", "kind <> 'deletion_request'")).toBe(0)
})

test("an old channel's answer that arrives after the entry was repaired onto another chat cannot gate or archive the replacement: the read is judged again against the binding as it stands, and the replacement is watched", async () => {
  const s = await stageTopics(cluster)
  const oldChat = s.fake.addChannel({ name: "old-coffee" })
  const newChat = s.fake.addChannel({ name: "new-coffee" })
  s.rewrite({ agents: [MASTER(oldChat)] })
  await later(s)
  const linked = await byAgent(s, "p1-coffee")
  // The old channel is gone, and the door's next look is held on its read of it.
  s.fake.removeChannel(oldChat)
  const reading = deferred()
  const release = deferred()
  let held = false
  const platform = s.platform(async (method, url) => {
    if (!held && method === "GET" && url.pathname.endsWith(`/channels/${oldChat}`)) {
      held = true
      reading.resolve()
      await release.promise
    }
  })
  s.fake.advance(31_000)
  const first = s.topicPass({ platform })
  await reading.promise
  // Meanwhile the entry is repaired onto the new chat and the topic follows, as the hub's repair verb makes it.
  s.rewrite({ agents: [MASTER(newChat)] })
  expect(await rebindLegacyTopic(s.as("hub_hub"), "p1-coffee", newChat, { door: DOOR, person: PERSON })).toBe("rebound")
  release.resolve()
  await first
  // The answer of the old channel was dropped: nothing was gated, asked or told about the replacement.
  expect(await topicOf(s, linked.id)).toMatchObject({ lifecycle: "active", chat: newChat, lifecycle_generation: 1, missing_operation: null })
  expect(await count(s, "claim_gate")).toBe(0)
  expect(await count(s, "topic_transition", `topic_id = '${linked.id}'`)).toBe(0)
  expect(await count(s, "outbox", "notice_key like 'topic:missing:%'")).toBe(0)
  // The replacement is the one that is watched: when it is deleted, that is a disappearance, and its own.
  s.fake.removeChannel(newChat)
  await later(s)
  expect(await topicOf(s, linked.id)).toMatchObject({ lifecycle: "channel_missing", chat: newChat, missing_operation: `missing:${linked.id}:2` })
})

test("missing A, repaired onto B, missing B: two disappearances, each with its own gate, request and notice; the first stays released, repaired and told, the second is open and pending, and a repeat or a restart changes nothing while an unrelated hold and gate stay", async () => {
  const s = await stageTopics(cluster)
  const a = s.fake.addChannel({ name: "chat-a" })
  const b = s.fake.addChannel({ name: "chat-b" })
  s.rewrite({ agents: [MASTER(a)] })
  await later(s)
  const linked = await byAgent(s, "p1-coffee")
  // Something else holds the master: a hold on an interrupted input, and another operation's gate.
  await s.admin`insert into inbound (id, person, agent, body, kind) values ('held-input', ${PERSON}, 'p1-coffee', 'interrupted', 'human')`
  await s.admin`insert into execution (id, inbound_id, conversation_id, agent, runner, incarnation, placement_generation, state, input_digest)
    values ('held-attempt', 'held-input', ${linked.conversation_id}, 'p1-coffee', ${RUNNER_PI}, 'inc-1', 1, 'running', 'd')`
  await s.admin`update execution set state = 'stopped', ended_at = now() where id = 'held-attempt'`
  await s.admin`insert into replay_hold (inbound_id, execution_id, conversation_id, cause, state) values ('held-input', 'held-attempt', ${linked.conversation_id}, 'stopped', 'held')`
  await s.admin`select hub_gate_place('op-other', 'agent', 'p1-coffee', 'council', '{}'::jsonb)`
  const named = (generation: number) => ({ gate: `missing:${linked.id}:${generation}`, request: `deletion-request:${linked.id}:${generation}`, notice: `topic:missing:${linked.id}:${generation}` })
  const first = named(1)
  const second = named(3)

  // A disappears.
  s.fake.removeChannel(a)
  await later(s)
  expect(await topicOf(s, linked.id)).toMatchObject({ lifecycle: "channel_missing", missing_from: "active", missing_operation: first.gate, lifecycle_generation: 1 })
  expect(await openGatesOf(s, "p1-coffee")).toEqual(new Set(["op-other", first.gate]))
  expect((await queuedLike(s, "topic:missing:%")).map(one => one.notice_key)).toEqual([first.notice])

  // Repaired onto B by the entry edit: the same topic; only that disappearance's gate is released, and its request is closed as repaired.
  s.rewrite({ agents: [MASTER(b)] })
  await later(s)
  expect(await topicOf(s, linked.id)).toMatchObject({ id: linked.id, lifecycle: "active", chat: b, missing_operation: null, lifecycle_generation: 2 })
  expect(await gateState(s, first.gate)).toBe("released")
  expect(await openGatesOf(s, "p1-coffee")).toEqual(new Set(["op-other"]))
  expect((await requestsOf(s, linked.id)).map(one => [one.id, one.state, one.stage])).toEqual([[first.request, "failed", "repaired"]])

  // B disappears too: a new operation, not the first one again.
  s.fake.removeChannel(b)
  await later(s)
  expect(await topicOf(s, linked.id)).toMatchObject({ lifecycle: "channel_missing", chat: b, missing_operation: second.gate, lifecycle_generation: 3 })
  expect(await gateState(s, first.gate)).toBe("released")
  expect(await gateState(s, second.gate)).toBe("open")
  expect(await openGatesOf(s, "p1-coffee")).toEqual(new Set(["op-other", second.gate]))
  expect((await requestsOf(s, linked.id)).map(one => [one.id, one.state, one.stage]))
    .toEqual([[first.request, "failed", "repaired"], [second.request, "open", "pending_setup"]])
  expect((await queuedLike(s, "topic:missing:%")).map(one => one.notice_key)).toEqual([first.notice, second.notice].sort())

  // Looked at again and after restarts: the same disappearance is the same operation, and nothing is made twice.
  await later(s)
  s.restart()
  await later(s)
  await later(s)
  expect(await count(s, "claim_gate", "operation_id like 'missing:%'")).toBe(2)
  expect(await count(s, "topic_transition", `topic_id = '${linked.id}' and kind = 'deletion_request'`)).toBe(2)
  expect(await count(s, "outbox", "notice_key like 'topic:missing:%'")).toBe(2)
  // Nothing else that held the master was let go.
  expect(await gateState(s, "op-other")).toBe("open")
  expect((await s.admin`select state, choice from replay_hold where inbound_id = 'held-input'`)[0]).toMatchObject({ state: "held", choice: null })
  expect((await s.admin`select hub_row_held('held-input') as held`)[0].held).toBe(true)
})

test("an agent that reappears on the route it vanished from repairs nothing: the missing gate stays and the request stays open, and only a changed, validated binding brings it back", async () => {
  const s = await stageTopics(cluster)
  const a = s.fake.addChannel({ name: "chat-a" })
  const b = s.fake.addChannel({ name: "chat-b" })
  s.rewrite({ agents: [MASTER(a)] })
  await later(s)
  const linked = await byAgent(s, "p1-coffee")
  s.fake.removeChannel(a)
  await later(s)
  const gone = { gate: `missing:${linked.id}:1`, request: `deletion-request:${linked.id}:1` }
  expect(await topicOf(s, linked.id)).toMatchObject({ lifecycle: "channel_missing", missing_operation: gone.gate })
  // Retired, and then added again on the very route it vanished from.
  s.rewrite({})
  await later(s)
  s.rewrite({ agents: [MASTER(a)] })
  await later(s)
  s.restart()
  await later(s)
  expect(await topicOf(s, linked.id)).toMatchObject({ lifecycle: "channel_missing", chat: a, missing_operation: gone.gate, lifecycle_generation: 1 })
  expect(await gateState(s, gone.gate)).toBe("open")
  expect((await requestsOf(s, linked.id)).map(one => [one.id, one.state])).toEqual([[gone.request, "open"]])
  // A genuinely changed binding is what repairs it.
  s.rewrite({ agents: [MASTER(b)] })
  await later(s)
  expect(await topicOf(s, linked.id)).toMatchObject({ lifecycle: "active", chat: b, missing_operation: null })
  expect(await gateState(s, gone.gate)).toBe("released")
  expect((await requestsOf(s, linked.id)).map(one => [one.id, one.state, one.stage])).toEqual([[gone.request, "failed", "repaired"]])
})

// ---------------------------------------------------------------------------------------------
// What could not be told is caught up with
// ---------------------------------------------------------------------------------------------

test("General archived and then reopened is caught up with: one keyed notice names what was missed and where it stands now, the gap and the stale findings go, it is queued and not delivered, and no agent gets an input", async () => {
  const s = await stageTopics(cluster)
  const general = await s.binding()
  await s.topicPass()
  const generalTopic = await byAgent(s, GENERAL)
  await s.ask(general, { action: "archive" })
  await s.topicPass()
  await s.topicPass()
  expect((await topicOf(s, generalTopic.id)).lifecycle).toBe("archived")
  expect(attentionDebtOf(await topicOf(s, generalTopic.id)).map(one => [one.kind, one.cause])).toEqual([["archive-done", "general_unusable"]])
  expect((await find(s)).map(one => one.kind).sort()).toEqual(["general-unusable", "topic-attention-unavailable"])
  // While nothing can take it, the debt keeps the door due at the retry interval, well before the next look at the server.
  s.fake.advance(31_000)
  expect(await s.topicPass({ pollSeconds: 600 })).toBe(s.fake.now() + 30_000)
  expect(await count(s, "outbox", "notice_key like 'topic:attention-catchup:%'")).toBe(0)

  // General is reopened in Discord's own app. The pass above looked at the server with the 600 s interval, so the next look is due
  // exactly that far on (fake time): when it comes the move is seen, and the pass that finds General usable pays the debt: once.
  s.fake.editChannelByHand(s.general, { parent_id: null })
  await later(s, 600_000)
  await s.topicPass()
  await s.topicPass()
  expect((await topicOf(s, generalTopic.id)).lifecycle).toBe("active")
  const caught = await queuedLike(s, `topic:attention-catchup:${generalTopic.id}:%`)
  expect(caught).toHaveLength(1)
  expect(caught[0]).toMatchObject({ agent: GENERAL, route: { door: DOOR, chat: s.general }, delivered_at: null })
  expect(caught[0].notice_key).toBe(`topic:attention-catchup:${generalTopic.id}:archive-done.1`)
  // It says what was missed and where the chat stands now, and does not claim the original was told.
  expect(caught[0].body).toContain("it was archived")
  expect(caught[0].body).toContain("Right now it is open")
  expect(caught[0].body).toContain("not the original message")
  expect(caught[0].body).not.toContain("delivered")
  expect(attentionGapsOf(await topicOf(s, generalTopic.id))).toEqual([])
  expect((await find(s)).filter(one => one.kind === "general-unusable" || one.kind === "topic-attention-unavailable")).toEqual([])
  expect(await count(s, "inbound", `agent = '${GENERAL}' and kind = 'human' and id not like 'owner-%'`)).toBe(0)
  // Nothing more, however many looks and restarts follow.
  await later(s)
  s.restart()
  await later(s)
  expect(await count(s, "outbox", "notice_key like 'topic:attention-catchup:%'")).toBe(1)
})

test("attention owed for a chat that is gone is paid once a place can take it, though nothing on the door is left to watch: the very gap the disappearance left, with no deletion question that has been settled", async () => {
  // An adopted master (the registry's own, so no chat of the person's is recorded as where it was asked for) is the door's only topic,
  // and the person has no General: the disappearance has nowhere to be told, and once its chat is gone nothing on the door is watched.
  const s = await stageTopics(cluster)
  const chat = s.fake.addChannel({ name: "chat-a" })
  s.rewrite({ person: { general: undefined }, withoutGeneralAgent: true, agents: [MASTER(chat)] })
  await s.topicPass()
  const topic = await byAgent(s, "p1-coffee")
  expect(topic).toMatchObject({ origin: "legacy", lifecycle: "active", chat })
  expect(topic.setup.origin ?? null).toBeNull()
  s.fake.removeChannel(chat)
  await later(s)
  expect((await topicOf(s, topic.id)).lifecycle).toBe("channel_missing")
  // Nobody could be told: the gap is kept, and no request for a deletion has been asked in any chat.
  expect(await count(s, "outbox", "notice_key like 'topic:missing:%'")).toBe(0)
  expect(attentionDebtOf(await topicOf(s, topic.id)).map(one => [one.kind, one.cause, one.seq])).toEqual([["missing", "general_not_configured", 1]])
  expect(await count(s, "outbox", "notice_key like 'topic:attention-catchup:%'")).toBe(0)
  // Only the registry can pay it, so nothing is polled for: the task has nothing due, and nothing else on the door is watched.
  expect(await s.topicPass({ pollSeconds: 600 })).toBeNull()

  // A General is configured. The next pass, with no time passed, pays it: the missing gap alone kept the door's work alive.
  s.rewrite({ agents: [MASTER(chat)] })
  // (General is an ordinary master, so it is linked as a topic by this same pass; its chat is what the door looks at from now on.)
  // A retry interval no look at the server can be mistaken for: a debt that is still owed would come due exactly that far on.
  const owed = await s.topicPass({ pollSeconds: 600, retrySeconds: 7 })
  const caught = await queuedLike(s, `topic:attention-catchup:${topic.id}:%`)
  expect(caught).toHaveLength(1)
  expect(caught[0]).toMatchObject({ notice_key: `topic:attention-catchup:${topic.id}:missing.1`, agent: GENERAL, route: { door: DOOR, chat: s.general }, delivered_at: null })
  expect(caught[0].body).toContain("its chat was reported deleted in Discord")
  expect(caught[0].body).toContain("its chat is deleted in Discord")
  expect(caught[0].body).not.toContain("not available yet")
  expect(attentionDebtOf(await topicOf(s, topic.id))).toEqual([])
  expect(await count(s, "inbound", `agent = '${GENERAL}' and kind = 'human' and id not like 'owner-%'`)).toBe(0)
  // Paid: the debt no longer keeps the door due at the retry interval, and nothing more is said however often it is looked at.
  expect(owed).toBeGreaterThan(s.fake.now() + 7_000)
  expect(await s.topicPass({ pollSeconds: 600, retrySeconds: 7 })).toBeGreaterThan(s.fake.now() + 7_000)
  expect(await count(s, "outbox", "notice_key like 'topic:attention-catchup:%'")).toBe(1)
})

test("attention owed for a chat that is gone is paid in the chat the topic was asked for in when that chat can take it, though the person has no General: the origin is a place, and nothing else is chosen", async () => {
  // The topic was made from a chat of the person's (recorded as its origin), the door has no archive mapping (so that chat is no topic and
  // can take a line), and the person has no configured General. The disappearance names no origin, so its own notice has nowhere to go;
  // the catch-up, which asks for the topic's own place first, says it there in the same pass.
  const s = await stageTopics(cluster, { door: { archive_category: undefined, archive_readonly_roles: undefined }, person: { general: undefined } })
  const topic = await bound(s)
  expect(topic.setup.origin).toMatchObject({ door: DOOR, chat: s.general })
  s.fake.removeChannel(topic.chat!)
  await later(s)
  expect((await topicOf(s, topic.id)).lifecycle).toBe("channel_missing")
  expect(await count(s, "outbox", "notice_key like 'topic:missing:%'")).toBe(0)
  const caught = await queuedLike(s, `topic:attention-catchup:${topic.id}:%`)
  expect(caught).toHaveLength(1)
  expect(caught[0]).toMatchObject({ notice_key: `topic:attention-catchup:${topic.id}:missing.1`, agent: GENERAL, route: { door: DOOR, chat: s.general }, delivered_at: null })
  expect(caught[0].body).toContain("its chat was reported deleted in Discord")
  expect(caught[0].body).not.toContain("not available yet")
  expect(attentionDebtOf(await topicOf(s, topic.id))).toEqual([])
  expect(await count(s, "inbound", `agent = '${GENERAL}' and kind = 'human' and id not like 'owner-%'`)).toBe(0)
  // Once, and nothing polled for.
  expect(await s.topicPass({ pollSeconds: 600 })).toBeNull()
  await later(s)
  expect(await count(s, "outbox", "notice_key like 'topic:attention-catchup:%'")).toBe(1)
})

test("attention owed for a disappearance that was repaired since says where the chat stands now: it was reported deleted and is open, and nothing that was settled is asked again", async () => {
  const s = await stageTopics(cluster, { person: { general: undefined } })
  const a = s.fake.addChannel({ name: "chat-a" })
  const b = s.fake.addChannel({ name: "chat-b" })
  s.rewrite({ person: { general: undefined }, agents: [MASTER(a)] })
  await later(s)
  const linked = await byAgent(s, "p1-coffee")
  s.fake.removeChannel(a)
  await later(s)
  expect((await topicOf(s, linked.id)).lifecycle).toBe("channel_missing")
  // The entry is repaired onto B while nobody could be told (the person has no General): the gap is kept, and the repair does not clear it.
  s.rewrite({ person: { general: undefined }, agents: [MASTER(b)] })
  await later(s)
  expect(await topicOf(s, linked.id)).toMatchObject({ lifecycle: "active", chat: b })
  expect(attentionDebtOf(await topicOf(s, linked.id)).map(one => [one.kind, one.cause])).toEqual([["missing", "general_not_configured"]])
  expect(await count(s, "outbox", "notice_key like 'topic:missing:%'")).toBe(0)

  // A General is configured: the catch-up says what was missed and the current state.
  s.rewrite({ agents: [MASTER(b)] })
  await s.topicPass()
  const [said] = await queuedLike(s, `topic:attention-catchup:${linked.id}:%`)
  expect(said.body).toContain("its chat was reported deleted in Discord")
  expect(said.body).toContain("Right now it is open")
  expect(said.body).not.toContain("not available yet")
  expect(said.body).not.toContain("archived")
  expect(attentionDebtOf(await topicOf(s, linked.id))).toEqual([])
})

test("a catch-up whose write fails keeps the debt and keeps the door due; once the write works it is paid exactly once, across restarts, and the door stops being due for it", async () => {
  const s = await stageTopics(cluster)
  const topic = await bound(s)
  await noteAttention(s.as("hub_door"), topic.id, "ready", "general_unusable")
  await s.admin.unsafe(`create function boom_catchup() returns trigger language plpgsql as $$ begin raise exception 'injected: the catch-up failed'; end $$`)
  await s.admin.unsafe(`create trigger boom before insert on outbox for each row when (new.notice_key like 'topic:attention-catchup:%') execute function boom_catchup()`)
  s.fake.advance(31_000)
  const owed = await s.topicPass({ pollSeconds: 600 })
  // The write did not commit: the gap stands as it was, nothing was queued, and the pass is due again at the retry interval.
  expect(attentionDebtOf(await topicOf(s, topic.id)).map(one => [one.kind, one.seq])).toEqual([["ready", 1]])
  expect(await count(s, "outbox", "notice_key like 'topic:attention-catchup:%'")).toBe(0)
  expect(owed).toBe(s.fake.now() + 30_000)

  // A restart with the write working: paid once, and the door is due only for its next look at the server.
  await s.admin.unsafe(`drop trigger boom on outbox`)
  s.restart()
  s.fake.advance(31_000)
  const paid = await s.topicPass({ pollSeconds: 600 })
  expect((await queuedLike(s, `topic:attention-catchup:${topic.id}:%`)).map(one => one.notice_key)).toEqual([`topic:attention-catchup:${topic.id}:ready.1`])
  expect(attentionDebtOf(await topicOf(s, topic.id))).toEqual([])
  expect(paid).toBe(s.fake.now() + 600_000)
  s.restart()
  await later(s)
  await later(s)
  expect(await count(s, "outbox", "notice_key like 'topic:attention-catchup:%'")).toBe(1)
})

test("successive outages of the same kind are caught up separately: a gap that opens again after its catch-up is a later occurrence with a key of its own", async () => {
  const s = await stageTopics(cluster)
  const topic = await bound(s)
  const key = (occurrence: number) => `topic:attention-catchup:${topic.id}:ready.${occurrence}`
  await noteAttention(s.as("hub_door"), topic.id, "ready", "general_unusable")
  await later(s)
  expect((await queuedLike(s, `topic:attention-catchup:${topic.id}:%`)).map(one => one.notice_key)).toEqual([key(1)])
  expect(attentionDebtOf(await topicOf(s, topic.id))).toEqual([])
  // The same kind, after the first was caught up with, is the next occurrence.
  await noteAttention(s.as("hub_door"), topic.id, "ready", "general_unusable")
  expect(attentionDebtOf(await topicOf(s, topic.id)).map(one => [one.kind, one.seq])).toEqual([["ready", 2]])
  await later(s)
  expect((await queuedLike(s, `topic:attention-catchup:${topic.id}:%`)).map(one => one.notice_key)).toEqual([key(1), key(2)])
  expect(attentionDebtOf(await topicOf(s, topic.id))).toEqual([])
  s.restart()
  await later(s)
  expect(await count(s, "outbox", "notice_key like 'topic:attention-catchup:%'")).toBe(2)
})

// ---------------------------------------------------------------------------------------------
// Which is older, at the precision the store keeps
// ---------------------------------------------------------------------------------------------

/** A chat archived, sampled inside the archive category, reopened by the tool (which leaves it in `projects`), and then put back inside the category by hand. */
async function putBackAfterReopen(s: TopicsStage): Promise<{ topic: TopicRow; projects: string; reopen: string }> {
  const topic = await bound(s)
  const projects = s.fake.addChannel({ name: "projects", type: 4 })
  s.fake.editChannelByHand(topic.chat!, { parent_id: projects })
  const general = await s.binding()
  await s.ask(general, { action: "archive", topic_id: topic.id })
  await s.topicPass()
  await s.topicPass()
  await later(s)
  const reopened = await s.ask(general, { action: "reopen", topic_id: topic.id })
  await s.topicPass()
  await s.topicPass()
  expect((await topicOf(s, topic.id)).lifecycle).toBe("active")
  expect(s.fake.channel(topic.chat!)!.parent_id).toBe(projects)
  s.fake.editChannelByHand(topic.chat!, { parent_id: s.archive })
  return { topic, projects, reopen: String(reopened.operation_id) }
}

/**
 * The completion of the reopen and the last sample, set to two explicit microsecond timestamps in ONE millisecond, in the order asked: the
 * sample still says the chat was inside the archive category (as it did while archived). A JavaScript `Date` cannot tell them apart, and
 * the store can; the check that they are one millisecond apart from nothing is made by the store too.
 */
async function order(s: TopicsStage, topic: TopicRow, reopen: string, sample: "before-completion" | "after-completion"): Promise<void> {
  const early = "2026-06-01T12:00:00.000200Z"
  const late = "2026-06-01T12:00:00.000800Z"
  const [completed, sampled] = sample === "before-completion" ? [late, early] : [early, late]
  await s.admin`update topic_transition set updated_at = ${completed}::timestamptz where id = ${reopen}`
  await s.admin`update topic_channel_seen set present = true, parent_id = ${s.archive}, seen_at = ${sampled}::timestamptz where topic_id = ${topic.id}`
  const [row] = Array.from(await s.admin`select date_trunc('milliseconds', t.updated_at) = date_trunc('milliseconds', s.seen_at) as same_millisecond,
      t.updated_at > s.seen_at as completed_later
    from topic_transition t, topic_channel_seen s where t.id = ${reopen} and s.topic_id = ${topic.id}`) as unknown as StampRow[]
  expect(row).toEqual({ same_millisecond: true, completed_later: sample === "before-completion" })
}

test("a sample taken microseconds before a reopen completed, in the same millisecond, is older than it: the reopen's own record is used, and the chat put back inside the archive category is archived from where the reopen left it", async () => {
  const s = await stageTopics(cluster)
  const { topic, projects, reopen } = await putBackAfterReopen(s)
  await order(s, topic, reopen, "before-completion")
  await later(s)
  await s.topicPass()
  await s.topicPass()
  const moves = await movesOf(s, topic.id)
  expect(moves.map(one => [one.kind, one.source])).toEqual([["archive", "tool"], ["reopen", "tool"], ["archive", "discord"]])
  expect(moves[2].evidence).toMatchObject({ observed_from: projects, observed_to: s.archive })
  expect(moves[2].evidence).not.toHaveProperty("first_observation")
  expect((await topicOf(s, topic.id)).lifecycle).toBe("archived")
  // Once, however often it is looked at.
  await later(s)
  s.restart()
  await later(s)
  expect(await count(s, "topic_transition", `topic_id = '${topic.id}'`)).toBe(3)
})

test("a sample taken microseconds after the reopen completed, in the same millisecond, is the fresher: the chat being inside the archive category is nothing new, exactly as before", async () => {
  const s = await stageTopics(cluster)
  const { topic, reopen } = await putBackAfterReopen(s)
  await order(s, topic, reopen, "after-completion")
  await later(s)
  await later(s)
  s.restart()
  await later(s)
  expect((await movesOf(s, topic.id)).map(one => [one.kind, one.source])).toEqual([["archive", "tool"], ["reopen", "tool"]])
  expect((await topicOf(s, topic.id)).lifecycle).toBe("active")
  expect(await count(s, "claim_gate", `scope_id = '${topic.agent_id}' and state = 'open'`)).toBe(0)
})
