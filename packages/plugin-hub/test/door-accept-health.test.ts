// A fetched batch the door cannot accept, again and
// again, leaves the same durable trace a read failure does: a door_health row
// `check` reports, one notice to a working chat of the same person, and a clear
// only once the batch really is accepted.
import { afterAll, beforeAll, expect, spyOn, test } from "bun:test"
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { startCluster, type Cluster } from "./helpers/cluster.ts"
import { rolloutStage } from "./helpers/rollout-stage.ts"
import { deliveryEdge } from "./helpers/rollout-delivery.ts"
import { observe } from "./helpers/rollout-runner.ts"
import { superStore } from "./helpers/hub-fixture.ts"
import { chatLogPath } from "../src/chatlog.ts"
import { runDoor } from "../src/door/run.ts"
import { runCheck } from "../src/check/run.ts"

let cluster: Cluster
beforeAll(async () => { cluster = await startCluster() })
afterAll(async () => { await cluster?.stop() })

const at = "2026-09-01T12:00:00.000Z"

for (const blocked of [true, false]) {
  test(`IMP-160 D-174 ${blocked ? "a repeating" : "no"} acceptance failure ${blocked ? "leaves a health row, a finding and one notice, then clears" : "leaves the chat healthy and says nothing"}`, async () => {
    const it = await rolloutStage(cluster, "telegram", {
      machines: [{ id: "pi", os: "linux" }],
      run: [{ id: "door-fake", kind: "door", machine: "pi", platform: "fake", person: "p1", token_file: "/dev/null" }, { id: "runner-pi", kind: "runner", machine: "pi", child_memory_limit_mb: 256 }],
      // The same person has a second chat, which is where a notice can go.
      registry: spec => ({ ...spec, agents: spec.agents!.map(agent => agent.id === "p2-lair" ? { ...agent, person: "p1" } : agent) }),
    })
    // The replay is the next tick (1 s here), not the read retry, and the
    // notice has to say the one that really happens.
    writeFileSync(it.registryFile, readFileSync(it.registryFile, "utf8").replace("read_retry_seconds = 1", "read_retry_seconds = 7"))
    const edge = deliveryEdge("telegram")
    // A directory where the day's chat log file belongs: every projection of
    // this chat's batch fails the same way, on every replay.
    const day = chatLogPath({ stateDir: it.stateDir, person: "p1", agent: "p1-lair", at: new Date(at) })
    if (blocked) mkdirSync(day, { recursive: true })
    let stderr = ""
    const capture = spyOn(process.stderr, "write").mockImplementation(((chunk: any) => { stderr += String(chunk); return true }) as any)
    const store = await superStore(cluster, it.db)
    let door: Awaited<ReturnType<typeof runDoor>> | undefined
    const check = () => runCheck({ machine: "pi", registryFile: it.registryFile, store, os: null, kernel: null,
      credentials: { open: async () => ({ ok: true }), secrets: async () => [] } })
    const health = async () => (await it.read.sheet("door_health")).find(row => row.id === "door-fake/1000000001")
    const finding = async () => (await check()).find(row => JSON.stringify(row).includes("door-fake/1000000001"))
    const notices = () => edge.posts().filter(post => post.text.includes("1000000001") && post.text.includes("[door]"))
    try {
      door = await runDoor({ door: "door-fake", registryFile: it.registryFile, platform: edge.platform })
      edge.batch([{ platform_message_id: "1", chat: "1000000001", sender_id: "p1", from: "p1", text: "blocked codeword", at, media: [] }], "2")
      if (!blocked) {
        expect(await observe(async () => (await it.read.sql("select log_ready from inbound where id = 'telegram:1000000001:1'"))[0]?.log_ready === true), "control batch is accepted").toBe(true)
        await Bun.sleep(2500)
        expect((await health())?.data.cause, "an accepted batch leaves no failure").toBeUndefined()
        expect(await finding(), "an accepted batch leaves no finding").toBeUndefined()
        expect(notices()).toHaveLength(0)
        return
      }
      expect(await observe(async () => (await health())?.data.code === "accept-failed", 6000), "a repeating acceptance failure must leave a door_health row").toBe(true)
      const first = (await health())!
      expect(first.data.status).toBe("failed")
      expect(first.data.cause).toBeTruthy()
      expect(first.data.retry_at).toBeTruthy()
      expect(JSON.stringify(await finding()), "check must report the chat whose batch is refused").toContain("accept-failed")
      // A refused batch is not an unreadable chat, and a door restart replays
      // the same batch into the same refusal. So it is its own finding, it
      // carries what was really thrown instead of the wording the person is
      // told, and it never tells the operator to recover the door.
      const refused = (await finding())!
      expect(refused.kind, "an acceptance failure is its own finding").toBe("accept-failed")
      expect(refused.fix, "and never sends the operator to restart the door").not.toContain("recover")
      expect(refused.fix).toContain("door-fake/1000000001")
      expect(refused.says, "the finding carries the real error, which names the file").toContain(day)
      // Several more refused replays: one episode, one notice, one stable row.
      await Bun.sleep(3000)
      expect(edge.pulls().filter(pull => pull.chat === "1000000001").length).toBeGreaterThan(3)
      expect(notices(), "one notice per episode to the same person's working chat").toHaveLength(1)
      expect(notices()[0].chat).toBe("0000000000")
      expect(notices()[0].text, "the notice names the retry that happens").toContain("retry in 1 s")
      expect((await health())!.data.since, "the episode keeps its start").toBe(first.data.since)
      expect((await it.read.ledger({ kind: "read-restored" })).filter(row => row.subject === "door-fake/1000000001"), "a read that worked is not an accepted batch").toHaveLength(0)
      expect((await it.read.sheet("door_cursor")).find(row => row.id === "door-fake/1000000001")?.data.cursor).not.toBe("2")
      expect(stderr).toContain("accept-failed")
      // The batch goes through once the cause is gone, and only that clears it.
      rmSync(day, { recursive: true })
      expect(await observe(async () => (await health())?.data.status === "healthy", 6000), "an accepted batch clears the row").toBe(true)
      expect(await finding()).toBeUndefined()
      expect((await it.read.sql("select log_ready from inbound where id = 'telegram:1000000001:1'"))[0].log_ready).toBe(true)
      expect((await it.read.sheet("door_cursor")).find(row => row.id === "door-fake/1000000001")?.data.cursor).toBe("2")
      expect(notices()).toHaveLength(1)
    } finally { edge.release(); await door?.stop(); capture.mockRestore(); await store.sql.close(); await it.stop() }
  })
}
