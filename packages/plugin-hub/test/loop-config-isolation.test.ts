import { beforeAll, expect, test } from "bun:test"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { claudeCode } from "../src/adapters/claude-code.ts"
import { harvestMessage } from "../src/harvest/prompt.ts"
import { loopFixture, launchInput, launchSeam, captureCli, ending, controlledMcp, nativeWrap, appended } from "./helpers/rollout-loop.ts"
import { boxGate } from "./helpers/box-gate.ts"
beforeAll(async () => { await import("../live/prove-rollout-loop.ts") })

test("ROLL-24 ambient account and project sources stay absent while declared fragment and MCP load", async () => {
  const f = loopFixture(), endpoint = controlledMcp()
  try {
    writeFileSync(f.files.mcp, JSON.stringify({ mcpServers: { synthetic: { type: "http", url: endpoint.url } } }))
    const make = await launchSeam(), input = launchInput(f)
    const launch = await make(input), capture = join(input.sessionDir, "isolation.json")
    const noAmbient = (got: any) => {
      expect(got.ambient).toEqual([])
      expect(appended(got.fragment).preamble).toBe(true)
      expect(got.fragment.endsWith(readFileSync(f.files.fragment, "utf8"))).toBe(true)
      expect(got.fragment).not.toContain("ambient-project-instruction-sentinel")
      expect(got.mcp).toEqual(JSON.parse(readFileSync(f.files.mcp, "utf8")))
    }
    // The defective launch uses the same fake executable with ambient sources enabled.
    for (const poison of [true, false]) {
      const options = poison ? { ...launch, env: { ...launch.env, HOME: f.home, CLAUDE_CODE_DISABLE_AUTO_MEMORY: "0" } } : launch
      const captureWrap = captureCli(capture, f)
      const session = await claudeCode.start({ ...options, preset: input.preset, sessionId: null,
        wrap: argv => launch.wrap(captureWrap(poison ? argv.flatMap((arg, i) => arg === "--setting-sources" || argv[i - 1] === "--setting-sources" ? [] : [arg]) : argv)) })
      try {
        await ending(session)
        const got = JSON.parse(readFileSync(capture, "utf8"))
        if (poison) {
          expect(JSON.stringify(got.ambient)).toContain("ambient-hook-sentinel")
          expect(JSON.stringify(got.ambient)).toContain("ambient-project-instruction-sentinel")
          expect(JSON.stringify(got.ambient)).toContain("ambient-local-settings-sentinel")
          expect(JSON.stringify(got.ambient)).toContain("ambient-plugin-sentinel")
          expect(() => noAmbient(got)).toThrow()
        } else noAmbient(got)
      } finally { await session.close() }
    }
    expect(endpoint.receipts).toEqual([]) // Config read is not a real MCP operation.
  } finally { endpoint.stop(); f.stop() }
})

for (const field of ["hooks", "enabledPlugins", "extraKnownMarketplaces"]) test(`ROLL-24 declared settings reject ${field} with clean settings control`, async () => {
  const f = loopFixture()
  try {
    const make = await launchSeam(), input = launchInput(f)
    expect((await make(input)).argv.length).toBeGreaterThan(0)
    writeFileSync(f.files.settings, JSON.stringify({ permissions: { allow: ["Read"], deny: [] }, [field]: { synthetic: true } }))
    await expect(make(input)).rejects.toThrow(/settings|hooks|plugin|configuration/)
  } finally { f.stop() }
})

test("ROLL-24 harvest prompt contains explicit filing rules with discovery disabled", () => {
  const f = loopFixture()
  try {
    const rules = readFileSync(f.files.filing_rules, "utf8")
    const args = { language: "en" as const, lines: [], filingRules: rules }
    const accepts = (text: string) => expect(text).toContain(rules)
    expect(() => accepts(harvestMessage({ language: "en", lines: [] }))).toThrow()
    accepts(harvestMessage(args))
  } finally { f.stop() }
})

for (const os of ["linux", "darwin"]) if (process.platform !== os) console.log(`SKIP: requires ${os === "linux" ? "Linux" : "macOS"} (ROLL-24 clean cwd)`)
for (const os of ["linux", "darwin"]) test.skipIf(process.platform !== os)(`ROLL-24 ${os} production box preserves clean launch cwd${process.platform !== os ? ` SKIP: requires ${os === "linux" ? "Linux" : "macOS"}` : ""}`, async () => {
  expect(boxGate().ok).toBe(true)
  const f = loopFixture(), input = launchInput(f)
  const box = nativeWrap(input.box)
  try {
    const done = Bun.spawnSync(box.wrap(["/bin/pwd"]), { cwd: input.sessionDir, stdout: "pipe", stderr: "pipe", timeout: 5000 })
    expect(done.exitCode).toBe(0)
    const clean = (cwd: string) => expect(cwd, "L15 cwd must remain the selected session").toBe(input.sessionDir)
    clean(done.stdout.toString().trim())
    const changed = Bun.spawnSync(box.wrap(["/bin/sh", "-c", 'cd "$1" && pwd', "sh", f.trees.person("p1").tree]), { cwd: input.sessionDir, stdout: "pipe", stderr: "pipe", timeout: 5000 })
    expect(changed.exitCode).toBe(0)
    expect(() => clean(changed.stdout.toString().trim())).toThrow()
  } finally { box.stop(); f.stop() }
})

import { afterAll } from "bun:test"
import { rmSync } from "node:fs"
import { startCluster, until, type Cluster } from "./helpers/cluster.ts"
import { stageHarvest, plantLine } from "./helpers/harvest-stage.ts"
import { insertInbound } from "./helpers/hub-fixture.ts"
import { runRunner } from "../src/runner/run.ts"
import { boxCommand, boxContextFor } from "../src/box/index.ts"
import { loadRegistry } from "../src/registry/load.ts"
let cluster: Cluster | undefined
afterAll(async () => { await cluster?.stop() })
for (const source of ["explicit", "default"]) test(`ROLL-24 runner feeds ${source} vault filing rules into the isolated harvest session`, async () => {
  cluster ??= await startCluster()
  const stage = await stageHarvest(cluster, { adapter: { answer: () => "nothing" }, registry: base => ({ ...base, agents: base.agents!.map(agent => ({ ...agent, runner: "runner-pi" })) }) })
  let runner: Awaited<ReturnType<typeof runRunner>> | undefined
  try {
    const rules = `synthetic-${source}-filing-rules-${crypto.randomUUID()}\nUse the note envelope.\n`
    const file = join(stage.vault.root, source === "explicit" ? "selected-rules.md" : "CLAUDE.md")
    writeFileSync(file, rules)
    if (source === "explicit") writeFileSync(stage.hub.registryFile, readFileSync(stage.hub.registryFile, "utf8").replace('id = "p1"\n', `id = "p1"\nfiling_rules = ${JSON.stringify(file)}\n`))
    const untilAt = new Date().toISOString()
    plantLine(stage, { at: new Date(Date.now() - 1000).toISOString(), direction: "in", from: "p1", text: "synthetic filing prompt input" })
    await insertInbound(cluster, stage.hub.db, { id: "filing-rules", kind: "harvest", body: JSON.stringify({ from: null, until: untilAt, reason: "demand", lines: 1 }) })
    runner = await runRunner({ runner: "runner-pi", registryFile: stage.hub.registryFile, adapters: { [stage.hub.adapterName]: stage.hub.scripted.adapter } })
    await until("harvest filing-rules turn settles", async () => (await stage.hub.read.ledger({ stream: "turn" })).some(row => row.subject === "filing-rules"), 15_000)
    const fed = stage.hub.scripted.fed().find(message => message.text.includes("synthetic filing prompt input") && message.text.includes("=== NOTE ==="))
    expect(fed).toBeDefined()
    const containsRules = (text: string) => expect(text, "D-176 runner must feed the selected filing rules bytes").toContain(rules)
    expect(() => containsRules(fed!.text.replace(rules, ""))).toThrow()
    containsRules(fed!.text)
  } finally {
    await runner?.stop()
    const profile = boxCommand([], boxContextFor(loadRegistry(stage.hub.registryFile), "p1-lair")).profile
    if (profile) rmSync(profile.path, { force: true })
    await stage.stop()
  }
})

test("an ordinary loop is told where its person's vault is, so recall and ingest reach it from the clean session directory", async () => {
  const f = loopFixture()
  try {
    const make = await launchSeam(), input = launchInput(f)
    const vault = join(input.box.tree, "vault")
    mkdirSync(vault, { recursive: true })
    const ordinary = await make(input)
    expect(ordinary.env.IMPRNT_VAULT, "the ordinary loop names the person's vault").toBe(vault)
    expect(ordinary.cwd.startsWith(input.box.tree), "the loop still runs outside the tree").toBe(false)
    const harvest = await make({ ...input, purpose: "harvest" })
    expect(harvest.env.IMPRNT_VAULT, "a harvest files through apply, never through its own loop").toBeUndefined()
  } finally { f.stop() }
})
