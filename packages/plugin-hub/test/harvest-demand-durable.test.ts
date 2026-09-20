// The acceptance path is protected, and no new clock gate is added.
import { afterAll, beforeAll, expect, test } from "bun:test"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { startCluster, startReadySubprocess, type Cluster } from "./helpers/cluster.ts"
import { stageHarvest, plantLine } from "./helpers/harvest-stage.ts"
import { chatLogLines } from "./helpers/hub-fixture.ts"
import { rolloutPlatform } from "./helpers/rollout-platform.ts"
import { observe } from "./helpers/rollout-runner.ts"
import { announceClock, clockGate, clockSuffix } from "./helpers/clock-gate.ts"
import { message, chat } from "./helpers/rollout-ingress.ts"
import { storeUrlAs } from "../src/store/connect.ts"
import { runDoor } from "../src/door/run.ts"
import { runRunner } from "../src/runner/run.ts"
const gate = clockGate(8)
announceClock(gate, "D-173 durable demand crash boundaries")
let cluster: Cluster
beforeAll(async () => { cluster = await startCluster() })
afterAll(async () => { await cluster?.stop() })
for (const point of ["demand-before-cursor", "demand-after-cursor"] as const) for (const [platform, phrase] of [["telegram", "harvest this"], ["discord", "сохрани важное"]] as const) {
  test.skipIf(!gate.ok)(`ROLL-03 ROLL-11 ROLL-20 HARV-03 ${platform} durable demand ${point}` + clockSuffix(gate), async () => {
    const stage = await stageHarvest(cluster, { hub: { tick_seconds: 30 }, harvest: { quiet_minutes: 600, min_messages: 99, report: false },
      registry: spec => ({ ...spec, agents: spec.agents!.map(a => ({ ...a, runner: "runner-pi" })) }) })
    const it = stage.hub
    let child: Awaited<ReturnType<typeof startReadySubprocess>> | undefined
    let door: Awaited<ReturnType<typeof runDoor>> | undefined
    let runner: Awaited<ReturnType<typeof runRunner>> | undefined
    try {
      const original = readFileSync(it.registryFile, "utf8")
      writeFileSync(it.registryFile, original.replace('id = "p1"\n', 'id = "p1"\nallowed_senders = { door-fake = ["p1"] }\n'))
      plantLine(stage, { at: new Date(Date.now() - 5 * 60_000).toISOString(), direction: "in", from: "p1", text: "synthetic useful history" })
      const input = message("1", phrase)
      const id = `harvest-demand:${platform}:${chat}:1`
      const config = join(it.stateDir, "crash.json")
      writeFileSync(config, JSON.stringify({ mode: "ingress", point, platform, trace: join(it.stateDir, "trace.jsonl"), message: input, id,
        registryFile: it.registryFile, stateDir: it.stateDir, url: storeUrlAs(it.storeUrl, "hub_door") }))
      child = await startReadySubprocess("test/helpers/rollout-crash-child.ts", [config], 5000)
      await child.stop(9)
      expect(child.proc.signalCode).toBe("SIGKILL")
      const rows = await it.read.sql("select id, kind, body from inbound where id = $1", [id])
      expect(rows, "D-173 deterministic demand row must be durable before cursor write").toHaveLength(1)
      expect(rows[0].kind).toBe("harvest")
      expect(String(rows[0].body)).toContain(phrase)
      expect(chatLogLines(it.stateDir, "p1", "p1-lair").filter(l => l.text === phrase)).toHaveLength(1)
      const edge = rolloutPlatform(platform)
      edge.batch([input], "2")
      it.scripted.setAnswer(() => "nothing")
      door = await runDoor({ door: "door-fake", registryFile: it.registryFile, platform: edge.platform })
      runner = await runRunner({ runner: "runner-pi", registryFile: it.registryFile, adapters: { [it.adapterName]: it.scripted.adapter } })
      expect(await observe(async () => (await it.read.sql("select state from inbound where id = $1", [id]))[0]?.state === "answered", 8000), "D-173 restarted demand executes shared harvest path").toBe(true)
      expect((await it.read.sql("select id from inbound where kind = 'harvest'"))).toHaveLength(1)
      expect(await it.read.sql("select id from inbound where kind = 'human'")).toEqual([])
      expect(it.scripted.fed().filter(f => f.text === phrase)).toEqual([])
      expect((await it.read.ledger({ kind: "turn" })).filter(e => (e.detail as any).harvest)).toHaveLength(1)
      expect(chatLogLines(it.stateDir, "p1", "p1-lair").filter(l => l.text === phrase)).toHaveLength(1)
      expect((await it.read.noticeRows()).length).toBeGreaterThan(0)
    } finally { await child?.stop(9); await runner?.stop(); await door?.stop(); await stage.stop() }
  })
}
