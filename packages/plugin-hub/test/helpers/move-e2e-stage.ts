// The rig of `topic-move-e2e.test.ts`: a REAL door, a REAL runner for each machine, and the hub's own registry-delivery functions driven per machine,
// on one disposable store. Nothing here performs a step of a move or of a delivery: it starts the processes, ticks the hub, and reads.
//
// WHAT IS SEPARATE, as on two machines: the registry FILE (the mac's is a copy made once, at the clone, and never written by this rig or by any test:
// the bytes it later holds are installed by `deliverRegistry`), the state directory (the runner's session directories are under it, so the
// destination's import does not meet the source's directory), the person's tree, the runner's adapter (one scripted adapter each, registered under
// the one adapter name the preset names) and the hub's own store handle.
//
// WHAT IS SHARED, and limits what a green run claims: one host, one Postgres, one OS process (door, both runners, both hub loops), and the
// native-session port (`fakePort`: no engine, no transcript on a disk; `checkResumed` only records the call it was made with).

import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { NativeSessionPort } from "../../src/adapters/types.ts"
import type { PlatformMessage } from "../../src/door/platform.ts"
import { runDoor } from "../../src/door/run.ts"
import { recordRegistryDigest } from "../../src/hub/digest.ts"
import { deliverRegistry } from "../../src/hub/distribute.ts"
import { registerMoves } from "../../src/hub/moves.ts"
import type { McpBinding } from "../../src/mcp/handlers.ts"
import { appendEntry } from "../../src/records/diary.ts"
import { loadRegistry, registryDigest, type Registry } from "../../src/registry/load.ts"
import { runRunner } from "../../src/runner/run.ts"
import type { StoreLike } from "../../src/store/connect.ts"
import { inboundId } from "../../src/store/inbound.ts"
import { readMove, type MoveRow } from "../../src/store/moves.ts"
import { until, type Cluster } from "./cluster.ts"
import { CHAT, DOOR, PERSON, stageHub, withLaunchTree, type StagedHub } from "./hub-fixture.ts"
import { fakePort, type Fake } from "./move-handoff-stage.ts"
import { DST, SRC, moveStage, type MoveFixture } from "./move-store-stage.ts"
import type { PersonSpec, RunSpec } from "./registry.ts"
import { createScriptedAdapter, type ScriptedAdapter } from "./scripted-adapter.ts"

export type Machine = "pi" | "mac"
type Track = <T extends { close(): Promise<void> }>(sql: T) => T
type Check = Parameters<NativeSessionPort["checkResumed"]>[0]

/** The sender the fake platform gives every message it is handed, and the one the person allows on the door. */
export const SENDER = "fixture-sender"
export const GENERAL = `${PERSON}-general`
export const TOPIC = `${PERSON}-coffee`
const GENERAL_CHAT = "1000000002"
/** The runner of a topic stage's General: declared in the registry and never started. */
export const GENERAL_RUNNER = "runner-general"
/** The hub's tick, as a pace (the registry's own `tick_seconds` is the runners' and the door's); every wait on its result is a bounded poll. */
const HUB_TICK_MS = 500

const SRC_CAPS = { stableSession: true, safeResume: false, delegationDisabled: false, version: "9.9.1" }
const DST_CAPS = { stableSession: true, safeResume: false, delegationDisabled: false, version: "9.9.2" }

/** The hub's tick for each machine, in the order `hub/run.ts` runs it (deliver, digest, register the moves), each on a store handle of its own. */
export interface HubLoops {
  start(): void
  /** Park the machine's loop (after the tick in flight): nothing of that machine's delivery runs until `release`. */
  hold(machine: Machine): Promise<void>
  release(machine: Machine): void
  /** Resolves once `count` complete ticks of the machine have run after this call. */
  ticks(machine: Machine, count: number, timeoutMs?: number): Promise<void>
  /** What a tick threw (a throw is recorded and the loop goes on, as the hub's own tick says it and goes on): a test ends with none. */
  readonly failures: string[]
  stop(): Promise<void>
}

function hubLoops(sides: Record<Machine, { file: string; store: StoreLike }>): HubLoops {
  const failures: string[] = []
  const ticked: Record<Machine, number> = { pi: 0, mac: 0 }
  const holds: Record<Machine, { wait: Promise<void>; open: () => void } | null> = { pi: null, mac: null }
  const inFlight: Record<Machine, Promise<void> | null> = { pi: null, mac: null }
  const running: Promise<void>[] = []
  let stopping = false
  let wake: () => void = () => {}
  const stopped = new Promise<void>(resolve => { wake = resolve })

  const tick = async (machine: Machine): Promise<void> => {
    const { file, store } = sides[machine]
    const load = (): Registry => loadRegistry(file, { machine })
    const say = async (kind: string, subject: string, detail: Record<string, unknown>): Promise<void> => {
      await appendEntry(store, { stream: "machine", subject, kind, actor: "hub", detail })
    }
    // A file caught half written is one this tick cannot read; the next tick reads the finished one.
    let registry: Registry
    try { registry = load() } catch { return }
    await deliverRegistry({ store, registryFile: file, machine, registry, load, say })
    await recordRegistryDigest(store, machine, file)
    await registerMoves({ store, registryFile: file, machine, load, say })
  }

  const loop = async (machine: Machine): Promise<void> => {
    while (!stopping) {
      const held = holds[machine]
      if (held !== null) { await Promise.race([held.wait, stopped]); continue }
      const current = tick(machine).catch((error: unknown) => { failures.push(`${machine}: ${String((error as Error)?.message ?? error)}`) })
      inFlight[machine] = current
      await current
      inFlight[machine] = null
      ticked[machine] += 1
      await Promise.race([Bun.sleep(HUB_TICK_MS), stopped])
    }
  }

  return {
    failures,
    start() { running.push(loop("pi"), loop("mac")) },
    async hold(machine) {
      if (holds[machine] === null) {
        let open: () => void = () => {}
        const wait = new Promise<void>(resolve => { open = resolve })
        holds[machine] = { wait, open }
      }
      await inFlight[machine]
    },
    release(machine) {
      const held = holds[machine]
      holds[machine] = null
      held?.open()
    },
    async ticks(machine, count, timeoutMs = 30_000) {
      // One more than asked: the tick that was already in flight does not count as a tick that began after this call.
      const target = ticked[machine] + count + 1
      await until(`${count} hub ticks of ${machine}`, () => ticked[machine] >= target, timeoutMs, () => `ticked=${ticked[machine]} failures=${JSON.stringify(failures)}`)
    },
    async stop() {
      stopping = true
      wake()
      for (const machine of ["pi", "mac"] as const) this.release(machine)
      await Promise.all(running)
    },
  }
}

export interface MoveE2E {
  it: StagedHub
  s: MoveFixture
  /** The agent whose chat moves: General itself, or an ordinary topic chat's agent (`topic`). */
  moved: string
  files: Record<Machine, string>
  /** The digest of the one file both copies were, at the clone. */
  initialDigest: string
  /** The source's engine (real child processes) and the destination's (none), each a scripted adapter registered under the preset's adapter name. */
  src: ScriptedAdapter
  dst: ScriptedAdapter
  /** The one native-session port both engines hand their runner. */
  native: Fake
  /** What `checkResumed` was called with. */
  checks: Check[]
  /** The destination engine's capability read: how many were asked, and a hold on the next ones (until `openEngine`). */
  engine: { readonly reads: number }
  holdEngine(): void
  openEngine(): void
  hub: HubLoops
  startDoor(): Promise<void>
  startRunner(machine: Machine): Promise<void>
  stopRunner(machine: Machine): Promise<void>
  restartRunners(): Promise<void>
  /** The owner says something in the moved agent's chat, as the platform hands it to the door. */
  owner(text: string): { id: string; message: PlatformMessage }
  /** The log id the door gives a command message (`move:<inbound id>`). */
  commandId(sent: { id: string }): string
  /** Everything the platform accepted a post of, in order. */
  posts(): string[]
  /** The binding the runner of `moved` gives a master conversation's tool: the actual conversation and attempt. */
  binding(of: { conversation: string; attempt: string | null }): McpBinding
  /** The conversation and the attempt the runner opened for an input. */
  turnOf(inbound: string): Promise<{ conversation: string; attempt: string }>
  /** The newest move of the moved agent. */
  moveRow(): Promise<MoveRow>
  /** The digest the machine's hub last wrote to the registry sheet. */
  digestRow(machine: Machine): Promise<string | null>
  close(): Promise<void>
}

/**
 * The staged hub: two machines, a door on the pi, a runner on each machine and (for a topic) a General whose runner is never started. Nothing is
 * started. The mac's registry file is a copy of the pi's, made here, once.
 */
export async function stageMoveE2E(cluster: Cluster, track: Track, options: { topic: boolean }): Promise<MoveE2E> {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), "e2e-")))
  const macState = join(scratch, "state")
  const macTree = join(scratch, "tree")
  const macRegistry = join(scratch, "registry")
  for (const dir of [macState, macTree, macRegistry]) mkdirSync(dir)
  const moved = options.topic ? TOPIC : GENERAL

  let it: StagedHub
  try {
    it = await stageHub(cluster, {
      adapter: { child: true, group: true, unboxed: true, capabilities: SRC_CAPS },
      machines: [{ id: "pi", os: "linux" }, { id: "mac", os: "macos", state_dir: macState }],
      hub: { tick_seconds: 1, store_machine: "pi" },
      run: [
        { id: DOOR, kind: "door", machine: "pi", platform: "fake", person: PERSON, token_file: "/dev/null", schedule: "always", memory_limit_mb: 192 },
        { id: SRC.runner, kind: "runner", machine: SRC.machine, schedule: "always", memory_limit_mb: 512, child_memory_limit_mb: 512 },
        { id: DST.runner, kind: "runner", machine: DST.machine, schedule: "always", memory_limit_mb: 512, child_memory_limit_mb: 512 },
        ...(options.topic ? [{ id: GENERAL_RUNNER, kind: "runner", machine: "pi", schedule: "always", memory_limit_mb: 512, child_memory_limit_mb: 512 } satisfies RunSpec] : []),
      ],
      registry: base => {
        // The person has a real EMPTY tree on each machine (`withLaunchTree` for the pi's, a directory of this rig's for the mac's), allows the fake
        // platform's one sender on the door, names General, and waits one second for an acknowledgement so a held message's card is said within a poll.
        const planted = withLaunchTree(base)
        const people = (planted.people ?? []).map((one): PersonSpec =>
          one.id === PERSON ? { ...one, allowed_senders: { [DOOR]: [SENDER] }, general: GENERAL, acked_seconds: 1, on: { mac: { tree: macTree } } } : one)
        return {
          ...planted, people,
          agents: [
            { id: moved, person: PERSON, preset: "daily", chat: CHAT, door: DOOR, runner: SRC.runner },
            ...(options.topic ? [{ id: GENERAL, person: PERSON, preset: "daily", chat: GENERAL_CHAT, door: DOOR, runner: GENERAL_RUNNER }] : []),
          ],
        }
      },
    })
  } catch (error) {
    rmSync(scratch, { recursive: true, force: true })
    throw error
  }

  const files: Record<Machine, string> = { pi: it.registryFile, mac: join(macRegistry, "registry.toml") }
  copyFileSync(files.pi, files.mac)
  const initialDigest = registryDigest(files.pi)
  let s: MoveFixture
  try { s = await moveStage(cluster, track, { database: it.db }) }
  catch (error) {
    await it.stop().catch(() => {})
    rmSync(scratch, { recursive: true, force: true })
    throw error
  }
  const src = it.scripted
  // The destination's engine: a second scripted adapter under the SAME name the preset gives (the source's is the stage's own).
  const dst = createScriptedAdapter({ name: it.adapterName, exitProof: true, capabilities: DST_CAPS })

  const native = fakePort()
  const checks: Check[] = []
  const port: NativeSessionPort = { ...native.port, checkResumed(input) { checks.push(input) } }
  const gate = { reads: 0, held: null as Promise<void> | null, open: () => {} }
  const srcEngine = { ...src.adapter, session: port }
  const dstEngine = {
    ...dst.adapter, session: port,
    capabilities: async (context: Parameters<NonNullable<typeof dst.adapter.capabilities>>[0]) => {
      gate.reads += 1
      await gate.held
      return await dst.adapter.capabilities!(context)
    },
  }

  const hub = hubLoops({ pi: { file: files.pi, store: s.hub }, mac: { file: files.mac, store: s.as("hub_hub") } })
  const processes: { door: Awaited<ReturnType<typeof runDoor>> | null; runner: Record<Machine, Awaited<ReturnType<typeof runRunner>> | null> } =
    { door: null, runner: { pi: null, mac: null } }

  const startRunner = async (machine: Machine): Promise<void> => {
    if (processes.runner[machine] !== null) throw new Error(`the ${machine} runner is already running`)
    processes.runner[machine] = await runRunner({
      runner: machine === "pi" ? SRC.runner : DST.runner, registryFile: files[machine], adapters: { [it.adapterName]: machine === "pi" ? srcEngine : dstEngine },
    })
  }
  const stopRunner = async (machine: Machine): Promise<void> => {
    const running = processes.runner[machine]
    processes.runner[machine] = null
    await running?.stop()
  }

  const rig: MoveE2E = {
    it, s, moved, files, initialDigest, src, dst, native, checks, hub,
    engine: { get reads() { return gate.reads } },
    holdEngine() {
      if (gate.held !== null) return
      gate.held = new Promise<void>(resolve => { gate.open = resolve })
    },
    openEngine() {
      const open = gate.open
      gate.held = null
      gate.open = () => {}
      open()
    },
    async startDoor() {
      if (processes.door !== null) throw new Error("the door is already running")
      processes.door = await runDoor({ door: DOOR, registryFile: files.pi, platform: it.fake.platform })
    },
    startRunner,
    stopRunner,
    async restartRunners() {
      await stopRunner("mac")
      await stopRunner("pi")
      await startRunner("pi")
      await startRunner("mac")
    },
    owner(text) {
      const message = it.fake.deliver({ text, chat: CHAT })
      return { id: inboundId(it.fake.platform.name, message.chat, message.platform_message_id), message }
    },
    commandId: sent => `move:${sent.id}`,
    posts: () => it.fake.posts().map(post => post.text),
    binding: of => ({
      store: s.tool, person: PERSON, agent: moved, conversation: of.conversation, kind: "master", registry: () => loadRegistry(files.pi, { machine: "pi" }), attempt: () => of.attempt,
    }),
    async turnOf(inbound) {
      const [row] = await it.read.sql("select id, conversation_id from execution where inbound_id = $1", [inbound])
      if (!row) throw new Error(`no attempt was opened for ${inbound}`)
      return { conversation: String(row.conversation_id), attempt: String(row.id) }
    },
    async moveRow() {
      const [row] = await it.read.sql("select id from topic_move where agent = $1 order by created_at desc limit 1", [moved])
      if (!row) throw new Error(`${moved} has no move`)
      const move = await readMove(s.tool, String(row.id))
      if (!move) throw new Error(`move ${String(row.id)} vanished`)
      return move
    },
    async digestRow(machine) {
      const row = (await it.read.sheet("registry")).find(one => one.id === machine)
      return row === undefined ? null : String(row.data.sha256 ?? "")
    },
    async close() {
      // In the order a stop needs: the hub's loops and the destination's held read first (so nothing waits on them), then the door and the runners,
      // then the children and the stage. A step that fails does not stop the ones after it; nothing here is read by a test.
      const steps: (() => Promise<unknown>)[] = [
        async () => { rig.openEngine() },
        () => hub.stop(),
        async () => { const door = processes.door; processes.door = null; await door?.stop() },
        () => stopRunner("mac"),
        () => stopRunner("pi"),
        async () => { src.reap(); dst.reap() },
        () => it.stop(),
        async () => { rmSync(scratch, { recursive: true, force: true }) },
      ]
      for (const step of steps) await step().catch(() => {})
    },
  }
  return rig
}
