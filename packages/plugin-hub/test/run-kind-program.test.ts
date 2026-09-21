import { afterAll, beforeAll, expect, test } from "bun:test"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { startCluster, seam, hubPath, type Cluster } from "./helpers/cluster.ts"
import { serviceFixture, serviceOs, renderContext } from "./helpers/rollout-service.ts"
import { scheduledArgv } from "./helpers/rollout-sync.ts"
let cluster: Cluster
beforeAll(async () => { cluster = await startCluster() })
afterAll(async () => { await cluster?.stop() })
for (const kind of ["hub", "door", "runner", "sync"] as const) for (const flavour of ["systemd", "launchd"] as const) {
  test(`ROLL-17 ${kind} ${flavour} exact existing program registry entry and machine`, async () => {
    const f = await serviceFixture(cluster)
    try {
      const probe = serviceOs(f.dir, flavour, Object.values(f.ids))
      const entry = f.entries().find(e => e.kind === kind)!
      const exact = (script: string) => {
        expect(resolve(script)).toBe(hubPath(`src/entry/${kind}.ts`))
        expect(scheduledArgv(probe.os.render(entry, renderContext(f, script)), flavour)).toEqual([process.execPath, "run", script, f.registryFile, entry.id])
        expect(entry.machine).toBe(f.machine)
      }
      exact(hubPath(`src/entry/${kind}.ts`))
      expect(() => exact(hubPath(`src/entry/${kind === "hub" ? "door" : "hub"}.ts`))).toThrow()
      const { programForKind } = await seam("src/hub/program.ts")
      const script = (programForKind as Function)(kind)
      exact(script)
      expect(existsSync(script)).toBe(true)
    } finally { await f.stop() }
  })
}
// Three kinds the hub renders are not in this list. `transcriber` is the
// recognizer's Python server, whose argv is bound in test/voice-units.test.ts,
// `board` is a page this package serves, whose own render assertions live in
// test/registry-board.test.ts, and `backup` is the off-box copy, whose program
// and both renders are bound in test/backup-registry.test.ts. The two that
// remain, a kind still deferred and a kind nobody declares, each still refuses
// before the first file write or child start.
for (const kind of ["watcher", "arbitrary-kind"]) {
  test(`ROLL-17 ${kind} refuses before the first file or child start and defeats hub fallback`, async () => {
    const f = await serviceFixture(cluster)
    try {
      const probe = serviceOs(f.dir, "systemd", Object.values(f.ids))
      const zero = () => { expect(probe.files).toHaveLength(0); expect(probe.calls).toHaveLength(0) }
      zero()
      // Same renderer with the old fallback is a real write and start, caught by zero().
      await probe.os.install(probe.os.render(f.entries()[0], renderContext(f, hubPath("src/entry/hub.ts"))))
      await probe.os.start(f.ids.hub)
      expect(zero).toThrow()
      const clean = serviceOs(f.dir, "systemd", Object.values(f.ids))
      const { programForKind } = await seam("src/hub/program.ts")
      expect(() => (programForKind as Function)(kind)).toThrow(/unsupported-run-kind/)
      const { runInstall } = await seam("src/install/run.ts")
      // Put the invalid entry last so per-entry validation cannot write the valid prefix.
      writeFileSync(f.registryFile, readFileSync(f.registryFile, "utf8").replace(`kind = "sync"`, `kind = "${kind}"`))
      await expect((runInstall as Function)({ registryFile: f.registryFile, stage: "services", target: f.ids.hub, os: clean.os })).rejects.toThrow(/unsupported-run-kind/)
      expect(clean.files).toHaveLength(0)
      expect(clean.calls).toHaveLength(0)
      // Refusal control: repair just the kind and call the identical install path.
      writeFileSync(f.registryFile, readFileSync(f.registryFile, "utf8").replace(`kind = "${kind}"`, 'kind = "sync"'))
      await (runInstall as Function)({ registryFile: f.registryFile, stage: "services", target: f.ids.hub, os: clean.os })
      expect(clean.files.length).toBeGreaterThan(0)
    } finally { await f.stop() }
  })
}
