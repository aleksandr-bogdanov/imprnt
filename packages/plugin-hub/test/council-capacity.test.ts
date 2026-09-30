// A real runner and a real wait: while a council is active its master keeps one slot free on its own runner, so
// a worker is not admitted into the last room, and the master can still answer the owner. Raising the limit
// (a routine registry edit, within a tick) lets workers in, one at a time, and the round completes.

import { afterAll, afterEach, beforeAll, expect, test } from "bun:test"
import { readFileSync, writeFileSync } from "node:fs"
import { startCluster, until, type Cluster } from "./helpers/cluster.ts"
import { RUNNER } from "./helpers/hub-fixture.ts"
import { councilStage, roster, startArgs } from "./helpers/council-stage.ts"
import { callTool } from "../src/mcp/handlers.ts"
import { runRunner } from "../src/runner/run.ts"
import { stamp } from "../src/records/stamps.ts"
import { readSnapshot } from "../src/council/snapshot.ts"
import { statusLine } from "../src/council/lines.ts"
import { admitOnce, type Admission } from "../src/runner/admission.ts"
import { runnerAdmission } from "../src/registry/entries.ts"
import { loadRegistry } from "../src/registry/load.ts"
import type { StoreLike } from "../src/store/connect.ts"

let cluster: Cluster
beforeAll(async () => { cluster = await startCluster() })
afterAll(async () => { await cluster?.stop() })

const mine: { close(): Promise<void> }[] = []
const track = <T extends { close(): Promise<void> }>(sql: T): T => { mine.push(sql); return sql }
afterEach(async () => { for (const one of mine.splice(0)) await one.close().catch(() => {}) })

test("C-cap a worker waits for room while its master keeps the last slot, the wait names it, the master still answers the owner, and a raised limit lets the workers in", async () => {
  // Every agent is on demand and lets go of its child after one quiet second (the setting the runner suites use for the same reason): an
  // on-demand child otherwise keeps its slot for `idle_seconds` (300 by default) after its last turn, and a second worker would then wait
  // for the first one's idle child and not for the limit this test raises.
  const s = await councilStage(cluster, track, {
    hub: { tick_seconds: 1 },
    registry: base => ({ ...base, agents: base.agents.map((one: { id: string }) => ({ ...one, ...(one.id === "p1-lair" ? { mode: "on-demand" } : {}), idle_seconds: 1 })) }),
  })
  const setCount = (count: number) => writeFileSync(s.registryFile, readFileSync(s.registryFile, "utf8")
    .replace(/\nmax_active_children = \d+/g, "")
    .replace(`id = ${JSON.stringify(RUNNER)}\n`, `id = ${JSON.stringify(RUNNER)}\nmax_active_children = ${count}\n`))
  let runner: Awaited<ReturnType<typeof runRunner>> | undefined
  try {
    setCount(1)
    const started = await callTool(s.binding("attempt-start"), "hub_council", startArgs({ participants: roster(["p1-w1", "p1-w2"]) }))
    const id = String(started.object_id)
    // The two staging messages are not this test's traffic. `inbound.state` is derived from the ledger, so they are answered the way the
    // runner answers a message: its own stamp, which the store's trigger turns into the state. Nothing writes the state itself.
    for (const message of ["h1", "h2"]) await stamp(s.runner, { messageId: message, kind: "answered", actor: "runner" })
    expect((await s.su`select id, state from inbound where id in ('h1', 'h2') order by id`).map((row: any) => [row.id, row.state]),
      "answered by the ledger, so no runner feeds the master with staging traffic").toEqual([["h1", "answered"], ["h2", "answered"]])
    runner = await runRunner({ runner: RUNNER, registryFile: s.registryFile, adapters: { [s.adapterName]: s.scripted.adapter } })

    await until("both workers wrote down that they wait for room", async () =>
      (await s.read.sheet("agent_wait")).filter(row => ["p1-w1", "p1-w2"].includes(row.id)).length === 2, 20_000,
      async () => JSON.stringify(await s.read.sheet("agent_wait")))
    for (const row of (await s.read.sheet("agent_wait")).filter(one => ["p1-w1", "p1-w2"].includes(one.id))) {
      expect(row.data).toMatchObject({ kind: "slots", count: 1, held_for_master: 1, conflict: true })
    }
    expect(await s.count("execution"), "nobody was started into the master's room").toBe(0)
    const waiting = await readSnapshot(s.runner, id, { now: new Date(), quietSeconds: 300 })
    expect(waiting).toMatchObject({ stage: "waiting-capacity" })
    expect(waiting!.members.map(one => one.view)).toEqual(["waiting-capacity", "waiting-capacity"])
    expect(statusLine("en", waiting!)).toContain("the machine's limits leave no room for a participant beside the master")

    // The master takes the room that was kept: the owner is answered while both workers wait.
    await s.human("h9")
    await until("the master answers the owner", async () => (await s.read.outbox()).some(row => row.inbound_id === "h9"), 20_000,
      async () => JSON.stringify(await s.read.outbox()))
    expect(await s.count("execution", "agent like 'p1-w%'"), "and still nobody else").toBe(0)
    // The master was served in the conversation the stage planted, placed where the registry places it: the runner did not have to make
    // another one, and a conversation that follows an agent to another machine is exactly what the store refuses.
    expect((await s.su`select conversation_id from execution where inbound_id = 'h9'`).map((row: any) => row.conversation_id), "the owner's message ran in the master's own conversation").toEqual([s.master.id])
    expect(await s.count("conversation", "kind = 'master'")).toBe(1)

    // A routine edit gives the runner a second slot. One worker is let in beside the master's reserve, then the other.
    setCount(2)
    await until("both workers answered", async () => (await s.jobsOf(id)).every(job => job.state === "answered"), 30_000,
      async () => JSON.stringify(await s.jobsOf(id)))
    await until("the master was handed the round's one event", async () => (await s.count("council_event")) === 1, 20_000)
    expect(await s.count("inbound", "id like 'report:%' and source ->> 'origin' = 'council' and kind = 'report' and source ? 'job'")).toBe(2)
    expect((await s.su`select count(*)::int as n from council_round where council_id = ${id}`)[0].n).toBe(1)
    // The round was completed once, by the ordinary path, and nothing was replayed, stopped or held to get there.
    expect((await s.su`select kind from council_event where council_id = ${id}`).map((row: any) => row.kind)).toEqual(["round_complete"])
    expect(await s.count("execution", "agent like 'p1-w%' and state = 'completed'"), "each worker had exactly one attempt and it completed").toBe(2)
    expect(await s.count("execution", "agent like 'p1-w%'")).toBe(2)
    expect(await s.count("replay_hold")).toBe(0)
    expect(await s.count("stop_request")).toBe(0)
    // The master's room was kept the whole time: with two slots, the workers went in one at a time and never beside each other.
    expect((await s.su`select count(*)::int as n from execution a join execution b on a.id < b.id
      where a.agent like 'p1-w%' and b.agent like 'p1-w%' and a.started_at < b.ended_at and b.started_at < a.ended_at`)[0].n, "the workers did not run together").toBe(0)
  } finally { await runner?.stop(); await s.close() }
}, 120_000)

// ---------------------------------------------------------------------------
// The decision to admit is taken against the runner's memory as it is AFTER the council query answers.
//
// Two workers that wake together are both suspended at the store's answer to "which masters have an active council". The decision itself
// (`runner/admission.ts`) is what `admitChild` runs; here the store's answer is HELD by the test and released to every caller at once, so the
// interleaving is exact and nothing sleeps: which callers are suspended, what the runner's own world is when they resume, and who is admitted.
// ---------------------------------------------------------------------------

/** A store whose every query stands still until `release()`: all callers that asked are suspended together, and resume together. */
function heldStore(real: StoreLike) {
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => gate.then(() => (real.sql as unknown as (...args: unknown[]) => Promise<unknown>)(strings, ...values))) as unknown as StoreLike["sql"]
  return { store: { ...real, sql } as StoreLike, release }
}

async function admissionStage() {
  const s = await councilStage(cluster, track)
  const started = await callTool(s.binding("attempt-start"), "hub_council", startArgs({ participants: roster(["p1-w1", "p1-w2"]) }))
  const registry = loadRegistry(s.registryFile)
  // Memory is the limit that binds: a slot budget of eight beside a budget for two children (each reserves 1024 MB of 2048).
  const limits = runnerAdmission({ max_active_children: 8, child_memory_budget_mb: 2048, child_memory_limit_mb: 1024 })
  expect(limits).toMatchObject({ max_active_children: 8, reserve_mb: 1024, child_memory_budget_mb: 2048, admits: 2 })
  const world = { reservations: 0, measuredBytes: 0, masterResident: false }
  const decide = (store: StoreLike, agent: string): Promise<Admission> => admitOnce({
    store, runner: RUNNER, registry, admitting: { id: agent, door: undefined },
    now: () => ({ reservations: world.reservations, measuredBytes: world.measuredBytes, limits, resident: (id: string) => id === "p1-lair" && world.masterResident }),
    take: () => { world.reservations += 1 },
  }, true)
  return { s, id: String(started.object_id), world, decide, limits }
}

test("A1 two workers woken together while an active council's master holds no slot: only the affordable one is admitted and the master's reserved memory is kept (memory binds, the slot limit does not)", async () => {
  const { s, world, decide } = await admissionStage()
  try {
    const gate = heldStore(s.runner)
    const first = decide(gate.store, "p1-w1")
    const second = decide(gate.store, "p1-w2")
    expect(world.reservations, "both are suspended at the store's answer: nothing has been decided or reserved").toBe(0)
    gate.release()
    const results = await Promise.all([first, second])
    // Deciding on the memory read BEFORE the wait, both saw none used and both fit beside the master's reserve.
    expect(results.map(one => one.admitted).sort()).toEqual([false, true])
    expect(world.reservations, "one child was reserved, and the master's room is the other one").toBe(1)
    const refused = results.find(one => !one.admitted)!
    expect(refused).toMatchObject({ admitted: false, held: ["p1-lair"], roomByCount: true, usedMb: 1024 })
  } finally { await s.close() }
}, 60_000)

test("A2 the master's occupancy is read at the decision, after the wait: a master that took its slot while the callers were suspended needs no room kept, and one that gave it up needs it back", async () => {
  const { s, world, decide } = await admissionStage()
  try {
    // Unloaded when they asked, resident when they resume: nothing more is kept for it, so both workers fit.
    let gate = heldStore(s.runner)
    let pair = [decide(gate.store, "p1-w1"), decide(gate.store, "p1-w2")]
    world.masterResident = true
    gate.release()
    expect((await Promise.all(pair)).map(one => one.admitted)).toEqual([true, true])
    expect(world.reservations).toBe(2)

    // Resident when they asked, gone when they resume: its room is kept again, and only one worker is admitted.
    world.reservations = 0
    gate = heldStore(s.runner)
    pair = [decide(gate.store, "p1-w1"), decide(gate.store, "p1-w2")]
    world.masterResident = false
    gate.release()
    expect((await Promise.all(pair)).map(one => one.admitted).sort()).toEqual([false, true])
    expect(world.reservations).toBe(1)
  } finally { await s.close() }
}, 60_000)

test("A3 the memory measured while the callers were suspended is what the decision sees, and a council that ended while they were suspended keeps no room", async () => {
  const { s, id, world, decide } = await admissionStage()
  try {
    // The children were measured to hold 1500 MB in the meantime: with the master's room kept, neither worker fits.
    let gate = heldStore(s.runner)
    let pair = [decide(gate.store, "p1-w1"), decide(gate.store, "p1-w2")]
    world.measuredBytes = 1500 * 1048576
    gate.release()
    const results = await Promise.all(pair)
    expect(results.map(one => one.admitted)).toEqual([false, false])
    expect(world.reservations).toBe(0)
    expect(results[0]).toMatchObject({ held: ["p1-lair"], usedMb: 1500 })

    // The council is over when the store answers: nobody's room is kept, and both workers fit.
    world.measuredBytes = 0
    await s.su`update council set lifecycle = 'stopped' where id = ${id}`
    gate = heldStore(s.runner)
    pair = [decide(gate.store, "p1-w1"), decide(gate.store, "p1-w2")]
    gate.release()
    expect((await Promise.all(pair)).map(one => one.admitted)).toEqual([true, true])
  } finally { await s.close() }
}, 60_000)
