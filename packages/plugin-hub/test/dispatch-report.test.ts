// The report comes back into the dispatcher's own chat at the right place in
// the queue, in the target's name, and the door hears about a row the runner
// caused.
//
// THE ORDER IS PLANTED IN THE ARRANGEMENT THAT FAILS. The dispatcher's runner is
// stopped, a job is dispatched, a human message to the dispatcher is accepted,
// the job is settled on the target's runner, and only then does the
// dispatcher's runner start. A report stamped with the moment it finished sorts
// after that human message and is fed second, which is a person answered out of
// order. A report carrying the job's own arrival stamp sorts ahead of it. A
// check that let the report land before the human message arrived would pass
// under both, so it would prove nothing. The target is the agent that takes
// jobs alone, because it is the one agent that runs on a runner of its own and
// so the only way the dispatcher's runner can stay stopped while the job is
// worked.
//
// THE LINE. A report is the only row whose author is not the row's person, so
// its chat line names the agent that did the work. Every other line is still
// the row's person: the platform username a door writes into the provenance is
// display only, and the tail and a harvest know a speaker by registry id.
//
// THE PROJECTION. A row the runner inserted has no door process in its loop, so
// the store tells the door on a channel of its own and the door runs the one
// sweep it already runs at startup. That listener is a THIRD connection per
// door process, beside the outbox waiter and the turn waiter, and it is one per
// process rather than one per agent, which is what makes it cheaper than either.
//
// Red reasons: behaviour absent. `projectInbound` writes every line as the row's
// person (`src/chatlog/project.ts:24`), and the door holds no LISTEN on
// `hub_project`, so a report inserted while the door runs is never projected,
// never becomes claimable and is never fed at all.

import { afterAll, beforeAll, expect, test } from "bun:test"
import { startCluster, until, type Cluster } from "./helpers/cluster.ts"
import {
  rolloutStage,
  DISPATCHER,
  DISPATCH_JOB_ONLY,
  DISPATCH_RUNNER2,
  DISPATCH_TARGET,
  DISPATCH_TARGET_CHAT,
  DISPATCH_TARGET_DOOR2,
} from "./helpers/rollout-stage.ts"
import { rolloutPlatform } from "./helpers/rollout-platform.ts"
import { message } from "./helpers/rollout-ingress.ts"
import { scriptedReply } from "./helpers/scripted-adapter.ts"
import { chatLogLines } from "./helpers/hub-fixture.ts"
import { DISPATCH_PHRASES, dispatchAccepted } from "../src/door/lines.ts"
import { claimNext } from "../src/runner/claim.ts"
import { clockDeadlines } from "../src/door/clock.ts"
import { loadRegistry } from "../src/registry/load.ts"
import { thresholdsFor } from "../src/registry/entries.ts"
import { listenForWork } from "../src/store/listen.ts"
import { runDoor } from "../src/door/run.ts"
import { runRunner } from "../src/runner/run.ts"
import { superStore } from "./helpers/hub-fixture.ts"

let cluster: Cluster
beforeAll(async () => { cluster = await startCluster() })
afterAll(async () => { await cluster?.stop() })

const LAIR_CHAT = "1000000001"
const TASK_A = "weigh the first synthetic ledger"
const TASK_B = "weigh the second synthetic ledger"
const REPORT_A = "the first ledger weighs four"
const REPORT_B = "the second ledger weighs nine"
const QUESTION = "an ordinary question typed while the jobs ran"

type Stage = Awaited<ReturnType<typeof rolloutStage>>

function answers(fed: { text: string }): string {
  if (fed.text === TASK_A) return REPORT_A
  if (fed.text === TASK_B) return REPORT_B
  return scriptedReply(fed.text)
}

function typed(id: string, text: string) {
  return { ...message(id, text), chat: LAIR_CHAT, sender_id: "p1", from: "p1" }
}

async function dispatched(it: Stage, id: string, target: string, task: string) {
  it.edge.batch([typed(id, `${DISPATCH_PHRASES.en} ${target} ${task}`)], String(Number(id) + 1))
  await until("the job reaches the queue", async () =>
    (await it.read.inbound()).some(r => r.kind === "job" && r.body === task), 20_000)
  return (await it.read.inbound()).find(r => r.kind === "job" && r.body === task)!
}

/** A chat log's lines, with the id every projected line carries. */
function logOf(stateDir: string, person: string, agent: string) {
  return chatLogLines(stateDir, person, agent) as (ReturnType<typeof chatLogLines>[number] & { id?: string })[]
}

/** The backends of one role holding a LISTEN on one channel, read off the server's activity view. */
async function listeners(it: Stage, role: string, channel: string): Promise<number[]> {
  // A listening connection's last statement is its `listen`, and it sits idle
  // on it for the rest of its life. `pg_listening_channels()` would be the
  // direct answer, but it reports only for the backend that calls it.
  return ((await it.read.sql(
    `select pid from pg_stat_activity
      where datname = current_database() and usename = $1 and state = 'idle' and query = $2
      order by pid`, [role, `listen ${channel}`])) as { pid: number }[]).map(one => Number(one.pid))
}

test("D-213 a report is fed before the message that arrived while its job ran, carries the job's own arrival, and speaks in the target's name", async () => {
  const it = await rolloutStage(cluster, "telegram", { dispatch: true, adapter: { answer: answers } })
  let door: Awaited<ReturnType<typeof runDoor>> | undefined
  let spoke: Awaited<ReturnType<typeof runRunner>> | undefined
  let hub: Awaited<ReturnType<typeof runRunner>> | undefined
  const work: string[] = []
  const heard = await listenForWork({ url: cluster.url(it.db), channel: "hub_work", onNotify: payload => { work.push(payload) } })
  try {
    // The dispatcher's runner is not started until the very end.
    door = await runDoor({ door: "door-fake", registryFile: it.registryFile, platform: it.edge.platform })
    const jobA = await dispatched(it, "100", DISPATCH_JOB_ONLY, TASK_A)
    // An hour of job, planted rather than waited for: the report inherits this
    // stamp, and a clock measured from it would already have run out.
    await it.read.sql("update inbound set received_at = now() - interval '1 hour' where id = $1", [jobA.id])
    const jobB = await dispatched(it, "110", DISPATCH_JOB_ONLY, TASK_B)
    it.edge.batch([typed("120", QUESTION)], "121")
    await until("the question reaches the queue", async () =>
      (await it.read.inbound()).some(r => r.kind === "human" && r.body === QUESTION), 20_000)

    spoke = await runRunner({ runner: DISPATCH_RUNNER2, registryFile: it.registryFile,
      adapters: { [it.adapterName]: it.scripted.adapter } })
    await until("both reports land and are projected", async () => {
      const rows = await it.read.inbound()
      return [jobA, jobB].every(job => rows.some(r => r.id === `report:${job.id}` && r.log_ready))
    }, 30_000, async () => JSON.stringify((await it.read.inbound()).map(r => [r.id, r.log_ready])))
    // The spoke's own diary line for each settle lands in the same transaction
    // as its report, so this read is not ahead of the write it depends on.
    const settled = await it.read.ledger({ subject: jobA.id, kind: "answered" })
    expect(settled).toHaveLength(1)

    // --- The arrangement itself, on record, so an edit that reorders it fails
    //     visibly: dispatched, then the person spoke, then the job settled.
    const rows = await it.read.inbound()
    const human = rows.find(r => r.kind === "human" && r.body === QUESTION)!
    const reportA = rows.find(r => r.id === `report:${jobA.id}`)!
    const reportB = rows.find(r => r.id === `report:${jobB.id}`)!
    const t0 = new Date(rows.find(r => r.id === jobA.id)!.received_at).getTime()
    const t0b = new Date(rows.find(r => r.id === jobB.id)!.received_at).getTime()
    const t1 = new Date(human.received_at).getTime()
    const t2 = new Date(settled[0].at).getTime()
    expect(t0).toBeLessThan(t0b)
    expect(t0b).toBeLessThan(t1)
    expect(t1).toBeLessThan(t2)

    // --- 2. The job's own arrival, by value, and strictly earlier than the
    //     question's, because equality alone does not say the order holds.
    expect(new Date(reportA.received_at).getTime()).toBe(t0)
    expect(new Date(reportB.received_at).getTime()).toBe(t0b)
    expect(new Date(reportB.received_at).getTime()).toBeLessThan(t1)

    // --- 3. The queue's own order, before any dispatcher runner exists: two
    //     probes that each claim the next row they may. The runner claims with
    //     the statement's own `order by rank, received_at, id`, so this is the
    //     table's answer and not the runner's. Each probe's claim is released
    //     before the real runner starts.
    const store = await superStore(cluster, it.db)
    try {
      const order: string[] = []
      for (const probe of ["probe-a", "probe-b", "probe-c"]) {
        const next = await claimNext(store, { runner: probe, agent: DISPATCHER, leaseMs: 60_000 })
        order.push(next?.id ?? "nothing")
      }
      expect(order).toEqual([reportA.id, reportB.id, human.id])
      await store.sql`update inbound set claimed_by = null, claim_deadline = null where claimed_by like 'probe-%'`
    } finally { await store.close() }

    // --- 12. Marking a report ready is what woke the dispatcher's runner, on
    //     the shipped work channel and on nothing new.
    expect(work).toContain(DISPATCHER)

    // --- 1 and 4. Now the dispatcher's runner. Its first feed is its tail,
    //     and after that the order the person is answered in.
    hub = await runRunner({ runner: "runner-pi", registryFile: it.registryFile,
      adapters: { [it.adapterName]: it.scripted.adapter } })
    await until("all three are answered", async () =>
      (await it.read.outbox()).filter(r => [reportA.id, reportB.id, human.id].includes(String(r.inbound_id))).length === 3, 30_000)
    const fed = it.scripted.fed().filter(one => [reportA.id, reportB.id, human.id].includes(one.id)).map(one => one.id)
    expect(fed).toEqual([reportA.id, reportB.id, human.id])
    expect(it.scripted.fed().filter(one => one.id === reportA.id).map(one => one.text)).toEqual([REPORT_A])
    // No second channel on the runner side: the runners listen on the work
    // channel they always did and on nothing the projection added.
    expect(await listeners(it, "hub_runner", "hub_project")).toEqual([])
    expect((await listeners(it, "hub_runner", "hub_work")).length).toBeGreaterThan(0)

    // --- 4b. What the dispatcher's chat was told, WHOLE, once every reply is
    //     delivered. The answer this pins: nothing about a clock at all. The
    //     first report's job ran for an hour and the report was claimed and
    //     answered in seconds, so a line saying the agent has not answered
    //     would be false, and the second report is the control for a job that
    //     ran for no time.
    await until("all three replies are posted", async () =>
      it.edge.posts().filter(p => p.chat === LAIR_CHAT && p.text.startsWith("reply to ")).length === 3, 30_000)
    expect(it.edge.posts().filter(p => p.chat === LAIR_CHAT).map(p => p.text)).toEqual([
      dispatchAccepted("en", { agent: DISPATCH_JOB_ONLY }),
      dispatchAccepted("en", { agent: DISPATCH_JOB_ONLY }),
      scriptedReply(REPORT_A),
      scriptedReply(REPORT_B),
      scriptedReply(QUESTION),
    ])
    expect(await it.read.ledger({ stream: "clock" })).toEqual([])
    // And the arithmetic behind that silence, on the row this run produced: the
    // clock the door arms while a report is open runs from the moment the
    // report landed, not from the hour old question underneath it. The door
    // posting the false line when it does not is what
    // `test/dispatch-clock.test.ts` holds a report open to show, because a
    // report answered in milliseconds is rarely open when a door looks.
    const [stamped] = await it.read.sql("select received_at, reported_at from inbound where id = $1", [reportA.id]) as
      unknown as { received_at: Date; reported_at: Date }[]
    const landed = new Date(stamped.reported_at).getTime()
    expect(landed).toBeGreaterThan(t1)
    const thresholds = thresholdsFor(loadRegistry(it.registryFile), "p1")
    expect(clockDeadlines({ state: "acked", received_at: stamped.received_at, reported_at: stamped.reported_at }, thresholds))
      .toEqual([{ stamp: "started", at: landed + thresholds.started_seconds * 1000 }])

    // --- 5, 6 and 7. The lines in the dispatcher's own log.
    const lines = logOf(it.stateDir, "p1", DISPATCHER)
    const reportLine = lines.find(line => line.id === reportA.id)!
    expect(reportLine).toMatchObject({ direction: "in", from: DISPATCH_JOB_ONLY, text: REPORT_A })
    expect(reportLine.from).not.toBe("p1")
    const humanLine = lines.find(line => line.id === human.id)!
    expect(humanLine).toMatchObject({ direction: "in", from: "p1", text: QUESTION })
    for (const one of lines.filter(line => line.id?.startsWith("report:"))) {
      expect(one.text).not.toContain(jobA.id)
      expect(one.text).not.toContain(jobB.id)
      expect(one.text.toLowerCase()).not.toContain("dispatch")
    }
  } finally {
    await heard.close(); await hub?.stop(); await spoke?.stop(); await door?.stop(); await it.stop()
  }
}, 150_000)

test("D-213 a running door projects a report on its own channel, a door started afterwards projects it before it is ready, and the door holds one projection listener for all its agents", async () => {
  const it = await rolloutStage(cluster, "telegram", { dispatch: true, adapter: { answer: answers } })
  let door: Awaited<ReturnType<typeof runDoor>> | undefined
  let spoke: Awaited<ReturnType<typeof runRunner>> | undefined
  let hub: Awaited<ReturnType<typeof runRunner>> | undefined
  const told: string[] = []
  const heard = await listenForWork({ url: cluster.url(it.db), channel: "hub_project", onNotify: payload => { told.push(payload) } })
  try {
    door = await runDoor({ door: "door-fake", registryFile: it.registryFile, platform: it.edge.platform })

    // --- 11. ONE listener on the projection channel for a door that serves
    //     four agents. This is a third connection beside the outbox waiter and
    //     the turn waiter, and it is one per door process, not one per agent.
    expect(await listeners(it, "hub_door", "hub_project")).toHaveLength(1)

    // --- 8. A running, idle door: the report becomes ready with no restart,
    //     exactly one line is written for it, and the store told the door by
    //     its own id.
    const jobA = await dispatched(it, "200", DISPATCH_JOB_ONLY, TASK_A)
    spoke = await runRunner({ runner: DISPATCH_RUNNER2, registryFile: it.registryFile,
      adapters: { [it.adapterName]: it.scripted.adapter } })
    await until("the running door projects the report", async () =>
      (await it.read.inbound()).some(r => r.id === `report:${jobA.id}` && r.log_ready), 30_000)
    expect(told).toContain("door-fake")
    expect(logOf(it.stateDir, "p1", DISPATCHER).filter(line => line.id === `report:${jobA.id}`)).toHaveLength(1)

    // --- 9. The door is down while the next report lands. The one started
    //     afterwards has projected it by the time its start returns, on the
    //     sweep every door runs at startup,
    //     `select id from inbound where not log_ready and source->>'door' = <door>`.
    await spoke.stop(); spoke = undefined
    const jobB = await dispatched(it, "210", DISPATCH_JOB_ONLY, TASK_B)
    await door.stop(); door = undefined
    spoke = await runRunner({ runner: DISPATCH_RUNNER2, registryFile: it.registryFile,
      adapters: { [it.adapterName]: it.scripted.adapter } })
    await until("the second report lands while no door runs", async () =>
      (await it.read.inbound()).some(r => r.id === `report:${jobB.id}`), 30_000)
    expect((await it.read.inbound()).find(r => r.id === `report:${jobB.id}`)!.log_ready).toBe(false)
    door = await runDoor({ door: "door-fake", registryFile: it.registryFile, platform: it.edge.platform })
    const [ready] = await it.read.sql("select log_ready from inbound where id = $1", [`report:${jobB.id}`])
    expect(ready.log_ready).toBe(true)

    // The control: an ordinary message through the same door and a dispatcher
    // runner behaves exactly as it does today, all five stamps in order.
    hub = await runRunner({ runner: "runner-pi", registryFile: it.registryFile,
      adapters: { [it.adapterName]: it.scripted.adapter } })
    it.edge.batch([typed("230", QUESTION)], "231")
    await until("the question is delivered", async () => {
      const human = (await it.read.inbound()).find(r => r.kind === "human" && r.body === QUESTION)
      return human !== undefined && (await it.read.ledger({ subject: human.id, kind: "delivered" })).length === 1
    }, 30_000)
    const human = (await it.read.inbound()).find(r => r.kind === "human" && r.body === QUESTION)!
    expect((await it.read.ledger({ stream: "inbound", subject: human.id })).map(e => e.kind))
      .toEqual(["received", "acked", "started", "answered", "delivered"])
    expect(await listeners(it, "hub_door", "hub_project")).toHaveLength(1)
  } finally {
    await heard.close(); await hub?.stop(); await spoke?.stop(); await door?.stop(); await it.stop()
  }
}, 150_000)

test("D-213 a job is projected by the door that serves its target, whether that is the door that accepted the command or a second one", async () => {
  // THE ACCEPTING DOOR DOES NOT PROJECT A JOB INLINE. The command is parsed and
  // answered before the path that enqueues and projects an ordinary message,
  // so the job reaches the target's chat through the same notification and
  // the same sweep as every row a runner causes. One implementation, two doors.
  const it = await rolloutStage(cluster, "telegram", { dispatch: true, secondDoor: true, adapter: { answer: answers } })
  const other = rolloutPlatform("telegram")
  let door: Awaited<ReturnType<typeof runDoor>> | undefined
  let door2: Awaited<ReturnType<typeof runDoor>> | undefined
  const told: string[] = []
  const heard = await listenForWork({ url: cluster.url(it.db), channel: "hub_project", onNotify: payload => { told.push(payload) } })
  try {
    door = await runDoor({ door: "door-fake", registryFile: it.registryFile, platform: it.edge.platform })
    door2 = await runDoor({ door: DISPATCH_TARGET_DOOR2, registryFile: it.registryFile, platform: other.platform })

    // The Russian target sits on the accepting door itself.
    it.edge.batch([{ ...message("300", `${DISPATCH_PHRASES.ru} p2-research ${TASK_A}`), chat: "0000000000", sender_id: "p2", from: "p2" }], "301")
    await until("the accepting door projects the job for a target it serves", async () =>
      (await it.read.inbound()).some(r => r.kind === "job" && r.agent === "p2-research" && r.log_ready), 20_000)
    const own = (await it.read.inbound()).find(r => r.kind === "job" && r.agent === "p2-research")!
    expect(logOf(it.stateDir, "p2", "p2-research").filter(line => line.id === own.id))
      .toEqual([expect.objectContaining({ direction: "in", from: "p2", text: TASK_A })])

    // The first person's target sits on the second door, which projects it.
    const job = await dispatched(it, "310", DISPATCH_TARGET, TASK_B)
    expect((job.source as Record<string, unknown>).door).toBe(DISPATCH_TARGET_DOOR2)
    await until("the second door projects the job", async () =>
      (await it.read.inbound()).find(r => r.id === job.id)!.log_ready, 20_000)
    expect(told).toContain(DISPATCH_TARGET_DOOR2)
    expect(logOf(it.stateDir, "p1", DISPATCH_TARGET).filter(line => line.id === job.id))
      .toEqual([expect.objectContaining({ direction: "in", from: "p1", text: TASK_B })])
    // Nothing of it was posted on the second door's platform: a job is a row,
    // not a message anybody reads in that chat.
    expect(other.posts().filter(p => p.chat === DISPATCH_TARGET_CHAT)).toEqual([])
  } finally {
    await heard.close(); await door2?.stop(); await door?.stop(); await it.stop()
  }
}, 120_000)
