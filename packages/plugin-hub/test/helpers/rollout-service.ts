// Fixture composition and service observations. No control policy lives here.
import { mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { rolloutFixture } from "./rollout-fixtures.ts"
import { freshDatabase, pgBin, type Cluster } from "./cluster.ts"
import { writeRegistry } from "./registry.ts"
import { storeReader, userlessStoreUrl } from "./hub-fixture.ts"
import { systemd } from "../../src/os/systemd.ts"
import { launchd } from "../../src/os/launchd.ts"
import { loadRegistry } from "../../src/registry/load.ts"
import { listRunEntries } from "../../src/registry/entries.ts"
import type { OsSeam, UnitFile, UnitState } from "../../src/os/types.ts"

export async function serviceFixture(cluster: Cluster, blank = false) {
  const f = rolloutFixture()
  const db = blank ? `hub_${crypto.randomUUID().replaceAll("-", "")}` : await freshDatabase(cluster)
  const suffix = crypto.randomUUID().slice(0, 8)
  const ids = { hub: `hub-${suffix}`, door: `door-${suffix}`, runner: `runner-pi-${suffix}`, sync: `sync-${suffix}` }
  const machine = process.platform === "darwin" ? "mac" : "pi"
  const registryFile = writeRegistry(f.dir, {
    hub: { store_url: userlessStoreUrl(cluster, db), state_dir: f.stateDir, tick_seconds: 1 },
    machines: [{ id: machine, os: process.platform === "darwin" ? "macos" : "linux" }],
    people: f.trees.people.map(p => ({ id: p.id, tree: p.tree })),
    presets: { daily: f.preset }, agents: [],
    run: Object.entries(ids).map(([kind, id]) => ({ id, kind, machine,
      schedule: kind === "sync" ? "every 5m" : "always", memory_limit_mb: 256,
      ...(kind === "runner" ? { child_memory_limit_mb: 256 } : {}),
      ...(kind === "door" ? { platform: "fake", person: "p1", token_file: "/dev/null" } : {}),
    })),
  })
  const admin = [pgBin("psql"), "-h", "127.0.0.1", "-p", String(cluster.port), "-U", cluster.superuser, "-X", "-v", "ON_ERROR_STOP=1"]
  let text = readFileSync(registryFile, "utf8")
  text = text.replace(`id = "${ids.sync}"\n`, `id = "${ids.sync}"\nrepositories = ["p1-vault"]\n`)
  text += `\n[install]\nadmin_argv = ${JSON.stringify(admin)}\n\n[[repositories]]\nid = "p1-vault"\nperson = "p1"\npath = ${JSON.stringify(f.trees.people[0].tree)}\nremote = "origin"\nbranch = "main"\nrequired = true\n`
  writeFileSync(registryFile, text)
  loadRegistry(registryFile)
  const read = blank ? null : storeReader(cluster, db)
  return { ...f, db, ids, machine, registryFile, admin, read,
    entries: () => listRunEntries(loadRegistry(registryFile)),
    async stop() { await read?.close(); f.stop() },
  }
}
export type ServiceFixture = Awaited<ReturnType<typeof serviceFixture>>

// An inert OS edge. Real renderers and actual temporary files, no manager calls.
export function serviceOs(root: string, flavour: "systemd" | "launchd", owned: string[]) {
  const unitDir = join(root, `units-${flavour}-${crypto.randomUUID()}`)
  mkdirSync(unitDir)
  const renderer = flavour === "systemd" ? systemd({ unitDir }) : launchd({ unitDir })
  const calls: { operation: string, target: string }[] = []
  const files: UnitFile[] = []
  const states = new Map<string, UnitState>()
  let failure: string | null = null
  const act = (operation: string, target: string) => {
    if (!owned.includes(target)) throw new Error("fixture refused foreign unit")
    calls.push({ operation, target })
    if (failure === operation) throw new Error(`synthetic-${operation}-denied`)
  }
  const os: OsSeam = {
    flavour, render: renderer.render,
    async install(rendered) {
      for (const file of rendered) {
        const target = owned.find(id => file.path.endsWith(`imprnt-hub-${id}.service`) || file.path.endsWith(`imprnt-hub-${id}.timer`) || file.path.endsWith(`imprnt-hub-${id}.plist`))
        if (!target) throw new Error("fixture refused foreign file")
        act("install", target)
        writeFileSync(file.path, file.text)
        files.push(file)
      }
      return rendered.map(f => f.path)
    },
    async start(id) { act("start", id); states.set(id, { name: `imprnt-hub-${id}${flavour === "systemd" ? ".service" : ""}`, loaded: true, running: true, pid: null, runs: 1, ran: true, restarts: 0, lastExit: null, since: null, state: "running", result: null }) },
    async restart(id) { act("restart", id) },
    async stop(id) { act("stop", id); states.delete(id) },
    async remove(id) { act("remove", id); states.delete(id); for (const f of files.filter(f => f.path.includes(`imprnt-hub-${id}.`))) rmSync(f.path, { force: true }) },
    async list() { return [...states.values()] }, async show(id) { if (!owned.includes(id)) throw new Error("fixture refused foreign read"); return states.get(id) ?? null },
    async memory() { return { current_bytes: 0, peak_bytes: 0, source: "ps-rss" } },
    async available() { return { ok: true, reason: "synthetic manager" } },
  }
  return { os, files, calls, fail(operation: string | null) { failure = operation } }
}

export function renderContext(f: ServiceFixture, script: string) {
  return { machine: f.machine, execPath: process.execPath, entryScript: script, registryFile: f.registryFile,
    stateDir: f.stateDir, restartDelaySeconds: 1, giveUpAfter: 3, giveUpWindowSeconds: 60 }
}
