// Only synthetic history is harvested. Login is an explicit private input.
import { beforeAll, expect, test } from "bun:test"
import { readFileSync, writeFileSync, readdirSync } from "node:fs"
import { isAbsolute, join } from "node:path"
import { seam, startCluster } from "../test/helpers/cluster.ts"
import { migrationFixture, migrationHarvestStage, historicalRows, inventory, from, until, plantTabHistory } from "../test/helpers/rollout-migration.ts"
import { proveMigrationFixtures } from "./prove-rollout-migration.ts"
import { loadRegistry } from "../src/registry/load.ts"
import { claudeCode } from "../src/adapters/claude-code.ts"
const manifestPath = process.env.HUB_ROLLOUT_HARVEST_MANIFEST
const reason = manifestPath ? "" : "requires declared live login and private harvest preset"
if (reason) console.log(`SKIP: ROLL-03 real historical harvest ${reason}`)
beforeAll(async () => { if (manifestPath) await proveMigrationFixtures() })
test.skipIf(Boolean(reason))(`ROLL-03 synthetic older history real login and real ingest${reason ? ` SKIP: ${reason}` : ""}`, async () => {
  expect(isAbsolute(manifestPath!)).toBe(true)
  const manifest = JSON.parse(readFileSync(manifestPath!, "utf8"))
  expect(manifest.login).toBe(true)
  expect(isAbsolute(manifest.registry)).toBe(true)
  const selected = loadRegistry(manifest.registry) as any
  const person = selected.people.find((p: any) => p.id === manifest.person)
  expect(person).toBeDefined()
  const preset = selected.data.presets[person.harvester]
  expect(preset.adapter).toBe("claude-code")
  const run = (await seam("src/migrate/harvest.ts")).catchUpHarvest as Function
  const convert = (await seam("src/migrate/chatlog.ts")).convertV2Chatlog as Function
  const f = migrationFixture()
  const cluster = await startCluster()
  const h = await migrationHarvestStage(cluster)
  try {
    const files = plantTabHistory(f.roots[1].root, historicalRows.map(row => ({ ...row, text: row.text + ". Synthetic fact: the archive retention period is forty-five days." })))
    await convert({ ...f.logManifest, sources: [f.roots[1]], state_dir: h.hub.stateDir, inventory: inventory([f.tab, ...files]) })
    // Keep all state and vault paths synthetic. Select only the declared preset
    // and its credential reference from the private registry.
    const registry = loadRegistry(h.hub.registryFile) as any
    registry.data.presets.harvest = preset
    registry.credentials = selected.credentials.filter((c: any) => c.id === preset.credential)
    registry.data.credentials = registry.credentials
    expect(registry.credentials).toHaveLength(1)
    const beforeManifest = JSON.parse(readFileSync(join(h.vault.vaultDir, ".manifest.json"), "utf8"))
    await run(registry, "p2", from, until, { adapters: { "claude-code": claudeCode } })
    expect((await h.hub.read.harvestSheet())[0].data.at).toBe(until)
    const notes = readdirSync(h.vault.vaultDir, { recursive: true }).map(String).filter(n => n.endsWith(".md") && !n.includes("CLAUDE"))
    expect(notes.length).toBeGreaterThan(0)
    const filed = JSON.parse(readFileSync(join(h.vault.vaultDir, ".manifest.json"), "utf8"))
    expect(Object.keys(filed).filter(key => key.startsWith("apply:sha256:") && !(key in beforeManifest)).length).toBeGreaterThan(0)
    const turns = await h.hub.read.sql("select detail from ledger_event where kind = 'turn'")
    expect(turns.length).toBeGreaterThan(0)
    expect(turns.some((r: any) => Number(r.detail.input_tokens) > 0)).toBe(true)
    expect(await h.hub.read.noticeRows()).toHaveLength(0)
  } finally { await h.stop(); await cluster.stop(); f.stop() }
})
