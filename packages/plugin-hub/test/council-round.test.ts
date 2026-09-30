// A council's rounds: the answers of independent participants, the one event the master is handed,
// where a queued human message stands against it, what makes a council complete, and what happens
// when a participant cannot be waited for. Real store and handlers; a worker's answer is the same
// settle a runner does, and a worker's interruption is the same hold a runner leaves.

import { afterAll, afterEach, beforeAll, expect, test } from "bun:test"
import { startCluster, type Cluster } from "./helpers/cluster.ts"
import { CHAT, DOOR, PERSON, RUNNER } from "./helpers/hub-fixture.ts"
import { councilStage, GONE, QUESTION, roster, startArgs } from "./helpers/council-stage.ts"
import { callTool } from "../src/mcp/handlers.ts"
import { ToolError } from "../src/mcp/contracts.ts"
import { reconcileCouncil } from "../src/council/reconcile.ts"
import { readSnapshot } from "../src/council/snapshot.ts"
import { endAttempt } from "../src/runner/execution.ts"
import { readEligible } from "../src/store/wake.ts"
import { claimNext } from "../src/runner/claim.ts"
import { markProgress } from "../src/store/conversations.ts"

let cluster: Cluster
beforeAll(async () => { cluster = await startCluster() })
afterAll(async () => { await cluster?.stop() })

const mine: { close(): Promise<void> }[] = []
const track = <T extends { close(): Promise<void> }>(sql: T): T => { mine.push(sql); return sql }
afterEach(async () => { for (const one of mine.splice(0)) await one.close().catch(() => {}) })

async function code(run: Promise<unknown>): Promise<string> {
  try { await run; return "no error" } catch (error) { return error instanceof ToolError ? error.code : `not a ToolError: ${(error as Error).message}` }
}

type Stage = Awaited<ReturnType<typeof councilStage>>

const move = (s: Stage, id: string, revision: number, over: Record<string, unknown>, attempt: string | null = "attempt-master") =>
  callTool(s.binding(attempt), "hub_council", { action: "continue", request_key: `k-${Math.random().toString(36).slice(2, 8)}`, council_id: id, expected_revision: revision, ...over })

/** A council of the given workers, started on the owner's word. */
async function begin(s: Stage, workers: string[] = ["p1-w1", "p1-w2"]) {
  const started = await callTool(s.binding("attempt-start"), "hub_council", startArgs({ participants: roster(workers) }))
  const id = String(started.object_id)
  return { id, jobs: await s.jobsOf(id) }
}

const eventsOf = async (s: Stage, id: string) => Array.from(await s.su`select e.seq, e.kind, e.dedupe_key, e.ready_at, e.consumed_at, e.consumed_attempt, e.disposition, e.inbound_id,
    i.kind as row_kind, i.rank, i.log_ready, i.body, i.source, i.state, i.received_at, i.reported_at
  from council_event e join inbound i on i.id = e.inbound_id where e.council_id = ${id} order by e.seq`) as any[]

// ---------------------------------------------------------------------------
// Whenful: independent answers, one event, one synthesis tied to the master's own attempt.
// ---------------------------------------------------------------------------

test("R1 an explicit roster answers independently; the master is handed ONE event when the last answer lands and finalizes from its own attempt; the reply that attempt settles is the result", async () => {
  const s = await councilStage(cluster, track)
  try {
    const { id, jobs: [j1, j2] } = await begin(s)
    await s.answer(j1.id, "Weigh it twice. The first reading drifts.")
    expect((await s.su`select lifecycle from council where id = ${id}`)[0].lifecycle, "one answer is not a round").toBe("running")
    expect(await s.count("council_event")).toBe(0)
    // A member's report is recorded and never fed: it is answered at settle, rank 0 for the master and marked as a council's.
    const report = (await s.su`select kind, rank, state, source from inbound where id = ${"report:" + j1.id}`)[0]
    expect(report).toMatchObject({ kind: "report", rank: 0, state: "answered" })
    expect(report.source.origin).toBe("council")

    await s.answer(j2.id, "Once is enough when the scale is warm. Unsure about cold starts.")
    const [council] = Array.from(await s.su`select lifecycle, waiting from council where id = ${id}`) as any[]
    expect(council.lifecycle).toBe("waiting_master")
    const events = await eventsOf(s, id)
    expect(events).toHaveLength(1)
    const event = events[0]
    expect(event).toMatchObject({ kind: "round_complete", row_kind: "report", rank: 0, log_ready: true, state: "received", consumed_at: null })
    expect(event.body).toContain("Weigh it twice. The first reading drifts.")
    expect(event.body).toContain("Once is enough when the scale is warm.")
    expect(event.body).toContain(QUESTION)
    expect(event.body).toContain("finalize")
    expect(event.source).toMatchObject({ origin: "council", door: DOOR, chat: CHAT, from: "council" })
    expect(new Date(event.ready_at).toISOString(), "its own queue time is the one on the row").toBe(new Date(event.received_at).toISOString())
    expect(event.reported_at, "clocks run from when it was written").not.toBeNull()

    // A redelivered settle, a second reconciler and a restart write it once and move nothing.
    await s.answer(j2.id, "Once is enough when the scale is warm. Unsure about cold starts.")
    await reconcileCouncil(s.runner, id)
    const again = await eventsOf(s, id)
    expect(again).toHaveLength(1)
    expect(new Date(again[0].ready_at).toISOString()).toBe(new Date(event.ready_at).toISOString())
    expect(await s.count("inbound", `id = '${event.inbound_id}'`)).toBe(1)

    // The master is fed: its attempt consumes the event, and only now is the council being assessed.
    expect((await s.su`select lifecycle from council where id = ${id}`)[0].lifecycle, "not claimed yet, so still waiting").toBe("waiting_master")
    const attempt = await s.feed(event.inbound_id)
    const [fed] = Array.from(await s.su`select lifecycle from council where id = ${id}`) as any[]
    expect(fed.lifecycle).toBe("assessing")
    expect((await eventsOf(s, id))[0]).toMatchObject({ consumed_attempt: attempt.id, disposition: "read" })
    const snap = await readSnapshot(s.runner, id, { now: new Date(), quietSeconds: 300 })
    expect(snap).toMatchObject({ stage: "assessing-next-round", master: "working", answered: 2, required: 2 })

    // An ordinary reply is not a synthesis: the disposition is a call, tied to THIS attempt.
    const fin = await move(s, id, await s.revision(id), { kind: "finalize" }, attempt.id)
    expect(fin).toMatchObject({ status: "running", stage: "preparing_result" })
    const [preparing] = Array.from(await s.su`select lifecycle, finalize from council where id = ${id}`) as any[]
    expect(preparing.lifecycle).toBe("preparing_result")
    expect(preparing.finalize).toMatchObject({ attempt: attempt.id, inbound: event.inbound_id, mode: "all", omitted: [] })
    await s.settleMaster(event.inbound_id, attempt, "Weigh it twice and log both readings. One view would settle for once on a warm scale.")
    const [done] = Array.from(await s.su`select lifecycle, result, completed_at from council where id = ${id}`) as any[]
    expect(done.lifecycle).toBe("complete")
    expect(done.completed_at).not.toBeNull()
    expect(done.result).toMatchObject({ attempt: attempt.id, inbound: event.inbound_id, mode: "all", reply: { source: event.inbound_id, kind: "reply" } })
    // The result is delivered by the existing outbox to the pinned route.
    const [out] = Array.from(await s.su`select body, route from outbox where inbound_id = ${event.inbound_id}`) as any[]
    expect(out.body).toContain("Weigh it twice and log both readings.")
    expect(out.route).toEqual({ door: DOOR, chat: CHAT })

    // Inspect gives the whole state and every participant's answer, and a completed council stays inspectable.
    const seen = await callTool(s.binding(), "hub_council", { action: "inspect", council_id: id })
    expect(seen).toMatchObject({ object_id: id, status: "complete", stage: "complete" })
    const inputs = (seen.rounds as any[])[0].inputs
    expect(inputs.map((one: any) => [one.state, one.answer_excerpt?.slice(0, 12)])).toEqual([["answered", "Weigh it twi"], ["answered", "Once is enou"]])
    expect((seen.participants as any[]).map(one => one.worker_ref)).toEqual(["p1-w1", "p1-w2"])
  } finally { await s.close() }
}, 90_000)

test("R2 a reply that never called finalize is not a synthesis: the council goes back to waiting for its master, visibly, and completes nothing", async () => {
  const s = await councilStage(cluster, track)
  try {
    const { id, jobs: [j1, j2] } = await begin(s)
    await s.answer(j1.id, "one")
    await s.answer(j2.id, "two")
    const event = (await eventsOf(s, id))[0]
    const attempt = await s.feed(event.inbound_id)
    expect((await s.su`select lifecycle from council where id = ${id}`)[0].lifecycle).toBe("assessing")
    await s.settleMaster(event.inbound_id, attempt, "Interesting question. Let me think about it.")
    const [council] = Array.from(await s.su`select lifecycle, result, finalize from council where id = ${id}`) as any[]
    expect(council).toMatchObject({ lifecycle: "waiting_master", result: null, finalize: null })
    expect(await s.count("council", "lifecycle = 'complete'")).toBe(0)
    // A master whose turn ended is not "assessing", and is not reported as working.
    const snap = await readSnapshot(s.runner, id, { now: new Date(), quietSeconds: 300 })
    expect(snap?.stage).toBe("waiting-master")
  } finally { await s.close() }
}, 60_000)

test("R3 finalize is tied to the attempt that called it, including a turn the owner's message started: the waiting event is taken over and never fed again", async () => {
  const s = await councilStage(cluster, track)
  try {
    const { id, jobs: [j1, j2] } = await begin(s)
    await s.answer(j1.id, "one")
    await s.answer(j2.id, "two")
    const event = (await eventsOf(s, id))[0]
    // The owner speaks before the master has read the event, and the master's attempt on THAT message decides.
    await s.human("h3")
    const attempt = await s.feed("h3")
    // Without an attempt of its own there is nothing to tie a result to.
    const noTurn = await move(s, id, await s.revision(id), { kind: "finalize" }, null)
    expect(noTurn).toMatchObject({ status: "failed", cause: "closed" })
    const fin = await move(s, id, await s.revision(id), { kind: "finalize" }, attempt.id)
    expect(fin).toMatchObject({ status: "running", stage: "preparing_result" })
    const taken = (await eventsOf(s, id))[0]
    expect(taken).toMatchObject({ consumed_attempt: attempt.id, disposition: "in_turn", state: "answered" })
    expect(await s.count("execution", `inbound_id = '${event.inbound_id}'`), "the event was never fed").toBe(0)
    expect((await readEligible(s.runner, { agent: "p1-lair", resumeOk: true })).map(row => row.id)).not.toContain(event.inbound_id)
    // The attempt that called finalize settles with the owner's message as its input, and that is the result.
    await s.settleMaster("h3", attempt, "Weigh it twice, and here is why.", "human")
    const [council] = Array.from(await s.su`select lifecycle, result from council where id = ${id}`) as any[]
    expect(council.lifecycle).toBe("complete")
    expect(council.result).toMatchObject({ attempt: attempt.id, inbound: "h3" })
  } finally { await s.close() }
}, 60_000)

// ---------------------------------------------------------------------------
// Ordering: a human message that was already waiting stays ahead; a later one cannot jump the event.
// ---------------------------------------------------------------------------

test("R4 the master's queue: a waiting human message precedes a later-born event, a later message cannot jump it, and the event's time is its insertion, not its transaction's start", async () => {
  const s = await councilStage(cluster, track)
  try {
    const { id, jobs: [j1, j2] } = await begin(s)
    await s.answer(j1.id, "one")
    await s.answer(j2.id, "two")
    const event = (await eventsOf(s, id))[0]
    await s.human("h-later")
    const order = async () => (await readEligible(s.runner, { agent: "p1-lair", resumeOk: true })).map(row => row.id)
    expect(await order(), "h1 and h2 were already waiting; h-later arrived after the event").toEqual(["h1", "h2", event.inbound_id, "h-later"])
    // The event is rank 0 like a human message, and an ordinary job for another agent is not in this queue at all.
    expect((await readEligible(s.runner, { agent: "p1-lair", resumeOk: true })).map(row => row.rank)).toEqual([0, 0, 0, 0])

    // THE HAZARD: a transaction that began before a human message committed. `now()` is its start; the event is stamped
    // by `clock_timestamp()`, so it is born after the message and a later human message does not sort before it.
    //
    // The three moments are ordered by the awaits below (the transaction has started and its start has been read before the message is
    // written, and the message has committed before the event is written), and they are COMPARED IN THE DATABASE, at its own
    // microsecond precision: a JavaScript Date keeps milliseconds, and a start and a message a few hundred microseconds apart are the same
    // Date. The start travels as text, which keeps every digit, and is compared as a timestamptz.
    const held = await (track(cluster.connectAs("hub_runner", s.db)) as any).reserve()
    let open = false
    let started = ""
    try {
      await held.unsafe("begin")
      open = true
      started = (await held.unsafe("select now()::text as started"))[0].started
      await s.human("h-mid")
      await held.unsafe(`select hub_council_event_put('council-event:probe:1', $1, 90, 'round_complete', 'probe', 'p1-lair', $2, 'probe', $3::text::jsonb, '{}'::text::jsonb)`,
        [id, PERSON, JSON.stringify({ agent: "p1-lair", door: DOOR, chat: CHAT })])
      await held.unsafe("commit")
      open = false
    } finally {
      // A failure between begin and commit must not leave a transaction open on a connection the pool hands to the next borrower.
      if (open) await held.unsafe("rollback").catch(() => {})
      held.release()
    }
    const [moments] = Array.from(await s.su`select
        ${started}::timestamptz < mid.received_at as began_before_message,
        probe.received_at > mid.received_at as born_after_message,
        probe.received_at > ${started}::timestamptz as born_after_start,
        probe.received_at = e.ready_at as own_time_is_its_stamp,
        mid.received_at - ${started}::timestamptz as message_after_start,
        probe.received_at - mid.received_at as event_after_message
      from inbound mid, inbound probe, council_event e
      where mid.id = 'h-mid' and probe.id = 'council-event:probe:1' and e.inbound_id = probe.id`) as any[]
    expect(moments, "the probe and the message were both written").toBeDefined()
    expect(moments.began_before_message, `the transaction began before the message (${started}; the message came ${moments.message_after_start} later)`).toBe(true)
    expect(moments.born_after_message, `and the event was born after it (${moments.event_after_message} later)`).toBe(true)
    expect(moments.born_after_start, "which is later than the transaction's start, so the event was not stamped with it").toBe(true)
    expect(moments.own_time_is_its_stamp, "the event's queue time is the stamp its row carries").toBe(true)

    // The queue honours the insertion: the message that arrived while that transaction was open sorts BEFORE the event it was open
    // around. Stamped with the transaction's `now()`, the event would sort ahead of `h-mid` (and behind `h-later`, which committed
    // before the transaction began), and this is the order that tells the two apart.
    expect(await order(), "h-mid was written before the event, so it is ahead of it").toEqual(["h1", "h2", event.inbound_id, "h-later", "h-mid", "council-event:probe:1"])
    expect((await readEligible(s.runner, { agent: "p1-lair", resumeOk: true })).map(row => row.rank)).toEqual([0, 0, 0, 0, 0, 0])
  } finally { await s.close() }
}, 60_000)

// ---------------------------------------------------------------------------
// A participant that cannot be waited for: named, the owner's, and never synthesized around.
// ---------------------------------------------------------------------------

test("R5 an interrupted participant is missing with its cause and the council waits for the owner: siblings keep running, nothing is rerun, no partial synthesis, and 'use the available answers' needs the owner's recorded scope first", async () => {
  const s = await councilStage(cluster, track)
  try {
    const { id, jobs: [j1, j2, j3] } = await begin(s, ["p1-w1", "p1-w2", "p1-w3"])
    await s.answer(j1.id, "answer one")
    const held = await s.interrupt(j2.id)
    const live = await s.running(j3.id)
    await markProgress(s.runner, live.execution, "running")
    await reconcileCouncil(s.runner, id)

    const [council] = Array.from(await s.su`select lifecycle, waiting from council where id = ${id}`) as any[]
    expect(council.lifecycle).toBe("waiting_owner")
    expect(council.waiting).toMatchObject({ kind: "members_missing", members: [`${id}:p2`] })
    const members = Array.from(await s.su`select participant_id, state, cause from round_member where council_id = ${id} order by participant_id`) as any[]
    expect(members.map(one => [one.participant_id.split(":").pop(), one.state])).toEqual([["p1", "answered"], ["p2", "missing"], ["p3", "open"]])
    expect(members[1].cause).toMatchObject({ kind: "interrupted", attempt: held.execution })
    // One event names who is missing and why; the round is NOT complete and nothing was synthesized.
    const events = await eventsOf(s, id)
    expect(events.map(one => one.kind)).toEqual(["member_missing"])
    expect(events[0].body).toContain("Participant 2 (p1-w2) is missing")
    expect(events[0].body).toContain("interrupted")
    expect(events[0].body).toContain("Do not synthesize a partial result")
    // Nothing was rerun or stopped: two attempts, the planted ones, and the healthy sibling is still running.
    expect(await s.count("execution")).toBe(2)
    expect(await s.count("stop_request")).toBe(0)
    expect((await s.su`select state from execution where id = ${live.execution}`)[0].state).toBe("running")
    await reconcileCouncil(s.runner, id)
    expect((await eventsOf(s, id)).map(one => one.kind), "said once").toEqual(["member_missing"])
    // The card's facts: both are true at once, the gate and the running sibling.
    const snap = await readSnapshot(s.runner, id, { now: new Date(), quietSeconds: 300 })
    expect(snap?.stage).toBe("waiting-owner")
    expect(snap?.members.map(one => one.view)).toEqual(["answered", "missing", "running"])
    expect(snap?.members[1].cause).toMatchObject({ kind: "interrupted" })

    // The master cannot finalize around it, and cannot record the owner's choice without the owner's message.
    const blocked = await move(s, id, await s.revision(id), { kind: "finalize" }, "attempt-x")
    expect(blocked).toMatchObject({ status: "failed", cause: "closed" })
    expect(await code(move(s, id, await s.revision(id), { kind: "owner_decision", decision: { choice: "use_available", affected_ids: [`${id}:p2`] } }))).toBe("invalid_arguments")
    expect(await code(move(s, id, await s.revision(id), { kind: "owner_decision", source_message_ids: ["h1"], decision: { choice: "use_available", affected_ids: [`${id}:p2`] } }))).toBe("source_invalid")

    // The owner says so. The omission is recorded BEFORE a result with fewer answers can exist.
    await s.human("h3")
    const chosen = await move(s, id, await s.revision(id), { kind: "owner_decision", source_message_ids: ["h3"],
      decision: { choice: "use_available", affected_ids: [`${id}:p2`] } })
    expect(chosen).toMatchObject({ stage: "using_available" })
    expect((await s.su`select kind, sources, payload from council_decision where council_id = ${id} and kind = 'use_available'`)[0]).toMatchObject({
      sources: ["h3"], payload: { omitted: [`${id}:p2`] } })
    expect((await s.su`select lifecycle from council where id = ${id}`)[0].lifecycle, "the healthy sibling is still running").toBe("running")
    await s.answer(j3.id, "answer three")
    expect((await s.su`select lifecycle from council where id = ${id}`)[0].lifecycle).toBe("waiting_master")
    const completed = (await eventsOf(s, id)).find(one => one.kind === "round_complete")!
    expect(completed.body).toContain("Participant 1")
    expect(completed.body).toContain("Participant 3")
    expect(completed.body).not.toContain("Participant 2 (")
    const fin = await move(s, id, await s.revision(id), { kind: "finalize" }, "attempt-fin")
    expect(fin).toMatchObject({ status: "running", stage: "preparing_result" })
    expect((await s.su`select finalize from council where id = ${id}`)[0].finalize).toMatchObject({ mode: "use_available", omitted: [`${id}:p2`] })
  } finally { await s.close() }
}, 90_000)

test("R6 the owner's retry is the store's own recovery choice: a linked new input into the same conversation, the interrupted input never fed again, and the continuation's report is recorded and never fed to the master", async () => {
  const s = await councilStage(cluster, track)
  try {
    const { id, jobs: [j1, j2] } = await begin(s)
    await s.answer(j1.id, "one")
    const held = await s.interrupt(j2.id)
    await reconcileCouncil(s.runner, id)
    await s.human("h3")
    const retry = await move(s, id, await s.revision(id), { kind: "owner_decision", source_message_ids: ["h3"], message: "carry on, and check the state first",
      decision: { choice: "retry", affected_ids: [`${id}:p2`] } })
    expect(retry).toMatchObject({ stage: "retrying" })
    const [hold] = Array.from(await s.su`select state, choice, chosen_by, evidence, continuation_id from replay_hold where inbound_id = ${j2.id}`) as any[]
    expect(hold).toMatchObject({ state: "continuing", choice: "continue", chosen_by: PERSON, continuation_id: `continue:${j2.id}:1` })
    expect(hold.evidence).toMatchObject({ source: "council", decision: "retry", messages: ["h3"] })
    const [next] = Array.from(await s.su`select kind, body, source from inbound where id = ${hold.continuation_id}`) as any[]
    expect(next.kind).toBe("job")
    expect(next.source.dispatch.conversation, "the same conversation, not a new one").toBe(held.conversation)
    expect(next.source.dispatch.council_round).toMatchObject({ council: id })
    expect(next.body).toContain("carry on, and check the state first")
    expect((await s.su`select hub_row_held(${j2.id}) as held`)[0].held, "the interrupted input is never fed again").toBe(true)
    // The member is waited for again, by the owner's choice, and the council runs.
    expect((await s.su`select state from round_member where inbound_id = ${j2.id}`)[0].state).toBe("open")
    expect((await s.su`select lifecycle from council where id = ${id}`)[0].lifecycle).toBe("running")
    // Its answer arrives as any member's does, and the report is recorded, never fed.
    await s.answer(hold.continuation_id, "two, after the retry")
    expect((await s.su`select state from inbound where id = ${"report:" + hold.continuation_id}`)[0].state).toBe("answered")
    expect((await s.su`select lifecycle from council where id = ${id}`)[0].lifecycle).toBe("waiting_master")
    // Said once each: who was missing, that nothing else could answer, and that every answer is in.
    expect((await eventsOf(s, id)).map(one => one.kind).sort()).toEqual(["member_missing", "round_complete", "round_stalled"])
  } finally { await s.close() }
}, 90_000)

test("R7 the owner's replacement is a NEW participant linked to the old one, which keeps its identity, its hold and whatever it produced", async () => {
  const s = await councilStage(cluster, track)
  try {
    const { id, jobs: [j1, j2] } = await begin(s)
    await s.answer(j1.id, "one")
    await s.interrupt(j2.id)
    await reconcileCouncil(s.runner, id)
    await s.human("h3")
    const spec = { worker_ref: "p1-w3", preset_ref: "daily", machine_ref: RUNNER, brief: "take over from the one that stopped" }
    // A replacement is the owner's word too, and it must be exactly configured.
    expect(await code(move(s, id, await s.revision(id), { kind: "owner_decision", source_message_ids: ["h3"],
      decision: { choice: "replace", affected_ids: [`${id}:p2`], replacement_spec: { ...spec, preset_ref: "cheap" } } }))).toBe("unsupported_override")
    const replaced = await move(s, id, await s.revision(id), { kind: "owner_decision", source_message_ids: ["h3"],
      decision: { choice: "replace", affected_ids: [`${id}:p2`], replacement_spec: spec } })
    expect(replaced).toMatchObject({ stage: "replaced" })
    const participants = Array.from(await s.su`select id, ordinal, worker_agent, state, replaces, roster_revision from council_participant where council_id = ${id} order by ordinal`) as any[]
    expect(participants.map(one => [one.worker_agent, one.state, one.replaces])).toEqual([["p1-w1", "active", null], ["p1-w2", "replaced", null], ["p1-w3", "active", `${id}:p2`]])
    expect(participants[2].roster_revision).toBe(2)
    expect((await s.su`select roster_revision from council where id = ${id}`)[0].roster_revision).toBe(2)
    const jobs = await s.jobsOf(id)
    const fresh = jobs.find(job => job.agent === "p1-w3")!
    expect(fresh.source.dispatch.conversation, "a fresh conversation of its own").toBeUndefined()
    expect((await s.su`select state from replay_hold where inbound_id = ${j2.id}`)[0].state, "the old hold is not silently released").toBe("held")
    expect((await s.su`select state from round_member where inbound_id = ${j2.id}`)[0].state, "the old input keeps what it was").toBe("missing")
    expect((await s.su`select lifecycle from council where id = ${id}`)[0].lifecycle).toBe("running")
    await s.answer(fresh.id, "three, in its place")
    expect((await s.su`select lifecycle from council where id = ${id}`)[0].lifecycle).toBe("waiting_master")
  } finally { await s.close() }
}, 90_000)

test("R8 a member whose attempt failed before the engine was handed its input is gated in the very transaction that ends the attempt, not tried again: the council names the failure and asks", async () => {
  const s = await councilStage(cluster, track)
  try {
    const { id, jobs: [j1, j2] } = await begin(s)
    // The attempt is opened and nothing is fed (`claimed`); it ends as the runner ends one whose engine was never given the input.
    const opened = await s.claimed(j1.id)
    expect(await endAttempt(s.runner, { execution: opened.execution, evidence: null, cause: "child exited", delivered: false })).toMatchObject({ state: "failed" })
    expect((await s.su`select state from execution where id = ${opened.execution}`)[0].state).toBe("failed")
    expect((await s.su`select state, evidence from claim_gate where operation_id = ${"council-failed:" + j1.id}`)[0]).toMatchObject({ state: "open", evidence: { cause: "child exited" } })
    expect((await readEligible(s.runner, { agent: "p1-w1", resumeOk: true })).map(row => row.id), "not claimable").toEqual([])
    expect(await claimNext(s.runner, { runner: "runner-a", agent: "p1-w1", leaseMs: 1000, resumeOk: true }), "no retry").toBeNull()
    expect((await s.su`select state from inbound where id = ${j1.id}`)[0].state, "and nothing is stamped answered").toBe("received")
    await reconcileCouncil(s.runner, id)
    const [member] = Array.from(await s.su`select state, cause from round_member where inbound_id = ${j1.id}`) as any[]
    expect(member).toMatchObject({ state: "missing", cause: { kind: "failed_before_start", detail: "child exited" } })
    expect((await s.su`select lifecycle from council where id = ${id}`)[0].lifecycle).toBe("waiting_owner")
    expect((await eventsOf(s, id)).map(one => one.kind)).toEqual(["member_missing"])
    // The other member is untouched and still a job on the queue.
    expect((await readEligible(s.runner, { agent: "p1-w2", resumeOk: true })).map(row => row.id)).toEqual([j2.id])
    void GONE
  } finally { await s.close() }
}, 60_000)
