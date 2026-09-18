// Explicit opt-in only. Manifest {registry, runner, login:true, budget_mb,
// idle_seconds}. The registry is private. Real modes, presets and credentials
// are selected from it. Work, state and filing use synthetic scratch fixtures.
import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { isAbsolute } from "node:path"
import { loadRegistry } from "../src/registry/load.ts"
import { runRunner } from "../src/runner/run.ts"
import { claudeCode } from "../src/adapters/claude-code.ts"
import { startCluster } from "../test/helpers/cluster.ts"
import { stageHarvest, plantLine } from "../test/helpers/harvest-stage.ts"
import { insertInbound, plantChatLine } from "../test/helpers/hub-fixture.ts"
import { childGone, residentBytes } from "../test/helpers/scripted-adapter.ts"
import { observe, editAgent, treeBytes } from "../test/helpers/rollout-runner.ts"
import { proveRolloutRunner } from "./prove-rollout-runner.ts"
import { harvestRowId, encodeHarvestBody } from "../src/harvest/row.ts"
import type { AdapterSession } from "../src/adapters/types.ts"

const path = process.env.HUB_ROLLOUT_FLEET_MANIFEST
const reason = path ? "" : "requires declared live login and private fleet registry"
if (reason) console.log(`SKIP: ${reason} (ROLL-14 real fleet measurement)`)
test.skipIf(Boolean(reason))(`ROLL-14 real converted fleet peak idle release and wake${reason ? ` SKIP: ${reason}` : ""}`, async () => {
  await proveRolloutRunner()
  expect(isAbsolute(path!)).toBe(true)
  const manifest = JSON.parse(readFileSync(path!, "utf8"))
  expect(manifest.login).toBe(true)
  expect(isAbsolute(manifest.registry)).toBe(true)
  const privateRegistry = loadRegistry(manifest.registry) as any
  const selected = privateRegistry.agents.filter((a: any) => a.runner === manifest.runner)
  expect(selected.length).toBeGreaterThanOrEqual(3)
  expect(manifest.budget_mb).toBeGreaterThan(0)
  const cluster = await startCluster()
  let h: Awaited<ReturnType<typeof stageHarvest>> | undefined
  let runner: Awaited<ReturnType<typeof runRunner>> | undefined
  const sessions: AdapterSession[] = []
  let sample: ReturnType<typeof setInterval> | undefined
  let peak = 0
  try {
    h = await stageHarvest(cluster, { hub: { tick_seconds: 1 },
      agents: selected.slice(1).map((a: any, i: number) => ({ id: `p1-lair-${i + 1}`, person: "p1", preset: `fleet-${i + 1}`, runner: "runner-pi", door: "door-fake", chat: "0000000000" })),
      registry: base => ({ ...base,
        credentials: privateRegistry.credentials,
        presets: { ...Object.fromEntries(selected.map((a: any, i: number) => [i === 0 ? "daily" : `fleet-${i}`, privateRegistry.data.presets[a.preset]])), harvest: privateRegistry.data.presets[privateRegistry.people[0].harvester] },
        agents: base.agents!.map((a, i) => ({ ...a, runner: "runner-pi",
          fragment: selected[i].fragment, tools: selected[i].tools,
          settings: selected[i].settings, mcp: selected[i].mcp,
        })),
        run: [{ id: "runner-pi", kind: "runner", schedule: "always", memory_limit_mb: 512, child_memory_limit_mb: manifest.budget_mb, child_memory_budget_mb: manifest.budget_mb, max_active_children: 4 } as any],
      }),
    })
    for (let i = 0; i < selected.length; i++) editAgent(h.hub.registryFile, i === 0 ? "p1-lair" : `p1-lair-${i}`, { mode: selected[i].mode ?? "resident", idle_seconds: manifest.idle_seconds })
    const adapter = { ...claudeCode, async start(options: Parameters<typeof claudeCode.start>[0]) {
      const session = await claudeCode.start(options)
      sessions.push(session)
      return session
    } }
    const it = h.hub
    plantLine(h, { at: new Date(Date.now() - 2000).toISOString(), direction: "in", from: "p1", text: "Synthetic fleet note. Nothing needs filing." })
    sample = setInterval(() => {
      peak = Math.max(peak, sessions.filter(s => s.pid && !childGone(s.pid)).reduce((sum, s) => sum + treeBytes(s.pid!), 0))
    }, 100)
    runner = await runRunner({ runner: "runner-pi", registryFile: it.registryFile, adapters: { "claude-code": adapter } })
    await Bun.sleep(300)
    const idle = peak
    const until = new Date().toISOString()
    await Promise.all([
      insertInbound(cluster, it.db, { id: "live-a", agent: "p1-lair-1", body: "Reply with synthetic-a only." }),
      insertInbound(cluster, it.db, { id: "live-b", agent: "p1-lair-2", body: "Reply with synthetic-b only." }),
      insertInbound(cluster, it.db, { id: harvestRowId("p1-lair", until), kind: "harvest", body: encodeHarvestBody({ from: null, until, reason: "demand", lines: 1 }) }),
    ])
    expect(await observe(async () => (await it.read.inbound()).every(r => r.state === "answered"), 60000)).toBe(true)
    expect(peak).toBeGreaterThan(0)
    expect(peak).toBeLessThanOrEqual(manifest.budget_mb * 1024 * 1024)
    const release = performance.now()
    const residents = selected.filter((a: any) => (a.mode ?? "resident") === "resident").length
    expect(await observe(() => sessions.filter(s => s.pid && !childGone(s.pid)).length === residents, manifest.idle_seconds * 1000 + 3000)).toBe(true)
    const releaseMs = performance.now() - release
    plantChatLine({ stateDir: it.stateDir, agent: "p1-lair-1", text: "synthetic-fleet-codeword" })
    const wake = performance.now()
    await insertInbound(cluster, it.db, { id: "live-wake", agent: "p1-lair-1", body: "Repeat the synthetic fleet codeword from your supplied history." })
    expect(await observe(async () => (await it.read.outbox()).some(r => r.inbound_id === "live-wake"), 60000)).toBe(true)
    expect((await it.read.outbox()).find(r => r.inbound_id === "live-wake")!.body).toContain("synthetic-fleet-codeword")
    console.log(JSON.stringify({ measurement: "real-fleet", peak_bytes: peak, idle_baseline_bytes: idle, release_ms: releaseMs, wake_ms: performance.now() - wake }))
  } finally { clearInterval(sample); await runner?.stop(); await Promise.all(sessions.map(s => s.close())); await h?.stop(); await cluster.stop() }
}, 180000)
