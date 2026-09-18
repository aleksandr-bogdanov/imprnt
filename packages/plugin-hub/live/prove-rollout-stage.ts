import assert from "node:assert/strict"
import { startCluster, until } from "../test/helpers/cluster.ts"
import { rolloutStage } from "../test/helpers/rollout-stage.ts"
import { loadRegistry } from "../src/registry/load.ts"
import { listAgents, listPeople } from "../src/registry/entries.ts"
import { runDoor } from "../src/door/run.ts"
import { runRunner } from "../src/runner/run.ts"

const cluster = await startCluster()
try {
  for (const name of ["telegram", "discord"] as const) {
    const it = await rolloutStage(cluster, name)
    let door: Awaited<ReturnType<typeof runDoor>> | undefined
    let runner: Awaited<ReturnType<typeof runRunner>> | undefined
    try {
      const registry = loadRegistry(it.registryFile)
      assert.deepEqual(listAgents(registry).map(one => one.id), ["p1-lair", "p2-lair"])
      assert.deepEqual(listPeople(registry).map(one => one.id), ["p1", "p2"])
      door = await runDoor({ door: "door-fake", registryFile: it.registryFile, platform: it.edge.platform })
      runner = await runRunner({ runner: "runner-pi", registryFile: it.registryFile, adapters: { [it.adapterName]: it.scripted.adapter } })
      it.edge.batch(["p1", "p2"].map((person, index) => ({
        platform_message_id: String(index + 1), chat: index ? "0000000000" : "1000000001",
        sender_id: person, from: person, text: `synthetic ${person} proof`, at: new Date().toISOString(), media: [],
      })), "3")
      await until("both fixture people receive replies", () => it.edge.posts().filter(one => one.text.includes("synthetic")).length === 2, 10_000)
      assert.equal((await it.read.inbound()).length, 2)
      assert.equal((await it.read.outbox()).length, 2)
      console.log(`PASS ${name} rollout stage: two agents, sender maps, registry, real door, runner, store and replies`)
    } finally {
      await runner?.stop()
      await door?.stop()
      await it.stop()
    }
  }
} finally { await cluster.stop() }
