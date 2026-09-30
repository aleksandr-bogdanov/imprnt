// A participant's answer, and the event the hub hands the master, are a council's: they are in the master's chat
// log marked as one, and in neither tail the master is fed nor any harvest slice. The master's own synthesis, an
// ordinary reply, is in both. A participant's job has no chat log of its own.

import { afterAll, afterEach, beforeAll, expect, test } from "bun:test"
import { startCluster, type Cluster } from "./helpers/cluster.ts"
import { chatLogLines } from "./helpers/hub-fixture.ts"
import { councilStage, roster, startArgs } from "./helpers/council-stage.ts"
import { callTool } from "../src/mcp/handlers.ts"
import { readTail } from "../src/chatlog.ts"
import { deriveSlice, deriveTail, deriveLines } from "../src/chatlog/derive.ts"
import { readSlice } from "../src/harvest/slice.ts"
import { projectInbound } from "../src/chatlog/project.ts"
import { loadRegistry } from "../src/registry/load.ts"

let cluster: Cluster
beforeAll(async () => { cluster = await startCluster() })
afterAll(async () => { await cluster?.stop() })

const mine: { close(): Promise<void> }[] = []
const track = <T extends { close(): Promise<void> }>(sql: T): T => { mine.push(sql); return sql }
afterEach(async () => { for (const one of mine.splice(0)) await one.close().catch(() => {}) })

const ANSWERS: Record<string, string> = {
  "p1-w1": "Weigh it twice, the first reading drifts.",
  "p1-w2": "Once is enough when the scale is warm.",
}
const SYNTHESIS = "Weigh it twice and keep both readings. One view would settle for once on a warm scale."

test("T1 the participants' report lines are the council's in the master's log and in neither tail nor slice, the event is in no log at all, and the master's synthesis is in both", async () => {
  const s = await councilStage(cluster, track)
  try {
    const registry = loadRegistry(s.registryFile)
    const started = await callTool(s.binding("attempt-start"), "hub_council", startArgs({ participants: roster(["p1-w1", "p1-w2"]) }))
    const id = String(started.object_id)
    const jobs = await s.jobsOf(id)
    // A participant's job carries the mark, is ready at the commit, and has no chat log of its own.
    for (const job of jobs) {
      expect(job.source.origin).toBe("council")
      expect(job.log_ready).toBe(true)
      expect(chatLogLines(s.stateDir, "p1", job.agent)).toEqual([])
    }
    for (const job of jobs) await s.answer(job.id, ANSWERS[job.agent])
    const store = { sql: s.su, url: cluster.url(s.db) } as never
    for (const job of jobs) await projectInbound(store, { stateDir: s.stateDir, inboundId: `report:${job.id}` })

    const lines = chatLogLines(s.stateDir, "p1", "p1-lair") as (ReturnType<typeof chatLogLines>[number] & { id?: string; origin?: string })[]
    for (const job of jobs) {
      const line = lines.find(one => one.text === ANSWERS[job.agent])!
      expect(line).toBeDefined()
      expect(line.origin).toBe("council")
      expect(line.from).toBe(job.agent)
      expect(line.direction).toBe("in")
    }
    // The event is written ready (`log_ready`), so it is projected nowhere: it is the master's to read and nobody's line.
    const [event] = Array.from(await s.su`select id, body from inbound where id like 'council-event:%'`) as any[]
    expect(event.body).toContain(ANSWERS["p1-w1"])
    expect(lines.some(one => one.text?.includes("finalize"))).toBe(false)
    expect(lines.some(one => one.id === event.id)).toBe(false)

    // The master reads the event, calls finalize from that attempt, and its reply is the synthesis.
    const attempt = await s.feed(event.id)
    const [{ revision }] = [{ revision: await s.revision(id) }]
    await callTool(s.binding(attempt.id), "hub_council", { action: "continue", request_key: "fin-1", council_id: id, expected_revision: revision, kind: "finalize" })
    await s.settleMaster(event.id, attempt, SYNTHESIS)
    expect((await s.su`select lifecycle from council where id = ${id}`)[0].lifecycle).toBe("complete")

    const where = { person: "p1", agent: "p1-lair", now: new Date(Date.now() + 1_000), hours: 24, tokens: 8000 }
    for (const tail of [await readTail({ stateDir: s.stateDir, ...where }), await deriveTail(store, { registry, ...where })]) {
      for (const answer of Object.values(ANSWERS)) expect(tail).not.toContain(answer)
      for (const worker of Object.keys(ANSWERS)) expect(tail).not.toContain(worker)
      expect(tail).not.toContain("finalize")
    }
    // The store's tail has the master's own words; the file's has them once the door has projected the reply.
    expect(await deriveTail(store, { registry, ...where })).toContain(SYNTHESIS)

    // The harvest slice: the owner's words and the master's, and none of a participant's or the event's.
    const bounds = { person: "p1", agent: "p1-lair", from: null, until: new Date(Date.now() + 60_000).toISOString() }
    const fromStore = await deriveSlice(store, { registry, ...bounds })
    const fromFile = await readSlice({ stateDir: s.stateDir, ...bounds })
    for (const slice of [fromFile, fromStore]) {
      const text = slice.map(one => one.text).join("\n")
      for (const answer of Object.values(ANSWERS)) expect(text).not.toContain(answer)
      expect(text).not.toContain("finalize")
      expect(slice.every(one => one.from === "p1" || one.from === "p1-lair")).toBe(true)
    }
    expect(fromStore.map(one => one.text)).toContain(SYNTHESIS)

    // The store names a report's speaker the way the file does, and the event is the council's.
    const derived = await deriveLines(store, { registry, person: "p1", agent: "p1-lair", from: new Date(Date.now() - 3_600_000).toISOString(), until: where.now.toISOString() })
    for (const job of jobs) expect(derived.find(one => one.text === ANSWERS[job.agent])).toMatchObject({ from: job.agent, origin: "council" })
    expect(derived.find(one => one.id === event.id)).toMatchObject({ from: "council", origin: "council" })
  } finally { await s.close() }
}, 90_000)
