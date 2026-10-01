// The store's half of moving a topic master, continued (IMP-231, migration 016): withdrawal and import in both orders, the registry receipt
// and serve, an archive between activation and serve, the relocation note, the queue across a move, and the migration itself.
//
// WHAT THIS PROVES is the store's: stages, generations, ownership of copies, what is refused after a terminal stage, and gate retention on every
// refusal. WHAT IT DOES NOT, and this file does not pretend to: that a destination removes only the files it owns (the store records the intent
// to clean up and accepts a report that it was done), that a runner writes or recovers a note at the right seam, that a registry file is
// rewritten safely, or that a native session can be carried. Those are runner, hub and transfer tests that come after this slice.

import { afterAll, afterEach, beforeAll, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { hubPath, startCluster, type Cluster } from "./helpers/cluster.ts"
import { rolloutDatabase } from "./helpers/rollout-fixtures.ts"
import { BOOT_MAC_1, DST, FACTS, FILES, NOTE_BODY, OWNER, SRC, moveStage, sha } from "./helpers/move-store-stage.ts"
import type { StoreLike } from "../src/store/connect.ts"
import { claimNext } from "../src/runner/claim.ts"
import { endAttempt } from "../src/runner/execution.ts"
import type { ExitEvidence } from "../src/adapters/types.ts"
import {
  ExecutionNotOwned, MoveNoteRefused, completeExecution, conversationFor, markFeedIntent, markLaunched, markProgress, mintNativeSession, openExecution, openHoldsOf,
  verifyNative,
} from "../src/store/conversations.ts"
import { MIGRATION_FILES, migrate } from "../src/store/migrate.ts"
import { gatesOn, placeGate, releaseGates } from "../src/store/controls.ts"
import { completeTransition, readTopic, recordChannel, requestTransition } from "../src/store/topics.ts"
import {
  MoveBlobsGone, NOT_LIVE_COPY_STATES, activateMove, advanceImport, beginImport, blockMove, checkpointOf, continueMove, copiesAtLocation, copiesDueForCleanup, copiesOf,
  copyRemoved, destReady, failImport, moveGateOperation, noteDelivered, pendingNotesOf, putBlob, readBlobs, recordDrainIntent, recordRegistryWritten,
  refreshRegistryReceipt, releaseSource, requestMove, retireCopy, serveMove, unblockMove, withdrawMove, type MoveStage,
} from "../src/store/moves.ts"

let cluster: Cluster
const mine: { close(): Promise<void> }[] = []
const track = <T extends { close(): Promise<void> }>(sql: T): T => { mine.push(sql); return sql }
beforeAll(async () => { cluster = await startCluster() })
afterEach(async () => { for (const one of mine.splice(0)) await one.close().catch(() => {}) })
afterAll(async () => { await cluster?.stop() })

const stage = () => moveStage(cluster, track)
const attempt = async (query: PromiseLike<unknown>): Promise<void> => { await query }
/** Rows as plain objects, so that `toMatchObject` and `toEqual` compare what the statement returned and not the client's row list. */
const rows = (result: unknown) => Array.from(result as Record<string, unknown>[]).map(row => ({ ...row }))
const GONE: ExitEvidence = { confirmed: true, leader: "exited", descendants: "none", pids: [], survivors: [], via: "test" }

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

test("withdrawing during the import releases only this move's gate and leaves the others and every hold; a late completion, activation or write after it cannot resurrect anything; cleanup is the move's own and never touches a later move's copy", async () => {
  const s = await stage()
  await s.fleet()
  const t = await s.topic()
  // A hold from before the request, two queued rows, and another operation's gate over the same agent.
  const pre = await s.fed(t, "h-pre")
  await endAttempt(s.tool, { execution: pre.execution.id, evidence: GONE, cause: "test" })
  await s.inbound("h1", t.agent_id)
  await s.inbound("h2", t.agent_id)
  const move = await s.request(t)
  expect(await placeGate(s.tool, { operation: "other-op", scope: { kind: "agent", id: t.agent_id }, cause: "archive" })).toBe("open")
  await s.reach(move, "source_released")
  const begun = await beginImport(s.tool, move.id, s.dst())
  expect(begun).toEqual({ answer: "intent", generation: 1, staging: `move-${move.id}-g1` })
  const sealed = await s.reread(move)
  const read = { manifest_digest: sealed.manifest!.digest, generation: 1, staging: begun.staging, files: 2, bytes: sealed.manifest!.bytes }
  expect(await advanceImport(s.tool, move.id, s.dst(), 1, "verified", read)).toBe("verified")
  expect((await readBlobs(s.tool, sealed)).map(blob => `${blob.kind}/${blob.path}`).sort(), "the destination reads exactly the manifest's files").toEqual(["native/session/a.jsonl", "session/notes/b.txt"])

  // The owner withdraws while the destination is mid-import.
  const notice = { body: "The move was withdrawn.", person: "p1", agent: t.agent_id, route: { door: "door-d", chat: "chat-x" } }
  expect(await withdrawMove(s.tool, move.id, OWNER, { notice })).toBe("withdrawn")
  expect(await withdrawMove(s.tool, move.id, OWNER, { notice })).toBe("replay")
  expect(await s.count("outbox where notice_key = $1", `topic-move:${move.id}:withdrawn`)).toBe(1)
  const gone = await s.reread(move)
  expect(gone).toMatchObject({ stage: "withdrawn", block: null, failure: null })
  expect(await s.openGates(t.agent_id), "only this move's gate was released").toEqual(["other-op"])
  expect((await gatesOn(s.tool, { kind: "agent", id: t.agent_id })).find(gate => gate.operation === moveGateOperation(move.id))).toMatchObject({ state: "released" })
  expect(await openHoldsOf(s.tool, t.conversation_id), "an existing hold is neither released nor replayed").toHaveLength(1)
  expect((await copiesOf(s.tool, move.id)).map(copy => `${copy.kind}:${copy.state}`)).toEqual(["dest_import:cleanup_due", "source_session_retained:source_owned"])
  expect(await s.count("move_blob where move_id = $1", move.id)).toBe(0)
  // A reader that was in flight finds the files gone and must fail, never import nothing.
  await expect(readBlobs(s.tool, gone)).rejects.toBeInstanceOf(MoveBlobsGone)

  // Late writes are refused by the stage, and the move does not come back.
  const verification = s.verificationOf(sealed, { generation: 1, staging: begun.staging! })
  const checkpoint = (await checkpointOf(s.tool, t.conversation_id))!
  expect(await advanceImport(s.tool, move.id, s.dst(), 1, "promote_intent")).toBe("terminal")
  expect(await activateMove(s.tool, move.id, s.dst(), 1, verification)).toBe("terminal")
  expect(await beginImport(s.tool, move.id, s.dst())).toMatchObject({ answer: "terminal" })
  expect(await failImport(s.tool, move.id, s.dst(), 1, "late_failure", {})).toBe("terminal")
  expect(await destReady(s.tool, move.id, s.dst(), FACTS)).toBe("terminal")
  expect(await blockMove(s.tool, move.id, s.dst(), "late_block", {})).toBe("terminal")
  expect(await putBlob(s.tool, move.id, s.src(), 1, { ...FILES[0], mode: 0o600 })).toBe("terminal")
  expect(await recordDrainIntent(s.tool, move.id, s.src(), { id: "late", boot_id: "b", machine: "pi" })).toBe("terminal")
  expect(await releaseSource(s.tool, move.id, s.src(), 1, checkpoint, sealed.manifest!)).toBe("terminal")
  expect(await continueMove(s.tool, move.id, OWNER, { execution: "x", revision: 1 })).toBe("terminal")
  expect(await recordRegistryWritten(s.hub, move.id, { digest: sha("x"), agent: t.agent_id, runner: DST.runner, machine: DST.machine, placement_generation: 2, profile: FACTS.profile })).toBe("terminal")
  expect((await s.reread(move)).stage).toBe("withdrawn")
  expect(rows(await s.su`select machine, placement_generation from conversation where id = ${t.conversation_id}`)).toMatchObject([{ machine: "pi", placement_generation: 1 }])

  // Cleanup is the owner's report, for a copy that is due and is its own, and it names that copy's staging identity.
  const own = { staging: begun.staging! }
  expect(await copyRemoved(s.tool, move.id, s.dst("dst-0"), 1, own)).toBe("not-owner")
  expect(await copyRemoved(s.tool, move.id, s.dst(), 2, own)).toBe("unknown-copy")
  expect(await copyRemoved(s.tool, move.id, s.dst(), 1, { staging: "move-elsewhere-g1" }), "a receipt that names another copy").toBe("receipt-mismatch")
  expect((await copiesOf(s.tool, move.id)).find(copy => copy.kind === "dest_import")!.state, "nothing was certified").toBe("cleanup_due")
  expect(await copyRemoved(s.tool, move.id, s.dst(), 1, { ...own, removed: "only what this move's staging identity owned" })).toBe("removed")
  expect(await copyRemoved(s.tool, move.id, s.dst(), 1, own)).toBe("replay")

  // The queue is whole once the other operation's gate is released: no row was lost, and the source takes the oldest first, with the hold still there.
  expect(await releaseGates(s.tool, { operation: "other-op" })).toBe(1)
  expect((await claimNext(s.tool, { runner: SRC.runner, agent: t.agent_id, leaseMs: 60_000, resumeOk: true }))?.id).toBe("h1")
  await s.su`update inbound set claimed_by = null, claim_deadline = null where id = 'h1'`

  // A LATER move of the same topic owns a staging identity of its own, and the earlier move's cleanup cannot touch it.
  const second = await s.request(t, "move-second")
  await s.reach(second, "promoted")
  const later = (await copiesOf(s.tool, second.id)).find(copy => copy.kind === "dest_import")!
  expect(later).toMatchObject({ state: "promoted", generation: 1, staging_id: `move-${second.id}-g1` })
  expect(later.staging_id).not.toBe(begun.staging)
  expect(await copyRemoved(s.tool, move.id, s.dst(), 1, own), "the earlier cleanup again").toBe("replay")
  expect(await copyRemoved(s.tool, second.id, s.dst(), 1, { staging: later.staging_id }), "a promoted copy has no path to removal").toBe("not-due")
  expect(await copyRemoved(s.tool, second.id, s.dst(), 1, own), "an earlier identity cannot release a later owner's copy").toBe("not-due")
  expect((await copiesOf(s.tool, second.id)).find(copy => copy.kind === "dest_import")!.state).toBe("promoted")
})

test("activation and withdrawal are ordered by the move's row lock in both orders: a withdrawn promoted import is never activated, an activated move is never withdrawn (and is not replaced while it finishes), and raced exactly one wins", async () => {
  const s = await stage()
  await s.fleet()

  // WITHDRAW FIRST: the promoted import is the move's own and is due for cleanup; activation is refused.
  const a = await s.topic()
  const ma = await s.request(a)
  await s.reach(ma, "promoted")
  const beforeA = await s.reread(ma)
  expect(await withdrawMove(s.tool, ma.id, OWNER)).toBe("withdrawn")
  expect(await activateMove(s.tool, ma.id, s.dst(), 1, s.verificationOf(beforeA, { generation: 1, staging: `move-${ma.id}-g1` }))).toBe("terminal")
  expect((await copiesOf(s.tool, ma.id)).find(copy => copy.kind === "dest_import")!.state).toBe("cleanup_due")
  expect(rows(await s.su`select machine, placement_generation from conversation where id = ${a.conversation_id}`)).toMatchObject([{ machine: "pi", placement_generation: 1 }])
  expect(rows(await s.su`select machine, runner from topic where id = ${a.id}`)).toMatchObject([{ machine: "pi", runner: "runner-pi" }])
  expect(await s.openGates(a.agent_id)).toEqual([])

  // ACTIVATE FIRST: too late to withdraw, and the activated move must finish its destination handoff before another is asked for.
  const b = await s.topic()
  const mb = await s.request(b)
  await s.reach(mb, "activated")
  expect(await withdrawMove(s.tool, mb.id, OWNER)).toBe("too-late")
  expect(await s.reread(mb)).toMatchObject({ stage: "activated", dest_generation: 2 })
  expect(await s.openGates(b.agent_id)).toEqual([moveGateOperation(mb.id)])
  expect(rows(await s.su`select machine, placement_generation from conversation where id = ${b.conversation_id}`)).toMatchObject([{ machine: "mac", placement_generation: 2 }])
  expect((await requestMove(s.tool, { operation: "again", topic: b.id, destRunner: SRC.runner, destMachine: SRC.machine, by: OWNER })).answer, "no immediate reverse move is promised").toBe("in-progress")
  expect(await recordRegistryWritten(s.hub, mb.id, s.receiptOf(await s.reread(mb)))).toBe("written")
  expect(await withdrawMove(s.tool, mb.id, OWNER)).toBe("too-late")
  expect(await serveMove(s.tool, mb.id, s.dst(), s.loadedOf(await s.reread(mb)), s.NOTE, s.notice(mb))).toBe("active")
  expect(await withdrawMove(s.tool, mb.id, OWNER)).toBe("too-late")

  // RACED: both wait on the agent's ordering lock in concurrent transactions and the store lets exactly one win, whichever the server grants first.
  const c = await s.topic()
  const mc = await s.request(c)
  await s.reach(mc, "promoted")
  const verification = s.verificationOf(await s.reread(mc), { generation: 1, staging: `move-${mc.id}-g1` })
  const holder = s.as("hub_runner")
  const activator = s.as("hub_runner")
  const withdrawer = s.as("hub_door")
  const [activatorPid, withdrawerPid] = [await pidOf(activator), await pidOf(withdrawer)]
  let release!: () => void
  let entered!: () => void
  const released = new Promise<void>(resolve => { release = resolve })
  const inside = new Promise<void>(resolve => { entered = resolve })
  const hold = holder.sql.begin(async (tx: any) => { await tx`select hub_gate_order(${c.agent_id}::text)`; entered(); await released })
  await Promise.race([inside, hold])
  const activating = activateMove(activator, mc.id, s.dst(), 1, verification).then(answer => answer as string, (error: unknown) => error)
  await blockedOnLock(s.su, activatorPid)
  const withdrawing = withdrawMove(withdrawer, mc.id, OWNER).then(answer => answer as string, (error: unknown) => error)
  await blockedOnLock(s.su, withdrawerPid)
  release()
  await hold
  const [won, lost] = await Promise.all([activating, withdrawing])
  const after = await s.reread(mc)
  if (won === "activated") {
    expect(lost).toBe("too-late")
    expect(after.stage).toBe("activated")
    expect(await s.openGates(c.agent_id)).toEqual([moveGateOperation(mc.id)])
    expect(rows(await s.su`select machine from conversation where id = ${c.conversation_id}`)).toMatchObject([{ machine: "mac" }])
  } else {
    expect(won).toBe("terminal")
    expect(lost).toBe("withdrawn")
    expect(after.stage).toBe("withdrawn")
    expect(await s.openGates(c.agent_id)).toEqual([])
    expect(rows(await s.su`select machine from conversation where id = ${c.conversation_id}`)).toMatchObject([{ machine: "pi" }])
  }
})

test("a withdrawal waits for the execution machinery: with an attempt owned it is refused and nothing changes; once it is resolved the same call withdraws", async () => {
  const s = await stage()
  await s.fleet()
  const t = await s.topic()
  const turn = await s.fed(t, "h1")
  const move = await s.request(t)
  expect(await withdrawMove(s.tool, move.id, OWNER)).toBe("execution-unresolved")
  expect((await s.reread(move)).stage).toBe("waiting")
  expect(await s.openGates(t.agent_id)).toEqual([moveGateOperation(move.id)])
  await markProgress(s.tool, turn.execution.id, "received")
  await completeExecution(s.tool, { execution: turn.execution.id, runner: SRC.runner, reply: "done", fence: { incarnation: "src-1" } })
  expect(await withdrawMove(s.tool, move.id, "", {})).toBe("withdraw-invalid")
  expect(await withdrawMove(s.tool, move.id, OWNER)).toBe("withdrawn")
  expect(await s.openGates(t.agent_id)).toEqual([])
  // The settled turn's row is answered (its settle is the runner's); the next message is an ordinary one again, on the source.
  await s.su`insert into ledger_event (stream, subject, kind, actor) values ('inbound', 'h1', 'answered', 'runner')`
  await s.inbound("h2", t.agent_id)
  expect((await claimNext(s.tool, { runner: SRC.runner, agent: t.agent_id, leaseMs: 60_000, resumeOk: true }))?.id).toBe("h2")
})

test("a failed import hands its generation back for cleanup and the next generation cannot begin until the owner reported it removed; a stale generation or a replaced incarnation cannot complete anything, and a restarted destination resumes its own staging identity", async () => {
  const s = await stage()
  await s.fleet()
  const t = await s.topic()
  const move = await s.request(t)
  await s.reach(move, "source_released")
  const first = await beginImport(s.tool, move.id, s.dst())
  expect(first).toEqual({ answer: "intent", generation: 1, staging: `move-${move.id}-g1` })
  expect(await failImport(s.tool, move.id, s.dst(), 1, "import_verification_failed", { files: 1 })).toBe("failed")
  expect(await s.reread(move)).toMatchObject({ stage: "source_released", block: { code: "import_verification_failed", by: "dest" } })
  expect(await s.openGates(t.agent_id), "a failure keeps the gate: nothing falls back to the source").toEqual([moveGateOperation(move.id)])
  expect((await copiesOf(s.tool, move.id)).find(copy => copy.kind === "dest_import")).toMatchObject({ generation: 1, state: "cleanup_due" })

  expect(await beginImport(s.tool, move.id, s.dst())).toMatchObject({ answer: "blocked" })
  expect(await unblockMove(s.tool, move.id, s.src(), "import_verification_failed")).toBe("not-yours")
  expect(await unblockMove(s.tool, move.id, s.dst(), "import_verification_failed")).toBe("cleared")
  expect(await beginImport(s.tool, move.id, s.dst()), "the first generation's files are still the owner's to remove").toMatchObject({ answer: "cleanup-pending" })
  expect(await copyRemoved(s.tool, move.id, s.dst(), 1, { staging: first.staging!, removed: "its own staging" })).toBe("removed")
  const second = await beginImport(s.tool, move.id, s.dst())
  expect(second).toEqual({ answer: "intent", generation: 2, staging: `move-${move.id}-g2` })

  // The late completion of the first generation resurrects nothing.
  const sealed = await s.reread(move)
  const read = (generation: number, staging: string) => ({ manifest_digest: sealed.manifest!.digest, generation, staging, files: 2, bytes: sealed.manifest!.bytes })
  expect(await advanceImport(s.tool, move.id, s.dst(), 1, "verified", read(1, first.staging!))).toBe("stale-generation")
  expect(await failImport(s.tool, move.id, s.dst(), 1, "late_failure", {})).toBe("stale-generation")
  expect((await copiesOf(s.tool, move.id)).find(copy => copy.generation === 2)).toMatchObject({ state: "intent" })

  // The destination restarts: the old incarnation is fenced out and the new one resumes its own generation, not a foreign collision.
  await s.register(DST, "dst-2")
  expect(await advanceImport(s.tool, move.id, s.dst(), 2, "verified", read(2, second.staging!))).toBe("not-destination")
  expect(await beginImport(s.tool, move.id, s.dst("dst-2"))).toEqual({ answer: "resumed", generation: 2, staging: second.staging })
  expect(await advanceImport(s.tool, move.id, s.dst("dst-2"), 2, "verified", read(2, second.staging!))).toBe("verified")
  expect(await advanceImport(s.tool, move.id, s.dst("dst-2"), 2, "verified", read(2, second.staging!))).toBe("replay")
  expect(await advanceImport(s.tool, move.id, s.dst("dst-2"), 2, "promote_intent")).toBe("promote_intent")
  expect(await advanceImport(s.tool, move.id, s.dst("dst-2"), 2, "promoted")).toBe("promoted")
  expect(await activateMove(s.tool, move.id, s.dst(), 2, s.verificationOf(sealed, { generation: 2, staging: second.staging! }))).toBe("not-destination")
  expect(await activateMove(s.tool, move.id, s.dst("dst-2"), 2, s.verificationOf(sealed, { generation: 2, staging: second.staging! }))).toBe("activated")
  expect((await copiesOf(s.tool, move.id)).map(copy => `${copy.kind}:${copy.generation}:${copy.state}`))
    .toEqual(["dest_import:1:removed", "dest_import:2:promoted", "source_session_retained:1:retained"])
})

test("the registry receipt and serve: a stale loaded digest or drifted profile keeps the gate, unrelated edits refresh the receipt only for an equivalent binding, digests are compared for equality and nothing is ordered, and serve alone releases the gate", async () => {
  const s = await stage()
  await s.fleet()
  const t = await s.topic()
  const move = await s.request(t)
  const activated = await s.reach(move, "activated")
  const gate = [moveGateOperation(move.id)]
  const stays = async (stageName: MoveStage) => {
    expect((await s.reread(move)).stage).toBe(stageName)
    expect(await s.openGates(t.agent_id)).toEqual(gate)
    expect(await s.count("outbox where notice_key like 'topic-move:%'")).toBe(0)
  }

  // A write of the runner key alone is never readiness: serve is not reachable before the hub's receipt.
  expect(await serveMove(s.tool, move.id, s.dst(), s.loadedOf(activated), s.NOTE, s.notice(move))).toBe("stage")
  await stays("activated")
  // The receipt is the hub's alone, and bound to the agent, the destination, the activated placement and the destination's own profile.
  await expect(attempt(s.tool.sql`select hub_move_registry_written(${move.id}, ${{}}::jsonb)`)).rejects.toThrow(/permission denied/)
  const receipt = s.receiptOf(activated)
  for (const [what, bad] of [["runner", { ...receipt, runner: "runner-x" }], ["machine", { ...receipt, machine: "pi" }], ["agent", { ...receipt, agent: "p1-other" }],
    ["placement", { ...receipt, placement_generation: 1 }], ["profile", { ...receipt, profile: { ...FACTS.profile, model: "other" } }], ["digest", { ...receipt, digest: "latest" }]] as const) {
    expect(await recordRegistryWritten(s.hub, move.id, bad), what).toBe("receipt-invalid")
  }
  await stays("activated")
  expect(await recordRegistryWritten(s.hub, move.id, receipt)).toBe("written")
  expect(await recordRegistryWritten(s.hub, move.id, receipt)).toBe("replay")
  expect(await recordRegistryWritten(s.hub, move.id, s.receiptOf(activated, sha("registry-2")))).toBe("use-refresh")
  const at = await s.reread(move)

  // SERVE refuses what does not match what the store holds, and every refusal keeps the gate and the stage.
  const serve = (over: Record<string, unknown> = {}, digest = sha("registry-1")) => serveMove(s.tool, move.id, s.dst(), s.loadedOf(at, digest, over as never), s.NOTE, s.notice(move))
  expect(await serve({}, sha("registry-0")), "the loaded snapshot is not the observed one").toBe("registry-stale")
  expect(await serve({ profile: { ...FACTS.profile, model: "other" } })).toBe("profile-mismatch")
  expect(await serve({ capabilities: { resume: false, mcp: true } })).toBe("profile-mismatch")
  expect(await serve({ imported: { generation: 2, manifest_digest: at.manifest!.digest } })).toBe("loaded-mismatch")
  expect(await serve({ imported: { generation: 1, manifest_digest: sha("another manifest") } })).toBe("loaded-mismatch")
  expect(await serve({ runner: "runner-x" })).toBe("loaded-mismatch")
  expect(await serve({ placement_generation: 3 })).toBe("loaded-mismatch")
  expect(await serveMove(s.tool, move.id, s.src(), s.loadedOf(at), s.NOTE, s.notice(move))).toBe("not-destination")
  expect(await serveMove(s.tool, move.id, s.dst("dst-0"), s.loadedOf(at), s.NOTE, s.notice(move))).toBe("not-destination")
  expect(await serveMove(s.tool, move.id, s.dst(), s.loadedOf(at), { digest: "not-a-digest" }, s.notice(move))).toBe("loaded-invalid")
  await stays("registry_written")

  // Unrelated registry edits change the digest: the hub reconciles and refreshes for an EQUIVALENT binding, and refuses any other.
  const edited = s.receiptOf(at, sha("registry-2"))
  expect(await refreshRegistryReceipt(s.hub, move.id, { ...edited, runner: "runner-x" })).toBe("binding-changed")
  expect(await refreshRegistryReceipt(s.hub, move.id, { ...edited, profile: { ...FACTS.profile, model: "other" } })).toBe("binding-changed")
  expect(await refreshRegistryReceipt(s.hub, move.id, { ...edited, placement_generation: 99 })).toBe("binding-changed")
  expect(await refreshRegistryReceipt(s.hub, move.id, s.receiptOf(at))).toBe("unchanged")
  await expect(attempt(s.tool.sql`select hub_move_registry_refresh(${move.id}, ${edited}::jsonb)`)).rejects.toThrow(/permission denied/)
  expect(await refreshRegistryReceipt(s.hub, move.id, edited)).toBe("refreshed")
  expect((await s.reread(move)).registry_receipt).toMatchObject({ digest: sha("registry-2") })
  // The destination still has the older bytes loaded: it is not ready, and "older" means nothing, only "not the same".
  expect(await serve({})).toBe("registry-stale")
  await stays("registry_written")

  // It reloads, and only now is the gate released, the note owed, the notice queued once and the blobs removed.
  expect(await serveMove(s.tool, move.id, s.dst(), s.loadedOf(at, sha("registry-2")), s.NOTE, s.notice(move))).toBe("active")
  expect(await serveMove(s.tool, move.id, s.dst(), s.loadedOf(at, sha("registry-2")), s.NOTE, s.notice(move))).toBe("replay")
  expect(await s.reread(move)).toMatchObject({ stage: "active", note_state: "pending", note_digest: s.NOTE.digest })
  expect(await s.openGates(t.agent_id)).toEqual([])
  expect((await gatesOn(s.tool, { kind: "agent", id: t.agent_id })).find(one => one.operation === gate[0])).toMatchObject({ state: "released" })
  expect(await s.count("outbox where notice_key = $1", `topic-move:${move.id}:active`)).toBe(1)
  expect(await s.count("move_blob where move_id = $1", move.id)).toBe(0)
  expect((await copiesOf(s.tool, move.id)).map(copy => `${copy.kind}:${copy.state}`)).toEqual(["dest_import:active", "source_session_retained:retained_stale"])
  // Terminal: late writes are refused, and an active copy has no path to removal.
  expect(await destReady(s.tool, move.id, s.dst(), FACTS)).toBe("terminal")
  expect(await blockMove(s.tool, move.id, s.dst(), "late_block", {})).toBe("terminal")
  expect(await refreshRegistryReceipt(s.hub, move.id, edited)).toBe("terminal")
  expect(await withdrawMove(s.tool, move.id, OWNER)).toBe("too-late")
  expect(await copyRemoved(s.tool, move.id, s.dst(), 1, { staging: `move-${move.id}-g1` })).toBe("not-due")
  await expect(attempt(s.su`update topic_move set block = '{"code":"late"}'::jsonb where id = ${move.id}`)).rejects.toThrow(/is active and stays so/)
})

test("an archive that lands between activation and serve keeps the gate and the stage, queues no false notice and releases nothing; the block clears when the topic is active again, and a move that was not yet activated can still be withdrawn from it", async () => {
  const s = await stage()
  await s.fleet()
  const t = await s.topic()
  const move = await s.request(t)
  const at = await s.reach(move, "registry_written")
  expect(await requestTransition(s.tool, { operation: "arch-mid", topic: t.id, kind: "archive", source: "tool", by: OWNER, route: null, evidence: {} })).toBe("ok")
  expect(await recordChannel(s.door, "arch-mid", "applied", { prior: {} }, {})).toBe("applied")
  expect(await completeTransition(s.door, "arch-mid", {}, null)).toBe("complete")
  expect((await readTopic(s.tool, t.id))!.lifecycle).toBe("archived")

  const serve = () => serveMove(s.tool, move.id, s.dst(), s.loadedOf(at), s.NOTE, s.notice(move))
  expect(await serve()).toBe("topic-not-active")
  expect(await s.reread(move)).toMatchObject({ stage: "registry_written", note_state: null, block: { code: "topic_not_active", by: "store" } })
  expect(await s.openGates(t.agent_id), "neither the archive's gate nor the move's was released").toEqual(["arch-mid", moveGateOperation(move.id)].sort())
  expect(await s.count("outbox where notice_key like 'topic-move:%'"), "no false running or completed-move notice").toBe(0)
  expect(await unblockMove(s.tool, move.id, s.dst(), "topic_not_active")).toBe("still-blocked")
  expect(await serve()).toBe("topic-not-active")

  // Reopened: the archive's own gate is released by its reopen, the store's own block clears, and the move completes.
  expect(await requestTransition(s.tool, { operation: "reopen-mid", topic: t.id, kind: "reopen", source: "tool", by: OWNER, route: null, evidence: {} })).toBe("ok")
  expect(await completeTransition(s.door, "reopen-mid", {}, null)).toBe("complete")
  expect(await s.openGates(t.agent_id)).toEqual([moveGateOperation(move.id)])
  expect(await unblockMove(s.tool, move.id, s.dst(), "topic_not_active")).toBe("cleared")
  expect(await serve()).toBe("active")
  expect(await s.openGates(t.agent_id)).toEqual([])

  // BEFORE the placement moved: the same archive blocks the activation by name, keeps the gate, and the owner can still withdraw.
  const u = await s.topic()
  const early = await s.request(u)
  await s.reach(early, "promoted")
  const sealed = await s.reread(early)
  expect(await requestTransition(s.tool, { operation: "arch-early", topic: u.id, kind: "archive", source: "tool", by: OWNER, route: null, evidence: {} })).toBe("ok")
  expect(await recordChannel(s.door, "arch-early", "applied", { prior: {} }, {})).toBe("applied")
  expect(await completeTransition(s.door, "arch-early", {}, null)).toBe("complete")
  expect(await activateMove(s.tool, early.id, s.dst(), 1, s.verificationOf(sealed, { generation: 1, staging: `move-${early.id}-g1` }))).toBe("topic-not-active")
  expect(await s.reread(early)).toMatchObject({ stage: "importing", block: { code: "topic_not_active", by: "store" } })
  expect(rows(await s.su`select machine from conversation where id = ${u.conversation_id}`)).toMatchObject([{ machine: "pi" }])
  expect(await s.openGates(u.agent_id)).toEqual(["arch-early", moveGateOperation(early.id)].sort())
  expect(await withdrawMove(s.tool, early.id, OWNER)).toBe("withdrawn")
  expect(await s.openGates(u.agent_id), "only the move's own gate went; the archive's stays").toEqual(["arch-early"])
})

test("the relocation note stays owed until evidence it was consumed: opening an attempt and a feed intent deliver nothing, a feed that never reached the engine leaves it pending, an acknowledgement is one atomic idempotent write, and a delivered note is never composed again", async () => {
  const s = await stage()
  await s.fleet()
  const t = await s.topic()
  const move = await s.request(t)
  await s.reach(move, "active")
  const on = { runner: DST.runner, incarnation: "dst-1", machine: DST.machine }
  const owed = await pendingNotesOf(s.tool, t.agent_id)
  expect(owed).toEqual([{ move: move.id, digest: s.NOTE.digest, conversation: t.conversation_id, attempt: null }])
  const carrying = [{ move: move.id, digest: owed[0].digest }]
  const words = [{ move: move.id, body: NOTE_BODY }]
  const recoveries = () => s.count("conversation_entry where conversation_id = $1 and kind = 'recovery'", t.conversation_id)

  // The first real input on the destination: the attempt opens, and that is all `claimed` means. The note is still owed.
  const first = await s.attempt(t, "n1", on)
  expect((await s.reread(move)).note_state).toBe("pending")
  // A note that is not the one the store owes refuses the feed, and the refusal commits nothing.
  await expect(markFeedIntent(s.tool, first.execution, "body of n1", "input", undefined, [{ move: move.id, digest: sha("another note") }])).rejects.toMatchObject({ name: "MoveNoteRefused", answer: "digest-mismatch" })
  await expect(markFeedIntent(s.tool, first.execution, "body of n1", "input", undefined, [{ move: "another-move", digest: owed[0].digest }])).rejects.toMatchObject({ name: "MoveNoteRefused", answer: "notes-mismatch" })
  expect(rows(await s.su`select state from execution where id = ${first.execution.id}`)).toMatchObject([{ state: "claimed" }])
  expect(await s.count("conversation_entry where kind = 'input'")).toBe(0)
  // The feed intent journals which attempt carries which note digest, and delivers nothing.
  await markFeedIntent(s.tool, first.execution, "body of n1", "input", undefined, carrying)
  expect(await s.reread(move)).toMatchObject({ note_state: "pending", note_attempt: first.execution.id })
  expect(await s.count("ledger_event where stream = 'execution' and kind = 'feed.intent' and detail -> 'notes' -> 0 ->> 'digest' = $1", owed[0].digest)).toBe(1)
  expect(await noteDelivered(s.tool, { execution: first.execution.id, notes: words })).toBe("not-received")
  expect(await recoveries()).toBe(0)

  // FeedNotWritten (or a fenced feed, or a crash before a byte): the attempt ends without the engine having the input. The note is still owed.
  await endAttempt(s.tool, { execution: first.execution.id, evidence: null, cause: "FeedNotWritten", delivered: false })
  expect((await s.su`select state from execution where id = ${first.execution.id}`)[0].state).toBe("failed")
  expect(await noteDelivered(s.tool, { execution: first.execution.id, notes: words })).toBe("not-received")
  expect(await pendingNotesOf(s.tool, t.agent_id)).toMatchObject([{ move: move.id, attempt: first.execution.id }])
  expect(await s.reread(move)).toMatchObject({ note_state: "pending" })
  expect(await recoveries()).toBe(0)

  // The next eligible input takes over the journal, and the engine's receipt is the evidence.
  await s.claim("n1", DST.runner)
  const second = await openExecution(s.tool, { row: { id: "n1", agent: t.agent_id }, conversation: first.conversation, runner: DST.runner, incarnation: "dst-1", digest: "d-n1-again", nativeSession: null })
  await markFeedIntent(s.tool, second, "body of n1", "input", undefined, carrying)
  expect((await s.reread(move)).note_attempt).toBe(second.id)
  expect(await noteDelivered(s.tool, { execution: second.id, notes: words })).toBe("not-received")
  await markProgress(s.tool, second.id, "received")
  expect(await noteDelivered(s.tool, { execution: first.execution.id, notes: words }), "an attempt that did not carry it").toBe("not-carrier")
  expect(await noteDelivered(s.tool, { execution: second.id, notes: [{ move: move.id, body: "" }] }), "a failed bookkeeping write keeps the note owed").toBe("note-invalid")
  expect(await noteDelivered(s.tool, { execution: second.id, notes: [{ move: move.id, body: "some other explanation" }] }), "no text but the declared one is written down as the note").toBe("digest-mismatch")
  expect(await noteDelivered(s.tool, { execution: second.id, notes: [{ move: "another-move", body: NOTE_BODY }] })).toBe("notes-mismatch")
  expect((await s.reread(move)).note_state).toBe("pending")
  expect(await recoveries()).toBe(0)
  expect(await noteDelivered(s.tool, { execution: second.id, notes: words })).toBe("delivered")
  expect(await s.reread(move)).toMatchObject({ note_state: "delivered" })
  expect(rows(await s.su`select source_id, body, execution_id from conversation_entry where conversation_id = ${t.conversation_id} and kind = 'recovery'`))
    .toEqual([{ source_id: `move-note:${move.id}`, body: NOTE_BODY, execution_id: second.id }])
  // A repeat after the acknowledgement (a crash after it, a second receipt seam) duplicates nothing.
  expect(await noteDelivered(s.tool, { execution: second.id, notes: words })).toBe("replay")
  await completeExecution(s.tool, { execution: second.id, runner: DST.runner, reply: "ok", fence: { incarnation: "dst-1" } })
  expect(await noteDelivered(s.tool, { execution: second.id, notes: words })).toBe("replay")
  expect(await recoveries()).toBe(1)
  expect(await pendingNotesOf(s.tool, t.agent_id)).toEqual([])

  // A delivered note is never composed again: the feed that would carry it is refused and commits nothing.
  const third = await s.attempt(t, "n2", on)
  await expect(markFeedIntent(s.tool, third.execution, "body of n2", "input", undefined, carrying)).rejects.toBeInstanceOf(MoveNoteRefused)
  expect(rows(await s.su`select state from execution where id = ${third.execution.id}`)).toMatchObject([{ state: "claimed" }])
  expect(await s.count("conversation_entry where source_id = 'n2'")).toBe(0)
  // An ordinary feed, with no note, is as it always was.
  await markFeedIntent(s.tool, third.execution, "body of n2")
  expect(await s.count("conversation_entry where source_id = 'n2' and kind = 'input'")).toBe(1)
})

test("a move that finished leaves no queued row lost and gives the source no way back: the queue reaches the destination whole and in order, and a source that planned on the old placement is refused by name", async () => {
  const s = await stage()
  await s.fleet()
  const t = await s.topic()
  await s.inbound("h1", t.agent_id)
  await s.inbound("h2", t.agent_id)
  // What the source planned with, before the move: its own conversation at generation 1.
  const planned = await conversationFor(s.tool, { row: { id: "h1", person: "p1", agent: t.agent_id, kind: "human" }, adapter: "synthetic", machine: SRC.machine })
  const move = await s.request(t)
  expect(await claimNext(s.tool, { runner: SRC.runner, agent: t.agent_id, leaseMs: 60_000, resumeOk: true }), "nothing starts during the move").toBeNull()
  expect(await s.count("inbound where agent = $1 and claimed_by is null and state not in ('answered', 'delivered')", t.agent_id)).toBe(2)
  await s.reach(move, "active")

  // The source cannot fall back: its conversation lookup and its opening are both refused by the placement.
  await expect(conversationFor(s.tool, { row: { id: "h1", person: "p1", agent: t.agent_id, kind: "human" }, adapter: "synthetic", machine: SRC.machine }))
    .rejects.toMatchObject({ refusal: "conversation elsewhere" })
  await s.claim("h2", SRC.runner)
  const fallback = await openExecution(s.tool, { row: { id: "h2", agent: t.agent_id }, conversation: planned, runner: SRC.runner, incarnation: "src-1", digest: "d", nativeSession: null })
    .then(() => null, (error: unknown) => error)
  expect(fallback).toBeInstanceOf(ExecutionNotOwned)
  expect((fallback as ExecutionNotOwned).reason).toBe("generation")
  await s.su`update inbound set claimed_by = null, claim_deadline = null where id = 'h2'`

  // The destination takes the oldest first; nothing was answered, discarded or replayed by the move.
  expect((await claimNext(s.tool, { runner: DST.runner, agent: t.agent_id, leaseMs: 60_000, resumeOk: true }))?.id).toBe("h1")
  expect(await s.count("inbound where agent = $1 and state in ('answered', 'delivered')", t.agent_id)).toBe(0)
  expect(await s.count("replay_hold")).toBe(0)
})

test("every step that advances the handoff stops under a block of ANY owner and keeps the gate, the original reason and the owner's way to clear it; repairs go on; an import failure under a foreign block keeps that reason and its own cleanup debt; only the store's own lifecycle block clears itself", async () => {
  const s = await stage()
  await s.fleet()
  const t = await s.topic()
  const move = await s.request(t)
  const gate = [moveGateOperation(move.id)]
  const blocked = async (stageName: MoveStage, by: string, code: string, gates: string[] = gate) => {
    const now = await s.reread(move)
    expect(now.stage).toBe(stageName)
    expect(now.block, "the original owner and reason").toMatchObject({ code, by })
    expect(await s.openGates(t.agent_id), "a block never releases the gate").toEqual(gates)
  }

  // AFTER THE SOURCE'S RELEASE: the hub names a conflict, and the destination cannot begin.
  await s.reach(move, "source_released")
  expect(await blockMove(s.hub, move.id, null, "registry_conflict", { why: "test" })).toBe("blocked")
  expect(await beginImport(s.tool, move.id, s.dst())).toMatchObject({ answer: "blocked" })
  await blocked("source_released", "hub", "registry_conflict")
  expect(await unblockMove(s.hub, move.id, null, "registry_conflict")).toBe("cleared")

  // DURING THE IMPORT: a resumed import and each step stop too, yet the failure report and the cleanup debt it leaves go on under someone else's block.
  const first = await beginImport(s.tool, move.id, s.dst())
  expect(first).toEqual({ answer: "intent", generation: 1, staging: `move-${move.id}-g1` })
  const sealed = await s.reread(move)
  const read = (generation: number, staging: string) => ({ manifest_digest: sealed.manifest!.digest, generation, staging, files: 2, bytes: sealed.manifest!.bytes })
  expect(await blockMove(s.hub, move.id, null, "dependency_unverified", { bash: 1 })).toBe("blocked")
  expect(await advanceImport(s.tool, move.id, s.dst(), 1, "verified", read(1, first.staging!))).toBe("blocked")
  expect(await beginImport(s.tool, move.id, s.dst()), "a resumed import goes no further under a block").toMatchObject({ answer: "blocked" })
  expect(await failImport(s.tool, move.id, s.dst(), 1, "import_verification_failed", { files: 1 })).toBe("failed")
  await blocked("source_released", "hub", "dependency_unverified")
  expect((await copiesOf(s.tool, move.id)).find(copy => copy.generation === 1), "the debt is recorded with the destination's own reason").toMatchObject({
    state: "cleanup_due", evidence: { failure: { code: "import_verification_failed" } } })
  expect(await unblockMove(s.hub, move.id, null, "dependency_unverified")).toBe("cleared")
  expect(await beginImport(s.tool, move.id, s.dst())).toMatchObject({ answer: "cleanup-pending", occupant: { move: move.id, generation: 1, state: "cleanup_due" } })
  expect(await copyRemoved(s.tool, move.id, s.dst(), 1, { staging: first.staging! })).toBe("removed")
  const second = await beginImport(s.tool, move.id, s.dst())
  expect(second).toEqual({ answer: "intent", generation: 2, staging: `move-${move.id}-g2` })
  expect(await advanceImport(s.tool, move.id, s.dst(), 2, "verified", read(2, second.staging!))).toBe("verified")

  // BEFORE THE PROMOTION: the steps of the promotion stop.
  expect(await blockMove(s.hub, move.id, null, "registry_conflict", {})).toBe("blocked")
  expect(await advanceImport(s.tool, move.id, s.dst(), 2, "promote_intent")).toBe("blocked")
  await blocked("importing", "hub", "registry_conflict")
  expect(await unblockMove(s.hub, move.id, null, "registry_conflict")).toBe("cleared")
  expect(await advanceImport(s.tool, move.id, s.dst(), 2, "promote_intent")).toBe("promote_intent")
  expect(await advanceImport(s.tool, move.id, s.dst(), 2, "promoted")).toBe("promoted")

  // AFTER THE PROMOTION: the source names a dependency, and the placement does not move.
  const verification = s.verificationOf(sealed, { generation: 2, staging: second.staging! })
  expect(await blockMove(s.tool, move.id, s.src(), "dependency_unverified", { mcp: 1 })).toBe("blocked")
  expect(await activateMove(s.tool, move.id, s.dst(), 2, verification)).toBe("blocked")
  await blocked("importing", "source", "dependency_unverified")
  expect(rows(await s.su`select machine, placement_generation from conversation where id = ${t.conversation_id}`)).toMatchObject([{ machine: "pi", placement_generation: 1 }])
  expect(await unblockMove(s.tool, move.id, s.src(), "dependency_unverified")).toBe("cleared")
  expect(await activateMove(s.tool, move.id, s.dst(), 2, verification)).toBe("activated")

  // AFTER THE ACTIVATION: the destination names a problem, and the hub's receipt does not go through.
  const activated = await s.reread(move)
  expect(await blockMove(s.tool, move.id, s.dst(), "profile_drift", { field: "model" })).toBe("blocked")
  expect(await recordRegistryWritten(s.hub, move.id, s.receiptOf(activated))).toBe("blocked")
  await blocked("activated", "dest", "profile_drift")
  expect(await unblockMove(s.tool, move.id, s.dst(), "profile_drift")).toBe("cleared")
  expect(await recordRegistryWritten(s.hub, move.id, s.receiptOf(activated))).toBe("written")

  // AFTER THE REGISTRY RECEIPT: serve stops under ANY block, even one that only uses the store's own word; a reconciliation does not stop.
  const at = await s.reread(move)
  const serve = () => serveMove(s.tool, move.id, s.dst(), s.loadedOf(at), s.NOTE, s.notice(move))
  expect(await blockMove(s.hub, move.id, null, "topic_not_active", { why: "a note of the hub that only looks like the store's" })).toBe("blocked")
  expect(await serve()).toBe("blocked")
  await blocked("registry_written", "hub", "topic_not_active")
  expect(await refreshRegistryReceipt(s.hub, move.id, s.receiptOf(at)), "a repair is not a step").toBe("unchanged")
  expect(await s.count("outbox where notice_key like 'topic-move:%'")).toBe(0)
  expect((await s.reread(move)).note_state).toBeNull()
  expect(await unblockMove(s.tool, move.id, s.dst(), "topic_not_active"), "it is the hub's").toBe("not-yours")
  expect(await unblockMove(s.hub, move.id, null, "topic_not_active")).toBe("cleared")

  // THE STORE'S OWN LIFETIME BLOCK clears itself once its condition is gone, and nothing else does.
  expect(await requestTransition(s.tool, { operation: "arch-g", topic: t.id, kind: "archive", source: "tool", by: OWNER, route: null, evidence: {} })).toBe("ok")
  expect(await recordChannel(s.door, "arch-g", "applied", { prior: {} }, {})).toBe("applied")
  expect(await completeTransition(s.door, "arch-g", {}, null)).toBe("complete")
  expect(await serve()).toBe("topic-not-active")
  await blocked("registry_written", "store", "topic_not_active", ["arch-g", ...gate].sort())
  expect(await serve()).toBe("topic-not-active")
  expect(await requestTransition(s.tool, { operation: "reopen-g", topic: t.id, kind: "reopen", source: "tool", by: OWNER, route: null, evidence: {} })).toBe("ok")
  expect(await completeTransition(s.door, "reopen-g", {}, null)).toBe("complete")
  expect(await s.openGates(t.agent_id)).toEqual(gate)
  expect(await serve(), "no explicit unblock: the next step re-reads the condition").toBe("active")
  expect(await s.reread(move)).toMatchObject({ stage: "active", block: null })
  expect(await s.openGates(t.agent_id)).toEqual([])
})

test("M1 withdrawn after its promotion and M2 to the same destination: M2 cannot import into the location while M1's copy is owed its removal, a cleaner with another identity releases nothing, a late M1 report cannot touch M2's copy, and the table itself allows one live claim per location", async () => {
  const s = await stage()
  await s.fleet()
  const t = await s.topic()
  const m1 = await s.request(t)
  const native = await s.nativeOf(m1)
  await s.reach(m1, "promoted")
  const m1copy = (await copiesOf(s.tool, m1.id)).find(copy => copy.kind === "dest_import")!
  expect(m1copy).toMatchObject({ state: "promoted", machine: "mac", conversation_id: t.conversation_id, native_session: native, placement_generation: 2 })
  expect(await withdrawMove(s.tool, m1.id, OWNER)).toBe("withdrawn")
  expect((await copiesOf(s.tool, m1.id)).map(copy => `${copy.kind}:${copy.state}`)).toEqual(["dest_import:cleanup_due", "source_session_retained:source_owned"])

  // M2 asks for the same destination BEFORE M1's cleanup was reported. Its source passes the claim it had from M1 (withdrawn: the source stayed the owner).
  const m2 = await s.request(t, "move-after-withdraw")
  await s.reach(m2, "source_released")
  expect((await copiesOf(s.tool, m1.id)).map(copy => `${copy.kind}:${copy.state}`)).toEqual(["dest_import:cleanup_due", "source_session_retained:superseded"])
  const refused = await beginImport(s.tool, m2.id, s.dst())
  expect(refused).toMatchObject({ answer: "cleanup-pending", generation: null, staging: null,
    occupant: { move: m1.id, kind: "dest_import", generation: 1, state: "cleanup_due", machine: "mac" } })
  expect((await copiesOf(s.tool, m2.id)).filter(copy => copy.kind === "dest_import"), "nothing of M2 was written at the location").toEqual([])
  expect((await s.reread(m2)).stage).toBe("source_released")
  expect(await copiesDueForCleanup(s.tool, DST.runner)).toMatchObject([{ move_id: m1.id, generation: 1, staging_id: m1copy.staging_id }])
  const live = (copies: { state: string; move_id: string }[]) => copies.filter(copy => !(NOT_LIVE_COPY_STATES as readonly string[]).includes(copy.state)).map(copy => copy.move_id)
  expect(live(await copiesAtLocation(s.tool, { conversation: t.conversation_id, machine: "mac" }))).toEqual([m1.id])

  // A cleaner that names M2's identity does not release M1's copy; M1's own report does, and only then M2 begins.
  expect(await copyRemoved(s.tool, m1.id, s.dst(), 1, { staging: `move-${m2.id}-g1` })).toBe("receipt-mismatch")
  expect((await copiesOf(s.tool, m1.id)).find(copy => copy.kind === "dest_import")!.state).toBe("cleanup_due")
  expect(await beginImport(s.tool, m2.id, s.dst())).toMatchObject({ answer: "cleanup-pending" })
  expect(await copyRemoved(s.tool, m1.id, s.dst(), 1, { staging: m1copy.staging_id, removed: "M1's own staging identity" })).toBe("removed")
  const begun = await beginImport(s.tool, m2.id, s.dst())
  expect(begun).toEqual({ answer: "intent", generation: 1, staging: `move-${m2.id}-g1` })
  const sealed = await s.reread(m2)
  expect(await advanceImport(s.tool, m2.id, s.dst(), 1, "verified", { manifest_digest: sealed.manifest!.digest, generation: 1, staging: begun.staging, files: 2, bytes: sealed.manifest!.bytes })).toBe("verified")
  expect(await advanceImport(s.tool, m2.id, s.dst(), 1, "promote_intent")).toBe("promote_intent")
  expect(await advanceImport(s.tool, m2.id, s.dst(), 1, "promoted")).toBe("promoted")

  // LATE: M1's report again, M1's identity against M2's copy, and M1's stale steps: none of it reaches M2's ownership.
  expect(await copyRemoved(s.tool, m1.id, s.dst(), 1, { staging: m1copy.staging_id })).toBe("replay")
  expect(await copyRemoved(s.tool, m2.id, s.dst(), 1, { staging: m1copy.staging_id })).toBe("not-due")
  expect(await copyRemoved(s.tool, m2.id, s.dst(), 1, { staging: begun.staging! }), "even its own identity: a promoted copy has no path to removal").toBe("not-due")
  expect(await advanceImport(s.tool, m1.id, s.dst(), 1, "promoted")).toBe("terminal")
  expect(await failImport(s.tool, m1.id, s.dst(), 1, "late_failure", {})).toBe("terminal")
  expect((await copiesOf(s.tool, m2.id)).find(copy => copy.kind === "dest_import")).toMatchObject({ state: "promoted", staging_id: begun.staging })
  expect(live(await copiesAtLocation(s.tool, { conversation: t.conversation_id, machine: "mac" }))).toEqual([m2.id])
  // The table refuses a second live claim whatever a routine forgot to ask.
  await expect(attempt(s.su`insert into move_copy (move_id, machine, kind, generation, state, staging_id, runner, incarnation, conversation_id, native_session, placement_generation)
    values (${m1.id}, 'mac', 'dest_import', 9, 'intent', 'move-rogue-g9', 'runner-mac', 'dst-1', ${t.conversation_id}, ${native}, 2)`)).rejects.toThrow(/move_copy_one_live_claim/)
})

test("A to B to A: the source copy the first move left behind is stale but still claims its location, the return is refused into it until it is retired and removed, the copy the current handoff and its withdrawal depend on is never retired, and no late report reaches the return's files", async () => {
  const s = await stage()
  await s.fleet()
  const t = await s.topic()
  const m1 = await s.request(t)
  await s.reach(m1, "active")
  const shape = async (move: { id: string }) => (await copiesOf(s.tool, move.id)).map(copy => `${copy.kind}@${copy.machine}:${copy.state}`)
  expect(await shape(m1)).toEqual(["dest_import@mac:active", "source_session_retained@pi:retained_stale"])

  // THE RETURN: the conversation is on mac; the move back asks pi, which still holds M1's stale source copy.
  const m2 = await s.request(t, "move-back", SRC)
  expect(m2).toMatchObject({ source_runner: DST.runner, source_machine: "mac", dest_runner: SRC.runner, dest_machine: "pi", source_generation: 2 })
  expect(m2.source_incarnation).toMatchObject({ known: true, incarnation: "dst-1", boot_id: BOOT_MAC_1, machine: "mac" })
  await s.reach(m2, "source_released")
  // The source's claim on mac passed from M1's imported copy to M2's retained one.
  expect(await shape(m1)).toEqual(["dest_import@mac:superseded", "source_session_retained@pi:retained_stale"])
  expect(await shape(m2)).toEqual(["source_session_retained@mac:retained"])
  const back = s.sideOf(m2, "dest")
  const out = s.sideOf(m2, "source")
  expect(await beginImport(s.tool, m2.id, back)).toMatchObject({ answer: "copy-occupied",
    occupant: { move: m1.id, kind: "source_session_retained", generation: 1, state: "retained_stale", machine: "pi" } })

  // What may be retired, and by whom. The copy this move's own handoff and its withdrawal depend on is never retirable.
  expect(await retireCopy(s.tool, m2.id, back, { move: m2.id, kind: "source_session_retained", generation: 1 }), "M2's own source copy").toBe("needed")
  expect(await retireCopy(s.tool, m2.id, out, { move: m1.id, kind: "source_session_retained", generation: 1 }), "the source is not the destination").toBe("not-destination")
  expect(await retireCopy(s.tool, m2.id, back, { move: m1.id, kind: "dest_import", generation: 1 }), "a copy on the machine the conversation is on").toBe("unknown-copy")
  expect(await retireCopy(s.tool, m2.id, back, { move: "no-such-move", kind: "source_session_retained", generation: 1 })).toBe("unknown-copy")
  expect(await shape(m2)).toEqual(["source_session_retained@mac:retained"])
  expect(await shape(m1)).toEqual(["dest_import@mac:superseded", "source_session_retained@pi:retained_stale"])

  // Retired: recorded as due, not removed; the return still cannot begin until the owner reports the removal with the copy's own identity.
  expect(await retireCopy(s.tool, m2.id, back, { move: m1.id, kind: "source_session_retained", generation: 1 })).toBe("retired")
  expect(await retireCopy(s.tool, m2.id, back, { move: m1.id, kind: "source_session_retained", generation: 1 })).toBe("replay")
  expect((await copiesOf(s.tool, m1.id)).find(copy => copy.kind === "source_session_retained")).toMatchObject({ state: "cleanup_due", evidence: { retired: { by_move: m2.id } } })
  expect(await beginImport(s.tool, m2.id, back)).toMatchObject({ answer: "cleanup-pending", occupant: { move: m1.id, state: "cleanup_due", kind: "source_session_retained" } })
  expect(await copiesDueForCleanup(s.tool, SRC.runner)).toMatchObject([{ move_id: m1.id, kind: "source_session_retained", staging_id: `source-${m1.id}` }])
  expect(await copyRemoved(s.tool, m1.id, back, 1, { staging: `source-${m1.id}` }), "by default an import; this owner is not the destination of M1").toBe("not-owner")
  expect(await copyRemoved(s.tool, m1.id, back, 1, { staging: "source-elsewhere" }, "source_session_retained")).toBe("receipt-mismatch")
  expect(await copyRemoved(s.tool, m1.id, back, 1, { staging: `source-${m1.id}`, removed: "the stale source copy" }, "source_session_retained")).toBe("removed")

  // Now the return goes through, and its ownership is M2's.
  const imported = await s.importIt(m2)
  expect(imported).toMatchObject({ generation: 1, staging: `move-${m2.id}-g1` })
  expect(await activateMove(s.tool, m2.id, back, 1, s.verificationOf(await s.reread(m2), imported))).toBe("activated")
  expect(await recordRegistryWritten(s.hub, m2.id, s.receiptOf(await s.reread(m2)))).toBe("written")
  expect(await serveMove(s.tool, m2.id, back, s.loadedOf(await s.reread(m2)), s.noteOf("moved back from mac to pi"), s.notice(m2))).toBe("active")
  expect(await shape(m2)).toEqual(["dest_import@pi:active", "source_session_retained@mac:retained_stale"])
  expect(await shape(m1)).toEqual(["dest_import@mac:superseded", "source_session_retained@pi:removed"])
  const live = (await copiesAtLocation(s.tool, { conversation: t.conversation_id, machine: "pi" })).filter(copy => !(NOT_LIVE_COPY_STATES as readonly string[]).includes(copy.state))
  expect(live.map(copy => copy.move_id)).toEqual([m2.id])
  // LATE: M1's report again and M1's identity against M2's files reach nothing.
  expect(await copyRemoved(s.tool, m1.id, back, 1, { staging: `source-${m1.id}` }, "source_session_retained")).toBe("replay")
  expect(await copyRemoved(s.tool, m2.id, back, 1, { staging: `source-${m1.id}` })).toBe("not-due")
  expect((await copiesOf(s.tool, m2.id)).find(copy => copy.kind === "dest_import")).toMatchObject({ state: "active", staging_id: `move-${m2.id}-g1` })
})

test("the native session changes between two moves and the location does not (the session directory is the conversation's, not the native session's): M1's withdrawn copy still blocks M2 on the same machine, a stale cleanup identity cannot reach M2, and the table allows one live claim whatever native session a row records", async () => {
  const s = await stage()
  await s.fleet()
  const t = await s.topic()
  const m1 = await s.request(t)
  const first = await s.nativeOf(m1)
  await s.reach(m1, "promoted")
  const m1copy = (await copiesOf(s.tool, m1.id)).find(copy => copy.kind === "dest_import")!
  expect(await withdrawMove(s.tool, m1.id, OWNER)).toBe("withdrawn")
  expect((await copiesOf(s.tool, m1.id)).map(copy => `${copy.kind}:${copy.state}`)).toEqual(["dest_import:cleanup_due", "source_session_retained:source_owned"])

  // The engine reports another session id on the next turn: it becomes the conversation's locator, and the directory on every machine stays where it was.
  const rotated = `rotated-${first}`
  expect(await verifyNative(s.tool, t.conversation_id, first, rotated)).toBe("mismatch")
  expect(await s.nativeOf(m1)).toBe(rotated)
  const m2 = await s.request(t, "move-after-rotation")
  await s.reach(m2, "source_released", { started: true })
  const live = (copies: { state: string; move_id: string }[]) => copies.filter(copy => !(NOT_LIVE_COPY_STATES as readonly string[]).includes(copy.state)).map(copy => copy.move_id)
  const rogue = (native: string) => s.su`insert into move_copy (move_id, machine, kind, generation, state, staging_id, runner, incarnation, conversation_id, native_session, placement_generation)
    values (${m1.id}, 'mac', 'dest_import', 9, 'intent', 'move-rogue-g9', 'runner-mac', 'dst-1', ${t.conversation_id}, ${native}, 2)`

  // M1's copy recorded the first session; M2 is on the rotated one; the claim on the location is the same.
  expect(await beginImport(s.tool, m2.id, s.dst())).toMatchObject({ answer: "cleanup-pending", generation: null, staging: null,
    occupant: { move: m1.id, kind: "dest_import", generation: 1, state: "cleanup_due", machine: "mac" } })
  expect((await copiesOf(s.tool, m2.id)).filter(copy => copy.kind === "dest_import"), "nothing of M2 was written at the location").toEqual([])
  expect(live(await copiesAtLocation(s.tool, { conversation: t.conversation_id, machine: "mac" }))).toEqual([m1.id])
  await expect(attempt(rogue(rotated)), "a live claim on the same location is refused even with another native session").rejects.toThrow(/move_copy_one_live_claim/)

  // A cleaner naming M2's identity releases nothing; M1's own report does, and only then M2 begins.
  expect(await copyRemoved(s.tool, m1.id, s.dst(), 1, { staging: `move-${m2.id}-g1` })).toBe("receipt-mismatch")
  expect(await beginImport(s.tool, m2.id, s.dst())).toMatchObject({ answer: "cleanup-pending" })
  expect(await copyRemoved(s.tool, m1.id, s.dst(), 1, { staging: m1copy.staging_id, removed: "M1's own staging identity" })).toBe("removed")
  const imported = await s.importIt(m2, { started: true })
  expect(imported).toMatchObject({ generation: 1, staging: `move-${m2.id}-g1` })

  // LATE: M1's identity against M2's copy, and M1's report again, reach nothing; the rows keep their own native evidence.
  expect(await copyRemoved(s.tool, m2.id, s.dst(), 1, { staging: m1copy.staging_id })).toBe("not-due")
  expect(await copyRemoved(s.tool, m1.id, s.dst(), 1, { staging: m1copy.staging_id })).toBe("replay")
  expect((await copiesOf(s.tool, m2.id)).find(copy => copy.kind === "dest_import")).toMatchObject({ state: "promoted", staging_id: imported.staging, native_session: rotated })
  expect((await copiesOf(s.tool, m1.id)).find(copy => copy.kind === "dest_import")).toMatchObject({ state: "removed", native_session: first })
  expect(live(await copiesAtLocation(s.tool, { conversation: t.conversation_id, machine: "mac" }))).toEqual([m2.id])
  await expect(attempt(rogue("another-native-session"))).rejects.toThrow(/move_copy_one_live_claim/)
})

test("A to B to A with the native session minted anew while the conversation is on B: the first move's stale source copy on A is still the occupant of the return's location, it can be retired by the fenced call and removed, the source copy the current move depends on is never retirable, and then the return imports", async () => {
  const s = await stage()
  await s.fleet()
  const t = await s.topic()
  const m1 = await s.request(t)
  const first = await s.nativeOf(m1)
  await s.reach(m1, "active")
  const shape = async (move: { id: string }) => (await copiesOf(s.tool, move.id)).map(copy => `${copy.kind}@${copy.machine}:${copy.state}`)
  expect(await shape(m1)).toEqual(["dest_import@mac:active", "source_session_retained@pi:retained_stale"])
  const live = (copies: { state: string; move_id: string }[]) => copies.filter(copy => !(NOT_LIVE_COPY_STATES as readonly string[]).includes(copy.state)).map(copy => copy.move_id)

  // A launch nobody acknowledged is replaced by a fresh session id: the conversation's native session is no longer the one M1's copy on pi recorded.
  await markLaunched(s.tool, t.conversation_id)
  const minted = await mintNativeSession(s.tool, t.conversation_id)
  expect(minted).toMatchObject({ replaced: first })
  expect(await s.nativeOf(m1)).toBe(minted!.id)

  const m2 = await s.request(t, "move-back", SRC)
  await s.reach(m2, "source_released")
  const back = s.sideOf(m2, "dest")
  const out = s.sideOf(m2, "source")
  expect((await copiesOf(s.tool, m1.id)).find(copy => copy.kind === "source_session_retained")).toMatchObject({ state: "retained_stale", native_session: first })
  expect(await beginImport(s.tool, m2.id, back)).toMatchObject({ answer: "copy-occupied",
    occupant: { move: m1.id, kind: "source_session_retained", generation: 1, state: "retained_stale", machine: "pi" } })
  expect(live(await copiesAtLocation(s.tool, { conversation: t.conversation_id, machine: "pi" }))).toEqual([m1.id])

  // What may and may not be retired is the same as without the change: the move's own source copy is needed, the source is not the destination.
  expect(await retireCopy(s.tool, m2.id, back, { move: m2.id, kind: "source_session_retained", generation: 1 }), "M2's own source copy").toBe("needed")
  expect(await retireCopy(s.tool, m2.id, out, { move: m1.id, kind: "source_session_retained", generation: 1 })).toBe("not-destination")
  expect(await shape(m2)).toEqual(["source_session_retained@mac:retained"])
  expect(await retireCopy(s.tool, m2.id, back, { move: m1.id, kind: "source_session_retained", generation: 1 })).toBe("retired")
  expect(await retireCopy(s.tool, m2.id, back, { move: m1.id, kind: "source_session_retained", generation: 1 })).toBe("replay")
  expect(await beginImport(s.tool, m2.id, back)).toMatchObject({ answer: "cleanup-pending", occupant: { move: m1.id, state: "cleanup_due", kind: "source_session_retained" } })
  expect(await copyRemoved(s.tool, m1.id, back, 1, { staging: `source-${m1.id}`, removed: "the stale source copy" }, "source_session_retained")).toBe("removed")
  expect(await shape(m2)).toEqual(["source_session_retained@mac:retained"])

  const imported = await s.importIt(m2)
  expect(imported).toMatchObject({ generation: 1, staging: `move-${m2.id}-g1` })
  expect(await shape(m2)).toEqual(["dest_import@pi:promoted", "source_session_retained@mac:retained"])
  expect(live(await copiesAtLocation(s.tool, { conversation: t.conversation_id, machine: "pi" }))).toEqual([m2.id])
})

test("two completed moves with no real input between them owe two notes: the first real input carries the whole ordered chain, one acknowledgement on receipt covers exactly those and once, a refused or unconfirmed feed keeps every note owed, and a partial, reordered or other text is refused", async () => {
  const s = await stage()
  await s.fleet()
  const LAB = { runner: "runner-lab", machine: "lab" }
  await s.register(LAB, "lab-1")
  const t = await s.topic()
  const first = "moved from pi to mac: the root is /srv/a now"
  const last = "moved from mac to lab: the root is /data/a now"
  const m1 = await s.request(t)
  await s.reach(m1, "active", { note: first })
  const m2 = await s.request(t, "move-lab", LAB)
  await s.reach(m2, "active", { note: last })

  const owed = await pendingNotesOf(s.tool, t.agent_id)
  expect(owed.map(note => note.move), "oldest first").toEqual([m1.id, m2.id])
  expect(owed.map(note => note.digest)).toEqual([sha(first), sha(last)])
  const chain = owed.map(note => ({ move: note.move, digest: note.digest }))
  const words = [{ move: m1.id, body: first }, { move: m2.id, body: last }]
  const on = { runner: LAB.runner, incarnation: "lab-1", machine: LAB.machine }
  const recoveries = async () => rows(await s.su`select source_id, body, execution_id from conversation_entry where conversation_id = ${t.conversation_id} and kind = 'recovery' order by seq`)
  const states = async () => (await Promise.all([m1, m2].map(move => s.reread(move)))).map(move => move.note_state)
  const feed = (execution: Parameters<typeof markFeedIntent>[1], list: { move: string; digest: string }[]) => markFeedIntent(s.tool, execution, "body of n1", "input", undefined, list)

  // The carrier is fenced by the conversation's CURRENT placement and the chain of moves, not by the first move's obsolete generation; what it is given is the whole chain.
  const one = await s.attempt(t, "n1", on)
  await expect(feed(one.execution, [chain[1]]), "the newest alone would drop the first machine and root change").rejects.toMatchObject({ name: "MoveNoteRefused", answer: "notes-mismatch" })
  await expect(feed(one.execution, [chain[0]]), "the oldest alone").rejects.toMatchObject({ answer: "notes-mismatch" })
  await expect(feed(one.execution, [chain[1], chain[0]]), "out of order").rejects.toMatchObject({ answer: "notes-mismatch" })
  await expect(feed(one.execution, [chain[0], { ...chain[1], digest: sha("other") }])).rejects.toMatchObject({ answer: "digest-mismatch" })
  expect(rows(await s.su`select state from execution where id = ${one.execution.id}`)).toMatchObject([{ state: "claimed" }])
  expect(await s.count("conversation_entry where kind = 'input'")).toBe(0)
  expect(await states()).toEqual(["pending", "pending"])
  await feed(one.execution, chain)
  expect((await pendingNotesOf(s.tool, t.agent_id)).map(note => note.attempt)).toEqual([one.execution.id, one.execution.id])
  expect(await noteDelivered(s.tool, { execution: one.execution.id, notes: words })).toBe("not-received")

  // The feed never reached the engine: every note is still owed and nothing was written down.
  await endAttempt(s.tool, { execution: one.execution.id, evidence: null, cause: "FeedNotWritten", delivered: false })
  expect(await noteDelivered(s.tool, { execution: one.execution.id, notes: words })).toBe("not-received")
  expect(await states()).toEqual(["pending", "pending"])
  expect(await recoveries()).toEqual([])
  expect(await s.count("replay_hold")).toBe(0)

  // The next attempt takes over the journal; the engine's receipt is the evidence, and only the complete set, in its own words, is acknowledged.
  await s.claim("n1", LAB.runner)
  const two = await openExecution(s.tool, { row: { id: "n1", agent: t.agent_id }, conversation: one.conversation, runner: LAB.runner, incarnation: "lab-1", digest: "d-n1-again", nativeSession: null })
  await feed(two, chain)
  await markProgress(s.tool, two.id, "received")
  expect(await noteDelivered(s.tool, { execution: one.execution.id, notes: words }), "an attempt that did not carry them").toBe("not-carrier")
  expect(await noteDelivered(s.tool, { execution: two.id, notes: [words[0]] }), "a partial acknowledgement of a chain is not made").toBe("notes-mismatch")
  expect(await noteDelivered(s.tool, { execution: two.id, notes: [words[1], words[0]] })).toBe("notes-mismatch")
  expect(await noteDelivered(s.tool, { execution: two.id, notes: [words[0], { move: m2.id, body: "moved, the root is /elsewhere" }] }), "the digest binds the words").toBe("digest-mismatch")
  expect(await noteDelivered(s.tool, { execution: two.id, notes: [words[0], { move: m2.id, body: "" }] })).toBe("note-invalid")
  expect(await states()).toEqual(["pending", "pending"])
  expect(await recoveries()).toEqual([])
  expect(await noteDelivered(s.tool, { execution: two.id, notes: words })).toBe("delivered")
  expect(await states()).toEqual(["delivered", "delivered"])
  expect(await recoveries()).toEqual([
    { source_id: `move-note:${m1.id}`, body: first, execution_id: two.id },
    { source_id: `move-note:${m2.id}`, body: last, execution_id: two.id },
  ])
  // Once: a repeat (a crash after the acknowledgement, the completed-result seam) duplicates nothing, and the next input does not carry them again.
  expect(await noteDelivered(s.tool, { execution: two.id, notes: words })).toBe("replay")
  await completeExecution(s.tool, { execution: two.id, runner: LAB.runner, reply: "ok", fence: { incarnation: "lab-1" } })
  expect(await noteDelivered(s.tool, { execution: two.id, notes: words })).toBe("replay")
  expect(await pendingNotesOf(s.tool, t.agent_id)).toEqual([])
  const later = await s.attempt(t, "n2", on)
  await expect(feed(later.execution, chain)).rejects.toBeInstanceOf(MoveNoteRefused)
  expect((await recoveries()).length).toBe(2)
})

test("the migration is numbered 016: an upgraded store carries the same objects, checks, fences and grants as a fresh one, applying it again changes nothing, the fresh schema carries it byte for byte, and no role writes a move table", async () => {
  const upgraded = await rolloutDatabase(cluster, true)
  const fresh = await rolloutDatabase(cluster)
  track(upgraded.sql)
  track(fresh.sql)
  const applier = () => { const store = upgraded.store(); track(store.sql); return store }
  await migrate(applier())
  await migrate(applier())
  const tables = ["topic_move", "move_blob", "move_copy"]
  const read = async (q: any) => ({
    functions: Array.from(await q`select p.proname, pg_get_function_identity_arguments(p.oid) as args, r.rolname as owner, p.prosecdef, p.proconfig::text as config, p.prosrc
      from pg_proc p join pg_roles r on r.oid = p.proowner
      where p.proname like 'hub_move%' or p.proname in ('hub_guard_topic_move', 'hub_guard_move_blob', 'hub_notify_move', 'hub_guard_inbound_claim')
      order by p.proname`),
    columns: Array.from(await q`select table_name, column_name, data_type, is_nullable, column_default from information_schema.columns
      where table_name in ('topic_move', 'move_blob', 'move_copy') order by table_name, ordinal_position`),
    indexes: Array.from(await q`select indexname, indexdef from pg_indexes where tablename in ('topic_move', 'move_blob', 'move_copy', 'hub_protocol') order by indexname`),
    checks: Array.from(await q`select conrelid::regclass::text as t, conname, pg_get_constraintdef(oid) as d from pg_constraint
      where conrelid in ('topic_move'::regclass, 'move_blob'::regclass, 'move_copy'::regclass, 'hub_protocol'::regclass) order by conrelid::regclass::text, conname`),
    triggers: Array.from(await q`select t.tgname, pg_get_triggerdef(t.oid) as d from pg_trigger t
      where t.tgname in ('topic_move_rules', 'topic_move_notify', 'move_blob_limits', 'replay_hold_move_failure', 'inbound_claim_honours_holds') order by t.tgname`),
    tableGrants: Array.from(await q`select table_name, grantee, privilege_type from information_schema.role_table_grants
      where table_name in ('topic_move', 'move_blob', 'move_copy') and grantee in ('hub_door', 'hub_runner', 'hub_hub', 'hub_agent') order by table_name, grantee, privilege_type`),
    routineGrants: Array.from(await q`select routine_name, grantee from information_schema.routine_privileges
      where routine_name like 'hub_move%' and grantee in ('hub_door', 'hub_runner', 'hub_hub', 'hub_agent') order by routine_name, grantee`),
  })
  const a = await read(fresh.sql)
  const b = await read(upgraded.sql)
  expect(b).toEqual(a)
  expect(a.functions.length).toBeGreaterThan(30)
  // The table itself allows ONE live claim on a physical location (conversation, machine: the session directory has no native-session part), whatever a routine forgot to ask.
  expect((a.indexes as any[]).map(one => one.indexname)).toContain("move_copy_one_live_claim")
  expect((a.indexes as any[]).find(one => one.indexname === "move_copy_one_live_claim").indexdef).toContain("UNIQUE")
  expect((a.indexes as any[]).find(one => one.indexname === "move_copy_one_live_claim").indexdef).not.toContain("native_session")
  expect(a.triggers.map((row: any) => row.tgname)).toEqual(["inbound_claim_honours_holds", "move_blob_limits", "replay_hold_move_failure", "topic_move_notify", "topic_move_rules"])
  // The protocol table allows 4 under the one name it had, and the claim guard keeps its council rule at 3 and compares the global protocol at 4.
  const protocol = (a.checks as any[]).filter(one => one.t === "hub_protocol" && one.d.includes("runner_protocol"))
  expect(protocol.map(one => one.conname)).toEqual(["hub_protocol_runner_protocol_check"])
  expect(protocol[0].d).toContain("4")
  const guard = (a.functions as any[]).find(one => one.proname === "hub_guard_inbound_claim").prosrc as string
  expect(guard).toContain("said < 3")
  expect(guard).toContain("said < 4")
  // Every routine a role can call is a definer with a pinned search path; the helpers nobody is granted are never callable by a role.
  const granted = new Set((a.routineGrants as any[]).map(row => row.routine_name))
  for (const one of a.functions as any[]) {
    if (!granted.has(one.proname)) continue
    expect(one.prosecdef, `${one.proname} is a definer`).toBe(true)
    expect(one.config, `${one.proname} pins its search path`).toContain("search_path=pg_catalog, public")
  }
  // Nobody writes a move table but the routines, nobody but the destination runner reads the bytes, and the model's login has nothing here.
  expect((a.tableGrants as any[]).filter(row => row.privilege_type !== "SELECT"), "nobody writes a move table directly").toEqual([])
  expect((a.tableGrants as any[]).filter(row => row.table_name === "move_blob").map(row => row.grantee)).toEqual(["hub_runner"])
  expect(new Set((a.tableGrants as any[]).filter(row => row.table_name !== "move_blob").map(row => row.grantee))).toEqual(new Set(["hub_door", "hub_runner", "hub_hub"]))
  expect((a.routineGrants as any[]).some(row => row.grantee === "hub_agent")).toBe(false)
  expect((a.routineGrants as any[]).filter(row => row.routine_name.startsWith("hub_move_registry_")).map(row => row.grantee)).toEqual(["hub_hub", "hub_hub"])
  // The version set is whole, and the fresh schema carries the step byte for byte.
  const versions = (await upgraded.sql`select version from schema_version order by version`).map((row: any) => Number(row.version))
  expect(versions).toEqual(MIGRATION_FILES.map(([version]) => version))
  expect(versions).toEqual((await fresh.sql`select version from schema_version order by version`).map((row: any) => Number(row.version)))
  expect(MIGRATION_FILES).toContainEqual([16, "016-topic-move.sql"])
  const migration = readFileSync(hubPath("src/store/migrations/016-topic-move.sql"), "utf8")
  expect(readFileSync(hubPath("src/schema.sql"), "utf8").includes(`${migration}\ninsert into schema_version (version) values (16);\n`)).toBe(true)
  // Landing it touched no row that was there, and activated nothing.
  expect(Number((await upgraded.sql`select count(*)::int as n from inbound`)[0].n)).toBe(1)
  expect(Number((await upgraded.sql`select count(*)::int as n from topic_move`)[0].n)).toBe(0)
  expect(tables.length).toBe(3)
  expect(Number((await upgraded.sql`select runner_protocol from hub_protocol`)[0].runner_protocol)).toBe(1)
})
