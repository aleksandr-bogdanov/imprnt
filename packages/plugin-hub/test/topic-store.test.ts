// The store's half of topic chats: identities made before anything outside the store happens,
// the reservation that can never be used again, the rules a topic and a transition are held to
// by the tables, and the gates and stops an archive is made of.
//
// A real Postgres, and every write goes through the roles the processes really use: the tool's
// (`hub_runner`), the door's (`hub_door`) and the hub's (`hub_hub`). Nothing here talks to a
// platform: what a platform did is what a check records through the routines, as the door would.

import { afterAll, afterEach, beforeAll, expect, test } from "bun:test"
import type { SQL } from "bun"
import { freshDatabase, hubPath, startCluster, type Cluster } from "./helpers/cluster.ts"
import { storeUrlAs, type StoreLike } from "../src/store/connect.ts"
import {
  IdentityReserved, adoptNamed, adoptRefused, allocateTopic, announceTopic, attentionCatchup, attentionDebtOf, attentionGapsOf, bindIntent, bound,
  channelKnown, completeTransition, confirmTopic, createFailed, createIntent, createLook, createUnsent, decideCreation, fenceOf, identityReserved,
  linkLegacyTopic, markChannelMissing, missingOperationOf, newIdentity, newestReopenSinceSample, noteAttention, observeChannel, readSeen, readTopic,
  readTopicByAgent, readTransition, rebindLegacyTopic, recordChannel, requestTransition, reserveIdentity, setTopicStatus, type CatchupAnswer,
  type TopicIdentity, type TopicRow, type TopicSetup,
} from "../src/store/topics.ts"
import { freezeConfirmation } from "../src/store/confirmations.ts"
import { conversationFor } from "../src/store/conversations.ts"
import { releaseGates } from "../src/store/controls.ts"
import { MIGRATION_FILES, migrate } from "../src/store/migrate.ts"
import { readFileSync } from "node:fs"
import { rolloutDatabase } from "./helpers/rollout-fixtures.ts"

let cluster: Cluster
const opened: SQL[] = []

beforeAll(async () => { cluster = await startCluster() })
afterEach(async () => { for (const sql of opened.splice(0)) await sql.close().catch(() => {}) })
afterAll(async () => { await cluster?.stop() })

const OWNER = "100000000000000001"

/** A statement as a real promise, so that `expect(...).rejects` reads what the store said. */
const attempt = async (query: PromiseLike<unknown>): Promise<void> => { await query }

async function stage() {
  const db = await freshDatabase(cluster)
  const open = (role?: string): SQL => { const sql = role ? cluster.connectAs(role, db) : cluster.connect(db); opened.push(sql); return sql }
  const as = (role: string): StoreLike => ({ sql: open(role), url: storeUrlAs(cluster.url(db), role) })
  return { db, su: open(), tool: as("hub_runner"), door: as("hub_door"), hub: as("hub_hub"), as }
}
type Stage = Awaited<ReturnType<typeof stage>>

function setupOf(identity: TopicIdentity, over: Partial<TopicSetup> = {}): TopicSetup {
  return {
    topic_id: identity.topic_id, agent_id: identity.agent_id, conversation_id: identity.conversation_id, person: "p1", door: "door-d",
    chat_name: "coffee", machine: "pi", machine_from: "person", runner: "runner-pi", preset: "daily", preset_from: "person",
    adapter: "synthetic", model: "m", initial_request: "Compare the two vendors.", origin: { door: "door-d", chat: "1000000001", agent: "p1-general" },
    requested_by: OWNER, ...over,
  }
}

async function allocate(s: Stage, operation: string, over: { name?: string; identity?: () => TopicIdentity } = {}) {
  return await allocateTopic(s.tool, {
    operation, person: "p1", door: "door-d", display_name: over.name ?? "coffee", machine: "pi", runner: "runner-pi", preset: "daily",
    adapter: "synthetic", setup: identity => setupOf(identity, { chat_name: over.name ?? "coffee" }),
  }, over.identity ? { identity: over.identity } : {})
}

/** A topic taken to `bound` along the legal road, the way the door and the hub take one. */
async function bind(s: Stage, operation: string, chat: string) {
  const topic = await allocate(s, operation)
  await s.su`update topic set create_state = 'confirmed' where id = ${topic.id}`
  expect(await createIntent(s.door, topic.id, `attempt-${operation}`)).toBe("intent")
  expect(await channelKnown(s.door, topic.id, chat, { how: "test" })).toBe("channel_known")
  expect(await bindIntent(s.hub, topic.id)).toBe("bind_intent")
  expect(await bound(s.hub, topic.id, {})).toBe("bound")
  return (await readTopic(s.tool, topic.id))!
}

test("the identities are made before the preview and are three different things: the chat's name is not one of them, and the master conversation is made under its own id", async () => {
  const s = await stage()
  const topic = await allocate(s, "op-1")
  expect(topic).toMatchObject({ create_state: "previewed", lifecycle: "pending", origin: "created", display_name: "coffee", chat: null })
  // A UUID-derived agent id that is a valid folder name, made from nothing the person typed.
  expect(topic.agent_id).toMatch(/^t-[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/)
  expect(new Set([topic.id, topic.agent_id, topic.conversation_id]).size).toBe(3)
  expect(topic.agent_id).not.toContain("coffee")
  expect(topic.marker).toMatch(/^hub-topic:[0-9a-f]{16}$/)
  expect(topic.marker).not.toContain(topic.id)
  const [conversation] = await s.su`select id, agent, kind, machine, adapter, native_state from conversation where id = ${topic.conversation_id}`
  expect(conversation).toMatchObject({ agent: topic.agent_id, kind: "master", machine: "pi", adapter: "synthetic", native_state: "new" })
  // Asking again for the same operation is the same topic, and nothing new is made.
  expect((await allocate(s, "op-1")).id).toBe(topic.id)
  expect(Number((await s.su`select count(*)::int as n from topic`)[0].n)).toBe(1)
  expect(Number((await s.su`select count(*)::int as n from conversation`)[0].n)).toBe(1)
  // When the runner first serves this agent it finds the conversation that was made, and does not mint another.
  await s.su`insert into inbound (id, person, agent, body, kind) values ('first', 'p1', ${topic.agent_id}, 'hello', 'human')`
  const found = await conversationFor(s.tool, { row: { id: "first", person: "p1", agent: topic.agent_id, kind: "human" }, adapter: "synthetic", machine: "pi" })
  expect(found.id).toBe(topic.conversation_id)
})

test("a name that was used before is a new topic: the same display name gets other identities, another history folder and its own conversation", async () => {
  const s = await stage()
  const first = await allocate(s, "op-a", { name: "coffee" })
  const second = await allocate(s, "op-b", { name: "coffee" })
  expect(second.display_name).toBe(first.display_name)
  for (const field of ["id", "agent_id", "conversation_id", "marker"] as const) expect(second[field], field).not.toBe(first[field])
  expect(Number((await s.su`select count(distinct agent) as n from conversation`)[0].n)).toBe(2)
})

test("a reserved identity is never allocated, adopted, given a conversation or a message: refused by the allocation, the fences and the legacy link, and only ever by name", async () => {
  const s = await stage()
  const doomed = newIdentity()
  expect(await identityReserved(s.tool, "agent", doomed.agent_id)).toBe(false)
  expect(await reserveIdentity(s.hub, "agent", doomed.agent_id, "topic deleted", { by: "test" })).toBe(true)
  expect(await reserveIdentity(s.hub, "agent", doomed.agent_id, "again")).toBe(false)
  expect(await reserveIdentity(s.hub, "topic", doomed.topic_id, "topic deleted")).toBe(true)
  expect(await reserveIdentity(s.hub, "conversation", doomed.conversation_id, "topic deleted")).toBe(true)
  expect(await identityReserved(s.door, "agent", doomed.agent_id)).toBe(true)

  // The allocation skips what is reserved and makes a fresh identity: the reserved one is not reintroduced.
  const fresh = newIdentity()
  let handed = 0
  const made = await allocate(s, "op-reserved", { identity: () => (handed++ === 0 ? doomed : fresh) })
  expect(handed).toBe(2)
  expect(made.agent_id).toBe(fresh.agent_id)
  expect(made.agent_id).not.toBe(doomed.agent_id)
  // Every identity being reserved is a refusal that names it, and nothing was made.
  await expect(allocate(s, "op-all-reserved", { identity: () => doomed })).rejects.toBeInstanceOf(IdentityReserved)
  expect(Number((await s.su`select count(*)::int as n from topic where operation_id = 'op-all-reserved'`)[0].n)).toBe(0)

  // The store refuses it a conversation and a message even when something else made the row: a registry that names it by hand, an old copy, a restore.
  await expect(attempt(s.su`insert into conversation (id, person, agent, kind, adapter, native_session) values ('c-x', 'p1', ${doomed.agent_id}, 'master', 'synthetic', 's')`))
    .rejects.toThrow(/identity-reserved/)
  await expect(attempt(s.su`insert into inbound (id, person, agent, body, kind) values ('m-x', 'p1', ${doomed.agent_id}, 'hello', 'human')`)).rejects.toThrow(/identity-reserved/)
  await expect(attempt(s.su`insert into conversation (id, person, agent, kind, adapter, native_session) values (${doomed.conversation_id}, 'p1', 'p1-someone', 'master', 'synthetic', 's')`))
    .rejects.toThrow(/identity-reserved/)
  // A worker's result is not refused here: refusing it would fail the settlement of that worker.
  await s.su`insert into inbound (id, person, agent, body, kind) values ('r-x', 'p1', ${doomed.agent_id}, 'a result', 'report')`
  // An adopted master with that id does not become a topic, and a reservation is permanent.
  await expect(linkLegacyTopic(s.tool, { person: "p1", agent: doomed.agent_id, door: "door-d", chat: "1", machine: "pi", runner: "runner-pi", preset: "daily",
    adapter: "synthetic", display_name: "old" })).rejects.toBeInstanceOf(IdentityReserved)
  await expect(attempt(s.su`delete from identity_reservation where id = ${doomed.agent_id}`)).rejects.toThrow(/permanent/)
  await expect(attempt(s.su`update identity_reservation set reason = 'changed' where id = ${doomed.agent_id}`)).rejects.toThrow(/permanent/)
})

test("the approval is this topic's own: only the approved preview of a topic that still waits for it, and only when it is exactly what the topic holds", async () => {
  const s = await stage()
  const topic = await allocate(s, "op-confirm")
  const freeze = (payload: unknown) => freezeConfirmation(s.tool, { operationId: "op-confirm", operationKind: "topic.create", person: "p1", door: "door-d",
    chat: "1000000001", ownerSender: OWNER, payload, preview: "Chat: coffee", confirmation: "React with ✅" })
  const frozen = await freeze(topic.setup)
  // Not approved yet: nothing confirms it, whoever asks.
  await expect(confirmTopic(s.door, frozen.id)).rejects.toThrow(/topic-approval-invalid/)
  await s.su`update confirmation set state = 'approved', approved_by = owner_sender, approved_at = now() where id = ${frozen.id}`
  await expect(confirmTopic(s.door, "no-such-confirmation")).rejects.toThrow(/topic-approval-unknown/)
  expect(await confirmTopic(s.door, frozen.id)).toBe("confirmed")
  const confirmed = (await readTopic(s.tool, topic.id))!
  expect(confirmed).toMatchObject({ create_state: "confirmed", confirmation_id: frozen.id, confirmed_by: OWNER })
  // The same approval again changes nothing, and a topic that has moved on is not confirmed again.
  expect(await confirmTopic(s.door, frozen.id)).toBe("replay")
  // What was approved has to be what the topic holds: a preview that says something else confirms nothing.
  const other = await allocate(s, "op-other")
  const changed = await freezeConfirmation(s.tool, { operationId: "op-other", operationKind: "topic.create", person: "p1", door: "door-d", chat: "1000000001",
    ownerSender: OWNER, payload: { ...other.setup, chat_name: "something else" }, preview: "Chat: something else", confirmation: "React with ✅" })
  await s.su`update confirmation set state = 'approved', approved_by = owner_sender, approved_at = now() where id = ${changed.id}`
  await expect(confirmTopic(s.door, changed.id)).rejects.toThrow(/topic-changed/)
  expect((await readTopic(s.tool, other.id))!.create_state).toBe("previewed")
  // Another kind of approval is not a topic's.
  const kind = await freezeConfirmation(s.tool, { operationId: "op-kind", operationKind: "council.start", person: "p1", door: "door-d", chat: "1", ownerSender: OWNER,
    payload: {}, preview: "x", confirmation: "y" })
  await s.su`update confirmation set state = 'approved', approved_by = owner_sender, approved_at = now() where id = ${kind.id}`
  await expect(confirmTopic(s.door, kind.id)).rejects.toThrow(/topic-approval-invalid/)
})

test("the creation only moves along its legal edges, a lost answer is never asked for again, and the chat is set once", async () => {
  const s = await stage()
  const topic = await allocate(s, "op-edges")
  // Nobody but the routines writes a topic: the roles have no update, and the table refuses an edge that is not there.
  await expect(attempt(s.door.sql`update topic set create_state = 'bound' where id = ${topic.id}`)).rejects.toThrow()
  await expect(attempt(s.su`update topic set create_state = 'bound', lifecycle = 'active' where id = ${topic.id}`)).rejects.toThrow(/cannot be made to go/)
  await expect(attempt(s.su`update topic set agent_id = 'another' where id = ${topic.id}`)).rejects.toThrow(/keeps its identity/)

  await s.su`update topic set create_state = 'confirmed' where id = ${topic.id}`
  // One call owns the attempt; the second is told the state and does not create.
  expect(await createIntent(s.door, topic.id, "a1")).toBe("intent")
  expect(await createIntent(s.door, topic.id, "a2")).toBe("create_intent")
  // A rate limit says nothing was made: asked again after `retry`, and only for the attempt that was made.
  expect(await createUnsent(s.door, topic.id, "a-other", new Date(), {})).toBe("create_intent")
  expect(await createUnsent(s.door, topic.id, "a1", new Date(Date.now() + 1000), { rate_limited: true })).toBe("confirmed")
  expect(await createIntent(s.door, topic.id, "a3")).toBe("intent")
  expect((await readTopic(s.tool, topic.id))!.create_attempts).toBe(2)
  // A look that finds nothing is a look, and the outcome becomes unknown once the looks run out. Then only a decision moves it.
  expect(await createLook(s.door, topic.id, "a3", { looked: 1 }, new Date(), false)).toBe("create_intent")
  expect(await createLook(s.door, topic.id, "a3", { looked: 2 }, null, true)).toBe("creation_unknown")
  await expect(attempt(s.su`update topic set create_state = 'create_intent' where id = ${topic.id}`)).rejects.toThrow(/cannot be made to go/)
  expect(await createUnsent(s.door, topic.id, "a3", new Date(), {})).toBe("creation_unknown")
  expect(await decideCreation(s.tool, topic.id, "adopt", OWNER, { chat: "777" })).toBe("creation_unknown")
  expect((await readTopic(s.tool, topic.id))!.create_evidence).toMatchObject({ decision: { choice: "adopt", chat: "777", by: OWNER } })
  // A channel that is found moves it, once, and the chat never changes after.
  expect(await channelKnown(s.door, topic.id, "777", { how: "marker" })).toBe("channel_known")
  expect(await channelKnown(s.door, topic.id, "777", {})).toBe("channel_known")
  await expect(channelKnown(s.door, topic.id, "888", {})).rejects.toThrow(/another chat/)
  await expect(attempt(s.su`update topic set chat = '999' where id = ${topic.id}`)).rejects.toThrow(/set once/)
  // One chat, one topic: another topic cannot claim it.
  const next = await allocate(s, "op-edges-2")
  await s.su`update topic set create_state = 'confirmed' where id = ${next.id}`
  await createIntent(s.door, next.id, "b1")
  await expect(channelKnown(s.door, next.id, "777", {})).rejects.toThrow()
  // A refusal that says nothing was made stays refused, and only a decision asks again.
  const refused = await allocate(s, "op-edges-3")
  await s.su`update topic set create_state = 'confirmed' where id = ${refused.id}`
  await createIntent(s.door, refused.id, "c1")
  expect(await createFailed(s.door, refused.id, "c1", { cause: "access denied" })).toBe("failed")
  expect(await createIntent(s.door, refused.id, "c2")).toBe("failed")
  expect(await decideCreation(s.tool, refused.id, "recreate", OWNER)).toBe("confirmed")
  await expect(decideCreation(s.tool, refused.id, "adopt", OWNER)).resolves.toBe("confirmed")
})

test("the registry write is journaled, refused writes go back, and a topic is bound to the runner it was made for with its lifecycle active", async () => {
  const s = await stage()
  const topic = await allocate(s, "op-bind")
  await s.su`update topic set create_state = 'confirmed' where id = ${topic.id}`
  await createIntent(s.door, topic.id, "a1")
  await channelKnown(s.door, topic.id, "5001", {})
  expect((await readTopic(s.tool, topic.id))).toMatchObject({ create_state: "channel_known", lifecycle: "pending", initial_input_id: `topic-create:${topic.id}`, runner: "runner-pi", machine: "pi" })
  expect(await bindIntent(s.hub, topic.id)).toBe("bind_intent")
  // A crash here finds bind_intent and looks at the file; a refusal puts it back with what was refused.
  expect(await bindIntent(s.hub, topic.id)).toBe("bind_intent")
  const { bindRefused } = await import("../src/store/topics.ts")
  expect(await bindRefused(s.hub, topic.id, { cause: "invalid configuration" })).toBe("channel_known")
  expect((await readTopic(s.tool, topic.id))!.create_failure).toMatchObject({ cause: "invalid configuration" })
  await bindIntent(s.hub, topic.id)
  expect(await bound(s.hub, topic.id, {})).toBe("bound")
  expect((await readTopic(s.tool, topic.id))).toMatchObject({ create_state: "bound", lifecycle: "active", create_failure: null })
  // A reserved agent id is never bound.
  const doomed = await allocate(s, "op-bind-reserved")
  await s.su`update topic set create_state = 'confirmed' where id = ${doomed.id}`
  await createIntent(s.door, doomed.id, "d1")
  await channelKnown(s.door, doomed.id, "5002", {})
  await reserveIdentity(s.hub, "agent", doomed.agent_id, "topic deleted")
  await expect(bindIntent(s.hub, doomed.id)).rejects.toThrow(/identity-reserved/)
})

test("an adopted master becomes a topic once and keeps the conversation it already has, and a repair follows it only when the Hub did not make the chat", async () => {
  const s = await stage()
  await s.su`insert into inbound (id, person, agent, body, kind) values ('h1', 'p1', 'p1-coffee', 'hello', 'human')`
  const existing = await conversationFor(s.tool, { row: { id: "h1", person: "p1", agent: "p1-coffee", kind: "human" }, adapter: "synthetic", machine: "pi" })
  const link = () => linkLegacyTopic(s.tool, { person: "p1", agent: "p1-coffee", door: "door-d", chat: "2001", machine: "pi", runner: "runner-pi", preset: "daily",
    adapter: "synthetic", display_name: "p1-coffee" })
  const linked = await link()
  expect(linked).toMatchObject({ origin: "legacy", create_state: "legacy", lifecycle: "active", agent_id: "p1-coffee", conversation_id: existing.id, chat: "2001" })
  expect((await link()).id).toBe(linked.id)
  expect(Number((await s.su`select count(*)::int as n from conversation where agent = 'p1-coffee'`)[0].n)).toBe(1)
  // An adopted agent that never had a conversation gets one under the topic's own id.
  const fresh = await linkLegacyTopic(s.tool, { person: "p1", agent: "p1-tea", door: "door-d", chat: "2002", machine: "pi", runner: "runner-pi", preset: "daily",
    adapter: "synthetic", display_name: "p1-tea" })
  expect((await s.su`select id from conversation where agent = 'p1-tea'`)[0].id).toBe(fresh.conversation_id)
  // The old repair verb follows a legacy topic, refuses one the Hub made, and never one that is not active.
  expect(await rebindLegacyTopic(s.hub, "p1-coffee", "2009")).toBe("rebound")
  expect((await readTopicByAgent(s.tool, "p1-coffee"))!.chat).toBe("2009")
  const made = await bind(s, "op-made", "3001")
  expect(await rebindLegacyTopic(s.hub, made.agent_id, "3009")).toBe("managed")
  expect(await rebindLegacyTopic(s.hub, "p1-nobody", "1")).toBe("not-a-topic")
})

/** A running attempt of the topic's master, as a runner would have opened it. */
async function plantAttempt(s: Stage, topic: { agent_id: string; conversation_id: string }, state = "running") {
  await s.su`insert into inbound (id, person, agent, body, kind) values ('planted-input', 'p1', ${topic.agent_id}, 'working on it', 'human')`
  await s.su`insert into execution (id, inbound_id, conversation_id, agent, runner, incarnation, placement_generation, state, input_digest)
    values ('planted-attempt', 'planted-input', ${topic.conversation_id}, ${topic.agent_id}, 'runner-pi', 'inc-1', 1, ${state}, 'd')`
}

const PLAN = { prior_parent: null, prior_parent_known: true, apply_parent: "9001", roles: [], mask: "0" }

test("an archive gates the master and asks for a stop at once, and it is complete only when the channel shows the change AND nothing of the master is owned", async () => {
  const s = await stage()
  const topic = await bind(s, "op-arch", "4001")
  await plantAttempt(s, topic)
  const ask = (operation: string, kind: "archive" | "reopen" = "archive") => requestTransition(s.tool, { operation, topic: topic.id, kind, source: "tool", by: OWNER,
    route: { door: "door-d", chat: "1000000001" }, evidence: { note: "asked" } })
  expect(await ask("op-1")).toBe("ok")
  // No drain: the gate is closed and the stop is asked for in the same transaction as the request.
  expect((await readTopic(s.tool, topic.id))).toMatchObject({ lifecycle: "archiving", lifecycle_generation: 1, archive_operation: "op-1" })
  expect((await s.su`select scope_kind, scope_id, cause, state from claim_gate where operation_id = 'op-1'`)[0]).toEqual({ scope_kind: "agent", scope_id: topic.agent_id, cause: "archive", state: "open" })
  const stops = await s.su`select target_kind, execution_id, state, requested_by from stop_request where operation_id = 'op-1'`
  expect(stops).toHaveLength(1)
  expect(stops[0]).toMatchObject({ target_kind: "agent", execution_id: "planted-attempt", state: "requested", requested_by: OWNER })
  // The same operation again is the same one; another archive of a topic that is archiving is not a second.
  expect(await ask("op-1")).toBe("replay")
  expect(await ask("op-2")).toBe("in-progress")
  expect(await ask("op-3", "reopen")).toBe("in-progress")

  // Nothing about the channel yet: not complete, and it says which half is missing.
  expect(await completeTransition(s.door, "op-1", {}, null)).toBe("channel-pending")
  await recordChannel(s.door, "op-1", "intent", { ...PLAN }, null)
  expect(await completeTransition(s.door, "op-1", {}, null)).toBe("channel-pending")
  await recordChannel(s.door, "op-1", "applied", null, { how: "response" })
  // The channel is done and the attempt is still owned: still archiving, and the topic is not called archived.
  expect(await completeTransition(s.door, "op-1", {}, null)).toBe("stop-pending")
  await s.su`update execution set state = 'stop_requested' where id = 'planted-attempt'`
  expect((await s.su`select state from stop_request where operation_id = 'op-1'`)[0].state).toBe("stopping")
  expect(await completeTransition(s.door, "op-1", {}, null)).toBe("stop-pending")
  // Not shown to be gone is unknown, and the topic stays archiving with its reason.
  await s.su`update execution set state = 'stop_unknown' where id = 'planted-attempt'`
  expect((await s.su`select state from stop_request where operation_id = 'op-1'`)[0].state).toBe("unknown")
  expect(await completeTransition(s.door, "op-1", {}, null)).toBe("stop-pending")
  expect((await readTopic(s.tool, topic.id))!.lifecycle).toBe("archiving")
  // Shown gone: complete, with its notice queued once in the same transaction.
  await s.su`update execution set state = 'stopped', ended_at = now() where id = 'planted-attempt'`
  expect((await s.su`select state from stop_request where operation_id = 'op-1'`)[0].state).toBe("stopped")
  const notice = { person: "p1", agent: "p1-general", key: "topic:archive-done:op-1", body: "coffee is archived", route: { door: "door-d", chat: "1000000001" } }
  expect(await completeTransition(s.door, "op-1", {}, notice)).toBe("complete")
  expect(await completeTransition(s.door, "op-1", {}, notice)).toBe("complete")
  expect((await readTopic(s.tool, topic.id))!.lifecycle).toBe("archived")
  const said = await s.su`select body, route from outbox where notice_key = 'topic:archive-done:op-1'`
  expect(said).toHaveLength(1)
  // The stopped input stays held, and nothing was stamped answered to make it look finished.
  expect((await s.su`select state from inbound where id = 'planted-input'`)[0].state).not.toBe("answered")
  const [held] = await s.su`select hub_row_held('planted-input') as held`
  expect(held.held).toBe(true)
  expect((await ask("op-4")).toString()).toBe("already-archived")
})

test("a reopen releases exactly the gates the archive placed, keeps every hold, and an operation that is not the archive's cannot lift it", async () => {
  const s = await stage()
  const topic = await bind(s, "op-reopen", "4101")
  const request = (operation: string, kind: "archive" | "reopen") => requestTransition(s.tool, { operation, topic: topic.id, kind, source: "tool", by: OWNER, route: null, evidence: {} })
  expect(await request("op-reopen-0", "reopen")).toBe("not-archived")
  expect(await request("op-a", "archive")).toBe("ok")
  // Nothing was running, so nothing is owed: the channel half alone completes it.
  await recordChannel(s.door, "op-a", "intent", PLAN, null)
  await recordChannel(s.door, "op-a", "applied", null, {})
  expect(await completeTransition(s.door, "op-a", {}, null)).toBe("complete")
  // An unrelated operation's gate over the same agent survives the reopen.
  await s.su`select hub_gate_place('op-other', 'agent', ${topic.agent_id}, 'council', '{}'::jsonb)`
  expect(await request("op-b", "reopen")).toBe("ok")
  expect((await readTopic(s.tool, topic.id))!.lifecycle).toBe("reopening")
  // A reopen whose channel work is still owed is not complete; one that found somebody's edit and left it is.
  await recordChannel(s.door, "op-b", "intent", { restore: {} }, null)
  expect(await completeTransition(s.door, "op-b", {}, null)).toBe("channel-pending")
  await recordChannel(s.door, "op-b", "conflict", null, { left: ["category"] })
  // The conflict is final: nothing overwrites it, and the reopen completes with it reported.
  await expect(recordChannel(s.door, "op-b", "applied", null, {})).resolves.toBe("conflict")
  expect(await completeTransition(s.door, "op-b", {}, null)).toBe("complete")
  expect((await readTopic(s.tool, topic.id))!.lifecycle).toBe("active")
  expect((await s.su`select state from claim_gate where operation_id = 'op-a'`)[0].state).toBe("released")
  expect((await s.su`select state from claim_gate where operation_id = 'op-other'`)[0].state).toBe("open")
  // A released gate is not reopened by asking again, so a replay cannot hold work the operation finished with.
  await s.su`select hub_gate_place('op-a', 'agent', ${topic.agent_id}, 'archive', '{}'::jsonb)`
  expect((await s.su`select state from claim_gate where operation_id = 'op-a'`)[0].state).toBe("released")
  expect(await releaseGates(s.hub, { operation: "op-a" })).toBe(0)
  // The next archive is a new operation with its own gate.
  expect(await request("op-c", "archive")).toBe("ok")
  expect((await s.su`select state from claim_gate where operation_id = 'op-c'`)[0].state).toBe("open")
})

test("a chat that is gone gates its master, records one request for the shared deletion flow and erases nothing; a deletion the Hub asked for suppresses the request", async () => {
  const s = await stage()
  const topic = await bind(s, "op-gone", "4201")
  await s.su`insert into inbound (id, person, agent, body, kind) values ('kept', 'p1', ${topic.agent_id}, 'the history', 'human')`
  // The key on the notice is the store's to write: it names the notice after the disappearance.
  const notice = { person: "p1", agent: "p1-general", key: "topic:missing", body: "coffee was deleted in Discord", route: { door: "door-d", chat: "1000000001" } }
  expect(await markChannelMissing(s.door, topic.id, { read: "unknown-channel" }, notice)).toBe("ok")
  expect((await readTopic(s.tool, topic.id))!.lifecycle).toBe("channel_missing")
  const names = missingOperationOf((await readTopic(s.tool, topic.id))!)!
  expect(names).toEqual({ gate: `missing:${topic.id}:1`, request: `deletion-request:${topic.id}:1`, notice: `topic:missing:${topic.id}:1` })
  expect((await s.su`select cause, state from claim_gate where scope_id = ${topic.agent_id}`)[0]).toEqual({ cause: "channel_missing", state: "open" })
  const requests = await s.su`select id, kind, source, state, stage, route from topic_transition where topic_id = ${topic.id}`
  expect(requests).toHaveLength(1)
  expect(requests[0]).toMatchObject({ id: names.request, kind: "deletion_request", source: "discord", state: "open", stage: "pending_setup" })
  expect((await s.su`select body from outbox where notice_key = ${names.notice}`)).toHaveLength(1)
  // Once, however often it is found, and nothing was erased.
  expect(await markChannelMissing(s.door, topic.id, {}, notice)).toBe("already")
  expect(Number((await s.su`select count(*)::int as n from topic_transition where topic_id = ${topic.id}`)[0].n)).toBe(1)
  expect(Number((await s.su`select count(*)::int as n from inbound where agent = ${topic.agent_id}`)[0].n)).toBe(1)
  expect(Number((await s.su`select count(*)::int as n from conversation where id = ${topic.conversation_id}`)[0].n)).toBe(1)
  // Nothing archives or reopens a chat that is gone.
  expect(await requestTransition(s.tool, { operation: "op-x", topic: topic.id, kind: "archive", source: "tool", by: OWNER, route: null, evidence: {} })).toBe("missing")

  // A deletion the Hub itself asked for is in flight: the same disappearance asks nothing a second time.
  const other = await bind(s, "op-gone-2", "4202")
  await s.su`update topic set delete_operation = 'op-hub-delete' where id = ${other.id}`
  expect(await markChannelMissing(s.door, other.id, {}, notice)).toBe("suppressed")
  expect((await readTopic(s.tool, other.id))!.lifecycle).toBe("channel_missing")
  expect(Number((await s.su`select count(*)::int as n from topic_transition where topic_id = ${other.id}`)[0].n)).toBe(0)
  expect(await markChannelMissing(s.door, "no-such-topic", {}, null)).toBe("unknown-topic")
})

test("the migration is numbered 015, after the councils: an upgraded store carries the same topic objects, checks, fences and grants as a fresh one, applying it again changes nothing, and no role writes a topic table directly", async () => {
  const upgraded = await rolloutDatabase(cluster, true)
  const fresh = await rolloutDatabase(cluster)
  opened.push(upgraded.sql, fresh.sql)
  const applier = () => { const store = upgraded.store(); opened.push(store.sql); return store }
  await migrate(applier())
  await migrate(applier())
  const tables = ["identity_reservation", "topic", "topic_transition", "topic_channel_seen"]
  const read = async (q: any) => ({
    functions: Array.from(await q`select p.proname, pg_get_function_identity_arguments(p.oid) as args, r.rolname as owner, p.prosecdef, p.prosrc
      from pg_proc p join pg_roles r on r.oid = p.proowner
      where p.proname like 'hub_topic%' or p.proname like 'hub_identity%' or p.proname in ('hub_guard_reservation', 'hub_guard_reserved_conversation',
        'hub_guard_reserved_inbound', 'hub_guard_topic', 'hub_guard_topic_transition', 'hub_notify_topic', 'hub_notify_topic_transition')
      order by p.proname`),
    columns: Array.from(await q`select table_name, column_name, data_type, is_nullable, column_default from information_schema.columns
      where table_name in ('identity_reservation', 'topic', 'topic_transition', 'topic_channel_seen') order by table_name, ordinal_position`),
    indexes: Array.from(await q`select indexname, indexdef from pg_indexes where tablename in ('identity_reservation', 'topic', 'topic_transition', 'topic_channel_seen') order by indexname`),
    checks: Array.from(await q`select conrelid::regclass::text as t, conname, pg_get_constraintdef(oid) as d from pg_constraint
      where conrelid in ('identity_reservation'::regclass, 'topic'::regclass, 'topic_transition'::regclass, 'topic_channel_seen'::regclass) order by conrelid::regclass::text, conname`),
    triggers: Array.from(await q`select t.tgname, pg_get_triggerdef(t.oid) as d from pg_trigger t
      where t.tgname in ('identity_reservation_permanent', 'conversation_refuses_reserved', 'inbound_refuses_reserved', 'topic_rules', 'topic_notify',
        'topic_transition_rules', 'topic_transition_notify') order by t.tgname`),
    tableGrants: Array.from(await q`select table_name, grantee, privilege_type from information_schema.role_table_grants
      where table_name in ('identity_reservation', 'topic', 'topic_transition', 'topic_channel_seen') and grantee in ('hub_door', 'hub_runner', 'hub_hub', 'hub_agent')
      order by table_name, grantee, privilege_type`),
    routineGrants: Array.from(await q`select routine_name, grantee from information_schema.routine_privileges
      where (routine_name like 'hub_topic%' or routine_name like 'hub_identity%') and grantee in ('hub_door', 'hub_runner', 'hub_hub', 'hub_agent')
      order by routine_name, grantee`),
  })
  const a = await read(fresh.sql)
  const b = await read(upgraded.sql)
  expect(b).toEqual(a)
  expect(a.triggers.map((row: any) => row.tgname)).toEqual(["conversation_refuses_reserved", "identity_reservation_permanent", "inbound_refuses_reserved",
    "topic_notify", "topic_rules", "topic_transition_notify", "topic_transition_rules"])
  expect(a.functions.length).toBeGreaterThan(20)
  // Nothing writes a topic table but the store's own routines: every role only reads them.
  expect(a.tableGrants.filter((row: any) => row.privilege_type !== "SELECT"), "nobody writes a topic table directly").toEqual([])
  expect(new Set(a.tableGrants.map((row: any) => row.grantee))).toEqual(new Set(["hub_door", "hub_runner", "hub_hub"]))
  // The roles that hold the routines are the three that work with topics, and the model's login has none.
  expect(a.routineGrants.some((row: any) => row.grantee === "hub_agent")).toBe(false)
  // The version set is whole (001..015: the councils are 014, this step follows them), and the fresh schema carries the step byte for byte.
  const versions = (await upgraded.sql`select version from schema_version order by version`).map((row: any) => Number(row.version))
  expect(versions).toEqual(MIGRATION_FILES.map(([version]) => version))
  expect(versions).toEqual((await fresh.sql`select version from schema_version order by version`).map((row: any) => Number(row.version)))
  expect(MIGRATION_FILES).toContainEqual([15, "015-topics.sql"])
  const migration = readFileSync(hubPath("src/store/migrations/015-topics.sql"), "utf8")
  expect(readFileSync(hubPath("src/schema.sql"), "utf8").includes(`${migration}\ninsert into schema_version (version) values (15);\n`)).toBe(true)
  expect(tables.length).toBe(4)
  // What the step adds to the tables of the step before it is nothing: the row an upgrade found is the row it has.
  expect(Number((await upgraded.sql`select count(*)::int as n from inbound`)[0].n)).toBe(1)
  expect(Number((await upgraded.sql`select count(*)::int as n from topic`)[0].n)).toBe(0)
})

test("what the platform showed of a chat moves only on a complete observation: an error ages the record and changes nothing about the chat", async () => {
  const s = await stage()
  const topic = await bind(s, "op-seen", "4301")
  expect(await readSeen(s.tool, topic.id)).toBeNull()
  await observeChannel(s.door, topic.id, { present: true, parent_id: "9000", name: "coffee" }, null)
  const first = (await readSeen(s.tool, topic.id))!
  expect(first).toMatchObject({ present: true, parent_id: "9000", name: "coffee", last_error: null })
  await observeChannel(s.door, topic.id, null, { code: "http-403", cause: "access denied" })
  const aged = (await readSeen(s.tool, topic.id))!
  expect(aged).toMatchObject({ present: true, parent_id: "9000", name: "coffee", last_error: { code: "http-403" } })
  expect(aged.seen_at!.getTime()).toBe(first.seen_at!.getTime())
  expect(aged.checked_at!.getTime()).toBeGreaterThanOrEqual(first.checked_at!.getTime())
  await observeChannel(s.door, topic.id, { present: true, parent_id: "9001", name: "coffee" }, null)
  expect(await readSeen(s.tool, topic.id)).toMatchObject({ parent_id: "9001", last_error: null })
  expect((await readTransition(s.tool, "nothing"))).toBeNull()
})

test("two requests for the same operation at once make one topic and one conversation: the one that lost the race is given the topic that won, and none of its own identities exists", async () => {
  const s = await stage()
  const first = s.as("hub_runner")
  const second = s.as("hub_runner")
  const mine = newIdentity()
  const yours = newIdentity()
  const ask = (store: StoreLike, identity: TopicIdentity) => allocateTopic(store, {
    operation: "op-race", person: "p1", door: "door-d", display_name: "coffee", machine: "pi", runner: "runner-pi", preset: "daily",
    adapter: "synthetic", setup: made => setupOf(made),
  }, { identity: () => identity })
  let commit!: () => void
  const release = new Promise<void>(done => { commit = done })
  let allocated!: () => void
  const inside = new Promise<void>(done => { allocated = done })
  // The winner allocates inside a transaction it keeps open. The loser has read that nothing stands, and meets the routine's lock on the
  // operation: it is released only when the winner commits, and then the routine answers with the standing topic and not with the loser's own.
  const winner = first.sql.begin(async (sql) => {
    const topic = await ask({ ...first, sql: sql as never }, mine)
    allocated()
    await release
    return topic
  }) as Promise<TopicRow>
  await inside
  const loser = ask(second, yours)
  await Bun.sleep(250)
  commit()
  const [won, lost] = await Promise.all([winner, loser])
  expect(won.id).toBe(mine.topic_id)
  expect(lost).not.toBeNull()
  expect(lost.id).toBe(won.id)
  expect(lost.agent_id).toBe(mine.agent_id)
  expect(lost.conversation_id).toBe(mine.conversation_id)
  expect(Number((await s.su`select count(*)::int as n from topic where operation_id = 'op-race'`)[0].n)).toBe(1)
  expect(Number((await s.su`select count(*)::int as n from conversation`)[0].n)).toBe(1)
  expect(Number((await s.su`select count(*)::int as n from conversation where agent = ${yours.agent_id} or id = ${yours.conversation_id}`)[0].n)).toBe(0)
  expect(Number((await s.su`select count(*)::int as n from topic where id = ${yours.topic_id}`)[0].n)).toBe(0)
})

/** A topic whose create the platform refused: nothing was made. */
async function refusedCreate(s: Stage, operation: string) {
  const topic = await allocate(s, operation)
  await s.su`update topic set create_state = 'confirmed' where id = ${topic.id}`
  await createIntent(s.door, topic.id, `attempt-${operation}`)
  expect(await createFailed(s.door, topic.id, `attempt-${operation}`, { cause: "access denied" })).toBe("failed")
  return topic
}

test("an owner's adoption commits only for the decision it was read for, from an unknown create and from a refused one, and the edge out of a refused create exists for nothing else", async () => {
  const s = await stage()
  const topic = await refusedCreate(s, "op-named")
  // The generic routine never takes a refused create, and nothing but a decision naming that chat can.
  await expect(channelKnown(s.door, topic.id, "5001", {})).rejects.toThrow(/topic-not-creating/)
  expect(await adoptNamed(s.door, topic.id, "5001", 0, {})).toBe("stale")
  await expect(attempt(s.su`update topic set create_state = 'channel_known', chat = '5001' where id = ${topic.id}`)).rejects.toThrow(/cannot be made to go/)

  // Two decisions, each a revision. The older answer changes nothing once a newer decision stands.
  expect(await decideCreation(s.tool, topic.id, "adopt", OWNER, { chat: "5001" })).toBe("failed")
  expect((await readTopic(s.tool, topic.id))!.decision_seq).toBe(1)
  expect(await decideCreation(s.tool, topic.id, "adopt", OWNER, { chat: "5002" })).toBe("failed")
  expect((await readTopic(s.tool, topic.id))).toMatchObject({ decision_seq: 2, create_evidence: { decision: { choice: "adopt", chat: "5002", seq: 2 } } })
  expect(await adoptNamed(s.door, topic.id, "5001", 1, { how: "older" })).toBe("stale")
  expect(await adoptNamed(s.door, topic.id, "5002", 1, { how: "older revision, newer chat" })).toBe("stale")
  expect((await readTopic(s.tool, topic.id))).toMatchObject({ create_state: "failed", chat: null })
  // The current decision commits once: the chat, the time it became known, and no failure left behind. Again is the same answer, another chat is stale.
  expect(await adoptNamed(s.door, topic.id, "5002", 2, { how: "owner_choice" })).toBe("channel_known")
  const known = (await readTopic(s.tool, topic.id))!
  expect(known).toMatchObject({ create_state: "channel_known", chat: "5002", create_failure: null, initial_input_id: `topic-create:${topic.id}` })
  expect(known.channel_known_at).not.toBeNull()
  expect(await adoptNamed(s.door, topic.id, "5002", 2, {})).toBe("channel_known")
  expect(await adoptNamed(s.door, topic.id, "5001", 1, {})).toBe("stale")

  // An unknown create takes it the same way; a decision that was not an adoption, or a recreate, is not an adoption.
  const lost = await allocate(s, "op-named-unknown")
  await s.su`update topic set create_state = 'confirmed' where id = ${lost.id}`
  await createIntent(s.door, lost.id, "a1")
  await createLook(s.door, lost.id, "a1", { looked: 1 }, null, true)
  expect((await readTopic(s.tool, lost.id))!.create_state).toBe("creation_unknown")
  expect(await decideCreation(s.tool, lost.id, "adopt", OWNER, { chat: "5003" })).toBe("creation_unknown")
  expect(await decideCreation(s.tool, lost.id, "recreate", OWNER)).toBe("confirmed")
  expect(await adoptNamed(s.door, lost.id, "5003", 1, {})).toBe("stale")
  expect((await readTopic(s.tool, lost.id))).toMatchObject({ create_state: "confirmed", chat: null, decision_seq: 2 })
})

test("a refused adoption is kept for its own decision and is not a change of anything else: another decision is a new look", async () => {
  const s = await stage()
  const topic = await refusedCreate(s, "op-refused-adopt")
  await decideCreation(s.tool, topic.id, "adopt", OWNER, { chat: "5101" })
  expect(await adoptRefused(s.door, topic.id, 1, "not_found", "that channel does not exist")).toBe("refused")
  const kept = (await readTopic(s.tool, topic.id))!
  expect(kept).toMatchObject({ create_state: "failed", chat: null })
  expect(kept.create_evidence.adopt_refused).toMatchObject({ seq: 1, chat: "5101", code: "not_found", cause: "that channel does not exist" })
  // A refusal for a decision that is not the standing one is stale and writes nothing.
  await decideCreation(s.tool, topic.id, "adopt", OWNER, { chat: "5102" })
  expect(await adoptRefused(s.door, topic.id, 1, "not_text", "older")).toBe("stale")
  expect((await readTopic(s.tool, topic.id))!.create_evidence.adopt_refused).toMatchObject({ seq: 1, code: "not_found" })
  expect(await adoptRefused(s.door, "no-such-topic", 1, "x", "y")).toBe("unknown-topic")
})

test("a legacy master whose chat vanished while it was ACTIVE is repaired and comes back as itself: only its own missing gate is released, a hold and another operation's gate stay, and the disappearance request is closed as superseded; one that vanished mid-archive is refused by name", async () => {
  const s = await stage()
  const legacy = await linkLegacyTopic(s.tool, { person: "p1", agent: "p1-coffee", door: "door-d", chat: "2001", machine: "pi", runner: "runner-pi", preset: "daily",
    adapter: "synthetic", display_name: "p1-coffee" })
  // An input that was interrupted and is held for the owner's choice, and a gate another operation placed over the same agent.
  await s.su`insert into inbound (id, person, agent, body, kind) values ('held-input', 'p1', 'p1-coffee', 'interrupted', 'human')`
  await s.su`insert into execution (id, inbound_id, conversation_id, agent, runner, incarnation, placement_generation, state, input_digest)
    values ('held-attempt', 'held-input', ${legacy.conversation_id}, 'p1-coffee', 'runner-pi', 'inc-1', 1, 'running', 'd')`
  await s.su`update execution set state = 'stopped', ended_at = now() where id = 'held-attempt'`
  await s.su`insert into replay_hold (inbound_id, execution_id, conversation_id, cause, state) values ('held-input', 'held-attempt', ${legacy.conversation_id}, 'stopped', 'held')`
  await s.su`select hub_gate_place('op-other', 'agent', 'p1-coffee', 'council', '{}'::jsonb)`
  await observeChannel(s.door, legacy.id, { present: true, parent_id: null, name: "old" }, null)

  expect(await markChannelMissing(s.door, legacy.id, { read: "unknown-channel" }, null)).toBe("ok")
  expect(await readTopic(s.tool, legacy.id)).toMatchObject({ lifecycle: "channel_missing", missing_from: "active", lifecycle_generation: 1, missing_operation: `missing:${legacy.id}:1` })
  expect((await s.su`select state from claim_gate where operation_id = ${`missing:${legacy.id}:1`}`)[0].state).toBe("open")
  expect((await s.su`select state, stage from topic_transition where topic_id = ${legacy.id}`)[0]).toEqual({ state: "open", stage: "pending_setup" })

  // The explicit repair onto a new chat.
  expect(await rebindLegacyTopic(s.hub, "p1-coffee", "2010")).toBe("rebound")
  const back = (await readTopic(s.tool, legacy.id))!
  expect(back).toMatchObject({ id: legacy.id, agent_id: "p1-coffee", conversation_id: legacy.conversation_id, origin: "legacy", lifecycle: "active",
    chat: "2010", missing_from: null, missing_operation: null, lifecycle_generation: 2 })
  // What was observed of the old chat is dropped; the missing gate is released and nothing else is.
  expect(await readSeen(s.tool, legacy.id)).toBeNull()
  expect((await s.su`select state from claim_gate where operation_id = ${`missing:${legacy.id}:1`}`)[0].state).toBe("released")
  expect((await s.su`select state from claim_gate where operation_id = 'op-other'`)[0].state).toBe("open")
  expect((await s.su`select hub_row_held('held-input') as held`)[0].held).toBe(true)
  expect((await s.su`select state, choice from replay_hold where inbound_id = 'held-input'`)[0]).toMatchObject({ state: "held", choice: null })
  // The question the disappearance asked is closed as answered by the repair, and is no longer an open request.
  const [closed] = await s.su`select state, stage, evidence from topic_transition where topic_id = ${legacy.id} and kind = 'deletion_request'`
  expect(closed).toMatchObject({ state: "failed", stage: "repaired", evidence: { superseded: { by: "repair", chat: "2010" } } })
  expect(Number((await s.su`select count(*)::int as n from conversation where agent = 'p1-coffee'`)[0].n)).toBe(1)
  // Asking again, as a hub that died before it recorded the answer would, changes nothing.
  expect(await rebindLegacyTopic(s.hub, "p1-coffee", "2010")).toBe("rebound")
  expect((await readTopic(s.tool, legacy.id))!.lifecycle_generation).toBe(2)

  // One whose chat vanished while it was being archived keeps its archive and its gates; nothing runs on a replacement, and the old chat's restore is never applied to it.
  const tea = await linkLegacyTopic(s.tool, { person: "p1", agent: "p1-tea", door: "door-d", chat: "2002", machine: "pi", runner: "runner-pi", preset: "daily",
    adapter: "synthetic", display_name: "p1-tea" })
  expect(await requestTransition(s.tool, { operation: "op-tea", topic: tea.id, kind: "archive", source: "tool", by: OWNER, route: null, evidence: {} })).toBe("ok")
  expect(await markChannelMissing(s.door, tea.id, { read: "unknown-channel" }, null)).toBe("ok")
  expect(await readTopic(s.tool, tea.id)).toMatchObject({ lifecycle: "channel_missing", missing_from: "archiving", missing_operation: `missing:${tea.id}:2` })
  expect(await rebindLegacyTopic(s.hub, "p1-tea", "2011")).toBe("missing-gated")
  expect(await readTopic(s.tool, tea.id)).toMatchObject({ lifecycle: "channel_missing", chat: "2002" })
  expect((await s.su`select state from claim_gate where operation_id = ${`missing:${tea.id}:2`}`)[0].state).toBe("open")
  expect((await s.su`select state from claim_gate where operation_id = 'op-tea'`)[0].state).toBe("open")
  // The table itself allows the way back for nothing but a legacy master that was active.
  await expect(attempt(s.su`update topic set lifecycle = 'active' where id = ${tea.id}`)).rejects.toThrow(/cannot go from/)
  const made = await bind(s, "op-made-gone", "4501")
  await markChannelMissing(s.door, made.id, {}, null)
  await expect(attempt(s.su`update topic set lifecycle = 'active' where id = ${made.id}`)).rejects.toThrow(/cannot go from/)
})

test("the status line moves only for a chat that is active, an announcement records whether anybody could be told, and what could not be told is kept by kind and cleared when it is", async () => {
  const s = await stage()
  const topic = await bind(s, "op-status", "4601")
  const notice = { person: "p1", agent: "p1-general", key: `topic:ready:${topic.id}`, body: "the chat is created", route: { door: "door-d", chat: "1000000001" } }
  // A start is refused for a chat that is not active, and an announcement with nowhere to go says so.
  const early = await bind(s, "op-status-early", "4602")
  await requestTransition(s.tool, { operation: "op-early", topic: early.id, kind: "archive", source: "tool", by: OWNER, route: null, evidence: {} })
  expect(await announceTopic(s.door, early.id, notice, "running")).toBe(false)
  expect((await readTopic(s.tool, early.id))!.create_evidence).not.toHaveProperty("announced")
  expect(await announceTopic(s.door, topic.id, null, "waiting", "runner_offline")).toBe(true)
  expect((await readTopic(s.tool, topic.id))!.create_evidence).toMatchObject({ announced: true, status: "waiting", notice: "unroutable", status_reason: "runner_offline" })
  expect(await announceTopic(s.door, topic.id, notice, "waiting")).toBe(false)
  expect(Number((await s.su`select count(*)::int as n from outbox where notice_key = ${notice.key}`)[0].n)).toBe(0)
  // The reason it still waits changes; a start clears it, and is refused once the chat is archiving.
  expect(await setTopicStatus(s.door, topic.id, "waiting", "not_picked_up_yet")).toBe(true)
  expect((await readTopic(s.tool, topic.id))!.create_evidence).toMatchObject({ status: "waiting", status_reason: "not_picked_up_yet" })
  expect(await setTopicStatus(s.door, topic.id, "running")).toBe(true)
  const started = (await readTopic(s.tool, topic.id))!.create_evidence
  expect(started).toMatchObject({ status: "running" })
  expect(started).not.toHaveProperty("status_reason")
  await requestTransition(s.tool, { operation: "op-status-arch", topic: topic.id, kind: "archive", source: "tool", by: OWNER, route: null, evidence: {} })
  expect(await setTopicStatus(s.door, topic.id, "waiting", "runner_offline")).toBe(false)
  expect((await readTopic(s.tool, topic.id))!.create_evidence).toMatchObject({ status: "running" })

  // A notice that was queued is recorded as queued.
  const other = await bind(s, "op-status-queued", "4603")
  expect(await announceTopic(s.door, other.id, { ...notice, key: `topic:ready:${other.id}` }, "waiting")).toBe(true)
  expect((await readTopic(s.tool, other.id))!.create_evidence).toMatchObject({ announced: true, notice: "queued" })
  expect(Number((await s.su`select count(*)::int as n from outbox where notice_key = ${`topic:ready:${other.id}`}`)[0].n)).toBe(1)

  // What could not be told is kept by kind with its cause and the moment it first happened, and is cleared when a notice of that kind is routed.
  await noteAttention(s.door, other.id, "archive-done", "general_unusable")
  const gaps = attentionGapsOf((await readTopic(s.tool, other.id))!)
  expect(gaps).toEqual([{ kind: "archive-done", cause: "general_unusable", at: expect.any(String) }])
  await Bun.sleep(20)
  await noteAttention(s.door, other.id, "archive-done", "general_unusable")
  expect(attentionGapsOf((await readTopic(s.tool, other.id))!)[0].at).toBe(gaps[0].at)
  await noteAttention(s.door, other.id, "results", "general_not_configured")
  expect(attentionGapsOf((await readTopic(s.tool, other.id))!).map(one => [one.kind, one.cause])).toEqual([["archive-done", "general_unusable"], ["results", "general_not_configured"]])
  await noteAttention(s.door, other.id, "archive-done", null)
  expect(attentionGapsOf((await readTopic(s.tool, other.id))!).map(one => one.kind)).toEqual(["results"])
  await noteAttention(s.door, other.id, "never-noted", null)
  expect(attentionGapsOf((await readTopic(s.tool, other.id))!).map(one => one.kind)).toEqual(["results"])
})

// ---------------------------------------------------------------------------------------------
// The route of an adopted master, one operation for each disappearance, and what could not be told
// ---------------------------------------------------------------------------------------------

/** The columns of the rows these checks read, typed once so that no result is read as anything wider. */
type GateRow = { operation_id: string; state: string }
type RequestRow = { id: string; state: string; stage: string }
type OutboxRow = { notice_key: string; body: string }

const legacyOn = (s: Stage, agent: string, door: string, chat: string) => linkLegacyTopic(s.tool, { person: "p1", agent, door, chat, machine: "pi",
  runner: "runner-pi", preset: "daily", adapter: "synthetic", display_name: agent })
const gateOf = async (s: Stage, operation: string): Promise<string> =>
  (Array.from(await s.su`select operation_id, state from claim_gate where operation_id = ${operation}`) as unknown as GateRow[])[0].state
const openGates = async (s: Stage, agent: string): Promise<Set<string>> =>
  new Set((Array.from(await s.su`select operation_id, state from claim_gate where scope_id = ${agent} and state = 'open'`) as unknown as GateRow[]).map(one => one.operation_id))
const requestsOf = async (s: Stage, topic: string): Promise<RequestRow[]> =>
  Array.from(await s.su`select id, state, stage from topic_transition where topic_id = ${topic} and kind = 'deletion_request' order by seq`) as unknown as RequestRow[]
const noticesLike = async (s: Stage, pattern: string): Promise<OutboxRow[]> =>
  Array.from(await s.su`select notice_key, body from outbox where notice_key like ${pattern} order by notice_key`) as unknown as OutboxRow[]

test("an adopted master edited onto another chat or door is the same topic on the new route: identity, conversation and history are kept and what was seen is dropped, and every refusal is named and changes nothing", async () => {
  const s = await stage()
  await s.su`insert into inbound (id, person, agent, body, kind) values ('h1', 'p1', 'p1-coffee', 'hello', 'human')`
  const existing = await conversationFor(s.tool, { row: { id: "h1", person: "p1", agent: "p1-coffee", kind: "human" }, adapter: "synthetic", machine: "pi" })
  const coffee = await legacyOn(s, "p1-coffee", "door-d", "2001")
  await observeChannel(s.door, coffee.id, { present: true, parent_id: "9000", name: "old" }, null)

  // Another chat on another door: the same topic, agent, conversation and history, and the old chat is not remembered.
  expect(await rebindLegacyTopic(s.hub, "p1-coffee", "2050", { door: "door-e", person: "p1", requireChange: true })).toBe("rebound")
  expect(await readTopic(s.tool, coffee.id)).toMatchObject({ id: coffee.id, agent_id: "p1-coffee", conversation_id: existing.id, origin: "legacy", lifecycle: "active",
    door: "door-e", chat: "2050", lifecycle_generation: 1 })
  expect(await readSeen(s.tool, coffee.id)).toBeNull()
  expect(Number((await s.su`select count(*)::int as n from topic where agent_id = 'p1-coffee'`)[0].n)).toBe(1)
  expect(Number((await s.su`select count(*)::int as n from conversation where agent = 'p1-coffee'`)[0].n)).toBe(1)
  // Asked again for the route it has: nothing moves, not even the generation.
  expect(await rebindLegacyTopic(s.hub, "p1-coffee", "2050", { door: "door-e", person: "p1", requireChange: true })).toBe("rebound")
  expect((await readTopic(s.tool, coffee.id))!.lifecycle_generation).toBe(1)

  // Another person's agent, and a route another topic already has, are refused by name and nothing moves.
  expect(await rebindLegacyTopic(s.hub, "p1-coffee", "2060", { door: "door-e", person: "p2" })).toBe("person-mismatch")
  await legacyOn(s, "p1-tea", "door-e", "2051")
  expect(await rebindLegacyTopic(s.hub, "p1-coffee", "2051", { door: "door-e", person: "p1" })).toBe("chat-taken")
  expect(await readTopic(s.tool, coffee.id)).toMatchObject({ door: "door-e", chat: "2050", lifecycle_generation: 1 })

  // Each of the three identities of a topic, retired AFTER it was linked, refuses the move: the topic, the agent, the conversation.
  const named = { topic: await legacyOn(s, "p1-r1", "door-d", "2101"), agent: await legacyOn(s, "p1-r2", "door-d", "2102"), conversation: await legacyOn(s, "p1-r3", "door-d", "2103") }
  await reserveIdentity(s.hub, "topic", named.topic.id, "history erased")
  await reserveIdentity(s.hub, "agent", "p1-r2", "history erased")
  await reserveIdentity(s.hub, "conversation", named.conversation.conversation_id, "history erased")
  for (const [agent, chat] of [["p1-r1", "2101"], ["p1-r2", "2102"], ["p1-r3", "2103"]] as const) {
    expect(await rebindLegacyTopic(s.hub, agent, "2999", { door: "door-e", person: "p1" })).toBe("identity-reserved")
    expect((await readTopicByAgent(s.tool, agent))!.chat).toBe(chat)
  }

  // A topic the Hub made keeps its route, and the table itself refuses to move the door of one or the person of any.
  const made = await bind(s, "op-made-route", "3101")
  expect(await rebindLegacyTopic(s.hub, made.agent_id, "3199", { door: "door-e" })).toBe("managed")
  await expect(attempt(s.su`update topic set door = 'door-e' where id = ${made.id}`)).rejects.toThrow(/keeps its identity/)
  await expect(attempt(s.su`update topic set person = 'p2' where id = ${coffee.id}`)).rejects.toThrow(/keeps its identity/)

  // An archive that is being made keeps its chat, its gate and its history: the route does not follow, whatever the registry says.
  const salt = await legacyOn(s, "p1-salt", "door-d", "2004")
  expect(await requestTransition(s.tool, { operation: "op-salt", topic: salt.id, kind: "archive", source: "tool", by: OWNER, route: null, evidence: {} })).toBe("ok")
  expect(await rebindLegacyTopic(s.hub, "p1-salt", "2099", { door: "door-e", person: "p1", requireChange: true })).toBe("not-active")
  expect(await readTopic(s.tool, salt.id)).toMatchObject({ lifecycle: "archiving", door: "door-d", chat: "2004" })
  expect(await gateOf(s, "op-salt")).toBe("open")

  // Gone while active: the same agent on the same route repairs nothing, and only a changed route brings it back.
  const pepper = await legacyOn(s, "p1-pepper", "door-d", "2005")
  expect(await markChannelMissing(s.door, pepper.id, {}, null)).toBe("ok")
  const gate = `missing:${pepper.id}:1`
  expect(await rebindLegacyTopic(s.hub, "p1-pepper", "2005", { door: "door-d", person: "p1", requireChange: true })).toBe("unchanged")
  expect(await readTopic(s.tool, pepper.id)).toMatchObject({ lifecycle: "channel_missing", missing_operation: gate })
  expect(await gateOf(s, gate)).toBe("open")
  expect(await rebindLegacyTopic(s.hub, "p1-pepper", "2006", { door: "door-d", person: "p1", requireChange: true })).toBe("rebound")
  expect(await readTopic(s.tool, pepper.id)).toMatchObject({ lifecycle: "active", chat: "2006", missing_operation: null, lifecycle_generation: 2 })
  expect(await gateOf(s, gate)).toBe("released")
})

test("what was looked at is written only while the topic still stands there: after a repair the old chat's disappearance, look and archive are all refused by the store, the same chat under another generation is a different route, and the current route's still work", async () => {
  const s = await stage()
  const legacy = await legacyOn(s, "p1-coffee", "door-d", "2001")
  const old = fenceOf(legacy)
  expect(old).toEqual({ chat: "2001", generation: 0 })
  expect(await rebindLegacyTopic(s.hub, "p1-coffee", "2002", { door: "door-d", person: "p1" })).toBe("rebound")
  const notice = { person: "p1", agent: "p1-general", key: "topic:missing", body: "coffee was deleted", route: { door: "door-d", chat: "1000000001" } }
  // Every write about the old chat is refused: no gate, no request, no sample, no notice.
  expect(await markChannelMissing(s.door, legacy.id, { read: "unknown-channel" }, notice, old)).toBe("stale")
  expect(await requestTransition(s.tool, { operation: "observed:late:1", topic: legacy.id, kind: "archive", source: "discord", by: "discord:observed", route: null, evidence: {}, fence: old })).toBe("stale")
  expect(await observeChannel(s.door, legacy.id, { present: true, parent_id: "9000", name: "old" }, null, old)).toBe(false)
  expect(await readSeen(s.tool, legacy.id)).toBeNull()
  expect(Number((await s.su`select count(*)::int as n from claim_gate`)[0].n)).toBe(0)
  expect(Number((await s.su`select count(*)::int as n from topic_transition`)[0].n)).toBe(0)
  expect(Number((await s.su`select count(*)::int as n from outbox`)[0].n)).toBe(0)
  expect(await readTopic(s.tool, legacy.id)).toMatchObject({ lifecycle: "active", chat: "2002", lifecycle_generation: 1 })
  // Back onto the first chat: the same chat, and another generation, so what was looked at before is still not this.
  expect(await rebindLegacyTopic(s.hub, "p1-coffee", "2001", { door: "door-d", person: "p1" })).toBe("rebound")
  expect(await observeChannel(s.door, legacy.id, { present: true, parent_id: "9000", name: "old" }, null, old)).toBe(false)
  expect(await markChannelMissing(s.door, legacy.id, {}, notice, old)).toBe("stale")
  // What was looked at now is written.
  const current = fenceOf((await readTopic(s.tool, legacy.id))!)
  expect(current).toEqual({ chat: "2001", generation: 2 })
  expect(await observeChannel(s.door, legacy.id, { present: true, parent_id: "9000", name: "old" }, null, current)).toBe(true)
  expect(await readSeen(s.tool, legacy.id)).toMatchObject({ present: true, parent_id: "9000" })
  expect(await markChannelMissing(s.door, legacy.id, { read: "unknown-channel" }, notice, current)).toBe("ok")
})

test("every disappearance is an operation of its own: repaired and gone again, the second has its own gate, request and notice, the first stay released, closed and told, and a stale look after the repair opens nothing", async () => {
  const s = await stage()
  const legacy = await legacyOn(s, "p1-coffee", "door-d", "2001")
  await s.su`insert into inbound (id, person, agent, body, kind) values ('held-input', 'p1', 'p1-coffee', 'interrupted', 'human')`
  await s.su`insert into execution (id, inbound_id, conversation_id, agent, runner, incarnation, placement_generation, state, input_digest)
    values ('held-attempt', 'held-input', ${legacy.conversation_id}, 'p1-coffee', 'runner-pi', 'inc-1', 1, 'running', 'd')`
  await s.su`update execution set state = 'stopped', ended_at = now() where id = 'held-attempt'`
  await s.su`insert into replay_hold (inbound_id, execution_id, conversation_id, cause, state) values ('held-input', 'held-attempt', ${legacy.conversation_id}, 'stopped', 'held')`
  await s.su`select hub_gate_place('op-other', 'agent', 'p1-coffee', 'council', '{}'::jsonb)`
  const notice = { person: "p1", agent: "p1-general", key: "topic:missing", body: "coffee was deleted in Discord", route: { door: "door-d", chat: "1000000001" } }
  const named = (generation: number) => ({ gate: `missing:${legacy.id}:${generation}`, request: `deletion-request:${legacy.id}:${generation}`, notice: `topic:missing:${legacy.id}:${generation}` })

  // The first disappearance, and the same one asked again.
  expect(await markChannelMissing(s.door, legacy.id, { read: "unknown-channel" }, notice, fenceOf(legacy))).toBe("ok")
  expect(missingOperationOf((await readTopic(s.tool, legacy.id))!)).toEqual(named(1))
  expect(await markChannelMissing(s.door, legacy.id, {}, notice)).toBe("already")
  expect(await markChannelMissing(s.door, legacy.id, {}, notice, fenceOf(legacy))).toBe("stale")
  expect(await openGates(s, "p1-coffee")).toEqual(new Set(["op-other", named(1).gate]))

  // Repaired: only that disappearance's gate is released and its request is closed.
  expect(await rebindLegacyTopic(s.hub, "p1-coffee", "2002", { door: "door-d", person: "p1", requireChange: true })).toBe("rebound")
  expect(missingOperationOf((await readTopic(s.tool, legacy.id))!)).toBeNull()
  expect(await openGates(s, "p1-coffee")).toEqual(new Set(["op-other"]))
  // A look at the old chat that was on its way, and one that repeats the first disappearance, open nothing.
  expect(await markChannelMissing(s.door, legacy.id, { read: "unknown-channel" }, notice, fenceOf(legacy))).toBe("stale")
  expect(Number((await s.su`select count(*)::int as n from claim_gate where operation_id like 'missing:%'`)[0].n)).toBe(1)

  // The second disappearance is a new operation: its own gate, request and notice, while the first are as the repair left them.
  const repaired = (await readTopic(s.tool, legacy.id))!
  expect(await markChannelMissing(s.door, legacy.id, { read: "unknown-channel" }, notice, fenceOf(repaired))).toBe("ok")
  expect(missingOperationOf((await readTopic(s.tool, legacy.id))!)).toEqual(named(3))
  expect(await gateOf(s, named(1).gate)).toBe("released")
  expect(await gateOf(s, named(3).gate)).toBe("open")
  expect(await openGates(s, "p1-coffee")).toEqual(new Set(["op-other", named(3).gate]))
  expect((await requestsOf(s, legacy.id)).map(one => [one.id, one.state, one.stage]))
    .toEqual([[named(1).request, "failed", "repaired"], [named(3).request, "open", "pending_setup"]])
  expect((await noticesLike(s, "topic:missing:%")).map(one => one.notice_key)).toEqual([named(1).notice, named(3).notice])
  // A gate that was released is never placed again, and repeating the second changes nothing.
  await s.su`select hub_gate_place(${named(1).gate}, 'agent', 'p1-coffee', 'channel_missing', '{}'::jsonb)`
  expect(await gateOf(s, named(1).gate)).toBe("released")
  expect(await markChannelMissing(s.door, legacy.id, {}, notice)).toBe("already")
  expect(Number((await s.su`select count(*)::int as n from topic_transition where topic_id = ${legacy.id}`)[0].n)).toBe(2)

  // Repaired again: the second gate is released and nothing else is.
  expect(await rebindLegacyTopic(s.hub, "p1-coffee", "2003", { door: "door-d", person: "p1", requireChange: true })).toBe("rebound")
  expect(await gateOf(s, named(3).gate)).toBe("released")
  expect(await openGates(s, "p1-coffee")).toEqual(new Set(["op-other"]))
  expect((await s.su`select hub_row_held('held-input') as held`)[0].held).toBe(true)
  expect((await s.su`select state, choice from replay_hold where inbound_id = 'held-input'`)[0]).toMatchObject({ state: "held", choice: null })
})

test("attention gaps are numbered occurrences and a catch-up clears exactly the ones it names: a gap that is not standing as it was read makes it stale and nothing is queued or erased, and a later occurrence of a kind has a key of its own", async () => {
  const s = await stage()
  const topic = await bind(s, "op-catch", "6001")
  const notice = (body: string) => ({ person: "p1", agent: "p1-general", key: "ignored", body, route: { door: "door-d", chat: "1000000001" } })
  const debt = async () => attentionDebtOf((await readTopic(s.tool, topic.id))!)
  const queued = async () => (await noticesLike(s, `topic:attention-catchup:${topic.id}:%`)).map(one => one.notice_key)

  await noteAttention(s.door, topic.id, "archive-done", "general_unusable")
  await noteAttention(s.door, topic.id, "results", "general_unusable")
  expect((await debt()).map(one => [one.kind, one.seq])).toEqual([["archive-done", 1], ["results", 2]])
  // A change of cause keeps the occurrence.
  await noteAttention(s.door, topic.id, "results", "general_not_configured")
  expect((await debt()).map(one => [one.kind, one.cause, one.seq])).toEqual([["archive-done", "general_unusable", 1], ["results", "general_not_configured", 2]])

  // A gap named that is not standing as it was read makes the whole catch-up stale: nothing queued, nothing cleared.
  expect(await attentionCatchup(s.door, topic.id, [{ kind: "archive-done", seq: 1 }, { kind: "results", seq: 9 }], notice("a"))).toBe("stale")
  expect(await queued()).toEqual([])
  expect((await debt()).map(one => one.kind)).toEqual(["archive-done", "results"])
  // Exactly the ones named are cleared.
  expect(await attentionCatchup(s.door, topic.id, [{ kind: "archive-done", seq: 1 }], notice("first"))).toBe("queued")
  expect(await queued()).toEqual([`topic:attention-catchup:${topic.id}:archive-done.1`])
  expect((await noticesLike(s, `topic:attention-catchup:${topic.id}:%`))[0].body).toBe("first")
  expect((await debt()).map(one => one.kind)).toEqual(["results"])
  // The same occurrence again is gone, so it queues nothing more.
  expect(await attentionCatchup(s.door, topic.id, [{ kind: "archive-done", seq: 1 }], notice("again"))).toBe("stale")
  expect(await queued()).toHaveLength(1)

  // A later occurrence of the kind that was caught up with is numbered on, and has a key of its own.
  await noteAttention(s.door, topic.id, "archive-done", "general_unusable")
  expect((await debt()).map(one => [one.kind, one.seq])).toEqual([["archive-done", 3], ["results", 2]])
  expect(await attentionCatchup(s.door, topic.id, [{ kind: "archive-done", seq: 3 }, { kind: "results", seq: 2 }], notice("second"))).toBe("queued")
  expect(await queued()).toEqual([`topic:attention-catchup:${topic.id}:archive-done.1`, `topic:attention-catchup:${topic.id}:archive-done.3,results.2`])
  expect(await debt()).toEqual([])
  // An older catch-up cannot erase a newer gap of the kind it named.
  await noteAttention(s.door, topic.id, "archive-done", "general_unusable")
  expect(await attentionCatchup(s.door, topic.id, [{ kind: "archive-done", seq: 3 }], notice("older"))).toBe("stale")
  expect((await debt()).map(one => [one.kind, one.seq])).toEqual([["archive-done", 4]])
  expect(await attentionCatchup(s.door, topic.id, [], notice("none"))).toBe("nothing")
  expect(await attentionCatchup(s.door, "no-such-topic", [{ kind: "results", seq: 1 }], notice("nobody"))).toBe("unknown-topic")
})

test("a catch-up that races a gap opening under the row lock does not erase it: the older catch-up waits for the newer gap, reads it again, and is stale", async () => {
  const s = await stage()
  const topic = await bind(s, "op-race-gap", "6002")
  const notice = { person: "p1", agent: "p1-general", key: "ignored", body: "older", route: { door: "door-d", chat: "1000000001" } }
  await noteAttention(s.door, topic.id, "results", "general_unusable")
  let racing: Promise<CatchupAnswer> | undefined
  // The gap is cleared and opens again inside a transaction that has not committed, and the catch-up that read the first is asked meanwhile:
  // it waits for the row, and reads what committed.
  await s.su.begin(async (tx) => {
    await tx`select hub_topic_attention(${topic.id}, 'results', null)`
    await tx`select hub_topic_attention(${topic.id}, 'results', 'general_unusable')`
    racing = attentionCatchup(s.door, topic.id, [{ kind: "results", seq: 1 }], notice)
  })
  expect(await racing).toBe("stale")
  expect(attentionDebtOf((await readTopic(s.tool, topic.id))!).map(one => [one.kind, one.seq])).toEqual([["results", 2]])
  expect((await noticesLike(s, "topic:attention-catchup:%"))).toEqual([])
})

test("whether a completed reopen is newer than the last sample is judged at the precision the store keeps: two timestamps in one millisecond are ordered in both directions, and a sample at or after the completion, or none, is not older", async () => {
  const s = await stage()
  const topic = await bind(s, "op-precision", "6101")
  const ask = (operation: string, kind: "archive" | "reopen") => requestTransition(s.tool, { operation, topic: topic.id, kind, source: "tool", by: OWNER,
    route: { door: "door-d", chat: "1000000001" }, evidence: {} })
  expect(await ask("op-a", "archive")).toBe("ok")
  await recordChannel(s.door, "op-a", "intent", { ...PLAN }, null)
  await recordChannel(s.door, "op-a", "applied", null, { how: "response" })
  expect(await completeTransition(s.door, "op-a", {}, null)).toBe("complete")
  // No reopen yet: nothing to be newer.
  expect(await newestReopenSinceSample(s.tool, topic.id)).toBeNull()
  expect(await ask("op-r", "reopen")).toBe("ok")
  expect(await completeTransition(s.door, "op-r", {}, null)).toBe("complete")
  // No sample was ever taken: the reopen is the newest thing, and is not called newer than what does not exist.
  expect(await newestReopenSinceSample(s.tool, topic.id)).toMatchObject({ transition: { id: "op-r", kind: "reopen" }, newer: false })
  await observeChannel(s.door, topic.id, { present: true, parent_id: "9000", name: "coffee" }, null)

  const early = "2026-06-01T12:00:00.000200Z"
  const late = "2026-06-01T12:00:00.000800Z"
  const place = async (completed: string, sampled: string) => {
    await s.su`update topic_transition set updated_at = ${completed}::timestamptz where id = 'op-r'`
    await s.su`update topic_channel_seen set seen_at = ${sampled}::timestamptz where topic_id = ${topic.id}`
  }
  // The sample was taken 600 microseconds before the completion: the reopen is newer. A Date sees both as the same millisecond.
  await place(late, early)
  const same = (await s.su`select date_trunc('milliseconds', t.updated_at) = date_trunc('milliseconds', x.seen_at) as same from topic_transition t, topic_channel_seen x
    where t.id = 'op-r' and x.topic_id = ${topic.id}`)[0].same
  expect(same).toBe(true)
  const newer = (await newestReopenSinceSample(s.tool, topic.id))!
  expect(newer.newer).toBe(true)
  expect(newer.transition.updated_at.getTime()).toBe((await readSeen(s.tool, topic.id))!.seen_at!.getTime())
  // The sample was taken 600 microseconds after it: the sample is the fresher, and the reopen is not newer.
  await place(early, late)
  expect((await newestReopenSinceSample(s.tool, topic.id))!.newer).toBe(false)
  // At the very same instant a sample is not older than the completion.
  await place(early, early)
  expect((await newestReopenSinceSample(s.tool, topic.id))!.newer).toBe(false)
})
