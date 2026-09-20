// The three door windows, re-opened in the one state a transcriber adds.
//
// This check does NOT copy the shipped windows' assertions. It takes their
// bounds and re-opens them with a voice-capable registry and a note that is
// waiting for its words, which is the state 7a adds and the state nothing else
// measures.
//
// WHICH OF THESE IS TRIVIALLY GREEN BEFORE THE STEP EXISTS, said out loud so
// nobody reads a green window as evidence: a door with no transcription task
// issues nothing extra, so the three statement bounds and the processor bound
// all pass against a build that has no step at all. What does NOT pass without
// it is the state each window is measured in: with no step a voice note is
// projected at the commit, so there is no pending row to hold a window open and
// no failed row either.
//
// WHAT THIS DELIBERATELY DOES NOT ASSERT. The typing rule is the shipped one: a
// turn is typable once the loop has ACCEPTED the message and a runner holds it,
// and a row nobody has claimed shows no typing at all. A note waiting for its
// words is such a row, so no typing is shown for it, and the sentence a person
// would otherwise read about the loop not having accepted their message is the
// one this check asserts absent.
import { afterAll, beforeAll, expect, test } from "bun:test"
import { readFileSync, writeFileSync } from "node:fs"
import { backendPid, startCluster, statementWatch, untilIssued, until, type Cluster } from "./helpers/cluster.ts"
import { cpuSeconds } from "./helpers/cpu.ts"
import { rolloutStage } from "./helpers/rollout-stage.ts"
import { observe } from "./helpers/rollout-runner.ts"
import { fakeRecognizer } from "./helpers/fake-recognizer.ts"
import { WAV_RATE, plantSamples, writeWav } from "./helpers/wav.ts"
import { clockLine } from "../src/door/lines.ts"
import { runDoor } from "../src/door/run.ts"

let cluster: Cluster
beforeAll(async () => {
  cluster = await startCluster({
    settings: { log_statement: "'all'", log_line_prefix: "'pid=%p '", log_min_duration_statement: "-1" },
  })
})
afterAll(async () => { await cluster?.stop() })

/** Window 1's own bound: a platform whose typing lasts five seconds, times three. */
const TYPING_WINDOW_MS = 15_000
/** Window 2's own bound. */
const IDLE_WINDOW_MS = 3_000
/** Window 3's own allowance, taken from the shipped restart budget. */
const RESTART_ALLOWED = 2
/** The processor bound, the shipped one. */
const CPU_BOUND_SECONDS = 0.3
/** How long a stop may take with a retry armed far in the future. */
const STOP_BOUND_MS = 2_000

function clip(seconds = 1): Uint8Array {
  const path = `${process.env.TMPDIR ?? "/tmp"}/windows-${crypto.randomUUID()}.wav`
  try {
    writeWav(path, plantSamples({ seconds, rate: WAV_RATE, quietAt: [] }), WAV_RATE)
    return new Uint8Array(readFileSync(path))
  } finally { Bun.spawnSync(["rm", "-f", path]) }
}

const AUDIO = clip()

function note(id: string) {
  return {
    platform_message_id: id, chat: "1000000001", sender_id: "p1", from: "p1",
    text: "", at: new Date().toISOString(),
    media: [{ kind: "voice" as const, remote_id: "voice", name: "note.wav",
      mime: "audio/wav", bytes: AUDIO.length, caption: null }],
  }
}

/** A port nothing listens on, so a note waits without a request in flight. */
async function deadPort(): Promise<number> {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") })
  const port = Number(server.port)
  await server.stop(true)
  return port
}

/**
 * The counter, proved. A statement from a backend the watch is NOT ignoring must
 * come out as one, so a window that counted nothing because its reader was
 * unwired fails instead of passing.
 */
async function proveCounter(db: string, ignore: number[]): Promise<void> {
  const watch = await statementWatch(cluster, ignore)
  const conn = cluster.connect(db) as unknown as { unsafe(q: string): Promise<unknown>; close(): Promise<void> }
  try {
    await conn.unsafe("select 1 as deliberate_statement")
    await until("the deliberate statement was counted", async () => (await watch.count()) >= 1, 10_000)
  } finally { await conn.close() }
}

test("RUN-13 a note left waiting for its words issues nothing across a typing interval", async () => {
  const port = await deadPort()
  const it = await rolloutStage(cluster, "telegram", {
    // Neither clock and no retry may fire inside the window: what is bound here
    // is that WAITING costs nothing, and a clock line or a retry is work.
    people: [{ id: "p1", language: "en", transcribed_seconds: 600 }, { id: "p2", language: "ru" }],
    voice: { port, retry_seconds: 600, chunk_deadline_seconds: 600 },
  })
  let door: Awaited<ReturnType<typeof runDoor>> | undefined
  const typings: string[] = []
  try {
    it.edge.file("voice", AUDIO)
    const readerPid = await it.read.pid()
    const settle = await statementWatch(cluster, [readerPid])
    const platform = {
      ...it.edge.platform,
      async typing(where: { chat: string }) { typings.push(where.chat) },
    }
    door = await runDoor({ door: "door-fake", registryFile: it.registryFile, platform })
    await untilIssued(settle, "the door's post task read its pending replies once",
      /from outbox o\b/, { after: /listen hub_outbox/ })
    it.edge.batch([note("1")], "2")
    await until("the note is waiting for its words",
      async () => (await it.read.inbound())[0]?.media_state === "pending", 30_000)
    await until("its first try is over and its retry is armed",
      async () => (await it.read.inbound())[0]?.media_retry_at !== null, 30_000)
    await until("the cursor has moved",
      async () => (await it.read.sheet("door_cursor")).length > 0, 30_000)
    await Bun.sleep(1000)

    // The window. The step learns its row from the commit and waits on that
    // row's own retry on a cancellable timer, so there is no per-tick query of
    // waiting rows and nothing here to count.
    const watch = await statementWatch(cluster, [readerPid])
    await Bun.sleep(TYPING_WINDOW_MS)
    const issued = await watch.count()
    if (issued > 0) {
      throw new Error(
        `the door issued ${issued} statements with a note waiting for its words, which is a poll, not a wait. Statements:\n` +
        (await watch.lines()).slice(0, 8).join("\n"),
      )
    }
    expect((await it.read.inbound())[0].media_state, "RUN-13 and it really was still waiting").toBe("pending")
    // The shipped typing rule, unchanged: a row nobody has accepted and nobody
    // holds shows no typing, and no waiting line goes out about it either.
    expect(typings, "RUN-13 no typing for a row no runner holds").toEqual([])
    expect(it.edge.posts().map(p => p.text), "RUN-13 and no acked line")
      .not.toContain(clockLine("en", "acked", 1))
    await proveCounter(it.db, [readerPid])
  } finally { await door?.stop(); await it.stop() }
}, 120_000)

test("RUN-13 a note that will never become words issues nothing while the door idles", async () => {
  const port = await deadPort()
  const it = await rolloutStage(cluster, "telegram", {
    people: [{ id: "p1", language: "en", transcribed_seconds: 600 }, { id: "p2", language: "ru" }],
    voice: { port, retry_seconds: 600, chunk_deadline_seconds: 600 },
  })
  let door: Awaited<ReturnType<typeof runDoor>> | undefined
  try {
    it.edge.file("voice", AUDIO)
    door = await runDoor({ door: "door-fake", registryFile: it.registryFile, platform: it.edge.platform })
    it.edge.batch([note("1")], "2")
    await until("the note is waiting", async () => (await it.read.inbound())[0]?.media_state === "pending", 30_000)
    const path = (await it.read.inbound())[0].body.match(/\(voice ([^)]+)\)/)![1]
    await door.stop()
    door = undefined
    // Bytes that no longer match their receipt will never be the right words, so
    // the note is finished the moment the door checks them. That is the state
    // D-190's content path leaves behind, reached without a recognizer.
    writeFileSync(path, new Uint8Array([0, 0, 0, 0]))
    const readerPid = await it.read.pid()
    const settle = await statementWatch(cluster, [readerPid])
    door = await runDoor({ door: "door-fake", registryFile: it.registryFile, platform: it.edge.platform })
    expect((await it.read.inbound())[0].media_state, "RUN-13 finished before the door was ready").toBe("failed")
    await untilIssued(settle, "the door's post task read its pending replies once",
      /from outbox o\b/, { after: /listen hub_outbox/ })
    await Bun.sleep(1000)

    // A FAILED row arms nothing, so nothing wakes.
    const watch = await statementWatch(cluster, [readerPid])
    await Bun.sleep(IDLE_WINDOW_MS)
    const issued = await watch.count()
    if (issued > 0) {
      throw new Error(
        `the door issued ${issued} statements with a finished note on the table, which is a timer, not a wait. Statements:\n` +
        (await watch.lines()).slice(0, 8).join("\n"),
      )
    }
    await proveCounter(it.db, [readerPid])
  } finally { await door?.stop(); await it.stop() }
}, 120_000)

test("RUN-13 a restarted door's budget still opens two seconds after it is ready, with three notes waiting", async () => {
  const port = await deadPort()
  const it = await rolloutStage(cluster, "telegram", {
    people: [{ id: "p1", language: "en", transcribed_seconds: 600 }, { id: "p2", language: "ru" }],
    voice: { port, retry_seconds: 600, chunk_deadline_seconds: 600 },
  })
  let door: Awaited<ReturnType<typeof runDoor>> | undefined
  try {
    it.edge.file("voice", AUDIO)
    door = await runDoor({ door: "door-fake", registryFile: it.registryFile, platform: it.edge.platform })
    it.edge.batch([note("1"), note("2"), note("3")], "2")
    await until("three notes are waiting with their retries armed", async () => {
      const rows = await it.read.inbound()
      return rows.length === 3 && rows.every(r => r.media_state === "pending" && r.media_retry_at !== null)
    }, 60_000)
    await door.stop()
    door = undefined

    const readerPid = await it.read.pid()
    door = await runDoor({ door: "door-fake", registryFile: it.registryFile, platform: it.edge.platform })
    // THE CONNECT SCAN AND EVERY DIGEST CHECK ARE ON THE OTHER SIDE OF THAT
    // RESOLVE, which is the property the shipped restart budget counts from.
    expect((await it.read.inbound()).every(r => r.media_state === "pending"),
      "RUN-13 three notes read, none of them finished off").toBe(true)
    await Bun.sleep(2000)
    const watch = await statementWatch(cluster, [readerPid])
    await Bun.sleep(IDLE_WINDOW_MS)
    const issued = await watch.count()
    if (issued > RESTART_ALLOWED) {
      throw new Error(
        `the restarted door issued ${issued} statements with three notes waiting, which is a tick, not a wait. Statements:\n` +
        (await watch.lines()).slice(0, 8).join("\n"),
      )
    }
    await proveCounter(it.db, [readerPid])
  } finally { await door?.stop(); await it.stop() }
}, 120_000)

test("RUN-13 a note waiting for its words costs no processor time, and the wait it sits in is cancellable", async () => {
  const port = await deadPort()
  const it = await rolloutStage(cluster, "telegram", {
    people: [{ id: "p1", language: "en", transcribed_seconds: 600 }, { id: "p2", language: "ru" }],
    voice: { port, retry_seconds: 600, chunk_deadline_seconds: 600 },
  })
  let door: Awaited<ReturnType<typeof runDoor>> | undefined
  try {
    it.edge.file("voice", AUDIO)
    door = await runDoor({ door: "door-fake", registryFile: it.registryFile, platform: it.edge.platform })
    it.edge.batch([note("1")], "2")
    await until("the note is waiting with its retry armed",
      async () => (await it.read.inbound())[0]?.media_retry_at !== null, 30_000)
    await Bun.sleep(1000)
    // The door runs in THIS process, so this is the processor time it burns.
    // A bound rather than a comparison, so a loaded machine does not turn it red.
    const before = cpuSeconds(process.pid)
    expect(before, "RUN-13 the probe answers at all").not.toBeNull()
    await Bun.sleep(IDLE_WINDOW_MS)
    const burned = cpuSeconds(process.pid)! - before!
    expect(burned, "RUN-13 a note waiting for its words is asleep").toBeLessThan(CPU_BOUND_SECONDS)

    // A RETRY TEN MINUTES AWAY DOES NOT HOLD THE STOP. Every wait the task sits
    // in races the stop, so the handle comes back in its own time rather than
    // at the end of the retry interval.
    const began = Date.now()
    await door.stop()
    door = undefined
    expect(Date.now() - began, "RUN-13 the stop did not wait out the retry").toBeLessThan(STOP_BOUND_MS)
  } finally { await door?.stop(); await it.stop() }
}, 120_000)

test("RUN-13 the statement counter used by these windows is proved by a deliberate statement", async () => {
  const it = await rolloutStage(cluster, "telegram")
  try {
    const readerPid = await it.read.pid()
    const quiet = await statementWatch(cluster, [readerPid])
    await Bun.sleep(500)
    expect(await quiet.count(), "RUN-13 an empty window counts nothing").toBe(0)
    const watch = await statementWatch(cluster, [readerPid])
    const conn = cluster.connect(it.db) as unknown as {
      unsafe(q: string): Promise<unknown>; close(): Promise<void>
    }
    try {
      const pid = await backendPid(conn as never)
      expect(pid, "RUN-13 a backend that is not the reader's").not.toBe(readerPid)
      await conn.unsafe("select 1 as deliberate_statement")
      await until("the deliberate statement was counted", async () => (await watch.count()) >= 1, 10_000)
    } finally { await conn.close() }
    expect(await observe(async () => (await watch.count()) >= 1)).toBe(true)
  } finally { await it.stop() }
}, 60_000)
