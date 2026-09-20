// What a person asked for in a chat, and
// a child that died under a person's message, both come back to that person's
// chat through the door's ordinary notice path: `recoveryDone` or
// `recoveryRefused` for a chat `/recover`, and `agentRetry` once per message a
// dying child was working on. A CLI request and a harvest death tell no chat.
import { afterAll, beforeAll, expect, test } from "bun:test"
import { startCluster, seam, type Cluster } from "./helpers/cluster.ts"
import { rolloutStage } from "./helpers/rollout-stage.ts"
import { stageHub, insertInbound, superStore } from "./helpers/hub-fixture.ts"
import { controlledAdapter, observe, retrySettings } from "./helpers/rollout-runner.ts"
import { message } from "./helpers/rollout-ingress.ts"
import { runDoor } from "../src/door/run.ts"
import { runRunner } from "../src/runner/run.ts"
import { loadRegistry, readSetting } from "../src/registry/load.ts"
import { openStore, storeUrlAs } from "../src/store/connect.ts"

let cluster: Cluster
beforeAll(async () => { cluster = await startCluster() })
afterAll(async () => { await cluster?.stop() })

const samePerson = { registry: (base: any) => ({ ...base, agents: base.agents!.map((agent: any) => ({ ...agent, person: "p1" })) }) }

for (const source of ["chat", "cli"] as const) {
  test(`IMP-160 D-178 a ${source} recovery ${source === "chat" ? "tells the chat it came from that it completed" : "tells no chat"}`, async () => {
    const it = await rolloutStage(cluster, "telegram", samePerson)
    const store = await superStore(cluster, it.db)
    let door: Awaited<ReturnType<typeof runDoor>> | undefined
    let runner: Awaited<ReturnType<typeof runRunner>> | undefined
    try {
      runner = await runRunner({ runner: "runner-pi", registryFile: it.registryFile, adapters: { [it.adapterName]: it.scripted.adapter } })
      door = await runDoor({ door: "door-fake", registryFile: it.registryFile, platform: it.edge.platform })
      if (source === "chat") it.edge.batch([message("20", "/recover p2-lair")], "21")
      else {
        const { requestRecovery } = await seam("src/hub/control.ts")
        await (requestRecovery as Function)(store, { id: crypto.randomUUID(), source: "cli", actor: "operator", target_kind: "agent", target_id: "p2-lair", registryFile: it.registryFile })
      }
      expect(await observe(async () => (await it.read.sheet("control")).some(row => row.data.status === "applied"), 6000), "the runner applies the recovery").toBe(true)
      const said = () => it.edge.posts().filter(post => post.text.startsWith("[door] recovery"))
      if (source === "cli") {
        await Bun.sleep(1500)
        expect(said()).toEqual([])
        expect((await it.read.noticeRows()).filter(row => String(row.notice_key).startsWith("recovery"))).toEqual([])
        return
      }
      expect(await observe(() => said().some(post => post.text === "[door] recovery completed for p2-lair."), 5000),
        "the person who asked is told the recovery completed").toBe(true)
      expect(said().map(post => [post.chat, post.text])).toEqual([
        ["1000000001", "[door] recovery requested for p2-lair."],
        ["1000000001", "[door] recovery completed for p2-lair."],
      ])
      const notices = (await it.read.noticeRows()).filter(row => String(row.notice_key).startsWith("recovery"))
      expect(notices).toHaveLength(1)
      expect(notices[0]).toMatchObject({ person: "p1", agent: "p1-lair" })
      expect((await it.read.sql("select route from outbox where id = $1", [notices[0].id]))[0].route).toEqual({ door: "door-fake", chat: "1000000001" })
    } finally { await door?.stop(); await runner?.stop(); await store.sql.close(); await it.stop() }
  })
}

test("IMP-160 D-178 a refused chat recovery tells the chat it came from, once, with the cause", async () => {
  const it = await rolloutStage(cluster, "telegram")
  const registry = loadRegistry(it.registryFile)
  const runnerStore = await openStore({ url: storeUrlAs(String(readSetting(registry, "hub.store_url")), "hub_runner") })
  const store = await superStore(cluster, it.db)
  let controls: { close(): Promise<void> } | undefined
  try {
    const { requestRecovery, watchControls } = await seam("src/hub/control.ts")
    const id = "recover:telegram:1000000001:30"
    await (requestRecovery as Function)(store, { id, source: "chat", actor: "p1", sender_id: "p1", person: "p1", door: "door-fake",
      chat: "1000000001", target_kind: "agent", target_id: "p1-lair", registryFile: it.registryFile })
    // The runner's own watcher, with an apply that refuses as `recoverAgent` does.
    const watch = watchControls as (...args: unknown[]) => Promise<{ close(): Promise<void> }>
    controls = await watch(runnerStore, "runner", () => true, async () => { throw new Error("unknown-agent") },
      { registry: () => loadRegistry(it.registryFile) })
    expect(await observe(async () => (await it.read.sheet("control")).some(row => row.data.status === "refused"))).toBe(true)
    const notices = () => it.read.noticeRows().then(rows => rows.filter(row => String(row.notice_key).startsWith("recovery")))
    expect(await observe(async () => (await notices()).length > 0), "a refused recovery is said to the chat that asked").toBe(true)
    expect((await notices()).map(row => [row.person, row.agent, row.body])).toEqual([["p1", "p1-lair", "[door] recovery refused for p1-lair: unknown-agent."]])
    expect((await it.read.sql("select route from outbox where kind = 'notice'"))[0].route).toEqual({ door: "door-fake", chat: "1000000001" })
  } finally { await controls?.close(); await runnerStore.close(); await store.sql.close(); await it.stop() }
})

for (const phase of ["unnoticed", "exit", "memory"] as const) {
  const defective = phase === "unnoticed"
  test(`IMP-160 D-175 a child that dies under a person's message ${defective ? "unnoticed (control) says nothing" : `by ${phase === "exit" ? "exiting" : "the memory limit"} tells that chat once when it will retry`}`, async () => {
    const it = await stageHub(cluster, {
      hub: { tick_seconds: 1 },
      agents: [{ id: "p2-lair", person: "p2", preset: "daily", runner: "runner-pi", door: "door-fake", chat: "0000000000" }],
      run: [{ id: "runner-pi", kind: "runner", schedule: "always", memory_limit_mb: 512, child_memory_limit_mb: phase === "memory" ? 150 : 512 }],
      registry: base => ({ ...base, agents: base.agents!.map(a => ({ ...a, runner: "runner-pi" })) }),
    })
    retrySettings(it)
    const edge = controlledAdapter(it.adapterName)
    edge.hold(m => m.id === "interrupted")
    edge.suppressExit(defective)
    let runner: Awaited<ReturnType<typeof runRunner>> | undefined
    try {
      runner = await runRunner({ runner: "runner-pi", registryFile: it.registryFile, adapters: { [it.adapterName]: edge.adapter } })
      await insertInbound(cluster, it.db, { id: "interrupted", body: "pending input" })
      expect(await observe(() => edge.sessions.some(r => r.fed.some(m => m.id === "interrupted")))).toBe(true)
      const target = edge.sessions.find(r => r.fed.some(m => m.id === "interrupted"))!
      edge.hold(() => false)
      if (phase === "memory") target.grow(200)
      else target.fail()
      const retries = () => it.read.noticeRows().then(rows => rows.filter(row => String(row.notice_key).startsWith("agent-retry")))
      const told = await observe(async () => (await retries()).length > 0, phase === "memory" ? 6000 : 2500)
      if (defective) { expect(told).toBe(false); return }
      expect(told, "the person whose message the child died under is told").toBe(true)
      const cause = phase === "memory" ? "memory limit reached" : "child exited"
      expect((await retries()).map(row => [row.person, row.agent, row.body])).toEqual([["p1", "p1-lair", `[door] p1-lair stopped: ${cause}. I will retry in 1 s.`]])
      expect((await it.read.sql("select route from outbox where kind = 'notice'"))[0].route).toEqual({ door: "door-fake", chat: "1000000001" })
      // The retry answers, and the same message is not announced twice.
      expect(await observe(async () => (await it.read.outbox()).some(row => row.inbound_id === "interrupted"), 5000)).toBe(true)
      expect(await retries()).toHaveLength(1)
    } finally { await runner?.stop(); await edge.stop(); await it.stop() }
  })
}
