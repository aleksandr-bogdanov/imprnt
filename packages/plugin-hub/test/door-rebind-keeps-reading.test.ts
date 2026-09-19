// IMP-163, D-178. A registry edit that does not move an agent to another chat
// never re-baselines where the door reads that chat. The door asks the platform
// where a chat stands only when an agent's CHAT changes to one the door has
// never read. An allowlist edit or a person rebind keeps the chat, so a message
// sent at once after either is answered.
//
// The third variant is the one that failed: a person rebind on a chat the door
// has not saved a cursor for yet. The door restarted that agent's tasks as an
// activation, asked the platform for the chat's newest position, and skipped a
// message the person had sent right after the edit as history. The chat's reads
// fail until the rebind is done, so no reader can take the message earlier.
import { afterAll, beforeAll, expect, test } from "bun:test"
import { readFileSync, writeFileSync } from "node:fs"
import { startCluster, type Cluster } from "./helpers/cluster.ts"
import { rolloutStage } from "./helpers/rollout-stage.ts"
import { deliveryEdge } from "./helpers/rollout-delivery.ts"
import { editAgent, observe } from "./helpers/rollout-runner.ts"
import { message } from "./helpers/rollout-ingress.ts"
import { runDoor } from "../src/door/run.ts"
import { runRunner } from "../src/runner/run.ts"

let cluster: Cluster
beforeAll(async () => { cluster = await startCluster() })
afterAll(async () => { await cluster?.stop() })

const CHAT = "1000000001"

for (const edit of ["allowlist", "person, chat already read", "person, chat not read yet"] as const) {
  test(`IMP-163 D-178 a message sent at once after ${edit === "allowlist" ? "an allowlist edit" : `a person rebind (${edit.slice(8)})`} is answered and the chat is not re-baselined`, async () => {
    const it = await rolloutStage(cluster, "discord", { agents: [] })
    // Both people accept the same sender, so the message is theirs whichever
    // reader takes it.
    writeFileSync(it.registryFile, readFileSync(it.registryFile, "utf8").replace('door-fake = ["p2"]', 'door-fake = ["p2", "p1"]'))
    const edge = deliveryEdge("discord")
    let asked = 0
    const highWater = edge.platform.highWater
    edge.platform.highWater = async where => { asked += 1; return highWater(where) }
    let door: Awaited<ReturnType<typeof runDoor>> | undefined
    let runner: Awaited<ReturnType<typeof runRunner>> | undefined
    try {
      door = await runDoor({ door: "door-fake", registryFile: it.registryFile, platform: edge.platform })
      runner = await runRunner({ runner: "runner-pi", registryFile: it.registryFile, adapters: { [it.adapterName]: it.scripted.adapter } })
      const answered = (text: string) => edge.posts().some(post => post.chat === CHAT && post.text === `reply to ${text}`)
      if (edit !== "person, chat not read yet") {
        edge.batch([message("1", "before the edit")], "2")
        // Both answer waits measured max 6747 ms in 8 runs on the Linux box at a load average of 5 to 8.
        // The same answer path measured max 32688 ms in test/door-remap-boundary.test.ts at a load average
        // up to 13. Three times that is 98064, rounded up.
        expect(await observe(() => answered("before the edit"), 100000), "the chat is served before the edit").toBe(true)
        expect((await it.read.sheet("door_cursor")).find(row => row.id === `door-fake/${CHAT}`)?.data.cursor).toBe("2")
      } else {
        expect(await it.read.sheet("door_cursor"), "no cursor is saved for the chat yet").toEqual([])
        edge.readFault(CHAT, Object.assign(new Error("synthetic outage"), { status: 502 }))
      }
      if (edit === "allowlist") writeFileSync(it.registryFile, readFileSync(it.registryFile, "utf8").replace('door-fake = ["p1"]', 'door-fake = ["p1", "p2"]'))
      else editAgent(it.registryFile, "p1-lair", { person: "p2" })
      edge.batch([message("3", "sent at once after the edit")], "4")
      if (edit === "person, chat not read yet") {
        // Two and a half ticks, so the edit has been acted on before the chat
        // can be read again, as test/door-person-rebind.test.ts waits.
        await Bun.sleep(2500)
        edge.readFault(CHAT, null)
      }
      expect(await observe(() => answered("sent at once after the edit"), 100000),
        "a message sent at once after the edit is answered").toBe(true)
      expect(asked, "the door asked where the chat stands although the chat never changed").toBe(0)
      expect((await it.read.sheet("door_cursor")).find(row => row.id === `door-fake/${CHAT}`)?.data.cursor).toBe("4")
    } finally { edge.release(); await runner?.stop(); await door?.stop(); await it.stop() }
  // Two answer waits, the rebind's two and a half ticks and the stage around them.
  }, 250000)
}
