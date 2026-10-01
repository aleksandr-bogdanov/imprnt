// What a deletion may say about the copies it does not erase, and the pure parts of the restore barrier: the owner's retention and
// nothing in its place, what the backup destination can verify, the content-free control manifest and how it only ever grows, and the
// shape a managed path is allowed to have. No Postgres: these are files and functions.

import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { hubPath } from "./helpers/cluster.ts"
import { managedPath } from "../src/erasure/files.ts"
import {
  CONTROL_MANIFEST_FILE, ManifestMalformed, mergeManifests, parseManifest, readLocalManifest, renderManifest, restoreBarrier, writeLocalManifest,
} from "../src/erasure/manifest.ts"
import { PROPOSED_DAYS, RetentionInvalid, accountOf, expiryOf, retentionDaysOf, retentionStatement, transportOf } from "../src/erasure/retention.ts"
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
  machine: "pi", runner: "runner-pi", workers: [], deletion_id: `del-${n}`, deletion_generation: n, active_deleted: false, ...over,
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

test("the control manifest is identifiers only, is read whole or refused, and a merge never knows less than either side", () => {
  const first = manifest(2, tomb(1), tomb(2))
  const text = renderManifest(first)
  expect(Object.keys(JSON.parse(text).tombstones[0]).sort()).toEqual(
    ["active_deleted", "agent_id", "chat", "conversation_id", "deletion_generation", "deletion_id", "door", "machine", "origin", "person", "runner", "topic_id", "workers"])
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

test("a machine's copy of the manifest only grows: an older or emptier manifest from a restored store cannot make it forget a deletion, and an unreadable copy is replaced", () => {
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
  expect(writeLocalManifest(dir, manifest(4, tomb(7))).tombstones.map(one => one.topic_id)).toEqual(["topic-7"])
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
