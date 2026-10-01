// A TOPIC MOVE, END TO END: a real door, a real source runner (pi) and a real destination runner (mac), each reading a registry FILE of its own, with
// the registry's change delivered from one to the other by the hub's own functions (`deliverRegistry`, `recordRegistryDigest`, `registerMoves`, in the
// order `hub/run.ts` runs them), on one disposable store with the move's own routines. The owner's messages go through the door as a platform hands
// them (`fake.deliver`, the sender the person allows), the request is the hub tool called as the runner's own role with the conversation and the
// attempt the runner opened, and every answer is read from the platform's posts and from the store.
//
// WHAT IS NOT DONE BY THE TEST: the drain, the export, the import, the activation, the registry write, the digest, the publication and the
// install, the serve, the gate's release and the feed of the note. After the mac's file is cloned once, no byte of it is written by the test: the
// bytes it ends up with are the ones `deliverRegistry` installed. The test never calls a setup helper of the store that names a step of the move.
//
// WHAT A GREEN RUN CLAIMS, AND ITS SEAMS (all of them limit it):
//   - One host, one Postgres and ONE OS PROCESS: the door, both runners and both hub loops share the test's module state. Two machines are separated
//     by what is configured and not by a kernel: the registry file, the state directory, the person's tree and the engine's adapter of each. A defect
//     that needs two processes (module state, a lock held by one of them) is not shown absent.
//   - The hub is the hub's functions driven by a loop at 500 ms (`HUB_TICK_MS`), not `runHub` (which installs OS units): the order and the arguments
//     are `hub/run.ts`'s, the pace is not, and a thrown tick is recorded and the loop goes on, as the hub's does; a test ends with none.
//   - The native session is the shared fake port (`fakePort`): no engine, no transcript on a disk, and `checkResumed` only records its call. That the
//     adapter's own answer is right is `adapter-claude-session.test.ts`'s; the engines are scripted (the source's children are real processes in
//     their own groups, the destination's has none), and no paid engine runs.
//   - The topic's agent and General are LEGACY-linked masters (the runner made the conversation, the tool linked the topic), not chats made through
//     the topic-creation flow.
//   - Absence (nothing fed twice, nothing claimed again, nothing imported) is observed over a bounded window of hub ticks, not proved.
//
// THE ONE HOLD (E2E-2): the destination's runner is started and its engine read is HELD in flight when the owner withdraws. That is how "the
// destination never recorded a preflight, so the source could not have released" is made certain for a withdrawal that comes after the turn ended; the
// hold is on the destination engine's capability read and nowhere else, and it is opened before the test ends.

import { afterAll, afterEach, beforeAll, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { startCluster, until, type Cluster } from "./helpers/cluster.ts"
import { CHAT, DOOR } from "./helpers/hub-fixture.ts"
import { GENERAL, GENERAL_RUNNER, SENDER, TOPIC, stageMoveE2E, type MoveE2E } from "./helpers/move-e2e-stage.ts"
import { DST, SRC } from "./helpers/move-store-stage.ts"
import { waitReasonText } from "../src/door/lines.ts"
import { callTool } from "../src/mcp/handlers.ts"
import { listAgents } from "../src/registry/entries.ts"
import { loadRegistry, registryDigest } from "../src/registry/load.ts"
import { relocationNote } from "../src/runner/move-note.ts"
import { pendingNotesOf } from "../src/store/moves.ts"
import { runnerLive } from "../src/store/topics.ts"

let cluster: Cluster
const mine: { close(): Promise<void> }[] = []
const track = <T extends { close(): Promise<void> }>(sql: T): T => { mine.push(sql); return sql }
const rigs: MoveE2E[] = []
beforeAll(async () => { cluster = await startCluster() })
afterEach(async () => {
  for (const one of rigs.splice(0)) await one.close()
  for (const one of mine.splice(0)) await one.close().catch(() => {})
})
afterAll(async () => { await cluster?.stop() })

const SLOW = 170_000
const WAIT = 60_000

async function rigOf(options: { topic: boolean }): Promise<MoveE2E> {
  const rig = await stageMoveE2E(cluster, track, options)
  rigs.push(rig)
  return rig
}

/** What a failed wait prints: the move as the store holds it, what the hub's loops threw, and what the platform was told. */
const dump = (r: MoveE2E) => async (): Promise<string> =>
  JSON.stringify({ move: await r.moveRow().catch(() => null), hubFailures: r.hub.failures, posts: r.posts() })
const stageOf = async (r: MoveE2E): Promise<string> => (await r.moveRow()).stage
const gatesOf = (r: MoveE2E) => r.s.openGates(r.moved)
const runnerLedger = (r: MoveE2E) => r.it.read.ledger({ stream: "runner", subject: DST.runner })

/** How many posts carry the reply the store holds for this input (the reply's own text, as the outbox wrote it). */
async function repliesPosted(r: MoveE2E, inbound: string): Promise<number> {
  const rows = (await r.it.read.outbox()).filter(row => row.inbound_id === inbound)
  return rows.reduce((total, row) => total + r.posts().filter(post => post.includes(row.body)).length, 0)
}

/** The pi's hub has written the digest of the file the mac's copy was cloned from: a spoke starts current, as one that was installed from it does. */
async function untilMacCurrent(r: MoveE2E): Promise<void> {
  await until("the pi's hub published and recorded the file the mac's copy was cloned from", async () => (await r.digestRow("pi")) === registryDigest(r.files.mac), 30_000, dump(r))
}

/** Everything a second feed, a second claim or a second reply would change. */
async function snapshot(r: MoveE2E) {
  return {
    executions: await r.it.read.sql("select id, inbound_id, runner, state from execution order by id"),
    outbox: (await r.it.read.outbox()).map(row => row.id),
    inbound: (await r.it.read.inbound()).map(row => [row.id, row.claimed_by]),
    srcFed: r.src.fed().map(one => one.id),
    dstFed: r.dst.fed().map(one => one.id),
    srcStarts: r.src.starts().length,
    posts: r.posts().length,
  }
}

test("E2E-1: General moves ITSELF: its current turn finishes, the queued input stays unfed on the source, the destination being offline is said, and once it is up the registry reaches it as the hub published it, the same native session is resumed behind one note, the reply is posted once, and a restart of both runners repeats nothing", async () => {
  const r = await rigOf({ topic: false })
  const { it, s } = r
  expect(r.moved).toBe(GENERAL)
  r.hub.start()
  await untilMacCurrent(r)
  await r.startRunner("pi")
  await until("the source's resident child was started", () => r.src.starts().length === 1, 30_000, dump(r))
  // The turn is held open: the request is made while the owner's first message is being answered.
  r.src.holdTurnEnd(true)
  await r.startDoor()

  const q1 = r.owner("Q1-MARK what is on today?")
  await until("q1 was fed to the source engine", () => r.src.fed().length === 1, 30_000, dump(r))
  expect(r.src.fed()[0].id).toBe(q1.id)
  const turn = await r.turnOf(q1.id)

  // The request, as General's own conversation makes it: accepted with nobody else to ask, and the owner is told the door's command.
  const reply = await callTool(r.binding(turn), "hub_topic", { action: "move", request_key: "e2e-1-move", source_message_ids: [q1.id], destination_machine: "mac" }) as Record<string, unknown>
  expect(reply).toMatchObject({ status: "accepted", stage: "move_requested" })
  expect(reply.cause, "General asking to move itself is not refused for want of another General").not.toBe("withdraw_path_missing")
  expect(String(reply.owner_status)).toContain("/move")
  const requested = await r.moveRow()
  expect(requested).toMatchObject({ agent: GENERAL, stage: "waiting", requested_by: SENDER, route: { door: DOOR, chat: CHAT }, source_machine: "pi", dest_machine: "mac" })
  expect(await gatesOf(r)).toEqual([`move:${requested.id}`])

  // The owner writes again: the gate holds it unclaimed, and the door's card for it says why (and not `unknown`).
  const q2 = r.owner("Q2-MARK sent after the request")
  await until("q2 is on the store", async () => (await it.read.inbound()).some(row => row.id === q2.id), 30_000, dump(r))
  // The card carries the reason inside the door's card cap (`inCard`, 160 characters), so the closing hint ("Send /move to see ...") is cut by design. What the
  // owner must be able to read is the sentence before it: which machine, that the message is kept, and where it is answered if the move goes through or is withdrawn.
  const moving = waitReasonText("en", "moving", { machine: "mac", source: "pi" })
  const reason = moving.slice(0, moving.indexOf(". Send /move") + 1)
  expect(reason, "the reason's own sentence names both machines and fits whole in the card's cap").toMatch(/moved to mac;.*kept.*on mac if it goes through, on pi if it is withdrawn\.$/)
  expect(reason.length, "the reason's own sentence is not itself cut by the card").toBeLessThan(160)
  await until("q2's card said it waits for the move", () => r.posts().some(post => post.startsWith("[door] still waiting") && post.includes(reason)), 30_000, dump(r))
  expect((await it.read.inbound()).find(row => row.id === q2.id)!.claimed_by, "the gate holds q2 unclaimed").toBeNull()

  // `/move` while the turn is finishing: the door's own answer, and no input row for it.
  r.owner("/move")
  await until("the door answered /move", () => r.posts().some(post => post.startsWith("[door] ") && post.includes("is still finishing") && post.includes("the move to mac can start only after it ends")), 30_000, dump(r))

  // The current turn finishes and is answered, once; the queued input stays unfed on the source.
  r.src.holdTurnEnd(false)
  await until("q1's reply was posted", async () => (await repliesPosted(r, q1.id)) === 1, WAIT, dump(r))
  await until("the source drained", async () => (await r.moveRow()).drain !== null, WAIT, dump(r))
  r.owner("/move")
  await until("the door said it waits for mac", () => r.posts().some(post => post.startsWith("[door] Waiting for mac:")), 30_000, dump(r))
  const offline = await r.moveRow()
  expect(offline).toMatchObject({ stage: "waiting", block: null, dest_ready_at: null, manifest: null })
  expect(r.native.log.exports, "nothing was read from the session").toBe(0)
  expect(r.dst.starts()).toEqual([])
  expect(r.src.fed().map(one => one.id), "the queued input was not fed to the source").toEqual([q1.id])
  expect((await it.read.inbound()).find(row => row.id === q2.id)!.claimed_by).toBeNull()

  // The mac comes up. Its delivery is held, so it cannot take what the hub publishes until the test lets it: the destination's runner has to SEE its
  // copy is not the store machine's, and the move has to wait there, at the write.
  await untilMacCurrent(r)
  await r.hub.hold("mac")
  await r.startRunner("mac")
  await until("the move reached the registry write", async () => (await stageOf(r)) === "registry_written", WAIT, dump(r))
  const written = await r.moveRow()
  const receipt = written.registry_receipt
  if (receipt === null) throw new Error("a registry_written move has a receipt")
  expect(receipt).toMatchObject({ agent: GENERAL, runner: DST.runner, machine: "mac" })
  await until("the mac's runner saw its copy was not the pi's", async () => (await runnerLedger(r)).some(row => row.kind === "registry.stale"), 30_000, dump(r))
  expect(registryDigest(r.files.pi), "the receipt names the bytes the hub wrote").toBe(receipt.digest)
  expect(registryDigest(r.files.mac), "the mac's copy is still the clone: nothing of the move was written into it").toBe(r.initialDigest)
  expect(await gatesOf(r), "a registry write is not readiness").toEqual([`move:${written.id}`])
  expect(r.dst.fed()).toEqual([])
  r.hub.release("mac")
  await until("the destination served", async () => (await stageOf(r)) === "active", WAIT, dump(r))

  await until("q2 was fed to the destination engine", () => r.dst.fed().length === 1, WAIT, dump(r))
  await until("the note was acknowledged", async () => (await r.moveRow()).note_state === "delivered", WAIT, dump(r))
  await until("q2's reply was posted", async () => (await repliesPosted(r, q2.id)) === 1, WAIT, dump(r))
  await until("the owner was told the chat now runs on mac", () => r.posts().some(post => post.includes("now runs on mac")), WAIT, dump(r))
  await until("everything owed was delivered", async () => (await it.read.outbox()).every(row => row.delivered_at !== null), WAIT, dump(r))
  const active = await r.moveRow()
  expect(active.stage).toBe("active")
  expect(await gatesOf(r)).toEqual([])

  // REGISTRY DELIVERY: the mac's file is the receipt's bytes and was installed by the hub's delivery, which the diary accounts for.
  expect(active.registry_receipt!.digest).toBe(receipt.digest)
  expect(registryDigest(r.files.mac)).toBe(receipt.digest)
  expect(readFileSync(r.files.mac).equals(readFileSync(r.files.pi)), "byte for byte the pi's").toBe(true)
  expect(listAgents(loadRegistry(r.files.mac, { machine: "mac" })).find(one => one.id === GENERAL)?.runner).toBe(DST.runner)
  const published = (await it.read.ledger({ stream: "machine", kind: "registry.published" })).filter(row => row.actor === "hub")
  const publication = published.filter(row => row.detail.sha256 === receipt.digest)
  expect(publication, "the receipt's bytes were published once, by the pi's hub").toHaveLength(1)
  expect(publication[0].subject).toBe("registry:pi")
  expect(published.filter(row => row.detail.sha256 === r.initialDigest), "and so were the bytes the mac was cloned from").toHaveLength(1)
  const installed = await it.read.ledger({ stream: "machine", kind: "registry.copy-installed" })
  expect(installed, "one install, on the mac").toHaveLength(1)
  expect(installed[0]).toMatchObject({ subject: "registry-copy:mac", actor: "hub", detail: { machine: "mac", reference: "pi", from: r.initialDigest.slice(0, 16), to: receipt.digest.slice(0, 16) } })
  expect(installed[0].seq, "after the publication").toBeGreaterThan(publication[0].seq)
  const registryLines = (await runnerLedger(r)).filter(row => row.kind.startsWith("registry."))
  expect(registryLines.map(row => row.kind), "the mac's runner was stale and then current").toEqual(["registry.stale", "registry.current"])
  expect(String(registryLines[0].detail.reason)).toContain("pi")

  // FEEDS: the source was fed q1 and nothing else; the destination was fed q2, behind the note, resumed under the same native id.
  const native = await s.nativeOf(active)
  expect(native).toBe(active.native_session)
  expect(r.src.fed().map(one => one.id)).toEqual([q1.id])
  expect(r.dst.fed().map(one => one.id)).toEqual([q2.id])
  const note = relocationNote(active)
  const wire = r.dst.fed()[0]
  expect(wire.text.startsWith(note), "the note goes ahead of the input on the wire").toBe(true)
  expect(wire.text.indexOf("Q2-MARK")).toBeGreaterThan(note.length)
  expect(r.src.starts()[0].session?.id, "the source's session was the conversation's own").toBe(native)
  expect(r.dst.starts().length).toBeGreaterThan(0)
  for (const start of r.dst.starts()) expect(start.session, "every start of the destination resumed the conversation's own session").toEqual({ id: native, resume: true })
  expect(r.native.log.exports).toBe(1)
  expect(r.native.log.imports).toHaveLength(1)
  expect(r.checks, "the resume was checked once").toHaveLength(1)
  expect(r.checks[0]).toMatchObject({ nativeSession: native, reportedSessionId: native })
  const executions = await it.read.sql("select inbound_id, runner from execution order by inbound_id")
  expect(executions, "one attempt per input").toHaveLength(2)
  const ranOn = new Map(executions.map(row => [String(row.inbound_id), String(row.runner)]))
  expect(ranOn.get(q1.id)).toBe(SRC.runner)
  expect(ranOn.get(q2.id)).toBe(DST.runner)
  expect(await pendingNotesOf(s.tool, GENERAL), "the note was delivered with the feed").toEqual([])

  // POSTS: one reply each, the door's commands answered once each and never made inputs, and one notice that is the door's and names no agent id.
  expect(await repliesPosted(r, q1.id)).toBe(1)
  expect(await repliesPosted(r, q2.id)).toBe(1)
  expect((await it.read.inbound()).map(row => row.id).sort()).toEqual([q1.id, q2.id].sort())
  expect(r.posts().filter(post => post.includes("is still finishing")).length).toBe(1)
  expect(r.posts().filter(post => post.startsWith("[door] Waiting for mac:")).length).toBe(1)
  const notices = r.posts().filter(post => post.includes("now runs on mac"))
  expect(notices).toHaveLength(1)
  expect(notices[0].startsWith("[door] ")).toBe(true)
  expect(notices[0]).not.toContain(GENERAL)
  const keys = (await it.read.noticeRows()).map(row => row.notice_key)
  expect(keys.filter(key => key === `topic-move:${active.id}:active`)).toHaveLength(1)
  expect(keys.some(key => key !== null && key.endsWith(":withdrawn"))).toBe(false)

  // A RESTART OF BOTH RUNNERS, and three more ticks of each hub: nothing is fed, claimed or answered again, and the pi never takes the agent back.
  const before = await snapshot(r)
  await r.restartRunners()
  await r.hub.ticks("pi", 3)
  await r.hub.ticks("mac", 3)
  expect(await snapshot(r)).toEqual(before)
  expect(r.checks).toHaveLength(1)
  expect(await it.read.sql("select 1 from execution where runner = $1 and inbound_id <> $2", [SRC.runner, q1.id])).toEqual([])
  expect(await gatesOf(r)).toEqual([])
  expect(r.hub.failures).toEqual([])
}, SLOW)

test("E2E-2: a topic's own chat withdraws a move at the door while General is unavailable: refused while the turn is finishing, withdrawn once it ended, the queued input is fed once on the source in the same session, and the destination imports nothing and the registry is untouched", async () => {
  const r = await rigOf({ topic: true })
  const { it, s } = r
  expect(r.moved).toBe(TOPIC)
  r.hub.start()
  await untilMacCurrent(r)
  await r.startRunner("pi")
  await until("the source's resident child was started", () => r.src.starts().length === 1, 30_000, dump(r))
  await r.startRunner("mac")
  r.src.holdTurnEnd(true)
  await r.startDoor()

  const q1 = r.owner("Q1-MARK what is on today?")
  await until("q1 was fed to the source engine", () => r.src.fed().length === 1, 30_000, dump(r))
  expect(await runnerLive(s.tool, GENERAL_RUNNER), "General's runner is not connected").toBe(false)

  // The destination's engine read is held from here: its preflight, started by the request, cannot be recorded until the test opens it.
  r.holdEngine()
  const reads = r.engine.reads
  const reply = await callTool(r.binding(await r.turnOf(q1.id)), "hub_topic", { action: "move", request_key: "e2e-2-move", source_message_ids: [q1.id], destination_machine: "mac" }) as Record<string, unknown>
  expect(reply).toMatchObject({ status: "accepted", stage: "move_requested" })
  expect(String(reply.owner_status)).toContain("/move")
  const requested = await r.moveRow()
  expect(requested).toMatchObject({ agent: TOPIC, stage: "waiting", requested_by: SENDER, route: { door: DOOR, chat: CHAT } })
  await until("the destination's preflight is in flight, held at its engine read", () => r.engine.reads > reads, 30_000, dump(r))

  const q2 = r.owner("Q2-MARK queued behind the request")
  await until("q2 is on the store", async () => (await it.read.inbound()).some(row => row.id === q2.id), 30_000, dump(r))

  // WHILE THE TURN IS STILL RUNNING: refused as finishing, and nothing is recorded or spent.
  r.owner(`/move withdraw ${requested.id}`)
  await until("the door refused: the turn is still finishing", () => r.posts().some(post => post.startsWith("[door] ") && post.includes("still finishing") && post.includes(`send /move withdraw ${requested.id} here again once it has ended`)), 30_000, dump(r))
  const refused = await r.moveRow()
  expect(refused.stage).toBe("waiting")
  expect(refused.evidence).not.toHaveProperty("withdrawn")
  expect(await gatesOf(r)).toEqual([`move:${requested.id}`])
  expect((await it.read.noticeRows()).filter(row => row.notice_key !== null && row.notice_key.startsWith("topic-move:"))).toEqual([])

  // THE TURN ENDS: the source drains, and the destination has recorded nothing, so nothing could be released.
  r.src.holdTurnEnd(false)
  await until("q1's reply was posted", async () => (await repliesPosted(r, q1.id)) === 1, WAIT, dump(r))
  await until("the source drained", async () => (await r.moveRow()).drain !== null, WAIT, dump(r))
  expect(await r.moveRow()).toMatchObject({ stage: "waiting", dest_ready_at: null, manifest: null })
  expect(r.native.log.exports).toBe(0)

  // IDLE: the same words, sent again, withdraw it.
  const late = r.owner(`/move withdraw ${requested.id}`)
  await until("the door said it was withdrawn", () => r.posts().some(post => post.startsWith("[door] ") && post.includes("was withdrawn")), 30_000, dump(r))
  const withdrawn = await r.moveRow()
  expect(withdrawn).toMatchObject({ id: requested.id, stage: "withdrawn", block: null })
  expect((withdrawn.evidence as { withdrawn: Record<string, unknown> }).withdrawn).toMatchObject({ by: SENDER, source: "chat-command", message: r.commandId(late), door: DOOR, chat: CHAT })
  expect(await gatesOf(r), "the gate was released").toEqual([])
  expect(r.posts().some(post => post.includes("General")), "no line points at a General").toBe(false)

  // THE QUEUED INPUT is fed ONCE on the source, in the session it had, and answered once.
  await until("q2 was fed on the source", () => r.src.fed().length === 2, WAIT, dump(r))
  const native = await s.nativeOf(withdrawn)
  expect(r.src.fed().map(one => one.id)).toEqual([q1.id, q2.id])
  expect(r.src.fed()[1].text).not.toContain("RELOCATION NOTE")
  expect(r.src.starts()[1].session, "resumed under the same native id").toEqual({ id: native, resume: true })
  await until("q2's reply was posted", async () => (await repliesPosted(r, q2.id)) === 1, WAIT, dump(r))
  expect(await it.read.sql("select runner from execution where inbound_id = $1", [q2.id])).toEqual([{ runner: SRC.runner }])

  // THE DESTINATION'S HELD LOOK is let go over a move that is withdrawn, and the hub ticks on: nothing was imported, written or published.
  r.openEngine()
  await r.hub.ticks("pi", 3)
  await r.hub.ticks("mac", 3)
  const after = await r.moveRow()
  expect(after).toMatchObject({ stage: "withdrawn", dest_ready_at: null, dest_facts: null, manifest: null, registry_receipt: null })
  expect(await it.read.sql("select 1 from move_copy where move_id = $1", [after.id])).toEqual([])
  expect(r.native.log.exports).toBe(0)
  expect(r.native.log.imports).toEqual([])
  expect(r.native.staged.size).toBe(0)
  expect(r.dst.starts()).toEqual([])
  expect(r.dst.fed()).toEqual([])
  expect(registryDigest(r.files.pi), "the pi's file is untouched").toBe(r.initialDigest)
  expect(registryDigest(r.files.mac), "and so is the mac's").toBe(r.initialDigest)
  expect(listAgents(loadRegistry(r.files.pi, { machine: "pi" })).find(one => one.id === TOPIC)?.runner).toBe(SRC.runner)
  expect((await it.read.ledger({ stream: "machine", kind: "registry.published" })).every(row => row.detail.sha256 === r.initialDigest)).toBe(true)
  expect(await it.read.ledger({ stream: "machine", kind: "registry.copy-installed" })).toEqual([])

  // General never ran: no conversation, no attempt, no connection; and there was one move.
  expect(await runnerLive(s.tool, GENERAL_RUNNER)).toBe(false)
  expect(await it.read.sql("select 1 from conversation where agent = $1", [GENERAL])).toEqual([])
  expect(await it.read.sql("select count(*)::int as n from topic_move")).toEqual([{ n: 1 }])
  expect(r.hub.failures).toEqual([])
}, SLOW)
