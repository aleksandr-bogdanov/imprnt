// FINALIZATION AND FEED BOOKKEEPING ARE PART OF THE SETTLEMENT AND OF THE FEED INTENT, not hooks that may fail behind the transaction they ride on.
//
// The council's result is recorded in the very transaction that settles the master's reply, so a failure to record it fails that settlement, and the
// runner (which journaled the model's answer before it settled it) settles the same answer again from the journal, on its next look and at its next
// start, without giving the engine another input. The consumption of a council's event by the master's attempt is written by the feed intent's own
// transaction, so an event is never recorded as read by an attempt that was never handed it. What is persistently wrong is said by `check` and by the card.
//
// The failures are INJECTED: a trigger on the table the statement writes, switched by a row, so the same statement that fails once succeeds later.

import { afterAll, afterEach, beforeAll, expect, test } from "bun:test"
import { startCluster, type Cluster } from "./helpers/cluster.ts"
import { DOOR, CHAT, PERSON } from "./helpers/hub-fixture.ts"
import { councilStage, roster, startArgs, turnOf } from "./helpers/council-stage.ts"
import { callTool } from "../src/mcp/handlers.ts"
import { councilFindings, readLiveCouncils } from "../src/check/council.ts"
import { statusLine } from "../src/council/lines.ts"
import { readSnapshot } from "../src/council/snapshot.ts"
import { reconcileExecutions, settleStored } from "../src/runner/execution.ts"
import { settleTurn } from "../src/runner/settle.ts"
import { journalResult, markFeedIntent } from "../src/store/conversations.ts"
import { loadRegistry } from "../src/registry/load.ts"

let cluster: Cluster
beforeAll(async () => { cluster = await startCluster() })
afterAll(async () => { await cluster?.stop() })

const mine: { close(): Promise<void> }[] = []
const track = <T extends { close(): Promise<void> }>(sql: T): T => { mine.push(sql); return sql }
afterEach(async () => { for (const one of mine.splice(0)) await one.close().catch(() => {}) })

type Stage = Awaited<ReturnType<typeof councilStage>>

const move = (s: Stage, id: string, over: Record<string, unknown>, attempt: string | null = "attempt-master") =>
  s.revision(id).then(revision => callTool(s.binding(attempt), "hub_council", { action: "continue", request_key: `k-${Math.random().toString(36).slice(2, 8)}`,
    council_id: id, expected_revision: revision, ...over }))

/** A council whose every answer is in, and the event the master reads. */
async function answered(s: Stage) {
  const started = await callTool(s.binding("attempt-start"), "hub_council", startArgs({ participants: roster(["p1-w1", "p1-w2"]) }))
  const id = String(started.object_id)
  const [j1, j2] = await s.jobsOf(id)
  await s.answer(j1.id, "one")
  await s.answer(j2.id, "two")
  const [event] = Array.from(await s.su`select e.inbound_id from council_event e where e.council_id = ${id} order by e.seq`) as { inbound_id: string }[]
  return { id, event: event.inbound_id }
}

/** A trigger on `table` that raises when `condition` holds while the row `name` is in `test_switch`: the same statement fails now and succeeds when the row is deleted. */
async function inject(s: Stage, name: string, table: string, condition: string) {
  await s.su.unsafe(`create table if not exists test_switch (name text primary key)`)
  // The trigger runs as the role that writes the table (the runner's), which must be able to read the switch.
  await s.su.unsafe(`grant select on test_switch to public`)
  await s.su.unsafe(`create function test_fail_${name}() returns trigger language plpgsql as $$ begin
    if ${condition} and exists (select 1 from test_switch where name = '${name}') then raise exception 'injected: ${name}'; end if;
    return new; end $$`)
  await s.su.unsafe(`create trigger test_fail_${name} before update on ${table} for each row execute function test_fail_${name}()`)
  await s.su.unsafe(`insert into test_switch values ('${name}')`)
  return { async heal() { await s.su.unsafe(`delete from test_switch where name = '${name}'`) } }
}

test("Z1 a failed finalize bookkeeping fails the settlement: nothing is delivered or completed, the journaled answer is settled again on the next look and at a restart without a second input to the engine, and the council completes once with one reply and one reference", async () => {
  const s = await councilStage(cluster, track)
  try {
    const { id, event } = await answered(s)
    const attempt = await s.feed(event)
    expect(await move(s, id, { kind: "finalize" }, attempt.id)).toMatchObject({ stage: "preparing_result" })
    const reply = "Weigh it twice and log both readings. One view would settle for once on a warm scale."
    const fault = await inject(s, "complete", "council", "new.lifecycle = 'complete'")
    // The runner keeps the answer before it settles it.
    await journalResult(s.runner, attempt.id, { text: reply, chunks: [reply], turn: turnOf("p1-lair") })
    const [row] = await s.su`select source from inbound where id = ${event}`
    const settle = () => settleTurn(s.runner, { inboundId: event, kind: "report", person: PERSON, source: row.source, chunks: [reply], turn: turnOf("p1-lair"),
      execution: { id: attempt.id, runner: "runner-a", fence: { incarnation: "one" } } })

    // The council's result cannot be recorded, so NOTHING of the settlement is: no reply, the attempt is not completed, the council is still preparing.
    await expect(settle()).rejects.toThrow()
    expect((await s.su`select lifecycle, result from council where id = ${id}`)[0]).toMatchObject({ lifecycle: "preparing_result", result: null })
    expect((await s.su`select state from execution where id = ${attempt.id}`)[0].state, "still owned, with its answer journaled").toMatch(/feed_intent|received|running/)
    expect(await s.count("outbox", `inbound_id = '${event}'`), "no reply was delivered").toBe(0)
    expect((await s.su`select state from inbound where id = ${event}`)[0].state).not.toBe("answered")

    // The next look (the runner's tick) tries again from the journal, and while the fault stands it fails again, and says how many are still owed.
    expect(await settleStored(s.runner, { runner: "runner-a" })).toBe(1)
    expect((await s.su`select lifecycle from council where id = ${id}`)[0].lifecycle).toBe("preparing_result")

    // The fault is gone and the runner starts again: a new incarnation settles the journaled answer, and does not feed the engine anything.
    await fault.heal()
    const owed = await reconcileExecutions(s.runner, { runner: "runner-a", incarnation: "two", registry: loadRegistry(s.registryFile) })
    expect(owed).toBe(0)
    const [done] = Array.from(await s.su`select lifecycle, result, completed_at from council where id = ${id}`) as any[]
    expect(done.lifecycle).toBe("complete")
    expect(done.completed_at).not.toBeNull()
    expect(done.result).toMatchObject({ attempt: attempt.id, inbound: event, mode: "all", reply: { source: event, kind: "reply" } })
    expect((await s.su`select state from execution where id = ${attempt.id}`)[0].state).toBe("completed")
    // One reply to the pinned route, and one reference to it; nothing was generated a second time.
    expect(await s.count("outbox", `inbound_id = '${event}'`)).toBe(1)
    expect((await s.su`select body, route from outbox where inbound_id = ${event}`)[0]).toMatchObject({ body: reply, route: { door: DOOR, chat: CHAT } })
    expect(await s.count("conversation_entry", `source_id = '${event}' and kind = 'reply'`)).toBe(1)
    expect(await s.count("conversation_entry", `source_id = '${event}' and kind = 'input'`), "the engine was handed the event once").toBe(1)
    expect(await s.count("execution", `inbound_id = '${event}'`), "and there is one attempt on it").toBe(1)
    expect(await s.count("ledger_event", `subject = '${attempt.id}' and kind = 'feed.intent'`)).toBe(1)
    // Settling it once more changes nothing.
    expect(await settleStored(s.runner, { runner: "runner-a" })).toBe(0)
    expect(await s.count("outbox", `inbound_id = '${event}'`)).toBe(1)
  } finally { await s.close() }
}, 120_000)

test("Z2 an empty reply is not a result, and a reply to an input that never called finalize completes nothing: the council goes back to waiting for its master", async () => {
  const s = await councilStage(cluster, track)
  try {
    const { id, event } = await answered(s)
    const attempt = await s.feed(event)
    expect(await move(s, id, { kind: "finalize" }, attempt.id)).toMatchObject({ stage: "preparing_result" })
    await s.settleMaster(event, attempt, "   ")
    const [council] = Array.from(await s.su`select lifecycle, result, finalize from council where id = ${id}`) as any[]
    expect(council).toMatchObject({ lifecycle: "waiting_master", result: null, finalize: null })
    expect(await s.count("council", "lifecycle = 'complete'")).toBe(0)
  } finally { await s.close() }
}, 60_000)

test("Z3 a council that says it is preparing its result after the attempt that was to write it was settled is said, by the card and by check, and is not left to look like a card that lags", async () => {
  const s = await councilStage(cluster, track)
  try {
    const { id, event } = await answered(s)
    const attempt = await s.feed(event)
    await move(s, id, { kind: "finalize" }, attempt.id)
    await s.settleMaster(event, attempt, "Weigh it twice.")
    expect((await s.su`select lifecycle from council where id = ${id}`)[0].lifecycle).toBe("complete")
    // Nothing this build writes is in this state (the settlement records the result with the reply). It is made by hand, the way an earlier build left one.
    await s.su`update council set lifecycle = 'preparing_result', result = null where id = ${id}`
    const registry = loadRegistry(s.registryFile)
    const found = councilFindings({ councils: await readLiveCouncils(s.runner), registry, agents: new Set(["p1-lair"]), graceSeconds: 300, machine: "m", now: new Date() })
    expect(found.filter(one => one.kind === "council-finalizing")).toHaveLength(1)
    expect(found.find(one => one.kind === "council-finalizing")!.says).toContain("settled")
    const snapshot = await readSnapshot(s.runner, id, { now: new Date(), quietSeconds: 300 })
    expect(snapshot).toMatchObject({ stage: "preparing-result", master: "idle" })
    expect(statusLine("en", snapshot!)).toContain("result was not recorded")
    // What the finding says for the other states of the master's attempt, from the rows the finding reads: a master that is still in its turn is
    // not a finding, and neither is an attempt that ended a moment ago; an attempt that ended and settled nothing is one once the grace has run.
    const at = (finalize_attempt: string | null, waited: number) => councilFindings({ registry, agents: new Set(["p1-lair"]), graceSeconds: 300, machine: "m", now: new Date(),
      councils: [{ id, person: "p1", agent: "p1-lair", lifecycle: "preparing_result", origin_kind: "owner_request", updated_at: new Date(Date.now() - waited * 1000), waiting: null, card: null,
        finalize_attempt }] }).filter(one => one.kind === "council-finalizing")
    expect(at("running", 3600)).toEqual([])
    expect(at("feed_intent", 3600)).toEqual([])
    expect(at("failed", 10), "not before the grace").toEqual([])
    expect(at("failed", 3600)).toHaveLength(1)
    expect(at("interrupted", 3600)).toHaveLength(1)
    expect(at(null, 3600), "an attempt that is not on record").toHaveLength(1)
    expect(at("completed", 1), "a settled attempt is said at once").toHaveLength(1)
  } finally { await s.close() }
}, 60_000)

test("Z4 the consumption of a council's event is part of the feed intent: when it cannot be written nothing is fed and nothing is recorded as read, and the same attempt feeds it once the fault is gone", async () => {
  const s = await councilStage(cluster, track)
  try {
    const { id, event } = await answered(s)
    const fault = await inject(s, "assess", "council", "new.lifecycle = 'assessing'")
    // The feed intent fails as a whole: the attempt was opened and is only claimed, and no input was recorded for the conversation.
    await expect(s.feed(event)).rejects.toThrow()
    const [attempt] = Array.from(await s.su`select * from execution where inbound_id = ${event}`) as any[]
    expect(attempt.state, "opened, and never handed the input").toBe("claimed")
    const [council] = Array.from(await s.su`select lifecycle from council where id = ${id}`) as any[]
    expect(council.lifecycle, "nobody has read it, and the council does not say somebody has").toBe("waiting_master")
    expect((await s.su`select consumed_at, consumed_attempt, disposition from council_event where inbound_id = ${event}`)[0]).toEqual({ consumed_at: null, consumed_attempt: null, disposition: null })
    expect(await s.count("conversation_entry", `source_id = '${event}'`)).toBe(0)
    expect(await s.count("ledger_event", `subject = '${attempt.id}' and kind = 'feed.intent'`)).toBe(0)

    await fault.heal()
    await markFeedIntent(s.runner, attempt, `body of ${event}`)
    expect((await s.su`select consumed_attempt, disposition from council_event where inbound_id = ${event}`)[0]).toEqual({ consumed_attempt: attempt.id, disposition: "read" })
    expect((await s.su`select lifecycle from council where id = ${id}`)[0].lifecycle).toBe("assessing")
    expect(await s.count("conversation_entry", `source_id = '${event}' and kind = 'input'`)).toBe(1)
    expect(await s.count("ledger_event", `subject = '${attempt.id}' and kind = 'feed.intent'`)).toBe(1)
  } finally { await s.close() }
}, 60_000)
