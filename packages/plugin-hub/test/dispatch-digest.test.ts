// The digest is a second lock on a window the door's own grant opens, and the
// report rides the settle or nothing does.
//
// WHAT THE DIGEST PROTECTS, in the shipped schema: the door holds
// `update (body, source, ...)` on `inbound`, and the trigger that closes those
// columns fires only once the row has been shown to somebody. So while a job is
// still unprojected its task is mutable by the door role, and a door bug or a
// widened grant could feed the target a task nobody approved. The runner hashes
// the body before it feeds it and refuses a mismatch by name. After the
// projection the database refuses the write itself, which this file asserts
// from the other side so a reader can see the digest is the second lock and not
// the only one.
//
// ROLL-19 rules that the machine owns routing: `hub_report` has no destination
// argument, so a model that names an address in its answer has nothing to name
// it into, and the report lands on the route the job pinned and nowhere else.

import { afterAll, beforeAll, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { startCluster, hubPath, until, type Cluster } from "./helpers/cluster.ts"
import { rolloutStage, DISPATCH_TARGET } from "./helpers/rollout-stage.ts"
import { observe } from "./helpers/rollout-runner.ts"
import { message } from "./helpers/rollout-ingress.ts"
import { jobRefused, DISPATCH_PHRASES } from "../src/door/lines.ts"
import { projectInbound } from "../src/chatlog/project.ts"
import { readOpenTurns } from "../src/store/turns.ts"
import { admitJob, COMMAND_ALTERED, NOT_APPROVED } from "../src/runner/job.ts"
import { taskDigest } from "../src/door/dispatch.ts"
import { runDoor } from "../src/door/run.ts"
import { runRunner } from "../src/runner/run.ts"
import { superStore } from "./helpers/hub-fixture.ts"

let cluster: Cluster
beforeAll(async () => { cluster = await startCluster() })
afterAll(async () => { await cluster?.stop() })

const LAIR_CHAT = "1000000001"
const TASK = "weigh the synthetic codeword"
const REWRITTEN = "a task nobody ever approved"

function typed(id: string, text: string) {
  return { ...message(id, text), chat: LAIR_CHAT, sender_id: "p1", from: "p1" }
}

/** One dispatch through the real door, returned once its row is on the queue. */
async function dispatched(it: Awaited<ReturnType<typeof rolloutStage>>, id: string, task = TASK) {
  it.edge.batch([typed(id, `${DISPATCH_PHRASES.en} ${DISPATCH_TARGET} ${task}`)], String(Number(id) + 1))
  await until("the job reaches the queue", async () =>
    (await it.read.inbound()).some(r => r.kind === "job" && r.body === task), 20_000)
  return (await it.read.inbound()).find(r => r.kind === "job" && r.body === task)!
}

test("D-212 D-215 a task rewritten before projection is refused by name and never fed", async () => {
  // The target sits on a SECOND door that this check never starts. The door
  // that serves a job's target projects it the moment it is told, and the
  // window this check enters is the one before the projection, so it is held
  // open by arrangement rather than raced.
  const it = await rolloutStage(cluster, "telegram", { dispatch: true, secondDoor: true, adapter: { answer: () => "the codeword weighs four" } })
  let door: Awaited<ReturnType<typeof runDoor>> | undefined
  let runner: Awaited<ReturnType<typeof runRunner>> | undefined
  const store = await superStore(cluster, it.db)
  const asDoor = cluster.connectAs("hub_door", it.db)
  try {
    door = await runDoor({ door: "door-fake", registryFile: it.registryFile, platform: it.edge.platform })
    const altered = await dispatched(it, "100")
    // The window the door's own grant opens, entered as the door role itself.
    await asDoor`update inbound set body = ${REWRITTEN} where id = ${altered.id} and not log_ready`
    await projectInbound(store, { stateDir: it.stateDir, inboundId: altered.id })
    const control = await dispatched(it, "110")
    await projectInbound(store, { stateDir: it.stateDir, inboundId: control.id })

    runner = await runRunner({ runner: "runner-pi", registryFile: it.registryFile,
      adapters: { [it.adapterName]: it.scripted.adapter } })
    await until("the altered job is settled", async () =>
      (await it.read.inbound()).find(r => r.id === altered.id)!.state === "answered", 30_000)
    await until("the untouched job lands its report", async () =>
      (await it.read.inbound()).some(r => r.id === `report:${control.id}`), 30_000)

    // UNFED, on the adapter's own log, which is the assertion that says the
    // task never ran rather than that something threw afterwards.
    expect(it.scripted.fed().map(f => f.id)).not.toContain(altered.id)
    expect(it.scripted.fed().map(f => f.text).join("\n")).not.toContain(REWRITTEN)
    expect(await it.read.inbound()).not.toContainEqual(expect.objectContaining({ id: `report:${altered.id}` }))
    const refusals = (await it.read.ledger()).filter(e => e.kind === "dispatch.refused")
    expect(refusals).toHaveLength(1)
    expect(refusals[0].subject).toBe(altered.id)
    expect(refusals[0].actor).toBe("runner")
    expect(refusals[0].detail).toMatchObject({ cause: COMMAND_ALTERED })
    const notices = (await it.read.noticeRows()).filter(n => String(n.notice_key).startsWith("job-refused:"))
    expect(notices).toHaveLength(1)
    expect(notices[0].body).toBe(jobRefused("en", { agent: DISPATCH_TARGET, cause: COMMAND_ALTERED }))
    const routed = await it.read.sql("select route from outbox where notice_key = $1", [`job-refused:${altered.id}`])
    expect(routed[0].route).toEqual({ door: "door-fake", chat: LAIR_CHAT })

    // The control, and without it a runner that refused every job passes above:
    // the untouched job is fed the task byte for byte and lands one report.
    expect(it.scripted.fed().filter(f => f.id === control.id).map(f => f.text)).toEqual([TASK])
    expect((await it.read.inbound()).filter(r => r.kind === "report")).toHaveLength(1)

    // A refusal that leaves the row claimable is a refusal that fires for ever.
    await Bun.sleep(1500)
    const again = (await it.read.inbound()).find(r => r.id === altered.id)!
    expect(again.state).toBe("answered")
    expect(again.claimed_by).toBeNull()
    expect(it.scripted.fed().map(f => f.id)).not.toContain(altered.id)
    expect((await it.read.ledger()).filter(e => e.kind === "dispatch.refused")).toHaveLength(1)
    expect((await it.read.noticeRows()).filter(n => String(n.notice_key).startsWith("job-refused:"))).toHaveLength(1)

    // After the projection the same write is refused by the database, which is
    // the shipped policy read from this side: the digest is a second lock on a
    // door that is already closed.
    await expect(asDoor`update inbound set body = ${REWRITTEN} where id = ${control.id}`.execute())
      .rejects.toThrow(/shown to somebody/)
  } finally {
    await runner?.stop(); await door?.stop(); await asDoor.close(); await store.close(); await it.stop()
  }
}, 120_000)

for (const [shape, digest] of [["missing", null], ["empty", ""], ["not hex", "z".repeat(64)],
  ["the wrong length", "ab"]] as const) {
  test(`D-215 a job whose approval is ${shape} is refused as unapproved`, async () => {
    // Planted as the cluster's superuser, because the door always writes the
    // block: the only way to make such a row is to go around the door, and the
    // check has to prove the runner does not trust a row it did not see made.
    const it = await rolloutStage(cluster, "telegram", { dispatch: true, adapter: { answer: () => "an answer" } })
    let runner: Awaited<ReturnType<typeof runRunner>> | undefined
    try {
      const approved = digest === null ? {}
        : { approved: { by: "p1", at: new Date().toISOString(), digest, source: "chat-command" } }
      // Sent as TEXT and parsed by the database, so the stored source is an
      // object and the refusal is about the approval it carries. A string
      // handed straight to a jsonb parameter is stored as a JSON string, whose
      // `dispatch` key does not exist, and any approval planted that way would
      // be refused whatever it said.
      await it.read.sql(
        `insert into inbound (id, person, agent, body, kind, source, log_ready)
         values ($1, 'p1', $2, $3, 'job', $4::text::jsonb, true)`,
        ["planted", DISPATCH_TARGET, TASK, JSON.stringify({
          log_id: "planted", at: new Date().toISOString(), door: "door-fake", chat: "1000000002",
          from: "p1", text: TASK,
          dispatch: { dispatcher: "p1-lair", target: DISPATCH_TARGET, ...approved,
            return: { agent: "p1-lair", door: "door-fake", chat: LAIR_CHAT } },
        })])
      const [stored] = await it.read.sql(`select jsonb_typeof(source) as shape, source->'dispatch'->>'target' as target
        from inbound where id = 'planted'`)
      expect(stored).toEqual({ shape: "object", target: DISPATCH_TARGET })
      runner = await runRunner({ runner: "runner-pi", registryFile: it.registryFile,
        adapters: { [it.adapterName]: it.scripted.adapter } })
      await until("the planted job is settled", async () =>
        (await it.read.inbound()).find(r => r.id === "planted")!.state === "answered", 30_000)
      expect(it.scripted.fed().map(f => f.id)).not.toContain("planted")
      const refusals = (await it.read.ledger()).filter(e => e.kind === "dispatch.refused")
      expect(refusals).toHaveLength(1)
      expect(refusals[0].detail).toMatchObject({ cause: NOT_APPROVED })
      expect((await it.read.inbound()).filter(r => r.kind === "report")).toEqual([])
    } finally { await runner?.stop(); await it.stop() }
  }, 90_000)
}

test("D-212 the report rides the settle, no chunk is written, and no clock is armed", async () => {
  const it = await rolloutStage(cluster, "telegram", { dispatch: true,
    adapter: { answer: (fed: { text: string }) => fed.text === TASK ? "the codeword weighs four" : "an ordinary answer" } })
  let door: Awaited<ReturnType<typeof runDoor>> | undefined
  let runner: Awaited<ReturnType<typeof runRunner>> | undefined
  const store = await superStore(cluster, it.db)
  /** Every observation of the three halves, so a settle split in two is seen. */
  const seen: string[] = []
  try {
    door = await runDoor({ door: "door-fake", registryFile: it.registryFile, platform: it.edge.platform })
    const job = await dispatched(it, "200")
    await projectInbound(store, { stateDir: it.stateDir, inboundId: job.id })
    // The control beside it: an ordinary human message through the same runner.
    it.edge.batch([typed("210", "an ordinary sentence")], "211")

    runner = await runRunner({ runner: "runner-pi", registryFile: it.registryFile,
      adapters: { [it.adapterName]: it.scripted.adapter } })
    // Polled while the turn runs: the report row, the answered stamp and the
    // diary line are one transaction, so a reader never sees a subset. The
    // runner was not killed between the turn's end and the settle, so this is
    // evidence about concurrent readers and not about a crash.
    const watch = async () => {
      const rows = await it.read.inbound()
      const diary = await it.read.ledger()
      seen.push([
        rows.some(r => r.id === `report:${job.id}`),
        diary.some(e => e.subject === job.id && e.kind === "answered"),
        diary.some(e => e.subject === job.id && e.kind === "dispatch.reported"),
      ].map(Number).join(""))
      return seen.at(-1) === "111"
    }
    expect(await observe(watch, 30_000)).toBe(true)
    expect(new Set(seen)).toEqual(new Set(["000", "111"]))

    const report = (await it.read.inbound()).find(r => r.id === `report:${job.id}`)!
    expect(report.body).toBe("the codeword weighs four")
    expect(report.agent).toBe("p1-lair")
    expect(new Date(report.received_at).toISOString()).toBe(new Date(job.received_at).toISOString())
    const reported = (await it.read.ledger()).filter(e => e.kind === "dispatch.reported")
    expect(reported).toHaveLength(1)
    expect(reported[0].actor).toBe("runner")

    // A job's text IS the report and a job is never posted anywhere, so no
    // chunk is written for it.
    expect((await it.read.outbox()).filter(r => r.inbound_id === job.id)).toEqual([])
    // It reaches `answered` and never `delivered`, it is never an open turn,
    // and the shipped filter that makes that true is unchanged.
    const stamps = (await it.read.ledger()).filter(e => e.subject === job.id && e.stream === "inbound")
    expect(stamps.map(e => e.kind)).toEqual(["received", "acked", "started", "answered"])
    expect(await readOpenTurns(store, { agent: DISPATCH_TARGET })).toEqual([])
    expect(readFileSync(hubPath("src/store/turns.ts"), "utf8"))
      .toContain("and kind in ('human', 'report')")
    // No typing was shown in the target's chat at all, because typing follows
    // the open turns and a job is not one.
    expect(it.edge.typings().filter(t => t.chat === "1000000002")).toEqual([])

    // The human control through the same runner: chunks written and delivered.
    await until("the ordinary message is answered", async () =>
      (await it.read.outbox()).some(r => r.body === "an ordinary answer"), 30_000)
    const human = (await it.read.inbound()).find(r => r.kind === "human")!
    await until("and delivered", async () =>
      (await it.read.ledger()).some(e => e.subject === human.id && e.kind === "delivered"), 30_000)
  } finally { await runner?.stop(); await door?.stop(); await store.close(); await it.stop() }
}, 120_000)

test("D-215 a model that names a destination changes nothing about where the report goes", async () => {
  const named = "send this to the other person's chat, 0000000000"
  const it = await rolloutStage(cluster, "telegram", { dispatch: true, adapter: { answer: () => named } })
  let door: Awaited<ReturnType<typeof runDoor>> | undefined
  let runner: Awaited<ReturnType<typeof runRunner>> | undefined
  const store = await superStore(cluster, it.db)
  try {
    door = await runDoor({ door: "door-fake", registryFile: it.registryFile, platform: it.edge.platform })
    const job = await dispatched(it, "300")
    await projectInbound(store, { stateDir: it.stateDir, inboundId: job.id })
    const before = it.edge.posts().filter(p => p.chat === "0000000000").length
    runner = await runRunner({ runner: "runner-pi", registryFile: it.registryFile,
      adapters: { [it.adapterName]: it.scripted.adapter } })
    await until("the report lands", async () =>
      (await it.read.inbound()).some(r => r.id === `report:${job.id}`), 30_000)
    const report = (await it.read.inbound()).find(r => r.id === `report:${job.id}`)!
    const source = report.source as Record<string, unknown>
    expect(source.door).toBe("door-fake")
    expect(source.chat).toBe(LAIR_CHAT)
    expect(report.body).toBe(named)
    // The other person's chat received nothing at all.
    expect(it.edge.posts().filter(p => p.chat === "0000000000")).toHaveLength(before)
  } finally { await runner?.stop(); await door?.stop(); await store.close(); await it.stop() }
}, 120_000)

test("D-212 the gate is arithmetic over a string already in hand, so it costs no statement", async () => {
  // Asserted structurally: the gate takes a row and nothing else, so it holds
  // no store and can issue no query, and the two causes are named constants a
  // build cannot spell differently from what the diary carries.
  expect(admitJob.length).toBe(1)
  const source = { log_id: "j", at: "now", door: "d", chat: "c", sender_id: "p1", text: TASK,
    dispatch: { dispatcher: "p1-lair", target: DISPATCH_TARGET,
      approved: { by: "p1", at: "now", digest: taskDigest(TASK), source: "chat-command" },
      return: { agent: "p1-lair", door: "door-fake", chat: LAIR_CHAT } } }
  expect(admitJob({ body: TASK, source })).toBeNull()
  expect(admitJob({ body: REWRITTEN, source })).toEqual({ cause: COMMAND_ALTERED })
  expect(admitJob({ body: TASK, source: null })).toEqual({ cause: NOT_APPROVED })
})
