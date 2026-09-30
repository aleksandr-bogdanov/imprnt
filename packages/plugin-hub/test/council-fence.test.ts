// FENCE FIRST: a council's stop and a correction decide what can still run only after nothing new can start, they count ALL of the
// council's work (a member whose ownership is unknown, a participant that was replaced, the continuation a retry queued), a later stop or
// correction supersedes an owner's retry that was still waiting for a process to be shown over, and the failure of a member before its input is a
// durable fence that no failed write of ours can turn into a retry: not when an attempt existed (H2), and not when none did, whichever step of the
// launch failed and whether the loop, the process or the store is what came back (H3 to H6).
//
// The interleavings are HELD where the test says and not slept past: an opener that has taken the agent's ordering lock in an open transaction, a
// stop that is seen waiting behind it in `pg_stat_activity`, and the opener committing its attempt while it waits. Real store and handlers; the
// engine and the process are fixtures, and a real runner is used where the rule is what the runner does with a row.

import { afterAll, afterEach, beforeAll, expect, test } from "bun:test"
import { readFileSync, writeFileSync } from "node:fs"
import { startCluster, until, type Cluster } from "./helpers/cluster.ts"
import { PERSON, RUNNER } from "./helpers/hub-fixture.ts"
import { councilStage, GONE, roster, startArgs } from "./helpers/council-stage.ts"
import { insertJob } from "./helpers/conversations.ts"
import { controlledAdapter, observe, retrySettings } from "./helpers/rollout-runner.ts"
import { callTool } from "../src/mcp/handlers.ts"
import { reconcileCouncil } from "../src/council/reconcile.ts"
import { guarded } from "../src/council/guard.ts"
import { fenceAbandonedClaims } from "../src/council/hooks.ts"
import { endAttempt } from "../src/runner/execution.ts"
import { runRunner } from "../src/runner/run.ts"
import { stamp } from "../src/records/stamps.ts"
import { readEligible } from "../src/store/wake.ts"
import { RUNNER_PROTOCOL, activateProtocol, markProgress, openExecution } from "../src/store/conversations.ts"
import { placeGate } from "../src/store/controls.ts"
import type { ExitEvidence } from "../src/adapters/types.ts"
import type { StoreLike } from "../src/store/connect.ts"

let cluster: Cluster
beforeAll(async () => { cluster = await startCluster() })
afterAll(async () => { await cluster?.stop() })

const mine: { close(): Promise<void> }[] = []
const track = <T extends { close(): Promise<void> }>(sql: T): T => { mine.push(sql); return sql }
afterEach(async () => { for (const one of mine.splice(0)) await one.close().catch(() => {}) })

const NOT_GONE: ExitEvidence = { confirmed: false, leader: "unknown", descendants: "unverified", pids: [], survivors: [], via: "test" }

type Stage = Awaited<ReturnType<typeof councilStage>>

const move = (s: Stage, id: string, over: Record<string, unknown>, attempt: string | null = "attempt-master") =>
  s.revision(id).then(revision => callTool(s.binding(attempt), "hub_council", { action: "continue", request_key: `k-${Math.random().toString(36).slice(2, 8)}`,
    council_id: id, expected_revision: revision, ...over }))

const stop = (s: Stage, id: string, over: Record<string, unknown> = {}) =>
  s.revision(id).then(revision => callTool(s.binding("attempt-stop"), "hub_council", { action: "stop", request_key: `stop-${Math.random().toString(36).slice(2, 8)}`,
    council_id: id, expected_revision: revision, source_message_ids: ["h3"], ...over }))

async function begin(s: Stage, workers: string[] = ["p1-w1", "p1-w2"]) {
  const started = await callTool(s.binding("attempt-start"), "hub_council", startArgs({ participants: roster(workers) }))
  const id = String(started.object_id)
  return { id, jobs: await s.jobsOf(id), participants: workers.map((_, at) => `${id}:p${at + 1}`) }
}

const membersOf = async (s: Stage, id: string) => Array.from(await s.su`select participant_id, round, input_revision, state, inbound_id, awaiting from round_member
  where council_id = ${id} order by round, participant_id, input_revision`) as any[]

const lifecycleOf = async (s: Stage, id: string) => String((await s.su`select lifecycle from council where id = ${id}`)[0].lifecycle)

/** A worker's runner backend is seen waiting for an advisory lock: the statement under test stands still exactly there. */
async function waitForOrderingLock(s: Stage) {
  const probe = track(cluster.connect(s.db)) as any
  await until("a runner backend waits for the agent's ordering lock", async () =>
    Number((await probe.unsafe(`select count(*)::int as n from pg_stat_activity where datname = $1 and usename = 'hub_runner' and wait_event_type = 'Lock' and wait_event = 'advisory'`,
      [s.db]))[0].n) > 0, 15_000)
}

/**
 * An opening of an attempt that has taken the agent's ordering lock (the first statement of every opening, `hub_open_order`) in a transaction that is
 * still open, and that inserts its attempt and commits only when the test says: the exact moment between the read and the gate of the old order.
 */
async function holdOpening(s: Stage, job: string) {
  await s.incarnate()
  const conversation = await s.conversationOf(job)
  const [row] = await s.su`select agent from inbound where id = ${job}`
  await s.su`update inbound set claimed_by = 'runner-a', claim_deadline = now() + interval '1 hour' where id = ${job}`
  const held = await (track(cluster.connectAs("hub_runner", s.db)) as any).reserve()
  await held.unsafe("begin")
  await held.unsafe("select hub_open_order($1::text, $2::text, $3::text)", [job, conversation.id, row.agent])
  const execution = crypto.randomUUID()
  return {
    execution, conversation: conversation.id,
    async commit() {
      await held.unsafe(`insert into execution (id, inbound_id, conversation_id, agent, runner, incarnation, placement_generation, state, input_digest, native_session, evidence)
        select $1::text, i.id, c.id, i.agent, 'runner-a', 'one', c.placement_generation, 'claimed', 'd', null, '{}'::jsonb from inbound i, conversation c where i.id = $2::text and c.id = $3::text`,
        [execution, job, conversation.id])
      await held.unsafe("commit")
      held.release()
    },
  }
}

// ---------------------------------------------------------------------------
// 1. The fence comes first, for a stop and for a correction.
// ---------------------------------------------------------------------------

test("F1 stop: an attempt that opens while the stop is being decided is FOUND and asked to end, not called cancelled: the opener holds the agent's ordering lock, the stop waits behind it, and reads what it committed", async () => {
  const s = await councilStage(cluster, track)
  try {
    const { id, jobs: [j1, j2], participants: [p1, p2] } = await begin(s)
    await s.human("h3")
    const opening = await holdOpening(s, j1.id)
    const stopping = stop(s, id)
    stopping.catch(() => {})
    await waitForOrderingLock(s)
    // The stop is standing at its first gate. The opening commits its attempt now, and the stop reads the world after it.
    await opening.commit()
    const reply = await stopping
    expect(reply).toMatchObject({ status: "stopping", stage: "stopping" })
    expect(await lifecycleOf(s, id), "an attempt is owned: the council is not stopped").toBe("stopping")
    const members = await membersOf(s, id)
    expect(members.find(one => one.participant_id === p1)).toMatchObject({ state: "stopping", awaiting: { kind: "stop", execution: opening.execution } })
    expect(members.find(one => one.participant_id === p2), "the one that had really not started is cancelled").toMatchObject({ state: "cancelled" })
    // The stop request is frozen to the attempt that opened, and asked for by the owner.
    expect((await s.su`select state, requested_by from stop_request where execution_id = ${opening.execution}`)[0]).toMatchObject({ state: "requested", requested_by: PERSON })
    // Every job of the council is gated, and nothing was called stopped on silence.
    expect(await s.count("claim_gate", `state = 'open' and scope_id in ('${j1.id}', '${j2.id}')`)).toBe(2)
    expect(await readEligible(s.runner, { agent: "p1-w2", resumeOk: true })).toEqual([])

    // Proof moves it: the process is shown gone, and only then is the council stopped.
    await endAttempt(s.runner, { execution: opening.execution, evidence: GONE, cause: "the process tree is gone", requested: true })
    await reconcileCouncil(s.runner, id)
    expect(await lifecycleOf(s, id)).toBe("stopped")
  } finally { await s.close() }
}, 90_000)

test("F2 correction: an attempt that opens while the correction is being decided is found and asked to end, and no corrected input is queued beside it", async () => {
  const s = await councilStage(cluster, track)
  try {
    const { id, jobs: [j1], participants: [p1] } = await begin(s)
    await s.human("h3")
    const opening = await holdOpening(s, j1.id)
    const correcting = move(s, id, { kind: "correction", source_message_ids: ["h3"], participants: [p1], message: "Should the ledger be weighed twice on a cold scale?",
      briefs: [{ participant_id: p1, text: "consider the cold scale" }] })
    correcting.catch(() => {})
    await waitForOrderingLock(s)
    await opening.commit()
    expect(await correcting).toMatchObject({ status: "running", stage: "correcting" })
    // The old order read "nothing is running", queued the corrected input at once, and left the old attempt owned. Now it waits for the end.
    expect((await membersOf(s, id)).filter(one => one.participant_id === p1)).toMatchObject([{ input_revision: 1, state: "superseding", awaiting: { kind: "correction", execution: opening.execution } }])
    expect(await s.count("inbound", "kind = 'job'"), "no corrected input yet").toBe(2)
    expect((await s.su`select state from stop_request where execution_id = ${opening.execution}`)[0].state).toBe("requested")
    expect(await readEligible(s.runner, { agent: "p1-w1", resumeOk: true }), "the old input is not claimable and the corrected one does not exist").toEqual([])
  } finally { await s.close() }
}, 90_000)

test("F3 a job that is claimed and not yet open is disabled by the stop, so the runner's opening is refused by the gate and hands the claim back; nothing unrelated is touched", async () => {
  const s = await councilStage(cluster, track)
  try {
    const { id, jobs: [j1, j2] } = await begin(s)
    await s.human("h3")
    await insertJob(cluster, s.db, { id: "other-job", target: "p1-w1", task: "something that has nothing to do with the council" })
    // The runner has claimed the member's job and has not opened its attempt yet.
    await s.incarnate()
    const conversation = await s.conversationOf(j1.id)
    await s.su`update inbound set claimed_by = 'runner-a', claim_deadline = now() + interval '1 hour' where id = ${j1.id}`
    expect(await stop(s, id)).toMatchObject({ status: "stopped", stage: "stopped" })
    expect((await membersOf(s, id)).map(one => one.state)).toEqual(["cancelled", "cancelled"])
    // The opening is the runner's next step, and the store refuses it by name.
    await expect(openExecution(s.runner, { row: { id: j1.id, agent: "p1-w1" }, conversation, runner: "runner-a", incarnation: "one", digest: "d", nativeSession: null }))
      .rejects.toMatchObject({ name: "ExecutionNotOwned", reason: "gate" })
    expect(await s.count("execution")).toBe(0)
    // The ordinary job of the same agent is the owner's other business: still there, not gated, still claimable.
    expect((await readEligible(s.runner, { agent: "p1-w1", resumeOk: true })).map(row => row.id)).toEqual(["other-job"])
    expect((await s.su`select scope_id from claim_gate where state = 'open' order by scope_id`).map((row: any) => row.scope_id).sort()).toEqual([j1.id, j2.id].sort())
  } finally { await s.close() }
}, 90_000)

test("F4 stop: a member that is already missing because its ownership is unknown is not left out of the stop: it is asked to end, and the council is not called stopped until that is shown", async () => {
  const s = await councilStage(cluster, track)
  try {
    const { id, jobs: [j1, j2], participants: [p1] } = await begin(s)
    const run = await s.running(j1.id)
    await markProgress(s.runner, run.execution, "running")
    // The process is lost track of: an end nobody can show. The attempt stays owned and the input is held.
    await endAttempt(s.runner, { execution: run.execution, evidence: NOT_GONE, cause: "lost track of the process" })
    await reconcileCouncil(s.runner, id)
    expect((await membersOf(s, id)).find(one => one.participant_id === p1)).toMatchObject({ state: "missing" })
    expect((await s.su`select state from execution where id = ${run.execution}`)[0].state).toBe("unknown")
    await s.human("h3")

    const reply = await stop(s, id)
    expect(reply).toMatchObject({ status: "stopping", stage: "stopping" })
    expect(await lifecycleOf(s, id), "a member that was `missing` is not a settled member").toBe("stopping")
    expect((await membersOf(s, id)).find(one => one.participant_id === p1)).toMatchObject({ state: "stopping", awaiting: { kind: "stop", execution: run.execution } })
    expect((await s.su`select requested_by, execution_id from stop_request where execution_id = ${run.execution}`)[0]).toMatchObject({ requested_by: PERSON })
    // Silence and time do not stop it; more looks do not either.
    await reconcileCouncil(s.runner, id)
    expect(await lifecycleOf(s, id)).toBe("stopping")

    await endAttempt(s.runner, { execution: run.execution, evidence: GONE, cause: "the process tree is gone", requested: true })
    await reconcileCouncil(s.runner, id)
    expect(await lifecycleOf(s, id)).toBe("stopped")
    expect((await s.su`select state from claim_gate where scope_id = ${j2.id}`)[0].state, "and the one that never started stayed disabled").toBe("open")
  } finally { await s.close() }
}, 90_000)

test("F5 stop: a participant that was REPLACED and whose process may still be running is part of the council's work: it is asked to end, and the council is not stopped over it", async () => {
  const s = await councilStage(cluster, track)
  try {
    const { id, jobs: [, j2], participants: [, p2] } = await begin(s)
    const run = await s.running(j2.id)
    await endAttempt(s.runner, { execution: run.execution, evidence: NOT_GONE, cause: "lost track of the process" })
    await reconcileCouncil(s.runner, id)
    await s.human("h3")
    const replaced = await move(s, id, { kind: "owner_decision", source_message_ids: ["h3"],
      decision: { choice: "replace", affected_ids: [p2], replacement_spec: { worker_ref: "p1-w3", preset_ref: "daily", machine_ref: RUNNER, brief: "take over from the one that was lost" } } })
    expect(replaced).toMatchObject({ stage: "replaced" })
    expect((await s.su`select state from council_participant where id = ${p2}`)[0].state).toBe("replaced")
    await s.human("h4")

    const reply = await stop(s, id, { source_message_ids: ["h4"] })
    expect(reply).toMatchObject({ status: "stopping" })
    expect(await lifecycleOf(s, id)).toBe("stopping")
    // The replaced participant's own attempt is asked to end, though it no longer counts toward the answer.
    expect((await s.su`select state from stop_request where execution_id = ${run.execution}`)[0].state).toBe("requested")
    const members = await membersOf(s, id)
    expect(members.find(one => one.participant_id === p2)).toMatchObject({ state: "stopping", awaiting: { kind: "stop", execution: run.execution } })
    expect(members.filter(one => one.participant_id !== p2).map(one => one.state).sort()).toEqual(["cancelled", "cancelled"])
    // Every unanswered job of the council is gated, the replacement's included.
    expect(await s.count("claim_gate", "state = 'open' and cause = 'council'")).toBe(3)

    await endAttempt(s.runner, { execution: run.execution, evidence: GONE, cause: "the process tree is gone", requested: true })
    await reconcileCouncil(s.runner, id)
    expect(await lifecycleOf(s, id)).toBe("stopped")
  } finally { await s.close() }
}, 120_000)

// ---------------------------------------------------------------------------
// 2. A later stop or correction supersedes an owner's retry that is still waiting.
// ---------------------------------------------------------------------------

/** A council whose first participant's process is lost track of, and whose owner chose to retry it: the choice waits for the process to be shown over. */
async function pendingRetry(s: Stage) {
  const begun = await begin(s)
  const [j1] = begun.jobs
  const [p1] = begun.participants
  const run = await s.running(j1.id)
  await markProgress(s.runner, run.execution, "running")
  await endAttempt(s.runner, { execution: run.execution, evidence: NOT_GONE, cause: "lost track of the process" })
  await reconcileCouncil(s.runner, begun.id)
  await s.human("h2b")
  const retried = await move(s, begun.id, { kind: "owner_decision", source_message_ids: ["h2b"], message: "carry on, and check the state first",
    decision: { choice: "retry", affected_ids: [p1] } })
  expect(retried).toMatchObject({ stage: "retrying" })
  expect((await s.su`select state, revision, continuation_id from replay_hold where inbound_id = ${j1.id}`)[0], "the choice waits for proof that the old process is over")
    .toMatchObject({ state: "continue_pending", revision: 1, continuation_id: null })
  return { ...begun, j1, p1, run }
}

test("G1 a pending retry, then a correction after the checkpoint, then the proof: the retry is cancelled with the store's own choice, nothing is runnable before the extension, and afterwards exactly one input, the correction's, goes into the same conversation", async () => {
  const s = await councilStage(cluster, track)
  try {
    const { id, j1, p1, run } = await pendingRetry(s)
    await s.su`update council set checkpoint_deadline = now() - interval '1 minute' where id = ${id}`
    await s.human("h3")
    const saved = await move(s, id, { kind: "correction", source_message_ids: ["h3"], participants: [p1], message: "Should the ledger be weighed twice on a cold scale?",
      briefs: [{ participant_id: p1, text: "consider the cold scale" }] })
    expect(saved).toMatchObject({ status: "waiting_owner", stage: "correction_waiting_checkpoint" })
    // The earlier choice was superseded by the store's own current-revision choice, and its result was checked.
    const [cancelled] = Array.from(await s.su`select state, revision, continuation_id, evidence from replay_hold where inbound_id = ${j1.id}`) as any[]
    expect(cancelled).toMatchObject({ state: "keep_held", revision: 1, continuation_id: null, evidence: { superseded_by: "correction", superseded_choice: "continue", source: "council" } })
    expect((await s.su`select state from stop_request where execution_id = ${run.execution}`)[0].state).toBe("requested")

    // The proof that the old process is over arrives. Before, it queued the retry with the OLD question's words, claimable, past the checkpoint.
    await endAttempt(s.runner, { execution: run.execution, evidence: GONE, cause: "the process tree is gone", requested: true })
    await reconcileCouncil(s.runner, id)
    expect(await s.count("inbound", "id like 'continue:%'"), "no continuation, old or corrected, before the owner extends").toBe(0)
    expect(await readEligible(s.runner, { agent: "p1-w1", resumeOk: true }), "nothing is runnable").toEqual([])
    expect((await s.su`select state, revision, continuation_id from replay_hold where inbound_id = ${j1.id}`)[0]).toMatchObject({ state: "keep_held", revision: 2, continuation_id: null })
    expect((await membersOf(s, id)).filter(one => one.participant_id === p1)).toMatchObject([{ state: "superseding", awaiting: { cleared: false } }])

    // The owner extends. The correction starts, once, as the correction's own continuation of the held input, in the same conversation.
    await s.human("h4")
    expect(await move(s, id, { kind: "owner_decision", source_message_ids: ["h4"], decision: { choice: "extend", extension_scope: { rounds: 1 } } })).toMatchObject({ stage: "checkpoint_extended" })
    expect(await s.count("inbound", "id like 'continue:%'"), "exactly one").toBe(1)
    const [hold] = Array.from(await s.su`select state, revision, continuation_id, evidence from replay_hold where inbound_id = ${j1.id}`) as any[]
    expect(hold).toMatchObject({ state: "continuing", continuation_id: `continue:${j1.id}:2`, evidence: { source: "council", question_revision: 2 } })
    expect(typeof hold.evidence.correction, "attributed to the correction").toBe("string")
    const continuation = (await s.su`select body, source from inbound where id = ${hold.continuation_id}`)[0]
    expect(continuation.body).toContain("ended on purpose")
    expect(continuation.body).toContain("consider the cold scale")
    expect(continuation.body, "not the retry's words").not.toContain("carry on, and check the state first")
    expect(continuation.source.dispatch.conversation).toBe(run.conversation)
    expect((await membersOf(s, id)).filter(one => one.participant_id === p1).map(one => [one.input_revision, one.state, one.inbound_id])).toEqual([[1, "superseded", j1.id], [2, "open", hold.continuation_id]])
    expect((await readEligible(s.runner, { agent: "p1-w1", resumeOk: true })).map(row => row.id)).toEqual([hold.continuation_id])
  } finally { await s.close() }
}, 120_000)

test("G2 a pending retry, then a stop, then the proof: the retry is cancelled, nothing is queued into the stopped council, and nothing is runnable", async () => {
  const s = await councilStage(cluster, track)
  try {
    const { id, j1, run } = await pendingRetry(s)
    await s.human("h3")
    expect(await stop(s, id)).toMatchObject({ status: "stopping" })
    expect((await s.su`select state, evidence from replay_hold where inbound_id = ${j1.id}`)[0]).toMatchObject({ state: "keep_held", evidence: { superseded_by: "stop", superseded_choice: "continue" } })
    await endAttempt(s.runner, { execution: run.execution, evidence: GONE, cause: "the process tree is gone", requested: true })
    await reconcileCouncil(s.runner, id)
    expect(await lifecycleOf(s, id)).toBe("stopped")
    expect(await s.count("inbound", "id like 'continue:%'"), "no continuation into a stopped council").toBe(0)
    expect(await readEligible(s.runner, { agent: "p1-w1", resumeOk: true })).toEqual([])
    // What is later reconciled does not start anything either.
    await reconcileCouncil(s.runner, id)
    expect(await s.count("inbound", "kind = 'job'")).toBe(2)
  } finally { await s.close() }
}, 120_000)

test("G3 the other order: the process is shown over FIRST, so the retry's continuation is already queued when the correction arrives: it is found, gated, never taken for the corrected input, and only the correction's own input runs after the extension", async () => {
  const s = await councilStage(cluster, track)
  try {
    const { id, j1, p1, run } = await pendingRetry(s)
    // Advancement wins: the proof arrives, and the store queues the retry.
    await endAttempt(s.runner, { execution: run.execution, evidence: GONE, cause: "the process tree is gone" })
    const old = `continue:${j1.id}:1`
    expect((await s.su`select state, continuation_id from replay_hold where inbound_id = ${j1.id}`)[0]).toMatchObject({ state: "continuing", continuation_id: old })
    await reconcileCouncil(s.runner, id)
    await s.su`update council set checkpoint_deadline = now() - interval '1 minute' where id = ${id}`
    await s.human("h3")
    const saved = await move(s, id, { kind: "correction", source_message_ids: ["h3"], participants: [p1], message: "Should the ledger be weighed twice on a cold scale?",
      briefs: [{ participant_id: p1, text: "consider the cold scale" }] })
    expect(saved).toMatchObject({ status: "waiting_owner", stage: "correction_waiting_checkpoint" })
    // The continuation the retry made is the council's work of the old question: gated, so nothing claims it, and not the corrected member.
    expect((await s.su`select state from claim_gate where operation_id = ${"council-correct:" + old}`)[0].state).toBe("open")
    expect(await readEligible(s.runner, { agent: "p1-w1", resumeOk: true }), "neither the old continuation nor a corrected input is runnable").toEqual([])
    expect((await membersOf(s, id)).filter(one => one.participant_id === p1)).toMatchObject([{ input_revision: 1, state: "superseding", awaiting: { execution: null, cleared: false } }])
    expect(await s.count("inbound", "kind = 'job'"), "no corrected input yet: the two jobs and the retry's continuation").toBe(3)

    await s.human("h4")
    await move(s, id, { kind: "owner_decision", source_message_ids: ["h4"], decision: { choice: "extend", extension_scope: { rounds: 1 } } })
    const members = (await membersOf(s, id)).filter(one => one.participant_id === p1)
    expect(members.map(one => [one.input_revision, one.state])).toEqual([[1, "superseded"], [2, "open"]])
    const fresh = members[1].inbound_id
    expect(fresh, "the correction's own new input, not the retry's continuation").not.toBe(old)
    expect((await s.su`select body, source from inbound where id = ${fresh}`)[0].body).toContain("consider the cold scale")
    expect((await s.su`select source from inbound where id = ${fresh}`)[0].source.dispatch.conversation, "in the same conversation").toBe(run.conversation)
    expect((await readEligible(s.runner, { agent: "p1-w1", resumeOk: true })).map(row => row.id), "exactly one input, and it is the correction's").toEqual([fresh])
    expect((await s.su`select hub_row_held(${old}) as held`)[0].held).toBe(true)
  } finally { await s.close() }
}, 120_000)

test("G4 the other order, for a stop: the retry's continuation is already RUNNING when the stop arrives: its attempt is found and asked to end, and the council is not stopped over it", async () => {
  const s = await councilStage(cluster, track)
  try {
    const { id, j1, run } = await pendingRetry(s)
    await endAttempt(s.runner, { execution: run.execution, evidence: GONE, cause: "the process tree is gone" })
    const old = `continue:${j1.id}:1`
    const running = await s.running(old)
    await s.human("h3")
    expect(await stop(s, id)).toMatchObject({ status: "stopping" })
    expect(await lifecycleOf(s, id)).toBe("stopping")
    expect((await s.su`select state from stop_request where execution_id = ${running.execution}`)[0].state).toBe("requested")
    expect((await membersOf(s, id)).find(one => one.inbound_id === j1.id)).toMatchObject({ state: "stopping", awaiting: { kind: "stop", execution: running.execution } })
    await endAttempt(s.runner, { execution: running.execution, evidence: GONE, cause: "the process tree is gone", requested: true })
    await reconcileCouncil(s.runner, id)
    expect(await lifecycleOf(s, id)).toBe("stopped")
    expect(await s.count("inbound", "id like 'continue:%'"), "still the one the retry made, and nothing after it").toBe(1)
  } finally { await s.close() }
}, 120_000)

// ---------------------------------------------------------------------------
// 3. A member's failure before its input is a durable fence, and a hook that may fail is contained by a real savepoint.
// ---------------------------------------------------------------------------

test("H1 a hook runs only inside a transaction, and an optional hook that fails is undone alone: the fence written before it in the same transaction survives, and the transaction stays usable", async () => {
  const s = await councilStage(cluster, track)
  try {
    const { jobs: [j1] } = await begin(s)
    // Outside a transaction there is no savepoint to protect anything with, and the hook is not run unprotected.
    await expect(guarded(s.runner, "outside", async () => { throw new Error("never runs") })).rejects.toThrow(/transaction/)
    await s.runner.sql.begin(async (tx: any) => {
      const inside = { ...s.runner, sql: tx } as StoreLike
      await placeGate(inside, { operation: "council-failed:test", scope: { kind: "row", id: j1.id }, cause: "council", evidence: { cause: "test" } })
      const kept = await guarded(inside, "optional", async (inner) => { await inner.sql`select 1 / 0` })
      expect(kept, "the failing hook was rolled back alone").toBe(false)
      // The transaction was not left aborted: it goes on, and what the hook did not do is still possible.
      expect((await inside.sql`select 1 as one`)[0].one).toBe(1)
      expect(await guarded(inside, "next", async (inner) => { await inner.sql`select 2` })).toBe(true)
    })
    expect((await s.su`select state from claim_gate where operation_id = 'council-failed:test'`)[0].state, "the fence survived the failed hook").toBe("open")
  } finally { await s.close() }
}, 60_000)

test("H2 the failure of a member before its input: the fence is written by the transaction that ends the attempt, so a failed write leaves the attempt owned and the row unclaimable, a restart writes it, and only the owner's fresh retry lets work proceed", async () => {
  // The master takes its turns on demand (no child of its own is started at the runner's start, which would take the one start that is to fail).
  const s = await councilStage(cluster, track, {
    hub: { tick_seconds: 1 },
    registry: base => ({ ...base, agents: base.agents.map((one: { id: string }) => (one.id === "p1-lair" ? { ...one, mode: "on-demand" } : one)) }),
  })
  retrySettings(s)
  // Room for the workers beside the master's kept slot, whatever the defaults are.
  writeFileSync(s.registryFile, readFileSync(s.registryFile, "utf8").replace(`id = ${JSON.stringify(RUNNER)}\n`, `id = ${JSON.stringify(RUNNER)}\nmax_active_children = 4\n`))
  // The two staging messages are not this test's traffic: answered the way the runner answers a message, so no engine is started for the master.
  for (const message of ["h1", "h2"]) await stamp(s.runner, { messageId: message, kind: "answered", actor: "runner" })
  const edge = controlledAdapter(s.adapterName, false, { capabilities: { stableSession: true, safeResume: false, delegationDisabled: true } })
  let first: Awaited<ReturnType<typeof runRunner>> | undefined
  let second: Awaited<ReturnType<typeof runRunner>> | undefined
  // The runner says on stderr when an agent's loop ends by a failure of its own: that is the signal that its failure path ran, and failed.
  const said: string[] = []
  const write = process.stderr.write.bind(process.stderr)
  process.stderr.write = ((chunk: unknown, ...rest: unknown[]) => { said.push(String(chunk)); return (write as (...args: unknown[]) => boolean)(chunk, ...rest) }) as typeof process.stderr.write
  try {
    const { id, jobs: [j1, j2], participants: [p1] } = await begin(s)
    // Only the first member is startable: the second waits behind a gate of the test's own, so what fails is the first member's start and nothing else.
    await placeGate(s.runner, { operation: "test-hold-second", scope: { kind: "row", id: j2.id }, cause: "test" })
    // Its engine cannot be started, once: a failure BEFORE the input (the attempt was opened and nothing was fed).
    let starts = 0
    edge.failStarts(1, () => { starts += 1; return true })
    // The write of the fence fails, and stays failed until the test says: a trigger on the gate table, switched by a row.
    await s.su`create table test_switch (name text primary key)`
    await s.su`grant select on test_switch to public`
    await s.su`create function test_fail_gate() returns trigger language plpgsql as $$ begin
      if new.operation_id like 'council-failed:%' and exists (select 1 from test_switch where name = 'fail-gate') then raise exception 'injected: the fence could not be written'; end if;
      return new; end $$`
    await s.su`create trigger test_fail_gate before insert on claim_gate for each row execute function test_fail_gate()`
    await s.su`insert into test_switch values ('fail-gate')`

    first = await runRunner({ runner: RUNNER, registryFile: s.registryFile, adapters: { [s.adapterName]: edge.adapter } })
    await until("the first member's failure path ran and failed", async () => said.some(line => line.includes("agent-loop-ended: p1-w1")), 30_000, () => said.join(""))
    expect(starts, "its engine was asked to start once").toBe(1)
    // The fence could not be written, so nothing released the row: the attempt is still owned, the row is still claimed by it, no gate exists, and the
    // failure path's own release (which used to put the row back on a retry) did not run either.
    expect((await s.su`select state from execution where inbound_id = ${j1.id}`)[0].state).toBe("claimed")
    expect((await s.su`select claimed_by from inbound where id = ${j1.id}`)[0].claimed_by).toBe(RUNNER)
    expect(await s.count("claim_gate", "operation_id like 'council-failed:%'")).toBe(0)
    expect(await s.count("execution", `inbound_id = '${j1.id}'`)).toBe(1)
    expect(await readEligible(s.runner, { agent: "p1-w1", resumeOk: true }), "an owned attempt blocks its agent and its row").toEqual([])
    await first.stop()
    first = undefined

    // The obligation is repaired without generating anything: the fault is gone and the runner starts again, which ends the attempt as it always did and
    // writes the fence in that same transaction. The row is not eligible, and nobody is given an input.
    await s.su`delete from test_switch`
    second = await runRunner({ runner: RUNNER, registryFile: s.registryFile, adapters: { [s.adapterName]: edge.adapter } })
    await until("the fence exists", async () => (await s.count("claim_gate", `operation_id = 'council-failed:${j1.id}' and state = 'open'`)) === 1, 30_000)
    await reconcileCouncil(s.runner, id)
    expect((await s.su`select state, cause from round_member where participant_id = ${p1}`)[0]).toMatchObject({ state: "missing", cause: { kind: "failed_before_start" } })
    expect((await s.su`select state from execution where inbound_id = ${j1.id}`)[0].state).toBe("failed")
    expect(await s.count("execution", `inbound_id = '${j1.id}'`), "no second attempt").toBe(1)
    expect(edge.sessions.flatMap(row => row.fed).filter(message => message.id === j1.id), "the input was never offered to an engine").toHaveLength(0)
    // Past any retry deadline, still nothing: it is gated, not waiting to be tried again.
    await s.su`update inbound set retry_at = now() - interval '1 hour' where id = ${j1.id}`
    expect(await readEligible(s.runner, { agent: "p1-w1", resumeOk: true })).toEqual([])
    expect(await observe(async () => (await s.count("execution", `inbound_id = '${j1.id}'`)) > 1, 2000), "nothing starts it again").toBe(false)
    expect(await lifecycleOf(s, id)).toBe("waiting_owner")

    // Only the owner's fresh retry lets work proceed: a new input, in the member's own conversation, that the runner takes and the engine is fed.
    await s.human("h3")
    const retried = await move(s, id, { kind: "owner_decision", source_message_ids: ["h3"], decision: { choice: "retry", affected_ids: [p1] } })
    expect(retried).toMatchObject({ stage: "retrying" })
    const [fresh] = (await membersOf(s, id)).filter(one => one.participant_id === p1 && one.state === "open")
    expect(fresh.input_revision).toBe(2)
    await until("the retried input was answered", async () => (await s.su`select state from inbound where id = ${fresh.inbound_id}`)[0]?.state === "answered", 30_000,
      async () => JSON.stringify(await s.su`select id, state from inbound where kind = 'job'`))
    expect(edge.sessions.flatMap(row => row.fed).filter(message => message.id === fresh.inbound_id)).toHaveLength(1)
    expect(edge.sessions.flatMap(row => row.fed).filter(message => message.id === j1.id), "and the refused input was never fed").toHaveLength(0)
  } finally {
    process.stderr.write = write
    await first?.stop().catch(() => {}); await second?.stop().catch(() => {}); await edge.stop().catch(() => {}); await s.close()
  }
}, 240_000)

// ---------------------------------------------------------------------------
// 4. A member that fails BEFORE an attempt exists, whichever step it was in, is not fed when the store is back.
// ---------------------------------------------------------------------------

/**
 * A real runner over the staged council's workers with a scripted engine. The master takes its turns on demand: no child is started for it when the runner
 * starts, but a message the owner sends it (h3, below) is still an input the runner claims, opens and serves with a turn of its own.
 */
async function stageWorkers() {
  const s = await councilStage(cluster, track, {
    hub: { tick_seconds: 1 },
    registry: base => ({ ...base, agents: base.agents.map((one: { id: string }) => (one.id === "p1-lair" ? { ...one, mode: "on-demand" } : one)) }),
  })
  retrySettings(s)
  writeFileSync(s.registryFile, readFileSync(s.registryFile, "utf8").replace(`id = ${JSON.stringify(RUNNER)}\n`, `id = ${JSON.stringify(RUNNER)}\nmax_active_children = 4\n`))
  for (const message of ["h1", "h2"]) await stamp(s.runner, { messageId: message, kind: "answered", actor: "runner" })
  const edge = controlledAdapter(s.adapterName, false, { capabilities: { stableSession: true, safeResume: false, delegationDisabled: true } })
  const start = () => runRunner({ runner: RUNNER, registryFile: s.registryFile, adapters: { [s.adapterName]: edge.adapter } })
  // What the runner says on stderr is the signal that an agent's loop ended by a failure of its own, and that a claim was fenced.
  const said: string[] = []
  const write = process.stderr.write.bind(process.stderr)
  process.stderr.write = ((chunk: unknown, ...rest: unknown[]) => { said.push(String(chunk)); return (write as (...args: unknown[]) => boolean)(chunk, ...rest) }) as typeof process.stderr.write
  const fed = (job: string) => edge.sessions.flatMap(row => row.fed).filter(message => message.id === job)
  /**
   * The end of every test that stages workers: `cleanup` (the runners, the engine, the stage) ALWAYS runs, and stderr is given back after it, so what the
   * runner and the adapter said while they were stopped is read too. A deadlock in what they said is a failure of the test even when every assertion of its
   * body held (an agent's loop that died of one is otherwise only a line in the log). When the body itself failed, its error is the one reported.
   */
  async function finish(passed: boolean, cleanup: () => Promise<unknown>) {
    try { await cleanup() } finally { process.stderr.write = write }
    if (passed) expect(said.filter(line => /deadlock/i.test(line)), "nothing the runner or the adapter said, through cleanup, was a deadlock").toEqual([])
  }
  return { s, edge, start, said, fed, finish }
}

/**
 * Failures the test switches: the write of a member's failure fence (a trigger on the gate table, for the fence's own operation), and the opening of an
 * attempt (a trigger on the attempt table). Both are switched by a row, so they can be taken away without touching the runner.
 */
async function installFaults(s: Stage) {
  await s.su`create table test_switch (name text primary key)`
  await s.su`grant select on test_switch to public`
  await s.su`create function test_fail_gate() returns trigger language plpgsql as $$ begin
    if new.operation_id like 'council-failed:%' and exists (select 1 from test_switch where name = 'fail-gate') then raise exception 'injected: the fence could not be written'; end if;
    return new; end $$`
  await s.su`create trigger test_fail_gate before insert on claim_gate for each row execute function test_fail_gate()`
  await s.su`create function test_fail_open() returns trigger language plpgsql as $$ begin
    if exists (select 1 from test_switch where name = 'fail-open') then raise exception 'injected: the attempt could not be opened'; end if;
    return new; end $$`
  await s.su`create trigger test_fail_open before insert on execution for each row execute function test_fail_open()`
}

/**
 * The owner's fresh retry of a member whose input was fenced: a new input, in the member's own conversation, that the runner takes and the engine is fed once.
 *
 * The owner's decision is a DIRECT CALL of the test to the tool, under the synthetic attempt "attempt-master"; it is not a call the master made from inside a turn.
 * It cites h3, the message the real runner is at the same moment free to claim, open and serve for the master, so what this case keeps is the concurrency of a tool
 * call that spends a message with the opening of the attempt that serves it, in whichever order they land. It does not model the master's own call, which cannot
 * overlap the opening of its own turn. The master's turn on h3 has a defined outcome that the test waits for and does not hide behind the member's success: it
 * completes, once, and no turn of the master failed.
 */
async function ownersRetryRuns(s: Stage, fed: (job: string) => unknown[], id: string, participant: string, refused: string) {
  await s.human("h3")
  const retried = await move(s, id, { kind: "owner_decision", source_message_ids: ["h3"], decision: { choice: "retry", affected_ids: [participant] } })
  expect(retried).toMatchObject({ stage: "retrying" })
  const [fresh] = (await membersOf(s, id)).filter(one => one.participant_id === participant && one.state === "open")
  expect(fresh.input_revision).toBe(2)
  await until("the retried input was answered", async () => (await s.su`select state from inbound where id = ${fresh.inbound_id}`)[0]?.state === "answered", 30_000,
    async () => JSON.stringify(await s.su`select id, state from inbound where kind = 'job'`))
  expect(fed(fresh.inbound_id), "the fresh input was fed once").toHaveLength(1)
  expect(fed(refused), "and the fenced input never was").toHaveLength(0)
  // The master's own turn on the owner's message: one attempt, completed, and the message answered. Nothing of the master's failed.
  await until("the master's turn on the owner's message completed", async () => {
    const turns = Array.from(await s.su`select state from execution where inbound_id = 'h3'`) as { state: string }[]
    return turns.length === 1 && turns[0].state === "completed"
  }, 30_000, async () => JSON.stringify(await s.su`select agent, inbound_id, purpose, state from execution where agent = 'p1-lair' order by started_at`))
  expect((await s.su`select state from inbound where id = 'h3'`)[0].state, "the owner's message was answered").toBe("answered")
  expect(Array.from(await s.su`select id, inbound_id, state from execution where agent = 'p1-lair' and state in ('failed', 'unknown', 'stop_unknown')`), "no turn of the master failed").toEqual([])
}

interface Fault { on(s: Stage): Promise<unknown>; off(s: Stage): Promise<unknown> }

/**
 * A member's launch fails at a step BEFORE any attempt exists for it (the fault), and the failure path cannot write the member's fence either (the store is
 * what failed). The claim is still the runner's. The store then comes back, first for everything but the fence, then for the fence: the loop is served again
 * after the retry delay, and again, and a runner that starts afterwards, and none of them feeds the input. The old failure path put the claimed row back on a
 * retry time, or left the claim for the next loop to take as its own, and the next loop fed it.
 */
async function preAttemptFailure(fault: Fault) {
  const { s, edge, start, said, fed, finish } = await stageWorkers()
  let first: Awaited<ReturnType<typeof runRunner>> | undefined
  let second: Awaited<ReturnType<typeof runRunner>> | undefined
  let passed = false
  try {
    const { id, jobs: [j1, j2], participants: [p1] } = await begin(s)
    // Only the first member is startable: the second waits behind a gate of the test's own, so what fails is the first member's launch and nothing else.
    await placeGate(s.runner, { operation: "test-hold-second", scope: { kind: "row", id: j2.id }, cause: "test" })
    await installFaults(s)
    await fault.on(s)
    await s.su`insert into test_switch values ('fail-gate')`
    const ended = () => said.filter(line => line.includes("agent-loop-ended: p1-w1: injected: the fence could not be written")).length

    first = await start()
    await until("the member's launch failed before any attempt existed and the fence could not be written", () => ended() >= 1, 30_000, () => said.join(""))
    // Nothing released the claim, nothing put the row on a retry time, and no attempt was ever opened.
    expect((await s.su`select claimed_by, retry_at from inbound where id = ${j1.id}`)[0]).toMatchObject({ claimed_by: RUNNER, retry_at: null })
    expect(await s.count("claim_gate", "operation_id like 'council-failed:%'")).toBe(0)
    expect(await s.count("execution", `inbound_id = '${j1.id}'`)).toBe(0)

    // The store comes back for everything but the fence. The loop is served again after its retry delay, twice: each time it must write the fence
    // before it claims anything, cannot, and so claims nothing. The row it still holds is not opened and not fed.
    await fault.off(s)
    const before = ended()
    await until("the loop was served again twice and each time could not fence, so it claimed nothing", () => ended() >= before + 2, 45_000, () => said.join(""))
    expect(await s.count("execution", `inbound_id = '${j1.id}'`), "no attempt was opened for the claimed row by a restarted loop").toBe(0)
    expect(fed(j1.id)).toHaveLength(0)
    expect(await s.count("claim_gate", "operation_id like 'council-failed:%'")).toBe(0)

    // The fence can be written again. The next loop writes it first, from what the store shows, and releases the claim it found.
    await s.su`delete from test_switch`
    await until("the abandoned claim was fenced before anything was claimed", async () => (await s.count("claim_gate", `operation_id = 'council-failed:${j1.id}' and state = 'open'`)) === 1, 45_000,
      () => said.join(""))
    expect(said.join("")).toContain(`council-claim-fenced: p1-w1: ${j1.id}`)
    expect((await s.su`select evidence from claim_gate where operation_id = ${"council-failed:" + j1.id}`)[0].evidence).toMatchObject({ council: id })
    expect((await s.su`select claimed_by from inbound where id = ${j1.id}`)[0].claimed_by).toBeNull()
    expect(await s.count("execution", `inbound_id = '${j1.id}'`)).toBe(0)
    expect(fed(j1.id)).toHaveLength(0)
    await reconcileCouncil(s.runner, id)
    expect((await s.su`select state, cause from round_member where participant_id = ${p1}`)[0]).toMatchObject({ state: "missing", cause: { kind: "failed_before_start" } })
    expect(await lifecycleOf(s, id)).toBe("waiting_owner")

    // Past any retry time, and across a restart of the whole runner: the member is not started again.
    await first.stop()
    first = undefined
    await s.su`update inbound set retry_at = now() - interval '1 hour' where id = ${j1.id}`
    second = await start()
    expect(await observe(async () => (await s.count("execution", `inbound_id = '${j1.id}'`)) > 0, 4000), "a restarted runner does not start it").toBe(false)
    expect(fed(j1.id)).toHaveLength(0)
    expect(await readEligible(s.runner, { agent: "p1-w1", resumeOk: true })).toEqual([])

    // The owner's explicit retry stays usable.
    await ownersRetryRuns(s, fed, id, p1, j1.id)
    passed = true
  } finally {
    await finish(passed, async () => {
      await first?.stop().catch(() => {}); await second?.stop().catch(() => {}); await edge.stop().catch(() => {}); await s.close()
    })
  }
}

test("H3 a member whose launch fails at the READ of its approved profile, before the claim was even known to be a council's, while its fence cannot be written, is not fed when the store is back: the next loop fences it before it claims anything, past the retry delay and across a restart, and the owner's retry runs", async () => {
  await preAttemptFailure({
    on: s => s.su`revoke select on council_participant from hub_runner`,
    off: s => s.su`grant select on council_participant to hub_runner`,
  })
}, 300_000)

test("H4 a member whose attempt cannot be opened, while its fence cannot be written, is not fed when the store is back: the claim it was left holding is fenced by the next loop before it claims anything, past the retry delay and across a restart, and the owner's retry runs", async () => {
  await preAttemptFailure({
    on: s => s.su`insert into test_switch values ('fail-open')`,
    off: s => s.su`delete from test_switch where name = 'fail-open'`,
  })
}, 300_000)

test("H5 a claim that a dead process left on a member's job is a launch that did not finish: the runner that starts fences it before it claims anything, whatever its retry time says, and another agent's ordinary job is served as ever", async () => {
  const { s, edge, start, said, fed, finish } = await stageWorkers()
  let runner: Awaited<ReturnType<typeof runRunner>> | undefined
  let passed = false
  try {
    const { id, jobs: [j1, j2], participants: [p1] } = await begin(s)
    await placeGate(s.runner, { operation: "test-hold-second", scope: { kind: "row", id: j2.id }, cause: "test" })
    await insertJob(cluster, s.db, { id: "ordinary", target: "p1-w3", task: "something that has nothing to do with the council" })
    // The store is already on the current protocol, as it is once any runner of this build has started: a claim left behind AFTER that is an abandoned
    // claim (what the sweep is for), not an input an older runner may have handed to an engine (which the activation itself refuses, and must). The
    // supported activation runs while nothing is claimed, so no protection is bypassed and no input is settled or discarded to get past it.
    await activateProtocol(s.runner)
    expect(Number((await s.su`select runner_protocol from hub_protocol`)[0].runner_protocol), "the current protocol is active before anything is claimed").toBe(RUNNER_PROTOCOL)
    // A process that took both claims died before it opened an attempt for either: nothing was fed, and nothing was written down.
    await s.su`update inbound set claimed_by = ${RUNNER}, claim_deadline = now() + interval '1 hour' where id in (${j1.id}, 'ordinary')`
    expect(await s.count("execution")).toBe(0)

    runner = await start()
    await until("the abandoned claim was fenced", async () => (await s.count("claim_gate", `operation_id = 'council-failed:${j1.id}' and state = 'open'`)) === 1, 30_000, () => said.join(""))
    expect(said.join("")).toContain(`council-claim-fenced: p1-w1: ${j1.id}`)
    expect((await s.su`select claimed_by from inbound where id = ${j1.id}`)[0].claimed_by).toBeNull()
    expect(await s.count("execution", `inbound_id = '${j1.id}'`), "the member's input was not opened by the runner that found its claim").toBe(0)
    expect(fed(j1.id)).toHaveLength(0)
    // Nothing else was gated: the ordinary job of another agent, claimed the same way, is served by the same runner as it always was.
    expect(await s.count("claim_gate", "scope_id = 'ordinary'")).toBe(0)
    await until("the ordinary job was served", async () => (await s.su`select state from inbound where id = 'ordinary'`)[0].state === "answered", 30_000,
      async () => JSON.stringify(await s.su`select id, state, claimed_by from inbound where kind = 'job'`))
    expect(fed("ordinary")).toHaveLength(1)

    await reconcileCouncil(s.runner, id)
    expect((await s.su`select state, cause from round_member where participant_id = ${p1}`)[0]).toMatchObject({ state: "missing", cause: { kind: "failed_before_start" } })
    await s.su`update inbound set retry_at = now() - interval '1 hour' where id = ${j1.id}`
    expect(await observe(async () => (await s.count("execution", `inbound_id = '${j1.id}'`)) > 0, 3000), "nothing starts it later either").toBe(false)
    expect(await readEligible(s.runner, { agent: "p1-w1", resumeOk: true })).toEqual([])
    await ownersRetryRuns(s, fed, id, p1, j1.id)
    passed = true
  } finally {
    await finish(passed, async () => { await runner?.stop().catch(() => {}); await edge.stop().catch(() => {}); await s.close() })
  }
}, 240_000)

test("H6 the fence of an abandoned claim looks only at what nobody owns and is written before the claim is released: a council job this runner holds with no attempt is fenced and released, an owned attempt, another runner's claim and an ordinary job are not touched, and a fence that cannot be written releases nothing", async () => {
  const s = await councilStage(cluster, track)
  try {
    const { id, jobs: [j1, j2] } = await begin(s)
    await insertJob(cluster, s.db, { id: "ord1", target: "p1-w1", task: "something that has nothing to do with the council" })
    await s.incarnate()
    await s.su`update inbound set claimed_by = 'runner-a', claim_deadline = now() + interval '1 hour' where id in (${j1.id}, 'ord1')`
    // The second member is claimed and its attempt is open (owned), and nothing was fed.
    await s.claimed(j2.id)
    const fence = (runner: string, agent: string) => s.runner.sql.begin(async (tx: any) => await fenceAbandonedClaims({ ...s.runner, sql: tx } as StoreLike, { runner, agent, cause: "test" }))
    const ids = (found: { id: string }[]) => found.map(one => one.id)

    // The fence cannot be written: the transaction fails and the claim is NOT released.
    await installFaults(s)
    await s.su`insert into test_switch values ('fail-gate')`
    await expect(fence("runner-a", "p1-w1")).rejects.toThrow(/injected/)
    expect((await s.su`select claimed_by from inbound where id = ${j1.id}`)[0].claimed_by, "a claim is released only with its fence").toBe("runner-a")
    expect(await s.count("claim_gate", "operation_id like 'council-failed:%'")).toBe(0)

    // Written, it fences the member's job and releases its claim, and no other row.
    await s.su`delete from test_switch`
    expect(await fence("runner-b", "p1-w1"), "another runner's claim is not this runner's to fence").toEqual([])
    expect(ids(await fence("runner-a", "p1-w1"))).toEqual([j1.id])
    expect((await s.su`select claimed_by from inbound where id = ${j1.id}`)[0].claimed_by).toBeNull()
    expect((await s.su`select cause, state, evidence from claim_gate where operation_id = ${"council-failed:" + j1.id}`)[0]).toMatchObject({ cause: "council", state: "open", evidence: { council: id, cause: "test" } })
    expect((await s.su`select claimed_by from inbound where id = 'ord1'`)[0].claimed_by, "an ordinary job is not a council's").toBe("runner-a")
    expect(await s.count("claim_gate", "scope_id = 'ord1'")).toBe(0)
    expect(ids(await fence("runner-a", "p1-w1")), "and there is nothing left to fence").toEqual([])

    // An attempt that may be running is owned, and is somebody else's rule: not fenced, not released.
    expect(await fence("runner-a", "p1-w2")).toEqual([])
    expect((await s.su`select claimed_by from inbound where id = ${j2.id}`)[0].claimed_by).toBe("runner-a")
    expect(await s.count("claim_gate", `scope_id = '${j2.id}'`)).toBe(0)

    // The council reads it as a member that failed before its input.
    await reconcileCouncil(s.runner, id)
    expect((await membersOf(s, id)).find(one => one.inbound_id === j1.id)).toMatchObject({ state: "missing" })
  } finally { await s.close() }
}, 90_000)
