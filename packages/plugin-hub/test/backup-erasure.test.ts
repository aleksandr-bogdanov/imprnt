// The backup and a deletion meet in one place: a copy is never assembled across an erasure generation, never while a confirmed deletion's rows
// or this machine's files for it are still to be removed, carries the content-free control manifest and the generation it was made under, and
// the retention the owner configured is carried out as far as the destination can: copies listed, aged by their own manifest and removed whole.
//
// Real commands, no provider: `pg_dump`, `cp`, `ls` and `rm` run through the stage's recorder, against a throwaway cluster. The checks that need
// a copy to LAND need a second device and skip with the reason in their name where the machine cannot give one; the refusals do not.
// What is PLANTED, and decides nothing the code under test decides: the confirmed deletion (its row, its tombstone and the receipt of a file)
// and the age of a copy at the destination.

import { afterAll, beforeAll, expect, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { pgBin, seam, startCluster, type Cluster } from "./helpers/cluster.ts"
import { backupStage, deviceGate, filesUnder, gateSuffix, pgDumpGate, type BackupStage } from "./helpers/backup-stage.ts"
import { THIS_MACHINE } from "./helpers/zone-stage.ts"
import { loadRegistry } from "../src/registry/load.ts"
import { listRunEntries } from "../src/registry/entries.ts"
import { SEAL_FILE, generationIdOf, registerSeal } from "../src/erasure/retention.ts"

let cluster: Cluster
beforeAll(async () => { cluster = await startCluster() })
afterAll(async () => { await cluster?.stop() })

const DEVICE = deviceGate()
const landed = DEVICE.ok ? test : test.skip
const SLOW = 180_000
/** Not a local path at all, so no device question is asked of it and nothing can land there: a refusal before the upload leaves nothing behind. */
const AWAY = `elsewhere-${crypto.randomUUID()}`
afterAll(() => rmSync(join(process.cwd(), AWAY), { recursive: true, force: true }))

type Refused = Error & { code: string; reason: string; detail: string }

async function copy(stage: BackupStage): Promise<{ result?: Record<string, unknown>; error?: Refused }> {
  const mod = await seam("src/backup/run.ts")
  const registry = loadRegistry(stage.registryFile)
  const entry = listRunEntries(registry).find(one => one.id === stage.entry)
  expect(entry).toBeDefined()
  try {
    return { result: await (mod.runBackup as (entry: unknown, registry: unknown) => Promise<Record<string, unknown>>)(entry, registry) }
  } catch (error) {
    expect(error).toBeInstanceOf(mod.BackupRefused as new (...args: unknown[]) => Error)
    return { error: error as Refused }
  }
}

const sql = (stage: BackupStage, query: string, values?: unknown[]) => stage.store.read.sql(query, values)

/** A deletion the owner confirmed (the generation it was confirmed under is 1), as its row and its tombstone say it. */
async function plantDeletion(stage: BackupStage, state: "quiescing" | "pending_machine" | "active_deleted"): Promise<void> {
  await sql(stage, `insert into topic_deletion (id, topic_id, person, agent_id, conversation_id, door, requested_by, source, preview, stage,
      confirmation_id, confirmed_by, confirmed_at, deletion_generation)
    values ('del-1', 'topic-1', 'p1', 't-agent-1', 'conv-1', 'door-fake', 'owner', 'tool', '{}'::jsonb, $1, 'cf-1', 'owner', now(), 1)`, [state])
  await sql(stage, `insert into topic_tombstone (topic_id, person, agent_id, conversation_id, origin, door, machine, runner, deletion_id, deletion_generation, active_deleted_at)
    values ('topic-1', 'p1', 't-agent-1', 'conv-1', 'created', 'door-fake', 'pi', 'runner-pi', 'del-1', 1, ${state === "active_deleted" ? "now()" : "null"})`)
  await sql(stage, "update erasure_control set generation = 1")
}

async function failures(stage: BackupStage): Promise<Record<string, unknown>[]> {
  const rows = (await sql(stage, "select detail from ledger_event where kind = 'failed' and subject = $1 order by seq", [stage.entry])) as { detail: Record<string, unknown> }[]
  return rows.map(row => row.detail)
}

function landing(stage: BackupStage, name = "copies"): string {
  const other = stage.otherDevice()
  if (other.path === null) throw new Error(`the device gate said yes and the stage said no: ${other.reason}`)
  const path = join(other.path, name)
  mkdirSync(path, { recursive: true })
  return path
}

/** What a destination is told when each copy gets a place of its own, and can list its copies and remove one. */
function generated(stage: BackupStage): { upload_argv: string[]; readback_argv: string[]; list_argv: string[]; expire_argv: string[] } {
  return {
    upload_argv: [stage.recorder, "/bin/cp", "-R", "-f", "{staging}/.", "{destination}/{generation}"],
    readback_argv: [stage.recorder, "/bin/cp", "{destination}/{generation}/{path}", "{out}"],
    list_argv: [stage.recorder, "/bin/ls", "{destination}"],
    expire_argv: [stage.recorder, "/bin/rm", "-rf", "{destination}/{generation}"],
  }
}

/** A copy that is already at the destination, made `days` days ago under an erasure generation, as its own manifest says. */
function oldCopy(destination: string, days: number, erasureGeneration: number): string {
  const at = new Date(Date.now() - days * 86_400_000)
  const id = generationIdOf(at)
  mkdirSync(join(destination, id, "dump"), { recursive: true })
  writeFileSync(join(destination, id, "dump", "hub.sql"), "-- an earlier dump\n")
  writeFileSync(join(destination, id, "manifest.json"), JSON.stringify({ at: at.toISOString(), machine: THIS_MACHINE, files: [], erasure_generation: erasureGeneration }))
  return id
}

test("a copy is held while a confirmed deletion's rows are still to go and while this machine's file for it is: it says why, dumps and sends nothing, and the next run assembles it fresh", async () => {
  const stage = await backupStage(cluster)
  try {
    stage.configure({ destination: AWAY })
    await plantDeletion(stage, "quiescing")
    stage.clearCalls()
    const first = await copy(stage)
    expect(first.error?.code).toBe("barrier")
    expect(first.error?.detail).toContain("has not erased the store's rows yet")
    // The refusal is the shipped one: no stamp, one diary line, the cause on the sheet, and nothing was uploaded or read back.
    expect((await stage.store.read.sheet("job_success")).find(row => row.id === stage.entry)).toBeUndefined()
    expect((await stage.store.read.sheet("backup")).find(row => row.id === stage.entry)?.data).toMatchObject({ status: "failed", code: "barrier" })
    expect((await failures(stage)).map(one => one.code)).toEqual(["backup-barrier"])
    expect(stage.calls()).toEqual([])

    // The rows are gone, and a copy of the topic's files on THIS machine is still to be removed: the copy would carry it.
    await sql(stage, "update topic_deletion set stage = 'pending_machine' where id = 'del-1'")
    await sql(stage, "insert into erasure_receipt (deletion_id, class, location, machine, state) values ('del-1', 'chatlog', 't-agent-1', $1, 'pending')", [THIS_MACHINE])
    const second = await copy(stage)
    expect(second.error?.code).toBe("barrier")
    expect(second.error?.detail).toContain("still waiting to be removed")
    await sql(stage, "update erasure_receipt set state = 'blocked' where deletion_id = 'del-1'")
    expect((await copy(stage)).error?.code).toBe("barrier")
    expect(stage.calls()).toEqual([])
  } finally {
    await stage.remove()
  }
}, SLOW)

test("a copy assembled across an erasure generation is never published: a deletion confirmed while it was being made holds it, after it was dumped and before it was sent", async () => {
  const gate = pgDumpGate()
  const stage = await backupStage(cluster)
  try {
    // The dump command confirms a deletion's generation under the copy's feet, then dumps.
    stage.configure({
      destination: AWAY,
      dump_argv: ["/bin/sh", "-c", `"${pgBin("psql")}" -X -q -o /dev/null -c "update erasure_control set generation = generation + 1" "$1" && "${gate.bin}" --dbname "$1"`,
        "dump", `postgres://${cluster.superuser}@127.0.0.1:${cluster.port}/${stage.store.db}`],
    })
    stage.clearCalls()
    const { error } = await copy(stage)
    expect(error?.code).toBe("barrier")
    expect(error?.detail).toContain("was being assembled")
    expect(stage.calls(), "nothing was sent").toEqual([])
  } finally {
    await stage.remove()
  }
}, SLOW)

landed(`a copy that lands carries the content-free control manifest and the generation it was made under, and a retention the destination cannot carry out is reported unverified${gateSuffix(DEVICE)}`, async () => {
  const stage = await backupStage(cluster)
  try {
    await plantDeletion(stage, "active_deleted")
    stage.configure({ destination: landing(stage) })
    const first = await copy(stage)
    expect(first.error).toBeUndefined()
    // The control manifest is identifiers only, in the copy and at the destination, and the copy's manifest says which generation it was made under.
    const control = JSON.parse(readFileSync(join(stage.staging, "erasure-manifest.json"), "utf8")) as { generation: number; tombstones: Record<string, unknown>[] }
    expect(control.generation).toBe(1)
    expect(control.tombstones.map(one => one.topic_id)).toEqual(["topic-1"])
    expect(Object.keys(control.tombstones[0]).sort()).toEqual(
      ["active_deleted", "agent_id", "chat", "conversation_id", "deletion_generation", "deletion_id", "door", "machine", "origin", "person", "runner", "topic_id", "worker_locations", "workers"])
    expect(existsSync(join(stage.destination, "erasure-manifest.json"))).toBe(true)
    const manifest = JSON.parse(readFileSync(join(stage.staging, "manifest.json"), "utf8")) as Record<string, unknown>
    expect(manifest).toMatchObject({ erasure_generation: 1, retention_days: null, expires_at: null })
    expect(first.result).toMatchObject({ erasure_generation: 1, retention: { days: null, state: "not_configured", expires_at: null } })

    // The owner's number is recorded on the copy and counted from its own creation; the destination declares nothing that lists or expires, so
    // the deletion says its earlier copies remain, with the reason, and nothing is expired.
    stage.configure({ retention_days: 30 })
    const second = await copy(stage)
    expect(second.error).toBeUndefined()
    const again = JSON.parse(readFileSync(join(stage.staging, "manifest.json"), "utf8")) as { at: string; retention_days: number; expires_at: string }
    expect(again.retention_days).toBe(30)
    expect(Date.parse(again.expires_at) - Date.parse(again.at)).toBe(30 * 86_400_000)
    expect(second.result).toMatchObject({ retention: { days: 30, state: "retention_unverified" } })
    const [row] = await sql(stage, "select retention_state, retention_detail from topic_deletion where id = 'del-1'") as { retention_state: string; retention_detail: { reason: string } }[]
    expect(row.retention_state).toBe("retention_unverified")
    expect(row.retention_detail.reason).toContain("none of them can list the copies it holds or remove one")
  } finally {
    await stage.remove()
  }
}, SLOW)

landed(`with a destination that lists and expires, each copy has a place of its own and a standalone dump, and a copy older than the owner's days is removed whole and shown gone${gateSuffix(DEVICE)}`, async () => {
  const stage = await backupStage(cluster)
  try {
    await plantDeletion(stage, "active_deleted")
    const destination = landing(stage)
    // An earlier copy, 40 days old, made before the deletion; and another 5 days old, which is not due. And a name that is not a copy's.
    const old = oldCopy(destination, 40, 0)
    const recent = oldCopy(destination, 5, 0)
    mkdirSync(join(destination, "legacy-dump"), { recursive: true })
    stage.configure({ destination, retention_days: 30, ...generated(stage) })
    stage.clearCalls()
    const { result, error } = await copy(stage)
    expect(error).toBeUndefined()

    // The copy is a generation of its own: standalone dump (no repository, so no earlier dump's history rides along), the manifests, the files.
    const id = String(result!.generation)
    const here = join(destination, id)
    expect(existsSync(join(here, "dump", "hub.sql"))).toBe(true)
    expect(existsSync(join(here, "dump", ".git"))).toBe(false)
    expect(filesUnder(here)).toContain("erasure-manifest.json")
    expect(filesUnder(here)).toContain("manifest.json")
    expect(existsSync(join(stage.staging, "dump", ".git")), "the legacy dump repository is not touched and not sent").toBe(false)

    // THE OLD COPY IS GONE, whole, and only it: the recent one, the copy just made and what is not a copy's are where they were.
    expect(existsSync(join(destination, old))).toBe(false)
    expect([recent, id, "legacy-dump"].map(name => existsSync(join(destination, name)))).toEqual([true, true, true])
    expect(stage.calls().filter(call => call[0] === "/bin/rm")).toEqual([["/bin/rm", "-rf", join(destination, old)]])
    // The deletion's account: its history is the copy made before it (the old one), shown gone by the destination's own listing.
    const [row] = await sql(stage, "select retention_state from topic_deletion where id = 'del-1'") as { retention_state: string }[]
    expect(row.retention_state).toBe("retention_unverified")
    const receipts = await sql(stage, "select location, state from erasure_receipt where deletion_id = 'del-1' and historical order by location") as { location: string; state: string }[]
    expect(receipts).toEqual([{ location: old, state: "expired" }, { location: recent, state: "pending" }])
    expect(await failures(stage)).toEqual([])
  } finally {
    await stage.remove()
  }
}, SLOW)

landed(`a failed fresh copy is no reason to keep expired history: the held copy reports its failure, and the expiry still runs${gateSuffix(DEVICE)}`, async () => {
  const stage = await backupStage(cluster)
  try {
    const destination = landing(stage)
    const old = oldCopy(destination, 40, 0)
    stage.configure({ destination, retention_days: 30, ...generated(stage) })
    // A deletion that has not erased its rows yet holds the new copy.
    await plantDeletion(stage, "quiescing")
    stage.clearCalls()
    const { error } = await copy(stage)
    expect(error?.code).toBe("barrier")
    expect(existsSync(join(destination, old)), "the 40-day-old copy was removed all the same").toBe(false)
    expect(filesUnder(destination)).toEqual([])
    expect(stage.calls().filter(call => call[0] === "/bin/rm")).toEqual([["/bin/rm", "-rf", join(destination, old)]])
    const [row] = await sql(stage, "select retention_state from topic_deletion where id = 'del-1'") as { retention_state: string }[]
    expect(row.retention_state).toBe("retention_unverified")
  } finally {
    await stage.remove()
  }
}, SLOW)

landed(`the legacy dump repository on this box expires at its sealed date, and a deletion is called fully expired only once the destination's inventory shows nothing it cannot account for${gateSuffix(DEVICE)}`, async () => {
  const stage = await backupStage(cluster)
  try {
    await plantDeletion(stage, "active_deleted")
    const destination = landing(stage)
    const old = oldCopy(destination, 40, 0)
    // The single-directory layout's repository, still on this box; the owner's number was first applied 40 days ago.
    mkdirSync(join(stage.staging, "dump", ".git"), { recursive: true })
    writeFileSync(join(stage.staging, "dump", "hub.sql"), "-- every earlier dump\n")
    registerSeal(stage.staging, 30, new Date(Date.now() - 40 * 86_400_000))
    stage.configure({ destination, retention_days: 30, ...generated(stage) })
    expect((await copy(stage)).error).toBeUndefined()
    expect(existsSync(join(stage.staging, "dump")), "the legacy repository is past its sealed date").toBe(false)
    expect(existsSync(join(destination, old))).toBe(false)
    const row = async () => ((await sql(stage, "select retention_state, retention_detail from topic_deletion where id = 'del-1'")) as { retention_state: string; retention_detail: { reason: string } }[])[0]
    const receipts = await sql(stage, "select location, state from erasure_receipt where deletion_id = 'del-1' and historical order by location") as { location: string; state: string }[]
    expect(receipts).toEqual([{ location: old, state: "expired" }, { location: "staging-dump", state: "expired" }])
    // Every copy it knows of is shown gone, but the destination declares no inventory of what it retains: that is not "expired".
    expect((await row()).retention_state).toBe("retention_unverified")
    expect((await row()).retention_detail.reason).toContain("declares no retained_argv")

    // With an inventory that holds nothing it cannot account for, the same copies are enough.
    stage.configure({ retained_argv: [stage.recorder, "/bin/ls", "{destination}"] })
    expect((await copy(stage)).error).toBeUndefined()
    expect((await row()).retention_state).toBe("historical_copies_expired")
  } finally {
    await stage.remove()
  }
}, SLOW)

landed(`an unreadable seal while the legacy dump repository is still on this box keeps every deletion from being called fully expired, however clean the destination's inventory is${gateSuffix(DEVICE)}`, async () => {
  const stage = await backupStage(cluster)
  try {
    await plantDeletion(stage, "active_deleted")
    const destination = landing(stage)
    const old = oldCopy(destination, 40, 0)
    mkdirSync(join(stage.staging, "dump", ".git"), { recursive: true })
    writeFileSync(join(stage.staging, "dump", "hub.sql"), "-- every earlier dump\n")
    // The seal cannot be read, so it is not replaced (that would refresh the date) and the local repository is not dealt with.
    writeFileSync(join(stage.staging, SEAL_FILE), "{ torn")
    // Every copy the destination can show is gone and its inventory is clean: the only thing left uncertain is the legacy archive.
    stage.configure({ destination, retention_days: 30, ...generated(stage), retained_argv: [stage.recorder, "/bin/ls", "{destination}"] })
    expect((await copy(stage)).error, "the failed legacy handling never costs the copy").toBeUndefined()
    expect(existsSync(join(destination, old))).toBe(false)
    expect(existsSync(join(stage.staging, "dump")), "the repository is not removed on a seal that cannot be read").toBe(true)
    expect(readFileSync(join(stage.staging, SEAL_FILE), "utf8")).toBe("{ torn")
    const [row] = await sql(stage, "select retention_state, retention_detail from topic_deletion where id = 'del-1'") as { retention_state: string; retention_detail: { reason: string } }[]
    expect(row.retention_state).toBe("retention_unverified")
    expect(row.retention_detail.reason).toContain("could not be sealed, read or moved")
    expect((await failures(stage)).map(one => one.operation)).toEqual(["backup-retention"])
  } finally {
    await stage.remove()
  }
}, SLOW)

landed(`a destination that is asked to expire a copy and still lists it is reported blocked, and nothing says the copy expired${gateSuffix(DEVICE)}`, async () => {
  const stage = await backupStage(cluster)
  try {
    await plantDeletion(stage, "active_deleted")
    const destination = landing(stage)
    const old = oldCopy(destination, 40, 0)
    // An expiry command that exits zero and removes nothing, as an upload that does nothing does.
    stage.configure({ destination, retention_days: 30, ...generated(stage), expire_argv: [stage.recorder, "/usr/bin/true", "{destination}/{generation}"] })
    const { error } = await copy(stage)
    expect(error).toBeUndefined()
    expect(existsSync(join(destination, old))).toBe(true)
    const [row] = await sql(stage, "select retention_state from topic_deletion where id = 'del-1'") as { retention_state: string }[]
    expect(row.retention_state).toBe("retention_blocked")
    const receipts = await sql(stage, "select location, state from erasure_receipt where deletion_id = 'del-1' and historical") as { location: string; state: string }[]
    expect(receipts).toEqual([{ location: old, state: "retention_blocked" }])
  } finally {
    await stage.remove()
  }
}, SLOW)
