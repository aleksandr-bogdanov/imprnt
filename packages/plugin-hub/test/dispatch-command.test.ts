// A person types it, the machine records it, and nothing a model writes creates one.
//
// SPEC §2 rules that an agent produces text and never calls a send tool, for a
// human or for another agent, and SPEC §5 rules that a command to another agent
// refuses without an approval. Both together say a job is created by a PERSON
// and carried by machinery, which is what the door does here: the command is
// parsed from a fetched platform message by an allowed sender, the return route
// is pinned to the door and chat it arrived in, and the envelope carries who
// approved what.

import { afterAll, beforeAll, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { startCluster, seam, hubPath, type Cluster } from "./helpers/cluster.ts"
import { rolloutStage, DISPATCH_TARGET, DISPATCH_TARGET_CHAT, DISPATCH_TARGET_RU } from "./helpers/rollout-stage.ts"
import { chatLogLines } from "./helpers/hub-fixture.ts"
import { observe } from "./helpers/rollout-runner.ts"
import { message } from "./helpers/rollout-ingress.ts"
import { readSlice } from "../src/harvest/slice.ts"
import { dispatchAccepted, DISPATCH_PHRASES } from "../src/door/lines.ts"
import { runDoor } from "../src/door/run.ts"
import { runRunner } from "../src/runner/run.ts"

let cluster: Cluster
beforeAll(async () => { cluster = await startCluster() })
afterAll(async () => { await cluster?.stop() })

const LAIR_CHAT = "1000000001"
const RU_CHAT = "0000000000"
const CODEWORD = "weigh the synthetic codeword"

function sha256(text: string): string {
  return new Bun.CryptoHasher("sha256").update(text).digest("hex")
}

/** A message in a chat of the check's choosing, from that person's own sender. */
function typed(id: string, text: string, chat = LAIR_CHAT, sender = "p1") {
  return { ...message(id, text), chat, sender_id: sender, from: sender }
}

test("D-211 one typed command lands one job row and the whole envelope", async () => {
  const it = await rolloutStage(cluster, "telegram", { dispatch: true })
  let door: Awaited<ReturnType<typeof runDoor>> | undefined
  try {
    door = await runDoor({ door: "door-fake", registryFile: it.registryFile, platform: it.edge.platform })
    const before = it.edge.posts().length
    it.edge.batch([typed("10", `${DISPATCH_PHRASES.en} ${DISPATCH_TARGET} ${CODEWORD}`)], "11")
    expect(await observe(async () => (await it.read.inbound()).some(r => r.kind === "job"), 20_000)).toBe(true)
    const jobs = (await it.read.inbound()).filter(r => r.kind === "job")
    expect(jobs).toHaveLength(1)
    const job = jobs[0]
    expect(job.agent).toBe(DISPATCH_TARGET)
    expect(job.person).toBe("p1")
    expect(job.rank).toBe(1)
    // Byte for byte, including every space inside it: the task is the job's
    // whole input and nothing else will ever be fed to the target.
    expect(job.body).toBe(CODEWORD)
    const source = job.source as Record<string, any>
    // The digest is recomputed HERE, over the task bytes, so a build that
    // hashed the whole message or a trimmed task fails.
    expect(source.dispatch).toEqual({
      dispatcher: "p1-lair", target: DISPATCH_TARGET,
      approved: { by: "p1", at: expect.any(String), digest: sha256(CODEWORD), source: "chat-command" },
      return: { agent: "p1-lair", door: "door-fake", chat: LAIR_CHAT },
    })
    expect(Number.isNaN(Date.parse(source.dispatch.approved.at))).toBe(false)
    // The TARGET's door and chat, because that is what the projection sweep
    // keys on, and never the dispatcher's, which is the return route below.
    expect(source.door).toBe("door-fake")
    expect(source.chat).toBe(DISPATCH_TARGET_CHAT)
    expect(source.chat).not.toBe(source.dispatch.return.chat)
    expect(job.log_ready).toBe(false)

    // The chat log carries what the person typed and what they were told, in
    // that order, compared against the pinned sentence rather than a retyped one.
    const lines = chatLogLines(it.stateDir, "p1", "p1-lair")
    expect(lines.map(l => ({ direction: l.direction, text: l.text }))).toEqual([
      { direction: "in", text: `${DISPATCH_PHRASES.en} ${DISPATCH_TARGET} ${CODEWORD}` },
      { direction: "out", text: dispatchAccepted("en", { agent: DISPATCH_TARGET }) },
    ])
    const posted = it.edge.posts().slice(before)
    expect(posted.map(p => ({ chat: p.chat, text: p.text })))
      .toEqual([{ chat: LAIR_CHAT, text: dispatchAccepted("en", { agent: DISPATCH_TARGET }) }])

    // A replay of the same platform message lands nothing on any of the four.
    it.edge.batch([typed("10", `${DISPATCH_PHRASES.en} ${DISPATCH_TARGET} ${CODEWORD}`)], "12")
    expect(await observe(() => it.edge.pulls().some(p => p.chat === LAIR_CHAT && p.cursor === "12"), 20_000)).toBe(true)
    expect((await it.read.inbound()).filter(r => r.kind === "job")).toHaveLength(1)
    expect(chatLogLines(it.stateDir, "p1", "p1-lair")).toHaveLength(2)
    expect(it.edge.posts().slice(before)).toHaveLength(1)

    // One diary line saying who authorized it, and one only.
    const diary = (await it.read.ledger()).filter(e => e.kind === "dispatch.requested")
    expect(diary).toHaveLength(1)
    expect(diary[0].actor).toBe("door")
    expect(diary[0].subject).toBe(job.id)
    expect(diary[0].detail).toMatchObject({ by: "p1", target: DISPATCH_TARGET, dispatcher: "p1-lair" })

    // The command is not a message: the slice a harvest reads drops it, the
    // same way it drops a recovery command and a demand.
    const slice = await readSlice({ stateDir: it.stateDir, person: "p1", agent: "p1-lair",
      from: null, until: new Date(Date.now() + 60_000).toISOString() })
    expect(slice.map(l => l.text)).toEqual([])
  } finally { await door?.stop(); await it.stop() }
}, 60_000)

for (const [shape, task] of [
  ["a newline", "first line\nsecond line"],
  ["two spaces", "weigh  the codeword"],
  ["the verb inside it", `tell me what ${DISPATCH_PHRASES.en} means`],
  ["one word", "codeword"],
] as const) {
  test(`D-211 the task is the rest of the message, ${shape}, whole`, async () => {
    const it = await rolloutStage(cluster, "telegram", { dispatch: true })
    let door: Awaited<ReturnType<typeof runDoor>> | undefined
    try {
      door = await runDoor({ door: "door-fake", registryFile: it.registryFile, platform: it.edge.platform })
      it.edge.batch([typed("20", `${DISPATCH_PHRASES.en} ${DISPATCH_TARGET} ${task}`)], "21")
      expect(await observe(async () => (await it.read.inbound()).some(r => r.kind === "job"), 20_000)).toBe(true)
      const job = (await it.read.inbound()).find(r => r.kind === "job")!
      expect(job.body).toBe(task)
      expect((job.source as any).dispatch.approved.digest).toBe(sha256(task))
    } finally { await door?.stop(); await it.stop() }
  }, 60_000)
}

test("D-211 the Russian verb answers in Russian in one run, and the English line is absent", async () => {
  const it = await rolloutStage(cluster, "telegram", { dispatch: true })
  let door: Awaited<ReturnType<typeof runDoor>> | undefined
  try {
    door = await runDoor({ door: "door-fake", registryFile: it.registryFile, platform: it.edge.platform })
    it.edge.batch([typed("30", `${DISPATCH_PHRASES.ru} ${DISPATCH_TARGET_RU} ${CODEWORD}`, RU_CHAT, "p2")], "31")
    expect(await observe(async () => (await it.read.inbound()).some(r => r.kind === "job"), 20_000)).toBe(true)
    const job = (await it.read.inbound()).find(r => r.kind === "job")!
    expect(job.agent).toBe(DISPATCH_TARGET_RU)
    expect(job.person).toBe("p2")
    const said = it.edge.posts().filter(p => p.chat === RU_CHAT).map(p => p.text)
    expect(said).toContain(dispatchAccepted("ru", { agent: DISPATCH_TARGET_RU }))
    expect(said).not.toContain(dispatchAccepted("en", { agent: DISPATCH_TARGET_RU }))
  } finally { await door?.stop(); await it.stop() }
}, 60_000)

test("D-211 an agent's own text creates nothing, and an ordinary sentence is an ordinary message", async () => {
  const written = `${DISPATCH_PHRASES.en} p2-lair do this`
  const it = await rolloutStage(cluster, "telegram", { dispatch: true,
    adapter: { answer: (fed: { text: string }) => fed.text.includes("say the command") ? written : "an ordinary answer" } })
  let door: Awaited<ReturnType<typeof runDoor>> | undefined
  let runner: Awaited<ReturnType<typeof runRunner>> | undefined
  try {
    door = await runDoor({ door: "door-fake", registryFile: it.registryFile, platform: it.edge.platform })
    runner = await runRunner({ runner: "runner-pi", registryFile: it.registryFile,
      adapters: { [it.adapterName]: it.scripted.adapter } })
    it.edge.batch([typed("40", "please say the command back to me")], "41")
    // The door parses commands only from FETCHED platform messages, never from
    // an agent's outgoing text, and there is no dispatch verb on the command
    // line at all, so a model has no way to make one.
    expect(await observe(() => it.edge.posts().some(p => p.text === written), 30_000)).toBe(true)
    const rows = await it.read.inbound()
    expect(rows.filter(r => r.kind === "job")).toEqual([])
    expect((await it.read.ledger()).filter(e => e.kind === "dispatch.requested")).toEqual([])
    // The control: the same chat, the same sender, an ordinary sentence, one
    // human row of rank 0. A build that treated every message as a command
    // passes the assertions above and fails this one.
    const human = rows.filter(r => r.kind === "human")
    expect(human).toHaveLength(1)
    expect(human[0].rank).toBe(0)
    expect(human[0].body).toBe("please say the command back to me")
  } finally { await runner?.stop(); await door?.stop(); await it.stop() }
}, 60_000)

test("D-211 there is no dispatch verb on the command line", async () => {
  // A report with nowhere to go is a design of its own and it is not built, so
  // the absence is asserted against the shipped verb list rather than assumed.
  const { command } = await seam("src/entry/command.ts") as { command: (args: string[]) => Promise<number> }
  const it = await rolloutStage(cluster, "telegram", { dispatch: true })
  try {
    expect(await command(["dispatch", DISPATCH_TARGET, CODEWORD])).toBe(2)
    expect(await command(["dispatch", it.registryFile, DISPATCH_TARGET, CODEWORD])).toBe(2)
    const verbs = readFileSync(hubPath("src/entry/command.ts"), "utf8")
    expect(verbs).toContain(`["check", "status", "metrics", "install", "recover"].includes(verb)`)
    expect(verbs).not.toContain('"dispatch"')
  } finally { await it.stop() }
}, 60_000)
