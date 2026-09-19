// IMP-160 item 5, D-178. An agent moved to another person on a live door is
// served for the NEW person: its outbox and turn waiters wake on that person's
// notifications, so its replies go out and its turns show typing. The door
// process is not restarted for the edit.
import { afterAll, beforeAll, expect, test } from "bun:test"
import { startCluster, type Cluster } from "./helpers/cluster.ts"
import { rolloutStage } from "./helpers/rollout-stage.ts"
import { editAgent, observe } from "./helpers/rollout-runner.ts"
import { superStore } from "./helpers/hub-fixture.ts"
import { appendNotice } from "../src/store/outbox.ts"
import { runDoor } from "../src/door/run.ts"

let cluster: Cluster
beforeAll(async () => { cluster = await startCluster() })
afterAll(async () => { await cluster?.stop() })

for (const moved of [true, false]) {
  test(`IMP-160 D-178 ${moved ? "an agent moved to another person" : "an agent that keeps its person"} gets its replies delivered and its turns typed`, async () => {
    const it = await rolloutStage(cluster, "telegram")
    const store = await superStore(cluster, it.db)
    const typed: string[] = []
    const typing = it.edge.platform.typing
    it.edge.platform.typing = async where => { typed.push(where.chat); return typing(where) }
    let door: Awaited<ReturnType<typeof runDoor>> | undefined
    try {
      door = await runDoor({ door: "door-fake", registryFile: it.registryFile, platform: it.edge.platform })
      // p1-lair belongs to p1 at start. The edit gives it to p2, on its own chat.
      const person = moved ? "p2" : "p1"
      if (moved) editAgent(it.registryFile, "p1-lair", { person: "p2" })
      await Bun.sleep(2500)
      await appendNotice(store, { person, agent: "p1-lair", body: "synthetic reply after the edit",
        noticeKey: `rebind:${crypto.randomUUID()}`, route: { door: "door-fake", chat: "1000000001" } })
      expect(await observe(() => it.edge.posts().some(post => post.text === "synthetic reply after the edit"), 4000),
        "the agent's reply must be delivered for the person it now belongs to").toBe(true)
      await store.sql`insert into inbound (id, person, agent, body, kind, log_ready, claimed_by)
        values ('rebind-turn', ${person}, 'p1-lair', 'turn after the edit', 'human', true, 'runner-pi')`
      await store.sql`insert into ledger_event (stream, subject, kind, actor) values ('inbound', 'rebind-turn', 'acked', 'runner')`
      expect(await observe(() => typed.includes("1000000001"), 4000), "the agent's open turn must show typing").toBe(true)
    } finally { await door?.stop(); await store.sql.close(); await it.stop() }
  })
}
