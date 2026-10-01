// Confirmed topic deletion, end to end: the tool freezes a scope, only the owner's check confirms it, the agent is stopped before anything
// is erased, the active copies are removed and reported one by one, the identities are never used again, and what cannot be erased is
// said and never called erased.
//
// Real store, real door task, real hub pass, real tool handlers and the real Discord seam over a fake Discord. Time is the fake's clock.
// What is PLANTED, and decides nothing the code under test decides: the content a topic would hold (so its absence can be asserted), a
// running attempt of the master (as the runner would have opened it), and the files a machine keeps.

import { afterAll, afterEach, beforeAll, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { startCluster, type Cluster } from "./helpers/cluster.ts"
import { closeStages, removeEffectDirs } from "./helpers/effects-fixture.ts"
import { PERSON, RUNNER_PI, STRANGER, stageTopics, type TopicsStage } from "./helpers/topics-fixture.ts"
import type { Platform, PlatformAdmin } from "../src/door/platform.ts"
import { bindTopics } from "../src/hub/topics.ts"
import { runDeletions } from "../src/hub/deletions.ts"
import { loadRegistry } from "../src/registry/load.ts"
import { listAgents } from "../src/registry/entries.ts"
import { backupHold, readErasureManifest, readDeletion, receiptsOf } from "../src/store/deletions.ts"
import { IdentityReserved, allocateTopic, identityReserved, readTopic, type TopicRow } from "../src/store/topics.ts"

let cluster: Cluster
beforeAll(async () => { cluster = await startCluster() })
afterEach(closeStages)
afterAll(async () => {
  removeEffectDirs()
  await cluster?.stop()
})

const REQUEST = "Compare the two vendors, and keep it short."
const count = async (s: TopicsStage, table: string, where = "true") =>
  Number((await s.admin.unsafe(`select count(*)::int as n from ${table} where ${where}`))[0].n)
const sha = (text: string) => createHash("sha256").update(text).digest("hex")
/** A statement as a real promise: a bare postgres query is lazy, and `expect(...).rejects` would wait for one that never ran. */
const attempt = async (query: PromiseLike<unknown>): Promise<void> => { await query }

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
  return (await readTopic(s.as("hub_hub"), String(reply.object_id)))!
}

/** What a topic would hold, planted so that its absence afterwards is a finding. Returns the paths of the files it put on disk. */
async function seed(s: TopicsStage, topic: TopicRow) {
  const agent = topic.agent_id
  await s.admin`insert into inbound (id, person, agent, body, kind) values ('seed-in-1', ${PERSON}, ${agent}, 'UNIQUE-SECRET-INPUT', 'human')`
  await s.admin`insert into outbox (inbound_id, seq_in_reply, body) values ('seed-in-1', 1, 'UNIQUE-SECRET-REPLY')`
  await s.admin`insert into media (inbound_id, index, sha256, kind, name, bytes) values ('seed-in-1', 0, 'x', 'photo', 'p.jpg', '\\x00'::bytea)`
  await s.admin`insert into conversation_entry (conversation_id, seq, source_id, kind, body) values (${topic.conversation_id}, 1, 'seed-in-1', 'input', 'UNIQUE-SECRET-ENTRY')`
  await s.admin`insert into ledger_event (stream, subject, kind, actor, detail) values ('inbound', 'seed-in-1', 'received', 'door', ${{ text: "UNIQUE-SECRET-LEDGER" }}::jsonb)`
  // The movement command receipts of this topic's chat, and one that belongs to another chat and must stay.
  const key = (who: string, message: string) => JSON.stringify([who, message])
  for (const sheet of ["move_command", "move_command_done"]) {
    await s.admin`insert into state_row (sheet, id, data) values (${sheet}, ${key(agent, "msg-1")}, ${{ text: "UNIQUE-SECRET-COMMAND", agent }}::jsonb)`
    await s.admin`insert into state_row (sheet, id, data) values (${sheet}, ${key("p1-general", "msg-9")}, ${{ keep: true }}::jsonb)`
  }
  const root = join(s.dir, PERSON)
  const chatlog = join(root, "chatlog", agent)
  const inbox = join(root, "inbox", sha("seed-in-1"))
  const session = join(root, "sessions", agent)
  for (const dir of [chatlog, inbox, session]) mkdirSync(dir, { recursive: true })
  writeFileSync(join(chatlog, "2026-01-01.jsonl"), "UNIQUE-SECRET-CHATLOG\n")
  writeFileSync(join(inbox, "0.jpg"), "UNIQUE-SECRET-IMAGE")
  writeFileSync(join(session, "native.jsonl"), "UNIQUE-SECRET-SESSION")
  const other = join(root, "chatlog", "p1-general")
  mkdirSync(other, { recursive: true })
  writeFileSync(join(other, "2026-01-01.jsonl"), "KEEP-GENERAL\n")
  return { chatlog, inbox, session, other }
}

/** A running attempt of the topic's master, as a runner would have opened it. */
async function plantAttempt(s: TopicsStage, topic: TopicRow) {
  await s.admin`insert into inbound (id, person, agent, body, kind) values ('planted-input', ${PERSON}, ${topic.agent_id}, 'working on it', 'human')`
  await s.admin`insert into execution (id, inbound_id, conversation_id, agent, runner, incarnation, placement_generation, state, input_digest)
    values ('planted-attempt', 'planted-input', ${topic.conversation_id}, ${topic.agent_id}, ${RUNNER_PI}, 'inc-1', 1, 'running', 'd')`
}

const hub = (s: TopicsStage, machine: string) => runDeletions({ store: s.as("hub_hub"), registryFile: s.registryFile, machine, load: () => loadRegistry(s.registryFile, { machine }) })

/**
 * Everything a confirmed deletion needs, in the order a deployment gets it: the door erases and starts on the platform's copies, the
 * hub of the door's machine takes the agent out of the registry, the door then deletes the chat, and each machine's hub reports its copies.
 */
async function finish(s: TopicsStage, over: Parameters<TopicsStage["topicPass"]>[0] = undefined) {
  await s.topicPass(over)
  await hub(s, "pi")
  await s.topicPass(over)
  await hub(s, "mac")
  await s.topicPass(over)
}
const noticeOf = async (s: TopicsStage, key: string) => (await s.admin`select agent, body from outbox where notice_key = ${key}`)[0]

/** The owner asks for the deletion from General and confirms the preview with the check. Returns the operation. */
async function confirmed(s: TopicsStage, topic: TopicRow): Promise<string> {
  const master = await s.binding()
  const reply = await s.ask(master, { action: "delete", topic_id: topic.id })
  expect(reply.status).toBe("awaiting_confirmation")
  await s.deliver()
  await s.react(String(reply.operation_id))
  return String(reply.operation_id)
}

test("a deletion is a preview first: the scope is frozen and shown with no word of the history, nothing is erased, and only the owner's check confirms it", async () => {
  const s = await stageTopics(cluster)
  const topic = await bound(s)
  await seed(s, topic)
  const master = await s.binding()
  const reply = await s.ask(master, { action: "delete", topic_id: topic.id })
  expect(reply).toMatchObject({ status: "awaiting_confirmation", stage: "preview", object_id: topic.id })
  const op = String(reply.operation_id)
  await s.deliver()
  const shown = s.texts(s.general).join("\n")
  expect(shown).toContain("Delete the chat coffee, its agent and its active history")
  expect(shown).toContain("Earlier backup copies are not rewritten. No backup retention is configured")
  expect(shown).toContain("Kept: notes already saved in the vault")
  expect(shown).not.toContain("UNIQUE-SECRET")
  // The frozen scope is numbers and identifiers.
  const [row] = await s.admin`select stage, preview from topic_deletion where id = ${op}`
  expect(row.stage).toBe("awaiting_confirmation")
  expect(row.preview.inventory.inbound).toBeGreaterThanOrEqual(1)
  expect(row.preview.retention).toEqual({ configured_days: null })
  expect(JSON.stringify(row.preview)).not.toContain("UNIQUE-SECRET")
  // Another sender's check, and a bot's, authorize nothing.
  await s.react(op, STRANGER)
  await s.react(op, "900000000000000001", { bot: true })
  expect((await readTopic(s.as("hub_hub"), topic.id))!.lifecycle).toBe("active")
  expect(await count(s, "topic_tombstone")).toBe(0)
  expect(await count(s, "inbound", "id = 'seed-in-1'")).toBe(1)
  // Asking again changes the scope the owner is shown, and the older preview can no longer be approved.
  const again = await s.ask(master, { action: "delete", topic_id: topic.id })
  expect(again.operation_id).not.toBe(op)
  expect((await readDeletion(s.as("hub_hub"), op))!.stage).toBe("superseded")
  // The owner's check on the preview that stands confirms it, and only now is anything gated: still nothing is erased.
  await s.deliver()
  await s.react(String(again.operation_id))
  const confirmedTopic = (await readTopic(s.as("hub_hub"), topic.id))!
  expect(confirmedTopic.lifecycle).toBe("deleting")
  expect((await readDeletion(s.as("hub_hub"), String(again.operation_id)))!.stage).toBe("quiescing")
  expect(await count(s, "inbound", "id = 'seed-in-1'")).toBe(1)
  expect(await count(s, "claim_gate", `operation_id = 'delete:${again.operation_id}' and scope_id = '${topic.agent_id}' and state = 'open'`)).toBe(1)
  // The identities are reserved BEFORE any erasure, and the tombstone holds identifiers only.
  expect(await identityReserved(s.as("hub_hub"), "topic", topic.id)).toBe(true)
  expect(await identityReserved(s.as("hub_hub"), "agent", topic.agent_id)).toBe(true)
  expect(await identityReserved(s.as("hub_hub"), "conversation", topic.conversation_id)).toBe(true)
  const [tomb] = await s.admin`select * from topic_tombstone where topic_id = ${topic.id}`
  expect(JSON.stringify(tomb)).not.toContain("coffee")
  expect(JSON.stringify(tomb)).not.toContain("UNIQUE-SECRET")
  // Archive and delete are distinct: an archive is refused for a topic under deletion, by the store's own lifecycle.
  expect((await s.ask(master, { action: "archive", topic_id: topic.id })).cause).toBe("not_active")
})

test("a confirmed deletion stops the work first, erases nothing while an attempt is owned, then removes every active copy, reports each, and keeps the vault and the other chats", async () => {
  const s = await stageTopics(cluster)
  const topic = await bound(s)
  const files = await seed(s, topic)
  await plantAttempt(s, topic)
  writeFileSync(join(s.dir, "vault-note.md"), "a note already saved in the vault\n")
  const generalInputs = await s.admin`select id, body from inbound where agent = 'p1-general' order by id`
  const op = await confirmed(s, topic)

  // The agent owns an attempt that nobody has shown gone: a stop was asked for, and not one row or file is touched.
  expect(await count(s, "stop_request", `operation_id = 'delete:${op}'`)).toBeGreaterThanOrEqual(1)
  await s.topicPass()
  expect((await readDeletion(s.as("hub_hub"), op))!.stage).toBe("quiescing")
  expect(await count(s, "inbound", "id = 'seed-in-1'")).toBe(1)
  expect(existsSync(files.chatlog)).toBe(true)
  // A backup assembled now would carry what is being deleted, so it is held and says why.
  expect(await backupHold(s.as("hub_hub"), "pi")).toContain("has not erased the store's rows yet")

  // The runner shows it stopped; the next pass erases.
  await s.admin`update execution set state = 'stopped', ended_at = now() where id = 'planted-attempt'`
  await s.topicPass()
  const afterErase = (await readDeletion(s.as("hub_hub"), op))!
  expect(["pending_machine", "blocked_scope", "verifying_active"]).toContain(afterErase.stage)
  for (const [table, where] of [
    ["inbound", `agent = '${topic.agent_id}' or id = 'seed-in-1'`], ["outbox", "body = 'UNIQUE-SECRET-REPLY'"], ["media", "inbound_id = 'seed-in-1'"],
    ["conversation", `agent = '${topic.agent_id}'`], ["conversation_entry", `conversation_id = '${topic.conversation_id}'`],
    ["execution", `agent = '${topic.agent_id}'`], ["ledger_event", "subject = 'seed-in-1'"], ["topic", `id = '${topic.id}'`],
    ["state_row", `sheet in ('move_command', 'move_command_done') and id like '%${topic.agent_id}%'`],
    ["platform_effect", `chat = '${topic.chat}'`], ["confirmation", `payload ->> 'topic_id' = '${topic.id}'`],
  ] as const) expect(await count(s, table, where), table).toBe(0)
  // The movement command receipts of OTHER chats stay, and so does everything of General's.
  expect(await count(s, "state_row", "sheet in ('move_command', 'move_command_done') and id like '%msg-9%'")).toBe(2)
  for (const input of generalInputs) {
    const kept = await s.admin`select id, body from inbound where id = ${input.id}`
    expect(kept[0]).toEqual(input)
  }
  // The deletion's own record holds numbers.
  const [kept] = await s.admin`select erased, quiesce from topic_deletion where id = ${op}`
  expect(kept.erased.inbound).toBeGreaterThanOrEqual(1)
  expect(JSON.stringify(kept)).not.toContain("UNIQUE-SECRET")

  // The platform: the Hub's own preview of the chat's creation, posted in General, is gone, and the deletion's own preview stays. The chat
  // itself waits for its agent to be out of the registry, so that no door reads a channel that is gone for an agent still declared.
  expect(s.texts(s.general).join("\n")).not.toContain("Compare the two vendors")
  expect(s.texts(s.general).join("\n")).toContain("Delete the chat coffee")
  expect(s.fake.channel(topic.chat!)!.exists).toBe(true)

  // One machine reports; the other is offline, so the deletion is waiting and says so, and nothing calls it done.
  await hub(s, "pi")
  await s.topicPass()
  expect(s.fake.channel(topic.chat!)!.exists).toBe(false)
  expect(existsSync(files.chatlog)).toBe(false)
  expect(existsSync(files.inbox)).toBe(false)
  expect(existsSync(files.session)).toBe(false)
  expect(existsSync(files.other)).toBe(true)
  expect(listAgents(s.load()).some(one => one.id === topic.agent_id)).toBe(false)
  const waiting = (await readDeletion(s.as("hub_hub"), op))!
  expect(waiting.stage).toBe("pending_machine")
  expect(waiting.blocked!.waiting.every(one => one.machine === "mac")).toBe(true)
  await s.topicPass()
  expect((await noticeOf(s, `topic:deletion-waiting:${op}`)).body).toContain("not finished")
  expect(await noticeOf(s, `topic:deleted:${op}`)).toBeUndefined()

  // The other machine comes back and reports: now, and only now, the active history is deleted.
  await hub(s, "mac")
  const done = (await readDeletion(s.as("hub_hub"), op))!
  expect(done.stage).toBe("active_deleted")
  expect(await receiptsOf(s.as("hub_hub"), op, { open: true })).toEqual([])
  await s.topicPass()
  const told = await noticeOf(s, `topic:deleted:${op}`)
  expect(told.agent).toBe("p1-general")
  expect(told.body).toContain("its active history are deleted")
  expect(told.body).toContain("Notes saved in the vault remain")
  // The retention was never configured, and the notice does not invent one or claim the earlier copies are gone.
  expect(told.body).toContain("No backup retention is configured")
  expect(told.body).not.toMatch(/30 days|expired|gone/)
  expect(await backupHold(s.as("hub_hub"), "pi")).toBeNull()
  // Independent vault knowledge is untouched: no code path of a deletion reaches it.
  expect(readFileSync(join(s.dir, "vault-note.md"), "utf8")).toBe("a note already saved in the vault\n")
}, 120_000)

test("identities are never used again: a recreated chat of the same name is a new topic, and neither the registry, a conversation nor an allocation can bring the old ones back", async () => {
  const s = await stageTopics(cluster)
  const topic = await bound(s)
  await confirmed(s, topic)
  await finish(s)
  expect(await count(s, "topic", `id = '${topic.id}'`)).toBe(0)
  // A late input for the deleted agent is refused at the insert, by name.
  await expect(attempt(s.admin`insert into inbound (id, person, agent, body, kind) values ('late-1', ${PERSON}, ${topic.agent_id}, 'late', 'human')`)).rejects.toThrow(/identity-reserved/)
  await expect(attempt(s.admin`insert into conversation (id, person, agent, kind, adapter, native_session) values ('c-late', ${PERSON}, ${topic.agent_id}, 'master', 'synthetic', 'n')`)).rejects.toThrow(/identity-reserved/)
  // An allocation that is handed the deleted identities refuses every one of them.
  await expect(allocateTopic(s.as("hub_hub"), {
    operation: "reuse-1", person: PERSON, door: "door-fake", display_name: "coffee", machine: "pi", runner: RUNNER_PI, preset: "daily", adapter: "synthetic",
    setup: () => ({} as never),
  }, { identity: () => ({ topic_id: topic.id, agent_id: topic.agent_id, conversation_id: topic.conversation_id, native_session: "n", marker: "m" }), tries: 2 })).rejects.toBeInstanceOf(IdentityReserved)
  // The same display name, asked for again, is a fresh topic with fresh identities, and it survives the old one's tombstone.
  const again = await bound(s)
  expect(again.display_name).toBe("coffee")
  expect([again.id, again.agent_id, again.conversation_id]).not.toContain(topic.id)
  expect(again.agent_id).not.toBe(topic.agent_id)
  expect(again.conversation_id).not.toBe(topic.conversation_id)
  await hub(s, "pi")
  expect((await readTopic(s.as("hub_hub"), again.id))!.lifecycle).toBe("active")
  expect(listAgents(s.load()).some(one => one.id === again.agent_id)).toBe(true)
  // A request about the deleted topic is answered from its tombstone, not as a topic that might still be there.
  const master = await s.binding()
  const asked = await s.ask(master, { action: "inspect", topic_id: topic.id })
  expect(asked.status).toBe("complete")
  expect(String(asked.status_message)).toContain("deleted")
}, 120_000)

test("a platform that cannot delete is asked for nothing and credited with nothing: the receipt says unsupported, the deletion is blocked and says which copy remains", async () => {
  const s = await stageTopics(cluster)
  const topic = await bound(s)
  await confirmed(s, topic)
  // The same Discord seam with the two verbs that delete taken away: what a platform that cannot delete looks like to the door.
  const base = s.platform()
  const bare: Platform = { ...base, admin: Object.fromEntries(Object.entries(base.admin!).filter(([name]) => !name.startsWith("delete"))) as unknown as PlatformAdmin }
  await finish(s, { platform: bare })
  const [asked] = await s.admin`select id from topic_deletion where topic_id = ${topic.id}`
  const standing = (await readDeletion(s.as("hub_hub"), String(asked.id)))!
  expect(standing.stage).toBe("blocked_scope")
  const chat = (await receiptsOf(s.as("hub_hub"), standing.id, { classes: ["platform_chat"] }))[0]
  expect(chat.state).toBe("unsupported")
  expect(s.fake.requests().filter(one => one.method === "DELETE")).toHaveLength(0)
  expect(s.fake.channel(topic.chat!)!.exists).toBe(true)
  const said = await noticeOf(s, `topic:deletion-blocked:${standing.id}`)
  expect(said.body).toContain("does not support deleting it")
  expect(said.body).toContain("not complete")
  expect(await noticeOf(s, `topic:deleted:${standing.id}`)).toBeUndefined()
  // The Hub's own records are gone regardless: the active deletion of what it holds does not wait on a platform that cannot.
  expect(await count(s, "topic", `id = '${topic.id}'`)).toBe(0)
}, 120_000)

test("the diary stays a diary, and the routines that remove content are not the model's: no deletion without a tombstone, none by a runner", async () => {
  const s = await stageTopics(cluster)
  await s.admin`insert into ledger_event (stream, subject, kind, actor, detail) values ('control', 'diary-row', 'x', 'hub', '{}')`
  await expect(attempt(s.admin`delete from ledger_event where subject = 'diary-row'`)).rejects.toThrow(/diary/)
  // The name that opens the erasure path means nothing without a tombstone for it, whoever sets it.
  await expect(attempt(s.admin.begin(async sql => {
    await sql`select set_config('hub.erasing', 'no-such-deletion', true)`
    await sql`delete from ledger_event where subject = 'diary-row'`
  }))).rejects.toThrow(/diary/)
  await expect(attempt(s.admin`select hub_erase_scope('no-topic')`)).rejects.toThrow(/permission|erase-unknown|tombstone/)
  const erasers = await s.admin`select p.proname from pg_proc p where p.proname ~ '^hub_(deletion|erase|erasure)'
    and (has_function_privilege('hub_agent', p.oid, 'execute') or (p.proname in ('hub_deletion_erase_active', 'hub_erasure_apply', 'hub_erase_scope') and has_function_privilege('hub_runner', p.oid, 'execute')))`
  expect(erasers.map((row: { proname: string }) => row.proname)).toEqual([])
  await expect(attempt(s.as("hub_runner").sql`select hub_deletion_erase_active('nothing')`)).rejects.toThrow(/permission denied/)
  await expect(attempt(s.as("hub_hub").sql`select hub_erase_scope('nothing')`)).rejects.toThrow(/permission denied/)
  expect((await s.as("hub_hub").sql`select hub_deletion_erase_active('nothing') as answer`)[0].answer).toBe("unknown-deletion")
  expect((await readErasureManifest(s.as("hub_hub"))).tombstones).toEqual([])
})
