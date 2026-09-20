// These are library crash boundaries. Plan 05 extends them
// through runDoor and covers external delivery receipt ambiguity.
import { afterAll, beforeAll, expect, test } from "bun:test"
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { rolloutDatabase, rolloutFixture } from "./helpers/rollout-fixtures.ts"
import { startCluster, startReadySubprocess, seam, type Cluster } from "./helpers/cluster.ts"
import { appendChatLine, chatLogPath, readTail, type ChatLine } from "../src/chatlog.ts"
import { enqueueInbound } from "../src/store/inbound.ts"
import { claimNext } from "../src/runner/claim.ts"
import { readEligible } from "../src/store/wake.ts"
import { listenForWork } from "../src/store/listen.ts"
import { readPendingChunks } from "../src/store/outbox.ts"
let cluster: Cluster
beforeAll(async () => { cluster = await startCluster() })
afterAll(async () => { await cluster?.stop() })
type Context = { stateDir: string; person: string; agent: string }
type Line = ChatLine & { id: string }
type Append = (ctx: Context, line: Line) => Promise<void>
const at = "2026-09-01T23:59:59.000Z"
const line: Line = { id: "telegram:0000000000:1", at, direction: "in", from: "p1", text: "synthetic-codeword" }
async function appendSeam(): Promise<Append> {
  const mod = await seam("src/chatlog.ts")
  expect(typeof mod.appendChatLineOnce, "D-172 appendChatLineOnce export missing").toBe("function")
  return mod.appendChatLineOnce as Append
}
async function projectSeam() {
  const mod = await seam("src/chatlog/project.ts")
  expect(typeof mod.projectInbound).toBe("function")
  return mod.projectInbound as (store: any, options: { stateDir: string; inboundId: string }) => Promise<void>
}
const context = (f: ReturnType<typeof rolloutFixture>): Context => ({ stateDir: f.stateDir, person: "p1", agent: "p1-lair" })
const log = (ctx: Context) => chatLogPath({ ...ctx, at: new Date(at) })
const lines = (ctx: Context): Line[] => existsSync(log(ctx)) ? readFileSync(log(ctx), "utf8").trim().split("\n").filter(Boolean).map(raw => JSON.parse(raw)) : []
async function tail(ctx: Context) {
  return readTail({ ...ctx, now: new Date("2026-09-02T00:00:01Z"), hours: 24, tokens: 8000 })
}

for (const point of ["inbound-commit", "append-before-fsync", "outgoing-before-send"] as const) {
  test(`ROLL-20 Forbidden missing tail or duplicate reply: SIGKILL at ${point} repairs exactly once`, async () => {
    // Both branches are stopped by the SAME child barrier at the same point.
    // The defect suppresses restart projection or appends without ID lookup.
    for (const defective of [true, false]) {
      const f = rolloutFixture()
      const ctx = context(f)
      const message = { id: line.id, person: "p1", agent: "p1-lair", body: line.text,
        source: { log_id: line.id, at, door: "door-fake", chat: "0000000000", sender_id: "p1", text: line.text }, log_ready: false }
      const saved = point === "outgoing-before-send" ? { ...line, id: "outbox:2", direction: "out" as const, from: "p1-lair" } : line
      let child: Awaited<ReturnType<typeof startReadySubprocess>> | undefined
      try {
        const db = await rolloutDatabase(cluster)
        if (point === "outgoing-before-send") {
          await db.sql`update outbox set written_at = ${at} where seq_in_reply = 2`
          const row = (await db.sql`select id, written_at from outbox where seq_in_reply = 2`)[0]
          saved.id = `outbox:${row.id}`
          saved.at = new Date(row.written_at).toISOString()
        }
        let append: Append = appendChatLine
        let project: Awaited<ReturnType<typeof projectSeam>> = async () => {}
        if (!defective) {
          append = await appendSeam()
          project = await projectSeam()
          expect((await db.sql`select column_name from information_schema.columns where table_name = 'inbound'`).map((r: any) => r.column_name)).toContain("log_ready")
        }
        mkdirSync(dirname(log(ctx)), { recursive: true })
        const config = join(f.dir, "crash.json")
        writeFileSync(config, JSON.stringify({ point, proof: defective, file: log(ctx), context: ctx, line: saved, message, url: db.store("hub_door").url }))
        child = await startReadySubprocess("test/helpers/rollout-crash-child.ts", [config], 5000)
        if (point === "inbound-commit") {
          expect((await db.sql`select body from inbound where id = ${message.id}`)[0].body).toBe(line.text)
          expect(lines(ctx)).toHaveLength(0)
        } else {
          expect(lines(ctx)).toEqual([saved])
        }
        await child.stop(9)
        expect(child.proc.signalCode).toBe("SIGKILL")
        const accept = async () => {
          if (point === "inbound-commit") {
            await project(db.store("hub_door"), { stateDir: f.stateDir, inboundId: message.id })
            await project(db.store("hub_door"), { stateDir: f.stateDir, inboundId: message.id })
          } else {
            await append(ctx, saved)
            await append(ctx, saved)
          }
          if (point === "inbound-commit") expect(await tail(ctx), "committed codeword must survive restart").toContain(line.text)
          expect(lines(ctx), "one complete stable-ID record after crash and repeated restart").toEqual([saved])
          expect(await tail(ctx)).toContain(line.text)
          expect(lines(ctx)[0].at).toBe(at)
          expect(existsSync(chatLogPath({ ...ctx, at: new Date("2026-09-02T00:00:01Z") }))).toBe(false)
          if (point === "inbound-commit" && !defective) expect((await db.sql`select log_ready from inbound where id = ${message.id}`)[0].log_ready).toBe(true)
        }
        if (defective) await expect(accept()).rejects.toThrow()
        else await accept()
      } finally { await child?.stop(9); f.stop() }
    }
  })
}

test("ROLL-20 D-172 equal prose with different IDs survives concurrent appenders and repeated IDs do not", async () => {
  const f = rolloutFixture()
  try {
    const append = await appendSeam()
    const ctx = context(f)
    // Independent processes exercise the file lock, rather than only a promise map.
    const configurations = Array.from({ length: 8 }, (_, index) => {
      const config = join(f.dir, `append-${index}.json`)
      writeFileSync(config, JSON.stringify({ point: "outgoing-before-send", context: ctx, line: { ...line, id: index % 2 ? "same-text-other-id" : line.id } }))
      return config
    })
    const children = await Promise.allSettled(configurations.map(config => startReadySubprocess("test/helpers/rollout-crash-child.ts", [config], 5000)))
    try {
      for (const child of children) if (child.status === "rejected") throw child.reason
      expect(lines(ctx).map(l => l.id).sort()).toEqual([line.id, "same-text-other-id"].sort())
      await append(ctx, line)
      expect(lines(ctx)).toHaveLength(2)
    } finally {
      for (const child of children) if (child.status === "fulfilled") await child.value.stop(9)
    }
  } finally { f.stop() }
})

test("ROLL-20 D-172 repairs only incomplete final records and refuses malformed complete history", async () => {
  const f = rolloutFixture()
  try {
    const append = await appendSeam()
    const ctx = context(f)
    const legacy = { at, direction: "in" as const, from: "p1", text: "legacy four-field text" }
    await appendChatLine(ctx, legacy)
    const prefix = readFileSync(log(ctx), "utf8")
    appendFileSync(log(ctx), '{"id":"partial')
    await append(ctx, line)
    expect(readFileSync(log(ctx), "utf8")).toBe(prefix + JSON.stringify(line) + "\n")
    expect(await tail(ctx)).toContain(legacy.text)
    // A complete final record without a newline is history, not a torn write.
    writeFileSync(log(ctx), prefix + JSON.stringify(line))
    await append(ctx, { ...line, id: "complete-next" })
    expect(lines(ctx).map(item => item.text)).toEqual([legacy.text, line.text, line.text])
    expect(lines(ctx)[1]).toEqual(line)
    for (const bad of ['{"broken":}\n', '{"id":"complete-but-invalid"}\n']) {
      const corrupt = prefix + bad + JSON.stringify(line) + "\n"
      writeFileSync(log(ctx), corrupt)
      await expect(append(ctx, { ...line, id: "next" })).rejects.toThrow()
      expect(readFileSync(log(ctx), "utf8")).toBe(corrupt)
      // The same append succeeds after removing only the malformed record.
      writeFileSync(log(ctx), prefix + JSON.stringify(line) + "\n")
      await append(ctx, { ...line, id: "next" })
      expect(lines(ctx)).toHaveLength(3)
    }
  } finally { f.stop() }
})

test("ROLL-20 D-172 source persists, unprojected rows cannot claim, readiness wakes the existing channel", async () => {
  const f = rolloutFixture()
  const db = await rolloutDatabase(cluster)
  const ctx = context(f)
  try {
    const project = await projectSeam()
    const door = db.store("hub_door")
    const runner = db.store("hub_runner")
    // Remove unrelated old work before opening this observation.
    await db.sql`delete from outbox`
    await db.sql`delete from inbound`
    const source = { log_id: line.id, at, door: "door-fake", chat: "0000000000", sender_id: "p1", text: line.text }
    await door.sql.begin(async sql => { await enqueueInbound({ sql, url: door.url }, { id: line.id, person: "p1", agent: "p1-lair", body: line.text, source, log_ready: false } as any) })
    expect((await db.sql`select source, log_ready from inbound where id = ${line.id}`)[0]).toEqual({ source, log_ready: false })
    expect(await claimNext(runner, { runner: "runner-pi", agent: "p1-lair", leaseMs: 1000 })).toBeNull()
    expect(await readEligible(runner, { agent: "p1-lair" })).toEqual([])
    let notified = false
    let wake: () => void = () => {}
    const ready = new Promise<void>(resolve => { wake = resolve })
    const listener = await listenForWork({ url: runner.url, channel: "hub_work", onNotify: payload => { if (payload === "p1-lair") { notified = true; wake() } } })
    try {
      await project(door, { stateDir: f.stateDir, inboundId: line.id })
      await Promise.race([ready, Bun.sleep(2000)])
      expect(notified, "projection readiness must notify hub_work").toBe(true)
      expect((await claimNext(runner, { runner: "runner-pi", agent: "p1-lair", leaseMs: 1000 }))?.id).toBe(line.id)
      expect(await tail(ctx)).toContain(line.text)
    } finally { await listener.close() }
  } finally { f.stop() }
})

test("ROLL-20 ROLL-23 D-172 pending chunks retain written_at and pinned accepted route", async () => {
  const db = await rolloutDatabase(cluster)
  const chunks = await readPendingChunks(db.store("hub_door"), { agent: "p1-lair" })
  expect(chunks).toHaveLength(1)
  expect(chunks[0], "restart projection needs the original outbox written_at").toHaveProperty("written_at")
  expect(new Date((chunks[0] as any).written_at).toISOString()).toBe("2026-09-01T12:00:00.000Z")
  await db.sql`update outbox set route = '{"door":"door-fake","chat":"0000000000"}' where seq_in_reply = 2`
  expect((await readPendingChunks(db.store("hub_door"), { agent: "p1-lair" }))[0]).toHaveProperty("route", { door: "door-fake", chat: "0000000000" })
})

test("ROLL-20 D-172 refused projection preserves unready work and succeeds after log repair", async () => {
  const f = rolloutFixture()
  try {
    const project = await projectSeam()
    const db = await rolloutDatabase(cluster)
    const door = db.store("hub_door")
    const source = { log_id: line.id, at, door: "door-fake", chat: "0000000000", sender_id: "p1", text: line.text }
    await door.sql.begin(async sql => { await enqueueInbound({ sql, url: door.url }, { id: line.id, person: "p1", agent: "p1-lair", body: line.text, source, log_ready: false } as any) })
    const ctx = context(f)
    mkdirSync(dirname(log(ctx)), { recursive: true })
    const corrupt = '{"malformed":}\n'
    writeFileSync(log(ctx), corrupt)
    await expect(project(door, { stateDir: f.stateDir, inboundId: line.id })).rejects.toThrow()
    expect((await db.sql`select log_ready from inbound where id = ${line.id}`)[0].log_ready).toBe(false)
    expect(readFileSync(log(ctx), "utf8")).toBe(corrupt)
    writeFileSync(log(ctx), "")
    await project(door, { stateDir: f.stateDir, inboundId: line.id })
    expect((await db.sql`select log_ready from inbound where id = ${line.id}`)[0].log_ready).toBe(true)
    expect(await tail(ctx)).toContain(line.text)
  } finally { f.stop() }
})

// Plan 05 exercises the real door at the same crash boundaries.
import { rolloutStage } from "./helpers/rollout-stage.ts"
import { chatLogLines } from "./helpers/hub-fixture.ts"
import { message } from "./helpers/rollout-ingress.ts"
import { observe } from "./helpers/rollout-runner.ts"
import { runDoor } from "../src/door/run.ts"
import { storeUrlAs } from "../src/store/connect.ts"

beforeAll(async () => {
  // Standalone proof before any check uses the added outgoing barrier mode.
  const f = rolloutFixture()
  let child: Awaited<ReturnType<typeof startReadySubprocess>> | undefined
  try {
    const ctx = context(f)
    const saved = { ...line, direction: "out" as const, text: "synthetic barrier proof" }
    const config = join(f.dir, "delivery-proof.json")
    writeFileSync(config, JSON.stringify({ mode: "delivery", proof: true, context: ctx, line: saved, text: saved.text }))
    child = await startReadySubprocess("test/helpers/rollout-crash-child.ts", [config], 5000)
    expect(lines(ctx)).toEqual([saved])
    await child.stop(9)
    expect(child.proc.signalCode).toBe("SIGKILL")
    expect(lines(ctx)).toEqual([saved])
    console.log("H05 outgoing crash barrier standalone proof passed")
  } finally { await child?.stop(9); f.stop() }
})

for (const point of ["inbound-commit", "outgoing-before-send"] as const) {
  test(`ROLL-20 runDoor SIGKILL ${point} repairs startup tail once with original UTC date`, async () => {
    const it = await rolloutStage(cluster, "telegram")
    let child: Awaited<ReturnType<typeof startReadySubprocess>> | undefined
    let door: Awaited<ReturnType<typeof runDoor>> | undefined
    // A durable timestamp on the previous UTC day. This is projection, not a
    // harvest trigger, so no trigger clock or ordering in the database is faked.
    const midnight = new Date(); midnight.setUTCHours(0, 0, 0, 0)
    const written = new Date(midnight.getTime() - 1000).toISOString()
    const input = { ...message(), at: written, text: "synthetic crash codeword" }
    const ctx = { stateDir: it.stateDir, person: "p1", agent: "p1-lair" }
    const path = chatLogPath({ ...ctx, at: new Date(written) })
    const config = join(it.stateDir, "crash.json")
    try {
      let id = `telegram:1000000001:1`
      if (point === "inbound-commit") {
        writeFileSync(config, JSON.stringify({ mode: "ingress", point: "projection", trace: join(it.stateDir, "trace.jsonl"), message: input,
          id, registryFile: it.registryFile, stateDir: it.stateDir, url: storeUrlAs(it.storeUrl, "hub_door") }))
      } else {
        await it.read.sql("insert into inbound (id, person, agent, body, state) values ('crash-reply', 'p1', 'p1-lair', 'synthetic request', 'answered')")
        const inserted = await it.read.sql("insert into outbox (inbound_id, seq_in_reply, body, written_at) values ('crash-reply', 1, $1, $2) returning id", [input.text, written])
        id = `outbox:${inserted[0].id}`
        writeFileSync(config, JSON.stringify({ mode: "delivery", registryFile: it.registryFile, text: input.text }))
      }
      child = await startReadySubprocess("test/helpers/rollout-crash-child.ts", [config], 5000)
      expect(await it.read.inbound()).toHaveLength(1)
      const before = chatLogLines(it.stateDir, "p1", "p1-lair")
      expect(before).toHaveLength(point === "inbound-commit" ? 0 : 1)
      expect((await it.read.outbox()).every(row => row.delivered_at === null)).toBe(true)
      await child.stop(9)
      expect(child.proc.signalCode).toBe("SIGKILL")
      const tailPresent = async () => expect(await readTail({ ...ctx, now: new Date(), hours: 48, tokens: 8000 }), "F20 committed input must be in repaired tail").toContain(input.text)
      const once = () => {
        const found = chatLogLines(it.stateDir, "p1", "p1-lair").filter(row => row.text === input.text) as Line[]
        expect(found, "F20 restart must have exactly one stable log ID").toHaveLength(1)
        expect(found[0].id, "D-172 outgoing log ID must be durable").toBe(id)
        expect(found[0].at, "D-172 original written_at survives UTC midnight").toBe(written)
      }
      if (point === "inbound-commit") {
        // Omitted startup repair control leaves the actual committed row absent.
        await expect(tailPresent()).rejects.toThrow()
      } else {
        // Scoped outgoing-only loss of deduplication on this scratch file.
        const originalPath = chatLogPath({ ...ctx, at: new Date(before[0].at) })
        const bytes = readFileSync(originalPath, "utf8")
        await appendChatLine(ctx, before[0] as ChatLine)
        expect(() => once()).toThrow()
        writeFileSync(originalPath, bytes)
      }
      // Restart with NO replay batch. Ready must mean startup repair is complete.
      door = await runDoor({ door: "door-fake", registryFile: it.registryFile, platform: it.edge.platform })
      if (point === "inbound-commit") await tailPresent()
      else expect(await observe(async () => (await it.read.outbox()).every(row => row.delivered_at !== null)), "D-172 restart delivers pending reply").toBe(true)
      once()
      expect(existsSync(path)).toBe(true)
      await tailPresent()
      await door.stop()
      door = await runDoor({ door: "door-fake", registryFile: it.registryFile, platform: it.edge.platform })
      once()
      if (point === "outgoing-before-send") expect(it.edge.posts().filter(row => row.text === input.text)).toHaveLength(1)
    } finally { await child?.stop(9); await door?.stop(); await it.stop() }
  })
}
