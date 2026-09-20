// Each refusal has a listed-sender control on the same door.
import { afterAll, beforeAll, expect, test } from "bun:test"
import { readFileSync, writeFileSync } from "node:fs"
import { startCluster, type Cluster } from "./helpers/cluster.ts"
import { rolloutStage } from "./helpers/rollout-stage.ts"
import { observe } from "./helpers/rollout-runner.ts"
import { message } from "./helpers/rollout-ingress.ts"
import { runDoor } from "../src/door/run.ts"
let cluster: Cluster
beforeAll(async () => { cluster = await startCluster() })
afterAll(async () => { await cluster?.stop() })

for (const name of ["telegram", "discord"] as const) {
  for (const refusal of ["unlisted", "display-name", "missing", "empty"] as const) {
    test(`ROLL-15 ${name} ${refusal} has zero unauthorized work, control, media and replies`, async () => {
      for (const defective of [true, false]) {
        const it = await rolloutStage(cluster, name)
        let door: Awaited<ReturnType<typeof runDoor>> | undefined
        try {
          const original = readFileSync(it.registryFile, "utf8")
          const start = () => runDoor({ door: "door-fake", registryFile: it.registryFile, platform: it.edge.platform })
          door = await start()
          it.edge.batch([message("1", "listed sender control")], "2")
          expect(await observe(async () => (await it.read.inbound()).length === 1), "listed sender control").toBe(true)
          await door.stop()
          const candidate = { ...message("2", "/recover p1-lair"), sender_id: "p2",
            from: refusal === "unlisted" ? "p2" : "p1",
            media: [{ kind: "file" as const, remote_id: "unauthorized", name: "fixture.txt", mime: "text/plain", bytes: 4, caption: null }] }
          it.edge.file("unauthorized", new Uint8Array([1, 2, 3, 4]))
          const empty = refusal === "missing" || refusal === "empty"
          let input = empty ? { ...candidate, sender_id: "p1" } : candidate
          if (empty) writeFileSync(it.registryFile, refusal === "missing"
            ? original.replace('allowed_senders = { door-fake = ["p1"] }\n', "")
            : original.replace('door-fake = ["p1"]', 'door-fake = []'))
          // Faulty display authority substitutes the presentation identity.
          // Faulty allow-all grants the actual candidate in the same registry.
          if (defective) {
            if (refusal === "display-name") input = { ...input, sender_id: input.from }
            else writeFileSync(it.registryFile, original.replace('door-fake = ["p1"]', `door-fake = ["${input.sender_id}"]`))
          }
          door = await start()
          const posts = it.edge.posts().length
          it.edge.batch([input], "3")
          const advanced = await observe(() => it.edge.pulls().some(p => p.chat === input.chat && p.cursor === "3"), 15000)
          const noEffects = async () => {
            expect((await it.read.inbound()).filter(row => row.id.endsWith(":2")), "D-173 zero unauthorized work").toEqual([])
            expect(await it.read.sheet("control"), "D-173 zero unauthorized control").toEqual([])
            expect(it.edge.downloads(), "D-173 zero unauthorized downloads").toEqual([])
            expect(it.edge.posts()).toHaveLength(posts)
          }
          if (defective) await expect(noEffects()).rejects.toThrow()
          else await noEffects()
          expect(advanced, "rejected batch fetched cursor").toBe(true)
        } finally { await door?.stop(); await it.stop() }
      }
    })
  }
  test(`ROLL-15 ${name} next tick reloads allowlist with the same process`, async () => {
    const it = await rolloutStage(cluster, name)
    let door: Awaited<ReturnType<typeof runDoor>> | undefined
    try {
      door = await runDoor({ door: "door-fake", registryFile: it.registryFile, platform: it.edge.platform })
      const pid = process.pid
      it.edge.batch([message("1")], "2")
      expect(await observe(async () => (await it.read.inbound()).length === 1)).toBe(true)
      const original = readFileSync(it.registryFile, "utf8")
      writeFileSync(it.registryFile, original.replace('door-fake = ["p1"]', 'door-fake = ["p2"]'))
      await Bun.sleep(1200)
      it.edge.batch([message("2", "old sender denied"), { ...message("3", "new sender accepted"), sender_id: "p2" }], "4")
      // The reader of the chat that holds the batch's messages. The stage's other agent reads another
      // chat through the same cursor and reaches "4" with nothing to accept, possibly before this one has
      // committed its row.
      expect(await observe(() => it.edge.pulls().some(p => p.chat === "1000000001" && p.cursor === "4"))).toBe(true)
      expect((await it.read.inbound()).map(row => row.id).sort(), "D-173 allowlist edit changes next accepted set").toEqual([`${name}:1000000001:1`, `${name}:1000000001:3`])
      expect(process.pid).toBe(pid)
    } finally { await door?.stop(); await it.stop() }
  })
}
