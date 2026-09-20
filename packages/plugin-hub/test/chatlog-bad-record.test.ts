// One complete record in the middle of a chat log that
// is not a chat line is skipped by the door and reported by file and line. It
// never refuses the door, and every other agent on that door keeps working. A
// torn LAST record is a different thing: a write that never finished, which
// the repair truncates.
import { afterAll, beforeAll, expect, spyOn, test } from "bun:test"
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { startCluster, type Cluster } from "./helpers/cluster.ts"
import { rolloutStage } from "./helpers/rollout-stage.ts"
import { observe } from "./helpers/rollout-runner.ts"
import { superStore } from "./helpers/hub-fixture.ts"
import { chatLogPath, readTail } from "../src/chatlog.ts"
import { enqueueInbound } from "../src/store/inbound.ts"
import { runDoor } from "../src/door/run.ts"
import { runRunner } from "../src/runner/run.ts"

let cluster: Cluster
beforeAll(async () => { cluster = await startCluster() })
afterAll(async () => { await cluster?.stop() })

const at = "2026-09-01T12:00:00.000Z"
const good = (id: string, text: string) => JSON.stringify({ id, at, direction: "in", from: "p1", text }) + "\n"

for (const middle of ["malformed", "invalid", "good", "torn-last"] as const) {
  test(`IMP-160 D-172 a ${middle} record in the day file ${middle === "malformed" || middle === "invalid" ? "is skipped and named by file and line" : "is no finding"} and the door starts and serves`, async () => {
    const it = await rolloutStage(cluster, "telegram", {
      machines: [{ id: "pi", os: "linux" }],
      run: [{ id: "door-fake", kind: "door", machine: "pi", platform: "fake", person: "p1", token_file: "/dev/null" }, { id: "runner-pi", kind: "runner", machine: "pi", child_memory_limit_mb: 256 }],
    })
    const file = chatLogPath({ stateDir: it.stateDir, person: "p1", agent: "p1-lair", at: new Date(at) })
    mkdirSync(dirname(file), { recursive: true })
    const bad = middle === "malformed" ? '{"broken":}\n' : middle === "invalid" ? '{"id":"complete-but-invalid"}\n' : middle === "good" ? good("history:2", "second history line") : ""
    const planted = good("history:1", "first history line") + bad + good("history:3", "third history line")
    writeFileSync(file, planted)
    if (middle === "torn-last") appendFileSync(file, '{"id":"torn","at":"2026-09-01T12')
    let stderr = ""
    const capture = spyOn(process.stderr, "write").mockImplementation(((chunk: any) => { stderr += String(chunk); return true }) as any)
    const store = await superStore(cluster, it.db)
    let door: Awaited<ReturnType<typeof runDoor>> | undefined
    try {
      // Work the door owes this file before it can be ready: startup repair.
      const owed = "telegram:1000000001:7"
      await store.sql.begin(async sql => { await enqueueInbound({ ...store, sql: sql as any }, { id: owed, person: "p1", agent: "p1-lair", body: "owed at start",
        source: { log_id: owed, at, door: "door-fake", chat: "1000000001", sender_id: "p1", text: "owed at start" }, log_ready: false } as any) })
      door = await runDoor({ door: "door-fake", registryFile: it.registryFile, platform: it.edge.platform })
      expect((await it.read.sql("select log_ready from inbound where id = $1", [owed]))[0].log_ready, "startup repair projected the owed line").toBe(true)
      // And a new message on the same day is accepted through the same file.
      it.edge.batch([{ platform_message_id: "8", chat: "1000000001", sender_id: "p1", from: "p1", text: "accepted after", at, media: [] }], "9")
      expect(await observe(async () => (await it.read.sql("select log_ready from inbound where id = 'telegram:1000000001:8'"))[0]?.log_ready === true), "a new message on the same day is accepted").toBe(true)
      const bytes = readFileSync(file, "utf8")
      const texts = bytes.trim().split("\n").flatMap(raw => { try { return [JSON.parse(raw).text] } catch { return [] } })
      expect(texts.filter(text => text === "owed at start")).toHaveLength(1)
      expect(texts.filter(text => text === "accepted after")).toHaveLength(1)
      const failures = (await it.read.ledger({ stream: "operation", kind: "failed" })).filter(row => String(row.subject).startsWith(file))
      if (middle === "malformed" || middle === "invalid") {
        // A complete record is never truncated, so its bytes stay.
        expect(bytes.startsWith(planted), "the skipped record stays on disk").toBe(true)
        expect(failures, "one diary entry names the file and the line").toHaveLength(1)
        expect(failures[0].subject).toBe(`${file}:2`)
        expect(stderr).toContain(`${file}:2`)
      } else {
        expect(failures).toHaveLength(0)
        expect(stderr).not.toContain(file)
        // The repair of an unfinished last write still applies.
        if (middle === "torn-last") expect(bytes.startsWith(planted + JSON.stringify({ id: owed, at, direction: "in", from: "p1", text: "owed at start" }))).toBe(true)
        else expect(bytes.startsWith(planted)).toBe(true)
      }
      expect(existsSync(file)).toBe(true)
    } finally { await door?.stop(); capture.mockRestore(); await store.sql.close(); await it.stop() }
  })
}

// The door's skip is only half of it: the agent's next spawn is fed the tail of
// the same file, and a tail that refused the record would retry that agent for
// ever with the person hearing nothing.
for (const middle of ["malformed", "good"] as const) {
  test(`IMP-160 D-172 an agent whose day file holds a ${middle} record still answers, fed the rest of its tail`, async () => {
    const it = await rolloutStage(cluster, "telegram", { adapter: { answer: ({ text }) => "answer: " + text } })
    const now = new Date()
    const earlier = new Date(now.getTime() - 60_000).toISOString()
    const history = (id: string, text: string) => JSON.stringify({ id, at: earlier, direction: "in", from: "p1", text }) + "\n"
    const file = chatLogPath({ stateDir: it.stateDir, person: "p1", agent: "p1-lair", at: new Date(earlier) })
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, history("history:1", "first history line") + (middle === "malformed" ? '{"broken":}\n' : history("history:2", "second history line")) + history("history:3", "third history line"))
    let door: Awaited<ReturnType<typeof runDoor>> | undefined
    let runner: Awaited<ReturnType<typeof runRunner>> | undefined
    try {
      const tail = await readTail({ stateDir: it.stateDir, person: "p1", agent: "p1-lair", now, hours: 24, tokens: 8000 }).catch(error => String(error))
      expect(tail, "the tail keeps the good lines around a bad one").toContain("first history line")
      expect(tail).toContain("third history line")
      runner = await runRunner({ runner: "runner-pi", registryFile: it.registryFile, adapters: { [it.adapterName]: it.scripted.adapter } })
      door = await runDoor({ door: "door-fake", registryFile: it.registryFile, platform: it.edge.platform })
      it.edge.batch([{ platform_message_id: "8", chat: "1000000001", sender_id: "p1", from: "p1", text: "still there", at: now.toISOString(), media: [] }], "9")
      expect(await observe(() => it.edge.posts().some(post => post.text === "answer: still there"), 8000), "the agent answers").toBe(true)
    } finally { await door?.stop(); await runner?.stop(); await it.stop() }
  })
}
