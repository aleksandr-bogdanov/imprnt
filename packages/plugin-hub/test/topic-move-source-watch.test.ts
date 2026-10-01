// The SOURCE RUNNER's watch over its moves (`watchMoves`, `src/runner/move.ts`, IMP-231): when it reads, what it fences, what it never
// does, and how it behaves when a listener is lost or a consumer is in flight.
//
// WHAT THIS PROVES: the fences are placed by the FIRST read, before the watch is handed back (and a runner that cannot read does not get
// one); a request is heard by its notification alone; a listener that was lost is opened again and what was asked meanwhile is read; one
// consumer per move and never two looks at once; closing is deterministic; a withdrawal lifts the fence; a move that went through is NOT
// lifted by leaving the list of open moves (the list leaves terminal rows out) and is lifted only by the store placing the conversation
// HERE again at a later generation. WHAT IT DOES NOT: the drain itself (`topic-move-source.test.ts`), the runner's loop
// (`topic-move-source-runner.test.ts`) or the statement count while nothing is owed (`topic-move-source-quiet.test.ts`). `drive` is a
// stub here, so nothing below says a child was closed.

import { afterAll, afterEach, beforeAll, expect, test } from "bun:test"
import { startCluster, until, type Cluster } from "./helpers/cluster.ts"
import { OWNER, SRC, moveStage } from "./helpers/move-store-stage.ts"
import { createFences, watchMoves, type DrainStep, type Fences, type MoveWatch } from "../src/runner/move.ts"
import { withdrawMove } from "../src/store/moves.ts"

let cluster: Cluster
const mine: { close(): Promise<void> }[] = []
const track = <T extends { close(): Promise<void> }>(sql: T): T => { mine.push(sql); return sql }
const watches: MoveWatch[] = []
beforeAll(async () => { cluster = await startCluster() })
afterEach(async () => {
  for (const one of watches.splice(0)) await one.close().catch(() => {})
  for (const one of mine.splice(0)) await one.close().catch(() => {})
})
afterAll(async () => { await cluster?.stop() })

const stage = () => moveStage(cluster, track)
const WAITING: DrainStep = { state: "waiting", why: "test", owed: null, seen: null }

interface Seen { driven: string[]; lifted: string[]; said: { kind: string; detail: Record<string, unknown> }[]; fences: Fences }
const recorder = (): Seen => ({ driven: [], lifted: [], said: [], fences: createFences() })

/** The watch over the staged store as the source runner, with `drive` a stub that records what it was asked to look at. */
async function watching(s: Awaited<ReturnType<typeof stage>>, seen: Seen, drive?: (request: { id: string; agent: string }) => Promise<DrainStep>): Promise<MoveWatch> {
  const watch = await watchMoves(s.tool, {
    runner: SRC.runner, machine: SRC.machine, fences: seen.fences,
    drive: drive ?? (async request => { seen.driven.push(request.id); return WAITING }),
    lifted: agent => { seen.lifted.push(agent) },
    say: async (kind, detail) => { seen.said.push({ kind, detail }) },
    report: () => {},
  })
  watches.push(watch)
  return watch
}

test("the FIRST read places the fence of a move that was requested before the runner started, before the watch is handed back, and a runner that cannot make it does not get a watch", async () => {
  const s = await stage()
  await s.fleet()
  const t = await s.topic()
  const move = await s.request(t)
  const seen = recorder()
  const watch = await watching(s, seen)
  // Nothing was awaited between the answer and this line: the fence is there now, not "soon".
  expect(seen.fences.get(t.agent_id)).toMatchObject({ kind: "move", move: move.id, stage: "waiting", agent: t.agent_id })
  await until("the move was looked at", () => seen.driven.includes(move.id), 10_000)
  await watch.close()

  const refused = createFences()
  const broken = Object.assign(() => { throw new Error("store down") }, { unsafe: async () => { throw new Error("read refused") } })
  await expect(watchMoves({ sql: broken as never, url: s.tool.url }, {
    runner: SRC.runner, machine: SRC.machine, fences: refused, drive: async () => WAITING, lifted: () => {}, say: async () => {},
  })).rejects.toThrow(/read refused/)
  expect(refused.all(), "no fence was placed from a read that failed").toEqual([])
})

test("a request is heard by its notification alone, and a withdrawal lifts the fence and wakes whoever waits on it; nothing else lifts it", async () => {
  const s = await stage()
  await s.fleet()
  const t = await s.topic()
  const seen = recorder()
  await watching(s, seen)
  expect(seen.fences.has(t.agent_id)).toBe(false)

  const move = await s.request(t)
  await until("the request was heard", () => seen.fences.has(t.agent_id) && seen.driven.includes(move.id), 10_000)
  expect(seen.lifted).toEqual([])

  expect(await withdrawMove(s.tool, move.id, OWNER)).toBe("withdrawn")
  await until("the withdrawal lifted the fence", () => !seen.fences.has(t.agent_id), 10_000)
  expect(seen.lifted).toEqual([t.agent_id])
  expect(seen.said.map(one => one.kind), "said once when the fence went up, once when it was lifted").toEqual(["move.fenced", "move.fence.lifted"])
  expect(seen.said[0].detail).toMatchObject({ agent: t.agent_id, move: move.id, stage: "waiting" })
  expect(seen.said[1].detail).toMatchObject({ agent: t.agent_id, move: move.id, why: "withdrawn" })

  // A later, explicit request is a new fence: the first one did not outlive its move.
  const again = await s.request(t, "again")
  await until("the new request was heard", () => seen.fences.get(t.agent_id)?.move === again.id, 10_000)
})

test("a move that WENT THROUGH is not lifted by leaving the list of open moves: the source stays fenced until the store places the conversation here again, at a later generation", async () => {
  const s = await stage()
  await s.fleet()
  const t = await s.topic()
  const move = await s.request(t)
  const seen = recorder()
  await watching(s, seen)
  expect(seen.fences.get(t.agent_id)).toMatchObject({ kind: "move", move: move.id })

  const done = await s.reach(move, "active")
  expect(done.stage).toBe("active")
  await until("the fence became a placement fence", () => seen.fences.get(t.agent_id)?.kind === "placed", 10_000)
  expect(seen.fences.get(t.agent_id), "the generation the source gave way to").toMatchObject({ kind: "placed", move: move.id, after: done.dest_generation })
  expect(seen.lifted, "absence from the open list lifted nothing").toEqual([])

  // The store places the conversation HERE again at a later generation (a move back), and the source hears that a move of its runner changed.
  await s.su`update conversation set machine = ${SRC.machine}, placement_generation = placement_generation + 1 where id = ${t.conversation_id}`
  await s.su`update topic set machine = ${SRC.machine}, runner = ${SRC.runner} where id = ${t.id}`
  await s.su`select pg_notify('hub_move', ${SRC.runner})`
  await until("the placement lifted the fence", () => !seen.fences.has(t.agent_id), 10_000)
  expect(seen.lifted).toEqual([t.agent_id])
  expect(seen.said.filter(one => one.kind === "move.fence.lifted").map(one => one.detail.why)).toEqual(["placed-here"])
})

test("a lost listener is opened again, and what was asked while nothing listened is read once (the notification of it is gone)", async () => {
  const s = await stage()
  await s.fleet()
  const t = await s.topic()
  const seen = recorder()
  await watching(s, seen)
  try {
    // New logins are refused, so the first attempts to listen again fail; the connection the listener had is ended.
    await s.su`alter role hub_runner nologin`
    await s.su`select pg_terminate_backend(pid) from pg_stat_activity where datname = ${s.db} and application_name = 'imprnt-hub-listen'`
    const move = await s.request(t)
    // Two attempts (they wait a second between tries) have been refused, and nothing heard the notification.
    await Bun.sleep(1500)
    expect(seen.fences.has(t.agent_id)).toBe(false)

    await s.su`alter role hub_runner login`
    await until("the move was read once the listener was back", () => seen.fences.get(t.agent_id)?.move === move.id && seen.driven.includes(move.id), 20_000)
    // A refused attempt is the caller's to retry and is not a listener that was lost: one loop, so exactly one listener, however many
    // attempts were refused (each extra one would hold a backend slot of the cluster for the rest of the file).
    const listeners = async () => Number((await s.su`select count(*)::int as n from pg_stat_activity where datname = ${s.db} and application_name = 'imprnt-hub-listen'`)[0].n)
    await Bun.sleep(1200)
    expect(await listeners(), "the lost listener was replaced by one, not by one per refused attempt").toBe(1)
  } finally {
    await s.su`alter role hub_runner login`.catch(() => {})
  }
})

test("one consumer per move, one look at a time: a notification that arrives while a look is in flight does not start another, and the move is looked at again after it", async () => {
  const s = await stage()
  await s.fleet()
  const t = await s.topic()
  const move = await s.request(t)
  let calls = 0
  let active = 0
  let peak = 0
  let release!: () => void
  const first = new Promise<void>(resolve => { release = resolve })
  const seen = recorder()
  const watch = await watching(s, seen, async () => {
    calls += 1
    active += 1
    peak = Math.max(peak, active)
    if (calls === 1) await first
    active -= 1
    return { ...WAITING, seen: "same" }
  })
  await until("the first look is in flight", () => calls === 1, 10_000)
  watch.refresh()
  watch.refresh()
  await s.su`select pg_notify('hub_move', ${SRC.runner})`
  release()
  await until("it was looked at again", () => calls >= 2, 10_000)
  expect(peak, "never two looks of one move at once").toBe(1)
  expect(seen.fences.get(t.agent_id)?.move).toBe(move.id)
})

test("closing is deterministic: it waits for the look that is in flight, starts no other, and a notification after it does nothing", async () => {
  const s = await stage()
  await s.fleet()
  const t = await s.topic()
  await s.request(t)
  let calls = 0
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const seen = recorder()
  const watch = await watching(s, seen, async () => { calls += 1; await gate; return WAITING })
  await until("the look is in flight", () => calls === 1, 10_000)

  let closed = false
  const closing = watch.close().then(() => { closed = true })
  watch.refresh()
  await s.su`select pg_notify('hub_move', ${SRC.runner})`
  release()
  await closing
  expect(closed).toBe(true)
  expect(calls, "no look was started after the close").toBe(1)

  await s.request(await s.topic())
  watch.refresh()
  await s.su`select pg_notify('hub_move', ${SRC.runner})`
  await s.su`select pg_sleep(0.3)`
  expect(calls).toBe(1)
})
