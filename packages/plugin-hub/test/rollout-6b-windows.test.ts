// The six protected windows, held against everything dispatch, the shared zone,
// phone provisioning and the off-box copy add. (SPEC §1, §2, L4, L6)
//
// TWO THINGS ARE MEASURED HERE AND NEITHER COPIES A WINDOW'S ASSERTIONS.
//
// The six shipped files are run BYTE-UNCHANGED, in a child `bun test`, with a
// preload that lays every new registry shape over the file each of them writes
// for itself: a `[zone]` table, an hourly `backup` entry with its three
// commands, a job-only agent on the very runner the window measures, and
// `guild` plus `default_preset` on every door. Their own assertions and their
// own bounds then say whether the phase stayed outside them.
//
// Then each window is RE-OPENED in the one state the phase adds to it, which no
// shipped file can reach because a shipped file cannot dispatch: a door holding
// an open job, a door whose job has been reported and answered, a door started
// with an open job on the table, a door restarted with three report rows an
// hour old and not yet projected, a runner draining a job and a report beside
// two messages, a door and a runner with a job waiting on a stopped spoke, and
// `check` against every new shape at once. Every bound is the shipped one, read
// out of the shipped file and named beside it, and never relaxed.
//
// WHICH OF THESE WERE ALREADY TRUE BEFORE THE PHASE AND WHICH ARE NEW, said
// before the first assertion so nobody reads a green window as evidence of work
// that did not happen:
//
// - The digests and the child run are TRIVIALLY GREEN against a build with none
//   of the phase in it: the six files are unchanged by construction, and they
//   passed on their own registries before any of this existed. What is new in
//   the child run is only the registry each window loads.
// - Every re-opened window is written after the build it measures landed, so
//   none was seen red for a missing behaviour. What each one does prove, and a
//   build without the phase could not, is that its state exists at all: a job
//   still open and unclaimed, three reports an hour old and unprojected at the
//   door's start, four new finding producers firing in one `check`. Each window
//   asserts its state before it counts, so a window that counted nothing
//   because its state was never reached fails.
// - The restarted door is the one window here that is NOT trivially green
//   against the phase's own history: a report inherits its job's arrival, and a
//   door that measured a report's clocks from that arrival would say an
//   hour-old deadline had run out the moment it started. It says so BEFORE the
//   budget window opens, so the statement count alone stays inside its
//   allowance, and what goes red is the assertion on the clock diary beside it.
//   It holds because a report's clocks run from the moment it landed, which is
//   also why the budget is cheap: three reports read at the start arm three
//   timers in memory and no query.
//
// THE COUNTER IS PROVED in every statement window by a deliberate statement
// from a backend the window does not ignore, which is the control each shipped
// window carries. The processor window carries a process that really spins.
//
// Which of the six protected windows this could reach: all six, by
// construction, and it edits none of them.

import { afterAll, beforeAll, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  backendPid, hubPath, startCluster, startReadySubprocess, statementWatch, until, untilIssued, type Cluster, type ReadyProcess,
} from "./helpers/cluster.ts"
import { cpuSeconds } from "./helpers/cpu.ts"
import { superStore } from "./helpers/hub-fixture.ts"
import { message } from "./helpers/rollout-ingress.ts"
import {
  DISPATCHER, DISPATCH_JOB_ONLY, DISPATCH_RUNNER2, DISPATCH_TARGET, DISPATCH_TARGET_RU, SIXB_BACKUP, rolloutStage,
} from "./helpers/rollout-stage.ts"
import { scriptedReply } from "./helpers/scripted-adapter.ts"
import { DISPATCH_PHRASES, dispatchAccepted } from "../src/door/lines.ts"
import { loadRegistry } from "../src/registry/load.ts"
import { listAgents, listRunEntries, zoneFor } from "../src/registry/entries.ts"
import { runCheck } from "../src/check/run.ts"
import { BACKUP_SHEET } from "../src/backup/run.ts"
import { putRow } from "../src/records/statesheet.ts"
import { runDoor } from "../src/door/run.ts"
import { runRunner } from "../src/runner/run.ts"

let cluster: Cluster
beforeAll(async () => {
  cluster = await startCluster({
    settings: { log_statement: "'all'", log_line_prefix: "'pid=%p '", log_min_duration_statement: "-1" },
  })
})
afterAll(async () => { await cluster?.stop() })

/** The six, by their shipped names, with the digest the transcriber's inventory pins for each. */
const WINDOWS: Record<string, string> = {
  "test/door-typing.test.ts": "26bf5dfd5068c8ab1a5c3287fd3b9c7f53d021d1c60d678852c7f409c683a1e9",
  "test/door-outbox.test.ts": "019b343c1affd068ef5b37adda3bdb065081bda083a8262b51d10a4d3afc5be9",
  "test/door-clock.test.ts": "bacd4b48bac4b2755876a78c82aa7631f1704b3d1a945e783ef792fc303b605a",
  "test/runner-drain.test.ts": "e8a8a14e7a1025a12624915a0e1b8a90691d1af9c96a1c1e45ad8536841c93f8",
  "test/wait-idle.test.ts": "30905f0bc010ee9f10e275d4d5e0c51eded16951700583888ac4acb52897fc39",
  "test/check-silence.test.ts": "5d2007df83b96ccc61b472507537b9e7b90fa688d65e2ea34260d5af51a22c67",
}

/** door-typing's window: three of the platform's own typing lifetimes, read off the platform. */
const TYPING_LIFETIMES = 3
/** door-outbox's and runner-drain's allowance to settle, and their window. */
const SETTLE_MS = 700
const IDLE_WINDOW_MS = 3_000
/** door-clock's restart: two seconds after the door is up, then at most two statements. */
const RESTART_SETTLE_MS = 2_000
const RESTART_ALLOWED = 2
/** wait-idle's window and bound. */
const CPU_WINDOW_MS = 3_000
const CPU_BOUND_SECONDS = 0.3
/** How long a stop may take with a wait armed far away, the transcriber's windows' own bound. */
const STOP_BOUND_MS = 2_000

const LAIR_CHAT = "1000000001"
const P2_CHAT = "0000000000"
const TASK_A = "weigh the first synthetic ledger"
const TASK_B = "weigh the second synthetic ledger"
const TASK_C = "weigh the third synthetic ledger"
const TASK_RU = "weigh the fourth synthetic ledger"
const REPORT: Record<string, string> = {
  [TASK_A]: "the first ledger weighs four",
  [TASK_B]: "the second ledger weighs nine",
  [TASK_C]: "the third ledger weighs one",
  [TASK_RU]: "the fourth ledger weighs two",
}

type Stage = Awaited<ReturnType<typeof rolloutStage>>
type Handle = { stop(): Promise<void> }

function answers(fed: { text: string }): string {
  return REPORT[fed.text] ?? scriptedReply(fed.text)
}

/** Every shape at once, on the Discord-shaped platform with an administration seam. */
function sixb(over: Parameters<typeof rolloutStage>[2] = {}): Promise<Stage> {
  return rolloutStage(cluster, "discord", { sixb: true, admin: {}, adapter: { answer: answers }, ...over })
}

function typed(id: string, text: string, chat = LAIR_CHAT, sender = "p1") {
  return { ...message(id, text), chat, sender_id: sender, from: sender }
}

async function cursorAt(it: Stage, chat: string, cursor: string): Promise<boolean> {
  return (await it.read.sheet("door_cursor")).some(row => row.id === `door-fake/${chat}` && row.data.cursor === cursor)
}

/**
 * A job typed as a command in a chat the door reads, waited for until every
 * write of the command's own batch has landed: the job row, the diary line that
 * says who authorized it, the acceptance line posted back, and last the cursor.
 */
async function dispatched(it: Stage, id: string, target: string, task: string, chat = LAIR_CHAT, sender = "p1") {
  const phrase = sender === "p2" ? DISPATCH_PHRASES.ru : DISPATCH_PHRASES.en
  const next = String(Number(id) + 1)
  it.edge.batch([typed(id, `${phrase} ${target} ${task}`, chat, sender)], next)
  let job: Awaited<ReturnType<Stage["read"]["inbound"]>>[number] | undefined
  await until(`the command dispatching ${task} landed whole`, async () => {
    job = (await it.read.inbound()).find(row => row.kind === "job" && row.body === task)
    if (!job) return false
    const said = (await it.read.ledger({ stream: "control", kind: "dispatch.requested" }))
      .some(row => row.subject === job!.id)
    const posted = it.edge.posts().some(post => post.chat === chat && post.text.includes(target))
    return said && posted && await cursorAt(it, chat, next)
  }, 30_000, async () => JSON.stringify(await it.read.inbound()))
  return job!
}

/**
 * Open the window only once the setup has stopped talking: no statement from a
 * backend the window counts across one settle allowance. It waits on that
 * condition, never on a guess, and a poll shorter than the allowance can never
 * satisfy it, so it fails by name instead of opening a window over a timer.
 */
async function untilQuiet(ignore: number[], what: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const watch = await statementWatch(cluster, ignore)
    await Bun.sleep(SETTLE_MS)
    if ((await watch.count()) === 0) return
    if (Date.now() >= deadline) {
      throw new Error(`${what} never went quiet for ${SETTLE_MS} ms within ${timeoutMs} ms:\n` +
        (await watch.lines()).slice(0, 8).join("\n"))
    }
  }
}

/** The window itself: a count from the server's own log, and the statements when it is over. */
async function windowOf(ms: number, ignore: number[], what: string, allowed = 0): Promise<void> {
  const watch = await statementWatch(cluster, ignore)
  await Bun.sleep(ms)
  const issued = await watch.count()
  if (issued > allowed) {
    throw new Error(`${what} issued ${issued} statements in ${ms} ms, which is a timer, not a wait. Statements:\n` +
      (await watch.lines()).slice(0, 8).join("\n"))
  }
}

/**
 * The counter, proved. A statement from a backend the window is NOT ignoring
 * must come out as one, so a window that counted nothing because its reader was
 * unwired fails instead of passing.
 */
async function proveCounter(db: string, ignore: number[]): Promise<void> {
  const watch = await statementWatch(cluster, ignore)
  const conn = cluster.connect(db) as unknown as { unsafe(q: string): Promise<unknown>; close(): Promise<void> }
  try {
    expect(ignore).not.toContain(await backendPid(conn as never))
    await conn.unsafe("select 1 as deliberate_statement")
    await until("the deliberate statement was counted", async () => (await watch.count()) >= 1, 10_000)
  } finally { await conn.close() }
}

function digest(relative: string): string {
  return createHash("sha256").update(readFileSync(hubPath(relative))).digest("hex")
}

// ---------------------------------------------------------------------------
// The six shipped files, unchanged.
// ---------------------------------------------------------------------------

test("ROLL-19 ROLL-27 ROLL-28 ROLL-32 the six protected windows are byte-unchanged, and their digests are the ones the transcriber's inventory pins (SPEC §6, L4)", () => {
  const pinned = readFileSync(hubPath("test/voice-acceptance.test.ts"), "utf8")
  for (const [file, hash] of Object.entries(WINDOWS)) {
    expect(digest(file), `${file} is a protected window and was edited`).toBe(hash)
    // The two inventories agree, so neither can drift from the other.
    expect(pinned.includes(`"${file}": "${hash}"`), `${file} carries the same digest in both inventories`).toBe(true)
  }
})

test("ROLL-19 ROLL-27 ROLL-28 ROLL-32 the six protected windows run unchanged and green against registries carrying the zone, the copy, a job-only agent and the door fields (SPEC §1, §2, L4)", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "hub-sixb-windows-"))
  const record = join(scratch, "registries.jsonl")
  try {
    const files = Object.keys(WINDOWS)
    // Every one of the six declares its tests with a plain `test(`, none behind
    // a gate or an alias, so this count is the number the child must report as
    // passed. A window that later gains a gated test changes this count first.
    const tests = files.reduce((sum, file) =>
      sum + [...readFileSync(hubPath(file), "utf8").matchAll(/(?<![\w.])test\(/g)].length, 0)
    const child = Bun.spawn([process.execPath, "test", "--timeout", "90000",
      "--preload", "./test/helpers/sixb-preload.ts", ...files], {
      cwd: hubPath("."),
      env: { ...process.env, BUN_FEATURE_FLAG_DISABLE_SQL_AUTO_PIPELINING: "1", HUB_SIXB_RECORD: record },
      stdout: "pipe", stderr: "pipe",
    })
    const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
    const code = await child.exited
    const said = out + err
    const count = (word: string) => Number(new RegExp(`\\n\\s*(\\d+) ${word}\\n`).exec(said)?.[1] ?? 0)
    if (code !== 0) throw new Error(`the six windows went red against the new shapes:\n${said.slice(-6000)}`)
    expect(count("pass"), "every test of the six ran and passed").toBe(tests)
    expect(count("fail")).toBe(0)
    expect(count("skip"), "no window skipped").toBe(0)
    expect(said).toContain(`Ran ${tests} tests across ${files.length} files.`)

    // Every registry a window loaded really carried the four shapes, and each
    // one is a file the hub accepts on its own.
    const rendered = readFileSync(record, "utf8").trim().split("\n").map(line => JSON.parse(line) as { text: string })
    expect(rendered.length).toBeGreaterThanOrEqual(tests)
    rendered.forEach((one, nth) => {
      const file = join(scratch, `registry-${nth}.toml`)
      writeFileSync(file, one.text)
      const registry = loadRegistry(file)
      expect(zoneFor(registry), "a [zone] table").not.toBeNull()
      const copy = listRunEntries(registry).find(entry => entry.kind === "backup") as Record<string, unknown> | undefined
      expect(copy, "a backup entry").toBeDefined()
      for (const key of ["dump_argv", "upload_argv", "readback_argv", "destination"]) expect(copy![key]).toBeDefined()
      expect(listAgents(registry).some(agent => agent.door === undefined && agent.chat === undefined), "a job-only agent").toBe(true)
      for (const door of listRunEntries(registry).filter(entry => entry.kind === "door") as unknown as Record<string, unknown>[]) {
        expect(door.guild, "a guild on every door").toBeDefined()
        expect(door.default_preset, "a default preset on every door").toBeDefined()
      }
    })
  } finally { rmSync(scratch, { recursive: true, force: true }) }
}, 600_000)

// ---------------------------------------------------------------------------
// door-typing, re-opened: a job is not a turn, so it shows nothing and asks nothing.
// ---------------------------------------------------------------------------

test("ROLL-19 a door holding an open job issues nothing across a typing interval, shows no typing, and lists no channel (SPEC §1, §2, L6)", async () => {
  const it = await sixb()
  let door: Handle | undefined
  try {
    const readerPid = await it.read.pid()
    const settle = await statementWatch(cluster, [readerPid])
    door = await runDoor({ door: "door-fake", registryFile: it.registryFile, platform: it.edge.platform })
    await untilIssued(settle, "the door's post task read its pending replies once", /from outbox o\b/, { after: /listen hub_outbox/ })
    // The target's runner is on the other machine and is never started, so the
    // job stays open for the whole window.
    const job = await dispatched(it, "100", DISPATCH_JOB_ONLY, TASK_A)
    await Bun.sleep(SETTLE_MS)

    const seconds = it.edge.platform.typingSeconds
    expect(seconds).toBeGreaterThan(0)
    await windowOf(seconds * TYPING_LIFETIMES * 1000, [readerPid], "a door holding an open job")

    // The state the window was measured in, asserted after it, so a window that
    // counted nothing because the job had gone is not a pass.
    const open = (await it.read.inbound()).find(row => row.id === job.id)!
    expect(open.state).toBe("received")
    expect(open.claimed_by).toBeNull()
    // A job arms no clock and opens no turn in the dispatcher's chat, and the
    // Discord channel listing belongs to an adopt command alone.
    expect(it.edge.typings().filter(one => one.chat === LAIR_CHAT)).toEqual([])
    expect(await it.read.ledger({ stream: "clock" })).toEqual([])
    expect(it.edge.adminCalls()).toEqual([])
    await proveCounter(it.db, [readerPid])
  } finally { await door?.stop(); await it.stop() }
}, 120_000)

test("ROLL-19 a door whose job was reported and answered issues nothing across a typing interval (SPEC §1, §2, L6)", async () => {
  const it = await sixb()
  let door: Handle | undefined
  let spoke: Handle | undefined
  let hub: Handle | undefined
  try {
    const readerPid = await it.read.pid()
    door = await runDoor({ door: "door-fake", registryFile: it.registryFile, platform: it.edge.platform })
    spoke = await runRunner({ runner: DISPATCH_RUNNER2, registryFile: it.registryFile,
      adapters: { [it.adapterName]: it.scripted.adapter } })
    hub = await runRunner({ runner: "runner-pi", registryFile: it.registryFile,
      adapters: { [it.adapterName]: it.scripted.adapter } })
    const job = await dispatched(it, "100", DISPATCH_JOB_ONLY, TASK_A)
    await until("the report was fed to the dispatcher and its answer delivered", async () =>
      (await it.read.ledger({ subject: `report:${job.id}`, kind: "delivered" })).length === 1, 60_000,
      async () => JSON.stringify((await it.read.inbound()).map(row => [row.id, row.state, row.log_ready])))
    expect(it.edge.posts().filter(post => post.chat === LAIR_CHAT).map(post => post.text))
      .toContain(scriptedReply(REPORT[TASK_A]))
    await spoke.stop(); spoke = undefined
    await hub.stop(); hub = undefined
    await untilQuiet([readerPid], "the door after the report's answer was delivered")

    await windowOf(it.edge.platform.typingSeconds * TYPING_LIFETIMES * 1000, [readerPid], "a door whose job was reported and answered")
    expect((await it.read.ledger({ subject: job.id, kind: "answered" })).length).toBe(1)
    expect(await it.read.ledger({ stream: "clock" })).toEqual([])
    await proveCounter(it.db, [readerPid])
  } finally { await hub?.stop(); await spoke?.stop(); await door?.stop(); await it.stop() }
}, 150_000)

// ---------------------------------------------------------------------------
// door-outbox, re-opened: the report is a row and never a chunk, and a job arms no timer.
// ---------------------------------------------------------------------------

test("ROLL-19 a door started with an open job on the table issues nothing across its idle interval (SPEC §1 Forbidden)", async () => {
  const it = await sixb()
  let door: Handle | undefined
  try {
    door = await runDoor({ door: "door-fake", registryFile: it.registryFile, platform: it.edge.platform })
    const job = await dispatched(it, "100", DISPATCH_JOB_ONLY, TASK_A)
    await door.stop(); door = undefined

    const readerPid = await it.read.pid()
    const settle = await statementWatch(cluster, [readerPid])
    door = await runDoor({ door: "door-fake", registryFile: it.registryFile, platform: it.edge.platform })
    await untilIssued(settle, "the door's post task read its pending replies once", /from outbox o\b/, { after: /listen hub_outbox/ })
    await Bun.sleep(SETTLE_MS)
    await windowOf(IDLE_WINDOW_MS, [readerPid], "a door started with an open job")

    const open = (await it.read.inbound()).find(row => row.id === job.id)!
    expect(open.state).toBe("received")
    // Nothing of the job reached the outbox: a job is work on another agent's
    // queue, and the only thing posted about it was the acceptance line.
    expect((await it.read.outbox()).filter(row => row.inbound_id === job.id)).toEqual([])
    expect(it.edge.posts().filter(post => post.chat === LAIR_CHAT).map(post => post.text))
      .toEqual([dispatchAccepted("en", { agent: DISPATCH_JOB_ONLY })])
    await proveCounter(it.db, [readerPid])
  } finally { await door?.stop(); await it.stop() }
}, 120_000)

// ---------------------------------------------------------------------------
// door-clock, re-opened: three reports an hour old, waiting to be projected.
// ---------------------------------------------------------------------------

test("ROLL-19 a restarted door projects three hour-old reports before it is ready, and its budget still holds two seconds after (SPEC §2, L6, L11)", async () => {
  const it = await sixb()
  let door: Handle | undefined
  let spoke: Handle | undefined
  try {
    door = await runDoor({ door: "door-fake", registryFile: it.registryFile, platform: it.edge.platform })
    const jobs = [
      await dispatched(it, "100", DISPATCH_JOB_ONLY, TASK_A),
      await dispatched(it, "110", DISPATCH_JOB_ONLY, TASK_B),
      await dispatched(it, "120", DISPATCH_JOB_ONLY, TASK_C),
    ]
    // An hour of work for each, planted rather than waited for. A report
    // inherits this stamp, which is the state that could give a restarted door
    // clock work inside its budget.
    for (const job of jobs) {
      await it.read.sql("update inbound set received_at = now() - interval '1 hour' where id = $1", [job.id])
    }
    await door.stop(); door = undefined

    spoke = await runRunner({ runner: DISPATCH_RUNNER2, registryFile: it.registryFile,
      adapters: { [it.adapterName]: it.scripted.adapter } })
    await until("three reports landed with no door to project them", async () =>
      (await it.read.inbound()).filter(row => row.kind === "report").length === 3, 60_000)
    await spoke.stop(); spoke = undefined

    const reports = (await it.read.sql(
      "select id, received_at, reported_at, log_ready, state from inbound where kind = 'report' order by id")) as
      unknown as { id: string; received_at: Date; reported_at: Date; log_ready: boolean; state: string }[]
    expect(reports.map(row => row.id).sort()).toEqual(jobs.map(job => `report:${job.id}`).sort())
    for (const row of reports) {
      expect(row.log_ready).toBe(false)
      expect(row.state).toBe("received")
      expect(Date.now() - new Date(row.received_at).getTime()).toBeGreaterThan(3_000_000)
      expect(Date.now() - new Date(row.reported_at).getTime()).toBeLessThan(600_000)
    }

    const readerPid = await it.read.pid()
    door = await runDoor({ door: "door-fake", registryFile: it.registryFile, platform: it.edge.platform })
    // PROJECTED BEFORE THE DOOR IS HANDED BACK: the startup sweep carries them.
    const ready = (await it.read.sql("select log_ready from inbound where kind = 'report'")) as unknown as { log_ready: boolean }[]
    expect(ready.map(row => row.log_ready)).toEqual([true, true, true])

    await Bun.sleep(RESTART_SETTLE_MS)
    await windowOf(IDLE_WINDOW_MS, [readerPid], "a restarted door with three hour-old reports", RESTART_ALLOWED)

    // Nothing about a clock, in the chat, the diary or the log: each report's
    // clocks run from the moment it landed, which is seconds ago.
    expect(await it.read.ledger({ stream: "clock" })).toEqual([])
    expect(it.edge.posts().filter(post => post.chat === LAIR_CHAT && post.text.includes("still waiting"))).toEqual([])
    await proveCounter(it.db, [readerPid])
  } finally { await spoke?.stop(); await door?.stop(); await it.stop() }
}, 150_000)

// ---------------------------------------------------------------------------
// runner-drain, re-opened: a job and a report are ordinary rows on the shipped path.
// ---------------------------------------------------------------------------

type Conn = { unsafe(query: string, values?: unknown[]): Promise<unknown>; close(): Promise<void> }

test("ROLL-19 a runner drains a job, a report and two messages with no new arrival but the report its own settle wrote, and then issues nothing while it waits (SPEC §1)", async () => {
  // The long tick is the shipped window's: the window sits inside ONE wait.
  const it = await sixb({ hub: { tick_seconds: 30 } })
  let door: Handle | undefined
  let spoke: Handle | undefined
  let hub: Handle | undefined
  const owner = cluster.connect(it.db) as unknown as Conn
  const asDoor = cluster.connectAs("hub_door", it.db) as unknown as Conn
  try {
    const ownerPid = await backendPid(owner as never)
    const doorPid = await backendPid(asDoor as never)
    const readerPid = await it.read.pid()

    door = await runDoor({ door: "door-fake", registryFile: it.registryFile, platform: it.edge.platform })
    // A job for the second person's target, which this door serves and projects.
    const job = await dispatched(it, "100", DISPATCH_TARGET_RU, TASK_RU, P2_CHAT, "p2")
    await until("the job is projected and claimable", async () =>
      (await it.read.inbound()).find(row => row.id === job.id)!.log_ready, 20_000)
    // A report for the dispatcher, settled by the spoke and projected by the door.
    const reported = await dispatched(it, "110", DISPATCH_JOB_ONLY, TASK_A)
    spoke = await runRunner({ runner: DISPATCH_RUNNER2, registryFile: it.registryFile,
      adapters: { [it.adapterName]: it.scripted.adapter } })
    await until("the report is projected and claimable", async () =>
      (await it.read.inbound()).some(row => row.id === `report:${reported.id}` && row.log_ready), 60_000)
    await spoke.stop(); spoke = undefined
    // Two ordinary messages.
    const bodies = ["the first thing that waited", "the second thing that waited"]
    it.edge.batch([typed("120", bodies[0]), typed("121", bodies[1])], "122")
    await until("both messages are projected and the cursor has moved", async () =>
      (await it.read.inbound()).filter(row => row.kind === "human" && bodies.includes(row.body) && row.log_ready).length === 2 &&
      await cursorAt(it, LAIR_CHAT, "122"), 20_000)
    await door.stop(); door = undefined

    const [{ seq: seqAtStart }] = (await it.read.sql("select coalesce(max(seq), 0) as seq from ledger_event")) as { seq: string }[]
    hub = await runRunner({ runner: "runner-pi", registryFile: it.registryFile,
      adapters: { [it.adapterName]: it.scripted.adapter } })
    const humans = (await it.read.inbound()).filter(row => row.kind === "human" && bodies.includes(row.body)).map(row => row.id)
    await until("the job, the report and both messages were answered", async () => {
      const answered = new Set((await it.read.outbox()).map(row => String(row.inbound_id)))
      return humans.every(id => answered.has(id)) && answered.has(`report:${reported.id}`) &&
        (await it.read.ledger({ subject: job.id, kind: "answered" })).length === 1
    }, 60_000, async () => JSON.stringify((await it.read.inbound()).map(row => [row.id, row.state])))

    // No arrival after the runner came up but the one its own settle wrote: a
    // job reports through a row, and that row is the only new thing.
    const arrivals = (await it.read.ledger({ stream: "inbound", kind: "received" }))
      .filter(row => row.seq > Number(seqAtStart)).map(row => row.subject)
    expect(arrivals).toEqual([`report:${job.id}`])
    const fed = it.scripted.fed().map(one => one.text)
    for (const body of [TASK_RU, REPORT[TASK_A], ...bodies]) expect(fed).toContain(body)

    // --- The wait. Nothing announces the next row, and nothing may look for it.
    await untilQuiet([ownerPid, doorPid, readerPid], "the runner after its drain")
    await owner.unsafe("alter table inbound disable trigger inbound_notify_work")
    await Bun.sleep(SETTLE_MS)
    const watch = await statementWatch(cluster, [ownerPid, doorPid, readerPid])
    await asDoor.unsafe(`insert into inbound (id, person, agent, body) values ('w-silent', 'p1', '${DISPATCHER}', 'the row nothing announced')`)
    await asDoor.unsafe(`insert into ledger_event (stream, subject, kind, actor) values ('inbound', 'w-silent', 'received', 'door')`)
    await Bun.sleep(IDLE_WINDOW_MS)
    const issued = await watch.count()
    if (issued > 0) {
      throw new Error(`the runner issued ${issued} statements while waiting for work, which is a timer, not a wait. Statements:\n` +
        (await watch.lines()).slice(0, 8).join("\n"))
    }
    const waiting = (await it.read.inbound()).find(row => row.id === "w-silent")!
    expect(waiting.claimed_by).toBeNull()
    expect(waiting.state).toBe("received")

    // The control: the notification is what makes the runner act.
    await owner.unsafe("alter table inbound enable trigger inbound_notify_work")
    const committed = Date.now()
    await asDoor.unsafe(`insert into inbound (id, person, agent, body) values ('w-notified', 'p1', '${DISPATCHER}', 'the row the trigger announced')`)
    await until("the runner took up the row it had been ignoring", async () => {
      const row = (await it.read.inbound()).find(one => one.id === "w-silent")
      return !!row && (row.claimed_by !== null || row.state !== "received")
    }, 10_000)
    expect(Date.now() - committed).toBeLessThan(1000)
    await proveCounter(it.db, [ownerPid, doorPid, readerPid])
  } finally {
    await owner.unsafe("alter table inbound enable trigger inbound_notify_work").catch(() => {})
    await owner.close(); await asDoor.close()
    await hub?.stop(); await spoke?.stop(); await door?.stop(); await it.stop()
  }
}, 180_000)

// ---------------------------------------------------------------------------
// wait-idle, re-opened: a job waiting on a stopped spoke costs no processor time.
// ---------------------------------------------------------------------------

test("ROLL-19 a door and a runner with a job waiting on a stopped spoke are asleep, and the spoke's own wait stops inside the bound (SPEC §2, STORE-01)", async () => {
  // wait-idle's own arrangement: the door and the runner are processes of their
  // own, reading a platform and a loop served over the wire, so the processor
  // time read is theirs alone and not this harness's or the fake's.
  const it = await sixb({ servers: true })
  // Every message the served fake hands out carries its one fixture sender.
  writeFileSync(it.registryFile, readFileSync(it.registryFile, "utf8")
    .replace('allowed_senders = { door-fake = ["p1"] }', 'allowed_senders = { door-fake = ["p1", "fixture-sender"] }'))
  let door: ReadyProcess | null = null
  let hub: ReadyProcess | null = null
  let spoke: Handle | undefined
  const busy = Bun.spawn([process.execPath, "-e",
    "setInterval(() => { let s = 0; for (let i = 0; i < 6e7; i++) s += i; globalThis.__sink = s; }, 100); setInterval(() => {}, 1e9);"],
  { stdout: "ignore", stderr: "ignore", stdin: "ignore" })
  try {
    door = await startReadySubprocess("test/helpers/door-subprocess.ts", [it.registryFile, "door-fake", it.platformUrl])
    hub = await startReadySubprocess("test/helpers/runner-subprocess.ts", [it.registryFile, "runner-pi", it.adapterUrl, it.adapterName])
    // One message the whole way, so what is measured is a pair that finished
    // its work rather than a pair that never started.
    it.fake.deliver({ chat: LAIR_CHAT, text: "a message that goes the whole way" })
    await until("the reply was delivered", async () =>
      (await it.read.outbox()).length >= 1 && (await it.read.outbox()).every(row => row.delivered_at !== null), 60_000,
      async () => JSON.stringify(await it.read.inbound()))
    it.fake.deliver({ chat: LAIR_CHAT, text: `${DISPATCH_PHRASES.en} ${DISPATCH_JOB_ONLY} ${TASK_A}` })
    let job: Awaited<ReturnType<Stage["read"]["inbound"]>>[number] | undefined
    await until("the job is on the queue and the dispatcher was told", async () => {
      job = (await it.read.inbound()).find(row => row.kind === "job" && row.body === TASK_A)
      return job !== undefined && it.fake.posts().some(post => post.text === dispatchAccepted("en", { agent: DISPATCH_JOB_ONLY }))
    }, 30_000, async () => JSON.stringify(await it.read.inbound()))
    // wait-idle's own beat for the settling writes, which a processor bound
    // reads through: a handful of statements cost no measurable time.
    await Bun.sleep(1500)

    const before = { door: cpuSeconds(door.pid), hub: cpuSeconds(hub.pid), busy: cpuSeconds(busy.pid) }
    expect(before.door).not.toBeNull()
    expect(before.hub).not.toBeNull()
    expect(before.busy).not.toBeNull()
    await Bun.sleep(CPU_WINDOW_MS)
    const burned = {
      door: cpuSeconds(door.pid)! - before.door!,
      hub: cpuSeconds(hub.pid)! - before.hub!,
      busy: cpuSeconds(busy.pid)! - before.busy!,
    }
    process.stderr.write(`[6b-windows] over ${CPU_WINDOW_MS / 1000} s the door burned ${burned.door.toFixed(3)} s, ` +
      `the runner ${burned.hub.toFixed(3)} s and the spinning control ${burned.busy.toFixed(3)} s, against ${CPU_BOUND_SECONDS} s\n`)
    expect(burned.busy, "the probe sees a process that really polls").toBeGreaterThan(CPU_BOUND_SECONDS)
    expect(burned.door, "a door with a job waiting on a stopped spoke").toBeLessThan(CPU_BOUND_SECONDS)
    expect(burned.hub, "a runner beside a job waiting on a stopped spoke").toBeLessThan(CPU_BOUND_SECONDS)
    expect(cpuSeconds(door.pid)).not.toBeNull()
    expect(cpuSeconds(hub.pid)).not.toBeNull()
    expect((await it.read.inbound()).find(row => row.id === job!.id)!.claimed_by).toBeNull()

    // --- The spoke: it takes the job on the shipped waiter, and once it is
    //     waiting again with its next bound half a minute away, a stop returns
    //     in its own time rather than at the end of that wait.
    await hub.stop(); hub = null
    await door.stop(); door = null
    writeFileSync(it.registryFile, readFileSync(it.registryFile, "utf8").replace(/^tick_seconds = \d+$/m, "tick_seconds = 30"))
    const readerPid = await it.read.pid()
    spoke = await runRunner({ runner: DISPATCH_RUNNER2, registryFile: it.registryFile,
      adapters: { [it.adapterName]: it.scripted.adapter } })
    await until("the spoke took the job and reported it", async () =>
      (await it.read.inbound()).some(row => row.id === `report:${job!.id}`), 60_000)
    await untilQuiet([readerPid], "the spoke after its report")
    const began = Date.now()
    await spoke.stop(); spoke = undefined
    expect(Date.now() - began, "the stop did not wait out the spoke's bound").toBeLessThan(STOP_BOUND_MS)
  } finally {
    busy.kill(9); await busy.exited.catch(() => {})
    await spoke?.stop(); await hub?.stop(); await door?.stop(); await it.stop()
  }
}, 150_000)

// ---------------------------------------------------------------------------
// check-silence, re-opened: every new producer at once, and still only its own sheet.
// ---------------------------------------------------------------------------

test("ROLL-19 ROLL-27 ROLL-32 check against every new shape at once fires all four new producers, writes only its own sheet, and runs no copy command (SPEC §1, §2, L13)", async () => {
  // The copy's three commands are a recorder that writes down that it ran, so
  // "check opens no destination" is an observation and not a promise.
  let recorder = ""
  let log = ""
  let destination = ""
  const it = await sixb({
    registry: spec => {
      const dir = String(spec.hub?.state_dir)
      recorder = join(dir, "recorder.sh")
      log = join(dir, "recorder.log")
      destination = join(dir, "destination")
      return { ...spec, run: (spec.run ?? []).map(entry => entry.kind !== "backup" ? entry : {
        ...entry, destination,
        dump_argv: [recorder, "dump"],
        upload_argv: [recorder, "upload", "{staging}", "{destination}"],
        readback_argv: [recorder, "readback", "{destination}", "{path}", "{out}"],
      }) }
    },
  })
  writeFileSync(recorder, `#!/bin/sh\necho "$@" >> '${log}'\n`)
  chmodSync(recorder, 0o755)
  mkdirSync(destination, { recursive: true })
  let door: Handle | undefined
  const store = await superStore(cluster, it.db)
  try {
    // An open job for a target on this machine's runner, a day old.
    door = await runDoor({ door: "door-fake", registryFile: it.registryFile, platform: it.edge.platform })
    const job = await dispatched(it, "100", DISPATCH_TARGET, TASK_A)
    await door.stop(); door = undefined
    await it.read.sql("update inbound set received_at = now() - interval '1 day' where id = $1", [job.id])
    // A copy that did not land, written by the copy's own sheet writer in the
    // shape the copy records one.
    await putRow(store, BACKUP_SHEET, SIXB_BACKUP,
      { at: new Date().toISOString(), machine: "pi", status: "failed", code: "compare", cause: "copy does not match" })

    const snapshot = async () => ({
      ledger: await it.read.sql("select count(*)::int as n, coalesce(max(seq), 0)::bigint as seq from ledger_event"),
      inbound: JSON.stringify(await it.read.sql("select * from inbound order by id")),
      outbox: JSON.stringify(await it.read.sql("select * from outbox order by id")),
      sheets: JSON.stringify(await it.read.sql("select sheet, id, data, updated_at from state_row where sheet <> 'check' order by sheet, id")),
    })
    const before = await snapshot()
    const findings = await runCheck({ machine: "pi", registryFile: it.registryFile, store, os: null, kernel: null })
    const after = await snapshot()

    const by = (kind: string) => findings.filter(one => one.kind === kind)
    // The four producers, each firing: the dispatched job keyed on its row, the
    // copy's own stamp keyed on the entry, the copy's failure, and the zone.
    expect(by("job-stale").map(one => one.subject)).toContain(job.id)
    expect(by("job-no-stamp").map(one => one.subject)).toContain(SIXB_BACKUP)
    expect(by("backup-failed").map(one => one.subject)).toEqual([SIXB_BACKUP])
    expect(by("zone-missing").length).toBe(2)
    expect(by("zone-undeclared")).toEqual([])

    // And the silence: the diary, the queue, the outbox and every sheet but its
    // own are exactly as they were, and no copy command ran.
    expect(after).toEqual(before)
    expect(existsSync(log), "a copy command ran during check").toBe(false)
    expect(readdirSync(destination)).toEqual([])
    const sheet = (await it.read.sheet("check")).map(row => row.id)
    for (const one of [...by("job-stale"), ...by("backup-failed"), ...by("zone-missing")]) expect(sheet).toContain(one.id)

    // The control: the snapshot sees a diary line when one is written.
    await it.read.sql("insert into ledger_event (stream, subject, kind, actor) values ('control', 'probe', 'probe', 'hub')")
    expect((await snapshot()).ledger).not.toEqual(after.ledger)
  } finally { await store.close().catch(() => {}); await door?.stop(); await it.stop() }
}, 120_000)

test("ROLL-19 the statement counter these windows use is proved by a deliberate statement, and an empty window counts nothing", async () => {
  const it = await sixb()
  try {
    const readerPid = await it.read.pid()
    const quiet = await statementWatch(cluster, [readerPid])
    await Bun.sleep(500)
    expect(await quiet.count()).toBe(0)
    await proveCounter(it.db, [readerPid])
  } finally { await it.stop() }
}, 60_000)
