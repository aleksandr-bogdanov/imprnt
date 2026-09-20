// Five ways of getting a dispatch wrong, each refused by the cause it names and
// by the state it leaves, each with a control that passes the same path without
// the defect, and all of them in ONE run so a build that refuses everything
// fails the counts at the end.
//
// SPEC §5 rules that a command to another agent refuses without an approval,
// and ROLL-19 rules that the machine owns routing: a model cannot supply the
// return address and cannot create an approved command.
//
// Two of the five are asserted in `test/dispatch-digest.test.ts`, where the
// runner's gate is: the altered command and the planted unapproved row. They
// are cross-referenced by name here rather than repeated, because one defect
// asserted twice is one defect that can be fixed in two ways. What this file
// adds for them is the half that check does not cover.

import { afterAll, beforeAll, expect, test } from "bun:test"
import { startCluster, type Cluster } from "./helpers/cluster.ts"
import { rolloutStage, DISPATCH_TARGET } from "./helpers/rollout-stage.ts"
import { chatLogLines } from "./helpers/hub-fixture.ts"
import { observe } from "./helpers/rollout-runner.ts"
import { message } from "./helpers/rollout-ingress.ts"
import { dispatchAccepted, dispatchRefused, dispatchUsage, DISPATCH_PHRASES } from "../src/door/lines.ts"
import { runDoor } from "../src/door/run.ts"

let cluster: Cluster
beforeAll(async () => { cluster = await startCluster() })
afterAll(async () => { await cluster?.stop() })

const LAIR_CHAT = "1000000001"
const RU_CHAT = "0000000000"
const TASK = "weigh the synthetic codeword"

function typed(id: string, text: string, chat = LAIR_CHAT, sender = "p1") {
  return { ...message(id, text), chat, sender_id: sender, from: sender }
}

test("D-215 a denied sender's dispatch saves nothing at all, and an allowed one lands a job", async () => {
  const it = await rolloutStage(cluster, "telegram", { dispatch: true })
  let door: Awaited<ReturnType<typeof runDoor>> | undefined
  try {
    door = await runDoor({ door: "door-fake", registryFile: it.registryFile, platform: it.edge.platform })
    const before = it.edge.posts().length
    // A sender the allowlist does not name is refused before the command is
    // ever read, by the shipped path any denied sender meets.
    it.edge.batch([{ ...typed("50", `${DISPATCH_PHRASES.en} ${DISPATCH_TARGET} ${TASK}`), sender_id: "unlisted" }], "51")
    expect(await observe(async () => (await it.read.sheet("sender_denied")).length > 0, 20_000)).toBe(true)
    expect(await it.read.inbound()).toEqual([])
    expect(chatLogLines(it.stateDir, "p1", "p1-lair")).toEqual([])
    expect(it.edge.posts().slice(before)).toEqual([])
    const denied = await it.read.sheet("sender_denied")
    expect(denied).toHaveLength(1)
    // The sender's own words are never recorded, which is what a denied sender
    // record is allowed to hold.
    expect(JSON.stringify(denied[0].data)).not.toContain(TASK)
    // The control: the same text from an allowed sender yields one job row.
    it.edge.batch([typed("52", `${DISPATCH_PHRASES.en} ${DISPATCH_TARGET} ${TASK}`)], "53")
    expect(await observe(async () => (await it.read.inbound()).some(r => r.kind === "job"), 20_000)).toBe(true)
    expect((await it.read.inbound()).filter(r => r.kind === "job")).toHaveLength(1)
  } finally { await door?.stop(); await it.stop() }
}, 60_000)

test("D-215 the four door refusals and the two good dispatches, in one run", async () => {
  const it = await rolloutStage(cluster, "telegram", { dispatch: true })
  let door: Awaited<ReturnType<typeof runDoor>> | undefined
  try {
    door = await runDoor({ door: "door-fake", registryFile: it.registryFile, platform: it.edge.platform })
    const said = () => it.edge.posts().filter(p => p.chat === LAIR_CHAT).map(p => p.text)

    // A cross-person dispatch. The target must be an agent of the SAME person,
    // which is the rule the shipped recovery command already reads.
    it.edge.batch([typed("60", `${DISPATCH_PHRASES.en} p2-lair ${TASK}`)], "61")
    expect(await observe(() => said().length === 1, 20_000)).toBe(true)
    expect(said()[0]).toBe(dispatchRefused("en", { agent: "p2-lair", cause: "access denied" }))

    // A self-dispatch: the dispatcher is the chat's own agent, and a job for
    // itself is a loop.
    it.edge.batch([typed("62", `${DISPATCH_PHRASES.en} p1-lair ${TASK}`)], "63")
    expect(await observe(() => said().length === 2, 20_000)).toBe(true)
    expect(said()[1]).toBe(dispatchRefused("en", { agent: "p1-lair", cause: "access denied" }))

    // A target that does not exist, refused IDENTICALLY to another person's
    // agent, so the refusal tells an attacker nothing about which agents exist.
    it.edge.batch([typed("64", `${DISPATCH_PHRASES.en} p1-nowhere ${TASK}`)], "65")
    expect(await observe(() => said().length === 3, 20_000)).toBe(true)
    expect(said()[2]).toBe(dispatchRefused("en", { agent: "p1-nowhere", cause: "access denied" }))
    expect(said()[2].replace("p1-nowhere", "")).toBe(said()[0].replace("p2-lair", ""))

    // Usage, one value at a time, because a parser that accepted one of these
    // would queue a job whose task nobody typed.
    for (const [nth, text] of [`${DISPATCH_PHRASES.en}`, `${DISPATCH_PHRASES.en} ${DISPATCH_TARGET}`,
      `${DISPATCH_PHRASES.en} `].entries()) {
      it.edge.batch([typed(String(70 + nth), text)], String(71 + nth * 2))
      expect(await observe(() => said().length === 4 + nth, 20_000)).toBe(true)
      expect(said()[3 + nth]).toBe(dispatchUsage("en"))
    }

    // Nothing is saved on a refusal except the record that says so: the command
    // is in the log because a person typed it and a person can see what they
    // typed, and the store holds nothing at all.
    expect((await it.read.inbound()).filter(r => r.kind === "job")).toEqual([])
    expect(await it.read.sheet("control")).toEqual([])
    expect((await it.read.ledger()).filter(e => e.stream === "control")).toEqual([])
    const lines = chatLogLines(it.stateDir, "p1", "p1-lair")
    expect(lines.map(l => l.direction)).toEqual(["in", "out", "in", "out", "in", "out", "in", "out", "in", "out", "in", "out"])

    // The controls, in the same run: a good dispatch in each language. Without
    // them a build that refused everything passes every assertion above.
    it.edge.batch([typed("80", `${DISPATCH_PHRASES.en} ${DISPATCH_TARGET} ${TASK}`)], "81")
    it.edge.batch([typed("82", `${DISPATCH_PHRASES.ru} p2-research ${TASK}`, RU_CHAT, "p2")], "83")
    expect(await observe(async () => (await it.read.inbound()).filter(r => r.kind === "job").length === 2, 30_000)).toBe(true)
    expect(said()[6]).toBe(dispatchAccepted("en", { agent: DISPATCH_TARGET }))
    expect(it.edge.posts().filter(p => p.chat === RU_CHAT).map(p => p.text))
      .toContain(dispatchAccepted("ru", { agent: "p2-research" }))
    const jobs = (await it.read.inbound()).filter(r => r.kind === "job")
    expect(jobs.map(r => r.agent).sort()).toEqual([DISPATCH_TARGET, "p2-research"])
  } finally { await door?.stop(); await it.stop() }
}, 90_000)

test("D-215 the Russian usage line is the Russian one", async () => {
  const it = await rolloutStage(cluster, "telegram", { dispatch: true })
  let door: Awaited<ReturnType<typeof runDoor>> | undefined
  try {
    door = await runDoor({ door: "door-fake", registryFile: it.registryFile, platform: it.edge.platform })
    it.edge.batch([typed("90", DISPATCH_PHRASES.ru, RU_CHAT, "p2")], "91")
    expect(await observe(() => it.edge.posts().some(p => p.chat === RU_CHAT), 20_000)).toBe(true)
    expect(it.edge.posts().filter(p => p.chat === RU_CHAT).map(p => p.text)).toEqual([dispatchUsage("ru")])
    expect((await it.read.inbound()).filter(r => r.kind === "job")).toEqual([])
  } finally { await door?.stop(); await it.stop() }
}, 60_000)
