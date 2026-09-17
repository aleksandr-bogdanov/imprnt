import { afterAll, beforeAll, expect, test } from "bun:test"
import { startCluster, type Cluster } from "./helpers/cluster.ts"
import { stageHub, insertInbound, superStore } from "./helpers/hub-fixture.ts"
import { controlledAdapter, observe, retrySettings } from "./helpers/rollout-runner.ts"
import { proveRolloutRunner } from "../live/prove-rollout-runner.ts"
import { runRunner } from "../src/runner/run.ts"
import { childGone } from "./helpers/scripted-adapter.ts"
import { runCheck } from "../src/check/run.ts"

let cluster: Cluster
beforeAll(async () => { await proveRolloutRunner(); cluster = await startCluster() })
afterAll(async () => { await cluster?.stop() })

for (const fault of ["start", "feed"] as const) test(`ROLL-10 ${fault} task failure records retry and serves next work without stale generation`, async () => {
  for (const defective of [true, false]) {
  const it = await stageHub(cluster, {
    hub: { tick_seconds: 1 },
    agents: [{ id: "p2-lair", person: "p2", preset: "sibling", runner: "runner-pi", door: "door-fake", chat: "0000000000" }],
    registry: base => ({ ...base, presets: { ...base.presets, sibling: { ...base.presets!.daily, model: "synthetic-sibling" } }, agents: base.agents!.map(a => ({ ...a, runner: "runner-pi" })) }),
  })
  retrySettings(it)
  const edge = controlledAdapter(it.adapterName)
  if (fault === "start") edge.failStarts(1, options => options.preset.model !== "synthetic-sibling")
  let thrown = false
  if (fault === "feed") edge.throwFeed(m => {
    if (m.id !== "fault" || thrown) return false
    thrown = true
    return true
  })
  let runner: Awaited<ReturnType<typeof runRunner>> | undefined
  const pid = process.pid
  const store = await superStore(cluster, it.db)
  const originalDelete = Map.prototype.delete
  if (defective) Map.prototype.delete = function(key: unknown) {
    const value = this.get(key)
    if (key === "p1-lair" && value?.agent?.id === key && "done" in value && "serving" in value) return true
    return originalDelete.call(this, key)
  }
  try {
    runner = await runRunner({ runner: "runner-pi", registryFile: it.registryFile, adapters: { [it.adapterName]: edge.adapter } })
    await insertInbound(cluster, it.db, { id: "sibling", person: "p2", agent: "p2-lair", body: "control" })
    expect(await observe(async () => (await it.read.outbox()).some(r => r.inbound_id === "sibling"))).toBe(true)
    const sibling = edge.sessions.find(r => r.fed.some(m => m.id === "sibling"))!
    await insertInbound(cluster, it.db, { id: "fault", body: "retry this" })
    expect(await observe(async () => (await it.read.ledger()).some(r => JSON.stringify(r.detail).includes(`synthetic-task-${fault}-failure`)))).toBe(true)
    const health = (await it.read.sheet("agent_health")).find(r => r.id === "p1-lair")
    const healthyRetry = (row: typeof health) => {
      expect(row, "D-175 failed task must have agent_health").toBeDefined()
      expect(Number.isFinite(Date.parse(String(row!.data.retry_at))), "D-175 failed task has a retry deadline").toBe(true)
      expect(row!.data.status).not.toBe("serving")
    }
    const accepting = async () => {
      healthyRetry(health)
      expect(await observe(async () => (await it.read.outbox()).some(r => r.inbound_id === "fault"), 5000), "D-175 finished generation must leave the live map").toBe(true)
    }
    // Suppress deletion only for the runner's own Live-shaped target entry.
    // A finished task is left in the production map. The same health and
    // next-answer predicate must reject it.
    if (defective) { await expect(accepting()).rejects.toThrow(); continue }
    healthyRetry(health)
    const findings = await runCheck({ registryFile: it.registryFile, machine: "pi", store, os: null, kernel: null })
    expect(findings.some(f => f.subject === "p1-lair" && f.says.includes(`synthetic-task-${fault}-failure`)), "D-175 task failure must be a named finding").toBe(true)
    const retryAt = Date.parse(String(health!.data.retry_at))
    const diary = await it.read.ledger({ subject: "p1-lair" })
    expect(diary.some(r => r.detail.retry_at === health!.data.retry_at)).toBe(true)
    expect(await observe(async () => (await it.read.outbox()).some(r => r.inbound_id === "fault"), 5000), "D-175 finished generation must leave the live map").toBe(true)
    const successor = edge.sessions.find(r => r.fed.some(m => m.id === "fault") && !r.closed)!
    expect(successor.loop.starts()[0].at).toBeGreaterThanOrEqual(retryAt)
    // Repeating old cleanup must not delete a replacement generation.
    for (const old of edge.sessions.filter(r => r !== successor && r !== sibling)) await old.session.close()
    await insertInbound(cluster, it.db, { id: "after", body: "next answer" })
    await insertInbound(cluster, it.db, { id: "sibling-after", person: "p2", agent: "p2-lair", body: "still answering" })
    expect(await observe(async () => (await it.read.outbox()).filter(r => ["after", "sibling-after"].includes(r.inbound_id)).length === 2)).toBe(true)
    expect(successor.fed.some(m => m.id === "after")).toBe(true)
    expect(sibling.fed.some(m => m.id === "sibling-after")).toBe(true)
    expect(childGone(sibling.session.pid!)).toBe(false)
    expect(process.pid).toBe(pid)
  } finally { Map.prototype.delete = originalDelete; await runner?.stop(); await edge.stop(); await store.close(); await it.stop() }
  }
})
