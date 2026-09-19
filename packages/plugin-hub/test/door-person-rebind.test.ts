// IMP-160 item 5, D-178. An agent moved to another person on a live door is
// served for the NEW person: its outbox and turn waiters wake on that person's
// notifications, so its replies go out and its turns show typing. The door
// process is not restarted for the edit.
import { afterAll, beforeAll, expect, test } from "bun:test"
import { startCluster, statementWatch, untilIssued, type Cluster } from "./helpers/cluster.ts"
import { rolloutStage } from "./helpers/rollout-stage.ts"
import { editAgent, observe } from "./helpers/rollout-runner.ts"
import { superStore } from "./helpers/hub-fixture.ts"
import { appendChunks, appendNotice } from "../src/store/outbox.ts"
import { stamp } from "../src/records/stamps.ts"
import type { Store } from "../src/store/connect.ts"
import { runDoor } from "../src/door/run.ts"

let cluster: Cluster
// Statements are logged so a check can see the new reply sender's first read.
beforeAll(async () => {
  cluster = await startCluster({ settings: { log_statement: "'all'", log_line_prefix: "'pid=%p '", log_min_duration_statement: "-1" } })
})
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

// A message the agent took in before the move keeps its person, and a reply
// is announced under the person of the message it answers. So the reply to a
// turn that was open when the agent moved is announced under the OLD person,
// after the door has started the agent's tasks for the new one. The chat is
// the same in all three cases, and nothing else is written after the settle,
// so only that announcement can bring the reply out.
for (const when of ["moved while the turn was open", "moved, then the door restarted", "kept its person"] as const) {
  test(`a reply to a turn that was open before the agent ${when === "kept its person" ? "kept its person (the control)" : when} is posted with no further message`, async () => {
    const it = await rolloutStage(cluster, "telegram")
    const store = await superStore(cluster, it.db)
    const start = () => runDoor({ door: "door-fake", registryFile: it.registryFile, platform: it.edge.platform })
    let door: Awaited<ReturnType<typeof runDoor>> | undefined
    try {
      door = await start()
      await store.sql`insert into inbound (id, person, agent, body, kind, log_ready, claimed_by)
        values ('owed-turn', 'p1', 'p1-lair', 'a question asked before the move', 'human', true, 'runner-pi')`
      await stamp(store, { messageId: "owed-turn", kind: "acked", actor: "runner" })
      await stamp(store, { messageId: "owed-turn", kind: "started", actor: "runner" })
      if (when !== "kept its person") {
        const watch = await statementWatch(cluster)
        editAgent(it.registryFile, "p1-lair", { person: "p2" })
        // The door drops the agent's tasks and starts new ones for p2. The
        // settle below has to land after the new reply sender's first read,
        // which is when the missing announcement is the only way out.
        await untilIssued(watch, "the new reply sender read its pending replies once", /from outbox o\b/,
          { after: /listen hub_outbox/, timeoutMs: 10_000 })
        if (when === "moved, then the door restarted") { await door.stop(); door = undefined; door = await start() }
      }
      await store.sql.begin(async tx => {
        const inside = { ...store, sql: tx as unknown as Store["sql"] }
        await appendChunks(inside, "owed-turn", ["the answer to the question asked before the move"])
        await stamp(inside, { messageId: "owed-turn", kind: "answered", actor: "runner" })
      })
      expect(await observe(() => it.edge.posts().some(post => post.text === "the answer to the question asked before the move"), 4000),
        "the reply to a message taken in before the move must be posted").toBe(true)
      if (when === "moved while the turn was open") {
        // Once nothing is owed under p1 the moved agent stops listening for
        // p1: an announcement for another p1 agent wakes no read of this door.
        // The control is the same announcement under p2, which does.
        expect(await observe(async () => (await store.sql`select state from inbound where id = 'owed-turn'`)[0].state === "delivered", 4000)).toBe(true)
        const reads = /from outbox o\b|select distinct person from inbound/
        const quiet = await statementWatch(cluster)
        await appendNotice(store, { person: "p1", agent: "p1-elsewhere", body: "for another agent of p1",
          noticeKey: `rebind:${crypto.randomUUID()}`, route: { door: "door-fake", chat: "1000000002" } })
        await Bun.sleep(1500)
        expect((await quiet.lines()).filter(line => reads.test(line)),
          "an announcement for p1 must not wake the moved agent once nothing is owed under p1").toEqual([])
        const woken = await statementWatch(cluster)
        await appendNotice(store, { person: "p2", agent: "p2-elsewhere", body: "for another agent of p2",
          noticeKey: `rebind:${crypto.randomUUID()}`, route: { door: "door-fake", chat: "1000000002" } })
        await untilIssued(woken, "an announcement for p2 woke a read of this door", reads, { timeoutMs: 4000 })
      }
    } finally { await door?.stop(); await store.sql.close(); await it.stop() }
  })
}
