import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
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

/**
 * Every shape dispatch, the shared zone and the off-box copy give a household,
 * in ONE file the hub would really accept: the dispatch household on two doors,
 * a `[zone]` table with one marked repository per vault-holding person listed
 * in that person's sync entry, an hourly `backup` entry with its three commands
 * and a destination, and `guild` plus `default_preset` on every door.
 *
 * NOTHING IS ON DISK. The vaults and the checkouts are paths under the stage's
 * own directory that nothing creates, and the destination is a string no
 * command in a stage ever receives, because the loader compares declared
 * strings and a check that wants a checkout present, or a copy landed, builds
 * that itself. Absence is also what makes `check` report the zone findings here
 * without anything being planted for them.
 *
 * UNSET MEANS THE FILE IS THE ONE EVERY SHIPPED CHECK ALREADY LOADS.
 */
export const SIXB_MOUNT = "shared"
export const SIXB_ZONE_REMOTE = "origin"
export const SIXB_BACKUP = "backup-hourly"
/** The Discord server a channel name is resolved against. A digit string, as Discord's are. */
export const SIXB_GUILD = "2000000000"
/**
 * The copy's three commands. Absolute programs, no password literal, and only
 * the placeholders each one may carry, because those are the loader's rules.
 * Nothing in a stage runs them: a check that needs a copy to land builds one
 * with the backup stage and its own recorder.
 */
export const SIXB_BACKUP_ARGV = {
  dump_argv: ["/usr/bin/env", "pg_dump", "hub"],
  upload_argv: ["/usr/bin/rsync", "-a", "{staging}/", "{destination}"],
  readback_argv: ["/usr/bin/rsync", "{destination}/{path}", "{out}"],
}

/** Where a person's vault would be, under the stage's own directory. */
export function sixbVault(stateDir: string, person: string): string {
  return join(stateDir, "vaults", person)
}

function sixbSpec(spec: RegistrySpec): RegistrySpec {
  const stateDir = String(spec.hub?.state_dir)
  const people = (spec.people ?? []).map(one => ({ ...one, vault: sixbVault(stateDir, one.id) }))
  const repositories = people.map(one => ({
    id: `${one.id}-zone`, person: one.id, path: join(sixbVault(stateDir, one.id), "vault", SIXB_MOUNT),
    remote: SIXB_ZONE_REMOTE, branch: "main", required: true, zone: true,
  }))
  return {
    ...spec,
    people,
    zone: { mount: SIXB_MOUNT, remote: SIXB_ZONE_REMOTE, url: `file://${join(stateDir, "zone.git")}` },
    repositories: [...(spec.repositories ?? []), ...repositories],
    run: [
      ...(spec.run ?? []).map(entry => entry.kind === "door" ? { ...entry, guild: SIXB_GUILD, default_preset: "daily" } : entry),
      ...people.map(one => ({
        id: `sync-${one.id}`, kind: "sync", machine: "pi", schedule: "every 5m", memory_limit_mb: 128,
        repositories: [`${one.id}-zone`],
      })),
      {
        id: SIXB_BACKUP, kind: "backup", machine: "pi", schedule: "hourly", memory_limit_mb: 256,
        destination: "mac:hub-copies", ...SIXB_BACKUP_ARGV,
      },
    ],
  }
}

export async function rolloutStage(
  cluster: Cluster,
  name: "telegram" | "discord",
  options: StageOptions & { voice?: VoiceStage; dispatch?: boolean; secondDoor?: boolean; sixb?: boolean; admin?: FakeAdminOptions } = {},
) {
  const customize = options.registry
  // Every shape at once is the dispatch household on two doors with the zone,
  // the copy and the door fields laid over it, so it is built from the two
  // options that already exist rather than beside them.
  const dispatch = options.dispatch === true || options.sixb === true
  const secondDoor = options.secondDoor === true || options.sixb === true
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
      const two = dispatch ? dispatchSpec(one, secondDoor) : one
      const spec = options.sixb ? sixbSpec(two) : two
      return customize ? customize(spec) : spec
    },
  })
  let text = readFileSync(hub.registryFile, "utf8")
  for (const person of ["p1", "p2"]) {
    text = text.replace(`id = "${person}"\n`, `id = "${person}"\nallowed_senders = { door-fake = ["${person}"] }\n`)
  }
  if (options.voice) text += voiceTables(options.voice, hub.stateDir)
  text += "\n[door]\ndelivery_retry_seconds = 1\ndelivery_max_attempts = 3\nread_retry_seconds = 1\nread_notice_after_seconds = 1\n[runner]\ntask_retry_seconds = 1\n"
  writeFileSync(hub.registryFile, text)
  return { ...hub, edge: rolloutPlatform(name, options.admin) }
}
