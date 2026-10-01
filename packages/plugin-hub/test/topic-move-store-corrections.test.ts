// The store's half of moving a topic master, corrections (IMP-231, migration 016): the drain resolves EVERY owner, the export is a fenced
// generation, hold decisions are made on fresh serialized state (with real barriers between real connections), and a proven-unfed
// observation is never the authority to release an attempt.
//
// WHAT THIS PROVES is the store's: what it lists as owed before an export, which evidence it accepts for each item, which boot it accepts
// (the registered one), which writes a generation refuses, and the order in which concurrent transactions meet. WHAT IT DOES NOT, and this
// file does not pretend to: that a process tree is really gone, that a runner records its intent before it closes a child, or that a spawn in
// flight was stopped. Every exit here is SCRIPTED by the test; the store records it and binds it to identities it can check.

import { afterAll, afterEach, beforeAll, expect, test } from "bun:test"
import { startCluster, type Cluster } from "./helpers/cluster.ts"
import {
  BOOT_1, BOOT_2, DST, EXIT_BOOT, EXIT_NO_CHILD, FACTS, FILES, OWNER, SRC, drainEvidence, exitGroup, manifestOf, moveStage, sha, type MoveFixture,
} from "./helpers/move-store-stage.ts"
import type { StoreLike } from "../src/store/connect.ts"
import type { ExitEvidence } from "../src/adapters/types.ts"
import { claimNext } from "../src/runner/claim.ts"
import { endAttempt } from "../src/runner/execution.ts"
import { MoveGated, activateProtocol, markFeedIntent, provenUnfedEnd } from "../src/store/conversations.ts"
import {
  blockMove, checkMoveFailure, checkpointOf, continueMove, destReady, exportGenerationOf, moveGateOperation, putBlob, readBlobs, recordDrainDone, recordDrainIntent,
  releaseSource, unblockMove, withdrawMove, type DrainExit, type DrainIntent,
} from "../src/store/moves.ts"

let cluster: Cluster
const mine: { close(): Promise<void> }[] = []
const track = <T extends { close(): Promise<void> }>(sql: T): T => { mine.push(sql); return sql }
beforeAll(async () => { cluster = await startCluster() })
afterEach(async () => { for (const one of mine.splice(0)) await one.close().catch(() => {}) })
afterAll(async () => { await cluster?.stop() })

const stage = () => moveStage(cluster, track)
/** Rows as plain objects, so that `toMatchObject` and `toEqual` compare what the statement returned and not the client's row list. */
const rows = (result: unknown) => Array.from(result as Record<string, unknown>[]).map(row => ({ ...row }))
const GONE: ExitEvidence = { confirmed: true, leader: "exited", descendants: "none", pids: [], survivors: [], via: "test" }
const NOT_GONE: ExitEvidence = { confirmed: false, leader: "unknown", descendants: "unverified", pids: [], survivors: [], via: "test" }

/** Waits until the backend is blocked on a lock, read from the server, never a fixed sleep. */
const blockedOnLock = async (sql: any, pid: number) => {
  const until = Date.now() + 15_000
  for (;;) {
    const [seen] = await sql`select wait_event_type as waiting from pg_stat_activity where pid = ${pid}`
    if (seen?.waiting === "Lock") return
    if (Date.now() > until) throw new Error(`backend ${pid} never blocked on a lock: ${JSON.stringify(seen)}`)
    await Bun.sleep(20)
  }
}
const pidOf = async (store: StoreLike) => Number((await store.sql`select pg_backend_pid() as pid`)[0].pid)
/** A transaction that stays open until `release()` is called, after `body` ran in it. The promise ends when the transaction does. */
async function openTransaction(sql: any, body: (tx: any) => Promise<unknown>) {
  let release!: () => void
  let entered!: () => void
  const released = new Promise<void>(resolve => { release = resolve })
  const inside = new Promise<void>(resolve => { entered = resolve })
  const done = sql.begin(async (tx: any) => { await body(tx); entered(); await released })
  await Promise.race([inside, done])
  return { release, done: done as Promise<unknown> }
}

/** Evidence for one drain item, by the incarnation `by` that registered `boot`. */
const proving = (s: MoveFixture, move: Awaited<ReturnType<MoveFixture["request"]>>, native: string) =>
  (intent: DrainIntent | null, by: { runner: string; incarnation: string }, boot: string, exit?: DrainExit, over: Record<string, unknown> = {}) =>
    recordDrainDone(s.tool, move.id, by, drainEvidence(move, native, { incarnation: by.incarnation, boot }, intent, { boot_id: boot, ...over }, exit))

test("the drain resolves EVERY owner: a restarted source that proves only its own intent leaves its predecessor's unresolved and the export refused; the same boot's group evidence covers only the group it names, and once all are resolved the export goes through", async () => {
  const s = await stage()
  await s.fleet()
  const t = await s.topic()
  const move = await s.request(t)
  const native = await s.nativeOf(move)
  const prove = proving(s, move, native)
  expect(await destReady(s.tool, move.id, s.dst(), FACTS)).toBe("ready")

  // A (src-1) says what it is about to close, and is gone before it proves anything. B is its restart in the same boot and has a child of its own.
  const a: DrainIntent = { id: "intent-a", boot_id: BOOT_1, machine: "pi", leader: 100, group: 100, pids: [100] }
  const b: DrainIntent = { id: "intent-b", boot_id: BOOT_1, machine: "pi", leader: 7, group: 7, pids: [7] }
  expect(await recordDrainIntent(s.tool, move.id, s.src(), a)).toBe("intent")
  await s.register(SRC, "src-2")
  expect(await recordDrainIntent(s.tool, move.id, s.src("src-2"), b)).toBe("intent")

  // B proves B, and that is all it has proved: A's intent is an owner of the move and is still owed.
  expect(await prove(b, s.src("src-2"), BOOT_1)).toBe("partial")
  const partial = await s.reread(move)
  expect(partial.drain).toBeNull()
  expect(partial.drain_resolutions.map(one => `${one.kind}:${one.id}`)).toEqual(["intent:intent-b"])
  const checkpoint = (await checkpointOf(s.tool, t.conversation_id))!
  expect(await putBlob(s.tool, move.id, s.src("src-2"), partial.export_generation, { ...FILES[0], mode: 0o600 })).toBe("drain-stale")
  expect(await releaseSource(s.tool, move.id, s.src("src-2"), partial.export_generation, checkpoint, manifestOf([]))).toBe("drain-stale")

  // What B cannot say about A: "no child here" is its own lifetime (and it recorded an intent), the same boot is not a reboot, and B's group is not A's.
  expect(await prove(null, s.src("src-2"), BOOT_1, EXIT_NO_CHILD)).toBe("drain-proof-incomplete")
  expect(await prove(null, s.src("src-2"), BOOT_1, EXIT_BOOT)).toBe("drain-proof-incomplete")
  expect(await prove(a, s.src("src-2"), BOOT_1, exitGroup(7))).toBe("drain-proof-incomplete")
  expect((await s.reread(move)).drain).toBeNull()

  // The group A recorded, looked up again in the same boot, resolves A; now every owner is resolved.
  expect(await prove(a, s.src("src-2"), BOOT_1)).toBe("drained")
  const drained = await s.reread(move)
  expect(drained.drain).toMatchObject({ incarnation: "src-2", boot_id: BOOT_1, export_generation: 1, resolved: 2 })
  expect(drained.drain_resolutions.map(one => `${one.kind}:${one.id}:${one.basis}:${one.by}`)).toEqual(["intent:intent-b:process-group:src-2", "intent:intent-a:process-group:src-2"])
  await s.release(move)
  expect((await s.reread(move)).stage).toBe("source_released")
})

test("a verified reboot covers the processes of the earlier boot, evidence of the old boot is not accepted from a runner registered in the new one, and the new incarnation still answers for its own lifetime", async () => {
  const s = await stage()
  await s.fleet()
  const t = await s.topic()
  const move = await s.request(t)
  const native = await s.nativeOf(move)
  const prove = proving(s, move, native)
  expect(await destReady(s.tool, move.id, s.dst(), FACTS)).toBe("ready")
  const a: DrainIntent = { id: "intent-a", boot_id: BOOT_1, machine: "pi", leader: 100, group: 100, pids: [100, 101] }
  expect(await recordDrainIntent(s.tool, move.id, s.src(), a)).toBe("intent")

  // The machine boots again and the runner restarts in BOOT_2 with no child and no memory.
  await s.register(SRC, "src-2", BOOT_2)
  expect(await recordDrainDone(s.tool, move.id, s.src("src-2"), drainEvidence(move, native, { incarnation: "src-2" }, a)), "the old boot named by a runner registered in the new one is a forgery").toBe("boot-mismatch")
  expect(await prove(a, s.src("src-2"), BOOT_2, exitGroup(100)), "a group of another boot is not looked up by looking at this one").toBe("drain-proof-incomplete")
  expect(await prove(null, s.src("src-2"), BOOT_2, { ...EXIT_BOOT, leader: "unknown" } as never)).toBe("drain-proof-incomplete")
  // The reboot is verified by the store itself: the boot it froze for A differs from the boot the speaking incarnation registered.
  expect(await prove(null, s.src("src-2"), BOOT_2, EXIT_BOOT)).toBe("partial")
  expect((await s.reread(move)).drain).toBeNull()
  expect(await prove(null, s.src("src-2"), BOOT_2, EXIT_BOOT), "the same evidence again changes nothing").toBe("partial")
  // The reboot says nothing about src-2's own lifetime: it answers for that itself, having closed its spawns.
  expect(await prove(null, s.src("src-2"), BOOT_2, { ...EXIT_NO_CHILD, spawn_closed: false } as never)).toBe("drain-proof-incomplete")
  expect(await prove(null, s.src("src-2"), BOOT_2, EXIT_NO_CHILD)).toBe("drained")
  const drained = await s.reread(move)
  expect(drained.drain_resolutions.map(one => `${one.kind}:${one.id}:${one.basis}`)).toEqual(["intent:intent-a:boot", "owner:src-2:no-child"])
  expect(drained.drain).toMatchObject({ incarnation: "src-2", boot_id: BOOT_2, export_generation: 1 })
  await s.release(move)
  expect((await s.reread(move)).stage).toBe("source_released")
})

test("a source that crashed before it recorded ANY intent is still an owner of the move: a restart's own intent and claim do not cover it, a later verified reboot does", async () => {
  const s = await stage()
  await s.fleet()
  const t = await s.topic()
  const move = await s.request(t)
  expect(move.source_incarnation).toMatchObject({ known: true, incarnation: "src-1", boot_id: BOOT_1 })
  const native = await s.nativeOf(move)
  const prove = proving(s, move, native)
  expect(await destReady(s.tool, move.id, s.dst(), FACTS)).toBe("ready")

  // src-1 is gone without a word; src-2 starts in the same boot, records an intent for its own child and proves it.
  await s.register(SRC, "src-2")
  const b: DrainIntent = { id: "intent-b", boot_id: BOOT_1, machine: "pi", leader: 7, group: 7, pids: [7] }
  expect(await recordDrainIntent(s.tool, move.id, s.src("src-2"), b)).toBe("intent")
  expect(await prove(b, s.src("src-2"), BOOT_1)).toBe("partial")
  expect(await prove(null, s.src("src-2"), BOOT_1, EXIT_NO_CHILD), "it recorded an intent: that is what it must resolve").toBe("drain-proof-incomplete")
  expect(await prove(null, s.src("src-2"), BOOT_1, EXIT_BOOT), "the same boot").toBe("drain-proof-incomplete")
  expect(await prove(null, s.src("src-2"), BOOT_1, EXIT_NO_CHILD, { owner: "src-1" }), "a claim about src-1 is not src-2's to make").toBe("drain-proof-incomplete")
  expect(await prove(b, s.src("src-2"), BOOT_1), "b again: nothing new, and src-1 is still owed").toBe("partial")
  const stuck = await s.reread(move)
  expect(stuck.drain).toBeNull()
  expect(await releaseSource(s.tool, move.id, s.src("src-2"), stuck.export_generation, (await checkpointOf(s.tool, t.conversation_id))!, manifestOf([]))).toBe("drain-stale")

  // The machine boots again: src-3 registers in BOOT_2, the store compares the boots itself, and the predecessor's items are covered.
  await s.register(SRC, "src-3", BOOT_2)
  expect(await prove(null, s.src("src-3"), BOOT_2, EXIT_BOOT)).toBe("partial")
  expect(await prove(null, s.src("src-3"), BOOT_2, EXIT_NO_CHILD)).toBe("drained")
  const drained = await s.reread(move)
  expect(drained.drain_resolutions.map(one => `${one.kind}:${one.id}:${one.basis}`)).toEqual(["intent:intent-b:process-group", "owner:src-1:boot", "owner:src-3:no-child"])
  await s.release(move)
  expect((await s.reread(move)).stage).toBe("source_released")
})

test("a request is admitted and gated when the source never registered, what was unknown stays unknown (nothing later stands in for it), the drain stays blocked by a named ownership block, and only the owner's withdrawal ends the move", async () => {
  const s = await stage()
  await activateProtocol(s.tool)
  await s.register(DST, "dst-1")
  const t = await s.topic()
  const move = await s.request(t)
  expect(move.source_incarnation).toEqual({ known: false, reason: "unregistered" })
  expect(move.block).toMatchObject({ code: "drain_owner_unknown", by: "store", detail: { known: false, reason: "unregistered" } })
  expect(await s.openGates(t.agent_id)).toEqual([moveGateOperation(move.id)])

  // The source starts afterwards. Its registration is not the baseline the request froze.
  await s.register(SRC, "src-1")
  expect((await s.reread(move)).source_incarnation).toEqual({ known: false, reason: "unregistered" })
  expect(await destReady(s.tool, move.id, s.dst(), FACTS)).toBe("ready")
  const native = await s.nativeOf(move)
  const prove = proving(s, move, native)
  const a: DrainIntent = { id: "intent-a", boot_id: BOOT_1, machine: "pi", leader: 100, group: 100, pids: [100] }
  expect(await recordDrainIntent(s.tool, move.id, s.src(), a)).toBe("intent")
  expect(await prove(a, s.src(), BOOT_1), "its own child is proved gone, its predecessor is not known").toBe("owner-unknown")
  expect(await prove(null, s.src(), BOOT_1, EXIT_NO_CHILD), "no child here is not evidence about a lifetime nobody knows").toBe("drain-proof-incomplete")
  const held = await s.reread(move)
  expect(held.drain).toBeNull()
  expect(held.stage).toBe("waiting")
  expect(held.block).toMatchObject({ code: "drain_owner_unknown", by: "store" })
  expect(await releaseSource(s.tool, move.id, s.src(), held.export_generation, (await checkpointOf(s.tool, t.conversation_id))!, manifestOf([]))).toBe("blocked")
  // The store's own note is nobody's to clear, and nobody's to overwrite.
  expect(await unblockMove(s.tool, move.id, s.src(), "drain_owner_unknown")).toBe("still-blocked")
  expect(await unblockMove(s.tool, move.id, s.dst(), "drain_owner_unknown")).toBe("still-blocked")
  expect(await blockMove(s.tool, move.id, s.dst(), "dependency_unverified", {})).toBe("occupied")
  expect(await s.openGates(t.agent_id)).toEqual([moveGateOperation(move.id)])

  // The owner ends it.
  expect(await withdrawMove(s.tool, move.id, OWNER)).toBe("withdrawn")
  expect(await s.reread(move)).toMatchObject({ stage: "withdrawn", block: null })
  expect(await s.openGates(t.agent_id)).toEqual([])
})

test("a registration without a boot proves nothing: no intent and no evidence is accepted from it, and a caller's own boot string is never an anchor", async () => {
  const s = await stage()
  await s.fleet()
  const t = await s.topic()
  const move = await s.request(t)
  const native = await s.nativeOf(move)
  expect(await destReady(s.tool, move.id, s.dst(), FACTS)).toBe("ready")
  await s.register(SRC, "src-2", null)
  const intent: DrainIntent = { id: "intent-x", boot_id: BOOT_1, machine: "pi", leader: 1, group: 1, pids: [1] }
  expect(await recordDrainIntent(s.tool, move.id, s.src("src-2"), intent)).toBe("boot-unknown")
  expect(await recordDrainDone(s.tool, move.id, s.src("src-2"), drainEvidence(move, native, { incarnation: "src-2" }, intent))).toBe("boot-unknown")
  expect((await s.reread(move)).drain_intents).toEqual([])
  expect((await s.reread(move)).drain).toBeNull()
  // Registered in another boot than the one it names: a forged intent is refused, a forged exit likewise.
  await s.register(SRC, "src-3", BOOT_2)
  expect(await recordDrainIntent(s.tool, move.id, s.src("src-3"), intent)).toBe("boot-mismatch")
  expect(await recordDrainDone(s.tool, move.id, s.src("src-3"), drainEvidence(move, native, { incarnation: "src-3" }, intent))).toBe("boot-mismatch")
  expect((await s.reread(move)).drain_intents).toEqual([])
})

test("an export is a fenced generation: a new genuine drain clears only the previous UNSEALED blobs, a duplicate replay keeps its progress, a late writer of an earlier generation (even the same incarnation) is refused, and a sealed snapshot is immutable", async () => {
  const s = await stage()
  await s.fleet()
  const t = await s.topic()
  const move = await s.request(t)
  const native = await s.nativeOf(move)
  const prove = proving(s, move, native)

  // GENERATION 1, by src-1: partly exported.
  const first = await s.drain(move)
  const g1 = exportGenerationOf(await s.reread(move))!
  expect(g1).toBe(1)
  expect(await putBlob(s.tool, move.id, s.src(), g1, { ...FILES[0], mode: 0o600 })).toBe("stored")
  // The same drain again (the same intent, the same evidence) is a replay: nothing is erased and the generation does not move.
  expect(await recordDrainIntent(s.tool, move.id, s.src(), first)).toBe("replay")
  expect(await prove(first, s.src(), BOOT_1)).toBe("replay")
  expect(await s.count("move_blob where move_id = $1", move.id)).toBe(1)
  expect(exportGenerationOf(await s.reread(move))).toBe(1)
  expect(await putBlob(s.tool, move.id, s.src(), g1, { ...FILES[0], mode: 0o600 }), "the same file again").toBe("replay")

  // The source restarts with another child: a genuinely NEW drain. The unsealed blobs of the first export are gone; what src-1 proved stays proved.
  await s.register(SRC, "src-2")
  const second: DrainIntent = { id: "intent-src-2", boot_id: BOOT_1, machine: "pi", leader: 7, group: 7, pids: [7] }
  expect(await recordDrainIntent(s.tool, move.id, s.src("src-2"), second)).toBe("intent")
  expect(await s.count("move_blob where move_id = $1", move.id)).toBe(0)
  expect((await s.reread(move)).drain).toBeNull()
  expect((await s.reread(move)).drain_resolutions.map(one => one.id)).toEqual(["intent-src-1"])
  expect(await prove(second, s.src("src-2"), BOOT_1)).toBe("drained")
  const g2 = exportGenerationOf(await s.reread(move))!
  expect(g2).toBe(2)
  // Changed bytes at the same key and a changed mode are the new export's, not a permanent conflict with the old one.
  const changed = { ...FILES[0], bytes: Buffer.from("one\ntwo\nthree\n") }
  expect(await putBlob(s.tool, move.id, s.src("src-2"), g2, { ...changed, mode: 0o600 })).toBe("stored")
  expect(await putBlob(s.tool, move.id, s.src("src-2"), g2, { ...FILES[1], mode: 0o600 })).toBe("stored")
  // The previous generation's writer is refused; the drain it belonged to is not the standing one.
  expect(await putBlob(s.tool, move.id, s.src("src-2"), g1, { ...FILES[0], mode: 0o600 })).toBe("stale-export")

  // A THIRD drain by the very same incarnation: its late writer of generation 2 cannot repopulate the new export.
  const third: DrainIntent = { id: "intent-src-2-again", boot_id: BOOT_1, machine: "pi", leader: 8, group: 8, pids: [8] }
  expect(await recordDrainIntent(s.tool, move.id, s.src("src-2"), third)).toBe("intent")
  expect(await s.count("move_blob where move_id = $1", move.id)).toBe(0)
  expect(await putBlob(s.tool, move.id, s.src("src-2"), g2, { ...changed, mode: 0o600 }), "no drain stands yet").toBe("drain-stale")
  expect(await prove(third, s.src("src-2"), BOOT_1)).toBe("drained")
  const g3 = exportGenerationOf(await s.reread(move))!
  expect(g3).toBe(3)
  expect(await putBlob(s.tool, move.id, s.src("src-2"), g2, { ...changed, mode: 0o600 }), "a late writer of the previous generation").toBe("stale-export")
  expect(await s.count("move_blob where move_id = $1", move.id)).toBe(0)
  const checkpoint = (await checkpointOf(s.tool, t.conversation_id))!
  const files = [{ ...changed, mode: 0o640 }, { ...FILES[1], mode: 0o600, bytes: Buffer.from("changed b") }]
  for (const file of files) expect(await putBlob(s.tool, move.id, s.src("src-2"), g3, file)).toBe("stored")
  expect(await releaseSource(s.tool, move.id, s.src("src-2"), g2, checkpoint, manifestOf(files)), "a seal of the previous generation").toBe("stale-export")
  expect((await s.reread(move)).stage).toBe("waiting")
  expect(await releaseSource(s.tool, move.id, s.src("src-2"), g3, checkpoint, manifestOf(files))).toBe("released")

  // SEALED: immutable. Nothing writes a blob, records an intent or replaces the manifest any more, and what the destination reads is the new export.
  const sealed = await s.reread(move)
  expect(await putBlob(s.tool, move.id, s.src("src-2"), g3, { ...files[0], bytes: Buffer.from("late") })).toBe("stage")
  expect(await recordDrainIntent(s.tool, move.id, s.src("src-2"), { id: "intent-late", boot_id: BOOT_1, machine: "pi", group: 9 })).toBe("stage")
  expect(await s.count("move_blob where move_id = $1", move.id)).toBe(2)
  await expect(s.su`update topic_move set manifest = '{}'::jsonb where id = ${move.id}`.execute()).rejects.toThrow(/keeps its sealed manifest/)
  const read = await readBlobs(s.tool, sealed)
  expect(read.map(blob => `${blob.kind}/${blob.path}:${blob.mode.toString(8)}:${blob.sha256}`).sort())
    .toEqual(files.map(file => `${file.kind}/${file.path}:${file.mode.toString(8)}:${sha(file.bytes)}`).sort())
})

test("a hold that is in flight when the move is requested is not seen by the request, and the drain and the release both find it afterwards: the move goes to awaiting_owner showing that very attempt and revision, with the hold untouched and the gate kept", async () => {
  const s = await stage()
  await s.fleet()
  const planter = track(cluster.connect(s.db))
  const plant = async (tx: any, topic: { agent_id: string; conversation_id: string }, id: string) => {
    await tx`insert into inbound (id, person, agent, body, kind) values (${id}, 'p1', ${topic.agent_id}, 'late', 'human')`
    await tx`insert into execution (id, inbound_id, conversation_id, agent, runner, incarnation, placement_generation, state, input_digest)
      values (${`ex-${id}`}, ${id}, ${topic.conversation_id}, ${topic.agent_id}, ${SRC.runner}, 'src-1', 1, 'interrupted', 'd')`
    await tx`insert into replay_hold (inbound_id, execution_id, conversation_id, cause) values (${id}, ${`ex-${id}`}, ${topic.conversation_id}, 'interrupted')`
  }

  // DRAIN BOUNDARY. The hold is written by a transaction that has not committed when the request reads its holds (nor when the trigger ran).
  const t = await s.topic()
  const inflight = await openTransaction(planter, tx => plant(tx, t, "h-flight"))
  const move = await s.request(t)
  expect(move.preexisting_holds, "the uncommitted hold is not a hold the request could see").toEqual([])
  expect(move.source_facts.holds).toBe(0)
  inflight.release()
  await inflight.done
  expect((await s.reread(move)).stage, "nothing noticed it: the trigger ran before the move existed").toBe("waiting")
  const native = await s.nativeOf(move)
  expect(await destReady(s.tool, move.id, s.dst(), FACTS)).toBe("ready")
  const intent: DrainIntent = { id: "intent-src-1", boot_id: BOOT_1, machine: "pi", leader: 1, group: 1, pids: [1] }
  expect(await recordDrainIntent(s.tool, move.id, s.src(), intent)).toBe("intent")
  expect(await recordDrainDone(s.tool, move.id, s.src(), drainEvidence(move, native, { incarnation: "src-1" }, intent)), "a failure nobody showed the owner").toBe("failure-unacknowledged")
  const shown = await s.reread(move)
  expect(shown.stage).toBe("awaiting_owner")
  expect(shown.failure).toMatchObject({ inbound: "h-flight", execution: "ex-h-flight", revision: 1, cause: "interrupted" })
  expect(shown.drain).toBeNull()
  expect(rows(await s.su`select state, choice, revision from replay_hold where inbound_id = 'h-flight'`)).toMatchObject([{ state: "held", choice: null, revision: 1 }])
  expect(await s.openGates(t.agent_id)).toEqual([moveGateOperation(move.id)])
  // Movement `continue` is bound to that very failure and revision, separate from recovery: it answers that and nothing else.
  expect(await continueMove(s.tool, move.id, OWNER, { execution: "ex-h-flight", revision: 2 })).toBe("stale")
  expect(await continueMove(s.tool, move.id, OWNER, { execution: "ex-h-flight", revision: 1 })).toBe("waiting")
  expect(rows(await s.su`select state, choice from replay_hold where inbound_id = 'h-flight'`)).toMatchObject([{ state: "held", choice: null }])

  // RELEASE BOUNDARY. The drain completes while a hold is in flight; the hold commits; the release finds it and persists it.
  const u = await s.topic()
  const late = await openTransaction(planter, tx => plant(tx, u, "h-late"))
  const second = await s.request(u)
  await s.drain(second)
  const generation = exportGenerationOf(await s.reread(second))!
  for (const file of FILES) expect(await putBlob(s.tool, second.id, s.src(), generation, { ...file, mode: 0o600 })).toBe("stored")
  late.release()
  await late.done
  expect((await s.reread(second)).stage).toBe("waiting")
  const snapshot = (await checkpointOf(s.tool, u.conversation_id))!
  expect(await releaseSource(s.tool, second.id, s.src(), generation, snapshot, manifestOf(FILES))).toBe("failure-unacknowledged")
  const found = await s.reread(second)
  expect(found.stage).toBe("awaiting_owner")
  expect(found.failure).toMatchObject({ inbound: "h-late", execution: "ex-h-late", revision: 1 })
  expect(found.manifest).toBeNull()
  expect(await checkMoveFailure(s.tool, second.id), "asked again, the same failure").toBe("awaiting_owner")
  expect(rows(await s.su`select state, choice from replay_hold where inbound_id = 'h-late'`)).toMatchObject([{ state: "held", choice: null }])
  expect(await s.openGates(u.agent_id)).toEqual([moveGateOperation(second.id)])
})

test("the hold trigger decides on the move's row after it holds the lock: a `continue` that acknowledged the failure is not overwritten by a stale reading, a genuinely newer revision still reaches the owner, and neither deadlocks", async () => {
  const s = await stage()
  await s.fleet()
  const planter = track(cluster.connect(s.db))
  const t = await s.topic()
  const live = await s.fed(t, "h-live")
  const move = await s.request(t)
  await endAttempt(s.tool, { execution: live.execution.id, evidence: NOT_GONE, cause: "the child was lost" })
  await endAttempt(s.tool, { execution: live.execution.id, evidence: GONE, cause: "the process tree was looked up again and is gone" })
  expect((await s.reread(move)).failure).toMatchObject({ execution: live.execution.id, revision: 2, cause: "interrupted" })
  const exec = live.execution.id

  // BARRIER: the owner's `continue` has acknowledged revision 2 and has not committed; a write to that very hold reaches the trigger and WAITS for the move's row.
  const continuer = s.as("hub_runner")
  const writerPid = await pidOf({ sql: planter } as unknown as StoreLike)
  const continuing = await openTransaction(continuer.sql, async tx => {
    const [said] = await tx`select hub_move_continue(${move.id}, ${OWNER}, ${exec}, ${2}::integer, ${{}}::jsonb) as answer`
    expect(said.answer).toBe("waiting")
  })
  const touching = planter`update replay_hold set state = 'keep_held' where execution_id = ${exec}`.then(() => "touched" as const, (error: unknown) => error)
  await blockedOnLock(s.su, writerPid)
  continuing.release()
  await continuing.done
  expect(await touching).toBe("touched")
  const answered = await s.reread(move)
  expect(answered.stage, "the trigger read the acknowledgement AFTER the lock: it is not a failure again").toBe("waiting")
  expect(answered.failure).toBeNull()
  expect(answered.acknowledged_failures).toMatchObject([{ execution: exec, revision: 2, by: OWNER }])
  expect(rows(await s.su`select state, choice from replay_hold where execution_id = ${exec}`)).toMatchObject([{ state: "keep_held", choice: null }])

  // A GENUINELY NEWER REVISION of the same hold (more was learned) is a new failure at its own revision, shown again.
  await planter`update replay_hold set revision = 3, cause = 'ownership-unknown' where execution_id = ${exec}`
  const newer = await s.reread(move)
  expect(newer.stage).toBe("awaiting_owner")
  expect(newer.failure).toMatchObject({ execution: exec, revision: 3, cause: "ownership-unknown" })
  expect(await continueMove(s.tool, move.id, OWNER, { execution: exec, revision: 2 }), "the answer to the older revision is void").toBe("stale")
  expect(rows(await s.su`select state, revision from replay_hold where execution_id = ${exec}`)).toMatchObject([{ state: "keep_held", revision: 3 }])
  expect(await s.openGates(t.agent_id)).toEqual([moveGateOperation(move.id)])
})

test("writing a hold takes neither the agent's ordering lock nor the topic's: while another transaction holds the ordering lock, the attempt's end still commits its hold and the move still moves to awaiting_owner", async () => {
  const s = await stage()
  await s.fleet()
  const t = await s.topic()
  const live = await s.fed(t, "h-live")
  const move = await s.request(t)
  const holder = s.as("hub_runner")
  // A feed takes the agent's ordering lock BEFORE the attempt's row; the trigger of a hold (inside the end of that attempt) must never wait for it.
  const ordering = await openTransaction(holder.sql, tx => tx`select hub_gate_order(${t.agent_id}::text)`)
  await endAttempt(s.tool, { execution: live.execution.id, evidence: NOT_GONE, cause: "the child was lost" })
  expect((await s.reread(move)).stage).toBe("awaiting_owner")
  expect(rows(await s.su`select state from replay_hold where execution_id = ${live.execution.id}`)).toMatchObject([{ state: "held" }])
  ordering.release()
  await ordering.done
})

test("a proven-unfed observation is not the authority to release an attempt: a feed that commits after the helper's read is resolved by the end's own locked classification - unknown and held, never failed and reclaimable - while a genuinely unfed attempt stays queued with no hold", async () => {
  const s = await stage()
  await s.fleet()

  // RACE. The runner was refused the first feed (MoveGated), the helper re-read the attempt as unfed, and then a feed intent COMMITTED before the end.
  const t = await s.topic()
  const { execution } = await s.attempt(t, "h1")
  const move = await s.request(t)
  const refused = await markFeedIntent(s.tool, execution, "body of h1").then(() => null, (error: unknown) => error)
  expect(refused).toBeInstanceOf(MoveGated)
  const end = await provenUnfedEnd(s.tool, refused as MoveGated)
  expect(end).toEqual({ execution: execution.id, evidence: null, cause: `move-gated:${move.id}` })
  await s.su`update execution set state = 'feed_intent', feed_intent_at = now() where id = ${execution.id}`
  await endAttempt(s.tool, end!)
  expect((await s.su`select state from execution where id = ${execution.id}`)[0].state, "fed meanwhile: not failed").toBe("unknown")
  expect(rows(await s.su`select cause, state from replay_hold where inbound_id = 'h1'`)).toMatchObject([{ cause: "ownership-unknown", state: "held" }])
  expect((await s.su`select hub_row_held('h1') as held`)[0].held).toBe(true)
  expect((await s.su`select hub_move_unresolved(${t.agent_id}) as n`)[0].n, "the slot stays taken until the existing machinery resolves it").toBe(1)
  expect(await claimNext(s.tool, { runner: SRC.runner, agent: t.agent_id, leaseMs: 60_000, resumeOk: true })).toBeNull()
  expect(await s.reread(move)).toMatchObject({ stage: "awaiting_owner", failure: { inbound: "h1", cause: "ownership-unknown" } })
  expect(await s.openGates(t.agent_id)).toEqual([moveGateOperation(move.id)])

  // GENUINELY UNFED: nothing moved between the read and the end. It is failed, the claim is released, no hold, and the row is still queued.
  const u = await s.topic()
  const plain = await s.attempt(u, "h2")
  const asked = await s.request(u)
  const gated = await markFeedIntent(s.tool, plain.execution, "body of h2").then(() => null, (error: unknown) => error)
  const unfed = await provenUnfedEnd(s.tool, gated as MoveGated)
  await endAttempt(s.tool, unfed!)
  expect((await s.su`select state from execution where id = ${plain.execution.id}`)[0].state).toBe("failed")
  expect(await s.count("replay_hold where inbound_id = 'h2'")).toBe(0)
  expect(rows(await s.su`select claimed_by from inbound where id = 'h2'`)).toMatchObject([{ claimed_by: null }])
  expect((await s.reread(asked)).stage).toBe("waiting")
  expect(await s.openGates(u.agent_id)).toEqual([moveGateOperation(asked.id)])
})
