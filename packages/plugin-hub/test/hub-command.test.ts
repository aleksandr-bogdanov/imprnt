import { afterAll, beforeAll, expect, test } from "bun:test"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { startCluster, hubPath, type Cluster } from "./helpers/cluster.ts"
import { serviceFixture } from "./helpers/rollout-service.ts"
import { commandHarness } from "./helpers/rollout-command.ts"
import { renderMetrics } from "../src/metrics/stamps.ts"
let cluster: Cluster
beforeAll(async () => { cluster = await startCluster() })
afterAll(async () => { await cluster?.stop() })
const launcher = () => expect(existsSync(hubPath("hub.mjs")), "D-170 missing dependency-free Node launcher hub.mjs").toBe(true)
const shared = (calls: any[], name: string) => expect(calls.filter(c => c.phase === "call" && c.name === name), "D-170 one shared library call").toHaveLength(1)
const verbs = [
  ["check", "src/check/run.ts", "runCheck"],
  ["status", "src/hub/status.ts", "readStatus"],
  ["metrics", "src/metrics/stamps.ts", "readStampMetrics"],
  ["install database", "src/install/run.ts", "runInstall"],
  ["install services", "src/install/run.ts", "runInstall"],
  ["install entry", "src/install/run.ts", "runInstall"],
  ["recover", "src/hub/control.ts", "requestRecovery"],
] as const
for (const [verb, module, exported] of verbs) test(`ROLL-04 ${verb} real core Node dispatch calls ${exported} once and rejects duplicate implementation`, async () => {
  const f = await serviceFixture(cluster)
  const h = await commandHarness(f.dir)
  try {
    // The same stdout cannot satisfy the shared-call predicate with a duplicate shim.
    h.replacePlugin("console.log('synthetic matching output')")
    const duplicate = await h.run([])
    expect(duplicate.code).toBe(0)
    expect(() => shared(duplicate.calls, exported)).toThrow()
    h.restorePlugin()
    launcher()
    // All manager operations stay behind an inert edge, including check reads.
    const options = `({os:(await import(${JSON.stringify(hubPath("test/helpers/rollout-service.ts"))})).serviceOs(${JSON.stringify(f.dir)},'launchd',${JSON.stringify(Object.values(f.ids))}).os})`
    h.spy(module, exported, exported === "readStampMetrics" || exported === "requestRecovery" ? "{}" : options)
    const [command, stage] = verb.split(" ")
    const argv = command === "install" ? [command, f.registryFile, stage!, ...(stage === "database" ? [] : [stage === "entry" ? f.ids.sync : f.ids.hub])]
      : command === "recover" ? [command, f.registryFile, `door:${f.ids.door}`]
      : [command, f.registryFile, ...(["check", "status"].includes(command) ? [f.machine] : [])]
    const result = await h.run(argv)
    shared(result.calls, exported)
    const library = result.calls.find(c => c.phase === "result")?.result
    expect(library).toBeDefined()
    if (command === "metrics") { expect(result.code).toBe(0); expect(result.out.trim()).toBe(renderMetrics(library).trim()) }
    if (command === "check") {
      expect(result.code).toBe(library.length ? 1 : 0)
      for (const finding of library) expect(result.out).toContain(finding.says)
    }
    if (command === "status") {
      expect(result.code).toBe(1) // no synthetic service is loaded
      for (const entry of f.entries()) expect(result.out).toContain(entry.id)
      expect(result.out).toMatch(/wanted.*seen.*pid/i)
      for (const row of library) expect(result.out).toContain(`${row.id}: wanted ${row.wanted}, seen ${row.seen}, pid ${row.pid ?? "unknown"}.`)
    }
    if (["install", "recover"].includes(command)) expect(result.code).toBe(0)
    // Replace just the implementation with identical observed bytes and status.
    h.replacePlugin(`process.stdout.write(${JSON.stringify(result.out)});process.exit(${result.code})`)
    const impostor = await h.run(argv)
    expect(impostor.out).toBe(result.out)
    expect(impostor.code).toBe(result.code)
    expect(() => shared(impostor.calls, exported)).toThrow()
  } finally { h.stop(); await f.stop() }
})
for (const verb of ["check", "status"]) test(`ROLL-04 ${verb} requires explicit multi-machine target and infers only a sole declared ID`, async () => {
  const f = await serviceFixture(cluster)
  const h = await commandHarness(f.dir)
  try {
    launcher()
    const one = readFileSync(f.registryFile, "utf8")
    const module = verb === "check" ? "src/check/run.ts" : "src/hub/status.ts"
    const exported = verb === "check" ? "runCheck" : "readStatus"
    h.spy(module, exported, `({os:(await import(${JSON.stringify(hubPath("test/helpers/rollout-service.ts"))})).serviceOs(${JSON.stringify(f.dir)},'launchd',${JSON.stringify(Object.values(f.ids))}).os})`)
    const explicit = await h.run([verb, f.registryFile, f.machine])
    const inferred = await h.run([verb, f.registryFile])
    shared(explicit.calls, exported)
    shared(inferred.calls, exported)
    expect(inferred.code).toBe(explicit.code)
    expect(inferred.out).toBe(explicit.out)
    writeFileSync(f.registryFile, one + `\n[[machines]]\nid = "${f.machine === "mac" ? "pi" : "mac"}"\nos = "${f.machine === "mac" ? "linux" : "macos"}"\n`)
    expect((await h.run([verb, f.registryFile])).code).toBe(2)
    shared((await h.run([verb, f.registryFile, f.machine])).calls, exported)
    writeFileSync(f.registryFile, one.replace(/\[\[machines\]\][\s\S]*?(?=\n\[)/, ""))
    expect((await h.run([verb, f.registryFile])).code).toBe(2)
  } finally { h.stop(); await f.stop() }
})
test("ROLL-04 usage exits two and never reads HUB_REGISTRY while operational refusal exits one", async () => {
  const f = await serviceFixture(cluster)
  const h = await commandHarness(f.dir)
  try {
    launcher()
    for (const args of [[], ["unknown"], ["check"], ["metrics"], ["install"], ["recover"], ["recover", f.registryFile], ["install", f.registryFile, "unknown"]]) {
      const result = await h.run(args, { HUB_REGISTRY: f.registryFile })
      expect(result.code).toBe(2)
      expect(result.out + result.err).toMatch(/usage|unknown|target|stage/i)
    }
    // Existing library with invalid registry: a real operational failure, not usage.
    const invalid = join(f.dir, "invalid.toml")
    writeFileSync(invalid, "[hub]\nstore_url = 3\n")
    expect((await h.run(["metrics", invalid])).code).toBe(1)
    expect((await h.run(["metrics", f.registryFile])).code).toBe(0)
  } finally { h.stop(); await f.stop() }
})
test("ROLL-04 Node shim forwards Bun failure and SIGTERM to its actual child", async () => {
  const f = await serviceFixture(cluster)
  const h = await commandHarness(f.dir)
  try {
    launcher()
    // Replace only the interpreter edge. The package's own launcher still runs.
    const marker = join(f.dir, "signal")
    const ready = join(f.dir, "ready")
    const bin = join(h.cwd, "bin", "bun")
    writeFileSync(bin, `#!${Bun.which("node")}\nprocess.exit(7)\n`, { mode: 0o755 })
    expect((await h.run(["metrics", f.registryFile])).code).toBe(7)
    writeFileSync(bin, `#!${Bun.which("node")}\nconst fs=require('node:fs');fs.writeFileSync(${JSON.stringify(ready)},String(process.pid));process.on('SIGTERM',()=>{fs.writeFileSync(${JSON.stringify(marker)},'SIGTERM');process.exit(0)});setInterval(()=>{},1000)\n`)
    const child = Bun.spawn([Bun.which("node")!, hubPath("hub.mjs"), "metrics", f.registryFile], { env: h.env, stdout: "ignore", stderr: "ignore" })
    try {
      const { observe } = await import("./helpers/rollout-runner.ts")
      expect(await observe(() => existsSync(ready))).toBe(true)
      child.kill("SIGTERM")
      expect(await observe(() => existsSync(marker))).toBe(true)
      expect(readFileSync(marker, "utf8")).toBe("SIGTERM")
    } finally {
      child.kill(9)
      if (existsSync(ready)) { try { process.kill(Number(readFileSync(ready, "utf8")), 9) } catch {} }
      await child.exited
    }
  } finally { h.stop(); await f.stop() }
})

test("ROLL-04 implicit install requires one machine and one hub and reaches shared installation once", async () => {
  const f = await serviceFixture(cluster)
  const h = await commandHarness(f.dir)
  try {
    launcher()
    h.spy("src/install/run.ts", "runInstall", `({os:(await import(${JSON.stringify(hubPath("test/helpers/rollout-service.ts"))})).serviceOs(${JSON.stringify(f.dir)},'launchd',${JSON.stringify(Object.values(f.ids))}).os})`)
    const good = await h.run(["install", f.registryFile])
    expect(good.code).toBe(0)
    shared(good.calls, "runInstall")
    writeFileSync(f.registryFile, readFileSync(f.registryFile, "utf8") + `\n[[machines]]\nid = "${f.machine === "mac" ? "pi" : "mac"}"\nos = "${f.machine === "mac" ? "linux" : "macos"}"\n`)
    expect((await h.run(["install", f.registryFile])).code).toBe(2)
    expect((await h.run(["install", f.registryFile, "services", f.ids.hub])).code).toBe(0)
  } finally { h.stop(); await f.stop() }
})
