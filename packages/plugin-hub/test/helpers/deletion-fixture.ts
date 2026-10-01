// Test infrastructure for the deletion checks that go past the first one: a topic taken all the way, its deletion carried out on both
// machines, and what an old copy brings back. The first checks (`topic-deletion.test.ts`, `topic-deletion-restore.test.ts`) keep their
// own copies of these so each file reads alone; the later ones share this.

import { expect } from "bun:test"
import { bindTopics } from "../../src/hub/topics.ts"
import { runDeletions } from "../../src/hub/deletions.ts"
import { loadRegistry } from "../../src/registry/load.ts"
import { readTopic, type TopicRow } from "../../src/store/topics.ts"
import { PERSON, type TopicsStage } from "./topics-fixture.ts"

export const REQUEST = "Compare the two vendors, and keep it short."

export const count = async (s: TopicsStage, table: string, where = "true"): Promise<number> =>
  Number((await s.admin.unsafe(`select count(*)::int as n from ${table} where ${where}`))[0].n)

/** A statement as a real promise, so that `expect(...).rejects` reads what the store said (a bare query is lazy and would never run). */
export const attempt = async (query: PromiseLike<unknown>): Promise<void> => { await query }

/** A topic taken all the way: asked for, confirmed by the owner's check, made, bound and announced. */
export async function bound(s: TopicsStage, name = "coffee"): Promise<TopicRow> {
  const master = await s.binding()
  const reply = await s.ask(master, { action: "create", setup: { chat_name: name, initial_request: REQUEST } })
  await s.deliver()
  await s.react(String(reply.operation_id))
  await s.topicPass()
  await bindTopics({ store: s.as("hub_hub"), registryFile: s.registryFile, machine: "pi", load: () => loadRegistry(s.registryFile, { machine: "pi" }) })
  await s.topicPass()
  await s.deliver()
  return (await readTopic(s.as("hub_hub"), String(reply.object_id)))!
}

/** One pass of a machine's hub over the deletions. */
export const hub = (s: TopicsStage, machine: string) =>
  runDeletions({ store: s.as("hub_hub"), registryFile: s.registryFile, machine, load: () => loadRegistry(s.registryFile, { machine }) })

/** The owner asks for the deletion from General and confirms the preview with the check. Returns the operation. */
export async function confirmed(s: TopicsStage, topic: TopicRow): Promise<string> {
  const master = await s.binding()
  const reply = await s.ask(master, { action: "delete", topic_id: topic.id })
  expect(reply.status).toBe("awaiting_confirmation")
  await s.deliver()
  await s.react(String(reply.operation_id))
  return String(reply.operation_id)
}

/** Everything a confirmed deletion needs, in the order a deployment gets it. */
export async function finish(s: TopicsStage): Promise<void> {
  await s.topicPass()
  await hub(s, "pi")
  await s.topicPass()
  await hub(s, "mac")
  await s.topicPass()
}

/** A topic deleted all the way, on both machines. */
export async function deleted(s: TopicsStage): Promise<TopicRow> {
  const topic = await bound(s)
  await confirmed(s, topic)
  await finish(s)
  const [row] = await s.admin`select stage from topic_deletion where topic_id = ${topic.id}`
  expect(row.stage).toBe("active_deleted")
  return topic
}

/** What an old copy carries of a topic: its input, its conversation, an entry in it, a diary row and a command receipt. */
export async function plantOldCopy(s: TopicsStage, topic: TopicRow, fenced: boolean): Promise<void> {
  if (fenced) {
    await s.admin`alter table inbound disable trigger inbound_refuses_reserved`
    await s.admin`alter table conversation disable trigger conversation_refuses_reserved`
  }
  try {
    await s.admin`insert into conversation (id, person, agent, kind, adapter, native_session) values (${topic.conversation_id}, ${PERSON}, ${topic.agent_id}, 'master', 'synthetic', 'n')`
    await s.admin`insert into inbound (id, person, agent, body, kind) values ('old-in-1', ${PERSON}, ${topic.agent_id}, 'RESTORED-SECRET', 'human')`
    await s.admin`insert into conversation_entry (conversation_id, seq, source_id, kind, body) values (${topic.conversation_id}, 1, 'old-in-1', 'input', 'RESTORED-SECRET')`
    await s.admin`insert into media (inbound_id, index, sha256, kind, name, bytes) values ('old-in-1', 0, 'x', 'photo', 'p.jpg', '\\x00'::bytea)`
    await s.admin`insert into ledger_event (stream, subject, kind, actor, detail) values ('inbound', 'old-in-1', 'received', 'door', ${{ text: "RESTORED-SECRET" }}::jsonb)`
    await s.admin`insert into state_row (sheet, id, data) values ('move_command', ${JSON.stringify([topic.agent_id, "old-msg"])}, ${{ text: "RESTORED-SECRET" }}::jsonb)`
  } finally {
    if (fenced) {
      await s.admin`alter table inbound enable trigger inbound_refuses_reserved`
      await s.admin`alter table conversation enable trigger conversation_refuses_reserved`
    }
  }
}
