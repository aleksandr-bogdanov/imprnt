// The RUNTIME INTEGRATION of a topic move: what joins the accepted handoff modules (`move-export.ts`, `move-import.ts`) to a runner, a hub and a
// registry, against a disposable store with the move's own routines (migration 016).
//
// WHAT THIS PROVES: the destination's gate is released only by `serveDestination` after the hub bound a receipt to the registry bytes it wrote
// and the destination loaded exactly those bytes, with the profile the preflight recorded and the engine it recorded (a copy that is behind, an
// agent that is not up, a profile or capabilities that changed all leave the gate where it is); the hub writes the agent's runner key only through
// the registry editor, judged inside its lock, and states a receipt only for a file that still gives the agent the recorded profile (conflict,
// changed profile, unrelated edit: named blocks and a refreshed receipt); the relocation note is composed from the move alone, hashes to what serve
// declared (and says only that the transcript moved: it promises no sync), rides a feed through the store's own journal and is acknowledged only on evidence that
// the attempt was received; a dependency the move does not carry or verify (a repository, a vault, a shared-zone checkout, a file found in the person's own
// tree, a default instruction file at the source or the destination) and a configuration file the launch reads and nothing compares are named
// refusals BEFORE anything is read or stored (no acknowledgement clears one), and a profile the destination recorded that is not the source's is one too;
// the watch looks at a destination's moves without placing a fence and removes the copies the store owes a cleanup from `copiesDueForCleanup`; and a
// REAL runner whose destination is offline waits (no export, no fallback, no second child, the queued input untouched), exports once the
// destination has recorded its preflight, and keeps the native session id (also across a withdrawal, where it resumes the same id).
//
// WHAT IT DOES NOT: a destination RUNNER (the destination's side of `run.ts`: its loop, the first resumed turn and `checkResumed` after it are
// `topic-move-destination-runner.test.ts`'s), a real engine (`checkResumed` is the adapter's own test), a spoke's copy of the registry, or anything
// about the production path gates (dots, side state, builds). The native port here is the scripted one of `move-handoff-stage.ts`.

import { afterAll, afterEach, beforeAll, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { startCluster, until, type Cluster } from "./helpers/cluster.ts"
import { CHAT, DOOR, PERSON, insertInbound, stageHub, withLaunchTree } from "./helpers/hub-fixture.ts"
import { DST, OWNER, SRC, moveStage, sha, type MoveFixture } from "./helpers/move-store-stage.ts"
import { Crash, PROVEN, drainOnly, fakePort, handoffWorld, lockChain, type Fake, type Locks } from "./helpers/move-handoff-stage.ts"
import { writeRegistry, type AgentSpec, type PersonSpec, type RepositorySpec, type ZoneSpec } from "./helpers/registry.ts"
import { registerMoves, type RegistryMovesContext } from "../src/hub/moves.ts"
import { listAgents } from "../src/registry/entries.ts"
import { Registry, loadRegistry, registryDigest } from "../src/registry/load.ts"
import { exportSource } from "../src/runner/move-export.ts"
import { cleanupCopies, importDestination, prepareDestination } from "../src/runner/move-import.ts"
import { importedBy, moveNotice, noteBlock, notesOwedTo, noteDigestOf, relocationNote } from "../src/runner/move-note.ts"
import { configReferences, profileDifference, profileOf } from "../src/runner/move-profile.ts"
import { who, type ScopeProof } from "../src/runner/move-handoff.ts"
import { defaultInstructionsOf, scopeOf, type Look, type ScopeFs } from "../src/runner/move-scope.ts"
import { serveDestination, type ServeWorld } from "../src/runner/move-serve.ts"
import { createFences, watchMoves, type DrainStep, type MoveWatch } from "../src/runner/move.ts"
import { runRunner } from "../src/runner/run.ts"
import { MoveNoteRefused, markFeedIntent, markProgress } from "../src/store/conversations.ts"
import { blockMove, destReady, noteDelivered, pendingNotesOf, readMove, serveMove, withdrawMove, type MoveRow } from "../src/store/moves.ts"
import { newIdentity, type TopicRow } from "../src/store/topics.ts"

let cluster: Cluster
const mine: { close(): Promise<void> }[] = []
const track = <T extends { close(): Promise<void> }>(sql: T): T => { mine.push(sql); return sql }
const watches: MoveWatch[] = []
const runners: { stop(): Promise<void> }[] = []
const staged: { stop(): Promise<void>; scripted: { reap(): void } }[] = []
const made: string[] = []
beforeAll(async () => { cluster = await startCluster() })
afterEach(async () => {
  for (const one of watches.splice(0)) await one.close().catch(() => {})
  for (const one of runners.splice(0)) await one.stop().catch(() => {})
  for (const one of staged.splice(0)) { one.scripted.reap(); await one.stop().catch(() => {}) }
  for (const one of mine.splice(0)) await one.close().catch(() => {})
})
afterAll(async () => { for (const dir of made) rmSync(dir, { recursive: true, force: true }); await cluster?.stop() })

const stage = () => moveStage(cluster, track)
const scratch = (): string => { const dir = realpathSync(mkdtempSync(join(tmpdir(), "rt-"))); made.push(dir); return dir }
const SLOW = 120_000

/** A registry of two machines and their runners, with the agent on the runner given (the source's by default). */
interface MoveRegistryOptions {
  runner?: string
  mode?: string
  repositories?: RepositorySpec[]
  /** More keys on the person's entry (a vault, a settings file, an instruction list) and on the agent's (a settings file, a fragment). */
  person?: Record<string, unknown>
  agent?: Record<string, unknown>
  zone?: ZoneSpec
}
function writeMoveRegistry(dir: string, agent: string, options: MoveRegistryOptions = {}): string {
  return writeRegistry(dir, {
    hub: { state_dir: dir, store_url: "postgres://127.0.0.1:1/unused" },
    machines: [{ id: "pi", os: "linux" }, { id: "mac", os: "macos" }],
    people: [{ id: "p1", tree: join(dir, "p1"), ...options.person } as PersonSpec],
    presets: { daily: { adapter: "a-scripted-adapter", model: "m", provider: "p", effort: "medium", paid: "key" } },
    agents: [{ id: agent, person: "p1", preset: "daily", chat: "1000000001", door: "door-fake", runner: options.runner ?? SRC.runner, ...(options.mode ? { mode: options.mode } : {}), ...options.agent } as AgentSpec],
    run: [
      { id: "door-fake", kind: "door", machine: "pi", platform: "fake", person: "p1", token_file: "/dev/null", schedule: "always", memory_limit_mb: 192 },
      { id: SRC.runner, kind: "runner", machine: SRC.machine, schedule: "always", memory_limit_mb: 512, child_memory_limit_mb: 512 },
      { id: DST.runner, kind: "runner", machine: DST.machine, schedule: "always", memory_limit_mb: 512, child_memory_limit_mb: 512 },
      { id: "runner-third", kind: "runner", machine: SRC.machine, schedule: "always", memory_limit_mb: 512, child_memory_limit_mb: 512 },
    ],
    ...(options.repositories ? { repositories: options.repositories } : {}),
    ...(options.zone ? { zone: options.zone } : {}),
  })
}
const agentRunner = (file: string, agent: string) => listAgents(loadRegistry(file)).find(one => one.id === agent)?.runner

type World = ReturnType<typeof handoffWorld>
interface Rig { s: MoveFixture; t: TopicRow; move: MoveRow; agent: string; dir: string; file: string; locks: Locks; fake: Fake; src: World; dst: World }

/**
 * A started conversation of an agent the registry file names, a move requested, both runners registered, a native port both sides share, and
 * the worlds bound to that registry: the destination's profile and the source's are what the file says, and the scope is the file's.
 */
async function rig(options: { registry?: Parameters<typeof writeMoveRegistry>[2] } = {}): Promise<Rig> {
  const s = await stage()
  await s.fleet()
  const agent = `t-${crypto.randomUUID()}`
  const t = await s.topic(`rt-${s.next()}`, { identity: () => ({ ...newIdentity(), agent_id: agent }) })
  const move = await s.request(t)
  await s.su`update conversation set native_state = 'started' where id = ${move.conversation_id}`
  const dir = scratch()
  const file = writeMoveRegistry(dir, agent, options.registry)
  const locks = lockChain()
  const fake = fakePort({ lockHeld: () => locks.held.size > 0 })
  const src = handoffWorld(s, "source", { port: fake.port, locks })
  const dst = handoffWorld(s, "dest", { port: fake.port, locks })
  src.w.scope = row => scopeOf(loadRegistry(file), row)
  src.w.sourceProfile = row => profileOf(loadRegistry(file), row.agent)
  dst.w.profile = row => ({ move: row.id, agent: row.agent, runner: row.dest_runner, machine: row.dest_machine, profile: profileOf(loadRegistry(file), row.agent)!, basis: "test: the registry file" })
  return { s, t, move, agent, dir, file, locks, fake, src, dst }
}

/** The preflight, the drain, the export, the import and the activation: the move at `activated`, the gate still open. */
async function toActivated(r: Rig): Promise<MoveRow> {
  expect(await prepareDestination(r.dst.w, r.move.id)).toMatchObject({ state: "done", reason: "ready" })
  await drainOnly(r.s, r.move)
  expect(await exportSource(r.src.w, PROVEN, r.move.id)).toMatchObject({ state: "done", reason: "released" })
  expect(await importDestination(r.dst.w, r.move.id)).toMatchObject({ state: "done", reason: "activated" })
  const row = await r.s.reread(r.move)
  expect(row.stage).toBe("activated")
  return row
}

const hubOf = (r: Rig, machine = "pi"): RegistryMovesContext => ({ store: r.s.hub, registryFile: r.file, machine, load: () => loadRegistry(r.file, { machine }) })

/** What the destination's runner hands the serve: the file as it stands, read once, and an agent that is (or is not) up. */
const serveOf = (r: Rig, over: Partial<ServeWorld> = {}): ServeWorld => ({
  ...r.dst.w,
  loaded: () => ({ digest: registryDigest(r.file), registry: loadRegistry(r.file) }),
  serving: () => true,
  language: () => "en",
  ...over,
})
const gateOf = (r: Rig) => `move:${r.move.id}`
const openGates = (r: Rig) => r.s.openGates(r.agent)

// ---------------------------------------------------------------------------------------------------------------------
// registry, serve and the gate
// ---------------------------------------------------------------------------------------------------------------------

test("RT-1: the gate is released only by the serve of what the destination LOADED: the hub's receipt binds the bytes it wrote, a copy that is behind, an agent that is not up and an edited file all wait, and the exact binding serves", async () => {
  const r = await rig()
  const activated = await toActivated(r)
  const placement = activated.dest_generation
  if (placement === null) throw new Error("an activated move has the destination's placement generation")
  expect(await openGates(r), "activation never releases the gate").toEqual([gateOf(r)])
  expect(agentRunner(r.file, r.agent), "and the registry still says the source").toBe(SRC.runner)
  expect(await serveDestination(serveOf(r), r.move.id), "nothing is served before the receipt").toMatchObject({ state: "waiting", reason: "stage:activated" })

  // THE HUB: the one key, through the editor, then the receipt of exactly the bytes it observed.
  await registerMoves(hubOf(r))
  const written = await r.s.reread(r.move)
  expect(written.stage).toBe("registry_written")
  expect(agentRunner(r.file, r.agent)).toBe(DST.runner)
  expect(written.registry_receipt).toEqual({
    digest: registryDigest(r.file), agent: r.agent, runner: DST.runner, machine: DST.machine, placement_generation: placement,
    profile: written.dest_facts!.profile,
  })
  expect(await openGates(r), "a registry write is never readiness").toEqual([gateOf(r)])

  // A copy of the registry that is behind the receipt, an agent that is not up here, and an unrelated edit of the file: each waits, the gate stays.
  expect(await serveDestination(serveOf(r, { loaded: () => ({ digest: sha("an older registry"), registry: loadRegistry(r.file) }) }), r.move.id)).toMatchObject({ state: "waiting", reason: "registry-stale", detail: { owed: "local" } })
  expect(await serveDestination(serveOf(r, { serving: () => false }), r.move.id)).toMatchObject({ state: "waiting", reason: "agent-not-serving" })
  expect(await serveDestination(serveOf(r, { loaded: () => null }), r.move.id)).toMatchObject({ state: "waiting", reason: "registry-unreadable" })
  writeFileSync(r.file, `${readFileSync(r.file, "utf8")}\n# an unrelated edit\n`)
  expect(await serveDestination(serveOf(r), r.move.id), "the file changed since the receipt").toMatchObject({ state: "waiting", reason: "registry-stale" })
  expect(await openGates(r)).toEqual([gateOf(r)])
  expect((await r.s.reread(r.move)).stage).toBe("registry_written")

  // The hub refreshes the receipt while the binding holds, and then the exact binding serves.
  await registerMoves(hubOf(r))
  expect((await r.s.reread(r.move)).registry_receipt!.digest).toBe(registryDigest(r.file))
  expect(await serveDestination(serveOf(r), r.move.id)).toMatchObject({ state: "done", reason: "active" })

  const active = await r.s.reread(r.move)
  expect(active.stage).toBe("active")
  expect(await openGates(r), "the gate is released by the serve and by nothing else").toEqual([])
  expect(active.note_state).toBe("pending")
  expect(active.note_digest).toBe(noteDigestOf(active))
  expect(await r.s.count("move_blob where move_id = $1", r.move.id), "the blobs are gone once the destination has its own copy").toBe(0)
  expect(await r.s.count("outbox where notice_key = $1", `topic-move:${r.move.id}:active`), "the owner's notice is queued once").toBe(1)
  expect(await serveDestination(serveOf(r), r.move.id), "a second look serves nothing again").toMatchObject({ state: "done", reason: "active" })
  expect(r.dst.said.map(one => one.kind)).toContain("move.served")
})

test("RT-2: a serve that finds the profile or the engine changed since the preflight is the destination's named block, stays while the same facts are read (no write loop), and clears itself when they change", async () => {
  const r = await rig()
  await toActivated(r)
  await registerMoves(hubOf(r))
  const receipt = (await r.s.reread(r.move)).registry_receipt!

  // The destination's copy of the file gives the agent another mode than the one it recorded: the digest is the receipt's, the profile is not.
  const other = writeMoveRegistry(scratch(), r.agent, { runner: DST.runner, mode: "on-demand" })
  const diverged = serveOf(r, { loaded: () => ({ digest: receipt.digest, registry: loadRegistry(other) }) })
  expect(await serveDestination(diverged, r.move.id)).toMatchObject({ state: "blocked", reason: "serve_profile_mismatch", detail: { sections: ["agent.mode"] } })
  const blocked = await r.s.reread(r.move)
  expect(blocked).toMatchObject({ stage: "registry_written", block: { code: "serve_profile_mismatch", by: "dest" } })
  expect(await openGates(r)).toEqual([gateOf(r)])

  // The same facts again: no call, no write (the row is not touched, so its notification does not make the next look write it again).
  expect(await serveDestination(diverged, r.move.id)).toMatchObject({ state: "waiting", reason: "blocked" })
  expect((await r.s.reread(r.move)).updated_at.getTime()).toBe(blocked.updated_at.getTime())

  // The engine changed instead: the facts differ, the block is cleared and the new refusal is named.
  const grown = serveOf(r, { build: async () => ({ version: "9.9.3", capabilities: { resume: true, mcp: true, extra: true } }) })
  expect(await serveDestination(grown, r.move.id)).toMatchObject({ state: "blocked", reason: "serve_capabilities_changed" })
  // Restored: the block clears and the move is served.
  expect(await serveDestination(serveOf(r), r.move.id)).toMatchObject({ state: "done", reason: "active" })
  expect((await r.s.reread(r.move)).block).toBeNull()
  expect(await openGates(r)).toEqual([])
})

test("RT-3: the hub writes the runner key only for a registry that still carries out the move: a third runner is a conflict, a profile that changed since the preflight is named, and each clears when the file is right", async () => {
  const r = await rig()
  await toActivated(r)
  const before = readFileSync(r.file, "utf8")

  // The agent is on a runner that is neither the move's source nor its destination: nothing is written and the hub's own block says so.
  writeMoveRegistry(r.dir, r.agent, { runner: "runner-third" })
  const moved = readFileSync(r.file, "utf8")
  await registerMoves(hubOf(r))
  expect(readFileSync(r.file, "utf8"), "the file was not touched").toBe(moved)
  expect(await r.s.reread(r.move)).toMatchObject({ stage: "activated", block: { code: "registry_conflict", by: "hub" } })

  // The agent's profile changed after the destination recorded it: named by section, nothing written.
  writeMoveRegistry(r.dir, r.agent, { mode: "on-demand" })
  const edited = readFileSync(r.file, "utf8")
  await registerMoves(hubOf(r))
  expect(readFileSync(r.file, "utf8")).toBe(edited)
  expect(await r.s.reread(r.move)).toMatchObject({ stage: "activated", block: { code: "registry_profile_changed", by: "hub", detail: { sections: ["agent.mode"] } } })

  // Restored: the hub's block clears, the key is written and the receipt is recorded.
  writeFileSync(r.file, before)
  await registerMoves(hubOf(r))
  const done = await r.s.reread(r.move)
  expect(done).toMatchObject({ stage: "registry_written", block: null })
  expect(agentRunner(r.file, r.agent)).toBe(DST.runner)
  expect(done.registry_receipt!.digest).toBe(registryDigest(r.file))
  // Looked at again, a move whose receipt stands asks nothing and writes nothing.
  const again = readFileSync(r.file, "utf8")
  await registerMoves(hubOf(r))
  expect(readFileSync(r.file, "utf8")).toBe(again)
  expect((await r.s.reread(r.move)).updated_at.getTime()).toBe(done.updated_at.getTime())
})

test("RT-3c: a registry restored to the receipt's EXACT bytes clears the hub's own binding block (the way out the module names), a wrong profile does not, and another party's block is never touched", async () => {
  const r = await rig()
  await toActivated(r)
  await registerMoves(hubOf(r))
  const written = await r.s.reread(r.move)
  expect(written.stage).toBe("registry_written")
  const exact = readFileSync(r.file, "utf8")
  expect(registryDigest(r.file)).toBe(written.registry_receipt!.digest)

  // A bad edit: the agent's profile is no longer the recorded one, and the hub says so.
  writeMoveRegistry(r.dir, r.agent, { runner: DST.runner, mode: "on-demand" })
  await registerMoves(hubOf(r))
  expect(await r.s.reread(r.move)).toMatchObject({ stage: "registry_written", block: { code: "registry_binding_changed", by: "hub" } })
  await registerMoves(hubOf(r))
  expect((await r.s.reread(r.move)).block, "the profile is still wrong: the block stands").toMatchObject({ code: "registry_binding_changed" })

  // Reverted to the receipt's exact bytes: the binding checks out again, the block goes, and the receipt is the one it was.
  writeFileSync(r.file, exact)
  expect(registryDigest(r.file)).toBe(written.registry_receipt!.digest)
  await registerMoves(hubOf(r))
  const cleared = await r.s.reread(r.move)
  expect(cleared.block).toBeNull()
  expect(cleared.registry_receipt).toEqual(written.registry_receipt)
  expect(cleared.stage, "clearing is not readiness").toBe("registry_written")
  expect(await openGates(r)).toEqual([gateOf(r)])

  // On the same exact bytes another party's block is left where it is.
  expect(await blockMove(r.dst.w.store, r.move.id, who(r.dst.w), "serve_profile_mismatch", { sections: ["agent.mode"] })).toBe("blocked")
  await registerMoves(hubOf(r))
  expect(await r.s.reread(r.move)).toMatchObject({ block: { code: "serve_profile_mismatch", by: "dest" } })
})

test("RT-3b: only the hub of the store machine writes, and a destination that is not a running runner of its machine is refused by name", async () => {
  const r = await rig()
  await toActivated(r)
  // A hub of another machine than the registry's store machine does nothing: the one authoritative file is the store machine's.
  const spoke = writeRegistry(r.dir, {
    hub: { state_dir: r.dir, store_url: "postgres://127.0.0.1:1/unused", store_machine: "pi" },
    machines: [{ id: "pi", os: "linux" }, { id: "mac", os: "macos" }],
    presets: { daily: { adapter: "a-scripted-adapter", model: "m", provider: "p", effort: "medium", paid: "key" } },
    agents: [{ id: r.agent, person: "p1", preset: "daily", chat: "1000000001", door: "door-fake", runner: SRC.runner }],
    people: [{ id: "p1", tree: join(r.dir, "p1") }],
    run: [
      { id: "door-fake", kind: "door", machine: "pi", platform: "fake", person: "p1", token_file: "/dev/null", schedule: "always", memory_limit_mb: 192 },
      { id: SRC.runner, kind: "runner", machine: "pi", schedule: "always", memory_limit_mb: 512, child_memory_limit_mb: 512 },
      { id: DST.runner, kind: "runner", machine: "mac", schedule: "always", memory_limit_mb: 512, child_memory_limit_mb: 512, enabled: false },
    ],
  })
  const bytes = readFileSync(spoke, "utf8")
  await registerMoves({ ...hubOf(r, "mac"), registryFile: spoke, load: () => loadRegistry(spoke) })
  expect(readFileSync(spoke, "utf8"), "a hub of another machine writes nothing").toBe(bytes)
  // The store machine's hub finds the destination runner switched off and says so, writing nothing.
  await registerMoves({ ...hubOf(r, "pi"), registryFile: spoke, load: () => loadRegistry(spoke) })
  expect(readFileSync(spoke, "utf8")).toBe(bytes)
  expect(await r.s.reread(r.move)).toMatchObject({ stage: "activated", block: { code: "registry_runner_unusable", by: "hub" } })
})

// ---------------------------------------------------------------------------------------------------------------------
// the relocation note
// ---------------------------------------------------------------------------------------------------------------------

async function toActive(r: Rig): Promise<MoveRow> {
  await toActivated(r)
  await registerMoves(hubOf(r))
  expect(await serveDestination(serveOf(r), r.move.id)).toMatchObject({ state: "done", reason: "active" })
  return await r.s.reread(r.move)
}

test("RT-4: the note is composed from the move alone, hashes to the digest serve declared, names the old and the new directory and the same session, and is a refusal when it would not hash to it", async () => {
  const r = await rig()
  const active = await toActive(r)
  const body = relocationNote(active)
  expect(body).toBe(relocationNote(await readMove(r.s.tool, r.move.id) as MoveRow))
  expect(sha(body), "what the store holds is the digest of exactly these words").toBe(active.note_digest!)
  expect(body).toContain(`machine ${SRC.machine}`)
  expect(body).toContain(`machine ${DST.machine}`)
  expect(body).toContain(active.native_session)
  expect(body, "the directory the transcript names and the one the destination placed it at").toContain((active.manifest!.native_export as { from: { cwd: string } }).from.cwd)
  expect(body).toContain((active.dest_facts!.native as { cwd: string }).cwd)
  expect(body, "wire text that is not an instruction").toContain("This is not a request")
  expect(body, "it says what was NOT carried").toContain("The hub did not carry, sync or verify anything else of the old machine")
  expect(body, "and promises nothing of a sync, a schedule or an arrival").not.toMatch(/reach this machine|own sync|own schedule|may not have arrived/)

  const owed = await pendingNotesOf(r.s.tool, r.agent)
  expect(owed).toEqual([{ move: r.move.id, digest: active.note_digest!, conversation: r.move.conversation_id, attempt: null }])
  const carried = await notesOwedTo(r.s.tool, r.agent, r.move.conversation_id)
  expect(carried).toEqual([{ move: r.move.id, digest: active.note_digest!, body }])
  expect(noteBlock(carried)).toBe(body)
  expect(await notesOwedTo(r.s.tool, r.agent, "another-conversation"), "a conversation the notes are not owed to carries none").toEqual([])

  // A body that would not hash to the declared digest is never fed as the move's explanation. The digest of a served move is sealed for good
  // (`hub_guard_topic_move`), so it is not edited: a SECOND move is served through the store's own routine, with the evidence the destination
  // would send (all of it the move's own record), declaring the digest of words this composer did not write (a note an earlier build declared).
  const other = await rig()
  await toActivated(other)
  await registerMoves(hubOf(other))
  const written = await other.s.reread(other.move)
  expect(written.stage).toBe("registry_written")
  const foreign = sha("the words another build composed for this move")
  expect(foreign).not.toBe(noteDigestOf(written))
  expect(await serveMove(other.dst.w.store, other.move.id, who(other.dst.w), {
    agent: written.agent, runner: written.dest_runner, machine: written.dest_machine, placement_generation: written.dest_generation!,
    digest: String(written.registry_receipt!.digest), profile: written.dest_facts!.profile as Record<string, unknown>,
    capabilities: written.dest_facts!.capabilities as Record<string, unknown>, imported: { generation: written.import_generation, manifest_digest: written.manifest!.digest },
  }, { digest: foreign }, moveNotice(written, "en"))).toBe("active")
  const served = await other.s.reread(other.move)
  expect(served).toMatchObject({ stage: "active", note_state: "pending", note_digest: foreign })
  const refused = await notesOwedTo(other.s.tool, other.agent, other.move.conversation_id).catch(error => error)
  expect(refused).toBeInstanceOf(MoveNoteRefused)
  expect(refused).toMatchObject({ move: other.move.id, answer: "digest-mismatch" })
  expect(await pendingNotesOf(other.s.tool, other.agent), "nothing was delivered, so the note stays owed").toMatchObject([{ move: other.move.id, digest: foreign }])
  await expect((async () => { await other.s.su`update topic_move set note_digest = ${sha("some other words")} where id = ${other.move.id}` })(), "the seal stands: a served move's digest is never edited").rejects.toThrow("keeps its sealed manifest")
})

test("RT-5: the note rides the feed's own journal and is acknowledged by the STORE, only for an attempt that was received, for exactly the bodies it carried, and once", async () => {
  const r = await rig()
  const active = await toActive(r)
  const carried = await notesOwedTo(r.s.tool, r.agent, r.move.conversation_id)
  const on = { ...r.s.dst(), machine: DST.machine }
  const { execution } = await r.s.attempt(r.t, "q-after-move", on)
  // Opening an attempt and the feed intent deliver nothing; the intent journals which attempt carries which notes.
  await markFeedIntent(r.s.tool, execution, "the first real input", "input", undefined, carried.map(({ move, digest }) => ({ move, digest })))
  expect((await pendingNotesOf(r.s.tool, r.agent)).map(one => one.attempt)).toEqual([execution.id])
  expect(await noteDelivered(r.s.tool, { execution: execution.id, notes: carried.map(({ move, body }) => ({ move, body })) }), "a send is not a delivery").toBe("not-received")
  expect(await pendingNotesOf(r.s.tool, r.agent)).toHaveLength(1)

  await markProgress(r.s.tool, execution.id, "received")
  expect(await noteDelivered(r.s.tool, { execution: execution.id, notes: [{ move: r.move.id, body: "other words" }] }), "no other text is written down as the move's explanation").toBe("digest-mismatch")
  expect(await noteDelivered(r.s.tool, { execution: execution.id, notes: carried.map(({ move, body }) => ({ move, body })) })).toBe("delivered")
  expect(await pendingNotesOf(r.s.tool, r.agent)).toEqual([])
  expect((await r.s.reread(r.move)).note_state).toBe("delivered")
  const entries = (await r.s.su`select kind, body from conversation_entry where conversation_id = ${r.move.conversation_id} and source_id = ${`move-note:${r.move.id}`}`) as unknown as { kind: string; body: string }[]
  expect(entries.map(one => one.kind)).toEqual(["recovery"])
  expect(entries[0].body).toBe(carried[0].body)
  expect(await noteDelivered(r.s.tool, { execution: execution.id, notes: carried.map(({ move, body }) => ({ move, body })) }), "idempotent").toBe("replay")
  expect(active.note_state).toBe("pending")
})

test("RT-6: the import of a move records what a resumed turn is checked against, and a conversation the engine never started has nothing to check", async () => {
  const r = await rig()
  const active = await toActive(r)
  const imported = await importedBy(r.s.tool, active)
  expect(imported).toMatchObject({
    native_manifest_digest: (active.manifest!.native as { native_manifest_digest: string }).native_manifest_digest,
    to: { cwd: (active.dest_facts!.native as { cwd: string }).cwd },
    transcript: { sha256: active.manifest!.files[0].sha256, size: active.manifest!.files[0].size },
    reused: false,
  })
  expect(imported!.receipt.operation).toBe((await r.s.su`select staging_id from move_copy where move_id = ${r.move.id} and kind = 'dest_import'`)[0].staging_id)

  const fresh = await rig()
  await fresh.s.su`update conversation set native_state = 'new' where id = ${fresh.move.conversation_id}`
  const row = await toActive(fresh)
  expect(row.snapshot!.native_state).toBe("new")
  expect(await importedBy(fresh.s.tool, row)).toBeNull()
  expect(fresh.fake.log.exports, "no transcript is read for a conversation the engine never started").toBe(0)
  expect(relocationNote(row)).toContain("had not started this conversation")
})

// ---------------------------------------------------------------------------------------------------------------------
// what the move does not carry, and a profile that is not the source's
// ---------------------------------------------------------------------------------------------------------------------

test("RT-7: a repository the move does not carry is refused BEFORE anything is read, stored or released, by name; the refusal clears when the dependency is gone", async () => {
  const dir = scratch()
  const repository: RepositorySpec = { id: "work", person: "p1", path: join(dir, "work"), remote: "origin", branch: "main" }
  const r = await rig({ registry: { repositories: [repository] } })
  expect(await prepareDestination(r.dst.w, r.move.id)).toMatchObject({ state: "done" })
  await drainOnly(r.s, r.move)

  expect(scopeOf(loadRegistry(r.file), await r.s.reread(r.move))).toMatchObject({ refused: "workspace_carriage_required", detail: { repositories: ["work"], count: 1 } })
  expect(await exportSource(r.src.w, PROVEN, r.move.id)).toMatchObject({ state: "blocked", reason: "scope_unsupported", detail: { reason: "workspace_carriage_required", repositories: ["work"] } })
  expect(r.fake.log.exports, "nothing was read").toBe(0)
  expect(await r.s.count("move_blob where move_id = $1", r.move.id), "nothing was stored").toBe(0)
  expect(await r.s.reread(r.move)).toMatchObject({ stage: "waiting", manifest: null, block: { code: "scope_unsupported", by: "source" } })

  // The dependency is gone from the registry: the source's own block clears and it releases.
  writeMoveRegistry(r.dir, r.agent)
  expect(await exportSource(r.src.w, PROVEN, r.move.id)).toMatchObject({ state: "done", reason: "released" })
  expect(await r.s.reread(r.move)).toMatchObject({ stage: "source_released", block: null, manifest: { scope: { carries: "native-only" } } })
  expect((await r.s.reread(r.move)).manifest!.scope).toMatchObject({ basis: expect.stringContaining("shared-zone checkout") })
})

test("RT-8: a destination profile that is not the source's is refused by section, never by value, before anything is read; and a source with no profile is its own named block", async () => {
  const r = await rig()
  expect(await prepareDestination(r.dst.w, r.move.id)).toMatchObject({ state: "done" })
  await drainOnly(r.s, r.move)
  const real = r.src.w.sourceProfile!
  r.src.w.sourceProfile = row => ({ ...real(row)!, agent: { ...(real(row)!.agent as object), tools: ["Bash"] } })
  expect(await exportSource(r.src.w, PROVEN, r.move.id)).toMatchObject({ state: "blocked", reason: "profile_mismatch", detail: { sections: ["agent.tools"] } })
  expect(r.fake.log.exports).toBe(0)
  expect(await r.s.count("move_blob where move_id = $1", r.move.id)).toBe(0)
  r.src.w.sourceProfile = () => null
  expect(await exportSource(r.src.w, PROVEN, r.move.id)).toMatchObject({ state: "blocked", reason: "source_profile_unbound" })

  r.src.w.sourceProfile = real
  expect(await exportSource(r.src.w, PROVEN, r.move.id)).toMatchObject({ state: "done", reason: "released" })
  expect((await r.s.reread(r.move)).block).toBeNull()
  expect(profileDifference({ version: 1, agent: { a: 1 }, preset: { b: 2 } }, { version: 1, agent: { a: 1, c: 3 }, preset: { b: 2 } })).toEqual(["agent.c"])
  expect(profileDifference({ version: 1 }, { version: 2 })).toEqual(["version"])
})

test("RT-7b: a vault or a shared zone is a dependency nothing here proves: refused by name BEFORE anything is read, stored or released, nothing acknowledges it, and a person that declares none is not held", async () => {
  const r = await rig()
  expect(await prepareDestination(r.dst.w, r.move.id)).toMatchObject({ state: "done" })
  await drainOnly(r.s, r.move)
  const vault = join(r.dir, "p1", "keep")

  // A vault: the hub's git sync is the only thing that would bring what the agent filed there, and nothing here awaits it, bounds it or reads it back.
  writeMoveRegistry(r.dir, r.agent, { person: { vault } })
  expect(scopeOf(loadRegistry(r.file), await r.s.reread(r.move))).toEqual({ refused: "dependency_unverified", detail: { dependencies: ["vault"] } })
  expect(await exportSource(r.src.w, PROVEN, r.move.id)).toMatchObject({ state: "blocked", reason: "scope_unsupported", detail: { reason: "dependency_unverified", dependencies: ["vault"] } })
  // Nothing clears it but the registry: the destination looking again, and the source looking again, change nothing.
  expect(await prepareDestination(r.dst.w, r.move.id)).toMatchObject({ state: "done" })
  expect(await exportSource(r.src.w, PROVEN, r.move.id)).toMatchObject({ state: "blocked", reason: "scope_unsupported", detail: { dependencies: ["vault"] } })
  expect(r.fake.log.exports, "nothing was read").toBe(0)
  expect(await r.s.count("move_blob where move_id = $1", r.move.id), "nothing was stored").toBe(0)
  expect(await r.s.reread(r.move)).toMatchObject({ stage: "waiting", manifest: null, block: { code: "scope_unsupported", by: "source" } })

  // A zone checkout (always inside a vault) is named beside it.
  const zoned = {
    person: { vault }, zone: { mount: "zone", remote: "origin", url: "file:///srv/zone.git" },
    repositories: [{ id: "zone", person: "p1", path: join(vault, "vault", "zone"), remote: "origin", branch: "main", zone: true }],
  }
  writeMoveRegistry(r.dir, r.agent, zoned)
  expect(scopeOf(loadRegistry(r.file), await r.s.reread(r.move))).toEqual({ refused: "dependency_unverified", detail: { dependencies: ["vault", "zone"] } })
  expect(await exportSource(r.src.w, PROVEN, r.move.id)).toMatchObject({ state: "blocked", reason: "scope_unsupported", detail: { dependencies: ["vault", "zone"] } })
  // A repository beside them is the workspace refusal, and names the synced dependencies too.
  writeMoveRegistry(r.dir, r.agent, { ...zoned, repositories: [...zoned.repositories, { id: "work", person: "p1", path: join(r.dir, "work"), remote: "origin", branch: "main" }] })
  expect(scopeOf(loadRegistry(r.file), await r.s.reread(r.move))).toMatchObject({ refused: "workspace_carriage_required", detail: { repositories: ["work"], count: 1, dependencies: ["vault", "zone"] } })
  expect(r.fake.log.exports).toBe(0)

  // The registry no longer declares any of them: the source's own block clears and it releases, with a proof that says only what is known.
  writeMoveRegistry(r.dir, r.agent)
  expect(await exportSource(r.src.w, PROVEN, r.move.id)).toMatchObject({ state: "done", reason: "released" })
  expect(await r.s.reread(r.move)).toMatchObject({
    stage: "source_released", block: null, manifest: { scope: { carries: "native-only", basis: expect.stringContaining("no repository, vault or shared-zone checkout") } },
  })
})

/** The proof a scope answer is, or a failure that prints the refusal it was instead. */
const proofOf = (answer: ReturnType<typeof scopeOf>): ScopeProof => {
  if (answer === null || !("basis" in answer)) throw new Error(`no proof: ${JSON.stringify(answer)}`)
  return answer
}
/** A look that answers from a table: an absent path for everything it was not told about. */
const looking = (table: Record<string, Look>): ScopeFs => ({ look: path => table[path] ?? { kind: "absent" } })
const directory = (names: string[], more = false): Look => ({ kind: "directory", names, more })

test("RT-7c: the person's tree is LOOKED AT, not assumed from a registry that declares nothing: absent, empty or only the hub's own directories passes (shown on a real tree); any other entry is local content refused by count, never by name", async () => {
  const r = await rig()
  expect(await prepareDestination(r.dst.w, r.move.id)).toMatchObject({ state: "done" })
  await drainOnly(r.s, r.move)
  const tree = join(r.dir, "p1") // the person's tree, which this registry also makes the person's state root
  const scope = async () => scopeOf(loadRegistry(r.file), await r.s.reread(r.move))

  const absent = proofOf(await scope())
  expect(absent.basis).toContain("the person's tree is absent")
  expect(absent.basis.length, "the sealed basis is bounded").toBeLessThanOrEqual(256)
  mkdirSync(tree)
  expect(proofOf(await scope()).basis).toContain("the person's tree is empty")
  mkdirSync(join(tree, "sessions"))
  mkdirSync(join(tree, "chatlog"))
  const hubOnly = proofOf(await scope())
  expect(hubOnly.basis).toContain("holds only the hub's own session and chat-log directories")
  expect(hubOnly.basis.length).toBeLessThanOrEqual(256)

  // A file nobody declared and nothing carries: refused by count, before anything is read, stored or released.
  writeFileSync(join(tree, "notes-from-the-agent.md"), "words that exist on this machine only")
  const refusal = await scope()
  expect(refusal).toEqual({ refused: "workspace_carriage_required", detail: { local_tree: { entries: 1 } } })
  expect(JSON.stringify(refusal), "no name and no content").not.toMatch(/notes-from-the-agent|words that exist/)
  expect(await exportSource(r.src.w, PROVEN, r.move.id)).toMatchObject({ state: "blocked", reason: "scope_unsupported", detail: { reason: "workspace_carriage_required", local_tree: { entries: 1 } } })
  expect(r.fake.log.exports, "nothing was read").toBe(0)
  expect(await r.s.count("move_blob where move_id = $1", r.move.id), "nothing was stored").toBe(0)
  expect(await r.s.reread(r.move)).toMatchObject({ stage: "waiting", manifest: null, block: { code: "scope_unsupported", by: "source" } })

  // `inbox` holds attachments a message can refer to: the hub's own directories skipped are `sessions` and `chatlog` and no others.
  rmSync(join(tree, "notes-from-the-agent.md"))
  mkdirSync(join(tree, "inbox"))
  expect(await scope()).toEqual({ refused: "workspace_carriage_required", detail: { local_tree: { entries: 1 } } })
  rmSync(join(tree, "inbox"), { recursive: true })

  // Back to what is demonstrably the hub's alone: the source's own block clears and it releases, and the sealed basis says what was looked at.
  expect(await exportSource(r.src.w, PROVEN, r.move.id)).toMatchObject({ state: "done", reason: "released" })
  expect(await r.s.reread(r.move)).toMatchObject({ stage: "source_released", block: null, manifest: { scope: { carries: "native-only", basis: hubOnly.basis } } })
})

test("RT-7d: a tree that cannot be looked at, or whose listing was cut, is never a proof; the hub's directories are skipped only where the tree IS the state root", async () => {
  const r = await rig()
  await drainOnly(r.s, r.move)
  const row = await r.s.reread(r.move)
  const tree = join(r.dir, "p1")
  const unverified = { refused: "dependency_unverified", detail: { dependencies: ["tree"] } }

  expect(scopeOf(loadRegistry(r.file), row, looking({ [tree]: { kind: "unreadable" } })), "a tree the look failed on").toEqual(unverified)
  expect(scopeOf(loadRegistry(r.file), row, looking({ [tree]: { kind: "file" } })), "a tree that is not a directory").toEqual(unverified)
  expect(scopeOf(loadRegistry(r.file), row, looking({ [tree]: directory(["sessions"], true) })), "the rest of a cut listing is not known to be the hub's").toEqual({
    refused: "workspace_carriage_required", detail: { local_tree: { entries: 0, capped: true } },
  })
  r.src.w.scope = move => scopeOf(loadRegistry(r.file), move, looking({ [tree]: { kind: "unreadable" } }))
  expect(await exportSource(r.src.w, PROVEN, r.move.id)).toMatchObject({ state: "blocked", reason: "scope_unsupported", detail: { reason: "dependency_unverified", dependencies: ["tree"] } })
  expect(r.fake.log.exports, "nothing was read").toBe(0)
  expect(await r.s.count("move_blob where move_id = $1", r.move.id)).toBe(0)

  // A tree that is not the state root: `sessions` there is the person's own directory, not the hub's.
  const elsewhere = join(r.dir, "elsewhere")
  writeMoveRegistry(r.dir, r.agent, { person: { tree: elsewhere } })
  expect(scopeOf(loadRegistry(r.file), row, looking({ [elsewhere]: directory(["sessions", "chatlog"]) }))).toEqual({
    refused: "workspace_carriage_required", detail: { local_tree: { entries: 2 } },
  })
  expect(proofOf(scopeOf(loadRegistry(r.file), row, looking({}))).basis, "and an absent one is a proof").toContain("the person's tree is absent")
})

test("RT-7e: the default instruction files the launch would read are a named gate on the source: found by name, never read or exported, and not asked about for a person that lists its own or for the triage master", async () => {
  const r = await rig()
  expect(await prepareDestination(r.dst.w, r.move.id)).toMatchObject({ state: "done" })
  await drainOnly(r.s, r.move)
  const tree = join(r.dir, "p1")
  const secret = "sk-test-secret-0123456789"
  mkdirSync(tree)
  const scope = async () => scopeOf(loadRegistry(r.file), await r.s.reread(r.move))

  writeFileSync(join(tree, "CLAUDE.md"), `standing rules ${secret}`)
  expect(await scope()).toEqual({ refused: "dependency_unverified", detail: { dependencies: ["instruction:CLAUDE.md"] } })
  writeFileSync(join(tree, "CLAUDE.local.md"), "private rules")
  const both = await scope()
  expect(both).toEqual({ refused: "dependency_unverified", detail: { dependencies: ["instruction:CLAUDE.md", "instruction:CLAUDE.local.md"] } })
  expect(JSON.stringify(both), "names only: never a content or a path").not.toMatch(/sk-test|private rules|standing rules|\//)
  expect(await exportSource(r.src.w, PROVEN, r.move.id)).toMatchObject({
    state: "blocked", reason: "scope_unsupported", detail: { reason: "dependency_unverified", dependencies: ["instruction:CLAUDE.md", "instruction:CLAUDE.local.md"] },
  })
  expect(r.fake.log.exports, "nothing was read").toBe(0)
  expect(await r.s.count("move_blob where move_id = $1", r.move.id), "nothing was stored").toBe(0)
  expect(await r.s.reread(r.move)).toMatchObject({ stage: "waiting", manifest: null, block: { code: "scope_unsupported", by: "source" } })

  // What counts as there is what `existsSync` counts: anything at the path, a directory or a file the look failed on included.
  const registry = loadRegistry(r.file)
  const at = join(tree, "CLAUDE.md")
  expect(defaultInstructionsOf(registry, r.agent, looking({ [at]: { kind: "file" } }))).toEqual(["CLAUDE.md"])
  expect(defaultInstructionsOf(registry, r.agent, looking({ [at]: directory([]) }))).toEqual(["CLAUDE.md"])
  expect(defaultInstructionsOf(registry, r.agent, looking({ [at]: { kind: "unreadable" } }))).toEqual(["CLAUDE.md"])
  expect(defaultInstructionsOf(registry, r.agent, looking({}))).toEqual([])
  expect(defaultInstructionsOf(registry, "nobody", looking({ [at]: { kind: "file" } })), "an agent the file does not name cannot be told").toBeNull()

  // A person that lists its own files is not asked about the default ones (the profile holds that list, and refuses it): they are then ordinary
  // entries of the tree, counted and refused as such. Nor is the triage master, which launches with no instruction file at all.
  const rules = join(r.dir, "rules.md")
  writeFileSync(rules, "listed")
  writeMoveRegistry(r.dir, r.agent, { person: { instructions: [rules] } })
  expect(defaultInstructionsOf(loadRegistry(r.file), r.agent, looking({ [at]: { kind: "file" } }))).toEqual([])
  expect(await scope()).toEqual({ refused: "workspace_carriage_required", detail: { local_tree: { entries: 2 } } })
  writeMoveRegistry(r.dir, r.agent, { agent: { role: "triage" } })
  expect(defaultInstructionsOf(loadRegistry(r.file), r.agent, looking({ [at]: { kind: "file" } }))).toEqual([])

  // Gone from the tree: the source's own block clears and it releases, with a proof that says what was looked at.
  writeMoveRegistry(r.dir, r.agent)
  rmSync(join(tree, "CLAUDE.md"))
  rmSync(join(tree, "CLAUDE.local.md"))
  expect(await exportSource(r.src.w, PROVEN, r.move.id)).toMatchObject({ state: "done", reason: "released" })
  expect(await r.s.reread(r.move)).toMatchObject({ stage: "source_released", block: null, manifest: { scope: { basis: expect.stringContaining("no default instruction file exists") } } })
})

test("RT-7f: the destination does not record a preflight while a default instruction file would be read there (by name, never a path or content), cannot-tell is the same refusal, and the block clears when the file is gone", async () => {
  const r = await rig()
  const tree = join(r.dir, "p1")
  mkdirSync(tree)
  writeFileSync(join(tree, "CLAUDE.local.md"), "rules that exist on this machine only")
  r.dst.w.localInstructions = row => defaultInstructionsOf(loadRegistry(r.file), row.agent)
  expect(await prepareDestination(r.dst.w, r.move.id)).toMatchObject({ state: "blocked", reason: "dest_local_unverified", detail: { references: ["instruction:CLAUDE.local.md"] } })
  expect(await r.s.reread(r.move)).toMatchObject({ dest_ready_at: null, dest_facts: null, block: { code: "dest_local_unverified", by: "dest" } })

  rmSync(join(tree, "CLAUDE.local.md"))
  expect(await prepareDestination(r.dst.w, r.move.id)).toMatchObject({ state: "done", reason: "ready" })
  expect((await r.s.reread(r.move)).block).toBeNull()
  await drainOnly(r.s, r.move)
  expect(await exportSource(r.src.w, PROVEN, r.move.id)).toMatchObject({ state: "done", reason: "released" })

  const unsure = await rig()
  unsure.dst.w.localInstructions = () => null
  expect(await prepareDestination(unsure.dst.w, unsure.move.id)).toMatchObject({ state: "blocked", reason: "dest_local_unverified", detail: { references: ["instructions"] } })
  expect(await unsure.s.reread(unsure.move)).toMatchObject({ dest_ready_at: null, dest_facts: null })
})

test("RT-8b: configuration the launch reads is named and held on both sides, never compared, read or leaked; an agent whose launch reads none is not held", async () => {
  const r = await rig()
  const secret = "sk-test-secret-0123456789"
  const files = { settings: join(r.dir, "agent-settings.json"), fragment: join(r.dir, "fragment.md"), mcp: join(r.dir, "person-mcp.json"), rules: join(r.dir, "rules.md") }
  writeFileSync(files.settings, JSON.stringify({ env: { KEY: secret } }))
  writeFileSync(files.mcp, JSON.stringify({ mcpServers: { x: { env: { TOKEN: secret } } } }))
  const references = ["agent.fragment", "agent.settings", "person.instructions", "person.mcp"]
  const held = { agent: { settings: files.settings, fragment: files.fragment }, person: { mcp: files.mcp, instructions: [files.rules] } }

  writeMoveRegistry(r.dir, r.agent, held)
  const profile = profileOf(loadRegistry(r.file), r.agent)!
  expect(profile.unverified).toEqual(references)
  expect(JSON.stringify(profile), "references by owner and kind: never a content").not.toContain(secret)

  // The destination does not record a preflight over a profile whose configuration nothing compares.
  expect(await prepareDestination(r.dst.w, r.move.id)).toMatchObject({ state: "blocked", reason: "dest_profile_unverified", detail: { references } })
  expect(await r.s.reread(r.move)).toMatchObject({ dest_ready_at: null, dest_facts: null, block: { code: "dest_profile_unverified", by: "dest" } })

  // The registry no longer points the agent at any: the destination clears its own block and records the preflight.
  writeMoveRegistry(r.dir, r.agent)
  expect(await prepareDestination(r.dst.w, r.move.id)).toMatchObject({ state: "done", reason: "ready" })
  expect((await r.s.reread(r.move)).block).toBeNull()
  await drainOnly(r.s, r.move)

  // The source's registry says it again: named before anything is read, stored or released, ahead of any comparison of the two profiles.
  writeMoveRegistry(r.dir, r.agent, held)
  expect(await exportSource(r.src.w, PROVEN, r.move.id)).toMatchObject({ state: "blocked", reason: "profile_unverified", detail: { references } })
  expect(r.fake.log.exports).toBe(0)
  expect(await r.s.count("move_blob where move_id = $1", r.move.id)).toBe(0)
  expect(await r.s.reread(r.move)).toMatchObject({ stage: "waiting", manifest: null, block: { code: "profile_unverified", by: "source" } })
  writeMoveRegistry(r.dir, r.agent)
  expect(await exportSource(r.src.w, PROVEN, r.move.id)).toMatchObject({ state: "done", reason: "released" })
  expect((await r.s.reread(r.move)).block).toBeNull()

  // What a launch reads, and what it does not: the agent's own settings and MCP file replace its person's, and the triage master reads none.
  const registryOf = (agent: Record<string, unknown>, person: Record<string, unknown>) =>
    new Registry("scratch.toml", {}, [], {}, [{ id: "a", person: "p1", preset: "daily", runner: "r", ...agent }] as never, [], [], [{ id: "p1", tree: "/t", ...person }] as never)
  expect(configReferences(registryOf({}, {}), "a"), "an agent and a person naming nothing").toEqual([])
  expect(configReferences(registryOf({ settings: "/a/s", mcp: "/a/m" }, { settings: "/p/s", mcp: "/p/m" }), "a")).toEqual(["agent.mcp", "agent.settings"])
  expect(configReferences(registryOf({}, { settings: "/p/s", mcp: "/p/m", instructions: ["/p/i"] }), "a")).toEqual(["person.instructions", "person.mcp", "person.settings"])
  expect(configReferences(registryOf({ role: "triage", settings: "/a/s", fragment: "/a/f" }, { mcp: "/p/m", instructions: ["/p/i"] }), "a"), "the triage master reads none").toEqual([])
  expect(configReferences(registryOf({}, {}), "nobody")).toEqual([])
})

test("RT-9: an offline destination is waited for with no block and nothing read, whatever the engine's state; a native UUID the store sealed is the one the destination imports", async () => {
  const r = await rig()
  await r.s.su`update conversation set native_state = 'launched' where id = ${r.move.conversation_id}`
  await drainOnly(r.s, r.move)
  expect(await exportSource(r.src.w, PROVEN, r.move.id), "no preflight yet: the move waits, and no gate of the engine's state is raised against it").toMatchObject({ state: "waiting", reason: "dest-not-ready" })
  expect((await r.s.reread(r.move)).block).toBeNull()
  expect(r.fake.log.exports).toBe(0)

  // The engine acknowledges the session; the preflight is recorded, and the same drain (already complete) is exported, imported and served.
  await r.s.su`update conversation set native_state = 'started' where id = ${r.move.conversation_id}`
  const native = await r.s.nativeOf(r.move)
  expect(await prepareDestination(r.dst.w, r.move.id)).toMatchObject({ state: "done", reason: "ready" })
  expect(await exportSource(r.src.w, PROVEN, r.move.id)).toMatchObject({ state: "done", reason: "released" })
  expect(await importDestination(r.dst.w, r.move.id)).toMatchObject({ state: "done", reason: "activated" })
  await registerMoves(hubOf(r))
  expect(await serveDestination(serveOf(r), r.move.id)).toMatchObject({ state: "done", reason: "active" })
  const sealed = await r.s.reread(r.move)
  expect(sealed.manifest!.native).toMatchObject({ native_session: native })
  expect((sealed.manifest!.native_export as { native_session: string }).native_session).toBe(native)
  expect(await r.s.nativeOf(r.move), "the conversation keeps the session id it had").toBe(native)
  expect(r.fake.log.imports.map(one => one.operation)).toHaveLength(1)
})

// ---------------------------------------------------------------------------------------------------------------------
// the watch: the destination's moves and the copies a runner owes a removal of
// ---------------------------------------------------------------------------------------------------------------------

const crashAfter = (step: string) => (kind: string, detail: Record<string, unknown>) => kind === "move.import-step" && detail.step === step
const WAITING: DrainStep = { state: "waiting", why: "test", owed: null, seen: null }

test("RT-10: the watch looks at a move of which this runner is the DESTINATION without placing a fence, and removes a withdrawn move's copy from the store's list of copies owed a cleanup", async () => {
  const r = await rig()
  expect(await prepareDestination(r.dst.w, r.move.id)).toMatchObject({ state: "done" })
  await drainOnly(r.s, r.move)
  expect(await exportSource(r.src.w, PROVEN, r.move.id)).toMatchObject({ state: "done", reason: "released" })
  r.dst.knobs.crashOn = crashAfter("promoted")
  await expect(importDestination(r.dst.w, r.move.id)).rejects.toBeInstanceOf(Crash)
  r.dst.knobs.crashOn = null
  const copy = (await r.s.su`select state from move_copy where move_id = ${r.move.id} and kind = 'dest_import'`)[0]
  expect(copy.state).toBe("promoted")

  const fences = createFences()
  const looked: string[] = []
  const driven: string[] = []
  const watch = await watchMoves(r.s.tool, {
    runner: DST.runner, machine: DST.machine, fences,
    drive: async request => { driven.push(request.id); return WAITING },
    driveDest: async request => { looked.push(request.id); return WAITING },
    cleanup: () => cleanupCopies(r.dst.w),
    lifted: () => {}, say: async () => {}, report: () => {},
  })
  watches.push(watch)
  await until("the destination's move was looked at", () => looked.includes(r.move.id), 10_000)
  expect(fences.all(), "a destination places no fence").toEqual([])
  expect(driven, "and the source's consumer is not asked about it").toEqual([])

  // The owner withdraws: the move leaves the open list, and only the store's list of copies owed a cleanup finds the copy.
  expect(await withdrawMove(r.s.tool, r.move.id, OWNER)).toBe("withdrawn")
  await until("the copy was removed and reported", async () => (await r.s.su`select state from move_copy where move_id = ${r.move.id} and kind = 'dest_import'`)[0].state === "removed", 15_000)
  expect(r.fake.log.discards, "discarded by the receipt of the stage, once").toHaveLength(1)
  expect(r.locks.events.filter(one => one === `enter:${r.move.conversation_id}`).length, "under the conversation's lock").toBeGreaterThanOrEqual(2)
})

test("RT-10b: a process that is no longer the runner's current incarnation stages nothing and removes nothing; the current one does, and reports the copies it left owed", async () => {
  const r = await rig()
  expect(await prepareDestination(r.dst.w, r.move.id)).toMatchObject({ state: "done" })
  await drainOnly(r.s, r.move)
  expect(await exportSource(r.src.w, PROVEN, r.move.id)).toMatchObject({ state: "done", reason: "released" })

  // A replaced process (not the store's current incarnation for the runner) is asked to import: it writes nothing.
  const old = handoffWorld(r.s, "dest", { port: r.fake.port, locks: r.locks, incarnation: "dst-old" })
  old.w.profile = r.dst.w.profile
  const refused = await importDestination(old.w, r.move.id)
  expect(refused.state, "the store refuses the begin: nothing was staged").not.toBe("done")
  expect(r.fake.log.writes).toBe(0)

  r.dst.knobs.crashOn = crashAfter("promoted")
  await expect(importDestination(r.dst.w, r.move.id)).rejects.toBeInstanceOf(Crash)
  r.dst.knobs.crashOn = null
  expect(await withdrawMove(r.s.tool, r.move.id, OWNER)).toBe("withdrawn")

  // The replaced process is asked to clean up: it leaves the copy alone and reports it owed.
  expect(await cleanupCopies(old.w)).toBe(1)
  expect(r.fake.log.discards, "nothing was discarded").toEqual([])
  expect((await r.s.su`select state from move_copy where move_id = ${r.move.id} and kind = 'dest_import'`)[0].state).toBe("cleanup_due")
  // The current incarnation removes it, and nothing is owed any more.
  expect(await cleanupCopies(r.dst.w)).toBe(0)
  expect((await r.s.su`select state from move_copy where move_id = ${r.move.id} and kind = 'dest_import'`)[0].state).toBe("removed")
  expect(r.fake.log.discards).toHaveLength(1)
})

test("RT-11: a cleanup pass that leaves a copy owed keeps the watch owed (the tick reads again), and one that leaves none asks nothing more", async () => {
  const s = await stage()
  await s.fleet()
  let passes = 0
  const watch = await watchMoves(s.tool, {
    runner: DST.runner, machine: DST.machine, fences: createFences(),
    drive: async () => WAITING, driveDest: async () => WAITING,
    cleanup: async () => { passes += 1; return passes < 2 ? 1 : 0 },
    lifted: () => {}, say: async () => {}, report: () => {},
  })
  watches.push(watch)
  await until("the first pass left a copy owed", () => passes >= 1 && watch.owed, 10_000)
  watch.tick()
  await until("the next pass left none", () => passes >= 2 && !watch.owed, 10_000)
  const settled = passes
  watch.tick()
  await Bun.sleep(300)
  expect(passes, "nothing is read while nothing is owed").toBe(settled)
})

// ---------------------------------------------------------------------------------------------------------------------
// the source RUNNER, whole
// ---------------------------------------------------------------------------------------------------------------------

const RUNNER_PI = SRC.runner

/**
 * A REAL source runner whose master is the agent the registry names, with the scripted adapter's children as real processes in groups of their
 * own, and the shared fake native port as the adapter's session. The scripted adapter answers capabilities with a build version, which is what the
 * export's fresh read of the engine asks for.
 */
async function stageRunner() {
  const agent = `t-${crypto.randomUUID()}`
  const capabilities = { stableSession: true, safeResume: false, delegationDisabled: false, version: "9.9.1" }
  // The person has a real EMPTY tree (`withLaunchTree`): the scope look refuses a person whose tree it cannot look at, whatever the destination has
  // recorded. The child stays plain (`unboxed`): what is under test is the move's order of events, not the box (`box-worn.test.ts`).
  const it = await stageHub(cluster, {
    adapter: { child: true, group: true, unboxed: true, capabilities },
    machines: [{ id: "pi", os: "linux" }],
    hub: { tick_seconds: 1 },
    run: [
      { id: DOOR, kind: "door", machine: "pi", platform: "fake", person: PERSON, token_file: "/dev/null", schedule: "always", memory_limit_mb: 192 },
      { id: RUNNER_PI, kind: "runner", machine: "pi", schedule: "always", memory_limit_mb: 512, child_memory_limit_mb: 512 },
    ],
    registry: base => ({ ...withLaunchTree(base), agents: [{ id: agent, person: PERSON, preset: "daily", chat: CHAT, door: DOOR, runner: RUNNER_PI }] }),
  })
  staged.push(it)
  const s = await moveStage(cluster, track, { database: it.db })
  const t = await s.topic("runtime", { identity: () => ({ ...newIdentity(), agent_id: agent }) })
  const fake = fakePort()
  const runner = await runRunner({ runner: RUNNER_PI, registryFile: it.registryFile, adapters: { [it.adapterName]: { ...it.scripted.adapter, session: fake.port } } })
  runners.push(runner)
  return { it, s, t, agent, fake, capabilities }
}

test("RT-12: a REAL source runner: the fed turn completes, queued input is untouched, an OFFLINE destination is waited for (no export, no fallback, no second child), and the export happens once the destination has recorded its preflight, under the native id the conversation has", async () => {
  const { it, s, t, agent, fake, capabilities } = await stageRunner()
  await until("the resident child was started", () => it.scripted.starts().length === 1, 30_000)
  it.scripted.holdTurnEnd(true)
  await insertInbound(cluster, it.db, { id: "q1", body: "the turn that is in flight", agent })
  await until("q1 was fed", () => it.scripted.fed().length === 1, 30_000)

  await s.adopt(SRC)
  const move = await s.request(t)
  await s.inbound("q2", agent)
  it.scripted.holdTurnEnd(false)
  await until("the reply landed", async () => (await it.read.outbox()).length === 1, 30_000)
  await until("the move is drained", async () => (await readMove(s.tool, move.id))!.drain !== null, 30_000)

  // The destination has recorded nothing (it is offline): the move waits, with no block, nothing exported, nothing started or fed.
  await Bun.sleep(2500)
  const waiting = (await readMove(s.tool, move.id))!
  expect(waiting).toMatchObject({ stage: "waiting", dest_ready_at: null, manifest: null, block: null })
  expect(fake.log.exports, "nothing was read from the session").toBe(0)
  expect(await s.count("move_blob where move_id = $1", move.id)).toBe(0)
  expect(it.scripted.starts().length, "no fresh session and no second child").toBe(1)
  expect(it.scripted.fed().map(one => one.id), "no double feed").toEqual(["q1"])
  expect((await it.read.inbound()).find(one => one.id === "q2")!.claimed_by, "the queued input waits where it is").toBeNull()
  expect((await it.read.sql("select state from execution where inbound_id = 'q1'"))[0].state, "the fed turn completed").toBe("completed")

  // The destination comes up and records its preflight: what the source's registry says of the agent, an engine and where a session would go.
  await s.register(DST, "dst-1")
  const profile = profileOf(loadRegistry(it.registryFile, { machine: "pi" }), agent)!
  const native = await s.nativeOf(move)
  expect(await destReady(s.tool, move.id, s.sideOf(move, "dest"), {
    profile, capabilities, native: { version: "9.9.2", os: "darwin", cwd: "/srv/hub/dest-session", project_dir: "-srv-hub-dest-session" },
  })).toBe("ready")
  await until("the move was exported and released", async () => (await readMove(s.tool, move.id))!.stage === "source_released", 30_000, async () => JSON.stringify(await readMove(s.tool, move.id)))

  const released = (await readMove(s.tool, move.id))!
  expect(fake.log.exports).toBe(1)
  expect(released.manifest!.native, "the native id is the conversation's own").toMatchObject({ native_session: native })
  expect(released.manifest!.files).toHaveLength(1)
  expect(released.manifest!.scope, "the proof sealed is the runner's own look at the person's real tree").toMatchObject({ carries: "native-only", basis: expect.stringContaining("the person's tree is empty") })
  expect(released.block).toBeNull()
  expect(await s.count("move_blob where move_id = $1", move.id)).toBe(1)
  expect((await it.read.ledger({ stream: "runner", kind: "move.released" })), "said once").toHaveLength(1)
  expect(it.scripted.starts().length, "releasing starts nothing").toBe(1)
  expect(it.scripted.fed().map(one => one.id)).toEqual(["q1"])
  expect((await it.read.inbound()).find(one => one.id === "q2")!.claimed_by).toBeNull()

  // The owner withdraws before activation: the source is still the session's owner, resumes the SAME native id, and feeds the queued row once.
  expect(await withdrawMove(s.tool, move.id, OWNER)).toBe("withdrawn")
  await until("the queued row was fed", () => it.scripted.fed().length === 2, 30_000)
  expect(it.scripted.fed().map(one => one.id)).toEqual(["q1", "q2"])
  expect(it.scripted.starts().length).toBe(2)
  expect(it.scripted.starts()[1].session, "resumed under the same native id").toEqual({ id: native, resume: true })
  expect(Number((await it.read.sql("select count(*)::int as n from execution where inbound_id = 'q2'"))[0].n), "fed exactly once").toBe(1)
}, SLOW)
