import { afterAll, beforeAll, expect, test } from "bun:test"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { startCluster, seam, hubPath, type Cluster } from "./helpers/cluster.ts"
import { serviceFixture, serviceOs, renderContext } from "./helpers/rollout-service.ts"
import { syncFixture, scheduleProbe } from "./helpers/rollout-sync.ts"
import { runHub } from "../src/hub/run.ts"
import { runCheck } from "../src/check/run.ts"
import { superStore } from "./helpers/hub-fixture.ts"
import { parsePlistDict } from "./helpers/plist.ts"
import { unitFixture } from "./helpers/units.ts"
import { launchd } from "../src/os/launchd.ts"
import { systemd } from "../src/os/systemd.ts"
import { observe } from "./helpers/rollout-runner.ts"
let cluster: Cluster
const native = unitFixture()
beforeAll(async () => { cluster = await startCluster() })
afterAll(async () => { try { await native.removeAll() } finally { await cluster?.stop() } })
for (const flavour of ["systemd", "launchd"] as const) test(`ROLL-12 ${flavour} service install includes and enables registry-owned resident hub`, async () => {
  const f = await serviceFixture(cluster)
  try {
    const probe = serviceOs(f.dir, flavour, Object.values(f.ids))
    const unitSet = (files: {path:string}[]) => {
      for (const id of Object.values(f.ids)) expect(files.some(file => file.path.includes(`imprnt-hub-${id}.`)), `F12 installed set includes ${id}`).toBe(true)
    }
    const rendered = f.entries().flatMap(entry => probe.os.render(entry, renderContext(f, hubPath(`src/entry/${entry.kind}.ts`))))
    unitSet(rendered)
    expect(() => unitSet(rendered.filter(file => !file.path.includes(`imprnt-hub-${f.ids.hub}.`)))).toThrow()
    const { runInstall } = await seam("src/install/run.ts")
    await (runInstall as Function)({ registryFile: f.registryFile, stage: "services", target: f.ids.hub, os: probe.os })
    unitSet(probe.files)
    expect(probe.calls.some(call => call.target === f.ids.hub && call.operation === "start")).toBe(true)
    const hub = probe.files.find(file => file.path.includes(`imprnt-hub-${f.ids.hub}.`))!
    if (flavour === "systemd") {
      const managerFixture = await syncFixture(cluster)
      try {
        const manager = scheduleProbe(managerFixture, "systemd")
        await (runInstall as Function)({ registryFile: f.registryFile, stage: "services", target: f.ids.hub, os: manager.os })
        const enabled = (calls: string[][]) => expect(calls.some(args => args.includes("enable") && args.includes(`imprnt-hub-${f.ids.hub}.service`)), "T126 real renderer must enable the resident with its manager").toBe(true)
        expect(() => enabled(manager.calls().filter(args => !args.includes("enable")))).toThrow()
        enabled(manager.calls())
      } finally { await managerFixture.stop() }
      expect(hub.text).toContain("WantedBy=default.target")
      expect(hub.text).toContain("After=network-online.target")
      expect(hub.text).toContain("Restart=always")
    } else {
      const plist = parsePlistDict(hub.text)
      expect(plist.RunAtLoad).toBe(true)
      expect(plist.KeepAlive).toBe(true)
    }
  } finally { await f.stop() }
})
test("ROLL-12 two coordinators hold distinct machine locks and never install the other machine's units", async () => {
  const f = await serviceFixture(cluster)
  const first = serviceOs(f.dir, "launchd", Object.values(f.ids))
  const other = f.machine === "mac" ? "pi" : "mac"
  const otherId = `hub-${crypto.randomUUID().slice(0,8)}`
  const second = serviceOs(f.dir, "launchd", [otherId])
  const running: Awaited<ReturnType<typeof runHub>>[] = []
  try {
    // Both synthetic machines have this host's OS so both coordinators execute here.
    writeFileSync(f.registryFile, readFileSync(f.registryFile, "utf8") + `\n[[machines]]\nid = "${other}"\nos = "${process.platform === "darwin" ? "macos" : "linux"}"\n[[run]]\nid = "${otherId}"\nkind = "hub"\nmachine = "${other}"\nschedule = "always"\nmemory_limit_mb = 256\n`)
    const { runInstall } = await seam("src/install/run.ts")
    await (runInstall as Function)({ registryFile: f.registryFile, stage: "services", target: f.ids.hub, os: first.os })
    await (runInstall as Function)({ registryFile: f.registryFile, stage: "services", target: otherId, os: second.os })
    running.push(await runHub({ registryFile: f.registryFile, machine: f.machine, os: first.os }))
    running.push(await runHub({ registryFile: f.registryFile, machine: other, os: second.os }))
    const locks = await f.read!.sql("select distinct a.application_name,l.classid,l.objid from pg_locks l join pg_stat_activity a on a.pid=l.pid where l.locktype='advisory' and l.granted and a.application_name in ($1,$2)", [`hub-${f.machine}`, `hub-${other}`])
    expect(locks).toHaveLength(2)
    expect(new Set(locks.map(r => `${r.classid}/${r.objid}`)).size).toBe(2)
    expect(first.calls.every(c => Object.values(f.ids).includes(c.target))).toBe(true)
    expect(second.calls.every(c => c.target === otherId)).toBe(true)
    await expect(runHub({ registryFile: f.registryFile, machine: f.machine, os: first.os })).rejects.toThrow(/already|one hub/)
  } finally { for (const h of running.reverse()) await h.stop(); await f.stop() }
})
test("ROLL-12 Linux linger disabled is a named check finding and enabled clears it", async () => {
  const f = await serviceFixture(cluster)
  const store = await superStore(cluster, f.db)
  try {
    const probe = serviceOs(f.dir, "systemd", Object.values(f.ids))
    const check = (linger: boolean) => (runCheck as Function)({ registryFile: f.registryFile, machine: f.machine, store, os: probe.os,
      kernel: { cmdline: "cgroup_enable=memory", bootFile: null, controllers: ["memory"], earlyoom: "active", linger } })
    const disabled = await check(false)
    expect(disabled.some((r: any) => /linger/.test(r.kind) && /linger/.test(r.fix)), "D-179 missing Linux linger preflight").toBe(true)
    expect((await check(true)).some((r: any) => /linger/.test(r.kind))).toBe(false)
  } finally { await store.close(); await f.stop() }
})
for (const host of ["linux", "darwin"] as const) {
  if (process.platform !== host) console.log(`SKIP: requires ${host === "linux" ? "Linux" : "macOS"}: ROLL-12 native bootstrap`)
  test.skipIf(process.platform !== host)(`ROLL-12 native ${host} resident service survives its launching command and schedule is installed`, async () => {
    const f = await serviceFixture(cluster)
    try {
      const os = host === "linux" ? systemd({ unitDir: native.unitDir() }) : launchd({ unitDir: native.unitDir() })
      expect((await os.available()).ok).toBe(true)
      const id = native.entryId("bootstrap")
      const marker = join(f.dir, "resident")
      const script = join(f.dir, "resident.ts")
      writeFileSync(script, `await Bun.write(${JSON.stringify(marker)},String(process.pid));setInterval(()=>{},1000)`)
      const entry = { ...f.entries()[0], id }
      await os.install(os.render(entry, renderContext(f, script)))
      await os.start(id)
      if (host === "linux") {
        const enabled = () => Bun.spawnSync(["systemctl", "--user", "is-enabled", `imprnt-hub-${id}.service`]).stdout.toString().trim()
        expect(enabled(), "L10 resident enablement survives manager restart").toBe("enabled")
      } else {
        const plist = parsePlistDict(readFileSync(join(native.unitDir(), `imprnt-hub-${id}.plist`), "utf8"))
        expect(plist.RunAtLoad).toBe(true)
        expect(plist.KeepAlive).toBe(true)
      }
      expect(await observe(async () => existsSync(marker) && (await os.show(id))?.running === true)).toBe(true)
      expect(Number(readFileSync(marker,"utf8"))).toBe((await os.show(id))!.pid!)
      const timerId = native.entryId("sync")
      const timerMarker = join(f.dir, "scheduled")
      const timerScript = join(f.dir, "scheduled.ts")
      writeFileSync(timerScript, `await Bun.write(${JSON.stringify(timerMarker)},String(process.pid))`)
      const timer = os.render({ ...entry, id: timerId, kind: "sync", schedule: "every 1s" }, renderContext(f, timerScript))
      await os.install(timer)
      if (host === "linux") {
        const queried = Bun.spawnSync(["systemctl", "--user", "is-active", `imprnt-hub-${timerId}.timer`])
        expect(queried.exitCode).toBe(0)
      } else expect(parsePlistDict(timer[0].text).StartInterval).toBe(1)
      // No explicit start of this entry. Only its scheduler can write the marker.
      expect(await observe(() => existsSync(timerMarker), 15000), "native schedule must execute its declared program").toBe(true)
    } finally { try { await native.removeAll(); expect(native.mine()).toEqual([]); console.log("L10 native owned-unit cleanup completed") } finally { await f.stop() } }
  })
}
