// A target on another machine needs nothing new, and an agent that only takes
// jobs declares its empty tail rather than being served one.
//
// A JOB IS A ROW IN THE ONE STORE, so the machinery that already carries a
// message carries it: the insert's own `hub_work` notification wakes the
// target's runner at the commit, a runner that was off finds the row on its
// connect read and on every bound after it, and a runner whose listening
// connection dropped is sent back to the table by the waiter it already holds.
// Nothing here adds a poll, a timer or a channel on the runner side.
//
// A JOB'S BODY IS ITS WHOLE INPUT, and no job depends on a chat tail on another
// machine. That sentence is what lets a target live on a machine that holds no
// chat state at all, and it is asserted on the scripted loop's own record of
// what it was fed.
//
// THE JOB-ONLY AGENT names neither a door nor a chat. It has no chat log, no
// typing, no clock, no harvest, no cursor and no allowlist, and its runner
// skips the tail at spawn. That is a DECLARED empty tail, which is a different
// thing from an agent whose chat log lives on another machine: that one is
// served, its chat read from the store where the machine holds no log, and it
// is asserted here beside the new shape so the two are told apart.
//
// Red reasons: behaviour absent. The loader copies `door` and `chat` onto every
// agent whether the file names them or not, so a job-only agent loads holding
// two keys set to undefined, and nothing refuses an agent that names one and
// not the other. The spawn reads a tail for every agent, so a file that happens
// to sit where a chat log would be is fed to an agent that has no chat. `check`
// reports an empty allowlist for an agent that has no door to be written to.

import { afterAll, beforeAll, expect, test } from "bun:test"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import {
  startCluster,
  lockTable,
  waitForLockWaiter,
  waitForBackendsGone,
  startReadySubprocess,
  until,
  type Cluster,
  type ReadyProcess,
} from "./helpers/cluster.ts"
import {
  rolloutStage,
  DISPATCHER,
  DISPATCH_JOB_ONLY,
  DISPATCH_RUNNER2,
  DISPATCH_TARGET,
} from "./helpers/rollout-stage.ts"
import { message } from "./helpers/rollout-ingress.ts"
import { controlledAdapter, editAgent, observe } from "./helpers/rollout-runner.ts"
import { insertInbound, plantChatLine, superStore } from "./helpers/hub-fixture.ts"
import { DISPATCH_PHRASES, agentRetry } from "../src/door/lines.ts"
import { projectInbound } from "../src/chatlog/project.ts"
import { loadRegistry, RegistryRefused } from "../src/registry/load.ts"
import { listAgents } from "../src/registry/entries.ts"
import { boxContextFor } from "../src/box/index.ts"
import { allowlistFindings } from "../src/check/senders.ts"
import { cursorId } from "../src/door/cursor.ts"
import { runDoor } from "../src/door/run.ts"
import { runRunner } from "../src/runner/run.ts"

let cluster: Cluster
beforeAll(async () => { cluster = await startCluster() })
afterAll(async () => { await cluster?.stop() })

const LAIR_CHAT = "1000000001"
const TASK = "count the synthetic ledger rows"
const REPORT = "there are forty two"

type Stage = Awaited<ReturnType<typeof rolloutStage>>

/** One `/dispatch` typed by the owner in the dispatcher's chat, returned once its row exists. */
async function dispatched(it: Stage, id: string, target = DISPATCH_JOB_ONLY, task = TASK) {
  it.edge.batch([{ ...message(id, `${DISPATCH_PHRASES.en} ${target} ${task}`), chat: LAIR_CHAT, sender_id: "p1", from: "p1" }],
    String(Number(id) + 1))
  await until("the job reaches the queue", async () =>
    (await it.read.inbound()).some(r => r.kind === "job" && r.body === task), 20_000)
  return (await it.read.inbound()).find(r => r.kind === "job" && r.body === task)!
}

/** Every runner-role backend, for a failure message that says what was there instead. */
async function runnerBackends(it: Stage): Promise<string> {
  return JSON.stringify(await it.read.sql(
    `select pid, state, left(query, 80) as query from pg_stat_activity
      where datname = current_database() and usename = 'hub_runner' order by pid`))
}

/** The runner-role backends holding a LISTEN, read off the server's own activity view. */
async function runnerListeners(it: Stage): Promise<{ pid: number; query: string }[]> {
  // A listening connection issues exactly one statement, `listen <channel>`,
  // and then sits idle for the rest of its life, so the server still shows that
  // statement as the backend's last. `pg_listening_channels()` would be the
  // direct answer, but it reports only for the backend that calls it.
  return (await it.read.sql(
    `select pid, query from pg_stat_activity
      where datname = current_database() and usename = 'hub_runner'
        and state = 'idle' and query ilike 'listen %' order by pid`)) as { pid: number; query: string }[]
}

test("D-214 an agent with neither door nor chat is a legal shape, one without the other refuses the file by line, and its box is its person's", async () => {
  const it = await rolloutStage(cluster, "telegram", { dispatch: true })
  try {
    const registry = loadRegistry(it.registryFile)
    const agents = listAgents(registry)
    const only = agents.find(one => one.id === DISPATCH_JOB_ONLY)!
    // THE WHOLE KEY SET, so a build that filled the two with empty strings, or
    // left them present holding nothing, fails here.
    expect(Object.keys(only).sort()).toEqual(["id", "person", "preset", "runner"])
    expect(Object.hasOwn(only, "door")).toBe(false)
    expect(Object.hasOwn(only, "chat")).toBe(false)
    // The control: an agent naming both reads back with the same keys it has always had.
    const target = agents.find(one => one.id === DISPATCH_TARGET)!
    expect(Object.keys(target).sort()).toEqual(["chat", "door", "id", "person", "preset", "runner"])

    // One without the other. The line is the agent's own id line, because the
    // key the file is missing has no line of its own.
    const text = readFileSync(it.registryFile, "utf8")
    const nth = agents.findIndex(one => one.id === DISPATCH_JOB_ONLY)
    const idLine = text.split("\n").findIndex(line => line === `id = "${DISPATCH_JOB_ONLY}"`) + 1
    expect(idLine).toBeGreaterThan(0)
    for (const [given, missing] of [["chat", "door"], ["door", "chat"]] as const) {
      writeFileSync(it.registryFile, text)
      editAgent(it.registryFile, DISPATCH_JOB_ONLY, given === "chat" ? { chat: "1000000009" } : { door: "door-fake" })
      let refusal: unknown = null
      try { loadRegistry(it.registryFile) } catch (error) { refusal = error }
      expect(refusal).toBeInstanceOf(RegistryRefused)
      expect((refusal as RegistryRefused).key).toBe(`agents[${nth}].${missing}`)
      expect((refusal as RegistryRefused).line).toBe(idLine)
      expect(String((refusal as RegistryRefused).message)).toContain(`line ${idLine}`)
    }
    writeFileSync(it.registryFile, text)

    // The person's tree is the fence, and having no chat changes nothing about
    // it: the same object as a chat-bearing agent of the same person, with the
    // agent id the only difference.
    const reloaded = loadRegistry(it.registryFile)
    expect(boxContextFor(reloaded, DISPATCH_JOB_ONLY))
      .toEqual({ ...boxContextFor(reloaded, DISPATCHER), agent: DISPATCH_JOB_ONLY })
  } finally { await it.stop() }
}, 60_000)

test("D-214 a job for a stopped runner waits unclaimed, is claimed when it starts, is fed its body alone, and leaves none of the six things a chat carries", async () => {
  const it = await rolloutStage(cluster, "telegram", { dispatch: true,
    adapter: { answer: (fed: { text: string }) => fed.text === TASK ? REPORT : "an ordinary answer" } })
  let door: Awaited<ReturnType<typeof runDoor>> | undefined
  let spoke: Awaited<ReturnType<typeof runRunner>> | undefined
  let hub: Awaited<ReturnType<typeof runRunner>> | undefined
  const store = await superStore(cluster, it.db)
  try {
    door = await runDoor({ door: "door-fake", registryFile: it.registryFile, platform: it.edge.platform })
    const job = await dispatched(it, "100")
    expect(job.agent).toBe(DISPATCH_JOB_ONLY)

    // --- 1. Nothing runs for it, so it waits where it landed.
    expect(await observe(async () => {
      const row = (await it.read.inbound()).find(r => r.id === job.id)!
      return row.state !== "received" || row.claimed_by !== null
    }, 1_500)).toBe(false)
    expect((await it.read.ledger({ stream: "turn", subject: job.id }))).toEqual([])

    spoke = await runRunner({ runner: DISPATCH_RUNNER2, registryFile: it.registryFile,
      adapters: { [it.adapterName]: it.scripted.adapter } })
    await until("the spoke claims the job and reports", async () =>
      (await it.read.inbound()).some(r => r.id === `report:${job.id}`), 30_000)
    expect((await it.read.inbound()).filter(r => r.kind === "report")).toHaveLength(1)
    expect((await it.read.ledger({ subject: job.id, kind: "answered" }))).toHaveLength(1)

    // --- 2. Nothing new was opened to wake it: the spoke serves one agent and
    //     holds one listener, on the shipped work channel, and no other.
    //     The three shipped mechanisms that carry this are the insert's own
    //     notification at the commit, the connect read and the read on every
    //     bound for a runner that was off, and the waiter reopening its LISTEN
    //     when the connection is lost. The second listener is the runner
    //     process's own control channel, which every runner holds whatever it
    //     serves.
    await until("the spoke's waiter is listening again after the turn", async () =>
      (await runnerListeners(it)).filter(one => one.query === "listen hub_work").length === 1, 10_000, () => runnerBackends(it))
    expect((await runnerListeners(it)).map(one => one.query).sort()).toEqual(["listen hub_control", "listen hub_work"])

    // --- 5. The body and nothing else, asserted whole on the loop's own record.
    expect(it.scripted.fed().map(one => ({ id: one.id, text: one.text }))).toEqual([{ id: job.id, text: TASK }])

    // --- 9. The six things an agent with a chat has, each read where it would be.
    expect(existsSync(join(it.stateDir, "p1", "chatlog", DISPATCH_JOB_ONLY))).toBe(false)
    expect(it.edge.typings()).toEqual([])
    expect(await it.read.ledger({ stream: "clock", subject: job.id })).toEqual([])
    expect((await it.read.harvestSheet()).map(row => row.id)).not.toContain(`p1/${DISPATCH_JOB_ONLY}`)
    const chats = listAgents(loadRegistry(it.registryFile)).filter(one => one.chat !== undefined)
      .map(one => cursorId(String(one.door), String(one.chat)))
    for (const row of await it.read.sheet("door_cursor")) expect(chats).toContain(row.id)
    const registry = loadRegistry(it.registryFile)
    const findings = allowlistFindings({ agents: listAgents(registry), registry, machine: "pi", registryFile: it.registryFile })
    expect(findings.map(one => one.subject)).not.toContain(DISPATCH_JOB_ONLY)
    // The allowlist control: the same producer still reports an agent that has
    // a door and nobody allowed to write to it.
    const p2 = readFileSync(it.registryFile, "utf8").replace(/allowed_senders = \{ door-fake = \["p2"\] \}\n/, "")
    writeFileSync(it.registryFile, p2)
    const bare = loadRegistry(it.registryFile)
    expect(allowlistFindings({ agents: listAgents(bare), registry: bare, machine: "pi", registryFile: it.registryFile })
      .map(one => one.subject).sort()).toEqual(["p2-lair", "p2-research"])

    // --- The control: an agent with a chat, on the machine that holds its
    //     state, is fed its tail before anything else and shows typing while it
    //     works, exactly as it does today.
    await projectInbound(store, { stateDir: it.stateDir, inboundId: `report:${job.id}` })
    hub = await runRunner({ runner: "runner-pi", registryFile: it.registryFile,
      adapters: { [it.adapterName]: it.scripted.adapter } })
    await until("the dispatcher is fed the report", async () =>
      it.scripted.fed().some(one => one.id === `report:${job.id}`), 30_000)
    const lair = it.scripted.fed().filter(one => one.id === DISPATCHER || one.id === `report:${job.id}`)
    expect(lair.map(one => one.id)).toEqual([DISPATCHER, `report:${job.id}`])
    expect(lair[0].text).toContain(`${DISPATCH_PHRASES.en} ${DISPATCH_JOB_ONLY} ${TASK}`)
    expect(lair[1].text).toBe(REPORT)
    await until("typing shows in the dispatcher's chat", async () =>
      it.edge.typings().some(one => one.chat === LAIR_CHAT), 10_000)
  } finally {
    await hub?.stop(); await spoke?.stop(); await door?.stop(); await store.close(); await it.stop()
  }
}, 120_000)

test("D-214 D-182 a job-only agent's empty tail is declared, and an agent whose chat is on another machine is served", async () => {
  const it = await rolloutStage(cluster, "telegram", { dispatch: true, adapter: { answer: () => REPORT } })
  let door: Awaited<ReturnType<typeof runDoor>> | undefined
  let spoke: Awaited<ReturnType<typeof runRunner>> | undefined
  try {
    // A file where a chat log would be, if this agent had a chat. No door
    // writes it, because the agent has no door, so whatever is in it is not
    // this agent's conversation and the entry's declaration is what decides.
    plantChatLine({ stateDir: it.stateDir, person: "p1", agent: DISPATCH_JOB_ONLY, text: "a line nobody said to this agent" })
    door = await runDoor({ door: "door-fake", registryFile: it.registryFile, platform: it.edge.platform })
    const job = await dispatched(it, "200")
    spoke = await runRunner({ runner: DISPATCH_RUNNER2, registryFile: it.registryFile,
      adapters: { [it.adapterName]: it.scripted.adapter } })
    await until("the job reports", async () =>
      (await it.read.inbound()).some(r => r.id === `report:${job.id}`), 30_000)
    expect(it.scripted.fed().map(one => ({ id: one.id, text: one.text }))).toEqual([{ id: job.id, text: TASK }])
    await spoke.stop(); spoke = undefined

    // The control, in the same run: an agent that HAS a chat, moved onto a
    // runner on a machine where its door is not, is SERVED, because there its
    // chat is read from the store rather than from a log that machine does not
    // hold. It is started for its work and refused nowhere, which is what tells
    // it apart from the job-only agent above, whose tail is declared empty and
    // is read from nowhere at all. The job-only agent steps off that runner
    // first, so every start the runner makes is the moved agent's.
    const before = it.scripted.starts().length
    editAgent(it.registryFile, DISPATCH_JOB_ONLY, { runner: "runner-pi" })
    editAgent(it.registryFile, DISPATCH_TARGET, { runner: DISPATCH_RUNNER2 })
    spoke = await runRunner({ runner: DISPATCH_RUNNER2, registryFile: it.registryFile,
      adapters: { [it.adapterName]: it.scripted.adapter } })
    await insertInbound(cluster, it.db, { id: "moved-target-work", person: "p1", agent: DISPATCH_TARGET, body: "work for the moved agent" })
    await until("the moved agent is served its work", async () =>
      it.scripted.fed().some(one => one.id === "moved-target-work"), 20_000)
    expect(it.scripted.starts().length).toBeGreaterThan(before)
    expect(JSON.stringify(await it.read.sheet("agent_health"))).not.toContain("agent-state-unavailable")
  } finally { await spoke?.stop(); await door?.stop(); await it.stop() }
}, 120_000)

test("D-214 a runner whose listening connection is cut from the server's side hears the next job anyway, and reports it once", async () => {
  const it = await rolloutStage(cluster, "telegram", { dispatch: true, adapter: { answer: () => REPORT } })
  let door: Awaited<ReturnType<typeof runDoor>> | undefined
  let spoke: Awaited<ReturnType<typeof runRunner>> | undefined
  try {
    door = await runDoor({ door: "door-fake", registryFile: it.registryFile, platform: it.edge.platform })
    spoke = await runRunner({ runner: DISPATCH_RUNNER2, registryFile: it.registryFile,
      adapters: { [it.adapterName]: it.scripted.adapter } })
    const work = async () => (await runnerListeners(it)).filter(one => one.query === "listen hub_work")
    await until("the spoke is listening", async () => (await work()).length === 1, 10_000, () => runnerBackends(it))
    const [cut] = await work()
    await it.read.sql("select pg_terminate_backend($1)", [cut.pid])
    await until("the waiter opened its LISTEN again", async () => {
      const now = await work()
      return now.length === 1 && now[0].pid !== cut.pid
    }, 20_000, () => runnerBackends(it))

    const job = await dispatched(it, "300")
    await until("the job reports", async () =>
      (await it.read.inbound()).some(r => r.id === `report:${job.id}`), 30_000)
    expect((await it.read.inbound()).filter(r => r.kind === "report")).toHaveLength(1)
    expect((await it.read.ledger({ subject: job.id, kind: "answered" }))).toHaveLength(1)
    expect((await it.read.ledger({ subject: job.id, kind: "dispatch.reported" }))).toHaveLength(1)
    expect((await runnerListeners(it)).map(one => one.query).sort()).toEqual(["listen hub_control", "listen hub_work"])
  } finally { await spoke?.stop(); await door?.stop(); await it.stop() }
}, 120_000)

test("D-214 a spoke killed between the turn's end and the settle, started again, reports exactly once", async () => {
  // The kill lands INSIDE the settle and after the report row was written in
  // it: the lock is on the diary, and the first diary write of a job's settle
  // is the report's own arrival stamp inside `hub_report`, which runs after the
  // report row's insert. A settle split in two would leave that row behind.
  const it = await rolloutStage(cluster, "telegram", { dispatch: true, servers: true, adapter: { answer: () => REPORT } })
  let door: Awaited<ReturnType<typeof runDoor>> | undefined
  let spoke: ReadyProcess | null = null
  let lock: { pid: number; release(): Promise<void> } | null = null
  try {
    door = await runDoor({ door: "door-fake", registryFile: it.registryFile, platform: it.edge.platform })
    it.scripted.holdTurnEnd(true)
    spoke = await startReadySubprocess("test/helpers/runner-subprocess.ts",
      [it.registryFile, DISPATCH_RUNNER2, it.adapterUrl, it.adapterName])
    const job = await dispatched(it, "400")
    await until("the job was fed", () => it.scripted.fed().some(one => one.id === job.id), 30_000)
    await until("and started", async () =>
      (await it.read.ledger({ subject: job.id, kind: "started" })).length > 0, 30_000)

    lock = await lockTable(cluster, it.db, "ledger_event", "exclusive")
    it.scripted.endTurn()
    const blocked = await waitForLockWaiter(cluster, it.db, { role: "hub_runner", relation: "ledger_event", timeoutMs: 30_000 })
    const [inside] = await it.read.sql("select query from pg_stat_activity where pid = $1", [blocked])
    expect(String(inside.query)).toContain("hub_report")
    spoke.proc.kill(9)
    await spoke.proc.exited
    spoke = null
    await lock.release(); lock = null
    await waitForBackendsGone(cluster, it.db, [blocked], 30_000)

    // The settle left nothing, and the claim still standing is what tells the
    // restart this row is its own to redo.
    expect((await it.read.inbound()).filter(r => r.kind === "report")).toEqual([])
    expect(await it.read.ledger({ subject: job.id, kind: "answered" })).toEqual([])
    expect(await it.read.ledger({ subject: job.id, kind: "dispatch.reported" })).toEqual([])
    expect((await it.read.inbound()).find(r => r.id === job.id)!.claimed_by).toBe(DISPATCH_RUNNER2)

    it.scripted.holdTurnEnd(false)
    spoke = await startReadySubprocess("test/helpers/runner-subprocess.ts",
      [it.registryFile, DISPATCH_RUNNER2, it.adapterUrl, it.adapterName])
    await until("the redo reports", async () =>
      (await it.read.ledger({ subject: job.id, kind: "dispatch.reported" })).length > 0, 60_000)
    // Read again after the runner has had every chance to write a second one.
    await until("the claim is released", async () =>
      (await it.read.inbound()).find(r => r.id === job.id)!.claimed_by === null, 30_000)
    expect((await it.read.inbound()).filter(r => r.kind === "report").map(r => r.id)).toEqual([`report:${job.id}`])
    expect(await it.read.ledger({ subject: job.id, kind: "answered" })).toHaveLength(1)
    expect(await it.read.ledger({ subject: job.id, kind: "dispatch.reported" })).toHaveLength(1)
  } finally {
    await lock?.release(); await spoke?.stop(); await door?.stop(); await it.stop()
  }
}, 180_000)

test("D-214 a child that dies while working a job tells the dispatcher's chat, in the shipped sentence", async () => {
  const it = await rolloutStage(cluster, "telegram", { dispatch: true })
  const edge = controlledAdapter(it.adapterName)
  let door: Awaited<ReturnType<typeof runDoor>> | undefined
  let spoke: Awaited<ReturnType<typeof runRunner>> | undefined
  try {
    edge.hold(fed => fed.text === TASK)
    door = await runDoor({ door: "door-fake", registryFile: it.registryFile, platform: it.edge.platform })
    const job = await dispatched(it, "500")
    spoke = await runRunner({ runner: DISPATCH_RUNNER2, registryFile: it.registryFile, adapters: { [it.adapterName]: edge.adapter } })
    await until("the job is being worked", () => edge.sessions.some(one => one.fed.some(fed => fed.id === job.id)), 30_000)
    edge.sessions.find(one => one.fed.some(fed => fed.id === job.id))!.fail()

    await until("the notice is written", async () =>
      (await it.read.noticeRows()).some(row => row.notice_key === `agent-retry:${job.id}`), 30_000)
    const health = (await it.read.sheet("agent_health")).find(row => row.id === DISPATCH_JOB_ONLY)!
    expect(health.data.status).toBe("retry")
    const notices = (await it.read.noticeRows()).filter(row => String(row.notice_key).startsWith("agent-retry"))
    expect(notices).toHaveLength(1)
    expect(notices[0].body).toBe(agentRetry("en", { agent: DISPATCH_JOB_ONLY, cause: "child exited", seconds: 1 }))
    const [routed] = await it.read.sql("select route from outbox where notice_key = $1", [`agent-retry:${job.id}`])
    expect(routed.route).toEqual({ door: "door-fake", chat: LAIR_CHAT })
  } finally { await spoke?.stop(); await edge.stop(); await door?.stop(); await it.stop() }
}, 120_000)
