// The councils of the earlier design, read into the new tables by migration 014 from what the store really holds.
//
// Nothing is replayed, merged or abandoned by the step: a merged council is history and stays inspectable, an
// open one whose seats have not all answered goes on running or waits for its owner with the cause it has, and one
// that has every answer and never merged says so and makes no result by itself. A seat that settles after the
// upgrade lands through the same code as any other member's, and the old clock is off.
//
// The migration reads a held seat's cause from its hold, and L5 seeds one: a disposable old council whose seat's
// attempt reached the engine and was interrupted, built with the store's own functions on a schema at 13. No copy of a
// real database is used.

import { afterAll, afterEach, beforeAll, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { startCluster, hubPath, waitForLockWaiter, type Cluster } from "./helpers/cluster.ts"
import { rolloutDatabase } from "./helpers/rollout-fixtures.ts"
import { GONE, turnOf } from "./helpers/council-stage.ts"
import { MIGRATION_FILES, migrate } from "../src/store/migrate.ts"
import { settleTurn } from "../src/runner/settle.ts"
import { endAttempt } from "../src/runner/execution.ts"
import { reconcileCouncil } from "../src/council/reconcile.ts"
import { readSnapshot } from "../src/council/snapshot.ts"
import { statusLine } from "../src/council/lines.ts"
import { conversationFor, markFeedIntent, openExecution, registerIncarnation } from "../src/store/conversations.ts"
import { chooseHold } from "../src/recovery/holds.ts"
import { storeUrlAs, type StoreLike } from "../src/store/connect.ts"

let cluster: Cluster
beforeAll(async () => { cluster = await startCluster() })
afterAll(async () => { await cluster?.stop() })

const mine: { close(): Promise<void> }[] = []
const track = <T extends { close(): Promise<void> }>(sql: T): T => { mine.push(sql); return sql }
afterEach(async () => { for (const one of mine.splice(0)) await one.close().catch(() => {}) })

const files = (upTo: number) => MIGRATION_FILES.filter(([version]) => version <= upTo)
  .map(([version, file]) => ({ version, sql: readFileSync(join(hubPath("src/store/migrations"), file), "utf8") }))

const SEATS = ["p1-seat-1", "p1-seat-2", "p1-seat-3"]
const ROUTE = { agent: "p1-lair", door: "door-fake", chat: "1000000001" }
const AT = "2026-09-20T12:00:00.000Z"

/** The rows of an old council as the store held them: a seat's job, its report, and the sheet row of the council. */
function planters(sql: any) {
  const job = async (cid: string, seat: string, state = "received") => {
    const id = `${cid}:${seat}`
    const source = { log_id: id, at: AT, from: "p1", text: "weigh it", origin: "council",
      dispatch: { dispatcher: "p1-lair", target: seat, approved: { by: "p1", at: AT, digest: "d", source: "council" }, return: ROUTE,
        council: { id: cid, seats: SEATS } } }
    await sql`insert into inbound (id, person, agent, body, kind, source, state, received_at)
      values (${id}, 'p1', ${seat}, ${"Answer the question below on your own. State your position and your reasons, and name what you are unsure of. No preamble.\n\nshould the ledger be weighed twice"},
              'job', ${JSON.stringify(source)}::text::jsonb, ${state}, ${AT})`
    return id
  }
  const report = async (id: string, text: string) => {
    await sql`insert into inbound (id, person, agent, body, kind, source, state, log_ready, received_at, reported_at)
      values (${"report:" + id}, 'p1', 'p1-lair', ${text}, 'report', ${JSON.stringify({ log_id: "report:" + id, origin: "council", job: id })}::text::jsonb, 'answered', true, ${AT}, ${AT})`
  }
  const sheet = async (cid: string) => sql`insert into state_row (sheet, id, data) values ('council', ${cid}, ${JSON.stringify({ task: "should the ledger be weighed twice", at: AT })}::text::jsonb)`
  return { job, report, sheet }
}

async function seed(sql: any) {
  const { job, report, sheet } = planters(sql)
  // A: merged. Every seat answered and the merge row was written.
  for (const seat of SEATS) { const id = await job("council-a", seat, "answered"); await report(id, `answer of ${seat}`) }
  await sql`insert into inbound (id, person, agent, body, kind, source, state, log_ready, received_at, reported_at)
    values ('merge:council-a', 'p1', 'p1-lair', 'merged', 'report', ${JSON.stringify({ log_id: "merge:council-a", origin: "council" })}::text::jsonb, 'answered', true, ${AT}, ${AT})`
  // B: one answered, one given up on (job answered, no report), one unclaimed. A member is missing.
  { const one = await job("council-b", SEATS[0], "answered"); await report(one, "answer one") }
  await job("council-b", SEATS[1], "answered")
  await job("council-b", SEATS[2])
  await sheet("council-b")
  // C: every seat answered, never merged.
  for (const seat of SEATS) { const id = await job("council-c", seat, "answered"); await report(id, `answer of ${seat}`) }
  await sheet("council-c")
  // D: nothing answered, nothing lost: still open.
  for (const seat of SEATS) await job("council-d", seat)
  await sheet("council-d")
}

async function upgraded() {
  const db = await rolloutDatabase(cluster, true)
  track(db.sql)
  const opened = () => { const one = db.store(); track(one.sql); return one }
  await migrate(opened(), files(13))
  await seed(db.sql)
  const before = {
    inbound: Number((await db.sql`select count(*)::int as n from inbound`)[0].n),
    sheets: Number((await db.sql`select count(*)::int as n from state_row where sheet = 'council'`)[0].n),
  }
  await migrate(opened())
  return { ...db, before }
}

test("L1 the step reads each old council as what it is, from the store's own rows: merged is complete history, a missing seat waits for the owner, all answered without a merge says so, untouched is still running", async () => {
  const it = await upgraded()
  const rows = Array.from(await it.sql`select id, origin_kind, lifecycle, waiting, result, question, legacy_of, current_round, return_route from council order by id`) as any[]
  expect(rows.map(one => [one.id, one.origin_kind, one.lifecycle])).toEqual([
    ["council-a", "legacy", "complete"], ["council-b", "legacy", "waiting_owner"], ["council-c", "legacy", "waiting_owner"], ["council-d", "legacy", "running"]])
  const by = Object.fromEntries(rows.map(one => [one.id, one]))
  expect(by["council-a"].result).toEqual({ legacy_merge: "merge:council-a" })
  expect(by["council-b"].waiting).toMatchObject({ kind: "members_missing", legacy: true, members: ["council-b:p2"] })
  expect(by["council-c"].waiting).toEqual({ kind: "legacy_unmerged", legacy: true })
  expect(by["council-d"].waiting).toBeNull()
  for (const one of rows) {
    expect(one.question).toBe("should the ledger be weighed twice")
    expect(one.legacy_of).toBe(one.id)
    expect(one.return_route).toEqual(ROUTE)
  }
  const members = (cid: string) => it.sql`select participant_id, state, cause, report_id from round_member where council_id = ${cid} order by participant_id`
  expect((await members("council-a")).map((one: any) => one.state)).toEqual(["answered", "answered", "answered"])
  const b = Array.from(await members("council-b")) as any[]
  expect(b.map(one => one.state)).toEqual(["answered", "missing", "open"])
  expect(b[0].report_id).toBe("report:council-b:p1-seat-1")
  expect(b[1].cause).toMatchObject({ kind: "given-up", legacy: true })
  expect((await members("council-d")).map((one: any) => one.state)).toEqual(["open", "open", "open"])
  expect((await it.sql`select worker_agent from council_participant where council_id = 'council-b' order by ordinal`).map((one: any) => one.worker_agent)).toEqual(SEATS)
})

test("L2 the step invents nothing: no merge, no job, no event, no notice, no gate and no stop; the old sheet rows are gone and the rest of the store is as it was", async () => {
  const it = await upgraded()
  expect(Number((await it.sql`select count(*)::int as n from inbound`)[0].n), "no row was added to the queue").toBe(it.before.inbound)
  expect((await it.sql`select id from inbound where id like 'merge:%' order by id`).map((one: any) => one.id), "only the one merge that already existed").toEqual(["merge:council-a"])
  for (const table of ["council_event", "claim_gate", "stop_request", "platform_effect"]) {
    expect(Number((await it.sql.unsafe(`select count(*)::int as n from ${table}`))[0].n), `${table} is untouched`).toBe(0)
  }
  // The fixture's two delivered/pending replies are the only outbox rows: no notice was said.
  expect(Number((await it.sql`select count(*)::int as n from outbox`)[0].n)).toBe(2)
  expect(Number((await it.sql`select count(*)::int as n from state_row where sheet = 'council'`)[0].n)).toBe(0)
  expect(it.before.sheets).toBe(3)
  expect((await it.sql`select kind, actor from ledger_event where stream = 'council' order by subject`).map((one: any) => [one.kind, one.actor])).toEqual([
    ["legacy.read", "hub"], ["legacy.read", "hub"], ["legacy.read", "hub"], ["legacy.read", "hub"]])
  const versions = (await it.sql`select version from schema_version order by version`).map((one: any) => Number(one.version))
  expect(versions).toEqual(MIGRATION_FILES.map(([version]) => version))
})

test("L3 the old clock is off: abandoning a seat now answers false and stamps nothing, and a fresh council of this design can be started beside the legacy ones", async () => {
  const it = await upgraded()
  const runner = track(cluster.connectAs("hub_runner", it.database)) as any
  expect((await runner`select hub_council_abandon('council-d:p1-seat-3', 'grace') as gone`)[0].gone).toBe(false)
  expect((await it.sql`select state from inbound where id = 'council-d:p1-seat-3'`)[0].state, "the seat is still waiting for its worker").toBe("received")
  // The catalog is the same as a fresh install's for the council objects.
  const fresh = await rolloutDatabase(cluster)
  track(fresh.sql)
  const shape = async (q: any) => Array.from(await q`select table_name, column_name, data_type, is_nullable from information_schema.columns
    where table_name in ('council', 'council_participant', 'council_round', 'round_member', 'council_decision', 'council_event') order by table_name, ordinal_position`)
  expect(await shape(it.sql)).toEqual(await shape(fresh.sql))
  expect((await fresh.sql`select count(*)::int as n from council`)[0].n).toBe(0)
})

test("L4 a seat that settles after the upgrade lands through the same code as any member: its report is recorded and never fed, the member is answered, and the last answer without a merge waits for the owner and makes no result", async () => {
  const it = await upgraded()
  const runner = { sql: track(cluster.connectAs("hub_runner", it.database)) as any, url: storeUrlAs(cluster.url(it.database), "hub_runner") }
  for (const seat of SEATS.slice(0, 2)) {
    const [row] = await it.sql`select id, source from inbound where id = ${"council-d:" + seat}`
    await settleTurn(runner as never, { inboundId: row.id, kind: "job", person: "p1", source: row.source, chunks: [`late answer of ${seat}`], turn: turnOf(seat) })
  }
  expect((await it.sql`select lifecycle from council where id = 'council-d'`)[0].lifecycle, "two of three is still running").toBe("running")
  const [last] = await it.sql`select id, source from inbound where id = ${"council-d:" + SEATS[2]}`
  await settleTurn(runner as never, { inboundId: last.id, kind: "job", person: "p1", source: last.source, chunks: ["late answer of the last"], turn: turnOf(SEATS[2]) })
  const report = (await it.sql`select kind, state, source from inbound where id = ${"report:" + last.id}`)[0]
  expect(report).toMatchObject({ kind: "report", state: "answered" })
  expect(report.source.origin).toBe("council")
  const [council] = Array.from(await it.sql`select lifecycle, waiting, result from council where id = 'council-d'`) as any[]
  expect(council).toMatchObject({ lifecycle: "waiting_owner", waiting: { kind: "legacy_unmerged", legacy: true }, result: null })
  expect((await it.sql`select state from round_member where council_id = 'council-d' order by participant_id`).map((one: any) => one.state)).toEqual(["answered", "answered", "answered"])
  // Nothing was made for the master and nothing was merged: the owner is asked, in words, and told nothing is made alone.
  expect(Number((await it.sql`select count(*)::int as n from council_event where council_id = 'council-d'`)[0].n)).toBe(0)
  expect(Number((await it.sql`select count(*)::int as n from inbound where id = 'merge:council-d'`)[0].n)).toBe(0)
  const snapshot = await readSnapshot(runner as never, "council-d", { now: new Date(), quietSeconds: 300 })
  expect(snapshot).toMatchObject({ stage: "waiting-owner", legacy: true })
  expect(statusLine("en", snapshot!)).toContain("None is made on its own")
  expect(statusLine("ru", snapshot!)).toContain("Итог не создаётся сам")
})

test("L5 a held seat survives the step: its hold, cause and history are kept, the council waits for its owner, and nothing merges, replays, continues or queues a new input", async () => {
  const db = await rolloutDatabase(cluster, true)
  track(db.sql)
  const opened = () => { const one = db.store(); track(one.sql); return one }
  await migrate(opened(), files(13))
  const runner = { sql: track(cluster.connectAs("hub_runner", db.database)), url: cluster.url(db.database) } as StoreLike
  const { job, report, sheet } = planters(db.sql)
  // Seat 1 answered, seat 2 HELD, seat 3 still open.
  { const one = await job("council-e", SEATS[0], "answered"); await report(one, "answer one") }
  const held = await job("council-e", SEATS[1])
  await job("council-e", SEATS[2])
  await sheet("council-e")
  // The held seat, the way the runner leaves one: a worker's attempt claimed, opened, handed its input and ended on proof that
  // its process is gone. The hold, the conversation and the recorded input are the store's own, written by its own functions.
  await registerIncarnation(runner, { runner: "runner-a", incarnation: "one", machine: "pi", bootId: null })
  await db.sql`update inbound set claimed_by = 'runner-a', claim_deadline = now() + interval '1 hour' where id = ${held}`
  const [row] = await db.sql`select id, person, agent, kind, source from inbound where id = ${held}`
  const conversation = await conversationFor(runner, { row, adapter: "claude-code", machine: "pi" })
  const attempt = await openExecution(runner, { row: { id: row.id, agent: row.agent }, conversation, runner: "runner-a", incarnation: "one", digest: "d", nativeSession: null })
  await markFeedIntent(runner, attempt, `task ${held}`)
  await endAttempt(runner, { execution: attempt.id, evidence: GONE, cause: "gone" })

  const everything = async () => ({
    inbound: Array.from(await db.sql`select id, state, claimed_by, retry_at from inbound order by id`).map((one: any) => ({ ...one })),
    execution: Array.from(await db.sql`select id, inbound_id, state, runner, incarnation from execution order by id`).map((one: any) => ({ ...one })),
    holds: Array.from(await db.sql`select inbound_id, execution_id, conversation_id, cause, state, revision, choice, continuation_id from replay_hold order by inbound_id`).map((one: any) => ({ ...one })),
    entries: Array.from(await db.sql`select conversation_id, source_id, kind from conversation_entry order by conversation_id, seq`).map((one: any) => ({ ...one })),
    conversations: Array.from(await db.sql`select id, owner_ref, native_state from conversation order by id`).map((one: any) => ({ ...one })),
    ledger: Number((await db.sql`select count(*)::int as n from ledger_event where stream <> 'council'`)[0].n),
  })
  const before = await everything()
  expect(before.holds, "the seed is a real hold on the seat's own job").toMatchObject([{ inbound_id: held, execution_id: attempt.id, conversation_id: conversation.id, cause: "interrupted", state: "held", continuation_id: null }])
  expect(before.entries.length, "and the seat has a history").toBeGreaterThan(0)

  await migrate(opened())
  // The council is read from the hold: the seat is missing with the store's own cause and the attempt it names.
  const [council] = Array.from(await db.sql`select lifecycle, waiting, result, origin_kind from council where id = 'council-e'`) as any[]
  expect(council).toMatchObject({ origin_kind: "legacy", lifecycle: "waiting_owner", result: null, waiting: { kind: "members_missing", legacy: true, members: ["council-e:p2"] } })
  const members = Array.from(await db.sql`select participant_id, state, cause, report_id from round_member where council_id = 'council-e' order by participant_id`) as any[]
  expect(members.map(one => one.state)).toEqual(["answered", "missing", "open"])
  expect(members[1].cause).toMatchObject({ kind: "interrupted", attempt: attempt.id, legacy: true })
  expect((await db.sql`select first_inbound, worker_conversation from council_participant where id = 'council-e:p2'`)[0]).toMatchObject({ first_inbound: held, worker_conversation: conversation.id })

  // Nothing was merged, replayed, continued or queued: every row, attempt, hold and entry is as it was, and the hold still holds the old input.
  expect(await everything(), "the step moved nothing of the seat").toEqual(before)
  expect((await db.sql`select hub_row_held(${held}) as held`)[0].held).toBe(true)
  for (const table of ["council_event", "claim_gate", "stop_request", "platform_effect"]) {
    expect(Number((await db.sql.unsafe(`select count(*)::int as n from ${table}`))[0].n), `${table} is untouched`).toBe(0)
  }
  expect(Number((await db.sql`select count(*)::int as n from inbound where id like 'merge:council-e' or id like 'continue:%'`)[0].n)).toBe(0)

  // The council's own reconcile (what a settle or the door's wake runs) leaves the hold alone too: the cause stays the store's, the
  // council keeps waiting for its owner, no event is written for the master and nothing is queued.
  await reconcileCouncil(runner, "council-e")
  await reconcileCouncil(runner, "council-e")
  expect(await everything(), "reconciling moved nothing of the seat").toEqual(before)
  const [after] = Array.from(await db.sql`select state, cause from round_member where participant_id = 'council-e:p2'`) as any[]
  expect(after).toMatchObject({ state: "missing", cause: { kind: "interrupted", attempt: attempt.id } })
  expect((await db.sql`select lifecycle from council where id = 'council-e'`)[0].lifecycle).toBe("waiting_owner")
  expect(Number((await db.sql`select count(*)::int as n from council_event`)[0].n)).toBe(0)
  const snapshot = await readSnapshot(runner, "council-e", { now: new Date(), quietSeconds: 300 })
  expect(snapshot).toMatchObject({ stage: "waiting-owner", legacy: true })
  expect(snapshot?.members.find(one => one.participant === "council-e:p2")).toMatchObject({ view: "missing", cause: { kind: "interrupted" } })
})

// ---------------------------------------------------------------------------
// THE CUTOVER OF THE OLD DESIGN'S WRITERS.
//
// A runner of protocol 3 is fenced from a council of this design, and it says nothing about an old DOOR: an old door goes on writing a seat's job for
// every configured seat and a sheet row until it is upgraded, and an old runner writes the merge at the last seat's settle. The step closes both in the
// database. It does not claim that every old late settle merges (an ordinary old settle after the step reads the sheet row, which is gone, and returns);
// it closes what remains: a writer that had read the row before, a caller that does not read it, and a door that creates a council.
// ---------------------------------------------------------------------------

const ROUTE_TEXT = JSON.stringify(ROUTE)

test("L6 the old merge writer writes nothing after the step, whichever council it is called for, and the merges already written are history that stays as it was", async () => {
  const it = await upgraded()
  const runner = track(cluster.connectAs("hub_runner", it.database)) as any
  const before = Array.from(await it.sql`select id, body, state from inbound where id like 'merge:%' order by id`).map((one: any) => ({ ...one }))
  expect(before.map(one => one.id), "the one merge that was written before the step").toEqual(["merge:council-a"])
  const merge = async (council: string) => (await runner`select hub_council_merge(${council}, 'p1-lair', 'p1', 'a synthesis nobody asked the master for', ${ROUTE_TEXT}::text::jsonb, now()) as wrote`)[0].wrote
  // An open council, one with a missing seat, one with every seat answered, and the merged one: nothing is written for any of them.
  for (const council of ["council-b", "council-c", "council-d", "council-a", "council-nobody"]) expect(await merge(council), `${council}: the writer answers false`).toBe(false)
  expect(Array.from(await it.sql`select id, body, state from inbound where id like 'merge:%' order by id`).map((one: any) => ({ ...one })), "no merge row was added or changed").toEqual(before)
  // History is read as it was: the merged council is complete, with its merge named, and nothing else changed state.
  const rows = Array.from(await it.sql`select id, lifecycle, result from council order by id`).map((one: any) => [one.id, one.lifecycle, one.result])
  expect(rows).toEqual([["council-a", "complete", { legacy_merge: "merge:council-a" }], ["council-b", "waiting_owner", null], ["council-c", "waiting_owner", null], ["council-d", "running", null]])
})

test("L7 after the step an old door cannot make a council: its seat job is refused in its own transaction and leaves nothing behind, while a held seat's authorized continuation, a report and every ordinary write are untouched", async () => {
  const it = await upgraded()
  const { job, sheet } = planters(it.sql)
  // The old door's creation: a sheet row and a seat's job for every configured seat. The job is refused by the table, by name.
  await expect(job("council-z", SEATS[0])).rejects.toThrow(/legacy-council-closed/)
  await expect(it.sql.begin(async (tx: any) => {
    const inside = planters(tx)
    await inside.sheet("council-z")
    for (const seat of SEATS) await inside.job("council-z", seat)
  }), "the whole transaction of the old door fails").rejects.toThrow(/legacy-council-closed/)
  expect(Number((await it.sql`select count(*)::int as n from inbound where id like 'council-z:%'`)[0].n), "no seat job").toBe(0)
  expect(Number((await it.sql`select count(*)::int as n from state_row where sheet = 'council' and id = 'council-z'`)[0].n), "and no sheet row (it was in the same transaction)").toBe(0)
  expect(Number((await it.sql`select count(*)::int as n from council where id = 'council-z'`)[0].n)).toBe(0)
  void sheet

  // What the step does not touch: an ordinary job, and a job of the old shape that is the owner's authorized continuation of a held seat
  // (`dispatch.continues`, written by the store's own recovery), are let through.
  await it.sql`insert into inbound (id, person, agent, body, kind, source) values ('ordinary-job', 'p1', 'p1-seat-1', 'weigh something else', 'job',
    ${JSON.stringify({ log_id: "ordinary-job", at: AT, from: "p1", text: "x", dispatch: { dispatcher: "p1-lair", target: "p1-seat-1", approved: { by: "p1", at: AT, digest: "d", source: "chat-command" }, return: ROUTE } })}::text::jsonb)`
  expect(Number((await it.sql`select count(*)::int as n from inbound where id = 'ordinary-job'`)[0].n)).toBe(1)
  const continued = { log_id: "continue:x", at: AT, from: "p1", text: "x", origin: "council", dispatch: { dispatcher: "p1-lair", target: "p1-seat-1", approved: { by: "p1", at: AT, digest: "d", source: "recovery" },
    return: ROUTE, council: { id: "council-d", seats: SEATS }, continues: "council-d:p1-seat-1" } }
  await it.sql`insert into inbound (id, person, agent, body, kind, source) values ('continue:probe', 'p1', 'p1-seat-1', 'x', 'job', ${JSON.stringify(continued)}::text::jsonb)`
  expect(Number((await it.sql`select count(*)::int as n from inbound where id = 'continue:probe'`)[0].n), "the continuation of a held seat is let through").toBe(1)
})

test("L8 a held legacy seat's owner-authorized recovery still works after the step: the store's own continuation is written, and nothing about it is refused as a new council", async () => {
  const db = await rolloutDatabase(cluster, true)
  track(db.sql)
  const opened = () => { const one = db.store(); track(one.sql); return one }
  await migrate(opened(), files(13))
  const runner = { sql: track(cluster.connectAs("hub_runner", db.database)), url: cluster.url(db.database) } as StoreLike
  const { job, report, sheet } = planters(db.sql)
  { const one = await job("council-e", SEATS[0], "answered"); await report(one, "answer one") }
  const held = await job("council-e", SEATS[1])
  await job("council-e", SEATS[2])
  await sheet("council-e")
  await registerIncarnation(runner, { runner: "runner-a", incarnation: "one", machine: "pi", bootId: null })
  await db.sql`update inbound set claimed_by = 'runner-a', claim_deadline = now() + interval '1 hour' where id = ${held}`
  const [row] = await db.sql`select id, person, agent, kind, source from inbound where id = ${held}`
  const conversation = await conversationFor(runner, { row, adapter: "claude-code", machine: "pi" })
  const attempt = await openExecution(runner, { row: { id: row.id, agent: row.agent }, conversation, runner: "runner-a", incarnation: "one", digest: "d", nativeSession: null })
  await markFeedIntent(runner, attempt, `task ${held}`)
  await endAttempt(runner, { execution: attempt.id, evidence: GONE, cause: "gone" })
  await migrate(opened())
  // The owner chooses to continue the held seat, with the store's own choice: a new input, marked as a continuation, on the same conversation.
  expect(await chooseHold(runner, { attempt: attempt.id, agent: row.agent, revision: 1, choice: "continue", by: "p1", evidence: { source: "test" }, context: "carry on" })).toBe("continuing")
  const [next] = Array.from(await db.sql`select id, source from inbound where id = ${"continue:" + held + ":1"}`) as any[]
  expect(next.source.dispatch).toMatchObject({ continues: held, conversation: conversation.id, council: { id: "council-e" } })
  // And the door still cannot make a new council beside it.
  await expect(job("council-y", SEATS[0])).rejects.toThrow(/legacy-council-closed/)
})

test("L9 the boundary: an old settle that had read its sheet row when the step began finishes, its merge included, before the step reads the old councils; and the merge writer is off from the moment the step commits", async () => {
  const db = await rolloutDatabase(cluster, true)
  track(db.sql)
  const opened = () => { const one = db.store(); track(one.sql); return one }
  await migrate(opened(), files(13))
  await seed(db.sql)
  // THE OLD SETTLE, in flight: a runner's transaction has read (and locked) the sheet row of council-d, as the old settle does before it writes anything.
  const old = await (track(cluster.connectAs("hub_runner", db.database)) as any).reserve()
  await old.unsafe("begin")
  expect((await old.unsafe("select data from state_row where sheet = 'council' and id = 'council-d' for update")).length).toBe(1)
  // The step begins while it is open, and waits for it at the sheet: it is seen waiting, not slept past.
  const migrating = migrate(opened())
  migrating.catch(() => {})
  await waitForLockWaiter(cluster, db.database, { role: cluster.superuser, relation: "state_row", timeoutMs: 15_000 })
  // The old settle goes on, with the old function (the step has not changed it: it is waiting), and lands the merge of the last seat, and commits.
  expect((await old.unsafe("select hub_council_merge($1::text, 'p1-lair', 'p1', 'the merge of the last seat', $2::text::jsonb, now()) as wrote", ["council-d", ROUTE_TEXT]))[0].wrote).toBe(true)
  await old.unsafe("commit")
  old.release()
  await migrating
  // The step read the old councils after it: council-d is a merged council, named as such, and its merge row is the history it had.
  expect((await db.sql`select lifecycle, result from council where id = 'council-d'`)[0]).toMatchObject({ lifecycle: "complete", result: { legacy_merge: "merge:council-d" } })
  expect(Number((await db.sql`select count(*)::int as n from inbound where id = 'merge:council-d'`)[0].n)).toBe(1)
  expect(Number((await db.sql`select count(*)::int as n from state_row where sheet = 'council'`)[0].n), "the sheet rows are gone").toBe(0)
  // From the commit on the writer is off, for the same council too.
  const runner = track(cluster.connectAs("hub_runner", db.database)) as any
  expect((await runner`select hub_council_merge('council-b', 'p1-lair', 'p1', 'late', ${ROUTE_TEXT}::text::jsonb, now()) as wrote`)[0].wrote).toBe(false)
  expect(Number((await db.sql`select count(*)::int as n from inbound where id = 'merge:council-b'`)[0].n)).toBe(0)
  // And a settle that reads the row now finds it gone, as the old code returns on: a read that returns nothing changes nothing.
  await runner.begin(async (tx: any) => {
    expect((await tx`select data from state_row where sheet = 'council' and id = 'council-b' for update`).length).toBe(0)
  })
})
