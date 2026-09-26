// One typed line starts several agents on one question, and the chat gets ONE
// merged answer. This file is the door's half: the command is parsed from a
// fetched platform message by an allowed sender, one job row per seat lands
// with the whole envelope, one sheet row holds the council, and the chat is
// told once. The seats' answers never reach the chat, which is the settle's
// half in test/council-merge.test.ts and test/council-tail.test.ts.

import { afterAll, beforeAll, expect, test } from "bun:test"
import { startCluster, type Cluster } from "./helpers/cluster.ts"
import { rolloutStage, COUNCIL_SEATS, COUNCIL_SEATS_RU } from "./helpers/rollout-stage.ts"
import { chatLogLines, superStore } from "./helpers/hub-fixture.ts"
import { observe } from "./helpers/rollout-runner.ts"
import { message } from "./helpers/rollout-ingress.ts"
import { readSlice } from "../src/harvest/slice.ts"
import { councilRefused, councilRequested, councilUsage, COUNCIL_PHRASES, COUNCIL_QUESTION_CAP } from "../src/door/lines.ts"
import { parseCouncil, requestCouncil, taskDigest } from "../src/door/dispatch.ts"
import { COUNCIL_SHEET, seatTask, SEAT_INSTRUCTION } from "../src/door/council.ts"
import { admitJob } from "../src/runner/job.ts"
import { loadRegistry } from "../src/registry/load.ts"
import { runDoor } from "../src/door/run.ts"

let cluster: Cluster
beforeAll(async () => { cluster = await startCluster() })
afterAll(async () => { await cluster?.stop() })

const LAIR_CHAT = "1000000001"
const RU_CHAT = "0000000000"
const QUESTION = "should the synthetic ledger be weighed twice"

function typed(id: string, text: string, chat = LAIR_CHAT, sender = "p1") {
  return { ...message(id, text), chat, sender_id: sender, from: sender }
}

test("the command is parsed in both languages, the question is the rest of the message byte for byte, and an empty question is usage", () => {
  expect(parseCouncil(`${COUNCIL_PHRASES.en} ${QUESTION}`)).toEqual({ question: QUESTION })
  expect(parseCouncil(`${COUNCIL_PHRASES.ru} ${QUESTION}`)).toEqual({ question: QUESTION })
  expect(parseCouncil(`${COUNCIL_PHRASES.en.toUpperCase()} ${QUESTION}`)).toEqual({ question: QUESTION })
  // Byte for byte: inner runs of spaces, newlines and the verb inside it all survive.
  for (const question of ["first line\nsecond line", "weigh  the  codeword", `tell me what ${COUNCIL_PHRASES.en} means`, "one"]) {
    expect(parseCouncil(`${COUNCIL_PHRASES.en} ${question}`)).toEqual({ question })
    expect(parseCouncil(`${COUNCIL_PHRASES.en}   ${question}`)).toEqual({ question })
  }
  expect(parseCouncil(COUNCIL_PHRASES.en)).toBe("usage")
  expect(parseCouncil(`${COUNCIL_PHRASES.ru} `)).toBe("usage")
  expect(parseCouncil(`${COUNCIL_PHRASES.en}\n`)).toBe("usage")
  // Not a command: the verb inside a sentence, a prefix of the verb, an empty message.
  expect(parseCouncil(`please ${COUNCIL_PHRASES.en} this`)).toBeNull()
  expect(parseCouncil(`${COUNCIL_PHRASES.en}s are slow`)).toBeNull()
  expect(parseCouncil("")).toBeNull()
  // The seat's task is the fixed instruction, then the question, whole.
  expect(seatTask(QUESTION)).toBe(`${SEAT_INSTRUCTION}\n\n${QUESTION}`)
  expect(SEAT_INSTRUCTION).not.toContain("seat")
  // The acknowledgement caps the question and says how many seats.
  const long = "x".repeat(COUNCIL_QUESTION_CAP + 40)
  expect(councilRequested("en", { count: 3, question: long })).toBe(`[door] council of 3 started on: ${"x".repeat(COUNCIL_QUESTION_CAP)}...`)
  expect(councilRequested("ru", { count: 2, question: QUESTION })).toBe(`[дверь] совет из 2 начат по вопросу: ${QUESTION}`)
})

test("one typed command lands one admissible job row per seat, one sheet row, one acknowledgement, and a replay lands nothing twice", async () => {
  const it = await rolloutStage(cluster, "telegram", { council: true })
  let door: Awaited<ReturnType<typeof runDoor>> | undefined
  try {
    door = await runDoor({ door: "door-fake", registryFile: it.registryFile, platform: it.edge.platform })
    const before = it.edge.posts().length
    it.edge.batch([typed("10", `${COUNCIL_PHRASES.en} ${QUESTION}`)], "11")
    expect(await observe(async () => (await it.read.inbound()).filter(r => r.kind === "job").length === COUNCIL_SEATS.length, 20_000)).toBe(true)
    const jobs = (await it.read.inbound()).filter(r => r.kind === "job")
    const councilId = "council:telegram:" + LAIR_CHAT + ":10"
    expect(jobs.map(j => j.agent).sort()).toEqual([...COUNCIL_SEATS].sort())
    for (const job of jobs) {
      expect(job.id).toBe(`${councilId}:${job.agent}`)
      expect(job.person).toBe("p1")
      expect(job.rank).toBe(1)
      // The task is the fixed instruction and then the question, byte for byte,
      // and the digest is recomputed HERE over those bytes.
      expect(job.body).toBe(seatTask(QUESTION))
      const source = job.source as Record<string, any>
      expect(source.dispatch).toEqual({
        dispatcher: "p1-lair", target: job.agent,
        approved: { by: "p1", at: expect.any(String), digest: taskDigest(seatTask(QUESTION)), source: "council" },
        return: { agent: "p1-lair", door: "door-fake", chat: LAIR_CHAT },
        council: { id: councilId, seats: COUNCIL_SEATS, seat: job.agent },
      })
      expect(source.origin).toBe("council")
      // A seat has no chat: no door and no chat on the row, and ready at the commit.
      expect(source.door).toBeUndefined()
      expect(source.chat).toBeUndefined()
      expect(job.log_ready).toBe(true)
      // The runner's own gate admits every seat's row as it stands.
      expect(admitJob({ body: job.body, source: job.source as never })).toBeNull()
    }
    // The sheet row: one per council, nothing answered yet.
    const sheet = await it.read.sheet(COUNCIL_SHEET)
    expect(sheet).toHaveLength(1)
    expect(sheet[0].id).toBe(councilId)
    expect(sheet[0].data).toEqual({ person: "p1", agent: "p1-lair", door: "door-fake", chat: LAIR_CHAT,
      task: QUESTION, seats: COUNCIL_SEATS, at: expect.any(String), answered: {} })

    // The chat log carries what was typed and what the door answered, once.
    const lines = chatLogLines(it.stateDir, "p1", "p1-lair")
    expect(lines.map(l => ({ direction: l.direction, text: l.text }))).toEqual([
      { direction: "in", text: `${COUNCIL_PHRASES.en} ${QUESTION}` },
      { direction: "out", text: councilRequested("en", { count: COUNCIL_SEATS.length, question: QUESTION }) },
    ])
    expect(it.edge.posts().slice(before).map(p => ({ chat: p.chat, text: p.text })))
      .toEqual([{ chat: LAIR_CHAT, text: councilRequested("en", { count: COUNCIL_SEATS.length, question: QUESTION }) }])

    // One diary line per seat and one for the council.
    const diary = await it.read.ledger({ stream: "control" })
    expect(diary.filter(e => e.kind === "dispatch.requested").map(e => e.subject).sort()).toEqual(jobs.map(j => j.id).sort())
    const convened = diary.filter(e => e.kind === "council.requested")
    expect(convened).toHaveLength(1)
    expect(convened[0].subject).toBe(councilId)
    expect(convened[0].actor).toBe("door")
    expect(convened[0].detail).toMatchObject({ by: "p1", agent: "p1-lair", seats: COUNCIL_SEATS })

    // A replay of the same platform message lands nothing on any of them.
    it.edge.batch([typed("10", `${COUNCIL_PHRASES.en} ${QUESTION}`)], "12")
    expect(await observe(() => it.edge.pulls().some(p => p.chat === LAIR_CHAT && p.cursor === "12"), 20_000)).toBe(true)
    expect((await it.read.inbound()).filter(r => r.kind === "job")).toHaveLength(COUNCIL_SEATS.length)
    expect(await it.read.sheet(COUNCIL_SHEET)).toHaveLength(1)
    expect(chatLogLines(it.stateDir, "p1", "p1-lair")).toHaveLength(2)
    expect(it.edge.posts().slice(before)).toHaveLength(1)
    expect((await it.read.ledger({ kind: "council.requested" }))).toHaveLength(1)

    // The command is not a message: the slice a harvest reads drops it.
    const slice = await readSlice({ stateDir: it.stateDir, person: "p1", agent: "p1-lair",
      from: null, until: new Date(Date.now() + 60_000).toISOString() })
    expect(slice.map(l => l.text)).toEqual([])
  } finally { await door?.stop(); await it.stop() }
}, 60_000)

test("the Russian verb answers in Russian for the second person's two seats, and a missing question is the usage line", async () => {
  const it = await rolloutStage(cluster, "telegram", { council: true })
  let door: Awaited<ReturnType<typeof runDoor>> | undefined
  try {
    door = await runDoor({ door: "door-fake", registryFile: it.registryFile, platform: it.edge.platform })
    it.edge.batch([typed("30", `${COUNCIL_PHRASES.ru} ${QUESTION}`, RU_CHAT, "p2")], "31")
    expect(await observe(async () => (await it.read.inbound()).filter(r => r.kind === "job").length === COUNCIL_SEATS_RU.length, 20_000)).toBe(true)
    const jobs = (await it.read.inbound()).filter(r => r.kind === "job")
    expect(jobs.map(j => j.agent).sort()).toEqual([...COUNCIL_SEATS_RU].sort())
    expect(jobs.every(j => j.person === "p2")).toBe(true)
    const said = () => it.edge.posts().filter(p => p.chat === RU_CHAT).map(p => p.text)
    expect(said()).toContain(councilRequested("ru", { count: 2, question: QUESTION }))
    expect(said()).not.toContain(councilRequested("en", { count: 2, question: QUESTION }))
    // The verb alone: usage, in Russian, and nothing queued for it.
    it.edge.batch([typed("32", COUNCIL_PHRASES.ru, RU_CHAT, "p2")], "33")
    expect(await observe(() => said().length === 2, 20_000)).toBe(true)
    expect(said()[1]).toBe(councilUsage("ru"))
    expect((await it.read.inbound()).filter(r => r.kind === "job")).toHaveLength(2)
    expect(await it.read.sheet(COUNCIL_SHEET)).toHaveLength(1)
  } finally { await door?.stop(); await it.stop() }
}, 60_000)

test("a person with no council reads the usage line and nothing is queued, and the three refusals carry one name", async () => {
  // The household every shipped check loads: no seat anywhere.
  const it = await rolloutStage(cluster, "telegram", { dispatch: true })
  let door: Awaited<ReturnType<typeof runDoor>> | undefined
  const store = await superStore(cluster, it.db)
  try {
    door = await runDoor({ door: "door-fake", registryFile: it.registryFile, platform: it.edge.platform })
    const said = () => it.edge.posts().filter(p => p.chat === LAIR_CHAT).map(p => p.text)
    it.edge.batch([typed("40", `${COUNCIL_PHRASES.en} ${QUESTION}`)], "41")
    expect(await observe(() => said().length === 1, 20_000)).toBe(true)
    expect(said()[0]).toBe(councilUsage("en"))
    expect(await it.read.inbound()).toEqual([])
    expect(await it.read.sheet(COUNCIL_SHEET)).toEqual([])
    expect(await it.read.ledger({ kind: "council.requested" })).toEqual([])

    // The request itself refuses by ONE name, whichever of the three it is.
    const registry = loadRegistry(it.registryFile)
    const good = { base: "telegram:" + LAIR_CHAT + ":42", registry, person: "p1", door: "door-fake", chat: LAIR_CHAT,
      agent: "p1-lair", sender_id: "p1", question: QUESTION, at: new Date().toISOString() }
    for (const [what, bad] of [
      ["a sender the allowlist does not name", { ...good, sender_id: "unlisted" }],
      ["a chat no agent of this person answers in", { ...good, chat: "9999999999" }],
      ["a person with no council", good],
    ] as const) {
      let refusal: unknown
      try { await requestCouncil(store, bad) } catch (error) { refusal = error }
      expect((refusal as Error)?.name, what).toBe("CouncilRefused")
      expect((refusal as Error)?.message, what).toBe("council-not-authorized")
    }
    expect(await it.read.inbound()).toEqual([])
    expect(await it.read.sheet(COUNCIL_SHEET)).toEqual([])
    expect(councilRefused("en", { cause: "access denied" })).toBe("[door] council refused: access denied.")
    expect(councilRefused("ru", { cause: "access denied" })).toBe("[дверь] совет отклонён: доступ запрещён.")
  } finally { await door?.stop(); await store.close(); await it.stop() }
}, 60_000)
