// `/council` and `/совет` no longer convene anything by themselves. The door used to put one
// question to every configured seat and merge the answers; nobody had said who should take part.
// Now the line is the owner's own message to the agent, marked with the command it began with, and
// the agent (which has the council tool) asks for the roster when the message did not say and
// starts the council on that very message as its evidence. This file is the door's half.

import { afterAll, beforeAll, expect, test } from "bun:test"
import { startCluster, type Cluster } from "./helpers/cluster.ts"
import { rolloutStage } from "./helpers/rollout-stage.ts"
import { chatLogLines } from "./helpers/hub-fixture.ts"
import { observe } from "./helpers/rollout-runner.ts"
import { message } from "./helpers/rollout-ingress.ts"
import { COUNCIL_PHRASES } from "../src/door/lines.ts"
import { parseCouncil } from "../src/door/dispatch.ts"
import { COUNCIL_SHEET } from "../src/door/council.ts"
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

test("the command is still recognized in both languages, and the question is the rest of the message byte for byte", () => {
  expect(parseCouncil(`${COUNCIL_PHRASES.en} ${QUESTION}`)).toEqual({ question: QUESTION })
  expect(parseCouncil(`${COUNCIL_PHRASES.ru} ${QUESTION}`)).toEqual({ question: QUESTION })
  expect(parseCouncil(`${COUNCIL_PHRASES.en.toUpperCase()} ${QUESTION}`)).toEqual({ question: QUESTION })
  for (const question of ["first line\nsecond line", "weigh  the  codeword", `tell me what ${COUNCIL_PHRASES.en} means`, "one"]) {
    expect(parseCouncil(`${COUNCIL_PHRASES.en} ${question}`)).toEqual({ question })
    expect(parseCouncil(`${COUNCIL_PHRASES.en}   ${question}`)).toEqual({ question })
  }
  expect(parseCouncil(COUNCIL_PHRASES.en)).toBe("usage")
  expect(parseCouncil(`${COUNCIL_PHRASES.ru} `)).toBe("usage")
  expect(parseCouncil(`please ${COUNCIL_PHRASES.en} this`)).toBeNull()
  expect(parseCouncil(`${COUNCIL_PHRASES.en}s are slow`)).toBeNull()
  expect(parseCouncil("")).toBeNull()
})

test("the command reaches the agent as the owner's own message, marked with it: no job, no sheet row, no merge, and nothing the door says by itself", async () => {
  // A household WITH configured seats: the old door would have asked every one of them.
  const it = await rolloutStage(cluster, "telegram", { council: true })
  let door: Awaited<ReturnType<typeof runDoor>> | undefined
  try {
    door = await runDoor({ door: "door-fake", registryFile: it.registryFile, platform: it.edge.platform })
    const before = it.edge.posts().length
    it.edge.batch([typed("10", `${COUNCIL_PHRASES.en} ${QUESTION}`)], "11")
    expect(await observe(async () => (await it.read.inbound()).some(r => r.kind === "human"), 20_000)).toBe(true)
    const rows = await it.read.inbound()
    expect(rows.filter(r => r.kind === "job"), "nothing was put to any seat").toEqual([])
    const human = rows.find(r => r.kind === "human")!
    expect(human).toMatchObject({ agent: "p1-lair", person: "p1", body: `${COUNCIL_PHRASES.en} ${QUESTION}` })
    const source = human.source as Record<string, unknown>
    expect(source.command).toBe("council")
    expect(source.sender_id, "the sender is the evidence a council later cites").toBe("p1")
    expect(await it.read.sheet(COUNCIL_SHEET)).toEqual([])
    expect(await it.read.ledger({ kind: "council.requested" })).toEqual([])
    expect(await it.read.ledger({ kind: "dispatch.requested" })).toEqual([])
    expect(it.edge.posts().slice(before), "no acknowledgement of a council nobody started").toEqual([])
    expect(chatLogLines(it.stateDir, "p1", "p1-lair").map(l => ({ direction: l.direction, text: l.text })))
      .toEqual([{ direction: "in", text: `${COUNCIL_PHRASES.en} ${QUESTION}` }])

    // A replay of the same platform message lands one row.
    it.edge.batch([typed("10", `${COUNCIL_PHRASES.en} ${QUESTION}`)], "12")
    expect(await observe(() => it.edge.pulls().some(p => p.chat === LAIR_CHAT && p.cursor === "12"), 20_000)).toBe(true)
    expect((await it.read.inbound()).filter(r => r.kind === "human")).toHaveLength(1)
  } finally { await door?.stop(); await it.stop() }
}, 60_000)

test("the Russian verb and the verb alone are the same: the owner's message, marked, and nothing convened", async () => {
  const it = await rolloutStage(cluster, "telegram", { council: true })
  let door: Awaited<ReturnType<typeof runDoor>> | undefined
  try {
    door = await runDoor({ door: "door-fake", registryFile: it.registryFile, platform: it.edge.platform })
    it.edge.batch([typed("30", `${COUNCIL_PHRASES.ru} ${QUESTION}`, RU_CHAT, "p2"), typed("32", COUNCIL_PHRASES.ru, RU_CHAT, "p2")], "33")
    expect(await observe(async () => (await it.read.inbound()).filter(r => r.kind === "human").length === 2, 20_000)).toBe(true)
    const rows = await it.read.inbound()
    expect(rows.filter(r => r.kind === "job")).toEqual([])
    for (const human of rows.filter(r => r.kind === "human")) {
      expect(human).toMatchObject({ agent: "p2-lair", person: "p2" })
      expect((human.source as Record<string, unknown>).command).toBe("council")
    }
    expect(it.edge.posts().filter(p => p.chat === RU_CHAT)).toEqual([])
  } finally { await door?.stop(); await it.stop() }
}, 60_000)

test("a person with no configured worker at all is treated the same: the message goes to the agent, which asks who should take part", async () => {
  const it = await rolloutStage(cluster, "telegram", { dispatch: true })
  let door: Awaited<ReturnType<typeof runDoor>> | undefined
  try {
    door = await runDoor({ door: "door-fake", registryFile: it.registryFile, platform: it.edge.platform })
    it.edge.batch([typed("40", `${COUNCIL_PHRASES.en} ${QUESTION}`)], "41")
    expect(await observe(async () => (await it.read.inbound()).some(r => r.kind === "human"), 20_000)).toBe(true)
    expect((await it.read.inbound()).filter(r => r.kind === "job")).toEqual([])
    expect(it.edge.posts().filter(p => p.chat === LAIR_CHAT)).toEqual([])
  } finally { await door?.stop(); await it.stop() }
}, 60_000)
