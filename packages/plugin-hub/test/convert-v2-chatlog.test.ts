import { beforeAll, expect, test } from "bun:test"
import { appendFileSync, readFileSync, writeFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { seam, startCluster } from "./helpers/cluster.ts"
import { migrationFixture, inventory, jsonlBytes } from "./helpers/rollout-migration.ts"
import { proveMigrationFixtures } from "../live/prove-rollout-migration.ts"
import { readTail } from "../src/chatlog.ts"
import { stageHub, insertInbound, RUNNER } from "./helpers/hub-fixture.ts"
import { runRunner } from "../src/runner/run.ts"
import { observe } from "./helpers/rollout-runner.ts"
beforeAll(proveMigrationFixtures)
async function converter() { return (await seam("src/migrate/chatlog.ts")).convertV2Chatlog as (manifest: any) => Promise<any> }

function rows(bytes: Record<string, string>) { return Object.values(bytes).join("").trim().split("\n").filter(Boolean).map(s => JSON.parse(s)) }

test("ROLL-02 both formats preserve text sender identity UTC days and byte-exact repeatability", async () => {
  const f = migrationFixture()
  try {
    const convert = await converter()
    f.logManifest.timezone = "Asia/Tokyo"
    writeFileSync(f.old, readFileSync(f.old, "utf8").replace("12:00:00", "00:03:04").replace("12:01:00", "09:05:06"))
    f.logManifest.inventory = inventory([f.old, f.tab])
    await convert(f.logManifest)
    const first = [jsonlBytes(f.stateDir, "p1", "p1-lair"), jsonlBytes(f.stateDir, "p2", "p2-lair")]
    const a = rows(first[0]), b = rows(first[1])
    expect(a.map(r => [r.from, r.direction, r.text])).toEqual([["p1", "in", "Unicode λ\nsecond line"], ["p1-lair", "out", "(voice) synthetic transcript"]])
    expect(b.map(r => r.text)).toEqual(["equal text", "equal text", "λ\n(voice) synthetic transcript"])
    expect(new Set(b.map(r => r.id)).size).toBe(3)
    const exactTimes = (rows: any[]) => expect(rows.map(r => r.at), "L08 original instants across UTC midnight").toEqual(["2026-06-30T15:03:04.000Z", "2026-07-01T00:05:06.000Z"])
    expect(() => exactTimes(a.map(r => ({ ...r, at: r.at.slice(0, 10) + "T12:00:00.000Z" })))).toThrow()
    exactTimes(a)
    expect(Object.keys(first[0])).toEqual(["2026-06-30.jsonl", "2026-07-01.jsonl"])
    expect(b.map(r => r.at)).toEqual(["2026-07-02T12:00:00.000Z", "2026-07-02T12:00:00.000Z", "2026-07-02T12:01:00.000Z"])
    expect(a.every(r => r.id)).toBe(true)
    expect(jsonlBytes(f.stateDir, "p1", "p1-empty")).toEqual({})
    await convert(f.logManifest)
    const second = [jsonlBytes(f.stateDir, "p1", "p1-lair"), jsonlBytes(f.stateDir, "p2", "p2-lair")]
    const repeatable = (got: any) => expect(got).toEqual(first)
    repeatable(second)
    // Scoped defective append with no ID deduplication on the same destination.
    const name = Object.keys(second[0])[0]
    appendFileSync(join(f.stateDir, "p1", "chatlog", "p1-lair", name), second[0][name])
    expect(() => repeatable([jsonlBytes(f.stateDir, "p1", "p1-lair"), second[1]])).toThrow()
  } finally { f.stop() }
})

test("ROLL-02 converted recent codeword reaches readTail and the actual new-session feed before input", async () => {
  const f = migrationFixture()
  try {
    const convert = await converter()
    const cluster = await startCluster()
    let h: Awaited<ReturnType<typeof stageHub>> | undefined
    let runner: Awaited<ReturnType<typeof runRunner>> | undefined
    try {
      h = await stageHub(cluster)
      const at = new Date(Date.now() - 1000).toISOString()
      const file = join(f.roots[0].root, `${at.slice(0, 10)}.log`)
      const codeword = `synthetic-tail-${crypto.randomUUID()}`
      writeFileSync(file, `${at}\tp1\tdiscord:0000000000:99\t${JSON.stringify(codeword)}\n`)
      f.logManifest.inventory = inventory([f.old, f.tab, file])
      f.logManifest.state_dir = h.stateDir
      await convert(f.logManifest)
      expect(await readTail({ stateDir: h.stateDir, person: "p1", agent: "p1-lair", now: new Date(), hours: 24, tokens: 8000 })).toContain(codeword)
      runner = await runRunner({ runner: RUNNER, registryFile: h.registryFile, adapters: { [h.adapterName]: h.scripted.adapter } })
      await insertInbound(cluster, h.db, { id: "new-message", body: "synthetic new work" })
      expect(await observe(async () => (await h!.read.outbox()).some(r => r.inbound_id === "new-message"))).toBe(true)
      const fed = h.scripted.fed()
      expect(fed[0].text).toContain(codeword)
      expect(fed.findIndex(r => r.text === "synthetic new work")).toBeGreaterThan(0)
      expect(() => expect(fed.slice(1)[0].text).toContain(codeword)).toThrow()
    } finally { await runner?.stop(); await h?.stop(); await cluster.stop() }
  } finally { f.stop() }
})

for (const fault of ["timezone", "unknown-sender", "malformed-row", "changed-source", "overlap", "ambiguous-date"] as const) test(`ROLL-02 ${fault} refuses with source cause and repaired input succeeds`, async () => {
  const f = migrationFixture()
  try {
    const convert = await converter()
    const valid = readFileSync(f.tab, "utf8")
    const manifest = structuredClone(f.logManifest)
    if (fault === "timezone") delete manifest.timezone
    if (fault === "unknown-sender") writeFileSync(f.tab, valid.replace("\tp2\t", "\tunknown\t"))
    if (fault === "malformed-row") writeFileSync(f.tab, valid.replace('"equal text"', 'not-json'))
    if (fault === "changed-source") appendFileSync(f.tab, "\n")
    let ambiguous: string | undefined
    if (fault === "ambiguous-date") {
      ambiguous = join(f.roots[0].root, "01-02-2026.md")
      writeFileSync(ambiguous, readFileSync(f.old, "utf8"))
      manifest.inventory = inventory([f.old, f.tab, ambiguous])
    }
    let overlap: string | undefined
    if (fault === "overlap") {
      overlap = join(f.roots[0].root, "2026-07-01.log")
      writeFileSync(overlap, '2026-07-01T12:00:00.000Z\tp1\tdiscord:0000000000:1\t"Unicode λ\\nsecond line"\n')
      manifest.inventory = inventory([f.old, f.tab, overlap])
    }
    if (fault === "unknown-sender" || fault === "malformed-row") manifest.inventory = inventory([f.old, f.tab])
    await expect(convert(manifest)).rejects.toThrow(fault === "unknown-sender" || fault === "malformed-row" ? /2026-07-02\.log:1/ : /timezone|digest|changed|overlap|reconcil|date/i)
    expect(jsonlBytes(f.stateDir, "p2", "p2-lair")).toEqual({})
    writeFileSync(f.tab, valid)
    if (ambiguous) rmSync(ambiguous)
    manifest.timezone = "UTC"
    manifest.inventory = inventory([f.old, f.tab, ...(overlap ? [overlap] : [])])
    if (overlap) manifest.reconciliation = [{ keep: { file: overlap, ordinal: 1 }, omit: { file: f.old, ordinal: 1 } }]
    await convert(manifest)
    expect(rows(jsonlBytes(f.stateDir, "p2", "p2-lair"))).toHaveLength(3)
    if (overlap) expect(rows(jsonlBytes(f.stateDir, "p1", "p1-lair")).filter(r => r.text === "Unicode λ\nsecond line")).toHaveLength(1)
  } finally { f.stop() }
})
