// ROLL-23 chat half, D-178. Reader responses straddle the registry edit.
import { afterAll, beforeAll, expect, test } from "bun:test"
import { readFileSync, writeFileSync } from "node:fs"
import { startCluster, startReadySubprocess, type ReadyProcess, type Cluster } from "./helpers/cluster.ts"
import { rolloutStage } from "./helpers/rollout-stage.ts"
import { deliveryEdge, proveDeliveryEdge } from "./helpers/rollout-delivery.ts"
import { editAgent, observe } from "./helpers/rollout-runner.ts"
import { message } from "./helpers/rollout-ingress.ts"
import { servePlatform } from "./helpers/fake-platform.ts"
import { join } from "node:path"
import { rolloutFixture } from "./helpers/rollout-fixtures.ts"

let cluster: Cluster
beforeAll(async () => {
  await proveDeliveryEdge()
  console.log("H05 delivery edge standalone proof passed")
  const f = rolloutFixture()
  let child: ReadyProcess | undefined
  try {
    const trace = join(f.dir, "observer-proof.jsonl")
    child = await startReadySubprocess("test/helpers/rollout-hub-observer-child.ts", [f.file, "mac", trace, "proof"], 5000)
    expect(readFileSync(trace, "utf8").trim().split("\n").map(line => JSON.parse(line).verb)).toEqual(["start", "restart", "stop", "remove"])
    await child.stop(9)
    expect(child.proc.signalCode).toBe("SIGKILL")
    console.log("H05 inert manager trace and owned hub child proof passed")
  } finally { await child?.stop(9); f.stop() }
  cluster = await startCluster()
})
afterAll(async () => { await cluster?.stop() })

for (const known of [false, true]) {
  test(`ROLL-23 existing-ID chat edit during pull and reply uses ${known ? "saved cursor" : "new high-water mark"} without redirect or duplicate`, async () => {
    const it = await rolloutStage(cluster, "telegram", { servers: true, machines: [{ id: "mac", os: process.platform === "darwin" ? "macos" : "linux" }], agents: [], adapter: { answer: ({ text }) => "answer: " + text } })
    const edge = deliveryEdge()
    let door: ReadyProcess | undefined
    let runner: ReadyProcess | undefined
    let hub: ReadyProcess | undefined
    const platform = await servePlatform({ ...it.fake, platform: edge.platform })
    const trace = join(it.stateDir, "hub-operations.jsonl")
    writeFileSync(trace, "")
    let release = () => {}
    try {
      // Target route history exists before activation. A known route resumes 4.
      if (known) await it.read.sql("insert into state_row (sheet, id, data) values ('door_cursor', 'door-fake/0000000000', '{\"cursor\":\"4\"}')")
      await it.read.sql("insert into state_row (sheet, id, data) values ('door_cursor', 'door-fake/1000000001', '{\"cursor\":\"4\"}')")
      edge.batch([{ ...message("3", "old channel history"), chat: "0000000000" }], "4")
      it.scripted.holdTurnEnd(true)
      door = await startReadySubprocess("test/helpers/door-subprocess.ts", [it.registryFile, "door-fake", platform.url], 5000)
      runner = await startReadySubprocess("test/helpers/runner-subprocess.ts", [it.registryFile, "runner-pi", it.adapterUrl, it.adapterName], 5000)
      hub = await startReadySubprocess("test/helpers/rollout-hub-observer-child.ts", [it.registryFile, "mac", trace], 5000)
      const pids = [door.proc.pid, runner.proc.pid, hub.proc.pid]
      edge.batch([message("5", "accepted old route")], "6")
      expect(await observe(async () => (await it.read.inbound()).some(row => row.state === "started")), "old-route turn is in flight").toBe(true)
      release = edge.hold("1000000001", "old fetched batch")
      edge.batch([message("7", "old fetched batch")], "8")
      expect(await observe(() => edge.held.has("1000000001")), "old response is fetched and held").toBe(true)
      editAgent(it.registryFile, "p1-lair", { chat: "0000000000" })
      await Bun.sleep(1100)
      release()
      it.scripted.holdTurnEnd(false)
      it.scripted.endTurn()
      const newReader = (reads = edge.reads) => expect(reads.some(row => row.chat === "0000000000"), "F23 existing-ID chat edit must activate new reader").toBe(true)
      // ID-only reconciliation yields the old reader trace, rejected by the same predicate.
      const oldOnly = edge.reads.filter(row => row.chat === "1000000001")
      expect(() => newReader(oldOnly)).toThrow()
      await observe(() => edge.reads.some(row => row.chat === "0000000000"))
      newReader()
      if (known) expect(edge.pulls().find(row => row.chat === "0000000000")?.cursor, "known route resumes its saved cursor").toBe("4")
      const accepted = await it.read.sql("select source from inbound where body = 'accepted old route'")
      expect(accepted[0].source).toMatchObject({ door: "door-fake", chat: "1000000001" })
      expect(await observe(async () => (await it.read.inbound()).some(row => row.body === "old fetched batch")), "old accepted batch completes before reader cancellation").toBe(true)
      expect(await observe(() => edge.posts().some(row => row.text === "answer: accepted old route"))).toBe(true)
      expect(edge.posts().filter(row => row.text === "answer: accepted old route").map(row => row.chat)).toEqual(["1000000001"])
      const oldCount = edge.reads.filter(row => row.chat === "1000000001").length
      // Authorization changes independently of the chat edit.
      writeFileSync(it.registryFile, readFileSync(it.registryFile, "utf8").replace('door-fake = ["p1"]', 'door-fake = ["p2"]'))
      await Bun.sleep(1200)
      edge.batch([{ ...message("9", "refused old sender"), chat: "0000000000" }, { ...message("10", "new authorized route"), chat: "0000000000", sender_id: "p2" }], "11")
      expect(await observe(() => edge.posts().some(row => row.text === "answer: new authorized route")), "new route answers authorized arrival").toBe(true)
      expect((await it.read.inbound()).map(row => row.body)).not.toContain("refused old sender")
      expect((await it.read.inbound()).map(row => row.body)).not.toContain("old channel history")
      expect(edge.posts().filter(row => row.text === "answer: new authorized route").map(row => row.chat)).toEqual(["0000000000"])
      expect(edge.reads.filter(row => row.chat === "1000000001")).toHaveLength(oldCount)
      expect([...edge.peak.values()].every(value => value === 1)).toBe(true)
      const cursors = await it.read.sheet("door_cursor")
      expect(cursors.find(row => row.id === "door-fake/1000000001")?.data.cursor).toBe("8")
      expect(cursors.find(row => row.id === "door-fake/0000000000")?.data.cursor).toBe("11")
      expect([door.proc.pid, runner.proc.pid, hub.proc.pid]).toEqual(pids)
      for (const child of [door, runner, hub]) { expect(child.proc.exitCode).toBeNull(); process.kill(child.proc.pid, 0) }
      expect(readFileSync(trace, "utf8"), "binding edit must request no service restart").toBe("")
      expect(await it.read.ledger({ stream: "runner", kind: "connected" })).toHaveLength(1)
    } finally { release(); edge.release(); it.scripted.holdTurnEnd(false); it.scripted.endTurn(); await runner?.stop(); await door?.stop(); await hub?.stop(); await platform.stop(); await it.stop() }
  })
}
