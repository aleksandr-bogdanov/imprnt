import { readFileSync, writeFileSync } from "node:fs"
import type { Cluster } from "./cluster.ts"
import { stageHub, type StageOptions } from "./hub-fixture.ts"
import type { RegistrySpec } from "./registry.ts"
import { rolloutPlatform } from "./rollout-platform.ts"
import type { FakeAdminOptions } from "./fake-platform.ts"

/**
 * What a staged household says about transcribing voice notes.
 *
 * ABSENT MEANS THE FILE IS THE ONE EVERY SHIPPED CHECK ALREADY LOADS. Nothing
 * below renders unless a check asks for it, so a stage written without this
 * option produces the same registry byte for byte and the shipped voice case
 * keeps meeting the path a household with no recognizer has.
 */
export interface VoiceStage {
  /**
   * Where the recognizer listens. A `sherpa-onnx` household reaches it on
   * loopback, so the transcriber entry carries this port and the check owns it.
   */
  port?: number
  /** The recognizer beside the door, or the one dialled over a wire. */
  provider?: "sherpa-onnx" | "deepgram"
  /** Which machine the recognizer runs on, when the file declares more than one. */
  machine?: string
  /** The `[[credentials]]` id a dialled recognizer reads its key from. */
  credential?: string
  model?: string
  chunk_seconds?: number
  retry_seconds?: number
  give_up_hours?: number
  chunk_deadline_seconds?: number
}

function voiceTables(voice: VoiceStage, runtime: string): string {
  const provider = voice.provider ?? "sherpa-onnx"
  const lines: string[] = ["", "[voice]", 'recognizer = "local"']
  for (const key of ["retry_seconds", "give_up_hours", "chunk_deadline_seconds"] as const) {
    if (voice[key] !== undefined) lines.push(`${key} = ${voice[key]}`)
  }
  lines.push("", "[recognizers.local]", `provider = ${JSON.stringify(provider)}`,
    `model = ${JSON.stringify(voice.model ?? "a-recognizer-model")}`)
  // Each field is refused on the other provider, so each side renders its own.
  if (provider === "sherpa-onnx") lines.push(`runtime = ${JSON.stringify(runtime)}`)
  else lines.push(`credential = ${JSON.stringify(voice.credential ?? "recognizer-key")}`)
  if (voice.chunk_seconds !== undefined) lines.push(`chunk_seconds = ${voice.chunk_seconds}`)
  // A door on a machine with no transcriber entry could never transcribe, so a
  // household whose recognizer runs here declares one. A dialled household is
  // refused if it declares one, because nothing of ours runs for it.
  if (provider === "sherpa-onnx") {
    lines.push("", "[[run]]", 'id = "transcriber"', 'kind = "transcriber"',
      ...(voice.machine === undefined ? [] : [`machine = ${JSON.stringify(voice.machine)}`]),
      'schedule = "always"', "memory_limit_mb = 2048", `port = ${voice.port ?? 0}`)
  }
  return lines.join("\n") + "\n"
}

/**
 * The household a dispatch check needs: a second agent per person on the same
 * door with a chat of its own, a second machine with a runner of its own, and a
 * job-only agent that names neither door nor chat.
 *
 * UNSET MEANS THE FILE IS THE ONE EVERY SHIPPED CHECK ALREADY LOADS. Nothing
 * below runs without the option, so a stage written without it renders the same
 * registry byte for byte and no shipped check sees a second machine.
 */
export const DISPATCHER = "p1-lair"
export const DISPATCH_TARGET = "p1-research"
export const DISPATCH_TARGET_CHAT = "1000000002"
export const DISPATCH_TARGET_RU = "p2-research"
export const DISPATCH_TARGET_RU_CHAT = "2000000002"
/** Neither door nor chat, so no chat log, no typing and no clock is its own. */
export const DISPATCH_JOB_ONLY = "p1-batch"
export const DISPATCH_RUNNER2 = "runner-mac"
/**
 * The door the target moves onto when a check asks for a second door, so a job
 * for it is projected by a door other than the one that accepted the command.
 */
export const DISPATCH_TARGET_DOOR2 = "door-fake-2"

function dispatchSpec(spec: RegistrySpec, secondDoor: boolean): RegistrySpec {
  // Both machines carry the os this suite runs on, so a check may really start
  // either runner here. Two of them is what makes `machine` required on every
  // run entry, which is why the entries are spelled out rather than implied.
  const os = process.platform === "darwin" ? "macos" : "linux"
  return {
    ...spec,
    machines: [{ id: "pi", os }, { id: DISPATCH_RUNNER2.replace("runner-", ""), os }],
    agents: [
      ...(spec.agents ?? []),
      { id: DISPATCH_TARGET, person: "p1", preset: "daily", chat: DISPATCH_TARGET_CHAT,
        door: secondDoor ? DISPATCH_TARGET_DOOR2 : "door-fake", runner: "runner-pi" },
      { id: DISPATCH_TARGET_RU, person: "p2", preset: "daily", chat: DISPATCH_TARGET_RU_CHAT, door: "door-fake", runner: "runner-pi" },
      { id: DISPATCH_JOB_ONLY, person: "p1", preset: "daily", runner: DISPATCH_RUNNER2 },
    ],
    run: [
      { id: "door-fake", kind: "door", platform: "fake", person: "p1", token_file: "/dev/null", schedule: "always", memory_limit_mb: 192, machine: "pi" },
      ...(secondDoor
        ? [{ id: DISPATCH_TARGET_DOOR2, kind: "door", platform: "fake", person: "p1", token_file: "/dev/null", schedule: "always", memory_limit_mb: 192, machine: "pi" }]
        : []),
      { id: "runner-pi", kind: "runner", schedule: "always", memory_limit_mb: 512, child_memory_limit_mb: 2048, machine: "pi" },
      { id: DISPATCH_RUNNER2, kind: "runner", schedule: "always", memory_limit_mb: 512, child_memory_limit_mb: 2048, machine: "mac" },
    ],
  }
}

export async function rolloutStage(
  cluster: Cluster,
  name: "telegram" | "discord",
  options: StageOptions & { voice?: VoiceStage; dispatch?: boolean; secondDoor?: boolean; admin?: FakeAdminOptions } = {},
) {
  const customize = options.registry
  const hub = await stageHub(cluster, {
    ...options,
    hub: { tick_seconds: 1, ...options.hub },
    people: options.people ?? [{ id: "p1", language: "en" }, { id: "p2", language: "ru" }],
    agents: options.agents ?? [{
      id: "p2-lair", person: "p2", preset: "daily", chat: "0000000000",
      door: "door-fake", runner: "runner-pi",
    }],
    registry: base => {
      const one = { ...base, agents: base.agents!.map(one => ({ ...one, runner: "runner-pi" })) }
      const spec = options.dispatch ? dispatchSpec(one, options.secondDoor === true) : one
      return customize ? customize(spec) : spec
    },
  })
  let text = readFileSync(hub.registryFile, "utf8")
  for (const person of ["p1", "p2"]) {
    text = text.replace(`id = "${person}"\n`, `id = "${person}"\nallowed_senders = { door-fake = ["${person}"] }\n`)
  }
  if (options.voice) text += voiceTables(options.voice, hub.stateDir)
  text += "\n[door]\ndelivery_retry_seconds = 1\ndelivery_max_attempts = 3\nread_retry_seconds = 1\n[runner]\ntask_retry_seconds = 1\n"
  writeFileSync(hub.registryFile, text)
  return { ...hub, edge: rolloutPlatform(name, options.admin) }
}
