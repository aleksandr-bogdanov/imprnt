// The two features that landed together: councils (migration 014, `hub_council`) and topic chats (migration 015, `hub_topic`).
//
// Each has its own suites, and nothing here repeats them. What is checked is only what neither could see alone: the one
// tool catalog and its handler table, the one migration list and the fresh schema that has to say what a store upgraded
// step by step says, the store objects both write into (`inbound`, `conversation`, the claim gates) working together, and an
// archive of a topic master whose council is running.
//
// A real Postgres, and every write goes through the role the process that makes it really has.

import { afterAll, afterEach, beforeAll, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { hubPath, startCluster, type Cluster } from "./helpers/cluster.ts"
import { rolloutDatabase } from "./helpers/rollout-fixtures.ts"
import { councilStage, startArgs } from "./helpers/council-stage.ts"
import { PERSON, RUNNER, CHAT, DOOR } from "./helpers/hub-fixture.ts"
import { MIGRATION_FILES, migrate } from "../src/store/migrate.ts"
import { TOOLS, ToolError } from "../src/mcp/contracts.ts"
import { callTool } from "../src/mcp/handlers.ts"
import { readEligible } from "../src/store/wake.ts"
import { completeTransition, linkLegacyTopic, readTopicByAgent, recordChannel, requestTransition, reserveIdentity } from "../src/store/topics.ts"

let cluster: Cluster
beforeAll(async () => { cluster = await startCluster() })
afterAll(async () => { await cluster?.stop() })

const mine: { close(): Promise<void> }[] = []
const track = <T extends { close(): Promise<void> }>(sql: T): T => { mine.push(sql); return sql }
afterEach(async () => { for (const one of mine.splice(0)) await one.close().catch(() => {}) })

/** A statement as a real promise, so that `expect(...).rejects` reads what the store said. */
const attempt = async (query: PromiseLike<unknown>): Promise<void> => { await query }

async function code(run: Promise<unknown>): Promise<string> {
  try { await run; return "no error" } catch (error) { return error instanceof ToolError ? error.code : `not a ToolError: ${(error as Error).message}` }
}

const files = (upTo: number) => MIGRATION_FILES.filter(([version]) => version <= upTo)
  .map(([version, file]) => ({ version, sql: readFileSync(join(hubPath("src/store/migrations"), file), "utf8") }))

const whole = (through: number) => Array.from({ length: through }, (_, i) => i + 1)

// ---------------------------------------------------------------------------
// I1-I2. The tool catalog: one facade, two families, one handler table.
// ---------------------------------------------------------------------------

test("I1 every action the catalog offers has a handler and nothing else is offered, for both families, and an action nobody built is refused by name", async () => {
  const s = await councilStage(cluster, track, { general: true })
  try {
    expect(TOOLS.map(tool => tool.name)).toEqual(["hub_topic", "hub_council"])
    for (const tool of TOOLS) {
      for (const action of tool.inputSchema.properties.action.enum as readonly string[]) {
        // With no other argument a call is refused for what it lacks, or answered: never for having no handler.
        const said = await code(callTool(s.binding(), tool.name, { action }))
        expect(["unsupported_action", "unknown_tool"], `${tool.name} ${action}`).not.toContain(said)
      }
    }
    // The actions neither slice built are not listed, and asking anyway is refused before anything is looked at.
    for (const [tool, action] of [["hub_topic", "stop"], ["hub_topic", "move"], ["hub_topic", "delete"], ["hub_council", "move"], ["hub_council", "delete"]] as const) {
      expect(await code(callTool(s.binding(), tool, { action })), `${tool} ${action}`).toBe("unsupported_action")
    }
    expect(await code(callTool(s.binding(), "hub_general", { action: "inspect" }))).toBe("unknown_tool")
    expect([await s.count("tool_invocation"), await s.count("source_consumption")]).toEqual([0, 0])
  } finally { await s.close() }
}, 120_000)

test("I2 both families run under the one binding: the call is the launch's own, recorded under the tool that made it, and a key or a message spent by one cannot be spent by the other", async () => {
  const s = await councilStage(cluster, track, { general: true })
  try {
    // Identity is never an argument, in either family.
    expect(await code(callTool(s.binding(), "hub_topic", { action: "inspect", person: "p2" }))).toBe("invalid_arguments")
    expect(await code(callTool(s.binding(), "hub_council", startArgs({ person: "p2" })))).toBe("invalid_arguments")

    // The topic family reads without writing, and says what is held in the bound conversation.
    expect(await callTool(s.binding("attempt-1"), "hub_topic", { action: "inspect" }))
      .toMatchObject({ status: "complete", stage: "nothing_held", object_id: s.master.id })
    expect(await s.count("tool_invocation")).toBe(0)

    // The council family starts on the owner's own message and is bound to the master's conversation and the running attempt.
    expect(await callTool(s.binding("attempt-1"), "hub_council", startArgs())).toMatchObject({ status: "running", stage: "workers_running" })
    expect((await s.su`select conversation_id, tool, action, execution_id from tool_invocation`).map((row: any) => ({ ...row })))
      .toEqual([{ conversation_id: s.master.id, tool: "hub_council", action: "start", execution_id: "attempt-1" }])

    // The same key under the other family is a conflict, and the message the council spent authorizes nothing else.
    expect(await code(callTool(s.binding("attempt-2"), "hub_topic", { action: "archive", request_key: "start-1", source_message_ids: ["h2"] }))).toBe("idempotency_conflict")
    expect(await code(callTool(s.binding("attempt-2"), "hub_topic", { action: "archive", request_key: "another", source_message_ids: ["h2"] }))).toBe("source_already_used")

    // A topic action that is refused after it began leaves nothing: the master is linked as a topic INSIDE the request, and
    // the refusal (this door names no archive) takes the link, the key and the message with it.
    expect(await callTool(s.binding("attempt-2"), "hub_topic", { action: "archive", request_key: "archive-1", source_message_ids: ["h1"] }))
      .toMatchObject({ status: "failed", cause: "archive_not_configured" })
    expect(await s.count("topic")).toBe(0)
    expect(await s.count("tool_invocation")).toBe(1)
    expect(await s.count("source_consumption")).toBe(1)
  } finally { await s.close() }
}, 120_000)

// ---------------------------------------------------------------------------
// I3-I4. The migrations: 013 (deployed), 014 councils, 015 topics.
// ---------------------------------------------------------------------------

const COUNCIL_TABLES = ["council", "council_participant", "council_round", "round_member", "council_decision", "council_event"]
const TOPIC_TABLES = ["identity_reservation", "topic", "topic_transition", "topic_channel_seen"]
// What both steps write into or replaced: 014 replaced `hub_report`, the claim guard and two old council writers, and both
// steps are made of the store's routines, so a routine is compared whole (owner, security, source) and never by name alone.
const SHARED = ["hub_report", "hub_guard_inbound_claim", "hub_guard_runner_incarnation", "hub_council_abandon", "hub_council_merge",
  "hub_gate_place", "hub_gate_release", "hub_gate_order", "hub_open_order", "hub_stop_request", "hub_stop_settle"]
const quoted = (names: readonly string[]) => names.map(name => `'${name}'`).join(", ")
const named = (column: string) => `${column} like 'hub_council%' or ${column} like 'hub_topic%' or ${column} like 'hub_identity%' or ${column} in (${quoted(SHARED)})`
const ROLES = quoted(["hub_door", "hub_runner", "hub_hub", "hub_agent"])

async function shape(q: any) {
  const tables = quoted([...COUNCIL_TABLES, ...TOPIC_TABLES])
  const one = async (query: string) => Array.from(await q.unsafe(query)).map((row: any) => ({ ...row }))
  return {
    functions: await one(`select p.proname, pg_get_function_identity_arguments(p.oid) as args, r.rolname as owner, p.prosecdef, p.prosrc
      from pg_proc p join pg_roles r on r.oid = p.proowner join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and (${named("p.proname")}) order by p.proname, args`),
    routineGrants: await one(`select routine_name, grantee, privilege_type from information_schema.routine_privileges
      where routine_schema = 'public' and (${named("routine_name")}) and grantee in (${ROLES}) order by routine_name, grantee, privilege_type`),
    tableGrants: await one(`select table_name, grantee, privilege_type from information_schema.role_table_grants
      where table_name in (${tables}) and grantee in (${ROLES}) order by table_name, grantee, privilege_type`),
    triggers: await one(`select c.relname as tbl, t.tgname, pg_get_triggerdef(t.oid) as def from pg_trigger t join pg_class c on c.oid = t.tgrelid
      where not t.tgisinternal and c.relname in ('inbound', 'conversation', 'runner_incarnation', 'replay_hold', 'stop_request', ${tables}) order by c.relname, t.tgname`),
    policies: await one(`select policyname, cmd, roles::text as roles, with_check from pg_policies where tablename = 'ledger_event' order by policyname`),
    // By name, so a store at 014 (which has no topic table yet) is read the same way as one at 015.
    constraints: await one(`select r.relname as tbl, c.conname, pg_get_constraintdef(c.oid) as def from pg_constraint c join pg_class r on r.oid = c.conrelid
      where r.relnamespace = 'public'::regnamespace and r.relname in ('hub_protocol', ${tables}) order by r.relname, c.conname`),
    columns: await one(`select table_name, column_name, data_type, is_nullable, column_default from information_schema.columns
      where table_name in (${tables}) order by table_name, ordinal_position`),
    indexes: await one(`select indexname, indexdef from pg_indexes where tablename in (${tables}) order by indexname`),
  }
}
type Shape = Awaited<ReturnType<typeof shape>>

const versionsOf = async (q: any) => (await q`select version from schema_version order by version`).map((row: any) => Number(row.version))
const exists = async (q: any, table: string) => (await q.unsafe(`select to_regclass('public.${table}') is not null as there`))[0].there as boolean

test("I3 the list is whole and ordered, and a store upgraded 013 to 014 to 015 carries what a fresh one does: both features' routines, fences and grants, and nothing of 014 rewritten by 015", async () => {
  expect(MIGRATION_FILES.map(([version]) => version)).toEqual(whole(15))
  expect(MIGRATION_FILES.slice(-2)).toEqual([[14, "014-councils.sql"], [15, "015-topics.sql"]])

  // The deployed store: everything through 013, with live work in it.
  const stepped = await rolloutDatabase(cluster, true)
  track(stepped.sql)
  const opened = (role?: string) => { const store = stepped.store(role); track(store.sql); return store }
  await migrate(opened(), files(13))
  await stepped.sql`insert into inbound (id, person, agent, body) values ('live-1', 'p1', 'p1-lair', 'a message in flight')`
  expect(await versionsOf(stepped.sql)).toEqual(whole(13))

  // 014 alone: councils are there and topics are not, so a store that has one and not the other is a store.
  await migrate(opened(), files(14))
  expect(await versionsOf(stepped.sql)).toEqual(whole(14))
  expect([await exists(stepped.sql, "council"), await exists(stepped.sql, "topic")]).toEqual([true, false])
  const at14 = await shape(stepped.sql)

  // 015 on top, twice: the second changes nothing.
  await migrate(opened())
  await migrate(opened())
  expect(await versionsOf(stepped.sql)).toEqual(whole(15))
  const after = await shape(stepped.sql)

  const fresh = await rolloutDatabase(cluster)
  track(fresh.sql)
  expect(await versionsOf(fresh.sql)).toEqual(whole(15))
  const born: Shape = await shape(fresh.sql)
  for (const part of Object.keys(born) as (keyof Shape)[]) expect(after[part], `${part}: upgraded and fresh`).toEqual(born[part])

  // 015 added its own objects and replaced none of 014's or 013's: every routine, grant and trigger 014 wrote is as it was.
  const ours = (row: { proname?: string; routine_name?: string }) => /^hub_(topic|identity)/.test(row.proname ?? row.routine_name ?? "")
  expect(after.functions.filter(row => !ours(row))).toEqual(at14.functions)
  expect(after.routineGrants.filter(row => !ours(row))).toEqual(at14.routineGrants)
  expect(after.policies).toEqual(at14.policies)
  expect(after.constraints.filter(row => row.tbl === "hub_protocol")).toEqual(at14.constraints.filter(row => row.tbl === "hub_protocol"))
  const onInbound = (shaped: Shape) => new Set(shaped.triggers.filter(row => row.tbl === "inbound").map(row => row.tgname))
  expect(onInbound(after)).toEqual(new Set([...onInbound(at14), "inbound_refuses_reserved"]))
  expect(onInbound(after)).toContain("inbound_no_new_legacy_council")
  expect(after.triggers.filter(row => row.tbl === "conversation").map(row => row.tgname)).toContain("conversation_refuses_reserved")

  // Who may call what, from both steps, on the same store: each family's routines with the roles its own step gave them.
  const grantees = (name: string) => [...new Set(after.routineGrants.filter(row => row.routine_name === name).map(row => row.grantee))].sort()
  expect(grantees("hub_council_job")).toEqual(["hub_door", "hub_runner"])
  expect(grantees("hub_council_event_put")).toEqual(["hub_door", "hub_runner"])
  expect(grantees("hub_topic_confirm")).toEqual(["hub_door", "hub_hub", "hub_runner"])
  expect(grantees("hub_topic_transition_request")).toEqual(["hub_door", "hub_hub", "hub_runner"])
  expect(grantees("hub_gate_place")).toEqual(["hub_door", "hub_hub", "hub_runner"])
  expect(after.routineGrants.some(row => row.grantee === "hub_agent" && /^hub_(council|topic|identity)/.test(row.routine_name)),
    "a model's login has no routine of either family").toBe(false)

  // The step touched no row of the deployed store, and made no council and no topic of its own.
  expect(Number((await stepped.sql`select count(*)::int as n from inbound where id in ('live-1', 'old-input')`)[0].n)).toBe(2)
  for (const table of [...COUNCIL_TABLES, ...TOPIC_TABLES]) {
    expect(Number((await stepped.sql.unsafe(`select count(*)::int as n from ${table}`))[0].n), table).toBe(0)
  }
}, 120_000)

test("I4 on one store the fences of both features hold together: an old door's council job and a retired agent's message are each refused by name, a report and a new-design job's function are not, and both families' routines run as their roles", async () => {
  const db = await rolloutDatabase(cluster, true)
  track(db.sql)
  const opened = (role?: string) => { const store = db.store(role); track(store.sql); return store }
  await migrate(opened(), files(13))
  await migrate(opened())
  const hub = opened("hub_hub")
  const door = opened("hub_door")
  const runner = opened("hub_runner")

  // 014's: a council of the earlier design cannot be made again, by any writer.
  await expect(attempt(db.sql`insert into inbound (id, person, agent, body, kind, source) values ('old-door-job', 'p1', 'p1-w1', 'weigh it', 'job',
    ${{ dispatch: { council: { id: "c-old", seats: ["p1-w1"] } } }}::jsonb)`)).rejects.toThrow(/legacy-council-closed/)

  // 015's: a retired identity is never given a message or a conversation, and its worker's result is still accepted.
  expect(await reserveIdentity(hub, "agent", "p1-retired", "topic deleted", { by: "test" })).toBe(true)
  await expect(attempt(db.sql`insert into inbound (id, person, agent, body, kind) values ('m-retired', 'p1', 'p1-retired', 'hello', 'human')`)).rejects.toThrow(/identity-reserved/)
  await expect(attempt(db.sql`insert into conversation (id, person, agent, kind, adapter, native_session) values ('c-retired', 'p1', 'p1-retired', 'master', 'synthetic', 's')`))
    .rejects.toThrow(/identity-reserved/)
  await db.sql`insert into inbound (id, person, agent, body, kind) values ('r-retired', 'p1', 'p1-retired', 'a result', 'report')`

  // Both families' routines are there for the roles that own them, and each answers as its own step says.
  expect((await door.sql`select hub_identity_reserved('agent', 'p1-retired') as reserved`)[0].reserved).toBe(true)
  await expect(attempt(runner.sql`select hub_council_job('j-x', 'p1', 'p1-w1', 'task', ${{ dispatch: { council_round: { council: "nobody" } } }}::jsonb)`))
    .rejects.toThrow(/council-job-unknown/)
  expect((await runner.sql`select hub_council_abandon('j-x', 'grace') as gone`)[0].gone, "014's switched-off writer is still off").toBe(false)
}, 120_000)

// ---------------------------------------------------------------------------
// I5. A topic master with a council running.
// ---------------------------------------------------------------------------

test("I5 archiving the master of a running council gates that master only: the council, its roster and a worker's attempt are untouched, and reopening serves what waited", async () => {
  const s = await councilStage(cluster, track, { general: true })
  try {
    const started = await callTool(s.binding("attempt-start"), "hub_council", startArgs())
    const id = String(started.object_id)
    const [first, second] = await s.jobsOf(id)
    // A worker's attempt the owner approved, running now; and something for the master that arrived after the council began.
    const working = await s.running(first.id)
    await s.human("h3")
    const eligible = async () => (await readEligible(s.runner, { agent: "p1-lair", runner: "runner-a", resumeOk: true })).map(row => row.id)
    expect(await eligible()).toContain("h3")

    // The master is a topic (an adopted master, linked once, keeping the conversation the council is bound to).
    const where = s.placement("p1-lair")
    const topic = await linkLegacyTopic(s.runner, { person: PERSON, agent: "p1-lair", door: DOOR, chat: CHAT, machine: where.machine,
      runner: RUNNER, preset: "daily", adapter: where.adapter, display_name: "lair" })
    expect(topic).toMatchObject({ origin: "legacy", lifecycle: "active", conversation_id: s.master.id })

    const ask = (operation: string, kind: "archive" | "reopen") => requestTransition(s.runner, { operation, topic: topic.id, kind, source: "tool", by: PERSON,
      route: { door: DOOR, chat: CHAT }, evidence: {} })
    const gates = async () => (await s.su`select scope_id, cause, state from claim_gate order by scope_id, cause`).map((row: any) => ({ ...row }))

    // ARCHIVE: the master's agent is gated and nothing else is.
    expect(await ask("op-archive", "archive")).toBe("ok")
    expect(await gates()).toEqual([{ scope_id: "p1-lair", cause: "archive", state: "open" }])
    expect(await eligible(), "the archived master is handed nothing").toEqual([])
    expect((await s.su`select lifecycle from council where id = ${id}`)[0].lifecycle, "the council is where it was").toBe("running")
    expect(await s.jobsOf(id), "no job was added, replaced or stopped").toHaveLength(2)
    expect(await s.count("stop_request", `execution_id = '${working.execution}'`), "the worker's attempt was not asked to stop").toBe(0)
    expect((await s.su`select state from execution where id = ${working.execution}`)[0].state).not.toMatch(/stop/)

    // A worker answers while the master is archived: its answer is recorded, the council is not made to wait for anything else,
    // and the master still takes nothing.
    await s.answer(second.id, "Once is enough when the scale is warm.")
    expect((await s.su`select state from round_member where inbound_id = ${second.id}`)[0].state).toBe("answered")
    expect((await s.su`select lifecycle from council where id = ${id}`)[0].lifecycle).toBe("running")
    expect(await eligible()).toEqual([])

    // The archive is complete only when the channel shows it; the gate stays for as long as the topic is archived.
    expect(await completeTransition(s.door, "op-archive", {}, null)).toBe("channel-pending")
    expect(await recordChannel(s.door, "op-archive", "applied", { parent: null }, { ok: true })).toBe("applied")
    expect(await completeTransition(s.door, "op-archive", {}, null)).toBe("complete")
    expect((await readTopicByAgent(s.runner, "p1-lair"))!.lifecycle).toBe("archived")
    expect(await gates()).toEqual([{ scope_id: "p1-lair", cause: "archive", state: "open" }])
    expect(await eligible()).toEqual([])

    // REOPEN releases that gate and no other, and what waited is served.
    expect(await ask("op-reopen", "reopen")).toBe("ok")
    expect(await recordChannel(s.door, "op-reopen", "applied", { parent: null }, { ok: true })).toBe("applied")
    expect(await completeTransition(s.door, "op-reopen", {}, null)).toBe("complete")
    expect((await readTopicByAgent(s.runner, "p1-lair"))!.lifecycle).toBe("active")
    expect(await gates()).toEqual([{ scope_id: "p1-lair", cause: "archive", state: "released" }])
    expect(await eligible()).toContain("h3")
    expect((await s.su`select lifecycle from council where id = ${id}`)[0].lifecycle).toBe("running")
  } finally { await s.close() }
}, 120_000)
