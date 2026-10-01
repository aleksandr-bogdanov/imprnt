// The SOURCE RUNNER's loop under a move (IMP-231): the real `runRunner` over a real store, its watch, fences and ledger, with a scripted adapter
// whose children are REAL processes that lead process groups of their own (`group`), so what the drain asserts is what the process table says.
//
// WHAT THIS PROVES, at the loop: a turn that was already fed finishes untouched and is never interrupted; a feed refused by the move (the request
// committed after the attempt was opened and while the adapter's start was paused) is handed back, not failed, with no retry, no health row, no
// notice and the child left for the drain; the child is closed after its intent and the move is drained on the group the intent named; nothing
// is fed or started after the drain; queued input is not claimed while the move stands and is fed exactly once after a withdrawal; a runner started
// AFTER the request places its fence before it serves (no eager child) and does not poll while it can prove nothing; a child closed earlier by the
// idle timer is accounted for (no-child when the adapter proved it gone, survivors when it could not, and the tick finds the group empty); a store
// that places the conversation elsewhere is not an error to retry, and a later placement here lifts the fence; a shutdown with a turn open writes
// the intent and leaves the held assignment to the existing machinery. THE SET OF INTENTS: an older child closed without proof and a current one are
// both written down (the older first) and sealed before anything is closed, and a successor of the same boot neither certifies a set its predecessor
// never sealed nor signals what it finds; a request or a withdrawal whose notification is LOST (the trigger that sends it is off, with no disconnect) is
// found by the loop's own selection and by the work wake, also with the adapter's start paused; a fenced agent that is recovered starts nothing and is
// not certified over an unproven child.
//
// WHAT IT DOES NOT: a listener that was lost and opened again (`topic-move-source-watch.test.ts` forces that against the watch itself), the
// destination, export or release, or anything about native portability. `drained` is not "the move can complete". A queued COUNCIL event is not
// staged here: only a queued human message is, and a worker's report; the gate is the store's and is the same for all of them.

import { afterAll, afterEach, beforeAll, expect, test } from "bun:test"
import { startCluster, until, type Cluster } from "./helpers/cluster.ts"
import { CHAT, DOOR, PERSON, insertInbound, stageHub, withLaunchTree, type StagedHub } from "./helpers/hub-fixture.ts"
import { OWNER, SRC, moveStage, type MoveFixture } from "./helpers/move-store-stage.ts"
import { childGone, spawnHolder, type ScriptedOptions } from "./helpers/scripted-adapter.ts"
import { bootId } from "../src/os/tree.ts"
import { runRunner } from "../src/runner/run.ts"
import { activateProtocol } from "../src/store/conversations.ts"
import { readMove, recordDrainIntent, withdrawMove } from "../src/store/moves.ts"
import { newIdentity, type TopicRow } from "../src/store/topics.ts"

let cluster: Cluster
const mine: { close(): Promise<void> }[] = []
const track = <T extends { close(): Promise<void> }>(sql: T): T => { mine.push(sql); return sql }
const staged: Staged[] = []
const runners: { stop(): Promise<void> }[] = []
beforeAll(async () => { cluster = await startCluster() })
afterEach(async () => {
  for (const one of runners.splice(0)) await one.stop().catch(() => {})
  for (const one of staged.splice(0)) { one.it.scripted.reap(); await one.it.stop().catch(() => {}) }
  for (const one of mine.splice(0)) await one.close().catch(() => {})
})
afterAll(async () => { await cluster?.stop() })

const RUNNER_PI = SRC.runner
const SLOW = 120_000

interface Staged { it: StagedHub; s: MoveFixture; t: TopicRow; agent: string }

/**
 * One staged hub whose only agent is a TOPIC MASTER on the Pi's runner (its id chosen before the registry is written, so the registry names it),
 * and the move fixture staged on the same database. The fixture's `fleet()` is never called: the runner registers itself, and the fixture adopts it.
 */
async function stageSource(options: { adapter?: ScriptedOptions; mode?: "resident" | "on-demand"; idle?: number; tick?: number } = {}): Promise<Staged> {
  const agent = `t-${crypto.randomUUID()}`
  // ONE declared machine, the Pi, which is the runner's: what `hub_move_request` freezes as the source's machine is what the runner
  // registered, and the destination (`runner-mac` on `mac`) is only a name the store records. The person has a real EMPTY tree (`withLaunchTree`):
  // the move's scope look refuses a person with no tree it can look at, so without one every drain here would be followed by that refusal. A person
  // with a tree is launched in the box, and the children here stay plain (`unboxed`): what is asserted is their process groups and survivors, and
  // the box's pid namespace and read-only host (Linux) would change both without being what is under test.
  const it = await stageHub(cluster, {
    adapter: { child: true, group: true, unboxed: true, ...(options.adapter ?? {}) },
    machines: [{ id: "pi", os: "linux" }],
    hub: { tick_seconds: options.tick ?? 1 },
    run: [
      { id: DOOR, kind: "door", machine: "pi", platform: "fake", person: PERSON, token_file: "/dev/null", schedule: "always", memory_limit_mb: 192 },
      { id: RUNNER_PI, kind: "runner", machine: "pi", schedule: "always", memory_limit_mb: 512, child_memory_limit_mb: 512 },
    ],
    registry: base => ({
      ...withLaunchTree(base),
      agents: [{ id: agent, person: PERSON, preset: "daily", chat: CHAT, door: DOOR, runner: RUNNER_PI,
        ...(options.mode ? { mode: options.mode } : {}), ...(options.idle ? { idle_seconds: options.idle } : {}) }],
    }),
  })
  const s = await moveStage(cluster, track, { database: it.db })
  const t = await s.topic("source", { identity: () => ({ ...newIdentity(), agent_id: agent }) })
  const one = { it, s, t, agent }
  staged.push(one)
  return one
}

async function start(st: Staged) {
  const runner = await runRunner({ runner: RUNNER_PI, registryFile: st.it.registryFile, adapters: { [st.it.adapterName]: st.it.scripted.adapter } })
  runners.push(runner)
  return runner
}
const incarnationOf = async (st: Staged) => String((await st.it.read.sql("select incarnation from runner_incarnation where runner = $1", [RUNNER_PI]))[0].incarnation)
const drained = (st: Staged, move: { id: string }) => async () => (await readMove(st.s.tool, move.id))!.drain !== null
/**
 * The drain AND the block this side wrote for it cleared. They are two transactions of two actors: `hub_move_drain_done` commits `drain`,
 * and the source clears its own `drain_unproven` afterwards, at the end of the same look (`settleBlock`: the store clears only a block of
 * the caller's own side and the drain does not touch it). A read that sees `drain` can therefore still see the survivor block of the look
 * before; where a move had a block, "drained" is the two together, and both are required.
 */
const drainedAndCleared = (st: Staged, move: { id: string }) => async () => {
  const row = (await readMove(st.s.tool, move.id))!
  return row.drain !== null && row.block === null
}
const describeMove = (st: Staged, move: { id: string }) => async () => JSON.stringify(await readMove(st.s.tool, move.id))
/**
 * The move's block once the runner has had time to look again after the drain (two ticks of the default one second). The export look runs after
 * the drain commits and, with a destination that has recorded nothing, WAITS for it without a block; a block it writes (a refused scope, a
 * profile) lands a moment after `drain` does, so a read taken at the instant the drain is seen can pass before it is written.
 */
const blockAfterSettle = async (st: Staged, move: { id: string }) => { await Bun.sleep(2500); return (await readMove(st.s.tool, move.id))!.block }

test("a turn that was already fed finishes untouched when the move is requested; then the child is closed under an intent and the move is drained, with no other row fed, claimed or started", async () => {
  const st = await stageSource()
  const { it, s, t, agent } = st
  await start(st)
  await until("the resident child was started", () => it.scripted.starts().length === 1, 30_000)
  it.scripted.holdTurnEnd(true)
  await insertInbound(cluster, it.db, { id: "q1", body: "the turn that is in flight", agent })
  await until("q1 was fed", () => it.scripted.fed().length === 1, 30_000)

  await s.adopt(SRC)
  const move = await s.request(t)
  // Queued after the request: a person's message and a worker's report. Neither is consumed while the move stands.
  await s.inbound("q2", agent)
  await s.inbound("r1", agent, "report")
  await until("the runner fenced the agent", async () => (await it.read.ledger({ stream: "runner", kind: "move.fenced" })).length === 1, 30_000)
  expect((await readMove(s.tool, move.id))!.drain, "nothing is certified over a turn that is the engine's").toBeNull()
  expect(it.scripted.closes(), "the fed turn was not interrupted").toEqual([])

  it.scripted.holdTurnEnd(false)
  await until("the reply landed", async () => (await it.read.outbox()).length === 1, 30_000)
  await until("the move is drained", drained(st, move), 30_000, describeMove(st, move))

  const done = (await readMove(s.tool, move.id))!
  const child = it.scripted.children()[0]
  expect(child.group, "a real group of its own").toBe(child.pid)
  expect(done.drain_intents).toHaveLength(1)
  expect(done.drain_intents[0]).toMatchObject({ incarnation: await incarnationOf(st), machine: "pi", group: child.group, leader: child.pid })
  expect(done.drain_resolutions.map(one => one.basis)).toEqual(["process-group"])
  expect(done.block).toBeNull()
  expect(await blockAfterSettle(st, move), "and the export look that follows the drain writes none: the person's empty tree is a proof, the destination is waited for").toBeNull()
  expect(childGone(child.pid)).toBe(true)
  expect(it.scripted.fed().map(one => one.id), "no other row was fed").toEqual(["q1"])
  expect(it.scripted.starts().length, "and nothing was started again").toBe(1)
  expect(it.scripted.closes()).toEqual([1])
  expect((await it.read.sql("select state from execution where inbound_id = 'q1'"))[0].state, "the fed turn completed").toBe("completed")
  const queued = (await it.read.inbound()).filter(one => one.id === "q2" || one.id === "r1")
  expect(queued.map(one => `${one.id}:${one.claimed_by}`).sort(), "the queued input waits where it is").toEqual(["q2:null", "r1:null"])
  expect(Number((await it.read.sql("select count(*)::int as n from execution"))[0].n)).toBe(1)
}, SLOW)

test("a move requested while the adapter's start is paused: the feed is refused and HANDED BACK (no retry, no health row, no notice), exactly one child is started, closed under its intent, and nothing respawns", async () => {
  const st = await stageSource({ adapter: { startGate: true }, mode: "on-demand" })
  const { it, s, t, agent } = st
  await start(st)
  await insertInbound(cluster, it.db, { id: "q1", body: "claimed, opened, not yet fed", agent })
  // THE ORDER IS FORCED BY THE ADAPTER: the attempt is opened and its spawn is inside the adapter's start when the request commits.
  await until("the spawn is paused inside the adapter", () => it.scripted.startsHeld() === 1, 30_000)
  await s.adopt(SRC)
  const move = await s.request(t)
  expect((await it.read.sql("select state from execution where inbound_id = 'q1'"))[0].state, "opened, and nothing fed").toBe("claimed")
  it.scripted.releaseStart()
  await until("the move is drained", drained(st, move), 30_000, describeMove(st, move))

  const child = it.scripted.children()[0]
  const done = (await readMove(s.tool, move.id))!
  expect(it.scripted.starts().length, "exactly one child").toBe(1)
  expect(it.scripted.fed(), "no byte was written").toEqual([])
  expect(it.scripted.closes()).toEqual([1])
  expect(done.drain_intents).toHaveLength(1)
  expect(done.drain_intents[0]).toMatchObject({ group: child.group, leader: child.pid })
  expect(childGone(child.pid)).toBe(true)
  expect((await it.read.sql("select state from execution where inbound_id = 'q1'"))[0].state, "handed back as what it was").toBe("failed")
  const row = (await it.read.inbound()).find(one => one.id === "q1")!
  expect(row.claimed_by, "the claim is released").toBeNull()
  expect((await it.read.sql("select retry_at from inbound where id = 'q1'"))[0].retry_at, "with no retry time").toBeNull()
  expect(await it.read.noticeRows(), "nobody is told the agent is retrying").toEqual([])
  expect((await it.read.sheet("agent_health")).length, "and there is no health row").toBe(0)
  expect(await it.read.ledger({ stream: "refusal" }), "it is not a refused turn").toEqual([])
  expect((await it.read.sql("select 1 from replay_hold")).length, "and no hold").toBe(0)
  const gated = await it.read.ledger({ stream: "runner", kind: "move.gated" })
  expect(gated).toHaveLength(1)
  expect(gated[0].detail).toMatchObject({ agent, move: move.id, state: "failed" })
  expect(Number((await it.read.sql("select count(*)::int as n from execution"))[0].n), "no second attempt").toBe(1)
}, SLOW)

test("a runner that starts AFTER the request places its fence before it serves: no eager child, a stable diagnosis for a predecessor that recorded nothing, and after a withdrawal the queued row is fed exactly once", async () => {
  const st = await stageSource()
  const { it, s, t, agent } = st
  const boot = bootId()
  if (boot === null) return
  await activateProtocol(s.tool)
  // The incarnation that was the source when the request was made is gone, in this boot, and recorded no intent.
  await s.register(SRC, "predecessor", boot)
  const move = await s.request(t)
  await insertInbound(cluster, it.db, { id: "q0", body: "queued while the move stands", agent })

  await start(st)
  await until("the diagnosis was written", async () => (await readMove(s.tool, move.id))!.block?.code === "drain_unproven", 30_000, describeMove(st, move))
  const blocked = (await readMove(s.tool, move.id))!
  expect(blocked.block).toMatchObject({ by: "source", detail: { reason: "predecessor-no-intent", incarnation: "predecessor" } })
  expect(blocked.drain).toBeNull()
  expect(it.scripted.starts().length, "no eager child for a gated agent: the fence was placed before anything was served").toBe(0)
  expect((await it.read.inbound()).find(one => one.id === "q0")!.claimed_by).toBeNull()

  expect(await withdrawMove(s.tool, move.id, OWNER)).toBe("withdrawn")
  await until("the queued row was fed", () => it.scripted.fed().length === 1, 30_000)
  await until("and answered", async () => (await it.read.outbox()).length === 1, 30_000)
  expect(it.scripted.fed().map(one => one.id)).toEqual(["q0"])
  expect(it.scripted.starts().length).toBe(1)
  expect(Number((await it.read.sql("select count(*)::int as n from execution where inbound_id = 'q0'"))[0].n), "fed exactly once").toBe(1)
}, SLOW)

test("an idle on-demand child that the idle timer closed and PROVED gone is accounted for as 'no child', with no intent; one closed with a survivor the adapter could not clear is not, and the runner's tick finds its group empty", async () => {
  // Proven gone: no intent, no-child.
  const clean = await stageSource({ mode: "on-demand", idle: 1 })
  await start(clean)
  await insertInbound(cluster, clean.it.db, { id: "q1", body: "one turn", agent: clean.agent })
  await until("the turn was answered", async () => (await clean.it.read.outbox()).length === 1, 30_000)
  await until("the idle timer closed the child", () => clean.it.scripted.closes().length === 1, 30_000)
  await clean.s.adopt(SRC)
  const first = await clean.s.request(clean.t)
  await until("the move is drained", drained(clean, first), 30_000, describeMove(clean, first))
  const done = (await readMove(clean.s.tool, first.id))!
  expect(done.drain_intents, "nothing was open: no intent").toEqual([])
  expect(done.drain_resolutions.map(one => one.basis)).toEqual(["no-child"])
  expect(clean.it.scripted.starts().length).toBe(1)

  // Not proven: the leader was signalled and a survivor kept the group; the debt is recorded, the block names it, and the tick resolves it.
  const dirty = await stageSource({ adapter: { survivor: true }, mode: "on-demand", idle: 1 })
  await start(dirty)
  await insertInbound(cluster, dirty.it.db, { id: "q1", body: "one turn", agent: dirty.agent })
  await until("the turn was answered", async () => (await dirty.it.read.outbox()).length === 1, 30_000)
  await until("the idle timer closed the child", () => dirty.it.scripted.closes().length === 1, 30_000)
  await dirty.s.adopt(SRC)
  const second = await dirty.s.request(dirty.t)
  await until("the survivor is named", async () => (await readMove(dirty.s.tool, second.id))!.block?.detail?.reason === "survivors", 30_000, describeMove(dirty, second))
  const standing = (await readMove(dirty.s.tool, second.id))!
  expect(standing.drain).toBeNull()
  expect(standing.drain_resolutions.some(one => one.basis === "no-child"), "an unverified close can never become 'no child'").toBe(false)
  expect(standing.drain_intents[0]).toMatchObject({ late: true })

  dirty.it.scripted.reap()
  await until("the tick found the group empty, the move is drained and the survivor block this side wrote is cleared", drainedAndCleared(dirty, second), 30_000, describeMove(dirty, second))
  const cleared = (await readMove(dirty.s.tool, second.id))!
  expect(cleared.drain, "drained on evidence, not by the block going away").not.toBeNull()
  expect(cleared.block).toBeNull()
  expect(await blockAfterSettle(dirty, second), "and it stays cleared: nothing the source writes after the drain replaces it").toBeNull()
}, SLOW)

test("a conversation the store places on another machine is not an error to retry: no child, no refusal, no health row, one diary line; a later placement HERE lifts the fence and the queued row is fed", async () => {
  const st = await stageSource()
  const { it, s, t, agent } = st
  // The move went through while the registry still lists the agent here.
  await s.su`update conversation set machine = 'mac', placement_generation = placement_generation + 1 where id = ${t.conversation_id}`
  await s.su`update topic set machine = 'mac', runner = 'runner-mac' where id = ${t.id}`
  await start(st)
  await until("the placement was said", async () => (await it.read.ledger({ stream: "runner", kind: "conversation.elsewhere" })).length === 1, 30_000)
  await insertInbound(cluster, it.db, { id: "q1", body: "for an agent that is elsewhere", agent })
  await Bun.sleep(1500)
  expect(it.scripted.starts(), "no child").toEqual([])
  expect(it.scripted.fed()).toEqual([])
  expect((await it.read.inbound()).find(one => one.id === "q1")!.claimed_by, "nothing was claimed").toBeNull()
  expect(await it.read.ledger({ stream: "refusal" })).toEqual([])
  expect((await it.read.sheet("agent_health")).length).toBe(0)
  expect(await it.read.ledger({ stream: "runner", kind: "conversation.elsewhere" }), "said once").toHaveLength(1)

  // An explicit move back: the store places the conversation here again, at a later generation.
  await s.su`update conversation set machine = 'pi', placement_generation = placement_generation + 1 where id = ${t.conversation_id}`
  await s.su`update topic set machine = 'pi', runner = ${RUNNER_PI} where id = ${t.id}`
  await s.su`select pg_notify('hub_move', ${RUNNER_PI})`
  await until("the queued row was fed", () => it.scripted.fed().length === 1, 30_000)
  expect(it.scripted.fed().map(one => one.id)).toEqual(["q1"])
}, SLOW)

test("stopping the runner while a fenced turn is open writes the intent before the child is closed, ends the held assignment by the existing machinery (a hold, awaiting_owner) and never replays it", async () => {
  const st = await stageSource()
  const { it, s, t, agent } = st
  const runner = await start(st)
  await until("the resident child was started", () => it.scripted.starts().length === 1, 30_000)
  it.scripted.holdTurnEnd(true)
  await insertInbound(cluster, it.db, { id: "q1", body: "a turn that will be cut off", agent })
  await until("q1 was fed", () => it.scripted.fed().length === 1, 30_000)
  await s.adopt(SRC)
  const move = await s.request(t)
  // The runner has the move: its fence is up (said once, after it was placed). Only then is it stopped, with the turn still open.
  await until("the runner fenced the agent", async () => (await it.read.ledger({ stream: "runner", kind: "move.fenced" })).length === 1, 30_000)

  runners.splice(runners.indexOf(runner), 1)
  await runner.stop()

  const after = (await readMove(s.tool, move.id))!
  const child = it.scripted.children()[0]
  expect(after.drain_intents, "the intent was written before the close, on the way out").toHaveLength(1)
  expect(after.drain_intents[0]).toMatchObject({ group: child.group, leader: child.pid })
  expect(childGone(child.pid)).toBe(true)
  expect((await it.read.sql("select state from execution where inbound_id = 'q1'"))[0].state, "ended with proof, and held").toBe("interrupted")
  expect((await it.read.sql("select state from replay_hold where inbound_id = 'q1'"))[0].state).toBe("held")
  expect(after.stage, "the failure is the owner's: the move waits for an explicit continue").toBe("awaiting_owner")
  expect(it.scripted.fed().map(one => one.id), "nothing was replayed").toEqual(["q1"])
}, SLOW)

const fencedSaid = (st: Staged) => st.it.read.ledger({ stream: "runner", kind: "move.fenced" })
/** The request's notification is LOST (no disconnect, nothing to reconnect): the trigger that sends it is off while `run` makes its writes. */
async function withoutNotification<T>(st: Staged, run: () => Promise<T>): Promise<T> {
  await st.s.su`alter table topic_move disable trigger topic_move_notify`
  try { return await run() } finally { await st.s.su`alter table topic_move enable trigger topic_move_notify` }
}

test("an older child closed WITHOUT proof (a recovery) and a current one: the runner writes both intents (the older one first) before it closes the current child and seals the set only after that close, names the older survivor, and a restart in the same boot neither certifies nor signals it", async () => {
  // The first child leaves a survivor, the second does not.
  const st = await stageSource({ adapter: { survivor: [1] } })
  const { it, s, t, agent } = st
  const runner = await start(st)
  await until("the resident child was started", () => it.scripted.starts().length === 1, 30_000)
  await until("it has its survivor", () => it.scripted.children()[0].survivors().length > 0, 10_000)
  // A recovery drops the loop: its child is closed and cannot be shown gone (the survivor keeps the group), and the agent is served again with a child of its own.
  await runner.recoverAgent({ id: "recover-1", agent })
  await until("the agent has a new child", () => it.scripted.starts().length === 2, 30_000)
  const older = it.scripted.children()[0]
  const [survivor] = older.survivors()
  expect(childGone(survivor)).toBe(false)

  await s.adopt(SRC)
  const move = await s.request(t)
  await until("the survivor is named", async () => (await readMove(s.tool, move.id))!.block?.detail?.reason === "survivors", 30_000, describeMove(st, move))
  const first = (await readMove(s.tool, move.id))!
  expect(first.drain).toBeNull()
  expect(first.drain_intents.map(one => one.late === true), "the older child first, written late; then the one that was open").toEqual([true, false])
  expect(first.drain_sealed).toMatchObject([{ incarnation: await incarnationOf(st) }])
  expect([...first.drain_sealed[0].intents].sort(), "sealed: exactly the intents of the set").toEqual(first.drain_intents.map(one => one.id).sort())
  expect(it.scripted.closes(), "the open child was closed once its pre-close intent was durable, and the set was sealed after it").toEqual([1, 2])
  expect(first.drain_resolutions.some(one => one.basis === "no-child")).toBe(false)

  // The runner stops and another starts in the same boot: the sealed set is read for what it is, the older group is alive, and nothing is signalled.
  runners.splice(runners.indexOf(runner), 1)
  await runner.stop()
  await start(st)
  await until("the successor names the older child's group", async () => (await readMove(s.tool, move.id))!.block?.detail?.reason === "predecessor-alive", 30_000, describeMove(st, move))
  const second = (await readMove(s.tool, move.id))!
  expect(second.drain).toBeNull()
  expect(second.block).toMatchObject({ by: "source", detail: { item: first.drain_intents[0].id } })
  expect(childGone(survivor), "a process of the predecessor is never signalled").toBe(false)
  expect(it.scripted.starts().length, "and nothing is started for a fenced agent").toBe(2)

  older.kill()
  await until("the tick found the older group empty, the move is drained and the survivor block this side wrote is cleared", drainedAndCleared(st, move), 30_000, describeMove(st, move))
  const cleared = (await readMove(s.tool, move.id))!
  expect(cleared.drain, "drained on evidence, not by the block going away").not.toBeNull()
  expect(cleared.block).toBeNull()
  expect(await blockAfterSettle(st, move), "and it stays cleared: nothing the source writes after the drain replaces it").toBeNull()
}, SLOW)

test("a predecessor of the same boot that wrote only PART of its set (an older child it never wrote down is still running): the successor certifies nothing and signals nothing, and a withdrawal ends it with the queued row fed once", async () => {
  const st = await stageSource()
  const { it, s, t, agent } = st
  const boot = bootId()
  if (boot === null) return
  await activateProtocol(s.tool)
  await s.register(SRC, "predecessor", boot)
  const move = await s.request(t)
  const unknown = spawnHolder({ group: true })
  const written = spawnHolder({ group: true })
  try {
    // The older child nobody wrote down is running; the current one was written down (the set still open) and is gone.
    written.kill()
    await written.exited
    expect(await recordDrainIntent(s.tool, move.id, s.src("predecessor"), { id: "intent-current", boot_id: boot, machine: "pi", leader: written.pid, group: written.group,
      pids: [written.pid], set: "open" })).toBe("intent")
    await insertInbound(cluster, it.db, { id: "q0", body: "queued while the move stands", agent })

    await start(st)
    await until("the diagnosis was written", async () => (await readMove(s.tool, move.id))!.block?.detail?.reason === "predecessor-intents-incomplete", 30_000, describeMove(st, move))
    const blocked = (await readMove(s.tool, move.id))!
    expect(blocked.block).toMatchObject({ code: "drain_unproven", by: "source", detail: { incarnation: "predecessor" } })
    expect(blocked.drain, "the intent it found is resolved and the set it never sealed is not").toBeNull()
    expect(childGone(unknown.pid), "nobody signalled the older child").toBe(false)
    expect(it.scripted.starts().length, "no eager child").toBe(0)

    expect(await withdrawMove(s.tool, move.id, OWNER)).toBe("withdrawn")
    await until("the queued row was fed", () => it.scripted.fed().length === 1, 30_000)
    await until("and answered", async () => (await it.read.outbox()).length === 1, 30_000)
    expect(it.scripted.fed().map(one => one.id)).toEqual(["q0"])
    expect(Number((await it.read.sql("select count(*)::int as n from execution where inbound_id = 'q0'"))[0].n), "fed exactly once").toBe(1)
  } finally {
    unknown.kill()
    written.kill()
  }
}, SLOW)

test("a request whose notification was LOST (no disconnect) is found by the loop's own selection, and a withdrawal whose notification was lost too is found by the work wake: the move drains, then the queued row is fed exactly once", async () => {
  // A long tick, so that what finds the request is what the loop reads, not a clock.
  const st = await stageSource({ tick: 4 })
  const { it, s, t, agent } = st
  await start(st)
  await until("the resident child was started", () => it.scripted.starts().length === 1, 30_000)
  await s.adopt(SRC)
  await withoutNotification(st, async () => {
    const move = await s.request(t)
    expect(await fencedSaid(st), "nothing told the runner").toEqual([])
    await until("the runner found the request on its own read and fenced the agent", async () => (await fencedSaid(st)).length === 1, 30_000)
    await until("the move is drained", drained(st, move), 30_000, describeMove(st, move))
    expect(it.scripted.fed(), "no turn was fed").toEqual([])

    await insertInbound(cluster, it.db, { id: "q1", body: "queued while the move stands", agent })
    expect(await withdrawMove(s.tool, move.id, OWNER)).toBe("withdrawn")
    await until("the queued row was fed", () => it.scripted.fed().length === 1, 30_000)
    await until("and answered", async () => (await it.read.outbox()).length === 1, 30_000)
    expect(it.scripted.fed().map(one => one.id)).toEqual(["q1"])
    expect(Number((await it.read.sql("select count(*)::int as n from execution where inbound_id = 'q1'"))[0].n), "fed exactly once").toBe(1)
    expect(it.scripted.starts().length, "one child before the drain closed it, one after the withdrawal").toBe(2)
  })
}, SLOW)

test("a request whose notification was LOST while the adapter's start is paused: the refused feed is handed back and ITS OWN fence and read find the move; the withdrawal, lost too, still feeds the queued row exactly once", async () => {
  const st = await stageSource({ adapter: { startGate: true }, mode: "on-demand", tick: 4 })
  const { it, s, t, agent } = st
  await start(st)
  await insertInbound(cluster, it.db, { id: "q1", body: "claimed, opened, not yet fed", agent })
  await until("the spawn is paused inside the adapter", () => it.scripted.startsHeld() === 1, 30_000)
  await s.adopt(SRC)
  await withoutNotification(st, async () => {
    const move = await s.request(t)
    expect(await fencedSaid(st), "the watch was told nothing").toEqual([])
    it.scripted.releaseStart()
    await until("the move is drained", drained(st, move), 30_000, describeMove(st, move))
    expect(it.scripted.fed(), "no byte was written").toEqual([])
    expect(it.scripted.starts().length, "exactly one child").toBe(1)
    expect((await it.read.sql("select state from execution where inbound_id = 'q1'"))[0].state, "handed back as what it was").toBe("failed")
    expect((await it.read.sql("select retry_at from inbound where id = 'q1'"))[0].retry_at, "with no retry time").toBeNull()
    expect((await it.read.sheet("agent_health")).length, "and no health row").toBe(0)
    expect(await it.read.ledger({ stream: "runner", kind: "move.gated" })).toHaveLength(1)

    expect(await withdrawMove(s.tool, move.id, OWNER)).toBe("withdrawn")
    await until("the queued row was fed", () => it.scripted.fed().length === 1, 30_000)
    await until("and answered", async () => (await it.read.outbox()).length === 1, 30_000)
    expect(it.scripted.fed().map(one => one.id), "no lost input and no second feed").toEqual(["q1"])
    expect(Number((await it.read.sql("select count(*)::int as n from execution where inbound_id = 'q1' and state = 'completed'"))[0].n)).toBe(1)
  })
}, SLOW)

test("recovering a FENCED agent whose older child could not be shown gone: nothing is started again, no-child is never said, and the drain is certified only when the group is empty", async () => {
  const st = await stageSource({ adapter: { survivor: true } })
  const { it, s, t, agent } = st
  const runner = await start(st)
  await until("the resident child was started", () => it.scripted.starts().length === 1, 30_000)
  await until("it has its survivor", () => it.scripted.children()[0].survivors().length > 0, 10_000)
  await s.adopt(SRC)
  const move = await s.request(t)
  await until("the survivor is named", async () => (await readMove(s.tool, move.id))!.block?.detail?.reason === "survivors", 30_000, describeMove(st, move))

  // The loop is dropped and the agent served again, while the move stands.
  await runner.recoverAgent({ id: "recover-fenced", agent })
  const standing = (await readMove(s.tool, move.id))!
  expect(standing.drain, "the survivor is still there").toBeNull()
  expect(standing.drain_resolutions.some(one => one.basis === "no-child"), "no-child is never said over an unproven child").toBe(false)
  expect(standing.block).toMatchObject({ by: "source", detail: { reason: "survivors" } })
  expect(it.scripted.starts().length, "a fenced agent starts nothing").toBe(1)
  expect(it.scripted.closes(), "its child was closed once").toEqual([1])

  it.scripted.children()[0].kill()
  await until("the tick found the group empty and the move is drained", drained(st, move), 30_000, describeMove(st, move))
  expect(it.scripted.starts().length).toBe(1)
}, SLOW)
