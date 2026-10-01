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
// machine (a default instruction file) is looked at again when the fact changes, with no restart; and so is a wait or refusal made from an engine that
// could not be asked (the preflight's, the serve's), by the bounded clock (`ENGINE_RECHECK`) and never by the tick asking the engine; and a configuration
// that drifts after the serve starts no child at either launch of the moved conversation (the first input's, and a restarted runner's eager start): the
// input is handed back unconsumed with the note owed, and once the file is restored the same input is fed once behind the note, in the same session.
//
// WHAT IT DOES NOT: the source's side as a runner (`topic-move-runtime.test.ts` runs a real source; here the source is the accepted export called
// with a registry-bound world and the drain's store half, as there), a real engine (the port's `checkResumed` here is scripted: the adapter's own
// answer is `adapter-claude-session.test.ts`), or a second machine's copy of the registry file (one file is every machine's here).

import { afterAll, afterEach, beforeAll, expect, test } from "bun:test"
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { NativeRefusal, type NativeSessionPort } from "../src/adapters/types.ts"
import { startCluster, until, type Cluster } from "./helpers/cluster.ts"
import { CHAT, DOOR, PERSON, insertInbound, stageHub, withLaunchTree, type StagedHub } from "./helpers/hub-fixture.ts"
import { DST, SRC, moveStage, type MoveFixture } from "./helpers/move-store-stage.ts"
import { PROVEN, drainOnly, fakePort, handoffWorld, lockChain } from "./helpers/move-handoff-stage.ts"
import { stageHousehold, type Household } from "./helpers/move-workspace-stage.ts"
import type { PersonSpec } from "./helpers/registry.ts"
import { registerMoves } from "../src/hub/moves.ts"
import { loadRegistry, registryDigest } from "../src/registry/load.ts"
import { configDifference, effectiveConfigOf } from "../src/runner/move-config.ts"
import { exportSource } from "../src/runner/move-export.ts"
import { ENGINE_RECHECK } from "../src/runner/move-handoff.ts"
import { relocationNote } from "../src/runner/move-note.ts"
import { profileOf } from "../src/runner/move-profile.ts"
import { scopeOf } from "../src/runner/move-scope.ts"
import { RECHECK, observeSource, workspaceFactsOf } from "../src/runner/move-workspace.ts"
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
  /** How many times a look of the destination read the engine (once per look that got that far), a gate that holds that read while set, and whether the engine cannot be asked (the read throws). */
  probe: { reads: number; gate: Promise<void> | null; down: boolean }
  /** The default instruction file planted in the DESTINATION's tree (`stage({ instruction: true })`), or null. */
  instruction: string | null
  /** The source's accepted export world, bound to this registry and read as the source machine reads it: it compares and seals the effective configuration and observes the repositories as the runner would (none, for a person that declares none). Only `legacySource` is a source of an older build that seals none. */
  src: ReturnType<typeof handoffWorld>
  h: Household | null
  /** The destination's runner stopped and started again on the same registry and the same engine: a process restart. */
  restart(): Promise<void>
}

const made: string[] = []
afterAll(() => { for (const dir of made) rmSync(dir, { recursive: true, force: true }) })
const scratch = (): string => { const dir = realpathSync(mkdtempSync(join(tmpdir(), "dr-"))); made.push(dir); return dir }

const hubOf = (r: Rig) => ({ store: r.s.hub, registryFile: r.it.registryFile, machine: "pi", load: () => loadRegistry(r.it.registryFile, { machine: "pi" }) })
const runnerLedger = (r: Rig, kind: string) => r.it.read.ledger({ stream: "runner", kind })
const rowsOf = async (r: Rig, query: string) => await r.it.read.sql(query)

/**
 * A REAL runner for the destination machine (`mac`), a source machine (`pi`) whose runner is never started, and a conversation the engine has
 * started that the owner asked to move: the destination's watch has recorded its preflight by the time this returns. The agent is on the source's
 * runner in the registry until the hub writes it.
 */
async function stage(options: { release?: boolean; instruction?: boolean; household?: Household; engineDown?: boolean; legacySource?: boolean } = {}): Promise<Rig> {
  const agent = `t-${crypto.randomUUID()}`
  let instruction: string | null = null
  const h = options.household ?? null
  const capabilities = { stableSession: true, safeResume: false, delegationDisabled: false, version: "9.9.2" }
  const it = await stageHub(cluster, {
    adapter: { exitProof: true, capabilities },
    machines: [{ id: "pi", os: "linux" }, { id: "mac", os: "macos" }],
    hub: { tick_seconds: 1 },
    run: [
      { id: DOOR, kind: "door", machine: "pi", platform: "fake", person: PERSON, token_file: "/dev/null", schedule: "always", memory_limit_mb: 192 },
      { id: SRC.runner, kind: "runner", machine: SRC.machine, schedule: "always", memory_limit_mb: 512, child_memory_limit_mb: 512 },
      { id: DST.runner, kind: "runner", machine: DST.machine, schedule: "always", memory_limit_mb: 512, child_memory_limit_mb: 512 },
      ...(h?.registry.run ?? []),
    ],
    // The person has a real EMPTY tree (`withLaunchTree`): the source's scope look and the effective configuration ask where the launch would read a
    // default instruction file from, which is the person's tree, and a person with none gives them nothing to look at.
    // With `instruction` the DESTINATION's tree (the person's placement on `mac`) holds a default instruction file the source's does not: the
    // effective configurations differ in the instructions, which the destination's preflight records and the source names.
    // With a household the person's tree is the household's vault on each machine, with the zone and a project inside it, synced on both.
    registry: base => {
      const planted = withLaunchTree(base)
      let people = planted.people ?? []
      if (options.instruction) {
        const macTree = join(String(base.hub?.state_dir), "trees", "p1-mac")
        mkdirSync(macTree, { recursive: true })
        instruction = join(macTree, "CLAUDE.md")
        writeFileSync(instruction, "# local instructions\n")
        people = people.map(one => (one.id === PERSON ? { ...one, on: { mac: { tree: macTree } } } : one))
      }
      if (h) people = [{ id: PERSON, ...h.registry.person } as PersonSpec]
      return {
        ...planted, people, agents: [{ id: agent, person: PERSON, preset: "daily", chat: CHAT, door: DOOR, runner: SRC.runner }],
        ...(h ? { repositories: h.registry.repositories, ...(h.registry.zone ? { zone: h.registry.zone } : {}) } : {}),
      }
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
  const probe: Rig["probe"] = { reads: 0, gate: null, down: options.engineDown === true }
  const port: NativeSessionPort = {
    ...fake.port,
    checkResumed(input) { checks.push(input); if (verdict.refuse) throw new NativeRefusal("native_resume_unverified", "scripted") },
  }
  const engine = {
    ...it.scripted.adapter, session: port,
    capabilities: async (context: Parameters<NonNullable<typeof it.scripted.adapter.capabilities>>[0]) => {
      probe.reads += 1
      await probe.gate
      if (probe.down) throw new Error("the engine could not be asked")
      return await it.scripted.adapter.capabilities!(context)
    },
  }
  const begin = async () => {
    const started = await runRunner({ runner: DST.runner, registryFile: it.registryFile, adapters: { [it.adapterName]: engine } })
    runners.push(started)
    return started
  }
  let runner = await begin()
  const restart = async () => { await runner.stop(); runner = await begin() }
  await s.adopt(DST)
  await s.register(SRC, "src-1")
  const move = await s.request(t)
  const native = await s.nativeOf(move)
  // The source's half, as the accepted export: the drain's store half, then the release, bound to this very registry file. It is a source of the
  // CURRENT build in every case, whatever the person declares: the destination's runner always records its effective configuration, so the source
  // reads the file as the source machine does (its tree, its placements) and compares and seals the effective configuration, the plan of the
  // repositories (none, for a person that declares none) and the scope. What it seals is its own observation, compared by the export itself with what
  // the destination recorded (equality, never a digest copied from the destination). Only `legacySource` is a source of an older build: it supplies
  // none of that, seals no configuration, and a destination that recorded one must refuse its manifest (DR-11).
  const src = handoffWorld(s, "source", { port: fake.port, locks: lockChain() })
  const view = () => loadRegistry(it.registryFile, { machine: SRC.machine })
  src.w.scope = row => scopeOf(options.legacySource ? loadRegistry(it.registryFile) : view(), row)
  src.w.sourceProfile = row => profileOf(options.legacySource ? loadRegistry(it.registryFile) : view(), row.agent)
  if (!options.legacySource) {
    src.w.effectiveConfig = (row, registry) => effectiveConfigOf((registry as ReturnType<typeof view> | undefined) ?? view(), row.agent, row.id)
    src.w.workspaceFacts = row => workspaceFactsOf(view(), row)
    src.w.sourceWorkspace = row => observeSource({ registry: view(), storeUrl: s.tool.url }, row)
  }
  const rig: Rig = { it, s, agent, move, native, checks, verdict, probe, instruction, src, h, restart }
  if (options.engineDown) {
    // The engine cannot be asked: the preflight is this side's named block and records nothing.
    await until("the destination named the engine it could not read", async () => (await readMove(s.tool, move.id))!.block?.code === "dest_build_unknown", 45_000,
      async () => JSON.stringify(await readMove(s.tool, move.id)))
    return rig
  }
  await until("the destination's runner recorded its preflight", async () => (await readMove(s.tool, move.id))!.dest_ready_at !== null, 45_000,
    async () => JSON.stringify(await readMove(s.tool, move.id)))
  if (options.release === false || options.instruction) return rig

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

test("DR-5: a default instruction file only THIS machine has is a named configuration mismatch at the source; when it is removed the same runner records its preflight again with no restart and no notification, and the source releases", async () => {
  const r = await stage({ instruction: true })
  expect(r.instruction).not.toBeNull()
  const mine = (await readMove(r.s.tool, r.move.id))!
  expect(mine.dest_facts).toMatchObject({ effective: { version: 1 } })
  await drainOnly(r.s, r.move)
  expect(await exportSource(r.src.w, PROVEN, r.move.id)).toMatchObject({ state: "blocked", reason: "config_mismatch", detail: { sections: ["instructions"] } })
  expect(JSON.stringify(await readMove(r.s.tool, r.move.id)), "a section name: no content of the file").not.toContain("local instructions")

  // No move row changes when the file is removed, so no notification comes: the runner's own tick sees the facts its preflight was made from move.
  rmSync(r.instruction!)
  const mineNow = () => effectiveConfigOf(loadRegistry(r.it.registryFile, { machine: SRC.machine }), r.agent, r.move.id)
  await until("the destination recorded its preflight again", async () => {
    const row = (await readMove(r.s.tool, r.move.id))!
    const wanted = mineNow()
    return !("unverifiable" in wanted) && configDifference(wanted, row.dest_facts!.effective).length === 0
  }, 30_000, async () => JSON.stringify(await readMove(r.s.tool, r.move.id)))
  expect(await exportSource(r.src.w, PROVEN, r.move.id)).toMatchObject({ state: "done", reason: "released" })
  expect((await readMove(r.s.tool, r.move.id))!.block, "the source's own block cleared when its look passed").toBeNull()
}, SLOW)

test("DR-6: a destination behind or dirty at the import waits on its own named block and imports BY ITSELF once its sync pulls and its dirt is gone (a file removed deep in a worktree is seen at the bounded re-look), with no notification", async () => {
  const h = stageHousehold(scratch())
  const proj = h.checkouts.proj
  const wasRecheck = RECHECK.ms
  RECHECK.ms = 300
  try {
    const r = await stage({ household: h, release: false })
    expect((await readMove(r.s.tool, r.move.id))!.dest_facts).toMatchObject({ effective: { version: 1 }, workspace: { version: 1, repositories: 3 } })

    // The source's sync pushed a commit the destination has not pulled, and the destination has an untracked file of its own deep in the project.
    h.commit(proj.src, "notes/more.md", "more\n", "hub sync")
    h.push(proj.src)
    const sealedHead = h.head(proj.src)
    h.put(proj.dst, "notes/deep/mine.md", "the destination's own\n")
    await drainOnly(r.s, r.move)
    expect(await exportSource(r.src.w, PROVEN, r.move.id)).toMatchObject({ state: "done", reason: "released" })
    const dump = async () => JSON.stringify(await readMove(r.s.tool, r.move.id))
    // Dirt is named before the commit is even asked about: the destination's own file is not the source's content.
    await until("the destination named its dirt", async () => (await readMove(r.s.tool, r.move.id))!.block?.code === "dest_workspace_dirty", 45_000, dump)
    expect((await readMove(r.s.tool, r.move.id))!.block).toMatchObject({ by: "dest", detail: { repository: "proj", untracked: 1 } })
    expect((await readMove(r.s.tool, r.move.id))!.stage).toBe("source_released")

    // REPAIR ONE: the file is removed (no git file changes: only the bounded re-look sees it). Now the commit is the thing missing.
    rmSync(join(proj.dst, "notes", "deep"), { recursive: true })
    await until("the destination named the commit it lacks", async () => (await readMove(r.s.tool, r.move.id))!.block?.code === "dest_workspace_behind", 45_000, dump)
    expect((await readMove(r.s.tool, r.move.id))!.block).toMatchObject({ detail: { repository: "proj", why: "revision-missing" } })
    expect(await rowsOf(r, "select 1 from move_copy where kind = 'dest_import'"), "nothing was staged").toEqual([])

    // REPAIR TWO: its own sync pulls (the branch and the remote-tracking ref move). The runner imports and activates with nobody asking.
    h.pull(proj.dst)
    await until("the destination imported and activated", async () => (await readMove(r.s.tool, r.move.id))!.stage === "activated", 60_000, dump)
    const activated = (await readMove(r.s.tool, r.move.id))!
    expect(activated.block).toBeNull()
    expect(h.head(proj.dst)).toBe(sealedHead)
    expect(await r.s.openGates(r.agent), "activation never releases the gate").toEqual([`move:${r.move.id}`])
  } finally { RECHECK.ms = wasRecheck }
}, SLOW)

test("DR-7: an engine that could not be asked at the preflight is not asked again by the tick; once the engine is readable and the bounded clock's slot has moved, the same runner records its preflight with no restart and no notification", async () => {
  const wasEngine = ENGINE_RECHECK.ms
  const wasRecheck = RECHECK.ms
  // An hour: no slot of either clock changes while the first half of this test looks, so only a fact of the engine or the clock can ask again.
  ENGINE_RECHECK.ms = RECHECK.ms = 3_600_000
  try {
    const r = await stage({ engineDown: true })
    const dump = async () => JSON.stringify(await readMove(r.s.tool, r.move.id))
    const unknown = (await readMove(r.s.tool, r.move.id))!
    expect(unknown.block).toMatchObject({ by: "dest", code: "dest_build_unknown" })
    expect(unknown.dest_ready_at, "nothing was recorded over the refusal").toBeNull()
    // The block's own notification is looked at once more (and writes nothing); after that the tick asks the engine nothing.
    let settled = -1
    while (settled !== r.probe.reads) { settled = r.probe.reads; await Bun.sleep(1500) }
    await Bun.sleep(3500)
    expect(r.probe.reads, "three ticks went by and no process was asked").toBe(settled)

    // The engine is readable again. Nothing is written to the store and nobody is told: a smaller slot stands for the time that passed, and the
    // runner makes ONE look, which reads the engine, records the preflight and clears its own block. RECHECK stays an hour, so it was not the checkouts' clock.
    r.probe.down = false
    ENGINE_RECHECK.ms = 300
    await until("the destination recorded its preflight", async () => (await readMove(r.s.tool, r.move.id))!.dest_ready_at !== null, 30_000, dump)
    const ready = (await readMove(r.s.tool, r.move.id))!
    expect(ready.block, "its own block cleared by the look that passed").toBeNull()
    expect(ready.dest_facts).toMatchObject({ capabilities: { version: "9.9.2" } })
    expect(r.probe.reads).toBeGreaterThan(settled)

    // And it settles again: a preflight that was recorded is not a probe of the engine, so the slot keeps nothing owed.
    let again = -1
    while (again !== r.probe.reads) { again = r.probe.reads; await Bun.sleep(1500) }
    await Bun.sleep(2500)
    expect(r.probe.reads, "a recorded preflight asks the engine nothing on the tick").toBe(again)
  } finally { ENGINE_RECHECK.ms = wasEngine; RECHECK.ms = wasRecheck }
}, SLOW)

test("DR-8: an engine that could not be asked at the serve leaves the move registry_written, releases nothing and writes nothing; when it is readable again the same runner serves, with no restart and no notification", async () => {
  const wasEngine = ENGINE_RECHECK.ms
  ENGINE_RECHECK.ms = 3_600_000
  try {
    const r = await stage()
    await toActivated(r)
    r.probe.down = true
    await registerMoves(hubOf(r))
    expect((await readMove(r.s.tool, r.move.id))!.stage).toBe("registry_written")
    // The agent's loop comes up here on the tick and the serve is looked at with an engine it cannot read: it waits, and no fact of this machine's files moves
    // when the engine comes back, which is what used to leave it there for good.
    await Bun.sleep(4500)
    const waiting = (await readMove(r.s.tool, r.move.id))!
    expect(waiting.stage).toBe("registry_written")
    expect(waiting.block, "an engine that could not be read is a wait, not a block").toBeNull()
    expect(await r.s.openGates(r.agent), "nothing released the gate").toEqual([`move:${r.move.id}`])

    r.probe.down = false
    ENGINE_RECHECK.ms = 300
    await until("the destination served", async () => (await readMove(r.s.tool, r.move.id))!.stage === "active", 45_000,
      async () => JSON.stringify(await readMove(r.s.tool, r.move.id)))
    expect(await r.s.openGates(r.agent), "the serve released it").toEqual([])
  } finally { ENGINE_RECHECK.ms = wasEngine }
}, SLOW)

test("DR-11: a source of an older build sealed no configuration, and the destination that recorded its own never imports that manifest: a named block, nothing staged, nothing activated, and it is not compared by an older rule instead", async () => {
  const r = await stage({ legacySource: true })
  const dump = async () => JSON.stringify(await readMove(r.s.tool, r.move.id))
  const asked = (await readMove(r.s.tool, r.move.id))!
  expect(asked.dest_facts, "the destination recorded what it compares").toMatchObject({ effective: { version: 1 } })
  expect(asked.manifest!.config, "and the old source sealed none").toBeUndefined()
  await until("the destination refused the manifest that sealed no configuration", async () => {
    const row = (await readMove(r.s.tool, r.move.id))!
    return row.block?.code === "dest_config_unverifiable"
  }, 45_000, dump)
  expect((await readMove(r.s.tool, r.move.id))!.block).toMatchObject({ by: "dest", code: "dest_config_unverifiable", detail: { reason: "not-sealed" } })

  // It stays refused: no look imports it, and nothing is staged or released on the way.
  await Bun.sleep(3500)
  const held = (await readMove(r.s.tool, r.move.id))!
  expect(held.stage).toBe("source_released")
  expect(held.block).toMatchObject({ code: "dest_config_unverifiable", detail: { reason: "not-sealed" } })
  expect(await rowsOf(r, "select 1 from move_copy where kind = 'dest_import'"), "nothing was staged").toEqual([])
  expect(await r.s.openGates(r.agent), "the gate is still open").toEqual([`move:${r.move.id}`])
  expect(r.it.scripted.fed()).toEqual([])
}, SLOW)

/**
 * A move whose manifest sealed the effective configuration and that is SERVED, with the first input still to come. A refused feed waits one second
 * (the registry's own `task_retry_seconds`, the usual retry of any refused feed), so a repaired file is looked at again with nothing else asked.
 */
async function servedWithConfig(): Promise<{ r: Rig; active: MoveRow }> {
  const r = await stage({ instruction: true })
  // The destination-only instruction file is a named mismatch at the source (DR-5): removed, the preflight is recorded again, and the move released.
  rmSync(r.instruction!)
  const mineNow = () => effectiveConfigOf(loadRegistry(r.it.registryFile, { machine: SRC.machine }), r.agent, r.move.id)
  await until("the destination recorded its preflight again", async () => {
    const row = (await readMove(r.s.tool, r.move.id))!
    const wanted = mineNow()
    return !("unverifiable" in wanted) && configDifference(wanted, row.dest_facts!.effective).length === 0
  }, 30_000, async () => JSON.stringify(await readMove(r.s.tool, r.move.id)))
  await drainOnly(r.s, r.move)
  expect(await exportSource(r.src.w, PROVEN, r.move.id)).toMatchObject({ state: "done", reason: "released" })
  appendFileSync(r.it.registryFile, "\n[runner]\ntask_retry_seconds = 1\n")
  const active = await toActive(r)
  expect(active.manifest!.config, "the move sealed the configuration it compared").toMatchObject({ version: 1 })
  return { r, active }
}

const DRIFT = "# local instructions, added after the serve\n"

test("DR-9: a configuration that drifts after the serve and before the first input starts no child and consumes no input: it is handed back with the note still owed, and once the file is restored the same input is fed ONCE behind the note, resumed, with no fresh session", async () => {
  const { r, active } = await servedWithConfig()
  writeFileSync(r.instruction!, DRIFT)
  await firstInput(r)
  await until("the feed was refused for the drift", async () => (await runnerLedger(r, "move.note-refused")).length >= 1, 60_000, async () => JSON.stringify(await runnerLedger(r, "move.note-refused")))
  expect((await runnerLedger(r, "move.note-refused"))[0].detail).toMatchObject({ move: r.move.id, answer: "config-drift:instructions" })

  // It repeats on the retry, and nothing is ever started, fed or acknowledged for it.
  await Bun.sleep(3500)
  expect(r.it.scripted.starts(), "no child was spawned").toEqual([])
  expect(r.it.scripted.fed(), "nothing was fed").toEqual([])
  const attempts = await rowsOf(r, "select state from execution where inbound_id = 'q1'")
  expect(attempts.length, "the refusals are attempts the machinery ended unfed").toBeGreaterThan(0)
  for (const one of attempts) expect(["feed_intent", "received", "running", "completed"], "no attempt reached the engine").not.toContain(String(one.state))
  expect((await r.it.read.outbox()).filter(one => one.inbound_id === "q1"), "no reply").toEqual([])
  expect(["answered", "delivered"], "the input is not consumed").not.toContain(String((await rowsOf(r, "select state from inbound where id = 'q1'"))[0].state))
  expect(await pendingNotesOf(r.s.tool, r.agent), "the note is still owed").toHaveLength(1)
  expect((await readMove(r.s.tool, r.move.id))!.note_state).toBe("pending")
  expect((await r.s.su`select 1 from conversation_entry where conversation_id = ${r.move.conversation_id} and source_id = ${`move-note:${r.move.id}`}`).length, "and was written down nowhere").toBe(0)
  expect(await r.s.nativeOf(r.move), "no fresh session was minted").toBe(r.native)
  expect(r.checks).toEqual([])

  // Restored: the same input, on the usual retry, is fed once behind the note and the resume is checked.
  rmSync(r.instruction!)
  await until("the input was fed", () => r.it.scripted.fed().length === 1, 60_000, () => JSON.stringify(r.it.scripted.fed()))
  const note = relocationNote(active)
  expect(r.it.scripted.fed()[0].id).toBe("q1")
  expect(r.it.scripted.fed()[0].text.startsWith(note), "the note goes ahead of the input").toBe(true)
  await until("the note was acknowledged", async () => (await readMove(r.s.tool, r.move.id))!.note_state === "delivered", 60_000, async () => JSON.stringify(await readMove(r.s.tool, r.move.id)))
  await until("the reply landed", async () => (await r.it.read.outbox()).some(one => one.inbound_id === "q1"), 60_000)
  await Bun.sleep(2500)
  expect(r.it.scripted.fed().map(one => one.id), "fed once").toEqual(["q1"])
  expect((await r.it.read.outbox()).filter(one => one.inbound_id === "q1"), "answered once").toHaveLength(1)
  expect(r.checks, "the resume was checked once").toHaveLength(1)
  expect(await r.s.nativeOf(r.move), "no fresh session was minted").toBe(r.native)
  for (const start of r.it.scripted.starts()) expect(start.session, "every start resumed the conversation's own session").toEqual({ id: r.native, resume: true })
  expect(await pendingNotesOf(r.s.tool, r.agent)).toEqual([])
}, SLOW)

test("DR-10: a runner that restarts after the serve and before the first input is held to the same question at its eager start: no child while the configuration has drifted, and the imported session is resumed once it is restored", async () => {
  const { r, active } = await servedWithConfig()
  writeFileSync(r.instruction!, DRIFT)
  await r.restart()
  await until("the eager start was refused for the drift", async () => (await runnerLedger(r, "move.note-refused")).length >= 1, 60_000, async () => JSON.stringify(await runnerLedger(r, "move.note-refused")))
  expect((await runnerLedger(r, "move.note-refused"))[0].detail).toMatchObject({ move: r.move.id, answer: "config-drift:instructions", execution: null })
  await Bun.sleep(3500)
  expect(r.it.scripted.starts(), "no child was started").toEqual([])
  expect(await pendingNotesOf(r.s.tool, r.agent), "the note is still owed").toHaveLength(1)

  // Restored and restarted again: the same start brings the imported session up, feeding nothing, and the first input carries the note once.
  rmSync(r.instruction!)
  await r.restart()
  await until("the child was started", () => r.it.scripted.starts().length === 1, 60_000, () => JSON.stringify(r.it.scripted.starts()))
  expect(r.it.scripted.starts()[0].session, "it resumes the imported session").toEqual({ id: r.native, resume: true })
  expect(r.it.scripted.fed(), "a start feeds nothing").toEqual([])
  expect(await pendingNotesOf(r.s.tool, r.agent), "and delivers no note").toHaveLength(1)
  await firstInput(r)
  await until("the input was fed", () => r.it.scripted.fed().length === 1, 60_000, () => JSON.stringify(r.it.scripted.fed()))
  expect(r.it.scripted.fed()[0].text.startsWith(relocationNote(active))).toBe(true)
  await until("the note was acknowledged", async () => (await readMove(r.s.tool, r.move.id))!.note_state === "delivered", 60_000, async () => JSON.stringify(await readMove(r.s.tool, r.move.id)))
  expect(await r.s.nativeOf(r.move), "no fresh session was minted").toBe(r.native)
}, SLOW)
