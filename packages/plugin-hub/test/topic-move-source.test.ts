// The SOURCE RUNNER's half of moving a topic master (IMP-231): the drain, what it asserts and what it refuses to, and how an attempt the
// move refused is handed back. `src/runner/move.ts` over the accepted store (migration 016) on a real Postgres cluster.
//
// WHAT THIS PROVES: the order intent-then-close (the store holds the intent when the child is closed), that a child is shown gone by the
// PROCESS TABLE (a real child that leads a group of its own, a real survivor, a real predecessor's group) and by nothing the test scripts,
// that nothing is certified for a lifetime nobody can answer for (a survivor, a predecessor without an intent, an unknown baseline, an
// unknown or another boot), that an intent that could not be written closes nothing, and which foreign blocks survive. THE SET: an incarnation's
// intents are evidence only as a complete, sealed set (a prefix of them, a refused intent and an older unproven child never let the drain be
// certified, and nothing is closed or submitted for a part of a set; an intent keeps the WHOLE union of observed processes, or is refused as too
// large and never shortened; the set is never sealed over a child that is open or closing, a process the close itself observes is durable in a
// final intent before the seal, and a crash or a refusal before that leaves the set unsealed), a hold that existed at the request is untouched by the drain, and the
// holder fixture ends only what it made. WHAT IT DOES NOT:
// that the runner's loop calls any of this at the right moment (`topic-move-source-runner.test.ts`), the notifications and fences
// (`topic-move-source-watch.test.ts`), or anything about export, release, the destination, the registry or native portability: a started
// conversation's portability is not a thing this file has, and `drained` is not "the move can complete".
//
// A "predecessor" here is a real process this test owns: its group is looked up in the process table of THIS machine and is never signalled
// by the code under test, which the test checks by finding it alive after the look.

import { afterAll, afterEach, beforeAll, expect, test } from "bun:test"
import { startCluster, until, type Cluster } from "./helpers/cluster.ts"
import { BOOT_1, BOOT_2, OWNER, SRC, drainEvidence, moveStage, sha, type MoveFixture } from "./helpers/move-store-stage.ts"
import { childGone, createScriptedAdapter, spawnHolder, type ScriptedAdapter } from "./helpers/scripted-adapter.ts"
import { createLedger, drainSource, handBackFeed, lookAt, settleSet, type ChildLedger, type ChildRecord, type DrainWorld } from "../src/runner/move.ts"
import { endAttempt, requireSchema, type Here } from "../src/runner/execution.ts"
import type { ExitEvidence } from "../src/adapters/types.ts"
import { MoveGated, MoveNoteRefused, activateProtocol, markFeedIntent, provenUnfedEnd } from "../src/store/conversations.ts"
import { blockMove, continueMove, readMove, recordDrainDone, recordDrainIntent, sealDrainIntents, withdrawMove, type DrainIntent } from "../src/store/moves.ts"
import { groupPresence, presence } from "../src/os/tree.ts"
import type { TopicRow } from "../src/store/topics.ts"

let cluster: Cluster
const mine: { close(): Promise<void> }[] = []
const track = <T extends { close(): Promise<void> }>(sql: T): T => { mine.push(sql); return sql }
const reapers: ScriptedAdapter[] = []
beforeAll(async () => { cluster = await startCluster() })
afterEach(async () => {
  for (const one of reapers.splice(0)) one.reap()
  for (const one of mine.splice(0)) await one.close().catch(() => {})
})
afterAll(async () => { await cluster?.stop() })

const stage = () => moveStage(cluster, track)
/** Rows as plain objects, so that `toMatchObject` and `toEqual` compare what the statement returned and not the client's row list. */
const rows = (result: unknown) => Array.from(result as Record<string, unknown>[]).map(row => ({ ...row }))
const GONE: ExitEvidence = { confirmed: true, leader: "exited", descendants: "none", pids: [], survivors: [], via: "test" }

interface Said { kind: string; detail: Record<string, unknown> }

/**
 * The drain's view of a process, as the runner builds it, with the ledger real and the close the runner's (`closeChild`): the record is marked
 * closing, the session is closed and asked what it can prove, and the ledger is told. `beforeClose` runs at the instant of the close.
 */
function worldFor(s: MoveFixture, over: {
  incarnation?: string; here?: Here; ledger?: ChildLedger; fenced?: boolean; quiet?: boolean; beforeClose?: (record: ChildRecord) => Promise<void>
  /** Runs right after the close, with the ledger told: a throw here is the runner dying at that instant. */
  afterClose?: (record: ChildRecord) => Promise<void>
  /** Runs after each diary line is said (the line follows the store's answer): a throw here is the runner dying at that instant. */
  onSay?: (kind: string, detail: Record<string, unknown>) => Promise<void>
} = {}) {
  const ledger = over.ledger ?? createLedger()
  const said: Said[] = []
  const closed: string[] = []
  const world: DrainWorld = {
    store: s.tool, runner: SRC.runner, incarnation: over.incarnation ?? "src-1", here: over.here ?? { machine: SRC.machine, boot: BOOT_1 }, ledger,
    fenced: () => over.fenced !== false,
    quiet: () => over.quiet !== false,
    async close(record) {
      await over.beforeClose?.(record)
      closed.push(record.id)
      await closeLikeTheRunner(ledger, record)
      await over.afterClose?.(record)
    },
    async say(kind, detail) { said.push({ kind, detail }); await over.onSay?.(kind, detail) },
  }
  return { world, ledger, said, closed }
}

/**
 * An owned process the child's session reports only AT THE CLOSE, as production does: `closeChild` observes the session
 * (`children.closing`) before it closes it, and the adapter's exit evidence reports the same process after. It is not in any document
 * written before the close. Nothing here signals it; the test that owns it ends it through its own handle.
 */
function reportsAtClose(record: ChildRecord, owned: number[]): void {
  const session = record.session as unknown as { processes?: () => number[]; exitEvidence?: () => Promise<ExitEvidence> }
  const processes = session.processes!.bind(session)
  const exitEvidence = session.exitEvidence!.bind(session)
  session.processes = () => [...processes(), ...owned]
  session.exitEvidence = async () => {
    const base = await exitEvidence()
    const present = owned.filter(one => presence(one) === "present")
    return { ...base, pids: [...base.pids, ...owned], survivors: [...base.survivors, ...present], confirmed: base.confirmed && present.length === 0,
      descendants: present.length > 0 ? "survivors" : base.descendants, basis: present.length > 0 ? "observed-tree" : base.basis }
  }
}

async function closeLikeTheRunner(ledger: ChildLedger, record: ChildRecord): Promise<void> {
  const session = record.session!
  ledger.closing(record)
  await session.close()
  const exit = session.exitEvidence ? await session.exitEvidence() : null
  ledger.closed(record, exit, null)
}

/** A child of the topic's agent, started the way the runner's `spawn` does: the record is made before the adapter is asked. */
async function startChild(s: MoveFixture, t: TopicRow, ledger: ChildLedger, scripted: ScriptedAdapter): Promise<ChildRecord> {
  const [row] = await s.su`select native_session, placement_generation from conversation where id = ${t.conversation_id}`
  const record = ledger.starting(t.agent_id, { conversation: t.conversation_id, nativeSession: String(row.native_session), placement: Number(row.placement_generation) })
  const session = await scripted.adapter.start({ preset: {} as never, sessionId: null })
  ledger.started(record, session)
  return record
}
const adapterWithGroups = (options: { survivor?: boolean | number[] } = {}) => {
  const scripted = createScriptedAdapter({ child: true, group: true, ...options })
  reapers.push(scripted)
  return scripted
}
/** A real process group that is gone: started, ended through its handle and waited for. */
async function deadGroup() {
  const holder = spawnHolder({ group: true })
  holder.kill()
  await holder.exited
  return holder
}

test("a runner of this build refuses a store without migration 16 by name, before it activates a protocol, registers an incarnation or watches anything", async () => {
  const s = await stage()
  await requireSchema(s.tool)
  // The routines a drain asserts through are the schema's own: one missing is a store that is behind, whatever else it has.
  await s.su`drop function hub_move_drain_done(text, text, text, jsonb)`
  await expect(requireSchema(s.tool)).rejects.toThrow(/schema-behind: apply migration 16/)
  expect(Number((await s.su`select count(*)::int as n from runner_incarnation`)[0].n), "nothing was registered").toBe(0)
})

test("an idle child is closed only after its intent is durable, and the move is drained on the very group the intent named", async () => {
  const s = await stage()
  await s.fleet()
  const t = await s.topic()
  const scripted = adapterWithGroups()
  const move = await s.request(t)
  let atClose: unknown = null
  const { world, ledger, said, closed } = worldFor(s, {
    beforeClose: async (record) => {
      // THE INTENT IS IN THE STORE WHEN THE CHILD IS CLOSED, and the child is still there.
      const standing = (await readMove(s.tool, move.id))!
      atClose = { intents: standing.drain_intents.map(one => one.id), alive: !childGone(record.leader!) }
      expect(standing.drain_intents[0]).toMatchObject({ id: record.id, incarnation: "src-1", boot_id: BOOT_1, machine: "pi", group: record.group, leader: record.leader })
    },
  })
  const record = await startChild(s, t, ledger, scripted)
  expect(record.group, "the child leads a group of its own, read back from the process table").toBe(record.leader)

  const step = await drainSource(world, move.id)
  expect(step).toMatchObject({ state: "drained", owed: null })
  expect(atClose).toEqual({ intents: [record.id], alive: true })
  expect(closed).toEqual([record.id])
  const after = (await readMove(s.tool, move.id))!
  expect(after.drain).toMatchObject({ incarnation: "src-1", boot_id: BOOT_1, export_generation: 1 })
  expect(after.drain_resolutions.map(one => `${one.kind}:${one.id}:${one.basis}`)).toEqual([`intent:${record.id}:process-group`])
  expect(after.block).toBeNull()
  expect(childGone(record.leader!)).toBe(true)
  expect(ledger.of(t.agent_id), "shown gone and answered for: nothing is owed").toEqual([])
  expect(said.map(one => one.kind)).toEqual(["move.drain.intent", "move.drained"])
})

test("an incarnation that never started a child asserts no-child for its own lifetime and records no intent", async () => {
  const s = await stage()
  await s.fleet()
  const t = await s.topic()
  const move = await s.request(t)
  const { world, closed } = worldFor(s)
  expect(await drainSource(world, move.id)).toMatchObject({ state: "drained", owed: null })
  const after = (await readMove(s.tool, move.id))!
  expect(closed).toEqual([])
  expect(after.drain_intents).toEqual([])
  expect(after.drain_resolutions.map(one => `${one.kind}:${one.id}:${one.basis}`)).toEqual(["owner:src-1:no-child"])
  // Nothing is asserted while spawning is not fenced: the evidence says it is.
  const other = await s.request(await s.topic())
  const open = worldFor(s, { fenced: false })
  expect(await drainSource(open.world, other.id)).toMatchObject({ state: "waiting", why: "unverified-child" })
  expect((await readMove(s.tool, other.id))!.drain_resolutions).toEqual([])
})

test("an idle child closed EARLIER, with a survivor the adapter could not clear, cannot become 'no child': the debt is recorded late, the block names it, and it is cleared only when the process table shows the group empty", async () => {
  const s = await stage()
  await s.fleet()
  const t = await s.topic()
  const scripted = adapterWithGroups({ survivor: true })
  const ledger = createLedger()
  const record = await startChild(s, t, ledger, scripted)
  await until("the child started its survivor", () => scripted.children()[0].survivors().length > 0, 10_000)
  // An idle close that dropped the handle before any request: the adapter signalled the leader and could not show the group empty.
  await closeLikeTheRunner(ledger, record)
  expect(record).toMatchObject({ phase: "closed", gone: false, session: null })
  expect(record.unproven).toContain("exit not confirmed")
  expect(record.pids.length, "the survivor was recorded while the child was alive").toBeGreaterThan(1)

  const move = await s.request(t)
  const { world, closed } = worldFor(s, { ledger })
  const first = await drainSource(world, move.id)
  expect(first).toMatchObject({ state: "waiting", why: "survivors", owed: { kind: "local" } })
  const after = (await readMove(s.tool, move.id))!
  expect(closed, "nothing was open to close").toEqual([])
  expect(after.drain).toBeNull()
  expect(after.drain_resolutions.some(one => one.basis === "no-child"), "no-child is never said for a lifetime that closed a child it could not clear").toBe(false)
  expect(after.drain_intents).toHaveLength(1)
  expect(after.drain_intents[0]).toMatchObject({ id: record.id, late: true, group: record.group })
  expect(after.block).toMatchObject({ code: "drain_unproven", by: "source", detail: { reason: "survivors", group: record.group } })
  const owed = first.owed as { kind: "local"; changed(): boolean }
  expect(owed.changed()).toBe(false)

  scripted.reap()
  await until("the group is empty", () => owed.changed(), 10_000)
  const second = await drainSource(world, move.id)
  expect(second).toMatchObject({ state: "drained", owed: null })
  const done = (await readMove(s.tool, move.id))!
  expect(done.block, "the block this side wrote is cleared, because its reason is gone").toBeNull()
  expect(done.drain_resolutions.map(one => `${one.kind}:${one.basis}`)).toEqual(["intent:process-group"])
})

test("an intent that cannot be written closes nothing: the child stays open and the proof is still owed (another boot than the one registered; no boot at all)", async () => {
  const s = await stage()
  await s.fleet()
  const t = await s.topic()
  const scripted = adapterWithGroups()
  const move = await s.request(t)

  const wrongBoot = worldFor(s, { here: { machine: "pi", boot: BOOT_2 } })
  const record = await startChild(s, t, wrongBoot.ledger, scripted)
  const first = await drainSource(wrongBoot.world, move.id)
  expect(first).toMatchObject({ state: "waiting", why: "intent-refused", owed: null })
  expect(wrongBoot.closed).toEqual([])
  expect(record.phase).toBe("open")
  expect(childGone(record.leader!), "the child is still there").toBe(false)
  let after = (await readMove(s.tool, move.id))!
  expect(after.drain_intents).toEqual([])
  expect(after.drain_resolutions).toEqual([])
  expect(after.block).toMatchObject({ code: "drain_unproven", detail: { reason: "intent-refused", answer: "boot-mismatch" } })

  // No boot identity at all: nothing the store accepts can be said, nothing is closed, nothing is certified.
  const noBoot = worldFor(s, { here: { machine: "pi", boot: null }, ledger: wrongBoot.ledger })
  const second = await drainSource(noBoot.world, move.id)
  expect(second).toMatchObject({ state: "waiting", why: "boot-unknown" })
  expect(noBoot.closed).toEqual([])
  expect(record.phase).toBe("open")
  after = (await readMove(s.tool, move.id))!
  expect(after.drain).toBeNull()
  expect(after.drain_resolutions).toEqual([])
})

test("a predecessor of the SAME boot that recorded an intent is never signalled: while its group is alive the drain names it and waits on the process table, and when it is gone it is resolved", async () => {
  const s = await stage()
  await s.fleet()
  const t = await s.topic()
  const move = await s.request(t)
  const predecessor = spawnHolder({ group: true })
  try {
    expect(predecessor.group).toBe(predecessor.pid)
    const intent: DrainIntent = { id: "intent-predecessor", boot_id: BOOT_1, machine: "pi", leader: predecessor.pid, group: predecessor.group, pids: [predecessor.pid] }
    expect(await recordDrainIntent(s.tool, move.id, s.src(), intent)).toBe("intent")
    await s.register(SRC, "src-2")
    const { world } = worldFor(s, { incarnation: "src-2" })

    const first = await drainSource(world, move.id)
    expect(first).toMatchObject({ state: "waiting", why: "predecessor-alive", owed: { kind: "local" } })
    expect(childGone(predecessor.pid), "nothing was signalled").toBe(false)
    expect(lookAt(intent).state).toBe("alive")
    const standing = (await readMove(s.tool, move.id))!
    expect(standing.block).toMatchObject({ code: "drain_unproven", by: "source", detail: { reason: "predecessor-alive", item: "intent-predecessor", group: predecessor.group } })
    expect(standing.drain, "its own lifetime is covered, its predecessor's is not").toBeNull()
    expect(standing.drain_resolutions.map(one => `${one.kind}:${one.id}:${one.basis}`)).toEqual(["owner:src-2:no-child"])
    const owed = first.owed as { kind: "local"; changed(): boolean }
    expect(owed.changed()).toBe(false)

    predecessor.kill()
    await predecessor.exited
    await until("the predecessor's group is empty", () => owed.changed(), 10_000)
    expect(await drainSource(world, move.id)).toMatchObject({ state: "drained", owed: null })
    const done = (await readMove(s.tool, move.id))!
    expect(done.block).toBeNull()
    expect(done.drain_resolutions.map(one => `${one.kind}:${one.id}:${one.basis}`)).toEqual(["owner:src-2:no-child", "intent:intent-predecessor:process-group"])
  } finally {
    predecessor.kill()
  }
})

test("a predecessor of the same boot that recorded NOTHING is never covered: the diagnosis is stable, nothing is written on a second look, and only a withdrawal ends it", async () => {
  const s = await stage()
  await s.fleet()
  const t = await s.topic()
  const move = await s.request(t)
  await s.register(SRC, "src-2")
  const { world } = worldFor(s, { incarnation: "src-2" })

  const first = await drainSource(world, move.id)
  expect(first).toMatchObject({ state: "waiting", why: "predecessor-no-intent", owed: null })
  const one = (await readMove(s.tool, move.id))!
  expect(one.block).toMatchObject({ code: "drain_unproven", by: "source", detail: { reason: "predecessor-no-intent", incarnation: "src-1" } })
  expect(one.drain).toBeNull()
  for (let again = 0; again < 3; again += 1) {
    expect(await drainSource(world, move.id)).toMatchObject({ state: "waiting", why: "predecessor-no-intent", owed: null })
  }
  const two = (await readMove(s.tool, move.id))!
  expect(two.updated_at.getTime(), "a look that finds the same writes nothing").toBe(one.updated_at.getTime())
  expect(two.drain_resolutions).toEqual(one.drain_resolutions)

  expect(await withdrawMove(s.tool, move.id, OWNER)).toBe("withdrawn")
  expect(await drainSource(world, move.id)).toMatchObject({ state: "ended", why: "withdrawn" })
  expect(await s.openGates(t.agent_id), "the move's gate is released by the withdrawal and by nothing else").toEqual([])
})

test("a verified reboot covers the predecessor, and an unknown boot covers nothing", async () => {
  const s = await stage()
  await s.fleet()
  const t = await s.topic()
  const move = await s.request(t)
  const a: DrainIntent = { id: "intent-a", boot_id: BOOT_1, machine: "pi", leader: 4242, group: 4242, pids: [4242] }
  expect(await recordDrainIntent(s.tool, move.id, s.src(), a)).toBe("intent")

  // The machine booted again, and the restarted runner registered the boot it could not read: nothing is resolved, nothing is asserted.
  await s.register(SRC, "src-2", null)
  const unknown = worldFor(s, { incarnation: "src-2", here: { machine: "pi", boot: null } })
  expect(await drainSource(unknown.world, move.id)).toMatchObject({ state: "waiting", why: "boot-unknown" })
  expect((await readMove(s.tool, move.id))!.drain_resolutions).toEqual([])

  // The same machine, booted again, and this incarnation registered the new boot.
  await s.register(SRC, "src-3", BOOT_2)
  const { world } = worldFor(s, { incarnation: "src-3", here: { machine: "pi", boot: BOOT_2 } })
  expect(await drainSource(world, move.id)).toMatchObject({ state: "drained", owed: null })
  const done = (await readMove(s.tool, move.id))!
  expect(done.drain_resolutions.map(one => `${one.kind}:${one.id}:${one.basis}`).sort()).toEqual(["intent:intent-a:boot", "owner:src-3:no-child"])
  expect(done.drain).toMatchObject({ incarnation: "src-3", boot_id: BOOT_2 })
})

test("an unknown baseline is a stable diagnosis, written once and never looped on, and a withdrawal still works", async () => {
  const s = await stage()
  await activateProtocol(s.tool)
  const t = await s.topic()
  const move = await s.request(t)
  expect(move.source_incarnation).toMatchObject({ known: false, reason: "unregistered" })
  expect(move.block).toMatchObject({ code: "drain_owner_unknown", by: "store" })
  await s.register(SRC, "src-1")
  const { world, said } = worldFor(s)

  const first = await drainSource(world, move.id)
  expect(first).toMatchObject({ state: "waiting", why: "owner-unknown", owed: null })
  expect(said.map(one => one.kind)).toEqual(["move.owner-unknown"])
  const one = (await readMove(s.tool, move.id))!
  expect(one.block, "the store's own block is neither replaced nor cleared").toMatchObject({ code: "drain_owner_unknown", by: "store" })
  expect(one.drain).toBeNull()
  await drainSource(world, move.id)
  expect((await readMove(s.tool, move.id))!.updated_at.getTime()).toBe(one.updated_at.getTime())

  expect(await withdrawMove(s.tool, move.id, OWNER)).toBe("withdrawn")
  expect(await drainSource(world, move.id)).toMatchObject({ state: "ended", why: "withdrawn" })
})

test("another party's block is never replaced or cleared by the source: it is said once and the gate stays; this side's own block is the only one it ever clears", async () => {
  const s = await stage()
  await s.fleet()
  const t = await s.topic()
  const move = await s.request(t)
  expect(await blockMove(s.hub, move.id, null, "dependency_unverified", { why: "the hub is verifying" })).toBe("blocked")

  // A reason to block (a predecessor that recorded nothing): the hub's block stands, and the diagnosis goes to the diary.
  await s.register(SRC, "src-2")
  const stuck = worldFor(s, { incarnation: "src-2" })
  expect(await drainSource(stuck.world, move.id)).toMatchObject({ state: "waiting", why: "predecessor-no-intent" })
  expect(stuck.said.map(one => one.kind)).toEqual(["move.block.foreign"])
  expect((await readMove(s.tool, move.id))!.block).toMatchObject({ code: "dependency_unverified", by: "hub", detail: { why: "the hub is verifying" } })

  // Nothing blocks the drain itself (a withdrawn-and-new move, no predecessor): the hub's block survives the certification.
  const t2 = await s.topic()
  const move2 = await s.request(t2)
  expect(await blockMove(s.hub, move2.id, null, "dependency_unverified", {})).toBe("blocked")
  const clear = worldFor(s, { incarnation: "src-2" })
  expect(await drainSource(clear.world, move2.id)).toMatchObject({ state: "drained" })
  expect((await readMove(s.tool, move2.id))!.block).toMatchObject({ code: "dependency_unverified", by: "hub" })
})

test("a drained turn that fails moves the move to awaiting_owner at the hold's own revision; the drain touches no hold and waits, and only the owner's explicit continue lets it go on, replaying nothing", async () => {
  const s = await stage()
  await s.fleet()
  const t = await s.topic()
  const fed = await s.fed(t, "m1")
  const move = await s.request(t)
  const { world } = worldFor(s)

  // The fed turn is still the engine's: nothing is certified over it.
  expect(await drainSource(world, move.id)).toMatchObject({ state: "waiting", why: "busy", owed: { kind: "store" } })
  // The turn ends without a result and the owner is asked: the hold is opened by the existing machinery, and the move waits for the owner.
  const ended = await endAttempt(s.tool, { execution: fed.execution.id, evidence: GONE, cause: "the child went away" })
  expect(ended.state).toBe("interrupted")
  const waiting = (await readMove(s.tool, move.id))!
  expect(waiting.stage).toBe("awaiting_owner")
  expect(waiting.failure).toMatchObject({ execution: fed.execution.id, revision: ended.revision })
  const holds = async () => rows(await s.su`select inbound_id, revision, state, cause from replay_hold order by inbound_id`)
  const before = await holds()

  expect(await drainSource(world, move.id)).toMatchObject({ state: "waiting", why: "awaiting_owner", owed: null })
  expect(await holds(), "the hold is exactly as it was").toEqual(before)
  expect((await readMove(s.tool, move.id))!.updated_at.getTime()).toBe(waiting.updated_at.getTime())

  expect(await continueMove(s.tool, move.id, OWNER, { execution: fed.execution.id, revision: ended.revision! })).toBe("waiting")
  expect(await drainSource(world, move.id)).toMatchObject({ state: "drained", owed: null })
  expect(await holds(), "continuing the move released and replayed nothing").toEqual(before)
  expect(Number((await s.su`select count(*)::int as n from execution where inbound_id = 'm1'`)[0].n), "the input was never fed again").toBe(1)
})

test("a feed the move refused is handed back as the existing machinery decides: unfed ends failed with no retry, no health row and no notice; a feed that was committed meanwhile is held and never released", async () => {
  const s = await stage()
  await s.fleet()
  const t = await s.topic()

  // REQUEST BEFORE THE FIRST FEED: the attempt was opened, the request committed, the feed intent is refused.
  const opened = await s.attempt(t, "m1")
  const move = await s.request(t)
  const error = await markFeedIntent(s.tool, opened.execution, "body of m1").then(() => null, (thrown: unknown) => thrown)
  expect(error).toBeInstanceOf(MoveGated)
  expect(await provenUnfedEnd(s.tool, error as MoveGated)).toMatchObject({ execution: opened.execution.id, evidence: null })
  const handed = await handBackFeed(s.tool, { error: error as MoveGated, execution: opened.execution.id, agent: t.agent_id, registry: null })
  expect(handed).toMatchObject({ state: "failed", revision: null, observed: true })
  expect((await s.su`select state from execution where id = ${opened.execution.id}`)[0].state).toBe("failed")
  expect(rows(await s.su`select claimed_by, retry_at from inbound where id = 'm1'`)).toMatchObject([{ claimed_by: null, retry_at: null }])
  expect(await s.count("replay_hold")).toBe(0)
  expect(await s.count("outbox where kind = 'notice'")).toBe(0)
  expect(await s.count("state_row where sheet = 'agent_health'")).toBe(0)
  expect(await s.openGates(t.agent_id), "the gate holds the queued input where it is").toEqual([`move:${move.id}`])

  // A STALE OBSERVATION: the store no longer shows the attempt unfed (a feed committed after the refusal). Nothing is released: it is
  // ended by `endAttempt` from the state it holds under its lock, which is uncertain, and the input is held.
  const t2 = await s.topic()
  const second = await s.attempt(t2, "m2")
  const move2 = await s.request(t2)
  const refused = await markFeedIntent(s.tool, second.execution, "body of m2").then(() => null, (thrown: unknown) => thrown)
  expect(refused).toBeInstanceOf(MoveGated)
  await s.su`update execution set state = 'feed_intent', feed_intent_at = now() where id = ${second.execution.id}`
  expect(await provenUnfedEnd(s.tool, refused as MoveGated)).toBeNull()
  const held = await handBackFeed(s.tool, { error: refused as MoveGated, execution: second.execution.id, agent: t2.agent_id, registry: null })
  expect(held).toMatchObject({ state: "unknown", observed: false })
  const hold = (await s.su`select cause, revision from replay_hold where inbound_id = 'm2'`)[0]
  expect(hold.cause).toBe("ownership-unknown")
  expect(held.revision, "the hold's own revision, as the machinery wrote it").toBe(Number(hold.revision))
  expect((await s.su`select hub_row_held('m2') as held`)[0].held, "an uncertain feed is never handed back").toBe(true)
  // And the move waits for it: ownership is unresolved.
  expect((await readMove(s.tool, move2.id))!.stage).toBe("awaiting_owner")
})

test("a feed that was committed BEFORE the request is not refused: the fed turn is the engine's, the move is not drained over it, and no other row is fed", async () => {
  const s = await stage()
  await s.fleet()
  const t = await s.topic()
  const fed = await s.fed(t, "m1")
  await s.inbound("m2", t.agent_id)
  const move = await s.request(t)
  expect((await s.su`select state from execution where id = ${fed.execution.id}`)[0].state).toBe("feed_intent")
  const { world } = worldFor(s)
  expect(await drainSource(world, move.id)).toMatchObject({ state: "waiting", why: "busy" })
  expect(Number((await s.su`select count(*)::int as n from execution`)[0].n), "no other row was opened for").toBe(1)
  expect((await s.su`select claimed_by from inbound where id = 'm2'`)[0].claimed_by, "the queued row is untouched").toBeNull()
})

test("a feed the move rolled back for its relocation note is handed back as what it was (unfed, failed from the locked state), with its own cause in the diary", async () => {
  const s = await stage()
  await s.fleet()
  const t = await s.topic()
  const opened = await s.attempt(t, "m1")
  const error = await markFeedIntent(s.tool, opened.execution, "body of m1", "input", undefined, [{ move: "ghost", digest: sha("ghost") }])
    .then(() => null, (thrown: unknown) => thrown)
  expect(error).toBeInstanceOf(MoveNoteRefused)
  expect((error as MoveNoteRefused).answer).toBe("no-note")
  expect((await s.su`select state from execution where id = ${opened.execution.id}`)[0].state, "the feed rolled back: nothing was written").toBe("claimed")
  expect(await s.count("conversation_entry where kind = 'input'")).toBe(0)

  const handed = await handBackFeed(s.tool, { error: error as MoveNoteRefused, execution: opened.execution.id, agent: t.agent_id, registry: null })
  expect(handed).toMatchObject({ state: "failed", revision: null })
  expect((await s.su`select state, evidence from execution where id = ${opened.execution.id}`)[0]).toMatchObject({ state: "failed", evidence: { cause: "move-note-refused:ghost:no-note" } })
  expect(await s.count("replay_hold")).toBe(0)
  expect(await s.count("outbox where kind = 'notice'")).toBe(0)
})

// ---------------------------------------------------------------------------------------------------------------------
// THE SET OF AN INCARNATION'S INTENTS (the store's `seal` item and the runner's `settleSet`)
// ---------------------------------------------------------------------------------------------------------------------

test("the store keeps an incarnation's set open until it is sealed: the intent's group shown empty is `partial`, a seal names EXACTLY the recorded intents, a sealed set takes no other, and intents written without `set: open` keep the earlier contract", async () => {
  const s = await stage()
  await s.fleet()
  const t = await s.topic()
  const move = await s.request(t)
  const a: DrainIntent = { id: "i-a", boot_id: BOOT_1, machine: "pi", leader: 4242, group: 4242, pids: [4242], set: "open" }
  expect(await sealDrainIntents(s.tool, move.id, s.src(), ["i-a"]), "nothing recorded: nothing to seal").toBe("seal-mismatch")
  expect(await recordDrainIntent(s.tool, move.id, s.src(), a)).toBe("intent")

  // The group is shown empty, and that is all that is said about the child it names: the set may have other children.
  const evidence = async () => drainEvidence(await s.reread(move), await s.nativeOf(move), { incarnation: "src-1" }, a)
  expect(await recordDrainDone(s.tool, move.id, s.src(), await evidence())).toBe("partial")
  const open = await s.reread(move)
  expect(open.drain).toBeNull()
  expect(open.drain_resolutions.map(one => `${one.kind}:${one.id}`)).toEqual(["intent:i-a"])

  expect(await sealDrainIntents(s.tool, move.id, s.src(), [])).toBe("seal-invalid")
  expect(await sealDrainIntents(s.tool, move.id, s.src(), ["i-a", "i-b"]), "an intent that was never recorded").toBe("seal-mismatch")
  expect(await sealDrainIntents(s.tool, move.id, s.dst(), ["i-a"])).toBe("not-source")
  expect(await sealDrainIntents(s.tool, move.id, s.src("old-9"), ["i-a"]), "an incarnation that is not the current one").toBe("not-source")
  expect(await sealDrainIntents(s.tool, move.id, s.src(), ["i-a"])).toBe("sealed")
  expect(await sealDrainIntents(s.tool, move.id, s.src(), ["i-a"])).toBe("replay")
  expect((await s.reread(move)).drain_sealed).toMatchObject([{ incarnation: "src-1", boot_id: BOOT_1, intents: ["i-a"] }])
  expect(await recordDrainIntent(s.tool, move.id, s.src(), { ...a, id: "i-late" }), "what was said stays what was said").toBe("intent-sealed")
  expect(await recordDrainIntent(s.tool, move.id, s.src(), a), "the same intent again is still a replay").toBe("replay")

  expect(await recordDrainDone(s.tool, move.id, s.src(), await evidence())).toBe("drained")
  expect((await s.reread(move)).drain).toMatchObject({ incarnation: "src-1", boot_id: BOOT_1 })

  // The earlier contract: an intent that does not say `set: open` is the complete account as recorded, and needs no seal.
  const other = await s.request(await s.topic())
  await s.drain(other)
  expect((await s.reread(other)).drain).not.toBeNull()
  expect((await s.reread(other)).drain_sealed).toEqual([])
})

test("a PREFIX of an incarnation's intents is not its set: the successor of the same boot resolves the intent it finds and still certifies nothing (stable, and a withdrawal ends it), and a reboot resolves the rest", async () => {
  const s = await stage()
  await s.fleet()
  const gone = await deadGroup()
  const prefix = async () => {
    const move = await s.request(await s.topic())
    // src-1 wrote the intent of ONE child, and died before it wrote the others or sealed anything.
    const a: DrainIntent = { id: `intent-${move.id}`, boot_id: BOOT_1, machine: "pi", leader: gone.pid, group: gone.group, pids: [gone.pid], set: "open" }
    expect(await recordDrainIntent(s.tool, move.id, s.src(), a)).toBe("intent")
    return move
  }
  const move = await prefix()
  const withdrawn = await prefix()
  await s.register(SRC, "src-2")
  const same = worldFor(s, { incarnation: "src-2" })

  const first = await drainSource(same.world, move.id)
  expect(first).toMatchObject({ state: "waiting", why: "predecessor-intents-incomplete", owed: null })
  const standing = (await readMove(s.tool, move.id))!
  expect(standing.drain, "the intent's group is empty, and still nothing is certified").toBeNull()
  expect(standing.block).toMatchObject({ code: "drain_unproven", by: "source", detail: { reason: "predecessor-intents-incomplete", incarnation: "src-1" } })
  expect(standing.drain_resolutions.map(one => `${one.kind}:${one.id}:${one.basis}`)).toEqual(["owner:src-2:no-child", `intent:intent-${move.id}:process-group`])
  expect(standing.drain_sealed).toEqual([])
  expect(await drainSource(same.world, move.id)).toMatchObject({ state: "waiting", why: "predecessor-intents-incomplete", owed: null })
  expect((await readMove(s.tool, move.id))!.updated_at.getTime(), "a look that finds the same writes nothing").toBe(standing.updated_at.getTime())

  // A withdrawal ends the one that can never be certified.
  expect(await drainSource(same.world, withdrawn.id)).toMatchObject({ state: "waiting", why: "predecessor-intents-incomplete" })
  expect(await withdrawMove(s.tool, withdrawn.id, OWNER)).toBe("withdrawn")
  expect(await drainSource(same.world, withdrawn.id)).toMatchObject({ state: "ended", why: "withdrawn" })

  // The machine booted again: every item recorded in the other boot is covered, the unsealed set included.
  await s.register(SRC, "src-3", BOOT_2)
  const rebooted = worldFor(s, { incarnation: "src-3", here: { machine: "pi", boot: BOOT_2 } })
  expect(await drainSource(rebooted.world, move.id)).toMatchObject({ state: "drained", owed: null })
  const done = (await readMove(s.tool, move.id))!
  expect(done.drain).toMatchObject({ incarnation: "src-3", boot_id: BOOT_2 })
  expect(done.drain_resolutions.map(one => `${one.kind}:${one.id}:${one.basis}`)).toContain("seal:src-1:boot")
  expect(done.block).toBeNull()
})

test("an older child closed WITHOUT proof and a current child still open: both are written down before the close (the older one first, late), the set is sealed only AFTER the open child is closed, and the drain is certified only when the older survivor is gone too", async () => {
  const s = await stage()
  await s.fleet()
  const t = await s.topic()
  // The first child leaves a survivor, the second does not.
  const scripted = adapterWithGroups({ survivor: [1] })
  const ledger = createLedger()
  const older = await startChild(s, t, ledger, scripted)
  await until("the older child started its survivor", () => scripted.children()[0].survivors().length > 0, 10_000)
  await closeLikeTheRunner(ledger, older)
  expect(older).toMatchObject({ phase: "closed", gone: false })
  const current = await startChild(s, t, ledger, scripted)
  const move = await s.request(t)
  // Assigned inside the async callback, which control-flow analysis cannot see: the cast keeps the declared union instead of narrowing to `null`.
  let atClose = null as { intents: string[]; sealed: number } | null
  const { world, closed } = worldFor(s, {
    ledger,
    beforeClose: async () => {
      // BOTH pre-close intents are durable when the close begins, and the set is not sealed: the open child is not known in full yet.
      const standing = (await readMove(s.tool, move.id))!
      atClose = { intents: standing.drain_intents.map(one => one.id), sealed: standing.drain_sealed.length }
    },
  })

  const first = await drainSource(world, move.id)
  expect(first).toMatchObject({ state: "waiting", why: "survivors", owed: { kind: "local" } })
  expect(atClose).toEqual({ intents: [older.id, current.id], sealed: 0 })
  const standing = (await readMove(s.tool, move.id))!
  expect(standing.drain_intents.map(one => one.id), "the closed child first, the open one last (and no final intent: both documents cover what was known)").toEqual([older.id, current.id])
  expect(standing.drain_intents.map(one => one.late === true)).toEqual([true, false])
  expect(standing.drain_intents.every(one => one.set === "open")).toBe(true)
  expect(standing.drain_sealed).toMatchObject([{ incarnation: "src-1", boot_id: BOOT_1 }])
  expect([...standing.drain_sealed[0].intents].sort(), "the seal names exactly the intents of the set").toEqual([older.id, current.id].sort())
  expect(closed, "the open child was closed once every pre-close intent was durable, and the set was sealed after it").toEqual([current.id])
  expect(childGone(current.leader!)).toBe(true)
  expect(standing.drain, "the older survivor is still there").toBeNull()
  expect(standing.block).toMatchObject({ code: "drain_unproven", detail: { reason: "survivors", child: older.id } })
  expect(standing.drain_resolutions.map(one => `${one.kind}:${one.id}:${one.basis}`), "the current child's group was shown empty, and only that").toEqual([`intent:${current.id}:process-group`])

  scripted.children()[0].kill()
  const owed = first.owed as { kind: "local"; changed(): boolean }
  await until("the older child's group is empty", () => owed.changed(), 10_000)
  expect(await drainSource(world, move.id)).toMatchObject({ state: "drained", owed: null })
  expect((await readMove(s.tool, move.id))!.block).toBeNull()
})

/** The pids of `count` processes this test started and waited for: real numbers that are gone, so that looking at them is only ever a question. */
async function reapedPids(count: number): Promise<number[]> {
  const procs = Array.from({ length: count }, () => Bun.spawn(["true"], { stdout: "ignore", stderr: "ignore", stdin: "ignore" }))
  await Promise.all(procs.map(proc => proc.exited))
  return procs.map(proc => proc.pid)
}

/**
 * A child closed WITHOUT proof, as the ledger keeps it: the group it led (`group`) is gone, and `seen` is the union of every process ever
 * observed under it, a process that left the group and still runs among them.
 */
async function unprovenChild(s: MoveFixture, t: TopicRow, ledger: ChildLedger, group: { pid: number; group: number | null }, seen: number[]): Promise<ChildRecord> {
  const [row] = await s.su`select native_session, placement_generation from conversation where id = ${t.conversation_id}`
  const record = ledger.starting(t.agent_id, { conversation: t.conversation_id, nativeSession: String(row.native_session), placement: Number(row.placement_generation) })
  ledger.record(record, { leader: group.pid, group: group.group, pids: seen })
  ledger.closed(record, null, "the observed tree is no proof of the group")
  return record
}

test("the intent holds EVERY process the ledger ever saw, with no cutoff: an owned survivor that left the group and sorts beyond the 65th is in it, so the successor of the same boot is blocked until that process exits, and signals nothing", async () => {
  const s = await stage()
  await s.fleet()
  const t = await s.topic()
  const gone = await deadGroup()
  const history = await reapedPids(70)
  const survivor = spawnHolder({ group: true })
  try {
    expect(survivor.group, "it leads a group of its own, outside the child's").toBe(survivor.pid)
    expect(survivor.group).not.toBe(gone.group)
    const ledger = createLedger()
    const older = await unprovenChild(s, t, ledger, gone, [...history, survivor.pid])
    expect(older.pids.length).toBeGreaterThan(64)
    expect(older.pids.indexOf(survivor.pid), "beyond the former cutoff").toBeGreaterThanOrEqual(64)
    const move = await s.request(t)
    const { world } = worldFor(s, { ledger })

    expect(await drainSource(world, move.id)).toMatchObject({ state: "waiting", why: "survivors", owed: { kind: "local" } })
    const first = (await readMove(s.tool, move.id))!
    expect(first.drain_intents).toMatchObject([{ id: older.id, group: gone.group, late: true, set: "open" }])
    expect(first.drain_intents[0].pids, "the whole union, in order").toEqual(older.pids)
    expect(first.drain_sealed).toMatchObject([{ incarnation: "src-1" }])
    expect(first.drain).toBeNull()

    // The source is replaced in the same boot: it has no child, the original group is empty, and the persisted record is all it has.
    await s.register(SRC, "src-2")
    const successor = worldFor(s, { incarnation: "src-2" }).world
    const second = await drainSource(successor, move.id)
    expect(second).toMatchObject({ state: "waiting", why: "predecessor-alive", owed: { kind: "local" } })
    const standing = (await readMove(s.tool, move.id))!
    expect(standing.drain, "the survivor still runs: nothing is certified").toBeNull()
    expect(standing.block).toMatchObject({ code: "drain_unproven", by: "source", detail: { reason: "predecessor-alive", item: older.id, present: [survivor.pid] } })
    expect(standing.drain_resolutions.some(one => one.kind === "intent"), "and the intent is not resolved").toBe(false)
    expect(childGone(survivor.pid), "nothing was signalled").toBe(false)

    survivor.kill()
    await survivor.exited
    const owed = second.owed as { kind: "local"; changed(): boolean }
    await until("the survivor is gone", () => owed.changed(), 10_000)
    expect(await drainSource(successor, move.id)).toMatchObject({ state: "drained", owed: null })
    const done = (await readMove(s.tool, move.id))!
    expect(done.block).toBeNull()
    expect(done.drain_resolutions.map(one => `${one.kind}:${one.id}:${one.basis}`)).toContain(`intent:${older.id}:process-group`)
  } finally {
    survivor.kill()
  }
})

test("a complete intent that is too large for the store is REFUSED, not shortened: nothing is written, sealed, closed or submitted for it, and the drain is not certified while its survivor runs", async () => {
  const s = await stage()
  await s.fleet()
  const t = await s.topic()
  const gone = await deadGroup()
  const survivor = spawnHolder({ group: true })
  try {
    const ledger = createLedger()
    // More processes than the document can carry. The numbers are above any pid a machine hands out, so none is live; the survivor
    // sorts first and a shortened document would have kept it, but it would have FITTED and been written: this test fails on any
    // document that is written, shortened or not, and passes only on the refusal of the complete one.
    const seen = [survivor.pid, ...Array.from({ length: 1200 }, (_, n) => 5_000_000 + n)]
    const older = await unprovenChild(s, t, ledger, gone, seen)
    const move = await s.request(t)
    const { world, closed } = worldFor(s, { ledger })

    expect(await drainSource(world, move.id)).toMatchObject({ state: "waiting", why: "intent-unrecorded", owed: null })
    expect(closed).toEqual([])
    const after = (await readMove(s.tool, move.id))!
    expect(after.drain_intents, "no part of it was written").toEqual([])
    expect(after.drain_sealed).toEqual([])
    expect(after.drain_resolutions, "no evidence for it").toEqual([])
    expect(after.drain).toBeNull()
    expect(after.block).toMatchObject({ code: "drain_unproven", detail: { reason: "intent-unrecorded", child: older.id, answer: "intent-invalid" } })
    expect(older.docs.get(move.id)?.pids, "what was asked is the complete record").toEqual(older.pids)
    expect(childGone(survivor.pid), "nothing was signalled").toBe(false)
  } finally {
    survivor.kill()
  }
})

test("an incomplete set closes nothing and submits nothing: when the store refuses an intent (its limit) the open child stays open and alive, no evidence is sent for the intents that WERE recorded, nothing is sealed, and no-child is never said", async () => {
  // 7 earlier intents: the older child's late intent is the eighth and the open child's is refused. 8: the older child's own is refused.
  for (const [prefill, reason] of [[7, "intent-refused"], [8, "intent-unrecorded"]] as const) {
    const s = await stage()
    await s.fleet()
    const t = await s.topic()
    const scripted = adapterWithGroups({ survivor: [1] })
    const ledger = createLedger()
    const older = await startChild(s, t, ledger, scripted)
    await until("the older child started its survivor", () => scripted.children()[0].survivors().length > 0, 10_000)
    await closeLikeTheRunner(ledger, older)
    const current = await startChild(s, t, ledger, scripted)
    const move = await s.request(t)
    for (let n = 0; n < prefill; n += 1) {
      expect(await recordDrainIntent(s.tool, move.id, s.src(), { id: `earlier-${n}`, boot_id: BOOT_1, machine: "pi", group: 900_000 + n })).toBe("intent")
    }
    const { world, closed } = worldFor(s, { ledger })

    expect(await drainSource(world, move.id), reason).toMatchObject({ state: "waiting", why: reason, owed: null })
    expect(closed, "nothing is closed for movement").toEqual([])
    expect(current.phase).toBe("open")
    expect(childGone(current.leader!), "and it is alive").toBe(false)
    const after = (await readMove(s.tool, move.id))!
    const written = after.drain_intents.map(one => one.id)
    expect(written.includes(older.id), "the older child is written first").toBe(prefill === 7)
    expect(written.includes(current.id), "the open child only after every other one").toBe(false)
    expect(after.drain).toBeNull()
    expect(after.drain_resolutions, "no evidence for a part of the set").toEqual([])
    expect(after.drain_sealed).toEqual([])
    expect(after.block).toMatchObject({ code: "drain_unproven", detail: { reason, answer: "intent-limit" } })
  }
})

/** The same world, but the agent is quiet for the first look only: the pre-close intents are made durable, the set is NOT sealed (the child is open), and the close is skipped. */
const quietOnce = (world: DrainWorld): DrainWorld => {
  let looks = 0
  return { ...world, quiet: () => (looks += 1) === 1 }
}

test("the intent is frozen per MOVE, not per child: a child left open by a withdrawn move that is then seen with a detached owned survivor gets a fresh complete document for the next move, so a successor of the same boot is blocked by that survivor and signals nothing", async () => {
  // How the first move ends with the child still open: the store refused its intent (the limit), or it was written and the close was skipped.
  for (const how of ["refused", "unclosed"] as const) {
    const s = await stage()
    await s.fleet()
    const t = await s.topic()
    const scripted = adapterWithGroups()
    const ledger = createLedger()
    const open = await startChild(s, t, ledger, scripted)
    const survivor = spawnHolder({ group: true })
    try {
      expect(survivor.group, "it leads a group of its own, outside the child's").toBe(survivor.pid)
      expect(survivor.group).not.toBe(open.group)

      const m1 = await s.request(t)
      if (how === "refused") {
        for (let n = 0; n < 8; n += 1) {
          expect(await recordDrainIntent(s.tool, m1.id, s.src(), { id: `earlier-${n}`, boot_id: BOOT_1, machine: "pi", group: 900_000 + n })).toBe("intent")
        }
      }
      const first = worldFor(s, { ledger })
      const world = how === "refused" ? first.world : quietOnce(first.world)
      expect(await drainSource(world, m1.id), how).toMatchObject({ state: "waiting", why: how === "refused" ? "intent-refused" : "not-quiet" })
      expect(first.closed, "the child was not closed for the first move").toEqual([])
      expect(open.phase).toBe("open")
      const stored = (await readMove(s.tool, m1.id))!
      expect(stored.drain_intents.some(one => one.id === open.id), "written only when the store took it").toBe(how === "unclosed")
      const frozen = open.docs.get(m1.id)!
      expect(frozen.pids, "the first move's document carries the pids it asked").toBeDefined()
      const asked = [...frozen.pids!]
      expect(asked, "what the first move asked: the union as it was then").not.toContain(survivor.pid)

      // An identical retry within the move sends the document it sent.
      if (how === "refused") {
        expect(await drainSource(world, m1.id)).toMatchObject({ state: "waiting", why: "intent-refused" })
        expect(open.docs.get(m1.id), "the same document").toBe(frozen)
      }

      // The owner withdraws the move. Nothing closes the child; it serves on, and a process under it is seen that then leaves its group.
      expect(await withdrawMove(s.tool, m1.id, OWNER)).toBe("withdrawn")
      expect(open.phase).toBe("open")
      ledger.record(open, { pids: [survivor.pid] })
      expect(open.pids).toContain(survivor.pid)

      // The next move asks again: the pre-close intent is made durable with a document of ITS OWN, and the close is skipped. The set is
      // not sealed: the child is still open, and what is known of it is not final until it is closed.
      const m2 = await s.request(t)
      const second = worldFor(s, { ledger })
      expect(await drainSource(quietOnce(second.world), m2.id)).toMatchObject({ state: "waiting", why: "not-quiet" })
      expect(second.closed).toEqual([])
      const sealed = (await readMove(s.tool, m2.id))!
      expect(sealed.drain_intents).toMatchObject([{ id: open.id, set: "open" }])
      expect(sealed.drain_intents[0].pids, "the whole union as it is now, the survivor in it").toEqual(open.pids)
      expect(sealed.drain_intents[0].pids).toContain(survivor.pid)
      expect(sealed.drain_sealed, "never sealed over an open child").toEqual([])
      expect(open.docs.get(m2.id)).not.toBe(frozen)
      expect(open.docs.get(m1.id), "the first move's document is kept as it was").toBe(frozen)
      expect(frozen.pids).toEqual(asked)

      // The runner is replaced in the same boot, after its child went away: the persisted record is all the successor has.
      scripted.children()[0].kill()
      await until("the child is gone", () => childGone(open.leader!), 10_000)
      await s.register(SRC, "src-2")
      const successor = worldFor(s, { incarnation: "src-2" }).world
      const next = await drainSource(successor, m2.id)
      expect(next).toMatchObject({ state: "waiting", why: "predecessor-alive", owed: { kind: "local" } })
      const standing = (await readMove(s.tool, m2.id))!
      expect(standing.drain, "the survivor still runs: nothing is certified").toBeNull()
      expect(standing.block).toMatchObject({ code: "drain_unproven", by: "source", detail: { reason: "predecessor-alive", item: open.id, present: [survivor.pid] } })
      expect(standing.drain_resolutions.some(one => one.kind === "intent"), "and the intent is not resolved").toBe(false)
      expect(childGone(survivor.pid), "nothing was signalled").toBe(false)

      // The survivor leaves, and the predecessor's set was never sealed (it died with the child open): its intent is resolved, and the
      // pending seal still certifies nothing in this boot. Only a withdrawal or a reboot ends it.
      survivor.kill()
      await survivor.exited
      const owed = next.owed as { kind: "local"; changed(): boolean }
      await until("the survivor is gone", () => owed.changed(), 10_000)
      expect(await drainSource(successor, m2.id)).toMatchObject({ state: "waiting", why: "predecessor-intents-incomplete", owed: null })
      const after = (await readMove(s.tool, m2.id))!
      expect(after.drain).toBeNull()
      expect(after.drain_resolutions.map(one => `${one.kind}:${one.id}:${one.basis}`)).toContain(`intent:${open.id}:process-group`)
    } finally {
      survivor.kill()
    }
  }
})

// ---------------------------------------------------------------------------------------------------------------------
// THE FINAL EVIDENCE: what the close itself observes (an owned process that appears between the snapshot and the close) is durable before
// the set is sealed, and a set whose final evidence is not durable is never sealed.
// ---------------------------------------------------------------------------------------------------------------------

/** One child, one move and one owned process that the child's session reports only at the close; everything a test below needs to look at. */
async function lateObservation(options: { owned?: (survivor: { pid: number }) => number[]; world?: Parameters<typeof worldFor>[1] } = {}) {
  const s = await stage()
  await s.fleet()
  const t = await s.topic()
  const scripted = adapterWithGroups()
  const move = await s.request(t)
  const survivor = spawnHolder({ group: true })
  expect(survivor.group, "it leads a group of its own, outside the child's").toBe(survivor.pid)
  const at: { intents: string[]; sealed: number; pids: number[] }[] = []
  const first = worldFor(s, {
    ...options.world,
    beforeClose: async (record) => {
      // The snapshot is durable and the set is not sealed when the close begins; the process appears only now.
      const standing = (await readMove(s.tool, move.id))!
      at.push({ intents: standing.drain_intents.map(one => one.id), sealed: standing.drain_sealed.length, pids: [...(standing.drain_intents[0].pids ?? [])] })
      reportsAtClose(record, options.owned ? options.owned(survivor) : [survivor.pid])
    },
  })
  const record = await startChild(s, t, first.ledger, scripted)
  return { s, t, move, survivor, first, record, at }
}

test("a process that appears BETWEEN the snapshot and the close is durable before the set is sealed: the pre-close intent stays as it was, a final intent carries the whole union, and a successor of the same boot is blocked by it and signals nothing", async () => {
  const { s, move, survivor, first, record, at } = await lateObservation()
  try {
    const look = await drainSource(first.world, move.id)
    expect(look, "the survivor runs: nothing is certified").toMatchObject({ state: "waiting", why: "survivors", owed: { kind: "local" } })
    expect(first.closed).toEqual([record.id])
    expect(at).toHaveLength(1)
    expect(at[0].intents, "only the pre-close intent was durable when the close began").toEqual([record.id])
    expect(at[0].sealed, "and the set was NOT sealed over the open child").toBe(0)
    expect(at[0].pids).not.toContain(survivor.pid)

    const stored = (await readMove(s.tool, move.id))!
    expect(stored.drain_intents.map(one => one.id)).toEqual([record.id, `${record.id}:final`])
    const [initial, final] = stored.drain_intents
    expect(initial.pids, "the pre-close document is exactly what was frozen and sent").toEqual(at[0].pids)
    expect(initial.pids).not.toContain(survivor.pid)
    expect(initial, "and it did not become a final one").not.toHaveProperty("final")
    expect(final).toMatchObject({ id: `${record.id}:final`, final: true, of: record.id, set: "open", group: record.group, leader: record.leader })
    expect(final.pids, "the final document is the whole union after the close").toEqual(record.pids)
    expect(final.pids).toContain(survivor.pid)
    expect(stored.drain_sealed).toMatchObject([{ incarnation: "src-1" }])
    expect([...stored.drain_sealed[0].intents].sort(), "the seal names the pre-close and the final intent").toEqual([record.id, `${record.id}:final`].sort())
    expect(stored.drain).toBeNull()
    expect(stored.drain_resolutions, "nothing is certified for a child whose process runs").toEqual([])
    expect(stored.block).toMatchObject({ code: "drain_unproven", by: "source", detail: { reason: "survivors", child: record.id } })

    // The runner is replaced in the same boot, after the original group went away: the persisted records are all the successor has.
    expect(groupPresence(record.group!), "the original group is empty").toBe("absent")
    await s.register(SRC, "src-2")
    const successor = worldFor(s, { incarnation: "src-2" }).world
    const next = await drainSource(successor, move.id)
    expect(next).toMatchObject({ state: "waiting", why: "predecessor-alive", owed: { kind: "local" } })
    const standing = (await readMove(s.tool, move.id))!
    expect(standing.drain, "the survivor still runs: nothing is certified").toBeNull()
    expect(standing.block).toMatchObject({ code: "drain_unproven", by: "source", detail: { reason: "predecessor-alive", item: `${record.id}:final`, present: [survivor.pid] } })
    expect(standing.drain_resolutions.map(one => `${one.kind}:${one.id}`), "the original intent is resolved, the final one is not").toContain(`intent:${record.id}`)
    expect(standing.drain_resolutions.some(one => one.id === `${record.id}:final`)).toBe(false)
    expect(childGone(survivor.pid), "nothing was signalled").toBe(false)

    survivor.kill()
    await survivor.exited
    const owed = next.owed as { kind: "local"; changed(): boolean }
    await until("the survivor is gone", () => owed.changed(), 10_000)
    expect(await drainSource(successor, move.id)).toMatchObject({ state: "drained", owed: null })
    expect((await readMove(s.tool, move.id))!.block).toBeNull()
  } finally {
    survivor.kill()
  }
})

test("the complete case drains only after the survivor is gone: both intents of the child are answered on its own group once the process table shows it and every recorded process gone", async () => {
  const { s, move, survivor, first, record } = await lateObservation()
  try {
    const look = await drainSource(first.world, move.id)
    expect(look).toMatchObject({ state: "waiting", why: "survivors", owed: { kind: "local" } })
    expect((await readMove(s.tool, move.id))!.drain).toBeNull()
    expect(first.ledger.of(record.agent), "the record is kept until every obligation is represented and answered").toEqual([record])

    survivor.kill()
    await survivor.exited
    const owed = look.owed as { kind: "local"; changed(): boolean }
    await until("the survivor is gone", () => owed.changed(), 10_000)
    expect(await drainSource(first.world, move.id)).toMatchObject({ state: "drained", owed: null })
    const done = (await readMove(s.tool, move.id))!
    expect(done.drain).toMatchObject({ incarnation: "src-1", boot_id: BOOT_1 })
    expect(done.drain_resolutions.map(one => `${one.kind}:${one.id}:${one.basis}`).sort()).toEqual(
      [`intent:${record.id}:process-group`, `intent:${record.id}:final:process-group`].sort())
    expect(done.block).toBeNull()
    expect(first.ledger.of(record.agent), "nothing is owed any more").toEqual([])
  } finally {
    survivor.kill()
  }
})

test("a crash AFTER the close and BEFORE the final write leaves the set unsealed: the predecessor's pending seal blocks a successor of the same boot, which signals nothing and certifies nothing even when the process is gone", async () => {
  const crash = { armed: true }
  const { s, move, survivor, first, record } = await lateObservation({
    world: { afterClose: async () => { if (crash.armed) throw new Error("the runner died after the close") } },
  })
  try {
    await expect(drainSource(first.world, move.id)).rejects.toThrow("died after the close")
    expect(record.phase, "the close happened").toBe("closed")
    const stored = (await readMove(s.tool, move.id))!
    expect(stored.drain_intents.map(one => one.id), "no final intent was written").toEqual([record.id])
    expect(stored.drain_sealed, "and nothing was sealed").toEqual([])
    expect(stored.drain).toBeNull()
    expect(stored.drain_resolutions).toEqual([])

    await s.register(SRC, "src-2")
    const successor = worldFor(s, { incarnation: "src-2" }).world
    expect(await drainSource(successor, move.id)).toMatchObject({ state: "waiting", why: "predecessor-intents-incomplete", owed: null })
    let standing = (await readMove(s.tool, move.id))!
    expect(standing.drain).toBeNull()
    expect(standing.block).toMatchObject({ code: "drain_unproven", by: "source", detail: { reason: "predecessor-intents-incomplete", incarnation: "src-1" } })
    expect(childGone(survivor.pid), "nothing was signalled").toBe(false)

    // The process is gone, and the unsealed set is still not a certificate: a reboot or a withdrawal ends it, nothing else.
    survivor.kill()
    await survivor.exited
    expect(await drainSource(successor, move.id)).toMatchObject({ state: "waiting", why: "predecessor-intents-incomplete", owed: null })
    standing = (await readMove(s.tool, move.id))!
    expect(standing.drain).toBeNull()
    expect(standing.drain_sealed).toEqual([])
  } finally {
    survivor.kill()
  }
})

test("a crash BETWEEN the final write and the seal leaves the set unsealed: the final intent blocks a successor while its process runs, and the pending seal still blocks it afterwards", async () => {
  const { s, move, survivor, first, record } = await lateObservation({
    world: { onSay: async (_kind, detail) => { if (detail.final === true) throw new Error("the runner died before the seal") } },
  })
  try {
    await expect(drainSource(first.world, move.id)).rejects.toThrow("died before the seal")
    const stored = (await readMove(s.tool, move.id))!
    expect(stored.drain_intents.map(one => one.id), "the final intent is durable").toEqual([record.id, `${record.id}:final`])
    expect(stored.drain_sealed, "the seal was never made").toEqual([])
    expect(stored.drain).toBeNull()

    await s.register(SRC, "src-2")
    const successor = worldFor(s, { incarnation: "src-2" }).world
    const next = await drainSource(successor, move.id)
    expect(next).toMatchObject({ state: "waiting", why: "predecessor-alive", owed: { kind: "local" } })
    let standing = (await readMove(s.tool, move.id))!
    expect(standing.block).toMatchObject({ code: "drain_unproven", detail: { reason: "predecessor-alive", item: `${record.id}:final`, present: [survivor.pid] } })
    expect(standing.drain).toBeNull()
    expect(childGone(survivor.pid), "nothing was signalled").toBe(false)

    survivor.kill()
    await survivor.exited
    const owed = next.owed as { kind: "local"; changed(): boolean }
    await until("the survivor is gone", () => owed.changed(), 10_000)
    expect(await drainSource(successor, move.id)).toMatchObject({ state: "waiting", why: "predecessor-intents-incomplete", owed: null })
    standing = (await readMove(s.tool, move.id))!
    expect(standing.drain, "the pending seal is still there").toBeNull()
    expect(standing.drain_resolutions.map(one => one.id)).toEqual(expect.arrayContaining([record.id, `${record.id}:final`]))
  } finally {
    survivor.kill()
  }
})

test("a final intent the store refuses (the limit of intents, a document too large) is never shortened or sealed over: the child is closed, the set stays unsealed, no evidence is submitted and nothing is certified", async () => {
  // 7 earlier intents: the pre-close intent is the eighth and the final one is refused by the limit.
  const counted = await lateObservation()
  try {
    for (let n = 0; n < 7; n += 1) {
      expect(await recordDrainIntent(counted.s.tool, counted.move.id, counted.s.src(), { id: `earlier-${n}`, boot_id: BOOT_1, machine: "pi", group: 900_000 + n })).toBe("intent")
    }
    expect(await drainSource(counted.first.world, counted.move.id)).toMatchObject({ state: "waiting", why: "final-unrecorded", owed: null })
    expect(counted.first.closed, "the close itself was not held up").toEqual([counted.record.id])
    const after = (await readMove(counted.s.tool, counted.move.id))!
    expect(after.drain_intents.map(one => one.id)).toEqual([...Array.from({ length: 7 }, (_, n) => `earlier-${n}`), counted.record.id])
    expect(after.drain_sealed).toEqual([])
    expect(after.drain_resolutions, "no evidence for a part of the set").toEqual([])
    expect(after.drain).toBeNull()
    expect(after.block).toMatchObject({ code: "drain_unproven", detail: { reason: "final-unrecorded", answer: "intent-limit", child: counted.record.id } })
    expect(childGone(counted.survivor.pid), "nothing was signalled").toBe(false)
  } finally {
    counted.survivor.kill()
  }

  // More processes than the document can carry: the complete document is refused, not shortened, and the pre-close one stands alone.
  const big = await lateObservation({ owned: survivor => [survivor.pid, ...Array.from({ length: 1200 }, (_, n) => 5_000_000 + n)] })
  try {
    expect(await drainSource(big.first.world, big.move.id)).toMatchObject({ state: "waiting", why: "final-unrecorded", owed: null })
    const after = (await readMove(big.s.tool, big.move.id))!
    expect(after.drain_intents.map(one => one.id), "no part of the final document was written").toEqual([big.record.id])
    expect(after.drain_sealed).toEqual([])
    expect(after.drain_resolutions).toEqual([])
    expect(after.drain).toBeNull()
    expect(after.block).toMatchObject({ code: "drain_unproven", detail: { reason: "final-unrecorded", answer: "intent-invalid", child: big.record.id } })
    expect(big.record.finals.get(big.move.id)?.pids, "what was asked is the complete union").toEqual(big.record.pids)

    await big.s.register(SRC, "src-2")
    const successor = worldFor(big.s, { incarnation: "src-2" }).world
    expect(await drainSource(successor, big.move.id)).toMatchObject({ state: "waiting", why: "predecessor-intents-incomplete" })
    expect((await readMove(big.s.tool, big.move.id))!.drain).toBeNull()
    expect(childGone(big.survivor.pid), "nothing was signalled").toBe(false)
  } finally {
    big.survivor.kill()
  }
})

test("a close that is not the drain's (a stop, an error, the loop ending) records the intent before it and seals only after it: settled around the close, the set is never sealed over the open child, and the final union is durable at the seal", async () => {
  const s = await stage()
  await s.fleet()
  const t = await s.topic()
  const scripted = adapterWithGroups()
  const move = await s.request(t)
  const survivor = spawnHolder({ group: true })
  try {
    const { world, ledger } = worldFor(s)
    const record = await startChild(s, t, ledger, scripted)

    // BEFORE the close: the pre-close intent is durable, the child is open, and nothing is sealed.
    expect(await settleSet(world, (await readMove(s.tool, move.id))!)).toMatchObject({ recorded: true, sealed: false, reason: "child-open", inflight: false })
    let stored = (await readMove(s.tool, move.id))!
    expect(stored.drain_intents.map(one => one.id)).toEqual([record.id])
    expect(stored.drain_sealed).toEqual([])

    // THE CLOSE (whoever does it): it observes the process. Between the close and the settle that follows, the runner can die: the set is unsealed.
    reportsAtClose(record, [survivor.pid])
    await closeLikeTheRunner(ledger, record)
    stored = (await readMove(s.tool, move.id))!
    expect(stored.drain_intents.map(one => one.id), "no final intent yet").toEqual([record.id])
    expect(stored.drain_sealed).toEqual([])

    // AFTER the close: the final union is written, then the set is sealed.
    expect(await settleSet(world, stored)).toMatchObject({ recorded: true, sealed: true, reason: null })
    stored = (await readMove(s.tool, move.id))!
    expect(stored.drain_intents.map(one => one.id)).toEqual([record.id, `${record.id}:final`])
    expect(stored.drain_intents[1].pids).toContain(survivor.pid)
    expect([...stored.drain_sealed[0].intents].sort()).toEqual([record.id, `${record.id}:final`].sort())
    // Again: nothing new is written.
    expect(await settleSet(world, stored)).toMatchObject({ recorded: true, sealed: true })
    expect((await readMove(s.tool, move.id))!.updated_at.getTime()).toBe(stored.updated_at.getTime())
    expect(childGone(survivor.pid), "nothing was signalled").toBe(false)
  } finally {
    survivor.kill()
  }
})

test("a hold that existed at the request is admitted, not a failure: the drain and a withdrawal leave its revision and state exactly, and the held input is never fed again", async () => {
  const s = await stage()
  await s.fleet()
  const t = await s.topic()
  const fed = await s.fed(t, "m1")
  const ended = await endAttempt(s.tool, { execution: fed.execution.id, evidence: GONE, cause: "the child went away" })
  expect(ended.state).toBe("interrupted")
  const holds = async () => rows(await s.su`select inbound_id, revision, state, cause from replay_hold order by inbound_id`)
  const before = await holds()
  expect(before).toMatchObject([{ inbound_id: "m1", state: "held", revision: ended.revision }])

  const move = await s.request(t)
  expect(move.preexisting_holds).toMatchObject([{ inbound: "m1", revision: ended.revision }])
  const { world } = worldFor(s)
  expect(await drainSource(world, move.id)).toMatchObject({ state: "drained", owed: null })
  expect((await readMove(s.tool, move.id))!.stage, "an admitted hold is not a failure").toBe("waiting")
  expect(await holds(), "the drain touched no hold").toEqual(before)

  expect(await withdrawMove(s.tool, move.id, OWNER)).toBe("withdrawn")
  expect(await holds(), "nor did the withdrawal").toEqual(before)
  expect((await s.su`select hub_row_held('m1') as held`)[0].held, "the held input stays the owner's").toBe(true)
  expect(Number((await s.su`select count(*)::int as n from execution where inbound_id = 'm1'`)[0].n), "and was never fed again").toBe(1)
})

test("the holder fixture ends what it made through the scratch directory it owns: the survivor leaves with the child, a second kill touches nothing, and nothing is signalled by a number", async () => {
  const holder = spawnHolder({ group: true, survivor: true })
  try {
    await until("the child started its survivor", () => holder.survivors().length > 0, 10_000)
    const [survivor] = holder.survivors()
    expect(childGone(survivor)).toBe(false)
    holder.leave()
    await holder.exited
    expect(childGone(survivor), "the leader alone was signalled: what it started is the survivor").toBe(false)
    holder.kill()
    await until("the survivor ended itself on the stop file", () => childGone(survivor), 10_000)
    await until("and the group is empty", () => groupPresence(holder.group!) === "absent", 10_000)
    holder.kill()
  } finally {
    holder.kill()
  }
})
