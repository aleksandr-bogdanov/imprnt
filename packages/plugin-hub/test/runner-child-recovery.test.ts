import { afterAll, beforeAll, expect, test } from "bun:test"
import { startCluster, type Cluster } from "./helpers/cluster.ts"
import { stageHub, insertInbound, plantChatLine } from "./helpers/hub-fixture.ts"
import { stageHarvest, plantLine } from "./helpers/harvest-stage.ts"
import { controlledAdapter, observe, retrySettings, brokenStream } from "./helpers/rollout-runner.ts"
import { proveRolloutRunner } from "../live/prove-rollout-runner.ts"
import { fakeClaudeCli, healthyResult } from "./helpers/fake-cli.ts"
import { ending } from "./helpers/rollout-loop.ts"
import { claudeCode } from "../src/adapters/claude-code.ts"
import { runRunner } from "../src/runner/run.ts"
import { harvestRowId, encodeHarvestBody } from "../src/harvest/row.ts"
import { childGone } from "./helpers/scripted-adapter.ts"

let cluster: Cluster
beforeAll(async () => { await proveRolloutRunner(); cluster = await startCluster() })
afterAll(async () => { await cluster?.stop() })

for (const mode of ["exit", "eof", "parse"] as const) {
  test(`ROLL-09 AdapterSession.exited settles once on ${mode}`, async () => {
    const preset = { adapter: "claude-code", model: "synthetic", provider: "synthetic", effort: "medium", paid: "key" } as const
    const good = await claudeCode.start({ preset, sessionId: null, wrap: fakeClaudeCli([healthyResult("answer")]) })
    try { expect((await ending(good)).text).toBe("answer") } finally { await good.close() }
    const session = await claudeCode.start({ preset, sessionId: null, wrap: brokenStream(fakeClaudeCli([]), mode) })
    try {
      const exited = (session as unknown as { exited?: Promise<unknown> }).exited
      expect(exited, "D-175 AdapterSession.exited must exist").toBeInstanceOf(Promise)
      let settlements = 0
      void exited!.then(() => settlements++, () => settlements++)
      await session.feed({ id: "fault", text: "synthetic input" })
      expect(await observe(() => settlements === 1), "D-175 stream termination must settle exited").toBe(true)
      await session.close()
      expect(settlements).toBe(1)
    } finally { await session.close() }
  })
}

for (const phase of ["ordinary", "tail", "memory"] as const) {
  test(`ROLL-09 ${phase} death releases claims and progress and retries with tail while sibling PID survives`, async () => {
    // The defective edge is run first through the identical runner path.
    // Only its exited signal is suppressed. The recovery predicate must reject it.
    for (const defective of phase === "memory" ? [false] : [true, false]) {
      const it = await stageHub(cluster, {
        hub: { tick_seconds: 1 },
        agents: [{ id: "p2-lair", person: "p2", preset: "daily", runner: "runner-pi", door: "door-fake", chat: "0000000000" }],
        run: [{ id: "runner-pi", kind: "runner", schedule: "always", memory_limit_mb: 512, child_memory_limit_mb: 150 }],
        registry: base => ({ ...base, agents: base.agents!.map(a => ({ ...a, runner: "runner-pi" })) }),
      })
      retrySettings(it)
      plantChatLine({ stateDir: it.stateDir, text: "recovery-tail-codeword" })
      const edge = controlledAdapter(it.adapterName)
      edge.hold(m => phase === "tail" ? m.id === "p1-lair" : m.id === "interrupted")
      edge.suppressExit(defective)
      let runner: Awaited<ReturnType<typeof runRunner>> | undefined
      const runnerPid = process.pid
      try {
        runner = await runRunner({ runner: "runner-pi", registryFile: it.registryFile, adapters: { [it.adapterName]: edge.adapter } })
        await insertInbound(cluster, it.db, { id: "sibling-control", body: "sibling", person: "p2", agent: "p2-lair" })
        expect(await observe(async () => (await it.read.outbox()).some(r => r.inbound_id === "sibling-control"))).toBe(true)
        const sibling = edge.sessions.find(r => r.fed.some(m => m.id === "sibling-control"))!
        const siblingPid = sibling.session.pid
        await insertInbound(cluster, it.db, { id: "interrupted", body: "pending input" })
        expect(await observe(() => edge.sessions.some(r => r.fed.some(m => m.id === (phase === "tail" ? "p1-lair" : "interrupted"))))).toBe(true)
        const target = edge.sessions.find(r => r.fed.some(m => m.id === "p1-lair"))!
        edge.hold(() => false)
        if (phase === "memory") target.grow(200)
        else target.fail()
        expect(await observe(() => childGone(target.session.pid!)), "fault injection killed the owned child").toBe(true)
        const recovered = await observe(async () => (await it.read.sheet("agent_health")).some(r => r.id === "p1-lair" && typeof r.data.retry_at === "string"), 2500)
        const acceptance = () => expect(recovered, "D-175 child death must record agent-local retry_at").toBe(true)
        if (defective) { expect(acceptance).toThrow(); continue }
        acceptance()
        const health = (await it.read.sheet("agent_health")).find(r => r.id === "p1-lair")!
        const retryAt = Date.parse(String(health.data.retry_at))
        expect(Number.isFinite(retryAt)).toBe(true)
        expect((await it.read.inbound()).find(r => r.id === "interrupted")!.claimed_by).toBeNull()
        expect((await it.read.sheet("turn_progress")).filter(r => r.id === "interrupted")).toEqual([])
        expect(await observe(async () => (await it.read.outbox()).some(r => r.inbound_id === "interrupted"), 5000), "D-175 pending answer resumes").toBe(true)
        const successor = edge.sessions.find(r => r !== target && r.fed.some(m => m.id === "interrupted"))!
        expect(successor).toBeDefined()
        expect(successor.loop.starts()[0].at).toBeGreaterThanOrEqual(retryAt)
        expect(successor.fed[0].text).toContain("recovery-tail-codeword")
        expect(successor.session.pid).not.toBe(target.session.pid)
        await insertInbound(cluster, it.db, { id: "sibling-after", body: "still here", person: "p2", agent: "p2-lair" })
        expect(await observe(async () => (await it.read.outbox()).some(r => r.inbound_id === "sibling-after"))).toBe(true)
        expect(sibling.fed.some(m => m.id === "sibling-after")).toBe(true)
        expect(sibling.session.pid).toBe(siblingPid)
        expect(childGone(siblingPid!)).toBe(false)
        expect(process.pid).toBe(runnerPid)
        expect(await it.read.outageSheet()).toEqual([])
      } finally { await runner?.stop(); await edge.stop(); await it.stop() }
    }
  })
}

test("ROLL-09 harvest death releases wait without human stamps or household notices", async () => {
  const h = await stageHarvest(cluster, { hub: { tick_seconds: 1 } })
  const it = h.hub
  retrySettings(it)
  const edge = controlledAdapter(it.adapterName)
  edge.hold(m => m.id.startsWith("harvest:"))
  let runner: Awaited<ReturnType<typeof runRunner>> | undefined
  try {
    plantLine(h, { at: new Date(Date.now() - 2000).toISOString(), direction: "in", from: "p1", text: "synthetic harvest codeword" })
    runner = await runRunner({ runner: "runner-test", registryFile: it.registryFile, adapters: { [it.adapterName]: edge.adapter } })
    const until = new Date().toISOString()
    await insertInbound(cluster, it.db, { id: harvestRowId("p1-lair", until), kind: "harvest", body: encodeHarvestBody({ from: null, until, reason: "demand", lines: 1 }) })
    expect(await observe(() => edge.sessions.some(r => r.fed.some(m => m.id.startsWith("harvest:"))))).toBe(true)
    const target = edge.sessions.find(r => r.fed.some(m => m.id.startsWith("harvest:")))!
    const id = target.fed.find(m => m.id.startsWith("harvest:"))!.id
    target.fail()
    expect(await observe(async () => (await it.read.inbound()).some(r => r.id === id && r.claimed_by === null)), "D-175 harvest death must release its claim").toBe(true)
    expect((await it.read.ledger({ subject: id })).filter(r => ["acked", "started", "answered"].includes(r.kind))).toEqual([])
    expect(await it.read.outageSheet()).toEqual([])
    expect(await it.read.noticeRows()).toEqual([])
    edge.hold(() => false)
    await insertInbound(cluster, it.db, { id: "after-harvest", body: "ordinary work" })
    expect(await observe(async () => (await it.read.outbox()).some(r => r.inbound_id === "after-harvest"), 5000)).toBe(true)
  } finally { await runner?.stop(); await edge.stop(); await h.stop() }
})

test("ROLL-22 target-session recovery replaces only the requested generation and replay is harmless", async () => {
  const it = await stageHub(cluster, { hub: { tick_seconds: 1 }, agents: [
    { id: "p2-lair", person: "p2", preset: "daily", runner: "runner-pi", door: "door-fake", chat: "0000000000" },
  ], registry: base => ({ ...base, agents: base.agents!.map(a => ({ ...a, runner: "runner-pi" })) }) })
  const edge = controlledAdapter(it.adapterName)
  let runner: Awaited<ReturnType<typeof runRunner>> | undefined
  try {
    runner = await runRunner({ runner: "runner-pi", registryFile: it.registryFile, adapters: { [it.adapterName]: edge.adapter } })
    for (const person of ["p1", "p2"]) await insertInbound(cluster, it.db, { id: person, person, agent: `${person}-lair`, body: "control" })
    expect(await observe(async () => (await it.read.outbox()).length === 2)).toBe(true)
    const target = edge.sessions.find(r => r.fed.some(m => m.id === "p1"))!
    const sibling = edge.sessions.find(r => r.fed.some(m => m.id === "p2"))!
    // This is the session operation only. Authorization and durable request
    // frontends are plan 07. The handle spelling is proposed for the builder.
    const recover = (runner as unknown as { recoverAgent?: Function }).recoverAgent
    expect(typeof recover, "D-178 missing target-session recoverAgent seam").toBe("function")
    const request = { id: "synthetic-recovery", agent: "p1-lair" }
    await recover!.call(runner, request)
    expect(await observe(() => childGone(target.session.pid!))).toBe(true)
    await insertInbound(cluster, it.db, { id: "new-generation", body: "after recovery" })
    expect(await observe(async () => (await it.read.outbox()).some(r => r.inbound_id === "new-generation"))).toBe(true)
    const successor = edge.sessions.find(r => r.fed.some(m => m.id === "new-generation"))!
    await recover!.call(runner, request)
    expect(childGone(successor.session.pid!)).toBe(false)
    expect(childGone(sibling.session.pid!)).toBe(false)
    // Wrong-target mutation executes the same operation, aimed at the sibling.
    await recover!.call(runner, { id: "synthetic-wrong-target", agent: "p2-lair" })
    expect(await observe(() => childGone(sibling.session.pid!))).toBe(true)
    expect(() => expect(childGone(sibling.session.pid!)).toBe(false)).toThrow()
  } finally { await runner?.stop(); await edge.stop(); await it.stop() }
})
