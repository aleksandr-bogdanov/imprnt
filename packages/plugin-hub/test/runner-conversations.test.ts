// What the runner does with durable conversations and attempts, driven through
// the real `runRunner` and the real store. Only the loop is a fixture, and the
// fixture reports its processes from the process table rather than from the
// runner's own bookkeeping, so the runner is not grading itself.
//
//   A1  a new job has a conversation of its own; an explicit follow-up resumes
//       its conversation after the child was shut down idle
//   A2  a follow-up an engine cannot resume is refused by name
//   A3  a child that dies after it was handed an input holds that input: nothing
//       replays it, a fresh turn only on a validated resume, and the owner's
//       choice queues one linked continuation
//   A4  an attempt of an earlier incarnation that may still be running keeps the
//       slot; only proof that it is gone moves it; a generic recover clears nothing
//   A5  a result the engine produced before the runner died is settled without
//       generation
//   A6  an explicit stop reports what is proved: stopped, or unknown

import { afterAll, beforeAll, expect, test } from "bun:test"
import { startCluster, type Cluster } from "./helpers/cluster.ts"
import { AGENT, CHAT, DOOR, PERSON, RUNNER, insertInbound, plantChatLine, stageHub } from "./helpers/hub-fixture.ts"
import { controlledAdapter, observe, processTree, retrySettings } from "./helpers/rollout-runner.ts"
import { insertJob, livingProcess } from "./helpers/conversations.ts"
import { childGone } from "./helpers/scripted-adapter.ts"
import { runRunner } from "../src/runner/run.ts"
import { claimNext } from "../src/runner/claim.ts"
import { alive } from "../src/os/tree.ts"
import { stageHarvest, plantLine } from "./helpers/harvest-stage.ts"
import { encodeHarvestBody, harvestRowId } from "../src/harvest/row.ts"
import { HoldChoiceRefused, requestHoldChoice } from "../src/door/recovery.ts"
import { holdChoiceLine } from "../src/door/lines.ts"
import { holdContextOf } from "../src/recovery/holds.ts"
import { callTool } from "../src/mcp/handlers.ts"
import { loadRegistry } from "../src/registry/load.ts"
import type { AdapterCapabilities } from "../src/adapters/types.ts"
import type { StoreLike } from "../src/store/connect.ts"

let cluster: Cluster
beforeAll(async () => { cluster = await startCluster() })
afterAll(async () => { await cluster?.stop() })

const WORKER = { id: "p1-worker", person: PERSON, preset: "daily", runner: RUNNER, mode: "on-demand", idle_seconds: 1 }

async function stage(options: { worker?: boolean; caps?: Partial<AdapterCapabilities> | null; descendants?: boolean; evidence?: boolean } = {}) {
  const it = await stageHub(cluster, {
    hub: { tick_seconds: 1 },
    people: [{ id: PERSON, allowed_senders: { [DOOR]: [PERSON] } } as never],
    agents: options.worker === false ? [] : [WORKER],
  })
  retrySettings(it)
  const caps: AdapterCapabilities | undefined = options.caps === null ? undefined
    : { stableSession: true, safeResume: false, delegationDisabled: true, ...options.caps }
  const edge = controlledAdapter(it.adapterName, options.descendants ?? false,
    { ...(caps ? { capabilities: caps } : {}), ...(options.evidence === undefined ? {} : { evidence: options.evidence }) })
  const start = () => runRunner({ runner: RUNNER, registryFile: it.registryFile, adapters: { [it.adapterName]: edge.adapter } })
  const door = { sql: cluster.connectAs("hub_door", it.db), url: cluster.url(it.db) } as StoreLike
  const answered = (id: string, ms = 15_000) => observe(async () => (await it.read.inbound()).find(r => r.id === id)?.state === "answered", ms)
  const sessionFed = (id: string) => edge.sessions.find(r => r.fed.some(m => m.id === id))
  return { it, edge, caps, start, door, answered, sessionFed }
}

const rows = async (it: { read: { sql(q: string, v?: unknown[]): Promise<Record<string, unknown>[]> } }, query: string, values?: unknown[]) =>
  Array.from(await it.read.sql(query, values))

test("A1 each new job has a conversation of its own, and an explicit follow-up resumes its conversation after the child was shut down idle", async () => {
  const { it, edge, start, answered, sessionFed } = await stage()
  let runner: Awaited<ReturnType<typeof runRunner>> | undefined
  try {
    runner = await start()
    await insertJob(cluster, it.db, { id: "j1", target: "p1-worker", task: "brief one: the codeword is ALPHA" })
    expect(await answered("j1")).toBe(true)
    const first = sessionFed("j1")!
    // The child goes when it has been idle; what it knew is the conversation's.
    expect(await observe(() => first.closed, 10_000), "the idle child was shut down").toBe(true)
    await insertJob(cluster, it.db, { id: "j2", target: "p1-worker", task: "brief two: what was the codeword?" })
    expect(await answered("j2")).toBe(true)
    const second = sessionFed("j2")!
    expect(await observe(() => second.closed, 10_000)).toBe(true)

    const conversations = await rows(it, "select id, owner_ref, native_session, native_state, kind, agent from conversation where kind = 'worker' order by owner_ref")
    expect(conversations.map(c => c.owner_ref)).toEqual(["j1", "j2"])
    const [c1, c2] = conversations as { id: string; native_session: string; native_state: string; agent: string }[]
    // Same configured worker, and nothing is shared: not the conversation, not
    // the engine session, not what it was told.
    expect(c2.id).not.toBe(c1.id)
    expect(c2.native_session).not.toBe(c1.native_session)
    expect(c1.agent).toBe("p1-worker")
    expect([c1.native_state, c2.native_state], "the engine reported the very session it was launched under").toEqual(["verified", "verified"])
    expect(first.loop.starts()[0].session).toEqual({ id: c1.native_session, resume: false })
    expect(second.loop.starts()[0].session).toEqual({ id: c2.native_session, resume: false })
    expect(second).not.toBe(first)
    expect(second.fed.map(m => m.text).join("\n"), "the second job cannot recall the first brief").not.toContain("ALPHA")

    // The explicit follow-up names the conversation. A NEW child is started, and
    // it is started by resuming the saved session: the earlier detail is the
    // engine's, so it is not fed again, and completed work is not replayed.
    await insertJob(cluster, it.db, { id: "j3", target: "p1-worker", task: "follow-up: and the second one?", conversation: c1.id })
    expect(await answered("j3")).toBe(true)
    const third = sessionFed("j3")!
    expect(third).not.toBe(first)
    expect(third.loop.starts()[0].session).toEqual({ id: c1.native_session, resume: true })
    expect(third.fed.map(m => m.text)).toEqual(["follow-up: and the second one?"])
    const attempts = await rows(it, "select inbound_id, conversation_id, state, native_session from execution where agent = 'p1-worker' order by started_at")
    expect(attempts.map(a => [a.inbound_id, a.conversation_id === c1.id, a.state])).toEqual([["j1", true, "completed"], ["j2", false, "completed"], ["j3", true, "completed"]])
    // The durable transcript of the conversation is its own, in order.
    const entries = await rows(it, "select seq, source_id, kind from conversation_entry where conversation_id = $1 order by seq", [c1.id])
    expect(entries.map(e => [e.seq, e.source_id, e.kind])).toEqual([[1, "j1", "input"], [2, "j1", "reply"], [3, "j3", "input"], [4, "j3", "reply"]])
  } finally { await runner?.stop(); await edge.stop(); await it.stop() }
})

test("A2 a follow-up that cannot be resumed, or is not this worker's, is refused by name and never made a new job", async () => {
  // An engine that says nothing about sessions cannot keep a follow-up's promise.
  const plain = await stage({ caps: null })
  let runner: Awaited<ReturnType<typeof runRunner>> | undefined
  try {
    runner = await plain.start()
    await insertJob(cluster, plain.it.db, { id: "j1", target: "p1-worker", task: "first" })
    expect(await plain.answered("j1")).toBe(true)
    const [conversation] = await rows(plain.it, "select id from conversation where owner_ref = 'j1'") as { id: string }[]
    await insertJob(cluster, plain.it.db, { id: "j2", target: "p1-worker", task: "follow-up", conversation: conversation.id })
    expect(await plain.answered("j2")).toBe(true)
    expect(plain.edge.sessions.some(r => r.fed.some(m => m.id === "j2")), "the follow-up was never fed to anything").toBe(false)
    const refusals = await plain.it.read.ledger({ subject: "j2", kind: "dispatch.refused" })
    expect(refusals.map(r => r.detail.cause)).toEqual(["resume unsupported"])
    // The refusal is said to the person who asked, once.
    expect((await plain.it.read.noticeRows()).filter(n => n.notice_key === "job-refused:j2")).toHaveLength(1)
  } finally { await runner?.stop(); await plain.edge.stop(); await plain.it.stop() }

  // An engine that can, refuses a conversation that belongs to another worker.
  const capable = await stage()
  let second: Awaited<ReturnType<typeof runRunner>> | undefined
  try {
    second = await capable.start()
    await insertInbound(cluster, capable.it.db, { id: "h1", body: "hello" })
    expect(await observe(async () => (await capable.it.read.outbox()).some(r => r.inbound_id === "h1"))).toBe(true)
    const [master] = await rows(capable.it, "select id from conversation where kind = 'master'") as { id: string }[]
    await insertJob(cluster, capable.it.db, { id: "j-stranger", target: "p1-worker", task: "borrow", conversation: master.id })
    expect(await capable.answered("j-stranger")).toBe(true)
    expect((await capable.it.read.ledger({ subject: "j-stranger", kind: "dispatch.refused" })).map(r => r.detail.cause)).toEqual(["conversation unavailable"])
    expect(capable.sessionFed("j-stranger")).toBeUndefined()
  } finally { await second?.stop(); await capable.edge.stop(); await capable.it.stop() }
})

test("A3 a child that dies after it was handed an input holds that input: no replay, a fresh turn only on a validated resume, and the owner's choice queues one linked continuation", async () => {
  const { it, edge, caps, start, door } = await stage({ worker: false, caps: { safeResume: false } })
  let runner: Awaited<ReturnType<typeof runRunner>> | undefined
  try {
    runner = await start()
    edge.hold(m => m.id === "h1")
    await insertInbound(cluster, it.db, { id: "h1", body: "do the risky thing" })
    expect(await observe(() => edge.sessions.some(r => r.fed.some(m => m.id === "h1")))).toBe(true)
    const target = edge.sessions.find(r => r.fed.some(m => m.id === "h1"))!
    edge.hold(() => false)
    target.fail()
    expect(await observe(async () => (await rows(it, "select 1 from replay_hold where inbound_id = 'h1'")).length === 1)).toBe(true)
    const [attempt] = await rows(it, "select id, state, native_session from execution where inbound_id = 'h1'") as { id: string; state: string; native_session: string }[]
    expect(attempt.state).toBe("interrupted")
    expect(attempt.native_session, "the attempt kept the session it ran under").not.toBeNull()
    expect(await rows(it, "select cause, state, revision from replay_hold")).toEqual([{ cause: "interrupted", state: "held", revision: 1 }])

    // The next message is NOT started: the engine has not shown that a resumed
    // session replays nothing, and no context is rebuilt in its place.
    await insertInbound(cluster, it.db, { id: "h2", body: "what happened?" })
    await Bun.sleep(3000)
    expect(edge.sessions.some(r => r.fed.some(m => m.id === "h2"))).toBe(false)
    expect((await it.read.inbound()).find(r => r.id === "h2")).toMatchObject({ state: "received", claimed_by: null })
    // ...and the owner is told why, once, by name, although the engine filtered the row out before any claim.
    const contextNotices = (await it.read.noticeRows()).filter(n => String(n.notice_key).startsWith("context:"))
    expect(contextNotices.map(n => n.notice_key)).toEqual([`context:${attempt.id}:1:safe-resume-unvalidated`])
    expect(contextNotices[0].body).toContain("waiting for native context")
    expect(contextNotices[0].body).toContain("has not been shown to resume an interrupted session")

    // The build whose resume was validated (a fresh runner reads it afresh) takes
    // the fresh turn, on the attempt's own session, and explains.
    await runner.stop()
    caps!.safeResume = true
    runner = await start()
    expect(await observe(() => edge.sessions.some(r => r.fed.some(m => m.id === "h2")), 12_000)).toBe(true)
    const fresh = edge.sessions.find(r => r.fed.some(m => m.id === "h2"))!
    expect(fresh.loop.starts()[0].session).toEqual({ id: attempt.native_session, resume: true })
    const said = fresh.fed.find(m => m.id === "h2")!.text
    expect(said).toContain("[Hub recovery context]")
    expect(said).toContain("Do NOT continue that assignment")
    expect(said.endsWith("what happened?")).toBe(true)
    expect(await observe(async () => (await it.read.outbox()).some(r => r.inbound_id === "h2"))).toBe(true)
    // The held input was fed exactly once, before it died, and is still held.
    expect(edge.sessions.flatMap(r => r.fed).filter(m => m.id === "h1")).toHaveLength(1)
    expect((await it.read.outbox()).some(r => r.inbound_id === "h1")).toBe(false)
    expect((await rows(it, "select kind, source_id from conversation_entry where kind = 'recovery'")).map(e => e.source_id)).toEqual([`hold:${attempt.id}:1`])
    expect((await rows(it, "select state from replay_hold"))[0].state).toBe("held")

    // Only the owner's choice, from a sender the person allows, about this attempt at this revision.
    const ask = (over: Record<string, unknown> = {}) => requestHoldChoice(door, { registry: loadRegistry(it.registryFile), person: PERSON, door: DOOR, chat: CHAT,
      sender_id: PERSON, message: "recover:1", at: new Date().toISOString(), agent: AGENT, attempt: attempt.id, revision: 1, choice: "continue", ...over })
    await expect(ask({ sender_id: "a-stranger" })).rejects.toBeInstanceOf(HoldChoiceRefused)
    expect(await ask({ revision: 9 })).toBe("stale-revision")
    expect(await rows(it, "select id from inbound where id like 'continue:%'")).toEqual([])
    expect(await ask()).toBe("continuing")
    // One new input on the same conversation, behind whatever is current; the
    // old input is not what runs, and it runs on the same session.
    expect(await observe(async () => (await it.read.outbox()).some(r => r.inbound_id === "continue:h1:1"), 12_000)).toBe(true)
    const resumed = edge.sessions.find(r => r.fed.some(m => m.id === "continue:h1:1"))!
    expect(resumed.loop.starts()[0].session).toEqual({ id: attempt.native_session, resume: true })
    const continuation = resumed.fed.find(m => m.id === "continue:h1:1")!.text
    expect(continuation).toContain("The owner has chosen to continue it")
    expect(continuation).toContain("do the risky thing")
    expect(continuation).not.toContain("[Hub recovery context]")
    expect(edge.sessions.flatMap(r => r.fed).filter(m => m.id === "h1")).toHaveLength(1)
    expect((await rows(it, "select state from replay_hold"))[0].state, "the hold is done once its continuation owns the conversation").toBe("released")
    // Releasing the owner's gate did not make the original input eligible again: it
    // is excluded from replay for good, it was never answered, and nothing (not the
    // continuation settling, not a restart) feeds it a second time.
    expect(await observe(async () => (await it.read.outbox()).some(r => r.inbound_id === "continue:h1:1"), 12_000)).toBe(true)
    expect((await rows(it, "select hub_row_held('h1') as held"))[0].held).toBe(true)
    expect((await it.read.inbound()).find(r => r.id === "h1")!.state).not.toBe("answered")
    await runner.stop()
    runner = await start()
    await Bun.sleep(2500)
    expect(edge.sessions.flatMap(r => r.fed).filter(m => m.id === "h1")).toHaveLength(1)
    expect((await it.read.outbox()).some(r => r.inbound_id === "h1")).toBe(false)
  } finally { await runner?.stop(); await edge.stop(); await it.stop() }
})

test("A4 an attempt of an earlier incarnation that may still be running keeps the slot: nothing else starts, only proof that it is gone moves it, and a generic recover clears nothing", async () => {
  const { it, edge, start, door } = await stage({ worker: false, caps: null })
  // The engine led a process group of its own, as the production adapter asks its child to, and a
  // tool it had started once left that group (its own session) and outlived it: recorded, and alive.
  const engine = livingProcess()
  const detached = livingProcess()
  let runner: Awaited<ReturnType<typeof runRunner>> | undefined
  try {
    expect(engine.group, "the runtime gave the stand-in engine a process group of its own, which is what a managed group needs").toBe(engine.pid)
    // What a runner that died left behind: a claimed row, its attempt fed and
    // running, and the pids it last saw. Planted through SQL, because the point
    // is what a NEW runner does with it.
    await insertInbound(cluster, it.db, { id: "h1", body: "a long job" })
    await insertInbound(cluster, it.db, { id: "h2", body: "queued behind it" })
    await it.read.sql(`insert into conversation (id, person, agent, kind, adapter, native_session)
      values ('conv-old', 'p1', 'p1-lair', 'master', $1, $2)`, [it.adapterName, crypto.randomUUID()])
    await it.read.sql("update inbound set claimed_by = $1, claim_deadline = now() - interval '1 minute' where id = 'h1'", [RUNNER])
    // The record travels as the VALUE: a jsonb string here would be a different fact.
    await it.read.sql(`insert into execution (id, inbound_id, conversation_id, agent, runner, incarnation, placement_generation, state, input_digest, evidence)
      values ('attempt-old', 'h1', 'conv-old', 'p1-lair', $1, 'an-earlier-incarnation', 1, 'running', 'd', $2::jsonb)`,
      [RUNNER, { leader: engine.pid, pids: [engine.pid, detached.pid], group: engine.group }])
    expect((await rows(it, "select jsonb_typeof(evidence) as evidence, jsonb_typeof(evidence -> 'pids') as pids from execution where id = 'attempt-old'"))[0])
      .toEqual({ evidence: "object", pids: "array" })

    runner = await start()
    // Reconciled before anything is claimed: the process is there, so ownership is unknown.
    expect((await rows(it, "select state from execution where id = 'attempt-old'"))[0].state).toBe("unknown")
    expect((await rows(it, "select jsonb_typeof(evidence) as evidence, jsonb_typeof(evidence -> 'exit') as exit, jsonb_typeof(effects) as effects from execution where id = 'attempt-old'"))[0],
      "what the runner wrote back is still the record").toEqual({ evidence: "object", exit: "object", effects: "object" })
    expect(await rows(it, "select cause, state, revision from replay_hold")).toEqual([{ cause: "ownership-unknown", state: "held", revision: 1 }])
    expect((await it.read.noticeRows()).some(n => n.notice_key === "hold:attempt-old:1" && n.body.includes("/recover p1-lair attempt-old 1 continue"))).toBe(true)
    await Bun.sleep(3000)
    // The lease ran out long ago and it changes nothing: no executor is started,
    // not even an idle child, and the queued message waits.
    expect(edge.sessions).toHaveLength(0)
    expect((await it.read.inbound()).find(r => r.id === "h2")).toMatchObject({ state: "received", claimed_by: null })

    // "Recover agent" restarts plumbing and cannot lift any of it.
    await runner.recoverAgent({ id: "generic-recover", agent: AGENT })
    await Bun.sleep(2000)
    expect(edge.sessions).toHaveLength(0)
    expect((await rows(it, "select state from execution where id = 'attempt-old'"))[0].state).toBe("unknown")
    expect((await rows(it, "select state from replay_hold"))[0].state).toBe("held")

    // Only proof moves it. The engine and its group are gone, but a tool it was recorded
    // with left the group and is alive: that is a known survivor, and nothing is proved.
    await engine.stop()
    await Bun.sleep(2500)
    expect((await rows(it, "select state from execution where id = 'attempt-old'"))[0].state, "a recorded process that is still alive keeps the slot").toBe("unknown")
    expect(await rows(it, "select cause, state, revision from replay_hold")).toEqual([{ cause: "ownership-unknown", state: "held", revision: 1 }])
    await detached.stop()
    expect(await observe(async () => (await rows(it, "select state from execution where id = 'attempt-old'"))[0].state === "interrupted", 10_000)).toBe(true)
    expect(await rows(it, "select cause, state, revision from replay_hold")).toEqual([{ cause: "interrupted", state: "held", revision: 2 }])
    // What is known changed, so the choice made about revision 1 is void.
    const ask = (revision: number) => requestHoldChoice(door, { registry: loadRegistry(it.registryFile), person: PERSON, door: DOOR, chat: CHAT,
      sender_id: PERSON, message: "recover:2", at: new Date().toISOString(), agent: AGENT, attempt: "attempt-old", revision, choice: "continue" })
    expect(await ask(1)).toBe("stale-revision")
    expect(await ask(2)).toBe("continuing")
    // Gone is not resumable: with no validated native resume nothing is started
    // for the continuation or for the message behind it, and no context is rebuilt.
    await Bun.sleep(3000)
    expect(edge.sessions).toHaveLength(0)
    expect((await rows(it, "select id from inbound where id like 'continue:%'")).map(r => r.id)).toEqual(["continue:h1:2"])
    // The machinery spoke and the model did not: the only outbox rows are the two hold
    // notices, one per revision, and the one notice that says what the conversation is waiting
    // for now that the attempt is over (no engine was shown able to resume: `caps` is null, and
    // it is said although no row could be claimed to find that out). No reply was generated for
    // anybody. Nothing was fed.
    expect(await rows(it, "select kind, notice_key from outbox order by id")).toEqual([
      { kind: "notice", notice_key: "hold:attempt-old:1" }, { kind: "notice", notice_key: "hold:attempt-old:2" },
      { kind: "notice", notice_key: "context:attempt-old:2:safe-resume-unvalidated" }])
    // The choice is recorded and says what it waits for, in the same words the door would answer with.
    expect((await rows(it, "select state, choice, native_context ->> 'state' as context, native_context ->> 'cause' as cause from replay_hold"))[0])
      .toEqual({ state: "continuing", choice: "continue", context: "unavailable", cause: "safe-resume-unvalidated" })
    expect((await it.read.outbox()).filter(r => r.inbound_id !== null), "no generated reply").toEqual([])
    expect(await it.read.ledger({ stream: "turn" }), "no turn was generated").toEqual([])
  } finally { await runner?.stop(); await engine.stop(); await detached.stop(); await edge.stop(); await it.stop() }
})

test("A5 a result the engine produced before the runner died is settled from its journal, once, without another generation", async () => {
  const { it, edge, start } = await stage({ worker: false, caps: null })
  let runner: Awaited<ReturnType<typeof runRunner>> | undefined
  try {
    await insertInbound(cluster, it.db, { id: "h1", body: "the question" })
    await it.read.sql(`insert into conversation (id, person, agent, kind, adapter, native_session)
      values ('conv-old', 'p1', 'p1-lair', 'master', $1, $2)`, [it.adapterName, crypto.randomUUID()])
    await it.read.sql("update inbound set claimed_by = $1, claim_deadline = now() + interval '1 hour' where id = 'h1'", [RUNNER])
    const turn = { agent: AGENT, runner: RUNNER, preset: "daily", preset_id: "x", preset_settings: {}, input_tokens: 5, cached_input_tokens: 0,
      output_tokens: 7, price: null, plan_usage: null, raw_usage: {}, session_id: null, lacks: [], tail: false }
    await it.read.sql(`insert into execution (id, inbound_id, conversation_id, agent, runner, incarnation, placement_generation, state, input_digest, result)
      values ('attempt-old', 'h1', 'conv-old', 'p1-lair', $1, 'an-earlier-incarnation', 1, 'running', 'd', $2::jsonb)`,
      [RUNNER, { text: "the saved answer", chunks: ["the saved answer"], turn }])
    expect((await rows(it, "select jsonb_typeof(result) as result, jsonb_typeof(result -> 'chunks') as chunks, jsonb_typeof(result -> 'turn') as turn from execution where id = 'attempt-old'"))[0])
      .toEqual({ result: "object", chunks: "array", turn: "object" })

    runner = await start()
    expect((await it.read.outbox()).map(r => [r.inbound_id, r.body])).toEqual([["h1", "the saved answer"]])
    expect((await it.read.inbound()).find(r => r.id === "h1")).toMatchObject({ state: "answered", claimed_by: null })
    expect((await rows(it, "select state from execution where id = 'attempt-old'"))[0].state).toBe("completed")
    expect((await it.read.ledger({ stream: "turn", subject: "h1" }))).toHaveLength(1)
    expect((await rows(it, "select source_id, kind, body from conversation_entry where conversation_id = 'conv-old' order by seq")).map(e => [e.source_id, e.kind, e.body]))
      .toEqual([["h1", "reply", "the saved answer"]])
    // Not one byte went to an engine for it, and a second start writes nothing more.
    expect(edge.sessions.flatMap(r => r.fed).filter(m => m.id === "h1")).toEqual([])
    await runner.stop()
    runner = await start()
    await Bun.sleep(1500)
    expect((await it.read.outbox())).toHaveLength(1)
    expect((await it.read.ledger({ stream: "turn", subject: "h1" }))).toHaveLength(1)
  } finally { await runner?.stop(); await edge.stop(); await it.stop() }
})

test("A6 an explicit stop says stopped only when the loop and everything under it are gone, and unknown when that cannot be shown", async () => {
  // The engine reports its process tree: the loop, and two tools under it.
  const shown = await stage({ worker: false, descendants: true })
  let runner: Awaited<ReturnType<typeof runRunner>> | undefined
  try {
    runner = await shown.start()
    shown.edge.hold(m => m.id === "h1")
    await insertInbound(cluster, shown.it.db, { id: "h1", body: "long work" })
    expect(await observe(() => shown.edge.sessions.some(r => r.fed.some(m => m.id === "h1")))).toBe(true)
    const target = shown.sessionFed("h1")!
    // The tree the fixture really has, read from the process table before the stop.
    expect(await observe(() => processTree(target.session.pid!).length === 3)).toBe(true)
    const tree = processTree(target.session.pid!)
    expect(await runner.stopExecution({ agent: AGENT, graceMs: 500 })).toMatchObject({ state: "stopped" })
    expect(tree.every(pid => childGone(pid)), "the loop and both tools exited").toBe(true)
    expect(await rows(shown.it, "select state from execution where inbound_id = 'h1'")).toEqual([{ state: "stopped" }])
    expect(await rows(shown.it, "select cause, state from replay_hold")).toEqual([{ cause: "stopped", state: "held" }])
    // A stop is not an error and not a retry: nothing is told to try again and nothing is fed.
    await Bun.sleep(2500)
    expect((await shown.it.read.noticeRows()).filter(n => String(n.notice_key).startsWith("agent-retry"))).toEqual([])
    expect(shown.edge.sessions.flatMap(r => r.fed).filter(m => m.id === "h1")).toHaveLength(1)
    expect((await shown.it.read.outbox()).some(r => r.inbound_id === "h1")).toBe(false)
  } finally { await runner?.stop(); await shown.edge.stop(); await shown.it.stop() }

  // An engine that cannot say what it left behind is never reported stopped.
  const blind = await stage({ worker: false, evidence: false })
  let second: Awaited<ReturnType<typeof runRunner>> | undefined
  try {
    second = await blind.start()
    blind.edge.hold(m => m.id === "h1")
    await insertInbound(cluster, blind.it.db, { id: "h1", body: "long work" })
    expect(await observe(() => blind.edge.sessions.some(r => r.fed.some(m => m.id === "h1")))).toBe(true)
    const result = await second.stopExecution({ agent: AGENT, graceMs: 200 })
    expect(result.state).toBe("stop_unknown")
    expect((await rows(blind.it, "select state from execution where inbound_id = 'h1'"))[0].state).toBe("stop_unknown")
    expect(await rows(blind.it, "select cause from replay_hold")).toEqual([{ cause: "ownership-unknown" }])
  } finally { await second?.stop(); await blind.edge.stop(); await blind.it.stop() }
})

test("A7 a finished answer whose settle failed is not an interruption: it stays journaled and is settled from the journal when the store takes it, without another generation", async () => {
  const { it, edge, start, answered } = await stage({ worker: false, caps: null })
  let runner: Awaited<ReturnType<typeof runRunner>> | undefined
  try {
    runner = await start()
    // The store refuses the reply the model produced (an injected, transient failure).
    await it.read.sql(`create function test_refuse_reply() returns trigger language plpgsql as $$ begin raise exception 'injected settle failure'; end $$`)
    await it.read.sql("create trigger test_refuse_reply before insert on outbox for each row execute function test_refuse_reply()")
    await insertInbound(cluster, it.db, { id: "h1", body: "the question" })
    expect(await observe(async () => (await rows(it, "select 1 from execution where inbound_id = 'h1' and result is not null")).length === 1, 15_000), "the answer was journaled").toBe(true)
    // Long enough for the runner to have failed, restarted its agent and looked again.
    await Bun.sleep(3500)
    const [attempt] = await rows(it, "select state, result is not null as journaled from execution where inbound_id = 'h1'")
    expect(attempt.journaled).toBe(true)
    expect(["feed_intent", "received", "running"], "still the attempt of a finished turn, not an interrupted or unknown one").toContain(attempt.state as string)
    expect(await rows(it, "select 1 from replay_hold")).toEqual([])
    expect((await it.read.outbox()).length).toBe(0)
    expect((await it.read.noticeRows()).filter(n => String(n.notice_key).startsWith("agent-retry") || String(n.notice_key).startsWith("hold:")), "nobody is told it was interrupted").toEqual([])

    // The store takes it again; the answer lands once, from the journal, on the runner's own look.
    await it.read.sql("drop trigger test_refuse_reply on outbox")
    expect(await answered("h1", 15_000)).toBe(true)
    expect((await it.read.outbox()).map(r => [r.inbound_id, r.body])).toEqual([["h1", "reply to the question"]])
    expect((await rows(it, "select state from execution where inbound_id = 'h1'"))[0].state).toBe("completed")
    expect((await it.read.ledger({ stream: "turn", subject: "h1" }))).toHaveLength(1)
    // The engine was given the input exactly once.
    expect(edge.sessions.flatMap(r => r.fed).filter(m => m.id === "h1")).toHaveLength(1)
  } finally { await runner?.stop(); await edge.stop(); await it.stop() }
}, 60_000)

test("A8 a completed master turn is followed by the same native session after a restart, resumed and not primed again", async () => {
  const { it, edge, start, answered, sessionFed } = await stage({ worker: false })
  let runner: Awaited<ReturnType<typeof runRunner>> | undefined
  try {
    runner = await start()
    await insertInbound(cluster, it.db, { id: "h1", body: "first" })
    expect(await answered("h1")).toBe(true)
    const [master] = await rows(it, "select id, native_session, native_state from conversation where kind = 'master'") as { id: string; native_session: string; native_state: string }[]
    expect(master.native_state, "the engine reported the very session it was launched under").toBe("verified")
    const first = sessionFed("h1")!
    expect(first.loop.starts()[0].session).toEqual({ id: master.native_session, resume: false })

    await runner.stop()
    runner = await start()
    await insertInbound(cluster, it.db, { id: "h2", body: "second" })
    expect(await answered("h2")).toBe(true)
    const second = sessionFed("h2")!
    expect(second).not.toBe(first)
    // The conversation's own locator, stable across the restart; and nothing was replayed into it.
    expect(second.loop.starts()[0].session).toEqual({ id: master.native_session, resume: true })
    expect(second.fed.map(m => m.id)).toEqual(["h2"])
    expect(await rows(it, "select id, native_session, native_state from conversation where kind = 'master'")).toEqual([{ ...master, native_state: "verified" }])
  } finally { await runner?.stop(); await edge.stop(); await it.stop() }
}, 60_000)

test("A9 a recovery context counts as told only once the engine has it: a feed that never lands leaves the next fresh turn to say it again", async () => {
  const { it, edge, caps, start } = await stage({ worker: false, caps: { safeResume: false } })
  let runner: Awaited<ReturnType<typeof runRunner>> | undefined
  try {
    runner = await start()
    edge.hold(m => m.id === "h1")
    await insertInbound(cluster, it.db, { id: "h1", body: "do the risky thing" })
    expect(await observe(() => edge.sessions.some(r => r.fed.some(m => m.id === "h1")))).toBe(true)
    const target = edge.sessions.find(r => r.fed.some(m => m.id === "h1"))!
    edge.hold(() => false)
    target.fail()
    expect(await observe(async () => (await rows(it, "select 1 from replay_hold where inbound_id = 'h1'")).length === 1)).toBe(true)
    const [attempt] = await rows(it, "select id from execution where inbound_id = 'h1'") as { id: string }[]
    await runner.stop()

    // A validated build takes the fresh turn, but the first feed of it is rejected
    // before it reaches the engine: the context it carried never arrived.
    caps!.safeResume = true
    let refused = 0
    edge.throwFeed(m => m.id === "h2" && refused++ === 0)
    runner = await start()
    await insertInbound(cluster, it.db, { id: "h2", body: "what happened?" })
    expect(await observe(async () => (await it.read.outbox()).some(r => r.inbound_id === "h2"), 25_000)).toBe(true)
    const fed = edge.sessions.flatMap(r => r.fed).filter(m => m.id === "h2")
    expect(fed, "fed twice: the rejected feed and the one that landed").toHaveLength(2)
    for (const message of fed) {
      expect(message.text).toContain("[Hub recovery context]")
      expect(message.text).toContain("Do NOT continue that assignment")
      expect(message.text.endsWith("what happened?")).toBe(true)
    }
    // Recorded once, and only after the engine had it.
    expect((await rows(it, "select source_id from conversation_entry where kind = 'recovery'")).map(e => e.source_id)).toEqual([`hold:${attempt.id}:1`])
    // The rejected feed never reached the engine, so it held nothing; the held input is still fed once.
    expect((await rows(it, "select state from execution where inbound_id = 'h2' order by started_at")).map(r => r.state)).toEqual(["failed", "completed"])
    expect(edge.sessions.flatMap(r => r.fed).filter(m => m.id === "h1")).toHaveLength(1)
  } finally { await runner?.stop(); await edge.stop(); await it.stop() }
}, 90_000)

test("A10 a resident's priming tail is a model turn and is owned: the agent is blocked while it runs, and a tail that completes leaves nothing", async () => {
  const { it, edge, start, answered } = await stage({ worker: false })
  let runner: Awaited<ReturnType<typeof runRunner>> | undefined
  try {
    plantChatLine({ stateDir: it.stateDir, text: "what was said yesterday" })
    // The tail is the one message whose id is the agent's own; the loop takes it and does not finish it.
    edge.hold(m => m.id === AGENT)
    runner = await start()
    expect(await observe(() => edge.sessions.some(r => r.fed.some(m => m.id === AGENT)))).toBe(true)
    const [tail] = await rows(it, "select purpose, state, inbound_id from execution where agent = $1", [AGENT])
    expect(tail).toMatchObject({ purpose: "tail", inbound_id: null })
    expect(["feed_intent", "received", "running"]).toContain(tail.state as string)
    // Owned: the agent is blocked by the table, so no other claimant gets an input to it beside the tail.
    expect((await rows(it, "select hub_agent_blocked($1) as blocked", [AGENT]))[0].blocked).toBe(true)
    await insertInbound(cluster, it.db, { id: "h1", body: "hello" })
    const other = { sql: cluster.connectAs("hub_runner", it.db), url: cluster.url(it.db) } as StoreLike
    expect(await claimNext(other, { runner: "another-runner", agent: AGENT, leaseMs: 60_000, resumeOk: true })).toBeNull()
    expect(edge.sessions.flatMap(r => r.fed).filter(m => m.id === "h1")).toEqual([])

    // The tail ends; the attempt is over, no hold is left, and the agent takes its input.
    edge.hold(() => false)
    for (const one of edge.sessions) one.loop.holdTurnEnd(false)
    expect(await answered("h1", 15_000)).toBe(true)
    expect((await rows(it, "select purpose, state from execution where agent = $1 order by started_at", [AGENT])).map(r => [r.purpose, r.state])).toEqual([["tail", "completed"], ["turn", "completed"]])
    expect(await rows(it, "select 1 from replay_hold")).toEqual([])
  } finally { await runner?.stop(); await edge.stop(); await it.stop() }
}, 60_000)

test("A12 an engine that cannot report its processes is primed under an owned attempt like any other: a tail that completes releases its own attempt, and one that is cut off stays unknown and blocks a second claimant", async () => {
  // Completes: owned while it runs, nothing invented, released by its own completion.
  const done = await stage({ worker: false, evidence: false })
  let runner: Awaited<ReturnType<typeof runRunner>> | undefined
  try {
    plantChatLine({ stateDir: done.it.stateDir, text: "what was said yesterday" })
    done.edge.hold(m => m.id === AGENT)
    runner = await done.start()
    expect(await observe(() => done.edge.sessions.some(r => r.fed.some(m => m.id === AGENT)))).toBe(true)
    expect(done.edge.sessions[0].session.processes, "this engine reports no processes and no evidence").toBeUndefined()
    const [tail] = await rows(done.it, "select purpose, state, inbound_id from execution where agent = $1", [AGENT])
    expect(tail, "the tail is owned although the engine can say nothing about its processes").toMatchObject({ purpose: "tail", inbound_id: null })
    expect(["feed_intent", "received", "running"]).toContain(tail.state as string)
    expect((await rows(done.it, "select hub_agent_blocked($1) as blocked", [AGENT]))[0].blocked).toBe(true)
    await insertInbound(cluster, done.it.db, { id: "h1", body: "hello" })
    const other = { sql: cluster.connectAs("hub_runner", done.it.db), url: cluster.url(done.it.db) } as StoreLike
    expect(await claimNext(other, { runner: "another-runner", agent: AGENT, leaseMs: 60_000, resumeOk: true }), "a second claimant gets nothing beside the tail").toBeNull()
    await other.sql.close()
    expect(done.edge.sessions.flatMap(r => r.fed).filter(m => m.id === "h1")).toEqual([])
    // Ordinary healthy behaviour is unchanged: the tail ends, releases only its own attempt, and the input is taken.
    done.edge.hold(() => false)
    for (const one of done.edge.sessions) one.loop.holdTurnEnd(false)
    expect(await done.answered("h1", 15_000)).toBe(true)
    expect((await rows(done.it, "select purpose, state from execution where agent = $1 order by started_at", [AGENT])).map(r => [r.purpose, r.state])).toEqual([["tail", "completed"], ["turn", "completed"]])
    expect(await rows(done.it, "select 1 from replay_hold")).toEqual([])
  } finally { await runner?.stop(); await done.edge.stop(); await done.it.stop() }

  // Cut off: nothing shows the process gone, so the attempt is unknown and the agent's slot stays taken.
  const cut = await stage({ worker: false, evidence: false })
  let second: Awaited<ReturnType<typeof runRunner>> | undefined
  try {
    plantChatLine({ stateDir: cut.it.stateDir, text: "what was said yesterday" })
    cut.edge.hold(m => m.id === AGENT)
    second = await cut.start()
    expect(await observe(() => cut.edge.sessions.some(r => r.fed.some(m => m.id === AGENT)))).toBe(true)
    cut.edge.sessions.find(r => r.fed.some(m => m.id === AGENT))!.fail()
    expect(await observe(async () => (await rows(cut.it, "select state from execution where agent = $1", [AGENT]))[0]?.state === "unknown", 15_000)).toBe(true)
    expect(await rows(cut.it, "select purpose, state, inbound_id from execution where agent = $1", [AGENT])).toEqual([{ purpose: "tail", state: "unknown", inbound_id: null }])
    expect(await rows(cut.it, "select 1 from replay_hold"), "a tail has no input to hold").toEqual([])
    await insertInbound(cluster, cut.it.db, { id: "h1", body: "hello" })
    const other = { sql: cluster.connectAs("hub_runner", cut.it.db), url: cluster.url(cut.it.db) } as StoreLike
    expect(await claimNext(other, { runner: "another-runner", agent: AGENT, leaseMs: 60_000, resumeOk: true }), "nobody else starts beside it").toBeNull()
    await expect(other.sql.begin(async (tx: any) => {
      await tx`select set_config('hub.runner_protocol', '2', true)`
      await tx`update inbound set claimed_by = 'another-runner', claim_deadline = now() + interval '1 minute' where id = 'h1'`
    })).rejects.toThrow(/not claimable/)
    await other.sql.close()
    await Bun.sleep(3500)
    // The tail's own process was never asked about and nothing was invented for it; the input waits, and no other child was started.
    expect(cut.edge.sessions, "no second child").toHaveLength(1)
    expect(cut.edge.sessions.flatMap(r => r.fed).filter(m => m.id === "h1")).toEqual([])
    expect((await rows(cut.it, "select state from execution where agent = $1", [AGENT]))[0].state).toBe("unknown")
    expect((await cut.it.read.inbound()).find(r => r.id === "h1")).toMatchObject({ state: "received", claimed_by: null })
  } finally { await second?.stop(); await cut.edge.stop(); await cut.it.stop() }
}, 90_000)

test("A15 a tail that cannot be owned is refused by name before anything is generated, and the tail of a claimed row's fresh child is a feed of that row's attempt", async () => {
  const { it, edge, start, answered } = await stage({ worker: false, evidence: false })
  let runner: Awaited<ReturnType<typeof runRunner>> | undefined
  try {
    plantChatLine({ stateDir: it.stateDir, text: "what was said yesterday" })
    // Another attempt of the agent takes the slot between the check and the opening: the table's own refusal.
    await it.read.sql(`create function test_tail_busy() returns trigger language plpgsql as $$ begin
      raise unique_violation using message = 'duplicate key value violates unique constraint "execution_one_per_agent"'; end $$`)
    await it.read.sql("create trigger test_tail_busy before insert on execution for each row when (new.purpose = 'tail') execute function test_tail_busy()")
    runner = await start()
    expect(await observe(async () => (await it.read.ledger({ stream: "runner", kind: "tail.refused" })).length === 1, 15_000), "the refusal is named in the diary").toBe(true)
    expect(edge.sessions, "the child that was started for it").toHaveLength(1)
    expect(edge.sessions[0].fed, "nothing was fed to it, so nothing was generated").toEqual([])
    expect(await observe(() => edge.sessions[0].closed), "and it was closed").toBe(true)
    expect(await rows(it, "select 1 from execution"), "no attempt exists for it").toEqual([])

    // An ordinary input then starts a fresh child, and that child's tail is a feed of the input's own attempt:
    // its feed intent is committed BEFORE the tail, so a crash inside the tail is uncertain and not "never fed".
    await insertInbound(cluster, it.db, { id: "h1", body: "hello" })
    expect(await answered("h1", 20_000)).toBe(true)
    expect(edge.sessions.flatMap(r => r.fed).map(m => m.id), "the tail first, then the input, once each").toEqual([AGENT, "h1"])
    const [attempt] = await rows(it, "select id, state, evidence ->> 'tail_fed' as tail_fed from execution where inbound_id = 'h1'") as { id: string; state: string; tail_fed: string }[]
    expect(attempt).toMatchObject({ state: "completed", tail_fed: "true" })
    const intents = await it.read.ledger({ stream: "execution", subject: attempt.id, kind: "feed.intent" })
    expect(intents.map(one => (one.detail as { purpose: string }).purpose)).toEqual(["tail", "turn"])
    expect((await rows(it, "select kind, source_id from conversation_entry where conversation_id = (select conversation_id from execution where id = $1) order by seq", [attempt.id])).map(e => [e.kind, e.source_id]))
      .toEqual([["input", "h1"], ["reply", "h1"]])
  } finally { await runner?.stop(); await edge.stop(); await it.stop() }
}, 60_000)

test("A13 one agent's finished answer that still cannot be stored keeps the runner's watch on the journal, however another agent's settle went", async () => {
  const { it, edge, start, answered } = await stage({ caps: null })
  let runner: Awaited<ReturnType<typeof runRunner>> | undefined
  try {
    runner = await start()
    // The master's reply is refused until the test opens the store; the worker's is refused ONCE and then taken.
    // Every settle, of a reply or of a job's report, writes the turn record inside its one transaction.
    await it.read.sql("create sequence test_refuse_worker")
    await it.read.sql("create table test_switch (open boolean not null)")
    await it.read.sql("insert into test_switch values (false)")
    await it.read.sql(`create function test_refuse_settle() returns trigger language plpgsql security definer as $$ begin
      if new.stream = 'turn' and new.kind = 'turn' and new.subject = 'j1' and nextval('test_refuse_worker') = 1 then raise exception 'injected once'; end if;
      if new.stream = 'turn' and new.kind = 'turn' and new.subject = 'h1' and not (select open from test_switch) then raise exception 'injected until open'; end if;
      return new; end $$`)
    await it.read.sql("create trigger test_refuse_settle before insert on ledger_event for each row execute function test_refuse_settle()")

    // The master's turn fails to settle first, and is given back as owed.
    await insertInbound(cluster, it.db, { id: "h1", body: "the master's question" })
    expect(await observe(async () => (await rows(it, "select 1 from execution where inbound_id = 'h1' and result is not null")).length === 1, 15_000), "the master's answer was journaled").toBe(true)
    expect(await observe(async () => (await rows(it, "select 1 from state_row where sheet = 'agent_health' and id = $1", [AGENT])).length === 1, 15_000), "and its attempt was given back").toBe(true)
    // Then the worker's fails once and its OWN settle from the journal succeeds at once.
    await insertJob(cluster, it.db, { id: "j1", target: "p1-worker", task: "the worker's brief" })
    expect(await answered("j1", 20_000), "the worker's answer landed from its journal").toBe(true)
    expect(Number((await it.read.sql("select last_value::int as n from test_refuse_worker"))[0].n), "the worker's settle was tried twice").toBe(2)
    expect((await it.read.inbound()).find(r => r.id === "h1")!.state, "the master's answer is still owed").not.toBe("answered")
    // Long enough for a runner that had stopped looking to be seen to have stopped.
    await Bun.sleep(4000)
    expect((await it.read.inbound()).find(r => r.id === "h1")!.state).not.toBe("answered")

    // The store takes the master's answer: the runner is still looking, and it lands once from the journal.
    await it.read.sql("update test_switch set open = true")
    expect(await answered("h1", 20_000), "the master's answer was settled by the watch that the worker's success did not switch off").toBe(true)
    expect((await it.read.outbox()).filter(r => r.inbound_id === "h1")).toHaveLength(1)
    expect((await rows(it, "select inbound_id, state from execution order by started_at")).map(r => [r.inbound_id, r.state])).toEqual([["h1", "completed"], ["j1", "completed"]])
    // No model was asked again for either.
    expect(edge.sessions.flatMap(r => r.fed).filter(m => m.id === "h1")).toHaveLength(1)
    expect(edge.sessions.flatMap(r => r.fed).filter(m => m.id === "j1")).toHaveLength(1)
    expect(await rows(it, "select 1 from replay_hold")).toEqual([])
  } finally { await runner?.stop(); await edge.stop(); await it.stop() }
}, 120_000)

test("A14 a scheduled harvest starts no executor beside an attempt whose ownership is unresolved, and runs once the attempt is shown over", async () => {
  const h = await stageHarvest(cluster, { hub: { tick_seconds: 1 } })
  const it = h.hub
  retrySettings(it)
  const edge = controlledAdapter(it.adapterName)
  edge.hold(m => m.id.startsWith("harvest:"))
  const engine = livingProcess()
  let runner: Awaited<ReturnType<typeof runRunner>> | undefined
  try {
    expect(engine.group, "the stand-in engine leads a process group of its own").toBe(engine.pid)
    plantLine(h, { at: new Date(Date.now() - 2000).toISOString(), direction: "in", from: PERSON, text: "synthetic harvest codeword" })
    // What an earlier incarnation left: an attempt whose process is still there.
    await insertInbound(cluster, it.db, { id: "h1", body: "a long job" })
    await it.read.sql(`insert into conversation (id, person, agent, kind, adapter, native_session)
      values ('conv-old', 'p1', 'p1-lair', 'master', $1, $2)`, [it.adapterName, crypto.randomUUID()])
    await it.read.sql("update inbound set claimed_by = $1, claim_deadline = now() - interval '1 minute' where id = 'h1'", [RUNNER])
    await it.read.sql(`insert into execution (id, inbound_id, conversation_id, agent, runner, incarnation, placement_generation, state, input_digest, evidence)
      values ('attempt-old', 'h1', 'conv-old', 'p1-lair', $1, 'an-earlier-incarnation', 1, 'running', 'd', $2::jsonb)`,
      [RUNNER, { leader: engine.pid, pids: [engine.pid], group: engine.group }])
    runner = await runRunner({ runner: RUNNER, registryFile: it.registryFile, adapters: { [it.adapterName]: edge.adapter } })
    expect((await rows(it, "select state from execution where id = 'attempt-old'"))[0].state).toBe("unknown")

    const until = new Date().toISOString()
    const harvest = harvestRowId(AGENT, until)
    await insertInbound(cluster, it.db, { id: harvest, kind: "harvest", body: encodeHarvestBody({ from: null, until, reason: "demand", lines: 1 }) })
    await Bun.sleep(3500)
    // The exemption is gone: the harvest is not claimed and no child, of any kind, was started for it.
    expect((await it.read.inbound()).find(r => r.id === harvest)).toMatchObject({ state: "received", claimed_by: null })
    expect(edge.sessions, "no executor was started beside the unresolved attempt").toHaveLength(0)
    expect((await it.read.ledger({ subject: harvest })).map(r => r.kind).filter(kind => ["acked", "started", "answered"].includes(kind))).toEqual([])

    // Only proof that the process is gone lets it run.
    await engine.stop()
    expect(await observe(async () => (await rows(it, "select state from execution where id = 'attempt-old'"))[0].state === "interrupted", 15_000)).toBe(true)
    expect(await observe(() => edge.sessions.some(r => r.fed.some(m => m.id === harvest)), 20_000), "the harvest runs once ownership is resolved").toBe(true)
  } finally { edge.hold(() => false); await runner?.stop(); await engine.stop(); await edge.stop(); await h.stop() }
}, 90_000)

test("A11 a machine that booted again proves an attempt over, whatever is or is not left of its recorded processes", async () => {
  const { it, edge, start } = await stage({ worker: false, caps: null })
  const engine = livingProcess()
  let runner: Awaited<ReturnType<typeof runRunner>> | undefined
  try {
    runner = await start()
    const [seen] = await rows(it, "select machine, boot_id from runner_incarnation where runner = $1", [RUNNER])
    await runner.stop()
    runner = undefined
    // A platform that will not say which boot it is has no reboot to prove anything with.
    if (seen.boot_id === null) return
    // An earlier boot of the SAME scheme: identities of two schemes are never compared.
    const earlierBoot = `${String(seen.boot_id).split(":")[0]}:00000000-0000-4000-8000-00000000000a`

    await insertInbound(cluster, it.db, { id: "h1", body: "a long job" })
    // The resident's master conversation was made by the first start (one master per agent),
    // and it is the one the earlier attempt belongs to.
    const [master] = await rows(it, "select id from conversation where kind = 'master' and agent = $1", [AGENT]) as { id: string }[]
    expect(master, "the first start made the master conversation").toBeDefined()
    await it.read.sql("update inbound set claimed_by = $1, claim_deadline = now() + interval '1 hour' where id = 'h1'", [RUNNER])
    // The process it recorded is alive right now, and so would pass for a survivor: only the boot says otherwise.
    await it.read.sql(`insert into execution (id, inbound_id, conversation_id, agent, runner, incarnation, placement_generation, state, input_digest, evidence)
      values ('attempt-old', 'h1', $2, 'p1-lair', $1, 'an-earlier-incarnation', 1, 'running', 'd', $3::jsonb)`,
      [RUNNER, master.id, { leader: engine.pid, pids: [engine.pid], machine: seen.machine, boot_id: earlierBoot }])
    runner = await start()
    expect((await rows(it, "select state from execution where id = 'attempt-old'"))[0].state).toBe("interrupted")
    expect((await rows(it, "select evidence -> 'exit' ->> 'basis' as basis, evidence -> 'exit' ->> 'leader' as leader from execution where id = 'attempt-old'"))[0])
      .toEqual({ basis: "boot", leader: "exited" })
    expect(alive(engine.pid), "the recorded process is still there: the boot, not the process table, is the proof").toBe(true)
    expect(await rows(it, "select cause, state, revision from replay_hold")).toEqual([{ cause: "interrupted", state: "held", revision: 1 }])
    expect((await it.read.noticeRows()).some(n => n.notice_key === "hold:attempt-old:1")).toBe(true)
    expect(edge.sessions.flatMap(r => r.fed).filter(m => m.id === "h1"), "the held input was not fed by anybody").toEqual([])
  } finally { await runner?.stop(); await engine.stop(); await edge.stop(); await it.stop() }
}, 60_000)

const REFUSED = { cause: "login" as const, said: "synthetic terminal refusal" }

/** Another attempt of the agent takes the slot when the eager priming tail is opened: the tail is refused by name, and the first input's fresh child is primed by a RIDING tail. */
async function refuseEagerTail(it: Awaited<ReturnType<typeof stage>>["it"]) {
  plantChatLine({ stateDir: it.stateDir, text: "what was said yesterday" })
  await it.read.sql(`create function test_tail_busy() returns trigger language plpgsql as $$ begin
    raise unique_violation using message = 'duplicate key value violates unique constraint "execution_one_per_agent"'; end $$`)
  await it.read.sql("create trigger test_tail_busy before insert on execution for each row when (new.purpose = 'tail') execute function test_tail_busy()")
}

test("B1 an attempt the engine was handed and refused, with no receipt and no output, is held with real exit proof: fed once, and no outage ending, generic recover, restart or passing retry feeds it again", async () => {
  const { it, edge, start } = await stage({ worker: false, caps: { safeResume: true } })
  let refusing = true
  edge.onStart(row => { if (refusing) { row.loop.setRefusal(REFUSED); row.loop.holdReceipt(true) } })
  let runner: Awaited<ReturnType<typeof runRunner>> | undefined
  try {
    runner = await start()
    await insertInbound(cluster, it.db, { id: "h1", body: "do the risky thing" })
    expect(await observe(() => edge.sessions.some(r => r.fed.some(m => m.id === "h1")))).toBe(true)
    // The loop ends the turn with a terminal refusal: it never said it had the message and produced nothing.
    edge.sessions.find(r => r.fed.some(m => m.id === "h1"))!.loop.endTurn()
    expect(await observe(async () => (await rows(it, "select 1 from replay_hold where inbound_id = 'h1'")).length === 1, 15_000)).toBe(true)
    const [attempt] = await rows(it, "select id, state from execution where inbound_id = 'h1'") as { id: string; state: string }[]
    // No receipt and no output are not "never delivered": the attempt ended with the evidence of its processes, and the input is held.
    expect(attempt.state, "the child was closed and everything of it shown gone: a real exit proof").toBe("interrupted")
    expect(await rows(it, "select cause, state, revision from replay_hold")).toEqual([{ cause: "interrupted", state: "held", revision: 1 }])
    expect((await rows(it, "select effects from execution where id = $1", [attempt.id]))[0].effects, "what was known of its effects is kept").toEqual({ actions: 0, lastAction: "" })
    expect((await rows(it, "select hub_row_held('h1') as held"))[0].held).toBe(true)
    // The refusal is written down for what it was; the held input carries no retry, is not claimed and is not answered.
    expect((await it.read.ledger({ stream: "refusal", subject: "h1" })).map(e => String(e.kind).startsWith("refused."))).toEqual([true])
    const [row] = await rows(it, "select state, claimed_by, retry_at from inbound where id = 'h1'")
    expect(row).toMatchObject({ claimed_by: null, retry_at: null })
    expect(row.state).not.toBe("answered")
    expect((await it.read.noticeRows()).some(n => n.notice_key === `hold:${attempt.id}:1`)).toBe(true)

    // The outage is over (any loop started from here is healthy), the agent is recovered, the runner restarted, the retry
    // interval long past: nothing feeds the original again.
    refusing = false
    await runner.recoverAgent({ id: "generic-recover", agent: AGENT })
    await Bun.sleep(3500)
    await runner.stop()
    runner = await start()
    await Bun.sleep(3500)
    expect(edge.sessions.flatMap(r => r.fed).filter(m => m.id === "h1"), "fed exactly once, before it was refused").toHaveLength(1)
    expect((await it.read.outbox()).some(r => r.inbound_id === "h1")).toBe(false)
    expect(await rows(it, "select id, state from execution where inbound_id = 'h1'")).toEqual([{ id: attempt.id, state: "interrupted" }])
    expect(await rows(it, "select state, revision from replay_hold")).toEqual([{ state: "held", revision: 1 }])
  } finally { await runner?.stop(); await edge.stop(); await it.stop() }
}, 90_000)

test("B2 a riding tail counts as a feed: the tail runs, the input is then refused with no output, and the attempt is held with the tail's effects kept and neither the tail nor the assignment fed again", async () => {
  const { it, edge, start } = await stage({ worker: false, caps: { safeResume: true } })
  // Every feed of the tail is a synthetic effect: a real tail is a model turn and can run tools.
  let tailFeeds = 0
  let refusing = true
  edge.hold(m => {
    if (m.id === AGENT) tailFeeds += 1
    if (m.id === "h1" && refusing) edge.sessions.find(r => r.fed.some(f => f.id === "h1"))!.loop.setRefusal(REFUSED)
    return false
  })
  let runner: Awaited<ReturnType<typeof runRunner>> | undefined
  try {
    await refuseEagerTail(it)
    runner = await start()
    expect(await observe(async () => (await it.read.ledger({ stream: "runner", kind: "tail.refused" })).length === 1, 15_000)).toBe(true)
    await insertInbound(cluster, it.db, { id: "h1", body: "do the risky thing" })
    expect(await observe(async () => (await rows(it, "select 1 from replay_hold where inbound_id = 'h1'")).length === 1, 20_000)).toBe(true)
    const [attempt] = await rows(it, "select id, state, evidence ->> 'tail_fed' as tail_fed from execution where inbound_id = 'h1'") as { id: string; state: string; tail_fed: string }[]
    expect(attempt, "the tail was fed on this attempt, so it is not an attempt that never fed anything").toMatchObject({ state: "interrupted", tail_fed: "true" })
    expect((await it.read.ledger({ stream: "execution", subject: attempt.id, kind: "feed.intent" })).map(e => (e.detail as { purpose: string }).purpose)).toEqual(["tail", "turn"])
    expect(tailFeeds).toBe(1)
    expect(await rows(it, "select cause, state, revision from replay_hold")).toEqual([{ cause: "interrupted", state: "held", revision: 1 }])

    refusing = false
    await runner.recoverAgent({ id: "generic-recover", agent: AGENT })
    await Bun.sleep(3500)
    await runner.stop()
    runner = await start()
    await Bun.sleep(3500)
    expect(tailFeeds, "the tail's effect happened once and was not repeated").toBe(1)
    expect(edge.sessions.flatMap(r => r.fed).filter(m => m.id === "h1"), "the assignment was fed once").toHaveLength(1)
    expect((await it.read.outbox()).some(r => r.inbound_id === "h1")).toBe(false)
    expect(await rows(it, "select id, state from execution where inbound_id = 'h1'")).toEqual([{ id: attempt.id, state: "interrupted" }])
  } finally { await runner?.stop(); await edge.stop(); await it.stop() }
}, 90_000)

test("B3 a feed that rejects after it may have been written is uncertain and held, and so is a refusal before any byte once a tail was fed first; only a refusal before any byte of an input nothing else was fed to is tried again (A9)", async () => {
  // A flush that failed after the engine took the message.
  const flush = await stage({ worker: false })
  flush.edge.hold(m => m.id === "h1")
  flush.edge.failFeedAfterWrite(m => m.id === "h1")
  let runner: Awaited<ReturnType<typeof runRunner>> | undefined
  try {
    runner = await flush.start()
    await insertInbound(cluster, flush.it.db, { id: "h1", body: "do the risky thing" })
    expect(await observe(async () => (await rows(flush.it, "select 1 from replay_hold where inbound_id = 'h1'")).length === 1, 20_000)).toBe(true)
    expect((await rows(flush.it, "select state from execution where inbound_id = 'h1'")).map(r => r.state), "not a failed attempt: the engine may have it").toEqual(["interrupted"])
    // The task-retry interval is a second: it passes, and nothing feeds it again or tells the owner it will be retried.
    await Bun.sleep(3500)
    expect(flush.edge.sessions.flatMap(r => r.fed).filter(m => m.id === "h1")).toHaveLength(1)
    expect((await flush.it.read.outbox()).some(r => r.inbound_id === "h1")).toBe(false)
    expect((await flush.it.read.noticeRows()).filter(n => String(n.notice_key).startsWith("agent-retry"))).toEqual([])
  } finally { await runner?.stop(); await flush.edge.stop(); await flush.it.stop() }

  // A refusal before any byte, after the priming tail was fed to the same attempt.
  const riding = await stage({ worker: false })
  riding.edge.throwFeed(m => m.id === "h1")
  let second: Awaited<ReturnType<typeof runRunner>> | undefined
  try {
    await refuseEagerTail(riding.it)
    second = await riding.start()
    expect(await observe(async () => (await riding.it.read.ledger({ stream: "runner", kind: "tail.refused" })).length === 1, 15_000)).toBe(true)
    await insertInbound(cluster, riding.it.db, { id: "h1", body: "do the risky thing" })
    expect(await observe(async () => (await rows(riding.it, "select 1 from replay_hold where inbound_id = 'h1'")).length === 1, 20_000)).toBe(true)
    expect(await rows(riding.it, "select state, evidence ->> 'tail_fed' as tail_fed from execution where inbound_id = 'h1'")).toEqual([{ state: "interrupted", tail_fed: "true" }])
    await Bun.sleep(3500)
    expect(riding.edge.sessions.flatMap(r => r.fed).filter(m => m.id === "h1"), "the tail was a feed of this attempt, so the input is not tried again").toHaveLength(1)
    expect(riding.edge.sessions.flatMap(r => r.fed).filter(m => m.id === AGENT), "and the tail was not fed again").toHaveLength(1)
  } finally { await second?.stop(); await riding.edge.stop(); await riding.it.stop() }
}, 120_000)

test("B4 an eager priming tail the loop refused is never completed: its attempt ends with the evidence of its processes, the refusal is written down, and the healthy priming is unchanged", async () => {
  // Every process shown gone: interrupted, and the agent is free.
  const proved = await stage({ worker: false, caps: { safeResume: true } })
  let refusing = true
  proved.edge.onStart(row => { if (refusing) row.loop.setRefusal(REFUSED) })
  let runner: Awaited<ReturnType<typeof runRunner>> | undefined
  try {
    plantChatLine({ stateDir: proved.it.stateDir, text: "what was said yesterday" })
    runner = await proved.start()
    expect(await observe(async () => (await rows(proved.it, "select 1 from execution where purpose = 'tail' and state = 'interrupted'")).length === 1, 15_000)).toBe(true)
    expect(await rows(proved.it, "select purpose, state, inbound_id from execution"), "the tail was not completed").toEqual([{ purpose: "tail", state: "interrupted", inbound_id: null }])
    expect(await rows(proved.it, "select 1 from replay_hold"), "a tail has no input to hold and no owner to ask").toEqual([])
    expect((await rows(proved.it, "select hub_agent_blocked($1) as blocked", [AGENT]))[0].blocked, "every process is shown gone, so the agent is free").toBe(false)
    expect((await proved.it.read.ledger({ stream: "refusal", subject: AGENT })).map(e => String(e.kind).startsWith("refused."))).toEqual([true])
    expect(proved.edge.sessions, "the child that was refused").toHaveLength(1)
    expect(proved.edge.sessions[0].fed.map(m => m.id)).toEqual([AGENT])
    expect(proved.edge.sessions[0].closed).toBe(true)

    // The loop is healthy again: the next input starts a child of its own, primed and answered as ever.
    refusing = false
    await insertInbound(cluster, proved.it.db, { id: "h1", body: "hello" })
    expect(await proved.answered("h1", 20_000)).toBe(true)
    // The engine acknowledged the refused tail's session, so the new child resumes it and is not primed again.
    expect(proved.edge.sessions.flatMap(r => r.fed).map(m => m.id), "the refused tail once, then the input").toEqual([AGENT, "h1"])
    expect(proved.edge.sessions, "the input went to a child of its own").toHaveLength(2)
    expect((await rows(proved.it, "select purpose, state from execution order by started_at")).map(r => [r.purpose, r.state])).toEqual([["tail", "interrupted"], ["turn", "completed"]])
  } finally { await runner?.stop(); await proved.edge.stop(); await proved.it.stop() }

  // Nothing shows the process gone: the attempt stays unknown and nobody starts beside it.
  const cut = await stage({ worker: false, evidence: false })
  cut.edge.onStart(row => row.loop.setRefusal(REFUSED))
  let second: Awaited<ReturnType<typeof runRunner>> | undefined
  try {
    plantChatLine({ stateDir: cut.it.stateDir, text: "what was said yesterday" })
    second = await cut.start()
    expect(await observe(async () => (await rows(cut.it, "select 1 from execution where state = 'unknown'")).length === 1, 15_000)).toBe(true)
    expect(await rows(cut.it, "select purpose, state, inbound_id from execution")).toEqual([{ purpose: "tail", state: "unknown", inbound_id: null }])
    expect(await rows(cut.it, "select 1 from replay_hold")).toEqual([])
    expect((await rows(cut.it, "select hub_agent_blocked($1) as blocked", [AGENT]))[0].blocked).toBe(true)
    await insertInbound(cluster, cut.it.db, { id: "h1", body: "hello" })
    await Bun.sleep(3500)
    expect(cut.edge.sessions, "no second child beside an attempt that may still be running").toHaveLength(1)
    expect(cut.edge.sessions.flatMap(r => r.fed).map(m => m.id)).toEqual([AGENT])
    expect((await cut.it.read.inbound()).find(r => r.id === "h1")).toMatchObject({ state: "received", claimed_by: null })
    expect((await rows(cut.it, "select state from execution"))[0].state).toBe("unknown")
  } finally { await second?.stop(); await cut.edge.stop(); await cut.it.stop() }
}, 120_000)

test("B5 a riding tail the loop refused holds the claimed row with its attempt and the input is never fed after it, to that child or to any other", async () => {
  const { it, edge, start } = await stage({ worker: false, caps: { safeResume: true } })
  let refusing = true
  edge.onStart(row => { if (refusing) row.loop.setRefusal(REFUSED) })
  let runner: Awaited<ReturnType<typeof runRunner>> | undefined
  try {
    // The eager tail is refused by name, so the first input's fresh child is primed by a riding tail.
    await refuseEagerTail(it)
    runner = await start()
    expect(await observe(async () => (await it.read.ledger({ stream: "runner", kind: "tail.refused" })).length === 1, 15_000)).toBe(true)
    await insertInbound(cluster, it.db, { id: "h1", body: "do the risky thing" })
    expect(await observe(async () => (await rows(it, "select 1 from replay_hold where inbound_id = 'h1'")).length === 1, 20_000)).toBe(true)
    const [attempt] = await rows(it, "select id, state, effects, evidence ->> 'tail_fed' as tail_fed from execution where inbound_id = 'h1'") as { id: string; state: string; effects: unknown; tail_fed: string }[]
    expect(attempt, "held with the exit evidence of the child, never completed").toMatchObject({ state: "interrupted", tail_fed: "true", effects: { actions: 0, lastAction: "" } })
    expect(await rows(it, "select cause, state, revision from replay_hold")).toEqual([{ cause: "interrupted", state: "held", revision: 1 }])
    expect((await rows(it, "select purpose from execution")).map(r => r.purpose), "no attempt of the tail's own").toEqual(["turn"])
    expect(edge.sessions.flatMap(r => r.fed).map(m => m.id), "the tail was fed, the input was not").toEqual([AGENT])
    expect(await rows(it, "select 1 from conversation_entry where source_id = 'h1' and kind = 'input'"), "the input was never fed, so it is not the conversation's entry").toEqual([])
    const [row] = await rows(it, "select state, claimed_by, retry_at from inbound where id = 'h1'")
    expect(row).toMatchObject({ claimed_by: null, retry_at: null })
    expect(row.state).not.toBe("answered")
    expect((await it.read.ledger({ stream: "refusal", subject: "h1" })).map(e => String(e.kind).startsWith("refused."))).toEqual([true])
    expect(await it.read.ledger({ stream: "refusal", kind: "refused.turn" }), "an ordinary refusal, not a failed feed").toEqual([])
    expect((await it.read.noticeRows()).some(n => n.notice_key === `hold:${attempt.id}:1`)).toBe(true)
    expect((await it.read.noticeRows()).filter(n => String(n.notice_key).startsWith("agent-retry"))).toEqual([])

    // The loop is healthy again, the agent recovered and the runner restarted: nothing feeds the held input.
    refusing = false
    await runner.recoverAgent({ id: "generic-recover", agent: AGENT })
    await Bun.sleep(3500)
    await runner.stop()
    runner = await start()
    await Bun.sleep(3500)
    expect(edge.sessions.flatMap(r => r.fed).filter(m => m.id === "h1"), "never fed").toEqual([])
    expect(edge.sessions.flatMap(r => r.fed).filter(m => m.id === AGENT), "the tail was fed once").toHaveLength(1)
    expect((await it.read.outbox()).some(r => r.inbound_id === "h1")).toBe(false)
    expect(await rows(it, "select id, state from execution")).toEqual([{ id: attempt.id, state: "interrupted" }])
  } finally { await runner?.stop(); await edge.stop(); await it.stop() }
}, 120_000)

/** The tool a master's engine is given, bound to its conversation exactly as the runner binds it. */
function toolFor(it: Awaited<ReturnType<typeof stage>>["it"], conversation: string) {
  const store = { sql: cluster.connectAs("hub_runner", it.db), url: cluster.url(it.db) } as StoreLike
  return { store, binding: { store, person: PERSON, agent: AGENT, conversation, kind: "master" as const, registry: () => loadRegistry(it.registryFile), attempt: () => null } }
}

test("C1 a held conversation whose session the engine never acknowledged is blocked by name and the owner is told, once and durably: no executor starts for a fresh message or for the owner's continuation, the choice and the effects are kept, and the door and the tool say the same thing", async () => {
  const { it, edge, start, door } = await stage({ worker: false, caps: { safeResume: true } })
  // The engine never acknowledges anything, so the conversation's session stays `launched`.
  edge.onStart(row => row.loop.holdReceipt(true))
  edge.hold(m => m.id === "h1")
  let runner: Awaited<ReturnType<typeof runRunner>> | undefined
  const tool = toolFor(it, "")
  try {
    runner = await start()
    await insertInbound(cluster, it.db, { id: "h1", body: "do the risky thing" })
    expect(await observe(() => edge.sessions.some(r => r.fed.some(m => m.id === "h1")))).toBe(true)
    const target = edge.sessions.find(r => r.fed.some(m => m.id === "h1"))!
    edge.hold(() => false)
    target.fail()
    expect(await observe(async () => (await rows(it, "select 1 from replay_hold where inbound_id = 'h1'")).length === 1)).toBe(true)
    const [attempt] = await rows(it, "select id, state, effects from execution where inbound_id = 'h1'") as { id: string; state: string; effects: unknown }[]
    const [master] = await rows(it, "select id, native_state from conversation where kind = 'master'") as { id: string; native_state: string }[]
    expect(attempt.state).toBe("interrupted")
    expect(master.native_state, "a child was started under the id and the engine acknowledged nothing").toBe("launched")

    // A fresh message, and the owner's choice to continue, both recorded while the conversation cannot take a turn.
    await insertInbound(cluster, it.db, { id: "h2", body: "what happened?" })
    const outcome = await requestHoldChoice(door, { registry: loadRegistry(it.registryFile), person: PERSON, door: DOOR, chat: CHAT,
      sender_id: PERSON, message: "recover:1", at: new Date().toISOString(), agent: AGENT, attempt: attempt.id, revision: 1, choice: "continue" })
    expect(outcome, "the choice is not rejected for want of readiness").toBe("continuing")
    await Bun.sleep(3500)
    expect(edge.sessions.filter(r => r.fed.some(m => m.id === "h2" || m.id === "continue:h1:1")), "no executor started for either").toEqual([])
    expect(edge.sessions, "and none at all beside the one that died").toHaveLength(1)
    // On every tick the loop selects h2 (the engine is shown able to resume, so selection lets it through), claims it, finds the
    // session was never acknowledged and gives the claim back before anything is built (`resume.blocked`). A read can land inside
    // that look, so one read finding the claim proves nothing either way. What must hold is that the claim does not STAND: it is
    // back within a bounded look (a stuck claim holds for its whole lease and never is), and the row never leaves `received`.
    let h2: Awaited<ReturnType<typeof it.read.inbound>>[number] | undefined
    expect(await observe(async () => { h2 = (await it.read.inbound()).find(r => r.id === "h2"); return h2?.claimed_by === null }),
      "a claim on the fresh message is given back within the look that took it").toBe(true)
    expect(h2).toMatchObject({ state: "received", claimed_by: null })

    // The owner is told the specific cause, once, keyed on the attempt, revision and cause.
    const told = (await it.read.noticeRows()).filter(n => String(n.notice_key).startsWith("context:"))
    expect(told.map(n => n.notice_key)).toEqual([`context:${attempt.id}:1:native-state-uncertain`])
    expect(told[0].body).toContain("waiting for native context")
    expect(told[0].body).toContain("never acknowledged")
    // The choice, the continuation and what was known of the effects are all kept.
    expect((await rows(it, "select state, choice, native_context ->> 'state' as context, native_context ->> 'cause' as cause from replay_hold"))[0])
      .toEqual({ state: "continuing", choice: "continue", context: "unavailable", cause: "native-state-uncertain" })
    expect((await rows(it, "select id, claimed_by from inbound where id = 'continue:h1:1'"))).toEqual([{ id: "continue:h1:1", claimed_by: null }])
    expect((await rows(it, "select effects from execution where id = $1", [attempt.id]))[0].effects).toEqual(attempt.effects)
    expect((await rows(it, "select body from inbound where id = 'h1'"))[0].body).toBe("do the risky thing")

    // The door and the tool report the same blocked prerequisite, and neither calls it queued behind the current turn.
    const context = await holdContextOf(door, attempt.id)
    expect(context).toMatchObject({ state: "unavailable", cause: "native-state-uncertain" })
    const said = holdChoiceLine("en", { outcome, attempt: attempt.id, agent: AGENT, context: context.state, cause: context.cause })
    expect(said).toContain("waiting for native context")
    expect(said).toContain("never acknowledged")
    expect(said).not.toContain("queued behind the current turn")
    const inspected = await callTool({ ...tool.binding, conversation: master.id }, "hub_topic", { action: "inspect" })
    const [held] = inspected.holds as { native_context: { state: string; cause: string; status_message: string } }[]
    expect(held.native_context).toMatchObject({ state: "unavailable", cause: "native-state-uncertain" })
    expect(held.native_context.status_message).toContain("never acknowledged")

    // A stopped runner leaves nothing measured standing as current; the next one measures again and says nothing twice.
    await runner.stop()
    expect((await rows(it, "select native_context ->> 'state' as state from replay_hold"))[0].state).toBe("pending")
    runner = await start()
    await Bun.sleep(3500)
    expect((await it.read.noticeRows()).filter(n => String(n.notice_key).startsWith("context:")).map(n => n.notice_key)).toEqual([`context:${attempt.id}:1:native-state-uncertain`])
    expect((await rows(it, "select native_context ->> 'state' as state from replay_hold"))[0].state).toBe("unavailable")
    expect(edge.sessions.filter(r => r.fed.some(m => m.id === "h2" || m.id === "continue:h1:1"))).toEqual([])
  } finally { await runner?.stop(); await tool.store.sql.close(); await edge.stop(); await it.stop() }
}, 90_000)

test("C2 an engine not shown able to resume filters the conversation out before any claim: the owner is still told, the choice is kept, and once readiness is measured the linked continuation runs once with the original held for good", async () => {
  const { it, edge, caps, start, door } = await stage({ worker: false, caps: { safeResume: false } })
  let runner: Awaited<ReturnType<typeof runRunner>> | undefined
  try {
    runner = await start()
    edge.hold(m => m.id === "h1")
    await insertInbound(cluster, it.db, { id: "h1", body: "do the risky thing" })
    expect(await observe(() => edge.sessions.some(r => r.fed.some(m => m.id === "h1")))).toBe(true)
    const target = edge.sessions.find(r => r.fed.some(m => m.id === "h1"))!
    edge.hold(() => false)
    target.fail()
    expect(await observe(async () => (await rows(it, "select 1 from replay_hold where inbound_id = 'h1'")).length === 1)).toBe(true)
    const [attempt] = await rows(it, "select id from execution where inbound_id = 'h1'") as { id: string }[]
    expect((await rows(it, "select native_state from conversation where kind = 'master'"))[0].native_state, "the session is one the engine acknowledged").toBe("started")

    await insertInbound(cluster, it.db, { id: "h2", body: "what happened?" })
    const outcome = await requestHoldChoice(door, { registry: loadRegistry(it.registryFile), person: PERSON, door: DOOR, chat: CHAT,
      sender_id: PERSON, message: "recover:1", at: new Date().toISOString(), agent: AGENT, attempt: attempt.id, revision: 1, choice: "continue" })
    expect(outcome).toBe("continuing")
    await Bun.sleep(3500)
    // The engine filtered the rows out of selection, so nothing was ever claimed to find this out: the owner is told anyway.
    expect(edge.sessions.filter(r => r.fed.some(m => m.id === "h2" || m.id === "continue:h1:1"))).toEqual([])
    expect((await rows(it, "select id from inbound where claimed_by is not null"))).toEqual([])
    const told = (await it.read.noticeRows()).filter(n => String(n.notice_key).startsWith("context:"))
    expect(told.map(n => n.notice_key)).toEqual([`context:${attempt.id}:1:safe-resume-unvalidated`])
    expect(told[0].body).toContain("has not been shown to resume an interrupted session")
    const context = await holdContextOf(door, attempt.id)
    expect(context).toMatchObject({ state: "unavailable", cause: "safe-resume-unvalidated" })
    expect(holdChoiceLine("en", { outcome, attempt: attempt.id, agent: AGENT, context: context.state, cause: context.cause })).not.toContain("queued behind the current turn")
    expect((await rows(it, "select state, choice from replay_hold"))[0]).toEqual({ state: "continuing", choice: "continue" })

    // Not measured on the engine that will run next: pending until it is, and never shown as ready on a stale reading.
    await runner.stop()
    expect((await rows(it, "select native_context ->> 'state' as state from replay_hold"))[0].state).toBe("pending")
    // The engine is now shown able to resume: the authorized continuation and the fresh message run, each once.
    caps!.safeResume = true
    runner = await start()
    expect(await observe(async () => {
      const done = (await it.read.outbox()).map(r => r.inbound_id)
      return done.includes("continue:h1:1") && done.includes("h2")
    }, 30_000)).toBe(true)
    expect(edge.sessions.flatMap(r => r.fed).filter(m => m.id === "continue:h1:1"), "the continuation ran once").toHaveLength(1)
    expect(edge.sessions.flatMap(r => r.fed).filter(m => m.id === "h1"), "the original was fed once, before it died").toHaveLength(1)
    expect((await rows(it, "select hub_row_held('h1') as held"))[0].held, "and it is held for good").toBe(true)
    expect((await it.read.outbox()).some(r => r.inbound_id === "h1")).toBe(false)
    expect((await it.read.inbound()).find(r => r.id === "h1")!.state).not.toBe("answered")
    expect((await rows(it, "select state from replay_hold"))[0].state, "the owner's gate is done once the continuation owns the conversation").toBe("released")
    expect((await it.read.noticeRows()).filter(n => String(n.notice_key).startsWith("context:")).map(n => n.notice_key), "nothing was said twice").toEqual([`context:${attempt.id}:1:safe-resume-unvalidated`])
  } finally { await runner?.stop(); await edge.stop(); await it.stop() }
}, 120_000)
