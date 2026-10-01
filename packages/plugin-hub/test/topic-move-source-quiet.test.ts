// A runner that can prove nothing does not busy-loop (IMP-231, source slice): the statements the SERVER logs for the watch's own backends while a
// diagnosis stands. The cluster runs with `log_statement = 'all'` and a pid prefix, so the count comes from the server and nothing client-side can
// fake it (the way `test/runner-drain.test.ts` counts a waiting runner).
//
// WHAT THIS PROVES: with a stable diagnosis (a predecessor of the same boot that recorded nothing) nothing is owed, the tick asks nothing, and the
// watch issues no statement; with evidence that may still move locally (a predecessor's REAL process group, alive) the debt is owed and the tick
// looks at the process table alone, issues no statement while the group is there, and reads the store only once it is gone, after which the move is
// drained. WHAT IT DOES NOT: the drain's own writes (`topic-move-source.test.ts`), the loop, or a runner's other waits.

import { afterAll, afterEach, beforeAll, expect, test } from "bun:test"
import { startCluster, statementWatch, until, type Cluster } from "./helpers/cluster.ts"
import { BOOT_1, SRC, moveStage } from "./helpers/move-store-stage.ts"
import { spawnHolder } from "./helpers/scripted-adapter.ts"
import { createFences, createLedger, drainSource, watchMoves, type DrainWorld, type MoveWatch } from "../src/runner/move.ts"
import { openStore } from "../src/store/connect.ts"
import { readMove, recordDrainIntent, type DrainIntent } from "../src/store/moves.ts"

let cluster: Cluster
const mine: { close(): Promise<void> }[] = []
const track = <T extends { close(): Promise<void> }>(sql: T): T => { mine.push(sql); return sql }
const watches: MoveWatch[] = []
beforeAll(async () => {
  cluster = await startCluster({ settings: { log_statement: "'all'", log_line_prefix: "'pid=%p '", log_min_duration_statement: "-1" } })
})
afterEach(async () => {
  for (const one of watches.splice(0)) await one.close().catch(() => {})
  for (const one of mine.splice(0)) await one.close().catch(() => {})
})
afterAll(async () => { await cluster?.stop() })

/** Statements the server logged in a window, from any backend: nothing of the test's own runs inside it. */
const issuedIn = async (window: () => Promise<void>): Promise<number> => {
  const watch = await statementWatch(cluster)
  await window()
  return await watch.count()
}
/** Until a window of 300 ms of the server's log is empty: the watch has finished writing what it was going to write. */
const untilQuiet = (what: string) => until(what, async () => (await issuedIn(() => Bun.sleep(300))) === 0, 30_000)

/** The source runner's watch, on a connection of its own, over a store where the source is incarnation `src-2` that restarted in the same boot. */
async function sourceWatch(s: Awaited<ReturnType<typeof moveStage>>) {
  const store = track(await openStore({ url: s.tool.url }))
  const fences = createFences()
  const world: DrainWorld = {
    store, runner: SRC.runner, incarnation: "src-2", here: { machine: SRC.machine, boot: BOOT_1 }, ledger: createLedger(),
    fenced: agent => fences.has(agent), quiet: () => true, async close() {}, say: async () => {},
  }
  const watch = await watchMoves(store, {
    runner: SRC.runner, machine: SRC.machine, fences,
    drive: ({ id }) => drainSource(world, id), lifted: () => {}, say: async () => {}, report: () => {},
  })
  watches.push(watch)
  return watch
}

test("a predecessor that recorded nothing: one diagnosis, nothing owed, and the tick, a notification of nothing and a wait issue no statement at all", async () => {
  const s = await moveStage(cluster, track)
  await s.fleet()
  const t = await s.topic()
  const move = await s.request(t)
  await s.register(SRC, "src-2")
  const watch = await sourceWatch(s)
  await until("the diagnosis was written", async () => (await readMove(s.tool, move.id))!.block?.code === "drain_unproven", 20_000)
  await untilQuiet("the watch went quiet after its own writes")

  expect(watch.owed, "nothing can move: nothing is owed").toBe(false)
  const statements = await issuedIn(async () => {
    for (let tick = 0; tick < 8; tick += 1) { watch.tick(); await Bun.sleep(60) }
    await Bun.sleep(400)
  })
  expect(statements, "eight ticks and a wait").toBe(0)
  expect((await readMove(s.tool, move.id))!.block).toMatchObject({ detail: { reason: "predecessor-no-intent" } })
})

test("a predecessor's REAL group that is still alive is owed locally: the tick looks at the process table alone, issues no statement while it is there, and reads the store only once it is gone", async () => {
  const s = await moveStage(cluster, track)
  await s.fleet()
  const t = await s.topic()
  const move = await s.request(t)
  const predecessor = spawnHolder({ group: true })
  try {
    const intent: DrainIntent = { id: "intent-predecessor", boot_id: BOOT_1, machine: "pi", leader: predecessor.pid, group: predecessor.group, pids: [predecessor.pid] }
    expect(await recordDrainIntent(s.tool, move.id, s.src(), intent)).toBe("intent")
    await s.register(SRC, "src-2")
    const watch = await sourceWatch(s)
    await until("the predecessor is named", async () => (await readMove(s.tool, move.id))!.block?.detail?.reason === "predecessor-alive", 20_000)
    await untilQuiet("the watch went quiet after its own writes")

    expect(watch.owed, "evidence may still move: it is owed").toBe(true)
    const statements = await issuedIn(async () => {
      for (let tick = 0; tick < 8; tick += 1) { watch.tick(); await Bun.sleep(60) }
      await Bun.sleep(400)
    })
    expect(statements, "the group is there: the process table answered, the store was not asked").toBe(0)
    expect((await readMove(s.tool, move.id))!.drain).toBeNull()

    predecessor.kill()
    await predecessor.exited
    await until("the tick found the group empty and the move is drained", async () => { watch.tick(); return (await readMove(s.tool, move.id))!.drain !== null }, 30_000)
    await untilQuiet("and went quiet again")
    expect(watch.owed).toBe(false)
    expect((await readMove(s.tool, move.id))!.block).toBeNull()
  } finally {
    predecessor.kill()
  }
})
