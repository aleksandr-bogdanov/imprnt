// Durable conversations, one owned attempt per agent, and holds.
//
// Everything here is asserted against Postgres on role connections, because the
// rules are the store's: a second runner, or one written before this step, opens
// its own connection and meets the same tables, functions and triggers. Nothing
// starts a loop. What the runner does with these rules is bound in
// `runner-conversations.test.ts`.

import { afterAll, afterEach, beforeAll, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { startCluster, freshDatabase, hubPath, type Cluster } from "./helpers/cluster.ts"
import { rolloutDatabase } from "./helpers/rollout-fixtures.ts"
import { jobSource } from "./helpers/conversations.ts"
import type { StoreLike } from "../src/store/connect.ts"
import type { ExitEvidence } from "../src/adapters/types.ts"
import { MIGRATION_FILES, migrate } from "../src/store/migrate.ts"
import { claimNext } from "../src/runner/claim.ts"
import { readEligible } from "../src/store/wake.ts"
import { admitJob } from "../src/runner/job.ts"
import { endAttempt, evidenceFromRecord, markedWatch, reevaluateUnknown, requireSchema, settleStored } from "../src/runner/execution.ts"
import { chooseHold } from "../src/recovery/holds.ts"
import { settleTurn } from "../src/runner/settle.ts"
import { alive, bootIdentityFrom, bootMoved, groupOf, groupPresence, presence, readBootIdentity, type BootSources } from "../src/os/tree.ts"
import {
  ConversationRefused, ExecutionBusy, ExecutionNotOwned, RUNNER_PROTOCOL, activateProtocol, completeTail, conversationFor, journalResult, markFeedIntent,
  notePids, openExecution, openHoldsOf, openTailExecution, readExecution, registerIncarnation,
} from "../src/store/conversations.ts"

let cluster: Cluster
beforeAll(async () => { cluster = await startCluster() })
afterAll(async () => { await cluster?.stop() })

// The cluster allows forty connections and every test opens several of its own (a role's connection is one
// backend), so each test hands its connections back when it is done instead of leaving them to the end.
const mine: { close(): Promise<void> }[] = []
const track = <T extends { close(): Promise<void> }>(sql: T): T => { mine.push(sql); return sql }
afterEach(async () => { for (const one of mine.splice(0)) await one.close().catch(() => {}) })
/** A database from the shipped schema (or the legacy one), whose connections are handed back with the test's. */
async function rollout(legacy = false) {
  const db = await rolloutDatabase(cluster, legacy)
  return { ...db, sql: track(db.sql), store: (role?: string) => { const opened = db.store(role); track(opened.sql); return opened } }
}

/** Two different boots of one machine, in the tagged form the runner records. */
const BOOT_1 = "linux:6f1c2a3e-1111-4222-8333-444455556666"
const BOOT_2 = "linux:6f1c2a3e-9999-4222-8333-444455556666"

const NOT_GONE: ExitEvidence = { confirmed: false, leader: "unknown", descendants: "unverified", pids: [], survivors: [], via: "test" }
const GONE: ExitEvidence = { confirmed: true, leader: "exited", descendants: "none", pids: [], survivors: [], via: "test" }
const TURN = { agent: "p1-lair", runner: "runner-a", preset: "daily", preset_id: "x", preset_settings: {}, input_tokens: 1, cached_input_tokens: 0,
  output_tokens: 1, price: null, plan_usage: null, raw_usage: {}, session_id: null, lacks: [], tail: false }

async function stage() {
  const db = await freshDatabase(cluster)
  const as = (role: string) => ({ sql: track(cluster.connectAs(role, db)), url: cluster.url(db) }) as StoreLike
  const su = track(cluster.connect(db))
  const human = async (id: string, agent = "p1-lair", over: Record<string, unknown> = {}) => {
    await su`insert into inbound (id, person, agent, body, kind, source) values (${id}, 'p1', ${agent}, ${`body of ${id}`}, 'human',
      ${{ log_id: id, at: new Date().toISOString(), door: "door-fake", chat: "1000000001", sender_id: "p1", text: `body of ${id}`, ...over }}::jsonb)`
  }
  const job = async (id: string, agent = "p1-worker", conversation?: string) => {
    const source = jobSource(id, { target: agent, task: `task ${id}`, ...(conversation ? { conversation } : {}) })
    await su`insert into inbound (id, person, agent, body, kind, source) values (${id}, 'p1', ${agent}, ${`task ${id}`}, 'job', ${source}::jsonb)`
    return source
  }
  const runner = as("hub_runner")
  /** A claim the way a claiming runner leaves it: the row is this runner's. */
  const claim = async (id: string, by: string, deadline = "1 hour") => {
    await su.unsafe(`update inbound set claimed_by = $1, claim_deadline = now() + interval '${deadline}' where id = $2`, [by, id])
  }
  /** This process, registered as the runner's current incarnation. */
  const incarnate = (name: string, incarnation: string) => registerIncarnation(runner, { runner: name, incarnation, machine: "pi", bootId: null })
  const master = (id: string, agent = "p1-lair") =>
    conversationFor(runner, { row: { id, person: "p1", agent, kind: "human" }, adapter: "claude-code", machine: "pi" })
  const worker = (id: string, source: unknown, agent = "p1-worker") =>
    conversationFor(runner, { row: { id, person: "p1", agent, kind: "job", source: source as never }, adapter: "claude-code", machine: "pi" })
  return { db, su, runner, door: as("hub_door"), human, job, claim, incarnate, master, worker }
}

test("a new job gets a conversation of its own, a follow-up is put into the one it names, and nothing else is quietly made a new job", async () => {
  const s = await stage()
  const a = await s.job("job-a")
  const b = await s.job("job-b")
  const first = await s.worker("job-a", a)
  const second = await s.worker("job-b", b)
  // The same configured worker served both, and they share nothing: not the
  // conversation, not the engine session it is launched under.
  expect(second.id).not.toBe(first.id)
  expect(second.native_session).not.toBe(first.native_session)
  expect(first.kind).toBe("worker")
  // Asking again for the same job is the same conversation, not a third.
  expect((await s.worker("job-a", a)).id).toBe(first.id)

  // The explicit follow-up names the conversation and gets it, engine session and all.
  const followSource = await s.job("job-a-again", "p1-worker", first.id)
  const followed = await s.worker("job-a-again", followSource)
  expect(followed.id).toBe(first.id)
  expect(followed.native_session).toBe(first.native_session)

  // A conversation that is not this worker's, this engine's or this machine's is
  // refused by name and never replaced by a new one.
  const master = await s.master("h1")
  expect(master.kind).toBe("master")
  const stranger = await s.job("job-stranger", "p1-worker", master.id)
  await expect(s.worker("job-stranger", stranger)).rejects.toMatchObject({ refusal: "conversation unavailable" })
  await expect(conversationFor(s.runner, { row: { id: "job-a-again", person: "p1", agent: "p1-worker", kind: "job", source: followSource }, adapter: "claude-code", machine: "mac" }))
    .rejects.toBeInstanceOf(ConversationRefused)
  await expect(conversationFor(s.runner, { row: { id: "job-a-again", person: "p1", agent: "p1-worker", kind: "job", source: followSource }, adapter: "another-engine", machine: "pi" }))
    .rejects.toMatchObject({ refusal: "conversation unavailable" })
  // One master per agent is the store's own rule, not the code's.
  await expect(s.su`insert into conversation (id, person, agent, kind, adapter, native_session)
    values ('second-master', 'p1', 'p1-lair', 'master', 'claude-code', ${crypto.randomUUID()})`.execute()).rejects.toThrow()
})

test("an expired lease proves nothing: an attempt that may still be running keeps the agent's slot, and a runner that predates this step is refused by the table", async () => {
  const s = await stage()
  await s.human("h1")
  await s.human("h2")
  await s.incarnate("runner-a", "one")
  await s.incarnate("runner-b", "two")
  // runner-a claimed h1 and then its lease ran out, which is all an old runner
  // would have looked at. The claim is still its own, and that is what opens.
  // A sibling holds a claim of h2 by then as well: both claims are staged BEFORE the
  // first attempt is opened, because once an attempt of the agent exists the table
  // refuses every further claim of it, which is the point of the rest of this test.
  await s.claim("h1", "runner-a", "-1 minute")
  await s.claim("h2", "runner-b")
  const conversation = await s.master("h1")
  const first = await openExecution(s.runner, { row: { id: "h1", agent: "p1-lair" }, conversation, runner: "runner-a", incarnation: "one", digest: "d1", nativeSession: null })
  // A second launch is refused by the row, not by anybody's clock.
  await expect(openExecution(s.runner, { row: { id: "h2", agent: "p1-lair" }, conversation, runner: "runner-b", incarnation: "two", digest: "d2", nativeSession: null }))
    .rejects.toBeInstanceOf(ExecutionBusy)

  // A sibling that does what the old runner did meets no row.
  expect(await claimNext(s.runner, { runner: "runner-b", agent: "p1-lair", leaseMs: 60_000, resumeOk: true })).toBeNull()
  expect(await readEligible(s.runner, { agent: "p1-lair", resumeOk: true })).toEqual([])
  // And a runner that does not ask the question at all, which is what one
  // written before this step is, is refused by the table on its own connection.
  await expect(s.runner.sql`update inbound set claimed_by = 'old-runner', claim_deadline = now() + interval '1 minute' where id = 'h1'`.execute())
    .rejects.toThrow(/not claimable/)
  await expect(s.runner.sql`update inbound set claimed_by = 'old-runner', claim_deadline = now() + interval '1 minute' where id = 'h2'`.execute())
    .rejects.toThrow(/not claimable/)

  // Fed, then ended with nothing shown about the process: still owned by nobody
  // provably, so still the slot.
  await markFeedIntent(s.runner, first, "body of h1")
  const unknown = await endAttempt(s.runner, { execution: first.id, evidence: NOT_GONE, cause: "the runner stopped" })
  expect(unknown.state).toBe("unknown")
  await expect(openExecution(s.runner, { row: { id: "h2", agent: "p1-lair" }, conversation, runner: "runner-b", incarnation: "two", digest: "d2", nativeSession: null }))
    .rejects.toBeInstanceOf(ExecutionBusy)
  expect({ ...(await s.su`select cause, state, revision from replay_hold where inbound_id = 'h1'`)[0] }).toEqual({ cause: "ownership-unknown", state: "held", revision: 1 })

  // Evidence arrives: the attempt is terminal, the input stays held, the
  // revision moved, and the agent may take a FRESH turn only on a validated resume.
  const over = await endAttempt(s.runner, { execution: first.id, evidence: GONE, cause: "the process tree is gone" })
  expect(over.state).toBe("interrupted")
  expect({ ...(await s.su`select cause, state, revision from replay_hold where inbound_id = 'h1'`)[0] }).toEqual({ cause: "interrupted", state: "held", revision: 2 })
  expect(await claimNext(s.runner, { runner: "runner-b", agent: "p1-lair", leaseMs: 60_000 })).toBeNull()
  expect(await claimNext(s.runner, { runner: "runner-b", agent: "p1-lair", leaseMs: 60_000, resumeOk: false })).toBeNull()
  const fresh = await claimNext(s.runner, { runner: "runner-b", agent: "p1-lair", leaseMs: 60_000, resumeOk: true })
  expect(fresh?.id, "a fresh turn is claimable once resume is validated, and the held input never is").toBe("h2")
})

test("the opening is the fence: one attempt per agent even across two jobs, and a lost claim, a stale placement or an obsolete incarnation opens nothing", async () => {
  const s = await stage()
  const sources = { "job-a": await s.job("job-a"), "job-b": await s.job("job-b"), "job-c": await s.job("job-c"), "job-d": await s.job("job-d"), "job-e": await s.job("job-e") }
  const conv = Object.fromEntries(await Promise.all(Object.entries(sources).map(async ([id, source]) => [id, await s.worker(id, source)])))
  await s.incarnate("runner-a", "one")
  for (const id of Object.keys(sources)) await s.claim(id, "runner-a")
  const open = (id: string, over: Record<string, unknown> = {}) => openExecution(s.runner, { row: { id, agent: "p1-worker" }, conversation: conv[id], runner: "runner-a", incarnation: "one", digest: "d", nativeSession: null, ...over })

  // Two different jobs, two different conversations, one configured worker, both
  // past every check: only one insert can stand.
  const raced = await Promise.allSettled([open("job-a"), open("job-b")])
  expect(raced.filter(r => r.status === "fulfilled")).toHaveLength(1)
  const lost = raced.find(r => r.status === "rejected") as PromiseRejectedResult
  expect(lost.reason).toBeInstanceOf(ExecutionBusy)
  expect(Number((await s.su`select count(*)::int as n from execution where agent = 'p1-worker'`)[0].n)).toBe(1)
  const winner = raced.find(r => r.status === "fulfilled") as PromiseFulfilledResult<Awaited<ReturnType<typeof open>>>
  // The slot is the agent's, so a third job is refused while the first is unsettled, and free once it ended without feeding.
  await expect(open("job-c")).rejects.toBeInstanceOf(ExecutionBusy)
  expect((await endAttempt(s.runner, { execution: winner.value.id, evidence: null, cause: "never fed", delivered: false })).state).toBe("failed")

  // An obsolete placement: the conversation moved on after the snapshot was read.
  await s.su`update conversation set placement_generation = 2 where id = ${conv["job-c"].id}`
  await expect(open("job-c")).rejects.toMatchObject({ reason: "generation" })
  // The current generation is not quietly substituted for the stale one.
  expect(Number((await s.su`select count(*)::int as n from execution where inbound_id = 'job-c'`)[0].n)).toBe(0)
  expect((await open("job-c", { conversation: { ...conv["job-c"], placement_generation: 2 } })).placement_generation).toBe(2)
  await endAttempt(s.runner, { execution: (await s.su`select id from execution where inbound_id = 'job-c'`)[0].id, evidence: null, cause: "never fed", delivered: false })

  // A claim that is no longer this runner's opens nothing, and is not touched.
  await s.claim("job-d", "runner-b")
  await expect(open("job-d")).rejects.toMatchObject({ reason: "claim" })
  expect((await s.su`select claimed_by from inbound where id = 'job-d'`)[0].claimed_by).toBe("runner-b")
  // A row that is already answered is no claim at all.
  await s.su`insert into ledger_event (stream, subject, kind, actor) values ('inbound', 'job-e', 'answered', 'runner')`
  await expect(open("job-e")).rejects.toBeInstanceOf(ExecutionNotOwned)

  // An obsolete incarnation: a newer process of the same runner registered.
  await s.claim("job-d", "runner-a")
  await s.incarnate("runner-a", "two")
  await expect(open("job-d")).rejects.toMatchObject({ reason: "incarnation" })
  expect(Number((await s.su`select count(*)::int as n from execution where inbound_id = 'job-d'`)[0].n)).toBe(0)
  expect((await open("job-d", { incarnation: "two" })).incarnation).toBe("two")

  // The feed is fenced the same way: the same attempt cannot be fed by the older incarnation once a newer one is current.
  const [attempt] = (await s.su`select * from execution where inbound_id = 'job-d'`) as unknown as { id: string }[]
  const row = (await readExecution(s.runner, attempt.id))!
  await expect(markFeedIntent(s.runner, { ...row, incarnation: "one" }, "task job-d")).rejects.toBeInstanceOf(ExecutionNotOwned)
  expect((await readExecution(s.runner, attempt.id))?.state).toBe("claimed")
  await s.su`update conversation set placement_generation = 3 where id = ${conv["job-d"].id}`
  await expect(markFeedIntent(s.runner, row, "task job-d")).rejects.toMatchObject({ reason: "state" })
  await s.su`update conversation set placement_generation = 1 where id = ${conv["job-d"].id}`
  await markFeedIntent(s.runner, row, "task job-d")
  expect((await readExecution(s.runner, attempt.id))?.state).toBe("feed_intent")
})

test("a priming tail is a model turn and is owned like one: it cannot run beside another attempt of the agent, and leaves no hold", async () => {
  const s = await stage()
  await s.human("h1")
  await s.incarnate("runner-a", "one")
  const conversation = await s.master("h1")
  const tail = () => openTailExecution(s.runner, { agent: "p1-lair", conversation, runner: "runner-a", incarnation: "one", digest: "t", nativeSession: null })
  // The row's claim is staged first: once the tail owns the agent the table refuses to
  // claim anything of it, so the competing opening below could not be staged after it.
  await s.claim("h1", "runner-a")
  const primed = await tail()
  expect(primed).toMatchObject({ purpose: "tail", inbound_id: null, state: "claimed" })
  await expect(tail()).rejects.toBeInstanceOf(ExecutionBusy)
  // The claim is refused for the agent now, and a claimed row of the same agent cannot open beside it either.
  await expect(s.runner.sql`update inbound set claimed_by = 'runner-b', claim_deadline = now() + interval '1 minute' where id = 'h1' and claimed_by <> 'runner-b'`.execute())
    .rejects.toThrow(/not claimable/)
  await expect(openExecution(s.runner, { row: { id: "h1", agent: "p1-lair" }, conversation, runner: "runner-a", incarnation: "one", digest: "d", nativeSession: null }))
    .rejects.toBeInstanceOf(ExecutionBusy)
  await markFeedIntent(s.runner, primed, "the tail")
  expect((await s.su`select count(*)::int as n from conversation_entry`)[0].n, "a tail is not an input of the conversation").toBe(0)
  // Cut off after it was fed and with nothing shown about the process: the slot stays taken, and there is no input to hold.
  expect((await endAttempt(s.runner, { execution: primed.id, evidence: NOT_GONE, cause: "the runner stopped" })).state).toBe("unknown")
  await expect(openExecution(s.runner, { row: { id: "h1", agent: "p1-lair" }, conversation, runner: "runner-a", incarnation: "one", digest: "d", nativeSession: null }))
    .rejects.toBeInstanceOf(ExecutionBusy)
  expect((await endAttempt(s.runner, { execution: primed.id, evidence: GONE, cause: "gone" })).state).toBe("interrupted")
  expect(Number((await s.su`select count(*)::int as n from replay_hold`)[0].n)).toBe(0)
  expect((await s.su`select claimed_by from inbound where id = 'h1'`)[0].claimed_by, "no row was touched").toBe("runner-a")
  // The agent is free again, and a tail that completes is over.
  const next = await tail()
  await markFeedIntent(s.runner, next, "the tail")
  await completeTail(s.runner, next)
  expect((await readExecution(s.runner, next.id))?.state).toBe("completed")
  // A tail is fenced by the incarnation as a turn is.
  await s.incarnate("runner-a", "two")
  await expect(tail()).rejects.toMatchObject({ reason: "incarnation" })
})

test("an owner's choice is scoped to one attempt at one revision, and a continuation is one linked new input queued only once the old attempt is over", async () => {
  const s = await stage()
  await s.human("h1")
  await s.incarnate("runner-a", "one")
  await s.incarnate("runner-b", "two")
  const conversation = await s.master("h1")
  await s.claim("h1", "runner-a")
  const attempt = await openExecution(s.runner, { row: { id: "h1", agent: "p1-lair" }, conversation, runner: "runner-a", incarnation: "one", digest: "d1", nativeSession: null })
  await markFeedIntent(s.runner, attempt, "body of h1")
  await s.su`update execution set effects = ${{ actions: 3, lastAction: "Edit" }}::jsonb where id = ${attempt.id}`
  await endAttempt(s.runner, { execution: attempt.id, evidence: NOT_GONE, cause: "the runner stopped" })
  // What the store keeps is the record, and never a string that looks like one.
  expect({ ...(await s.su`select jsonb_typeof(effects) as effects, jsonb_typeof(evidence) as evidence, jsonb_typeof(evidence -> 'exit') as exit from execution where id = ${attempt.id}`)[0] })
    .toEqual({ effects: "object", evidence: "object", exit: "object" })
  const choose = (over: Record<string, unknown> = {}) => chooseHold(s.door, {
    attempt: attempt.id, agent: "p1-lair", revision: 1, choice: "continue", by: "p1", evidence: { message: "m" }, context: "keep the edits", ...over })

  // Every way to be refused, and none of them leaves a mark.
  expect(await choose({ revision: 7 })).toBe("stale-revision")
  expect(await choose({ agent: "someone-else" })).toBe("unknown-attempt")
  expect(await choose({ attempt: "no-such-attempt" })).toBe("unknown-attempt")
  expect({ ...(await s.su`select state, choice from replay_hold where inbound_id = 'h1'`)[0] }).toEqual({ state: "held", choice: null })

  // Choosing to continue does not prove the old process died: nothing is queued.
  expect(await choose()).toBe("continue_pending")
  expect(Array.from(await s.su`select id from inbound where id like 'continue:%'`)).toEqual([])

  // With the evidence, and only then, exactly one new input exists, linked to the
  // held one, carrying what is known and what the owner said.
  await endAttempt(s.runner, { execution: attempt.id, evidence: GONE, cause: "the process tree is gone" })
  const queued = await s.su`select id, body, kind, agent from inbound where id like 'continue:%'`
  expect(queued.map((r: { id: string }) => r.id)).toEqual(["continue:h1:1"])
  expect(queued[0].kind).toBe("human")
  expect(queued[0].agent).toBe("p1-lair")
  expect(queued[0].body).toContain("3 tool actions were started before it stopped, the last of them Edit")
  expect(queued[0].body).toContain("keep the edits")
  expect(queued[0].body).toContain("body of h1")
  expect({ ...(await s.su`select state, continuation_id, chosen_by from replay_hold where inbound_id = 'h1'`)[0] })
    .toEqual({ state: "continuing", continuation_id: "continue:h1:1", chosen_by: "p1" })
  // Choosing again, or replaying the evidence, adds nothing.
  expect(await choose()).toBe("closed")
  await endAttempt(s.runner, { execution: attempt.id, evidence: GONE, cause: "again" })
  expect(Array.from(await s.su`select id from inbound where id like 'continue:%'`)).toHaveLength(1)
  // The original input is still held, and is not what runs.
  expect(await claimNext(s.runner, { runner: "runner-b", agent: "p1-lair", leaseMs: 60_000, resumeOk: true }).then(r => r?.id)).toBe("continue:h1:1")
  // Keep-held records the choice and authorizes nothing.
  await s.human("h3")
  await s.claim("h3", "runner-a")
  const other = await openExecution(s.runner, { row: { id: "h3", agent: "p1-lair" }, conversation, runner: "runner-a", incarnation: "one", digest: "d3", nativeSession: null })
  await markFeedIntent(s.runner, other, "body of h3")
  await endAttempt(s.runner, { execution: other.id, evidence: GONE, cause: "gone" })
  expect(await chooseHold(s.door, { attempt: other.id, agent: "p1-lair", revision: 1, choice: "keep_held", by: "p1", evidence: {} })).toBe("keep_held")
  expect((await openHoldsOf(s.runner, conversation.id)).map(h => [h.inbound_id, h.state]).sort()).toEqual([["h1", "continuing"], ["h3", "keep_held"]])
})

test("a continuation never reopens the original input: released recovery state keeps it excluded from replay, for a person's message and for a job", async () => {
  for (const kind of ["human", "job"] as const) {
    const s = await stage()
    const agent = kind === "job" ? "p1-worker" : "p1-lair"
    const original = kind === "job" ? "job-1" : "h1"
    const source = kind === "job" ? await s.job(original) : null
    await s.incarnate("runner-a", "one")
    const conversation = kind === "job" ? await s.worker(original, source) : await s.master(original)
    if (kind === "human") await s.human(original)
    await s.claim(original, "runner-a")
    const attempt = await openExecution(s.runner, { row: { id: original, agent }, conversation, runner: "runner-a", incarnation: "one", digest: "d", nativeSession: null })
    await markFeedIntent(s.runner, attempt, `body of ${original}`)
    await endAttempt(s.runner, { execution: attempt.id, evidence: GONE, cause: "gone" })
    expect(await chooseHold(s.door, { attempt: attempt.id, agent, revision: 1, choice: "continue", by: "p1", evidence: {} })).toBe("continuing")
    const held = async () => (await s.su`select hub_row_held(${original}) as held`)[0].held
    expect(await held()).toBe(true)

    // The continuation is claimed, and the attempt that owns the conversation from
    // here releases the OWNER'S gate.
    const continuation = await claimNext(s.runner, { runner: "runner-a", agent, leaseMs: 60_000, resumeOk: true })
    expect(continuation?.id).toBe(`continue:${original}:1`)
    expect(continuation?.kind).toBe(kind)
    const again = kind === "job" ? await s.worker(continuation!.id, continuation!.source) : await s.master(continuation!.id)
    expect(again.id).toBe(conversation.id)
    const next = await openExecution(s.runner, { row: { id: continuation!.id, agent }, conversation: again, runner: "runner-a", incarnation: "one", digest: "d2", nativeSession: null })
    expect((await s.su`select state from replay_hold where inbound_id = ${original}`)[0].state).toBe("released")
    // ...and the original input is excluded all the same, and not falsely answered.
    expect(await held(), "a released hold does not make the original eligible again").toBe(true)
    await markFeedIntent(s.runner, next, "the continuation")
    await settleTurn(s.runner, { inboundId: continuation!.id, person: "p1", chunks: ["done"], turn: { ...TURN, agent }, kind: continuation!.kind, source: continuation!.source,
      execution: { id: next.id, runner: "runner-a", fence: { incarnation: "one" } } })
    expect((await readExecution(s.runner, next.id))?.state).toBe("completed")
    expect(await held(), "nor once the continuation settled").toBe(true)
    expect(await claimNext(s.runner, { runner: "runner-a", agent, leaseMs: 60_000, resumeOk: true }), "nothing of the agent's is left to claim").toBeNull()
    expect(await readEligible(s.runner, { agent, resumeOk: true })).toEqual([])
    await expect(s.runner.sql`update inbound set claimed_by = 'runner-a', claim_deadline = now() + interval '1 minute' where id = ${original}`.execute()).rejects.toThrow(/not claimable/)
    expect((await s.su`select state from inbound where id = ${original}`)[0].state, "it was never answered").not.toBe("answered")
    expect((await s.su`select state from execution where id = ${attempt.id}`)[0].state).toBe("interrupted")
  }
})

test("an attempt settles only as the current incarnation on the placement it started on, and only recovery may settle a result it journaled", async () => {
  const s = await stage()
  await s.human("h1")
  await s.incarnate("runner-a", "one")
  await s.claim("h1", "runner-a")
  const conversation = await s.master("h1")
  const attempt = await openExecution(s.runner, { row: { id: "h1", agent: "p1-lair" }, conversation, runner: "runner-a", incarnation: "one", digest: "d", nativeSession: null })
  await markFeedIntent(s.runner, attempt, "body of h1")
  const settle = (execution: { runner: string; fence: { incarnation: string } | { recovery: true } }) =>
    settleTurn(s.runner, { inboundId: "h1", person: "p1", chunks: ["the answer"], turn: TURN, execution: { id: attempt.id, ...execution } })
  const written = async () => [
    Array.from(await s.su`select id from outbox`).length,
    Array.from(await s.su`select kind from ledger_event where subject = 'h1' and kind = 'answered'`).length,
  ]
  // The conversation moved on while this runner was cut off: what it finishes is obsolete.
  await s.su`update conversation set placement_generation = 2 where id = ${conversation.id}`
  await expect(settle({ runner: "runner-a", fence: { incarnation: "one" } })).rejects.toBeInstanceOf(ExecutionNotOwned)
  expect(await written()).toEqual([0, 0])
  expect((await readExecution(s.runner, attempt.id))?.state).toBe("feed_intent")
  // Another runner's settle of the same attempt is refused the same way.
  await s.su`update conversation set placement_generation = 1 where id = ${conversation.id}`
  await expect(settle({ runner: "runner-b", fence: { incarnation: "one" } })).rejects.toBeInstanceOf(ExecutionNotOwned)
  // An older incarnation of the same runner is not the current one, even on the same placement.
  await expect(settle({ runner: "runner-a", fence: { incarnation: "zero" } })).rejects.toBeInstanceOf(ExecutionNotOwned)
  await s.incarnate("runner-a", "two")
  await expect(settle({ runner: "runner-a", fence: { incarnation: "one" } })).rejects.toMatchObject({ reason: "incarnation" })
  expect(await written()).toEqual([0, 0])
  // Recovery is deliberate and asks for a RESULT: with none stored it settles nothing.
  await expect(settle({ runner: "runner-a", fence: { recovery: true } })).rejects.toMatchObject({ reason: "stored-result" })
  expect(await written()).toEqual([0, 0])
  // With one, it settles without asking about the placement or the incarnation.
  await journalResult(s.runner, attempt.id, { text: "the answer", chunks: ["the answer"], turn: TURN })
  await s.su`update conversation set placement_generation = 2 where id = ${conversation.id}`
  expect(await settleStored(s.runner, { runner: "runner-a" })).toBe(0)
  expect((await readExecution(s.runner, attempt.id))?.state).toBe("completed")
  expect(Array.from(await s.su`select body from outbox`)).toEqual([{ body: "the answer" }])
  // And a second look writes nothing more.
  expect(await settleStored(s.runner, { runner: "runner-a" })).toBe(0)
  expect(await written()).toEqual([1, 1])
})

test("a finished answer is never turned into an interruption: a failed settle leaves it journaled and it is settled when the store takes it, stop races included", async () => {
  const s = await stage()
  await s.human("h1")
  await s.human("h2")
  await s.incarnate("runner-a", "one")
  const conversation = await s.master("h1")
  const opened = async (id: string) => {
    await s.claim(id, "runner-a")
    const attempt = await openExecution(s.runner, { row: { id, agent: "p1-lair" }, conversation, runner: "runner-a", incarnation: "one", digest: "d", nativeSession: null })
    await markFeedIntent(s.runner, attempt, `body of ${id}`)
    await journalResult(s.runner, attempt.id, { text: `answer to ${id}`, chunks: [`answer to ${id}`], turn: TURN })
    return attempt
  }
  const first = await opened("h1")
  // What the runner does when its settle throws: it ends the attempt, and the
  // journal is what says the model had finished.
  expect(await endAttempt(s.runner, { execution: first.id, evidence: GONE, cause: "the settle failed" })).toEqual({ state: "journaled", revision: null })
  expect(Number((await s.su`select count(*)::int as n from replay_hold`)[0].n), "no hold, no interruption").toBe(0)
  expect((await readExecution(s.runner, first.id))?.state).toBe("feed_intent")
  expect((await s.su`select jsonb_typeof(result) as result from execution where id = ${first.id}`)[0].result).toBe("object")

  // The store refuses the settle (an injected, transient failure).
  await s.su.unsafe(`create function test_refuse_reply() returns trigger language plpgsql as $$ begin raise exception 'injected settle failure'; end $$;
    create trigger test_refuse_reply before insert on outbox for each row execute function test_refuse_reply()`)
  expect(await settleStored(s.runner, { runner: "runner-a" }), "still owed").toBe(1)
  expect((await readExecution(s.runner, first.id))?.state, "not turned into anything else").toBe("feed_intent")
  expect(Number((await s.su`select count(*)::int as n from replay_hold`)[0].n)).toBe(0)
  expect(Array.from(await s.su`select id from outbox`)).toEqual([])
  expect((await s.su`select state from inbound where id = 'h1'`)[0].state).not.toBe("answered")
  // The agent takes nothing else meanwhile: the answer is still owed.
  expect(await claimNext(s.runner, { runner: "runner-a", agent: "p1-lair", leaseMs: 60_000, resumeOk: true })).toBeNull()

  // The store takes it again, and the answer lands once, from the journal, without a model.
  await s.su.unsafe("drop trigger test_refuse_reply on outbox")
  expect(await settleStored(s.runner, { runner: "runner-a" })).toBe(0)
  expect((await readExecution(s.runner, first.id))?.state).toBe("completed")
  expect(Array.from(await s.su`select inbound_id, body from outbox`)).toEqual([{ inbound_id: "h1", body: "answer to h1" }])
  expect((await s.su`select state from inbound where id = 'h1'`)[0].state).toBe("answered")
  expect(await settleStored(s.runner, { runner: "runner-a" })).toBe(0)
  expect(Array.from(await s.su`select id from outbox`)).toHaveLength(1)

  // A stop that lands between the journal and the settle is not an interruption either.
  const second = await opened("h2")
  await s.su`update execution set state = 'stop_requested' where id = ${second.id}`
  expect((await endAttempt(s.runner, { execution: second.id, evidence: NOT_GONE, cause: "stop requested", requested: true })).state).toBe("journaled")
  expect(Number((await s.su`select count(*)::int as n from replay_hold`)[0].n)).toBe(0)
  expect(await settleStored(s.runner, { runner: "runner-a" })).toBe(0)
  expect((await readExecution(s.runner, second.id))?.state).toBe("completed")
  expect((Array.from(await s.su`select inbound_id from outbox order by id`) as { inbound_id: string }[]).map(r => r.inbound_id)).toEqual(["h1", "h2"])
})

/** A process that leads a process group of its own, as the production adapter asks its child to. */
function groupLeader(argv: string[]) {
  const child = Bun.spawn(argv, { stdout: "ignore", stderr: "ignore", stdin: "ignore", ...({ detached: true } as object) })
  return { child, pid: child.pid, group: groupOf(child.pid) === child.pid ? child.pid : null,
    async kill() { try { child.kill(9) } catch { /* gone */ } await child.exited } }
}

test("what proves an attempt is over: a new boot of the same machine, or a managed group that is empty with everything recorded under it gone and the leader exited, and never a lookup that failed, a survivor, a missing group or a live leader", async () => {
  const sleeper = Bun.spawn(["sleep", "300"], { stdout: "ignore", stderr: "ignore", stdin: "ignore" })
  const gone = Bun.spawn(["true"], { stdout: "ignore", stderr: "ignore", stdin: "ignore" })
  await gone.exited
  const managed = groupLeader(["sleep", "300"])
  // A leader that started a tool in its own group before it was killed: the tool stays in the leader's group.
  const shell = groupLeader(["sh", "-c", "sleep 300 & wait"])
  const bystander = groupLeader(["sleep", "300"])
  try {
    expect(managed.group, "the runtime gave the child a process group of its own").toBe(managed.pid)
    expect(shell.group).toBe(shell.pid)
    const here = { machine: "pi", boot: BOOT_2 }
    // A reboot proves every process of the earlier boot gone, including one whose pid is in use again.
    const rebooted = evidenceFromRecord({ evidence: { boot_id: BOOT_1, machine: "pi", leader: sleeper.pid, pids: [sleeper.pid] } }, here)
    expect(rebooted).toMatchObject({ confirmed: true, leader: "exited", descendants: "none", basis: "boot" })
    // Not another machine's boot, not an unknown boot, and not the same one.
    expect(evidenceFromRecord({ evidence: { boot_id: BOOT_1, machine: "mac", leader: sleeper.pid, pids: [sleeper.pid] } }, here).confirmed).toBe(false)
    expect(evidenceFromRecord({ evidence: { boot_id: BOOT_1, machine: "pi", leader: sleeper.pid, pids: [sleeper.pid] } }, { machine: "pi", boot: null }).confirmed).toBe(false)
    expect(evidenceFromRecord({ evidence: { boot_id: BOOT_2, machine: "pi", leader: sleeper.pid, pids: [sleeper.pid] } }, here)).toMatchObject({ confirmed: false, leader: "alive" })
    // An old incarnation, an empty list and a legacy mark prove nothing.
    for (const evidence of [{}, { pids: [] }, { legacy: true, pids: [gone.pid], leader: gone.pid }]) {
      expect(evidenceFromRecord({ evidence }, here)).toMatchObject({ confirmed: false, leader: "unknown", descendants: "unverified" })
    }
    // A leader that is alive is never an attempt that ended, whatever else was recorded.
    expect(evidenceFromRecord({ evidence: { leader: sleeper.pid, pids: [gone.pid] } }).confirmed).toBe(false)
    // Every recorded process gone and the leader with them is NOT enough without a verified group: with
    // only a process table lookup, what was never recorded (or left before it was) is not shown gone.
    expect(evidenceFromRecord({ evidence: { leader: gone.pid, pids: [gone.pid] } })).toMatchObject({ confirmed: false, leader: "exited", descendants: "unverified", basis: "observed-tree" })
    // A process still in the leader's group is a survivor whether or not it was ever recorded.
    const mine = groupOf(process.pid)
    expect(mine).not.toBeNull()
    expect(evidenceFromRecord({ evidence: { leader: gone.pid, pids: [gone.pid], group: mine } })).toMatchObject({ confirmed: false, leader: "exited", descendants: "survivors" })
    await shell.kill()
    expect(alive(shell.pid), "the leader is gone").toBe(false)
    expect(evidenceFromRecord({ evidence: { leader: shell.pid, pids: [shell.pid], group: shell.group } }),
      "its tool is still in the group though nobody recorded it").toMatchObject({ confirmed: false, leader: "exited", descendants: "survivors" })
    // A lookup that failed is unknown, and never gone: an impossible pid is not an absent one.
    expect(presence(0)).toBe("unknown")
    expect(presence(Number.NaN)).toBe("unknown")
    expect(groupPresence(1)).toBe("unknown")
    expect(groupPresence(managed.pid)).toBe("present")
    expect(presence(gone.pid)).toBe("absent")
    await managed.kill()
    expect(groupPresence(managed.pid), "the group is empty once its last member is reaped").toBe("absent")
    const failed = evidenceFromRecord({ evidence: { leader: managed.pid, pids: [managed.pid, 0], group: managed.group } })
    expect(failed).toMatchObject({ confirmed: false, leader: "exited", descendants: "unverified", unknown: [0] })
    // The managed group is empty and everything recorded under it is gone: the bounded claim, and only that.
    const bounded = evidenceFromRecord({ evidence: { leader: managed.pid, pids: [managed.pid], group: managed.group } })
    expect(bounded).toMatchObject({ confirmed: true, leader: "exited", descendants: "none", basis: "process-group" })
    expect(bounded.via).toContain("left the group before it was recorded is not covered")
    // A recorded descendant that left the group and is still alive is a known survivor: the group being empty does not cover it.
    const survivor = evidenceFromRecord({ evidence: { leader: managed.pid, pids: [managed.pid, bystander.pid], group: managed.group } })
    expect(survivor).toMatchObject({ confirmed: false, descendants: "survivors", survivors: [bystander.pid] })
    expect(alive(sleeper.pid)).toBe(true)
  } finally {
    try { sleeper.kill(9) } catch { /* gone */ } await sleeper.exited
    await managed.kill(); await shell.kill(); await bystander.kill()
    // The tool the shell started was left in the shell's group, which is this test's own: only that group is signalled.
    try { process.kill(-shell.pid, 9) } catch { /* nothing was left */ }
  }
})

/** A machine that answers exactly what it is told to, so no test changes a clock or reboots anything. */
function machineSaying(platform: NodeJS.Platform, answers: Record<string, string | null>): BootSources {
  return { platform, file: path => answers[path] ?? null, sysctl: name => answers[name] ?? null }
}

test("a boot is told by the kernel's per-boot session id and never by a boot time: the same session with a stepped clock is the same boot, a different valid session on the same machine is a new boot, and a bad, old, unread or foreign identity proves nothing", async () => {
  const mac = "kern.bootsessionuuid"
  // The session id is read as a tagged, lower-cased UUID on each platform.
  expect(readBootIdentity(machineSaying("darwin", { [mac]: "6F1C2A3E-1111-4222-8333-444455556666\n" }))).toBe("darwin:6f1c2a3e-1111-4222-8333-444455556666")
  expect(readBootIdentity(machineSaying("linux", { "/proc/sys/kernel/random/boot_id": "6f1c2a3e-1111-4222-8333-444455556666\n" }))).toBe(BOOT_1)
  // A failed, empty, malformed or unavailable read is no identity, and a boot TIME is not accepted in its place.
  for (const said of [null, "", "\n", "not-a-uuid", "{ sec = 1790000000, usec = 12 } Tue Sep 29 10:00:00 2026", "1790000000.12"]) {
    expect(readBootIdentity(machineSaying("darwin", { [mac]: said, "kern.boottime": "{ sec = 1790000000, usec = 12 }" }))).toBeNull()
    expect(readBootIdentity(machineSaying("linux", { "/proc/sys/kernel/random/boot_id": said }))).toBeNull()
  }
  expect(readBootIdentity(machineSaying("win32", { [mac]: "6F1C2A3E-1111-4222-8333-444455556666" }))).toBeNull()
  expect(bootIdentityFrom("darwin", "6F1C2A3E-1111-4222-8333-44445555666")).toBeNull()

  // A stepped calendar changes kern.boottime and nothing else: the session id is the same, so nothing moved.
  const before = readBootIdentity(machineSaying("darwin", { [mac]: "AAAAAAAA-1111-4222-8333-444455556666", "kern.boottime": "{ sec = 1790000000, usec = 0 }" }))
  const stepped = readBootIdentity(machineSaying("darwin", { [mac]: "AAAAAAAA-1111-4222-8333-444455556666", "kern.boottime": "{ sec = 1790003600, usec = 5 }" }))
  expect(stepped).toBe(before)
  expect(bootMoved(before, stepped)).toBe(false)
  // A real reboot is a different session id of the same scheme.
  const after = readBootIdentity(machineSaying("darwin", { [mac]: "BBBBBBBB-1111-4222-8333-444455556666" }))
  expect(bootMoved(before, after)).toBe(true)
  // Never across schemes, from an untagged or numeric record, from an unreadable current identity, or from garbage.
  expect(bootMoved(before, BOOT_1)).toBe(false)
  for (const old of ["1790000000.0", "boot-1", "", 1790000000, null, undefined, "darwin:1790000000.0", "darwin:not-a-uuid"]) {
    expect(bootMoved(old, after), `${String(old)} is not an identity`).toBe(false)
  }
  expect(bootMoved(before, null)).toBe(false)

  // The verdict of an attempt follows: the process below is alive and stays unproven except by a real new session.
  const sleeper = Bun.spawn(["sleep", "300"], { stdout: "ignore", stderr: "ignore", stdin: "ignore" })
  try {
    const record = (boot_id: unknown, machine = "mac") => ({ evidence: { boot_id, machine, leader: sleeper.pid, pids: [sleeper.pid] } })
    const here = { machine: "mac", boot: after }
    expect(evidenceFromRecord(record(before), here)).toMatchObject({ confirmed: true, basis: "boot" })
    expect(evidenceFromRecord(record(stepped), { machine: "mac", boot: before }), "the same session after a clock change").toMatchObject({ confirmed: false, leader: "alive" })
    for (const old of ["1790000000.0", "boot-1", BOOT_1, "darwin:zzzz"]) {
      expect(evidenceFromRecord(record(old), here), `${old} cannot be compared with a session id`).toMatchObject({ confirmed: false, leader: "alive" })
    }
    expect(evidenceFromRecord(record(before), { machine: "mac", boot: null })).toMatchObject({ confirmed: false, leader: "alive" })
    expect(evidenceFromRecord(record(before, "pi"), here)).toMatchObject({ confirmed: false, leader: "alive" })
  } finally { sleeper.kill(9); await sleeper.exited }
})

test("the record of an attempt's processes is everything ever seen and never the last look: a tool that left the tree stays recorded, and a group or leader once known is not erased", async () => {
  const s = await stage()
  await s.human("h1")
  await s.incarnate("runner-a", "one")
  await s.claim("h1", "runner-a")
  const conversation = await s.master("h1")
  const attempt = await openExecution(s.runner, { row: { id: "h1", agent: "p1-lair" }, conversation, runner: "runner-a", incarnation: "one", digest: "d", nativeSession: null })
  await markFeedIntent(s.runner, attempt, "body of h1")
  const managed = groupLeader(["sleep", "300"])
  const detached = groupLeader(["sleep", "300"])
  const record = async () => (await readExecution(s.runner, attempt.id))!.evidence as Record<string, unknown>
  try {
    expect(managed.group).toBe(managed.pid)
    await notePids(s.runner, attempt.id, { leader: managed.pid, pids: [managed.pid, detached.pid], group: managed.group, machine: "pi", bootId: BOOT_1 })
    // The tool detaches: the next look no longer finds it in the tree, and does not know the group either.
    await notePids(s.runner, attempt.id, { leader: null, pids: [managed.pid], group: null, machine: "pi", bootId: BOOT_1, partial: true })
    expect(await record()).toMatchObject({ leader: managed.pid, group: managed.group, machine: "pi", boot_id: BOOT_1, partial: true })
    expect([...(await record()).pids as number[]].sort()).toEqual([managed.pid, detached.pid].sort())
    expect((await s.su`select jsonb_typeof(evidence) as e, jsonb_typeof(evidence -> 'pids') as p from execution where id = ${attempt.id}`)[0]).toMatchObject({ e: "object", p: "array" })
    // A third look does not duplicate what is known.
    await notePids(s.runner, attempt.id, { leader: managed.pid, pids: [detached.pid, managed.pid], group: managed.group, machine: "pi", bootId: BOOT_1 })
    expect(((await record()).pids as number[]).length).toBe(2)
    expect(await record(), "a partial observation, once made, is not forgotten").toMatchObject({ partial: true })

    // The engine's process and its group are gone after a crash; the recorded tool is not, and it is still known.
    await managed.kill()
    const verdict = evidenceFromRecord(await readExecution(s.runner, attempt.id) as never)
    expect(verdict).toMatchObject({ confirmed: false, leader: "exited", descendants: "survivors", survivors: [detached.pid], partial: true })
    await detached.kill()
    expect(evidenceFromRecord(await readExecution(s.runner, attempt.id) as never)).toMatchObject({ confirmed: true, descendants: "none", basis: "process-group" })
  } finally { await managed.kill(); await detached.kill() }
})

test("a job's continuation is a new approved job on the same worker conversation, so it passes the same gate a dispatched one does", async () => {
  const s = await stage()
  const source = await s.job("job-1")
  const conversation = await s.worker("job-1", source)
  await s.incarnate("runner-a", "one")
  await s.claim("job-1", "runner-a")
  const attempt = await openExecution(s.runner, { row: { id: "job-1", agent: "p1-worker" }, conversation, runner: "runner-a", incarnation: "one", digest: "d", nativeSession: conversation.native_session })
  await markFeedIntent(s.runner, attempt, "task job-1")
  await endAttempt(s.runner, { execution: attempt.id, evidence: GONE, cause: "gone" })
  expect(await chooseHold(s.door, { attempt: attempt.id, agent: "p1-worker", revision: 1, choice: "continue", by: "p1", evidence: {} })).toBe("continuing")
  const [row] = await s.su`select id, body, kind, source from inbound where id = 'continue:job-1:1'`
  expect(row.kind).toBe("job")
  expect(admitJob({ body: row.body, source: row.source }), "the digest is over the new task").toBeNull()
  expect(row.source.dispatch.conversation).toBe(conversation.id)
  expect(row.source.dispatch.continues).toBe("job-1")
  expect(row.source.dispatch.approved.source).toBe("recovery")
  // And it is put back into the conversation it continues, not into a new one.
  expect((await s.worker(row.id, row.source)).id).toBe(conversation.id)
  // A worker's hold gates only its own conversation: another job is not asked about it.
  const otherSource = await s.job("job-2")
  const [needs] = await s.su`select hub_row_needs_resume('job-2', 'p1-worker', 'job', ${otherSource}::jsonb) as needs`
  expect(needs.needs).toBe(false)
  const [mine] = await s.su`select hub_row_needs_resume(${row.id}, 'p1-worker', 'job', ${row.source}::jsonb) as needs`
  expect(mine.needs).toBe(true)
  expect((await readExecution(s.runner, attempt.id))?.state).toBe("interrupted")
})

test("a council seat is never abandoned by a clock: the store's own grace is switched off, whether the seat is held, unresolved or plain", async () => {
  const s = await stage()
  await s.incarnate("runner-a", "one")
  const heldSource = await s.job("seat-held")
  const openSource = await s.job("seat-unresolved")
  await s.job("seat-plain")

  // A seat whose input reached the engine and was interrupted.
  const conversation = await s.worker("seat-held", heldSource)
  await s.claim("seat-held", "runner-a")
  const attempt = await openExecution(s.runner, { row: { id: "seat-held", agent: "p1-worker" }, conversation, runner: "runner-a", incarnation: "one", digest: "d", nativeSession: null })
  await markFeedIntent(s.runner, attempt, "task seat-held")
  await endAttempt(s.runner, { execution: attempt.id, evidence: GONE, cause: "gone" })
  expect((await s.su`select claimed_by from inbound where id = 'seat-held'`)[0].claimed_by, "the claim was released, which is all the store's grace looked at").toBeNull()
  const door = async (id: string) => (await s.door.sql`select hub_council_abandon(${id}, 'the council is late') as done`)[0].done
  expect(await door("seat-held"), "the door's grace does not close a held seat").toBe(false)
  expect((await s.su`select state from inbound where id = 'seat-held'`)[0].state).not.toBe("answered")
  expect(Array.from(await s.su`select kind from ledger_event where subject = 'seat-held' and kind = 'dispatch.abandoned'`)).toEqual([])

  // A seat whose attempt may still be running, with its claim already given back.
  const other = await s.worker("seat-unresolved", openSource)
  await s.claim("seat-unresolved", "runner-a")
  const running = await openExecution(s.runner, { row: { id: "seat-unresolved", agent: "p1-worker" }, conversation: other, runner: "runner-a", incarnation: "one", digest: "d", nativeSession: null })
  await s.su`update inbound set claimed_by = null, claim_deadline = null where id = 'seat-unresolved'`
  expect(running.state).toBe("claimed")
  expect(await door("seat-unresolved")).toBe(false)

  // A seat nobody worked on is not closed by the grace any more either: a council waits for its owner instead.
  expect(await door("seat-plain")).toBe(false)
  expect((await s.su`select state from inbound where id = 'seat-plain'`)[0].state).not.toBe("answered")
})

test("a scheduled harvest asks the same ownership question as every other claim: an unresolved attempt of the agent holds it, and only the claimant's own live turn lets it run beside", async () => {
  const s = await stage()
  await s.human("h1")
  await s.su`insert into inbound (id, person, agent, body, kind) values ('harvest:1', 'p1', 'p1-lair', '{}', 'harvest')`
  await s.incarnate("runner-a", "one")
  await s.incarnate("runner-b", "two")
  await s.claim("h1", "runner-a")
  const conversation = await s.master("h1")
  const attempt = await openExecution(s.runner, { row: { id: "h1", agent: "p1-lair" }, conversation, runner: "runner-a", incarnation: "one", digest: "d", nativeSession: null })
  await markFeedIntent(s.runner, attempt, "body of h1")
  const blocked = async (by: string) => (await s.su`select hub_harvest_blocked('p1-lair', ${by}) as blocked`)[0].blocked
  const release = () => s.su`update inbound set claimed_by = null, claim_deadline = null where id = 'harvest:1'`

  // The claimant's own live turn (its current incarnation) is not another executor's: a harvest is a
  // session of its own beside it, as it always was.
  expect(await blocked("runner-a")).toBe(false)
  expect((await readEligible(s.runner, { agent: "p1-lair", runner: "runner-a" })).map(r => r.id)).toEqual(["harvest:1"])
  // Any other runner's is: nothing shows that turn's process gone, and a harvest is another executor of the agent's tools.
  expect(await blocked("runner-b")).toBe(true)
  expect(await readEligible(s.runner, { agent: "p1-lair", runner: "runner-b" })).toEqual([])
  expect(await claimNext(s.runner, { runner: "runner-b", agent: "p1-lair", leaseMs: 60_000, resumeOk: true })).toBeNull()
  await expect(s.runner.sql`update inbound set claimed_by = 'runner-b', claim_deadline = now() + interval '1 minute' where id = 'harvest:1'`.execute()).rejects.toThrow(/not claimable/)
  // And an obsolete incarnation of the claimant's own runner is not the live one.
  await s.incarnate("runner-a", "two")
  expect(await blocked("runner-a"), "the incarnation that owns the attempt is not the current one").toBe(true)
  await s.incarnate("runner-a", "one")

  // Ownership unresolved: the attempt may still be running, and nobody has shown it is not.
  await endAttempt(s.runner, { execution: attempt.id, evidence: NOT_GONE, cause: "the runner stopped" })
  expect((await readExecution(s.runner, attempt.id))?.state).toBe("unknown")
  for (const by of ["runner-a", "runner-b"]) {
    expect(await blocked(by)).toBe(true)
    expect(await claimNext(s.runner, { runner: by, agent: "p1-lair", leaseMs: 60_000, resumeOk: true, maxRank: 1 }), `${by} claims nothing, the harvest included`).toBeNull()
    expect(await readEligible(s.runner, { agent: "p1-lair", runner: by, resumeOk: true })).toEqual([])
    await expect(s.runner.sql`update inbound set claimed_by = ${by}, claim_deadline = now() + interval '1 minute' where id = 'harvest:1'`.execute()).rejects.toThrow(/not claimable/)
  }
  expect((await s.su`select claimed_by from inbound where id = 'harvest:1'`)[0].claimed_by).toBeNull()
  // The same for an explicit stop that was not proved.
  await s.su`update execution set state = 'stop_unknown' where id = ${attempt.id}`
  expect(await blocked("runner-a")).toBe(true)
  await s.su`update execution set state = 'unknown' where id = ${attempt.id}`

  // Only proof that the process is gone frees it, and then the harvest is claimable again.
  await endAttempt(s.runner, { execution: attempt.id, evidence: GONE, cause: "the process tree is gone" })
  expect(await blocked("runner-a")).toBe(false)
  expect((await claimNext(s.runner, { runner: "runner-a", agent: "p1-lair", leaseMs: 60_000, resumeOk: true }))?.id).toBe("harvest:1")
  await release()
})

test("the unknown watch is lowered only by a full look that found nothing during which no attempt was left unresolved: an attempt that turns unknown while a look is awaiting keeps the watch up and is examined on a later tick, and no executor starts before its proof", async () => {
  const s = await stage()
  await s.incarnate("runner-a", "one")
  // What the runner's tick hands the look: this runner, and this machine's current boot. No registry is needed to move an attempt.
  const at = { runner: "runner-a", registry: null as never, here: { machine: "pi", boot: BOOT_2 } }
  const unknownAttempt = async (id: string, agent: string, evidence: Record<string, unknown>) => {
    await s.human(id, agent)
    await s.claim(id, "runner-a")
    const conversation = await s.master(id, agent)
    const attempt = await openExecution(s.runner, { row: { id, agent }, conversation, runner: "runner-a", incarnation: "one", digest: "d", nativeSession: null })
    await markFeedIntent(s.runner, attempt, `body of ${id}`)
    expect((await endAttempt(s.runner, { execution: attempt.id, evidence: NOT_GONE, cause: "the runner stopped" })).state).toBe("unknown")
    await s.su`update execution set evidence = evidence || ${evidence}::jsonb where id = ${attempt.id}`
    return attempt
  }
  const stateOf = async (id: string) => (await readExecution(s.runner, id))?.state
  const managed = groupLeader(["sleep", "300"])
  try {
    expect(managed.group).toBe(managed.pid)
    // A: a boot ago, so the next look proves it over. It is the only attempt the look below will see.
    const a = await unknownAttempt("ha", "p1-lair", { boot_id: BOOT_1, machine: "pi", leader: managed.pid + 100_000, pids: [managed.pid + 100_000] })
    const watch = markedWatch(true)
    const later: { b?: Awaited<ReturnType<typeof unknownAttempt>> } = {}
    // THE BARRIER IS THE LOOK ITSELF: it has read the store (only A is unresolved, and A is resolved by it) and has not returned
    // when another agent's attempt ends `unknown` and the runner raises the watch, exactly as `closeAttempt` does.
    await watch.look(async () => {
      const remaining = await reevaluateUnknown(s.runner, at)
      later.b = await unknownAttempt("hb", "p1-other", { leader: managed.pid, pids: [managed.pid], group: managed.group, machine: "pi" })
      watch.raise()
      return remaining
    })
    const b = later.b!
    expect(await stateOf(a.id), "the look proved A over").toBe("interrupted")
    expect(watch.watching, "a zero counted before B existed says nothing about B").toBe(true)
    expect(await stateOf(b.id)).toBe("unknown")

    // B's process is alive: the next look finds it unresolved, leaves it exactly as it is, and the watch stays up.
    await watch.look(() => reevaluateUnknown(s.runner, at))
    expect(await stateOf(b.id)).toBe("unknown")
    expect(watch.watching).toBe(true)
    // And nothing else of B's agent starts beside it.
    expect((await s.su`select hub_agent_blocked('p1-other') as blocked`)[0].blocked).toBe(true)
    await s.human("hb2", "p1-other")
    expect(await claimNext(s.runner, { runner: "runner-a", agent: "p1-other", leaseMs: 60_000, resumeOk: true })).toBeNull()

    // B's process ends. A later tick, with no restart, moves it, and only then is the watch lowered and the agent free.
    await managed.kill()
    await watch.look(() => reevaluateUnknown(s.runner, at))
    expect(await stateOf(b.id)).toBe("interrupted")
    expect(watch.watching, "a full look that found nothing and saw nothing new lowers it").toBe(false)
    expect((await s.su`select hub_agent_blocked('p1-other') as blocked`)[0].blocked).toBe(false)
  } finally { await managed.kill() }
})

test("a protocol that is activated refuses every claim that does not say it speaks it, and it does not move while an old runner's input is in flight", async () => {
  const old = await rollout()
  const sql = old.sql
  const runner = old.store("hub_runner") as unknown as StoreLike
  for (const [id, agent] of [["quiet", "p1-lair"], ["other-work", "p1-third"], ["fed-by-old", "p1-other"]]) {
    await sql`insert into inbound (id, person, agent, body) values (${id}, 'p1', ${agent}, ${`body ${id}`})`
  }
  const protocol = async () => Number((await sql`select runner_protocol from hub_protocol`)[0].runner_protocol)
  expect(await protocol(), "a store nobody has activated is protocol 1").toBe(1)
  // Before activation nothing is asked of a claim: every runner there is is an old one.
  await runner.sql`update inbound set claimed_by = 'old-runner', claim_deadline = now() + interval '1 minute' where id = 'quiet'`
  await runner.sql`update inbound set claimed_by = null, claim_deadline = null where id = 'quiet'`

  // An input an old runner acked and never settled: nothing can say what became of it.
  await sql`insert into ledger_event (stream, subject, kind, actor) values ('inbound', 'fed-by-old', 'acked', 'runner')`
  await sql`update inbound set claimed_by = 'old-runner', claim_deadline = now() + interval '1 minute' where id = 'fed-by-old'`
  await expect(activateProtocol(runner, 2)).rejects.toThrow(/legacy-inputs-in-flight.*fed-by-old/)
  expect(await protocol()).toBe(1)
  await sql`insert into ledger_event (stream, subject, kind, actor) values ('inbound', 'fed-by-old', 'answered', 'runner')`
  await activateProtocol(runner, 2)
  expect(await protocol()).toBe(2)
  await activateProtocol(runner, 2)
  await expect(runner.sql`update hub_protocol set runner_protocol = 1`.execute()).rejects.toThrow(/only moves forward/)

  // After it, a runner that predates the protocol is refused on every row and every claim.
  await expect(runner.sql`update inbound set claimed_by = 'old-runner', claim_deadline = now() + interval '1 minute' where id = 'quiet'`.execute())
    .rejects.toThrow(/does not speak protocol 2/)
  await expect(runner.sql`update inbound set claimed_by = 'old-runner', claim_deadline = now() + interval '1 minute' where id = 'other-work'`.execute())
    .rejects.toThrow(/does not speak protocol 2/)
  // A runner that says it speaks a protocol at least as new claims (this build says its own, which is newer than the
  // one activated here), and what it said does not stay on the connection for the next borrower.
  expect((await claimNext(runner, { runner: "runner-pi", agent: "p1-third", leaseMs: 1000 }))?.id).toBe("other-work")
  for (const id of ["quiet", "old-input"]) {
    await expect(runner.sql`update inbound set claimed_by = 'old-runner', claim_deadline = now() + interval '1 minute' where id = ${id}`.execute())
      .rejects.toThrow(/does not speak protocol 2/)
  }
  // Nothing was claimed by the refused ones, and the one that spoke it holds its row
  // (beside the answered input the old runner left its claim on).
  expect((await sql`select id from inbound where claimed_by is not null order by id`).map((r: any) => r.id)).toEqual(["fed-by-old", "other-work"])
})

/** A council's job and the event the master reads for one, as the hub writes them, planted for the claim rule to meet. */
const councilJobSource = (id: string) => ({ log_id: id, at: new Date().toISOString(), door: "door-fake", chat: "1000000001", from: "p1", text: "a council's question",
  dispatch: { dispatcher: "p1-lair", target: "p1-w1", approved: { by: "p1", at: new Date().toISOString(), digest: "d", source: "council" },
    return: { agent: "p1-lair", door: "door-fake", chat: "1000000001" }, council_round: { council: "c1", round: 1, participant: "c1:p1", revision: 1 } } })
const councilEventSource = (id: string) => ({ log_id: id, at: new Date().toISOString(), door: "door-fake", chat: "1000000001", from: "council", text: "council round_complete",
  origin: "council", council_event: { council: "c1", seq: 1, kind: "round_complete" } })

/** A claim the way a connection of a given protocol makes it: `null` says nothing at all, as every runner before 2 did. */
const claimSaying = (store: StoreLike, protocol: string | null, id: string, by = "some-runner") => store.sql.begin(async (tx: any) => {
  if (protocol !== null) await tx`select set_config('hub.runner_protocol', ${protocol}, true)`
  await tx`update inbound set claimed_by = ${by}, claim_deadline = now() + interval '1 minute' where id = ${id}`
})

test("protocol 3: a council's job and event are claimable only by a connection that says 3, before and after 3 is active, and once it is active nothing that says less claims, registers or moves the protocol back", async () => {
  const s = await rollout()
  const sql = s.sql
  const runner = s.store("hub_runner") as unknown as StoreLike
  await sql`insert into inbound (id, person, agent, body, kind, source, log_ready) values ('c-job', 'p1', 'p1-w1', 'a council question', 'job', ${councilJobSource("c-job")}::jsonb, true)`
  await sql`insert into inbound (id, person, agent, body, kind, received_at, reported_at, source, log_ready)
    values ('c-event', 'p1', 'p1-w2', 'council round_complete', 'report', now(), now(), ${councilEventSource("c-event")}::jsonb, true)`
  await sql`insert into inbound (id, person, agent, body) values ('plain', 'p1', 'p1-third', 'an ordinary message')`
  const claimed = async () => (await sql`select id from inbound where claimed_by is not null order by id`).map((r: any) => r.id)
  const release = async (id: string) => { await runner.sql`update inbound set claimed_by = null, claim_deadline = null where id = ${id}` }
  const protocol = async () => Number((await sql`select runner_protocol from hub_protocol`)[0].runner_protocol)
  expect(RUNNER_PROTOCOL).toBe(3)

  // BEFORE ACTIVATION the store is at 1, and the rule is on the row and not on what is active: a connection that says nothing,
  // or says 2 (a pooled connection's previous borrower's word does not survive its transaction, and this one is a runner of 2's),
  // cannot take a council's job or event. An ordinary row is asked nothing yet.
  expect(await protocol()).toBe(1)
  for (const id of ["c-job", "c-event"]) {
    await expect(claimSaying(runner, null, id), `${id}: says nothing`).rejects.toThrow(/belongs to a council.*does not speak protocol 3/)
    await expect(claimSaying(runner, "2", id), `${id}: says 2`).rejects.toThrow(/belongs to a council.*does not speak protocol 3/)
  }
  await claimSaying(runner, "2", "plain")
  await release("plain")
  expect(await claimed(), "nothing was claimed by the refused ones").toEqual([])
  // This build's own claim takes the council's job.
  expect((await claimNext(runner, { runner: "runner-new", agent: "p1-w1", leaseMs: 60_000, resumeOk: true }))?.id).toBe("c-job")
  await release("c-job")

  // ACTIVATION: one statement, nothing started, stopped, settled or discarded; the protocol is this build's.
  await activateProtocol(runner)
  expect(await protocol()).toBe(RUNNER_PROTOCOL)
  await activateProtocol(runner)
  await activateProtocol(runner, 2)
  expect(await protocol(), "activating an older protocol is no move").toBe(RUNNER_PROTOCOL)
  for (const id of ["plain", "c-job", "c-event"]) {
    await expect(claimSaying(runner, null, id), `${id}: says nothing`).rejects.toThrow(/does not speak protocol 3/)
    await expect(claimSaying(runner, "2", id), `${id}: a runner of 2 claims nothing once 3 is active`).rejects.toThrow(/does not speak protocol 3/)
  }
  expect(await claimed()).toEqual([])
  expect((await claimNext(runner, { runner: "runner-new", agent: "p1-third", leaseMs: 60_000, resumeOk: true }))?.id).toBe("plain")
  expect((await claimNext(runner, { runner: "runner-new", agent: "p1-w2", leaseMs: 60_000, resumeOk: true }))?.id).toBe("c-event")
  // What this build said does not stay on the connection for the next borrower.
  await expect(claimSaying(runner, null, "c-job")).rejects.toThrow(/does not speak protocol 3/)
  expect(await claimed()).toEqual(["c-event", "plain"])
  await release("plain")
  await release("c-event")

  // THE INCARNATION: a registration that speaks less than what is active cannot become current and fence out the one that serves.
  await expect(runner.sql`insert into runner_incarnation (runner, incarnation, protocol) values ('runner-old', 'x', 2)`.execute()).rejects.toThrow(/does not serve/)
  await registerIncarnation(runner, { runner: "runner-new", incarnation: "one", machine: "pi", bootId: null })
  expect(Number((await sql`select protocol from runner_incarnation where runner = 'runner-new'`)[0].protocol)).toBe(RUNNER_PROTOCOL)
  await expect(runner.sql`update runner_incarnation set incarnation = 'old', protocol = 2 where runner = 'runner-new'`.execute()).rejects.toThrow(/does not serve/)
  expect((await sql`select incarnation from runner_incarnation where runner = 'runner-new'`)[0].incarnation).toBe("one")

  // THE PROTOCOL ONLY MOVES FORWARD, and only to a value the table knows.
  await expect(runner.sql`update hub_protocol set runner_protocol = 2`.execute()).rejects.toThrow(/only moves forward/)
  await expect(runner.sql`update hub_protocol set runner_protocol = 4`.execute()).rejects.toThrow(/check constraint/)
  expect(await protocol()).toBe(RUNNER_PROTOCOL)
})

test("version skew: a runner of this build refuses a store at migration 13 before it does anything, landing 14 (and 15, the topics, after it) over live work touches none of it and activates nothing, and activating 3 closes the claim door to older runners and settles, stops and discards nothing", async () => {
  const old = await rollout(true)
  const files = (upTo: number) => MIGRATION_FILES.filter(([version]) => version <= upTo)
    .map(([version, file]) => ({ version, sql: readFileSync(join(hubPath("src/store/migrations"), file), "utf8" ) }))
  await migrate(old.store(), files(13))
  const sql = old.sql
  const runner = old.store("hub_runner") as unknown as StoreLike
  const protocol = async () => Number((await sql`select runner_protocol from hub_protocol`)[0].runner_protocol)
  expect(Number((await sql`select max(version) as version from schema_version`)[0].version)).toBe(13)

  // A runner of this build on this store refuses by name, before it activates a protocol, registers an incarnation or claims a row.
  await expect(requireSchema(runner)).rejects.toThrow(/schema-behind: apply migration 14/)
  expect(await protocol()).toBe(1)
  expect(Number((await sql`select count(*)::int as n from runner_incarnation`)[0].n)).toBe(0)

  // Live work of a runner of protocol 2: a turn claimed and an attempt opened for it, and ordinary rows waiting beside it.
  await sql`insert into inbound (id, person, agent, body, kind, source) values ('live', 'p1', 'p1-lair', 'a turn in flight', 'human',
    ${{ log_id: "live", at: new Date().toISOString(), door: "door-fake", chat: "1000000001", sender_id: "p1", text: "a turn in flight" }}::jsonb)`
  await sql`insert into inbound (id, person, agent, body) values ('plain', 'p1', 'p1-third', 'an ordinary message')`
  await sql`insert into runner_incarnation (runner, incarnation, protocol) values ('runner-pi', 'old-inc', 2)`
  await sql`update inbound set claimed_by = 'runner-pi', claim_deadline = now() + interval '1 hour' where id = 'live'`
  const conversation = await conversationFor(runner, { row: { id: "live", person: "p1", agent: "p1-lair", kind: "human" }, adapter: "claude-code", machine: "pi" })
  const attempt = await openExecution(runner, { row: { id: "live", agent: "p1-lair" }, conversation, runner: "runner-pi", incarnation: "old-inc", digest: "d", nativeSession: null })
  const everything = async () => ({
    inbound: Array.from(await sql`select id, state, claimed_by, retry_at from inbound order by id`).map((r: any) => ({ ...r })),
    execution: Array.from(await sql`select id, state, runner, incarnation from execution order by id`).map((r: any) => ({ ...r })),
    holds: Array.from(await sql`select inbound_id, state from replay_hold order by inbound_id`).map((r: any) => ({ ...r })),
    ledger: Number((await sql`select count(*)::int as n from ledger_event`)[0].n),
  })
  const before = await everything()
  expect(before.execution).toEqual([{ id: attempt.id, state: "claimed", runner: "runner-pi", incarnation: "old-inc" }])

  // LANDING 14 over it (and 15, which `migrate` applies after it and which reads no row of live work): every row, attempt, hold and
  // diary line is as it was, the protocol is where it was, and the runner now serves.
  await migrate(old.store())
  expect(await everything(), "the step moved, discarded and settled nothing").toEqual(before)
  expect(await protocol(), "landing the step activates nothing").toBe(1)
  await requireSchema(runner)
  // Until a runner of 3 activates it an older runner still claims ordinary work, but no council's row.
  await claimSaying(runner, "2", "plain")
  await runner.sql`update inbound set claimed_by = null, claim_deadline = null where id = 'plain'`
  await sql`insert into inbound (id, person, agent, body, kind, source, log_ready) values ('c-job', 'p1', 'p1-w1', 'a council question', 'job', ${councilJobSource("c-job")}::jsonb, true)`
  await expect(claimSaying(runner, "2", "c-job")).rejects.toThrow(/belongs to a council.*does not speak protocol 3/)
  const beforeActivation = await everything()
  expect(beforeActivation.execution, "the attempt is untouched by all of it").toEqual(before.execution)
  expect(beforeActivation.inbound.find((r: any) => r.id === "live"), "and so is the row it is for").toEqual(before.inbound.find((r: any) => r.id === "live"))

  // ACTIVATING 3 is allowed with that work in flight (it has an attempt, which is what a row an old runner may have fed lacks), and it moves none of it.
  await activateProtocol(runner)
  expect(await protocol()).toBe(RUNNER_PROTOCOL)
  expect(await everything(), "activation killed, settled, discarded and replayed nothing").toEqual(beforeActivation)
  // From then on the door is shut to every older claim, ordinary rows included, and the agent with the attempt stays blocked for everyone.
  await expect(claimSaying(runner, null, "plain")).rejects.toThrow(/does not speak protocol 3/)
  await expect(claimSaying(runner, "2", "plain")).rejects.toThrow(/does not speak protocol 3/)
  await expect(runner.sql`insert into runner_incarnation (runner, incarnation, protocol) values ('runner-old', 'x', 2)`.execute()).rejects.toThrow(/does not serve/)
  expect(await claimNext(runner, { runner: "runner-new", agent: "p1-lair", leaseMs: 1000, resumeOk: true }), "the agent with an unresolved attempt takes nothing").toBeNull()
  expect((await claimNext(runner, { runner: "runner-new", agent: "p1-third", leaseMs: 1000, resumeOk: true }))?.id).toBe("plain")
  expect((await claimNext(runner, { runner: "runner-new", agent: "p1-w1", leaseMs: 1000, resumeOk: true }))?.id).toBe("c-job")
})

test("the claim and the activation of the protocol are ordered by a row lock and not by a clock: an old claim already in flight makes the activation refuse, and an activation in flight makes an old claim refuse", async () => {
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
  const gate = () => {
    let open!: () => void
    const opened = new Promise<void>(resolve => { open = resolve })
    return { opened, open }
  }
  const pid = async (sql: any) => Number((await sql`select pg_backend_pid() as pid`)[0].pid)
  const pending = (promise: Promise<unknown>) => Promise.race([promise.then(() => "settled", () => "settled"), Promise.resolve("pending")])

  // ORDER ONE: the old runner's claim is in flight (it passed the protocol as 1 and has not committed).
  const first = await rollout()
  await first.sql`insert into inbound (id, person, agent, body) values ('quiet', 'p1', 'p1-lair', 'body')`
  const claimer = first.store("hub_runner").sql as any
  const activator = first.store("hub_runner")
  const activatorPid = await pid(activator.sql)
  const release = gate(), entered = gate()
  const claim = claimer.begin(async (tx: any) => {
    await tx`update inbound set claimed_by = 'old-runner', claim_deadline = now() + interval '1 minute' where id = 'quiet'`
    entered.open()
    await release.opened
  })
  await Promise.race([entered.opened, claim])
  const activation = activateProtocol(activator as StoreLike).then(() => null, (error: Error) => error)
  await blockedOnLock(first.sql, activatorPid)
  expect(await pending(activation), "the activation waits for the claim that is in flight").toBe("pending")
  expect(Number((await first.sql`select runner_protocol from hub_protocol`)[0].runner_protocol)).toBe(1)
  release.open()
  await claim
  // It checked for in-flight inputs AFTER waiting, so it saw the claim that committed while it waited.
  const refused = await activation
  expect(refused).toBeInstanceOf(Error)
  expect((refused as Error).message).toMatch(/legacy-inputs-in-flight.*quiet/)
  expect(Number((await first.sql`select runner_protocol from hub_protocol`)[0].runner_protocol), "the protocol did not move").toBe(1)
  expect((await first.sql`select claimed_by from inbound where id = 'quiet'`)[0].claimed_by).toBe("old-runner")
  // The role fences hold: a door cannot activate anything, and a runner may write only the two columns it is given.
  await expect(first.store("hub_door").sql`update hub_protocol set runner_protocol = 2`.execute()).rejects.toThrow(/permission denied/)
  await expect(first.store("hub_runner").sql`update hub_protocol set singleton = true`.execute()).rejects.toThrow(/permission denied/)

  // ORDER TWO: the activation is in flight (it found nothing in flight and has not committed).
  const second = await rollout()
  await second.sql`insert into inbound (id, person, agent, body) values ('quiet', 'p1', 'p1-third', 'body')`
  const activating = second.store("hub_runner").sql as any
  const late = second.store("hub_runner").sql as any
  const latePid = await pid(late)
  const settle = gate(), inside = gate()
  const activated = activating.begin(async (tx: any) => {
    await tx`update hub_protocol set runner_protocol = 2, activated_at = now() where runner_protocol < 2`
    inside.open()
    await settle.opened
  })
  await Promise.race([inside.opened, activated])
  const oldClaim = late`update inbound set claimed_by = 'old-runner', claim_deadline = now() + interval '1 minute' where id = 'quiet'`.execute().then(() => null, (error: Error) => error)
  await blockedOnLock(second.sql, latePid)
  expect(await pending(oldClaim), "the old claim waits for the activation that is in flight").toBe("pending")
  settle.open()
  await activated
  // It read the protocol AFTER waiting, and read it as activated.
  const stopped = await oldClaim
  expect(stopped).toBeInstanceOf(Error)
  expect((stopped as Error).message).toMatch(/does not speak protocol 2/)
  expect(Number((await second.sql`select runner_protocol from hub_protocol`)[0].runner_protocol)).toBe(2)
  expect((await second.sql`select claimed_by from inbound where id = 'quiet'`)[0].claimed_by, "nothing was claimed").toBeNull()
  // A claim that says it speaks protocol 2 is untouched by either state and takes no lock on the way.
  expect((await claimNext(second.store("hub_runner") as StoreLike, { runner: "runner-pi", agent: "p1-third", leaseMs: 1000 }))?.id).toBe("quiet")
})

test("the step refuses to land while an old runner may have fed an input, and leaves a store that carries the same objects as a fresh install", async () => {
  const old = await rollout(true)
  const files = (upTo: number) => MIGRATION_FILES.filter(([version]) => version <= upTo)
    .map(([version, file]) => ({ version, sql: readFileSync(join(hubPath("src/store/migrations"), file), "utf8") }))
  await migrate(old.store(), files(10))
  // What an old runner leaves: a row fed and started and never settled; one it fed
  // and then released onto a retry; one it only claimed; and ordinary waiting work.
  const sql = old.sql
  for (const [id, agent] of [["mid-turn", "p1-lair"], ["released-retry", "p1-lair"], ["claimed-only", "p1-other"], ["behind", "p1-lair"], ["elsewhere", "p1-third"]]) {
    await sql`insert into inbound (id, person, agent, body) values (${id}, 'p1', ${agent}, ${`body ${id}`})`
  }
  await sql`insert into ledger_event (stream, subject, kind, actor) values ('inbound', 'mid-turn', 'acked', 'runner'), ('inbound', 'mid-turn', 'started', 'runner'),
    ('inbound', 'released-retry', 'acked', 'runner')`
  await sql`update inbound set retry_at = now() + interval '5 minutes' where id = 'released-retry'`
  await sql`update inbound set claimed_by = 'runner-pi', claim_deadline = now() + interval '5 minutes' where id in ('mid-turn', 'claimed-only')`

  // Refused, whole, by name, with the inputs that need somebody to say what became of them.
  const refused = await migrate(old.store()).then(() => "", (error: Error) => error.message)
  expect(refused).toContain("migration-not-quiescent")
  for (const id of ["mid-turn", "released-retry", "claimed-only"]) expect(refused).toContain(id)
  for (const id of ["behind", "elsewhere", "old-input"]) expect(refused).not.toContain(id)
  expect(Number((await sql`select max(version) as version from schema_version`)[0].version), "nothing of the step landed").toBe(10)
  expect((await sql`select to_regclass('public.execution') as t`)[0].t).toBeNull()

  // Somebody who can say settles them; only then does the step land, and it writes no history of its own.
  await sql`insert into ledger_event (stream, subject, kind, actor) values ('inbound', 'mid-turn', 'answered', 'runner'),
    ('inbound', 'released-retry', 'answered', 'runner'), ('inbound', 'claimed-only', 'answered', 'runner')`
  await migrate(old.store())
  expect((await sql`select version from schema_version order by version`).map((r: any) => Number(r.version))).toEqual(MIGRATION_FILES.map(([v]) => v))
  for (const table of ["conversation", "execution", "replay_hold", "conversation_entry"]) {
    expect(Number((await sql.unsafe(`select count(*)::int as n from ${table}`))[0].n), `${table} was not invented for old rows`).toBe(0)
  }
  expect((await sql`select runner_protocol from hub_protocol`)[0].runner_protocol, "landing the step does not activate it").toBe(1)
  expect({ ...(await sql`select body, state from inbound where id = 'mid-turn'`)[0] }).toEqual({ body: "body mid-turn", state: "answered" })

  // The upgraded objects are the fresh install's, read from the catalog on both sides.
  const fresh = await rollout()
  const read = async (q: any) => ({
    functions: Array.from(await q`select p.proname, pg_get_function_identity_arguments(p.oid) as args, r.rolname as owner, p.prosecdef, p.prosrc
      from pg_proc p join pg_roles r on r.oid = p.proowner
      where p.proname in ('hub_row_held', 'hub_agent_blocked', 'hub_harvest_blocked', 'hub_row_needs_resume', 'hub_guard_inbound_claim', 'hub_hold_advance', 'hub_hold_choice',
                          'hub_legacy_inputs', 'hub_guard_protocol_activation', 'hub_council_abandon', 'hub_guard_runner_incarnation',
                          'hub_council_merge', 'hub_guard_legacy_council_job')
      order by p.proname`) as { proname: string; args: string; owner: string; prosecdef: boolean; prosrc: string }[],
    triggers: Array.from(await q`select t.tgname, pg_get_triggerdef(t.oid) as d from pg_trigger t
      where t.tgname in ('inbound_claim_honours_holds', 'hub_protocol_activation', 'runner_incarnation_speaks_protocol', 'inbound_no_new_legacy_council') order by t.tgname`),
    columns: Array.from(await q`select table_name, column_name, data_type, is_nullable from information_schema.columns
      where table_name in ('conversation', 'conversation_entry', 'execution', 'replay_hold', 'tool_invocation', 'source_consumption', 'runner_incarnation', 'hub_protocol')
      order by table_name, ordinal_position`),
    indexes: Array.from(await q`select indexname, indexdef from pg_indexes
      where tablename in ('conversation', 'execution', 'replay_hold', 'runner_incarnation', 'hub_protocol') order by indexname`),
    checks: Array.from(await q`select conrelid::regclass::text as t, conname, pg_get_constraintdef(oid) as d from pg_constraint
      where conrelid in ('conversation'::regclass, 'execution'::regclass, 'hub_protocol'::regclass) and contype = 'c' order by conrelid::regclass::text, conname`),
    policies: Array.from(await q`select policyname, roles::text as roles, with_check from pg_policies where policyname like '%_execution' order by policyname`),
    grants: Array.from(await q`select table_name, grantee, privilege_type from information_schema.role_table_grants
      where table_name in ('runner_incarnation', 'hub_protocol', 'execution') and grantee like 'hub_%' order by table_name, grantee, privilege_type`),
    protocol: Array.from(await q`select runner_protocol from hub_protocol`),
  })
  const a = await read(fresh.sql)
  const b = await read(sql)
  // The three of the protocol's machinery and the one that closes the old design's council creation; the eleven functions of that machinery and the two that
  // switch the old merge off and refuse a new legacy seat. The old merge is not a function this step may leave writing, on either side.
  expect(a.triggers).toHaveLength(4)
  expect(a.functions).toHaveLength(13)
  expect(a.functions.find(one => one.proname === "hub_council_merge")!.prosrc).toContain("return false")
  expect(a.protocol).toEqual([{ runner_protocol: 1 }])
  // The protocol table allows the three protocols and is one constraint under one name on both sides.
  const protocolChecks = (a.checks as { t: string; conname: string; d: string }[]).filter(one => one.t === "hub_protocol" && one.d.includes("runner_protocol"))
  expect(protocolChecks.map(one => one.conname)).toEqual(["hub_protocol_runner_protocol_check"])
  expect(protocolChecks[0].d).toContain("3")
  expect(b.functions).toEqual(a.functions)
  expect(b.triggers).toEqual(a.triggers)
  expect(b.columns).toEqual(a.columns)
  expect(b.indexes).toEqual(a.indexes)
  expect(b.checks).toEqual(a.checks)
  expect(b.policies).toEqual(a.policies)
  expect(b.grants).toEqual(a.grants)
  expect(b.protocol).toEqual(a.protocol)
})
