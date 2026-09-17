// Round 2 composition checks. Synthetic inputs only.
import { afterAll, beforeAll, expect, spyOn, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, symlinkSync, lstatSync, readlinkSync, unlinkSync } from "node:fs"
import { join } from "node:path"
import { startCluster, seam, hubPath, type Cluster } from "./helpers/cluster.ts"
import { migrationFixture, privateJson } from "./helpers/rollout-migration.ts"
import { loopFixture, captureCli, digest } from "./helpers/rollout-loop.ts"
import { stageHub, insertInbound } from "./helpers/hub-fixture.ts"
import { runRunner } from "../src/runner/run.ts"
import { claudeCode } from "../src/adapters/claude-code.ts"
import { controlledAdapter, observe, editAgent } from "./helpers/rollout-runner.ts"
import { rolloutStage } from "./helpers/rollout-stage.ts"
import { deliveryEdge, proveDeliveryEdge } from "./helpers/rollout-delivery.ts"
import { runDoor } from "../src/door/run.ts"
import { wirePlatform } from "./helpers/rollout-ingress.ts"
import { syncFixture, scheduleProbe } from "./helpers/rollout-sync.ts"
import { serviceFixture, renderContext } from "./helpers/rollout-service.ts"
let cluster: Cluster
beforeAll(async () => {
  await proveDeliveryEdge()
  await (await import("../live/prove-rollout-wire-observer.ts")).proveWireObserver()
  await import("../live/prove-rollout-loop.ts")
  await import("../live/prove-rollout-sync.ts")
  cluster = await startCluster()
})
afterAll(async () => { await cluster?.stop() })

test("L05 ordinary runner passes the complete selected recipe to the real adapter", async () => {
  const f = loopFixture()
  const it = await stageHub(cluster, { registry: base => ({ ...base,
    people: [{ id: "p1", tree: f.trees.person("p1").tree }],
    credentials: [f.credential],
    presets: { daily: { ...f.preset, adapter: "claude-code", credential: "loop-login" } },
    agents: [{ id: "p1-lair", person: "p1", preset: "daily", runner: "runner-test", door: "door-fake", chat: "1000000001",
      fragment: f.files.fragment, settings: f.files.settings, mcp: f.files.mcp, tools: ["Read", "Write", "Glob", "Grep"] } as any],
  }) })
  let runner: Awaited<ReturnType<typeof runRunner>> | undefined
  try {
    const capture = join(f.trees.person("p1").tree, "runner-capture.json")
    const adapter = { ...claudeCode, async start(options: any) {
      // Forward all options unchanged. Only substitute the executable at spawn.
      return claudeCode.start({ ...options, wrap: (argv: string[]) => options.wrap ? options.wrap(captureCli(capture, f)(argv)) : captureCli(capture, f)(argv) })
    } }
    runner = await runRunner({ runner: "runner-test", registryFile: it.registryFile, adapters: { "claude-code": adapter } })
    await insertInbound(cluster, it.db, { id: "ordinary-recipe", body: "synthetic ordinary work" })
    expect(await observe(() => existsSync(capture), 5000), "runner must spawn its real adapter").toBe(true)
    const accepts = (got: any) => {
      expect(got.fragment, "L05 runner fragment bytes").toBe(readFileSync(f.files.fragment, "utf8"))
      expect(got.settings, "L05 runner allow and deny lists").toEqual(JSON.parse(readFileSync(f.files.settings, "utf8")))
      expect(got.mcp, "L05 runner MCP").toEqual(JSON.parse(readFileSync(f.files.mcp, "utf8")))
      expect(got.argv).toContain("--dangerously-skip-permissions")
      expect(got.argv).toContain("--strict-mcp-config")
      const at = got.argv.indexOf("--tools")
      expect(at).toBeGreaterThan(-1)
      const tail = got.argv.slice(at + 1)
      const end = tail.findIndex((s: string) => s.startsWith("--"))
      expect(tail.slice(0, end < 0 ? undefined : end).flatMap((s: string) => s.split(/[, ]/)).filter(Boolean).sort()).toEqual(["Glob", "Grep", "Read", "Write"])
      expect(got.credentialDigest, "L05 runner canonical login bytes").toBe(digest(readFileSync(f.login, "utf8")))
      expect(got.ambient).toEqual([])
    }
    const got = JSON.parse(readFileSync(capture, "utf8"))
    for (const field of ["fragment", "settings", "mcp", "credentialDigest"]) expect(() => accepts({ ...got, [field]: null })).toThrow()
    accepts(got)
  } finally { await runner?.stop(); await it.stop(); f.stop() }
})

for (const destination of ["candidate", "inventory", "runtime_dir"] as const) test(`L06 converter refuses checkout ${destination} and confines private writes`, async () => {
  const f = migrationFixture()
  const previousCwd = process.cwd()
  try {
    const checkout = join(f.dir, "checkout")
    mkdirSync(join(checkout, ".git"), { recursive: true })
    writeFileSync(join(checkout, "sentinel"), "synthetic tracked bytes")
    const manifest = { ...f.registryManifest, checkout_root: checkout }
    process.chdir(checkout)
    const snapshot = () => {
      const files: Record<string, string> = {}
      const visit = (relative: string) => {
        for (const name of readdirSync(join(checkout, relative)).sort()) {
          const key = join(relative, name)
          const path = join(checkout, key)
          const stat = lstatSync(path)
          if (stat.isSymbolicLink()) files[key] = "link:" + readlinkSync(path)
          else if (stat.isDirectory()) { files[key + "/"] = "directory"; visit(key) }
          else files[key] = digest(readFileSync(path, "utf8"))
        }
      }
      visit("")
      return files
    }
    const before = snapshot()
    const untouched = () => expect(snapshot(), "D-168b private output must not enter checkout").toEqual(before)
    // Standalone observer proof includes a nested leak, before the product seam.
    const leak = join(checkout, ".git", "leaked-source")
    writeFileSync(leak, readFileSync(f.sources[0].file, "utf8"))
    expect(untouched).toThrow()
    unlinkSync(leak)
    untouched()
    const convert = (await seam("src/migrate/registry.ts")).convertV2Registry as Function
    await convert(manifest, f.lookup)
    untouched()
    const alias = join(f.dir, "checkout-alias")
    symlinkSync(checkout, alias)
    for (const root of [checkout, alias]) {
      // Fresh destinations prevent an existing output from masking confinement.
      const output = join(f.dir, "private-attempt-" + crypto.randomUUID())
      mkdirSync(output)
      const attempt = { ...manifest, candidate: join(output, "candidate.toml"), inventory: join(output, "inventory.json"), runtime_dir: output,
        [destination]: join(root, destination) }
      await expect(convert(attempt, f.lookup)).rejects.toThrow(/checkout|private|destination/i)
      untouched()
    }
    writeFileSync(join(checkout, "leaked-source"), readFileSync(f.sources[0].file, "utf8"))
    expect(untouched).toThrow()
  } finally { process.chdir(previousCwd); f.stop() }
})

for (const platform of ["telegram", "discord"] as const) test(`L04 ${platform} wire refusal reaches classifier and repaired post works`, async () => {
  const f = loopFixture()
  try {
    let refuse = true
    const wire = wirePlatform(f.dir, platform, () => refuse
      ? Response.json(platform === "telegram" ? { ok: false, error_code: 403, description: "Forbidden: synthetic access denied" } : { code: 50001, message: "Missing Access" }, { status: 403 })
      : platform === "telegram" ? { ok: true, result: { message_id: 1 } } : { id: "1" })
    let error: unknown
    try { await wire.platform.post({ chat: "1000000001", text: "synthetic answer" }) } catch (e) { error = e }
    expect(error).toBeDefined()
    const classify = (await seam("src/door/reply.ts")).classifyPlatformError as Function
    expect(classify(error).kind, "L04 real wire refusal classification").toBe("permanent")
    refuse = false
    expect((await wire.platform.post({ chat: "1000000001", text: "synthetic answer" })).id).toBeTruthy()
  } finally { f.stop() }
})

for (const platform of ["telegram", "discord"] as const) test(`L13 ${platform} unresolved read becomes unhealthy and released read clears`, async () => {
  const it = await rolloutStage(cluster, platform)
  const edge = deliveryEdge(platform)
  const release = edge.hold("1000000001")
  let diagnostic = ""
  const capture = spyOn(process.stderr, "write").mockImplementation(((chunk: any) => { diagnostic += String(chunk); return true }) as any)
  let door: Awaited<ReturnType<typeof runDoor>> | undefined
  try {
    writeFileSync(it.registryFile, readFileSync(it.registryFile, "utf8").replace("[door]\n", "[door]\nread_timeout_seconds = 1\n"))
    door = await runDoor({ door: "door-fake", registryFile: it.registryFile, platform: edge.platform })
    expect(await observe(() => edge.held.has("1000000001"))).toBe(true)
    expect(await observe(async () => (await it.read.sheet("door_health")).some(r => JSON.stringify(r).includes("read-timeout")), 3500), "D-174a pending transport read must not remain healthy").toBe(true)
    const diagnosed = (text: string) => {
      expect(text, "D-174a timeout diagnostic code").toContain("read-timeout")
      expect(text, "D-179 affected door").toContain("door-fake")
      expect(text, "D-179 affected chat").toContain("1000000001")
    }
    expect(() => diagnosed("")).toThrow()
    diagnosed(diagnostic)
    const events = await it.read.ledger()
    expect(events.some(row => JSON.stringify(row).includes("read-timeout") && JSON.stringify(row).includes("1000000001")), "D-179 timeout diary cause and target").toBe(true)
    expect(edge.peak.get("1000000001"), "D-174a do not overlap unresolved reads").toBe(1)
    release()
    expect(await observe(async () => !(await it.read.sheet("door_health")).some(r => JSON.stringify(r).includes("read-timeout")), 3500), "successful read repairs timeout").toBe(true)
  } finally { release(); try { await door?.stop(); await it.stop() } finally { capture.mockRestore() } }
})

test("L10 service installation actually enables the resident service", async () => {
  const f = await serviceFixture(cluster)
  const s = await syncFixture(cluster)
  try {
    const probe = scheduleProbe(s, "systemd")
    const runInstall = (await seam("src/install/run.ts")).runInstall as Function
    await runInstall({ registryFile: f.registryFile, stage: "services", target: f.ids.hub, os: probe.os })
    const enabled = (calls: string[][]) => expect(calls.some(args => args.includes("enable") && args.includes(`imprnt-hub-${f.ids.hub}.service`)), "L10 enable resident service in manager").toBe(true)
    expect(() => enabled(probe.calls().filter(args => !args.includes("enable")))).toThrow()
    enabled(probe.calls())
  } finally { await f.stop(); await s.stop() }
})

test("L11 suppressed on-demand wake fails the same bounded output oracle", async () => {
  for (const suppressed of [true, false]) {
    const it = await stageHub(cluster, { hub: { tick_seconds: 1 } })
    const edge = controlledAdapter(it.adapterName)
    let runner: Awaited<ReturnType<typeof runRunner>> | undefined
    let release!: () => void
    const wakeGate = new Promise<void>(resolve => { release = resolve })
    let intercept = false
    const starts: Promise<any>[] = []
    const adapter = { ...edge.adapter, start(options: any) {
      const pending = (async () => {
        if (intercept) await wakeGate
        return edge.adapter.start(options)
      })()
      starts.push(pending)
      return pending
    } }
    try {
      editAgent(it.registryFile, "p1-lair", { mode: "on-demand", idle_seconds: 1 })
      runner = await runRunner({ runner: "runner-test", registryFile: it.registryFile, adapters: { [it.adapterName]: adapter } })
      expect(edge.sessions, "on-demand starts no eager child").toHaveLength(0)
      intercept = suppressed
      await insertInbound(cluster, it.db, { id: "bounded-wake", body: "synthetic wake" })
      const output = await observe(async () => (await it.read.outbox()).some(r => r.inbound_id === "bounded-wake"), 3500)
      const awake = () => expect(output, "L11 wake must produce output before deadline").toBe(true)
      if (suppressed) {
        expect(starts.length, "wake fault intercepted actual admission").toBeGreaterThan(0)
        expect(edge.sessions).toHaveLength(0)
        expect(awake).toThrow()
      } else awake()
    } finally {
      release()
      await Promise.allSettled(starts)
      await runner?.stop()
      await edge.stop()
      await it.stop()
    }
  }
})

test("L14 diagnostic operator documentation names both actual destinations", () => {
  const file = hubPath("docs/operations.md")
  expect(existsSync(file), "D-179a operator diagnostic lookup is missing").toBe(true)
  const text = readFileSync(file, "utf8")
  const documented = (text: string) => {
    expect(text, "D-179a one owned-unit journal command").toMatch(/journalctl[^\n`]*--user[^\n`]*(?:--unit(?:=|\s+)|-u\s+)["']?imprnt-hub-<entry>\.service/)
    expect(text).toContain("<state_dir>/service-log/<entry>.err.log")
    expect(text).toContain("<state_dir>/service-log/<entry>.out.log")
  }
  const example = "journalctl --user --unit imprnt-hub-<entry>.service\n<state_dir>/service-log/<entry>.err.log\n<state_dir>/service-log/<entry>.out.log"
  documented(example)
  for (const bad of ["", "journalctl --user\nimprnt-hub-\nservice-log\n.err.log\n.out.log", example.replace("--unit imprnt-hub-<entry>.service", ""), example.replaceAll("<state_dir>/", "")]) expect(() => documented(bad)).toThrow()
  documented(text)
})

for (const script of ["convert-v2-chatlog", "convert-v2-registry", "handoff-v2", "harvest-v2"]) test(`L14 ${script} executable rejects missing arguments and executes a manifest`, async () => {
  const f = migrationFixture()
  try {
    const entry = hubPath(`scripts/${script}.ts`)
    expect(existsSync(entry), "D-181b one-off command entry missing").toBe(true)
    const invoke = (args: string[]) => Bun.spawnSync([process.execPath, entry, ...args], { stdout: "pipe", stderr: "pipe", timeout: 15000 })
    expect(invoke([]).exitCode).toBe(2)
    if (script === "convert-v2-chatlog") {
      const file = privateJson(join(f.dir, "manifest.json"), f.logManifest)
      expect(invoke([file]).exitCode).toBe(0)
      expect(existsSync(join(f.stateDir, "p2", "chatlog", "p2-lair", "2026-07-02.jsonl"))).toBe(true)
    } else if (script === "convert-v2-registry") {
      // Telegram-only conversion needs no authenticated channel lookup.
      const manifest = { ...f.registryManifest, source_registries: [f.sources[1].file], expected_agents: ["p2-lair"], bindings: [f.registryManifest.bindings[1]], people: [f.registryManifest.people[1]], repositories: [f.registryManifest.repositories[1]], checkout_root: join(f.dir, "checkout") }
      mkdirSync(manifest.checkout_root)
      manifest.credentials = manifest.credentials.map((credential: any) => credential.id === "loop-login" ? { ...credential, owner: "household" } : credential)
      const file = privateJson(join(f.dir, "manifest.json"), manifest)
      expect(invoke([file]).exitCode).toBe(0)
      expect(JSON.parse(readFileSync(manifest.inventory, "utf8")).agents.map((a: any) => a.id)).toEqual(["p2-lair"])
    } else if (script === "handoff-v2") {
      const it = await stageHub(cluster, { hub: { cutover_batch: "synthetic-cutover" }, people: [{ id: "p1" }, { id: "p2" }],
        registry: base => ({ ...base, agents: [{ id: "p1-lair", person: "p1", preset: "daily", runner: "runner-pi", door: "door-fake", chat: "0000000000" }],
          run: [{ id: "runner-pi", kind: "runner", schedule: "always", memory_limit_mb: 512, child_memory_limit_mb: 512 }] }),
      })
      try {
        const file = privateJson(join(f.dir, "manifest.json"), { ...f.handoffManifest, registry: it.registryFile })
        expect(invoke([file]).exitCode).toBe(0)
        expect((await it.read.sheet("cutover")).some(r => r.id === "synthetic-cutover" && r.data.complete)).toBe(true)
        expect((await it.read.outbox()).some(r => r.body === "fully owed")).toBe(true)
      } finally { await it.stop() }
    } else {
      const it = await stageHub(cluster)
      try {
        // Empty converted history is a valid no-model control.
        const file = privateJson(join(f.dir, "manifest.json"), { version: 1, registry: it.registryFile, person: "p1", from: "2026-07-01T00:00:00.000Z", until: "2026-07-01T00:00:00.000Z" })
        const result = invoke([file])
        expect(result.exitCode).toBe(0)
        expect(await it.read.inbound()).toEqual([])
        expect(await it.read.ledger()).toEqual([])
        privateJson(file, { version: 1, registry: it.registryFile, person: "unknown", from: "2026-07-01T00:00:00.000Z", until: "2026-07-01T00:00:00.000Z" })
        expect(invoke([file]).exitCode).toBe(1)
      } finally { await it.stop() }
    }
  } finally { f.stop() }
})
