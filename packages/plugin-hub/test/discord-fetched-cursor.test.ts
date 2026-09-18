// ROLL-26. Snowflakes above Number's exact range and more than two wire pages.
import { afterAll, beforeAll, expect, test } from "bun:test"
import { startCluster, type Cluster } from "./helpers/cluster.ts"
import { rolloutFixture } from "./helpers/rollout-fixtures.ts"
import { rolloutStage } from "./helpers/rollout-stage.ts"
import { observe } from "./helpers/rollout-runner.ts"
import { attachment, chat, discordMessage, wirePlatform } from "./helpers/rollout-ingress.ts"
import { runDoor } from "../src/door/run.ts"
let cluster: Cluster
beforeAll(async () => { cluster = await startCluster() })
afterAll(async () => { await cluster?.stop() })
const base = 9007199254740992n

test("ROLL-26 Forbidden accepted-only cursor pins ignored pages and production drains numerically", async () => {
  const f = rolloutFixture()
  try {
    const records = Array.from({ length: 151 }, (_, i) => discordMessage(String(base + BigInt(i + 1)), { content: "bot", author: { id: "p2", bot: true } }))
    records.push(discordMessage(String(base + 152n), { content: "last human", attachments: [attachment("1", "image/png")] }))
    for (const defective of [true, false]) {
      const wire = wirePlatform(f.dir, "discord", url => {
        const after = BigInt(url.searchParams.get("after") ?? "0")
        return records.filter(r => BigInt(r.id) > after).slice(0, 50).reverse()
      })
      let cursor: string | null = null
      const accepted: string[] = []
      const cursors: bigint[] = []
      for (let page = 0; page < 5; page++) {
        const pulled = await wire.platform.pull({ chat, cursor, timeoutMs: 0 })
        accepted.push(...pulled.messages.map(m => m.platform_message_id))
        cursor = defective && pulled.messages.length === 0 ? cursor : pulled.cursor
        if (cursor) cursors.push(BigInt(cursor))
      }
      const progressed = () => {
        expect(accepted, "D-173 bounded Discord ignored-page drain reaches human work").toEqual([String(base + 152n)])
        expect(cursor).toBe(String(base + 152n))
        expect(cursors.every((value, i) => i === 0 || value >= cursors[i - 1])).toBe(true)
        expect(wire.calls.length).toBeLessThanOrEqual(8)
      }
      if (defective) expect(progressed).toThrow()
      else progressed()
    }
  } finally { f.stop() }
})

test("ROLL-26 bot and unauthorized pages precede one authorized attachment and text across restart", async () => {
  const it = await rolloutStage(cluster, "discord", { agents: [] })
  const f = rolloutFixture()
  let door: Awaited<ReturnType<typeof runDoor>> | undefined
  try {
    const records = Array.from({ length: 151 }, (_, i) => discordMessage(String(base + BigInt(i + 1)), {
      content: "ignored synthetic input", author: { id: "p2", username: "p1", bot: i % 2 === 0 },
    }))
    records.push(discordMessage(String(base + 152n), { content: "human codeword", attachments: [attachment("1", "image/png")] }))
    const wire = wirePlatform(f.dir, "discord", url => {
      if (!url.searchParams.has("limit")) return { id: "synthetic-receipt" }
      const after = BigInt(url.searchParams.get("after") ?? "0")
      return records.filter(r => BigInt(r.id) > after).slice(0, 50).reverse()
    })
    const pull = wire.platform.pull
    const platform = { ...wire.platform, async pull(where: any) { await Bun.sleep(5); return pull({ ...where, timeoutMs: 0 }) }, fetchMedia: async () => new Response(new Uint8Array([11, 22, 33, 44])) }
    const start = () => runDoor({ door: "door-fake", registryFile: it.registryFile, platform })
    door = await start()
    expect(await observe(async () => (await it.read.sheet("door_cursor")).some(r => r.id === `door-fake/${chat}` && r.data.cursor === String(base + 152n))), "D-173 fetched snowflakes durably reach last human").toBe(true)
    expect((await it.read.inbound()).map(r => r.id), "D-173 ignored pages create no human work").toEqual([`discord:${chat}:${base + 152n}`])
    expect((await it.read.inbound())[0].body).toContain("human codeword")
    expect((await it.read.inbound())[0].body).toContain("(photo ")
    await door.stop()
    const calls = wire.calls.length
    door = await start()
    expect(await observe(() => wire.calls.length > calls)).toBe(true)
    expect(await it.read.inbound()).toHaveLength(1)
    expect(await it.read.ledger({ subject: `discord:${chat}:${base + 152n}`, kind: "received" })).toHaveLength(1)
    const offsets = wire.calls.map(c => new URL(c.url)).filter(u => u.pathname.includes(chat) && u.searchParams.has("after")).map(u => BigInt(u.searchParams.get("after")!))
    expect(offsets.every((value, i) => i === 0 || value >= offsets[i - 1])).toBe(true)
  } finally { await door?.stop(); await it.stop(); f.stop() }
})
