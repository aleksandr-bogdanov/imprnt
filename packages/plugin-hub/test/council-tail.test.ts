// A real door projects a seat's report and the merge row into the dispatcher's
// chat log marked as a council's, and neither tail the dispatcher is fed
// carries a word of the seats' answers, while the dispatcher's own reply, an
// ordinary chunk, is in both. A seat's job row carries the same mark on its
// provenance, and has no chat log of its own to be projected into.

import { afterAll, beforeAll, expect, test } from "bun:test"
import { startCluster, until, type Cluster } from "./helpers/cluster.ts"
import { rolloutStage, COUNCIL_SEATS } from "./helpers/rollout-stage.ts"
import { chatLogLines, superStore } from "./helpers/hub-fixture.ts"
import { message } from "./helpers/rollout-ingress.ts"
import { readTail } from "../src/chatlog.ts"
import { deriveTail } from "../src/chatlog/derive.ts"
import { mergeIdOf } from "../src/door/council.ts"
import { COUNCIL_PHRASES, councilRequested } from "../src/door/lines.ts"
import { runDoor } from "../src/door/run.ts"
import { loadRegistry } from "../src/registry/load.ts"
import { settleTurn, type TurnRecord } from "../src/runner/settle.ts"
import { openStore, storeUrlAs } from "../src/store/connect.ts"

let cluster: Cluster
beforeAll(async () => { cluster = await startCluster() })
afterAll(async () => { await cluster?.stop() })

const LAIR_CHAT = "1000000001"
const QUESTION = "should the synthetic ledger be weighed twice"
const ANSWERS: Record<string, string> = {
  "p1-seat-1": "Weigh it twice, the first reading drifts.",
  "p1-seat-2": "Once is enough when the scale is warm.",
  "p1-seat-3": "Twice, and log both readings.",
}
const MERGED = "Weigh it twice and keep both readings. One seat would settle for once on a warm scale."

function turnOf(agent: string): TurnRecord {
  return { agent, runner: "runner-pi", preset: "daily", preset_id: "p", preset_settings: {}, input_tokens: 1, cached_input_tokens: 0,
    output_tokens: 1, price: null, plan_usage: null, raw_usage: {}, session_id: null, lacks: [], tail: false }
}

test("the seats' report lines and the merge row are in the dispatcher's log as a council's and in neither tail, while the dispatcher's own reply is in both", async () => {
  const it = await rolloutStage(cluster, "telegram", { council: true })
  let door: Awaited<ReturnType<typeof runDoor>> | undefined
  const store = await superStore(cluster, it.db)
  const runner = await openStore({ url: storeUrlAs(cluster.url(it.db), "hub_runner") })
  try {
    door = await runDoor({ door: "door-fake", registryFile: it.registryFile, platform: it.edge.platform })
    it.edge.batch([{ ...message("10", `${COUNCIL_PHRASES.en} ${QUESTION}`), chat: LAIR_CHAT, sender_id: "p1", from: "p1" }], "11")
    await until("the seats' jobs reach the queue", async () =>
      (await it.read.inbound()).filter(r => r.kind === "job").length === COUNCIL_SEATS.length, 20_000)
    const jobs = (await it.read.inbound()).filter(r => r.kind === "job")
    const councilId = jobs[0].id.slice(0, jobs[0].id.lastIndexOf(":"))
    // A seat's job carries the mark and is ready at the commit: it has no chat
    // log, so nothing of it is projected anywhere.
    for (const job of jobs) {
      expect((job.source as Record<string, unknown>).origin).toBe("council")
      expect(job.log_ready).toBe(true)
      expect(chatLogLines(it.stateDir, "p1", job.agent)).toEqual([])
    }

    // Every seat settles, as its runner would.
    for (const seat of COUNCIL_SEATS) {
      const job = jobs.find(j => j.agent === seat)!
      await settleTurn(runner, { inboundId: job.id, kind: "job", person: "p1", source: job.source as never, chunks: [ANSWERS[seat]], turn: turnOf(seat) })
    }
    const mergeId = mergeIdOf(councilId)
    await until("the door projected the three reports and the merge", async () => {
      const rows = await it.read.inbound()
      return [...jobs.map(j => `report:${j.id}`), mergeId].every(id => rows.some(r => r.id === id && r.log_ready))
    }, 30_000, async () => JSON.stringify((await it.read.inbound()).map(r => [r.id, r.log_ready])))
    const lines = chatLogLines(it.stateDir, "p1", "p1-lair") as (ReturnType<typeof chatLogLines>[number] & { id?: string; origin?: string })[]
    for (const seat of COUNCIL_SEATS) {
      const line = lines.find(one => one.text === ANSWERS[seat])!
      expect(line).toBeDefined()
      expect(line.origin).toBe("council")
      expect(line.from).toBe(seat)
      expect(line.direction).toBe("in")
    }
    const merge = (await it.read.inbound()).find(r => r.id === mergeId)!
    const mergeLine = lines.find(one => one.id === mergeId)!
    expect(mergeLine).toBeDefined()
    expect(mergeLine.origin).toBe("council")
    expect(mergeLine.from).toBe("council")
    expect(mergeLine.text).toBe(merge.body)
    // The command and the acknowledgement are ordinary lines.
    expect(lines.find(one => one.text === `${COUNCIL_PHRASES.en} ${QUESTION}`)!.origin).toBeUndefined()
    expect(lines.find(one => one.text === councilRequested("en", { count: 3, question: QUESTION }))!.origin).toBeUndefined()

    // The dispatcher answers the merge row as it answers any report: one
    // ordinary chunk, which the door posts into the chat and projects.
    await settleTurn(runner, { inboundId: mergeId, kind: "report", person: "p1", source: merge.source as never, chunks: [MERGED], turn: turnOf("p1-lair") })
    await until("the door posted the merged answer", () => it.edge.posts().some(p => p.chat === LAIR_CHAT && p.text === MERGED), 20_000)
    await until("the door projected the merged answer", async () => chatLogLines(it.stateDir, "p1", "p1-lair").some(one => one.text === MERGED), 20_000)
    const reply = (chatLogLines(it.stateDir, "p1", "p1-lair") as { text: string; origin?: string; from: string }[]).find(one => one.text === MERGED)!
    expect(reply.origin).toBeUndefined()
    expect(reply.from).toBe("p1-lair")
    // Nothing of the seats reached the chat: the merged answer is the one post after the acknowledgement.
    const posted = it.edge.posts().filter(p => p.chat === LAIR_CHAT).map(p => p.text)
    expect(posted).toEqual([councilRequested("en", { count: 3, question: QUESTION }), MERGED])

    // Both tails carry the dispatcher's own words and not one word of a
    // seat's. The typed command is a chat log line with no row of its own, so
    // it is in the file tail alone, as a dispatch command is today.
    const registry = loadRegistry(it.registryFile)
    const where = { person: "p1", agent: "p1-lair", now: new Date(), hours: 24, tokens: 8000 }
    expect(await readTail({ stateDir: it.stateDir, ...where })).toContain(`${COUNCIL_PHRASES.en} ${QUESTION}`)
    for (const tail of [await readTail({ stateDir: it.stateDir, ...where }), await deriveTail(store, { registry, ...where })]) {
      expect(tail).toContain(MERGED)
      for (const seat of COUNCIL_SEATS) {
        expect(tail).not.toContain(ANSWERS[seat])
        expect(tail).not.toContain(seat)
      }
      expect(tail).not.toContain("Seat 1")
      expect(tail).not.toContain("no preamble")
    }
  } finally { await door?.stop(); await runner.close(); await store.close(); await it.stop() }
}, 90_000)
