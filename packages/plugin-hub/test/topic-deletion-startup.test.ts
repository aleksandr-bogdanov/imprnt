// What keeps a deleted identity from being put back to work: the startup reconciliation of a machine against the store it reaches, the
// start fence of a door and a runner, the schema fence of a store that has not been migrated, the restore command's arguments, and the one
// rule that stands under all of them: a manifest never erases a deletion ahead of the stops it waits for.
//
// Real store, real topic task and hub pass, real registry file the editor really edits. What is PLANTED, and decides nothing the code under
// test decides: the rows and files an old copy would bring back, and a running attempt of the master.

import { afterAll, afterEach, beforeAll, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { hubPath, startCluster, type Cluster } from "./helpers/cluster.ts"
import { attempt, bound, confirmed, count, deleted, hub, plantOldCopy } from "./helpers/deletion-fixture.ts"
import { closeStages, removeEffectDirs } from "./helpers/effects-fixture.ts"
import { rolloutDatabase } from "./helpers/rollout-fixtures.ts"
import { DOOR, PERSON, RUNNER_PI, stageTopics } from "./helpers/topics-fixture.ts"
import { CONTROL_MANIFEST_FILE, writeLocalManifest } from "../src/erasure/manifest.ts"
import { restoreMachine } from "../src/erasure/restore.ts"
import { erasureFence, reconcileErasure } from "../src/erasure/startup.ts"
import { restoreCommand } from "../src/entry/restore.ts"
import { listAgents } from "../src/registry/entries.ts"
import { loadRegistry } from "../src/registry/load.ts"
import { requireSchema } from "../src/runner/execution.ts"
import type { StoreLike } from "../src/store/connect.ts"
import {
  DELETION_SCHEMA_VERSION, applyErasureManifest, backupHold, deletionSchemaReady, erasureGeneration, readDeletion, readErasureManifest,
} from "../src/store/deletions.ts"
import { MIGRATION_FILES, migrate } from "../src/store/migrate.ts"
import { identityReserved } from "../src/store/topics.ts"

let cluster: Cluster
beforeAll(async () => { cluster = await startCluster() })
afterEach(closeStages)
afterAll(async () => {
  removeEffectDirs()
  await cluster?.stop()
})

const sha = (text: string) => createHash("sha256").update(text).digest("hex")
const quiet = async <T>(run: () => Promise<T>): Promise<T> => {
  const out = process.stderr.write.bind(process.stderr)
  process.stderr.write = (() => true) as typeof process.stderr.write
  try { return await run() } finally { process.stderr.write = out }
}

test("a store restored from a copy older than a deletion is brought forward before anything is served: the tombstone, the reserved identities, the erasure, and the restored disk", async () => {
  const old = await stageTopics(cluster)
  const topic = await deleted(old)
  const manifest = await readErasureManifest(old.as("hub_hub"))

  // The restored machine: a store that never heard of the deletion, holding what the old copy held, and a disk that holds it too. The copy of
  // the manifest its hub kept before the restore is the one thing that remembers.
  const s = await stageTopics(cluster)
  writeLocalManifest(s.dir, manifest)
  await plantOldCopy(s, topic, false)
  const root = join(s.dir, PERSON)
  const agent = topic.agent_id
  const files = {
    chatlog: join(root, "chatlog", agent), sessions: join(root, "sessions", agent), inbox: join(root, "inbox", sha("old-in-1")),
    stage: join(root, "harvest", `harvest-${agent}-2026-01-01T00-00-00.000Z`),
    // Another agent's staged notes, whose name only starts alike, and another topic's chat log.
    otherStage: join(root, "harvest", `harvest-${agent}-notes-2026-01-01T00-00-00.000Z`), general: join(root, "chatlog", "p1-general"),
  }
  for (const dir of Object.values(files)) { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, "kept.txt"), "RESTORED-SECRET\n") }
  const rows = async () => (await count(s, "inbound", "id = 'old-in-1'")) + (await count(s, "conversation", `id = '${topic.conversation_id}'`))
    + (await count(s, "ledger_event", "subject = 'old-in-1'")) + (await count(s, "state_row", "id like '%old-msg%'")) + (await count(s, "media", "inbound_id = 'old-in-1'"))
  expect(await rows()).toBe(5)

  // BEFORE the reconciliation a door or a runner started on this machine is refused by name: the store does not hold what the machine recorded.
  const store = s.as("hub_hub")
  expect(await erasureFence(store, s.dir)).toContain("does not hold 1 deletion")
  const context = { store, registryFile: s.registryFile, machine: "pi", load: () => loadRegistry(s.registryFile, { machine: "pi" }) }
  const verdict = await reconcileErasure({ ...context, sweepFiles: true })
  expect(verdict).toMatchObject({ serve: true, created: [topic.id], copyUnreadable: false })
  expect(await rows()).toBe(0)
  expect(await identityReserved(store, "agent", agent)).toBe(true)
  expect(await identityReserved(store, "conversation", topic.conversation_id)).toBe(true)
  expect((await readErasureManifest(store)).tombstones.map(one => one.topic_id)).toEqual([topic.id])
  expect(await erasureFence(store, s.dir)).toBeNull()
  // The restored disk is swept by identifier: the chat log, the sessions, the staged notes of THIS agent and the attachments of its inputs.
  expect([files.chatlog, files.sessions, files.inbox, files.stage].map(existsSync)).toEqual([false, false, false, false])
  expect([files.otherStage, files.general].map(existsSync)).toEqual([true, true])
  // Again changes nothing, and says nothing was brought back.
  expect(await reconcileErasure({ ...context, sweepFiles: true })).toMatchObject({ serve: true, created: [], applied: 0, swept: 0 })
}, 120_000)

test("a registry that still declares a deleted agent is cleaned by the store machine's hub and waited for by every other: nothing is started from it", async () => {
  const s = await stageTopics(cluster)
  const topic = await deleted(s)
  const chat = s.fake.addChannel({ name: "old-chat" })
  const stale = { agents: [{ id: topic.agent_id, person: PERSON, preset: "daily", chat, door: DOOR, runner: RUNNER_PI }] }
  const has = () => listAgents(s.load()).some(one => one.id === topic.agent_id)

  // A spoke holds: its copy is replaced from the store machine's, and the hub here never edits a file that is not its own to publish.
  s.rewrite({ ...stale, hub: { store_machine: "pi" } })
  expect(has()).toBe(true)
  const spoke = await reconcileErasure({ store: s.as("hub_hub"), registryFile: s.registryFile, machine: "mac", load: () => loadRegistry(s.registryFile, { machine: "mac" }) })
  expect(spoke).toMatchObject({ serve: false, reason: "registry_binds_deleted" })
  expect(has()).toBe(true)

  // The store machine removes it through the editor, reads the file again, and serves.
  const home = await reconcileErasure({ store: s.as("hub_hub"), registryFile: s.registryFile, machine: "pi", load: () => loadRegistry(s.registryFile, { machine: "pi" }) })
  expect(home.serve).toBe(true)
  expect(has()).toBe(false)
}, 120_000)

test("a manifest never erases a deletion ahead of the stops it waits for: the store's own manifest, applied while the agent is still running, removes nothing, and the deletion stays where it was", async () => {
  const s = await stageTopics(cluster)
  const topic = await bound(s)
  await s.admin`insert into inbound (id, person, agent, body, kind) values ('seed-in-1', ${PERSON}, ${topic.agent_id}, 'UNIQUE-SECRET-INPUT', 'human')`
  await s.admin`insert into inbound (id, person, agent, body, kind) values ('planted-input', ${PERSON}, ${topic.agent_id}, 'working on it', 'human')`
  await s.admin`insert into execution (id, inbound_id, conversation_id, agent, runner, incarnation, placement_generation, state, input_digest)
    values ('planted-attempt', 'planted-input', ${topic.conversation_id}, ${topic.agent_id}, ${RUNNER_PI}, 'inc-1', 1, 'running', 'd')`
  const op = await confirmed(s, topic)

  const store = s.as("hub_hub")
  await hub(s, "pi")
  const applied = await applyErasureManifest(store, await readErasureManifest(store))
  expect(applied.tombstones).toBe(1)
  expect(await count(s, "inbound", "id = 'seed-in-1'")).toBe(1)
  expect(await count(s, "execution", "id = 'planted-attempt'")).toBe(1)
  expect((await readDeletion(store, op))!.stage).toBe("quiescing")
  // The reconciliation does the same: the store knows the deletion, so it is the store's own routine that erases it, after the stops.
  const verdict = await reconcileErasure({ store, registryFile: s.registryFile, machine: "pi", load: () => loadRegistry(s.registryFile, { machine: "pi" }) })
  expect(verdict).toMatchObject({ serve: true, created: [] })
  expect(await count(s, "inbound", "id = 'seed-in-1'")).toBe(1)
  // A backup is held meanwhile, and says why.
  expect(await backupHold(store, "pi")).toContain("has not erased the store's rows yet")
}, 120_000)

test("the start fence and the restore command: an unreadable copy of the manifest holds a door and a runner, and the command refuses what it was not asked well, by name, without opening a store", async () => {
  const s = await stageTopics(cluster)
  const store = s.as("hub_hub")
  expect(await erasureFence(store, s.dir), "a machine with no copy has nothing to be held against").toBeNull()
  expect(await erasureFence(store, null)).toBeNull()
  writeFileSync(join(s.dir, CONTROL_MANIFEST_FILE), "{ torn")
  expect(await erasureFence(store, s.dir)).toContain("cannot be read whole")
  expect(await reconcileErasure({ store, registryFile: s.registryFile, machine: "pi", load: () => loadRegistry(s.registryFile, { machine: "pi" }) })).toMatchObject({ serve: false, reason: "manifest_unreadable" })
  expect(readFileSync(join(s.dir, CONTROL_MANIFEST_FILE), "utf8")).toBe("{ torn")

  expect(await quiet(() => restoreCommand([]))).toBe(2)
  expect(await quiet(() => restoreCommand([s.registryFile]))).toBe(2)
  expect(await quiet(() => restoreCommand([s.registryFile, "pi", "--bogus", "x"]))).toBe(2)
  expect(await quiet(() => restoreCommand([s.registryFile, "pi", "--from"]))).toBe(2)
  expect(await quiet(() => restoreCommand([s.registryFile, "no-such-machine"]))).toBe(2)
  // A source that is not a directory holds the restore (exit 1), and nothing was applied: the store was never opened.
  expect(await quiet(() => restoreCommand([s.registryFile, "pi", "--from", join(s.dir, "not-there")]))).toBe(1)
})

test("the restoring machine removes its own restored copies of every topic the manifest names, and its copy of the manifest grows to the one that was applied", async () => {
  const old = await stageTopics(cluster)
  const topic = await deleted(old)
  const manifest = await readErasureManifest(old.as("hub_hub"))

  const s = await stageTopics(cluster)
  await plantOldCopy(s, topic, false)
  const root = join(s.dir, PERSON)
  const chatlog = join(root, "chatlog", topic.agent_id)
  const inbox = join(root, "inbox", sha("old-in-1"))
  const general = join(root, "chatlog", "p1-general")
  for (const dir of [chatlog, inbox, general]) { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, "kept.txt"), "RESTORED\n") }
  const result = await applyErasureManifest(s.as("hub_hub"), manifest)
  expect(result.created).toEqual([topic.id])
  expect(result.inbox).toEqual([{ person: PERSON, digest: sha("old-in-1") }])
  const report = restoreMachine(s.dir, { manifest, result })
  expect(report.failed).toEqual([])
  expect(report.removed).toBe(2)
  expect([existsSync(chatlog), existsSync(inbox), existsSync(general)]).toEqual([false, false, true])
  expect(JSON.parse(readFileSync(join(s.dir, CONTROL_MANIFEST_FILE), "utf8")).tombstones.map((one: { topic_id: string }) => one.topic_id)).toEqual([topic.id])
  expect(await erasureGeneration(s.as("hub_hub"))).toBe(manifest.generation)
}, 120_000)

test("a store that has not been migrated to 017 degrades to nothing was deleted, refuses by name where it must, and is brought forward when it is migrated", async () => {
  expect(MIGRATION_FILES).toContainEqual([DELETION_SCHEMA_VERSION, "017-topic-deletion.sql"])
  const old = await stageTopics(cluster)
  const topic = await deleted(old)
  const manifest = await readErasureManifest(old.as("hub_hub"))

  // A store at migration 16.
  const behind = await rolloutDatabase(cluster, true)
  const files = MIGRATION_FILES.filter(([version]) => version < DELETION_SCHEMA_VERSION)
    .map(([version, file]) => ({ version, sql: readFileSync(hubPath(`src/store/migrations/${file}`), "utf8") }))
  const hubStore = behind.store("hub_hub") as unknown as StoreLike
  await migrate(behind.store(), files)
  expect(await deletionSchemaReady(hubStore)).toBe(false)
  // Everything that reads the deletion objects answers as a store with no deletion in it, and none of it fails on a missing routine.
  expect(await readErasureManifest(hubStore)).toEqual({ version: 1, generation: 0, tombstones: [] })
  expect(await erasureGeneration(hubStore)).toBe(0)
  expect(await backupHold(hubStore, "pi")).toBeNull()
  // A runner of this build refuses to serve it, by the migration it lacks.
  await expect(attempt(requireSchema(behind.store("hub_runner") as unknown as StoreLike))).rejects.toThrow(/schema-behind: apply migration 17/)

  // A machine with nothing recorded serves; one that recorded a deletion holds, because it cannot be applied there.
  const s = await stageTopics(cluster)
  const context = { store: hubStore, registryFile: s.registryFile, machine: "pi", load: () => loadRegistry(s.registryFile, { machine: "pi" }) }
  expect(await reconcileErasure(context)).toMatchObject({ serve: true, applied: 0 })
  writeLocalManifest(s.dir, manifest)
  expect(await reconcileErasure(context)).toMatchObject({ serve: false, reason: "schema_behind" })
  expect(await erasureFence(hubStore, s.dir)).toContain("has not been migrated")

  // Version 17 can read existing tombstones, but this build must not serve or restore until General notices are covered.
  await migrate(behind.store(), MIGRATION_FILES.filter(([version]) => version === 17)
    .map(([version, file]) => ({ version, sql: readFileSync(hubPath(`src/store/migrations/${file}`), "utf8") })))
  expect(await deletionSchemaReady(hubStore)).toBe(true)
  expect(await reconcileErasure(context)).toMatchObject({ serve: false, reason: "schema_behind" })
  expect(await erasureFence(hubStore, s.dir)).toContain("schema 18")

  // Migrated, the same store is brought forward by the same call, and the machine serves.
  await migrate(behind.store())
  expect(await deletionSchemaReady(hubStore)).toBe(true)
  expect(await reconcileErasure(context)).toMatchObject({ serve: true, created: [topic.id] })
  expect(await erasureFence(hubStore, s.dir)).toBeNull()
  await (behind.sql as unknown as { close(): Promise<void> }).close().catch(() => {})
}, 120_000)
