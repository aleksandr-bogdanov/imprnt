// A person's line in the chat log carries their registry id, never the platform
// username. Harvest keeps only the person's and the agent's lines, so a username
// there drops everything the person typed from every harvest.
import { afterAll, beforeAll, expect, test } from "bun:test"
import { readFileSync, writeFileSync } from "node:fs"
import { startCluster, until, type Cluster } from "./helpers/cluster.ts"
import { chatLogLines } from "./helpers/hub-fixture.ts"
import { chat } from "./helpers/rollout-ingress.ts"
import { observe } from "./helpers/rollout-runner.ts"
import { rolloutStage } from "./helpers/rollout-stage.ts"
import { readTail } from "../src/chatlog.ts"
import { runDoor } from "../src/door/run.ts"
import { readSlice } from "../src/harvest/slice.ts"
import { runRunner } from "../src/runner/run.ts"

// The stable platform id the allowlist names, and a display name that is
// neither it nor the registry id, so the log cannot pass by coincidence.
const SENDER = "4242"
const USERNAME = "someone"
const PERSON = "p1"
const AGENT = "p1-lair"
const REPLY = "synthetic agent reply"

let cluster: Cluster
beforeAll(async () => { cluster = await startCluster() })
afterAll(async () => { await cluster?.stop() })

function said(id: string, text: string) {
  return { platform_message_id: id, chat, sender_id: SENDER, from: USERNAME, text, at: new Date().toISOString(), media: [] }
}

for (const name of ["telegram", "discord"] as const) {
  test(`${name} logs what a person types under their registry id and harvest reads it`, async () => {
    const it = await rolloutStage(cluster, name, { adapter: { answer: () => REPLY } })
    let door: Awaited<ReturnType<typeof runDoor>> | undefined
    let runner: Awaited<ReturnType<typeof runRunner>> | undefined
    try {
      const listed = readFileSync(it.registryFile, "utf8")
      const registry = listed.replace('allowed_senders = { door-fake = ["p1"] }', `allowed_senders = { door-fake = ["${SENDER}"] }`)
      expect(registry, "the stage allowlists the stable sender for p1").not.toBe(listed)
      writeFileSync(it.registryFile, registry)
      const lines = () => chatLogLines(it.stateDir, PERSON, AGENT)
      door = await runDoor({ door: "door-fake", registryFile: it.registryFile, platform: it.edge.platform })
      runner = await runRunner({ runner: "runner-pi", registryFile: it.registryFile, adapters: { [it.adapterName]: it.scripted.adapter } })

      // An ordinary message, answered by the agent.
      it.edge.batch([said("1", "synthetic person codeword")], "2")
      await until("the agent's reply is logged", () => lines().some(line => line.direction === "out" && line.text === REPLY), 15_000)
      const person = lines().find(line => line.text === "synthetic person codeword")
      expect(person?.direction).toBe("in")
      expect(person?.from, "the inbound line names the person, not the platform username").toBe(PERSON)
      const reply = lines().find(line => line.direction === "out" && line.text === REPLY)
      expect(reply?.from, "control: the reply still names the agent").toBe(AGENT)
      const slice = await readSlice({ stateDir: it.stateDir, person: PERSON, agent: AGENT, from: null, until: new Date().toISOString() })
      expect(slice.map(line => [line.from, line.text]), "harvest reads both speakers").toEqual([
        [PERSON, "synthetic person codeword"],
        [AGENT, REPLY],
      ])
      const tail = await readTail({ stateDir: it.stateDir, person: PERSON, agent: AGENT, now: new Date(), hours: 1, tokens: 10_000 })
      expect(tail).toContain(`${PERSON}: synthetic person codeword`)
      expect(tail, "the tail shows one name for the person").not.toContain(USERNAME)
      await runner.stop()
      runner = undefined

      // A recovery command is logged by the door itself, before any work row.
      it.edge.batch([said("2", "/recover")], "3")
      const recover = `recover:${name}:${chat}:2`
      await until("the recovery command is logged", () => lines().some(line => (line as { id?: string }).id === recover), 10_000)
      expect(lines().find(line => (line as { id?: string }).id === recover)?.from, "a recovery command names the person").toBe(PERSON)

      // A demand read while the registry is mid-save is logged from the last
      // good registry, and that line keeps its id when the save completes.
      writeFileSync(it.registryFile, registry + "\n[[[ half saved")
      await Bun.sleep(1200)
      it.edge.batch([said("3", "harvest this")], "4")
      const demand = `harvest-demand:${name}:${chat}:3`
      await until("the demand is logged during the incomplete save", () => lines().some(line => (line as { id?: string }).id === demand), 10_000)
      expect(lines().find(line => (line as { id?: string }).id === demand)?.from, "a demand during an incomplete save names the person").toBe(PERSON)
      writeFileSync(it.registryFile, registry)
      expect(await observe(async () => (await it.read.sql("select id from inbound where id = $1", [demand])).length === 1, 10_000),
        "the demand is accepted once the save completes").toBe(true)
      expect(lines().filter(line => (line as { id?: string }).id === demand)).toHaveLength(1)
    } finally {
      await runner?.stop()
      await door?.stop()
      await it.stop()
    }
  })
}
