// What the master and the owner can do to a running council: debate (opt-in, later, in the same
// conversations, no round cap), the 30-minute checkpoint (blocks a further round, never a running one), the
// owner's follow-up (the only thing that starts a new period), a correction (only the affected work is touched;
// nothing is fed to a running attempt until it is shown to be over; a late output never satisfies the round),
// an explicit stop (stopped only on evidence), and the room a master keeps on its runner.

import { afterAll, afterEach, beforeAll, expect, test } from "bun:test"
import { startCluster, type Cluster } from "./helpers/cluster.ts"
import { DOOR, PERSON, RUNNER } from "./helpers/hub-fixture.ts"
import { councilStage, GONE, roster, startArgs, turnOf } from "./helpers/council-stage.ts"
import { callTool } from "../src/mcp/handlers.ts"
import { ToolError } from "../src/mcp/contracts.ts"
import { reconcileCouncil } from "../src/council/reconcile.ts"
import { readSnapshot } from "../src/council/snapshot.ts"
import { mastersToHold } from "../src/council/capacity.ts"
import { endAttempt } from "../src/runner/execution.ts"
import { chooseHold } from "../src/recovery/holds.ts"
import { settleTurn } from "../src/runner/settle.ts"
import { journalResult, markProgress } from "../src/store/conversations.ts"
import { readEligible } from "../src/store/wake.ts"
import { loadRegistry } from "../src/registry/load.ts"
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

async function begin(s: Stage, workers: string[] = ["p1-w1", "p1-w2"], over: Record<string, unknown> = {}) {
  const started = await callTool(s.binding("attempt-start"), "hub_council", startArgs({ participants: roster(workers), ...over }))
  const id = String(started.object_id)
  return { id, jobs: await s.jobsOf(id), participants: workers.map((_, at) => `${id}:p${at + 1}`) }
}

/** Every job of the council's newest round answered, the way each worker's settle would. */
async function answerRound(s: Stage, id: string, text: string) {
  const [{ current_round }] = Array.from(await s.su`select current_round from council where id = ${id}`) as any[]
  for (const job of (await s.jobsOf(id)).filter(one => one.source.dispatch.council_round.round === current_round && one.state !== "answered")) {
    await s.answer(job.id, `${text} (${job.agent}, round ${current_round})`)
  }
}

const briefs = (participants: string[], text: string, refs: { participant_id: string }[] = []) =>
  participants.map(participant_id => ({ participant_id, text: `${text} ${participant_id.split(":").pop()}`, ...(refs.length > 0 ? { evidence_refs: refs } : {}) }))

// ---------------------------------------------------------------------------
// Debate, opted into later, in the same conversations; no round cap; the clock is not reset.
// ---------------------------------------------------------------------------

test("K1 debate is opt-in and can be opted into later on fresh owner evidence: the same participant conversations, the answers quoted verbatim, no confirmation, more than two rounds, and the clock never reset by the master", async () => {
  const s = await councilStage(cluster, track)
  try {
    const { id, jobs, participants } = await begin(s)
    for (const job of jobs) await s.conversationOf(job.id)
    await answerRound(s, id, "independent")
    const [before] = Array.from(await s.su`select epoch, epoch_started_at, checkpoint_deadline, debate_opt_in from council where id = ${id}`) as any[]
    expect(before.debate_opt_in).toBeNull()

    // A model's own continuation cannot enable it: no evidence, no debate, and nothing recorded.
    const args = { kind: "debate_round", participants, briefs: briefs(participants, "Answer the other participant's point:", [{ participant_id: participants[1] }]) }
    expect(await move(s, id, args)).toMatchObject({ status: "failed", cause: "debate_not_opted_in" })
    expect((await s.su`select debate_opt_in from council where id = ${id}`)[0].debate_opt_in).toBeNull()
    expect(await s.count("council_round")).toBe(1)

    // The owner's words, fresh, after the independent comparison completed: opt-in is recorded atomically and the round starts.
    await s.human("h3")
    const started = await move(s, id, { ...args, source_message_ids: ["h3"] })
    expect(started).toMatchObject({ status: "running", stage: "debate_round", round: 2 })
    const [council] = Array.from(await s.su`select debate_opt_in, epoch, epoch_started_at, checkpoint_deadline, current_round, lifecycle from council where id = ${id}`) as any[]
    expect(council.debate_opt_in).toMatchObject({ kind: "later", source_message_ids: ["h3"] })
    expect(council).toMatchObject({ current_round: 2, lifecycle: "running", epoch: 1 })
    expect((await s.su`select kind from council_decision where council_id = ${id} order by seq`).map((row: any) => row.kind)).toEqual(["start", "debate_opt_in", "debate_round"])
    expect(await s.count("confirmation"), "no second approval").toBe(0)
    // The same conversations, not new ones; the other participant's answer quoted verbatim and by number.
    const round2 = (await s.jobsOf(id)).filter(job => job.source.dispatch.council_round.round === 2)
    expect(round2).toHaveLength(2)
    for (const job of round2) {
      const first = jobs.find(one => one.agent === job.agent)!
      expect(job.source.dispatch.conversation).toBe((await s.conversationOf(first.id)).id)
      expect(job.source.dispatch.approved).toMatchObject({ by: PERSON, source: "council" })
    }
    expect(round2[0].body).toContain("Participant 2, round 1:")
    expect(round2[0].body).toContain("independent (p1-w2, round 1)")
    expect(round2[0].body).toContain("debate round")

    // More than two rounds inside one period: the master decides, and no round count stops it.
    await answerRound(s, id, "debate")
    expect(await move(s, id, { kind: "debate_round", participants, briefs: briefs(participants, "Once more:") })).toMatchObject({ round: 3 })
    await answerRound(s, id, "debate")
    expect(await move(s, id, { kind: "debate_round", participants, briefs: briefs(participants, "And again:") })).toMatchObject({ round: 4 })
    const [after] = Array.from(await s.su`select epoch, epoch_started_at, checkpoint_deadline from council where id = ${id}`) as any[]
    expect(after.epoch).toBe(1)
    expect(new Date(after.epoch_started_at).toISOString(), "a master's round does not reset the clock").toBe(new Date(before.epoch_started_at).toISOString())
    expect(new Date(after.checkpoint_deadline).toISOString()).toBe(new Date(before.checkpoint_deadline).toISOString())
  } finally { await s.close() }
}, 120_000)

test("K2 debate opted into at the start needs no evidence later, and needs the same roster and a completed round", async () => {
  const s = await councilStage(cluster, track)
  try {
    const { id, jobs, participants } = await begin(s, ["p1-w1", "p1-w2"], { debate: true })
    for (const job of jobs) await s.conversationOf(job.id)
    // A round in progress is not a completed round.
    expect(await move(s, id, { kind: "debate_round", participants, briefs: briefs(participants, "Go:") })).toMatchObject({ status: "failed", cause: "closed" })
    await answerRound(s, id, "independent")
    // The roster is what it was (nothing was replaced): no evidence is needed, the owner opted in at the start.
    expect(await move(s, id, { kind: "debate_round", participants, briefs: briefs(participants, "Go:") })).toMatchObject({ status: "running", stage: "debate_round", round: 2 })
    // A participant it never named cannot be asked: exactly one brief for each participant chosen.
    await answerRound(s, id, "debate")
    await expect(move(s, id, { kind: "debate_round", participants, briefs: briefs([participants[0]], "Go:") })).rejects.toMatchObject({ code: "invalid_arguments" })
    await expect(move(s, id, { kind: "debate_round", participants: ["nobody"], briefs: briefs(["nobody"], "Go:") })).rejects.toMatchObject({ code: "unknown_participant" })
  } finally { await s.close() }
}, 90_000)

// ---------------------------------------------------------------------------
// The checkpoint: a further round waits for the owner; a running round and a synthesis do not.
// ---------------------------------------------------------------------------

test("K3 past the checkpoint a further round is blocked (and nothing is recorded or spent) until the owner extends it with a scope; an owner's follow-up starts a new period by itself", async () => {
  const s = await councilStage(cluster, track)
  try {
    const { id, jobs, participants } = await begin(s)
    for (const job of jobs) await s.conversationOf(job.id)
    await answerRound(s, id, "independent")
    await s.su`update council set checkpoint_deadline = now() - interval '1 minute' where id = ${id}`
    await s.human("h3")
    const invocations = await s.count("tool_invocation")
    const debate = { kind: "debate_round", source_message_ids: ["h3"], participants, briefs: briefs(participants, "Go:") }

    const blocked = await move(s, id, debate)
    expect(blocked).toMatchObject({ status: "waiting_owner", stage: "checkpoint", cause: "checkpoint" })
    expect(String(blocked.status_message)).toContain("30-minute checkpoint")
    expect(await s.count("tool_invocation"), "the refusal left no invocation behind").toBe(invocations)
    expect(await s.count("source_consumption", "source_id = 'h3'"), "and did not spend the owner's message").toBe(0)
    expect([await s.count("council_round"), (await s.su`select debate_opt_in from council where id = ${id}`)[0].debate_opt_in]).toEqual([1, null])

    // The owner extends it, and says how far. The scope is recorded with their message.
    await s.human("h4")
    expect(await move(s, id, { kind: "owner_decision", source_message_ids: ["h4"], decision: { choice: "extend", extension_scope: { rounds: 1 } } })).toMatchObject({ stage: "checkpoint_extended" })
    expect((await s.su`select extension from council where id = ${id}`)[0].extension).toMatchObject({ kind: "rounds", rounds_left: 1, source_message_ids: ["h4"] })
    expect(await move(s, id, debate)).toMatchObject({ status: "running", round: 2 })
    expect((await s.su`select extension from council where id = ${id}`)[0].extension.rounds_left, "one round spent").toBe(0)
    await answerRound(s, id, "debate")
    expect(await move(s, id, { kind: "debate_round", participants, briefs: briefs(participants, "Again:") }), "the allowance is spent").toMatchObject({ status: "waiting_owner", cause: "checkpoint" })

    // Another interval of minutes is the other scope.
    await s.human("h5")
    await move(s, id, { kind: "owner_decision", source_message_ids: ["h5"], decision: { choice: "extend", extension_scope: { minutes: 30 } } })
    const [extended] = Array.from(await s.su`select checkpoint_deadline from council where id = ${id}`) as any[]
    expect(new Date(extended.checkpoint_deadline).getTime() - Date.now()).toBeGreaterThan(29 * 60_000)
    expect(await move(s, id, { kind: "debate_round", participants, briefs: briefs(participants, "Again:") })).toMatchObject({ round: 3 })

    // The owner's own follow-up starts a new period: the clock is theirs to restart and nothing else's.
    await answerRound(s, id, "debate")
    await s.human("h6")
    const [old] = Array.from(await s.su`select epoch, epoch_started_at from council where id = ${id}`) as any[]
    const follow = await move(s, id, { kind: "follow_up", source_message_ids: ["h6"], participants, briefs: briefs(participants, "One more thing:") })
    expect(follow).toMatchObject({ status: "running", stage: "follow_up", round: 4, epoch: 2 })
    const [now] = Array.from(await s.su`select epoch, epoch_started_at, checkpoint_deadline, extension, epoch_authority from council where id = ${id}`) as any[]
    expect(now.epoch).toBe(old.epoch + 1)
    expect(new Date(now.epoch_started_at).getTime()).toBeGreaterThan(new Date(old.epoch_started_at).getTime())
    expect(Math.round((new Date(now.checkpoint_deadline).getTime() - Date.now()) / 60_000)).toBe(30)
    expect(now.extension).toBeNull()
    expect(now.epoch_authority).toMatchObject({ source_message_ids: ["h6"] })
    expect(await s.count("confirmation")).toBe(0)
  } finally { await s.close() }
}, 120_000)

test("K4 crossing the checkpoint changes nothing that is running and never blocks a synthesis: a healthy finished round may still be finalized", async () => {
  const s = await councilStage(cluster, track)
  try {
    const { id, jobs } = await begin(s)
    await s.answer(jobs[0].id, "one")
    await s.su`update council set checkpoint_deadline = now() - interval '1 hour' where id = ${id}`
    // A member is still running when the checkpoint is long gone, and nothing was stopped, cancelled or retried.
    const running = await s.running(jobs[1].id)
    await reconcileCouncil(s.runner, id)
    expect((await s.su`select state from execution where id = ${running.execution}`)[0].state).not.toMatch(/stop|interrupted|failed/)
    expect(await s.count("stop_request")).toBe(0)
    expect((await s.su`select lifecycle from council where id = ${id}`)[0].lifecycle).toBe("running")
    await s.answer(jobs[1].id, "two")
    const finalized = await move(s, id, { kind: "finalize" }, "attempt-fin")
    expect(finalized).toMatchObject({ status: "running", stage: "preparing_result" })
  } finally { await s.close() }
}, 60_000)

// ---------------------------------------------------------------------------
// A correction touches only the affected work, and waits for evidence before it feeds anything.
// ---------------------------------------------------------------------------

test("K5 a correction disables what had not started, asks what runs to end, keeps the unaffected answer, feeds nothing until the process is shown to be over, and a late output never satisfies the round", async () => {
  const s = await councilStage(cluster, track)
  try {
    const { id, jobs: [j1, j2, j3], participants: [p1, p2, p3] } = await begin(s, ["p1-w1", "p1-w2", "p1-w3"])
    await s.answer(j3.id, "answer three")
    const running = await s.running(j1.id)
    await markProgress(s.runner, running.execution, "running")
    await s.human("h3")

    const corrected = await move(s, id, { kind: "correction", source_message_ids: ["h3"], participants: [p1, p2], message: "Should the ledger be weighed twice on a cold scale?",
      briefs: [{ participant_id: p1, text: "consider the cold scale" }, { participant_id: p2, text: "consider the cold scale" }] })
    expect(corrected).toMatchObject({ status: "running", stage: "correcting", question_revision: 2, unaffected: [p3] })
    expect((await s.su`select question_revision, question, lifecycle from council where id = ${id}`)[0]).toMatchObject({
      question_revision: 2, question: "Should the ledger be weighed twice on a cold scale?", lifecycle: "running" })

    // The running one is asked to end, durably, and nothing new is fed to it.
    const members = async () => Array.from(await s.su`select participant_id, input_revision, state, inbound_id, valid_for_revision, awaiting from round_member where council_id = ${id}
      order by participant_id, input_revision`) as any[]
    const after = await members()
    const first = after.filter(one => one.participant_id === p1)
    expect(first).toHaveLength(1)
    expect(first[0]).toMatchObject({ state: "superseding", awaiting: { kind: "correction", execution: running.execution } })
    const [stop] = Array.from(await s.su`select state, execution_id, requested_by from stop_request where execution_id = ${running.execution}`) as any[]
    expect(stop).toMatchObject({ state: "requested", requested_by: PERSON })
    expect(await s.count("inbound", "id like 'continue:%'"), "no continuation before the process is shown to be over").toBe(0)
    // The one that had not started: disabled where it stands, asked again with the correction, on the corrected question.
    const second = after.filter(one => one.participant_id === p2)
    expect(second.map(one => [one.input_revision, one.state])).toEqual([[1, "superseded"], [2, "open"]])
    expect((await s.su`select state from claim_gate where operation_id = ${"council-correct:" + j2.id}`)[0].state).toBe("open")
    const queued = (await readEligible(s.runner, { agent: "p1-w2", resumeOk: true })).map(row => row.id)
    expect(queued, "the old input is not claimable, only the corrected one").toEqual([second[1].inbound_id])
    const fresh = (await s.su`select body, source from inbound where id = ${second[1].inbound_id}`)[0]
    expect(fresh.body).toContain("corrected")
    expect(fresh.body).toContain("cold scale")
    expect(fresh.source.dispatch.council_round.revision).toBe(2)
    // The unaffected answer stays, and stays valid for the new revision by the master's explicit list.
    const third = after.filter(one => one.participant_id === p3)
    expect(third[0]).toMatchObject({ state: "answered", valid_for_revision: 2 })

    // Not evidence: the stop asked, and then an end nobody can show. The corrected input still waits.
    await s.su`update execution set state = 'stop_requested' where id = ${running.execution}`
    await endAttempt(s.runner, { execution: running.execution, evidence: NOT_GONE, cause: "stop requested", requested: true })
    await reconcileCouncil(s.runner, id)
    expect((await s.su`select state from stop_request where execution_id = ${running.execution}`)[0].state).toBe("unknown")
    expect((await members()).filter(one => one.participant_id === p1)).toHaveLength(1)
    expect(await s.count("inbound", "id like 'continue:%'")).toBe(0)
    // What the store now knows about the old input is only "ownership unknown": its hold stands at its first revision, held, and unchosen.
    const [unproven] = Array.from(await s.su`select state, cause, revision, continuation_id from replay_hold where inbound_id = ${j1.id}`) as any[]
    expect(unproven).toMatchObject({ state: "held", cause: "ownership-unknown", revision: 1, continuation_id: null })
    const snap = await readSnapshot(s.runner, id, { now: new Date(), quietSeconds: 300 })
    expect(snap?.members.find(one => one.participant === p1)?.view).toBe("correcting")

    // The corrected input of the other participant is answered meanwhile; the round still waits for the one being stopped.
    await s.answer(second[1].inbound_id, "answer two, on the cold scale")
    expect(await s.count("council_event", "kind = 'round_complete'")).toBe(0)

    // The end is shown. The interrupted input is held, and the owner's continuation of it carries the correction.
    await endAttempt(s.runner, { execution: running.execution, evidence: GONE, cause: "the process tree is gone", requested: true })
    await reconcileCouncil(s.runner, id)
    expect((await s.su`select state from stop_request where execution_id = ${running.execution}`)[0].state).toBe("stopped")
    // The proof CHANGED what is known about the input (ownership-unknown -> stopped), and the store moves a hold's revision whenever
    // what is known moves, so a choice made against the old knowledge is void. The correction chose against the CURRENT revision (2),
    // and the continuation's id is derived from exactly that revision by the store: `continue:<input>:<revision>`.
    const [hold] = Array.from(await s.su`select state, cause, revision, continuation_id from replay_hold where inbound_id = ${j1.id}`) as any[]
    expect(hold).toMatchObject({ state: "continuing", cause: "stopped", revision: unproven.revision + 1 })
    expect(hold.revision).toBe(2)
    expect(hold.continuation_id).toBe(`continue:${j1.id}:${hold.revision}`)
    // A choice made at the revision that was current before the proof is refused by name, and changes nothing.
    const inboundBefore = await s.count("inbound")
    expect(await chooseHold(s.runner, { attempt: running.execution, agent: "p1-w1", revision: unproven.revision, choice: "continue", by: PERSON,
      evidence: { source: "test", stale: true }, context: "a stale choice" })).toBe("stale-revision")
    expect(await s.count("inbound"), "the stale choice queued nothing").toBe(inboundBefore)
    // The continuing hold is stable: more reconciles neither move its revision nor mint a second continuation.
    await reconcileCouncil(s.runner, id)
    await reconcileCouncil(s.runner, id)
    expect((await s.su`select state, revision, continuation_id from replay_hold where inbound_id = ${j1.id}`)[0]).toMatchObject({
      state: "continuing", revision: hold.revision, continuation_id: hold.continuation_id })
    expect(await s.count("inbound", "id like 'continue:%'"), "exactly one continuation").toBe(1)
    const now = (await members()).filter(one => one.participant_id === p1)
    expect(now.map(one => [one.input_revision, one.state])).toEqual([[1, "superseded"], [2, "open"]])
    expect(now[1].inbound_id).toBe(hold.continuation_id)
    const continuation = (await s.su`select body, source from inbound where id = ${hold.continuation_id}`)[0]
    expect(continuation.body).toContain("ended on purpose")
    expect(continuation.body).toContain("consider the cold scale")
    expect(continuation.source.dispatch.conversation, "the same conversation").toBe(running.conversation)
    expect((await s.su`select hub_row_held(${j1.id}) as held`)[0].held, "the old input is never fed again").toBe(true)

    // The old attempt's output lands late anyway: kept as a report, and it satisfies nothing for the corrected question.
    await s.answer(j1.id, "a late answer to the old question")
    expect(await s.count("council_event", "kind = 'round_complete'"), "the round is not satisfied by a superseded output").toBe(0)
    expect((await members()).filter(one => one.participant_id === p1).map(one => [one.input_revision, one.state])).toEqual([[1, "superseded"], [2, "open"]])

    // Only the corrected answer completes the round, and the round quotes it, not the late one.
    await s.answer(hold.continuation_id, "answer one, on the cold scale")
    const event = (await s.su`select body from inbound where id like 'council-event:%' and source -> 'council_event' ->> 'kind' = 'round_complete'`)[0]
    expect(event.body).toContain("answer one, on the cold scale")
    expect(event.body).not.toContain("a late answer to the old question")
    expect((await s.su`select body from inbound where id = ${"report:" + j1.id}`)[0].body, "the late output is kept as a record").toBe("a late answer to the old question")
  } finally { await s.close() }
}, 120_000)

test("K6 an output that lands before the stop does is kept as superseded, the corrected input is a fresh input into the same conversation, and the round is not satisfied by the old one", async () => {
  const s = await councilStage(cluster, track)
  try {
    const { id, jobs: [j1, j2], participants: [p1, p2] } = await begin(s)
    const running = await s.running(j1.id)
    await s.human("h3")
    await move(s, id, { kind: "correction", source_message_ids: ["h3"], participants: [p1], briefs: [{ participant_id: p1, text: "mind the warm scale too" }] })
    // The unaffected participant that has not answered is valid for the new revision by that same list.
    expect((await s.su`select valid_for_revision, state from round_member where participant_id = ${p2}`)[0]).toMatchObject({ valid_for_revision: 2, state: "open" })
    // The attempt finishes with its own result before the stop lands.
    await s.su`update execution set state = 'stop_requested' where id = ${running.execution}`
    await journalResult(s.runner, running.execution, { text: "the answer nobody was waiting for any more", chunks: ["the answer nobody was waiting for any more"], turn: turnOf("p1-w1") })
    const [row] = await s.su`select source from inbound where id = ${j1.id}`
    await settleTurn(s.runner, { inboundId: j1.id, kind: "job", person: PERSON, source: row.source, chunks: ["the answer nobody was waiting for any more"], turn: turnOf("p1-w1"),
      execution: { id: running.execution, runner: "runner-a", fence: { recovery: true } } })
    expect((await s.su`select state, outcome from stop_request where execution_id = ${running.execution}`)[0]).toMatchObject({ state: "settled", outcome: "completed" })
    const inputs = Array.from(await s.su`select input_revision, state, inbound_id from round_member where participant_id = ${p1} order by input_revision`) as any[]
    expect(inputs.map(one => [one.input_revision, one.state])).toEqual([[1, "superseded"], [2, "open"]])
    expect((await s.su`select source from inbound where id = ${inputs[1].inbound_id}`)[0].source.dispatch.conversation, "into the same conversation").toBe(running.conversation)
    expect((await s.su`select body from inbound where id = ${"report:" + j1.id}`)[0].body, "the old output is kept").toContain("nobody was waiting")
    // The other participant answers; the round is still not complete, because the corrected input has not.
    await s.answer(j2.id, "two")
    expect(await s.count("council_event", "kind = 'round_complete'")).toBe(0)
    expect((await s.su`select lifecycle from council where id = ${id}`)[0].lifecycle).toBe("running")
    await s.answer(inputs[1].inbound_id, "one, corrected")
    expect((await s.su`select lifecycle from council where id = ${id}`)[0].lifecycle).toBe("waiting_master")
  } finally { await s.close() }
}, 90_000)

test("K10 a correction after the checkpoint still stops the work it made outdated, at once, and is saved: nothing is fed until the owner extends AND the process is shown to be over, it survives a restart, and then it starts", async () => {
  const s = await councilStage(cluster, track)
  try {
    const { id, jobs: [j1, j2], participants: [p1] } = await begin(s)
    const running = await s.running(j1.id)
    await markProgress(s.runner, running.execution, "running")
    await s.su`update council set checkpoint_deadline = now() - interval '1 minute' where id = ${id}`
    await s.human("h3")
    const iso = (at: unknown) => new Date(at as string).toISOString()
    const [before] = Array.from(await s.su`select epoch, epoch_started_at, checkpoint_deadline, extension from council where id = ${id}`) as any[]
    expect(before.extension).toBeNull()

    // The checkpoint is long gone and the owner has said the work on the old question is outdated: accepted, journaled, acted on.
    const saved = await move(s, id, { kind: "correction", source_message_ids: ["h3"], participants: [p1], message: "Should the ledger be weighed twice on a cold scale?",
      briefs: [{ participant_id: p1, text: "consider the cold scale" }] })
    expect(saved).toMatchObject({ status: "waiting_owner", stage: "correction_waiting_checkpoint", cause: "checkpoint", question_revision: 2 })
    expect(await s.count("source_consumption", "source_id = 'h3'"), "the owner's message was spent on it: it is recorded").toBeGreaterThan(0)
    expect((await s.su`select kind from council_decision where council_id = ${id} order by seq`).map((row: any) => row.kind)).toEqual(["start", "correction"])
    expect((await s.su`select question_revision, lifecycle, waiting from council where id = ${id}`)[0]).toMatchObject({
      question_revision: 2, lifecycle: "waiting_owner", waiting: { kind: "checkpoint", correction: true, members: [p1] } })
    // The stop was asked for NOW, through the store's own request, by the owner's word; it did not wait for the checkpoint.
    expect((await s.su`select state, requested_by from stop_request where execution_id = ${running.execution}`)[0]).toMatchObject({ state: "requested", requested_by: PERSON })
    const member = async () => Array.from(await s.su`select input_revision, state, inbound_id, awaiting from round_member where participant_id = ${p1} order by input_revision`) as any[]
    expect(await member()).toMatchObject([{ input_revision: 1, state: "superseding", awaiting: { kind: "correction", execution: running.execution, cleared: false } }])
    // Nothing fresh was fed or queued, and the deadline and the period are exactly as they were: no silent extension, no reset.
    expect(await s.count("inbound", "id like 'continue:%'")).toBe(0)
    expect(await s.count("round_member", `participant_id = '${p1}'`)).toBe(1)
    const [kept] = Array.from(await s.su`select epoch, epoch_started_at, checkpoint_deadline, extension from council where id = ${id}`) as any[]
    expect([kept.epoch, iso(kept.epoch_started_at), iso(kept.checkpoint_deadline), kept.extension]).toEqual([before.epoch, iso(before.epoch_started_at), iso(before.checkpoint_deadline), null])

    // Positive evidence that the process is gone is NOT permission: the old input stays held (its hold is not released), and nothing is fed.
    await s.su`update execution set state = 'stop_requested' where id = ${running.execution}`
    await endAttempt(s.runner, { execution: running.execution, evidence: GONE, cause: "the process tree is gone", requested: true })
    await reconcileCouncil(s.runner, id)
    expect((await s.su`select state from stop_request where execution_id = ${running.execution}`)[0].state).toBe("stopped")
    expect((await s.su`select state, continuation_id from replay_hold where inbound_id = ${j1.id}`)[0]).toMatchObject({ state: "held", continuation_id: null })
    expect(await s.count("inbound", "id like 'continue:%'"), "evidence alone feeds nothing while the checkpoint is closed").toBe(0)
    expect((await member()).map(one => one.state)).toEqual(["superseding"])
    // Asking again and again changes nothing, not even the council's revision (the waiting note is compared as stored).
    const revision = await s.revision(id)
    await reconcileCouncil(s.runner, id)
    await reconcileCouncil(s.runner, id)
    expect(await s.revision(id)).toBe(revision)

    // A RESTART: a new connection knows it from the rows alone. The saved correction is there, named, and nothing has been fed.
    const restarted = { sql: track(cluster.connectAs("hub_runner", s.db)), url: cluster.url(s.db) } as StoreLike
    await reconcileCouncil(restarted, id)
    const snapshot = await readSnapshot(restarted, id, { now: new Date(), quietSeconds: 300 })
    expect(snapshot).toMatchObject({ stage: "waiting-owner", question_revision: 2, waiting: { kind: "checkpoint", members: [p1] } })
    expect(snapshot?.members.find(one => one.participant === p1)?.view).toBe("correcting")
    expect(await callTool(s.binding(null, { store: restarted }), "hub_council", { action: "inspect", council_id: id })).toMatchObject({ status: "waiting_owner" })
    expect(await s.count("inbound", "id like 'continue:%'")).toBe(0)
    // The other participant answering meanwhile does not complete the round: the corrected input of the first has not started.
    await s.answer(j2.id, "answer two")
    expect(await s.count("council_event", "kind = 'round_complete'")).toBe(0)
    expect((await s.su`select lifecycle from council where id = ${id}`)[0].lifecycle).toBe("waiting_owner")

    // The owner's scoped extension, with the evidence already in, starts the correction, once, in the same conversation.
    await s.human("h4")
    expect(await move(s, id, { kind: "owner_decision", source_message_ids: ["h4"], decision: { choice: "extend", extension_scope: { rounds: 1 } } })).toMatchObject({ stage: "checkpoint_extended" })
    const [hold] = Array.from(await s.su`select state, continuation_id from replay_hold where inbound_id = ${j1.id}`) as any[]
    expect(hold).toMatchObject({ state: "continuing", continuation_id: `continue:${j1.id}:1` })
    expect((await member()).map(one => [one.input_revision, one.state])).toEqual([[1, "superseded"], [2, "open"]])
    expect((await s.su`select extension, lifecycle from council where id = ${id}`)[0]).toMatchObject({ extension: { kind: "rounds", rounds_left: 0 }, lifecycle: "running" })
    const continuation = (await s.su`select body, source from inbound where id = ${hold.continuation_id}`)[0]
    expect(continuation.body).toContain("consider the cold scale")
    expect(continuation.source.dispatch.conversation, "the same conversation").toBe(running.conversation)
    expect((await s.su`select hub_row_held(${j1.id}) as held`)[0].held, "the old input is never fed again").toBe(true)
    await s.answer(hold.continuation_id, "answer one, on the cold scale")
    expect((await s.su`select lifecycle from council where id = ${id}`)[0].lifecycle).toBe("waiting_master")
  } finally { await s.close() }
}, 120_000)

test("K11 a correction after the checkpoint disables what had not started and keeps what was answered, at once, and one extension starts the whole correction, spending one allowance for all of it", async () => {
  const s = await councilStage(cluster, track)
  try {
    const { id, jobs: [j1, j2], participants: [p1, p2] } = await begin(s)
    await s.answer(j1.id, "answer one, before the correction")
    await s.su`update council set checkpoint_deadline = now() - interval '1 minute' where id = ${id}`
    await s.human("h3")
    const saved = await move(s, id, { kind: "correction", source_message_ids: ["h3"], participants: [p1, p2], message: "Should the ledger be weighed twice on a cold scale?",
      briefs: [{ participant_id: p1, text: "again, cold scale" }, { participant_id: p2, text: "again, cold scale" }] })
    expect(saved).toMatchObject({ status: "waiting_owner", stage: "correction_waiting_checkpoint", question_revision: 2 })
    // What had not started is disabled now; what was answered is kept as it was; nothing corrected exists yet.
    expect((await s.su`select state from claim_gate where operation_id = ${"council-correct:" + j2.id}`)[0].state).toBe("open")
    expect(await readEligible(s.runner, { agent: "p1-w2", resumeOk: true })).toEqual([])
    expect(await s.count("inbound", "kind = 'job'"), "no corrected input exists yet").toBe(2)
    expect((await s.su`select body from inbound where id = ${"report:" + j1.id}`)[0].body).toContain("answer one, before the correction")
    const states = async () => Array.from(await s.su`select participant_id, input_revision, state from round_member where council_id = ${id} order by participant_id, input_revision`)
      .map((row: any) => [row.participant_id, row.input_revision, row.state])
    expect(await states()).toEqual([[p1, 1, "superseding"], [p2, 1, "superseding"]])
    expect(await s.count("council_event", "kind = 'round_complete'"), "the kept answer does not complete a corrected round").toBe(0)
    const revision = await s.revision(id)
    await reconcileCouncil(s.runner, id)
    await reconcileCouncil(s.runner, id)
    expect(await s.revision(id), "waiting is a fixed point").toBe(revision)
    const [kept] = Array.from(await s.su`select checkpoint_deadline, extension, epoch from council where id = ${id}`) as any[]

    // One extension, one round: both affected participants start, and the allowance is spent once for the correction.
    await s.human("h4")
    await move(s, id, { kind: "owner_decision", source_message_ids: ["h4"], decision: { choice: "extend", extension_scope: { rounds: 1 } } })
    expect(await states()).toEqual([[p1, 1, "superseded"], [p1, 2, "open"], [p2, 1, "superseded"], [p2, 2, "open"]])
    expect((await s.su`select extension, lifecycle, epoch, checkpoint_deadline from council where id = ${id}`)[0]).toMatchObject({
      extension: { kind: "rounds", rounds_left: 0 }, lifecycle: "running", epoch: kept.epoch })
    expect(new Date((await s.su`select checkpoint_deadline from council where id = ${id}`)[0].checkpoint_deadline).toISOString(), "the deadline was not silently moved").toBe(new Date(kept.checkpoint_deadline).toISOString())
    const fresh = Array.from(await s.su`select inbound_id from round_member where council_id = ${id} and input_revision = 2 order by participant_id`).map((row: any) => row.inbound_id)
    expect(fresh).toHaveLength(2)
    expect((await s.su`select source from inbound where id = ${fresh[0]}`)[0].source.dispatch.council_round.revision).toBe(2)
    // Only the corrected answers complete the round.
    await s.answer(fresh[0], "one, corrected")
    expect(await s.count("council_event", "kind = 'round_complete'")).toBe(0)
    await s.answer(fresh[1], "two, corrected")
    expect((await s.su`select lifecycle from council where id = ${id}`)[0].lifecycle).toBe("waiting_master")
  } finally { await s.close() }
}, 120_000)

// ---------------------------------------------------------------------------
// Stop.
// ---------------------------------------------------------------------------

test("K7 stop disables what has not started at once, asks what runs to end, keeps saved answers, and is called stopped only when every process is shown to be gone", async () => {
  const s = await councilStage(cluster, track)
  try {
    const { id, jobs: [j1, j2, j3] } = await begin(s, ["p1-w1", "p1-w2", "p1-w3"])
    await s.answer(j3.id, "answer three, saved")
    const running = await s.running(j1.id)
    await s.human("h3")
    const stopArgs = { action: "stop", request_key: "stop-1", source_message_ids: ["h3"], reason: "the owner said stop" }
    const stopCall = { ...stopArgs, council_id: id, expected_revision: await s.revision(id) }
    const stopping = await callTool(s.binding("attempt-stop"), "hub_council", stopCall)
    expect(stopping).toMatchObject({ status: "stopping", stage: "stopping" })
    const [council] = Array.from(await s.su`select lifecycle, finalize from council where id = ${id}`) as any[]
    expect(council.lifecycle).toBe("stopping")
    const states = Array.from(await s.su`select participant_id, state from round_member where council_id = ${id} order by participant_id`).map((row: any) => [row.participant_id.split(":").pop(), row.state])
    expect(states).toEqual([["p1", "stopping"], ["p2", "cancelled"], ["p3", "answered"]])
    expect((await s.su`select state, scope_kind, cause from claim_gate where scope_id = ${j2.id}`)[0]).toMatchObject({ state: "open", scope_kind: "row", cause: "council" })
    expect((await readEligible(s.runner, { agent: "p1-w2", resumeOk: true })).map(row => row.id), "the queued member is not claimable").toEqual([])
    expect((await s.su`select state from stop_request where execution_id = ${running.execution}`)[0].state, "asked, and not shown").toBe("requested")
    // No new work while it stops, and the same request again is the same answer.
    await s.human("h4")
    expect(await move(s, id, { kind: "follow_up", source_message_ids: ["h4"], participants: [`${id}:p3`], briefs: briefs([`${id}:p3`], "more") })).toMatchObject({ status: "failed", cause: "closed" })
    expect(await callTool(s.binding("attempt-stop"), "hub_council", stopCall), "the same request is the same answer").toEqual(stopping)

    // An end nobody can show is not "stopped", and neither is silence.
    await reconcileCouncil(s.runner, id)
    expect((await s.su`select lifecycle from council where id = ${id}`)[0].lifecycle).toBe("stopping")
    await s.su`update execution set state = 'stop_requested' where id = ${running.execution}`
    await endAttempt(s.runner, { execution: running.execution, evidence: NOT_GONE, cause: "stop requested", requested: true })
    const seen = await callTool(s.binding(), "hub_council", { action: "inspect", council_id: id })
    expect(seen).toMatchObject({ status: "stopping", stage: "stopping" })
    expect((await s.su`select state from stop_request where execution_id = ${running.execution}`)[0].state).toBe("unknown")

    // Proof moves it; saved answers stay.
    await endAttempt(s.runner, { execution: running.execution, evidence: GONE, cause: "the process tree is gone", requested: true })
    const done =await callTool(s.binding(), "hub_council", { action: "inspect", council_id: id })
    expect(done).toMatchObject({ status: "stopped", stage: "stopped" })
    const [final] = Array.from(await s.su`select lifecycle, completed_at from council where id = ${id}`) as any[]
    expect(final.lifecycle).toBe("stopped")
    expect(final.completed_at).not.toBeNull()
    expect(Array.from(await s.su`select state from round_member where council_id = ${id} order by participant_id`).map((row: any) => row.state)).toEqual(["stopped", "cancelled", "answered"])
    expect((await s.su`select body from inbound where id = ${"report:" + j3.id}`)[0].body, "answers already saved are kept").toContain("answer three, saved")
  } finally { await s.close() }
}, 120_000)

test("K8 stopping a council nothing of which had started is stopped at once, with every input disabled and none run", async () => {
  const s = await councilStage(cluster, track)
  try {
    const { id, jobs } = await begin(s)
    await s.human("h3")
    const reply = await callTool(s.binding("attempt-stop"), "hub_council", { action: "stop", request_key: "stop-1", council_id: id, expected_revision: await s.revision(id), source_message_ids: ["h3"] })
    expect(reply).toMatchObject({ status: "stopped", stage: "stopped" })
    expect(await s.count("execution")).toBe(0)
    expect(await s.count("claim_gate", "state = 'open'")).toBe(jobs.length)
    expect((await s.su`select state from round_member where council_id = ${id}`).map((row: any) => row.state)).toEqual(["cancelled", "cancelled"])
    for (const agent of ["p1-w1", "p1-w2"]) expect(await readEligible(s.runner, { agent, resumeOk: true })).toEqual([])
  } finally { await s.close() }
}, 60_000)

// ---------------------------------------------------------------------------
// A council that is over does not start work through any branch but the owner's follow-up.
// ---------------------------------------------------------------------------

/** A council of the given workers whose every answer is in, finalized by the master from its own attempt, and complete. */
async function completed(s: Stage, workers: string[], over: Record<string, unknown> = {}) {
  const begun = await begin(s, workers, over)
  for (const job of begun.jobs) await s.conversationOf(job.id)
  await answerRound(s, begun.id, "independent")
  const [event] = Array.from(await s.su`select inbound_id from council_event where council_id = ${begun.id} and kind = 'round_complete' order by seq`) as { inbound_id: string }[]
  const attempt = await s.feed(event.inbound_id)
  expect(await move(s, begun.id, { kind: "finalize" }, attempt.id)).toMatchObject({ stage: "preparing_result" })
  await s.settleMaster(event.inbound_id, attempt, "The result.")
  expect((await s.su`select lifecycle from council where id = ${begun.id}`)[0].lifecycle).toBe("complete")
  return begun
}

const jobCount = (s: Stage) => s.count("inbound", "kind = 'job'")

test("K12 a finalized council whose owner opted into debate cannot restart on a source-free debate request or on one that cites a message: nothing is queued, and the owner's own follow-up is what reopens it, in the same conversations, in a new epoch", async () => {
  const s = await councilStage(cluster, track)
  try {
    const { id, jobs, participants } = await completed(s, ["p1-w1", "p1-w2"], { debate: true })
    const before = [await s.count("council_round"), await jobCount(s), await s.count("council_decision")]
    const debate = { kind: "debate_round", participants, briefs: briefs(participants, "Again:", [{ participant_id: participants[1] }]) }

    // The opt-in the owner gave at the start is for the master's next step inside a period, and this period is over.
    const refused = await move(s, id, debate)
    expect(refused).toMatchObject({ status: "failed", cause: "closed" })
    expect(String(refused.status_message), "and it says what does reopen it").toContain("follow_up")
    await s.human("h5")
    expect(await move(s, id, { ...debate, source_message_ids: ["h5"] }), "a fresh message does not change that: only a follow-up is the transition").toMatchObject({ status: "failed", cause: "closed" })
    expect([await s.count("council_round"), await jobCount(s), await s.count("council_decision")], "nothing was queued, opened or recorded").toEqual(before)
    expect((await s.su`select lifecycle, epoch from council where id = ${id}`)[0]).toMatchObject({ lifecycle: "complete", epoch: 1 })

    // The owner's own follow-up is the explicit transition: same participants, same conversations, a new period, no confirmation.
    await s.human("h6")
    const follow = await move(s, id, { kind: "follow_up", source_message_ids: ["h6"], participants, briefs: briefs(participants, "One more thing:") })
    expect(follow).toMatchObject({ status: "running", stage: "follow_up", round: 2, epoch: 2 })
    const round2 = (await s.jobsOf(id)).filter(job => job.source.dispatch.council_round.round === 2)
    expect(round2).toHaveLength(2)
    for (const job of round2) expect(job.source.dispatch.conversation).toBe((await s.conversationOf(jobs.find(one => one.agent === job.agent)!.id)).id)
    expect((await s.su`select epoch, epoch_authority from council where id = ${id}`)[0]).toMatchObject({ epoch: 2, epoch_authority: { source_message_ids: ["h6"] } })
    expect(await s.count("confirmation"), "no redundant confirmation").toBe(0)
    // Inside the new period the opt-in the owner gave still makes a debate the master's own next step.
    await answerRound(s, id, "follow-up")
    expect(await move(s, id, { kind: "debate_round", participants, briefs: briefs(participants, "Challenge it:") })).toMatchObject({ status: "running", stage: "debate_round", round: 3 })
  } finally { await s.close() }
}, 150_000)

test("K13 a debate is opted into later, on the owner's fresh words, after their follow-up: the terminal council itself cannot be debated, and a debate inside the new period needs no confirmation", async () => {
  const s = await councilStage(cluster, track)
  try {
    const { id, participants } = await completed(s, ["p1-w1", "p1-w2"])
    expect((await s.su`select debate_opt_in from council where id = ${id}`)[0].debate_opt_in).toBeNull()
    await s.human("h5")
    const debate = { kind: "debate_round", participants, briefs: briefs(participants, "Answer the other participant's point:", [{ participant_id: participants[1] }]) }
    expect(await move(s, id, { ...debate, source_message_ids: ["h5"] }), "the council is over").toMatchObject({ status: "failed", cause: "closed" })
    expect((await s.su`select debate_opt_in from council where id = ${id}`)[0].debate_opt_in, "and the refusal recorded no opt-in").toBeNull()
    await s.human("h6")
    expect(await move(s, id, { kind: "follow_up", source_message_ids: ["h6"], participants, briefs: briefs(participants, "One more thing:") })).toMatchObject({ stage: "follow_up", epoch: 2 })
    await answerRound(s, id, "follow-up")
    await s.human("h7")
    const later = await move(s, id, { ...debate, source_message_ids: ["h7"] })
    expect(later).toMatchObject({ status: "running", stage: "debate_round", round: 3 })
    expect((await s.su`select debate_opt_in from council where id = ${id}`)[0].debate_opt_in).toMatchObject({ kind: "later", source_message_ids: ["h7"] })
    expect(await s.count("confirmation")).toBe(0)
  } finally { await s.close() }
}, 150_000)

test("K14 a council finalized without a participant, and one that was stopped, cannot queue a retry or a replacement of it: the decision is refused while the lifecycle stays terminal, and the follow-up is the way back", async () => {
  const s = await councilStage(cluster, track)
  try {
    // Finalized with the available answers: the second participant was interrupted and the owner chose to go without it.
    const { id, jobs: [j1, j2], participants: [p1, p2] } = await begin(s)
    await s.answer(j1.id, "answer one")
    const held = await s.interrupt(j2.id)
    await reconcileCouncil(s.runner, id)
    await s.human("h3")
    // The owner's message starts the master's turn, and that turn records the owner's choice and finalizes: the choice makes the round complete, and the
    // event that says so is taken into THIS turn (a decision called from an attempt adopts the waiting event, R3) and is never fed on its own.
    const attempt = await s.feed("h3")
    expect(await move(s, id, { kind: "owner_decision", source_message_ids: ["h3"], decision: { choice: "use_available", affected_ids: [p2] } }, attempt.id)).toMatchObject({ stage: "using_available" })
    const [event] = Array.from(await s.su`select inbound_id, consumed_attempt, disposition from council_event where council_id = ${id} and kind = 'round_complete'`) as { inbound_id: string; consumed_attempt: string; disposition: string }[]
    expect(event).toMatchObject({ consumed_attempt: attempt.id, disposition: "in_turn" })
    expect(await move(s, id, { kind: "finalize" }, attempt.id)).toMatchObject({ stage: "preparing_result" })
    await s.settleMaster("h3", attempt, "The result, without the second participant.", "human")
    expect((await s.su`select lifecycle, result from council where id = ${id}`)[0]).toMatchObject({ lifecycle: "complete", result: { mode: "use_available", omitted: [p2] } })
    expect((await membersState(s, id)).find(one => one.participant_id === p2)).toMatchObject({ state: "missing" })

    await s.human("h4")
    const spec = { worker_ref: "p1-w3", preset_ref: "daily", machine_ref: RUNNER, brief: "take over" }
    const before = [await jobCount(s), await s.count("council_participant"), await s.count("council_decision"), await s.count("replay_hold", "state = 'held'")]
    const retry = await move(s, id, { kind: "owner_decision", source_message_ids: ["h4"], decision: { choice: "retry", affected_ids: [p2] } })
    expect(retry).toMatchObject({ status: "failed", cause: "closed" })
    expect(String(retry.status_message)).toContain("follow_up")
    expect(await move(s, id, { kind: "owner_decision", source_message_ids: ["h4"], decision: { choice: "replace", affected_ids: [p2], replacement_spec: spec } })).toMatchObject({ status: "failed", cause: "closed" })
    expect([await jobCount(s), await s.count("council_participant"), await s.count("council_decision"), await s.count("replay_hold", "state = 'held'")], "no job, participant, decision or hold was made").toEqual(before)
    expect((await s.su`select lifecycle from council where id = ${id}`)[0].lifecycle).toBe("complete")

    // The owner's follow-up of the participant that was left out: the same conversation it had, a new period.
    await s.human("h6")
    expect(await move(s, id, { kind: "follow_up", source_message_ids: ["h6"], participants: [p2], briefs: briefs([p2], "Tell us what you had, if anything:") })).toMatchObject({ stage: "follow_up", epoch: 2 })
    const fresh = (await s.jobsOf(id)).filter(job => job.source.dispatch.council_round.round === 2)
    expect(fresh).toHaveLength(1)
    expect(fresh[0].source.dispatch.conversation).toBe(held.conversation)
    void p1
  } finally { await s.close() }
}, 150_000)

test("K15 a stopped council cannot be retried or replaced into: nothing is queued while the lifecycle stays stopped, and the owner's follow-up starts a new period in the participant's own conversation", async () => {
  const s = await councilStage(cluster, track)
  try {
    const { id, jobs: [, j2], participants: [, p2] } = await begin(s)
    const held = await s.interrupt(j2.id)
    await reconcileCouncil(s.runner, id)
    await s.human("h3")
    const stopped = await callTool(s.binding("attempt-stop"), "hub_council", { action: "stop", request_key: "stop-1", council_id: id, expected_revision: await s.revision(id), source_message_ids: ["h3"] })
    expect(stopped).toMatchObject({ status: "stopped", stage: "stopped" })
    expect((await membersState(s, id)).find(one => one.participant_id === p2)).toMatchObject({ state: "missing" })

    await s.human("h4")
    const before = [await jobCount(s), await s.count("council_participant"), await s.count("council_decision")]
    expect(await move(s, id, { kind: "owner_decision", source_message_ids: ["h4"], decision: { choice: "retry", affected_ids: [p2] } })).toMatchObject({ status: "failed", cause: "closed" })
    expect(await move(s, id, { kind: "owner_decision", source_message_ids: ["h4"],
      decision: { choice: "replace", affected_ids: [p2], replacement_spec: { worker_ref: "p1-w3", preset_ref: "daily", machine_ref: RUNNER, brief: "take over" } } })).toMatchObject({ status: "failed", cause: "closed" })
    expect([await jobCount(s), await s.count("council_participant"), await s.count("council_decision")]).toEqual(before)
    expect((await s.su`select lifecycle from council where id = ${id}`)[0].lifecycle).toBe("stopped")
    // No source-free or opted-in debate either, whatever the owner opted into: it is not a comparison that completed.
    expect(await move(s, id, { kind: "debate_round", participants: [p2], briefs: briefs([p2], "Again:") })).toMatchObject({ status: "failed", cause: "closed" })

    await s.human("h6")
    expect(await move(s, id, { kind: "follow_up", source_message_ids: ["h6"], participants: [p2], briefs: briefs([p2], "One more thing:") })).toMatchObject({ stage: "follow_up", epoch: 2 })
    const fresh = (await s.jobsOf(id)).filter(job => job.source.dispatch.council_round.round === 2)
    expect(fresh).toHaveLength(1)
    expect(fresh[0].source.dispatch.conversation).toBe(held.conversation)
  } finally { await s.close() }
}, 150_000)

async function code(run: Promise<unknown>): Promise<string> {
  try { await run; return "no error" } catch (error) { return error instanceof ToolError ? error.code : `not a ToolError: ${(error as Error).message}` }
}

// The freshness of the owner's words is compared by the database, at the microsecond. A JS Date keeps milliseconds, so a message written a few
// microseconds after the news it must follow (the fixture and a fast machine put them in the same millisecond) was refused as "older".

test("K16 a choice about a missing participant must be newer than the news of it to the microsecond: words inside the news' own millisecond are newer, equal or older by their own microseconds, and a refusal spends nothing", async () => {
  const s = await councilStage(cluster, track)
  try {
    const { id, jobs: [j1, j2], participants: [p1] } = await begin(s)
    await s.answer(j2.id, "two")
    await s.interrupt(j1.id)
    await reconcileCouncil(s.runner, id)
    const news = `council_id = '${id}' and kind in ('member_missing', 'round_stalled')`
    expect(await s.count("council_event", news), "the news of the missing participant was written").toBeGreaterThan(0)
    // The news is put at a known microsecond of a millisecond, and the three messages are at, a microsecond before and a microsecond after it.
    const [t] = Array.from(await s.su`select moment::text as same, (moment - interval '1 microsecond')::text as earlier, (moment + interval '1 microsecond')::text as later
      from (select date_trunc('milliseconds', now() - interval '1 second') + interval '456 microseconds' as moment) x`) as { same: string; earlier: string; later: string }[]
    await s.su.unsafe(`update council_event set ready_at = $1::timestamptz where ${news}`, [t.same])
    await s.human("us-earlier", { at: t.earlier })
    await s.human("us-same", { at: t.same })
    await s.human("us-later", { at: t.later })
    const [held] = Array.from(await s.su.unsafe(`select max(ready_at) as at from council_event where ${news}`)) as { at: Date }[]
    const words = Array.from(await s.su`select received_at from inbound where id in ('us-earlier', 'us-same', 'us-later')`) as { received_at: Date }[]
    expect(new Set([held.at.getTime(), ...words.map(one => one.received_at.getTime())]).size, "the premise: a JS Date cannot tell the news and the three messages apart").toBe(1)

    const decision = { kind: "owner_decision", decision: { choice: "retry", affected_ids: [p1] } }
    const state = async () => [await s.revision(id), await jobCount(s), await s.count("council_decision"), await s.count("source_consumption", "source_id like 'us-%'")]
    const before = await state()
    // Not newer than the news, on either side of it inside the millisecond: refused by name, nothing recorded, nothing queued, no message spent.
    for (const source of ["us-earlier", "us-same"]) expect(await code(move(s, id, { ...decision, source_message_ids: [source] })), source).toBe("source_invalid")
    expect(await state()).toEqual(before)

    // A microsecond newer is newer: the choice is recorded once, and a repeat of the very request is its own answer.
    const args = { action: "continue", request_key: "k-later", council_id: id, expected_revision: await s.revision(id), ...decision, source_message_ids: ["us-later"] }
    const reply = await callTool(s.binding("attempt-master"), "hub_council", args)
    expect(reply).toMatchObject({ stage: "retrying" })
    expect(await callTool(s.binding("attempt-master"), "hub_council", args)).toEqual(reply)
    expect(await jobCount(s), "one continuation, however often it was asked").toBe(before[1] + 1)
    // The message is spent for any other request, and the two that were refused are still unspent.
    expect(await code(move(s, id, { ...decision, source_message_ids: ["us-later"] }))).toBe("source_already_used")
    expect(await s.count("source_consumption", "source_id like 'us-%'")).toBe(1)
    expect(await s.count("source_consumption", "source_id in ('us-earlier', 'us-same')")).toBe(0)
  } finally { await s.close() }
}, 90_000)

test("K17 a stop must cite words newer than the council to the microsecond: a message a microsecond before or at the council's creation is refused and spent on nothing, one a microsecond after stops it", async () => {
  const s = await councilStage(cluster, track)
  try {
    const { id } = await begin(s)
    const [t] = Array.from(await s.su`select created_at::text as same, (created_at - interval '1 microsecond')::text as earlier, (created_at + interval '1 microsecond')::text as later
      from council where id = ${id}`) as { same: string; earlier: string; later: string }[]
    await s.human("us-earlier", { at: t.earlier })
    await s.human("us-same", { at: t.same })
    await s.human("us-later", { at: t.later })
    const stopWith = async (source: string) => callTool(s.binding("attempt-stop"), "hub_council", { action: "stop", request_key: `stop-${source}`, council_id: id, expected_revision: await s.revision(id), source_message_ids: [source] })
    const lifecycle = async () => String((await s.su`select lifecycle from council where id = ${id}`)[0].lifecycle)
    const before = await lifecycle()
    for (const source of ["us-earlier", "us-same"]) expect(await code(stopWith(source)), source).toBe("source_invalid")
    expect(await s.count("source_consumption", "source_id like 'us-%'"), "a refusal spends no message").toBe(0)
    expect(await lifecycle(), "and stops nothing").toBe(before)
    expect(await stopWith("us-later")).not.toMatchObject({ status: "failed" })
    expect(["stopping", "stopped"]).toContain(await lifecycle())
    expect(await s.count("source_consumption", "source_id like 'us-%'")).toBe(1)
  } finally { await s.close() }
}, 90_000)

const membersState = async (s: Stage, id: string) => Array.from(await s.su`select participant_id, state from round_member where council_id = ${id} order by participant_id, input_revision`) as { participant_id: string; state: string }[]

// ---------------------------------------------------------------------------
// The master's room.
// ---------------------------------------------------------------------------

test("K9 an active council keeps one slot free for its master on the master's own runner, once however many councils it has, and lets go when it is done", async () => {
  const s = await councilStage(cluster, track)
  try {
    await begin(s)
    const registry = loadRegistry(s.registryFile)
    const hold = (over: Record<string, unknown> = {}) => mastersToHold(s.runner, { runner: RUNNER, registry, admitting: { id: "p1-w3", door: undefined }, residentReserved: () => false, ...over } as never)
    expect(await hold()).toEqual(["p1-lair"])
    expect(await hold({ residentReserved: (agent: string) => agent === "p1-lair" }), "a master that already holds a slot needs no second one").toEqual([])
    expect(await hold({ admitting: { id: "p1-lair", door: DOOR } }), "a chat agent is never made to wait for its own reserve").toEqual([])
    expect(await hold({ runner: "runner-elsewhere" }), "every other runner keeps its own limits").toEqual([])
    // A second council of the same master shares the one reservation.
    await s.human("h3")
    const second = await callTool(s.binding("attempt-2"), "hub_council", startArgs({ request_key: "start-2", authority: { source_message_ids: ["h3"] }, participants: roster(["p1-w2", "p1-w3"]) }))
    expect(second).toMatchObject({ status: "running" })
    expect(await hold()).toEqual(["p1-lair"])
    // Released when the councils are settled: complete or stopped, and no event waiting for the master.
    await s.su`update council set lifecycle = 'complete' where lifecycle = 'running'`
    expect(await hold()).toEqual([])
  } finally { await s.close() }
}, 60_000)


test("debate quotes a long answer without splitting an emoji at the jsonb boundary", async () => {
  const s = await councilStage(cluster, track)
  try {
    const { id, jobs: firstJobs, participants } = await begin(s)
    for (const job of firstJobs) await s.conversationOf(job.id)
    await answerRound(s, id, "a".repeat(5999) + "😀tail")
    await s.human("h3")
    expect(await move(s, id, { kind: "debate_round", source_message_ids: ["h3"], participants,
      briefs: briefs(participants, "Respond:", [{ participant_id: participants[1] }]) }))
      .toMatchObject({ status: "running", round: 2 })
    const jobs = (await s.jobsOf(id)).filter(job => job.source.dispatch.council_round.round === 2)
    expect(jobs).toHaveLength(2)
    for (const job of jobs) {
      expect(job.body).toContain("a".repeat(5999))
      expect(job.body).not.toContain("😀")
      expect(job.body.isWellFormed()).toBe(true)
    }
  } finally { await s.close() }
}, 120_000)
