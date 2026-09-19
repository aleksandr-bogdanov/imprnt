// One damaged record in a chat log costs only itself, in the harvest's walk too.
//
// The door and the agent's tail already step over a complete record that is not
// a chat line and name it by file and line. The harvest's own walk refused the
// whole file instead, and that refusal is not quiet: a person's "harvest this"
// is read while the door ACCEPTS the batch, before the message is written, so
// the throw refused the batch, the platform cursor stayed where it was, and
// every message that person sent to that chat afterwards waited behind it until
// somebody repaired the file by hand. The chat's scheduled harvest threw on
// every tick for the same reason.
//
// Two halves here. The walk itself, planted by hand so the reported line number
// can be checked against a file with a blank line in it, and the door, where
// the cost really lands.

import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdirSync, writeFileSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { startCluster, type Cluster } from "./helpers/cluster.ts"
import { rolloutStage } from "./helpers/rollout-stage.ts"
import { observe } from "./helpers/rollout-runner.ts"
import { chatLogPath, type BadRecord } from "../src/chatlog.ts"
import { newestLine, readSlice } from "../src/harvest/slice.ts"
import { runDoor } from "../src/door/run.ts"

const PERSON = "p1"
const AGENT = "p1-lair"
const CHAT = "1000000001"

let cluster: Cluster
beforeAll(async () => { cluster = await startCluster() })
afterAll(async () => { await cluster?.stop() })

const line = (at: string, text: string) =>
  JSON.stringify({ at, direction: "in", from: PERSON, text })

/** A day file written whole, one string per file line. */
function plant(stateDir: string, at: Date, rows: string[]): string {
  const file = chatLogPath({ stateDir, person: PERSON, agent: AGENT, at })
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, rows.join("\n") + "\n", "utf8")
  return file
}

test("a damaged record in the middle of a day file is skipped and named by its own line, and the rest of the slice is read", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "hub-slice-bad-"))
  try {
    const day = new Date("2026-09-16T00:00:00.000Z")
    const first = "2026-09-16T09:00:00.000Z"
    const last = "2026-09-16T09:30:00.000Z"
    // A BLANK LINE above the damage, on purpose: a walk that numbered records
    // instead of file lines would name line 3 and 4 and send whoever reads the
    // report to the wrong place in the file.
    const file = plant(stateDir, day, [
      line(first, "the first thing said"),
      "",
      '{"broken":}',
      '{"id":"complete-but-not-a-chat-line"}',
      line(last, "the last thing said"),
    ])

    const where = { stateDir, person: PERSON, agent: AGENT }
    const named: BadRecord[] = []
    const slice = await readSlice({ ...where, from: null, until: "2026-09-16T23:00:00.000Z",
      skipBad: bad => { named.push(bad) } })
    expect(slice.map(one => one.text), "both good lines survive the damaged ones").toEqual([
      "the first thing said", "the last thing said",
    ])
    expect(named, "each damaged record named by its file and its own 1-based line").toEqual([
      { file, line: 3 }, { file, line: 4 },
    ])

    // The clock's own read of the same file is the other half of a harvest tick.
    const newestNamed: BadRecord[] = []
    const newest = await newestLine({ ...where, now: new Date("2026-09-16T23:00:00.000Z"),
      skipBad: bad => { newestNamed.push(bad) } })
    expect(newest?.text, "the quiet clock reads the newest good line").toBe("the last thing said")
    expect(newestNamed.map(one => one.line)).toEqual([3, 4])
  } finally { await rm(stateDir, { recursive: true, force: true }).catch(() => {}) }
})

test("a torn last line still costs nothing and is named to nobody, and a clean log reads exactly as before", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "hub-slice-torn-"))
  try {
    const day = new Date("2026-09-16T00:00:00.000Z")
    const at = "2026-09-16T09:00:00.000Z"
    const where = { stateDir, person: PERSON, agent: AGENT }
    const until = "2026-09-16T23:00:00.000Z"

    // Control: a clean log, which is what every other chat looks like.
    plant(stateDir, day, [line(at, "one"), line("2026-09-16T09:05:00.000Z", "two")])
    const clean: BadRecord[] = []
    const before = await readSlice({ ...where, from: null, until, skipBad: bad => { clean.push(bad) } })
    expect(before.map(one => one.text)).toEqual(["one", "two"])
    expect(clean, "a clean log names nothing").toEqual([])

    // A write that never finished: the last line with bytes in the newest file.
    const file = chatLogPath({ stateDir, person: PERSON, agent: AGENT, at: day })
    writeFileSync(file, [line(at, "one"), line("2026-09-16T09:05:00.000Z", "two"),
      '{"at":"2026-09-16T09:07:00.000Z","direction":"in","fr'].join("\n"), "utf8")
    const torn: BadRecord[] = []
    const after = await readSlice({ ...where, from: null, until, skipBad: bad => { torn.push(bad) } })
    expect(after.map(one => one.text), "the finished lines are unchanged").toEqual(["one", "two"])
    expect(torn, "an unfinished last write is not a damaged record").toEqual([])
  } finally { await rm(stateDir, { recursive: true, force: true }).catch(() => {}) }
})

for (const damaged of [true, false]) {
  test(`a chat whose log ${damaged ? "holds a damaged record" : "is clean"} accepts a harvest demand and every message after it`, async () => {
    const it = await rolloutStage(cluster, "telegram", {
      machines: [{ id: "pi", os: "linux" }],
      run: [{ id: "door-fake", kind: "door", machine: "pi", platform: "fake", person: PERSON, token_file: "/dev/null" },
        { id: "runner-pi", kind: "runner", machine: "pi", child_memory_limit_mb: 256 }],
    })
    const said = new Date(Date.now() - 3_600_000)
    const at = said.toISOString()
    const rows = [line(at, "history the harvest would take")]
    if (damaged) rows.push('{"broken":}')
    rows.push(line(new Date(said.getTime() + 60_000).toISOString(), "and one more"))
    const file = plant(it.stateDir, said, rows)
    let door: Awaited<ReturnType<typeof runDoor>> | undefined
    try {
      door = await runDoor({ door: "door-fake", registryFile: it.registryFile, platform: it.edge.platform })
      const now = new Date().toISOString()
      it.edge.batch([
        { platform_message_id: "1", chat: CHAT, sender_id: PERSON, from: PERSON, text: "harvest this", at: now, media: [] },
        { platform_message_id: "2", chat: CHAT, sender_id: PERSON, from: PERSON, text: "and this is the message after it", at: now, media: [] },
      ], "3")
      expect(await observe(async () => (await it.read.sql(
        "select id from inbound where id = 'harvest-demand:telegram:1000000001:1'")).length === 1, 15_000),
        "the demand is accepted").toBe(true)
      expect(await observe(async () => (await it.read.sql(
        "select log_ready from inbound where id = 'telegram:1000000001:2'"))[0]?.log_ready === true, 15_000),
        "the message sent after the demand arrives").toBe(true)
      expect(await observe(async () => (await it.read.sheet("door_cursor"))
        .find(row => row.id === "door-fake/1000000001")?.data.cursor === "3", 15_000),
        "the platform cursor moves past the batch").toBe(true)
      const demand = (await it.read.sql(
        "select body from inbound where id = 'harvest-demand:telegram:1000000001:1'"))[0] as { body: string }
      expect(JSON.parse(demand.body).lines, "the slice counted the readable lines").toBe(2)
      const skipped = (await it.read.ledger({ stream: "operation", kind: "failed" }))
        .filter(row => String(row.subject).startsWith(file))
      if (damaged) {
        expect(skipped.map(row => row.subject), "the skipped record is named by file and line").toEqual([`${file}:2`])
      } else {
        expect(skipped, "a clean log names nothing").toEqual([])
      }
      // Nothing about the chat is reported as failing: a skipped record is not
      // a chat the door cannot read.
      expect((await it.read.sheet("door_health")).find(row => row.id === "door-fake/1000000001")?.data.cause).toBeUndefined()
    } finally { await door?.stop(); await it.stop() }
  }, 120_000)
}
