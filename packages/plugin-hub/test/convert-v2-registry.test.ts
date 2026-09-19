import { beforeAll, expect, test } from "bun:test"
import { copyFileSync, readFileSync, writeFileSync, statSync, rmSync } from "node:fs"
import { join } from "node:path"
import { loadRegistry, readSetting } from "../src/registry/load.ts"
import { readStorePid } from "../src/hub/peak.ts"
import { claudeCode } from "../src/adapters/claude-code.ts"
import { seam, startCluster } from "./helpers/cluster.ts"
import { serviceFixture } from "./helpers/rollout-service.ts"
import { migrationFixture, privateJson, digest } from "./helpers/rollout-migration.ts"
import { launchInput, launchSeam, captureCli, ending } from "./helpers/rollout-loop.ts"
import { proveMigrationFixtures } from "../live/prove-rollout-migration.ts"
beforeAll(proveMigrationFixtures)

async function converter() { return (await seam("src/migrate/registry.ts")).convertV2Registry as (manifest: any, lookup: any) => Promise<any> }

test("ROLL-05 ROLL-30 imported inventory reaches loadRegistry and actual wrapped launches", async () => {
  const f = migrationFixture()
  try {
    const convert = await converter()
    const original = readFileSync(f.file, "utf8")
    const sources = f.sources.map(s => readFileSync(s.file, "utf8"))
    await convert(f.registryManifest, f.lookup)
    expect(readFileSync(f.file, "utf8")).toBe(original)
    expect(f.sources.map(s => readFileSync(s.file, "utf8"))).toEqual(sources)
    for (const file of [f.registryManifest.candidate, f.registryManifest.inventory]) expect(statSync(file).mode & 0o777).toBe(0o600)
    const registry = loadRegistry(f.registryManifest.candidate) as any
    const inventory = JSON.parse(readFileSync(f.registryManifest.inventory, "utf8"))
    expect(inventory.agents.map((a: any) => a.id).sort()).toEqual(["p1-lair", "p2-lair"])
    expect(registry.data.hub.cutover_batch).toBe("synthetic-cutover")
    expect(registry.data.repositories).toEqual(f.registryManifest.repositories)
    expect(f.lookups).toHaveLength(1)
    expect(JSON.stringify(f.lookups)).toContain(f.token)
    expect(JSON.stringify(f.lookups)).not.toContain("synthetic-token")
    const make = await launchSeam()
    for (const source of f.sources) {
      const agent = registry.agents.find((a: any) => a.id === `${source.person}-lair`)
      const person = registry.people.find((p: any) => p.id === source.person)
      expect(person.allowed_senders[agent.door]).toEqual([source.person])
      expect(person.language, "L07 source locale survives").toBe(source.agents.locale)
      expect(person.harvester).toBe("harvest")
      expect(person.vault).toBe(f.trees.person(source.person).tree)
      const entry = inventory.agents.find((a: any) => a.id === agent.id)
      const complete = (entry: any) => expect(entry, "D-168a exhaustive inventory bindings").toMatchObject({
        id: agent.id, fragment_sha256: digest(readFileSync(source.rendered, "utf8")),
        tools: source.tools, settings: agent.settings, mcp: agent.mcp,
        model: "synthetic-alias", chat: agent.chat, credential: "loop-login",
        vault: person.vault, repositories: f.registryManifest.repositories.filter((r: any) => r.person === source.person),
      })
      expect(() => complete({ id: agent.id })).toThrow()
      complete(entry)
      expect(agent.mode).toBe(source.agents.agents[0].mode)
      expect(agent.chat).toBe(source.person === "p1" ? "0000000000" : "1000000001")
      expect(registry.data.presets[agent.preset].model).toBe("synthetic-alias")
      expect(readFileSync(agent.fragment, "utf8")).toBe(readFileSync(source.rendered, "utf8"))
      expect(JSON.parse(readFileSync(agent.settings, "utf8"))).toEqual({ permissions: { allow: source.allow, deny: source.deny } })
      const input: any = launchInput(f)
      Object.assign(input, { registry, agent, preset: registry.data.presets[agent.preset] })
      input.sessionDir = join(f.stateDir, source.person, "sessions", agent.id, crypto.randomUUID())
      input.box = { ...input.box, agent: agent.id, person: source.person, tree: person.tree, otherTrees: [f.trees.person(source.person === "p1" ? "p2" : "p1").tree], stateRoot: join(f.stateDir, source.person), otherStateRoots: [join(f.stateDir, source.person === "p1" ? "p2" : "p1")] }
      const launch = await make(input)
      const capture = join(input.sessionDir, "import.json")
      const session = await claudeCode.start({ ...launch, preset: input.preset, sessionId: null, wrap: argv => launch.wrap(captureCli(capture, f)(argv)) })
      try { await ending(session) } finally { await session.close() }
      const got = JSON.parse(readFileSync(capture, "utf8"))
      const accepts = (value: any) => {
        expect(digest(value.fragment ?? "")).toBe(digest(readFileSync(source.rendered, "utf8")))
        const at = value.argv.indexOf("--tools")
        expect(at).toBeGreaterThan(-1)
        const tail = value.argv.slice(at + 1)
        const end = tail.findIndex((v: string) => v.startsWith("--"))
        expect(tail.slice(0, end < 0 ? undefined : end).flatMap((v: string) => v.split(/[, ]/)).filter(Boolean).sort()).toEqual(source.tools.slice().sort())
        expect(value.mcp).toEqual({ mcpServers: source.mcp ?? {} })
      }
      accepts(got)
      // Feed defective imported bindings through the same real launch path.
      for (const defect of [{ fragment: undefined }, { tools: [] }]) {
        const changed = await make({ ...input, agent: { ...agent, ...defect } })
        const child = await claudeCode.start({ ...changed, preset: input.preset, sessionId: null, wrap: argv => changed.wrap(captureCli(capture, f)(argv)) })
        try { await ending(child) } finally { await child.close() }
        expect(() => accepts(JSON.parse(readFileSync(capture, "utf8")))).toThrow()
      }
    }
  } finally { f.stop() }
})

for (const fault of ["missing-agent", "unreadable-fragment", "unresolved-import", "malformed-json", "duplicate-channel", "absent-channel", "active-overwrite", "relative-input", "malformed-permissions", "malformed-mcp"] as const) test(`ROLL-05 converter refuses ${fault} with a valid same-path control`, async () => {
  const f = migrationFixture()
  try {
    const convert = await converter()
    await convert(f.registryManifest, f.lookup)
    expect(loadRegistry(f.registryManifest.candidate).agents).toHaveLength(2)
    const active = readFileSync(f.file, "utf8")
    const manifest = structuredClone(f.registryManifest)
    if (fault === "missing-agent") { f.sources[0].agents.agents = []; privateJson(f.sources[0].file, f.sources[0].agents) }
    if (fault === "unreadable-fragment") rmSync(f.sources[0].rendered)
    if (fault === "unresolved-import") { f.sources[0].agents.agents[0].fragment = f.sources[0].fragment; privateJson(f.sources[0].file, f.sources[0].agents) }
    if (fault === "malformed-json") writeFileSync(f.sources[0].file, "{")
    if (fault === "malformed-permissions") privateJson(f.sources[0].file, { ...f.sources[0].agents, agents: [{ ...f.sources[0].agents.agents[0], allow: "not-an-array" }] })
    if (fault === "malformed-mcp") privateJson(f.sources[0].file, { ...f.sources[0].agents, mcp: { synthetic: { command: 42, args: "not-an-array" } } })
    if (fault === "duplicate-channel") f.setChannels([{ name: "synthetic-channel", id: "0000000000" }, { name: "synthetic-channel", id: "1000000001" }])
    if (fault === "absent-channel") f.setChannels([])
    if (fault === "active-overwrite") manifest.candidate = f.file
    if (fault === "relative-input") manifest.source_registries[0] = "agents.json"
    // Remove previous outputs so an overwrite refusal cannot mask the named fault.
    rmSync(f.registryManifest.candidate, { force: true })
    rmSync(f.registryManifest.inventory, { force: true })
    await expect(convert(manifest, f.lookup)).rejects.toThrow(/agent|fragment|import|JSON|channel|active|absolute|path|permission|allow|MCP|command/i)
    expect(readFileSync(f.file, "utf8")).toBe(active)
  } finally { f.stop() }
})

test("D-186 steps 6 and 7 the promoted candidate keeps the active registry's install and store tables, so a later database install still runs", async () => {
  const cluster = await startCluster()
  const f = migrationFixture()
  let bootstrap: Awaited<ReturnType<typeof serviceFixture>> | undefined
  try {
    bootstrap = await serviceFixture(cluster, true)
    const { runInstall } = await seam("src/install/run.ts") as { runInstall: (options: any) => Promise<any> }
    const database = () => runInstall({ registryFile: bootstrap!.registryFile, stage: "database" })
    // Step 6 writes [store] into the bootstrap registry the household uses.
    await database()
    // A setting the household put in the bootstrap registry by hand.
    writeFileSync(bootstrap.registryFile, readFileSync(bootstrap.registryFile, "utf8") + "\n[runner]\ntask_retry_seconds = 7\n")
    const bootstrapped = loadRegistry(bootstrap.registryFile)
    const store = bootstrapped.data.store
    expect(readStorePid(bootstrapped).pid, "the real cluster's pid file").toBeGreaterThan(0)
    // Control on the same path: the unconverted registry installs again with no change.
    const before = readFileSync(bootstrap.registryFile, "utf8")
    await database()
    expect(readFileSync(bootstrap.registryFile, "utf8")).toBe(before)
    // Step 7 converts against that registry, and the reviewed candidate is promoted over it.
    const manifest = structuredClone(f.registryManifest)
    manifest.active_registry = bootstrap.registryFile
    manifest.hub = { ...manifest.hub, store_url: (bootstrapped.data.hub as Record<string, unknown>).store_url }
    // A mistyped active registry refuses rather than converting without its tables.
    await expect((await converter())({ ...manifest, active_registry: `${bootstrap.registryFile}.mistyped` }, f.lookup)).rejects.toThrow(/cannot be read/)
    expect(() => statSync(manifest.candidate), "no candidate is published").toThrow()
    await (await converter())(manifest, f.lookup)
    expect(readFileSync(bootstrap.registryFile, "utf8"), "the active registry is never overwritten").toBe(before)
    copyFileSync(manifest.candidate, bootstrap.registryFile)
    // A later migration runs against the promoted file and keeps one store declaration.
    await database()
    const promoted = loadRegistry(bootstrap.registryFile)
    expect(promoted.agents.map(a => a.id).sort()).toEqual(["p1-lair", "p2-lair"])
    expect(readSetting(promoted, "install.admin_argv")).toEqual(bootstrap.admin)
    expect(promoted.data.store).toEqual(store)
    expect(readSetting(promoted, "runner.task_retry_seconds")).toBe(7)
    expect(readStorePid(promoted)).toEqual(readStorePid(bootstrapped))
  } finally { await bootstrap?.stop(); f.stop(); await cluster.stop() }
})
