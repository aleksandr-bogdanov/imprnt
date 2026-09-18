// The one-time history catch-up and an ordinary harvest of the same chat, run in
// either order. Every input is a disposable synthetic fixture.
//
// The catch-up is the only harvest that reaches past the ordinary thirty-day
// first slice. When an ordinary harvest has already moved the chat's watermark,
// a catch-up starting there reaches none of the older lines, so it must refuse
// by name rather than report an empty success.
import { expect, test } from "bun:test"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { seam, startCluster, hubPath } from "./helpers/cluster.ts"
import { migrationFixture, migrationHarvestStage, historicalRows, from, until, inventory, note, envelope, plantCanonical, plantTabHistory, privateJson } from "./helpers/rollout-migration.ts"
import { loadRegistry } from "../src/registry/load.ts"
import { SLICE_MAX_DAYS } from "../src/harvest/slice.ts"
import { harvestPrompt } from "../src/harvest/prompt.ts"
import { runRunner } from "../src/runner/run.ts"
import { insertInbound } from "./helpers/hub-fixture.ts"
import { observe } from "./helpers/rollout-runner.ts"

async function catchup() { return (await seam("src/migrate/harvest.ts")).catchUpHarvest as (registry: any, person: string, from: string, until: string, edges?: any) => Promise<any> }

/** Every file under a directory with its bytes, so "filed nothing" is a comparison. */
function tree(dir: string): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (at: string) => {
    for (const name of readdirSync(at).sort()) {
      const path = join(at, name)
      if (statSync(path).isDirectory()) walk(path)
      else out[path] = readFileSync(path, "utf8")
    }
  }
  walk(dir)
  return out
}

for (const order of ["catch-up first", "ordinary harvest first"] as const) test(`ROLL-03 history catch-up with ${order}: old lines are filed or the catch-up refuses by name`, async () => {
  const f = migrationFixture()
  const cluster = await startCluster()
  const h = await migrationHarvestStage(cluster)
  let runner: Awaited<ReturnType<typeof runRunner>> | undefined
  try {
    const run = await catchup()
    const convert = (await seam("src/migrate/chatlog.ts")).convertV2Chatlog as Function
    const files = plantTabHistory(f.roots[1].root, historicalRows)
    await convert({ ...f.logManifest, sources: [f.roots[1]], state_dir: h.hub.stateDir, inventory: inventory([f.tab, ...files]) })
    // The whole converted history is older than an ordinary first slice reaches.
    expect(Date.now() - Date.parse(until)).toBeGreaterThan(SLICE_MAX_DAYS * 86_400_000)

    const calls: string[] = []
    h.hub.scripted.setAnswer(({ text }) => {
      if (!text.includes(harvestPrompt("en"))) return "nothing"
      calls.push(text)
      const marker = historicalRows.find(row => text.includes(row.text))?.text
      return marker ? envelope(note(marker, "Synthetic history retained.")) : "nothing"
    })
    const edges = { adapters: { [h.hub.adapterName]: h.hub.scripted.adapter } }
    const earliest = join(h.vault.vaultDir, "life", "earliest-history-codeword.md")
    const mark = async () => (await h.hub.read.harvestSheet())[0]?.data ?? null

    // One new line after the cutover, harvested the ordinary way.
    const end = new Date(Date.now() - 1000).toISOString()
    plantCanonical(h.hub.stateDir, "p2", "p2-lair", [{ at: end, direction: "in", from: "p2", text: "fresh-after-cutover" }])
    const ordinary = async () => {
      runner = await runRunner({ runner: "runner-pi", registryFile: h.hub.registryFile, adapters: edges.adapters })
      try {
        await insertInbound(cluster, h.hub.db, { id: `harvest:p2-lair:${end}`, person: "p2", agent: "p2-lair", kind: "harvest", body: JSON.stringify({ from: null, until: end, reason: "backstop", lines: 1 }) })
        expect(await observe(async () => (await mark())?.at === end, 15000), "the ordinary harvest must move the watermark").toBe(true)
      } finally { await runner.stop(); runner = undefined }
    }

    if (order === "catch-up first") {
      await run(loadRegistry(h.hub.registryFile), "p2", from, until, edges)
      expect((await mark())?.at).toBe(until)
      expect(existsSync(earliest), "the catch-up must file the oldest line").toBe(true)
      for (const row of historicalRows) expect(calls.some(text => text.includes(row.text))).toBe(true)
      await ordinary()
      const fresh = calls.filter(text => text.includes("fresh-after-cutover"))
      expect(fresh).toHaveLength(1)
      for (const row of historicalRows) expect(fresh[0]).not.toContain(row.text)
      return
    }

    await ordinary()
    // The ordinary first slice reached back thirty days and no further.
    expect(calls).toHaveLength(1)
    for (const row of historicalRows) expect(calls[0]).not.toContain(row.text)
    const count = calls.length
    const before = tree(h.vault.root)
    const turns = async () => (await h.hub.read.sql("select count(*)::int as n from ledger_event where kind = 'turn'"))[0].n
    const turnsBefore = await turns()

    const refusal = await run(loadRegistry(h.hub.registryFile), "p2", from, until, edges).then(() => null, error => error)
    expect(refusal, "a catch-up that starts after the history it was asked for must refuse").not.toBeNull()
    expect(refusal.name).toBe("CatchUpRefused")
    expect(String(refusal.message)).toContain("p2/p2-lair")
    expect(String(refusal.message)).toMatch(/not harvested/)

    const manifest = privateJson(join(f.dir, "harvest-manifest.json"), { version: 1, registry: h.hub.registryFile, person: "p2", from, until })
    const child = Bun.spawnSync([process.execPath, hubPath("scripts/harvest-v2.ts"), manifest], { stdout: "pipe", stderr: "pipe", timeout: 30000 })
    const said = child.stderr.toString()
    expect(child.exitCode, "the command must not report success over an empty range").toBe(1)
    expect(child.stdout.toString()).not.toContain("complete through")
    expect(said).toContain("p2/p2-lair")
    expect(said).toMatch(/not harvested/)

    // Nothing was filed, no model was asked, no turn was recorded, and the
    // watermark is where the ordinary harvest left it.
    expect(calls).toHaveLength(count)
    expect(existsSync(earliest)).toBe(false)
    expect(tree(h.vault.root)).toEqual(before)
    expect(await turns()).toBe(turnsBefore)
    expect((await mark())?.at).toBe(end)
  } finally { await runner?.stop(); await h.stop(); await cluster.stop(); f.stop() }
})
