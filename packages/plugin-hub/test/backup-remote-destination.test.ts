// The off-box copy refuses a destination on the staging directory's own
// filesystem, and it can only judge a destination that IS a path on this box.
//
// The realistic household shape puts the other machine in the upload command
// (`mac:{destination}`, the convention scp, rsync and rclone share) and keeps
// `destination` a plain path on that machine. Judged against this box's own
// disk, such a path lands on the root filesystem the staging directory sits on,
// and every hourly copy would be refused. So a destination is judged only when
// the upload command is handed it as a path of its own, at the start of an
// argument, and one it receives inside another argument is the command's
// business. The shipped refusal of a destination handed over whole, on the same
// filesystem, is the control.
import { afterAll, beforeAll, expect, test } from "bun:test"
import { chmodSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { seam, startCluster, type Cluster } from "./helpers/cluster.ts"
import { backupStage, type BackupStage } from "./helpers/backup-stage.ts"
import { loadRegistry } from "../src/registry/load.ts"
import { listRunEntries } from "../src/registry/entries.ts"

let cluster: Cluster
beforeAll(async () => { cluster = await startCluster() })
afterAll(async () => { await cluster?.stop() })

const SLOW = 120_000

async function copy(stage: BackupStage): Promise<{ landed: boolean; reason?: string }> {
  const { runBackup } = await seam("src/backup/run.ts") as { runBackup: (entry: unknown, registry: unknown) => Promise<unknown> }
  const registry = loadRegistry(stage.registryFile)
  const entry = listRunEntries(registry).find(one => one.id === stage.entry)
  try {
    await runBackup(entry, registry)
    return { landed: true }
  } catch (error) {
    return { landed: false, reason: (error as { reason?: string }).reason }
  }
}

/**
 * Two stand-ins for a copy tool that reaches another machine: each takes a
 * `host:path` argument and works on the path, which on this box is the only
 * place a check can put it.
 */
function remoteTools(stage: BackupStage): { upload: string; readback: string } {
  const dir = join(stage.dir, "remote-tools")
  mkdirSync(dir, { recursive: true })
  const upload = join(dir, "upload")
  const readback = join(dir, "readback")
  writeFileSync(upload, '#!/bin/sh\nto="${2#*:}"\nmkdir -p "$to" && cp -R -f "$1/." "$to"\n')
  writeFileSync(readback, '#!/bin/sh\ncp "${1#*:}" "$2"\n')
  chmodSync(upload, 0o755)
  chmodSync(readback, 0o755)
  return { upload, readback }
}

test("a destination the upload command receives after a host name is not judged against this box's own disk", async () => {
  const stage = await backupStage(cluster)
  try {
    const tools = remoteTools(stage)
    // A plain path, and one that sits on the staging directory's filesystem,
    // which is exactly where a path meant for the other machine lands when it
    // is judged here.
    stage.configure({
      destination: join(stage.sameDevice(), "backups", "hub"),
      upload_argv: [stage.recorder, tools.upload, "{staging}", "mac:{destination}"],
      readback_argv: [stage.recorder, tools.readback, "mac:{destination}/{path}", "{out}"],
    })
    const done = await copy(stage)
    expect(done, `the copy was refused: ${done.reason}`).toEqual({ landed: true })
    expect((await stage.store.read.sheet("job_success")).some(row => row.id === stage.entry)).toBe(true)
  } finally { await stage.remove() }
}, SLOW)

test("the same destination handed to the upload command as a path of its own is still refused as the same device", async () => {
  const stage = await backupStage(cluster)
  try {
    stage.configure({ destination: join(stage.sameDevice(), "backups", "hub") })
    stage.clearCalls()
    expect(await copy(stage)).toEqual({ landed: false, reason: "same device" })
    expect(stage.calls()).toEqual([])
  } finally { await stage.remove() }
}, SLOW)
