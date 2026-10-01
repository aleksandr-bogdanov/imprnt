// The native handoff of one conversation, source and destination (`runner/move-export.ts`, `runner/move-import.ts`), against a disposable
// store that holds the move's own routines (migration 016) and the real adapter's transfer library where a directory is the subject.
//
// WHAT THIS PROVES: the order of the steps and what is committed before each; that a stale export generation, a missing proof and a
// block stop an export before anything is stored or sealed; that a resumed import verifies against what its copy recorded and never
// writes twice; that a copy is reported removed only on durable evidence (a receipt discarded, a directory observed absent, or no
// `promote_intent` ever committed); and that nothing here takes the conversation's lock twice. Also (the `V2-` tests): that the source asks its
// local question (fenced, quiet, no foreign block, a generation-bound scope proof) again after the read and right before the release; that
// destination facts replaced mid-look, or made before the engine started the conversation, never seal a pair that was not checked and never
// overwrite another side's block; that a removal is never decided from the session directory rule of NOW alone; that a stage's receipt is
// carried by a failure whole or not at all, by the store's own byte limits; and that a launched session is a named gate, never replaced.
// The `V4-` tests: that a copy's evidence has ONE lifetime budget, the removal's own record included (an import that cannot fit is refused
// before anything is staged, a copy that was recorded fuller than that is never discarded and then failed to be reported removed, and
// evidence too full for even a small failure becomes a named block, never a store error), with a long link alias that resolves to a short
// real path (Linux only) and the padded fake port; and that diagnostics are cut on whole code points (a legal filename ending in an emoji).
// WHAT IT DOES NOT: that the source's drain is sound (`PROVEN` is a test's own assertion), that any engine resumes an imported session,
// that a repository or workspace travels (the scope proof is supplied, not checked), or that a registry, serve or a note exists. The fake
// port writes nothing; the real one runs on temporary directories under a TEST-ONLY copy of the measured tables that also encode `_` and
// `.` (macOS puts an underscore in `tmpdir()`), which exercises the machinery and measures nothing.

import { afterAll, afterEach, beforeAll, expect, test } from "bun:test"
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { startCluster, type Cluster } from "./helpers/cluster.ts"
import { FACTS, OWNER, sha, type MoveFixture, moveStage } from "./helpers/move-store-stage.ts"
import { Crash, FAKE_BYTES, PROVEN, drainOnly, fakeDir, fakePort, handoffWorld, lockChain, type Fake, type Locks } from "./helpers/move-handoff-stage.ts"
import {
  encodeProjectDir, makeClaudeSessionPort, nativeManifestDigest, VALIDATED_SESSION_BUILDS, VALIDATED_SESSION_PAIRS, type SessionObserve, type SessionRule, type SessionTables,
} from "../src/adapters/claude-session.ts"
import { NativeRefusal, type NativeManifest, type NativeSessionPort } from "../src/adapters/types.ts"
import type { StageReceipt } from "../src/transfer/workspace.ts"
import { buildBundle, contentKey, STAGE_MARKER, TransferError } from "../src/transfer/bundle.ts"
import { COPY_EVIDENCE_LIMIT, MOVE_NATIVE_LIMITS, clip, jsonbBytes, lifetimeBytes, removalReport, type ProvenDrain } from "../src/runner/move-handoff.ts"
import { exportSource } from "../src/runner/move-export.ts"
import { cleanupCopies, importDestination, prepareDestination } from "../src/runner/move-import.ts"
import {
  activateMove, blockMove, checkpointOf, copiesAtLocation, copiesOf, copyRemoved, exportGenerationOf, putBlob, releaseSource, unblockMove, withdrawMove, type MoveCopyRow, type MoveRow,
} from "../src/store/moves.ts"

let cluster: Cluster
const mine: { close(): Promise<void> }[] = []
const track = <T extends { close(): Promise<void> }>(sql: T): T => { mine.push(sql); return sql }
beforeAll(async () => { cluster = await startCluster() })
afterEach(async () => { for (const one of mine.splice(0)) await one.close().catch(() => {}) })
const made: string[] = []
afterAll(async () => { for (const dir of made) rmSync(dir, { recursive: true, force: true }); await cluster?.stop() })

const stage = () => moveStage(cluster, track)
const scratch = (): string => { const dir = realpathSync(mkdtempSync(join(tmpdir(), "hm-"))); made.push(dir); return dir }
const ev = (copy: MoveCopyRow) => copy.evidence as Record<string, any>

type World = ReturnType<typeof handoffWorld>
interface Rig { s: MoveFixture; move: MoveRow; locks: Locks; src: World; dst: World }

/** A started conversation (or a new one) with a move requested, both runners registered, and a fake native port both sides share. */
async function rig(options: { started?: boolean; dir?: string } = {}): Promise<Rig & { fake: Fake }> {
  const s = await stage()
  await s.fleet()
  const t = await s.topic()
  const move = await s.request(t)
  if (options.started !== false) await s.su`update conversation set native_state = 'started' where id = ${move.conversation_id}`
  const locks = lockChain()
  const fake = fakePort({ lockHeld: () => locks.held.size > 0 })
  const knobs = options.dir ? { sessionDir: () => options.dir! } : {}
  return { s, move, locks, fake, src: handoffWorld(s, "source", { port: fake.port, locks }), dst: handoffWorld(s, "dest", { port: fake.port, locks, knobs }) }
}

/** The destination ready, the drain complete, the export sealed: the move at `source_released`. */
async function atReleased(r: Rig) {
  expect(await prepareDestination(r.dst.w, r.move.id)).toMatchObject({ state: "done" })
  await drainOnly(r.s, r.move)
  expect(await exportSource(r.src.w, PROVEN, r.move.id)).toMatchObject({ state: "done", reason: "released" })
}

const crashAfter = (step: string) => (kind: string, detail: Record<string, unknown>) => kind === "move.import-step" && detail.step === step
const blobsOf = (s: MoveFixture, move: MoveRow, generation?: number) =>
  generation === undefined ? s.count("move_blob where move_id = $1", move.id) : s.count("move_blob where move_id = $1 and generation = $2", move.id, generation)
const destCopy = async (s: MoveFixture, move: MoveRow, generation = 1) => (await copiesOf(s.tool, move.id)).find(one => one.kind === "dest_import" && one.generation === generation)!
const machineOf = async (s: MoveFixture, move: MoveRow) => String((await s.su`select machine from conversation where id = ${move.conversation_id}`)[0].machine)

/** The import taken to a crash right after a committed step. */
async function crashed(r: Rig, step: string) {
  r.dst.knobs.crashOn = crashAfter(step)
  await expect(importDestination(r.dst.w, r.move.id)).rejects.toBeInstanceOf(Crash)
  r.dst.knobs.crashOn = null
}

// ---------------------------------------------------------------------------------------------------------------------
// the source
// ---------------------------------------------------------------------------------------------------------------------

test("S1: a drained move is exported under the drain's own generation, and the sealed manifest carries the bundle digest, the adapter's native digest, the generation, the scope proof and one blob", async () => {
  const r = await rig()
  expect(await prepareDestination(r.dst.w, r.move.id)).toMatchObject({ state: "done", reason: "ready" })
  await drainOnly(r.s, r.move)
  const generation = exportGenerationOf(await r.s.reread(r.move))!
  expect(await exportSource(r.src.w, PROVEN, r.move.id)).toMatchObject({ state: "done", reason: "released" })

  const sealed = await r.s.reread(r.move)
  expect(sealed.stage).toBe("source_released")
  expect(sealed.block).toBeNull()
  const manifest = sealed.manifest!
  const path = manifest.files[0].path
  expect(manifest.digest).toBe(buildBundle([{ path, class: "native", mode: 0o600, bytes: FAKE_BYTES }], MOVE_NATIVE_LIMITS).manifest.digest)
  expect(manifest.native).toEqual({ native_session: sealed.native_session, native_manifest_digest: nativeManifestDigest(manifest.native_export as NativeManifest) })
  expect(manifest.export_generation).toBe(generation)
  expect(manifest.scope).toMatchObject({ carries: "native-only" })
  expect(manifest.portability).toMatchObject({ adapter: "fake", evidence: "scripted-by-test" })
  expect(manifest.files).toEqual([{ kind: "native", path, sha256: sha(FAKE_BYTES), size: FAKE_BYTES.byteLength, mode: 0o600 }])
  expect(await blobsOf(r.s, r.move, generation)).toBe(1)
  expect(await blobsOf(r.s, r.move)).toBe(1)
  expect(r.src.said.map(one => one.kind)).toContain("move.released")
  // Looking again at a released move asks nothing and writes nothing.
  expect(await exportSource(r.src.w, PROVEN, r.move.id)).toMatchObject({ state: "done", reason: "stage:source_released" })
  expect(r.fake.log.exports).toBe(1)
})

test("S2: a drain that is not final for THIS incarnation exports nothing: no drain, not fenced, not quiet, another incarnation", async () => {
  const r = await rig()
  await prepareDestination(r.dst.w, r.move.id)
  expect(await exportSource(r.src.w, PROVEN, r.move.id), "no drain yet").toMatchObject({ state: "waiting", reason: "drain-not-final" })
  await drainOnly(r.s, r.move)
  expect(await exportSource(r.src.w, { fenced: () => false, quiet: () => true }, r.move.id)).toMatchObject({ reason: "drain-not-final" })
  expect(await exportSource(r.src.w, { fenced: () => true, quiet: () => false }, r.move.id)).toMatchObject({ reason: "drain-not-final" })
  const other = handoffWorld(r.s, "source", { port: r.fake.port, locks: r.locks, incarnation: "src-other" })
  expect(await exportSource(other.w, PROVEN, r.move.id)).toMatchObject({ reason: "drain-not-final" })
  expect(r.fake.log.exports).toBe(0)
  expect(await blobsOf(r.s, r.move)).toBe(0)
  expect((await r.s.reread(r.move)).stage).toBe("waiting")
})

test("S3: a drain completed again after the export was read leaves the old generation stale; the next look exports afresh under the new one and only that is sealed", async () => {
  const r = await rig()
  await prepareDestination(r.dst.w, r.move.id)
  await drainOnly(r.s, r.move, "intent-1", 4242)
  const first = exportGenerationOf(await r.s.reread(r.move))!
  r.src.knobs.duringBuild = async () => { r.src.knobs.duringBuild = null; await drainOnly(r.s, r.move, "intent-2", 4343) }
  // The look asks again after the read and finds another generation standing: nothing is stored (the store would refuse it too, `stale-export`).
  expect(await exportSource(r.src.w, PROVEN, r.move.id)).toMatchObject({ state: "waiting", reason: "drain-not-final" })
  expect(await blobsOf(r.s, r.move)).toBe(0)
  const second = exportGenerationOf(await r.s.reread(r.move))!
  expect(second).toBeGreaterThan(first)

  expect(await exportSource(r.src.w, PROVEN, r.move.id)).toMatchObject({ state: "done", reason: "released" })
  const sealed = await r.s.reread(r.move)
  expect(sealed.manifest!.export_generation).toBe(second)
  expect(await blobsOf(r.s, r.move, second)).toBe(1)
  expect(await blobsOf(r.s, r.move, first)).toBe(0)
  expect(r.fake.log.exports).toBe(2)
})

test("S4: an export waits for the destination's preflight and releases once it is recorded; nothing is stored before", async () => {
  const r = await rig()
  await drainOnly(r.s, r.move)
  expect(await exportSource(r.src.w, PROVEN, r.move.id)).toMatchObject({ state: "waiting", reason: "dest-not-ready" })
  expect(await blobsOf(r.s, r.move)).toBe(0)
  expect(r.fake.log.exports).toBe(0)
  await prepareDestination(r.dst.w, r.move.id)
  expect(await exportSource(r.src.w, PROVEN, r.move.id)).toMatchObject({ state: "done", reason: "released" })
})

test("S5: a side-state, unvalidated pair or build refusal, a missing proof, port or build is this side's named block with nothing stored; a drain that is not final clears it and a fix releases", async () => {
  const r = await rig()
  await prepareDestination(r.dst.w, r.move.id)
  await drainOnly(r.s, r.move)
  const blocked = async (code: string) => {
    const now = await r.s.reread(r.move)
    expect(now.block).toMatchObject({ code, by: "source" })
    expect(now.stage).toBe("waiting")
    expect(await blobsOf(r.s, r.move)).toBe(0)
  }
  r.fake.behavior.exportRefuses = new NativeRefusal("native_side_state_unsupported", "config/todos")
  expect(await exportSource(r.src.w, PROVEN, r.move.id)).toMatchObject({ state: "blocked", reason: "native_side_state_unsupported" })
  await blocked("native_side_state_unsupported")
  expect((await r.s.reread(r.move)).block!.detail).toMatchObject({ path: "config/todos" })

  r.fake.behavior.exportRefuses = new NativeRefusal("native_build_unvalidated")
  expect(await exportSource(r.src.w, PROVEN, r.move.id)).toMatchObject({ state: "blocked", reason: "native_build_unvalidated" })
  await blocked("native_build_unvalidated")

  r.fake.behavior.exportRefuses = null
  r.fake.behavior.portabilityRefuses = new NativeRefusal("native_pair_unvalidated")
  expect(await exportSource(r.src.w, PROVEN, r.move.id)).toMatchObject({ state: "blocked", reason: "native_pair_unvalidated" })
  await blocked("native_pair_unvalidated")
  r.fake.behavior.portabilityRefuses = null

  for (const mode of ["missing", "other-move"] as const) {
    r.src.knobs.scope = mode
    expect(await exportSource(r.src.w, PROVEN, r.move.id), `scope ${mode}`).toMatchObject({ state: "blocked", reason: "scope_unproven" })
    await blocked("scope_unproven")
  }
  r.src.knobs.scope = "ok"
  const exportsBefore = r.fake.log.exports
  r.src.knobs.build = null
  expect(await exportSource(r.src.w, PROVEN, r.move.id)).toMatchObject({ state: "blocked", reason: "native_build_unknown" })
  await blocked("native_build_unknown")
  r.src.knobs.build = { version: "9.9.1", capabilities: {} }
  const portless = handoffWorld(r.s, "source", { port: null, locks: r.locks })
  expect(await exportSource(portless.w, PROVEN, r.move.id)).toMatchObject({ state: "blocked", reason: "native_port_missing" })
  await blocked("native_port_missing")
  expect(r.fake.log.exports, "the scope, the build and the port are asked before the disk is").toBe(exportsBefore)

  // The block never hides a drain that is not final: it is this side's own and is cleared by that look.
  expect(await exportSource(r.src.w, { fenced: () => false, quiet: () => true }, r.move.id)).toMatchObject({ reason: "drain-not-final" })
  expect((await r.s.reread(r.move)).block).toBeNull()

  expect(await exportSource(r.src.w, PROVEN, r.move.id)).toMatchObject({ state: "done", reason: "released" })
  expect((await r.s.reread(r.move)).block).toBeNull()
})

test("S5a: a side's block under the SAME code is restated when its detail moved (the store answers replay to the code alone), and a repeat on the same facts writes nothing", async () => {
  const r = await rig()
  await prepareDestination(r.dst.w, r.move.id)
  await drainOnly(r.s, r.move)
  const look = () => exportSource(r.src.w, PROVEN, r.move.id)
  r.fake.behavior.exportRefuses = new NativeRefusal("native_side_state_unsupported", "config/todos")
  expect(await look()).toMatchObject({ state: "blocked", reason: "native_side_state_unsupported", detail: { path: "config/todos" } })
  const first = (await r.s.reread(r.move)).block!
  expect(first).toMatchObject({ code: "native_side_state_unsupported", by: "source", detail: { path: "config/todos" } })
  // The same facts again: the row is exactly as it was (no clear, no set, the same `since`).
  expect(await look()).toMatchObject({ state: "blocked", reason: "native_side_state_unsupported" })
  expect((await r.s.reread(r.move)).block).toEqual(first)

  // What the refusal is about moved on under the one code: the row says the new subject, not the first.
  r.fake.behavior.exportRefuses = new NativeRefusal("native_side_state_unsupported", "config/plans")
  expect(await look()).toMatchObject({ state: "blocked", reason: "native_side_state_unsupported", detail: { path: "config/plans" } })
  const second = (await r.s.reread(r.move)).block!
  expect(second).toMatchObject({ code: "native_side_state_unsupported", by: "source", detail: { path: "config/plans" } })
  expect(second.since, "it was set again").not.toBe(first.since)
  expect((await r.s.reread(r.move)).stage).toBe("waiting")
  expect(await blobsOf(r.s, r.move)).toBe(0)

  // And it is still this side's own: the fix releases, with nothing left on the row.
  r.fake.behavior.exportRefuses = null
  expect(await look()).toMatchObject({ state: "done", reason: "released" })
  expect((await r.s.reread(r.move)).block).toBeNull()
})

test("S5b: another party's block stands: nothing is read, stored or sealed, and it is never cleared by the source", async () => {
  const r = await rig()
  await prepareDestination(r.dst.w, r.move.id)
  await drainOnly(r.s, r.move)
  expect(await blockMove(r.s.tool, r.move.id, r.s.sideOf(r.move, "dest"), "dest_hold", {})).toBe("blocked")
  expect(await exportSource(r.src.w, PROVEN, r.move.id)).toMatchObject({ state: "waiting", reason: "blocked", detail: { by: "dest", code: "dest_hold" } })
  expect(r.fake.log.exports).toBe(0)
  expect(await exportSource(r.src.w, { fenced: () => false, quiet: () => true }, r.move.id)).toMatchObject({ reason: "drain-not-final" })
  expect((await r.s.reread(r.move)).block).toMatchObject({ code: "dest_hold", by: "dest" })
})

test("S6: a conversation the engine never started is sealed with an EMPTY manifest and no blob, the port untouched, and imports without a file", async () => {
  const r = await rig({ started: false })
  expect(await prepareDestination(r.dst.w, r.move.id)).toMatchObject({ state: "done", reason: "ready" })
  expect((await r.s.reread(r.move)).dest_facts).toMatchObject({ native: null })
  await drainOnly(r.s, r.move)
  const generation = exportGenerationOf(await r.s.reread(r.move))!
  expect(await exportSource(r.src.w, PROVEN, r.move.id)).toMatchObject({ state: "done", reason: "released" })
  const sealed = await r.s.reread(r.move)
  expect(sealed.manifest).toMatchObject({ digest: buildBundle([], MOVE_NATIVE_LIMITS).manifest.digest, files: [], bytes: 0, export_generation: generation })
  expect(sealed.manifest!.native).toBeUndefined()
  expect(await blobsOf(r.s, r.move)).toBe(0)

  expect(await importDestination(r.dst.w, r.move.id)).toMatchObject({ state: "done", reason: "activated" })
  const moved = await r.s.reread(r.move)
  expect(moved.stage).toBe("activated")
  expect(moved.verification).toMatchObject({ imported: { empty: true, bundle_digest: sealed.manifest!.digest } })
  expect(await machineOf(r.s, r.move)).toBe("mac")
  expect(ev(await destCopy(r.s, r.move)).promote_intent).toEqual({ empty: true })
  expect(r.fake.log).toMatchObject({ exports: 0, destination: 0, portability: 0, imports: [], writes: 0 })
})

test("S6b: an empty import that is withdrawn is removed as nothing-written, with no directory looked at and no discard", async () => {
  const r = await rig({ started: false })
  await atReleased(r)
  await crashed(r, "promote_intent")
  expect(await withdrawMove(r.s.tool, r.move.id, OWNER)).toBe("withdrawn")
  await cleanupCopies(r.dst.w)
  const copy = await destCopy(r.s, r.move)
  expect(copy.state).toBe("removed")
  expect(ev(copy).removed).toMatchObject({ removed: "nothing-written", staging: copy.staging_id })
  expect(r.fake.log.discards).toEqual([])
})

test("S7: bytes that differ from what one generation already stored are native_export_changed, with no release", async () => {
  const r = await rig()
  await prepareDestination(r.dst.w, r.move.id)
  await drainOnly(r.s, r.move)
  // One look's bytes are stored (as an earlier look of the same generation left them): what is read now must be the same file.
  const generation = exportGenerationOf(await r.s.reread(r.move))!
  const first = r.fake.port.exportSession({ sessionDir: "/unused", nativeSession: await r.s.nativeOf(r.move), version: "9.9.1", limits: MOVE_NATIVE_LIMITS })
  const file = first.manifest.files[0]
  expect(await putBlob(r.s.tool, r.move.id, r.s.sideOf(r.move, "source"), generation, { kind: "native", path: file.path, mode: file.mode, bytes: first.bundle.contents.get(contentKey("native", file.path))! })).toBe("stored")
  expect(await blobsOf(r.s, r.move)).toBe(1)

  r.fake.behavior.bytes = Buffer.from("not what the quiet source held\n")
  expect(await exportSource(r.src.w, PROVEN, r.move.id)).toMatchObject({ state: "blocked", reason: "native_export_changed" })
  const now = await r.s.reread(r.move)
  expect(now.stage).toBe("waiting")
  expect(now.block).toMatchObject({ code: "native_export_changed", by: "source" })
  expect(now.manifest).toBeNull()
})

// ---------------------------------------------------------------------------------------------------------------------
// the destination
// ---------------------------------------------------------------------------------------------------------------------

test("D1: a refused path is this side's block and destReady is never called, so the source cannot release; a supported path records the native side; an unbound profile records nothing", async () => {
  const r = await rig()
  r.dst.knobs.sessionDir = move => `${fakeDir(move)}/dotted.dir`
  expect(await prepareDestination(r.dst.w, r.move.id)).toMatchObject({ state: "blocked", reason: "native_locator_unsupported_path" })
  const refused = await r.s.reread(r.move)
  expect(refused).toMatchObject({ dest_facts: null, dest_ready_at: null, block: { code: "native_locator_unsupported_path", by: "dest" } })
  await drainOnly(r.s, r.move)
  expect(await exportSource(r.src.w, PROVEN, r.move.id)).toMatchObject({ state: "waiting", reason: "blocked" })
  expect(await blobsOf(r.s, r.move)).toBe(0)
  expect(r.fake.log.exports).toBe(0)

  for (const profile of ["missing", "other-runner"] as const) {
    r.dst.knobs.profile = profile
    r.dst.knobs.sessionDir = fakeDir
    expect(await prepareDestination(r.dst.w, r.move.id), profile).toMatchObject({ state: "blocked", reason: "dest_profile_unbound" })
    expect((await r.s.reread(r.move)).dest_facts).toBeNull()
  }
  r.dst.knobs.profile = "ok"
  expect(await prepareDestination(r.dst.w, r.move.id)).toMatchObject({ state: "done", reason: "ready" })
  const ready = await r.s.reread(r.move)
  expect(ready.block).toBeNull()
  expect(ready.dest_facts).toMatchObject({ native: { os: "darwin", cwd: fakeDir(r.move), version: "9.9.2" }, profile_basis: "test: supplied binding" })
  expect(await prepareDestination(r.dst.w, r.move.id), "a repeat is a replay").toMatchObject({ state: "done" })
})

test("D2: the happy path through activation: one import under the copy's own staging identity, the placement moved, the verification built from the copy's stored evidence, one lock entry", async () => {
  const r = await rig()
  await atReleased(r)
  r.locks.events.length = 0
  expect(await importDestination(r.dst.w, r.move.id)).toMatchObject({ state: "done", reason: "activated" })
  const moved = await r.s.reread(r.move)
  expect(moved.stage).toBe("activated")
  expect(await machineOf(r.s, r.move)).toBe("mac")
  const copy = await destCopy(r.s, r.move)
  expect(copy.state).toBe("promoted")
  expect(r.fake.log.writes).toBe(1)
  expect(r.fake.log.imports).toEqual([{ sessionDir: fakeDir(r.move), operation: `move-${r.move.id}-g1`, reused: false }])
  expect(ev(copy).promoted).toMatchObject({ reused: false, native_manifest_digest: moved.manifest!.native!.native_manifest_digest, receipt: { operation: copy.staging_id } })
  // `verified` REPLACES the copy's evidence, so its words are the evidence's own keys; the later steps merge in under their names.
  expect(ev(copy)).toMatchObject({ manifest_digest: moved.manifest!.digest, generation: 1, staging: copy.staging_id, version: "9.9.2", native: moved.manifest!.native })
  expect(ev(copy).promote_intent).toEqual({ session_dir: fakeDir(r.move), absent: true })
  expect(moved.verification).toMatchObject({
    generation: 1, staging: copy.staging_id, manifest_digest: moved.manifest!.digest, dest_runner: moved.dest_runner, dest_machine: moved.dest_machine,
    native: moved.manifest!.native, imported: { bundle_digest: ev(copy).promoted.bundle_digest, to: ev(copy).promoted.to, transcript: ev(copy).promoted.transcript },
  })
  expect(r.locks.events).toEqual([`enter:${r.move.conversation_id}`, `exit:${r.move.conversation_id}`])
  expect(await importDestination(r.dst.w, r.move.id), "after activation nothing is owed").toMatchObject({ state: "done", reason: "stage:activated" })
})

test("D4: a crash after each committed step resumes to the same activation with no second write, the same receipt and a jsonb-equal replay", async () => {
  for (const point of ["intent", "verified", "promote_intent", "imported", "promoted", "stage"]) {
    const r = await rig()
    await atReleased(r)
    if (point === "stage") r.fake.behavior.afterStage = () => { r.fake.behavior.afterStage = null; throw new Crash("stage") }
    else r.dst.knobs.crashOn = crashAfter(point)
    await expect(importDestination(r.dst.w, r.move.id), point).rejects.toBeInstanceOf(Crash)
    const wroteBefore = r.fake.log.writes

    const again = handoffWorld(r.s, "dest", { port: r.fake.port, locks: r.locks })
    expect(await importDestination(again.w, r.move.id), point).toMatchObject({ state: "done", reason: "activated" })
    expect(r.fake.log.writes, `${point}: never a second write`).toBe(1)
    const reused = r.fake.log.imports.at(-1)!.reused
    expect(reused, point).toBe(wroteBefore === 1 && point !== "promoted")
    const copy = await destCopy(r.s, r.move)
    expect(ev(copy).promoted.receipt, point).toEqual(r.fake.staged.get(fakeDir(r.move)))
    expect(ev(copy).promoted.reused, point).toBe(reused === true)
    const moved = await r.s.reread(r.move)
    expect(await activateMove(r.s.tool, r.move.id, r.s.sideOf(moved, "dest"), 1, moved.verification!), point).toBe("replay")
    expect((await copiesOf(r.s.tool, r.move.id)).filter(one => one.kind === "dest_import").length, point).toBe(1)
  }
})

test("D5: a build that changed since the preflight fails the import before any write; the copy is then removed as nothing-written, once", async () => {
  const r = await rig()
  await atReleased(r)
  r.dst.knobs.build = { version: "9.9.3", capabilities: {} }
  expect(await importDestination(r.dst.w, r.move.id)).toMatchObject({ state: "blocked", reason: "native_build_changed" })
  const failed = await r.s.reread(r.move)
  expect(failed.stage).toBe("source_released")
  expect(failed.block).toMatchObject({ code: "native_build_changed", by: "dest" })
  const copy = await destCopy(r.s, r.move)
  expect(copy.state).toBe("cleanup_due")
  expect(ev(copy).failure.detail).toMatchObject({ written: false, recorded: "9.9.2", now: "9.9.3" })
  expect(r.fake.log.imports).toEqual([])

  await cleanupCopies(r.dst.w)
  const removed = await destCopy(r.s, r.move)
  expect(removed.state).toBe("removed")
  expect(ev(removed).removed).toMatchObject({ removed: "nothing-written", staging: removed.staging_id, proof: { activated: false, live_child: false, other_claims: 0 } })
  await cleanupCopies(r.dst.w)
  expect(r.fake.log.discards).toEqual([])
})

test("D5b: a destination path that is not the one the preflight recorded fails the import before any write", async () => {
  const r = await rig()
  await atReleased(r)
  // The path the preflight recorded is not where the launch directory is now.
  r.dst.knobs.sessionDir = move => `${fakeDir(move)}-moved`
  expect(await importDestination(r.dst.w, r.move.id)).toMatchObject({ state: "blocked", reason: "native_destination_changed" })
  expect(ev(await destCopy(r.s, r.move)).failure.detail).toMatchObject({ written: false })
  expect(r.fake.log.imports).toEqual([])
})

test("D5c: a blob the store no longer has fails the import as native_blobs_gone, written false", async () => {
  const r = await rig()
  await atReleased(r)
  await r.s.su`delete from move_blob where move_id = ${r.move.id}`
  expect(await importDestination(r.dst.w, r.move.id)).toMatchObject({ state: "blocked", reason: "native_blobs_gone" })
  expect(ev(await destCopy(r.s, r.move)).failure.detail).toMatchObject({ written: false })
})

test("P1: a refusal AFTER promote_intent is recorded written: unknown, and the copy is removed only when the directory is observed absent, never on that refusal", async () => {
  const dir = join(scratch(), "d")
  const r = await rig({ dir })
  await atReleased(r)
  r.fake.behavior.importRefuses = new NativeRefusal("native_dest_session_collision")
  expect(await importDestination(r.dst.w, r.move.id)).toMatchObject({ state: "blocked", reason: "native_dest_session_collision" })
  const copy = await destCopy(r.s, r.move)
  expect(copy.state).toBe("cleanup_due")
  expect(ev(copy).promote_intent).toMatchObject({ session_dir: dir, absent: true })
  expect(ev(copy).failure.detail).toMatchObject({ written: "unknown", dir: "absent" })

  // An earlier call may have staged files: something is there and nothing shows this copy made it.
  mkdirSync(dir)
  writeFileSync(join(dir, "stage-of-an-earlier-call.txt"), "keep")
  await cleanupCopies(r.dst.w)
  expect((await destCopy(r.s, r.move)).state).toBe("cleanup_due")
  expect(r.dst.said.find(one => one.kind === "move.cleanup-left")!.detail).toMatchObject({ reason: "cleanup-receipt-missing", dir: "present" })
  expect(readFileSync(join(dir, "stage-of-an-earlier-call.txt"), "utf8")).toBe("keep")
  expect(r.fake.log.discards).toEqual([])

  rmSync(dir, { recursive: true })
  await cleanupCopies(r.dst.w)
  const removed = await destCopy(r.s, r.move)
  expect(removed.state).toBe("removed")
  expect(ev(removed).removed).toMatchObject({ removed: "absent" })
})

// ---------------------------------------------------------------------------------------------------------------------
// cleanup
// ---------------------------------------------------------------------------------------------------------------------

/** An import crashed right after `promoted`, then withdrawn: the copy is owed its removal, with the receipt on it. */
async function promotedAndWithdrawn(options: { dir?: string } = {}) {
  const r = await rig(options)
  await atReleased(r)
  await crashed(r, "promoted")
  expect(await withdrawMove(r.s.tool, r.move.id, OWNER)).toBe("withdrawn")
  expect((await destCopy(r.s, r.move)).state).toBe("cleanup_due")
  return r
}

test("C1: a withdrawal after promoted is discarded by the receipt and reported removed once; a repeat is a replay", async () => {
  const r = await promotedAndWithdrawn()
  await cleanupCopies(r.dst.w)
  const copy = await destCopy(r.s, r.move)
  expect(copy.state).toBe("removed")
  expect(r.fake.log.discards.map(one => one.operation)).toEqual([copy.staging_id])
  expect(ev(copy).removed).toMatchObject({ removed: "stage", staging: copy.staging_id, stage_generation: r.fake.log.discards[0].generation })
  expect(r.fake.staged.size).toBe(0)
  await cleanupCopies(r.dst.w)
  expect(r.fake.log.discards.length).toBe(1)
  expect(await copyRemoved(r.s.tool, r.move.id, r.s.sideOf(r.move, "dest"), 1, { staging: copy.staging_id }, "dest_import")).toBe("replay")
  expect((await copiesAtLocation(r.s.tool, { conversation: r.move.conversation_id, machine: "mac" })).filter(one => one.state !== "removed")).toEqual([])
})

test("C2: a withdrawal after promote_intent with no receipt leaves a directory that is there, untouched, and the location stays cleanup-pending", async () => {
  const dir = join(scratch(), "d")
  const r = await rig({ dir })
  await atReleased(r)
  await crashed(r, "promote_intent")
  mkdirSync(dir)
  writeFileSync(join(dir, "who-made-this.txt"), "unknown")
  expect(await withdrawMove(r.s.tool, r.move.id, OWNER)).toBe("withdrawn")
  await cleanupCopies(r.dst.w)
  expect((await destCopy(r.s, r.move)).state).toBe("cleanup_due")
  expect(readdirSync(dir)).toEqual(["who-made-this.txt"])
  expect(r.dst.said.at(-1)).toMatchObject({ kind: "move.cleanup-left", detail: { reason: "cleanup-receipt-missing" } })
  expect(r.fake.log.discards).toEqual([])
  expect((await copiesAtLocation(r.s.tool, { conversation: r.move.conversation_id, machine: "mac" })).map(one => one.state)).toEqual(["cleanup_due"])
})

test("C5: a removal is refused before any discard while a child may be live, or the conversation is placed here; once both are false it goes ahead", async () => {
  const r = await promotedAndWithdrawn()
  r.dst.knobs.idle = false
  await cleanupCopies(r.dst.w)
  expect(r.dst.said.at(-1)).toMatchObject({ kind: "move.cleanup-left", detail: { reason: "live-child" } })
  r.dst.knobs.idle = true
  await r.s.su`update conversation set machine = 'mac' where id = ${r.move.conversation_id}`
  await cleanupCopies(r.dst.w)
  expect(r.dst.said.at(-1)).toMatchObject({ detail: { reason: "placed-here" } })
  expect(r.fake.log.discards).toEqual([])
  expect((await destCopy(r.s, r.move)).state).toBe("cleanup_due")
  await r.s.su`update conversation set machine = 'pi' where id = ${r.move.conversation_id}`
  await cleanupCopies(r.dst.w)
  expect((await destCopy(r.s, r.move)).state).toBe("removed")
  expect(r.fake.log.discards.length).toBe(1)
})

test("C6: an import and a cleanup of one conversation never interleave, and every port call that writes or removes is made under the lock", async () => {
  const r = await promotedAndWithdrawn()
  r.locks.events.length = 0
  await Promise.all([cleanupCopies(r.dst.w), importDestination(r.dst.w, r.move.id), cleanupCopies(r.dst.w)])
  const key = r.move.conversation_id
  expect(r.locks.events.length % 2).toBe(0)
  r.locks.events.forEach((event, at) => expect(event).toBe(`${at % 2 === 0 ? "enter" : "exit"}:${key}`))
  expect(r.fake.log.discards.length).toBe(1)
})

test("C6b: an import that finds an earlier copy of its location owed its removal removes it under the lock it already holds, and does not wait for itself", async () => {
  const r = await rig()
  await atReleased(r)
  r.dst.knobs.build = { version: "9.9.3", capabilities: {} }
  expect(await importDestination(r.dst.w, r.move.id)).toMatchObject({ state: "blocked", reason: "native_build_changed" })
  r.dst.knobs.build = { version: "9.9.2", capabilities: {} }
  expect(await unblockMove(r.s.tool, r.move.id, r.s.sideOf(r.move, "dest"), "native_build_changed")).toBe("cleared")
  r.locks.events.length = 0
  const outcome = await Promise.race([importDestination(r.dst.w, r.move.id), Bun.sleep(5_000).then(() => "deadlock" as const)])
  expect(outcome).toMatchObject({ state: "done", reason: "activated" })
  expect(r.locks.events).toEqual([`enter:${r.move.conversation_id}`, `exit:${r.move.conversation_id}`])
  const copies = (await copiesOf(r.s.tool, r.move.id)).filter(one => one.kind === "dest_import").map(one => `${one.generation}:${one.state}`)
  expect(copies).toEqual(["1:removed", "2:promoted"])
  expect(r.fake.log.imports[0].operation).toBe(`move-${r.move.id}-g2`)
})

test("C7: a retained source copy that is owed removal is left untouched and said once", async () => {
  const r = await rig()
  await atReleased(r)
  await r.s.su`update move_copy set state = 'cleanup_due' where move_id = ${r.move.id} and kind = 'source_session_retained'`
  await cleanupCopies(r.src.w)
  await cleanupCopies(r.src.w)
  const retained = (await copiesOf(r.s.tool, r.move.id)).find(one => one.kind === "source_session_retained")!
  expect(retained.state).toBe("cleanup_due")
  expect(r.src.said.filter(one => one.kind === "move.cleanup-left").map(one => one.detail.reason)).toEqual(["retained-source-copy"])
  expect(r.fake.log.discards).toEqual([])
})

// ---------------------------------------------------------------------------------------------------------------------
// the real adapter, on temporary directories
// ---------------------------------------------------------------------------------------------------------------------

const SESSION = "1e261f87-06a7-4242-b039-ec2a6c7173aa"
const TRANSCRIPT = Buffer.from('{"type":"user","n":1}\n{"type":"assistant","n":2}\n')
const widen = (entry: SessionRule): SessionRule => ({ ...entry, substitute: { ...entry.substitute, "_": "-", ".": "-" } })
const TABLES: SessionTables = {
  builds: { "darwin:2.1.286": widen(VALIDATED_SESSION_BUILDS["darwin:2.1.286"]), "linux:2.1.285": widen(VALIDATED_SESSION_BUILDS["linux:2.1.285"]) },
  pairs: VALIDATED_SESSION_PAIRS,
}

/** The source as a linux 2.1.285 engine leaves it, the destination a darwin 2.1.286 one: the measured pair, on the tables above. */
async function realRig(observe?: SessionObserve, wrap: (port: NativeSessionPort) => NativeSessionPort = port => port) {
  const root = scratch()
  const srcDir = join(root, "src")
  const dstDir = join(root, "dst")
  mkdirSync(srcDir)
  const projectDir = encodeProjectDir(realpathSync(srcDir), TABLES.builds["linux:2.1.285"])!
  const rel = `config/projects/${projectDir}/${SESSION}.jsonl`
  mkdirSync(dirname(join(srcDir, rel)), { recursive: true })
  writeFileSync(join(srcDir, rel), TRANSCRIPT)
  chmodSync(join(srcDir, rel), 0o600)

  const s = await stage()
  await s.fleet()
  const t = await s.topic()
  await s.su`update conversation set native_session = ${SESSION}, native_state = 'started' where id = ${t.conversation_id}`
  const move = await s.request(t)
  const locks = lockChain()
  const srcPort = makeClaudeSessionPort(TABLES, { os: "linux" })
  const dstPort = wrap(makeClaudeSessionPort(TABLES, { os: "darwin" }, observe))
  const src = handoffWorld(s, "source", { port: srcPort, locks, knobs: { build: { version: "2.1.285", capabilities: {} }, sessionDir: () => srcDir } })
  const dst = handoffWorld(s, "dest", { port: dstPort, locks, knobs: { build: { version: "2.1.286", capabilities: {} }, sessionDir: () => dstDir } })
  return { s, move, locks, src, dst, srcDir, dstDir, srcPort, dstPort }
}
type Real = Awaited<ReturnType<typeof realRig>>

const transcriptAt = (real: Real, copy: MoveCopyRow) => join(real.dstDir, ev(copy).promoted.transcript.path as string)

test("R1: a real transcript crosses: the same bytes at the destination's own folder, the relocation inputs kept, the placement moved", async () => {
  const real = await realRig()
  await atReleased(real)
  expect(await importDestination(real.dst.w, real.move.id)).toMatchObject({ state: "done", reason: "activated" })
  const copy = await destCopy(real.s, real.move)
  expect(readFileSync(transcriptAt(real, copy))).toEqual(TRANSCRIPT)
  expect(existsSync(join(real.dstDir, STAGE_MARKER))).toBe(true)
  const moved = await real.s.reread(real.move)
  expect((moved.manifest!.native_export as NativeManifest).from.cwd).toBe(realpathSync(real.srcDir))
  expect(ev(copy).promoted.to.cwd).toBe(realpathSync(real.dstDir))
  expect(ev(copy).promoted.to.cwd).not.toBe((moved.manifest!.native_export as NativeManifest).from.cwd)
  expect(moved.manifest!.portability).toMatchObject({ adapter: "claude-code", from: "linux:2.1.285", to: "darwin:2.1.286" })
  expect(await machineOf(real.s, real.move)).toBe("mac")
})

test("R2: a sealed native digest that is not the carried manifest's is refused before anything is written, and the copy is removed only because the directory is absent", async () => {
  const real = await realRig()
  const { s, move } = real
  await prepareDestination(real.dst.w, move.id)
  await drainOnly(s, move)
  const generation = exportGenerationOf(await s.reread(move))!
  const exp = real.srcPort.exportSession({ sessionDir: real.srcDir, nativeSession: SESSION, version: "2.1.285", limits: MOVE_NATIVE_LIMITS })
  const file = exp.manifest.files[0]
  const bytes = exp.bundle.contents.get(contentKey("native", file.path))!
  const by = s.sideOf(move, "source")
  expect(await putBlob(s.tool, move.id, by, generation, { kind: "native", path: file.path, mode: file.mode, bytes })).toBe("stored")
  const manifest = {
    digest: exp.bundle.manifest.digest, files: [{ kind: "native", ...file }], bytes: file.size,
    native: { native_session: SESSION, native_manifest_digest: sha("not the manifest that was carried") },
    portability: real.srcPort.portability({ from: { os: "linux", version: "2.1.285" }, to: { os: "darwin", version: "2.1.286" } }),
    native_export: exp.manifest, export_generation: generation,
  }
  expect(await releaseSource(s.tool, move.id, by, generation, (await checkpointOf(s.tool, move.conversation_id))!, manifest)).toBe("released")

  expect(await importDestination(real.dst.w, move.id)).toMatchObject({ state: "blocked", reason: "native_export_mismatch" })
  expect(existsSync(real.dstDir)).toBe(false)
  expect(ev(await destCopy(s, move)).failure.detail).toMatchObject({ written: "unknown", dir: "absent" })
  await cleanupCopies(real.dst.w)
  expect(ev(await destCopy(s, move)).removed).toMatchObject({ removed: "absent" })
})

test("D6: a foreign directory at the session directory is a collision seen BEFORE promote_intent: written false, the foreign bytes intact, and the copy is removed as nothing-written", async () => {
  const real = await realRig()
  await atReleased(real)
  mkdirSync(real.dstDir)
  writeFileSync(join(real.dstDir, "foreign.txt"), "not ours")
  expect(await importDestination(real.dst.w, real.move.id)).toMatchObject({ state: "blocked", reason: "native_dest_session_collision" })
  const copy = await destCopy(real.s, real.move)
  expect(ev(copy).failure.detail).toMatchObject({ written: false, dir: "present" })
  expect(ev(copy).promote_intent).toBeUndefined()
  await cleanupCopies(real.dst.w)
  expect(ev(await destCopy(real.s, real.move)).removed).toMatchObject({ removed: "nothing-written" })
  expect(readdirSync(real.dstDir)).toEqual(["foreign.txt"])
  expect(readFileSync(join(real.dstDir, "foreign.txt"), "utf8")).toBe("not ours")
})

test("P2: a directory that appears between the adapter's check and its stage is a refusal after promote_intent: written unknown, and the foreign bytes are neither removed nor reported removed", async () => {
  const real = await realRig({
    beforeStage: (dir) => { mkdirSync(dir); writeFileSync(join(dir, "foreign.txt"), "appeared late") },
  })
  await atReleased(real)
  expect(await importDestination(real.dst.w, real.move.id)).toMatchObject({ state: "blocked", reason: "native_dest_session_collision" })
  const copy = await destCopy(real.s, real.move)
  expect(ev(copy).promote_intent).toBeDefined()
  expect(ev(copy).failure.detail).toMatchObject({ written: "unknown", dir: "present" })
  await cleanupCopies(real.dst.w)
  const left = await destCopy(real.s, real.move)
  expect(left.state).toBe("cleanup_due")
  expect(real.dst.said.at(-1)).toMatchObject({ kind: "move.cleanup-left", detail: { reason: "cleanup-receipt-missing" } })
  expect(readFileSync(join(real.dstDir, "foreign.txt"), "utf8")).toBe("appeared late")
  // The location is still claimed: nothing else may begin there.
  expect((await copiesAtLocation(real.s.tool, { conversation: real.move.conversation_id, machine: "mac" })).map(one => one.state)).toEqual(["cleanup_due"])
})

test("P3: a complete stage an earlier call wrote, refused as a collision on the retry, is NOT nothing-written: the files stay, the failure says unknown and no removal is reported", async () => {
  const real = await realRig(undefined, port => ({
    ...port,
    importSession(input) { port.importSession(input); throw new Crash("stage") },
  }))
  await atReleased(real)
  await expect(importDestination(real.dst.w, real.move.id)).rejects.toBeInstanceOf(Crash)
  const staged = readdirSync(real.dstDir)
  expect(staged).toContain(STAGE_MARKER)
  // The retry sees a directory it can no longer prove it made (its marker was lost): a NativeRefusal whose `written: false` would be a lie.
  unlinkSync(join(real.dstDir, STAGE_MARKER))
  const retry = handoffWorld(real.s, "dest", { port: makeClaudeSessionPort(TABLES, { os: "darwin" }), locks: real.locks, knobs: { build: { version: "2.1.286", capabilities: {} }, sessionDir: () => real.dstDir } })
  expect(await importDestination(retry.w, real.move.id)).toMatchObject({ state: "blocked", reason: "native_dest_session_collision" })
  const copy = await destCopy(real.s, real.move)
  expect(ev(copy).failure.detail.written).toBe("unknown")
  await cleanupCopies(retry.w)
  expect((await destCopy(real.s, real.move)).state).toBe("cleanup_due")
  expect(readdirSync(real.dstDir).length).toBeGreaterThan(0)
  expect(retry.said.at(-1)).toMatchObject({ detail: { reason: "cleanup-receipt-missing" } })
})

test("C1r: a withdrawal after promoted removes exactly what the stage made, by its receipt, and frees the location", async () => {
  const real = await realRig()
  await atReleased(real)
  await crashed(real, "promoted")
  expect(await withdrawMove(real.s.tool, real.move.id, OWNER)).toBe("withdrawn")
  expect(existsSync(real.dstDir)).toBe(true)
  await cleanupCopies(real.dst.w)
  const copy = await destCopy(real.s, real.move)
  expect(copy.state).toBe("removed")
  expect(ev(copy).removed).toMatchObject({ removed: "stage", stage_generation: ev(copy).promoted.receipt.generation })
  expect(existsSync(real.dstDir)).toBe(false)
  await cleanupCopies(real.dst.w)
  expect(await copyRemoved(real.s.tool, real.move.id, real.s.sideOf(real.move, "dest"), 1, { staging: copy.staging_id }, "dest_import")).toBe("replay")
})

test("C3: a transcript appended to since the import stops the discard: nothing is removed and nothing is reported", async () => {
  const real = await realRig()
  await atReleased(real)
  await crashed(real, "promoted")
  const copy = await destCopy(real.s, real.move)
  appendFileSync(transcriptAt(real, copy), '{"type":"user","n":3}\n')
  expect(await withdrawMove(real.s.tool, real.move.id, OWNER)).toBe("withdrawn")
  await cleanupCopies(real.dst.w)
  expect((await destCopy(real.s, real.move)).state).toBe("cleanup_due")
  expect(real.dst.said.at(-1)).toMatchObject({ kind: "move.cleanup-left", detail: { reason: "discard-refused" } })
  expect(readFileSync(transcriptAt(real, copy), "utf8")).toBe(`${TRANSCRIPT.toString()}{"type":"user","n":3}\n`)
})

test("C4: an entry in the stage's root that is not the stage's is stage-ambiguous: not reported, and a second pass (the receipt may be stale after a partial removal) still reports nothing while the directory exists", async () => {
  const real = await realRig()
  await atReleased(real)
  await crashed(real, "promoted")
  writeFileSync(join(real.dstDir, "launch-left-this.txt"), "beside the stage")
  expect(await withdrawMove(real.s.tool, real.move.id, OWNER)).toBe("withdrawn")
  for (const pass of [1, 2]) {
    await cleanupCopies(real.dst.w)
    expect((await destCopy(real.s, real.move)).state, `pass ${pass}`).toBe("cleanup_due")
    expect(readFileSync(join(real.dstDir, "launch-left-this.txt"), "utf8")).toBe("beside the stage")
  }
  expect(real.dst.said.find(one => one.kind === "move.cleanup-left")!.detail).toMatchObject({ reason: "discard-refused" })
})

// ---------------------------------------------------------------------------------------------------------------------
// corrections of the second review: the source's re-checks (F2), the destination's facts (F3), where a stage is (F1), a stage's
// receipt after a failure (S1), the sealed pair (S2) and a launched session (S3)
// ---------------------------------------------------------------------------------------------------------------------

/** A drain whose `which` answer is true for the first `calls - 1` asks of a look and false at the `calls`-th: lost across an await. */
const lostAt = (which: "fenced" | "quiet", calls: number): ProvenDrain => {
  let n = 0
  return { fenced: () => (which === "fenced" ? ++n < calls : true), quiet: () => (which === "quiet" ? ++n < calls : true) }
}

/** The library's receipt with a field of a chosen weight added: how a test makes a receipt exactly as heavy as a limit. */
const padded = (receipt: StageReceipt, pad: string): StageReceipt => ({ ...receipt, pad }) as StageReceipt

/** A release sealed by hand for the fake port's file (what a source that is not `exportSource` could seal), `to` being the pair it names. */
async function sealByHand(r: Rig & { fake: Fake }, to: string) {
  const generation = exportGenerationOf(await r.s.reread(r.move))!
  const nativeSession = await r.s.nativeOf(r.move)
  const exp = r.fake.port.exportSession({ sessionDir: "/unused", nativeSession, version: "9.9.1", limits: MOVE_NATIVE_LIMITS })
  const file = exp.manifest.files[0]
  const by = r.s.sideOf(r.move, "source")
  expect(await putBlob(r.s.tool, r.move.id, by, generation, { kind: "native", path: file.path, mode: file.mode, bytes: exp.bundle.contents.get(contentKey("native", file.path))! })).toBe("stored")
  const manifest = {
    digest: exp.bundle.manifest.digest, files: [{ kind: "native", ...file }], bytes: file.size, native: { native_session: nativeSession, native_manifest_digest: exp.digest },
    portability: { adapter: "fake", from: "linux:9.9.1", to, evidence: "scripted-by-test" }, native_export: exp.manifest, export_generation: generation,
    scope: { carries: "native-only", basis: "test: sealed by hand" },
  }
  expect(await releaseSource(r.s.tool, r.move.id, by, generation, (await checkpointOf(r.s.tool, r.move.conversation_id))!, manifest)).toBe("released")
}

test("V2-F2a: a drain that stops being fenced or quiet while the transcript is read, or while it is stored, ends the look: the bytes read are not stored, the ones stored are not sealed", async () => {
  const r = await rig()
  await prepareDestination(r.dst.w, r.move.id)
  await drainOnly(r.s, r.move)
  for (const which of ["fenced", "quiet"] as const) {
    const before = await blobsOf(r.s, r.move)
    expect(await exportSource(r.src.w, lostAt(which, 2), r.move.id), `${which} lost after the read`).toMatchObject({ state: "waiting", reason: "drain-not-final" })
    expect(await blobsOf(r.s, r.move), `${which}: nothing was stored from a read that began quiet and ended not`).toBe(before)
    expect(await exportSource(r.src.w, lostAt(which, 3), r.move.id), `${which} lost before the release`).toMatchObject({ state: "waiting", reason: "drain-not-final" })
    expect(await blobsOf(r.s, r.move), `${which}: the store holds the bytes of the generation`).toBe(1)
    const now = await r.s.reread(r.move)
    expect(now.stage, which).toBe("waiting")
    expect(now.manifest, which).toBeNull()
  }
  expect(r.fake.log.exports).toBe(4)
  expect(await exportSource(r.src.w, PROVEN, r.move.id), "the next look under a drain that is final reuses the stored bytes").toMatchObject({ state: "done", reason: "released" })
})

test("V2-F2b: a scope proof lost during the read is scope_unproven with nothing stored; one bound to an earlier generation is refused; the proof sealed is the one asked last", async () => {
  const r = await rig()
  await prepareDestination(r.dst.w, r.move.id)
  await drainOnly(r.s, r.move)
  r.src.knobs.duringBuild = async () => { r.src.knobs.duringBuild = null; r.src.knobs.scope = "missing" }
  expect(await exportSource(r.src.w, PROVEN, r.move.id)).toMatchObject({ state: "blocked", reason: "scope_unproven", detail: { reason: "missing" } })
  expect(await blobsOf(r.s, r.move)).toBe(0)
  expect(await r.s.reread(r.move)).toMatchObject({ stage: "waiting", manifest: null, block: { code: "scope_unproven", by: "source" } })

  r.src.knobs.scope = "stale-generation"
  const exportsBefore = r.fake.log.exports
  expect(await exportSource(r.src.w, PROVEN, r.move.id)).toMatchObject({ state: "blocked", reason: "scope_unproven", detail: { reason: "mismatch" } })
  expect(r.fake.log.exports, "a proof of another generation is refused before the disk is read").toBe(exportsBefore)

  r.src.knobs.scope = "ok"
  r.src.knobs.duringBuild = async () => { r.src.knobs.duringBuild = null; r.src.knobs.scopeBasis = "test: proved again after the read" }
  expect(await exportSource(r.src.w, PROVEN, r.move.id)).toMatchObject({ state: "done", reason: "released" })
  const sealed = await r.s.reread(r.move)
  expect(sealed.manifest!.scope).toEqual({ carries: "native-only", basis: "test: proved again after the read" })
  expect(sealed.block).toBeNull()
})

test("V2-F2c: another party's block that appears while the file is read stops the look before anything is stored, and is not cleared; once it is gone the look releases", async () => {
  const r = await rig()
  await prepareDestination(r.dst.w, r.move.id)
  await drainOnly(r.s, r.move)
  r.src.knobs.duringBuild = async () => { r.src.knobs.duringBuild = null; await blockMove(r.s.tool, r.move.id, r.s.sideOf(r.move, "dest"), "dest_hold", {}) }
  expect(await exportSource(r.src.w, PROVEN, r.move.id)).toMatchObject({ state: "waiting", reason: "blocked", detail: { by: "dest", code: "dest_hold" } })
  expect(await blobsOf(r.s, r.move)).toBe(0)
  expect((await r.s.reread(r.move)).block).toMatchObject({ code: "dest_hold", by: "dest" })
  expect(await unblockMove(r.s.tool, r.move.id, r.s.sideOf(r.move, "dest"), "dest_hold")).toBe("cleared")
  expect(await exportSource(r.src.w, PROVEN, r.move.id)).toMatchObject({ state: "done", reason: "released" })
})

test("V2-F2d / S2: destination facts replaced while the file is read end the look with nothing sealed; the next look seals the pair it checked against the facts that stand", async () => {
  const r = await rig()
  await prepareDestination(r.dst.w, r.move.id)
  await drainOnly(r.s, r.move)
  r.src.knobs.duringBuild = async () => {
    r.src.knobs.duringBuild = null
    r.dst.knobs.build = { version: "9.9.4", capabilities: FACTS.capabilities }
    expect(await prepareDestination(r.dst.w, r.move.id)).toMatchObject({ state: "done", reason: "ready" })
  }
  expect(await exportSource(r.src.w, PROVEN, r.move.id)).toMatchObject({ state: "waiting", reason: "dest-facts-changed" })
  expect(await r.s.reread(r.move)).toMatchObject({ stage: "waiting", manifest: null, dest_facts: { native: { version: "9.9.4" } } })
  expect(await exportSource(r.src.w, PROVEN, r.move.id)).toMatchObject({ state: "done", reason: "released" })
  expect((await r.s.reread(r.move)).manifest!.portability).toMatchObject({ from: "linux:9.9.1", to: "darwin:9.9.4" })
  expect(await importDestination(r.dst.w, r.move.id)).toMatchObject({ state: "done", reason: "activated" })
})

test("V2-S2: a sealed pair that is not the side the destination is bound to is refused before anything is written, whatever the facts and the build say", async () => {
  const r = await rig()
  await prepareDestination(r.dst.w, r.move.id)
  await drainOnly(r.s, r.move)
  await sealByHand(r, "darwin:9.9.1")
  expect(await importDestination(r.dst.w, r.move.id)).toMatchObject({ state: "blocked", reason: "native_export_mismatch" })
  const copy = await destCopy(r.s, r.move)
  expect(ev(copy).failure.detail).toMatchObject({ why: "portability-destination", sealed: "darwin:9.9.1", bound: "darwin:9.9.2", written: false })
  expect(r.fake.log.imports).toEqual([])
  expect(r.fake.log.writes).toBe(0)
})

test("V2-F3a: new -> preflight -> the engine starts the conversation -> the source blocks on the missing native side -> a second preflight replaces the facts -> the source releases; no block of the other side is touched", async () => {
  const r = await rig({ started: false })
  expect(await prepareDestination(r.dst.w, r.move.id)).toMatchObject({ state: "done", reason: "ready" })
  expect((await r.s.reread(r.move)).dest_facts).toMatchObject({ native: null })
  await r.s.su`update conversation set native_state = 'started' where id = ${r.move.conversation_id}`
  await drainOnly(r.s, r.move)

  expect(await exportSource(r.src.w, PROVEN, r.move.id)).toMatchObject({ state: "blocked", reason: "native_dest_facts_missing", detail: { native_state: "started", recorded: "no-native-side" } })
  expect(await blobsOf(r.s, r.move)).toBe(0)
  expect(r.fake.log.exports).toBe(0)
  expect((await r.s.reread(r.move)).block).toMatchObject({ code: "native_dest_facts_missing", by: "source" })

  // The destination asks again: its facts replace the old ones and the source's block is left standing for the source to clear.
  expect(await prepareDestination(r.dst.w, r.move.id)).toMatchObject({ state: "done", reason: "ready" })
  const asked = await r.s.reread(r.move)
  expect(asked.dest_facts).toMatchObject({ native: { os: "darwin", cwd: fakeDir(r.move), version: "9.9.2" } })
  expect(asked.block).toMatchObject({ code: "native_dest_facts_missing", by: "source" })

  expect(await exportSource(r.src.w, PROVEN, r.move.id)).toMatchObject({ state: "done", reason: "released" })
  const sealed = await r.s.reread(r.move)
  expect(sealed.block).toBeNull()
  expect(sealed.manifest!.portability).toMatchObject({ to: "darwin:9.9.2" })
  expect(await importDestination(r.dst.w, r.move.id)).toMatchObject({ state: "done", reason: "activated" })
})

test("V2-F3b: the second preflight REFUSES the path: the destination's reason is recorded in its facts without touching the source's block, and the source restates it in its own, so the owner reads the truth", async () => {
  const r = await rig({ started: false })
  await prepareDestination(r.dst.w, r.move.id)
  await r.s.su`update conversation set native_state = 'started' where id = ${r.move.conversation_id}`
  await drainOnly(r.s, r.move)
  expect(await exportSource(r.src.w, PROVEN, r.move.id)).toMatchObject({ state: "blocked", reason: "native_dest_facts_missing" })

  r.dst.knobs.sessionDir = move => `${fakeDir(move)}/dotted.dir`
  expect(await prepareDestination(r.dst.w, r.move.id)).toMatchObject({ state: "waiting", reason: "block-occupied", detail: { code: "native_locator_unsupported_path", recorded: true } })
  const refused = await r.s.reread(r.move)
  expect(refused.block, "the source's block is not stolen or overwritten").toMatchObject({ code: "native_dest_facts_missing", by: "source" })
  expect(refused.dest_facts).toMatchObject({ native: null, native_refusal: { code: "native_locator_unsupported_path" } })

  expect(await exportSource(r.src.w, PROVEN, r.move.id)).toMatchObject({ state: "blocked", reason: "native_dest_refused", detail: { code: "native_locator_unsupported_path" } })
  expect((await r.s.reread(r.move)).block).toMatchObject({ code: "native_dest_refused", by: "source", detail: { code: "native_locator_unsupported_path" } })
  expect(await blobsOf(r.s, r.move)).toBe(0)
  expect(r.fake.log.exports).toBe(0)

  // The destination never owned a block through any of it; a path it accepts replaces the refusal and the source releases.
  r.dst.knobs.sessionDir = fakeDir
  expect(await prepareDestination(r.dst.w, r.move.id)).toMatchObject({ state: "done", reason: "ready" })
  expect((await r.s.reread(r.move)).dest_facts).toMatchObject({ native: { cwd: fakeDir(r.move) } })
  expect(await exportSource(r.src.w, PROVEN, r.move.id)).toMatchObject({ state: "done", reason: "released" })
  expect((await r.s.reread(r.move)).block).toBeNull()
})

test("V2-S3: a launched session is a named gate of the source: nothing is read, sealed, replaced or minted, and it clears itself once the engine has moved the state on; a manifest of one is not imported", async () => {
  const r = await rig()
  await r.s.su`update conversation set native_state = 'launched' where id = ${r.move.conversation_id}`
  const before = (await r.s.su`select native_session, native_state from conversation where id = ${r.move.conversation_id}`)[0]
  expect(await prepareDestination(r.dst.w, r.move.id)).toMatchObject({ state: "done", reason: "ready" })
  await drainOnly(r.s, r.move)
  expect(await exportSource(r.src.w, PROVEN, r.move.id)).toMatchObject({ state: "blocked", reason: "native_state_launched", detail: { native_state: "launched" } })
  expect(await exportSource(r.src.w, PROVEN, r.move.id), "a second look repeats the same gate").toMatchObject({ state: "blocked", reason: "native_state_launched" })
  expect(r.fake.log.exports).toBe(0)
  expect(await blobsOf(r.s, r.move)).toBe(0)
  expect(await r.s.reread(r.move)).toMatchObject({ stage: "waiting", manifest: null, block: { code: "native_state_launched", by: "source" } })
  expect((await r.s.su`select native_session, native_state from conversation where id = ${r.move.conversation_id}`)[0], "no session was minted in its place").toEqual(before)

  await r.s.su`update conversation set native_state = 'started' where id = ${r.move.conversation_id}`
  expect(await exportSource(r.src.w, PROVEN, r.move.id)).toMatchObject({ state: "done", reason: "released" })
  expect((await r.s.reread(r.move)).block).toBeNull()

  const hand = await rig()
  await prepareDestination(hand.dst.w, hand.move.id)
  await hand.s.su`update conversation set native_state = 'launched' where id = ${hand.move.conversation_id}`
  await drainOnly(hand.s, hand.move)
  await sealByHand(hand, "darwin:9.9.2")
  expect(await importDestination(hand.dst.w, hand.move.id)).toMatchObject({ state: "blocked", reason: "native_state_launched" })
  expect(ev(await destCopy(hand.s, hand.move)).failure.detail).toMatchObject({ native_state: "launched", written: false })
  expect(hand.fake.log.imports).toEqual([])
})

test("V2-F1a: a session directory rule that changed since the import leaves a copy with no receipt: the new path being absent frees nothing; the recorded one is what is looked at", async () => {
  const r = await rig()
  await atReleased(r)
  await crashed(r, "promote_intent")
  expect(await withdrawMove(r.s.tool, r.move.id, OWNER)).toBe("withdrawn")
  r.dst.knobs.sessionDir = move => `${fakeDir(move)}-under-the-new-rule`
  await cleanupCopies(r.dst.w)
  expect((await destCopy(r.s, r.move)).state).toBe("cleanup_due")
  expect(r.dst.said.at(-1)).toMatchObject({ kind: "move.cleanup-left", detail: { reason: "session-dir-changed", of: "promote_intent", recorded: fakeDir(r.move) } })
  expect(r.fake.log.discards).toEqual([])
  expect((await copiesAtLocation(r.s.tool, { conversation: r.move.conversation_id, machine: "mac" })).map(one => one.state)).toEqual(["cleanup_due"])

  r.dst.knobs.sessionDir = fakeDir
  await cleanupCopies(r.dst.w)
  expect(ev(await destCopy(r.s, r.move)).removed).toMatchObject({ removed: "absent" })
})

test("V2-F1b: with a receipt, a stage-stale discard is `absent` only at the path the receipt and the import recorded; a rule or a receipt that names another path leaves the copy, before any discard", async () => {
  const r = await promotedAndWithdrawn()
  r.fake.behavior.discardRefuses = new TransferError("stage-stale")
  r.dst.knobs.sessionDir = move => `${fakeDir(move)}-under-the-new-rule`
  await cleanupCopies(r.dst.w)
  expect((await destCopy(r.s, r.move)).state).toBe("cleanup_due")
  expect(r.dst.said.at(-1)).toMatchObject({ kind: "move.cleanup-left", detail: { reason: "session-dir-changed" } })

  // The rule is what it was, but the receipt names a real path that is not where the rule puts the session.
  r.dst.knobs.sessionDir = fakeDir
  await r.s.su`update move_copy set evidence = jsonb_set(evidence, '{promoted,receipt,destination}', '"/elsewhere"') where move_id = ${r.move.id} and kind = 'dest_import'`
  const again = handoffWorld(r.s, "dest", { port: r.fake.port, locks: r.locks })
  await cleanupCopies(again.w)
  expect((await destCopy(r.s, r.move)).state).toBe("cleanup_due")
  expect(again.said.at(-1)).toMatchObject({ kind: "move.cleanup-left", detail: { reason: "session-dir-changed", of: "receipt", recorded: "/elsewhere" } })
  expect(r.fake.log.discards).toEqual([])

  await r.s.su`update move_copy set evidence = jsonb_set(evidence, '{promoted,receipt,destination}', to_jsonb(${fakeDir(r.move)}::text)) where move_id = ${r.move.id} and kind = 'dest_import'`
  await cleanupCopies(handoffWorld(r.s, "dest", { port: r.fake.port, locks: r.locks }).w)
  expect(ev(await destCopy(r.s, r.move)).removed).toMatchObject({ removed: "absent" })
})

test("V2-F1c: a real stage is never reported removed, nor discarded, because the session directory rule now names another path; at its own path it is removed by its receipt", async () => {
  const real = await realRig()
  await atReleased(real)
  await crashed(real, "promoted")
  expect(await withdrawMove(real.s.tool, real.move.id, OWNER)).toBe("withdrawn")
  const elsewhere = join(dirname(real.dstDir), "elsewhere")
  real.dst.knobs.sessionDir = () => elsewhere
  await cleanupCopies(real.dst.w)
  expect((await destCopy(real.s, real.move)).state).toBe("cleanup_due")
  expect(real.dst.said.at(-1)).toMatchObject({ kind: "move.cleanup-left", detail: { reason: "session-dir-changed" } })
  expect(existsSync(real.dstDir)).toBe(true)

  real.dst.knobs.sessionDir = () => real.dstDir
  await cleanupCopies(real.dst.w)
  expect(ev(await destCopy(real.s, real.move)).removed).toMatchObject({ removed: "stage" })
  expect(existsSync(real.dstDir)).toBe(false)
})

test("V2-S1a: a withdrawal that lands between promote_intent and promoted does not lose the stage: it is removed by the receipt in hand, under the lock already held, through the one cleanup", async () => {
  const real = await realRig()
  await atReleased(real)
  real.dst.knobs.afterSay = async (kind, detail) => {
    if (kind !== "move.import-step" || detail.step !== "imported") return
    real.dst.knobs.afterSay = null
    expect(await withdrawMove(real.s.tool, real.move.id, OWNER)).toBe("withdrawn")
  }
  real.locks.events.length = 0
  const outcome = await Promise.race([importDestination(real.dst.w, real.move.id), Bun.sleep(5_000).then(() => "deadlock" as const)])
  expect(outcome).toMatchObject({ state: "waiting", reason: "terminal", detail: { step: "promoted", cleanup: "removed:stage" } })
  expect(real.locks.events).toEqual([`enter:${real.move.conversation_id}`, `exit:${real.move.conversation_id}`])
  expect(existsSync(real.dstDir)).toBe(false)
  const copy = await destCopy(real.s, real.move)
  expect(copy.state).toBe("removed")
  expect(ev(copy).removed).toMatchObject({ removed: "stage", staging: copy.staging_id })
  expect(ev(copy).promoted).toBeUndefined()
})

test("V2-S1b: that same removal asks every guard of any removal, not idle alone; refused, the stage stays, and with no receipt anywhere it is the explicit gate that holds it", async () => {
  const real = await realRig()
  await atReleased(real)
  real.dst.knobs.idle = false
  real.dst.knobs.afterSay = async (kind, detail) => {
    if (kind !== "move.import-step" || detail.step !== "imported") return
    real.dst.knobs.afterSay = null
    expect(await withdrawMove(real.s.tool, real.move.id, OWNER)).toBe("withdrawn")
  }
  expect(await importDestination(real.dst.w, real.move.id)).toMatchObject({ state: "waiting", reason: "terminal", detail: { cleanup: "left:live-child" } })
  expect(existsSync(real.dstDir)).toBe(true)
  expect((await destCopy(real.s, real.move)).state).toBe("cleanup_due")

  // The conversation placed on this machine is a refusal of its own, whatever the child says.
  real.dst.knobs.idle = true
  await real.s.su`update conversation set machine = 'mac' where id = ${real.move.conversation_id}`
  await cleanupCopies(real.dst.w)
  expect(real.dst.said.at(-1)).toMatchObject({ detail: { reason: "placed-here" } })
  await real.s.su`update conversation set machine = 'pi' where id = ${real.move.conversation_id}`

  // Nothing durable names the stage: a directory that is there is left, said as what it is.
  await cleanupCopies(real.dst.w)
  expect((await destCopy(real.s, real.move)).state).toBe("cleanup_due")
  expect(real.dst.said.at(-1)).toMatchObject({ kind: "move.cleanup-left", detail: { reason: "cleanup-receipt-missing", dir: "present" } })
  expect(readdirSync(real.dstDir)).toContain(STAGE_MARKER)
})

test("V2-S1c: the checks after the stage fail: the failure carries the whole receipt and the cleanup removes exactly that stage by it", async () => {
  const real = await realRig(undefined, port => ({
    ...port,
    importSession(input) {
      const out = port.importSession(input)
      return { ...out, transcript: { ...out.transcript, size: out.transcript.size + 1 } }
    },
  }))
  await atReleased(real)
  expect(await importDestination(real.dst.w, real.move.id)).toMatchObject({ state: "blocked", reason: "native_import_unverified" })
  const copy = await destCopy(real.s, real.move)
  const detail = ev(copy).failure.detail
  expect(detail).toMatchObject({ why: "transcript", written: "unknown" })
  expect(detail.receipt).toMatchObject({ operation: copy.staging_id, destination: realpathSync(real.dstDir) })
  expect(jsonbBytes(detail)).toBeLessThanOrEqual(2048)
  expect(existsSync(real.dstDir)).toBe(true)

  await cleanupCopies(real.dst.w)
  const removed = await destCopy(real.s, real.move)
  expect(removed.state).toBe("removed")
  expect(ev(removed).removed).toMatchObject({ removed: "stage", stage_generation: detail.receipt.generation })
  expect(existsSync(real.dstDir)).toBe(false)
})

test("V2-S1d: a receipt rides the failure exactly while the store's limit takes it (2048 bytes, measured as jsonb text), whole; one byte more and it is not carried, said so, and the directory is left", async () => {
  for (const target of [2048, 2049]) {
    const dir = join(scratch(), "d")
    const r = await rig({ dir })
    await atReleased(r)
    const wrapped: NativeSessionPort = {
      ...r.fake.port,
      importSession(input) {
        const out = r.fake.port.importSession(input)
        const fixed = jsonbBytes({ why: "transcript", dir: "absent", written: "unknown", receipt: padded(out.receipt, "") })
        return { ...out, transcript: { ...out.transcript, size: out.transcript.size + 1 }, receipt: padded(out.receipt, "x".repeat(target - fixed)) }
      },
    }
    const fat = handoffWorld(r.s, "dest", { port: wrapped, locks: r.locks, knobs: { sessionDir: () => dir } })
    expect(await importDestination(fat.w, r.move.id), `${target}`).toMatchObject({ state: "blocked", reason: "native_import_unverified" })
    const copy = await destCopy(r.s, r.move)
    const detail = ev(copy).failure.detail
    if (target === 2048) {
      expect(jsonbBytes(detail), "the report is exactly as heavy as the store allows").toBe(2048)
      expect(detail.receipt, "whole: every field the library made, the destination included").toMatchObject({ ...r.fake.staged.get(dir)! })
      expect(detail.receipt.destination).toBe(dir)
      expect(detail.receipt_unrecorded).toBeUndefined()
      await cleanupCopies(fat.w)
      expect(ev(await destCopy(r.s, r.move)).removed).toMatchObject({ removed: "stage" })
    } else {
      expect(detail).toMatchObject({ why: "transcript", written: "unknown", receipt_unrecorded: true })
      expect(detail.receipt).toBeUndefined()
      mkdirSync(dir)
      writeFileSync(join(dir, "the-stage-nothing-names.txt"), "stage")
      await cleanupCopies(fat.w)
      expect((await destCopy(r.s, r.move)).state).toBe("cleanup_due")
      expect(fat.said.at(-1)).toMatchObject({ kind: "move.cleanup-left", detail: { reason: "cleanup-receipt-missing", dir: "present", receipt_unrecorded: true } })
      expect(r.fake.log.discards).toEqual([])
      expect(readFileSync(join(dir, "the-stage-nothing-names.txt"), "utf8")).toBe("stage")
    }
  }
})

/**
 * The fake port with a receipt padded so that the copy's evidence at the END of its life weighs `COPY_EVIDENCE_LIMIT + over` bytes: what the
 * copy held at `promote_intent` (`held.evidence`, filled by the test), the promoted evidence this receipt makes, and the removal's record.
 */
function fatPromoted(r: Rig & { fake: Fake }, held: { evidence: Record<string, unknown> }, over: number): NativeSessionPort {
  return {
    ...r.fake.port,
    importSession(input) {
      const out = r.fake.port.importSession(input)
      const promoted = (pad: string) => ({
        receipt: padded(out.receipt, pad), bundle_digest: out.bundle_digest, to: out.to, transcript: out.transcript, reused: out.reused, native_manifest_digest: out.native_manifest_digest,
      })
      const fixed = lifetimeBytes(held.evidence, [{ promoted: promoted("") }], { staging: input.operation, incarnation: "dst-1", generation: out.receipt.generation })
      return { ...out, receipt: padded(out.receipt, "x".repeat(COPY_EVIDENCE_LIMIT + over - fixed)) }
    },
  }
}
const heldAtIntent = (r: Rig, held: { evidence: Record<string, unknown> }) => async (kind: string, detail: Record<string, unknown>) => {
  if (kind === "move.import-step" && detail.step === "promote_intent") held.evidence = (await destCopy(r.s, r.move)).evidence
}

/** What the DATABASE says the copy's evidence would weigh if `removed` (a report of `staging`, as `copyRemoved` is given it) were merged in now. */
async function weightWithRemoval(s: MoveFixture, move: MoveRow, copy: MoveCopyRow, removed: "stage" | "absent" | "nothing-written", generation: string | null): Promise<number> {
  const report = removalReport(copy.staging_id, removed, generation, "dst-1")
  const rows = (await s.su.unsafe(
    "select octet_length((evidence || jsonb_build_object('removed', $2::text::jsonb || jsonb_build_object('by', $3::text)))::text) as n from move_copy where move_id = $1 and kind = 'dest_import'",
    [move.id, JSON.stringify(report), "dst-1"] as never[],
  )) as { n: number }[]
  return Number(rows[0].n)
}

test("V2-S1e: the promoted evidence must fit the copy's 8 KiB WITH what verified and promote_intent kept AND the removal's record that follows: exactly that is stored, one byte more is a named failure that is not a store error", async () => {
  for (const over of [0, 1]) {
    const dir = join(scratch(), "d")
    const r = await rig({ dir })
    await atReleased(r)
    const held = { evidence: {} as Record<string, unknown> }
    const fat = handoffWorld(r.s, "dest", { port: fatPromoted(r, held, over), locks: r.locks, knobs: { sessionDir: () => dir } })
    fat.knobs.afterSay = heldAtIntent(r, held)
    const step = await importDestination(fat.w, r.move.id)
    const copy = await destCopy(r.s, r.move)
    if (over === 0) {
      expect(step).toMatchObject({ state: "done", reason: "activated" })
      // The store's own measure of the evidence once the heaviest removal is merged in: the whole lifetime fits to the byte, and no more.
      expect(await weightWithRemoval(r.s, r.move, copy, "nothing-written", ev(copy).promoted.receipt.generation)).toBe(COPY_EVIDENCE_LIMIT)
    } else {
      expect(step).toMatchObject({ state: "blocked", reason: "native_import_unverified" })
      expect(ev(copy).failure.detail).toMatchObject({ why: "evidence-size", written: "unknown", receipt_unrecorded: true })
      expect(copy.state).toBe("cleanup_due")
    }
  }
})

test("V2-S1f: a stage a crashed call made, with no receipt anywhere, stays ambiguous after a withdrawal: left, never nothing-written", async () => {
  const real = await realRig(undefined, port => ({
    ...port,
    importSession(input) { port.importSession(input); throw new Crash("stage") },
  }))
  await atReleased(real)
  await expect(importDestination(real.dst.w, real.move.id)).rejects.toBeInstanceOf(Crash)
  expect(await withdrawMove(real.s.tool, real.move.id, OWNER)).toBe("withdrawn")
  await cleanupCopies(real.dst.w)
  const copy = await destCopy(real.s, real.move)
  expect(copy.state).toBe("cleanup_due")
  expect(ev(copy).removed).toBeUndefined()
  expect(real.dst.said.at(-1)).toMatchObject({ kind: "move.cleanup-left", detail: { reason: "cleanup-receipt-missing", dir: "present" } })
  expect(readdirSync(real.dstDir)).toContain(STAGE_MARKER)
})

test("V2-B: the byte count the limits are checked with is the store's own: jsonbBytes equals octet_length(jsonb::text) for what a handoff writes", async () => {
  const s = await stage()
  const values: unknown[] = [
    {}, [], [[], {}], { a: 1 }, { a: "é€😀", b: [1, 2, { c: null }], d: true }, "quote\" back\\ nl\n tab\t ctl\u0001 del\u007f", { "k e y": { x: "" } },
    12345, -7, false, null, { ids: ["a", "b", "c"], nested: { deep: { deeper: [0, 1, 2] } } },
  ]
  for (const value of values) {
    // Through text, so the driver does not encode the document a second time.
    const rows = (await s.su.unsafe("select octet_length($1::text::jsonb::text) as n", [JSON.stringify(value)] as never[])) as { n: number }[]
    expect(jsonbBytes(value), JSON.stringify(value)).toBe(Number(rows[0].n))
  }
})

// ---------------------------------------------------------------------------------------------------------------------
// the two blockers of the third review: the copy's evidence has ONE lifetime budget (the removal's own record included), and the
// diagnostics are cut on whole code points
// ---------------------------------------------------------------------------------------------------------------------

const sizeOfEvidence = async (s: MoveFixture, move: MoveRow) =>
  Number((await s.su`select octet_length(evidence::text) as n from move_copy where move_id = ${move.id} and kind = 'dest_import'`)[0].n)

test("V4-R1: promoted evidence that fills the column as far as the budget allows is still removable: crash after promoted, withdrawal, cleanup commit the removal, and a repeat changes nothing", async () => {
  const dir = join(scratch(), "d")
  const r = await rig({ dir })
  await atReleased(r)
  const held = { evidence: {} as Record<string, unknown> }
  const fat = handoffWorld(r.s, "dest", { port: fatPromoted(r, held, 0), locks: r.locks, knobs: { sessionDir: () => dir } })
  fat.knobs.afterSay = heldAtIntent(r, held)
  fat.knobs.crashOn = crashAfter("promoted")
  await expect(importDestination(fat.w, r.move.id)).rejects.toBeInstanceOf(Crash)
  fat.knobs.crashOn = null
  expect(await withdrawMove(r.s.tool, r.move.id, OWNER)).toBe("withdrawn")
  await cleanupCopies(fat.w)

  const copy = await destCopy(r.s, r.move)
  expect(copy.state).toBe("removed")
  expect(ev(copy).removed).toMatchObject({ removed: "stage", staging: copy.staging_id })
  // The reserve is for the longest word ("nothing-written"); the report that was made says "stage": ten bytes under the column's limit.
  const size = await sizeOfEvidence(r.s, r.move)
  expect(size).toBeLessThanOrEqual(COPY_EVIDENCE_LIMIT)
  expect(size).toBeGreaterThan(COPY_EVIDENCE_LIMIT - 64)
  expect(r.fake.staged.size).toBe(0)
  await cleanupCopies(fat.w)
  await cleanupCopies(fat.w)
  expect(r.fake.log.discards.length).toBe(1)
  expect(fat.said.filter(one => one.kind === "move.cleanup-removed")).toHaveLength(1)
})

test("V4-R2: a copy whose evidence has no room for its removal's record is never discarded: it is left, named once, with no repeated delete and no throw, and it goes as soon as there is room", async () => {
  const r = await promotedAndWithdrawn()
  const held = (await destCopy(r.s, r.move)).evidence
  // Recorded before the budget existed: full to within five bytes of the column's limit, which the column itself accepts.
  const n = COPY_EVIDENCE_LIMIT - 5 - jsonbBytes({ ...held, pad: "" })
  await r.s.su`update move_copy set evidence = evidence || jsonb_build_object('pad', repeat('x', ${n}::int)) where move_id = ${r.move.id} and kind = 'dest_import'`
  expect(await sizeOfEvidence(r.s, r.move)).toBe(COPY_EVIDENCE_LIMIT - 5)

  for (let again = 0; again < 3; again++) await cleanupCopies(r.dst.w)
  expect((await destCopy(r.s, r.move)).state).toBe("cleanup_due")
  expect(r.fake.log.discards, "nothing was discarded, so nothing is repeated").toEqual([])
  expect(r.fake.staged.size).toBe(1)
  expect(r.dst.said.filter(one => one.kind === "move.cleanup-left" && one.detail.reason === "evidence-budget")).toHaveLength(1)
  expect(r.dst.said.at(-1)).toMatchObject({ kind: "move.cleanup-left", detail: { reason: "evidence-budget", limit: COPY_EVIDENCE_LIMIT } })
  expect((await copiesAtLocation(r.s.tool, { conversation: r.move.conversation_id, machine: "mac" })).map(one => one.state)).toEqual(["cleanup_due"])

  await r.s.su`update move_copy set evidence = evidence - 'pad' where move_id = ${r.move.id} and kind = 'dest_import'`
  await cleanupCopies(r.dst.w)
  expect(ev(await destCopy(r.s, r.move)).removed).toMatchObject({ removed: "stage" })
  expect(r.fake.log.discards.length).toBe(1)
})

test("V4-R3: evidence too full for even the small named failure is not written at all: the refusal is this side's named block, nothing is staged, nothing throws (repeated or not), and the removal is left named too", async () => {
  const r = await rig()
  await atReleased(r)
  await crashed(r, "verified")
  const held = (await destCopy(r.s, r.move)).evidence
  expect((await destCopy(r.s, r.move)).state).toBe("verified")
  const n = 8100 - jsonbBytes({ ...held, pad: "" })
  await r.s.su`update move_copy set evidence = evidence || jsonb_build_object('pad', repeat('x', ${n}::int)) where move_id = ${r.move.id} and kind = 'dest_import'`

  expect(await importDestination(r.dst.w, r.move.id)).toMatchObject({ state: "blocked", reason: "native_evidence_budget", detail: { code: "native_evidence_budget", written: false } })
  const after = await destCopy(r.s, r.move)
  expect(after.state, "no failure was merged: the column would have refused it").toBe("verified")
  expect(ev(after).failure).toBeUndefined()
  expect(r.fake.log.imports, "nothing was staged").toEqual([])
  expect((await r.s.reread(r.move)).block).toMatchObject({ code: "native_evidence_budget", by: "dest" })
  expect(await importDestination(r.dst.w, r.move.id)).toMatchObject({ state: "waiting", reason: "blocked" })
  expect(r.fake.log.imports).toEqual([])

  expect(await withdrawMove(r.s.tool, r.move.id, OWNER)).toBe("withdrawn")
  await cleanupCopies(r.dst.w)
  await cleanupCopies(r.dst.w)
  expect((await destCopy(r.s, r.move)).state).toBe("cleanup_due")
  expect(r.dst.said.at(-1)).toMatchObject({ kind: "move.cleanup-left", detail: { reason: "evidence-budget" } })
})

// A path through links that is far longer than the real one it names. The adapter bounds the REAL path (its tables, `placeAt`); the string a
// launch is given, normalized and absolute, is recorded in the evidence twice (`verified` and `promote_intent`) whatever it weighs. Linux
// only: macOS refuses a path of this length (PATH_MAX is 1024 there), so it cannot make one.
const onLinux = process.platform === "linux"

/** A normalized path of exactly `bytes` characters that reaches `${dir}/${leaf}` through links: every component between is a link to `.`, so the string is long and the real path is not. */
function aliasThrough(dir: string, leaf: string, bytes: number): string {
  let rest = bytes - dir.length - 1 - leaf.length
  const names: string[] = []
  while (rest > 256) { names.push("a".repeat(200)); rest -= 201 }
  if (rest === 1) throw new Error("no component weighs one character with its slash")
  if (rest >= 2) names.push("b".repeat(rest - 1))
  for (const name of new Set(names)) symlinkSync(".", join(dir, name))
  return [dir, ...names, leaf].join("/")
}

/** The real port taken from `released` to the END of a copy's life (promoted, crash, withdrawal, cleanup) with the session directory spelled as a link alias of `bytes` characters. */
async function lifeThroughAlias(bytes: number) {
  const real = await realRig()
  const alias = aliasThrough(dirname(real.dstDir), "dst", bytes)
  real.dst.knobs.sessionDir = () => alias
  await atReleased(real)
  await crashed(real, "promoted")
  expect(await withdrawMove(real.s.tool, real.move.id, OWNER)).toBe("withdrawn")
  await cleanupCopies(real.dst.w)
  return { real, alias, copy: await destCopy(real.s, real.move), size: await sizeOfEvidence(real.s, real.move) }
}

/** The weight of a whole life at the shortest alias (the real path itself): everything but the alias is the same at any length, and the alias is in the evidence twice. */
let calibrated: Promise<{ chars: number; size: number }> | null = null
const calibration = () => (calibrated ??= lifeThroughAlias(0).then(one => ({ chars: one.alias.length, size: one.size })))

test.skipIf(!onLinux)("V4-A1: a long normalized alias that resolves through links to a short supported directory is recorded whole, a life that nearly fills the column is removable, and a repeat changes nothing", async () => {
  const small = await calibration()
  const chars = small.chars + Math.floor((COPY_EVIDENCE_LIMIT - 250 - small.size) / 2)
  const near = await lifeThroughAlias(chars)
  expect(near.alias.length).toBe(chars)
  expect(near.alias.length).toBeGreaterThan(2 * near.real.dstDir.length)
  expect(near.size).toBeGreaterThan(COPY_EVIDENCE_LIMIT - 300)
  expect(near.size).toBeLessThanOrEqual(COPY_EVIDENCE_LIMIT)

  expect(near.copy.state).toBe("removed")
  expect(ev(near.copy).removed).toMatchObject({ removed: "stage", staging: near.copy.staging_id })
  // Identity is never clipped to make room: the alias is in the evidence exactly as given, the receipt names the short real path.
  expect(ev(near.copy).session_dir).toBe(near.alias)
  expect(ev(near.copy).promote_intent.session_dir).toBe(near.alias)
  expect(ev(near.copy).promoted.receipt.destination).toBe(near.real.dstDir)
  expect(ev(near.copy).promoted.to.cwd).toBe(near.real.dstDir)
  expect(existsSync(near.real.dstDir)).toBe(false)

  await cleanupCopies(near.real.dst.w)
  await cleanupCopies(near.real.dst.w)
  expect(near.real.dst.said.filter(one => one.kind === "move.cleanup-removed")).toHaveLength(1)
  expect((await destCopy(near.real.s, near.real.move)).state).toBe("removed")
})

test.skipIf(!onLinux)("V4-A2: with that alias a receipt-bearing failure near the limit is removed by its receipt, and one alias longer is refused BEFORE anything is staged by a small named failure that is recorded and removable", async () => {
  const small = await calibration()

  let calls = 0
  const failing = await realRig(undefined, port => ({
    ...port,
    importSession(input) {
      calls += 1
      const out = port.importSession(input)
      return { ...out, transcript: { ...out.transcript, size: out.transcript.size + 1 } }
    },
  }))
  const near = aliasThrough(dirname(failing.dstDir), "dst", small.chars + Math.floor((COPY_EVIDENCE_LIMIT - 250 - small.size) / 2))
  failing.dst.knobs.sessionDir = () => near
  await atReleased(failing)
  expect(await importDestination(failing.dst.w, failing.move.id)).toMatchObject({ state: "blocked", reason: "native_import_unverified" })
  expect(calls).toBe(1)
  const failed = await destCopy(failing.s, failing.move)
  expect(failed.state).toBe("cleanup_due")
  expect(ev(failed).failure.detail.receipt).toMatchObject({ operation: failed.staging_id, destination: failing.dstDir })
  expect(ev(failed).failure.detail.receipt_unrecorded).toBeUndefined()
  expect(existsSync(failing.dstDir)).toBe(true)
  await cleanupCopies(failing.dst.w)
  expect(ev(await destCopy(failing.s, failing.move)).removed).toMatchObject({ removed: "stage", stage_generation: ev(failed).failure.detail.receipt.generation })
  expect(existsSync(failing.dstDir)).toBe(false)
  expect(await sizeOfEvidence(failing.s, failing.move)).toBeLessThanOrEqual(COPY_EVIDENCE_LIMIT)

  let staged = 0
  const over = await realRig(undefined, port => ({ ...port, importSession(input) { staged += 1; return port.importSession(input) } }))
  const tooLong = aliasThrough(dirname(over.dstDir), "dst", small.chars + Math.ceil((COPY_EVIDENCE_LIMIT + 60 - small.size) / 2))
  over.dst.knobs.sessionDir = () => tooLong
  await atReleased(over)
  const step = await importDestination(over.dst.w, over.move.id)
  expect(step).toMatchObject({ state: "blocked", reason: "native_evidence_budget", detail: { why: "lifecycle", limit: COPY_EVIDENCE_LIMIT, written: false } })
  expect((step.detail as Record<string, number>).bytes).toBeGreaterThan(COPY_EVIDENCE_LIMIT)
  expect(staged, "the port was never asked to stage").toBe(0)
  expect(existsSync(over.dstDir)).toBe(false)
  const refused = await destCopy(over.s, over.move)
  expect(refused.state).toBe("cleanup_due")
  expect(ev(refused).failure).toMatchObject({ code: "native_evidence_budget" })
  expect(ev(refused).session_dir, "`verified` was never recorded: its words are the evidence's own keys").toBeUndefined()
  expect(ev(refused).promote_intent).toBeUndefined()
  expect((await over.s.reread(over.move)).block).toMatchObject({ code: "native_evidence_budget", by: "dest" })
  await cleanupCopies(over.dst.w)
  expect(ev(await destCopy(over.s, over.move)).removed).toMatchObject({ removed: "nothing-written" })
})

/** No lone surrogate: what jsonb refuses (a UTF-16 cut in the middle of an emoji leaves one). */
const wellFormed = (text: string) => !/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(text)
const LEGAL_NAME = `${"a".repeat(232)}😀`

test("V4-C1: clip cuts between whole code points by the bytes jsonb prints, and a text that fits comes back as it is", () => {
  expect(clip(undefined)).toBeNull()
  expect(clip("config/projects")).toBe("config/projects")
  expect(clip("a".repeat(240))).toBe("a".repeat(240))
  expect(clip("a".repeat(241))).toBe(`${"a".repeat(240)}...`)
  // The legal basename of a real unsupported entry: 236 bytes, a 241-unit path. The old cut at 240 units kept the emoji's high half.
  const path = `config/${LEGAL_NAME}`
  expect(path.length).toBe(241)
  expect(wellFormed(path)).toBe(true)
  expect(clip(path)).toBe(`config/${"a".repeat(232)}...`)
  expect(clip("😀".repeat(100))).toBe(`${"😀".repeat(60)}...`)
  expect(clip("é".repeat(300))).toBe(`${"é".repeat(120)}...`)
  expect(clip("\u0001".repeat(100))).toBe(`${"\u0001".repeat(40)}...`)
  for (let n = 200; n < 260; n++) expect(wellFormed(clip(`${"a".repeat(n)}😀😀`)!), `${n}`).toBe(true)
})

test("V4-C2: a real unsupported side-state entry whose legal name ends in an emoji persists as the source's named block with a valid, clipped path; the destination's refusal and a failure take the same cut", async () => {
  const real = await realRig()
  writeFileSync(join(real.srcDir, "config", LEGAL_NAME), "side state")
  expect(await prepareDestination(real.dst.w, real.move.id)).toMatchObject({ state: "done" })
  await drainOnly(real.s, real.move)
  expect(await exportSource(real.src.w, PROVEN, real.move.id)).toMatchObject({ state: "blocked", reason: "native_side_state_unsupported" })
  const block = (await real.s.reread(real.move)).block!
  expect(block).toMatchObject({ code: "native_side_state_unsupported", by: "source" })
  expect((block.detail as { path: string }).path).toBe(`config/${"a".repeat(232)}...`)
  expect(wellFormed((block.detail as { path: string }).path)).toBe(true)
  expect(await blobsOf(real.s, real.move)).toBe(0)

  const long = `config/${LEGAL_NAME}`
  const r = await rig()
  const refusing = handoffWorld(r.s, "dest", { port: { ...r.fake.port, destination() { throw new NativeRefusal("native_locator_unsupported_path", long) } }, locks: r.locks })
  expect(await prepareDestination(refusing.w, r.move.id)).toMatchObject({ state: "blocked", reason: "native_locator_unsupported_path" })
  const refused = (await r.s.reread(r.move)).block!
  expect(refused).toMatchObject({ code: "native_locator_unsupported_path", by: "dest" })
  expect((refused.detail as { path: string }).path).toBe(`config/${"a".repeat(232)}...`)

  const f = await rig()
  await atReleased(f)
  f.fake.behavior.importRefuses = new NativeRefusal("native_dest_session_collision", long)
  expect(await importDestination(f.dst.w, f.move.id)).toMatchObject({ state: "blocked", reason: "native_dest_session_collision" })
  const copy = await destCopy(f.s, f.move)
  expect(copy.state).toBe("cleanup_due")
  expect(ev(copy).failure.detail.path).toBe(`config/${"a".repeat(232)}...`)
  expect(ev(copy).failure.detail.written).toBe("unknown")
})
