import { afterAll, beforeAll, expect, test } from "bun:test"
import { startCluster, type Cluster } from "./helpers/cluster.ts"
import { stageHub, insertInbound } from "./helpers/hub-fixture.ts"
import { controlledAdapter, observe, editAgent } from "./helpers/rollout-runner.ts"
import { proveRolloutRunner } from "../live/prove-rollout-runner.ts"
import { expectedPresetId } from "./helpers/preset-oracle.ts"
import { runRunner } from "../src/runner/run.ts"

let cluster: Cluster
beforeAll(async () => { await proveRolloutRunner(); cluster = await startCluster() })
afterAll(async () => { await cluster?.stop() })

test("ROLL-23 existing agent changes named preset only after the current turn with unchanged runner PID", async () => {
  for (const defective of [true, false]) {
  const it = await stageHub(cluster, { hub: { tick_seconds: 1 }, registry: base => ({
    ...base, presets: { ...base.presets, alternate: { ...base.presets!.daily, model: "synthetic-alternate" } },
  }) })
  const edge = controlledAdapter(it.adapterName)
  edge.hold(m => m.id === "before")
  let runner: Awaited<ReturnType<typeof runRunner>> | undefined
  const pid = process.pid
  try {
    runner = await runRunner({ runner: "runner-test", registryFile: it.registryFile, adapters: { [it.adapterName]: edge.adapter } })
    await insertInbound(cluster, it.db, { id: "before", body: "hold this turn" })
    expect(await observe(() => edge.sessions.some(r => r.fed.some(m => m.id === "before")))).toBe(true)
    const original = edge.sessions.find(r => r.fed.some(m => m.id === "before"))!
    editAgent(it.registryFile, "p1-lair", { preset: "alternate" })
    await Bun.sleep(1200)
    expect(original.closed).toBe(false)
    edge.hold(() => false)
    original.loop.endTurn()
    expect(await observe(async () => (await it.read.outbox()).some(r => r.inbound_id === "before"))).toBe(true)
    // A stale next-turn snapshot is the cached-reference mutation.
    if (defective) editAgent(it.registryFile, "p1-lair", { preset: "daily" })
    await insertInbound(cluster, it.db, { id: "after", body: "new preset" })
    expect(await observe(async () => (await it.read.outbox()).some(r => r.inbound_id === "after"))).toBe(true)
    const records = await it.read.ledger({ stream: "turn" })
    const first = records.find(r => r.subject === "before")!.detail
    const second = records.find(r => r.subject === "after")!.detail
    const oldId = expectedPresetId(original.preset as unknown as Record<string, string>)
    const newId = expectedPresetId({ ...original.preset, model: "synthetic-alternate" } as unknown as Record<string, string>)
    expect(first.preset_id).toBe(oldId)
    expect(first.preset).toBe("daily")
    const acceptance = (detail: Record<string, unknown>) => {
      expect(detail.preset_id, "D-175 next turn must use the new named preset").toBe(newId)
      expect(detail.preset).toBe("alternate")
    }
    if (defective) { expect(() => acceptance(second)).toThrow(); continue }
    acceptance(second)
    expect(edge.sessions.find(r => r.fed.some(m => m.id === "after"))!.preset.model).toBe("synthetic-alternate")
    expect((await it.read.outbox()).length).toBe(2)
    expect(process.pid).toBe(pid)
    expect((await it.read.ledger({ stream: "runner", kind: "connected" })).length).toBe(1)
  } finally { await runner?.stop(); await edge.stop(); await it.stop() }
  }
})
