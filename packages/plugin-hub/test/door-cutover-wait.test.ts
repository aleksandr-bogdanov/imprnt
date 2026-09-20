// A door whose declared cutover batch is not yet
// complete WAITS for it. It pulls nothing and says in its diary why, once, and
// it becomes ready when the batch completes. It does not exit: a unit that
// exits on start is restarted by systemd until its start limit, and then it
// stays down after the handoff completes until someone resets it by hand.
import { afterAll, beforeAll, expect, test } from "bun:test"
import { startCluster, type Cluster } from "./helpers/cluster.ts"
import { rolloutStage } from "./helpers/rollout-stage.ts"
import { observe } from "./helpers/rollout-runner.ts"
import { superStore } from "./helpers/hub-fixture.ts"
import { putRow } from "../src/records/statesheet.ts"
import { runDoor } from "../src/door/run.ts"

let cluster: Cluster
beforeAll(async () => { cluster = await startCluster() })
afterAll(async () => { await cluster?.stop() })

const batch = "synthetic-cutover"

for (const start of ["incomplete", "complete", "stopped"] as const) {
  test(`IMP-160 D-181 a door started with its cutover batch ${start === "complete" ? "complete starts at once" : start === "incomplete" ? "incomplete waits, says why once, then starts" : "incomplete stops cleanly while it waits"}`, async () => {
    const it = await rolloutStage(cluster, "telegram", { hub: { cutover_batch: batch } })
    const store = await superStore(cluster, it.db)
    const abort = new AbortController()
    let door: Awaited<ReturnType<typeof runDoor>> | undefined
    let failure: unknown
    const waits = async () => (await it.read.ledger({ stream: "operation", subject: "door-fake" }))
      .filter(row => row.kind === "failed" && row.detail.code === "cutover-incomplete")
    try {
      if (start === "complete") await putRow(store, "cutover", batch, { complete: true })
      const starting = runDoor({ door: "door-fake", registryFile: it.registryFile, platform: it.edge.platform, signal: abort.signal } as Parameters<typeof runDoor>[0])
        .then(handle => { door = handle; return handle }, error => { failure = error; return undefined })
      if (start === "complete") {
        await starting
        expect(failure).toBeUndefined()
        expect(door, "a complete batch is no reason to wait").toBeDefined()
        expect(await waits()).toHaveLength(0)
        return
      }
      expect(await observe(async () => (await waits()).length > 0 || failure !== undefined, 5000), "the door says why it waits").toBe(true)
      expect(failure, "an incomplete batch is waited for, not refused").toBeUndefined()
      const said = (await waits())[0]
      expect(String(said.detail.cause)).toContain(batch)
      // Several ticks of waiting: not ready, nothing pulled, said once.
      await Bun.sleep(2500)
      expect(door).toBeUndefined()
      expect(failure).toBeUndefined()
      expect(it.edge.pulls()).toHaveLength(0)
      expect(await waits(), "the reason is written once, not once a tick").toHaveLength(1)
      if (start === "stopped") {
        abort.abort()
        await starting
        expect(door).toBeUndefined()
        expect(String(failure)).toMatch(/cutover/)
        expect(it.edge.pulls()).toHaveLength(0)
        return
      }
      await putRow(store, "cutover", batch, { complete: true })
      expect(await observe(() => door !== undefined, 5000), "the door starts once the batch completes").toBe(true)
      expect(await observe(() => it.edge.pulls().length > 0), "and then it reads").toBe(true)
      expect(await waits()).toHaveLength(1)
    } finally { abort.abort(); await door?.stop(); await store.sql.close(); await it.stop() }
  })
}
