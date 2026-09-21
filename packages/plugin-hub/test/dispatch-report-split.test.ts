// The dispatcher's answer to a report is cut for the platform it is posted on.
//
// A person's message carries its platform at the front of its id, and the
// answer to it is cut at that platform's limit. A report's id starts with the
// word `report` instead, so its answer fell through to the shorter limit on
// every platform and a Telegram chat got a long answer in pieces it did not
// need. The report goes back on the route its job pinned, whose platform is at
// the front of the job's own id. The control is an ordinary message in the same
// Telegram chat, answered with the same text.
import { afterAll, beforeAll, expect, test } from "bun:test"
import { startCluster, until, type Cluster } from "./helpers/cluster.ts"
import { rolloutStage, DISPATCH_TARGET } from "./helpers/rollout-stage.ts"
import { message } from "./helpers/rollout-ingress.ts"
import { DISPATCH_PHRASES } from "../src/door/lines.ts"
import { runDoor } from "../src/door/run.ts"
import { runRunner } from "../src/runner/run.ts"

let cluster: Cluster
beforeAll(async () => { cluster = await startCluster() })
afterAll(async () => { await cluster?.stop() })

const LAIR_CHAT = "1000000001"
const TASK = "weigh the synthetic codeword"
/** Longer than Discord's limit and shorter than Telegram's. */
const LONG = "the dispatcher's answer about the report. ".repeat(70)

function typed(id: string, text: string) {
  return { ...message(id, text), chat: LAIR_CHAT, sender_id: "p1", from: "p1" }
}

test("the dispatcher's answer to a report on a Telegram chat is cut at Telegram's limit, as an ordinary answer there is", async () => {
  expect(LONG.length).toBeGreaterThan(2000)
  expect(LONG.length).toBeLessThan(4000)
  const it = await rolloutStage(cluster, "telegram", { dispatch: true,
    adapter: { answer: (fed: { text: string }) => fed.text === TASK ? "the codeword weighs four" : LONG } })
  let door: Awaited<ReturnType<typeof runDoor>> | undefined
  let runner: Awaited<ReturnType<typeof runRunner>> | undefined
  try {
    door = await runDoor({ door: "door-fake", registryFile: it.registryFile, platform: it.edge.platform })
    runner = await runRunner({ runner: "runner-pi", registryFile: it.registryFile,
      adapters: { [it.adapterName]: it.scripted.adapter } })
    it.edge.batch([typed("100", `${DISPATCH_PHRASES.en} ${DISPATCH_TARGET} ${TASK}`)], "101")
    await until("the report lands", async () => (await it.read.inbound()).some(r => r.kind === "report"), 30_000)
    const report = (await it.read.inbound()).find(r => r.kind === "report")!
    await until("the report is answered", async () =>
      (await it.read.ledger()).some(e => e.subject === report.id && e.kind === "answered"), 30_000)
    const answered = (await it.read.outbox()).filter(r => r.inbound_id === report.id)
    expect(answered.map(r => r.body)).toEqual([LONG])

    // The control: an ordinary message in the same chat, answered the same way.
    it.edge.batch([typed("110", "an ordinary sentence")], "111")
    await until("the ordinary message is answered", async () => {
      const human = (await it.read.inbound()).find(r => r.body === "an ordinary sentence")
      return !!human && (await it.read.ledger()).some(e => e.subject === human.id && e.kind === "answered")
    }, 30_000)
    const human = (await it.read.inbound()).find(r => r.body === "an ordinary sentence")!
    expect((await it.read.outbox()).filter(r => r.inbound_id === human.id).map(r => r.body)).toEqual([LONG])
  } finally { await runner?.stop(); await door?.stop(); await it.stop() }
}, 120_000)
