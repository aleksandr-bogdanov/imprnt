// Cursor observations use the real door_cursor sheet.
import { afterAll, beforeAll, expect, test } from "bun:test"
import { constants, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { startCluster, startReadySubprocess, seam, type Cluster } from "./helpers/cluster.ts"
import { rolloutStage } from "./helpers/rollout-stage.ts"
import { rolloutFixture } from "./helpers/rollout-fixtures.ts"
import { observe } from "./helpers/rollout-runner.ts"
import { chatLogLines } from "./helpers/hub-fixture.ts"
import { chat, message, payload, telegramUpdate, wirePlatform } from "./helpers/rollout-ingress.ts"
import { storeUrlAs } from "../src/store/connect.ts"
import { runDoor } from "../src/door/run.ts"
import { readTail } from "../src/chatlog.ts"
let cluster: Cluster
beforeAll(async () => { cluster = await startCluster() })
afterAll(async () => { await cluster?.stop() })

test("ROLL-11 Telegram cursor is the next update offset on ignored-only transport batches", async () => {
  const f = rolloutFixture()
  try {
    const wire = wirePlatform(f.dir, "telegram", () => ({ ok: true, result: [{ update_id: 7 }, telegramUpdate(9, { chat: { id: "0000000000" } })] }))
    const first = await wire.platform.pull({ chat, cursor: null, timeoutMs: 0 })
    expect(first.messages).toEqual([])
    expect(first.cursor, "D-173 Telegram fetched cursor is next offset").toBe("10")
    await wire.platform.pull({ chat, cursor: first.cursor, timeoutMs: 0 })
    expect(wire.calls[1].body.offset).toBe(10)
  } finally { f.stop() }
})

test("ROLL-11 ignored-only batch advances durably then accepted work survives restart once", async () => {
  const it = await rolloutStage(cluster, "telegram")
  let door: Awaited<ReturnType<typeof runDoor>> | undefined
  try {
    it.edge.batch([], "2")
    it.edge.batch([message("2")], "3")
    const start = () => runDoor({ door: "door-fake", registryFile: it.registryFile, platform: it.edge.platform })
    door = await start()
    expect(await observe(async () => (await it.read.sheet("door_cursor")).some(r => r.id === `door-fake/${chat}` && r.data.cursor === "3")), "D-173 ignored-only batch must not pin cursor").toBe(true)
    expect((await it.read.inbound()).map(r => r.id)).toEqual([`telegram:${chat}:2`])
    await door.stop()
    door = await start()
    expect(await observe(() => it.edge.pulls().some(p => p.chat === chat && p.cursor === "3"))).toBe(true)
    expect(await it.read.inbound()).toHaveLength(1)
    expect(await it.read.ledger({ subject: `telegram:${chat}:2`, kind: "received" })).toHaveLength(1)
    expect(chatLogLines(it.stateDir, "p1", "p1-lair").filter(l => l.direction === "in")).toHaveLength(1)
  } finally { await door?.stop(); await it.stop() }
})

for (const point of ["media-save", "accepted-commit", "projection"] as const) test(`ROLL-11 Forbidden early acknowledgement: cursor cannot overtake blocked ${point}`, async () => {
  for (const defective of [true, false]) {
    const it = await rolloutStage(cluster, "telegram")
    let child: Awaited<ReturnType<typeof startReadySubprocess>> | undefined
    let door: Awaited<ReturnType<typeof runDoor>> | undefined
    try {
      const input = { ...message(), media: point === "projection" ? [] : [{ kind: "file" as const, remote_id: "fixture", name: "fixture.bin", mime: "application/octet-stream", bytes: 4, caption: null }] }
      if (!defective) {
        const mod = await seam("src/door/ingest.ts")
        expect(typeof mod.acceptBatch, "D-173 acceptBatch export").toBe("function")
      }
      const trace = join(it.stateDir, "trace.jsonl")
      const config = join(it.stateDir, "crash.json")
      writeFileSync(config, JSON.stringify({ mode: "ingress", point, proof: defective, earlyCursor: defective,
        trace, message: input, id: `telegram:${chat}:1`, registryFile: it.registryFile, stateDir: it.stateDir, url: storeUrlAs(it.storeUrl, "hub_door") }))
      child = await startReadySubprocess("test/helpers/rollout-crash-child.ts", [config], 5000)
      const ordered = async () => expect((await it.read.sheet("door_cursor")).find(r => r.id === `door-fake/${chat}`)?.data.cursor ?? null, "D-173 cursor stays behind blocked accepted work").toBeNull()
      if (defective) await expect(ordered()).rejects.toThrow()
      else {
        await ordered()
        if (point === "accepted-commit") {
          expect(await it.read.inbound()).toEqual([])
          const hash = new Bun.CryptoHasher("sha256").update(`telegram:${chat}:1`).digest("hex")
          const saved = join(it.stateDir, "p1", "inbox", hash, "0.bin")
          expect(new Uint8Array(readFileSync(saved))).toEqual(payload)
          const events = readFileSync(trace, "utf8").trim().split("\n").map(l => JSON.parse(l))
          const renamed = events.findIndex(e => e.event === "rename" && e.detail.to === saved)
          expect(renamed, "D-166 atomic rename before commit").toBeGreaterThan(0)
          const temporary = events[renamed].detail.from
          expect(temporary).not.toBe(saved)
          expect(events.slice(0, renamed).some(e => e.event === "open" && e.detail.path === temporary &&
            (typeof e.detail.flags === "string" ? e.detail.flags.includes("x") : (e.detail.flags & constants.O_EXCL) !== 0)), "D-166 exclusive temporary file").toBe(true)
          expect(events.slice(0, renamed).some(e => e.event === "file-sync" && e.detail === temporary), "D-166 file fsync before rename").toBe(true)
          expect(events.slice(renamed + 1).some(e => e.event === "directory-sync" && e.detail === join(it.stateDir, "p1", "inbox", hash)), "D-166 directory fsync before commit").toBe(true)
        }
        if (point === "projection") expect(await it.read.inbound()).toHaveLength(1)
      }
      await child.stop(9)
      expect(child.proc.signalCode).toBe("SIGKILL")
      if (!defective) {
        it.edge.file("fixture", payload)
        if (point === "accepted-commit") it.edge.platform.fetchMedia = async () => { throw new Error("verified durable file must be reused after precommit crash") }
        it.edge.batch([input], "2")
        door = await runDoor({ door: "door-fake", registryFile: it.registryFile, platform: it.edge.platform })
        expect(await observe(async () => (await it.read.sheet("door_cursor")).some(r => r.id === `door-fake/${chat}` && r.data.cursor === "2")), "D-173 unblocked replay completes").toBe(true)
        expect(await it.read.inbound()).toHaveLength(1)
        expect(chatLogLines(it.stateDir, "p1", "p1-lair").filter(l => l.direction === "in")).toHaveLength(1)
      }
    } finally { await child?.stop(9); await door?.stop(); await it.stop() }
  }
})

test("ROLL-20 replay repairs nonfresh committed ingress before advancing its fetched cursor", async () => {
  const it = await rolloutStage(cluster, "telegram")
  let child: Awaited<ReturnType<typeof startReadySubprocess>> | undefined
  let door: Awaited<ReturnType<typeof runDoor>> | undefined
  try {
    const input = message()
    const config = join(it.stateDir, "crash.json")
    writeFileSync(config, JSON.stringify({ mode: "ingress", point: "projection", trace: join(it.stateDir, "trace.jsonl"), message: input,
      id: `telegram:${chat}:1`, registryFile: it.registryFile, stateDir: it.stateDir, url: storeUrlAs(it.storeUrl, "hub_door") }))
    child = await startReadySubprocess("test/helpers/rollout-crash-child.ts", [config], 5000)
    expect(await it.read.inbound()).toHaveLength(1)
    expect(chatLogLines(it.stateDir, "p1", "p1-lair")).toEqual([])
    await child.stop(9)
    // The defective replay is precisely the old fresh-only guard: enqueue the
    // same row, get false, and suppress append. It meets the same crash above.
    const { enqueueInbound } = await import("../src/store/inbound.ts")
    const store = { sql: cluster.connectAs("hub_door", it.db), url: storeUrlAs(it.storeUrl, "hub_door") }
    const fresh = await store.sql.begin(sql => enqueueInbound({ ...store, sql }, { id: `telegram:${chat}:1`, person: "p1", agent: "p1-lair", body: input.text }))
    expect(fresh).toBe(false)
    const tailPresent = async () => expect(await readTail({ stateDir: it.stateDir, person: "p1", agent: "p1-lair", now: new Date(), hours: 24, tokens: 8000 }), "D-172 committed replay must repair the tail").toContain(input.text)
    await expect(tailPresent()).rejects.toThrow()
    it.edge.batch([input], "2")
    door = await runDoor({ door: "door-fake", registryFile: it.registryFile, platform: it.edge.platform })
    expect(await observe(() => it.edge.pulls().some(p => p.cursor === "2"))).toBe(true)
    await tailPresent()
    expect(chatLogLines(it.stateDir, "p1", "p1-lair").filter(l => l.direction === "in")).toHaveLength(1)
    expect(await it.read.ledger({ subject: `telegram:${chat}:1`, kind: "received" })).toHaveLength(1)
  } finally { await child?.stop(9); await door?.stop(); await it.stop() }
})
