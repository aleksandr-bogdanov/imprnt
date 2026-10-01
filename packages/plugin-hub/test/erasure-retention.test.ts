// What a deletion may say about the copies it does not erase, and the pure parts of the restore barrier: the owner's retention and
// nothing in its place, what the backup destination can verify, the content-free control manifest and how it only ever grows, and the
// shape a managed path is allowed to have. No Postgres: these are files and functions.

import { afterEach, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { hubPath } from "./helpers/cluster.ts"
import { managedPath, sweepFromManifest } from "../src/erasure/files.ts"
import {
  CONTROL_MANIFEST_FILE, ManifestMalformed, mergeManifests, parseManifest, readLocalManifest, renderManifest, restoreBarrier, writeLocalManifest,
} from "../src/erasure/manifest.ts"
import {
  GENERATION_ID, PROPOSED_DAYS, RetentionInvalid, accountForDeletion, accountOf, enforceRetention, expiryOf, fill, generationIdOf, retentionDaysOf,
  retentionStatement, transportOf, type Exec, type Outcome,
} from "../src/erasure/retention.ts"
import { loadRegistry } from "../src/registry/load.ts"
import type { ErasureManifest, ManifestTombstone } from "../src/store/deletions.ts"

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const scratch = (): string => { const dir = mkdtempSync(join(tmpdir(), "erasure-")); dirs.push(dir); return dir }

/** The shipped example, with what a fixture needs added to its `[hub]` table. */
function registryWith(extra: string): ReturnType<typeof loadRegistry> {
  const text = readFileSync(hubPath("src/registry/registry.example.toml"), "utf8").replace("[hub]", `[hub]\n${extra}`)
  const file = join(scratch(), "registry.toml")
  writeFileSync(file, text)
  return loadRegistry(file)
}

const tomb = (n: number, over: Partial<ManifestTombstone> = {}): ManifestTombstone => ({
  topic_id: `topic-${n}`, person: "p1", agent_id: `t-agent-${n}`, conversation_id: `conv-${n}`, origin: "created", door: "door-fake", chat: `chat-${n}`,
  machine: "pi", runner: "runner-pi", workers: [], worker_locations: [], deletion_id: `del-${n}`, deletion_generation: n, active_deleted: false, ...over,
})
const manifest = (generation: number, ...tombstones: ManifestTombstone[]): ErasureManifest => ({ version: 1, generation, tombstones })

test("no retention is applied that the owner did not configure: the proposal is a name in the code, not a setting, and an unconfigured deletion says so", () => {
  const registry = registryWith("")
  expect(PROPOSED_DAYS).toBe(30)
  expect(retentionDaysOf(registry)).toBeNull()
  const said = retentionStatement("en", { state: "not_configured", days: null, until: null })
  expect(said).toContain("No backup retention is configured")
  expect(said).not.toMatch(/30|expire by|expired/)
  expect(accountOf({ days: null, transport: transportOf(null), until: null })).toMatchObject({ state: "not_configured", days: null, until: null })
})

test("a configured retention is the owner's number and is counted from the copy's own creation; a number that is not a day count is refused by name", () => {
  expect(retentionDaysOf(registryWith("backup_retention_days = 45"))).toBe(45)
  expect(expiryOf(new Date("2026-01-01T00:00:00.000Z"), 45).toISOString()).toBe("2026-02-15T00:00:00.000Z")
  for (const bad of [0, 3651, -3]) expect(() => retentionDaysOf(registryWith(`backup_retention_days = ${bad}`))).toThrow(RetentionInvalid)
})

test("a destination that cannot list or expire its copies is reported unsupported: the retention is unverified, the earlier copies are said to remain, and nothing says they expired", () => {
  const transport = transportOf({ id: "backup-copy" })
  expect(transport.supported).toBe(false)
  expect(transport.reason).toContain("none of them can list the copies it holds or remove one")
  const account = accountOf({ days: 45, transport, until: null })
  expect(account.state).toBe("retention_unverified")
  const said = retentionStatement("en", account)
  expect(said).toContain("cannot verify or carry out expiry")
  expect(said).toContain("remain until they are removed by hand")
  expect(said).not.toMatch(/have expired|expire by/)
  // The date is said only when one is known, and only for a copy the destination can expire.
  expect(retentionStatement("en", { state: "tracking", days: 45, until: new Date("2026-02-15T00:00:00.000Z") })).toBe("Historical backups expire by 2026-02-15.")
  expect(retentionStatement("ru", account)).toContain("не позволяет проверить")
  // And the null case is not a catalogue: no destination at all is unsupported too.
  expect(transportOf(null).supported).toBe(false)
})

// ---- the transport: what a destination that declares it can list and expire its copies is asked, and what is believed of its answers ----

/** A destination that holds copies by id, and the three commands (list, read back one file, expire one copy) that reach it. No process is run. */
function destination(initial: Record<string, string | null>, options: { stubborn?: boolean; failExpire?: boolean; failList?: boolean; foreign?: string[] } = {}) {
  const held = new Map(Object.entries(initial))
  const calls: string[][] = []
  const exec: Exec = async (argv) => {
    calls.push(argv)
    const [tool] = argv
    if (tool === "/fake/list") {
      if (options.failList) throw new Error("unreachable")
      return new TextEncoder().encode(`${[...held.keys(), ...(options.foreign ?? [])].join("\n")}\n`)
    }
    if (tool === "/fake/read") {
      const [, , id, path, out] = argv
      const text = held.get(id)
      if (text === undefined || text === null || path !== "manifest.json") throw new Error("not there")
      writeFileSync(out, text)
      return new Uint8Array()
    }
    if (tool === "/fake/expire") {
      if (options.failExpire) throw new Error("denied")
      if (!options.stubborn) held.delete(argv[2])
      return new Uint8Array()
    }
    throw new Error(`unexpected command ${tool}`)
  }
  return { held, calls, exec, expired: () => calls.filter(call => call[0] === "/fake/expire").map(call => call[2]) }
}
const ENTRY = {
  id: "backup-copy", destination: "/dest",
  upload_argv: ["/fake/up", "{staging}/", "{destination}/{generation}"], readback_argv: ["/fake/read", "{destination}", "{generation}", "{path}", "{out}"],
  list_argv: ["/fake/list", "{destination}"], expire_argv: ["/fake/expire", "{destination}", "{generation}"],
}
const made = (at: string, generation?: number): string => JSON.stringify({ at, machine: "pi", files: [], ...(generation === undefined ? {} : { erasure_generation: generation }) })
const NOW = new Date("2026-10-05T00:00:00.000Z")

test("a copy's id is the second it was made, a placeholder is filled once and never again, and a destination is supported only when it declares both commands and gives each copy a place of its own", () => {
  expect(generationIdOf(new Date("2026-10-01T12:00:00.123Z"))).toBe("20261001T120000Z")
  expect(GENERATION_ID.test(generationIdOf(new Date()))).toBe(true)
  for (const not of ["legacy-dump", "../etc", "2026-10-01", "20261001T120000", ""]) expect(GENERATION_ID.test(not), not).toBe(false)
  expect(fill(["x", "{destination}/{generation}"], { destination: "/d e", generation: "G" })).toEqual(["x", "/d e/G"])
  expect(fill(["{destination}"], { destination: "{generation}", generation: "G" })).toEqual(["{generation}"])
  expect(fill(["{generation}"], {})).toEqual(["{generation}"])

  expect(transportOf(ENTRY)).toEqual({ supported: true, reason: "the destination can enumerate and expire its copies" })
  const mirror = transportOf({ ...ENTRY, upload_argv: ["/fake/up", "{staging}/", "{destination}"] })
  expect(mirror.supported).toBe(false)
  expect(mirror.reason).toContain("does not give each copy a place of its own")
  const unlisted = transportOf({ id: "backup-copy", upload_argv: ENTRY.upload_argv })
  expect(unlisted.supported).toBe(false)
  expect(unlisted.reason).toContain("none of them can list the copies it holds or remove one")
})

test("only a copy the destination listed, whose own manifest says when it was made, and that is older than the owner's days, is asked to be removed, and it is expired only when it is no longer listed", async () => {
  const where = destination({
    "20260801T000000Z": null, // listed, and its manifest cannot be read: its age is not known
    "20260901T000000Z": made("2026-09-01T00:00:00.000Z", 0), // due on 2026-10-01
    "20260920T000000Z": made("2026-09-20T00:00:00.000Z", 1),
    "20260930T000000Z": made("2026-09-30T00:00:00.000Z", 2),
    "29990101T000000Z": made("2999-01-01T00:00:00.000Z", 2), // dated in the future: not old
  }, { foreign: ["legacy-dump", "../etc"] })
  const result = await enforceRetention({ entry: ENTRY, scratch: scratch(), exec: where.exec }, { days: 30, now: NOW })
  expect(result.foreign).toBe(2)
  const by = new Map(result.outcomes.map(one => [one.id, one]))
  expect(by.get("20260801T000000Z")).toMatchObject({ state: "retention_unverified", expires_at: null })
  expect(by.get("20260901T000000Z")).toMatchObject({ state: "expired", expires_at: "2026-10-01T00:00:00.000Z", erasure_generation: 0 })
  expect(by.get("20260920T000000Z")).toMatchObject({ state: "pending", expires_at: "2026-10-20T00:00:00.000Z", erasure_generation: 1 })
  expect(by.get("20260930T000000Z")).toMatchObject({ state: "pending", expires_at: "2026-10-30T00:00:00.000Z" })
  expect(by.get("29990101T000000Z")?.state).toBe("pending")
  // Exactly the one was asked for, by the id the job checked: not the unreadable one, not a name that is not a copy's.
  expect(where.expired()).toEqual(["20260901T000000Z"])
  expect([...where.held.keys()]).not.toContain("20260901T000000Z")
  // And the destination was asked again after it: the listing is the proof.
  expect(where.calls.filter(call => call[0] === "/fake/list")).toHaveLength(2)
})

test("a destination that does not remove what it was asked to is blocked, never expired: a command that failed and a copy that is still listed are different words", async () => {
  const old = { "20260901T000000Z": made("2026-09-01T00:00:00.000Z", 0) }
  const stubborn = await enforceRetention({ entry: ENTRY, scratch: scratch(), exec: destination(old, { stubborn: true }).exec }, { days: 30, now: NOW })
  expect(stubborn.outcomes).toMatchObject([{ id: "20260901T000000Z", state: "retention_blocked", reason: "the destination still lists the copy after its expiry command" }])
  const failing = await enforceRetention({ entry: ENTRY, scratch: scratch(), exec: destination(old, { failExpire: true }).exec }, { days: 30, now: NOW })
  expect(failing.outcomes[0].state).toBe("retention_blocked")
  expect(failing.outcomes[0].reason).toContain("the expiry command failed")
  // A destination that cannot be listed expires nothing and says so by the step, and nothing is guessed from an earlier listing.
  const down = destination(old, { failList: true })
  await expect(enforceRetention({ entry: ENTRY, scratch: scratch(), exec: down.exec }, { days: 30, now: NOW })).rejects.toMatchObject({ step: "list" })
  expect(down.expired()).toEqual([])
})

test("the copies that are a deletion's history are the ones made before it, or whose age is not known; it is never expired from an empty listing or on the word of a setting", () => {
  const out = (id: string, state: Outcome["state"], generation: number | null, expires: string | null = "2026-10-20T00:00:00.000Z"): Outcome =>
    ({ id, state, expires_at: expires, erasure_generation: generation })
  const before = out("20260901T000000Z", "expired", 0, "2026-10-01T00:00:00.000Z")
  const during = out("20260920T000000Z", "pending", 1)
  const after = out("20260930T000000Z", "pending", 2)
  const unknown = out("20260801T000000Z", "retention_unverified", null, null)
  const deletion = { deletion_generation: 2, retention_state: "tracking" as const }

  const mixed = accountForDeletion(deletion, [before, during, after, unknown], 30)
  expect(mixed.generations.map(one => one.id)).toEqual(["20260901T000000Z", "20260920T000000Z", "20260801T000000Z"])
  expect(mixed.state).toBe("retention_unverified")
  expect(mixed.until?.toISOString()).toBe("2026-10-20T00:00:00.000Z")
  expect(accountForDeletion(deletion, [before, during, after], 30)).toMatchObject({ state: "tracking" })
  expect(accountForDeletion(deletion, [before, { ...during, state: "retention_blocked" }, after], 30).state).toBe("retention_blocked")
  const done = accountForDeletion(deletion, [before, { ...during, state: "expired" }, after], 30)
  expect(done.state).toBe("historical_copies_expired")
  expect(done.until).toBeNull()
  // Nothing found at the destination is not a verification: it stays a deletion being tracked, and says nothing was shown to have expired.
  const none = accountForDeletion(deletion, [after], 30)
  expect(none.state).toBe("tracking")
  expect(none.detail.note).toContain("nothing is shown to have expired")
  // A copy that predates erasure generations has no number, and is history of every deletion.
  expect(accountForDeletion(deletion, [out("20260101T000000Z", "pending", null)], 30).generations).toHaveLength(1)
})

test("the control manifest is identifiers only, is read whole or refused, and a merge never knows less than either side", () => {
  const first = manifest(2, tomb(1), tomb(2))
  const text = renderManifest(first)
  expect(Object.keys(JSON.parse(text).tombstones[0]).sort()).toEqual(
    ["active_deleted", "agent_id", "chat", "conversation_id", "deletion_generation", "deletion_id", "door", "machine", "origin", "person", "runner", "topic_id", "worker_locations", "workers"])
  expect(parseManifest(text)).toEqual(first)
  for (const bad of ["not json", "{}", JSON.stringify({ version: 1, generation: 1, tombstones: [{ topic_id: "t" }] }), JSON.stringify({ version: 2, generation: 1, tombstones: [] })]) {
    expect(() => parseManifest(bad), bad).toThrow(ManifestMalformed)
  }
  const merged = mergeManifests(first, manifest(5, tomb(2, { active_deleted: true, workers: ["w-1"] }), tomb(3)))
  expect(merged.generation).toBe(5)
  expect(merged.tombstones.map(one => one.topic_id)).toEqual(["topic-1", "topic-2", "topic-3"])
  expect(merged.tombstones.find(one => one.topic_id === "topic-2")).toMatchObject({ active_deleted: true, workers: ["w-1"] })
  expect(mergeManifests(null, null)).toEqual(manifest(0))
})

test("a machine's copy of the manifest only grows: an older or emptier manifest from a restored store cannot make it forget a deletion, and an unreadable copy holds without replacement", () => {
  const dir = scratch()
  writeLocalManifest(dir, manifest(3, tomb(1), tomb(2)))
  const grown = writeLocalManifest(dir, manifest(1))
  expect(grown.tombstones).toHaveLength(2)
  expect(grown.generation).toBe(3)
  expect(readLocalManifest(dir)).toEqual(grown)
  const before = readFileSync(join(dir, CONTROL_MANIFEST_FILE), "utf8")
  writeLocalManifest(dir, manifest(3, tomb(1)))
  expect(readFileSync(join(dir, CONTROL_MANIFEST_FILE), "utf8")).toBe(before)
  writeFileSync(join(dir, CONTROL_MANIFEST_FILE), "{ torn")
  expect(() => readLocalManifest(dir)).toThrow(ManifestMalformed)
  expect(() => writeLocalManifest(dir, manifest(4, tomb(7)))).toThrow(ManifestMalformed)
  expect(readFileSync(join(dir, CONTROL_MANIFEST_FILE), "utf8")).toBe("{ torn")
  expect(readdirNoTemp(dir)).toEqual([CONTROL_MANIFEST_FILE])
})

function readdirNoTemp(dir: string): string[] {
  return [...new Bun.Glob("*").scanSync(dir)].filter(name => !name.endsWith(".tmp"))
}

test("a restore serves nothing when the current manifest cannot be obtained or the snapshot's own cannot be read whole, and otherwise applies both", () => {
  const current = manifest(4, tomb(1), tomb(2))
  expect(restoreBarrier({ current: null, snapshot: null, registry: null })).toMatchObject({ serve: false, reason: "current_manifest_unverified" })
  expect(restoreBarrier({ current, snapshot: "malformed", registry: null })).toMatchObject({ serve: false, reason: "snapshot_manifest_malformed" })
  const older = manifest(1, tomb(1), tomb(9))
  const verdict = restoreBarrier({ current, snapshot: older, registry: null })
  expect(verdict.serve).toBe(true)
  if (verdict.serve) {
    expect(verdict.apply.tombstones.map(one => one.topic_id)).toEqual(["topic-1", "topic-2", "topic-9"])
    expect(verdict.apply.generation).toBe(4)
  }
  // A snapshot that predates manifests carries none, and the current one is applied alone.
  const alone = restoreBarrier({ current, snapshot: null, registry: null })
  expect(alone.serve && alone.apply.tombstones).toHaveLength(2)
})

test("a managed path is made only from a shape the id system produces and stays inside the person's own tree: nothing else is removed", () => {
  const root = resolve("/state")
  expect(managedPath("/state", "p1", { class: "chatlog", location: "t-abc-123" })).toBe(join(root, "p1", "chatlog", "t-abc-123"))
  expect(managedPath("/state", "p1", { class: "engine_state", location: "t-abc-123" })).toBe(join(root, "p1", "sessions", "t-abc-123"))
  expect(managedPath("/state", "p1", { class: "engine_state", location: "w-agent/conv-9" })).toBe(join(root, "p1", "sessions", "w-agent", "conv-9"))
  const digest = "a".repeat(64)
  expect(managedPath("/state", "p1", { class: "inbox_media", location: digest })).toBe(join(root, "p1", "inbox", digest))
  for (const refused of [
    { class: "chatlog" as const, location: "../p2/chatlog/x" }, { class: "chatlog" as const, location: "Upper-Case" }, { class: "chatlog" as const, location: "/etc" },
    { class: "engine_state" as const, location: "agent/conv/extra" }, { class: "engine_state" as const, location: "agent/.." },
    { class: "inbox_media" as const, location: "not-a-digest" }, { class: "move_copy" as const, location: "move-1-g1" },
  ]) expect(managedPath("/state", "p1", refused), JSON.stringify(refused)).toBeNull()
  expect(managedPath("/state", "../p2", { class: "chatlog", location: "t-abc" })).toBeNull()
  expect(managedPath("/state", "", { class: "chatlog", location: "t-abc" })).toBeNull()
})


test("restored delegated conversation files are erased without removing a sibling worker session", () => {
  const dir = scratch()
  const removed = join(dir, "p1", "sessions", "p1-worker", "conv-deleted")
  const kept = join(dir, "p1", "sessions", "p1-worker", "conv-kept")
  mkdirSync(removed, { recursive: true }); mkdirSync(kept, { recursive: true })
  writeFileSync(join(removed, "transcript"), "deleted"); writeFileSync(join(kept, "transcript"), "keep")
  const control = manifest(1, tomb(1, { active_deleted: true, workers: ["conv-deleted"], worker_locations: [{ agent: "p1-worker", conversation: "conv-deleted" }] }))
  expect(parseManifest(renderManifest(control)).tombstones[0].worker_locations).toEqual(control.tombstones[0].worker_locations)
  expect(sweepFromManifest(dir, control, {}).failed).toEqual([])
  expect(existsSync(removed)).toBe(false)
  expect(readFileSync(join(kept, "transcript"), "utf8")).toBe("keep")
})
