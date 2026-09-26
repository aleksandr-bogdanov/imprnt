// A report's clocks run from the moment the report landed, and never from the
// moment the person asked.
//
// A report row inherits the JOB's own arrival stamp, which is what puts it
// ahead of a human message that arrived while the job was running. That stamp
// is as old as the job is, and a job that ran for an hour carries an hour.
// `readOpenTurns` selects `kind in ('human', 'report')`, so the report is an
// open turn from the instant it exists, and every deadline derived from the
// row's own arrival is already in the past. The door would post "still waiting:
// the agent has not started answering" into a person's chat in the same second
// their answer arrives, which is a false sentence about a turn nobody has even
// claimed yet.
//
// THE MECHANISM IS THE ONE A VOICE NOTE ALREADY USES. A clock must not run
// while the message has nothing to answer, so the base is the moment the row
// became answerable when it has one, and the row's own arrival otherwise. A row
// with no media and no report is byte for byte what it is today, which is what
// keeps the three shipped clock checks green.
//
// Red reasons: behaviour absent. `clockDeadlines` derives every deadline from
// `received_at` (`src/door/clock.ts:48`) and the read carries no column that
// says when a report landed (`src/store/turns.ts:70-77`), so a report's three
// deadlines are the job's and the door speaks about it at once.

import { afterAll, beforeAll, expect, test } from "bun:test"
import { startCluster, until, type Cluster } from "./helpers/cluster.ts"
import { rolloutStage, DISPATCH_TARGET } from "./helpers/rollout-stage.ts"
import { message } from "./helpers/rollout-ingress.ts"
import { observe } from "./helpers/rollout-runner.ts"
import { COUNCIL_PHRASES, councilLate, DISPATCH_PHRASES } from "../src/door/lines.ts"
import { clockDeadlines, councilDeadline, COUNCIL_STAMP } from "../src/door/clock.ts"
import { COUNCIL_SHEET, mergeIdOf } from "../src/door/council.ts"
import { settleTurn } from "../src/runner/settle.ts"
import { openStore, storeUrlAs } from "../src/store/connect.ts"
import { COUNCIL_SEATS } from "./helpers/rollout-stage.ts"
import { chatLogLines } from "./helpers/hub-fixture.ts"
import { projectInbound } from "../src/chatlog/project.ts"
import { readOpenTurns } from "../src/store/turns.ts"
import { loadRegistry } from "../src/registry/load.ts"
import { thresholdsFor } from "../src/registry/entries.ts"
import { runDoor } from "../src/door/run.ts"
import { superStore } from "./helpers/hub-fixture.ts"

let cluster: Cluster
beforeAll(async () => { cluster = await startCluster() })
afterAll(async () => { await cluster?.stop() })

const LAIR_CHAT = "1000000001"
const OTHER_CHAT = "0000000000"
const TASK = "weigh the synthetic codeword"

test("D-213 a report's three clocks are measured from the moment it landed, and a row with no media and no report is unchanged", () => {
  const thresholds = {
    acked_seconds: 30,
    started_seconds: 60,
    answered_seconds: 900,
    delivered_seconds: 60,
  }
  const receivedAt = new Date("2026-09-20T12:00:00.000Z")
  // An hour of job, which is what a dispatched job IS: the report is stamped
  // with the moment the person asked and lands when the work is done.
  const reportedAt = new Date("2026-09-20T13:00:00.000Z")
  const shipped: [string, string, number][] = [
    ["received", "acked", thresholds.acked_seconds],
    ["acked", "started", thresholds.started_seconds],
    ["started", "answered", thresholds.answered_seconds],
  ]

  for (const [state, stamp, seconds] of shipped) {
    expect(clockDeadlines({ state, received_at: receivedAt, reported_at: reportedAt }, thresholds))
      .toEqual([{ stamp, at: reportedAt.getTime() + seconds * 1000 }])
  }
  // The whole of the defect in one line: with the row's own arrival as the
  // base, the last clock a report can arm has already run out while the report
  // is being written.
  expect(receivedAt.getTime() + thresholds.answered_seconds * 1000)
    .toBeLessThan(reportedAt.getTime())

  // The control that keeps the three shipped clock checks green, asserted
  // against the exact rows `test/door-clock.test.ts` hands this function: a row
  // with no media and no report is the arithmetic it already pins.
  for (const [state, stamp, seconds] of shipped) {
    expect(clockDeadlines({ state, received_at: receivedAt }, thresholds))
      .toEqual([{ stamp, at: receivedAt.getTime() + seconds * 1000 }])
    expect(clockDeadlines({ state, received_at: receivedAt, media_state: null, media_done_at: null, reported_at: null }, thresholds))
      .toEqual([{ stamp, at: receivedAt.getTime() + seconds * 1000 }])
  }
  expect(clockDeadlines({ state: "answered", received_at: receivedAt, reported_at: reportedAt }, thresholds)).toEqual([])
  expect(clockDeadlines({ state: "delivered", received_at: receivedAt, reported_at: reportedAt }, thresholds)).toEqual([])

  // And the voice base is untouched, because a note whose words arrived late is
  // measured from the moment they existed and nothing here moves that.
  const doneAt = new Date("2026-09-20T12:01:00.000Z")
  expect(clockDeadlines({ state: "received", received_at: receivedAt, media_state: "done", media_done_at: doneAt }, thresholds))
    .toEqual([{ stamp: "acked", at: doneAt.getTime() + thresholds.acked_seconds * 1000 }])
  expect(clockDeadlines({ state: "received", received_at: receivedAt, media_state: "pending", media_done_at: null }, thresholds, 90))
    .toEqual([{ stamp: "transcribed", at: receivedAt.getTime() + 90_000 }])
})

test("D-213 the door says nothing about a report whose job ran for an hour, while a clock that really ran out in the same run is spoken", async () => {
  // THE MINIATURE OF WHAT PRODUCTION DOES, without a runner process. The report
  // lands, the dispatcher's runner claims it and stamps it accepted, that stamp
  // is what wakes the door's clock task for that person, and the door then says
  // what it thinks of the row. The stamp is written here as the runner role,
  // because a whole runner would answer both rows out from under the check and
  // the question is what the DOOR says. The report itself is made by
  // `hub_report`, the function the runner calls inside its own settle, so the
  // row is the one production makes.
  //
  // TWO PEOPLE WITH TWO SETS OF THRESHOLDS. The first waits a minute before any
  // clock of his runs out, so a fresh report is quiet for the whole of this
  // check and only a backdated one can speak. The second waits a second, which
  // is the control that says the door's clocks are armed and posting in this
  // very run.
  const it = await rolloutStage(cluster, "telegram", {
    dispatch: true,
    people: [
      { id: "p1", language: "en", acked_seconds: 60, started_seconds: 120, answered_seconds: 180 },
      { id: "p2", language: "ru", acked_seconds: 1, started_seconds: 2, answered_seconds: 3 },
    ],
  })
  let door: Awaited<ReturnType<typeof runDoor>> | undefined
  const store = await superStore(cluster, it.db)
  const asRunner = cluster.connectAs("hub_runner", it.db)
  try {
    door = await runDoor({ door: "door-fake", registryFile: it.registryFile, platform: it.edge.platform })
    it.edge.batch([{ ...message("400", `${DISPATCH_PHRASES.en} ${DISPATCH_TARGET} ${TASK}`), chat: LAIR_CHAT, sender_id: "p1", from: "p1" }], "401")
    await until("the job reaches the queue", async () =>
      (await it.read.inbound()).some(r => r.kind === "job"), 20_000)
    const job = (await it.read.inbound()).find(r => r.kind === "job")!

    // The hour the job took, planted so the arrangement is exact rather than
    // waited for. Everything a report inherits is inherited from this row.
    await it.read.sql("update inbound set received_at = now() - interval '1 hour' where id = $1", [job.id])
    await asRunner`select hub_report(${job.id}, ${"the codeword weighs four"})`
    const reportId = `report:${job.id}`
    await projectInbound(store, { stateDir: it.stateDir, inboundId: reportId })

    const backdated = (await it.read.inbound()).find(r => r.id === reportId)!
    const aged = (await it.read.inbound()).find(r => r.id === job.id)!
    expect(new Date(backdated.received_at).toISOString()).toBe(new Date(aged.received_at).toISOString())
    expect(Date.now() - new Date(backdated.received_at).getTime()).toBeGreaterThan(3_000_000)

    // The control: an ordinary message from the second person, whose own
    // thresholds are seconds. Accepted and then held at `acked`, so the clock
    // it is waiting on really does run out and the door says so.
    it.edge.batch([{ ...message("410", "обычное сообщение"), chat: OTHER_CHAT, sender_id: "p2", from: "p2" }], "411")
    await until("the second person's message reaches the queue", async () =>
      (await it.read.inbound()).some(r => r.kind === "human" && r.person === "p2"), 20_000)
    const control = (await it.read.inbound()).find(r => r.kind === "human" && r.person === "p2")!

    for (const id of [reportId, control.id]) {
      await asRunner`insert into ledger_event (stream, subject, kind, actor)
                     values ('inbound', ${id}, 'acked', 'runner')`
    }
    await until("the control's clock runs out and the door says so", async () =>
      (await it.read.ledger({ stream: "clock", subject: control.id })).length > 0, 30_000)

    // THE ASSERTION. In the window the control's clock ran out in, the door
    // said nothing at all about a report whose job took an hour: no expiry in
    // the diary, and the deadline it would speak about next is still ahead.
    expect(await it.read.ledger({ stream: "clock", subject: reportId })).toEqual([])
    const open = await readOpenTurns(store, { agent: "p1-lair" })
    const row = open.find(one => one.id === reportId)!
    expect(row).toBeDefined()
    const thresholds = thresholdsFor(loadRegistry(it.registryFile), "p1")
    const [due] = clockDeadlines(row, thresholds)
    // Accepted a moment ago, so the clock it is waiting on is the next one and
    // it runs from the report, not from the hour old question underneath it.
    expect(row.state).toBe("acked")
    expect(due.stamp).toBe("started")
    expect(due.at).toBeGreaterThan(Date.now())

    // A report on a job dispatched a second ago is quiet too, which is what
    // says the assertion above is about the backdating and not about reports.
    it.edge.batch([{ ...message("420", `${DISPATCH_PHRASES.en} ${DISPATCH_TARGET} ${TASK} again`), chat: LAIR_CHAT, sender_id: "p1", from: "p1" }], "421")
    await until("the second job reaches the queue", async () =>
      (await it.read.inbound()).filter(r => r.kind === "job").length === 2, 20_000)
    const fresh = (await it.read.inbound()).filter(r => r.kind === "job").find(r => r.id !== job.id)!
    await asRunner`select hub_report(${fresh.id}, ${"the codeword weighs four again"})`
    await projectInbound(store, { stateDir: it.stateDir, inboundId: `report:${fresh.id}` })
    await asRunner`insert into ledger_event (stream, subject, kind, actor)
                   values ('inbound', ${`report:${fresh.id}`}, 'acked', 'runner')`
    expect(await observe(async () =>
      (await it.read.ledger({ stream: "clock", subject: `report:${fresh.id}` })).length > 0, 2_500)).toBe(false)

    // And the whole of what the first person's chat was told: the command, what
    // the door answered it, and the two reports. Not one clock line.
    const said = it.edge.posts().filter(p => p.chat === LAIR_CHAT).map(p => p.text)
    expect(said.filter(text => text.startsWith("[door] still waiting"))).toEqual([])
    expect(await it.read.ledger({ stream: "clock", subject: reportId })).toEqual([])
  } finally {
    await door?.stop(); await asRunner.close(); await store.close(); await it.stop()
  }
}, 120_000)

test("a council past the grace is said late ONCE, its unclaimed seat is given up on, a claimed seat is left to its runner whatever its lease says, and a restarted door says it no second time", async () => {
  // The grace is four seconds, so the council's one clock runs out inside this
  // check. Two seats are claimed by a runner before the grace, one on a live
  // lease and one on a lease that has run out, and neither is settled until
  // the end, so the council stays open past the late line.
  const it = await rolloutStage(cluster, "telegram", { council: true, hub: { job_grace_seconds: 4 } })
  let door: Awaited<ReturnType<typeof runDoor>> | undefined
  const runner = await openStore({ url: storeUrlAs(cluster.url(it.db), "hub_runner") })
  try {
    door = await runDoor({ door: "door-fake", registryFile: it.registryFile, platform: it.edge.platform })
    it.edge.batch([{ ...message("500", `${COUNCIL_PHRASES.en} weigh the synthetic council`), chat: LAIR_CHAT, sender_id: "p1", from: "p1" }], "501")
    await until("the seats' jobs reach the queue", async () =>
      (await it.read.inbound()).filter(r => r.kind === "job").length === COUNCIL_SEATS.length, 20_000)
    const jobs = (await it.read.inbound()).filter(r => r.kind === "job")
    const held = jobs.find(j => j.agent === COUNCIL_SEATS[2])!
    const lapsed = jobs.find(j => j.agent === COUNCIL_SEATS[1])!
    await it.read.sql("update inbound set claimed_by = 'runner-pi', claim_deadline = now() + interval '1 hour' where id = $1", [held.id])
    // A lease that ran out is not a turn that stopped: the deadline is fixed
    // at the claim and a long turn outlives it.
    await it.read.sql("update inbound set claimed_by = 'runner-pi', claim_deadline = now() - interval '1 minute' where id = $1", [lapsed.id])
    const [council] = await it.read.sheet(COUNCIL_SHEET)
    expect(council).toBeDefined()
    expect(councilDeadline({ at: String(council.data.at) }, 4)).toBe(new Date(String(council.data.at)).getTime() + 4000)

    const late = () => it.edge.posts().filter(p => p.chat === LAIR_CHAT && p.text.includes("council")).filter(p => !p.text.includes("started on"))
    await until("the door says the council is late", () => late().length > 0, 20_000)
    // ONE line, naming the council's count and none of the seats, and one
    // diary row under the council's own id.
    expect(late()).toHaveLength(1)
    const seconds = Number(/(\d+) s so far/.exec(late()[0].text)?.[1])
    expect(late()[0].text).toBe(councilLate("en", { answered: 0, seats: COUNCIL_SEATS.length, seconds }))
    for (const seat of COUNCIL_SEATS) expect(late()[0].text).not.toContain(seat)
    const spoken = await it.read.ledger({ stream: "clock", subject: council.id })
    expect(spoken).toHaveLength(1)
    expect(spoken[0].detail).toMatchObject({ stamp: COUNCIL_STAMP, person: "p1", agent: "p1-lair", id: `clock:${council.id}:${COUNCIL_STAMP}` })
    // No seat's job was ever spoken about: a seat's row is the seat's and
    // never an open turn of the chat's agent.
    for (const job of jobs) expect(await it.read.ledger({ stream: "clock", subject: job.id })).toEqual([])

    // The one seat nobody claimed is given up on in the same transaction, by
    // the door through the runner-owned function; both held ones are left,
    // the lapsed lease included.
    const rows = await it.read.inbound()
    {
      const job = rows.find(r => r.agent === COUNCIL_SEATS[0] && r.kind === "job")!
      expect(job.state).toBe("answered")
      expect(rows.find(r => r.id === `report:${job.id}`)).toBeUndefined()
      const abandoned = await it.read.ledger({ subject: job.id, kind: "dispatch.abandoned" })
      expect(abandoned).toHaveLength(1)
      expect(abandoned[0].actor).toBe("runner")
      expect(abandoned[0].detail).toMatchObject({ agent: COUNCIL_SEATS[0], council: council.id, cause: "unclaimed past the grace", by: "door", dispatcher: "p1-lair" })
    }
    for (const job of [held, lapsed]) {
      expect(rows.find(r => r.id === job.id)!.state).toBe("received")
      expect(rows.find(r => r.id === job.id)!.claimed_by).toBe("runner-pi")
      expect(await it.read.ledger({ subject: job.id, kind: "dispatch.abandoned" })).toEqual([])
    }
    expect(rows.filter(r => String(r.id).startsWith("merge:"))).toEqual([])
    const marked = (await it.read.sheet(COUNCIL_SHEET))[0]
    expect(marked.data.late).toEqual(expect.any(String))
    expect(marked.data.answered).toEqual({ [COUNCIL_SEATS[0]]: null })
    // No "stopped, will retry" line about any seat reached the chat.
    expect((await it.read.noticeRows()).filter(one => String(one.notice_key).startsWith("agent-retry:"))).toEqual([])
    // Not a second time in this door's life, well past a second grace.
    expect(await observe(() => late().length > 1, 5_000)).toBe(false)
    // Not a second time from a door started again either: the mark is on the row.
    await door.stop()
    door = await runDoor({ door: "door-fake", registryFile: it.registryFile, platform: it.edge.platform })
    expect(await observe(() => late().length > 1, 5_000)).toBe(false)
    expect(await it.read.ledger({ stream: "clock", subject: council.id })).toHaveLength(1)
    expect(chatLogLines(it.stateDir, "p1", "p1-lair").filter(l => l.text === late()[0].text)).toHaveLength(1)
    // And the ordinary still-waiting lines are absent: nothing here is a turn.
    expect(it.edge.posts().filter(p => p.text.startsWith("[door] still waiting:"))).toEqual([])

    // The held seats' runner settles them at last: the merge lands with the
    // given-up seat as "no answer", and the row goes.
    const record = (agent: string) => ({ agent, runner: "runner-pi", preset: "daily", preset_id: "p", preset_settings: {}, input_tokens: 1, cached_input_tokens: 0,
      output_tokens: 1, price: null, plan_usage: null, raw_usage: {}, session_id: null, lacks: [], tail: false })
    await settleTurn(runner, { inboundId: lapsed.id, kind: "job", person: "p1", source: lapsed.source as never, chunks: ["the lapsed seat's answer"], turn: record(COUNCIL_SEATS[1]) })
    expect((await it.read.inbound()).filter(r => String(r.id).startsWith("merge:"))).toEqual([])
    await settleTurn(runner, { inboundId: held.id, kind: "job", person: "p1", source: held.source as never, chunks: ["the held seat's answer"], turn: record(COUNCIL_SEATS[2]) })
    const merge = (await it.read.inbound()).find(r => r.id === mergeIdOf(council.id))!
    expect(merge).toBeDefined()
    expect(merge.body).toContain("Seat 1:\nno answer")
    expect(merge.body).toContain("Seat 2:\nthe lapsed seat's answer")
    expect(merge.body).toContain("Seat 3:\nthe held seat's answer")
    expect(await it.read.sheet(COUNCIL_SHEET)).toEqual([])
    expect(await it.read.ledger({ kind: "council.merged" })).toHaveLength(1)
  } finally { await door?.stop(); await runner.close(); await it.stop() }
}, 90_000)
