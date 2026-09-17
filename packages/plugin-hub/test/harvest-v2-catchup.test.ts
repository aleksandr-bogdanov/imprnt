import { beforeAll, expect, test } from "bun:test"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { seam, startCluster } from "./helpers/cluster.ts"
import { migrationFixture, migrationHarvestStage, historicalRows, from, until, inventory, note, envelope, plantCanonical, plantTabHistory } from "./helpers/rollout-migration.ts"
import { proveMigrationFixtures } from "../live/prove-rollout-migration.ts"
import { loadRegistry } from "../src/registry/load.ts"
import { readSlice } from "../src/harvest/slice.ts"
import { harvestPrompt } from "../src/harvest/prompt.ts"
import { runRunner } from "../src/runner/run.ts"
import { insertInbound } from "./helpers/hub-fixture.ts"
import { stageHarvest, plantLine } from "./helpers/harvest-stage.ts"
import { observe } from "./helpers/rollout-runner.ts"
import { writeGatedImprntShim } from "./helpers/imprnt-shim.ts"
import { clockGate, clockSuffix, announceClock } from "./helpers/clock-gate.ts"

beforeAll(async () => {
  await proveMigrationFixtures()
  const cluster = await startCluster()
  let stage: Awaited<ReturnType<typeof migrationHarvestStage>> | undefined
  try {
    stage = await migrationHarvestStage(cluster)
    const registry = loadRegistry(stage.hub.registryFile)
    expect(registry.people[0].id).toBe("p2")
    expect(registry.agents.map(a => a.id)).toEqual(["p2-lair"])
    expect(existsSync(join(stage.vault.root, "CLAUDE.md"))).toBe(true)
    expect(await stage.hub.read.inbound()).toEqual([])
    console.log("H08 harvest stage proof: p2 registry, real scratch vault, empty throwaway store")
  } finally { await stage?.stop(); await cluster.stop() }
})
async function catchup() { return (await seam("src/migrate/harvest.ts")).catchUpHarvest as (registry: any, person: string, from: string, until: string, edges?: any) => Promise<any> }
async function convertHistory(f: ReturnType<typeof migrationFixture>, state: string) {
  const convert = (await seam("src/migrate/chatlog.ts")).convertV2Chatlog as Function
  const files = plantTabHistory(f.roots[1].root, historicalRows)
  await convert({ ...f.logManifest, sources: [f.roots[1]], state_dir: state, inventory: inventory([f.tab, ...files]) })
}

for (const mode of ["complete", "refused-resume", "conflict", "outside-inventory"] as const) test(`ROLL-03 ${mode} inclusive full-history catch-up uses real filing and durable watermark`, async () => {
  const f = migrationFixture()
  try {
    const run = await catchup()
    const cluster = await startCluster()
    const h = await migrationHarvestStage(cluster)
    const gate = writeGatedImprntShim(f.dir)
    let pending: Promise<any> | undefined
    try {
      await convertHistory(f, h.hub.stateDir)
      const registry = loadRegistry(h.hub.registryFile)
      const calls: string[] = []
      h.hub.scripted.setAnswer(({ text }) => {
        calls.push(text)
        const marker = historicalRows.find(row => text.includes(row.text))?.text ?? "missing"
        return envelope(note(marker, "Synthetic history retained.", !(mode === "refused-resume" && marker === "middle-history-codeword")))
      })
      const edges = { adapters: { [h.hub.adapterName]: h.hub.scripted.adapter } }
      if (mode === "outside-inventory") {
        await expect(run(registry, "p2", "2026-06-01T00:00:00.000Z", until, edges)).rejects.toThrow(/inventory|bound|source/i)
        await expect(run(registry, "p2", from, "2026-09-01T00:00:00.000Z", edges)).rejects.toThrow(/inventory|bound|source/i)
        expect(calls).toHaveLength(0)
        expect(await h.hub.read.harvestSheet()).toHaveLength(0)
        await run(registry, "p2", from, until, edges)
        expect((await h.hub.read.harvestSheet())[0].data.at).toBe(until)
        return
      }
      if (mode === "conflict") {
        const file = join(f.dir, "conflicting.md")
        writeFileSync(file, note("earliest-history-codeword", "Different existing fact."))
        const result = Bun.spawnSync([h.shim, "ingest", "--apply", file, "--vault", h.vault.vaultDir], { stdout: "pipe", stderr: "pipe" })
        expect(result.exitCode).toBe(0)
      }
      // Observe the watermark while the real apply is held, not only afterwards.
      writeFileSync(h.hub.registryFile, readFileSync(h.hub.registryFile, "utf8").replace(JSON.stringify(h.shim), JSON.stringify(gate.shim)))
      pending = run(loadRegistry(h.hub.registryFile), "p2", from, until, edges)
      // Attach immediately so a refusal cannot become an unhandled rejection.
      const outcome = pending.then(value => ({ value, error: null }), error => ({ value: null, error }))
      expect(await observe(() => gate.held() === 1, 7000), "catch-up must reach actual ingest").toBe(true)
      const at = async () => (await h.hub.read.harvestSheet())[0]?.data.at ?? null
      const ordering = (mark: unknown) => expect(mark).not.toBe(until)
      ordering(await at())
      expect(await at()).toBeNull()
      // Firing the watermark write before the held apply is a scoped defect.
      await h.hub.read.sql("insert into state_row (sheet, id, data) values ('harvest', 'p2/p2-lair', $1)", [JSON.stringify({ at: until })])
      expect(() => ordering(until)).toThrow()
      const premature = await at()
      expect(() => ordering(premature)).toThrow()
      await h.hub.read.sql("delete from state_row where sheet = 'harvest' and id = 'p2/p2-lair'")
      gate.open()
      const result = await outcome
      if (mode === "refused-resume") {
        expect(String(result.error ?? JSON.stringify(result.value))).toMatch(/refus|fail|incomplete/i)
        expect(await at()).not.toBe(until)
        const earlyCalls = calls.filter(text => text.includes("earliest-history-codeword")).length
        expect(earlyCalls).toBe(1)
        h.hub.scripted.setAnswer(({ text }) => { calls.push(text); return envelope(note(historicalRows.find(row => text.includes(row.text))!.text)) })
        await run(loadRegistry(h.hub.registryFile), "p2", from, until, edges)
        expect(calls.filter(text => text.includes("earliest-history-codeword"))).toHaveLength(earlyCalls)
      } else expect(result.error).toBeNull()
      if (mode === "conflict") {
        expect(readFileSync(join(h.vault.vaultDir, "life", "earliest-history-codeword.md"), "utf8")).toContain("Different existing fact.")
        expect(readFileSync(join(h.vault.vaultDir, "_needs-review.md"), "utf8")).toContain("earliest-history-codeword")
      }
      expect(await at()).toBe(until)
      const coverage = (texts: string[]) => { for (const row of historicalRows) expect(texts.some(text => text.includes(row.text))).toBe(true) }
      coverage(calls)
      for (const text of calls) expect(text).toContain(harvestPrompt("en"))
      expect(calls.filter(text => text.includes("final-history-one"))).toHaveLength(1)
      expect(calls.find(text => text.includes("final-history-one"))).toContain("final-history-three")
      expect(existsSync(join(h.vault.vaultDir, "life", "earliest-history-codeword.md"))).toBe(true)
      const lastNote = join(h.vault.vaultDir, "life", "final-history-one.md")
      const finalApplied = (file: string) => {
        expect(existsSync(file), "L09 final nonempty slice must reach real apply").toBe(true)
        expect(readFileSync(file, "utf8")).toContain("final-history-one")
      }
      expect(() => finalApplied(join(h.vault.vaultDir, "missing-final.md"))).toThrow()
      finalApplied(lastNote)
      const turns = await h.hub.read.sql("select detail from ledger_event where kind = 'turn' order by at")
      const bounds = turns.map((row: any) => row.detail.harvest).filter(Boolean)
      expect(bounds.length).toBeGreaterThanOrEqual(3)
      expect(bounds.at(-1).until).toBe(until)
      // All nonempty slices are disjoint and gaps are proved empty source days.
      for (let i = 1; i < bounds.length; i++) expect(Date.parse(bounds[i].from)).toBeGreaterThanOrEqual(Date.parse(bounds[i - 1].until))
      const generic = await readSlice({ stateDir: h.hub.stateDir, person: "p2", agent: "p2-lair", from: null, until })
      expect(() => coverage([generic.map(row => row.text).join("\n")])).toThrow()
      if (mode === "complete") {
        expect(calls).toHaveLength(4)
        const slices = result.value.slices
        expect(slices).toHaveLength(46)
        expect(slices[0].from).toBe(from)
        expect(slices.at(-1).until).toBe(until)
        for (let i = 1; i < slices.length; i++) expect(slices[i].from).toBe(slices[i - 1].until)
        expect(slices.filter((slice: any) => slice.lines === 0).length).toBe(42)
      }
      const count = calls.length
      await run(loadRegistry(h.hub.registryFile), "p2", from, until, edges)
      expect(calls).toHaveLength(count)
      expect(await h.hub.read.noticeRows()).toHaveLength(0)
      if (mode === "complete") {
        const end = new Date(Date.now() - 1000).toISOString()
        plantCanonical(h.hub.stateDir, "p2", "p2-lair", [{ at: end, direction: "in", from: "p2", text: "new demand fact" }])
        h.hub.scripted.setAnswer(() => "nothing")
        const runner = await runRunner({ runner: "runner-pi", registryFile: h.hub.registryFile, adapters: edges.adapters })
        try {
          await insertInbound(cluster, h.hub.db, { id: `harvest:p2-lair:${end}`, person: "p2", agent: "p2-lair", kind: "harvest", body: JSON.stringify({ from: until, until: end, reason: "demand", lines: 1, said: "harvest this" }) })
          expect(await observe(async () => (await h.hub.read.noticeRows()).length === 1, 7000)).toBe(true)
          expect((await h.hub.read.noticeRows())[0].body).toContain("nothing")
        } finally { await runner.stop() }
      }
    } finally { gate.open(); await pending?.catch(() => {}); await h.stop(); await cluster.stop() }
  } finally { f.stop() }
})

const gate = clockGate(15)
announceClock(gate, "ROLL-03 imported owner history exclusion")
for (const reason of ["quiet", "backstop", "demand"] as const) test.skipIf(!gate.ok)(`ROLL-03 ${reason} excludes owner history while permitting new content${clockSuffix(gate)}`, async () => {
  const cluster = await startCluster()
  const h = await stageHarvest(cluster, { harvest: { report: false }, hub: { tick_seconds: 1 }, registry: base => ({ ...base, agents: base.agents!.map(a => ({ ...a, runner: "runner-pi" })), run: [{ id: "runner-pi", kind: "runner", schedule: "always", memory_limit_mb: 512, child_memory_limit_mb: 512 }] }) })
  let runner: Awaited<ReturnType<typeof runRunner>> | undefined
  try {
    const boundary = new Date(Date.now() - 5 * 60000).toISOString()
    const end = new Date(Date.now() - 1000).toISOString()
    writeFileSync(h.hub.registryFile, readFileSync(h.hub.registryFile, "utf8").replace('id = "p1"\n', `id = "p1"\nhistory_harvest_after = ${JSON.stringify(boundary)}\n`))
    plantLine(h, { at: new Date(Date.now() - 10 * 60000).toISOString(), direction: "in", from: "p1", text: "excluded-owner-history" })
    plantLine(h, { at: end, direction: "in", from: "p1", text: "permitted-new-content" })
    h.hub.scripted.setAnswer(() => "nothing")
    runner = await runRunner({ runner: "runner-pi", registryFile: h.hub.registryFile, adapters: { [h.hub.adapterName]: h.hub.scripted.adapter } })
    await insertInbound(cluster, h.hub.db, { id: `harvest:p1-lair:${end}`, kind: "harvest", body: JSON.stringify({ from: null, until: end, reason, lines: 2, ...(reason === "demand" ? { said: "harvest this" } : {}) }) })
    expect(await observe(() => h.hub.scripted.fed().some(r => r.text.includes(harvestPrompt("en"))), 7000)).toBe(true)
    const prompt = h.hub.scripted.fed().filter(r => r.text.includes(harvestPrompt("en"))).map(r => r.text).join("\n")
    expect(prompt, "D-181 owner history exclusion must filter the actual harvest prompt").not.toContain("excluded-owner-history")
    expect(prompt).toContain("permitted-new-content")
    expect(await observe(async () => (await h.hub.read.harvestSheet()).length === 1)).toBe(true)
    if (reason === "demand") expect((await h.hub.read.noticeRows()).length).toBe(1)
    else expect(await h.hub.read.noticeRows()).toHaveLength(0)
    // Removing only the exclusion must make the same old content eligible.
    await runner.stop(); runner = undefined
    await h.hub.read.sql("delete from state_row where sheet = 'harvest'")
    writeFileSync(h.hub.registryFile, readFileSync(h.hub.registryFile, "utf8").replace(/^history_harvest_after = .*\n/m, ""))
    const second = new Date(Date.parse(end) + 1).toISOString()
    const count = h.hub.scripted.fed().length
    await insertInbound(cluster, h.hub.db, { id: `harvest:p1-lair:${second}`, kind: "harvest", body: JSON.stringify({ from: null, until: second, reason, lines: 2 }) })
    runner = await runRunner({ runner: "runner-pi", registryFile: h.hub.registryFile, adapters: { [h.hub.adapterName]: h.hub.scripted.adapter } })
    expect(await observe(() => h.hub.scripted.fed().slice(count).some(r => r.text.includes(harvestPrompt("en"))))).toBe(true)
    expect(h.hub.scripted.fed().slice(count).filter(r => r.text.includes(harvestPrompt("en"))).some(r => r.text.includes("excluded-owner-history"))).toBe(true)
  } finally { await runner?.stop(); await h.stop(); await cluster.stop() }
})
