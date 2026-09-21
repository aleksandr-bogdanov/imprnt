// A job's report can only go back the way the job came, and a job that names no
// way back cannot be reported on at all.
//
// The report is written by `hub_report` from the job's pinned return route, so
// a job carrying an approval and no complete route would have its task run by
// the model and then fail to settle on every attempt, running again each time.
// The door always pins a route, so such a row only exists by going around the
// door, and the runner refuses it as unapproved before any child is started.
// The control is the same planted job with its route whole.
import { afterAll, beforeAll, expect, test } from "bun:test"
import { startCluster, until, type Cluster } from "./helpers/cluster.ts"
import { rolloutStage, DISPATCH_TARGET } from "./helpers/rollout-stage.ts"
import { NOT_APPROVED } from "../src/runner/job.ts"
import { taskDigest } from "../src/door/dispatch.ts"
import { runRunner } from "../src/runner/run.ts"

let cluster: Cluster
beforeAll(async () => { cluster = await startCluster() })
afterAll(async () => { await cluster?.stop() })

const LAIR_CHAT = "1000000001"
const TASK = "weigh the synthetic codeword"
const WHOLE = { agent: "p1-lair", door: "door-fake", chat: LAIR_CHAT }

async function plant(it: Awaited<ReturnType<typeof rolloutStage>>, route: Record<string, unknown> | null) {
  // Sent as TEXT and parsed by the database. A string handed straight to a
  // jsonb parameter is stored as a JSON string, whose `dispatch` key does not
  // exist, and every job planted that way is refused whatever it says.
  await it.read.sql(
    `insert into inbound (id, person, agent, body, kind, source, log_ready)
     values ($1, 'p1', $2, $3, 'job', $4::text::jsonb, true)`,
    ["planted", DISPATCH_TARGET, TASK, JSON.stringify({
      log_id: "planted", at: new Date().toISOString(), door: "door-fake", chat: "1000000002",
      from: "p1", text: TASK,
      dispatch: { dispatcher: "p1-lair", target: DISPATCH_TARGET,
        approved: { by: "p1", at: new Date().toISOString(), digest: taskDigest(TASK), source: "chat-command" },
        ...(route === null ? {} : { return: route }) },
    })])
  const [stored] = await it.read.sql(`select jsonb_typeof(source) as shape, source->'dispatch'->'approved'->>'digest' as digest
    from inbound where id = 'planted'`)
  expect(stored).toEqual({ shape: "object", digest: taskDigest(TASK) })
}

for (const [shape, route] of [
  ["no return route", null],
  ["a return route with no chat", { agent: "p1-lair", door: "door-fake" }],
  ["a return route with no agent", { door: "door-fake", chat: LAIR_CHAT }],
  ["a return route whose door is empty", { ...WHOLE, door: "" }],
] as const) {
  test(`an approved job with ${shape} is refused before the model runs, and settles once`, async () => {
    const it = await rolloutStage(cluster, "telegram", { dispatch: true, adapter: { answer: () => "an answer" } })
    let runner: Awaited<ReturnType<typeof runRunner>> | undefined
    try {
      await plant(it, route)
      runner = await runRunner({ runner: "runner-pi", registryFile: it.registryFile,
        adapters: { [it.adapterName]: it.scripted.adapter } })
      await until("the planted job is settled or fed", async () =>
        (await it.read.inbound()).find(r => r.id === "planted")!.state === "answered" ||
        it.scripted.fed().some(f => f.id === "planted"), 30_000)
      expect(it.scripted.fed().map(f => f.id), "the model was handed a job with no way back").not.toContain("planted")
      await until("the planted job is settled", async () =>
        (await it.read.inbound()).find(r => r.id === "planted")!.state === "answered", 30_000)
      const refusals = (await it.read.ledger()).filter(e => e.kind === "dispatch.refused")
      expect(refusals).toHaveLength(1)
      expect(refusals[0].detail).toMatchObject({ cause: NOT_APPROVED })
      expect((await it.read.inbound()).filter(r => r.kind === "report")).toEqual([])
    } finally { await runner?.stop(); await it.stop() }
  }, 90_000)
}

test("the same planted job with its return route whole is fed once and reported once", async () => {
  const it = await rolloutStage(cluster, "telegram", { dispatch: true, adapter: { answer: () => "an answer" } })
  let runner: Awaited<ReturnType<typeof runRunner>> | undefined
  try {
    await plant(it, WHOLE)
    runner = await runRunner({ runner: "runner-pi", registryFile: it.registryFile,
      adapters: { [it.adapterName]: it.scripted.adapter } })
    await until("the report lands", async () => (await it.read.inbound()).some(r => r.kind === "report"), 30_000)
    expect(it.scripted.fed().filter(f => f.id === "planted").map(f => f.text)).toEqual([TASK])
    expect((await it.read.inbound()).filter(r => r.kind === "report").map(r => r.id)).toEqual(["report:planted"])
    expect((await it.read.ledger()).filter(e => e.kind === "dispatch.refused")).toEqual([])
  } finally { await runner?.stop(); await it.stop() }
}, 90_000)
