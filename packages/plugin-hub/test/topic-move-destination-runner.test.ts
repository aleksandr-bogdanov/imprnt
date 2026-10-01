// The DESTINATION'S RUNNER of a topic move, whole: a real `runRunner` for the destination machine, against a disposable store with the move's own
// routines (migration 016), the scripted adapter's loop as its engine and the shared fake native port as the adapter's session. Nothing on the
// destination is called as a pure helper here: the runner's own watch preflights, imports and activates, serves from what it loaded, claims the
// first real input, feeds it behind the relocation note, checks the resumed turn (`checkResumed`) and acknowledges the note (`noteDelivered`).
//
// WHAT THIS PROVES: the gate of a moved agent holds a queued input while the destination's copy of the registry is not the receipt's, and the same
// input is fed exactly once after the serve; the note rides that one feed, in front of the input, and is acknowledged only after the check passed,
// once; a check the adapter refuses, and a started conversation whose import left no record to check against, each hold the input with the note
// still owed, no reply, no second feed, no fresh session and no replay (and no progress line while the turn runs: its resume is not yet verified); a
// change the other side commits during a look is not taken for seen, and what the look wrote itself converges; a preflight refused for a fact of this
// machine (a default instruction file) is looked at again when the fact changes, with no restart.
//
// WHAT IT DOES NOT: the source's side as a runner (`topic-move-runtime.test.ts` runs a real source; here the source is the accepted export called
// with a registry-bound world and the drain's store half, as there), a real engine (the port's `checkResumed` here is scripted: the adapter's own
// answer is `adapter-claude-session.test.ts`), or a second machine's copy of the registry file (one file is every machine's here).

import { afterAll, afterEach, beforeAll, expect, test } from "bun:test"
import { appendFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { NativeRefusal, type NativeSessionPort } from "../src/adapters/types.ts"
import { startCluster, until, type Cluster } from "./helpers/cluster.ts"
import { CHAT, DOOR, PERSON, insertInbound, stageHub, withLaunchTree, type StagedHub } from "./helpers/hub-fixture.ts"
import { DST, SRC, moveStage, type MoveFixture } from "./helpers/move-store-stage.ts"
import { PROVEN, drainOnly, fakePort, handoffWorld, lockChain } from "./helpers/move-handoff-stage.ts"
import { registerMoves } from "../src/hub/moves.ts"
import { loadRegistry, registryDigest } from "../src/registry/load.ts"
import { exportSource } from "../src/runner/move-export.ts"
import { relocationNote } from "../src/runner/move-note.ts"
import { profileOf } from "../src/runner/move-profile.ts"
import { scopeOf } from "../src/runner/move-scope.ts"
import { runRunner } from "../src/runner/run.ts"
import { pendingNotesOf, readMove, type MoveRow } from "../src/store/moves.ts"
import { newIdentity } from "../src/store/topics.ts"

let cluster: Cluster
const mine: { close(): Promise<void> }[] = []
const track = <T extends { close(): Promise<void> }>(sql: T): T => { mine.push(sql); return sql }
const runners: { stop(): Promise<void> }[] = []
const staged: StagedHub[] = []
beforeAll(async () => { cluster = await startCluster() })
afterEach(async () => {
  for (const one of runners.splice(0)) await one.stop().catch(() => {})
  for (const one of staged.splice(0)) { one.scripted.reap(); await one.stop().catch(() => {}) }
  for (const one of mine.splice(0)) await one.close().catch(() => {})
})
afterAll(async () => { await cluster?.stop() })

const SLOW = 180_000
type Check = Parameters<NativeSessionPort["checkResumed"]>[0]

interface Rig {
  it: StagedHub
  s: MoveFixture
  agent: string
  move: MoveRow
  native: string
  checks: Check[]
  /** What the scripted port answers a `checkResumed` with: nothing, or the adapter's own named refusal. */
  verdict: { refuse: boolean }
  /** How many times a look of the destination read the engine (once per look that got that far), and a gate that holds that read while set. */
  probe: { reads: number; gate: Promise<void> | null }
  /** The default instruction file planted in the person's tree (`stage({ instruction: true })`), or null. */
  instruction: string | null
}

const hubOf = (r: Rig) => ({ store: r.s.hub, registryFile: r.it.registryFile, machine: "pi", load: () => loadRegistry(r.it.registryFile, { machine: "pi" }) })
const runnerLedger = (r: Rig, kind: string) => r.it.read.ledger({ stream: "runner", kind })
const rowsOf = async (r: Rig, query: string) => await r.it.read.sql(query)

/**
 * A REAL runner for the destination machine (`mac`), a source machine (`pi`) whose runner is never started, and a conversation the engine has
 * started that the owner asked to move: the destination's watch has recorded its preflight by the time this returns. The agent is on the source's
 * runner in the registry until the hub writes it.
 */
async function stage(options: { release?: boolean; instruction?: boolean } = {}): Promise<Rig> {
  const agent = `t-${crypto.randomUUID()}`
  let instruction: string | null = null
  const capabilities = { stableSession: true, safeResume: false, delegationDisabled: false, version: "9.9.2" }
  const it = await stageHub(cluster, {
    adapter: { exitProof: true, capabilities },
    machines: [{ id: "pi", os: "linux" }, { id: "mac", os: "macos" }],
    hub: { tick_seconds: 1 },
    run: [
      { id: DOOR, kind: "door", machine: "pi", platform: "fake", person: PERSON, token_file: "/dev/null", schedule: "always", memory_limit_mb: 192 },
      { id: SRC.runner, kind: "runner", machine: SRC.machine, schedule: "always", memory_limit_mb: 512, child_memory_limit_mb: 512 },
      { id: DST.runner, kind: "runner", machine: DST.machine, schedule: "always", memory_limit_mb: 512, child_memory_limit_mb: 512 },
    ],
    // The person has a real EMPTY tree (`withLaunchTree`): the destination's preflight asks where the launch would read a default instruction file
    // from, which is the person's tree, and a person with none gives it nothing to look at (`dest_local_unverified`, instructions). The source's
    // scope look below is asked of the same file and the same directory.
    // With `instruction` the tree holds a default instruction file from the start: the destination's preflight is refused for it.
    registry: base => {
      const planted = withLaunchTree(base)
      const tree = (planted.people ?? []).find(one => one.id === PERSON)?.tree
      if (options.instruction && typeof tree === "string") { instruction = join(tree, "CLAUDE.md"); writeFileSync(instruction, "# local instructions\n") }
      return { ...planted, agents: [{ id: agent, person: PERSON, preset: "daily", chat: CHAT, door: DOOR, runner: SRC.runner }] }
    },
  })
  staged.push(it)
  const s = await moveStage(cluster, track, { database: it.db })
  const identity = { ...newIdentity(), agent_id: agent }
  const t = await s.topic("destination-runner", { identity: () => identity })
  // The engine started this conversation on the source before the owner asked: the preflight records where a session would go. The conversation
  // is the scripted adapter's (a turn on the source would have placed it so: `conversationFor`), which is the adapter whose session port is asked.
  await s.su`update conversation set native_state = 'started', adapter = ${it.adapterName} where id = ${identity.conversation_id}`

  const fake = fakePort()
  const checks: Check[] = []
  const verdict = { refuse: false }
  const probe: Rig["probe"] = { reads: 0, gate: null }
  const port: NativeSessionPort = {
    ...fake.port,
    checkResumed(input) { checks.push(input); if (verdict.refuse) throw new NativeRefusal("native_resume_unverified", "scripted") },
  }
  const engine = {
    ...it.scripted.adapter, session: port,
    capabilities: async (context: Parameters<NonNullable<typeof it.scripted.adapter.capabilities>>[0]) => { probe.reads += 1; await probe.gate; return await it.scripted.adapter.capabilities!(context) },
  }
  const runner = await runRunner({ runner: DST.runner, registryFile: it.registryFile, adapters: { [it.adapterName]: engine } })
  runners.push(runner)
  await s.adopt(DST)
  await s.register(SRC, "src-1")
  const move = await s.request(t)
  const native = await s.nativeOf(move)
  const rig: Rig = { it, s, agent, move, native, checks, verdict, probe, instruction }
  if (options.instruction) {
    await until("the destination's runner refused its preflight for the instruction file", async () => (await readMove(s.tool, move.id))!.block?.code === "dest_local_unverified", 45_000,
      async () => JSON.stringify(await readMove(s.tool, move.id)))
    return rig
  }
  await until("the destination's runner recorded its preflight", async () => (await readMove(s.tool, move.id))!.dest_ready_at !== null, 45_000,
    async () => JSON.stringify(await readMove(s.tool, move.id)))
  if (options.release === false) return rig

  // The source's half, as the accepted export: the drain's store half, then the release, bound to this very registry file.
  const src = handoffWorld(s, "source", { port: fake.port, locks: lockChain() })
  src.w.scope = row => scopeOf(loadRegistry(it.registryFile), row)
  src.w.sourceProfile = row => profileOf(loadRegistry(it.registryFile), row.agent)
  await drainOnly(s, move)
  expect(await exportSource(src.w, PROVEN, move.id)).toMatchObject({ state: "done", reason: "released" })
  return rig
}

/** The destination's own watch imports and activates after the release; the gate is still open and the registry still says the source. */
async function toActivated(r: Rig): Promise<MoveRow> {
  await until("the destination imported and activated", async () => (await readMove(r.s.tool, r.move.id))!.stage === "activated", 60_000,
    async () => JSON.stringify(await readMove(r.s.tool, r.move.id)))
  expect(await r.s.openGates(r.agent), "activation never releases the gate").toEqual([`move:${r.move.id}`])
  return (await readMove(r.s.tool, r.move.id))!
}

/** The hub writes the registry; the destination serves what it loaded, and the gate is released by that and by nothing else. */
async function toActive(r: Rig): Promise<MoveRow> {
  await toActivated(r)
  await registerMoves(hubOf(r))
  await until("the destination served", async () => (await readMove(r.s.tool, r.move.id))!.stage === "active", 60_000,
    async () => JSON.stringify(await readMove(r.s.tool, r.move.id)))
  expect(await r.s.openGates(r.agent)).toEqual([])
  return (await readMove(r.s.tool, r.move.id))!
}

const firstInput = (r: Rig) => insertInbound(cluster, r.it.db, { id: "q1", body: "the first input after the move", agent: r.agent })

test("DR-1: the gate holds an input while the destination's registry is not the receipt's, then the input is fed ONCE behind the relocation note, the resumed turn is checked, and the note is acknowledged once", async () => {
  const r = await stage()
  await toActivated(r)
  await firstInput(r)

  // The hub binds the registry it wrote; an unrelated edit then makes the destination's copy something the receipt does not name.
  await registerMoves(hubOf(r))
  expect((await readMove(r.s.tool, r.move.id))!.stage).toBe("registry_written")
  appendFileSync(r.it.registryFile, "\n# an unrelated edit\n")
  await Bun.sleep(3500)
  const waiting = (await readMove(r.s.tool, r.move.id))!
  expect(waiting.stage, "the serve waits for a registry that is the receipt's").toBe("registry_written")
  expect(waiting.registry_receipt!.digest).not.toBe(registryDigest(r.it.registryFile))
  expect(await r.s.openGates(r.agent), "the gate is still open").toEqual([`move:${r.move.id}`])
  expect(r.it.scripted.fed(), "nothing was fed to the moved agent").toEqual([])
  expect(await rowsOf(r, "select count(*)::int as n from execution where inbound_id = 'q1'"), "no attempt was opened for the queued input").toEqual([{ n: 0 }])
  expect((await r.it.read.inbound()).find(one => one.id === "q1")!.claimed_by, "and it stays unclaimed").toBeNull()
  expect(r.checks).toEqual([])

  // The hub refreshes the receipt while the binding holds; the destination serves exactly that file; the held input is fed.
  await registerMoves(hubOf(r))
  await until("the destination served", async () => (await readMove(r.s.tool, r.move.id))!.stage === "active", 60_000, async () => JSON.stringify(await readMove(r.s.tool, r.move.id)))
  const active = (await readMove(r.s.tool, r.move.id))!
  expect(active.registry_receipt!.digest, "the receipt names the bytes the destination loaded").toBe(registryDigest(r.it.registryFile))
  expect(active.registry_receipt!.profile).toEqual(active.dest_facts!.profile)
  const registered = profileOf(loadRegistry(r.it.registryFile, { machine: DST.machine }), r.agent)
  if (registered === null) throw new Error("the registry file gives the moved agent no profile")
  expect(active.dest_facts!.profile).toEqual(registered)
  expect(active.dest_facts!.profile).toMatchObject({ unverified: [] })
  expect(await r.s.openGates(r.agent)).toEqual([])
  expect((await runnerLedger(r, "move.served")).length, "said once").toBe(1)

  await until("the first input was fed", () => r.it.scripted.fed().length === 1, 60_000, () => JSON.stringify(r.it.scripted.fed()))
  const note = relocationNote(active)
  const wire = r.it.scripted.fed()[0]
  expect(wire.id).toBe("q1")
  expect(wire.text.startsWith(note), "the note goes ahead of the input on the wire").toBe(true)
  expect(wire.text.indexOf("the first input after the move")).toBeGreaterThan(note.length)
  await until("the note was acknowledged", async () => (await readMove(r.s.tool, r.move.id))!.note_state === "delivered", 60_000, async () => JSON.stringify(await readMove(r.s.tool, r.move.id)))

  // The check was made once, from what the destination's own copy recorded, on the directory it imported into, for the id the engine reported.
  expect(r.checks).toHaveLength(1)
  expect(r.checks[0]).toMatchObject({ nativeSession: r.native, reportedSessionId: r.native })
  expect(r.checks[0].sessionDir, "the directory checked is the one the import went into").toBe(r.checks[0].imported.to.cwd)
  expect(r.checks[0].imported.transcript.sha256).toBe(active.manifest!.files[0].sha256)
  expect((await runnerLedger(r, "move.resume-verified")).length).toBe(1)
  expect(await pendingNotesOf(r.s.tool, r.agent)).toEqual([])
  const entries = (await r.s.su`select kind, body from conversation_entry where conversation_id = ${r.move.conversation_id} and source_id = ${`move-note:${r.move.id}`}`) as unknown as { kind: string; body: string }[]
  expect(entries.map(one => one.kind)).toEqual(["recovery"])
  expect(entries[0].body).toBe(note)
  await until("the reply landed", async () => (await r.it.read.outbox()).some(one => one.inbound_id === "q1"), 60_000)
  expect((await r.it.read.outbox()).filter(one => one.inbound_id === "q1")).toHaveLength(1)

  // The next input carries no note and is not checked again: the session is the same one, resumed.
  await insertInbound(cluster, r.it.db, { id: "q2", body: "the second input", agent: r.agent })
  await until("the second input was fed", () => r.it.scripted.fed().length === 2, 60_000, () => JSON.stringify(r.it.scripted.fed()))
  expect(r.it.scripted.fed().map(one => one.id)).toEqual(["q1", "q2"])
  expect(r.it.scripted.fed()[1].text).not.toContain("RELOCATION NOTE")
  expect(r.checks, "checked once").toHaveLength(1)
  expect(r.it.scripted.starts().length).toBeGreaterThan(0)
  for (const start of r.it.scripted.starts()) expect(start.session, "every start resumed the conversation's own session").toEqual({ id: r.native, resume: true })
  expect(await r.s.nativeOf(r.move), "no fresh session was minted").toBe(r.native)
}, SLOW)

/** The input is held with the note still owed: no reply, no second feed, no acknowledgement, no fresh session and nothing replayed. */
async function expectHeld(r: Rig, why: string): Promise<void> {
  await until("the attempt ended", async () => {
    const [row] = await rowsOf(r, "select state from execution where inbound_id = 'q1'")
    return row !== undefined && !["claimed", "feed_intent", "received", "running"].includes(String(row.state))
  }, 60_000, async () => JSON.stringify(await rowsOf(r, "select state, evidence from execution where inbound_id = 'q1'")))
  const [attempt] = await rowsOf(r, "select state from execution where inbound_id = 'q1'")
  expect(attempt.state, "the attempt did not complete").not.toBe("completed")
  expect((await r.it.read.outbox()).filter(one => one.inbound_id === "q1"), "no reply was written for a turn that was not trusted").toEqual([])
  const [inbound] = await rowsOf(r, "select state from inbound where id = 'q1'")
  expect(["answered", "delivered"], "the input is not answered").not.toContain(String(inbound.state))

  expect(await pendingNotesOf(r.s.tool, r.agent), "the note is still owed").toHaveLength(1)
  expect((await readMove(r.s.tool, r.move.id))!.note_state).toBe("pending")
  const written = await r.s.su`select 1 from conversation_entry where conversation_id = ${r.move.conversation_id} and source_id = ${`move-note:${r.move.id}`}`
  expect(written.length, "and was written down nowhere").toBe(0)
  expect((await runnerLedger(r, "move.resume-verified")).length).toBe(0)

  // Another input is not fed over the held one (the engine is not shown able to resume safely), and nothing is replayed.
  await insertInbound(cluster, r.it.db, { id: "q2", body: "the second input", agent: r.agent })
  await Bun.sleep(3500)
  expect(r.it.scripted.fed().map(one => one.id), `${why}: fed once`).toEqual(["q1"])
  expect((await r.it.read.inbound()).find(one => one.id === "q2")!.claimed_by).toBeNull()
  expect(await r.s.nativeOf(r.move), "and no fresh session was minted in its place").toBe(r.native)
  for (const start of r.it.scripted.starts()) expect(start.session).toEqual({ id: r.native, resume: true })
}

test("DR-2: a resumed turn the adapter refuses to verify holds the input with the note still owed, writes no reply, and replays nothing", async () => {
  const r = await stage()
  await toActive(r)
  r.verdict.refuse = true
  // The engine's turn is held open after it has said it began: the turn is running, its resume not yet checked, and the door has no line for it.
  r.it.scripted.holdTurnEnd(true)
  await firstInput(r)
  await until("the first input was fed", () => r.it.scripted.fed().length === 1, 60_000, () => JSON.stringify(r.it.scripted.fed()))
  await until("the turn is running", async () => (await rowsOf(r, "select 1 from execution where inbound_id = 'q1' and state = 'running'")).length === 1, 60_000)
  await Bun.sleep(2500)
  expect(await rowsOf(r, "select 1 from state_row where sheet = 'turn_progress' and id = 'q1'"), "no progress line is written for a turn whose resume is not yet verified").toEqual([])
  r.it.scripted.holdTurnEnd(false)
  await until("the check was made", () => r.checks.length === 1, 60_000)
  expect(r.checks[0]).toMatchObject({ nativeSession: r.native, reportedSessionId: r.native })
  await expectHeld(r, "refused")
  expect(r.checks, "the refused check is not made again by anything").toHaveLength(1)
}, SLOW)

test("DR-3: a started conversation whose import left no record to check against is the same refusal: the check is not guessed and the note is not acknowledged", async () => {
  const r = await stage()
  await toActive(r)
  // The destination's own copy no longer carries what it recorded when it promoted.
  await r.s.su`update move_copy set evidence = evidence - 'promoted' where move_id = ${r.move.id} and kind = 'dest_import'`
  await firstInput(r)
  await until("the first input was fed", () => r.it.scripted.fed().length === 1, 60_000, () => JSON.stringify(r.it.scripted.fed()))
  await expectHeld(r, "no import record")
  expect(r.checks, "nothing was asked of the port").toEqual([])
  expect((await runnerLedger(r, "move.resume-unverified")).length).toBe(1)
}, SLOW)

test("DR-4: a change the OTHER side commits while the destination is looking is not taken for seen: the notification that comes after the look is looked at, and what the look wrote itself converges", async () => {
  const r = await stage({ release: false })
  // The destination's own write (its preflight) is heard once, looked at once more and settles: nothing keeps asking the port.
  await until("the preflight's own notification was looked at", () => r.probe.reads >= 2, 30_000, () => String(r.probe.reads))
  let settled = -1
  while (settled !== r.probe.reads) { settled = r.probe.reads; await Bun.sleep(1500) }

  // The other side's commits are made WITHOUT their notification (an update of the one column the trigger does not listen to), and the notification is
  // sent by hand after the look: the late arrival of the case, made deterministic. The look is held where it reads the engine, after it read the row.
  const touch = async () => { await r.s.su`update topic_move set updated_at = updated_at + interval '5 milliseconds' where id = ${r.move.id}` }
  const ring = async () => { await r.s.su`select pg_notify('hub_move', ${DST.runner})` }
  let open!: () => void
  r.probe.gate = new Promise<void>(resolve => { open = resolve })
  await touch()
  await ring()
  await until("a look is in flight, held at the engine's capabilities", () => r.probe.reads === settled + 1, 30_000, () => String(r.probe.reads))
  await touch()
  r.probe.gate = null
  open()
  await Bun.sleep(1500)
  const after = r.probe.reads
  await ring()
  await until("the change committed during the look was looked at when its notification came", () => r.probe.reads > after, 30_000, () => String(r.probe.reads))

  // And that look, which wrote nothing, settles on the row it read.
  let again = -1
  while (again !== r.probe.reads) { again = r.probe.reads; await Bun.sleep(1500) }
  await ring()
  await Bun.sleep(1500)
  expect(r.probe.reads, "a notification of a row already looked at asks nothing").toBe(again)
}, SLOW)

test("DR-5: a preflight refused for a default instruction file on THIS machine is looked at again when the file is gone, by the same runner with no restart: its own block clears and the preflight is recorded", async () => {
  const r = await stage({ instruction: true })
  expect(await readMove(r.s.tool, r.move.id)).toMatchObject({ dest_ready_at: null, block: { code: "dest_local_unverified", by: "dest" } })
  expect(r.instruction).not.toBeNull()
  // No move row changes when the file is removed, so no notification comes: the runner's own tick sees the facts it decided from move.
  rmSync(r.instruction!)
  await until("the preflight was recorded", async () => (await readMove(r.s.tool, r.move.id))!.dest_ready_at !== null, 30_000, async () => JSON.stringify(await readMove(r.s.tool, r.move.id)))
  expect((await readMove(r.s.tool, r.move.id))!.block, "the destination's own block cleared when its proof succeeded").toBeNull()
}, SLOW)
