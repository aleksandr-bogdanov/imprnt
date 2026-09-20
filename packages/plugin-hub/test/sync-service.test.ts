// Cross-platform rendering and fake schedule activation, no native units.
import { afterAll, beforeAll, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { startCluster, seam, hubPath, type Cluster } from "./helpers/cluster.ts"
import { syncFixture, commitChange, observeGit, scheduleProbe, scheduledArgv } from "./helpers/rollout-sync.ts"
import { fixtureGit } from "./helpers/rollout-git.ts"
import { parsePlistDict } from "./helpers/plist.ts"
import { staleJobs } from "../src/check/schedule.ts"

let cluster: Cluster
const cleanup: (() => Promise<void>)[] = []
beforeAll(async () => { cluster = await startCluster() })
afterAll(async () => {
  try { for (const stop of cleanup.reverse()) await stop() }
  finally { if (cluster) await cluster.stop() }
})

test("ROLL-17 sync resolves to its own existing entry and rejects the hub fallback control", async () => {
  const exact = (program: string) => expect(resolve(program)).toBe(hubPath("src/entry/sync.ts"))
  exact(hubPath("src/entry/sync.ts"))
  expect(() => exact(hubPath("src/entry/hub.ts"))).toThrow()
  const { programForKind } = await seam("src/hub/program.ts")
  expect(typeof programForKind).toBe("function")
  const program = (programForKind as (kind: string) => string)("sync")
  exact(program)
  expect(existsSync(program)).toBe(true)
})

for (const flavour of ["systemd", "launchd"] as const) {
  test(`ROLL-07 ROLL-17 ${flavour} renders the exact sync program registry entry and five-minute schedule`, async () => {
    const f = await syncFixture(cluster)
    try {
      const probe = scheduleProbe(f, flavour)
      const ctx = { machine: f.machine, execPath: process.execPath, entryScript: hubPath("src/entry/sync.ts"), registryFile: f.registryFile, restartDelaySeconds: 1, giveUpAfter: 5, giveUpWindowSeconds: 300 }
      const expected = [process.execPath, "run", ctx.entryScript, f.registryFile, f.id]
      const exact = (files: ReturnType<typeof probe.os.render>) => expect(scheduledArgv(files, flavour)).toEqual(expected)
      exact(probe.os.render(f.entry(), ctx))
      // Forbidden: same renderer and registry, only the program is defective.
      expect(() => exact(probe.os.render(f.entry(), { ...ctx, entryScript: hubPath("src/entry/hub.ts") }))).toThrow()
      const { programForKind } = await seam("src/hub/program.ts")
      const files = probe.os.render(f.entry(), { ...ctx, entryScript: (programForKind as Function)("sync") })
      exact(files)
      if (flavour === "systemd") {
        expect(files).toHaveLength(2)
        const timer = files.find(file => file.path.endsWith(".timer"))!.text
        expect(timer).toContain("OnUnitActiveSec=300\n")
        expect(timer).toContain(`Unit=imprnt-hub-${f.id}.service\n`)
        expect(files.find(file => file.path.endsWith(".service"))!.text).not.toContain("Restart=always")
      } else {
        const plist = parsePlistDict(files[0].text)
        expect(plist.Label).toBe(`imprnt-hub-${f.id}`)
        expect(plist.StartInterval).toBe(300)
        expect(plist.RunAtLoad).toBe(false)
        expect(plist.KeepAlive).toBeUndefined()
      }
    } finally { await f.stop() }
  })

  test(`ROLL-07 ROLL-31 ${flavour} fake schedule activation executes the real sync entry and transports all required commits`, async () => {
    const f = await syncFixture(cluster)
    const probe = scheduleProbe(f, flavour)
    let removed = false
    const stop = async () => {
      if (removed) return
      try { await probe.os.remove(f.id) } finally { await f.stop(); removed = true }
    }
    cleanup.push(stop)
    try {
      const git = observeGit(f.root)
      for (const repo of f.repos) commitChange(repo.path)
      // Missing entry is a behavior red, not a child launch error or timeout.
      expect(existsSync(hubPath("src/entry/sync.ts")), "D-180 missing sync entry program").toBe(true)
      const { programForKind } = await seam("src/hub/program.ts")
      const files = probe.os.render(f.entry(), { machine: f.machine, execPath: process.execPath,
        entryScript: (programForKind as Function)("sync"), registryFile: f.registryFile,
        restartDelaySeconds: 1, giveUpAfter: 5, giveUpWindowSeconds: 300 })
      expect(scheduledArgv(files, flavour)).toEqual([process.execPath, "run", hubPath("src/entry/sync.ts"), f.registryFile, f.id])
      await probe.os.install(files)
      expect(probe.calls().some(argv => flavour === "systemd"
        ? argv.includes("enable") && argv.includes("--now") && argv.includes(`imprnt-hub-${f.id}.timer`)
        : argv[0] === "bootstrap" && argv.includes(files[0].path))).toBe(true)
      const started = Date.now()
      const fired = await probe.fire(files, git.env)
      expect(fired.code).toBe(0)
      for (const repo of f.repos) {
        expect(fixtureGit(f.root, "--git-dir", repo.remote, "show", "main:local.txt")).toBe("synthetic local change")
        expect(fixtureGit(f.root, "--git-dir", repo.remote, "rev-parse", "main")).toBe(fixtureGit(repo.path, "rev-parse", "HEAD"))
      }
      const stamps = await f.read.sheet("job_success")
      expect(Date.parse(String(stamps.find(row => row.id === f.id)!.data.at))).toBeGreaterThanOrEqual(started)
      expect(staleJobs({ entries: [f.entry()], stamps, graceSeconds: 0, now: new Date() })).toEqual([])
      expect(probe.calls().flat().some(arg => arg.includes("runner-pi") || arg.includes("door-fake"))).toBe(false)
    } finally { await stop() }
  })
}
