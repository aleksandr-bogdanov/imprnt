// The registry, delivered: the store machine's hub publishes the exact bytes of its file, a spoke's hub installs them, and nothing else does.
//
// WHAT THIS PROVES, against a disposable store with the real roles and the real editor:
//   - the editor's whole-file replacement (`replaceRegistry`) is byte for byte (CRLF where the loader reads it, no last newline, non-ASCII,
//     notes), keeps a symlink a symlink and the file's mode, is a compare-and-swap on the live bytes (a hand edit survives), asks its caller's
//     freshness question and keeps its backup inside the lock, and a refusal never repeats the loader's sentence;
//   - the store machine's hub publishes once per change, sheet first and then one hub-only diary line, and REFUSES a file that carries a
//     credential in a place the schema permits one (store urls, urls, the loader's own password rule) without any value reaching the ledger or a sheet;
//   - a spoke installs only bytes whose own sha256 is the latest `registry.published` digest of the store machine's hub, and only over a copy that
//     is a version that authority published before: every other copy is DIVERGED, left exactly as it is, and named once;
//   - the sheet is untrusted (a forged row, a lying `sha256` field), the diary is not writable by the door or the runner for that actor, and a line
//     written in another stream or actor is not read;
//   - a copy the loader refuses on the destination machine is kept as `.refused`, said once without a value, and retried when the minute is up;
//   - a crash between the sheet and the line, a stray candidate file, a newer publication or a hand edit landing during an install, a store machine
//     that was changed, a published file that names another store machine, and a spoke-side edit are each answered and none loses a byte;
//   - the operator's override of a diverged copy names the digest it discards, keeps those exact bytes under a name of their own (never over a
//     prior backup), and is refused on the store machine;
//   - the real hub tick delivers, reloads and renders from the installed file, and a move's registry receipt arrives on a spoke.

import { afterAll, afterEach, beforeAll, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { appendFileSync, chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { SQL } from "bun"
import { freshDatabase, startCluster, until, type Cluster } from "./helpers/cluster.ts"
import { DOOR, PERSON, RUNNER2 } from "./helpers/hub-fixture.ts"
import { handWrittenRegistry } from "./helpers/registry-fixture.ts"
import { writeRegistry, type PersonSpec, type RegistrySpec } from "./helpers/registry.ts"
import { serviceOs } from "./helpers/rollout-service.ts"
import { DST, SRC, moveStage, type MoveFixture } from "./helpers/move-store-stage.ts"
import { PROVEN, drainOnly, fakePort, handoffWorld, lockChain } from "./helpers/move-handoff-stage.ts"
import { appendEntry } from "../src/records/diary.ts"
import { putRow } from "../src/records/statesheet.ts"
import { command } from "../src/entry/command.ts"
import { REGISTRY_SHEET, recordRegistryDigest, registryStanding } from "../src/hub/digest.ts"
import {
  REFUSED_RETRY_MS, REGISTRY_COPY_SHEET, WAIT_REPORT_MS, backupPathFor, deliverRegistry, overrideRegistryCopy, preserveBytes, unsafeToPublish,
  type DeliveryContext,
} from "../src/hub/distribute.ts"
import { runHub } from "../src/hub/run.ts"
import { registerMoves, type RegistryMovesContext } from "../src/hub/moves.ts"
import { RegistryEditRefused, appendEntry as appendRegistryEntry, replaceRegistry } from "../src/registry/edit.ts"
import { listAgents } from "../src/registry/entries.ts"
import { loadRegistry, registryDigest } from "../src/registry/load.ts"
import { exportSource } from "../src/runner/move-export.ts"
import { importDestination, prepareDestination } from "../src/runner/move-import.ts"
import { profileOf } from "../src/runner/move-profile.ts"
import { scopeOf } from "../src/runner/move-scope.ts"
import { serveDestination, type ServeWorld } from "../src/runner/move-serve.ts"
import { storeUrlAs, type StoreLike } from "../src/store/connect.ts"
import { newIdentity } from "../src/store/topics.ts"

let cluster: Cluster
const connections: { close(): Promise<void> }[] = []
const hubs: { stop(): Promise<void> }[] = []
const made: string[] = []
const SLOW = 120_000

beforeAll(async () => { cluster = await startCluster() })
afterEach(async () => {
  for (const one of hubs.splice(0)) await one.stop().catch(() => {})
  for (const one of connections.splice(0)) await one.close().catch(() => {})
})
afterAll(async () => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true })
  await cluster?.stop()
})

const sha = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex")
const scratch = (): string => { const dir = realpathSync(mkdtempSync(join(tmpdir(), "rd-"))); made.push(dir); return dir }
const track = <T extends { close(): Promise<void> }>(one: T): T => { connections.push(one); return one }
const MARK = "PLANTED-SECRET-MARKER-7f3a"

// ---------------------------------------------------------------------------------------------------------------------------------------
// The editor's whole-file replacement.
// ---------------------------------------------------------------------------------------------------------------------------------------

function handFile(): { dir: string; file: string; bytes: string } {
  const dir = scratch()
  const { file, bytes } = handWrittenRegistry(dir)
  chmodSync(file, 0o640)
  return { dir, file, bytes }
}

test("RD-1 replaceRegistry puts exactly these bytes in place: no last newline, non-ASCII, notes, and CRLF wherever the loader reads it", async () => {
  const it = handFile()
  const variants: { name: string; text: string }[] = [
    { name: "a last newline", text: it.bytes + "\n" },
    { name: "no last newline", text: it.bytes },
    { name: "non-ASCII notes", text: `${it.bytes}\n# café — 日本語 ✓ ünïcode\n` },
    { name: "notes at the end of a line", text: it.bytes.replace('id = "p1"\n', 'id = "p1" # the owner\n') },
    { name: "two blank lines and a trailing note", text: `${it.bytes}\n\n\n# the last word\n` },
  ]
  let live = readFileSync(it.file)
  for (const variant of variants) {
    const wanted = Buffer.from(variant.text, "utf8")
    const result = await replaceRegistry(it.file, wanted, { expect: sha(live) })
    expect(result.changed, variant.name).toBe(wanted.equals(live) ? false : true)
    live = readFileSync(it.file)
    expect(live.equals(wanted), `${variant.name}: the bytes are the ones asked for`).toBe(true)
  }
  // CRLF is the bytes a person's editor on another system may leave. Where the loader reads it the replacement is exact; where it does not, the
  // replacement is refused as a load and the live file is untouched, which is the loader's own rule and not this one's.
  const crlf = Buffer.from(it.bytes.replace(/\n/g, "\r\n"), "utf8")
  const probe = join(it.dir, "crlf-probe.toml")
  writeFileSync(probe, crlf)
  let loads = true
  try { loadRegistry(probe) } catch { loads = false }
  const before = readFileSync(it.file)
  if (loads) {
    await replaceRegistry(it.file, crlf, { expect: sha(before) })
    expect(readFileSync(it.file).equals(crlf)).toBe(true)
  } else {
    await expect(replaceRegistry(it.file, crlf, { expect: sha(before) })).rejects.toMatchObject({ step: "load" })
    expect(readFileSync(it.file).equals(before)).toBe(true)
  }
})

test("RD-2 replaceRegistry is a compare-and-swap on the live bytes: a digest that is not the file's refuses before any candidate exists, and bytes already there change nothing", async () => {
  const it = handFile()
  const live = readFileSync(it.file)
  const wanted = Buffer.from(`${it.bytes}\n# next\n`)
  await expect(replaceRegistry(it.file, wanted, { expect: "0".repeat(64) })).rejects.toMatchObject({ name: "RegistryEditRefused", step: "precondition", candidate: null })
  expect(readFileSync(it.file).equals(live)).toBe(true)
  expect(readdirSync(it.dir).filter(name => name.includes(".candidate-") || name.endsWith(".refused"))).toEqual([])
  expect((await replaceRegistry(it.file, live, { expect: "0".repeat(64) })).changed, "the same bytes are not a change, whatever digest was said").toBe(false)
})

test("RD-3 replaceRegistry keeps a symlink a symlink, the file's mode, and leaves no candidate beside it", async () => {
  const it = handFile()
  const real = join(it.dir, "real")
  mkdirSync(real)
  const target = join(real, "registry.toml")
  copyFileSync(it.file, target)
  chmodSync(target, 0o640)
  const link = join(it.dir, "link.toml")
  symlinkSync(target, link)
  const wanted = Buffer.from(`${it.bytes}\n# through a link\n`)
  expect((await replaceRegistry(link, wanted, { expect: sha(readFileSync(target)) })).changed).toBe(true)
  expect(lstatSync(link).isSymbolicLink()).toBe(true)
  expect(readlinkSync(link)).toBe(target)
  expect(readFileSync(target).equals(wanted)).toBe(true)
  expect(statSync(target).mode & 0o777).toBe(0o640)
  expect(statSync(target).uid).toBe(process.getuid!())
  expect(readdirSync(real).filter(name => name.includes(".candidate-"))).toEqual([])
})

test("RD-4 a candidate the loader refuses is kept as .refused and the live file is untouched, and the refusal carries the line and the key and never the loader's sentence or a value", async () => {
  const it = handFile()
  const live = readFileSync(it.file)
  const bad = Buffer.from(`${it.bytes}\n\n[[machines]]\nid = "${MARK}"\nos = "plan9"\n`)
  const thrown = await replaceRegistry(it.file, bad, { expect: sha(live) }).then(() => null, error => error as RegistryEditRefused)
  expect(thrown).toBeInstanceOf(RegistryEditRefused)
  expect(thrown!.step).toBe("load")
  expect(thrown!.line).toBeGreaterThan(0)
  expect(thrown!.key).toBeDefined()
  expect(thrown!.message).not.toContain(MARK)
  expect(thrown!.message).not.toContain("plan9")
  expect(readFileSync(it.file).equals(live)).toBe(true)
  const refused = join(it.dir, ".hand-written.toml.refused")
  expect(thrown!.candidate).toBe(refused)
  expect(readFileSync(refused).equals(bad)).toBe(true)
})

test("RD-5 a hand edit that lands while the replacement is staged is refused as concurrent and survives, with nothing left beside the file", async () => {
  const it = handFile()
  const live = readFileSync(it.file)
  const edit = `${it.bytes}\n# my own edit, made while the hub was copying\n`
  await expect(replaceRegistry(it.file, Buffer.from(`${it.bytes}\n# published\n`), {
    expect: sha(live), seam: { beforeRename: () => { writeFileSync(it.file, edit) } },
  })).rejects.toMatchObject({ step: "concurrent" })
  expect(readFileSync(it.file, "utf8")).toBe(edit)
  expect(readdirSync(it.dir).filter(name => name.includes(".candidate-") || name.endsWith(".refused"))).toEqual([])
})

test("RD-6 the caller's freshness question, its acceptance and its backup are asked inside the lock, and each refuses with nothing replaced", async () => {
  const it = handFile()
  const live = readFileSync(it.file)
  const wanted = Buffer.from(`${it.bytes}\n# next\n`)
  await expect(replaceRegistry(it.file, wanted, { expect: sha(live), fresh: async () => false })).rejects.toMatchObject({ step: "stale", candidate: null })
  expect(readFileSync(it.file).equals(live)).toBe(true)
  await expect(replaceRegistry(it.file, wanted, { expect: sha(live), preserve: () => { throw new Error("cannot keep") } })).rejects.toMatchObject({ step: "backup" })
  expect(readFileSync(it.file).equals(live)).toBe(true)
  const named = await replaceRegistry(it.file, wanted, { expect: sha(live), accept: () => "this names another store machine" }).then(() => null, error => error as RegistryEditRefused)
  expect(named?.step).toBe("authority")
  expect(readFileSync(it.file).equals(live)).toBe(true)
  expect(readdirSync(it.dir).filter(name => name.includes(".candidate-"))).toEqual([])
  // The backup is handed the bytes read inside the lock, and a hand edit that lands first is refused and survives (the backup holds what WAS there).
  const kept: { bytes: Buffer | null } = { bytes: null }
  const edit = `${it.bytes}\n# a hand edit\n`
  await expect(replaceRegistry(it.file, wanted, {
    expect: sha(live), seam: { afterRead: () => { writeFileSync(it.file, edit) } }, preserve: previous => { kept.bytes = previous },
  })).rejects.toMatchObject({ step: "concurrent" })
  expect(kept.bytes!.equals(live)).toBe(true)
  expect(readFileSync(it.file, "utf8")).toBe(edit)
})

test("RD-7 a backup is the exact bytes, bound to their own digest, never over a file that is there, and a conflicting file of that name refuses", async () => {
  const it = handFile()
  const live = join(it.dir, "registry.toml")
  writeFileSync(live, "the file", { mode: 0o640 })
  chmodSync(live, 0o640)
  // A person's own earlier backup under the old single name is never touched.
  const theirs = join(it.dir, ".registry.toml.diverged")
  writeFileSync(theirs, "USER DATA THAT MUST SURVIVE")
  const first = Buffer.from("local edit one")
  const path = preserveBytes(first, live)
  expect(path).toBe(backupPathFor(live, sha(first)))
  expect(readFileSync(path).equals(first)).toBe(true)
  expect(statSync(path).mode & 0o777).toBe(0o640)
  expect(readFileSync(theirs, "utf8")).toBe("USER DATA THAT MUST SURVIVE")
  // The same bytes kept twice lose nothing; other bytes go to a name of their own.
  expect(preserveBytes(first, live)).toBe(path)
  const second = Buffer.from("local edit two")
  const other = preserveBytes(second, live)
  expect(other).not.toBe(path)
  expect(readFileSync(path).equals(first)).toBe(true)
  expect(readFileSync(other).equals(second)).toBe(true)
  // A file already under the digest's own name that holds other bytes is a conflict, and it is not overwritten.
  const third = Buffer.from("local edit three")
  writeFileSync(backupPathFor(live, sha(third)), "something else is here")
  expect(() => preserveBytes(third, live)).toThrow()
  expect(readFileSync(backupPathFor(live, sha(third)), "utf8")).toBe("something else is here")
  expect(readdirSync(it.dir).filter(name => name.endsWith(".tmp"))).toEqual([])
})

// ---------------------------------------------------------------------------------------------------------------------------------------
// What may be published.
// ---------------------------------------------------------------------------------------------------------------------------------------

test("RD-8 unsafeToPublish names a closed code and a place, never the value, for every credential-bearing location the schema permits", () => {
  const url = (line: string) => `[hub]\nstore_url = "postgres://127.0.0.1:1/x"\n${line}\n`
  const cases: [string, string, string | null][] = [
    ["a benign file", url(""), null],
    ["an ssh remote with an account", url('[zone]\nurl = "ssh://git@example.invalid/org/repo.git"'), null],
    ["an https url with no user", url('[zone]\nurl = "https://example.invalid/org/repo.git"'), null],
    ["the loader's own password rule, in a comment", url(`# password = ${MARK}`), "password-literal"],
    ["a password written as a key", url(`password = "${MARK}"`), "password-literal"],
    ["a password in a url", url(`[zone]\nurl = "https://x:${MARK}@example.invalid/r.git"`), "password-literal"],
    ["a token as the user of an https url", url(`[zone]\nurl = "https://${MARK}@example.invalid/r.git"`), "url-userinfo"],
  ]
  for (const [name, text, reason] of cases) {
    const found = unsafeToPublish(text)
    expect(found?.reason ?? null, name).toBe(reason)
    expect(JSON.stringify(found), `${name}: the value is never in the verdict`).not.toContain(MARK)
  }
  const hub = (storeUrl: string) => `[hub]\nstore_url = ${JSON.stringify(storeUrl)}\n`
  expect(unsafeToPublish(hub("postgres://someuser@127.0.0.1:1/x"))).toMatchObject({ reason: "store-url-userinfo", at: "hub.store_url", line: 2 })
  expect(unsafeToPublish(hub("postgres://127.0.0.1:1/x?sslmode=require"))).toMatchObject({ reason: "store-url-query", at: "hub.store_url" })
  expect(unsafeToPublish(hub(`not a url ${MARK}`))).toMatchObject({ reason: "store-url-invalid" })
  expect(JSON.stringify(unsafeToPublish(hub(`not a url ${MARK}`)))).not.toContain(MARK)
  const machine = `${hub("postgres://127.0.0.1:1/x")}\n[[machines]]\nid = "pi"\nos = "linux"\n\n[[machines]]\nid = "mac"\nos = "macos"\nstore_url = "postgres://host@127.0.0.1:1/x"\n`
  expect(unsafeToPublish(machine)).toMatchObject({ reason: "store-url-userinfo", at: "machines[1].store_url" })
})

// ---------------------------------------------------------------------------------------------------------------------------------------
// The world: one store, two machines, a registry per machine.
// ---------------------------------------------------------------------------------------------------------------------------------------

interface World {
  dir: string
  db: string
  piDir: string
  macDir: string
  piFile: string
  macFile: string
  su: SQL
  hubPi: StoreLike
  hubMac: StoreLike
  runner: StoreLike
  door: StoreLike
  /** The hub's clock, which a check moves to cross a retry or a wait. */
  clock: { at: number }
}

interface WorldOptions {
  /** Both machines declare this os, so a real hub of either may run on this box. */
  os?: string
  /** A [[run]] entry of kind hub on each machine, which a real hub needs. */
  hubs?: boolean
  /** The file a person of the mac names on the mac only; with it missing the file does not load THERE. */
  macInstructions?: string[]
  /** A registry whose store route is the one, so there is nothing to deliver. */
  single?: boolean
  /** The real url of the store, for a hub that opens it. */
  real?: boolean
}

function specOf(w: { dir: string; piDir: string; macDir: string; db: string }, options: WorldOptions = {}): RegistrySpec {
  const url = `postgres://127.0.0.1:${cluster.port}/${w.db}`
  const piTree = join(w.piDir, "tree")
  const macTree = join(w.macDir, "tree")
  const os = options.os
  if (options.single) {
    return {
      hub: { tick_seconds: 1, state_dir: w.piDir, store_url: url },
      machines: [{ id: "pi", os: os ?? "linux" }],
      people: [{ id: PERSON, tree: piTree }],
      presets: { daily: { adapter: "a-scripted-adapter", model: "m", provider: "p", effort: "medium", paid: "key" } },
      agents: [{ id: "p1-lair", person: PERSON, preset: "daily", chat: "1000000001", door: DOOR, runner: "runner-pi" }],
      run: [
        { id: DOOR, kind: "door", machine: "pi", platform: "fake", person: PERSON, token_file: "/dev/null", schedule: "always", memory_limit_mb: 192 },
        { id: "runner-pi", kind: "runner", machine: "pi", schedule: "always", memory_limit_mb: 512, child_memory_limit_mb: 512 },
      ],
    }
  }
  const placement: Record<string, unknown> = { tree: macTree, ...(options.macInstructions ? { instructions: options.macInstructions } : {}) }
  return {
    hub: { tick_seconds: 1, state_dir: w.piDir, store_url: url, store_machine: "pi" },
    machines: [
      { id: "pi", os: os ?? "linux", state_dir: w.piDir },
      { id: "mac", os: os ?? "macos", state_dir: w.macDir, store_url: url },
    ],
    people: [{ id: PERSON, tree: piTree, on: { mac: placement } } as unknown as PersonSpec],
    presets: { daily: { adapter: "a-scripted-adapter", model: "m", provider: "p", effort: "medium", paid: "key" } },
    agents: [{ id: "p1-lair", person: PERSON, preset: "daily", chat: "1000000001", door: DOOR, runner: RUNNER2 }],
    run: [
      { id: DOOR, kind: "door", machine: "pi", platform: "fake", person: PERSON, token_file: "/dev/null", schedule: "always", memory_limit_mb: 192 },
      { id: RUNNER2, kind: "runner", machine: "mac", schedule: "always", memory_limit_mb: 512, child_memory_limit_mb: 2048 },
      ...(options.hubs ? [
        { id: "hub-pi", kind: "hub", machine: "pi", schedule: "always", memory_limit_mb: 128 },
        { id: "hub-mac", kind: "hub", machine: "mac", schedule: "always", memory_limit_mb: 128 },
      ] : []),
    ],
  }
}

/** One database, the pi's registry written, and the mac holding the SAME bytes (the first delivery by hand, which a person did before this existed). */
async function world(options: WorldOptions = {}): Promise<World> {
  const dir = scratch()
  const db = await freshDatabase(cluster)
  const piDir = join(dir, "pi")
  const macDir = join(dir, "mac")
  for (const path of [piDir, macDir, join(piDir, "tree"), join(macDir, "tree")]) mkdirSync(path, { recursive: true })
  const piFile = writeRegistry(piDir, specOf({ dir, piDir, macDir, db }, options))
  const macFile = join(macDir, "registry.toml")
  copyFileSync(piFile, macFile)
  const as = (role: string): StoreLike => ({ sql: track(cluster.connectAs(role, db)), url: storeUrlAs(cluster.url(db), role) })
  return { dir, db, piDir, macDir, piFile, macFile, su: track(cluster.connect(db)), hubPi: as("hub_hub"), hubMac: as("hub_hub"), runner: as("hub_runner"), door: as("hub_door"), clock: { at: 1_000_000 } }
}

function contextOf(w: World, machine: "pi" | "mac", over: Partial<DeliveryContext> = {}): DeliveryContext {
  const registryFile = machine === "pi" ? w.piFile : w.macFile
  const store = machine === "pi" ? w.hubPi : w.hubMac
  const load = () => loadRegistry(registryFile, { machine })
  return {
    store, registryFile, machine, registry: load(), load, now: () => w.clock.at,
    say: async (kind, subject, detail) => { await appendEntry(store, { stream: "machine", subject, kind, actor: "hub", detail }) },
    ...over,
  }
}
const deliver = (w: World, machine: "pi" | "mac", over: Partial<DeliveryContext> = {}) => deliverRegistry(contextOf(w, machine, over))

interface Line { seq: number; subject: string; kind: string; actor: string; detail: Record<string, unknown> }
async function lines(w: World, kind?: string): Promise<Line[]> {
  const rows = await w.su`select seq, subject, kind, actor, detail from ledger_event where stream = 'machine' and kind like 'registry.%' order by seq`
  return (rows as Line[]).map(row => ({ ...row, seq: Number(row.seq) })).filter(row => kind === undefined || row.kind === kind)
}
async function sheetBytes(w: World, id = "pi"): Promise<Buffer | null> {
  const rows = await w.su`select data from state_row where sheet = ${REGISTRY_COPY_SHEET} and id = ${id}`
  const encoded = (rows[0]?.data as { bytes_b64?: string } | undefined)?.bytes_b64
  return typeof encoded === "string" ? Buffer.from(encoded, "base64") : null
}
const bytesOf = (file: string): Buffer => readFileSync(file)
/** The pi's file, edited as a person edits it by hand: one more line at the end. */
const editPi = (w: World, note: string): Buffer => { appendFileSync(w.piFile, `\n# ${note}\n`); return bytesOf(w.piFile) }
const strays = (dir: string): string[] => readdirSync(dir).filter(name => name.includes(".candidate-"))

// ---------------------------------------------------------------------------------------------------------------------------------------
// Publishing.
// ---------------------------------------------------------------------------------------------------------------------------------------

test("RD-10 the store machine's first tick publishes the sheet and one hub-only line, and an unchanged tick writes nothing at all", async () => {
  const w = await world()
  expect(await deliver(w, "pi")).toBe("published")
  const bytes = bytesOf(w.piFile)
  const published = await lines(w, "registry.published")
  expect(published).toHaveLength(1)
  expect(published[0]).toMatchObject({ actor: "hub", subject: "registry:pi", detail: { machine: "pi", sha256: sha(bytes), size: bytes.length } })
  expect((await sheetBytes(w))!.equals(bytes)).toBe(true)
  const [row] = await w.su`select updated_at from state_row where sheet = ${REGISTRY_COPY_SHEET} and id = 'pi'`
  expect(await deliver(w, "pi")).toBe("current")
  expect(await deliver(w, "pi")).toBe("current")
  expect(await lines(w, "registry.published")).toHaveLength(1)
  const [again] = await w.su`select updated_at from state_row where sheet = ${REGISTRY_COPY_SHEET} and id = 'pi'`
  expect(new Date(again.updated_at).getTime(), "the sheet is not touched by an unchanged tick").toBe(new Date(row.updated_at).getTime())
  // A change is one more line and one more put, and the mac that holds the first version is not yet the latest.
  const next = editPi(w, "a second version")
  expect(await deliver(w, "pi")).toBe("published")
  expect(await lines(w, "registry.published")).toHaveLength(2)
  expect((await sheetBytes(w))!.equals(next)).toBe(true)
})

test("RD-11 a file that names no store machine delivers nothing and writes nothing, so a single-route household is untouched", async () => {
  const w = await world({ single: true })
  expect(await deliver(w, "pi")).toBe("none")
  expect(await lines(w)).toEqual([])
  expect(await sheetBytes(w)).toBeNull()
})

test("RD-12 a file that carries a credential is REFUSED, said once with a code and a place, and no value reaches the ledger or any sheet", async () => {
  const cases: { name: string; change: (text: string) => string; reason: string; line?: boolean }[] = [
    { name: "a password in a comment", change: text => `${text}\n# password = ${MARK}\n`, reason: "password-literal", line: true },
    { name: "a user on the top-level store url", change: text => text.replace(/store_url = "postgres:\/\/127\.0\.0\.1:(\d+)\/(\w+)"/, `store_url = "postgres://${MARK}@127.0.0.1:$1/$2"`), reason: "store-url-userinfo" },
    { name: "a password on the top-level store url", change: text => text.replace(/store_url = "postgres:\/\/127\.0\.0\.1:(\d+)\/(\w+)"/, `store_url = "postgres://user:${MARK}@127.0.0.1:$1/$2"`), reason: "password-literal" },
    { name: "a query on the top-level store url", change: text => text.replace(/store_url = "postgres:\/\/127\.0\.0\.1:(\d+)\/(\w+)"/, `store_url = "postgres://127.0.0.1:$1/$2?options=${MARK}"`), reason: "store-url-query" },
    { name: "a token as the user of a url in a key the loader ignores", change: text => `${text}\nnote = "https://${MARK}@example.invalid/x"\n`, reason: "url-userinfo" },
  ]
  for (const one of cases) {
    const w = await world()
    writeFileSync(w.piFile, one.change(readFileSync(w.piFile, "utf8")))
    expect(await deliver(w, "pi"), one.name).toBe("refused")
    expect(await deliver(w, "pi"), `${one.name}: again`).toBe("refused")
    expect(await lines(w, "registry.published"), one.name).toEqual([])
    expect(await sheetBytes(w), `${one.name}: nothing is put on the sheet`).toBeNull()
    const said = await lines(w, "registry.publish-refused")
    expect(said, `${one.name}: said once`).toHaveLength(1)
    expect(said[0].detail).toMatchObject({ machine: "pi", reason: one.reason, sha256: sha(bytesOf(w.piFile)) })
    if (one.line) expect(typeof said[0].detail.line).toBe("number")
    const [ledger] = await w.su`select count(*)::int as n from ledger_event where detail::text like ${`%${MARK}%`} or subject like ${`%${MARK}%`}`
    const [rows] = await w.su`select count(*)::int as n from state_row where data::text like ${`%${MARK}%`} or id like ${`%${MARK}%`}`
    expect(ledger.n, `${one.name}: no value in the diary`).toBe(0)
    expect(rows.n, `${one.name}: no value on a sheet`).toBe(0)
  }
  const big = await world()
  expect(await deliver(big, "pi", { maxBytes: 100 })).toBe("refused")
  expect((await lines(big, "registry.publish-refused"))[0].detail).toMatchObject({ reason: "too-large" })
  expect(await sheetBytes(big)).toBeNull()
})

test("RD-13 a file the loader cannot read is not published, and a publication that finds the file moved before its line drops the line", async () => {
  const w = await world()
  const good = readFileSync(w.piFile)
  const ctx = contextOf(w, "pi")
  writeFileSync(w.piFile, "this is [not toml")
  expect(await deliverRegistry({ ...ctx, registry: ctx.registry })).toBe("waiting")
  expect(await sheetBytes(w)).toBeNull()
  expect(await lines(w, "registry.published")).toEqual([])
  writeFileSync(w.piFile, good)
  // The file moves between the sheet and the line: the line is not written for bytes that are no longer the file's.
  let moved = false
  const storeThatMoves: StoreLike = {
    url: w.hubPi.url,
    sql: new Proxy(w.hubPi.sql as object, {
      apply(target, self, args) {
        const first = Array.isArray(args[0]) ? String((args[0] as string[]).join("?")) : ""
        // The sheet put is the statement that mentions `on conflict (sheet, id)`.
        if (!moved && first.includes("on conflict (sheet, id)")) { moved = true; appendFileSync(w.piFile, "\n# moved\n") }
        return Reflect.apply(target as never, self, args)
      },
      get(target, key) { const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value },
    }) as never,
  }
  expect(await deliverRegistry({ ...contextOf(w, "pi"), store: storeThatMoves })).toBe("waiting")
  expect(moved).toBe(true)
  expect(await lines(w, "registry.published")).toEqual([])
  // The next tick looks at the file as it now is, and publishes that.
  expect(await deliver(w, "pi")).toBe("published")
  expect((await lines(w, "registry.published"))[0].detail.sha256).toBe(sha(bytesOf(w.piFile)))
})

// ---------------------------------------------------------------------------------------------------------------------------------------
// Installing.
// ---------------------------------------------------------------------------------------------------------------------------------------

test("RD-20 a spoke installs the published bytes exactly, keeps its own overlays, and the runner's standing is current once the store machine's row says so", async () => {
  const w = await world()
  expect(await deliver(w, "pi")).toBe("published")
  expect(await deliver(w, "mac"), "a copy that is the published one needs nothing").toBe("current")
  const v2 = editPi(w, "a second version, with café and 日本語")
  expect(await deliver(w, "pi")).toBe("published")
  expect(await deliver(w, "mac")).toBe("installed")
  expect(bytesOf(w.macFile).equals(v2)).toBe(true)
  expect(strays(w.macDir)).toEqual([])
  const installed = await lines(w, "registry.copy-installed")
  expect(installed).toHaveLength(1)
  expect(installed[0]).toMatchObject({ actor: "hub", subject: "registry-copy:mac", detail: { machine: "mac", reference: "pi" } })
  expect(await deliver(w, "mac")).toBe("current")
  expect(await lines(w, "registry.copy-installed")).toHaveLength(1)
  // THE OVERLAYS ARE IN THE BYTES: the mac reads its own state directory and its own tree out of the one file the pi reads its own out of.
  const onMac = loadRegistry(w.macFile, { machine: "mac" })
  const onPi = loadRegistry(w.macFile, { machine: "pi" })
  expect((onMac.data.hub as Record<string, unknown>).state_dir).toBe(w.macDir)
  expect((onPi.data.hub as Record<string, unknown>).state_dir).toBe(w.piDir)
  expect(onMac.people.find(one => one.id === PERSON)?.tree).toBe(join(w.macDir, "tree"))
  expect(onPi.people.find(one => one.id === PERSON)?.tree).toBe(join(w.piDir, "tree"))
  // And the runner's standing, measured against the store machine's row, is current.
  await recordRegistryDigest(w.hubPi, "pi", w.piFile)
  expect(await registryStanding(w.hubMac, { registry: loadRegistry(w.macFile, { machine: "mac" }), machine: "mac", file: w.macFile })).toEqual({ stale: false, reason: "" })
})

test("RD-21 reverting to an earlier published version is delivered, because the authority's own history is the baseline", async () => {
  const w = await world()
  const v1 = bytesOf(w.piFile)
  await deliver(w, "pi")
  editPi(w, "v2")
  await deliver(w, "pi")
  await deliver(w, "mac")
  expect(bytesOf(w.macFile).equals(v1)).toBe(false)
  writeFileSync(w.piFile, v1)
  expect(await deliver(w, "pi")).toBe("published")
  expect((await lines(w, "registry.published")).map(one => one.detail.sha256)).toEqual([sha(v1), sha(bytesOf(w.macFile)), sha(v1)])
  expect(await deliver(w, "mac")).toBe("installed")
  expect(bytesOf(w.macFile).equals(v1)).toBe(true)
})

// ---------------------------------------------------------------------------------------------------------------------------------------
// Conflicts.
// ---------------------------------------------------------------------------------------------------------------------------------------

test("RD-30 a spoke copy that is not a published version is DIVERGED: untouched, said once, and repeated ticks add nothing", async () => {
  const w = await world()
  await deliver(w, "pi")
  const local = Buffer.from(`${readFileSync(w.macFile, "utf8")}\n# an edit made on the spoke\n`)
  writeFileSync(w.macFile, local)
  editPi(w, "v2")
  await deliver(w, "pi")
  for (let n = 0; n < 4; n += 1) expect(await deliver(w, "mac")).toBe("diverged")
  expect(bytesOf(w.macFile).equals(local)).toBe(true)
  const said = await lines(w, "registry.copy-diverged")
  expect(said).toHaveLength(1)
  expect(said[0]).toMatchObject({ actor: "hub", subject: "registry-copy:mac", detail: { machine: "mac", reference: "pi", local: sha(local).slice(0, 16), published: sha(bytesOf(w.piFile)).slice(0, 16) } })
  expect(await lines(w, "registry.copy-installed")).toEqual([])
  // The runner stays stale, which is today's behaviour and the existing check's finding.
  await recordRegistryDigest(w.hubPi, "pi", w.piFile)
  expect((await registryStanding(w.hubMac, { registry: loadRegistry(w.macFile, { machine: "mac" }), machine: "mac", file: w.macFile })).stale).toBe(true)
})

test("RD-31 a copy made before this existed, that the authority never published, waits for a first publication and is then diverged, and nothing is adopted", async () => {
  const w = await world()
  const old = Buffer.from(`${readFileSync(w.piFile, "utf8")}\n# a pre-delivery copy, never published\n`)
  writeFileSync(w.macFile, old)
  // Nothing published yet: the spoke waits and writes nothing.
  expect(await deliver(w, "mac")).toBe("waiting")
  expect(await lines(w)).toEqual([])
  await deliver(w, "pi")
  expect(await deliver(w, "mac")).toBe("diverged")
  expect(bytesOf(w.macFile).equals(old)).toBe(true)
})

test("RD-32 an edit made ON a spoke, by anything that writes the registry there, is a divergence and is never merged", async () => {
  const w = await world()
  await deliver(w, "pi")
  await appendRegistryEntry(w.macFile, "agents", { id: "p1-spoke", person: PERSON, preset: "daily", chat: "1000000002", door: DOOR, runner: RUNNER2 })
  const edited = bytesOf(w.macFile)
  expect(await deliver(w, "mac")).toBe("diverged")
  editPi(w, "v2")
  await deliver(w, "pi")
  expect(await deliver(w, "mac")).toBe("diverged")
  expect(bytesOf(w.macFile).equals(edited)).toBe(true)
  expect(await lines(w, "registry.copy-diverged")).toHaveLength(2)
})

test("RD-33 a store machine that was changed is not followed silently: the pi, now a spoke of a machine that has published nothing, waits, says so once after the wait, and writes nothing", async () => {
  const w = await world()
  await deliver(w, "pi")
  const before = bytesOf(w.piFile)
  writeFileSync(w.piFile, readFileSync(w.piFile, "utf8").replace('store_machine = "pi"', 'store_machine = "mac"'))
  const moved = bytesOf(w.piFile)
  expect(await deliver(w, "pi")).toBe("waiting")
  expect(await lines(w, "registry.copy-waiting")).toEqual([])
  w.clock.at += WAIT_REPORT_MS + 1
  expect(await deliver(w, "pi")).toBe("waiting")
  expect(await deliver(w, "pi")).toBe("waiting")
  const said = await lines(w, "registry.copy-waiting")
  expect(said).toHaveLength(1)
  expect(said[0].detail).toMatchObject({ machine: "pi", reference: "mac", reason: "no-publication" })
  expect(bytesOf(w.piFile).equals(moved)).toBe(true)
  expect(moved.equals(before)).toBe(false)
  expect(await lines(w, "registry.published")).toHaveLength(1)
})

test("RD-34 a published file that names another store machine is never installed: that is a decision, not a copy", async () => {
  const w = await world()
  await deliver(w, "pi")
  const v1 = bytesOf(w.macFile)
  // The pi's own file now names the mac, so the hub of the pi does not publish it: the line and the sheet are written the way a publisher would.
  const moved = Buffer.from(readFileSync(w.piFile, "utf8").replace('store_machine = "pi"', 'store_machine = "mac"'))
  await putRow(w.hubPi, REGISTRY_COPY_SHEET, "pi", { sha256: sha(moved), size: moved.length, bytes_b64: moved.toString("base64"), at: new Date().toISOString() })
  await appendEntry(w.hubPi, { stream: "machine", subject: "registry:pi", kind: "registry.published", actor: "hub", detail: { machine: "pi", sha256: sha(moved), size: moved.length } })
  expect(await deliver(w, "mac")).toBe("refused")
  expect(bytesOf(w.macFile).equals(v1)).toBe(true)
  const said = await lines(w, "registry.copy-refused")
  expect(said).toHaveLength(1)
  expect(said[0].detail).toMatchObject({ machine: "mac", step: "authority" })
  expect(existsSync(join(w.macDir, ".registry.toml.refused"))).toBe(true)
  // Within the minute, nothing is tried and nothing is said again.
  expect(await deliver(w, "mac")).toBe("refused")
  expect(await lines(w, "registry.copy-refused")).toHaveLength(1)
})

test("RD-35 two machines each acting as the store machine is said, once, where the operator reads it, and nothing is moved by it", async () => {
  const w = await world()
  await deliver(w, "pi")
  // The mac publishes as an authority too (a file of its own that names it), after the pi did.
  await appendEntry(w.hubMac, { stream: "machine", subject: "registry:mac", kind: "registry.published", actor: "hub", detail: { machine: "mac", sha256: "a".repeat(64), size: 1 } })
  editPi(w, "v2")
  expect(await deliver(w, "pi")).toBe("published")
  const said = await lines(w, "registry.authority-contested")
  expect(said).toHaveLength(1)
  expect(said[0]).toMatchObject({ subject: "registry:pi", detail: { machine: "pi", other: "mac" } })
  editPi(w, "v3")
  expect(await deliver(w, "pi")).toBe("published")
  expect(await lines(w, "registry.authority-contested"), "once per other line").toHaveLength(1)
})

// ---------------------------------------------------------------------------------------------------------------------------------------
// Forgery: the sheet is untrusted, the diary for that actor is not writable.
// ---------------------------------------------------------------------------------------------------------------------------------------

test("RD-40 a sheet row written by the runner with other bytes and a lying sha256 is not installed, and the publisher's next tick puts the real bytes back", async () => {
  const w = await world()
  await deliver(w, "pi")
  const v1 = bytesOf(w.macFile)
  const v2 = editPi(w, "v2")
  // The line first (as a crash after the sheet would leave it... the other way round), then the forgery over the sheet.
  await deliver(w, "pi")
  const evil = Buffer.from("[hub]\nstore_url = \"postgres://127.0.0.1:1/evil\"\n")
  await w.runner.sql`insert into state_row (sheet, id, data) values (${REGISTRY_COPY_SHEET}, ${"pi"}, ${{ sha256: sha(v2), size: evil.length, bytes_b64: evil.toString("base64") }})
    on conflict (sheet, id) do update set data = excluded.data`
  expect(await deliver(w, "mac")).toBe("waiting")
  expect(bytesOf(w.macFile).equals(v1)).toBe(true)
  expect(await lines(w, "registry.copy-installed")).toEqual([])
  // The sheet that says nothing about bytes at all, and one that is not base64, are the same answer.
  await w.runner.sql`update state_row set data = ${{ sha256: sha(v2) }} where sheet = ${REGISTRY_COPY_SHEET} and id = ${"pi"}`
  expect(await deliver(w, "mac")).toBe("waiting")
  await w.runner.sql`update state_row set data = ${{ sha256: sha(v2), bytes_b64: "!!! not base64 !!!" }} where sheet = ${REGISTRY_COPY_SHEET} and id = ${"pi"}`
  expect(await deliver(w, "mac")).toBe("waiting")
  // The publisher notices the sheet does not hold the published bytes, and puts them back.
  expect(await deliver(w, "pi")).toBe("published")
  expect((await sheetBytes(w))!.equals(v2)).toBe(true)
  expect(await deliver(w, "mac")).toBe("installed")
  expect(bytesOf(w.macFile).equals(v2)).toBe(true)
})

test("RD-41 the door and the runner cannot write the hub's diary line, and a line they can write in another stream or actor is not read", async () => {
  const w = await world()
  await deliver(w, "pi")
  const v1 = bytesOf(w.macFile)
  const evil = Buffer.from("[hub]\nstore_url = \"postgres://127.0.0.1:1/evil\"\n")
  const forged = { machine: "pi", sha256: sha(evil), size: evil.length }
  for (const role of ["runner", "door"] as const) {
    const store = w[role]
    await expect((async () => {
      await store.sql`insert into ledger_event (stream, subject, kind, actor, detail) values ('machine', 'registry:pi', 'registry.published', 'hub', ${forged})`
    })(), `${role} as the hub`).rejects.toThrow()
    await expect((async () => {
      await store.sql`insert into ledger_event (stream, subject, kind, actor, detail) values ('machine', 'registry:pi', 'registry.published', ${role}, ${forged})`
    })(), `${role} in the hub's stream`).rejects.toThrow()
  }
  // What the runner CAN write: its own stream, under its own actor, naming the same subject and kind. Its sheet carries the evil bytes with the right hash.
  await w.runner.sql`insert into ledger_event (stream, subject, kind, actor, detail) values ('runner', 'registry:pi', 'registry.published', 'runner', ${forged})`
  await w.runner.sql`insert into state_row (sheet, id, data) values (${REGISTRY_COPY_SHEET}, ${"pi"}, ${{ sha256: sha(evil), size: evil.length, bytes_b64: evil.toString("base64") }})
    on conflict (sheet, id) do update set data = excluded.data`
  expect(await deliver(w, "mac")).toBe("current")
  expect(bytesOf(w.macFile).equals(v1)).toBe(true)
  // A spoke that holds nothing the authority published, with only that forged line to go on, writes nothing.
  writeFileSync(w.macFile, "# a copy of something else\n" + readFileSync(w.piFile, "utf8"))
  const other = bytesOf(w.macFile)
  expect(await deliver(w, "mac")).toBe("diverged")
  expect(bytesOf(w.macFile).equals(other)).toBe(true)
})

// ---------------------------------------------------------------------------------------------------------------------------------------
// The destination's own loader.
// ---------------------------------------------------------------------------------------------------------------------------------------

test("RD-50 a published file that does not load on the spoke is refused once, without a value, kept as .refused, and retried when the minute is up", async () => {
  const w = await world()
  await deliver(w, "pi")
  const v1 = bytesOf(w.macFile)
  const missing = join(w.macDir, `instructions-${MARK}.md`)
  // v2 names a file on the mac only. The pi loads it (a placement for another machine need only be absolute); the mac cannot.
  writeFileSync(w.piFile, readFileSync(w.piFile, "utf8").replace(/(\[\[people\]\][\s\S]*?)on = \{ mac = \{ ([^}]*) \} \}/, `$1on = { mac = { $2, instructions = [${JSON.stringify(missing)}] } }`))
  expect(readFileSync(w.piFile, "utf8")).toContain(MARK)
  const v2 = bytesOf(w.piFile)
  expect(await deliver(w, "pi")).toBe("published")
  expect(await deliver(w, "mac")).toBe("refused")
  expect(bytesOf(w.macFile).equals(v1)).toBe(true)
  const said = await lines(w, "registry.copy-refused")
  expect(said).toHaveLength(1)
  expect(said[0].detail).toMatchObject({ machine: "mac", reference: "pi", step: "load" })
  expect(typeof said[0].detail.line).toBe("number")
  const [leak] = await w.su`select count(*)::int as n from ledger_event where detail::text like ${`%${MARK}%`}`
  expect(leak.n, "the missing file's name is the loader's sentence's, and it is not in the diary").toBe(0)
  expect(bytesOf(join(w.macDir, ".registry.toml.refused")).equals(v2)).toBe(true)
  // Within the minute: nothing is tried and nothing is said. When the person creates the file and the minute is up, it installs.
  expect(await deliver(w, "mac")).toBe("refused")
  expect(await lines(w, "registry.copy-refused")).toHaveLength(1)
  writeFileSync(missing, "# instructions\n")
  w.clock.at += REFUSED_RETRY_MS - 1
  expect(await deliver(w, "mac")).toBe("refused")
  w.clock.at += 2
  expect(await deliver(w, "mac")).toBe("installed")
  expect(bytesOf(w.macFile).equals(v2)).toBe(true)
  expect(await lines(w, "registry.copy-refused")).toHaveLength(1)
})

// ---------------------------------------------------------------------------------------------------------------------------------------
// Crashes and races.
// ---------------------------------------------------------------------------------------------------------------------------------------

test("RD-60 a crash between the sheet and the line leaves a spoke waiting, the next tick appends only the line, and a stray candidate file is ignored", async () => {
  const w = await world()
  await deliver(w, "pi")
  const v2 = editPi(w, "v2")
  // The sheet is written and the process dies before its line.
  await putRow(w.hubPi, REGISTRY_COPY_SHEET, "pi", { sha256: sha(v2), size: v2.length, bytes_b64: v2.toString("base64"), at: new Date().toISOString() })
  const stray = join(w.macDir, ".registry.toml.candidate-deadbeef")
  writeFileSync(stray, "junk left by a crash")
  expect(await deliver(w, "mac"), "the line still says the version the spoke holds").toBe("current")
  const [row] = await w.su`select updated_at from state_row where sheet = ${REGISTRY_COPY_SHEET} and id = 'pi'`
  expect(await deliver(w, "pi")).toBe("published")
  const [after] = await w.su`select updated_at from state_row where sheet = ${REGISTRY_COPY_SHEET} and id = 'pi'`
  expect(new Date(after.updated_at).getTime(), "the sheet already held the bytes, so only the line was written").toBe(new Date(row.updated_at).getTime())
  expect(await lines(w, "registry.published")).toHaveLength(2)
  expect(await deliver(w, "mac")).toBe("installed")
  expect(bytesOf(w.macFile).equals(v2)).toBe(true)
  expect(readFileSync(stray, "utf8")).toBe("junk left by a crash")
})

test("RD-61 a line ahead of its bytes is a spoke that waits, writes nothing, and installs the moment the bytes are there", async () => {
  const w = await world()
  await deliver(w, "pi")
  const v1 = bytesOf(w.macFile)
  const v2 = editPi(w, "v2")
  await appendEntry(w.hubPi, { stream: "machine", subject: "registry:pi", kind: "registry.published", actor: "hub", detail: { machine: "pi", sha256: sha(v2), size: v2.length } })
  expect(await deliver(w, "mac")).toBe("waiting")
  expect(bytesOf(w.macFile).equals(v1)).toBe(true)
  expect(await deliver(w, "pi")).toBe("published")
  expect(await deliver(w, "mac")).toBe("installed")
  expect(bytesOf(w.macFile).equals(v2)).toBe(true)
})

test("RD-62 a newer publication that lands while an install waits is not overwritten by the older one: the install is refused as stale, nothing is written, and the next tick installs the newer", async () => {
  const w = await world()
  await deliver(w, "pi")
  const v1 = bytesOf(w.macFile)
  editPi(w, "v2")
  await deliver(w, "pi")
  const newer: { v3: Buffer | null } = { v3: null }
  expect(await deliver(w, "mac", {
    seam: { beforeRename: async () => { newer.v3 = editPi(w, "v3"); await deliver(w, "pi") } },
  })).toBe("waiting")
  expect(bytesOf(w.macFile).equals(v1), "the older publication was not written over anything").toBe(true)
  expect(await lines(w, "registry.copy-installed")).toEqual([])
  expect(strays(w.macDir)).toEqual([])
  expect(await deliver(w, "mac")).toBe("installed")
  expect(bytesOf(w.macFile).equals(newer.v3!)).toBe(true)
})

test("RD-63 a hand edit that lands on the spoke while an install is staged survives, and is then a divergence", async () => {
  const w = await world()
  await deliver(w, "pi")
  editPi(w, "v2")
  await deliver(w, "pi")
  const mine = `${readFileSync(w.macFile, "utf8")}\n# my edit, while the hub was copying\n`
  expect(await deliver(w, "mac", { seam: { beforeRename: () => { writeFileSync(w.macFile, mine) } } })).toBe("waiting")
  expect(readFileSync(w.macFile, "utf8")).toBe(mine)
  expect(strays(w.macDir)).toEqual([])
  expect(await deliver(w, "mac")).toBe("diverged")
  expect(readFileSync(w.macFile, "utf8")).toBe(mine)
})

test("RD-64 a file this process cannot read or replace is said by its code alone and not again for a minute, and the tick goes on", async () => {
  const w = await world()
  await deliver(w, "pi")
  editPi(w, "v2")
  await deliver(w, "pi")
  // The store answers the install's freshness question (the second read of the latest publication: the first is the standing) with an error whose
  // text names a value, once.
  let reads = 0
  const wrapped: StoreLike = {
    url: w.hubMac.url,
    sql: new Proxy(w.hubMac.sql as object, {
      apply(target, self, args) {
        const text = Array.isArray(args[0]) ? (args[0] as string[]).join("?") : ""
        if (text.includes("select seq, detail->>'sha256'")) { reads += 1; if (reads === 2) throw Object.assign(new Error(`could not reach ${MARK}`), { code: "ECONNRESET" }) }
        return Reflect.apply(target as never, self, args)
      },
      get(target, key) { const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value },
    }) as never,
  }
  expect(await deliverRegistry({ ...contextOf(w, "mac"), store: wrapped })).toBe("waiting")
  const said = await lines(w, "registry.copy-failed")
  expect(said).toHaveLength(1)
  expect(said[0].detail).toMatchObject({ machine: "mac", code: "ECONNRESET" })
  const [leak] = await w.su`select count(*)::int as n from ledger_event where detail::text like ${`%${MARK}%`}`
  expect(leak.n).toBe(0)
  expect(strays(w.macDir)).toEqual([])
  // The store answers again, and the install is made.
  expect(await deliverRegistry({ ...contextOf(w, "mac"), store: wrapped })).toBe("installed")
})

// ---------------------------------------------------------------------------------------------------------------------------------------
// The operator's override of a diverged copy.
// ---------------------------------------------------------------------------------------------------------------------------------------

/** `imprnt hub ...` as the command runs it, with what it printed. */
async function cli(args: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = []
  const err: string[] = []
  const writeOut = process.stdout.write.bind(process.stdout)
  const writeErr = process.stderr.write.bind(process.stderr)
  process.stdout.write = ((chunk: unknown) => { out.push(String(chunk)); return true }) as typeof process.stdout.write
  process.stderr.write = ((chunk: unknown) => { err.push(String(chunk)); return true }) as typeof process.stderr.write
  try {
    const code = await command(args)
    return { code, out: out.join(""), err: err.join("") }
  } finally {
    process.stdout.write = writeOut
    process.stderr.write = writeErr
  }
}

test("RD-70 the CLI says where a copy stands, replaces a diverged copy only for its exact digest, keeps those bytes under a name of their own, and refuses on the store machine", async () => {
  const w = await world()
  await deliver(w, "pi")
  // current
  let said = await cli(["registry", w.macFile, "mac"])
  expect([said.code, said.out]).toEqual([0, expect.stringContaining("current")])
  // behind: an earlier published version, which the hub itself replaces
  const v2 = editPi(w, "v2")
  await deliver(w, "pi")
  said = await cli(["registry", w.macFile, "mac"])
  expect(said.code).toBe(1)
  expect(said.out).toContain("behind")
  // diverged
  const local = Buffer.from(`${readFileSync(w.macFile, "utf8")}\n# an edit of mine\n`)
  writeFileSync(w.macFile, local)
  said = await cli(["registry", w.macFile, "mac"])
  expect(said.code).toBe(1)
  expect(said.out).toContain("diverged")
  expect(said.out).toContain(sha(local).slice(0, 16))
  expect(said.out).toContain(sha(v2).slice(0, 16))
  // a malformed digest is usage, and a digest that is not the file's is refused: nothing is changed by either
  expect((await cli(["registry", w.macFile, "mac", "not-a-digest"])).code).toBe(2)
  said = await cli(["registry", w.macFile, "mac", "0".repeat(64)])
  expect(said.code).toBe(1)
  expect(said.out).toContain("refused")
  expect(bytesOf(w.macFile).equals(local)).toBe(true)
  expect(readdirSync(w.macDir).filter(name => name.includes(".diverged"))).toEqual([])
  // the exact digest: the bytes are kept first, under a name that is theirs, and a person's own earlier backup is not touched
  const theirs = join(w.macDir, ".registry.toml.diverged")
  writeFileSync(theirs, "USER DATA THAT MUST SURVIVE")
  said = await cli(["registry", w.macFile, "mac", sha(local)])
  expect([said.code, said.err]).toEqual([0, ""])
  expect(said.out).toContain("replaced")
  expect(bytesOf(w.macFile).equals(v2)).toBe(true)
  const backup = backupPathFor(w.macFile, sha(local))
  expect(readFileSync(backup).equals(local)).toBe(true)
  expect(said.out).toContain(`.registry.toml.diverged-${sha(local)}`)
  expect(readFileSync(theirs, "utf8")).toBe("USER DATA THAT MUST SURVIVE")
  const replaced = await lines(w, "registry.copy-replaced")
  expect(replaced).toHaveLength(1)
  expect(replaced[0]).toMatchObject({ actor: "hub", subject: "registry-copy:mac", detail: { machine: "mac", from: sha(local).slice(0, 16), to: sha(v2).slice(0, 16) } })
  // a current copy is not "replaced" again, and a second divergence gets a backup of its own, the first untouched
  expect((await cli(["registry", w.macFile, "mac", sha(v2)])).code).toBe(1)
  const again = Buffer.from(`${v2.toString("utf8")}\n# a second edit of mine\n`)
  writeFileSync(w.macFile, again)
  said = await cli(["registry", w.macFile, "mac", sha(again)])
  expect(said.code).toBe(0)
  expect(readFileSync(backupPathFor(w.macFile, sha(again))).equals(again)).toBe(true)
  expect(readFileSync(backup).equals(local)).toBe(true)
  // the store machine's own file is never replaced from a copy
  said = await cli(["registry", w.piFile, "pi", sha(bytesOf(w.piFile))])
  expect(said.code).toBe(1)
  expect(said.out).toContain("store machine")
  // and its status is its own
  said = await cli(["registry", w.piFile, "pi"])
  expect([said.code, said.out]).toEqual([0, expect.stringContaining("store machine")])
})

test("RD-71 an override that cannot keep the bytes it discards replaces nothing, and one that finds the file changed since the digest was read is refused", async () => {
  const w = await world()
  await deliver(w, "pi")
  const v2 = editPi(w, "v2")
  await deliver(w, "pi")
  const local = Buffer.from(`${readFileSync(w.macFile, "utf8")}\n# mine\n`)
  writeFileSync(w.macFile, local)
  const args ={ store: w.hubMac, registryFile: w.macFile, machine: "mac", registry: loadRegistry(w.macFile, { machine: "mac" }), digest: sha(local), say: async () => {} }
  // A conflicting file already under the backup's own name: the bytes cannot be kept, so nothing is replaced.
  writeFileSync(backupPathFor(w.macFile, sha(local)), "something else")
  expect(await overrideRegistryCopy(args)).toMatchObject({ result: "refused", cause: "backup" })
  expect(bytesOf(w.macFile).equals(local)).toBe(true)
  expect(readFileSync(backupPathFor(w.macFile, sha(local)), "utf8")).toBe("something else")
  rmSync(backupPathFor(w.macFile, sha(local)))
  // A hand edit lands after the digest was read: refused, and the edit survives.
  const edit = `${local.toString("utf8")}# and another\n`
  expect(await overrideRegistryCopy({ ...args, seam: { beforeRename: () => { writeFileSync(w.macFile, edit) } } })).toMatchObject({ result: "refused", cause: "busy" })
  expect(readFileSync(w.macFile, "utf8")).toBe(edit)
  expect(strays(w.macDir)).toEqual([])
  // The bytes the backup holds are what was read inside the lock, never a later or an earlier snapshot.
  expect(readFileSync(backupPathFor(w.macFile, sha(local))).equals(local)).toBe(true)
  // And with nothing in the way the digest of the file as it is now replaces it.
  expect(await overrideRegistryCopy({ ...args, digest: sha(edit), registry: loadRegistry(w.macFile, { machine: "mac" }) })).toMatchObject({ result: "replaced" })
  expect(bytesOf(w.macFile).equals(v2)).toBe(true)
})

// ---------------------------------------------------------------------------------------------------------------------------------------
// The real hub tick.
// ---------------------------------------------------------------------------------------------------------------------------------------

test("RD-80 the real hub of each machine delivers on its tick: a change made with the editor on the pi reaches the mac's file, and the mac's hub renders from what it installed", async () => {
  const here = process.platform === "darwin" ? "macos" : "linux"
  const flavour = process.platform === "darwin" ? "launchd" : "systemd"
  const w = await world({ os: here, hubs: true })
  const piUnits = join(w.piDir, "units")
  const macUnits = join(w.macDir, "units")
  mkdirSync(piUnits)
  mkdirSync(macUnits)
  const piOs = serviceOs(piUnits, flavour, ["hub-pi", DOOR])
  const macOs = serviceOs(macUnits, flavour, ["hub-mac", RUNNER2, "runner-mac-2"])
  const stop = (one: { stop(): Promise<void> }) => { hubs.push(one); return one }
  stop(await runHub({ registryFile: w.piFile, machine: "pi", os: piOs.os }))
  await until("the pi's hub published its file", async () => (await lines(w, "registry.published")).length === 1, 30_000)
  expect((await lines(w, "registry.published"))[0].detail.sha256).toBe(sha(bytesOf(w.piFile)))
  stop(await runHub({ registryFile: w.macFile, machine: "mac", os: macOs.os }))
  await until("the mac's hub wrote its digest", async () => (await w.su`select 1 from state_row where sheet = ${REGISTRY_SHEET} and id = 'mac'`).length > 0, 30_000)
  expect(await lines(w, "registry.copy-installed"), "a copy that is the published one is not touched").toEqual([])
  // The editor, as the pi's hub applies a lifecycle command or a move: one more runner on the mac.
  await appendRegistryEntry(w.piFile, "run", { id: "runner-mac-2", kind: "runner", machine: "mac", schedule: "always", memory_limit_mb: 512, child_memory_limit_mb: 512 })
  const v2 = bytesOf(w.piFile)
  await until("the mac's file is the pi's", async () => bytesOf(w.macFile).equals(v2), 30_000)
  await until("the mac's hub rendered the entry it installed", async () =>
    (await w.su`select 1 from ledger_event where stream = 'machine' and kind = 'unit.installed' and subject = 'runner-mac-2'`).length > 0, 30_000)
  const installed = (await lines(w, "registry.copy-installed"))
  expect(installed).toHaveLength(1)
  const [unit] = await w.su`select seq from ledger_event where stream = 'machine' and kind = 'unit.installed' and subject = 'runner-mac-2' order by seq limit 1`
  expect(installed[0].seq, "the install comes before what is rendered from it").toBeLessThan(Number(unit.seq))
  await until("the mac's digest row is the new file's", async () => {
    const [row] = await w.su`select data->>'sha256' as sha from state_row where sheet = ${REGISTRY_SHEET} and id = 'mac'`
    return row?.sha === sha(v2)
  }, 30_000)
  expect(await lines(w, "registry.published")).toHaveLength(2)
  expect(strays(w.macDir)).toEqual([])
}, SLOW)

// ---------------------------------------------------------------------------------------------------------------------------------------
// A move's registry receipt arrives on the spoke.
// ---------------------------------------------------------------------------------------------------------------------------------------

type World2 = ReturnType<typeof handoffWorld>
interface Rig { s: MoveFixture; move: Awaited<ReturnType<MoveFixture["request"]>>; agent: string; dir: string; file: string; macFile: string; dst: World2; src: World2 }

function writeMovePair(dir: string, agent: string): { file: string; macFile: string } {
  const macDir = join(dir, "mac")
  mkdirSync(macDir)
  const file = writeRegistry(dir, {
    hub: { state_dir: dir, store_url: "postgres://127.0.0.1:1/unused", store_machine: "pi" },
    machines: [{ id: "pi", os: "linux" }, { id: "mac", os: "macos", store_url: "postgres://127.0.0.1:1/unused" }],
    people: [{ id: "p1", tree: join(dir, "p1") } as PersonSpec],
    presets: { daily: { adapter: "a-scripted-adapter", model: "m", provider: "p", effort: "medium", paid: "key" } },
    agents: [{ id: agent, person: "p1", preset: "daily", chat: "1000000001", door: "door-fake", runner: SRC.runner }],
    run: [
      { id: "door-fake", kind: "door", machine: "pi", platform: "fake", person: "p1", token_file: "/dev/null", schedule: "always", memory_limit_mb: 192 },
      { id: SRC.runner, kind: "runner", machine: SRC.machine, schedule: "always", memory_limit_mb: 512, child_memory_limit_mb: 512 },
      { id: DST.runner, kind: "runner", machine: DST.machine, schedule: "always", memory_limit_mb: 512, child_memory_limit_mb: 512 },
    ],
  })
  const macFile = join(macDir, "registry.toml")
  copyFileSync(file, macFile)
  return { file, macFile }
}

async function moveRig(): Promise<Rig> {
  const s = await moveStage(cluster, track)
  await s.fleet()
  const agent = `t-${crypto.randomUUID()}`
  const topic = await s.topic(`rd-${s.next()}`, { identity: () => ({ ...newIdentity(), agent_id: agent }) })
  const move = await s.request(topic)
  await s.su`update conversation set native_state = 'started' where id = ${move.conversation_id}`
  const dir = scratch()
  const { file, macFile } = writeMovePair(dir, agent)
  const locks = lockChain()
  const fake = fakePort({ lockHeld: () => locks.held.size > 0 })
  const src = handoffWorld(s, "source", { port: fake.port, locks })
  const dst = handoffWorld(s, "dest", { port: fake.port, locks })
  src.w.scope = row => scopeOf(loadRegistry(file), row)
  src.w.sourceProfile = row => profileOf(loadRegistry(file), row.agent)
  dst.w.profile = row => ({ move: row.id, agent: row.agent, runner: row.dest_runner, machine: row.dest_machine, profile: profileOf(loadRegistry(file), row.agent)!, basis: "test: the registry file" })
  return { s, move, agent, dir, file, macFile, src, dst }
}

async function activated(r: Rig): Promise<void> {
  expect(await prepareDestination(r.dst.w, r.move.id)).toMatchObject({ state: "done", reason: "ready" })
  await drainOnly(r.s, r.move)
  expect(await exportSource(r.src.w, PROVEN, r.move.id)).toMatchObject({ state: "done", reason: "released" })
  expect(await importDestination(r.dst.w, r.move.id)).toMatchObject({ state: "done", reason: "activated" })
}

const movesOf = (r: Rig): RegistryMovesContext => ({ store: r.s.hub, registryFile: r.file, machine: "pi", load: () => loadRegistry(r.file, { machine: "pi" }) })

/** The pi's tick for this file, and the mac's tick for the copy: the delivery, with the stage's own hub store for the pi and a hub of its own for the mac. */
function ticks(r: Rig) {
  const mac = r.s.as("hub_hub")
  const ctx = (machine: "pi" | "mac"): DeliveryContext => {
    const registryFile = machine === "pi" ? r.file : r.macFile
    const store = machine === "pi" ? r.s.hub : mac
    const load = () => loadRegistry(registryFile, { machine })
    return { store, registryFile, machine, registry: load(), load, say: async (kind, subject, detail) => { await appendEntry(store, { stream: "machine", subject, kind, actor: "hub", detail }) } }
  }
  return { pi: () => deliverRegistry(ctx("pi")), mac: () => deliverRegistry(ctx("mac")) }
}

test("RD-90 a move's registry write on the store machine arrives on the spoke: after one publish and one install the copy's digest is the receipt's", async () => {
  const r = await moveRig()
  await activated(r)
  const tick = ticks(r)
  expect(await tick.pi()).toBe("published")
  expect(await tick.mac()).toBe("current")
  await registerMoves(movesOf(r))
  const receipt = (await r.s.reread(r.move)).registry_receipt!
  expect(receipt.digest).toBe(registryDigest(r.file))
  expect(registryDigest(r.macFile), "the copy is still the earlier published version").not.toBe(receipt.digest)
  expect(await tick.pi()).toBe("published")
  expect(await tick.mac()).toBe("installed")
  expect(registryDigest(r.macFile)).toBe(receipt.digest)
  expect(listAgents(loadRegistry(r.macFile, { machine: "mac" })).find(one => one.id === r.agent)?.runner).toBe(DST.runner)
})

test("RD-91 and the destination serves from that copy: what it loaded is the receipt's bytes", async () => {
  const r = await moveRig()
  await activated(r)
  const tick = ticks(r)
  await tick.pi()
  await tick.mac()
  await registerMoves(movesOf(r))
  await tick.pi()
  expect(await tick.mac()).toBe("installed")
  const world: ServeWorld = {
    ...r.dst.w,
    loaded: () => ({ digest: registryDigest(r.macFile), registry: loadRegistry(r.macFile, { machine: "mac" }) }),
    serving: () => true,
    language: () => "en",
  }
  expect(await serveDestination(world, r.move.id)).toMatchObject({ state: "done", reason: "active" })
})
