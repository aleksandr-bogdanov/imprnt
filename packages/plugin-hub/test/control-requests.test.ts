// Durable execution controls: the request helper, claim gates and stop requests.
//
// Everything against Postgres, on role connections where the rule is the store's,
// and against the REAL `runRunner` where the rule is what the runner does with a
// row. Only the engine and the platform are fixtures, and the fixture reports its
// processes from the process table, so the runner is not grading itself.
//
//   H  the request helper the tool calls run in: one request key, the owner's
//      messages as evidence, a recorded answer that is replayed, and a refusal
//      that leaves nothing behind
//   G  claim gates: every path that claims refuses what a gate covers, nothing
//      already running is interrupted, and a release moves only its own gates
//   S  stop requests as a store rule: frozen to one attempt, saying only what the
//      attempt says
//   M  the migration: an upgraded store carries what a fresh one does
//   R  the runner consuming them: intent before the signal, no replay, a stale
//      request never reaches a newer attempt, an unproved end stays blocked
//
// The second pass adds what the first left to reasoning, each as an interleaving
// that is HELD where the test says and not slept past:
//   H4/H5  a key reused by another tool; operations named by their origin
//   S3     two conversations with one key, and a repeat cycle
//   G7     placing a gate against opening an attempt, in both orders, for an
//          input's attempt and for a tail
//   R8-R11 a stop against the attempt settling and the next input opening; the
//          other feed boundary; an accepted stop while the answer lands; a stop
//          whose write fails, and two requests for one attempt
//   R12-R14 an attempt of this incarnation that is unknown; a request the runner
//          could not read; a stop asked while the attempt is only being opened
//   R15/R16 a claim that committed before a gate; a resident starting beside one
//   R17/R18 the opening handoff of a stop: an attempt claimed when the stop begins and
//          fed by the time it is judged, in both orders (the write accepted after
//          the feed; the write refused before it and its read after it)
//
// The seams: an advisory lock held on a reserved connection that a trigger (for a
// statement of the runner) or the store's own ordering lock waits for, and
// `lock table execution` for the moment an insert is in flight. A backend is
// seen waiting in `pg_stat_activity` before the test moves on. A trigger pause
// holds a statement AFTER its snapshot, so it cannot place a write after a feed; R17/R18 hold
// the adapter's start and, on a byte-transparent proxy in front of the store, the
// DISPATCH or the ANSWER of the stop's own write.

import { afterAll, afterEach, beforeAll, expect, test } from "bun:test"
import { readFileSync, writeFileSync } from "node:fs"
import { connect, createServer, type AddressInfo, type Server, type Socket } from "node:net"
import { startCluster, freshDatabase, hubPath, lockTable, statementWatch, until, untilIssued, waitForLockWaiter, type Cluster } from "./helpers/cluster.ts"
import { rolloutDatabase } from "./helpers/rollout-fixtures.ts"
import { AGENT, CHAT, DOOR, PERSON, RUNNER, insertInbound, plantChatLine, stageHub, type NoticeRow } from "./helpers/hub-fixture.ts"
import { controlledAdapter, observe, processTree, retrySettings } from "./helpers/rollout-runner.ts"
import { insertJob, jobSource, livingProcess } from "./helpers/conversations.ts"
import { childGone } from "./helpers/scripted-adapter.ts"
import { runRunner } from "../src/runner/run.ts"
import { claimNext } from "../src/runner/claim.ts"
import { endAttempt } from "../src/runner/execution.ts"
import { readEligible } from "../src/store/wake.ts"
import { MIGRATION_FILES, migrate } from "../src/store/migrate.ts"
import { ToolError, TOOLS, canonical } from "../src/mcp/contracts.ts"
import { callTool, type McpBinding } from "../src/mcp/handlers.ts"
import { Undo, digest, operationFor, refusal, runRequest, type RequestPlan } from "../src/mcp/requests.ts"
import {
  ControlRefused, attemptsOf, describeStop, gatesOn, operationId, placeGate, releaseGates, requestStop, stopsOf,
} from "../src/store/controls.ts"
import {
  completeExecution, conversationFor, journalResult, markFeedIntent, noteExecution, openExecution, openTailExecution, readExecution, registerIncarnation,
} from "../src/store/conversations.ts"
import { loadRegistry } from "../src/registry/load.ts"
import type { AdapterCapabilities, ExitEvidence } from "../src/adapters/types.ts"
import type { StoreLike } from "../src/store/connect.ts"

let cluster: Cluster
// The server logs every statement, so a runner that is waiting can be shown to be reading nothing.
beforeAll(async () => {
  cluster = await startCluster({ settings: { log_statement: "'all'", log_line_prefix: "'pid=%p '", log_min_duration_statement: "-1" } })
})
afterAll(async () => { await cluster?.stop() })

// The cluster allows forty connections and every test opens several, so each test hands its own back.
const mine: { close(): Promise<void> }[] = []
const track = <T extends { close(): Promise<void> }>(sql: T): T => { mine.push(sql); return sql }
afterEach(async () => { for (const one of mine.splice(0)) await one.close().catch(() => {}) })

const NOT_GONE: ExitEvidence = { confirmed: false, leader: "unknown", descendants: "unverified", pids: [], survivors: [], via: "test" }
const GONE: ExitEvidence = { confirmed: true, leader: "exited", descendants: "none", pids: [], survivors: [], via: "test" }
const TURN = { agent: AGENT, runner: RUNNER, preset: "daily", preset_id: "x", preset_settings: {}, input_tokens: 5, cached_input_tokens: 0,
  output_tokens: 7, price: null, plan_usage: null, raw_usage: {}, session_id: null, lacks: [], tail: false }

// ---------------------------------------------------------------------------
// A store with a master, its rows and an owner's messages, on role connections.
// ---------------------------------------------------------------------------

async function stage() {
  const db = await freshDatabase(cluster)
  const as = (role: string) => ({ sql: track(cluster.connectAs(role, db)), url: cluster.url(db) }) as StoreLike
  const su = track(cluster.connect(db))
  const human = async (id: string, agent = "p1-lair") => {
    await su`insert into inbound (id, person, agent, body, kind, source) values (${id}, 'p1', ${agent}, ${`body of ${id}`}, 'human',
      ${{ log_id: id, at: new Date().toISOString(), door: "door-fake", chat: "1000000001", sender_id: "p1", text: `body of ${id}` }}::jsonb)`
  }
  const job = async (id: string, agent = "p1-worker", conversation?: string) => {
    const source = jobSource(id, { target: agent, task: `task ${id}`, ...(conversation ? { conversation } : {}) })
    await su`insert into inbound (id, person, agent, body, kind, source) values (${id}, 'p1', ${agent}, ${`task ${id}`}, 'job', ${source}::jsonb)`
    return source
  }
  const harvest = async (id: string, agent = "p1-lair") => {
    await su`insert into inbound (id, person, agent, body, kind) values (${id}, 'p1', ${agent}, '{}', 'harvest')`
  }
  const runner = as("hub_runner")
  const claim = async (id: string, by: string) => {
    await su.unsafe(`update inbound set claimed_by = $1, claim_deadline = now() + interval '1 hour' where id = $2`, [by, id])
  }
  const incarnate = (name: string, incarnation: string) => registerIncarnation(runner, { runner: name, incarnation, machine: "pi", bootId: null })
  const master = (id: string, agent = "p1-lair") =>
    conversationFor(runner, { row: { id, person: "p1", agent, kind: "human" }, adapter: "claude-code", machine: "pi" })
  const worker = (id: string, source: unknown, agent = "p1-worker") =>
    conversationFor(runner, { row: { id, person: "p1", agent, kind: "job", source: source as never }, adapter: "claude-code", machine: "pi" })
  return { db, su, runner, door: as("hub_door"), hub: as("hub_hub"), human, job, harvest, claim, incarnate, master, worker }
}

/** What a claim by this runner could take for an agent right now, by every id, sorted. */
async function claimable(s: { runner: StoreLike }, agent: string): Promise<string[]> {
  return (await readEligible(s.runner, { agent, runner: "runner-a", resumeOk: true })).map(row => row.id).sort()
}

/** Take the next row the way a runner does, and give it straight back, so the answer is only "could it". */
async function tryClaim(s: { runner: StoreLike; su: any }, agent: string): Promise<string | null> {
  const row = await claimNext(s.runner, { runner: "runner-a", agent, leaseMs: 60_000, resumeOk: true })
  if (row) await s.su`update inbound set claimed_by = null, claim_deadline = null where id = ${row.id}`
  return row?.id ?? null
}

// ---------------------------------------------------------------------------
// The seams the interleavings are held on.
// ---------------------------------------------------------------------------

/**
 * A session advisory lock held on a reserved connection. A trigger the test installed waits for it,
 * so the runner's statement stands still exactly there until `release()`.
 */
async function holdKey(db: string, key: number) {
  const client = track(cluster.connect(db)) as any
  const held = await client.reserve()
  await held.unsafe("select pg_advisory_lock($1::bigint)", [key])
  return { async release() { await held.unsafe("select pg_advisory_unlock($1::bigint)", [key]); await held.release() } }
}

/**
 * The store's own ordering lock for one agent, held in an open transaction on a reserved connection: an
 * opening (which takes it first) waits behind it, and a gate placed on this connection is ordered by it.
 */
async function holdOrder(db: string, agent: string) {
  const client = track(cluster.connect(db)) as any
  const held = await client.reserve()
  await held.unsafe("begin")
  await held.unsafe("select hub_gate_order($1::text)", [agent])
  return {
    async gate(operation: string, kind: "row" | "agent" | "conversation", id: string, cause: string) {
      await held.unsafe("select hub_gate_place($1::text, $2::text, $3::text, $4::text, '{}'::jsonb)", [operation, kind, id, cause])
    },
    async commit() { await held.unsafe("commit"); await held.release() },
  }
}

/** Whether a backend of this role is waiting for an advisory lock: the statement under test is held where the test put it. */
function waiting(db: string) {
  const probeConnection = track(cluster.connect(db)) as any
  return (role: string) => observe(async () => Number((await probeConnection.unsafe(
    `select count(*)::int as n from pg_stat_activity where datname = $1 and usename = $2 and wait_event_type = 'Lock' and wait_event = 'advisory'`,
    [db, role]))[0].n) > 0, 15_000)
}

/** Whether a promise is still unsettled a moment later. */
const pending = (promise: Promise<unknown>) => Promise.race([promise.then(() => "settled", () => "settled"), Bun.sleep(250).then(() => "pending")])

// ---------------------------------------------------------------------------
// H. The request helper.
// ---------------------------------------------------------------------------

async function ownerConversation() {
  const it = await stageHub(cluster, { people: [{ id: PERSON, allowed_senders: { [DOOR]: [PERSON, "the-other-allowed"] } } as never] })
  const su = cluster.connect(it.db)
  const store = { sql: cluster.connectAs("hub_runner", it.db), url: cluster.url(it.db) } as StoreLike
  const human = async (id: string, over: { agent?: string; sender?: string; at?: string } = {}) => {
    await su.unsafe(`insert into inbound (id, person, agent, body, kind, source, received_at) values ($1, $2, $3, $4, 'human', $5::jsonb, ${over.at ? "$6" : "now()"})`,
      [id, PERSON, over.agent ?? "p1-lair", `words of ${id}`,
        { log_id: id, at: new Date().toISOString(), door: DOOR, chat: CHAT, sender_id: over.sender ?? PERSON, text: `words of ${id}` }, ...(over.at ? [over.at] : [])])
  }
  await human("h1")
  const conversation = await conversationFor(store, { row: { id: "h1", person: PERSON, agent: "p1-lair", kind: "human" }, adapter: "claude-code", machine: "pi" })
  const binding: McpBinding = { store, person: PERSON, agent: "p1-lair", conversation: conversation.id, kind: "master",
    registry: () => loadRegistry(it.registryFile), attempt: () => "attempt-in-flight" }
  const count = async (table: string) => Number((await su.unsafe(`select count(*)::int as n from ${table}`))[0].n)
  const probed = async (key: string) => Number((await su`select count(*)::int as n from ledger_event where subject = ${`probe:${key}`}`)[0].n)
  return { it, su, store, human, conversation, binding, count, probed,
    async close() { await su.close().catch(() => {}); await store.sql.close().catch(() => {}); await it.stop() } }
}

/**
 * A second action, built the way a council's or a topic's will be: a few lines
 * around `runRequest`. It writes a diary line as its effect, so what a refusal
 * rolls back can be looked at.
 */
function probe(over: { key?: string; sources?: string[]; note?: string; effect?: "ok" | "refuse" | "throw" | "undo-open"; since?: Date } = {}) {
  const request = { action: "probe", request_key: over.key ?? "k1", source_message_ids: over.sources ?? ["h2"], note: over.note ?? "a" }
  const calls = { open: 0, apply: 0 }
  const plan: RequestPlan<typeof request, { note: string }> = {
    tool: "hub_probe", request, object: "the-probe",
    async open() {
      calls.open += 1
      if (over.effect === "undo-open") throw new Undo(refusal("the-probe", "unknown_probe", "there is no such probe"))
      return { context: { note: request.note }, ...(over.since ? { since: { at: over.since, what: "the probe it would change" } } : {}) }
    },
    async apply(tx, context, owner) {
      calls.apply += 1
      await noteExecution(tx, `probe:${request.request_key}`, "probe.applied", { note: context.note, by: owner.sender })
      if (over.effect === "throw") throw new Error("the database went away")
      return over.effect === "refuse"
        ? refusal("the-probe", "probe_failed", "nothing changed")
        : { operation_id: request.request_key, object_id: "the-probe", revision: 1, status: "accepted", stage: "probed" }
    },
  }
  return { plan, calls }
}

async function code(run: Promise<unknown>): Promise<string> {
  try { await run; return "no error" } catch (error) { return error instanceof ToolError ? error.code : `not a ToolError: ${(error as Error).message}` }
}

test("H1 an action built on the helper is accepted once, replayed as the recorded answer, and a changed argument under the same key is a conflict", async () => {
  const s = await ownerConversation()
  try {
    await s.human("h2")
    const first = probe()
    const reply = await runRequest(s.binding, first.plan)
    expect(reply).toEqual({ operation_id: "k1", object_id: "the-probe", revision: 1, status: "accepted", stage: "probed" })
    expect(first.calls).toEqual({ open: 1, apply: 1 })
    expect([await s.count("tool_invocation"), await s.count("source_consumption"), await s.probed("k1")]).toEqual([1, 1, 1])
    // The invocation carries the tool, the action and the attempt the binding says was running.
    expect({ ...(await s.su`select tool, action, execution_id, result from tool_invocation`)[0] })
      .toEqual({ tool: "hub_probe", action: "probe", execution_id: "attempt-in-flight", result: reply })

    // The model asked again with the same key and arguments: it meets its own answer, and nothing is applied again.
    const again = probe()
    expect(await runRequest(s.binding, again.plan)).toEqual(reply)
    expect(again.calls, "not looked up and not applied").toEqual({ open: 0, apply: 0 })
    expect([await s.count("tool_invocation"), await s.probed("k1")]).toEqual([1, 1])

    // The same key with any changed argument is a conflict, and leaves what was recorded exactly as it was.
    expect(await code(runRequest(s.binding, probe({ note: "another" }).plan))).toBe("idempotency_conflict")
    expect(await code(runRequest(s.binding, probe({ sources: ["h2", "h1"] }).plan))).toBe("idempotency_conflict")
    expect({ ...(await s.su`select result from tool_invocation`)[0] }).toEqual({ result: reply })

    // One message is one intent: another request cannot spend it.
    expect(await code(runRequest(s.binding, probe({ key: "k2" }).plan))).toBe("source_already_used")
    expect([await s.count("tool_invocation"), await s.count("source_consumption"), await s.probed("k2")], "the refused request left no trace").toEqual([1, 1, 0])

    // A key is scoped to the conversation that made it.
    const other = { ...s.binding, conversation: (await conversationFor(s.store, { row: { id: "x1", person: PERSON, agent: "p1-other", kind: "human" }, adapter: "claude-code", machine: "pi" })).id }
    await s.human("x1", { agent: "p1-other" })
    await s.human("x2", { agent: "p1-other" })
    expect(await runRequest({ ...other, agent: "p1-other" }, probe({ sources: ["x2"] }).plan)).toMatchObject({ status: "accepted" })
    expect(await s.count("tool_invocation")).toBe(2)
  } finally { await s.close() }
})

test("H2 a refusal leaves nothing behind: not the invocation, not the messages it would have used, not what it wrote before it refused, and the key is free again", async () => {
  const s = await ownerConversation()
  try {
    await s.human("h2")
    await s.human("h3")
    const nothing = async () => [await s.count("tool_invocation"), await s.count("source_consumption"), await s.probed("k1")]

    // The action wrote its effect and then said it could not: all of it is undone, and the reply is the refusal.
    const refused = probe({ effect: "refuse" })
    expect(await runRequest(s.binding, refused.plan)).toMatchObject({ status: "failed", stage: "refused", cause: "probe_failed", object_id: "the-probe" })
    expect(refused.calls.apply, "the effect was written before the refusal, which is what is undone").toBe(1)
    expect(await nothing()).toEqual([0, 0, 0])

    // A refusal from the lookup that comes first is a reply too.
    expect(await runRequest(s.binding, probe({ effect: "undo-open" }).plan)).toMatchObject({ status: "failed", cause: "unknown_probe" })
    expect(await nothing()).toEqual([0, 0, 0])

    // A fault of the hub's own is thrown to the caller and undoes everything the same way.
    await expect(runRequest(s.binding, probe({ effect: "throw" }).plan)).rejects.toThrow("the database went away")
    expect(await nothing()).toEqual([0, 0, 0])

    // Evidence that is not good enough is refused by name and spends nothing, however many messages came before the bad one.
    await s.human("from-a-stranger", { sender: "not-allowed" })
    await s.human("to-another-agent", { agent: "p1-other" })
    await s.su`insert into inbound (id, person, agent, body, kind, source) values ('a-report', ${PERSON}, 'p1-lair', 'r', 'report',
      ${{ log_id: "a-report", at: new Date().toISOString(), door: DOOR, chat: CHAT, sender_id: PERSON, text: "r" }}::jsonb)`
    for (const [id, why] of [["missing", "no such message"], ["from-a-stranger", "an unlisted sender"], ["to-another-agent", "another agent's"], ["a-report", "not a person's message"]] as const) {
      expect(await code(runRequest(s.binding, probe({ sources: ["h2", id] }).plan)), why).toBe("source_invalid")
    }
    expect(await nothing(), "h2 was cited first in every one of those and is still unspent").toEqual([0, 0, 0])

    // A message older than what the action says it must be newer than.
    await s.su`insert into inbound (id, person, agent, body, kind, source, received_at) values ('early', ${PERSON}, 'p1-lair', 'too early', 'human',
      ${{ log_id: "early", at: new Date().toISOString(), door: DOOR, chat: CHAT, sender_id: PERSON, text: "too early" }}::jsonb, now() - interval '1 hour')`
    expect(await code(runRequest(s.binding, probe({ sources: ["early"], since: new Date(Date.now() - 60_000) }).plan))).toBe("source_invalid")
    expect(await nothing()).toEqual([0, 0, 0])
    // With no such bound the same message is evidence, because nothing supplies a default bound.
    expect(await runRequest(s.binding, probe({ key: "k-early", sources: ["early"] }).plan)).toMatchObject({ status: "accepted" })

    // The key that refused is free, and so is the message it would have used.
    expect(await runRequest(s.binding, probe({ sources: ["h2"] }).plan)).toMatchObject({ status: "accepted" })
    expect(await s.count("tool_invocation")).toBe(2)
    // An action that cites nothing is one that does not need the owner's words: the helper adds no default.
    expect(await runRequest(s.binding, probe({ key: "k-no-words", sources: [] }).plan)).toMatchObject({ status: "accepted" })
    expect((await s.su`select detail ->> 'by' as who from ledger_event where subject = 'probe:k-no-words'`)[0].who).toBe("")
  } finally { await s.close() }
})

test("H3 the tools the model is offered are unchanged, and an action nobody registered is refused by name", async () => {
  const s = await ownerConversation()
  try {
    expect(TOOLS.map(tool => tool.name)).toEqual(["hub_topic"])
    expect(TOOLS[0].inputSchema.additionalProperties).toBe(false)
    expect(Object.keys(TOOLS[0].inputSchema.properties).sort()).toEqual(["action", "recovery_decision", "request_key", "source_message_ids"])
    expect(TOOLS[0].inputSchema.properties.action.enum).toEqual(["inspect", "resume"])
    // Nothing that is not listed is offered, and what is asked for anyway is refused by name, before anything is looked at.
    expect(await code(callTool(s.binding, "hub_topic", { action: "stop", request_key: "k", source_message_ids: ["h1"] }))).toBe("unsupported_action")
    expect(await code(callTool(s.binding, "hub_topic", { action: "toString" }))).toBe("unsupported_action")
    expect(await code(callTool(s.binding, "hub_council", { action: "start" }))).toBe("unknown_tool")
    expect(await code(callTool(s.binding, "constructor", {}))).toBe("unknown_tool")
    expect(await code(callTool(s.binding, "hub_topic", { action: "inspect", person: "p2" }))).toBe("invalid_arguments")
    expect(await code(callTool(s.binding, "hub_topic", { action: "inspect", request_key: "k" }))).toBe("invalid_arguments")
    expect([await s.count("tool_invocation"), await s.count("source_consumption")]).toEqual([0, 0])
  } finally { await s.close() }
})

test("H4 the same key and arguments under ANOTHER tool is a conflict before anything is looked up, spent or applied, and the first tool's recorded answer replays unchanged", async () => {
  const s = await ownerConversation()
  try {
    await s.human("h2")
    const first = probe()
    const reply = await runRequest(s.binding, first.plan)
    const recorded = async () => JSON.stringify({ ...(await s.su`select tool, action, payload_hash, result from tool_invocation`)[0] })
    const before = await recorded()
    // The hash is of the request alone, and it is the hash the store always recorded: replays of what is already stored do not move.
    expect((await s.su`select payload_hash from tool_invocation`)[0].payload_hash).toBe(digest(canonical(first.plan.request)))

    // A second tool whose request has the same shape (an action and a key) meets the key as taken, and nothing of it runs.
    const other = probe()
    other.plan.tool = "hub_other"
    expect(await code(runRequest(s.binding, other.plan))).toBe("idempotency_conflict")
    expect(other.calls, "not looked up and not applied").toEqual({ open: 0, apply: 0 })
    expect([await s.count("tool_invocation"), await s.count("source_consumption"), await s.probed("k1")], "and it spent nothing").toEqual([1, 1, 1])
    expect(await recorded(), "the recorded call and its answer are exactly what they were").toBe(before)

    // The tool that made the call is still told its own answer, byte for byte.
    const again = probe()
    expect(await runRequest(s.binding, again.plan)).toEqual(reply)
    expect(again.calls).toEqual({ open: 0, apply: 0 })
    expect(await recorded()).toBe(before)
    // A key that is taken by another tool is not free for it either, with the arguments changed.
    const changed = probe({ note: "another" })
    changed.plan.tool = "hub_other"
    expect(await code(runRequest(s.binding, changed.plan))).toBe("idempotency_conflict")
  } finally { await s.close() }
})

test("H5 an operation id is made of the origin conversation and the request, cannot be confused with another, and a repeat cycle is a different operation", async () => {
  const same = operationId({ conversation: "c1", request: "stop-1" })
  expect(operationId({ conversation: "c1", request: "stop-1" }), "deterministic").toBe(same)
  // The same key in two conversations is two operations, and so is every pair whose parts only run together the same way.
  const origins = [
    { conversation: "c1", request: "stop-1" }, { conversation: "c2", request: "stop-1" }, { conversation: "c1", request: "stop-2" },
    { conversation: "c1", request: "stop-1", epoch: 0 }, { conversation: "c1", request: "stop-1", epoch: 1 }, { conversation: "c1", request: "stop-1", epoch: 2 },
    { conversation: "c1", request: "stop-1:e1" }, { conversation: "a:1:b", request: "c" }, { conversation: "a", request: "1:b:c" },
    { conversation: "a:1", request: "b:1:c" }, { conversation: "a", request: "1:b:1:c" }, { conversation: "op1:2:c1", request: "stop-1" },
  ]
  expect(new Set(origins.map(operationId)).size, "no two origins share an id").toBe(origins.length)
  expect(() => operationId({ conversation: "", request: "k" })).toThrow()
  expect(() => operationId({ conversation: "c1", request: "" })).toThrow()
  expect(() => operationId({ conversation: "c1", request: "k", epoch: -1 })).toThrow()
  expect(() => operationId({ conversation: "c1", request: "k", epoch: 1.5 })).toThrow()
  // The helper a handler calls is the same thing, from what the runner bound the call to.
  const binding = { conversation: "c1" } as McpBinding
  expect(operationFor(binding, { request_key: "stop-1" })).toBe(same)
  expect(operationFor(binding, { request_key: "stop-1" }, 2)).toBe(operationId({ conversation: "c1", request: "stop-1", epoch: 2 }))
})

// ---------------------------------------------------------------------------
// G. Claim gates.
// ---------------------------------------------------------------------------

test("G1 a row gate, an agent gate and a conversation gate each refuse NEW claims on every path that claims, and nothing else", async () => {
  const s = await stage()
  await s.incarnate("runner-a", "one")
  await s.human("h1"); await s.human("h2"); await s.human("o1", "p1-other")
  await s.harvest("harvest:1")
  const master = await s.master("h1")
  const raw = (id: string) => s.runner.sql`update inbound set claimed_by = 'an-old-runner', claim_deadline = now() + interval '1 minute' where id = ${id}`.execute()
  expect(await claimable(s, "p1-lair")).toEqual(["h1", "h2", "harvest:1"])

  // ROW. One input, on every path: the runner's read, its claim, and the table's own fence for a runner that predates them.
  expect(await placeGate(s.door, { operation: "op-row", scope: { kind: "row", id: "h1" }, cause: "council" })).toBe("open")
  expect(await claimable(s, "p1-lair")).toEqual(["h2", "harvest:1"])
  expect(await tryClaim(s, "p1-lair")).toBe("h2")
  await expect(raw("h1")).rejects.toThrow(/not claimable/)
  expect((await s.su`select hub_row_held('h1') as held, hub_row_held('h2') as other`)[0]).toMatchObject({ held: true, other: false })
  await releaseGates(s.door, { operation: "op-row" })

  // AGENT. Every input of that agent, a scheduled harvest included; another agent is not asked.
  await placeGate(s.door, { operation: "op-agent", scope: { kind: "agent", id: "p1-lair" }, cause: "archive" })
  expect(await claimable(s, "p1-lair")).toEqual([])
  expect(await tryClaim(s, "p1-lair")).toBeNull()
  for (const id of ["h1", "h2", "harvest:1"]) await expect(raw(id), id).rejects.toThrow(/not claimable/)
  expect(await claimable(s, "p1-other")).toEqual(["o1"])
  expect(await tryClaim(s, "p1-other")).toBe("o1")
  await releaseGates(s.door, { operation: "op-agent" })
  expect(await claimable(s, "p1-lair")).toEqual(["h1", "h2", "harvest:1"])

  // CONVERSATION. The master's own inputs; a scheduled harvest is nobody's turn, so it is not this gate's (a worker's is G2).
  await placeGate(s.door, { operation: "op-master", scope: { kind: "conversation", id: master.id }, cause: "move" })
  expect(await claimable(s, "p1-lair"), "only the harvest, which is no conversation's turn").toEqual(["harvest:1"])
  await expect(raw("h1")).rejects.toThrow(/not claimable/)
  await releaseGates(s.door, { operation: "op-master" })

  // Nothing above is an answer: no input was stamped answered to make waiting work look finished.
  expect(await s.su`select id from inbound where state = 'answered'`).toHaveLength(0)
  expect(await s.su`select 1 from ledger_event where kind = 'answered'`).toHaveLength(0)
})

test("G2 a conversation gate holds a worker's own job and a follow-up that names its conversation, and not another conversation", async () => {
  const s = await stage()
  await s.incarnate("runner-a", "one")
  const first = await s.job("ja", "p1-worker")
  const convA = await s.worker("ja", first)
  await s.job("ja-follow", "p1-worker", convA.id)
  const other = await s.job("jb", "p1-worker")
  await s.worker("jb", other)
  expect(await claimable(s, "p1-worker")).toEqual(["ja", "ja-follow", "jb"])
  await placeGate(s.door, { operation: "op-conv", scope: { kind: "conversation", id: convA.id }, cause: "council" })
  expect(await claimable(s, "p1-worker")).toEqual(["jb"])
  await releaseGates(s.door, { operation: "op-conv" })
  expect(await claimable(s, "p1-worker")).toEqual(["ja", "ja-follow", "jb"])
})

test("G3 a gate makes the council's grace and the table's fence say no too: a gated seat is not abandoned, and nothing is stamped answered", async () => {
  const s = await stage()
  await s.job("seat", "p1-worker")
  await placeGate(s.door, { operation: "op-council", scope: { kind: "agent", id: "p1-worker" }, cause: "council" })
  const abandon = async () => (await s.door.sql`select hub_council_abandon('seat', 'the council is late') as done`)[0].done
  expect(await abandon(), "the seat is held, and abandoning it would stamp answered work nobody answered").toBe(false)
  expect((await s.su`select state from inbound where id = 'seat'`)[0].state).not.toBe("answered")
  expect(await s.su`select 1 from ledger_event where subject = 'seat' and kind in ('answered', 'dispatch.abandoned')`).toHaveLength(0)
  await releaseGates(s.door, { operation: "op-council" })
  expect(await abandon(), "released, it is what the grace was always for").toBe(true)
})

test("G4 a gate is owned by its operation: the same request is one gate, a replay after release does not reopen it, another cause is refused, and one operation's release opens nothing of another's", async () => {
  const s = await stage()
  await s.incarnate("runner-a", "one")
  await s.human("h1"); await s.human("h2"); await s.human("o1", "p1-other")
  const agent = (id: string) => ({ kind: "agent" as const, id })

  // One operation, one scope: a gate. Asking again is the same gate.
  expect(await placeGate(s.door, { operation: "op-a", scope: agent("p1-lair"), cause: "archive", evidence: { messages: ["h9"] } })).toBe("open")
  expect(await placeGate(s.door, { operation: "op-a", scope: agent("p1-lair"), cause: "archive" })).toBe("open")
  expect(await gatesOn(s.hub, agent("p1-lair"))).toEqual([expect.objectContaining({ operation: "op-a", cause: "archive", state: "open", evidence: { messages: ["h9"] } })])
  await expect(placeGate(s.door, { operation: "op-a", scope: agent("p1-lair"), cause: "move" })).rejects.toMatchObject({ refusal: "gate-conflict" })
  await expect(placeGate(s.door, { operation: "op-a", scope: { kind: "row", id: "no-such-row" }, cause: "archive" })).rejects.toBeInstanceOf(ControlRefused)
  await expect(placeGate(s.door, { operation: "op-a", scope: { kind: "conversation", id: "no-such" }, cause: "archive" })).rejects.toMatchObject({ refusal: "gate-scope-unknown" })

  // Two operations on one scope: releasing one leaves it closed, and a scope it never had is nothing to release.
  await placeGate(s.door, { operation: "op-b", scope: agent("p1-lair"), cause: "council" })
  await placeGate(s.door, { operation: "op-b", scope: agent("p1-other"), cause: "council" })
  expect(await releaseGates(s.door, { operation: "op-a" })).toBe(1)
  expect(await releaseGates(s.door, { operation: "op-a" }), "a repeat releases nothing").toBe(0)
  expect(await claimable(s, "p1-lair"), "op-b still holds it").toEqual([])
  expect(await releaseGates(s.door, { operation: "op-b", scope: agent("p1-nobody") })).toBe(0)
  expect(await claimable(s, "p1-lair")).toEqual([])
  // Targeted: only the scope named.
  expect(await releaseGates(s.door, { operation: "op-b", scope: agent("p1-other") })).toBe(1)
  expect(await claimable(s, "p1-other")).toEqual(["o1"])
  expect(await claimable(s, "p1-lair"), "the other scope of the same operation is still closed").toEqual([])
  expect(await releaseGates(s.door, { operation: "op-b" })).toBe(1)
  expect(await claimable(s, "p1-lair")).toEqual(["h1", "h2"])

  // A gate that was released stays released: a replayed request does not hold work its operation finished with.
  expect(await placeGate(s.door, { operation: "op-a", scope: agent("p1-lair"), cause: "archive" })).toBe("released")
  expect(await claimable(s, "p1-lair")).toEqual(["h1", "h2"])
  // And the store says so itself.
  await expect(s.su`update claim_gate set state = 'open', released_at = null where operation_id = 'op-a'`.execute()).rejects.toThrow(/stays so|released/)
  await expect(s.su`update claim_gate set cause = 'other' where operation_id = 'op-b'`.execute()).rejects.toThrow(/none of them changes/)
})

test("G5 a release moves no replay hold, and a gate never interrupts an attempt that already owns the agent", async () => {
  const s = await stage()
  await s.incarnate("runner-a", "one")
  await s.human("h1"); await s.human("h2"); await s.human("h3")
  const conversation = await s.master("h1")
  await s.claim("h1", "runner-a")
  const attempt = await openExecution(s.runner, { row: { id: "h1", agent: "p1-lair" }, conversation, runner: "runner-a", incarnation: "one", digest: "d", nativeSession: null })
  await markFeedIntent(s.runner, attempt, "body of h1")

  // A gate over the agent, the row and the conversation while the attempt runs: it is not touched.
  for (const scope of [{ kind: "agent" as const, id: "p1-lair" }, { kind: "row" as const, id: "h1" }, { kind: "conversation" as const, id: conversation.id }]) {
    await placeGate(s.door, { operation: `op-${scope.kind}`, scope, cause: "archive" })
  }
  expect((await readExecution(s.runner, attempt.id))?.state, "a gate is not a stop").toBe("feed_intent")
  expect((await s.su`select claimed_by from inbound where id = 'h1'`)[0].claimed_by, "and does not release its claim").toBe("runner-a")
  expect(await s.su`select 1 from stop_request`).toHaveLength(0)

  // The attempt ends unfinished: its input is held for its owner. Releasing every gate does not release that.
  await endAttempt(s.runner, { execution: attempt.id, evidence: GONE, cause: "gone" })
  const hold = async () => ({ ...(await s.su`select state, revision, cause from replay_hold where inbound_id = 'h1'`)[0] })
  expect(await hold()).toEqual({ state: "held", revision: 1, cause: "interrupted" })
  for (const kind of ["agent", "row", "conversation"]) expect(await releaseGates(s.door, { operation: `op-${kind}` })).toBe(1)
  expect(await hold(), "the owner's hold is not a gate's to lift").toEqual({ state: "held", revision: 1, cause: "interrupted" })
  expect((await s.su`select hub_row_held('h1') as held`)[0].held).toBe(true)
  expect(await tryClaim(s, "p1-lair"), "the next input is claimable once nothing gates it").toBe("h2")
  // A gate on the held row itself, released, leaves the hold exactly as it was.
  await placeGate(s.door, { operation: "op-again", scope: { kind: "row", id: "h1" }, cause: "council" })
  await releaseGates(s.door, { operation: "op-again" })
  expect(await hold()).toEqual({ state: "held", revision: 1, cause: "interrupted" })
})

test("G6 the routines are the only writers: the runner, the door and the hub read both tables and change neither directly, and a model's role holds nothing", async () => {
  const s = await stage()
  await s.human("h1")
  const can = async (role: string, table: string, privilege: string) =>
    (await s.su.unsafe(`select has_table_privilege('${role}', '${table}', '${privilege}') as yes`))[0].yes as boolean
  for (const role of ["hub_runner", "hub_door", "hub_hub"]) {
    for (const table of ["claim_gate", "stop_request"]) {
      expect(await can(role, table, "select"), `${role} reads ${table}`).toBe(true)
      for (const privilege of ["insert", "update", "delete"]) expect(await can(role, table, privilege), `${role} ${privilege} ${table}`).toBe(false)
    }
  }
  for (const table of ["claim_gate", "stop_request"]) {
    for (const privilege of ["select", "insert", "update", "delete"]) expect(await can("hub_agent", table, privilege), `hub_agent ${privilege} ${table}`).toBe(false)
  }
  const routines = ["hub_gate_place(text,text,text,text,jsonb)", "hub_gate_release(text,text,text)", "hub_stop_request(text,text,text,text,text,jsonb)", "hub_stop_settle(text)",
    "hub_gate_order(text)", "hub_open_order(text,text,text)"]
  for (const routine of routines) {
    for (const role of ["hub_runner", "hub_door", "hub_hub"]) {
      expect((await s.su.unsafe(`select has_function_privilege('${role}', '${routine}', 'execute') as yes`))[0].yes, `${role} runs ${routine}`).toBe(true)
    }
    expect((await s.su.unsafe(`select has_function_privilege('hub_agent', '${routine}', 'execute') as yes`))[0].yes, `hub_agent runs ${routine}`).toBe(false)
  }
  // The direct writes are refused on the role's own connection, and the routine does the same thing.
  await expect(s.runner.sql`insert into claim_gate (operation_id, scope_kind, scope_id, cause) values ('x', 'agent', 'p1-lair', 'archive')`.execute()).rejects.toThrow()
  await placeGate(s.runner, { operation: "x", scope: { kind: "agent", id: "p1-lair" }, cause: "archive" })
  await expect(s.runner.sql`update claim_gate set state = 'released', released_at = now() where operation_id = 'x'`.execute()).rejects.toThrow()
  const made = await requestStop(s.runner, { operation: "x", target: { agent: "p1-lair" }, by: "test" })
  await expect(s.runner.sql`update stop_request set state = 'stopped' where id = ${made.id}`.execute()).rejects.toThrow()
  await expect(s.runner.sql`delete from stop_request where id = ${made.id}`.execute()).rejects.toThrow()
})

test("G7 placing a gate and opening an attempt are ordered, in either order and for an input's attempt and for a tail: a gate committed first refuses the opening, an opening committed first is seen by whoever placed the gate", async () => {
  const s = await stage()
  await s.incarnate("runner-a", "one")
  await s.human("h1")
  const conversation = await s.master("h1")
  const agent = { kind: "agent" as const, id: "p1-lair" }
  const isWaiting = waiting(s.db)
  const opening = {
    input: () => openExecution(s.runner, { row: { id: "h1", agent: "p1-lair" }, conversation, runner: "runner-a", incarnation: "one", digest: "d", nativeSession: null }),
    tail: () => openTailExecution(s.runner, { agent: "p1-lair", conversation, runner: "runner-a", incarnation: "one", digest: "t", nativeSession: null }),
  }
  const owned = async () => (await attemptsOf(s.hub, { agent: "p1-lair" }, { ownedOnly: true })).map(view => [view.purpose, view.state])
  const reset = async () => { // nothing of one round is left for the next
    for (const view of await attemptsOf(s.hub, { agent: "p1-lair" }, { ownedOnly: true })) {
      await endAttempt(s.runner, { execution: view.execution, evidence: GONE, cause: "the round is over" })
    }
    await s.claim("h1", "runner-a")
  }
  await s.claim("h1", "runner-a")

  for (const kind of ["input", "tail"] as const) {
    // ORDER ONE, gate first. Committed before the opening starts: refused by name, nothing inserted, the claim untouched.
    await placeGate(s.door, { operation: `op-first-${kind}`, scope: agent, cause: "archive" })
    await expect(opening[kind](), `${kind}: a gate over the agent`).rejects.toMatchObject({ name: "ExecutionNotOwned", reason: "gate" })
    expect(await owned()).toEqual([])
    expect((await s.su`select claimed_by from inbound where id = 'h1'`)[0].claimed_by).toBe("runner-a")
    await releaseGates(s.door, { operation: `op-first-${kind}` })
    // Every scope a gate can have is read by an input's opening; a row has no place in a tail's.
    await placeGate(s.door, { operation: `op-conv-${kind}`, scope: { kind: "conversation", id: conversation.id }, cause: "move" })
    await expect(opening[kind](), `${kind}: a gate over the conversation`).rejects.toMatchObject({ reason: "gate" })
    await releaseGates(s.door, { operation: `op-conv-${kind}` })
    await placeGate(s.door, { operation: `op-row-${kind}`, scope: { kind: "row", id: "h1" }, cause: "council" })
    if (kind === "input") await expect(opening.input(), "input: a gate over the row").rejects.toMatchObject({ reason: "gate" })
    else await expect(opening.tail().then(async made => { await endAttempt(s.runner, { execution: made.id, evidence: GONE, cause: "done" }) }), "tail: a row's gate is not its business").resolves.toBeUndefined()
    await releaseGates(s.door, { operation: `op-row-${kind}` })

    // ORDER TWO, concurrent, the gate BEHIND the opening. The opening has the ordering lock and is held in its insert.
    const lock = await lockTable(cluster, s.db, "execution", "exclusive")
    const inserting = opening[kind]()
    await waitForLockWaiter(cluster, s.db, { role: "hub_runner", relation: "execution", timeoutMs: 15_000 })
    const placing = placeGate(s.door, { operation: `op-behind-${kind}`, scope: agent, cause: "archive" })
    expect(await isWaiting("hub_door"), "the gate waits for the opening that is ahead of it").toBe(true)
    expect(await pending(placing)).toBe("pending")
    await lock.release()
    const made = await inserting
    expect(await placing).toBe("open")
    // The consumer that placed the gate looks after it committed: the attempt the opening made is there, and it is not "nothing was running".
    expect(await owned(), `${kind}: seen by whoever placed the gate`).toEqual([[kind === "tail" ? "tail" : "turn", "claimed"]])
    expect((await attemptsOf(s.hub, { agent: "p1-lair" }, { ownedOnly: true }))[0].execution).toBe(made.id)
    // And a stop asked in the same breath sees it too, instead of answering that nothing was owned.
    expect(await requestStop(s.hub, { operation: `op-stop-${kind}`, target: { agent: "p1-lair" }, by: "test" })).toMatchObject({ execution: made.id })
    await releaseGates(s.door, { operation: `op-behind-${kind}` })
    await reset()

    // ORDER THREE, concurrent, the gate AHEAD of the opening. The gate holds the ordering lock and is not yet committed.
    const order = await holdOrder(s.db, "p1-lair")
    const late = opening[kind]()
    late.catch(() => {})
    expect(await isWaiting("hub_runner"), "the opening waits for the gate that is ahead of it").toBe(true)
    expect(await pending(late)).toBe("pending")
    await order.gate(`op-ahead-${kind}`, "agent", "p1-lair", "archive")
    await order.commit()
    await expect(late, `${kind}: it read the gate after the lock, not before`).rejects.toMatchObject({ reason: "gate" })
    expect(await owned(), "and nothing was inserted after the gate committed").toEqual([])
    await releaseGates(s.door, { operation: `op-ahead-${kind}` })
    // Released, the same opening goes through: a gate refuses while it is open and no longer.
    const after = await opening[kind]()
    expect(after.state).toBe("claimed")
    await reset()
  }
})

// ---------------------------------------------------------------------------
// S. Stop requests as a store rule.
// ---------------------------------------------------------------------------

test("S1 a stop request is frozen to one attempt, says only what that attempt says, and neither a repeat nor a newer attempt changes it", async () => {
  const s = await stage()
  await s.incarnate("runner-a", "one")
  for (const id of ["h1", "h2", "h3", "h4", "h5"]) await s.human(id)
  const conversation = await s.master("h1")
  const open = async (id: string) => {
    await s.claim(id, "runner-a")
    return await openExecution(s.runner, { row: { id, agent: "p1-lair" }, conversation, runner: "runner-a", incarnation: "one", digest: `d-${id}`, nativeSession: null })
  }
  const request = async (operation: string, target: Parameters<typeof requestStop>[1]["target"]) => await requestStop(s.hub, { operation, target, by: "test:handler" })

  const a = await open("h1")
  await markFeedIntent(s.runner, a, "body of h1")
  const made = await request("op-1", { execution: a.id })
  expect(made).toMatchObject({ state: "requested", outcome: null, execution: a.id, conversation: conversation.id, agent: "p1-lair", runner: "runner-a",
    incarnation: "one", placement_generation: 1, conversation_generation: 1, by: "test:handler" })
  expect(describeStop(made)).toMatchObject({ status: "queued", stage: "stop_requested" })
  expect((await request("op-1", { execution: a.id })).id, "the same operation and target is one request").toBe(made.id)
  expect(await stopsOf(s.hub, "op-1")).toHaveLength(1)
  const standing = async (id = made.id) => ({ ...(await s.su`select state, outcome from stop_request where id = ${id}`)[0] })

  // What the runner does, in the order it does it. The request follows the attempt and nothing else.
  await s.runner.sql`update execution set state = 'stop_requested' where id = ${a.id} and state in ('feed_intent', 'received', 'running')`
  expect(await standing()).toEqual({ state: "stopping", outcome: "stop_requested" })
  expect(describeStop({ state: "stopping", outcome: "stop_requested" }).message, "not called stopped while it is not shown").toContain("not shown to be gone")
  expect((await endAttempt(s.runner, { execution: a.id, evidence: NOT_GONE, cause: "stop requested", requested: true })).state).toBe("stop_unknown")
  expect(await standing(), "silence, a grace that ran out: nothing shows it is gone").toEqual({ state: "unknown", outcome: "stop_unknown" })
  expect(describeStop({ state: "unknown", outcome: "stop_unknown" })).toMatchObject({ status: "unknown" })
  expect((await s.su`select hub_agent_blocked('p1-lair') as blocked`)[0].blocked, "and the agent stays blocked").toBe(true)
  expect((await s.su`select cause from replay_hold where inbound_id = 'h1'`)[0].cause).toBe("ownership-unknown")
  // Only proof moves an unproved end.
  await endAttempt(s.runner, { execution: a.id, evidence: GONE, cause: "the process tree is gone" })
  expect(await standing()).toEqual({ state: "stopped", outcome: "stopped" })
  expect(describeStop({ state: "stopped", outcome: "stopped" })).toMatchObject({ status: "stopped" })
  expect((await s.su`select hub_agent_blocked('p1-lair') as blocked`)[0].blocked).toBe(false)
  expect((await s.su`select cause, state from replay_hold where inbound_id = 'h1'`)[0]).toMatchObject({ cause: "stopped", state: "held" })
  await expect(s.su`update stop_request set state = 'unknown' where id = ${made.id}`.execute()).rejects.toThrow(/stays so/)
  await expect(s.su`update stop_request set execution_id = null, runner = null, incarnation = null, agent = null, conversation_id = null where id = ${made.id}`.execute()).rejects.toThrow(/frozen/)

  // A NEWER attempt of the same conversation is not this request's: a repeat is the same row, whatever happened since.
  const c = await open("h2")
  expect(await request("op-1", { execution: a.id })).toMatchObject({ id: made.id, state: "stopped", execution: a.id })
  expect((await attemptsOf(s.hub, { conversation: conversation.id })).map(view => [view.execution, view.state, view.owned, view.stops.map(one => one.state)]))
    .toEqual([[c.id, "claimed", true, []], [a.id, "stopped", false, ["stopped"]]])
  expect((await readExecution(s.runner, c.id))?.state).toBe("claimed")

  // "Whatever this conversation owns now" is resolved ONCE, at the request: a repeat after that attempt ended still means that attempt.
  const now = await request("op-2", { conversation: conversation.id })
  expect(now).toMatchObject({ execution: c.id, state: "requested", target: { conversation: conversation.id } })
  await markFeedIntent(s.runner, c, "body of h2")
  await endAttempt(s.runner, { execution: c.id, evidence: GONE, cause: "gone" })
  const d = await open("h3")
  expect(await request("op-2", { conversation: conversation.id })).toMatchObject({ id: now.id, execution: c.id, state: "moot", outcome: "interrupted" })
  expect((await attemptsOf(s.hub, { conversation: conversation.id })).find(view => view.execution === d.id)!.stops, "the newer attempt was never a target").toEqual([])
  // The agent's own way of asking is the same.
  expect(await request("op-agent", { agent: "p1-lair" })).toMatchObject({ execution: d.id, state: "requested" })

  // An attempt that finished with its own result before the stop landed keeps it: the request says it was settled, not stopped.
  await markFeedIntent(s.runner, d, "body of h3")
  await journalResult(s.runner, d.id, { text: "the answer", chunks: ["the answer"], turn: TURN })
  await completeExecution(s.runner, { execution: d.id, runner: "runner-a", reply: null, fence: { recovery: true } })
  expect(await standing((await stopsOf(s.hub, "op-agent"))[0].id)).toEqual({ state: "settled", outcome: "completed" })
  expect((await readExecution(s.runner, d.id))).toMatchObject({ state: "completed", result: { text: "the answer" } })
  // And a request made after the fact is answered at once, from what the attempt is.
  expect(await request("op-late", { execution: d.id })).toMatchObject({ state: "settled", outcome: "completed" })
  expect(describeStop({ state: "settled", outcome: "completed" })).toMatchObject({ status: "complete", stage: "already_finished" })

  // Nothing owned is a request that is nothing, for good, and says so. An unknown target is refused by name.
  const none = await request("op-none", { agent: "p1-nobody" })
  expect(none).toMatchObject({ state: "moot", outcome: "no_attempt", execution: null, runner: null })
  expect(describeStop(none).message).toContain("Nothing was running")
  await expect(request("op-x", { execution: "no-such-attempt" })).rejects.toMatchObject({ refusal: "stop-target-unknown" })
  await expect(request("op-y", { conversation: "no-such-conversation" })).rejects.toBeInstanceOf(ControlRefused)
})

test("S2 a stop that meets a result which landed first leaves the result: the request is settled, not stopped", async () => {
  const s = await stage()
  await s.incarnate("runner-a", "one")
  await s.human("h1")
  const conversation = await s.master("h1")
  await s.claim("h1", "runner-a")
  const attempt = await openExecution(s.runner, { row: { id: "h1", agent: "p1-lair" }, conversation, runner: "runner-a", incarnation: "one", digest: "d", nativeSession: null })
  await markFeedIntent(s.runner, attempt, "body of h1")
  const made = await requestStop(s.hub, { operation: "op-race", target: { execution: attempt.id }, by: "test" })
  // The model finished, and its answer is kept before the stop is read.
  await journalResult(s.runner, attempt.id, { text: "the answer", chunks: ["the answer"], turn: TURN })
  await s.runner.sql`update execution set state = 'stop_requested' where id = ${attempt.id}`
  // The runner's own end of an attempt with a kept answer does not turn it into an interruption.
  expect((await endAttempt(s.runner, { execution: attempt.id, evidence: GONE, cause: "stop requested", requested: true })).state).toBe("journaled")
  expect((await readExecution(s.runner, attempt.id))?.state).toBe("stop_requested")
  expect(await s.su`select 1 from replay_hold`).toHaveLength(0)
  await completeExecution(s.runner, { execution: attempt.id, runner: "runner-a", reply: "the answer", fence: { recovery: true } })
  expect((await stopsOf(s.hub, "op-race"))[0]).toMatchObject({ id: made.id, state: "settled", outcome: "completed" })
  expect((await s.su`select kind, body from conversation_entry where conversation_id = ${conversation.id} and kind = 'reply'`)[0]).toMatchObject({ body: "the answer" })
})

test("S3 two conversations that used the same request key own separate gates and stops, releasing one leaves the other closed, and a later cycle neither reuses a released gate nor an old stop", async () => {
  const s = await stage()
  await s.incarnate("runner-a", "one")
  for (const id of ["h1", "h2", "h3"]) await s.human(id)
  await s.human("o1", "p1-other")
  const origin = await s.master("h1")
  const another = await s.master("o1", "p1-other")
  const lair = { kind: "agent" as const, id: "p1-lair" }
  const key = "stop-1"
  const [opA, opB] = [operationId({ conversation: origin.id, request: key }), operationId({ conversation: another.id, request: key })]
  expect(opA).not.toBe(opB)

  // Two operations over one scope, each with its own cause: the bare key would have made the second a false conflict.
  expect(await placeGate(s.door, { operation: opA, scope: lair, cause: "council" })).toBe("open")
  expect(await placeGate(s.door, { operation: opB, scope: lair, cause: "archive" })).toBe("open")
  expect((await gatesOn(s.hub, lair)).map(gate => [gate.operation, gate.cause]).sort()).toEqual([[opA, "council"], [opB, "archive"]].sort())
  expect(await releaseGates(s.door, { operation: opA })).toBe(1)
  expect(await claimable(s, "p1-lair"), "the other conversation's operation still holds the scope").toEqual([])
  expect(await releaseGates(s.door, { operation: opB })).toBe(1)
  expect(await claimable(s, "p1-lair")).toEqual(["h1", "h2", "h3"])

  // Stop requests: the same key, the same target, two operations, two requests (the bare key would have returned the first one twice).
  await s.claim("h1", "runner-a")
  const first = await openExecution(s.runner, { row: { id: "h1", agent: "p1-lair" }, conversation: origin, runner: "runner-a", incarnation: "one", digest: "d1", nativeSession: null })
  await markFeedIntent(s.runner, first, "body of h1")
  const stopA = await requestStop(s.hub, { operation: opA, target: { agent: "p1-lair" }, by: "test" })
  const stopB = await requestStop(s.hub, { operation: opB, target: { agent: "p1-lair" }, by: "test" })
  expect(stopA.id).not.toBe(stopB.id)
  expect([stopA.execution, stopB.execution]).toEqual([first.id, first.id])
  expect([(await stopsOf(s.hub, opA)).length, (await stopsOf(s.hub, opB)).length]).toEqual([1, 1])

  // A second cycle of the same request. The first attempt is over, a newer one runs, and the first cycle's gate is released for good.
  await endAttempt(s.runner, { execution: first.id, evidence: GONE, cause: "gone" })
  await s.claim("h2", "runner-a")
  const second = await openExecution(s.runner, { row: { id: "h2", agent: "p1-lair" }, conversation: origin, runner: "runner-a", incarnation: "one", digest: "d2", nativeSession: null })
  await markFeedIntent(s.runner, second, "body of h2")
  expect(await placeGate(s.door, { operation: opA, scope: lair, cause: "council" }), "the same operation again is the same, released, gate").toBe("released")
  const cycle = operationId({ conversation: origin.id, request: key, epoch: 2 })
  expect(await placeGate(s.door, { operation: cycle, scope: lair, cause: "council" }), "another cycle is its own gate and it is closed").toBe("open")
  expect((await gatesOn(s.hub, lair)).map(gate => [gate.operation === cycle ? "cycle" : "old", gate.state]).sort())
    .toEqual([["cycle", "open"], ["old", "released"], ["old", "released"]])
  expect(await tryClaim(s, "p1-other"), "another agent's scope is not touched by the cycle").toBe("o1")
  const stopCycle = await requestStop(s.hub, { operation: cycle, target: { agent: "p1-lair" }, by: "test" })
  expect(stopCycle).toMatchObject({ execution: second.id, state: "requested" })
  expect(await requestStop(s.hub, { operation: opA, target: { agent: "p1-lair" }, by: "test" }), "the first cycle's request is still about the first attempt")
    .toMatchObject({ id: stopA.id, execution: first.id })
})

// ---------------------------------------------------------------------------
// M. The migration.
// ---------------------------------------------------------------------------

test("M1 an upgraded store carries the same gate, stop and claim objects, checks and grants as a fresh one, and applying the step again changes nothing", async () => {
  const upgraded = await rolloutDatabase(cluster, true)
  const fresh = await rolloutDatabase(cluster)
  track(upgraded.sql); track(fresh.sql)
  const applier = () => { const opened = upgraded.store(); track(opened.sql); return opened }
  await migrate(applier())
  await migrate(applier())
  const read = async (q: any) => ({
    functions: Array.from(await q`select p.proname, pg_get_function_identity_arguments(p.oid) as args, r.rolname as owner, p.prosecdef, p.prosrc
      from pg_proc p join pg_roles r on r.oid = p.proowner
      where p.proname in ('hub_row_held', 'hub_row_conversation', 'hub_gate_place', 'hub_gate_release', 'hub_guard_claim_gate', 'hub_stop_request',
                          'hub_stop_settle', 'hub_stop_state', 'hub_guard_stop_request', 'hub_notify_stop', 'hub_stop_follows_execution',
                          'hub_gate_covers', 'hub_gate_order', 'hub_open_order')
      order by p.proname`),
    columns: Array.from(await q`select table_name, column_name, data_type, is_nullable, column_default from information_schema.columns
      where table_name in ('claim_gate', 'stop_request') order by table_name, ordinal_position`),
    indexes: Array.from(await q`select indexname, indexdef from pg_indexes where tablename in ('claim_gate', 'stop_request') order by indexname`),
    checks: Array.from(await q`select conrelid::regclass::text as t, conname, pg_get_constraintdef(oid) as d from pg_constraint
      where conrelid in ('claim_gate'::regclass, 'stop_request'::regclass) order by conrelid::regclass::text, conname`),
    triggers: Array.from(await q`select t.tgname, pg_get_triggerdef(t.oid) as d from pg_trigger t
      where t.tgname in ('claim_gate_rules', 'stop_request_rules', 'stop_request_notify', 'execution_stop_requests') order by t.tgname`),
    tableGrants: Array.from(await q`select table_name, grantee, privilege_type from information_schema.role_table_grants
      where table_name in ('claim_gate', 'stop_request') and grantee in ('hub_door', 'hub_runner', 'hub_hub', 'hub_agent') order by table_name, grantee, privilege_type`),
    routineGrants: Array.from(await q`select routine_name, grantee from information_schema.routine_privileges
      where routine_name in ('hub_gate_order', 'hub_gate_place', 'hub_gate_release', 'hub_open_order', 'hub_stop_request', 'hub_stop_settle')
        and grantee in ('hub_door', 'hub_runner', 'hub_hub', 'hub_agent')
      order by routine_name, grantee`),
  })
  const a = await read(fresh.sql)
  const b = await read(upgraded.sql)
  expect(a.functions).toHaveLength(14)
  expect(a.triggers.map((row: any) => row.tgname)).toEqual(["claim_gate_rules", "execution_stop_requests", "stop_request_notify", "stop_request_rules"])
  expect(a.checks.length).toBeGreaterThan(8)
  expect(b).toEqual(a)
  expect(a.tableGrants.filter((row: any) => row.privilege_type !== "SELECT"), "nobody writes either table directly").toEqual([])
  expect(a.routineGrants.map((row: any) => `${row.routine_name}:${row.grantee}`)).toEqual([
    "hub_gate_order:hub_door", "hub_gate_order:hub_hub", "hub_gate_order:hub_runner",
    "hub_gate_place:hub_door", "hub_gate_place:hub_hub", "hub_gate_place:hub_runner",
    "hub_gate_release:hub_door", "hub_gate_release:hub_hub", "hub_gate_release:hub_runner",
    "hub_open_order:hub_door", "hub_open_order:hub_hub", "hub_open_order:hub_runner",
    "hub_stop_request:hub_door", "hub_stop_request:hub_hub", "hub_stop_request:hub_runner",
    "hub_stop_settle:hub_door", "hub_stop_settle:hub_hub", "hub_stop_settle:hub_runner",
  ])
  const versions = (await upgraded.sql`select version from schema_version order by version`).map((row: any) => Number(row.version))
  expect(versions).toEqual(MIGRATION_FILES.map(([version]) => version))
  expect(versions.at(-1)).toBe(13)
  expect(versions).toEqual((await fresh.sql`select version from schema_version order by version`).map((row: any) => Number(row.version)))
  // What the step adds to the tables of the step before it is nothing: the rows an upgrade found are the rows it has.
  expect(Number((await upgraded.sql`select count(*)::int as n from inbound`)[0].n)).toBe(1)
  expect(Number((await upgraded.sql`select count(*)::int as n from claim_gate`)[0].n)).toBe(0)
})

test("M2 the fresh schema ends with the migration, byte for byte, and its version, and the migration is registered under its own number", () => {
  const migration = readFileSync(hubPath("src/store/migrations/013-execution-controls.sql"), "utf8")
  const schema = readFileSync(hubPath("src/schema.sql"), "utf8")
  expect(schema.endsWith(`${migration}\ninsert into schema_version (version) values (13);\n`)).toBe(true)
  expect(MIGRATION_FILES.at(-1)).toEqual([13, "013-execution-controls.sql"])
  expect(MIGRATION_FILES.map(([version]) => version)).toEqual(Array.from({ length: 13 }, (_, i) => i + 1))
})

// ---------------------------------------------------------------------------
// R. The runner consuming them, through the real `runRunner`.
// ---------------------------------------------------------------------------

const WORKER = { id: "p1-worker", person: PERSON, preset: "daily", runner: RUNNER, mode: "on-demand", idle_seconds: 1 }

async function stageRunner(options: { worker?: boolean; caps?: Partial<AdapterCapabilities> | null; descendants?: boolean; tick?: number } = {}) {
  const it = await stageHub(cluster, {
    hub: { tick_seconds: options.tick ?? 1 },
    people: [{ id: PERSON, allowed_senders: { [DOOR]: [PERSON] } } as never],
    agents: options.worker ? [WORKER] : [],
  })
  retrySettings(it)
  const caps: AdapterCapabilities | undefined = options.caps === null ? undefined
    : { stableSession: true, safeResume: false, delegationDisabled: true, ...options.caps }
  const edge = controlledAdapter(it.adapterName, options.descendants ?? false, { ...(caps ? { capabilities: caps } : {}) })
  const start = () => runRunner({ runner: RUNNER, registryFile: it.registryFile, adapters: { [it.adapterName]: edge.adapter } })
  const hub = { sql: cluster.connectAs("hub_hub", it.db), url: cluster.url(it.db) } as StoreLike
  const answered = (id: string, ms = 15_000) => observe(async () => (await it.read.inbound()).find(row => row.id === id)?.state === "answered", ms)
  const sessionFed = (id: string) => edge.sessions.find(row => row.fed.some(message => message.id === id))
  const fedCount = (id: string) => edge.sessions.flatMap(row => row.fed).filter(message => message.id === id).length
  const q = async (query: string, values?: unknown[]) => Array.from(await it.read.sql(query, values)) as Record<string, any>[]
  return { it, edge, start, hub, answered, sessionFed, fedCount, q,
    async stop() { await hub.sql.close().catch(() => {}); await edge.stop(); await it.stop() } }
}

test("R1 a stop requested through the store is consumed by the owning runner: intent before the signal, no transaction held while it lasts, and the input is never fed again", async () => {
  const s = await stageRunner({ descendants: true })
  let runner: Awaited<ReturnType<typeof runRunner>> | undefined
  const seen: Record<string, unknown>[] = []
  let interrupts = 0
  s.edge.onStart(row => {
    const inner = row.session.interrupt!
    row.session.interrupt = async (options) => {
      interrupts += 1
      // The moment the signal goes out: what does the store say, and does the runner hold a transaction open?
      const [now] = await s.q(`select e.state as execution, r.state as request from execution e join stop_request r on r.execution_id = e.id where e.inbound_id = 'h1'`)
      const [open] = await s.q(`select count(*)::int as n from pg_stat_activity where usename = 'hub_runner' and datname = current_database() and state like 'idle in transaction%'`)
      seen.push({ ...now, open: open.n })
      await Bun.sleep(1500)
      return await inner(options)
    }
  })
  try {
    runner = await s.start()
    s.edge.hold(message => message.id === "h1")
    await insertInbound(cluster, s.it.db, { id: "h1", body: "long work" })
    expect(await observe(() => s.fedCount("h1") === 1)).toBe(true)
    const target = s.sessionFed("h1")!
    expect(await observe(() => processTree(target.session.pid!).length === 3)).toBe(true)
    const tree = processTree(target.session.pid!)
    const [attempt] = await s.q("select id, conversation_id from execution where inbound_id = 'h1'")

    const asked = performance.now()
    const made = await requestStop(s.hub, { operation: "op-stop-1", target: { execution: attempt.id }, by: "test:handler", evidence: { messages: ["h9"] } })
    expect(performance.now() - asked, "asking returned long before the stop did: nobody waits for a process").toBeLessThan(1000)
    expect(["requested", "stopping"]).toContain(made.state)
    expect(made).toMatchObject({ execution: attempt.id, conversation: attempt.conversation_id, agent: AGENT, runner: RUNNER, placement_generation: 1, evidence: { messages: ["h9"] } })

    expect(await observe(async () => (await stopsOf(s.hub, "op-stop-1"))[0].state === "stopped", 20_000)).toBe(true)
    expect(seen, "asked to stop and committed as such BEFORE the signal, with no transaction held open across it")
      .toEqual([{ execution: "stop_requested", request: "stopping", open: 0 }])
    expect(interrupts).toBe(1)
    expect(tree.every(pid => childGone(pid)), "the loop and both tools exited").toBe(true)
    expect(await s.q("select state from execution where inbound_id = 'h1'")).toEqual([{ state: "stopped" }])
    expect(await s.q("select cause, state from replay_hold")).toEqual([{ cause: "stopped", state: "held" }])
    expect((await stopsOf(s.hub, "op-stop-1"))[0]).toMatchObject({ state: "stopped", outcome: "stopped" })
    // Asking again is the same request, and nothing is signalled twice.
    expect(await requestStop(s.hub, { operation: "op-stop-1", target: { execution: attempt.id }, by: "test:handler" })).toMatchObject({ id: made.id, state: "stopped" })

    // Nothing was replayed: the runner is restarted, and the input the model already had stays held and unanswered.
    await runner.stop()
    runner = await s.start()
    await Bun.sleep(2500)
    expect(interrupts, "a restart signals nothing").toBe(1)
    expect(s.fedCount("h1")).toBe(1)
    expect((await s.it.read.outbox()).some(row => row.inbound_id === "h1")).toBe(false)
    expect((await s.it.read.noticeRows()).filter(row => String(row.notice_key).startsWith("agent-retry"))).toEqual([])
    expect(await s.q("select id from stop_request")).toHaveLength(1)
    expect((await s.q("select hub_row_held('h1') as held"))[0].held).toBe(true)
  } finally { await runner?.stop(); await s.stop() }
}, 90_000)

test("R2 a request frozen to an older attempt cannot stop a newer one: it is settled from what the older attempt is, and the newer one runs on", async () => {
  const s = await stageRunner({ caps: { safeResume: true } })
  let runner: Awaited<ReturnType<typeof runRunner>> | undefined
  try {
    runner = await s.start()
    s.edge.hold(message => message.id === "h1" || message.id === "h2")
    await insertInbound(cluster, s.it.db, { id: "h1", body: "do the risky thing" })
    expect(await observe(() => s.fedCount("h1") === 1)).toBe(true)
    // The engine dies under the first attempt: it is over, and its input is held for its owner.
    s.sessionFed("h1")!.fail()
    expect(await observe(async () => (await s.q("select 1 from replay_hold where inbound_id = 'h1'")).length === 1)).toBe(true)
    const [older] = await s.q("select id, conversation_id, agent, runner, incarnation, placement_generation, state from execution where inbound_id = 'h1'")
    expect(older.state).toBe("interrupted")
    // A newer attempt of the same conversation, on the validated resume.
    await insertInbound(cluster, s.it.db, { id: "h2", body: "what happened?" })
    expect(await observe(() => s.fedCount("h2") === 1, 15_000)).toBe(true)
    const newer = s.sessionFed("h2")!
    const [current] = await s.q("select id, state from execution where inbound_id = 'h2'")
    expect(current.id).not.toBe(older.id)

    // A request made about the older attempt while it was still owned, and never settled (planted: it is what the store holds
    // for a request that was made before the attempt ended and read by a runner that came up after).
    let interrupts = 0
    const inner = newer.session.interrupt!
    newer.session.interrupt = async (options) => { interrupts += 1; return await inner(options) }
    await s.q(`insert into stop_request (id, operation_id, target_kind, target_id, requested_by, execution_id, conversation_id, agent, runner, incarnation,
        placement_generation, conversation_generation, state) values ('stale-1', 'op-stale', 'execution', $1, 'test', $1, $2, $3, $4, $5, $6, 1, 'requested')`,
      [older.id, older.conversation_id, older.agent, older.runner, older.incarnation, older.placement_generation])
    expect(await observe(async () => (await s.q("select state from stop_request where id = 'stale-1'"))[0].state === "moot", 15_000)).toBe(true)
    expect((await s.q("select outcome from stop_request where id = 'stale-1'"))[0].outcome).toBe("interrupted")
    await Bun.sleep(1000)
    expect(interrupts, "the newer attempt was never signalled").toBe(0)
    expect(newer.closed).toBe(false)
    expect((await s.q("select state from execution where inbound_id = 'h2'"))[0].state).toMatch(/feed_intent|received|running/)
    expect(s.fedCount("h2")).toBe(1)
  } finally { await runner?.stop(); await s.stop() }
}, 90_000)

test("R3 a stop asked while its runner was down is reconciled at start without signalling a process nobody holds, and an unproved end stays blocked until it is proved", async () => {
  const s = await stageRunner({ caps: null })
  const engine = livingProcess()
  const detached = livingProcess()
  let runner: Awaited<ReturnType<typeof runRunner>> | undefined
  try {
    await insertInbound(cluster, s.it.db, { id: "h1", body: "a long job" })
    await insertInbound(cluster, s.it.db, { id: "h2", body: "queued behind it" })
    await s.q(`insert into conversation (id, person, agent, kind, adapter, native_session) values ('conv-old', 'p1', 'p1-lair', 'master', $1, $2)`, [s.it.adapterName, crypto.randomUUID()])
    await s.q("update inbound set claimed_by = $1, claim_deadline = now() - interval '1 minute' where id = 'h1'", [RUNNER])
    await s.q(`insert into execution (id, inbound_id, conversation_id, agent, runner, incarnation, placement_generation, state, input_digest, evidence)
      values ('attempt-old', 'h1', 'conv-old', 'p1-lair', $1, 'an-earlier-incarnation', 1, 'running', 'd', $2::jsonb)`,
      [RUNNER, { leader: engine.pid, pids: [engine.pid, detached.pid], group: engine.group }])
    // Asked while nothing is running to answer it: the intent is kept, and nothing is signalled.
    const made = await requestStop(s.hub, { operation: "op-down", target: { execution: "attempt-old" }, by: "test" })
    expect(made).toMatchObject({ state: "requested", runner: RUNNER, incarnation: "an-earlier-incarnation" })

    runner = await s.start()
    expect(await observe(async () => (await s.q("select state from stop_request where id = $1", [made.id]))[0].state === "unknown", 15_000)).toBe(true)
    expect((await s.q("select state from execution where id = 'attempt-old'"))[0].state).toBe("stop_unknown")
    expect(await s.q("select cause, state from replay_hold")).toEqual([{ cause: "ownership-unknown", state: "held" }])
    // Not shown gone, so nothing starts beside it, and nobody signalled a pid that may be another process by now.
    await Bun.sleep(3000)
    expect(s.edge.sessions).toHaveLength(0)
    expect((await s.it.read.inbound()).find(row => row.id === "h2")).toMatchObject({ state: "received", claimed_by: null })
    expect(childGone(engine.pid), "the runner did not touch a process it does not hold").toBe(false)
    expect(childGone(detached.pid)).toBe(false)

    // Only proof moves it. The engine and the tool it left the group with are both gone.
    await engine.stop()
    await Bun.sleep(2000)
    expect((await s.q("select state from stop_request where id = $1", [made.id]))[0].state, "a recorded process that is still there keeps it open").toBe("unknown")
    await detached.stop()
    expect(await observe(async () => (await s.q("select state from stop_request where id = $1", [made.id]))[0].state === "stopped", 15_000)).toBe(true)
    expect((await s.q("select state from execution where id = 'attempt-old'"))[0].state).toBe("stopped")
    expect((await s.q("select cause from replay_hold"))[0].cause).toBe("stopped")
    // The same request again is the recorded one, and there is one.
    expect(await requestStop(s.hub, { operation: "op-down", target: { execution: "attempt-old" }, by: "test" })).toMatchObject({ id: made.id, state: "stopped" })
    expect(await s.q("select id from stop_request")).toHaveLength(1)
    expect(s.edge.sessions.flatMap(row => row.fed).filter(message => message.id === "h1"), "nothing was fed for the held input").toEqual([])
  } finally { await runner?.stop(); await engine.stop(); await detached.stop(); await s.stop() }
}, 90_000)

test("R4 a stop that meets a result the model had already produced keeps it: the answer is settled from its journal, not interrupted", async () => {
  const s = await stageRunner({ descendants: true })
  let runner: Awaited<ReturnType<typeof runRunner>> | undefined
  try {
    runner = await s.start()
    s.edge.hold(message => message.id === "h1")
    await insertInbound(cluster, s.it.db, { id: "h1", body: "the question" })
    expect(await observe(() => s.fedCount("h1") === 1)).toBe(true)
    const [attempt] = await s.q("select id from execution where inbound_id = 'h1'")
    // The model finished and its answer is durable; the settle has not landed.
    await s.q("update execution set result = $1::jsonb where id = $2", [{ text: "the saved answer", chunks: ["the saved answer"], turn: TURN }, attempt.id])
    await requestStop(s.hub, { operation: "op-race", target: { execution: attempt.id }, by: "test" })
    expect(await observe(async () => (await s.q("select state from execution where id = $1", [attempt.id]))[0].state === "completed", 20_000)).toBe(true)
    expect((await s.it.read.outbox()).map(row => [row.inbound_id, row.body])).toEqual([["h1", "the saved answer"]])
    expect((await s.it.read.inbound()).find(row => row.id === "h1")).toMatchObject({ state: "answered", claimed_by: null })
    expect(await s.q("select 1 from replay_hold"), "an answer is not an interruption").toEqual([])
    expect(await observe(async () => (await stopsOf(s.hub, "op-race"))[0].state === "settled")).toBe(true)
    expect((await stopsOf(s.hub, "op-race"))[0]).toMatchObject({ state: "settled", outcome: "completed" })
    expect(s.fedCount("h1")).toBe(1)
  } finally { await runner?.stop(); await s.stop() }
}, 90_000)

test("R5 a stop takes only the master's attempt: an independent job runs to its report, the gate that closes future claims is separate, and releasing it does not lift the hold", async () => {
  const s = await stageRunner({ worker: true })
  let runner: Awaited<ReturnType<typeof runRunner>> | undefined
  try {
    runner = await s.start()
    s.edge.hold(message => message.id === "h1" || message.id === "j1")
    await insertInbound(cluster, s.it.db, { id: "h1", body: "master work" })
    await insertJob(cluster, s.it.db, { id: "j1", target: "p1-worker", task: "independent work" })
    expect(await observe(() => s.fedCount("h1") === 1 && s.fedCount("j1") === 1, 20_000)).toBe(true)
    const [master] = await s.q("select id from execution where inbound_id = 'h1'")
    const worker = s.sessionFed("j1")!

    // One transaction: the gate on what the master is given next, then the stop (the gate first: that is the lock order the
    // openings rely on). Neither waits for a process.
    await s.hub.sql.begin(async (tx) => {
      const inside = { ...s.hub, sql: tx as unknown as StoreLike["sql"] }
      await placeGate(inside, { operation: "op-stop-master", scope: { kind: "agent", id: AGENT }, cause: "stop" })
      await requestStop(inside, { operation: "op-stop-master", target: { execution: master.id }, by: "test" })
    })
    expect(await observe(async () => (await stopsOf(s.hub, "op-stop-master"))[0].state === "stopped", 20_000)).toBe(true)
    // The independent job was not cancelled, interrupted or even noticed: it is still running.
    expect(worker.closed).toBe(false)
    expect((await s.q("select state from execution where inbound_id = 'j1'"))[0].state).toMatch(/feed_intent|received|running/)
    worker.loop.holdTurnEnd(false)
    expect(await s.answered("j1", 20_000), "it went on to its own report").toBe(true)

    // Future claims are gated separately, and releasing the gate does not lift the hold on the interrupted input.
    await insertInbound(cluster, s.it.db, { id: "h2", body: "next" })
    expect((await s.q("select hub_row_held('h2') as held"))[0].held).toBe(true)
    expect(await gatesOn(s.hub, { kind: "agent", id: AGENT })).toEqual([expect.objectContaining({ operation: "op-stop-master", cause: "stop", state: "open" })])
    await Bun.sleep(1500)
    expect(s.fedCount("h2")).toBe(0)
    expect(await releaseGates(s.hub, { operation: "op-stop-master" })).toBe(1)
    expect(await s.q("select cause, state from replay_hold")).toEqual([{ cause: "stopped", state: "held" }])
    expect((await s.q("select hub_row_held('h1') as held"))[0].held, "the original input is still held").toBe(true)
    await Bun.sleep(2000)
    expect(s.fedCount("h2"), "and no validated resume means nothing starts for the next one either").toBe(0)
    expect(s.fedCount("h1")).toBe(1)
  } finally { await runner?.stop(); await s.stop() }
}, 90_000)

test("R6 a gate closed while a turn runs interrupts nothing, holds the next input, and a release wakes the runner on the store's own notification", async () => {
  // A long bound, so that an answer that comes soon after the release can only have come from the notification.
  const s = await stageRunner({ tick: 30 })
  let runner: Awaited<ReturnType<typeof runRunner>> | undefined
  try {
    runner = await s.start()
    s.edge.hold(message => message.id === "h1")
    await insertInbound(cluster, s.it.db, { id: "h1", body: "long work" })
    expect(await observe(() => s.fedCount("h1") === 1)).toBe(true)
    const running = s.sessionFed("h1")!
    await placeGate(s.hub, { operation: "op-archive", scope: { kind: "agent", id: AGENT }, cause: "archive" })
    await insertInbound(cluster, s.it.db, { id: "h2", body: "a message that arrives while it is gated" })
    await Bun.sleep(1500)
    // The running turn is not interrupted, and the new message is not claimed.
    expect(running.closed).toBe(false)
    expect((await s.q("select state from execution where inbound_id = 'h1'"))[0].state).toMatch(/feed_intent|received|running/)
    expect((await s.it.read.inbound()).find(row => row.id === "h2")).toMatchObject({ state: "received", claimed_by: null })
    expect(s.fedCount("h2")).toBe(0)
    // The running turn finishes and its answer is delivered as it always was; the gate did not touch it.
    running.loop.holdTurnEnd(false)
    expect(await s.answered("h1", 15_000)).toBe(true)
    await Bun.sleep(1000)
    expect(s.fedCount("h2"), "still gated after the turn that was running has settled").toBe(0)
    expect(await s.q("select 1 from ledger_event where subject = 'h2' and kind = 'answered'")).toEqual([])

    const released = performance.now()
    expect(await releaseGates(s.hub, { operation: "op-archive" })).toBe(1)
    expect(await s.answered("h2", 12_000), "woken by the release, not by the 30 second bound").toBe(true)
    expect(performance.now() - released).toBeLessThan(20_000)
  } finally { await runner?.stop(); await s.stop() }
}, 90_000)

test("R7 a runner with nothing asked of it reads nothing for stop requests: one read at start, one per notification meant for it", async () => {
  const s = await stageRunner()
  const watch = await statementWatch(cluster)
  let runner: Awaited<ReturnType<typeof runRunner>> | undefined
  const reads = async () => (await watch.lines()).filter(line => /from stop_request/.test(line)).length
  try {
    runner = await s.start()
    await untilIssued(watch, "the runner opened its stop listener", /listen hub_stop/i)
    await untilIssued(watch, "the runner read its stop requests once, after listening", /from stop_request/, { after: /listen hub_stop/i })
    expect(await reads()).toBe(1)
    await Bun.sleep(3500)
    expect(await reads(), "three ticks of waiting read nothing").toBe(1)
    // A notification for another runner wakes nothing; one for this runner is one read.
    await s.it.read.sql("select pg_notify('hub_stop', 'a-runner-somewhere-else')")
    await Bun.sleep(1000)
    expect(await reads()).toBe(1)
    await s.it.read.sql("select pg_notify('hub_stop', $1)", [RUNNER])
    await untilIssued(watch, "one read for the notification", /from stop_request/, { times: 2 })
    await Bun.sleep(1000)
    expect(await reads()).toBe(2)
  } finally { await runner?.stop(); await s.stop() }
}, 90_000)

// ---------------------------------------------------------------------------
// R8-R16. The interleavings the first pass reasoned about and did not run.
// ---------------------------------------------------------------------------

type Staged = Awaited<ReturnType<typeof stageRunner>>
type Runner = Awaited<ReturnType<typeof runRunner>>

/** Count the signals sent to any session, optionally holding each one until `until` resolves. Called before the runner starts. */
function watchSignals(s: Staged, until?: Promise<void>) {
  const signals = { count: 0 }
  s.edge.onStart(row => {
    const inner = row.session.interrupt!
    row.session.interrupt = async (options) => { signals.count += 1; if (until) await until; return await inner(options) }
  })
  return signals
}

const feedsOrHolds = (row: NoticeRow) => String(row.notice_key).startsWith("hold:") || String(row.notice_key).startsWith("agent-retry")

test("R8 a stop whose write is still in flight when its attempt settles and the next input opens signals nothing: the answer stands once, the next input runs on the same session, and nothing is held", async () => {
  const s = await stageRunner()
  const signals = watchSignals(s)
  let runner: Runner | undefined
  let pause: Awaited<ReturnType<typeof holdKey>> | undefined
  try {
    runner = await s.start()
    s.edge.hold(message => message.id === "h1" || message.id === "h2")
    await insertInbound(cluster, s.it.db, { id: "h1", body: "the first" })
    expect(await observe(() => s.fedCount("h1") === 1)).toBe(true)
    const first = s.sessionFed("h1")!
    await insertInbound(cluster, s.it.db, { id: "h2", body: "queued behind it" })
    const [attempt] = await s.q("select id from execution where inbound_id = 'h1'")

    // The stop's own write is held where it starts, before it has looked at anything.
    await s.q(`create function test_hold_stop() returns trigger language plpgsql as $$ begin
      if current_query() like '%set state = ''stop_requested''%' then perform pg_advisory_lock(90212); perform pg_advisory_unlock(90212); end if;
      return null; end $$`)
    await s.q("create trigger test_hold_stop before update on execution for each statement execute function test_hold_stop()")
    pause = await holdKey(s.it.db, 90212)
    await requestStop(s.hub, { operation: "op-late", target: { execution: attempt.id }, by: "test" })
    expect(await waiting(s.it.db)("hub_runner"), "the runner's stop is inside its write").toBe(true)

    // While it is held the attempt finishes with its answer, and the input queued behind it opens and is fed on the resident session.
    first.loop.holdTurnEnd(false)
    expect(await s.answered("h1")).toBe(true)
    expect(await observe(() => s.fedCount("h2") === 1)).toBe(true)
    expect(s.sessionFed("h2"), "the next input went to the session that was already there").toBe(first)

    await pause.release()
    pause = undefined
    expect(await observe(async () => (await stopsOf(s.hub, "op-late"))[0].state === "settled", 20_000)).toBe(true)
    await Bun.sleep(700)
    expect(signals.count, "the session the next input is on was never signalled").toBe(0)
    expect(first.closed).toBe(false)
    expect((await s.q("select state from execution where inbound_id = 'h2'"))[0].state).toMatch(/feed_intent|received|running/)
    expect(await s.q("select 1 from replay_hold"), "nothing was stopped, so nothing is held").toEqual([])
    expect((await s.it.read.noticeRows()).filter(feedsOrHolds)).toEqual([])
    // The next input goes on by the normal road, and the first answer was delivered once.
    first.loop.holdTurnEnd(false)
    expect(await s.answered("h2", 20_000)).toBe(true)
    expect((await s.it.read.outbox()).filter(row => row.inbound_id === "h1")).toHaveLength(1)
    expect([s.fedCount("h1"), s.fedCount("h2")]).toEqual([1, 1])
  } finally { await pause?.release().catch(() => {}); await runner?.stop(); await s.stop() }
}, 90_000)

test("R9 a stop accepted while the answer lands keeps the answer, and the session it signalled is never fed the input queued behind it: that input runs on a session of its own", async () => {
  let release!: () => void
  const signalled = new Promise<void>(resolve => { release = resolve })
  const s = await stageRunner({ descendants: true })
  const signals = watchSignals(s, signalled)
  let runner: Runner | undefined
  try {
    runner = await s.start()
    s.edge.hold(message => message.id === "h1" || message.id === "h2")
    await insertInbound(cluster, s.it.db, { id: "h1", body: "long work" })
    expect(await observe(() => s.fedCount("h1") === 1)).toBe(true)
    const target = s.sessionFed("h1")!
    await insertInbound(cluster, s.it.db, { id: "h2", body: "queued behind it" })
    const [attempt] = await s.q("select id from execution where inbound_id = 'h1'")

    // Accepted: the attempt is `stop_requested` and the signal is on its way (held here).
    await requestStop(s.hub, { operation: "op-accepted", target: { execution: attempt.id }, by: "test" })
    expect(await observe(() => signals.count === 1)).toBe(true)
    expect((await s.q("select state from execution where id = $1", [attempt.id]))[0].state).toBe("stop_requested")
    // The model's answer lands first. It is kept and delivered, and the stop that was accepted for it does not turn it into a hold.
    target.loop.holdTurnEnd(false)
    expect(await s.answered("h1")).toBe(true)
    expect((await s.q("select state from execution where id = $1", [attempt.id]))[0].state).toBe("completed")
    await Bun.sleep(700)
    expect(s.fedCount("h2"), "the session that was signalled is not fed the next input").toBe(0)

    release()
    expect(await observe(() => s.fedCount("h2") === 1, 20_000)).toBe(true)
    const next = s.sessionFed("h2")!
    expect(next, "it runs on a session of its own").not.toBe(target)
    expect(await observe(() => target.closed), "and the one that was signalled is finished with").toBe(true)
    next.loop.holdTurnEnd(false)
    expect(await s.answered("h2", 20_000)).toBe(true)
    expect(signals.count).toBe(1)
    expect((await s.it.read.outbox()).filter(row => row.inbound_id === "h1")).toHaveLength(1)
    expect((await s.q("select inbound_id, state from execution order by started_at")).map(row => [row.inbound_id, row.state])).toEqual([["h1", "completed"], ["h2", "completed"]])
    expect(await s.q("select 1 from replay_hold"), "neither input was held").toEqual([])
    expect((await stopsOf(s.hub, "op-accepted"))[0]).toMatchObject({ state: "settled", outcome: "completed" })
    expect((await s.it.read.noticeRows()).filter(feedsOrHolds)).toEqual([])
  } finally { release(); await runner?.stop(); await s.stop() }
}, 90_000)

test("R10 a stop accepted after the priming tail's answer landed and before the input is fed ends the attempt as stopped, and the input is never fed", async () => {
  const s = await stageRunner({ descendants: true })
  let runner: Runner | undefined
  let pause: Awaited<ReturnType<typeof holdKey>> | undefined
  try {
    plantChatLine({ stateDir: s.it.stateDir, text: "what was said yesterday" })
    // The resident's own tail is refused (A15), so the row's fresh child carries the tail on the row's attempt.
    await s.q(`create function test_tail_busy() returns trigger language plpgsql as $$ begin
      raise unique_violation using message = 'duplicate key value violates unique constraint "execution_one_per_agent"'; end $$`)
    await s.q("create trigger test_tail_busy before insert on execution for each row when (new.purpose = 'tail') execute function test_tail_busy()")
    runner = await s.start()
    expect(await observe(async () => (await s.it.read.ledger({ stream: "runner", kind: "tail.refused" })).length === 1, 15_000)).toBe(true)
    // The tail's own answer is held as it is recorded: the tail has been fed and has answered, the input has not been fed.
    await s.q(`create function test_hold_tail() returns trigger language plpgsql as $$ begin
      if new.stream = 'turn' and new.detail ->> 'tail' = 'true' then perform pg_advisory_lock(90213); perform pg_advisory_unlock(90213); end if;
      return new; end $$`)
    await s.q("create trigger test_hold_tail before insert on ledger_event for each row execute function test_hold_tail()")
    pause = await holdKey(s.it.db, 90213)
    await insertInbound(cluster, s.it.db, { id: "h1", body: "the input" })
    expect(await waiting(s.it.db)("hub_runner")).toBe(true)
    const [attempt] = await s.q("select id, state from execution where inbound_id = 'h1'")
    expect(attempt.state, "the tail was fed on the row's attempt").toMatch(/feed_intent|received|running/)
    expect(s.fedCount("h1")).toBe(0)

    await requestStop(s.hub, { operation: "op-boundary", target: { execution: attempt.id }, by: "test" })
    expect(await observe(async () => (await stopsOf(s.hub, "op-boundary"))[0].state === "stopped", 20_000)).toBe(true)
    await pause.release()
    pause = undefined
    await Bun.sleep(1500)
    expect(s.fedCount("h1"), "the input is not fed to the session that was ended for its attempt").toBe(0)
    expect(s.edge.sessions.flatMap(row => row.fed).map(message => message.id), "only the tail was ever fed").toEqual([AGENT])
    expect(await s.q("select state from execution where inbound_id = 'h1'")).toEqual([{ state: "stopped" }])
    expect(await s.q("select inbound_id, cause, state from replay_hold")).toEqual([{ inbound_id: "h1", cause: "stopped", state: "held" }])
    expect((await s.it.read.inbound()).find(row => row.id === "h1")).toMatchObject({ claimed_by: null })
    expect((await s.it.read.outbox()).some(row => row.inbound_id === "h1")).toBe(false)
    expect((await s.it.read.noticeRows()).filter(row => String(row.notice_key).startsWith("agent-retry"))).toEqual([])
  } finally { await pause?.release().catch(() => {}); await runner?.stop(); await s.stop() }
}, 90_000)

test("R11 a stop whose write fails leaves no intent behind and is done again on the tick; two requests for one attempt signal it once", async () => {
  const s = await stageRunner()
  const signals = watchSignals(s)
  let runner: Runner | undefined
  try {
    runner = await s.start()
    s.edge.hold(message => message.id === "h1" || message.id === "h3")
    // The stop's write fails for as long as the switch is on.
    await s.q("create table test_stop_armed (armed boolean)")
    await s.q("grant select on test_stop_armed to public")
    await s.q("insert into test_stop_armed values (true)")
    await s.q(`create function test_fail_stop() returns trigger language plpgsql as $$ begin
      if exists (select 1 from test_stop_armed) and current_query() like '%set state = ''stop_requested''%' then raise exception 'injected stop failure'; end if;
      return null; end $$`)
    await s.q("create trigger test_fail_stop before update on execution for each statement execute function test_fail_stop()")
    const drains = async (watch: { lines(): Promise<string[]> }) => (await watch.lines()).filter(line => /from stop_request\s+where runner/.test(line)).length

    // FIRST, the attempt finishes while its stop keeps failing. No intent was left on the session by the failed writes.
    await insertInbound(cluster, s.it.db, { id: "h1", body: "the first" })
    expect(await observe(() => s.fedCount("h1") === 1)).toBe(true)
    const first = s.sessionFed("h1")!
    await insertInbound(cluster, s.it.db, { id: "h2", body: "queued behind it" })
    const [a] = await s.q("select id from execution where inbound_id = 'h1'")
    const tried = await statementWatch(cluster)
    await requestStop(s.hub, { operation: "op-fail", target: { execution: a.id }, by: "test" })
    await untilIssued(tried, "the stop was tried, and tried again on the tick with no second notification", /update execution set state = 'stop_requested'/, { times: 2 })
    expect((await s.q("select state from execution where id = $1", [a.id]))[0].state, "nothing of the failed writes stayed").toMatch(/feed_intent|received|running/)
    expect([signals.count, first.closed]).toEqual([0, false])
    first.loop.holdTurnEnd(false)
    expect(await s.answered("h1")).toBe(true)
    expect(await s.answered("h2")).toBe(true)
    expect(s.sessionFed("h2"), "no stop intent was left on the session: the next input went to it").toBe(first)
    expect(signals.count).toBe(0)
    expect(await observe(async () => (await stopsOf(s.hub, "op-fail"))[0].state === "settled", 20_000)).toBe(true)
    // With nothing left owed the runner asks about nothing: three ticks read no stop request.
    await Bun.sleep(2500)
    const idle = await drains(tried)
    await Bun.sleep(3500)
    expect(await drains(tried), "an idle runner reads no stop request").toBe(idle)

    // SECOND, the write fails and is repaired; the request is done by the tick, and a second request for the same attempt does not signal twice.
    await insertInbound(cluster, s.it.db, { id: "h3", body: "the third" })
    expect(await observe(() => s.fedCount("h3") === 1)).toBe(true)
    const [b] = await s.q("select id from execution where inbound_id = 'h3'")
    const again = await statementWatch(cluster)
    await requestStop(s.hub, { operation: "op-c", target: { execution: b.id }, by: "test" })
    await requestStop(s.hub, { operation: "op-d", target: { execution: b.id }, by: "test" })
    // Two requests, each tried once on the notification and once more on the tick.
    await untilIssued(again, "tried, and tried again", /update execution set state = 'stop_requested'/, { times: 4 })
    expect(signals.count).toBe(0)
    await s.q("delete from test_stop_armed")
    expect(await observe(async () => (await stopsOf(s.hub, "op-c"))[0].state === "stopped" && (await stopsOf(s.hub, "op-d"))[0].state === "stopped", 25_000)).toBe(true)
    expect(signals.count, "one attempt, one signal, whoever asked").toBe(1)
    expect(await s.q("select state from execution where inbound_id = 'h3'")).toEqual([{ state: "stopped" }])
    expect(await s.q("select cause, state from replay_hold")).toEqual([{ cause: "stopped", state: "held" }])
  } finally { await runner?.stop(); await s.stop() }
}, 120_000)

test("R12 an attempt of THIS incarnation that is unknown and held by no loop is ended as asked from what is recorded: never signalled, stopped only on proof, and a result it had journaled is settled, not interrupted", async () => {
  const s = await stageRunner({ caps: null })
  const engine = livingProcess()
  const detached = livingProcess()
  const su = track(cluster.connect(s.it.db)) as any
  let runner: Runner | undefined
  try {
    expect(engine.group, "the fixture leads a process group of its own").not.toBeNull()
    runner = await s.start()
    const [{ incarnation }] = await s.q("select incarnation from runner_incarnation where runner = $1", [RUNNER]) as { incarnation: string }[]
    // One transaction, so the runner never sees a row without the attempt that holds it.
    const plant = async (id: string, evidence: Record<string, unknown>, result?: unknown) => {
      await su.begin(async (tx: any) => {
        await tx`insert into inbound (id, person, agent, body, kind, source, claimed_by, claim_deadline) values (${id}, ${PERSON}, ${AGENT}, 'a long job', 'human',
          ${{ log_id: id, at: new Date().toISOString(), door: DOOR, chat: CHAT, sender_id: PERSON, text: "a long job" }}::jsonb, ${RUNNER}, now() + interval '1 hour')`
        await tx`insert into conversation (id, person, agent, kind, adapter, native_session) values (${crypto.randomUUID()}, ${PERSON}, ${AGENT}, 'master', ${s.it.adapterName}, ${crypto.randomUUID()})
          on conflict (agent) where kind = 'master' do nothing`
        await tx`insert into execution (id, inbound_id, conversation_id, agent, runner, incarnation, placement_generation, state, input_digest, evidence, result)
          select ${`attempt-${id}`}, ${id}, c.id, ${AGENT}, ${RUNNER}, ${incarnation}, c.placement_generation, 'unknown', 'd', ${evidence}::jsonb, ${result ?? null}::jsonb
            from conversation c where c.agent = ${AGENT} and c.kind = 'master'`
      })
    }
    await plant("h1", { leader: engine.pid, pids: [engine.pid, detached.pid], group: engine.group })
    const made = await requestStop(s.hub, { operation: "op-unknown", target: { execution: "attempt-h1" }, by: "test" })
    expect(made.state).toBe("requested")
    // Ended as asked, at once: not looked for again for a second and left waiting for a restart.
    expect(await observe(async () => (await s.q("select state from stop_request where id = $1", [made.id]))[0].state === "unknown", 15_000)).toBe(true)
    expect((await s.q("select state from execution where id = 'attempt-h1'"))[0].state).toBe("stop_unknown")
    expect(await s.it.read.ledger({ stream: "execution", subject: "attempt-h1", kind: "stop.deferred" }), "it was not treated as an attempt being opened").toEqual([])
    expect(await s.q("select cause, state from replay_hold")).toEqual([{ cause: "ownership-unknown", state: "held" }])
    expect([childGone(engine.pid), childGone(detached.pid)], "nothing was signalled to a process the runner does not hold").toEqual([false, false])
    // Only proof moves it.
    await engine.stop()
    await Bun.sleep(2000)
    expect((await s.q("select state from stop_request where id = $1", [made.id]))[0].state, "a recorded process that is still there keeps it open").toBe("unknown")
    await detached.stop()
    expect(await observe(async () => (await s.q("select state from stop_request where id = $1", [made.id]))[0].state === "stopped", 20_000)).toBe(true)
    expect((await s.q("select state from execution where id = 'attempt-h1'"))[0].state).toBe("stopped")

    // An unknown attempt that had journaled its answer: the journal is settled first, and the stop does not turn it into a hold.
    await plant("h2", { pids: [] }, { text: "the saved answer", chunks: ["the saved answer"], turn: TURN })
    const kept = await requestStop(s.hub, { operation: "op-journaled", target: { execution: "attempt-h2" }, by: "test" })
    expect(await observe(async () => (await s.q("select state from execution where id = 'attempt-h2'"))[0].state === "completed", 20_000)).toBe(true)
    expect((await s.it.read.outbox()).filter(row => row.inbound_id === "h2").map(row => row.body)).toEqual(["the saved answer"])
    expect(await s.q("select 1 from replay_hold where inbound_id = 'h2'")).toEqual([])
    expect((await stopsOf(s.hub, "op-journaled"))[0]).toMatchObject({ id: kept.id, state: "settled", outcome: "completed" })
    expect(s.edge.sessions.flatMap(row => row.fed), "nothing was fed for either").toEqual([])
  } finally { await runner?.stop(); await engine.stop(); await detached.stop(); await s.stop() }
}, 90_000)

test("R13 a stop request the runner could not read is looked at again on the tick with no second notification, and once nothing is owed the runner reads nothing", async () => {
  const s = await stageRunner()
  const signals = watchSignals(s)
  const watch = await statementWatch(cluster)
  const drains = async () => (await watch.lines()).filter(line => /from stop_request\s+where runner/.test(line)).length
  // A refused read never reaches `execute`: the store rejects it while the statement is being bound, so `statementWatch` (which counts
  // what was executed) cannot see it. The server logs it as an ERROR followed by the STATEMENT it refused, and that is read here, from
  // the marker the revoke left, and paired to the backend that sent it.
  const REVOKED = "statement: revoke select on stop_request from hub_runner"
  const refusedReads = (): number[] => {
    const text = readFileSync(cluster.logFile, "utf8")
    const marker = text.lastIndexOf(REVOKED)
    if (marker < 0) return []
    const entries: { pid: number; level: string; text: string }[] = []
    for (const line of text.slice(marker).split("\n")) {
      const head = /^pid=(\d+)\s+([A-Z]+):\s(.*)$/.exec(line)
      if (head) entries.push({ pid: Number(head[1]), level: head[2], text: head[3] })
      else if (entries.length) entries[entries.length - 1].text += "\n" + line
    }
    return entries.flatMap((entry, i) => {
      if (entry.level !== "ERROR" || !/permission denied for table stop_request/.test(entry.text)) return []
      const statement = entries.slice(i + 1).find(next => next.pid === entry.pid && next.level === "STATEMENT")
      return statement && /from stop_request\s+where runner/.test(statement.text) ? [entry.pid] : []
    })
  }
  let runner: Runner | undefined
  try {
    runner = await s.start()
    await untilIssued(watch, "the read at start", /from stop_request\s+where runner/)
    s.edge.hold(message => message.id === "h1")
    await insertInbound(cluster, s.it.db, { id: "h1", body: "long work" })
    expect(await observe(() => s.fedCount("h1") === 1)).toBe(true)
    const [attempt] = await s.q("select id from execution where inbound_id = 'h1'")
    // The store refuses the runner its read.
    await s.q("revoke select on stop_request from hub_runner")
    const executed = await drains()
    expect(refusedReads(), "nothing is owed, so nothing was read and refused before the request").toEqual([])
    const made = await requestStop(s.hub, { operation: "op-unread", target: { execution: attempt.id }, by: "test" })
    // One notification, so the first refusal is the notification's read; a second and a third can only be the tick looking again.
    await until("the notification's read was refused, and the tick's reads after it, twice", () => refusedReads().length >= 3, 15_000,
      () => `The server log showed ${refusedReads().length} refused reads of 3, from backends ${JSON.stringify(refusedReads())}.`)
    const refused = refusedReads()
    const runners = new Set((await s.q("select pid from pg_stat_activity where usename = 'hub_runner' and datname = current_database()")).map(row => Number(row.pid)))
    expect(refused.every(pid => runners.has(pid)), "every refused read came from a backend of the runner").toBe(true)
    expect(await drains(), "a refused read is not an executed one: the executed count did not move").toBe(executed)
    expect((await s.q("select state from stop_request where id = $1", [made.id]))[0].state).toBe("requested")
    expect(signals.count).toBe(0)
    // The store takes the read again. Nobody notifies anybody: the tick finds the debt.
    await s.q("grant select on stop_request to hub_runner")
    expect(await observe(async () => (await s.q("select state from stop_request where id = $1", [made.id]))[0].state === "stopped", 25_000)).toBe(true)
    expect(await drains(), "the request was read, by the tick, once the store allowed it").toBeGreaterThan(executed)
    expect(signals.count).toBe(1)
    // Done: a complete look with nothing left lowers the debt, and the runner reads nothing on the ticks after it.
    await Bun.sleep(3000)
    const settled = await drains()
    const failed = refusedReads().length
    await Bun.sleep(3500)
    expect(await drains(), "three idle ticks read no stop request").toBe(settled)
    expect(refusedReads().length, "and none is refused either").toBe(failed)
  } finally { await runner?.stop(); await s.stop() }
}, 90_000)

test("R14 a stop asked while its attempt is only being opened signals nothing to the resident session, is left owed, and is consumed once the input is fed", async () => {
  const s = await stageRunner()
  const signals = watchSignals(s)
  let runner: Runner | undefined
  let pause: Awaited<ReturnType<typeof holdKey>> | undefined
  try {
    runner = await s.start()
    // A resident session is left over from an earlier turn of the same conversation.
    await insertInbound(cluster, s.it.db, { id: "h0", body: "an earlier turn" })
    expect(await s.answered("h0")).toBe(true)
    const resident = s.sessionFed("h0")!
    s.edge.hold(message => message.id === "h1")
    // The opening is held at the write that hands the input to the session: the attempt is claimed, and the session is still the earlier turn's.
    await s.q(`create function test_hold_feed() returns trigger language plpgsql as $$ begin
      if current_query() like '%set state = ''feed_intent''%' then perform pg_advisory_lock(90214); perform pg_advisory_unlock(90214); end if;
      return null; end $$`)
    await s.q("create trigger test_hold_feed before update on execution for each statement execute function test_hold_feed()")
    pause = await holdKey(s.it.db, 90214)
    await insertInbound(cluster, s.it.db, { id: "h1", body: "the input being opened" })
    expect(await waiting(s.it.db)("hub_runner")).toBe(true)
    const [attempt] = await s.q("select id, state from execution where inbound_id = 'h1'")
    expect(attempt.state).toBe("claimed")

    const made = await requestStop(s.hub, { operation: "op-opening", target: { execution: attempt.id }, by: "test" })
    // Asked again for the bounded time, then left owed and said once. Nothing is signalled: the session is not this attempt's yet.
    expect(await observe(async () => (await s.it.read.ledger({ stream: "execution", subject: attempt.id, kind: "stop.deferred" })).length === 1, 15_000)).toBe(true)
    await Bun.sleep(2500)
    expect(signals.count).toBe(0)
    expect(resident.closed).toBe(false)
    expect((await s.q("select state from stop_request where id = $1", [made.id]))[0].state, "not reported as consumed before it was handled").toBe("requested")
    expect(await s.it.read.ledger({ stream: "execution", subject: attempt.id, kind: "stop.deferred" }), "said once however many ticks passed").toHaveLength(1)

    // The input is fed, and the debt is paid by the tick.
    await pause.release()
    pause = undefined
    expect(await observe(async () => (await s.q("select state from stop_request where id = $1", [made.id]))[0].state === "stopped", 25_000)).toBe(true)
    expect(signals.count).toBe(1)
    expect(s.fedCount("h1")).toBe(1)
    expect(await s.q("select state from execution where inbound_id = 'h1'")).toEqual([{ state: "stopped" }])
  } finally { await pause?.release().catch(() => {}); await runner?.stop(); await s.stop() }
}, 90_000)

test("R15 a claim that committed before a gate is not opened under it: the runner hands the claim back with nothing fed, and a release wakes it", async () => {
  // A long bound, so that an answer after the release can only have come from the notification.
  const s = await stageRunner({ tick: 30 })
  let runner: Runner | undefined
  let order: Awaited<ReturnType<typeof holdOrder>> | undefined
  try {
    runner = await s.start()
    order = await holdOrder(s.it.db, AGENT)
    await insertInbound(cluster, s.it.db, { id: "h1", body: "claimed, then gated" })
    expect(await waiting(s.it.db)("hub_runner"), "the runner claimed it and is at the opening, behind the lock").toBe(true)
    expect((await s.it.read.inbound()).find(row => row.id === "h1")).toMatchObject({ claimed_by: RUNNER })
    expect(await s.q("select 1 from execution")).toEqual([])
    // The gate is ordered ahead of the opening and committed.
    await order.gate("op-claimed", "agent", AGENT, "archive")
    await order.commit()
    order = undefined
    expect(await observe(async () => (await s.it.read.ledger({ stream: "runner", kind: "execution.fenced" })).length === 1, 15_000)).toBe(true)
    expect((await s.it.read.ledger({ stream: "runner", kind: "execution.fenced" }))[0].detail).toMatchObject({ row: "h1", reason: "gate" })
    await Bun.sleep(1200)
    expect((await s.it.read.inbound()).find(row => row.id === "h1")).toMatchObject({ state: "received", claimed_by: null })
    expect(await s.q("select 1 from execution"), "no attempt was ever opened").toEqual([])
    expect(s.fedCount("h1")).toBe(0)
    // The release is what wakes it.
    expect(await releaseGates(s.hub, { operation: "op-claimed" })).toBe(1)
    expect(await s.answered("h1", 12_000)).toBe(true)
    expect(s.fedCount("h1")).toBe(1)
  } finally { await order?.commit().catch(() => {}); await runner?.stop(); await s.stop() }
}, 90_000)

test("R16 a resident that starts beside a gate placed while it was starting does not prime its tail, and its first input waits for the release", async () => {
  const s = await stageRunner({ tick: 30 })
  let runner: Runner | undefined
  let order: Awaited<ReturnType<typeof holdOrder>> | undefined
  try {
    plantChatLine({ stateDir: s.it.stateDir, text: "what was said yesterday" })
    order = await holdOrder(s.it.db, AGENT)
    const starting = s.start()
    expect(await waiting(s.it.db)("hub_runner"), "the resident is opening its tail attempt, behind the lock").toBe(true)
    await order.gate("op-tail", "agent", AGENT, "archive")
    await order.commit()
    order = undefined
    runner = await starting
    const [refused] = await s.it.read.ledger({ stream: "runner", kind: "tail.refused" })
    expect(String((refused.detail as { cause: string }).cause), "refused by name, for the gate").toMatch(/\(gate\)/)
    expect(s.edge.sessions.flatMap(row => row.fed), "nothing was generated").toEqual([])
    expect(await s.q("select 1 from execution"), "and no attempt was owned").toEqual([])
    expect(await observe(() => s.edge.sessions.every(row => row.closed))).toBe(true)

    await insertInbound(cluster, s.it.db, { id: "h1", body: "the first input" })
    await Bun.sleep(1200)
    expect(s.fedCount("h1")).toBe(0)
    expect((await s.it.read.inbound()).find(row => row.id === "h1")).toMatchObject({ claimed_by: null })
    expect(await releaseGates(s.hub, { operation: "op-tail" })).toBe(1)
    expect(await s.answered("h1", 20_000)).toBe(true)
    expect(s.edge.sessions.flatMap(row => row.fed).map(message => message.id), "the tail rides the input's own attempt, once").toEqual([AGENT, "h1"])
  } finally { await order?.commit().catch(() => {}); await runner?.stop(); await s.stop() }
}, 90_000)

// ---------------------------------------------------------------------------
// R17-R18. The opening handoff of a stop: an attempt that is claimed when the stop
// begins and fed by the time it is judged, on the seams that place each order.
// ---------------------------------------------------------------------------

/** The stop's own write, as it goes over the wire (`stopExecution`): what the seam below looks for. */
const STOP_WRITE = "set state = 'stop_requested'"

const seam = () => {
  let reach!: () => void
  let open!: () => void
  return { reached: new Promise<void>(resolve => { reach = resolve }), opened: new Promise<void>(resolve => { open = resolve }), reach, release: () => open() }
}
type Seam = ReturnType<typeof seam>

/** A bounded wait for one promise, failing by name, so a seam that was never reached cannot hang the test. */
function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} did not happen within ${ms} ms`)), ms) })])
    .finally(() => clearTimeout(timer))
}

/**
 * The runner's own store connections, through a byte-transparent proxy the test controls, with the registry it reads
 * pointed at it. Nothing is changed or read by it: bytes go both ways as they come. It can hold, ONCE,
 *   the DISPATCH of the first statement that carries a text: the runner has sent it and the server has not seen it, so
 *     it starts (and takes its snapshot) only after the release, whatever happened in between;
 *   the ANSWER of the first statement that carries a text: the server has run it (its commit follows on the client's Sync,
 *     which is not held, and may land just after the command tag does), and the runner has not been told, so the runner's
 *     next statement is issued only after the release.
 * The runner holds one of its two store connections for as long as its statement is held; the loop runs on the other.
 */
async function wire(s: Staged) {
  const sockets = new Set<Socket>()
  const seams: { dispatch: (Seam & { text: string }) | null; answer: (Seam & { text: string; on: Socket | null }) | null } = { dispatch: null, answer: null }
  let connections = 0
  const server: Server = createServer(client => {
    connections += 1
    const upstream = connect(cluster.port, "127.0.0.1")
    sockets.add(client)
    sockets.add(upstream)
    client.setNoDelay(true)
    upstream.setNoDelay(true)
    const end = () => { client.destroy(); upstream.destroy() }
    for (const socket of [client, upstream]) { socket.on("close", end); socket.on("error", end) }
    // Each direction is forwarded in order, so a held chunk holds every chunk behind it on its connection.
    let toServer = Promise.resolve()
    client.on("data", (chunk: Buffer) => {
      toServer = toServer.then(async () => {
        const text = chunk.toString("latin1")
        const dispatch = seams.dispatch
        if (dispatch && text.includes(dispatch.text)) { seams.dispatch = null; dispatch.reach(); await dispatch.opened }
        const answer = seams.answer
        if (answer && answer.on === null && text.includes(answer.text)) answer.on = client
        upstream.write(chunk)
      })
    })
    let toClient = Promise.resolve()
    upstream.on("data", (chunk: Buffer) => {
      toClient = toClient.then(async () => {
        const answer = seams.answer
        // The command tag of the statement that was let through on this connection: `UPDATE 0`, or `UPDATE 1` with its row.
        if (answer && answer.on === client && chunk.toString("latin1").includes("UPDATE ")) { seams.answer = null; answer.reach(); await answer.opened }
        client.write(chunk)
      })
    })
  })
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  const url = `postgres://127.0.0.1:${(server.address() as AddressInfo).port}/${s.it.db}`
  const registry = readFileSync(s.it.registryFile, "utf8")
  if (!registry.includes(s.it.storeUrl)) throw new Error("the registry does not carry the store url the runner reads")
  writeFileSync(s.it.registryFile, registry.split(s.it.storeUrl).join(url))
  return {
    connections: () => connections,
    holdDispatch(text: string) { const one = { ...seam(), text }; seams.dispatch = one; return one },
    holdAnswer(text: string) { const one = { ...seam(), text, on: null as Socket | null }; seams.answer = one; return one },
    async stop() {
      seams.dispatch?.release()
      seams.answer?.release()
      for (const socket of sockets) socket.destroy()
      await new Promise<void>(resolve => server.close(() => resolve()))
    },
  }
}

/**
 * The adapter's start, held ONCE when armed: the attempt the runner has just opened is claimed and owns no child, and
 * `own.session` is whatever it was before (nothing, or the last turn's) until `release()`. Installed before the runner starts.
 */
function holdStarts(s: Staged) {
  const inner = s.edge.adapter.start.bind(s.edge.adapter)
  let armed = false
  const held = seam()
  s.edge.adapter.start = async options => {
    if (armed) { armed = false; held.reach(); await held.opened }
    return await inner(options)
  }
  return { arm() { armed = true }, arrived: held.reached, release: held.release }
}

/** Every signal a session is sent, and what the store says of the attempt and the request at the instant it is sent. Installed before the runner starts. */
function signalLog(s: Staged) {
  const sent: { row: Staged["edge"]["sessions"][number]; execution: string; request: string }[] = []
  s.edge.onStart(row => {
    const inner = row.session.interrupt!
    row.session.interrupt = async (options) => {
      const [now] = await s.q("select e.state as execution, r.state as request from execution e join stop_request r on r.execution_id = e.id where e.inbound_id = 'h1'")
      sent.push({ row, execution: now.execution, request: now.request })
      return await inner(options)
    }
  })
  return sent
}

/**
 * What the STORE did with each write of a stop, in order: `statement:<state>` is a stop write that began while the attempt
 * was in that state (read inside the statement, after the runner sent it), and `accepted:<state>` is a row that write moved
 * to `stop_requested` from that state. A write that moved nothing leaves only its `statement`. Fed states read `fed`, because which of
 * them the attempt is in (fed, received, running) depends on how far the held turn has got.
 */
async function logStopWrites(s: Staged) {
  await s.q("create table test_stop_log (seq bigserial primary key, what text not null, state text)")
  await s.q(`create function test_log_stop_statement() returns trigger language plpgsql security definer as $$ begin
    if current_query() like '%set state = ''stop_requested''%' then
      insert into test_stop_log (what, state) select 'statement', string_agg(state, ',') from execution where inbound_id = 'h1';
    end if;
    return null; end $$`)
  await s.q("create trigger test_log_stop_statement before update on execution for each statement execute function test_log_stop_statement()")
  await s.q(`create function test_log_stop_row() returns trigger language plpgsql security definer as $$ begin
    insert into test_stop_log (what, state) values ('accepted', old.state); return null; end $$`)
  await s.q(`create trigger test_log_stop_row after update on execution for each row
    when (new.state = 'stop_requested' and old.state is distinct from 'stop_requested') execute function test_log_stop_row()`)
  return async () => (await s.q("select what, state from test_stop_log order by seq"))
    .map(row => `${row.what}:${String(row.state).replace(/^(feed_intent|received|running)$/, "fed")}`)
}

/**
 * A runner whose resident has no child, and an input about to open its attempt on a FRESH one, whose priming tail rides
 * that attempt. Everything is held: the child's start (when armed), the tail's turn and the input's turn, so nothing
 * finishes on its own. Call `openAttempt` after the runner is up.
 */
async function stageOpening(s: Staged) {
  const starts = holdStarts(s)
  const sent = signalLog(s)
  const written = await logStopWrites(s)
  plantChatLine({ stateDir: s.it.stateDir, text: "what was said yesterday" })
  // The resident's own tail is refused (A15), so it is left with no child, and the input's fresh child carries the tail on the input's attempt.
  await s.q(`create function test_tail_busy() returns trigger language plpgsql as $$ begin
    raise unique_violation using message = 'duplicate key value violates unique constraint "execution_one_per_agent"'; end $$`)
  await s.q("create trigger test_tail_busy before insert on execution for each row when (new.purpose = 'tail') execute function test_tail_busy()")
  s.edge.hold(message => message.id === AGENT || message.id === "h1")
  return {
    starts, sent, written,
    /** The input is claimed and its attempt is owned; the child's start is held, so no child of it exists. */
    async openAttempt() {
      expect(await observe(async () => (await s.it.read.ledger({ stream: "runner", kind: "tail.refused" })).length === 1, 15_000)).toBe(true)
      const before = s.edge.sessions.length
      starts.arm()
      await insertInbound(cluster, s.it.db, { id: "h1", body: "the input" })
      await within(starts.arrived, 15_000, "the start of the input's fresh child")
      const [attempt] = await s.q("select id, state from execution where inbound_id = 'h1'")
      expect(attempt.state, "the attempt is claimed").toBe("claimed")
      expect(s.edge.sessions.length, "and no child of it exists yet: a stop read now reads no session of its own").toBe(before)
      expect(s.edge.sessions.flatMap(row => row.fed), "nothing was fed").toEqual([])
      return { id: String(attempt.id), before }
    },
  }
}

test("R17 a stop that read no session while its attempt was only claimed, and whose write was accepted after that same attempt was fed on a fresh child, signals THAT child once and ends stopped on proof: the input riding behind the tail is never fed", async () => {
  const s = await stageRunner({ descendants: true })
  const open = await stageOpening(s)
  const wired = await wire(s)
  let runner: Runner | undefined
  let dispatch: ReturnType<typeof wired.holdDispatch> | undefined
  try {
    runner = await s.start()
    expect(wired.connections(), "the runner's store connections go through the seam").toBeGreaterThan(0)
    const attempt = await open.openAttempt()

    // The stop begins now: it reads the attempt claimed and the session none, and its write is HELD before the server has seen it.
    const watch = await statementWatch(cluster)
    const drains = async () => (await watch.lines()).filter(line => /from stop_request\s+where runner/.test(line)).length
    dispatch = wired.holdDispatch(STOP_WRITE)
    const made = await requestStop(s.hub, { operation: "op-opening-a", target: { execution: attempt.id }, by: "test" })
    await within(dispatch.reached, 15_000, "the runner's stop write")
    expect(await open.written(), "the server has not begun the write").toEqual([])
    expect((await s.q("select state from execution where id = $1", [attempt.id]))[0].state).toBe("claimed")
    expect(s.edge.sessions.length, "still no child").toBe(attempt.before)

    // While it is held the SAME attempt gets its child and is fed the tail (feed intent committed, the turn held): what the write finds
    // is a fed attempt, so it is accepted, and the session the runner read before the write is not the one the attempt is on.
    open.starts.release()
    expect(await observe(() => s.fedCount(AGENT) === 1, 15_000)).toBe(true)
    const fresh = s.sessionFed(AGENT)!
    expect(s.edge.sessions.indexOf(fresh), "a child that did not exist when the stop began").toBe(attempt.before)
    expect(await s.q("select id, state from execution where inbound_id = 'h1'")).toEqual([{ id: attempt.id, state: expect.stringMatching(/^(feed_intent|received|running)$/) }])
    expect(await observe(() => processTree(fresh.session.pid!).length === 3)).toBe(true)
    const tree = processTree(fresh.session.pid!)
    expect(await open.written(), "the write still has not reached the server").toEqual([])
    expect(open.sent).toHaveLength(0)

    // Now it does: the statement begins on a fed attempt, so this is the POSITIVE acceptance, not a write that moved nothing.
    dispatch.release()
    dispatch = undefined
    expect(await observe(async () => (await stopsOf(s.hub, "op-opening-a"))[0].state === "stopped", 25_000)).toBe(true)
    expect(await open.written()).toEqual(["statement:fed", "accepted:fed"])
    expect(open.sent, "exactly one signal").toHaveLength(1)
    expect(open.sent[0].row, "to the child the attempt was fed on, and to no other").toBe(fresh)
    expect(open.sent[0], "asked to stop and committed as such BEFORE the signal").toMatchObject({ execution: "stop_requested", request: "stopping" })
    expect(tree.every(pid => childGone(pid)), "ended on what the signal proved: the loop and both tools are gone").toBe(true)
    expect(await s.q("select id, state from execution where inbound_id = 'h1'"), "stopped, and not left unknown for a child nobody signalled")
      .toEqual([{ id: attempt.id, state: "stopped" }])
    expect((await stopsOf(s.hub, "op-opening-a"))[0]).toMatchObject({ id: made.id, state: "stopped", outcome: "stopped" })

    // Nothing rides on: the input behind the tail is never fed, and nothing else is signalled or said.
    await Bun.sleep(1500)
    expect(s.fedCount("h1"), "the input is never fed to a child that was ended for its attempt").toBe(0)
    expect(s.edge.sessions.flatMap(row => row.fed).map(message => message.id), "only the tail was ever fed").toEqual([AGENT])
    expect(open.sent).toHaveLength(1)
    expect(await s.q("select inbound_id, cause, state from replay_hold")).toEqual([{ inbound_id: "h1", cause: "stopped", state: "held" }])
    expect((await s.it.read.outbox()).some(row => row.inbound_id === "h1")).toBe(false)
    expect(await s.it.read.ledger({ stream: "execution", subject: attempt.id, kind: "stop.deferred" }), "nothing was deferred").toEqual([])
    expect(await drains(), "one notification, one read: nothing was owed").toBe(1)
    expect((await s.it.read.noticeRows()).filter(row => String(row.notice_key).startsWith("agent-retry"))).toEqual([])
  } finally {
    dispatch?.release()
    open.starts.release()
    await runner?.stop()
    await wired.stop()
    await s.stop()
  }
}, 90_000)

test("R18 a stop whose write met its attempt claimed and whose read met it fed is not taken for an attempt nobody here holds: it is asked again by the same bounded look, signals the attempt's child once, and ends stopped on proof", async () => {
  const s = await stageRunner({ descendants: true })
  const open = await stageOpening(s)
  const wired = await wire(s)
  let runner: Runner | undefined
  let answer: ReturnType<typeof wired.holdAnswer> | undefined
  try {
    runner = await s.start()
    expect(wired.connections(), "the runner's store connections go through the seam").toBeGreaterThan(0)
    const attempt = await open.openAttempt()

    // The stop's write runs NOW, on the claimed attempt, and moves nothing; the server has run it, and its ANSWER is held.
    const watch = await statementWatch(cluster)
    const drains = async () => (await watch.lines()).filter(line => /from stop_request\s+where runner/.test(line)).length
    answer = wired.holdAnswer(STOP_WRITE)
    const made = await requestStop(s.hub, { operation: "op-opening-b", target: { execution: attempt.id }, by: "test" })
    await within(answer.reached, 15_000, "the answer to the runner's stop write")
    // The command tag can reach the proxy BEFORE the statement's transaction is committed: the server sends it ahead of the commit
    // and the client's Sync (already sent, and not held) is what ends the implicit transaction. So what the write did is looked at
    // once it is committed, and it is committed without the runner's help: the answer stays held, the child's start stays held, and
    // nothing can feed the attempt until both are released below.
    expect(await observe(async () => (await open.written()).length > 0, 5_000), "the write is committed while its answer is still held").toBe(true)
    expect(await open.written(), "the write ran while the attempt was claimed and moved no row").toEqual(["statement:claimed"])
    expect((await s.q("select state from execution where id = $1", [attempt.id]))[0].state).toBe("claimed")

    // The runner has not been told. The loop feeds the attempt, on its fresh child, before the read that follows the write.
    open.starts.release()
    expect(await observe(() => s.fedCount(AGENT) === 1, 15_000)).toBe(true)
    const fresh = s.sessionFed(AGENT)!
    expect(await s.q("select id, state from execution where inbound_id = 'h1'")).toEqual([{ id: attempt.id, state: expect.stringMatching(/^(feed_intent|received|running)$/) }])
    expect(await observe(() => processTree(fresh.session.pid!).length === 3)).toBe(true)
    const tree = processTree(fresh.session.pid!)
    expect(await open.written(), "no write has moved the attempt").toEqual(["statement:claimed"])
    expect(open.sent).toHaveLength(0)

    // The answer arrives: no row. The attempt is held here and fed, so it is asked again, and the second write is accepted.
    answer.release()
    answer = undefined
    expect(await observe(async () => (await stopsOf(s.hub, "op-opening-b"))[0].state === "stopped", 25_000)).toBe(true)
    expect(await open.written()).toEqual(["statement:claimed", "statement:fed", "accepted:fed"])
    expect(open.sent, "exactly one signal").toHaveLength(1)
    expect(open.sent[0].row, "to the child the attempt was fed on").toBe(fresh)
    expect(open.sent[0], "asked to stop and committed as such BEFORE the signal").toMatchObject({ execution: "stop_requested", request: "stopping" })
    expect(tree.every(pid => childGone(pid)), "ended on what the signal proved").toBe(true)
    expect(await s.q("select id, state from execution where inbound_id = 'h1'"), "stopped, not ended from its record as unknown while its child ran on")
      .toEqual([{ id: attempt.id, state: "stopped" }])
    expect((await stopsOf(s.hub, "op-opening-b"))[0]).toMatchObject({ id: made.id, state: "stopped", outcome: "stopped" })

    await Bun.sleep(1500)
    expect(s.fedCount("h1"), "the input is never fed to a child that was ended for its attempt").toBe(0)
    expect(s.edge.sessions.flatMap(row => row.fed).map(message => message.id), "only the tail was ever fed").toEqual([AGENT])
    expect(open.sent).toHaveLength(1)
    expect(await s.q("select inbound_id, cause, state from replay_hold")).toEqual([{ inbound_id: "h1", cause: "stopped", state: "held" }])
    expect(await s.it.read.ledger({ stream: "execution", subject: attempt.id, kind: "stop.deferred" }), "asked again inside the bounded look, not left owed").toEqual([])
    expect(await drains(), "one notification and one read: the second look was the consumer's own, not another notification").toBe(1)
    expect((await s.it.read.noticeRows()).filter(row => String(row.notice_key).startsWith("agent-retry"))).toEqual([])
  } finally {
    answer?.release()
    open.starts.release()
    await runner?.stop()
    await wired.stop()
    await s.stop()
  }
}, 90_000)
