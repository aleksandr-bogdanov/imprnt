// What the handoff modules (`move-export.ts`, `move-import.ts`) are handed in production, scripted: a per-key lock that records its own
// entries and exits, a native port that remembers every call (and writes nothing, so no disk is claimed), and a world whose every
// fact is a knob. Nothing here proves anything about a real engine or a real drain: `PROVEN` is a test's own assertion that the source
// is fenced and quiet, as the source's drain will make it when that is accepted.

import { NativeRefusal, type NativeManifest, type NativeSessionPort, type NativeSide } from "../../src/adapters/types.ts"
import { nativeManifestDigest } from "../../src/adapters/claude-session.ts"
import { buildBundle, sha256Hex } from "../../src/transfer/bundle.ts"
import type { StageReceipt } from "../../src/transfer/workspace.ts"
import type { HandoffWorld, ProvenDrain } from "../../src/runner/move-handoff.ts"
import { exportGenerationOf, recordDrainDone, recordDrainIntent, type MoveRow } from "../../src/store/moves.ts"
import { DST, FACTS, SRC, drainEvidence, sha, type MoveFixture } from "./move-store-stage.ts"

/** A process that died right after a committed step: thrown from `say` or from a port wrapper, caught by the test, never by the modules. */
export class Crash extends Error {
  constructor(readonly at: string) { super(`crash after ${at}`) }
}

export const PROVEN: ProvenDrain = { fenced: () => true, quiet: () => true }

/** One in-process chain per key, NOT re-entrant (a nested call on the same key never finishes), recording who is inside. */
export function lockChain() {
  const tails = new Map<string, Promise<unknown>>()
  const held = new Set<string>()
  const events: string[] = []
  const exclusive = <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    const run = (tails.get(key) ?? Promise.resolve()).then(async () => {
      events.push(`enter:${key}`)
      held.add(key)
      try { return await fn() } finally { held.delete(key); events.push(`exit:${key}`) }
    })
    tails.set(key, run.catch(() => {}))
    return run
  }
  return { exclusive, held, events }
}
export type Locks = ReturnType<typeof lockChain>

export const FAKE_BYTES = Buffer.from('{"type":"user","n":1}\n{"type":"assistant","n":2}\n')

/** The side the fake places a session at: the directory itself is the working directory, and the folder is its path with `/` as `-`. */
const sideAt = (sessionDir: string, version: string): NativeSide => ({ version, os: "darwin", cwd: sessionDir, project_dir: sessionDir.replaceAll("/", "-") })

export interface FakeBehavior {
  bytes: Buffer
  portabilityRefuses: NativeRefusal | null
  exportRefuses: NativeRefusal | null
  importRefuses: Error | null
  /** Called with the port's own receipt after a stage was made, before `importSession` returns (a crash after the write). */
  afterStage: (() => void) | null
  discardRefuses: Error | null
}

/**
 * A native port that keeps the tree it "wrote" in memory. `destination` refuses a dot, as the adapter does; `importSession` checks the
 * digest it is handed against the manifest's canonical digest (the adapter's own check), reuses a stage of the same operation and
 * refuses anything else at the directory as a collision. Every call is recorded, and a call that needs the conversation's lock fails
 * when `lockHeld()` says it is not held.
 */
export function fakePort(options: { lockHeld?: () => boolean } = {}) {
  const log = { destination: 0, portability: 0, exports: 0, imports: [] as { sessionDir: string; operation: string; reused: boolean | null }[], writes: 0, discards: [] as StageReceipt[] }
  const behavior: FakeBehavior = { bytes: FAKE_BYTES, portabilityRefuses: null, exportRefuses: null, importRefuses: null, afterStage: null, discardRefuses: null }
  const staged = new Map<string, StageReceipt>()
  const needLock = (what: string) => { if (options.lockHeld && !options.lockHeld()) throw new Error(`${what} called without the conversation's lock`) }
  let generation = 0

  const port: NativeSessionPort = {
    destination({ sessionDir, version }) {
      log.destination += 1
      // The adapter refuses a dot; the fake refuses the one a test names, so a temporary directory's own characters decide nothing.
      if (sessionDir.includes("dotted.")) throw new NativeRefusal("native_locator_unsupported_path")
      return sideAt(sessionDir, version)
    },
    portability({ from, to }) {
      log.portability += 1
      if (behavior.portabilityRefuses) throw behavior.portabilityRefuses
      return { adapter: "fake", from: `${from.os}:${from.version}`, to: `${to.os}:${to.version}`, evidence: "scripted-by-test" }
    },
    exportSession({ sessionDir, nativeSession, version, limits }) {
      log.exports += 1
      if (behavior.exportRefuses) throw behavior.exportRefuses
      const path = `config/projects/-source/${nativeSession}.jsonl`
      const bundle = buildBundle([{ path, class: "native", mode: 0o600, bytes: behavior.bytes }], limits)
      const manifest: NativeManifest = {
        version: 1, adapter: "fake", native_session: nativeSession, rule: "fake",
        from: { version, os: "linux", cwd: sessionDir, project_dir: "-source" },
        files: [{ path, sha256: sha256Hex(behavior.bytes), size: behavior.bytes.byteLength, mode: 0o600 }],
      }
      return { manifest, digest: nativeManifestDigest(manifest), bundle }
    },
    importSession({ manifest, digest, bundle, sessionDir, version, operation }) {
      needLock("importSession")
      const entry = { sessionDir, operation, reused: null as boolean | null }
      log.imports.push(entry)
      if (behavior.importRefuses) throw behavior.importRefuses
      const carried = manifest as NativeManifest
      if (digest !== nativeManifestDigest(carried)) throw new NativeRefusal("native_export_mismatch")
      const prior = staged.get(sessionDir)
      if (prior && prior.operation !== operation) throw new NativeRefusal("native_dest_session_collision")
      let receipt = prior
      if (!receipt) {
        log.writes += 1
        generation += 1
        receipt = {
          destination: sessionDir, manifestDigest: bundle.manifest.digest, planDigest: sha(`plan-${sessionDir}`), operation, generation: generation.toString(16).padStart(32, "0"),
          root: { dev: 1, ino: generation }, createdRoot: true, files: 1, dirs: 3, markerBytes: 1024,
        }
        staged.set(sessionDir, receipt)
      }
      entry.reused = prior !== undefined
      behavior.afterStage?.()
      const file = carried.files[0]
      return {
        native_manifest_digest: digest, to: sideAt(sessionDir, version), bundle_digest: bundle.manifest.digest,
        transcript: { path: `config/projects/${sideAt(sessionDir, version).project_dir}/${carried.native_session}.jsonl`, sha256: file.sha256, size: file.size, mode: file.mode },
        receipt, reused: prior !== undefined,
      }
    },
    discardImport(receipt) {
      needLock("discardImport")
      log.discards.push(receipt)
      if (behavior.discardRefuses) throw behavior.discardRefuses
      staged.delete(receipt.destination)
    },
    checkResumed() {},
  }
  return { port, log, behavior, staged }
}
export type Fake = ReturnType<typeof fakePort>

export interface Knobs {
  build: { version: string; capabilities: Record<string, unknown> } | null
  /** Runs inside `build`, before it answers: where a test makes something happen between a look's checks and its writes. */
  duringBuild: (() => Promise<void>) | null
  /** `stale-generation`: a proof kept from the drain before the one standing. */
  scope: "ok" | "missing" | "other-move" | "stale-generation"
  /** The basis the proof states: a test changes it to see which proof was sealed. */
  scopeBasis: string
  profile: "ok" | "missing" | "other-runner"
  idle: boolean
  sessionDir: (move: MoveRow) => string
  /** A throw here stands for a crash after the event. */
  crashOn: ((kind: string, detail: Record<string, unknown>) => boolean) | null
  /** Runs inside `say`, after it was recorded, before it returns: where a test makes something happen between two steps of an import (a withdrawal). */
  afterSay: ((kind: string, detail: Record<string, unknown>) => Promise<void>) | null
}

/** A deterministic directory without a dot or an underscore, whatever the conversation id holds. */
export const fakeDir = (move: MoveRow): string => `/srv/hub/c-${sha(move.conversation_id).slice(0, 12)}`

export function handoffWorld(s: MoveFixture, side: "source" | "dest", options: { port: NativeSessionPort | null; locks: Locks; knobs?: Partial<Knobs>; incarnation?: string }) {
  const at = side === "source" ? SRC : DST
  const knobs: Knobs = {
    build: { version: side === "source" ? "9.9.1" : "9.9.2", capabilities: FACTS.capabilities }, duringBuild: null, scope: "ok", scopeBasis: "test: the conversation has no workspace or repository",
    profile: "ok", idle: true, sessionDir: fakeDir, crashOn: null, afterSay: null, ...options.knobs,
  }
  const said: { kind: string; detail: Record<string, unknown> }[] = []
  const w: HandoffWorld = {
    store: s.tool, runner: at.runner, incarnation: options.incarnation ?? (side === "source" ? "src-1" : "dst-1"), machine: at.machine,
    port: () => options.port,
    async build() { await knobs.duringBuild?.(); return knobs.build },
    sessionDir: move => knobs.sessionDir(move),
    scope: move => knobs.scope === "missing" ? null : {
      move: knobs.scope === "other-move" ? `${move.id}-x` : move.id, conversation: move.conversation_id, agent: move.agent,
      generation: (exportGenerationOf(move) ?? 0) - (knobs.scope === "stale-generation" ? 1 : 0), carries: "native-only", basis: knobs.scopeBasis,
    },
    profile: move => knobs.profile === "missing" ? null : {
      move: move.id, agent: move.agent, runner: knobs.profile === "other-runner" ? "runner-elsewhere" : move.dest_runner, machine: move.dest_machine, profile: FACTS.profile, basis: "test: supplied binding",
    },
    exclusive: options.locks.exclusive,
    idle: () => knobs.idle,
    async say(kind, detail) {
      said.push({ kind, detail })
      if (knobs.crashOn?.(kind, detail)) throw new Crash(`${kind}:${String(detail.step ?? "")}`)
      await knobs.afterSay?.(kind, detail)
    },
  }
  return { w, knobs, said }
}

/** The drain's store half, complete, for the source that stands: an intent and the evidence for it. NO preflight (the destination's own look makes that). */
export async function drainOnly(s: MoveFixture, move: MoveRow, intentId = "intent-1", group = 4242): Promise<void> {
  const by = s.sideOf(move, "source")
  const intent = { id: intentId, boot_id: s.bootOf(by.runner)!, machine: move.source_machine, leader: group, group, pids: [group] }
  if ((await recordDrainIntent(s.tool, move.id, by, intent)) !== "intent") throw new Error("the drain intent was not recorded")
  const answer = await recordDrainDone(s.tool, move.id, by, drainEvidence(move, await s.nativeOf(move), by, intent))
  if (answer !== "drained") throw new Error(`the drain was not complete: ${answer}`)
}
