// THE APPROVED PROFILE IS CHECKED WHERE THE BYTES GO.
//
// A roster is accepted with each participant's normalized effective profile (the worker, its preset name and the five settings behind it, its tools,
// its instruction, settings and MCP files, its runner and its machine: `council/profile.ts`). The runner compares it again for EVERY job of that
// participant, before a conversation is chosen or a child is started: a first input that waited for its machine, a later round, a follow-up, a
// correction, an owner's retry and the continuation the store queues after a process is shown over. A worker that no longer matches is refused by
// name (`configuration changed`, with the parts that changed and never a value), nothing is fed, and the council reads it as a member that waits for
// its owner. What the worker can do is not touched: no tools are taken away, no other model is put in its place, no context is rebuilt.
//
// The real `runRunner` and a scripted engine are used for what the runner does with a row; the comparison itself is also read directly.
//
// THE DOOR IS NOT PART OF THIS STAGE. A council is kept true by two readers of the same rows: the runner's settle, which reconciles the council it
// settled a member of, and the door's council watcher, which reconciles on every change and on its own timer (`council/watch.ts`). The settle's
// reconcile never waits for a council somebody else holds (`skip locked`, `council/hooks.ts`) and only reads rows that are committed, so two members
// that settle at the same moment can each miss the other's answer, and the door's next reconcile is what reads them together. Where a case here needs
// the council to have moved and the runner alone left it where the settles could not see (a member's answer committed and its round still `open`),
// it takes the door's first step, `reconcileCouncil`, and only then; any other state is a failure with the picture of the store (`picture`), and
// `P5b` keeps the deferral itself under test.

import { afterAll, afterEach, beforeAll, expect, test } from "bun:test"
import { readFileSync, writeFileSync } from "node:fs"
import { startCluster, until, type Cluster } from "./helpers/cluster.ts"
import { PERSON, RUNNER } from "./helpers/hub-fixture.ts"
import { councilStage, roster, startArgs } from "./helpers/council-stage.ts"
import { controlledAdapter, retrySettings } from "./helpers/rollout-runner.ts"
import { callTool } from "../src/mcp/handlers.ts"
import { reconcileCouncil, reconcileInside } from "../src/council/reconcile.ts"
import { noteJobSettled } from "../src/council/hooks.ts"
import { readSnapshot } from "../src/council/snapshot.ts"
import { statusLine } from "../src/council/lines.ts"
import { checkLaunch } from "../src/council/launch.ts"
import { changedOf, profileIdOf, profileOf } from "../src/council/profile.ts"
import { runRunner } from "../src/runner/run.ts"
import { stamp } from "../src/records/stamps.ts"
import { loadRegistry } from "../src/registry/load.ts"
import type { StoreLike } from "../src/store/connect.ts"

let cluster: Cluster
beforeAll(async () => { cluster = await startCluster() })
afterAll(async () => { await cluster?.stop() })

const mine: { close(): Promise<void> }[] = []
const track = <T extends { close(): Promise<void> }>(sql: T): T => { mine.push(sql); return sql }
afterEach(async () => { for (const one of mine.splice(0)) await one.close().catch(() => {}) })

type Stage = Awaited<ReturnType<typeof councilStage>>

/** One edit of the registry file as written, and it fails loudly when the text it edits is not there. */
function edit(file: string, from: string, to: string) {
  const text = readFileSync(file, "utf8")
  if (!text.includes(from)) throw new Error(`fixture: ${JSON.stringify(from)} is not in the registry file`)
  writeFileSync(file, text.replace(from, to))
}

const move = (s: Stage, id: string, over: Record<string, unknown>, attempt: string | null = "attempt-master") =>
  s.revision(id).then(revision => callTool(s.binding(attempt), "hub_council", { action: "continue", request_key: `k-${Math.random().toString(36).slice(2, 8)}`,
    council_id: id, expected_revision: revision, ...over }))

/**
 * What the store shows of a council, of its members' answers and of its master's attempts, and the last of what the process said on stderr, as one line
 * for the message of a wait that did not end. No text of an answer or an input is in it. (The first failure of P5 on Linux ended with only the jobs, and
 * that could not tell a council that was never reconciled from a master turn that never settled.)
 */
async function picture(s: Stage, id: string, said: readonly string[]): Promise<string> {
  const rows = async (query: any) => Array.from(await query)
  return JSON.stringify({
    council: await rows(s.su`select lifecycle, revision, waiting, current_round, epoch, question_revision from council where id = ${id}`),
    members: await rows(s.su`select participant_id, round, input_revision, state, report_id, inbound_id, cause from round_member where council_id = ${id}
      order by round, participant_id, input_revision`),
    jobs: await rows(s.su`select id, agent, state, claimed_by from inbound where kind = 'job' and source -> 'dispatch' -> 'council_round' ->> 'council' = ${id} order by id`),
    reports: await rows(s.su`select id, state, reported_at from inbound where id in (select 'report:' || inbound_id from round_member where council_id = ${id} and inbound_id is not null) order by id`),
    events: await rows(s.su`select seq, kind, inbound_id, consumed_at is not null as consumed, consumed_attempt, disposition from council_event where council_id = ${id} order by seq`),
    event_rows: await rows(s.su`select id, state, claimed_by, log_ready from inbound where id in (select inbound_id from council_event where council_id = ${id}) order by id`),
    master: await rows(s.su`select id, inbound_id, state, purpose, result is not null as journaled, ended_at is not null as ended from execution where agent = 'p1-lair' order by started_at`),
    holds: await rows(s.su`select inbound_id, cause, state from replay_hold order by inbound_id`),
    gates: await rows(s.su`select operation_id, scope_kind, scope_id, state, evidence ->> 'cause' as cause from claim_gate order by operation_id`),
    stderr: said.slice(-30).map(line => line.trimEnd().slice(0, 300)),
  })
}

/** Work that must finish in a bounded time: a settle that waited for a council would otherwise end the case by its own timeout, saying nothing. */
function within<T>(what: string, work: Promise<T>, ms = 15_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<never>((_, no) => { timer = setTimeout(() => no(new Error(`${what} did not finish within ${ms} ms`)), ms) })
  return Promise.race([work, late]).finally(() => clearTimeout(timer))
}

/** A staged hub whose runner serves the council's workers with a scripted engine, and whose master takes turns on demand. */
async function stageRunner() {
  const s = await councilStage(cluster, track, {
    hub: { tick_seconds: 1 },
    registry: base => ({ ...base, agents: base.agents.map((one: { id: string }) => (one.id === "p1-lair" ? { ...one, mode: "on-demand" } : one)) }),
  })
  retrySettings(s)
  edit(s.registryFile, `id = ${JSON.stringify(RUNNER)}\n`, `id = ${JSON.stringify(RUNNER)}\nmax_active_children = 4\n`)
  // The staging messages are not this test's traffic: answered the way the runner answers a message.
  for (const message of ["h1", "h2"]) await stamp(s.runner, { messageId: message, kind: "answered", actor: "runner" })
  const edge = controlledAdapter(s.adapterName, false, { capabilities: { stableSession: true, safeResume: false, delegationDisabled: true } })
  const start = () => runRunner({ runner: RUNNER, registryFile: s.registryFile, adapters: { [s.adapterName]: edge.adapter } })
  const begin = async () => {
    const started = await callTool(s.binding("attempt-start"), "hub_council", startArgs({ participants: roster(["p1-w1", "p1-w2"]) }))
    const id = String(started.object_id)
    return { id, jobs: await s.jobsOf(id), participants: [`${id}:p1`, `${id}:p2`] }
  }
  const refusals = async () => Array.from(await s.su`select subject, detail from ledger_event where kind = 'dispatch.refused' order by subject`) as { subject: string; detail: Record<string, unknown> }[]
  // What the council's workers were handed (their jobs' ids start with the council's own): the master's turns on the council's events are not the subject here.
  const fed = () => edge.sessions.flatMap(row => row.fed).filter(message => message.id.startsWith("council:"))
  const workers = { executions: (where = "true") => s.count("execution", `agent like 'p1-w%' and ${where}`), conversations: () => s.count("conversation", "kind = 'worker'") }
  return { s, edge, start, begin, refusals, fed, workers }
}

test("P1 a roster is accepted with its normalized effective profile: names, lists and identifiers the registry states, a digest of them, and nothing secret or volatile", async () => {
  const s = await councilStage(cluster, track)
  try {
    const started = await callTool(s.binding("attempt-start"), "hub_council", startArgs({ participants: roster(["p1-w1", "p1-w2"]) }))
    const id = String(started.object_id)
    const rows = Array.from(await s.su`select worker_agent, preset_name, preset_id, profile_id, profile from council_participant where council_id = ${id} order by ordinal`) as any[]
    expect(rows.map(one => one.worker_agent)).toEqual(["p1-w1", "p1-w2"])
    for (const row of rows) {
      expect(row.profile_id).toMatch(/^[0-9a-f]{24}$/)
      expect(Object.keys(row.profile).sort(), "only what the registry states about how the worker runs").toEqual(
        ["instructions", "machine", "mcp", "preset", "preset_id", "role", "runner", "settings", "settings_file", "tools", "worker"])
      expect(row.profile).toMatchObject({ worker: row.worker_agent, runner: RUNNER, preset: "daily", preset_id: row.preset_id, tools: [], instructions: null, mcp: null })
      expect(Object.keys(row.profile.settings).sort()).toEqual(["adapter", "effort", "model", "paid", "provider"])
      // No credential and no store address is in what is hashed or logged.
      expect(JSON.stringify(row.profile)).not.toContain(s.storeUrl)
      expect(profileIdOf(profileOf(loadRegistry(s.registryFile), row.worker_agent)!), "the same digest wherever it is computed").toBe(row.profile_id)
    }
    // The digest tells the workers apart, and any part of the profile moves it.
    expect(rows[0].profile_id).not.toBe(rows[1].profile_id)
    const one = profileOf(loadRegistry(s.registryFile), "p1-w1")!
    for (const changed of [{ tools: ["Read"] }, { runner: "another-runner" }, { machine: "another-machine" }, { preset: "another-preset" }, { instructions: "other.md" }, { mcp: "other.json" },
        { settings: { ...one.settings, model: "another-model" } }]) {
      expect(profileIdOf({ ...one, ...changed })).not.toBe(profileIdOf(one))
    }
    expect(changedOf(one as any, { ...one, tools: ["Read"], runner: "another-runner", machine: "another-machine", settings: { ...one.settings, effort: "high" } })).toEqual(["runner", "machine", "effort", "tools"])
    expect(changedOf(one as any, null), "a worker that is not configured any more").toEqual(["worker"])
  } finally { await s.close() }
}, 60_000)

test("P2 the same preset name with another model: a first job that waited for its machine is refused before anything is fed, by name, and both members wait for their owner", async () => {
  const { s, edge, start, begin, refusals, fed, workers } = await stageRunner()
  let runner: Awaited<ReturnType<typeof runRunner>> | undefined
  try {
    const { id, jobs } = await begin()
    // While the jobs wait, the preset's model is edited. The preset is still called `daily`.
    edit(s.registryFile, `model = "a-model-name"`, `model = "another-model"`)
    runner = await start()
    await until("both jobs were refused", async () => (await s.jobsOf(id)).every(job => job.state === "answered"), 30_000, async () => JSON.stringify(await s.jobsOf(id)))
    await reconcileCouncil(s.runner, id)

    // Nothing reached an engine, and nothing was made for the worker: no input, no attempt, no conversation.
    expect(fed()).toHaveLength(0)
    expect(await workers.executions()).toBe(0)
    expect(await workers.conversations()).toBe(0)
    const said = await refusals()
    expect(said.map(one => one.subject).sort()).toEqual(jobs.map(one => one.id).sort())
    for (const one of said) expect(one.detail).toMatchObject({ cause: "configuration changed", changed: "model" })
    // The council reads it as members that cannot be waited for, with the named cause, and asks. Nothing is replaced, retried or held.
    const members = Array.from(await s.su`select state, cause from round_member where council_id = ${id} order by participant_id`) as any[]
    expect(members).toMatchObject([{ state: "missing", cause: { kind: "configuration_changed", detail: "model" } }, { state: "missing", cause: { kind: "configuration_changed", detail: "model" } }])
    expect((await s.su`select lifecycle from council where id = ${id}`)[0].lifecycle).toBe("waiting_owner")
    expect(await s.count("replay_hold")).toBe(0)
    expect(await s.count("claim_gate")).toBe(0)
    expect(await s.count("inbound", "kind = 'job'")).toBe(2)
    const snapshot = await readSnapshot(s.runner, id, { now: new Date(), quietSeconds: 300 })
    expect(snapshot?.members.map(one => one.view)).toEqual(["missing", "missing"])
    expect(statusLine("en", snapshot!)).toContain("no longer matches what was approved (model)")
  } finally { await runner?.stop(); await edge.stop().catch(() => {}); await s.close() }
}, 120_000)

test("P3 the same preset name with another adapter is refused the same way, before the adapter is looked up", async () => {
  const { s, edge, start, begin, refusals, fed, workers } = await stageRunner()
  let runner: Awaited<ReturnType<typeof runRunner>> | undefined
  try {
    const { id } = await begin()
    edit(s.registryFile, `adapter = ${JSON.stringify(s.adapterName)}`, `adapter = "another-adapter"`)
    runner = await start()
    await until("both jobs were refused", async () => (await s.jobsOf(id)).every(job => job.state === "answered"), 30_000, async () => JSON.stringify(await s.jobsOf(id)))
    expect(fed()).toHaveLength(0)
    for (const one of await refusals()) expect(one.detail).toMatchObject({ cause: "configuration changed", changed: "adapter" })
    expect(await workers.executions()).toBe(0)
  } finally { await runner?.stop(); await edge.stop().catch(() => {}); await s.close() }
}, 120_000)

test("P4 a change to one worker's effective tools refuses only that worker's job: its sibling runs and answers in its own conversation, and reverting the change and the owner's fresh retry lets the refused member proceed", async () => {
  const { s, edge, start, begin, refusals, fed, workers } = await stageRunner()
  let runner: Awaited<ReturnType<typeof runRunner>> | undefined
  try {
    const { id, jobs: [j1, j2], participants: [p1, p2] } = await begin()
    // The first worker is given a tool while its job waits: same preset, same runner, same machine.
    edit(s.registryFile, `id = "p1-w1"\n`, `id = "p1-w1"\ntools = ["Read"]\n`)
    runner = await start()
    await until("the sibling answered and the first job was refused", async () => {
      const jobs = await s.jobsOf(id)
      return jobs.every(job => job.state === "answered") && (await s.count("inbound", `id = 'report:${j2.id}'`)) === 1
    }, 30_000, async () => JSON.stringify(await s.jobsOf(id)))
    await reconcileCouncil(s.runner, id)
    expect(await s.count("inbound", `id = 'report:${j1.id}'`), "the refused member has no answer").toBe(0)
    expect((await refusals()).map(one => [one.subject, one.detail.cause, one.detail.changed])).toEqual([[j1.id, "configuration changed", "tools"]])
    // The sibling was not touched: one child, one attempt that completed, its own conversation with the input and the reply.
    expect(fed().map(message => message.id)).toEqual([j2.id])
    expect((await s.su`select agent, state from execution where agent like 'p1-w%'`).map((row: any) => [row.agent, row.state])).toEqual([["p1-w2", "completed"]])
    expect((await s.su`select owner_ref from conversation where kind = 'worker'`).map((row: any) => row.owner_ref)).toEqual([j2.id])
    expect(await s.count("conversation_entry", `source_id = '${j2.id}'`)).toBe(2)
    const members = Array.from(await s.su`select participant_id, state, cause from round_member where council_id = ${id} order by participant_id`) as any[]
    expect(members).toMatchObject([{ participant_id: p1, state: "missing", cause: { kind: "configuration_changed", detail: "tools" } }, { participant_id: p2, state: "answered" }])
    expect((await s.su`select lifecycle from council where id = ${id}`)[0].lifecycle).toBe("waiting_owner")
    // Nothing is retried on its own: the row is answered as refused, and no worker was started for it in the meantime.
    expect(await s.count("execution", `inbound_id = '${j1.id}'`)).toBe(0)
    expect(await workers.executions()).toBe(1)

    // The configuration is put back, and only the owner's fresh retry makes work: a new input, under the profile that was approved.
    edit(s.registryFile, `tools = ["Read"]\n`, ``)
    await s.human("h3")
    const retried = await move(s, id, { kind: "owner_decision", source_message_ids: ["h3"], decision: { choice: "retry", affected_ids: [p1] } })
    expect(retried).toMatchObject({ stage: "retrying" })
    await until("the council has every answer", async () => (await s.su`select lifecycle from council where id = ${id}`)[0].lifecycle === "waiting_master", 30_000,
      async () => JSON.stringify(await s.su`select id, state from inbound where kind = 'job'`))
    expect(fed().map(message => message.id).filter(one => one === j1.id), "the refused input itself was never fed").toEqual([])
    expect(fed()).toHaveLength(2)
  } finally { await runner?.stop(); await edge.stop().catch(() => {}); await s.close() }
}, 180_000)

test("P5 a change after the first round: the owner's follow-up is queued into the same conversations and refused by the runner, and what the participants had answered and the conversations themselves are untouched", async () => {
  const { s, edge, start, begin, refusals, fed, workers } = await stageRunner()
  let runner: Awaited<ReturnType<typeof runRunner>> | undefined
  // What the runner and the council code say on stderr (a hook that failed says so there and nowhere else), kept for the picture and for the check below.
  const said: string[] = []
  const write = process.stderr.write.bind(process.stderr)
  process.stderr.write = ((chunk: unknown, ...rest: unknown[]) => { said.push(String(chunk)); return (write as (...args: unknown[]) => boolean)(chunk, ...rest) }) as typeof process.stderr.write
  try {
    const { id, jobs, participants } = await begin()
    runner = await start()
    const show = () => picture(s, id, said)
    // WHAT THE RUNNER DOES, on its own: both members' jobs are settled, each with its report.
    await until("both first-round jobs were answered, each with its report", async () =>
      (await s.jobsOf(id)).every(job => job.state === "answered") && (await s.count("inbound", `id in (${jobs.map(job => `'report:${job.id}'`).join(", ")})`)) === 2, 60_000, show)
    // WHAT READS THEM INTO THE COUNCIL. Each settle reconciles the council it settled a member of, without waiting for it (`skip locked`) and from committed rows only,
    // so of two answers that land together each can miss the other's. That leaves a member `open` beside its own committed report and the council `running` until
    // the door's reconcile, which this stage has no task for (see the header). It is taken here, and only for exactly that state: a council in any other state
    // (a lifecycle no settle could have left, no member behind a report) is a failure with the picture of the store, and so is a hook that failed on stderr.
    const [state] = Array.from(await s.su`select c.lifecycle, (select count(*)::int from round_member m where m.council_id = c.id and m.round = 1 and m.state = 'open'
      and exists (select 1 from inbound r where r.id = 'report:' || m.inbound_id)) as behind from council c where c.id = ${id}`) as { lifecycle: string; behind: number }[]
    const hooksOk = async (when: string) => {
      const failed = said.filter(line => /council-hook:|council:pass-failed/.test(line))
      if (failed.length > 0) throw new Error(`a council hook failed ${when} (${failed.map(line => line.trim().slice(0, 300)).join(" | ")}): ${await show()}`)
    }
    await hooksOk("while the round settled")
    if (state.lifecycle === "running" && state.behind > 0) {
      write(`council-profile P5: the round's answers were each read by a settle that could not see the other's (${state.behind} member behind its report); taking the door's reconcile\n`)
      await reconcileCouncil(s.runner, id)
    } else if (state.lifecycle !== "waiting_master" && state.lifecycle !== "assessing") {
      throw new Error(`the council is ${state.lifecycle} with ${state.behind} members behind their reports after both answers were committed, which no settle leaves and the door's reconcile is not for: ${await show()}`)
    }
    await until("the first round is answered and the master has it", async () => (await s.su`select lifecycle from council where id = ${id}`)[0].lifecycle === "waiting_master", 60_000, show)
    expect(fed().map(message => message.id).sort()).toEqual(jobs.map(one => one.id).sort())
    // The same runner hands the master the round's event, and the council's revision moves twice with it: to `assessing` when the event is fed and back to
    // `waiting_master` when that turn settles without a finalize. The owner's follow-up is made against the revision the master would have looked at AFTER
    // that turn, so the test waits for the turn to be over (the event read, the council waiting for its master again) before it takes the revision it acts on.
    await until("the master's own turn on the round's event is over", async () => {
      const [row] = Array.from(await s.su`select c.lifecycle, (select count(*)::int from council_event e where e.council_id = c.id and e.consumed_at is null) as unread
        from council c where c.id = ${id}`) as { lifecycle: string; unread: number }[]
      return row.lifecycle === "waiting_master" && row.unread === 0
    }, 60_000, show)
    const conversations = (await s.su`select id, owner_ref from conversation where kind = 'worker' order by owner_ref`).map((row: any) => [row.id, row.owner_ref])
    const entriesOf = () => s.count("conversation_entry", "conversation_id in (select id from conversation where kind = 'worker')")
    const entries = await entriesOf()

    // The model is edited, and the owner asks the same participants more.
    edit(s.registryFile, `model = "a-model-name"`, `model = "another-model"`)
    await s.human("h3")
    const follow = await move(s, id, { kind: "follow_up", source_message_ids: ["h3"], participants,
      briefs: participants.map(participant_id => ({ participant_id, text: "Once more, with feeling." })) })
    expect(follow).toMatchObject({ stage: "follow_up", round: 2, epoch: 2 })
    await until("both follow-up jobs were refused", async () => (await s.jobsOf(id)).filter(job => job.source.dispatch.council_round.round === 2).every(job => job.state === "answered"), 30_000,
      show)
    // The reconcile below is the door's step again, and it would hide a refusal hook that failed: none did.
    await hooksOk("while the follow-up was refused")
    await reconcileCouncil(s.runner, id)

    // Nothing was fed under the changed profile, no conversation was made or changed, and what was answered is still answered.
    expect(fed(), "still only the first round's two inputs").toHaveLength(2)
    expect((await s.su`select id, owner_ref from conversation where kind = 'worker' order by owner_ref`).map((row: any) => [row.id, row.owner_ref])).toEqual(conversations)
    expect(await entriesOf(), "no entry was added to any participant's conversation").toBe(entries)
    expect(await workers.executions()).toBe(2)
    void edge
    const refused = (await refusals()).filter(one => !jobs.some(job => job.id === one.subject))
    expect(refused).toHaveLength(2)
    for (const one of refused) expect(one.detail).toMatchObject({ cause: "configuration changed", changed: "model" })
    for (const job of jobs) expect(await s.count("inbound", `id = 'report:${job.id}'`), "the first round's answers are kept").toBe(1)
    const round2 = Array.from(await s.su`select state, cause from round_member where council_id = ${id} and round = 2 order by participant_id`) as any[]
    expect(round2).toMatchObject([{ state: "missing", cause: { kind: "configuration_changed" } }, { state: "missing", cause: { kind: "configuration_changed" } }])
    expect((await s.su`select lifecycle from council where id = ${id}`)[0].lifecycle).toBe("waiting_owner")
  } finally {
    // The runner, the engine and the stage are always taken down, and stderr is given back after them.
    try { await runner?.stop(); await edge.stop().catch(() => {}); await s.close() } finally { process.stderr.write = write }
  }
}, 240_000)

test("P5b a settle never waits for a council that another settle holds: of two answers that land together the second is left for the next reconcile, and the door's reconcile reads them both", async () => {
  const s = await councilStage(cluster, track)
  let release: () => void = () => {}
  let first: Promise<unknown> | undefined
  try {
    const started = await callTool(s.binding("attempt-start"), "hub_council", startArgs({ participants: roster(["p1-w1", "p1-w2"]) }))
    const id = String(started.object_id)
    const [j1, j2] = await s.jobsOf(id)
    // Two settles on two connections of the runner's role, each in a transaction of its own as the runner's are (`settleTurn`): the report through the
    // function the door owns, and then the hook the runner calls. The first has read the council and stays open, holding it, until the second is done.
    const one = track(cluster.connectAs("hub_runner", s.db))
    const two = track(cluster.connectAs("hub_runner", s.db))
    const inside = (tx: unknown) => ({ ...s.runner, sql: tx as StoreLike["sql"] }) as StoreLike
    const held = new Promise<void>(resolve => { release = resolve })
    let read!: () => void
    const has = new Promise<void>(resolve => { read = resolve })
    first = one.begin(async (tx: unknown) => {
      await inside(tx).sql`select hub_report(${j1.id}, ${"one"})`
      await noteJobSettled(inside(tx), j1.source)
      read()
      await held
    })
    await within("the first settle", Promise.race([has, first]))

    // The second cannot see the first's answer (it is not committed) and cannot have the council (the first holds it): it finishes without waiting.
    let taken: { changed: boolean; skipped?: boolean } | undefined
    await within("the second settle, which must not wait for the council", two.begin(async (tx: unknown) => {
      await inside(tx).sql`select hub_report(${j2.id}, ${"two"})`
      taken = await reconcileInside(inside(tx), id, { skipLocked: true })
      await noteJobSettled(inside(tx), j2.source)
    }))
    expect(taken, "the council was held, and the step gave up without looking at anything").toMatchObject({ changed: false, skipped: true })
    release()
    await within("the first settle's commit", first)

    // Both answers are committed, and the council has read one of them: nothing is lost, and nothing is invented either.
    expect(await s.count("inbound", `id in ('report:${j1.id}', 'report:${j2.id}')`), "both answers are there").toBe(2)
    const before = Array.from(await s.su`select participant_id, state from round_member where council_id = ${id} order by participant_id`) as any[]
    expect(before).toMatchObject([{ participant_id: `${id}:p1`, state: "answered" }, { participant_id: `${id}:p2`, state: "open" }])
    expect((await s.su`select lifecycle from council where id = ${id}`)[0].lifecycle).toBe("running")
    expect(await s.count("council_event", `council_id = '${id}'`), "no event for the master yet").toBe(0)

    // The door's reconcile (the same step, taking the council's lock) reads them both, writes the one event, and finds nothing to do the second time.
    const done = await reconcileCouncil(s.runner, id)
    expect(done.changed).toBe(true)
    expect(done.events).toHaveLength(1)
    const after = Array.from(await s.su`select state from round_member where council_id = ${id} order by participant_id`) as any[]
    expect(after).toMatchObject([{ state: "answered" }, { state: "answered" }])
    expect((await s.su`select lifecycle from council where id = ${id}`)[0].lifecycle).toBe("waiting_master")
    expect(Array.from(await s.su`select kind from council_event where council_id = ${id}`)).toMatchObject([{ kind: "round_complete" }])
    expect(await reconcileCouncil(s.runner, id)).toMatchObject({ changed: false, events: [] })
  } finally {
    release()
    await first?.catch(() => {})
    await s.close()
  }
}, 60_000)

test("P6 the check itself: a recovery continuation is compared like any job of its participant, a conversation that is not the participant's is refused, and an unchanged worker passes with the digest it was approved under", async () => {
  const s = await councilStage(cluster, track)
  try {
    const started = await callTool(s.binding("attempt-start"), "hub_council", startArgs({ participants: roster(["p1-w1", "p1-w2"]) }))
    const id = String(started.object_id)
    const [j1, j2] = await s.jobsOf(id)
    await s.answer(j2.id, "two")
    await s.interrupt(j1.id)
    await reconcileCouncil(s.runner, id)
    await s.human("h3")
    const retry = await move(s, id, { kind: "owner_decision", source_message_ids: ["h3"], decision: { choice: "retry", affected_ids: [`${id}:p1`] } })
    expect(retry).toMatchObject({ stage: "retrying" })
    const [continuation] = Array.from(await s.su`select id, agent, source from inbound where id = ${"continue:" + j1.id + ":1"}`) as any[]
    expect(continuation.source.dispatch.council_round, "the continuation keeps the mark of its participant").toMatchObject({ council: id, participant: `${id}:p1` })
    const [accepted] = Array.from(await s.su`select profile_id from council_participant where id = ${id + ":p1"}`) as any[]
    const row = { id: continuation.id, agent: continuation.agent, source: continuation.source }

    const before = loadRegistry(s.registryFile)
    expect(await checkLaunch(s.runner, { row, registry: before })).toEqual({ profile: accepted.profile_id, refusal: null })
    // An ordinary job is not a council's and is never asked.
    expect(await checkLaunch(s.runner, { row: { id: "x", agent: "p1-w1", source: { ...row.source, dispatch: { ...row.source.dispatch, council_round: undefined } } }, registry: before })).toEqual({ profile: null, refusal: null })

    // The model is edited: the continuation is refused, by name, and only for what changed.
    edit(s.registryFile, `model = "a-model-name"`, `model = "another-model"`)
    expect(await checkLaunch(s.runner, { row, registry: loadRegistry(s.registryFile) })).toEqual({ profile: null, refusal: { cause: "configuration changed", changed: ["model"] } })
    // A job that names a conversation that is not this participant's own is refused, whatever the configuration says.
    const elsewhere = { ...row, source: { ...row.source, dispatch: { ...row.source.dispatch, conversation: "somebody-elses-conversation" } } }
    expect((await checkLaunch(s.runner, { row: elsewhere, registry: before })).refusal).toEqual({ cause: "conversation unavailable", changed: [] })
    // A job of a participant that does not exist is not approved.
    const strange = { ...row, source: { ...row.source, dispatch: { ...row.source.dispatch, council_round: { ...row.source.dispatch.council_round, participant: "no-such-participant" } } } }
    expect((await checkLaunch(s.runner, { row: strange, registry: before })).refusal).toEqual({ cause: "not approved", changed: [] })
    // A worker that is no longer the one the job is for is refused as a changed worker.
    expect((await checkLaunch(s.runner, { row: { ...row, agent: "p1-w2" }, registry: before })).refusal).toEqual({ cause: "configuration changed", changed: ["worker"] })
    void PERSON
  } finally { await s.close() }
}, 60_000)
