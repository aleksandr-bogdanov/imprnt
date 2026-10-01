// The store's half of moving a topic master (IMP-231, migration 016): protocol 4, the request and its agent gate, the drain, the holds
// and failures a move meets, the export and the identities every step is bound to.
//
// A real Postgres, and every write goes through the roles the processes use (`hub_runner`, `hub_door`, `hub_hub`). WHAT THIS PROVES is the
// store's: the stage machine, the ordering of a request against the first feed intent, what the store validates itself and what it only
// records because nothing but the operating system or an adapter can know it. WHAT IT DOES NOT PROVE, and this file does not pretend to:
// that a runner closes its child before it says so, that a spawn paused after its precheck cannot start, that a file lands where a
// manifest says, that any adapter can carry a session. Those are runner and transfer tests that come after this slice; the evidence used
// here is scripted, and a scripted "started" conversation is a fixture, never production native continuity.

import { afterAll, afterEach, beforeAll, expect, test } from "bun:test"
import { startCluster, type Cluster } from "./helpers/cluster.ts"
import { jobSource } from "./helpers/conversations.ts"
import { BOOT_1, BOOT_2, DST, EXIT_BOOT, EXIT_NO_CHILD, FACTS, FILES, OWNER, SRC, drainEvidence, exitGroup, manifestOf, moveStage, scriptedNative, sha } from "./helpers/move-store-stage.ts"
import type { ExitEvidence } from "../src/adapters/types.ts"
import type { StoreLike } from "../src/store/connect.ts"
import { claimNext } from "../src/runner/claim.ts"
import { endAttempt } from "../src/runner/execution.ts"
import {
  ExecutionNotOwned, MoveGated, activateProtocol, completeExecution, markFeedIntent, markProgress, openHoldsOf, provenUnfedEnd,
} from "../src/store/conversations.ts"
import {
  MOVE_MAX_FILE_BYTES, activateMove, advanceImport, beginImport, blockMove, checkMoveFailure, checkpointOf, continueMove, destReady, exportGenerationOf,
  moveGateOperation, putBlob, recordDrainDone, recordDrainIntent, releaseSource, requestMove, unblockMove, type MoveStage,
} from "../src/store/moves.ts"
import { gatesOn } from "../src/store/controls.ts"
import { requestTransition } from "../src/store/topics.ts"

let cluster: Cluster
const mine: { close(): Promise<void> }[] = []
const track = <T extends { close(): Promise<void> }>(sql: T): T => { mine.push(sql); return sql }
beforeAll(async () => { cluster = await startCluster() })
afterEach(async () => { for (const one of mine.splice(0)) await one.close().catch(() => {}) })
afterAll(async () => { await cluster?.stop() })

const stage = () => moveStage(cluster, track)
/** A statement as a real promise, so that `expect(...).rejects` reads what the store said. */
const attempt = async (query: PromiseLike<unknown>): Promise<void> => { await query }

/** Rows as plain objects, so that `toMatchObject` and `toEqual` compare what the statement returned and not the client's row list. */
const rows = (result: unknown) => Array.from(result as Record<string, unknown>[]).map(row => ({ ...row }))

const GONE: ExitEvidence = { confirmed: true, leader: "exited", descendants: "none", pids: [], survivors: [], via: "test" }
const NOT_GONE: ExitEvidence = { confirmed: false, leader: "unknown", descendants: "unverified", pids: [], survivors: [], via: "test" }

/** A claim the way a connection of a given protocol makes it: `null` says nothing at all, as every runner before 2 did. */
const claimSaying = (store: StoreLike, protocol: string | null, id: string) => store.sql.begin(async (tx: any) => {
  if (protocol !== null) await tx`select set_config('hub.runner_protocol', ${protocol}, true)`
  await tx`update inbound set claimed_by = 'some-runner', claim_deadline = now() + interval '1 minute' where id = ${id}`
})

/** Waits until the backend is blocked on a lock, read from the server, never a fixed sleep. */
const blockedOnLock = async (sql: any, pid: number) => {
  const until = Date.now() + 15_000
  for (;;) {
    const [seen] = await sql`select wait_event_type as waiting from pg_stat_activity where pid = ${pid}`
    if (seen?.waiting === "Lock") return
    if (Date.now() > until) throw new Error(`backend ${pid} never blocked on a lock: ${JSON.stringify(seen)}`)
    await Bun.sleep(20)
  }
}
const pidOf = async (store: StoreLike) => Number((await store.sql`select pg_backend_pid() as pid`)[0].pid)

const councilJob = (id: string) => ({ log_id: id, at: new Date().toISOString(), door: "door-fake", chat: "1000000001", from: "p1", text: "a council's question",
  dispatch: { dispatcher: "p1-lair", target: "p1-w1", approved: { by: "p1", at: new Date().toISOString(), digest: "d", source: "council" },
    return: { agent: "p1-lair", door: "door-fake", chat: "1000000001" }, council_round: { council: "c1", round: 1, participant: "c1:p1", revision: 1 } } })

test("protocol 4: a move is refused while it is inactive, a process that registered at 3 before the activation claims nothing new after it (its open attempt still finishes), and a move's steps bind the current protocol-4 incarnation and not the global flag", async () => {
  const s = await stage()
  const t = await s.topic()
  // Two processes of protocol 3 that registered BEFORE 4 was activated, which was allowed then, and an attempt the source already opened.
  await s.su`insert into runner_incarnation (runner, incarnation, protocol, machine) values ('runner-pi', 'old-3', 3, 'pi'), ('runner-mac', 'old-mac', 3, 'mac')`
  const open = await s.attempt(t, "h-old", { runner: "runner-pi", incarnation: "old-3", machine: "pi" })
  await s.inbound("plain-1", "p1-other")
  await s.su`insert into inbound (id, person, agent, body, kind, source, log_ready) values ('c-job', 'p1', 'p1-w1', 'a council question', 'job', ${councilJob("c-job")}::jsonb, true)`

  // BEFORE the activation no move is admitted, and nothing is gated or written for the refusal.
  const early = await requestMove(s.tool, { operation: "op-early", topic: t.id, destRunner: DST.runner, destMachine: DST.machine, by: OWNER })
  expect(early).toEqual({ answer: "protocol-inactive", move: null })
  expect(await s.count("topic_move")).toBe(0)
  expect(await s.openGates(t.agent_id)).toEqual([])
  // A connection that says 3 claims an ordinary row while 4 is not active; the release is not a claim.
  await claimSaying(s.tool, "3", "plain-1")
  await s.su`update inbound set claimed_by = null, claim_deadline = null where id = 'plain-1'`

  // ACTIVATION: one statement, nothing started, stopped, settled or discarded.
  await activateProtocol(s.tool)
  expect(Number((await s.su`select runner_protocol from hub_protocol`)[0].runner_protocol)).toBe(4)
  for (const id of ["plain-1", "c-job"]) {
    await expect(claimSaying(s.tool, "3", id), `${id}: a runner of 3 claims nothing once 4 is active`).rejects.toThrow(/does not speak protocol 4/)
  }
  await claimSaying(s.tool, "4", "plain-1")
  await s.su`update inbound set claimed_by = null, claim_deadline = null where id = 'plain-1'`
  // The attempt the old process had open finishes under its own fences: activation stops nothing.
  await markFeedIntent(s.tool, open.execution, "body of h-old")
  await completeExecution(s.tool, { execution: open.execution.id, runner: "runner-pi", reply: "done", fence: { incarnation: "old-3" } })
  expect((await s.su`select state from execution where id = ${open.execution.id}`)[0].state).toBe("completed")
  // A registration that speaks less than what is active cannot become current.
  await expect(s.tool.sql`insert into runner_incarnation (runner, incarnation, protocol) values ('runner-old', 'x', 3)`.execute()).rejects.toThrow(/does not serve/)
  await expect(s.tool.sql`update hub_protocol set runner_protocol = 5`.execute()).rejects.toThrow(/check constraint/)

  // The move is admitted now. Its steps are the CURRENT PROTOCOL-4 incarnation's: the two residents of 3 are refused, whatever the store says globally.
  const move = await s.request(t)
  expect(await recordDrainIntent(s.tool, move.id, { runner: "runner-pi", incarnation: "old-3" }, { id: "i-old", boot_id: BOOT_1, machine: "pi" })).toBe("not-source")
  expect(await destReady(s.tool, move.id, { runner: "runner-mac", incarnation: "old-mac" }, FACTS)).toBe("not-destination")
  await s.register(SRC, "src-2")
  await s.register(DST, "dst-1")
  expect(await recordDrainIntent(s.tool, move.id, s.src("src-2"), { id: "i-new", boot_id: BOOT_1, machine: "pi" })).toBe("intent")
  expect(await destReady(s.tool, move.id, s.dst(), FACTS)).toBe("ready")
  // The gate was there the whole time.
  expect(await s.openGates(t.agent_id)).toEqual([moveGateOperation(move.id)])
})

test("a request places the master's agent gate in its own transaction even with the destination offline: nothing new is claimed, the queue is intact, and a refusal gates nothing", async () => {
  const s = await stage()
  await s.fleet({ destination: false })
  const t = await s.topic()
  await s.inbound("h1", t.agent_id)
  await s.inbound("h2", t.agent_id)
  const asked = await requestMove(s.tool, { operation: "op-1", topic: t.id, destRunner: DST.runner, destMachine: DST.machine, by: OWNER, route: { door: "door-d", chat: "chat-x" } })
  expect(asked.answer).toBe("requested")
  const move = asked.move!
  expect(move).toMatchObject({ stage: "waiting", block: null, source_runner: SRC.runner, source_machine: "pi", dest_runner: DST.runner, dest_machine: "mac",
    dest_ready_at: null, conversation_id: t.conversation_id, source_generation: 1, native_state: "new", adapter: "synthetic" })
  expect(move.source_facts).toEqual({ holds: 0, attempts: 0, councils: 0, jobs: 0 })
  // What the store knew of the source AT THE REQUEST is frozen with the move (the destination is offline and was never needed for it).
  expect(move.source_incarnation).toMatchObject({ known: true, incarnation: "src-1", boot_id: BOOT_1, machine: "pi", protocol: 4 })
  expect(move.block).toBeNull()
  expect(move.export_generation).toBe(0)

  // The gate is the move's own, over the agent, committed with the request; nothing of the destination exists yet.
  expect(await s.openGates(t.agent_id)).toEqual([moveGateOperation(move.id)])
  const [gate] = await gatesOn(s.tool, { kind: "agent", id: t.agent_id })
  expect(gate).toMatchObject({ cause: "move", state: "open", evidence: { topic: t.id, move: move.id } })
  expect(await s.count("runner_incarnation where runner = $1", DST.runner)).toBe(0)
  // Nothing new is claimed, by the runner's own selection or by a statement that does not ask.
  expect(await claimNext(s.tool, { runner: SRC.runner, agent: t.agent_id, leaseMs: 60_000, resumeOk: true })).toBeNull()
  await expect(attempt(s.su`update inbound set claimed_by = ${SRC.runner} where id = 'h1'`)).rejects.toThrow(/not claimable/)
  expect(await s.count("inbound where agent = $1 and claimed_by is null and state not in ('answered', 'delivered')", t.agent_id), "no queued row was lost or claimed").toBe(2)

  // The same operation is the same move; a second one for this topic is refused by name and gates nothing more.
  expect(await requestMove(s.tool, { operation: "op-1", topic: t.id, destRunner: DST.runner, destMachine: DST.machine, by: OWNER })).toMatchObject({ answer: "replay", move: { id: move.id } })
  expect((await requestMove(s.tool, { operation: "op-2", topic: t.id, destRunner: "runner-x", destMachine: "x", by: OWNER })).answer).toBe("in-progress")
  expect(await s.openGates(t.agent_id)).toEqual([moveGateOperation(move.id)])
  expect(await s.count("topic_move")).toBe(1)

  // Every refusal is a word, and none of them places or releases a gate.
  const archived = await s.topic()
  await s.su`update topic set lifecycle = 'archiving' where id = ${archived.id}`
  const same = await s.topic()
  const pending = await s.topic()
  await s.su`insert into topic_transition (id, topic_id, kind, seq, source, requested_by, stage) values ('del-1', ${pending.id}, 'deletion_request', 1, 'discord', 'discord:observed', 'pending_setup')`
  const ask = (topic: string, runner: string = DST.runner, machine: string = DST.machine) => requestMove(s.tool, { operation: `op-${topic}-${runner}`, topic, destRunner: runner, destMachine: machine, by: OWNER })
  expect((await ask("no-such-topic")).answer).toBe("unknown-topic")
  expect((await ask(archived.id)).answer).toBe("not-active")
  expect((await ask(same.id, "runner-x", "pi")).answer).toBe("same-machine")
  expect((await ask(pending.id)).answer).toBe("in-progress")
  for (const other of [archived, same, pending]) expect(await s.openGates(other.agent_id), other.id).toEqual([])
  expect(await s.count("topic_move")).toBe(1)
  expect(await s.openGates(t.agent_id), "the move's gate is exactly as it was").toEqual([moveGateOperation(move.id)])

  // An open council and an unanswered job are ADMITTED, and counted for the owner to see.
  const busy = await s.topic()
  await s.su`insert into council (id, person, agent, origin_kind, origin, return_route, operation_id, question, lifecycle, checkpoint_deadline, status_effect_key)
    values ('c-open', 'p1', ${busy.agent_id}, 'owner_request', '{}'::jsonb, ${{ agent: busy.agent_id, door: "door-d", chat: "1" }}::jsonb, 'op-c-open', 'which?', 'running',
            now() + interval '1 hour', 'council-status:c-open')`
  await s.su`insert into inbound (id, person, agent, body, kind, source) values ('job-1', 'p1', ${busy.agent_id}, 'task job-1', 'job',
    ${jobSource("job-1", { target: busy.agent_id, task: "task job-1" })}::jsonb)`
  const admitted = await s.request(busy)
  expect(admitted.source_facts).toEqual({ holds: 0, attempts: 0, councils: 1, jobs: 1 })
  expect(admitted.stage).toBe("waiting")
})

test("a request and the first feed intent of an unfed attempt are ordered: the request first refuses that feed as proven unfed (queued, no hold), the feed first lets that turn finish, and a legacy tail_fed attempt is never called unfed", async () => {
  const s = await stage()
  await s.fleet()

  // REQUEST FIRST, with the attempt claimed and its spawn still awaiting (nothing is fed yet).
  const t = await s.topic()
  const { execution } = await s.attempt(t, "h1")
  const move = await s.request(t)
  expect(move.drain_attempts).toMatchObject([{ execution: execution.id, state: "claimed" }])
  // A caller that is no longer this attempt's owner meets the ownership refusal, not the move's.
  await expect(markFeedIntent(s.tool, { ...execution, incarnation: "not-me" }, "body of h1")).rejects.toBeInstanceOf(ExecutionNotOwned)
  const refused = await markFeedIntent(s.tool, execution, "body of h1").then(() => null, (error: unknown) => error)
  expect(refused).toBeInstanceOf(MoveGated)
  expect(refused).not.toBeInstanceOf(ExecutionNotOwned)
  expect((refused as MoveGated).provenUnfed).toBe(true)
  // Nothing was committed: no state change, no input entry, no diary line of a feed.
  expect(rows(await s.su`select state, feed_intent_at from execution where id = ${execution.id}`)).toMatchObject([{ state: "claimed", feed_intent_at: null }])
  expect(await s.count("conversation_entry")).toBe(0)
  expect(await s.count("ledger_event where stream = 'execution' and kind = 'feed.intent'")).toBe(0)
  // It is handed back through the existing endAttempt: failed, claim released, NO hold, the row stays queued behind the gate.
  const end = await provenUnfedEnd(s.tool, refused as MoveGated)
  // It carries NO `delivered: false`: that flag would settle the attempt `failed` whatever the store then says (see the race below).
  expect(end).toEqual({ execution: execution.id, evidence: null, cause: `move-gated:${move.id}` })
  expect("delivered" in end!).toBe(false)
  await endAttempt(s.tool, end!)
  expect((await s.su`select state from execution where id = ${execution.id}`)[0].state).toBe("failed")
  expect(await s.count("replay_hold")).toBe(0)
  expect(rows(await s.su`select claimed_by from inbound where id = 'h1'`)).toMatchObject([{ claimed_by: null }])
  expect((await s.su`select state from inbound where id = 'h1'`)[0].state).not.toBe("answered")
  expect((await s.su`select hub_move_unresolved(${t.agent_id}) as n`)[0].n).toBe(0)
  expect(await claimNext(s.tool, { runner: SRC.runner, agent: t.agent_id, leaseMs: 60_000, resumeOk: true }), "no implicit retry and no fallback: the gate holds").toBeNull()
  expect(await s.openGates(t.agent_id)).toEqual([moveGateOperation(move.id)])
  expect((await provenUnfedEnd(s.tool, refused as MoveGated)), "a failed attempt is not handed back twice").toBeNull()

  // A LEGACY tail_fed attempt is already uncertain: its input's own feed goes on (it is a fed turn finishing) and it is never proven unfed.
  const legacy = await s.topic()
  const old = await s.attempt(legacy, "h-tail")
  await markFeedIntent(s.tool, old.execution, "", "tail")
  const legacyMove = await s.request(legacy)
  expect(legacyMove.drain_attempts).toMatchObject([{ execution: old.execution.id, state: "feed_intent" }])
  await markFeedIntent(s.tool, old.execution, "body of h-tail", "input")
  expect(await s.count("conversation_entry where conversation_id = $1 and kind = 'input'", legacy.conversation_id)).toBe(1)
  expect(await provenUnfedEnd(s.tool, new MoveGated(old.execution.id, legacy.agent_id, legacyMove.id))).toBeNull()

  // FEED FIRST: the turn that was fed finishes normally, and nothing behind it starts.
  const fedFirst = await s.topic()
  const turn = await s.fed(fedFirst, "h3")
  const fedMove = await s.request(fedFirst)
  expect(fedMove.drain_attempts).toMatchObject([{ execution: turn.execution.id, state: "feed_intent" }])
  await markProgress(s.tool, turn.execution.id, "received")
  await completeExecution(s.tool, { execution: turn.execution.id, runner: SRC.runner, reply: "done", fence: { incarnation: "src-1" } })
  expect((await s.su`select state from execution where id = ${turn.execution.id}`)[0].state).toBe("completed")
  expect(await s.count("conversation_entry where conversation_id = $1", fedFirst.conversation_id), "its input and its reply").toBe(2)
  await s.inbound("h4", fedFirst.agent_id)
  expect(await claimNext(s.tool, { runner: SRC.runner, agent: fedFirst.agent_id, leaseMs: 60_000, resumeOk: true })).toBeNull()
  expect(await s.openGates(fedFirst.agent_id)).toEqual([moveGateOperation(fedMove.id)])
})

test("the request and the first feed intent, both waiting on the agent's ordering lock in concurrent transactions, end in ONE coherent order: what the request froze is exactly what the feed did", async () => {
  const s = await stage()
  await s.fleet()
  const t = await s.topic()
  const { execution } = await s.attempt(t, "h1")
  const holder = s.as("hub_runner")
  const feeder = s.as("hub_runner")
  const requester = s.as("hub_runner")
  const [feederPid, requesterPid] = [await pidOf(feeder), await pidOf(requester)]
  let release!: () => void
  let entered!: () => void
  const released = new Promise<void>(resolve => { release = resolve })
  const inside = new Promise<void>(resolve => { entered = resolve })
  // One transaction holds the ordering lock, and both contenders queue behind it, read from the server.
  const hold = holder.sql.begin(async (tx: any) => { await tx`select hub_gate_order(${t.agent_id}::text)`; entered(); await released })
  await Promise.race([inside, hold])
  const feeding = markFeedIntent(feeder, execution, "body of h1").then(() => "fed" as const, (error: unknown) => error)
  await blockedOnLock(s.su, feederPid)
  const requesting = requestMove(requester, { operation: "op-race", topic: t.id, destRunner: DST.runner, destMachine: DST.machine, by: OWNER }).then(answer => answer, (error: unknown) => error)
  await blockedOnLock(s.su, requesterPid)
  release()
  await hold
  const [feedOutcome, requested] = await Promise.all([feeding, requesting]) as [unknown, { answer: string; move: { id: string; drain_attempts: { state: string }[] } }]
  expect(requested.answer).toBe("requested")
  const froze = requested.move.drain_attempts[0].state
  if (feedOutcome === "fed") {
    // The feed won: the request found a fed attempt and lets it finish.
    expect(froze).toBe("feed_intent")
    expect(await s.count("conversation_entry where kind = 'input'")).toBe(1)
  } else {
    // The request won: the feed was refused as proven unfed and nothing of it was committed.
    expect(feedOutcome).toBeInstanceOf(MoveGated)
    expect(froze).toBe("claimed")
    expect(await s.count("conversation_entry")).toBe(0)
    expect((await s.su`select state from execution where id = ${execution.id}`)[0].state).toBe("claimed")
  }
  expect(await s.openGates(t.agent_id)).toEqual([moveGateOperation(requested.move.id)])
})

test("a held conversation is admitted, not a fresh failure; only a NEWLY interrupted drain failure needs the owner, `continue` is bound to that failure and revision and recovers nothing, and the same hold never loops back while a distinct later failure still blocks", async () => {
  const s = await stage()
  await s.fleet()

  // PREEXISTING: a hold from before the request. Admitted and counted; every later write to that hold is not a failure of the move.
  const t = await s.topic()
  const pre = await s.fed(t, "h-pre")
  await endAttempt(s.tool, { execution: pre.execution.id, evidence: GONE, cause: "test" })
  expect(rows(await openHoldsOf(s.tool, t.conversation_id))).toMatchObject([{ cause: "interrupted", state: "held", revision: 1 }])
  const admitted = await s.request(t)
  expect(admitted.source_facts).toMatchObject({ holds: 1 })
  expect(admitted.preexisting_holds).toMatchObject([{ inbound: "h-pre", execution: pre.execution.id, revision: 1 }])
  expect(admitted.stage).toBe("waiting")
  await s.door.sql`select hub_hold_choice(${pre.execution.id}, ${t.agent_id}, 1, 'keep_held', 'owner', ${{}}::jsonb, ${null}) as answer`
  expect(await s.count("replay_hold where state = 'keep_held'")).toBe(1)
  expect((await s.reread(admitted)).stage, "the owner's own choice about an old hold is not a new failure").toBe("waiting")
  expect(await checkMoveFailure(s.tool, admitted.id)).toBe("waiting")

  // A NEW failure: the attempt the drain was waiting on ends unresolved, in the transaction that writes its hold.
  const u = await s.topic()
  const live = await s.fed(u, "h-live")
  const move = await s.request(u)
  await endAttempt(s.tool, { execution: live.execution.id, evidence: NOT_GONE, cause: "the child was lost" })
  const failing = await s.reread(move)
  expect(failing.stage).toBe("awaiting_owner")
  expect(failing.block).toBeNull()
  expect(failing.failure).toMatchObject({ execution: live.execution.id, revision: 1, cause: "ownership-unknown", inbound: "h-live" })
  expect(await s.openGates(u.agent_id), "the gate stays; nothing falls back to the source").toEqual([moveGateOperation(move.id)])
  // Ownership is not resolved while the attempt is `unknown`, so the owner's continue waits for that evidence.
  expect(await continueMove(s.tool, move.id, OWNER, { execution: live.execution.id, revision: 1 })).toBe("ownership-unresolved")
  // The existing machinery resolves it: the hold moves to a new revision, and the move shows that one.
  await endAttempt(s.tool, { execution: live.execution.id, evidence: GONE, cause: "the process tree was looked up again and is gone" })
  expect((await s.reread(move)).failure).toMatchObject({ execution: live.execution.id, revision: 2, cause: "interrupted" })
  expect(await continueMove(s.tool, move.id, OWNER, { execution: live.execution.id, revision: 1 }), "a choice against the older revision is void").toBe("stale")
  expect(await continueMove(s.tool, move.id, OWNER, { execution: "some-other-attempt", revision: 2 })).toBe("stale")
  expect(await continueMove(s.tool, move.id, OWNER, { execution: live.execution.id, revision: 2 })).toBe("waiting")
  const after = await s.reread(move)
  expect(after).toMatchObject({ stage: "waiting", failure: null })
  expect(after.acknowledged_failures).toMatchObject([{ execution: live.execution.id, revision: 2, by: OWNER }])
  // It acknowledged that failure and nothing else: no /recover choice, no release, nothing authorized to be fed, the row still the owner's.
  expect(rows(await s.su`select state, choice, chosen_by, revision, cause from replay_hold where execution_id = ${live.execution.id}`))
    .toMatchObject([{ state: "held", choice: null, chosen_by: null, revision: 2, cause: "interrupted" }])
  expect(rows(await s.su`select claimed_by from inbound where id = 'h-live'`)).toMatchObject([{ claimed_by: null }])
  expect((await s.su`select state from inbound where id = 'h-live'`)[0].state).not.toBe("answered")
  expect(await continueMove(s.tool, move.id, OWNER, { execution: live.execution.id, revision: 2 }), "asked again").toBe("replay")
  // The same unchanged hold does not bring it back to the owner, however it is written to afterwards.
  await s.door.sql`select hub_hold_choice(${live.execution.id}, ${u.agent_id}, 2, 'keep_held', 'owner', ${{}}::jsonb, ${null}) as answer`
  expect((await s.reread(move)).stage).toBe("waiting")
  expect(await checkMoveFailure(s.tool, move.id)).toBe("waiting")

  // A DISTINCT later failure still blocks. (The gate refuses a second real attempt, so the row is planted as the store would hold it.)
  await s.su`insert into inbound (id, person, agent, body, kind) values ('h-late', 'p1', ${u.agent_id}, 'late', 'human')`
  await s.su`insert into execution (id, inbound_id, conversation_id, agent, runner, incarnation, placement_generation, state, input_digest)
    values ('late-exec', 'h-late', ${u.conversation_id}, ${u.agent_id}, ${SRC.runner}, 'src-1', 1, 'interrupted', 'd')`
  await s.su`insert into replay_hold (inbound_id, execution_id, conversation_id, cause) values ('h-late', 'late-exec', ${u.conversation_id}, 'interrupted')`
  expect((await s.reread(move)).stage).toBe("awaiting_owner")
  expect((await s.reread(move)).failure).toMatchObject({ execution: "late-exec", revision: 1 })
  expect(await continueMove(s.tool, move.id, OWNER, { execution: "late-exec", revision: 1 })).toBe("waiting")
  expect(await s.openGates(u.agent_id)).toEqual([moveGateOperation(move.id)])
})

test("a worker's council event arriving while the master is exported neither invalidates the master's checkpoint nor is copied into it: it queues under the gate for the destination", async () => {
  const s = await stage()
  await s.fleet()
  const t = await s.topic()
  const done = await s.fed(t, "h1")
  await markProgress(s.tool, done.execution.id, "received")
  await completeExecution(s.tool, { execution: done.execution.id, runner: SRC.runner, reply: "done", fence: { incarnation: "src-1" } })
  const move = await s.request(t)
  await s.drain(move)
  const before = (await checkpointOf(s.tool, t.conversation_id))!
  expect(before).toMatchObject({ entry_seq: 2, native_state: "new", placement_generation: 1 })
  expect(before.last_completed).toBe(done.execution.id)

  // Independent worker output for THIS master arrives during the export: an inbound row and a council event, never an entry of the master's conversation.
  await s.su`insert into council (id, person, agent, origin_kind, origin, return_route, operation_id, question, lifecycle, checkpoint_deadline, status_effect_key)
    values ('c-1', 'p1', ${t.agent_id}, 'owner_request', '{}'::jsonb, ${{ agent: t.agent_id, door: "door-d", chat: "1" }}::jsonb, 'op-c-1', 'which?', 'waiting_master',
            now() + interval '1 hour', 'council-status:c-1')`
  await s.tool.sql`select hub_council_event_put(${"ev-1"}, ${"c-1"}, 1, ${"round_complete"}, ${"dedupe-1"}, ${t.agent_id}, ${"p1"}, ${"the round is ready"},
    ${{ door: "door-d", chat: "chat-x" }}::jsonb, ${{}}::jsonb)`
  expect(await s.count("council_event")).toBe(1)
  expect(await s.count("inbound where agent = $1 and kind = 'report'", t.agent_id)).toBe(1)
  expect(await checkpointOf(s.tool, t.conversation_id), "no council event or inbound high-water mark is part of the master's consumed state").toEqual(before)

  // The release at the earlier checkpoint is not refused, and the seal carries the master's two entries and only the exported files.
  const manifest = await s.release(move)
  const sealed = await s.reread(move)
  expect(sealed.stage).toBe("source_released")
  expect(sealed.snapshot).toMatchObject({ entry_seq: 2, last_completed: done.execution.id })
  expect(sealed.manifest!.files.map(file => `${file.kind}/${file.path}`).sort()).toEqual(manifest.files.map(file => `${file.kind}/${file.path}`).sort())
  // The event keeps its own queue identity, unconsumed, and cannot be claimed while the gate stands.
  expect(rows(await s.su`select consumed_at, consumed_attempt from council_event where council_id = 'c-1'`)).toMatchObject([{ consumed_at: null, consumed_attempt: null }])
  expect(await claimNext(s.tool, { runner: SRC.runner, agent: t.agent_id, leaseMs: 60_000, resumeOk: true })).toBeNull()
})

test("every step names the identity it was frozen against: a replaced incarnation, another placement, another native session, another manifest or another generation is refused, and the gate and stage stay", async () => {
  const s = await stage()
  await s.fleet()
  const t = await s.topic()
  const move = await s.request(t)
  const gate = [moveGateOperation(move.id)]
  const stays = async (stageName: MoveStage) => { expect((await s.reread(move)).stage).toBe(stageName); expect(await s.openGates(t.agent_id)).toEqual(gate) }

  // The preflight is the destination's, as its current incarnation.
  expect(await destReady(s.tool, move.id, s.dst("dst-old"), FACTS)).toBe("not-destination")
  expect(await destReady(s.tool, move.id, s.src(), FACTS), "the source is not the destination").toBe("not-destination")
  expect(await destReady(s.tool, move.id, s.dst(), { profile: {} } as never)).toBe("facts-invalid")
  await s.drain(move)

  // THE EXPORT. Blobs are the source's own and verified by the store.
  const generation = exportGenerationOf(await s.reread(move))!
  expect(generation).toBe(1)
  for (const file of FILES) expect(await putBlob(s.tool, move.id, s.src(), generation, { ...file, mode: file.mode ?? 0o600 })).toBe("stored")
  expect(await putBlob(s.tool, move.id, s.src(), generation, { ...FILES[0], mode: 0o600 })).toBe("replay")
  expect(await putBlob(s.tool, move.id, s.src(), generation, { ...FILES[0], mode: 0o600, bytes: Buffer.from("different") })).toBe("blob-conflict")
  expect(await putBlob(s.tool, move.id, s.src(), generation, { ...FILES[0], mode: 0o644 }), "the same bytes with another mode is not the same file").toBe("blob-conflict")
  expect(await putBlob(s.tool, move.id, s.dst(), generation, { ...FILES[0], mode: 0o600 })).toBe("not-source")
  expect(await putBlob(s.tool, move.id, s.src(), generation + 1, { ...FILES[0], mode: 0o600 }), "an export generation that is not the drain's").toBe("stale-export")
  const checkpoint = (await checkpointOf(s.tool, t.conversation_id))!
  const manifest = manifestOf(FILES)
  const release = (by: { runner: string; incarnation: string }, cp: unknown, mf: unknown, gen: number = generation) => releaseSource(s.tool, move.id, by, gen, cp as never, mf as never)
  expect(await release(s.src(), checkpoint, manifest, generation + 1), "a seal of another export generation").toBe("stale-export")
  expect(await release(s.dst(), checkpoint, manifest)).toBe("not-source")
  expect(await release(s.src("src-0"), checkpoint, manifest)).toBe("not-source")
  expect(await release(s.src(), { ...checkpoint, native_session: "another-session" }, manifest)).toBe("checkpoint-mismatch")
  expect(await release(s.src(), { ...checkpoint, entry_seq: 5 }, manifest)).toBe("checkpoint-mismatch")
  expect(await release(s.src(), { ...checkpoint, placement_generation: 2 }, manifest)).toBe("checkpoint-mismatch")
  expect(await release(s.src(), { ...checkpoint, conversation: "another-conversation" }, manifest)).toBe("checkpoint-mismatch")
  expect(await release(s.src(), checkpoint, { ...manifest, digest: "not-a-digest" })).toBe("manifest-invalid")
  expect(await release(s.src(), checkpoint, { ...manifest, files: manifest.files.slice(1) })).toBe("manifest-mismatch")
  expect(await release(s.src(), checkpoint, { ...manifest, files: [{ ...manifest.files[0], sha256: sha("forged") }, manifest.files[1]] })).toBe("manifest-mismatch")
  expect(await release(s.src(), checkpoint, { ...manifest, bytes: manifest.bytes + 1 })).toBe("manifest-mismatch")
  await stays("waiting")
  // A conversation the engine has seen needs the adapter's native and portability assertion; a scripted one is this test's own, never production proof.
  await s.su`update conversation set native_state = 'started' where id = ${t.conversation_id}`
  const started = (await checkpointOf(s.tool, t.conversation_id))!
  expect(await release(s.src(), checkpoint, manifest), "the snapshot's native state moved").toBe("checkpoint-mismatch")
  expect(await release(s.src(), started, manifest)).toBe("native-evidence-missing")
  expect(await release(s.src(), started, { ...manifest, ...scriptedNative("another-session") })).toBe("native-evidence-missing")
  const blank = scriptedNative(started.native_session)
  expect(await release(s.src(), started, { ...manifest, native: blank.native, portability: { ...blank.portability, adapter: "" } })).toBe("native-evidence-missing")
  await stays("waiting")
  const native = scriptedNative(started.native_session)
  expect(await release(s.src(), started, { ...manifest, ...native })).toBe("released")
  const sealed = await s.reread(move)
  expect(sealed.stage).toBe("source_released")
  expect(sealed.snapshot).toMatchObject({ native_session: started.native_session, native_state: "started", entry_seq: 0, placement_generation: 1 })
  expect(await release(s.src(), started, { ...manifest, ...native }), "the same seal again").toBe("replay")

  // THE IMPORT. The destination's own generation and staging identity first, then each step bound to them.
  expect(await beginImport(s.tool, move.id, s.src())).toMatchObject({ answer: "not-destination" })
  expect(await beginImport(s.tool, move.id, s.dst("dst-0"))).toMatchObject({ answer: "not-destination" })
  const begun = await beginImport(s.tool, move.id, s.dst())
  expect(begun).toEqual({ answer: "intent", generation: 1, staging: `move-${move.id}-g1` })
  const read = { manifest_digest: sealed.manifest!.digest, generation: 1, staging: begun.staging, files: 2, bytes: sealed.manifest!.bytes, native: sealed.manifest!.native }
  const verify = (over: Record<string, unknown>) => advanceImport(s.tool, move.id, s.dst(), 1, "verified", { ...read, ...over })
  expect(await verify({ manifest_digest: sha("other") })).toBe("verification-mismatch")
  expect(await verify({ staging: "move-elsewhere-g1" })).toBe("verification-mismatch")
  expect(await verify({ generation: 2 })).toBe("verification-mismatch")
  expect(await verify({ native: { ...read.native, native_session: "another-session" } })).toBe("verification-mismatch")
  expect(await verify({ native: undefined }), "a started conversation is not imported without its native identity").toBe("verification-mismatch")
  expect(await advanceImport(s.tool, move.id, s.dst("dst-0"), 1, "verified", read)).toBe("not-destination")
  expect(await advanceImport(s.tool, move.id, s.dst(), 2, "verified", read)).toBe("stale-generation")
  expect(await advanceImport(s.tool, move.id, s.dst(), 1, "promoted")).toBe("bad-transition")
  const verification = s.verificationOf(sealed, { generation: 1, staging: begun.staging! }, { started: true })
  expect(await activateMove(s.tool, move.id, s.dst(), 1, verification), "nothing was promoted yet").toBe("import-incomplete")
  expect(await verify({})).toBe("verified")
  expect(await advanceImport(s.tool, move.id, s.dst(), 1, "promote_intent")).toBe("promote_intent")
  expect(await advanceImport(s.tool, move.id, s.dst(), 1, "promoted")).toBe("promoted")

  // ACTIVATION: the destination's own verification, and the source exactly as sealed.
  expect(await activateMove(s.tool, move.id, s.dst("dst-0"), 1, verification)).toBe("not-destination")
  expect(await activateMove(s.tool, move.id, s.dst(), 2, verification)).toBe("stale-generation")
  expect(await activateMove(s.tool, move.id, s.dst(), 1, { ...verification, manifest_digest: sha("other") })).toBe("verification-mismatch")
  expect(await activateMove(s.tool, move.id, s.dst(), 1, { ...verification, native: undefined })).toBe("verification-mismatch")
  expect(await activateMove(s.tool, move.id, s.dst(), 1, { ...verification, dest_machine: "pi" })).toBe("verification-mismatch")
  await s.su`update conversation set placement_generation = 2 where id = ${t.conversation_id}`
  expect(await activateMove(s.tool, move.id, s.dst(), 1, verification), "the placement moved under it").toBe("snapshot-changed")
  await s.su`update conversation set placement_generation = 1 where id = ${t.conversation_id}`
  await s.su`insert into conversation_entry (conversation_id, seq, source_id, kind, body) values (${t.conversation_id}, 1, 'late-input', 'input', 'newer master consumption')`
  expect(await activateMove(s.tool, move.id, s.dst(), 1, verification), "the master consumed something after the checkpoint").toBe("snapshot-changed")
  await s.su`delete from conversation_entry where source_id = 'late-input'`
  await stays("importing")
  expect(await activateMove(s.tool, move.id, s.dst(), 1, verification)).toBe("activated")
  const placed = await s.reread(move)
  expect(placed).toMatchObject({ stage: "activated", dest_generation: 2 })
  expect(rows(await s.su`select machine, placement_generation from conversation where id = ${t.conversation_id}`)).toMatchObject([{ machine: "mac", placement_generation: 2 }])
  expect(rows(await s.su`select machine, runner from topic where id = ${t.id}`)).toMatchObject([{ machine: "mac", runner: "runner-mac" }])
  expect(await activateMove(s.tool, move.id, s.dst(), 1, verification), "the same activation again").toBe("replay")
  expect(await s.openGates(t.agent_id), "activation releases nothing: only serve does").toEqual(gate)
})

test("the source's restart is not proof its predecessor's child is gone: a persisted intent and evidence bound to the REGISTERED boot are, a bare confirmation, a missing or wrong intent, another identity or another boot are refused, the new incarnation answers for its own lifetime only, and the export needs THIS incarnation's completed drain", async () => {
  const s = await stage()
  await s.fleet()
  const t = await s.topic()
  const live = await s.fed(t, "h-live")
  const move = await s.request(t)
  expect(move.source_incarnation).toMatchObject({ known: true, incarnation: "src-1", boot_id: BOOT_1 })
  expect(await destReady(s.tool, move.id, s.dst(), FACTS)).toBe("ready")
  const native = await s.nativeOf(move)
  const intent = { id: "i1", boot_id: BOOT_1, machine: "pi", leader: 100, group: 100, pids: [100, 101] }

  // The intent is durable BEFORE anything is closed, by the source's current incarnation, about the source's machine and its REGISTERED boot.
  expect(await recordDrainIntent(s.tool, move.id, s.src(), intent)).toBe("intent")
  expect(await recordDrainIntent(s.tool, move.id, s.src(), intent)).toBe("replay")
  expect(await recordDrainIntent(s.tool, move.id, s.dst(), { ...intent, id: "i-x" })).toBe("not-source")
  expect(await recordDrainIntent(s.tool, move.id, s.src(), { ...intent, id: "i-y", machine: "mac" })).toBe("intent-invalid")
  expect(await recordDrainIntent(s.tool, move.id, s.src(), { ...intent, id: "i-z", boot_id: "" })).toBe("intent-invalid")
  expect(await recordDrainIntent(s.tool, move.id, s.src(), { ...intent, id: "i-w", boot_id: BOOT_2 }), "a boot the registration does not hold").toBe("boot-mismatch")
  expect(await recordDrainIntent(s.tool, move.id, s.src(), { ...intent, leader: 101 }), "the same id with other content is not a replay").toBe("intent-invalid")
  expect((await s.reread(move)).drain_intents.map(one => one.id)).toEqual(["i1"])
  const done = (over: Record<string, unknown> = {}, by = s.src(), exit?: Parameters<typeof drainEvidence>[5]) =>
    recordDrainDone(s.tool, move.id, by, drainEvidence(move, native, { incarnation: by.incarnation, boot: BOOT_1 }, intent, over, exit))

  // The attempt the drain waits on is still owned, so nothing is gone yet.
  expect(await done()).toBe("busy")
  await markProgress(s.tool, live.execution.id, "received")
  await completeExecution(s.tool, { execution: live.execution.id, runner: SRC.runner, reply: "done", fence: { incarnation: "src-1" } })

  // What is not enough.
  const good = exitGroup(100)
  expect(await done({ intent: "unknown" })).toBe("no-intent")
  expect(await done({ intent: undefined })).toBe("no-intent")
  for (const over of [{ conversation: "other" }, { native_session: "other" }, { placement_generation: 3 }, { machine: "mac" }, { move: "other" }, { incarnation: "src-9" }, { runner: "runner-x" }]) {
    expect(await done(over), JSON.stringify(over)).toBe("drain-identity-mismatch")
  }
  for (const exit of [
    { ...good, confirmed: false }, { ...good, leader: "unknown" }, { ...good, descendants: "unverified" }, { ...good, via: "" }, { ...good, basis: "observed-tree" },
    { ...good, basis: "none" }, { ...good, group: 999 }, { ...good, basis: "boot" }, { confirmed: true }, EXIT_NO_CHILD,
  ]) {
    expect(await done({ exit }), JSON.stringify(exit)).toBe("drain-proof-incomplete")
  }
  expect(await done({ boot_id: "" }), "a boot the caller names is not an anchor").toBe("boot-mismatch")
  expect(await done({ boot_id: BOOT_2 }), "another boot than the registered one").toBe("boot-mismatch")
  expect((await s.reread(move)).drain).toBeNull()
  expect(await done()).toBe("drained")
  expect(await done()).toBe("replay")
  const first = await s.reread(move)
  expect(first.drain).toMatchObject({ incarnation: "src-1", boot_id: BOOT_1, export_generation: 1 })
  expect(first.drain_resolutions).toMatchObject([{ kind: "intent", id: "i1", basis: "process-group", boot_id: BOOT_1, by: "src-1" }])
  expect(first.export_generation).toBe(1)

  // THE SOURCE RESTARTS (the same boot): a new incarnation of the same runner. It finds no child in memory, and that proves nothing about its predecessor.
  await s.register(SRC, "src-2")
  const generation = exportGenerationOf(first)!
  for (const file of FILES) {
    expect(await putBlob(s.tool, move.id, s.src(), generation, { ...file, mode: 0o600 }), "the old incarnation is fenced out").toBe("not-source")
    expect(await putBlob(s.tool, move.id, s.src("src-2"), generation, { ...file, mode: 0o600 }), "the new one has no evidence of its own").toBe("drain-stale")
  }
  const checkpoint = (await checkpointOf(s.tool, t.conversation_id))!
  expect(await releaseSource(s.tool, move.id, s.src("src-2"), generation, checkpoint, manifestOf([]))).toBe("drain-stale")
  expect(await done({ exit: { confirmed: true } }, s.src("src-2")), "a new incarnation saying `confirmed` alone").toBe("drain-proof-incomplete")
  expect(await done({}, s.src("src-2"), EXIT_BOOT), "the same boot is not a reboot").toBe("drain-proof-incomplete")
  expect(await done({}, s.src("src-2"), { ...EXIT_NO_CHILD, spawn_closed: false } as never), "a no-child claim that has not closed its spawns").toBe("drain-proof-incomplete")
  // Its predecessor's intent was resolved (by the predecessor, in its own life) and stays resolved; what the new incarnation owes is ITS OWN lifetime.
  const own = (extra: Record<string, unknown> = {}) => recordDrainDone(s.tool, move.id, s.src("src-2"),
    drainEvidence(move, native, { incarnation: "src-2", boot: BOOT_1 }, null, extra, EXIT_NO_CHILD))
  expect(await own({ owner: "src-1" }), "its claim is about itself, never a predecessor").toBe("drain-proof-incomplete")
  expect(await own()).toBe("drained")
  const second = await s.reread(move)
  expect(second.drain).toMatchObject({ incarnation: "src-2", export_generation: 2 })
  expect(second.drain_resolutions.map(one => `${one.kind}:${one.id}:${one.basis}`)).toEqual(["intent:i1:process-group", "owner:src-2:no-child"])
  expect(await own(), "the same claim again").toBe("replay")
  expect(await putBlob(s.tool, move.id, s.src("src-2"), generation, { ...FILES[0], mode: 0o600 }), "the first export's generation is over").toBe("stale-export")
  expect(await putBlob(s.tool, move.id, s.src("src-2"), 2, { ...FILES[0], mode: 0o600 })).toBe("stored")

  // A source that restarts with ANOTHER child records a new intent: the drain is stale, the unsealed blobs of that export are gone, what the others proved stays.
  expect(await recordDrainIntent(s.tool, move.id, s.src("src-2"), { id: "i2", boot_id: BOOT_1, machine: "pi", group: 7 })).toBe("intent")
  const third = await s.reread(move)
  expect(third.drain).toBeNull()
  expect(third.drain_resolutions).toHaveLength(2)
  expect(await s.count("move_blob where move_id = $1", move.id)).toBe(0)
  expect(await putBlob(s.tool, move.id, s.src("src-2"), 2, { ...FILES[1], mode: 0o600 })).toBe("drain-stale")
  // Its own intent has to be resolved now (the no-child claim it made before recording one no longer covers it).
  expect(await own(), "it has recorded an intent: that is what it must resolve").toBe("drain-proof-incomplete")
  expect(await recordDrainDone(s.tool, move.id, s.src("src-2"), drainEvidence(move, native, { incarnation: "src-2", boot: BOOT_1 }, { id: "i2", boot_id: BOOT_1, machine: "pi", group: 7 }))).toBe("drained")
  expect((await s.reread(move)).export_generation).toBe(3)
  expect((await s.reread(move)).stage).toBe("waiting")
  expect(await s.openGates(t.agent_id)).toEqual([moveGateOperation(move.id)])
})

test("a block is a note on the stage and keeps the gate: dependency_unverified stops the export and nothing acknowledges it away, each side clears its own, and no role but the intended one can call a step or write a move table", async () => {
  const s = await stage()
  await s.fleet()
  const t = await s.topic()
  const move = await s.request(t)
  await s.drain(move)
  const generation = exportGenerationOf(await s.reread(move))!
  for (const file of FILES) await putBlob(s.tool, move.id, s.src(), generation, { ...file, mode: 0o600 })
  const checkpoint = (await checkpointOf(s.tool, t.conversation_id))!

  expect(await blockMove(s.tool, move.id, s.dst(), "dependency_unverified", { bash: 2, mcp: 1 })).toBe("blocked")
  expect(await blockMove(s.tool, move.id, s.dst(), "dependency_unverified", { bash: 2, mcp: 1 })).toBe("replay")
  expect((await s.reread(move)).block).toMatchObject({ code: "dependency_unverified", by: "dest", detail: { bash: 2, mcp: 1 } })
  expect(await releaseSource(s.tool, move.id, s.src(), generation, checkpoint, manifestOf(FILES))).toBe("blocked")
  expect((await s.reread(move)).stage).toBe("waiting")
  expect(await s.openGates(t.agent_id), "a block never releases the gate").toEqual([moveGateOperation(move.id)])
  expect(await unblockMove(s.tool, move.id, s.src(), "dependency_unverified"), "the other side cannot clear it").toBe("not-yours")
  // ANOTHER PARTY'S BLOCK IS NEVER REPLACED, by the source, by the hub or by the store's own notes: the reason stays as it was set.
  expect(await blockMove(s.tool, move.id, s.src(), "source_says_otherwise", { why: "test" })).toBe("occupied")
  expect(await blockMove(s.hub, move.id, null, "registry_conflict", { why: "test" })).toBe("occupied")
  expect((await s.reread(move)).block).toMatchObject({ code: "dependency_unverified", by: "dest", detail: { bash: 2, mcp: 1 } })
  // The owner's answer to a drain FAILURE is another thing: it is bound to an attempt and its revision, and it clears nothing here.
  expect(await continueMove(s.tool, move.id, OWNER, { execution: "x", revision: 1 })).toBe("stage")
  expect((await s.reread(move)).block).toMatchObject({ code: "dependency_unverified", by: "dest" })
  expect(await blockMove(s.tool, move.id, null, "anything", {}), "a runner is not the hub").toBe("not-party")
  expect(await blockMove(s.tool, move.id, s.dst("dst-0"), "anything", {})).toBe("not-party")
  expect(await blockMove(s.tool, move.id, s.dst(), "Not A Code", {})).toBe("block-invalid")
  // Only the side that set it clears it (then the hub's own note can be written, and cleared by the hub alone).
  expect(await unblockMove(s.tool, move.id, s.dst(), "dependency_unverified")).toBe("cleared")
  expect(await blockMove(s.hub, move.id, null, "registry_conflict", { why: "test" })).toBe("blocked")
  expect(await unblockMove(s.tool, move.id, s.dst(), "registry_conflict")).toBe("not-yours")
  expect(await unblockMove(s.hub, move.id, null, "registry_conflict")).toBe("cleared")
  expect(await unblockMove(s.hub, move.id, null, "registry_conflict")).toBe("none")
  // There is no acknowledgement that turns an unverified dependency into a verified one: no routine and no column for it. (`topic_move.acknowledged_failures` is
  // something else, and stays: the owner's revision-bound answer to a drain failure, which the movement `continue` writes and nothing else reads as a waiver.)
  expect(await s.count("pg_proc where proname like '%ack_unverified%' or proname like '%owner_ack%' or proname ~ '^hub_move_.*(unverified|waive|bypass|override)'")).toBe(0)
  expect(await s.count("information_schema.columns where table_name in ('topic_move', 'move_copy', 'move_blob') and column_name ~ '(^|_)ack(_|$)|unverified|waive|bypass'")).toBe(0)
  expect(await s.count("information_schema.columns where table_name = 'topic_move' and column_name = 'acknowledged_failures'")).toBe(1)

  // Who may call what, read off the roles the processes use.
  const args = "'x', 'r', 'i', 1, '{}'::jsonb, '{}'::jsonb"
  await expect(attempt(s.door.sql.unsafe(`select hub_move_source_release(${args})`))).rejects.toThrow(/permission denied/)
  await expect(attempt(s.hub.sql.unsafe(`select hub_move_source_release(${args})`))).rejects.toThrow(/permission denied/)
  await expect(attempt(s.tool.sql.unsafe(`select hub_move_registry_written('x', '{}'::jsonb)`))).rejects.toThrow(/permission denied/)
  await expect(attempt(s.door.sql.unsafe(`select hub_move_registry_written('x', '{}'::jsonb)`))).rejects.toThrow(/permission denied/)
  await expect(attempt(s.as("hub_agent").sql.unsafe(`select hub_move_request('m', 'o', 't', 'r', 'x', 'by', null, null)`))).rejects.toThrow(/permission denied/)
  await expect(attempt(s.tool.sql.unsafe(`update topic_move set stage = 'withdrawn'`))).rejects.toThrow(/permission denied/)
  await expect(attempt(s.tool.sql.unsafe(`delete from move_blob`))).rejects.toThrow(/permission denied/)
  await expect(attempt(s.tool.sql.unsafe(`insert into move_copy (move_id, machine, kind, generation, state, staging_id, runner, incarnation) values ('x', 'y', 'dest_import', 1, 'active', 's', 'r', 'i')`))).rejects.toThrow(/permission denied/)
  await expect(attempt(s.door.sql.unsafe(`select bytes from move_blob`))).rejects.toThrow(/permission denied/)
  // The frozen and the sealed stay: even the owner of the tables' own writes cannot rewrite what a move keeps for good.
  await expect(attempt(s.su`update topic_move set dest_machine = 'pi' where id = ${move.id}`)).rejects.toThrow(/keeps what was frozen/)
  await expect(attempt(s.su`update topic_move set stage = 'active' where id = ${move.id}`)).rejects.toThrow(/cannot go from/)
  // The bounds: a file over the limit is refused before it is sent, and a path cannot climb.
  await expect(putBlob(s.tool, move.id, s.src(), generation, { kind: "native", path: "big", mode: 0o600, bytes: new Uint8Array(MOVE_MAX_FILE_BYTES + 1) })).rejects.toBeInstanceOf(RangeError)
  await expect(putBlob(s.tool, move.id, s.src(), generation, { kind: "native", path: "../escape", mode: 0o600, bytes: Buffer.from("x") })).rejects.toThrow(/check constraint/)
  await expect(putBlob(s.tool, move.id, s.src(), generation, { kind: "native", path: "/absolute", mode: 0o600, bytes: Buffer.from("x") })).rejects.toThrow(/check constraint/)
  // An archive that is not this move's does not change the move's gate.
  expect(await requestTransition(s.tool, { operation: "arch-1", topic: t.id, kind: "archive", source: "tool", by: OWNER, route: null, evidence: {} })).toBe("ok")
  expect(await s.openGates(t.agent_id)).toEqual(["arch-1", moveGateOperation(move.id)].sort())
  expect((await gatesOn(s.tool, { kind: "agent", id: t.agent_id })).map(gate => gate.cause).sort()).toEqual(["archive", "move"])
})
