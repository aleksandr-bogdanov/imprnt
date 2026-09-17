import { afterAll, beforeAll, expect, test } from "bun:test"
import { readFileSync, writeFileSync } from "node:fs"
import { startCluster, statementWatch, type Cluster } from "./helpers/cluster.ts"
import { stageHub, insertInbound, plantChatLine } from "./helpers/hub-fixture.ts"
import { stageHarvest, plantLine } from "./helpers/harvest-stage.ts"
import { controlledAdapter, observe, editAgent, processTree, treeBytes } from "./helpers/rollout-runner.ts"
import { proveRolloutRunner } from "../live/prove-rollout-runner.ts"
import { runRunner } from "../src/runner/run.ts"
import { childGone, residentBytes } from "./helpers/scripted-adapter.ts"
import { encodeHarvestBody, harvestRowId } from "../src/harvest/row.ts"
import { loadRegistry } from "../src/registry/load.ts"

let cluster: Cluster
beforeAll(async () => { await proveRolloutRunner(); cluster = await startCluster({ settings: { log_statement: "'all'", log_line_prefix: "'pid=%p '" } }) })
afterAll(async () => { await cluster?.stop() })

for (const behavior of ["no eager child", "idle release", "safe sleep"] as const) test(`ROLL-14 ${behavior} and wake use registry without runner restart`, async () => {
  for (const defective of behavior === "no eager child" ? [false] : [true, false]) {
  const it = await stageHub(cluster, { hub: { tick_seconds: 1 } })
  editAgent(it.registryFile, "p1-lair", { mode: "on-demand", idle_seconds: 1 })
  plantChatLine({ stateDir: it.stateDir, text: "wake-tail-codeword" })
  const edge = controlledAdapter(it.adapterName)
  edge.suppressClose(defective)
  let runner: Awaited<ReturnType<typeof runRunner>> | undefined
  const pid = process.pid
  try {
    runner = await runRunner({ runner: "runner-test", registryFile: it.registryFile, adapters: { [it.adapterName]: edge.adapter } })
    if (behavior === "no eager child") expect(edge.sessions.length, "D-175 on-demand has no child before eligible work").toBe(0)
    if (behavior === "safe sleep") edge.hold(m => m.id === "first")
    await insertInbound(cluster, it.db, { id: "first", body: "first wake" })
    expect(await observe(() => edge.sessions.some(r => r.fed.some(m => m.id === "first")))).toBe(true)
    const original = edge.sessions.find(r => r.fed.some(m => m.id === "first"))!
    expect(original.fed[0].text).toContain("wake-tail-codeword")
    if (behavior === "safe sleep") {
      editAgent(it.registryFile, "p1-lair", { sleeping: true })
      await Bun.sleep(1200)
      expect(original.closed).toBe(false)
      edge.hold(() => false)
      original.loop.endTurn()
    }
    expect(await observe(async () => (await it.read.outbox()).some(r => r.inbound_id === "first"))).toBe(true)
    const released = await observe(() => childGone(original.session.pid!), 3500)
    const releasePredicate = () => expect(released, "D-175 idle or sleeping child must be released").toBe(true)
    if (defective) { expect(releasePredicate).toThrow(); continue }
    releasePredicate()
    await insertInbound(cluster, it.db, { id: "second", body: "second wake" })
    if (behavior === "safe sleep") {
      await Bun.sleep(1200)
      expect((await it.read.inbound()).find(r => r.id === "second")!.claimed_by).toBeNull()
      expect(edge.sessions.length).toBe(1)
      editAgent(it.registryFile, "p1-lair", { sleeping: false })
    }
    const wake = performance.now()
    expect(await observe(async () => (await it.read.outbox()).some(r => r.inbound_id === "second"), 5000)).toBe(true)
    const next = edge.sessions.find(r => r.fed.some(m => m.id === "second"))!
    expect(next.session.pid).not.toBe(original.session.pid)
    expect(next.fed[0].text).toContain("wake-tail-codeword")
    expect(process.pid).toBe(pid)
    console.log(JSON.stringify({ measurement: behavior, wake_ms: performance.now() - wake }))
  } finally { await runner?.stop(); await edge.stop(); await it.stop() }
  }
})

for (const os of ["linux", "darwin"]) {
  const reason = process.platform === os ? "" : `requires ${os === "linux" ? "Linux" : "macOS"}`
  if (reason) console.log(`SKIP: ${reason} (ROLL-14 native fleet memory)`)
  test.skipIf(Boolean(reason))(`ROLL-09 ROLL-14 ${os} real monitor counts descendant totals${reason ? ` SKIP: ${reason}` : ""}`, async () => {
    const it = await stageHub(cluster, { hub: { tick_seconds: 1 },
      run: [{ id: "runner-pi", kind: "runner", schedule: "always", memory_limit_mb: 512, child_memory_limit_mb: 150 }],
      registry: base => ({ ...base, agents: base.agents!.map(a => ({ ...a, runner: "runner-pi" })) }),
    })
    const edge = controlledAdapter(it.adapterName, true)
    let runner: Awaited<ReturnType<typeof runRunner>> | undefined
    try {
      runner = await runRunner({ runner: "runner-pi", registryFile: it.registryFile, adapters: { [it.adapterName]: edge.adapter } })
      const row = edge.sessions[0]
      expect(await observe(() => processTree(row.session.pid!).length === 3)).toBe(true)
      await insertInbound(cluster, it.db, { id: "small", body: "under limit control" })
      expect(await observe(async () => (await it.read.outbox()).some(r => r.inbound_id === "small"))).toBe(true)
      expect(treeBytes(row.session.pid!)).toBeLessThan(150 * 1024 * 1024)
      row.grow(80)
      expect(await observe(() => treeBytes(row.session.pid!) > 150 * 1024 * 1024), "controlled subtree must exceed the declared limit").toBe(true)
      const readings = processTree(row.session.pid!).map(residentBytes)
      expect(Math.max(...readings)).toBeLessThan(150 * 1024 * 1024)
      // A largest-process-only monitor is the scoped defective implementation.
      const overLimit = (bytes: number) => expect(bytes > 150 * 1024 * 1024).toBe(true)
      expect(() => overLimit(Math.max(...readings))).toThrow()
      overLimit(readings.reduce((a, b) => a + b, 0))
      expect(await observe(() => childGone(row.session.pid!), 3500), "D-175 monitor must enforce descendant total").toBe(true)
      const killed = await it.read.ledger({ stream: "memory", kind: "killed.child" })
      expect(killed).toHaveLength(1)
      expect(Number(killed[0].detail.reading_bytes)).toBeGreaterThan(150 * 1024 * 1024)
    } finally { await runner?.stop(); await edge.stop(); await it.stop() }
  })
  for (const bound of ["children", "aggregate"] as const) test.skipIf(Boolean(reason))(`ROLL-14 ${os} eighteen-agent fleet ${bound} admission and measured memory with harvest${reason ? ` SKIP: ${reason}` : ""}`, async () => {
    const h = await stageHarvest(cluster, { hub: { tick_seconds: 1 },
      agents: Array.from({ length: 17 }, (_, i) => ({ id: `p1-lair-${i + 1}`, person: "p1", preset: "daily", runner: "runner-pi", door: "door-fake", chat: "0000000000" })),
      run: [{ id: "runner-pi", kind: "runner", schedule: "always", memory_limit_mb: 512, child_memory_limit_mb: 150 }],
      registry: base => ({ ...base, people: base.people!.map(p => ({ ...p, tree: undefined })), agents: base.agents!.map(a => ({ ...a, runner: "runner-pi" })) }),
    })
    const it = h.hub
    const maxChildren = bound === "children" ? 3 : 18
    const budgetMb = bound === "children" ? 600 : 400
    for (let i = 1; i <= 17; i++) editAgent(it.registryFile, `p1-lair-${i}`, { mode: "on-demand", idle_seconds: 1 })
    writeFileSync(it.registryFile, readFileSync(it.registryFile, "utf8").replace('id = "runner-pi"\n', `id = "runner-pi"\nmax_active_children = ${maxChildren}\nchild_memory_budget_mb = ${budgetMb}\n`))
    const edge = controlledAdapter(it.adapterName, true)
    edge.hold(m => m.id === "human-a" || m.id === "human-b" || m.id.startsWith("harvest:"))
    let runner: Awaited<ReturnType<typeof runRunner>> | undefined
    let sampler: ReturnType<typeof setInterval> | undefined
    let peak = 0, peakChildren = 0
    try {
      const budget = (count: number, bytes: number) => {
        expect(count, "D-175 max_active_children must include harvest").toBeLessThanOrEqual(maxChildren)
        expect(bytes, "D-175 aggregate child budget must be enforced").toBeLessThanOrEqual(budgetMb * 1024 * 1024)
      }
      // Disabled admission: the same controlled processes are started without
      // asking the runner for capacity. Measure them, reject, then reap them.
      for (let i = 0; i < 4; i++) await edge.adapter.start({ preset: loadRegistry(it.registryFile).presets.daily, sessionId: null })
      expect(await observe(() => edge.sessions.every(r => processTree(r.session.pid!).length === 3))).toBe(true)
      for (const row of edge.sessions) row.grow(os === "linux" ? 0 : 32)
      if (bound === "aggregate") expect(await observe(() => edge.sessions.reduce((sum, r) => sum + treeBytes(r.session.pid!), 0) > budgetMb * 1024 * 1024)).toBe(true)
      expect(() => budget(edge.sessions.length, edge.sessions.reduce((sum, r) => sum + treeBytes(r.session.pid!), 0))).toThrow()
      await edge.stop()
      edge.sessions.splice(0)
      plantLine(h, { at: new Date(Date.now() - 2000).toISOString(), direction: "in", from: "p1", text: "fleet harvest" })
      runner = await runRunner({ runner: "runner-pi", registryFile: it.registryFile, adapters: { [it.adapterName]: edge.adapter } })
      const sample = () => {
        const alive = edge.sessions.filter(r => !childGone(r.session.pid!))
        peakChildren = Math.max(peakChildren, alive.length)
        peak = Math.max(peak, alive.reduce((sum, r) => sum + treeBytes(r.session.pid!), 0))
      }
      expect(await observe(() => edge.sessions.every(r => processTree(r.session.pid!).length === 3))).toBe(true)
      sample()
      const idleBaseline = peak
      sampler = setInterval(sample, 50)
      budget(peakChildren, peak)
      const until = new Date().toISOString()
      await Promise.all([
        insertInbound(cluster, it.db, { id: "human-a", agent: "p1-lair-1", body: "first simultaneous human" }),
        insertInbound(cluster, it.db, { id: "human-b", agent: "p1-lair-2", body: "second simultaneous human" }),
        insertInbound(cluster, it.db, { id: harvestRowId("p1-lair", until), kind: "harvest", body: encodeHarvestBody({ from: null, until, reason: "demand", lines: 1 }) }),
      ])
      await observe(() => edge.sessions.length >= 3)
      for (const row of edge.sessions.filter(r => !r.closed)) row.grow(os === "linux" ? 0 : 32)
      await Bun.sleep(2200)
      sample()
      budget(peakChildren, peak)
      const waiting = (await it.read.inbound()).filter(r => !edge.sessions.some(s => s.fed.some(m => m.id === r.id)))
      expect(waiting.length).toBeGreaterThan(0)
      expect(waiting.every(r => r.claimed_by === null)).toBe(true)
      clearInterval(sampler)
      // No observer SQL or memory sampler inside this capacity-wait window.
      // The monitor is still free to read native memory on its own tick.
      await Bun.sleep(250)
      const watch = await statementWatch(cluster, [await it.read.pid()])
      await Bun.sleep(1200)
      expect(await watch.count(), "D-175 capacity wait must not poll the store").toBe(0)
      // All capacity observations are outside the shipped protected windows.
      expect((await it.read.ledger()).some(r => JSON.stringify(r.detail).includes("admission"))).toBe(true)
      edge.hold(() => false)
      for (const row of edge.sessions) { row.loop.setAnswer(() => "nothing"); row.loop.endTurn() }
      expect(await observe(async () => (await it.read.inbound()).every(r => r.state === "answered"), 8000)).toBe(true)
      const release = performance.now()
      expect(await observe(() => edge.sessions.filter(r => !childGone(r.session.pid!)).length === 1, 5000)).toBe(true)
      const releaseMs = performance.now() - release
      plantChatLine({ stateDir: it.stateDir, agent: "p1-lair-1", text: "fleet-wake-codeword" })
      const wake = performance.now()
      await insertInbound(cluster, it.db, { id: "wake", agent: "p1-lair-1", body: "wake again" })
      expect(await observe(async () => (await it.read.outbox()).some(r => r.inbound_id === "wake"))).toBe(true)
      expect(edge.sessions.findLast(r => r.fed.some(m => m.id === "wake"))!.fed[0].text).toContain("fleet-wake-codeword")
      console.log(JSON.stringify({ measurement: "synthetic-fleet", peak_bytes: peak, idle_baseline_bytes: idleBaseline, release_ms: releaseMs, wake_ms: performance.now() - wake }))
    } finally {
      clearInterval(sampler)
      edge.hold(() => false)
      const releaseTurns = () => {
        for (const row of edge.sessions) { row.loop.holdTurnEnd(false); row.loop.endTurn() }
      }
      releaseTurns()
      console.log("L11 fleet cleanup begins")
      const releasePendingStarts = setInterval(releaseTurns, 20)
      try {
        const stopped = runner?.stop() ?? Promise.resolve()
        let done = false
        void stopped.then(() => { done = true })
        await Promise.race([stopped, Bun.sleep(2000)])
        if (!done) {
          // Shutdown can strand a LISTEN connection while a wait is opening.
          // This is teardown only, scoped to this fixture's database and role.
          await it.read.sql("select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and usename = 'hub_runner' and pid <> pg_backend_pid()", [it.db])
          console.log("L11 fleet cleanup disconnected its own remaining runner sessions")
        }
        await stopped
      } finally { clearInterval(releasePendingStarts) }
      console.log("L11 fleet runner stopped")
      await edge.stop()
      console.log("L11 fleet children stopped")
      await h.stop()
      console.log("L11 fleet cleanup released fixture turns before shutdown")
    }
  })
}
