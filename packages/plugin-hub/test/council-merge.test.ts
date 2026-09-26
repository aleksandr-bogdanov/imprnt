// The seats' answers never reach the chat. Each seat's settle records its
// report answered so it is never fed, puts the answer into the council's sheet
// row, and the last one writes ONE merge row for the dispatching agent. A
// refused seat closes the council with "no answer" in its place, and a
// replayed settle lands nothing twice.

import { afterAll, beforeAll, expect, test } from "bun:test"
import { startCluster, type Cluster } from "./helpers/cluster.ts"
import { rolloutStage, COUNCIL_SEATS } from "./helpers/rollout-stage.ts"
import { superStore } from "./helpers/hub-fixture.ts"
import { requestCouncil } from "../src/door/dispatch.ts"
import { COUNCIL_SHEET, MERGE_INSTRUCTION, mergeIdOf } from "../src/door/council.ts"
import { jobRefused } from "../src/door/lines.ts"
import { loadRegistry } from "../src/registry/load.ts"
import { NOT_APPROVED, refuseJob } from "../src/runner/job.ts"
import { settleTurn, type TurnRecord } from "../src/runner/settle.ts"
import { openStore, storeUrlAs, type Store } from "../src/store/connect.ts"
import { readEligible } from "../src/store/wake.ts"

let cluster: Cluster
beforeAll(async () => { cluster = await startCluster() })
afterAll(async () => { await cluster?.stop() })

const LAIR_CHAT = "1000000001"
const QUESTION = "should the synthetic ledger be weighed twice"
const ANSWERS: Record<string, string> = {
  "p1-seat-1": "Weigh it twice. The first reading drifts.",
  "p1-seat-2": "Once is enough when the scale is warm. Unsure about cold starts.",
  "p1-seat-3": "Twice, and log both readings.",
}

function turnOf(agent: string): TurnRecord {
  return { agent, runner: "runner-pi", preset: "daily", preset_id: "p", preset_settings: {}, input_tokens: 1, cached_input_tokens: 0,
    output_tokens: 1, price: null, plan_usage: null, raw_usage: {}, session_id: null, lacks: [], tail: false }
}

type Stage = Awaited<ReturnType<typeof rolloutStage>>

async function convene(it: Stage, store: Store, base: string) {
  const registry = loadRegistry(it.registryFile)
  const made = await requestCouncil(store, { base, registry, person: "p1", door: "door-fake", chat: LAIR_CHAT,
    agent: "p1-lair", sender_id: "p1", question: QUESTION, at: new Date().toISOString() })
  const jobs = (await it.read.inbound()).filter(r => r.kind === "job" && String(r.id).startsWith(made.id + ":"))
  expect(jobs).toHaveLength(COUNCIL_SEATS.length)
  return { ...made, registry, jobs }
}

/** The settle the runner does at the end of a seat's turn, with the job's own provenance. */
async function settleSeat(runner: Store, job: { id: string; source: unknown; agent: string }, answer: string) {
  await settleTurn(runner, { inboundId: job.id, kind: "job", person: "p1", source: job.source as never, chunks: [answer], turn: turnOf(job.agent) })
}

test("three seats settle one at a time: each report is answered and never fed, the third lands exactly one merge row and removes the sheet row, and a replay lands nothing twice", async () => {
  const it = await rolloutStage(cluster, "telegram", { council: true })
  const store = await superStore(cluster, it.db)
  // The settling store is the RUNNER's role, so the merge function's grant is
  // what this exercises and not the superuser.
  const runner = await openStore({ url: storeUrlAs(cluster.url(it.db), "hub_runner") })
  try {
    const council = await convene(it, store, "telegram:" + LAIR_CHAT + ":100")
    const at = (await it.read.sheet(COUNCIL_SHEET))[0].data.at as string
    for (const [nth, seat] of COUNCIL_SEATS.entries()) {
      const job = council.jobs.find(j => j.agent === seat)!
      await settleSeat(runner, job, ANSWERS[seat])
      const rows = await it.read.inbound()
      const report = rows.find(r => r.id === `report:${job.id}`)!
      expect(report).toBeDefined()
      expect(report.agent).toBe("p1-lair")
      expect(report.kind).toBe("report")
      expect(report.state).toBe("answered")
      expect((report.source as Record<string, unknown>).origin).toBe("council")
      expect(rows.find(r => r.id === job.id)!.state).toBe("answered")
      // Even once the door has projected it, the dispatcher's eligible read leaves it alone.
      await it.read.sql("update inbound set log_ready = true where id = $1", [report.id])
      expect((await readEligible(store, { agent: "p1-lair" })).map(r => r.id)).not.toContain(report.id)
      const merges = rows.filter(r => String(r.id).startsWith("merge:"))
      const sheet = await it.read.sheet(COUNCIL_SHEET)
      if (nth < COUNCIL_SEATS.length - 1) {
        expect(merges).toEqual([])
        expect(sheet).toHaveLength(1)
        expect(sheet[0].data.answered).toEqual(Object.fromEntries(COUNCIL_SEATS.slice(0, nth + 1).map(one => [one, ANSWERS[one]])))
        expect((await readEligible(store, { agent: "p1-lair" }))).toEqual([])
      } else {
        expect(merges).toHaveLength(1)
        expect(sheet).toEqual([])
      }
    }
    // The merge row, whole.
    const merge = (await it.read.inbound()).find(r => r.id === mergeIdOf(council.id))!
    expect(merge).toMatchObject({ kind: "report", rank: 0, agent: "p1-lair", person: "p1", state: "received", log_ready: false })
    expect(new Date(merge.received_at).toISOString()).toBe(new Date(at).toISOString())
    expect(merge.reported_at).not.toBeNull()
    expect(merge.source).toEqual({ log_id: mergeIdOf(council.id), at: expect.any(String), door: "door-fake", chat: LAIR_CHAT,
      from: "council", text: merge.body, council: council.id, origin: "council" })
    expect(merge.body).toBe([
      `Question:\n${QUESTION}`,
      `Seat 1:\n${ANSWERS["p1-seat-1"]}`,
      `Seat 2:\n${ANSWERS["p1-seat-2"]}`,
      `Seat 3:\n${ANSWERS["p1-seat-3"]}`,
      MERGE_INSTRUCTION,
    ].join("\n\n"))
    for (const seat of COUNCIL_SEATS) expect(merge.body).not.toContain(seat)
    // Once it is projected it is the one row the dispatcher is fed, ahead of anything later.
    await it.read.sql("update inbound set log_ready = true where id = $1", [merge.id])
    expect((await readEligible(store, { agent: "p1-lair" })).map(r => r.id)).toEqual([merge.id])
    const merged = await it.read.ledger({ kind: "council.merged" })
    expect(merged).toHaveLength(1)
    expect(merged[0]).toMatchObject({ subject: council.id, actor: "runner" })
    expect(merged[0].detail).toMatchObject({ agent: "p1-lair", seats: COUNCIL_SEATS, answered: COUNCIL_SEATS, silent: [] })

    // A replayed settle of the last seat: no second report, no second merge, no second diary line.
    const last = council.jobs.find(j => j.agent === COUNCIL_SEATS[2])!
    await settleSeat(runner, last, ANSWERS[COUNCIL_SEATS[2]])
    const rows = await it.read.inbound()
    expect(rows.filter(r => String(r.id).startsWith("merge:"))).toHaveLength(1)
    expect(rows.filter(r => r.id === `report:${last.id}`)).toHaveLength(1)
    expect(await it.read.ledger({ kind: "council.merged" })).toHaveLength(1)
    expect(await it.read.ledger({ subject: merge.id, kind: "received" })).toHaveLength(1)
    expect(await it.read.sheet(COUNCIL_SHEET)).toEqual([])
  } finally { await runner.close(); await store.close(); await it.stop() }
}, 60_000)

test("a refused seat leaves no answer and still completes the council, whose merge says so in its place", async () => {
  const it = await rolloutStage(cluster, "telegram", { council: true })
  const store = await superStore(cluster, it.db)
  const runner = await openStore({ url: storeUrlAs(cluster.url(it.db), "hub_runner") })
  try {
    const council = await convene(it, store, "telegram:" + LAIR_CHAT + ":200")
    // The first seat is refused by the runner's own gate path, as a job whose
    // approval is not a digest would be.
    const dead = council.jobs.find(j => j.agent === COUNCIL_SEATS[0])!
    await refuseJob(runner, { row: { ...dead, source: dead.source as never, received_at: new Date(dead.received_at) } as never,
      refusal: { cause: NOT_APPROVED }, registry: council.registry, runner: "runner-pi" })
    expect((await it.read.inbound()).find(r => r.id === dead.id)!.state).toBe("answered")
    expect((await it.read.inbound()).find(r => r.id === `report:${dead.id}`)).toBeUndefined()
    let sheet = await it.read.sheet(COUNCIL_SHEET)
    expect(sheet).toHaveLength(1)
    expect(sheet[0].data.answered).toEqual({ [COUNCIL_SEATS[0]]: null })
    // The person reads that the seat was refused, on the route the question came in on.
    expect((await it.read.noticeRows()).map(one => one.body)).toContain(jobRefused("en", { agent: COUNCIL_SEATS[0], cause: NOT_APPROVED }))
    // The two live seats settle, and the second of them lands the merge.
    await settleSeat(runner, council.jobs.find(j => j.agent === COUNCIL_SEATS[1])!, ANSWERS[COUNCIL_SEATS[1]])
    expect((await it.read.inbound()).filter(r => String(r.id).startsWith("merge:"))).toEqual([])
    await settleSeat(runner, council.jobs.find(j => j.agent === COUNCIL_SEATS[2])!, ANSWERS[COUNCIL_SEATS[2]])
    const merge = (await it.read.inbound()).find(r => r.id === mergeIdOf(council.id))!
    expect(merge).toBeDefined()
    expect(merge.body).toContain("Seat 1:\nno answer")
    expect(merge.body).toContain(`Seat 2:\n${ANSWERS[COUNCIL_SEATS[1]]}`)
    expect(merge.body).toContain(`Seat 3:\n${ANSWERS[COUNCIL_SEATS[2]]}`)
    expect(await it.read.sheet(COUNCIL_SHEET)).toEqual([])
    const merged = await it.read.ledger({ kind: "council.merged" })
    expect(merged).toHaveLength(1)
    expect(merged[0].detail).toMatchObject({ answered: COUNCIL_SEATS.slice(1), silent: [COUNCIL_SEATS[0]] })
    // A replayed refusal of the dead seat after the merge lands nothing.
    await refuseJob(runner, { row: { ...dead, source: dead.source as never, received_at: new Date(dead.received_at) } as never,
      refusal: { cause: NOT_APPROVED }, registry: council.registry, runner: "runner-pi" })
    expect((await it.read.inbound()).filter(r => String(r.id).startsWith("merge:"))).toHaveLength(1)
    expect(await it.read.sheet(COUNCIL_SHEET)).toEqual([])
  } finally { await runner.close(); await store.close(); await it.stop() }
}, 60_000)
