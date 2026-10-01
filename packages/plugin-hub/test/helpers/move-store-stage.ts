// A disposable store with a topic master bound on a source machine, and the steps that take a move through its stages the way the
// runner, the hub and the transfer library eventually will. Nothing here moves a file or starts a process: every step is a call to the
// store's own routines on the role connections the real processes use, with SCRIPTED evidence (a started conversation's native identity
// and portability included, which is a test's own assertion and never proof that any adapter can carry a session).
//
// Every runner registers with the boot of ITS machine (`register` records it, as a real runner's registration does), because the store
// accepts a boot only when it equals what the speaking incarnation registered. The sides of a move are read off the move itself
// (`sideOf`), so a move back to the machine a topic came from is staged by the same steps.

import { createHash } from "node:crypto"
import { expect } from "bun:test"
import { freshDatabase, type Cluster } from "./cluster.ts"
import { storeUrlAs, type StoreLike } from "../../src/store/connect.ts"
import { allocateTopic, bindIntent, bound, channelKnown, createIntent, readTopic, type TopicIdentity, type TopicRow, type TopicSetup } from "../../src/store/topics.ts"
import { activateProtocol, conversationFor, markFeedIntent, openExecution, registerIncarnation, type Conversation, type ExecutionRow } from "../../src/store/conversations.ts"
import { gatesOn } from "../../src/store/controls.ts"
import {
  activateMove, advanceImport, beginImport, checkpointOf, destReady, exportGenerationOf, putBlob, readMove, recordDrainDone, recordDrainIntent, recordRegistryWritten,
  releaseSource, requestMove, serveMove,
  type DrainEvidence, type DrainExit, type DrainIntent, type LoadedEvidence, type MoveManifest, type MoveRow, type RegistryReceipt,
} from "../../src/store/moves.ts"

export const OWNER = "100000000000000001"
/** Two different boots of the source machine, and two of the destination machine, in the tagged form the runner records. */
export const BOOT_1 = "linux:6f1c2a3e-1111-4222-8333-444455556666"
export const BOOT_2 = "linux:6f1c2a3e-9999-4222-8333-444455556666"
export const BOOT_MAC_1 = "linux:6f1c2a3e-aaaa-4222-8333-444455556666"
export const BOOT_MAC_2 = "linux:6f1c2a3e-bbbb-4222-8333-444455556666"
const FIRST_BOOT: Record<string, string> = { pi: BOOT_1, mac: BOOT_MAC_1 }
export const SRC = { runner: "runner-pi", machine: "pi" } as const
export const DST = { runner: "runner-mac", machine: "mac" } as const
type Side = { runner: string; machine: string }
/** What the destination recorded at preflight, and what the loaded side has to equal. */
export const FACTS = { profile: { model: "m", tools: "t1", instructions: "i1" }, capabilities: { resume: true, mcp: true } }
export const sha = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex")

export interface ScriptedFile { kind: string; path: string; mode?: number; bytes: Uint8Array }
export const FILES: ScriptedFile[] = [
  { kind: "native", path: "session/a.jsonl", bytes: Buffer.from("one\ntwo\n") },
  { kind: "session", path: "notes/b.txt", mode: 0o644, bytes: Buffer.from("b") },
]

export function manifestOf(files: ScriptedFile[], extra: Partial<MoveManifest> = {}): MoveManifest {
  const listed = files.map(file => ({ kind: file.kind, path: file.path, sha256: sha(file.bytes), size: file.bytes.byteLength, mode: file.mode ?? 0o600 }))
  return { digest: sha(JSON.stringify(listed)), files: listed, bytes: listed.reduce((total, file) => total + file.size, 0), ...extra }
}

/** The adapter's scripted assertion for a started conversation. A test's own: an empty portability allowlist never produces it in production. */
export const scriptedNative = (session: string) => ({
  native: { native_session: session, native_manifest_digest: sha(`native-${session}`) },
  portability: { adapter: "synthetic", from: "pi", to: "mac", evidence: "scripted-by-test" },
})

/** The three exits the store accepts, as a test scripts them (assertions only the runtime could make for real). */
export const exitGroup = (group: number | null | undefined): DrainExit => ({
  confirmed: true, leader: "exited", descendants: "none", basis: "process-group", via: "the process group and every process recorded under it, looked up again", group: group as number,
})
export const EXIT_BOOT: DrainExit = { confirmed: true, leader: "exited", descendants: "none", basis: "boot", via: "the machine booted again after the processes were recorded" }
export const EXIT_NO_CHILD: DrainExit = { confirmed: true, basis: "no-child", children: "none", spawn_closed: true, via: "the resident registry is empty and spawning is closed" }

/**
 * Drain evidence for one owner. `who.boot` (or the intent's boot) is the boot the incarnation registered; `intent` is the intent a
 * `process-group` exit resolves (null for a `boot` or `no-child` exit, which name none); `exit` defaults to that intent's group.
 */
export function drainEvidence(move: MoveRow, nativeSession: string, who: { incarnation: string; boot?: string }, intent: DrainIntent | null,
  over: Record<string, unknown> = {}, exit?: DrainExit): DrainEvidence {
  return {
    move: move.id, conversation: move.conversation_id, native_session: nativeSession, placement_generation: move.source_generation,
    runner: move.source_runner, machine: move.source_machine, incarnation: who.incarnation, boot_id: intent?.boot_id ?? who.boot,
    ...(intent ? { intent: intent.id } : {}),
    exit: exit ?? exitGroup(intent?.group ?? null),
    ...over,
  } as DrainEvidence
}

export type ReachStage = "drained" | "source_released" | "promoted" | "activated" | "registry_written" | "active"
export interface Reach { files?: ScriptedFile[]; started?: boolean; note?: string }
/** The words the serve of a move declares the digest of (`NOTE`), and what a test hands the delivery. */
export const NOTE_BODY = "relocation note"

/** `database` stages the move on a database that already exists (a staged hub's own), instead of a fresh one. */
export async function moveStage(cluster: Cluster, track: <T extends { close(): Promise<void> }>(sql: T) => T, options: { database?: string } = {}) {
  const db = options.database ?? (await freshDatabase(cluster))
  const su = track(cluster.connect(db))
  const as = (role: string): StoreLike => ({ sql: track(cluster.connectAs(role, db)), url: storeUrlAs(cluster.url(db), role) })
  const tool = as("hub_runner")
  const door = as("hub_door")
  const hub = as("hub_hub")
  let counter = 0
  const next = () => (counter += 1)
  /** The incarnation and boot each runner last registered through `register`. */
  const current = new Map<string, { incarnation: string; boot: string | null }>()

  const setupOf = (identity: TopicIdentity, name: string): TopicSetup => ({
    topic_id: identity.topic_id, agent_id: identity.agent_id, conversation_id: identity.conversation_id, person: "p1", door: "door-d",
    chat_name: name, machine: SRC.machine, machine_from: "person", runner: SRC.runner, preset: "daily", preset_from: "person",
    adapter: "synthetic", model: "m", initial_request: "Compare the two vendors.", origin: { door: "door-d", chat: "1000000001", agent: "p1-general" },
    requested_by: OWNER,
  })

  /** A topic taken to `bound` along the legal road: active, on the source machine and runner, its master conversation `new` at generation 1. */
  async function topic(name = `topic-${next()}`, options: { identity?: () => TopicIdentity } = {}): Promise<TopicRow> {
    const operation = `alloc-${name}`
    const made = await allocateTopic(tool, {
      operation, person: "p1", door: "door-d", display_name: name, machine: SRC.machine, runner: SRC.runner, preset: "daily", adapter: "synthetic",
      setup: identity => setupOf(identity, name),
    }, options.identity ? { identity: options.identity } : {})
    await su`update topic set create_state = 'confirmed' where id = ${made.id}`
    expect(await createIntent(door, made.id, `attempt-${operation}`)).toBe("intent")
    expect(await channelKnown(door, made.id, `chat-${name}`, { how: "test" })).toBe("channel_known")
    expect(await bindIntent(hub, made.id)).toBe("bind_intent")
    expect(await bound(hub, made.id, {})).toBe("bound")
    return (await readTopic(tool, made.id))!
  }

  const who = (runner: { runner: string; machine: string }, incarnation: string) => ({ runner: runner.runner, incarnation })
  const src = (incarnation = "src-1") => who(SRC, incarnation)
  const dst = (incarnation = "dst-1") => who(DST, incarnation)
  /** A process registered as the runner's current incarnation (protocol 4), with the boot of its machine unless another is said (`null`: the boot could not be read). */
  const register = async (runner: Side, incarnation: string, bootId: string | null = FIRST_BOOT[runner.machine] ?? null) => {
    await registerIncarnation(tool, { runner: runner.runner, incarnation, machine: runner.machine, bootId })
    current.set(runner.runner, { incarnation, boot: bootId })
  }
  /**
   * A REAL runner process registered itself: the fixture takes the incarnation and the boot the store holds for it, as they are, and registers
   * nothing (a registration would replace the process's own and fence it out). The steps that name a side of a move then speak as that incarnation.
   */
  const adopt = async (runner: Side) => {
    const [row] = await su`select incarnation, boot_id from runner_incarnation where runner = ${runner.runner}`
    if (!row) throw new Error(`${runner.runner} has not registered`)
    current.set(runner.runner, { incarnation: String(row.incarnation), boot: row.boot_id === null ? null : String(row.boot_id) })
  }
  /** The runner's current incarnation as the store holds it after `register`, and the boot it registered. */
  const sideOf = (move: MoveRow, which: "source" | "dest") => {
    const runner = which === "source" ? move.source_runner : move.dest_runner
    const seen = current.get(runner)
    if (!seen) throw new Error(`${runner} was never registered through the fixture`)
    return { runner, incarnation: seen.incarnation }
  }
  const bootOf = (runner: string) => current.get(runner)?.boot ?? undefined
  /** The store at protocol 4, both runners registered as it: what a move needs. The destination is left out when it is to be offline. */
  async function fleet(options: { destination?: boolean } = {}) {
    await activateProtocol(tool)
    await register(SRC, "src-1")
    if (options.destination !== false) await register(DST, "dst-1")
  }

  async function inbound(id: string, agent: string, kind: "human" | "report" = "human") {
    await su`insert into inbound (id, person, agent, body, kind, source) values (${id}, 'p1', ${agent}, ${`body of ${id}`}, ${kind},
      ${{ log_id: id, at: new Date().toISOString(), door: "door-fake", chat: "1000000001", sender_id: "p1", text: `body of ${id}` }}::jsonb)`
  }
  /** A claim the way a claiming runner leaves it: the row is this runner's. */
  const claim = async (id: string, by: string) => { await su`update inbound set claimed_by = ${by}, claim_deadline = now() + interval '1 hour' where id = ${id}` }

  /** One input, queued and claimed by `on`, with an attempt opened for it (`claimed`: nothing fed). */
  async function attempt(t: TopicRow, id: string, on: { runner: string; incarnation: string; machine: string } = { ...src(), machine: SRC.machine }):
    Promise<{ execution: ExecutionRow; conversation: Conversation }> {
    await inbound(id, t.agent_id)
    await claim(id, on.runner)
    const conversation = await conversationFor(tool, { row: { id, person: "p1", agent: t.agent_id, kind: "human" }, adapter: "synthetic", machine: on.machine })
    const execution = await openExecution(tool, { row: { id, agent: t.agent_id }, conversation, runner: on.runner, incarnation: on.incarnation, digest: `d-${id}`, nativeSession: null })
    return { execution, conversation }
  }
  /** The same attempt, past its feed intent: the engine may hold the input. */
  async function fed(t: TopicRow, id: string, on?: { runner: string; incarnation: string; machine: string }) {
    const opened = await attempt(t, id, on)
    await markFeedIntent(tool, opened.execution, `body of ${id}`)
    return opened
  }

  /** Ask for a move of the topic's master to `to` (the destination machine's runner by default). */
  async function request(t: TopicRow, operation = `move-${next()}`, to: Side = DST): Promise<MoveRow> {
    const asked = await requestMove(tool, { operation, topic: t.id, destRunner: to.runner, destMachine: to.machine, by: OWNER })
    expect(asked.answer).toBe("requested")
    return asked.move!
  }

  const reread = async (move: MoveRow) => (await readMove(tool, move.id))!
  const nativeOf = async (move: MoveRow) => String((await su`select native_session from conversation where id = ${move.conversation_id}`)[0].native_session)

  /** The destination's preflight, the source's intent and its evidence that the child is gone: the drain, complete, for the source that stands. */
  async function drain(move: MoveRow, by = sideOf(move, "source"), over: Record<string, unknown> = {}): Promise<DrainIntent> {
    expect(await destReady(tool, move.id, sideOf(move, "dest"), FACTS)).toMatch(/^(ready|replay)$/)
    const intent: DrainIntent = { id: `intent-${by.incarnation}`, boot_id: bootOf(by.runner)!, machine: move.source_machine, leader: 4242, group: 4242, pids: [4242, 4243] }
    expect(await recordDrainIntent(tool, move.id, by, intent)).toBe("intent")
    expect(await recordDrainDone(tool, move.id, by, drainEvidence(move, await nativeOf(move), by, intent, over))).toBe("drained")
    return intent
  }

  /** The export: every blob, then the release sealing them against the manifest, at the master's own checkpoint and the drain's export generation. */
  async function release(move: MoveRow, options: Reach = {}, by = sideOf(move, "source")): Promise<MoveManifest> {
    const files = options.files ?? FILES
    const generation = exportGenerationOf(await reread(move))!
    for (const file of files) expect(await putBlob(tool, move.id, by, generation, { ...file, mode: file.mode ?? 0o600 })).toBe("stored")
    const snapshot = (await checkpointOf(tool, move.conversation_id))!
    const manifest = manifestOf(files, options.started ? scriptedNative(snapshot.native_session) : {})
    expect(await releaseSource(tool, move.id, by, generation, snapshot, manifest)).toBe("released")
    return manifest
  }

  /** The import: the generation and its staging identity first, then each committed step of the destination's own copy. */
  async function importIt(move: MoveRow, options: Reach = {}, by = sideOf(move, "dest")) {
    const sealed = await reread(move)
    const begun = await beginImport(tool, move.id, by)
    expect(begun.answer).toBe("intent")
    const generation = begun.generation!
    const verified = { manifest_digest: sealed.manifest!.digest, generation, staging: begun.staging, files: sealed.manifest!.files.length, bytes: sealed.manifest!.bytes,
      ...(options.started ? { native: sealed.manifest!.native } : {}) }
    expect(await advanceImport(tool, move.id, by, generation, "verified", verified)).toBe("verified")
    expect(await advanceImport(tool, move.id, by, generation, "promote_intent")).toBe("promote_intent")
    expect(await advanceImport(tool, move.id, by, generation, "promoted")).toBe("promoted")
    return { generation, staging: begun.staging!, verified }
  }

  const verificationOf = (move: MoveRow, imported: { generation: number; staging: string }, options: Reach = {}) => ({
    manifest_digest: move.manifest!.digest, generation: imported.generation, staging: imported.staging, dest_runner: move.dest_runner, dest_machine: move.dest_machine,
    ...(options.started ? { native: move.manifest!.native } : {}),
  })

  const receiptOf = (move: MoveRow, digest = sha("registry-1")): RegistryReceipt => ({
    digest, agent: move.agent, runner: move.dest_runner, machine: move.dest_machine, placement_generation: move.dest_generation!, profile: FACTS.profile,
  })
  const loadedOf = (move: MoveRow, digest = sha("registry-1"), over: Partial<LoadedEvidence> = {}): LoadedEvidence => ({
    agent: move.agent, runner: move.dest_runner, machine: move.dest_machine, placement_generation: move.dest_generation!, digest,
    profile: FACTS.profile, capabilities: FACTS.capabilities, imported: { generation: move.import_generation, manifest_digest: move.manifest!.digest }, ...over,
  })
  const NOTE = { digest: sha(NOTE_BODY) }
  const noteOf = (body: string) => ({ digest: sha(body) })
  const notice = (move: MoveRow) => ({ body: "moved", person: "p1", agent: move.agent, route: { door: "door-d", chat: "chat-x" } })

  /** Take a fresh move (stage `waiting`, the fleet registered) to `to`, asserting every step's answer. */
  async function reach(move: MoveRow, to: ReachStage, options: Reach = {}): Promise<MoveRow> {
    if (options.started) await su`update conversation set native_state = 'started' where id = ${move.conversation_id}`
    await drain(move)
    if (to === "drained") return await reread(move)
    await release(move, options)
    if (to === "source_released") return await reread(move)
    const imported = await importIt(move, options)
    if (to === "promoted") return await reread(move)
    expect(await activateMove(tool, move.id, sideOf(move, "dest"), imported.generation, verificationOf(await reread(move), imported, options))).toBe("activated")
    if (to === "activated") return await reread(move)
    expect(await recordRegistryWritten(hub, move.id, receiptOf(await reread(move)))).toBe("written")
    if (to === "registry_written") return await reread(move)
    expect(await serveMove(tool, move.id, sideOf(move, "dest"), loadedOf(await reread(move)), options.note === undefined ? NOTE : noteOf(options.note), notice(move))).toBe("active")
    return await reread(move)
  }

  const openGates = async (agent: string) => (await gatesOn(tool, { kind: "agent", id: agent })).filter(gate => gate.state === "open").map(gate => gate.operation).sort()
  const count = async (sql: string, ...params: unknown[]) => Number(((await su.unsafe(`select count(*)::int as n from ${sql}`, params as never[])) as { n: number }[])[0].n)

  return {
    db, su, tool, door, hub, as, topic, src, dst, register, adopt, sideOf, bootOf, fleet, inbound, claim, attempt, fed, request, reread, drain, release, importIt, verificationOf,
    receiptOf, loadedOf, NOTE, noteOf, notice, reach, openGates, count, nativeOf, next,
  }
}
export type MoveFixture = Awaited<ReturnType<typeof moveStage>>
