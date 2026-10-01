// The restore barrier against a real store: an old copy that comes back holding what was deleted has it removed before anything is
// served, a restore that cannot prove it knows what was deleted serves nothing, a registry copy that still binds a deleted agent holds
// the restore, and the newer topic that took the same display name is not touched.
//
// "The old copy" is made the only way a test can make one without a second cluster of dumps: the rows a snapshot would carry are put
// back with the two fences that refuse reserved identities switched off for the insert and on again, which is exactly the state a
// restored database is in. A second, fresh store plays a database restored from a copy that never heard of the deletion.

import { afterAll, afterEach, beforeAll, expect, test } from "bun:test"
import { startCluster, type Cluster } from "./helpers/cluster.ts"
import { closeStages, removeEffectDirs } from "./helpers/effects-fixture.ts"
import { DOOR, PERSON, RUNNER_PI, stageTopics, type TopicsStage } from "./helpers/topics-fixture.ts"
import { runRestoreBarrier } from "../src/erasure/restore.ts"
import { bindTopics } from "../src/hub/topics.ts"
import { runDeletions } from "../src/hub/deletions.ts"
import { loadRegistry } from "../src/registry/load.ts"
import { applyErasureManifest, erasureGeneration, readErasureManifest } from "../src/store/deletions.ts"
import { allocateTopic, identityReserved, readTopic, IdentityReserved, type TopicRow } from "../src/store/topics.ts"

let cluster: Cluster
beforeAll(async () => { cluster = await startCluster() })
afterEach(closeStages)
afterAll(async () => {
  removeEffectDirs()
  await cluster?.stop()
})

const count = async (s: TopicsStage, table: string, where = "true") =>
  Number((await s.admin.unsafe(`select count(*)::int as n from ${table} where ${where}`))[0].n)

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

const hub = (s: TopicsStage, machine: string) => runDeletions({ store: s.as("hub_hub"), registryFile: s.registryFile, machine, load: () => loadRegistry(s.registryFile, { machine }) })

/** A topic deleted all the way, on both machines. */
async function deleted(s: TopicsStage): Promise<TopicRow> {
  const topic = await bound(s)
  const master = await s.binding()
  const reply = await s.ask(master, { action: "delete", topic_id: topic.id })
  await s.deliver()
  await s.react(String(reply.operation_id))
  await s.topicPass()
  await hub(s, "pi")
  await hub(s, "mac")
  await s.topicPass()
  await hub(s, "pi")
  const [row] = await s.admin`select stage from topic_deletion where topic_id = ${topic.id}`
  expect(row.stage).toBe("active_deleted")
  return topic
}

/** What an old copy carries of a topic: its input, its conversation and the entries in it, a diary row and a command receipt. */
async function plantOldCopy(s: TopicsStage, topic: TopicRow, fenced: boolean) {
  if (fenced) {
    await s.admin`alter table inbound disable trigger inbound_refuses_reserved`
    await s.admin`alter table conversation disable trigger conversation_refuses_reserved`
  }
  try {
    await s.admin`insert into conversation (id, person, agent, kind, adapter, native_session) values (${topic.conversation_id}, ${PERSON}, ${topic.agent_id}, 'master', 'synthetic', 'n')`
    await s.admin`insert into inbound (id, person, agent, body, kind) values ('old-in-1', ${PERSON}, ${topic.agent_id}, 'RESTORED-SECRET', 'human')`
    await s.admin`insert into conversation_entry (conversation_id, seq, source_id, kind, body) values (${topic.conversation_id}, 1, 'old-in-1', 'input', 'RESTORED-SECRET')`
    await s.admin`insert into ledger_event (stream, subject, kind, actor, detail) values ('inbound', 'old-in-1', 'received', 'door', ${{ text: "RESTORED-SECRET" }}::jsonb)`
    await s.admin`insert into state_row (sheet, id, data) values ('move_command', ${JSON.stringify([topic.agent_id, "old-msg"])}, ${{ text: "RESTORED-SECRET" }}::jsonb)`
  } finally {
    if (fenced) {
      await s.admin`alter table inbound enable trigger inbound_refuses_reserved`
      await s.admin`alter table conversation enable trigger conversation_refuses_reserved`
    }
  }
}
const restoredRows = (s: TopicsStage, topic: TopicRow) => count(s, "inbound", "id = 'old-in-1'")
  .then(async inbound => inbound + await count(s, "conversation", `id = '${topic.conversation_id}'`)
    + await count(s, "ledger_event", "subject = 'old-in-1'") + await count(s, "state_row", "id like '%old-msg%'"))

test("a restore serves nothing it cannot prove: no current manifest holds it, a registry copy that binds a deleted agent holds it, and neither removes anything it was not allowed to", async () => {
  const s = await stageTopics(cluster)
  const topic = await deleted(s)
  await plantOldCopy(s, topic, true)
  expect(await restoredRows(s, topic)).toBe(4)

  // No source of the latest manifest: the restore is held, and the old rows are not touched on a guess.
  const blind = await runRestoreBarrier({ store: s.as("hub_hub"), stateDirs: [], snapshotManifest: null, registry: null })
  expect(blind.verdict).toMatchObject({ serve: false, reason: "current_manifest_unverified" })
  expect(blind.applied).toBeNull()
  expect(await restoredRows(s, topic)).toBe(4)

  // A copy of the registry that still binds the deleted agent holds it too.
  const chat = s.fake.addChannel({ name: "old-chat" })
  const bad = s.rewrite({ agents: [{ id: topic.agent_id, person: PERSON, preset: "daily", chat, door: DOOR, runner: RUNNER_PI }] })
  const held = await runRestoreBarrier({ store: s.as("hub_hub"), stateDirs: [s.dir], snapshotManifest: null, registry: bad })
  expect(held.verdict).toMatchObject({ serve: false, reason: "registry_binds_deleted" })
  expect(held.applied).toBeNull()
  expect(await restoredRows(s, topic)).toBe(4)

  // A snapshot whose own manifest is torn is not guessed at either.
  const torn = await runRestoreBarrier({ store: s.as("hub_hub"), stateDirs: [s.dir], snapshotManifest: "{ torn", registry: null })
  expect(torn.verdict).toMatchObject({ serve: false, reason: "snapshot_manifest_malformed" })
  expect(await restoredRows(s, topic)).toBe(4)
}, 120_000)

test("with the manifest and a clean registry the restore erases what the old copy brought back, keeps the identities reserved, and leaves the newer topic of the same name alone", async () => {
  const s = await stageTopics(cluster)
  const topic = await deleted(s)
  const newer = await bound(s)
  await s.admin`insert into inbound (id, person, agent, body, kind) values ('newer-in-1', ${PERSON}, ${newer.agent_id}, 'NEWER-HISTORY', 'human')`
  await plantOldCopy(s, topic, true)
  const before = await erasureGeneration(s.as("hub_hub"))

  const done = await runRestoreBarrier({ store: s.as("hub_hub"), stateDirs: [s.dir], snapshotManifest: null, registry: s.load() })
  expect(done.verdict.serve).toBe(true)
  expect(done.applied!.tombstones).toBeGreaterThanOrEqual(1)
  expect(await restoredRows(s, topic)).toBe(0)
  expect(await identityReserved(s.as("hub_hub"), "agent", topic.agent_id)).toBe(true)
  expect(await identityReserved(s.as("hub_hub"), "conversation", topic.conversation_id)).toBe(true)
  // The generation only moved forward, and applying again changes nothing.
  expect(await erasureGeneration(s.as("hub_hub"))).toBeGreaterThanOrEqual(before)
  const again = await runRestoreBarrier({ store: s.as("hub_hub"), stateDirs: [s.dir], snapshotManifest: null, registry: s.load() })
  expect(again.applied!.generation).toBe(done.applied!.generation)
  // The newer topic took the same display name and has its own identities: its row and its history survive the old tombstone.
  expect((await readTopic(s.as("hub_hub"), newer.id))!.lifecycle).toBe("active")
  expect(await count(s, "inbound", "id = 'newer-in-1'")).toBe(1)
}, 120_000)

test("a late result of a delegated job, which the reserved identity does not refuse, is removed by the hub's sweep, and nothing is read when nothing came back", async () => {
  const s = await stageTopics(cluster)
  const topic = await deleted(s)
  await s.admin`insert into inbound (id, person, agent, body, kind) values ('late-report', ${PERSON}, ${topic.agent_id}, 'LATE-RESULT', 'report')`
  expect(await count(s, "inbound", "id = 'late-report'")).toBe(1)
  await hub(s, "pi")
  expect(await count(s, "inbound", "id = 'late-report'")).toBe(0)
  await hub(s, "pi")
  expect((await readErasureManifest(s.as("hub_hub"))).tombstones.map(one => one.topic_id)).toEqual([topic.id])
}, 120_000)

test("a store restored from a copy that never heard of the deletion is given the tombstone, the reserved identities and the erasure before anything is served, and a manifest it cannot read whole applies nothing", async () => {
  const old = await stageTopics(cluster)
  const topic = await deleted(old)
  const manifest = await readErasureManifest(old.as("hub_hub"))

  const restored = await stageTopics(cluster)
  // The old copy has the deleted agent's rows, and General's own, and knows nothing of any tombstone.
  await plantOldCopy(restored, topic, false)
  await restored.admin`insert into inbound (id, person, agent, body, kind) values ('general-in', ${PERSON}, 'p1-general', 'GENERAL-STAYS', 'human')`
  expect(await count(restored, "topic_tombstone")).toBe(0)
  expect(await restoredRows(restored, topic)).toBe(4)

  // A manifest that is missing what identifies a tombstone applies nothing at all, not half of it.
  await expect(applyErasureManifest(restored.as("hub_hub"), { version: 1, generation: 9, tombstones: [{ topic_id: "x" } as never, ...manifest.tombstones] }))
    .rejects.toThrow(/manifest-malformed/)
  expect(await count(restored, "topic_tombstone")).toBe(0)
  expect(await restoredRows(restored, topic)).toBe(4)

  const applied = await applyErasureManifest(restored.as("hub_hub"), manifest)
  expect(applied.tombstones).toBe(1)
  expect(await restoredRows(restored, topic)).toBe(0)
  expect(await count(restored, "inbound", "id = 'general-in'")).toBe(1)
  expect(await count(restored, "topic_tombstone", `topic_id = '${topic.id}'`)).toBe(1)
  expect(await identityReserved(restored.as("hub_hub"), "topic", topic.id)).toBe(true)
  expect(await identityReserved(restored.as("hub_hub"), "agent", topic.agent_id)).toBe(true)
  expect(await erasureGeneration(restored.as("hub_hub"))).toBe(manifest.generation)
  // And from then on its allocations refuse the deleted identities too.
  await expect(allocateTopic(restored.as("hub_hub"), {
    operation: "again", person: PERSON, door: DOOR, display_name: "coffee", machine: "pi", runner: RUNNER_PI, preset: "daily", adapter: "synthetic", setup: () => ({} as never),
  }, { identity: () => ({ topic_id: topic.id, agent_id: topic.agent_id, conversation_id: topic.conversation_id, native_session: "n", marker: "m" }), tries: 2 }))
    .rejects.toBeInstanceOf(IdentityReserved)
}, 120_000)
