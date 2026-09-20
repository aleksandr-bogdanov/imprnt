// A preset reference must be the entry's own declared property.
// Each refusal first loads the same reference as a declared own property.
import { afterAll, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { writeRegistry } from "./helpers/registry.ts"
import { loadRegistry, RegistryRefused } from "../src/registry/load.ts"

const dir = mkdtempSync(join(tmpdir(), "hub-rollout-registry-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

for (const reference of ["constructor", "toString"]) {
  for (const owner of ["agent", "harvester"]) {
    test(`ROLL-06 D-171 ${owner} refuses inherited ${reference} and accepts its declared own preset`, () => {
      const preset = {
        adapter: "synthetic-loop",
        model: "synthetic-alias",
        provider: "synthetic-provider",
        effort: "medium",
        paid: "key",
      }
      const spec = {
        presets: { [reference]: preset },
        people: [{
          id: "p1",
          tree: dir,
          ...(owner === "harvester" ? { harvester: reference, vault: join(dir, "vault") } : {}),
        }],
        agents: owner === "agent" ? [{
          id: "p1-lair", person: "p1", preset: reference,
          chat: "1000000001", door: "door-fake", runner: "runner-pi",
        }] : [],
      }
      const file = writeRegistry(dir, spec)
      expect(() => loadRegistry(file)).not.toThrow()
      writeRegistry(dir, { ...spec, presets: {} })
      let refusal: unknown
      try { loadRegistry(file) } catch (error) { refusal = error }
      expect(refusal).toBeInstanceOf(RegistryRefused)
      expect((refusal as RegistryRefused).key).toContain(owner === "agent" ? "preset" : "harvester")
      expect((refusal as RegistryRefused).reason).toContain(reference)
    })
  }
}

import { rolloutFixture } from "./helpers/rollout-fixtures.ts"
import { listAgents, listPeople, listRunEntries } from "../src/registry/entries.ts"
import { readSetting } from "../src/registry/load.ts"
import { getPreset, presetId } from "../src/registry/presets.ts"
import { expectedPresetId } from "./helpers/preset-oracle.ts"
import { boxContextFor } from "../src/box/index.ts"
import { seam } from "./helpers/cluster.ts"

// Accessor call shapes for the defaults are deliberately explicit.
async function accessor(name: string): Promise<(...args: any[]) => any> {
  const mod = await seam("src/registry/entries.ts")
  expect(typeof mod[name], `D-171 missing accessor ${name}`).toBe("function")
  return mod[name] as (...args: any[]) => any
}
function refused(file: string, key: string) {
  let error: unknown
  try { loadRegistry(file) } catch (caught) { error = caught }
  expect(error, `D-171 must refuse ${key}`).toBeInstanceOf(RegistryRefused)
  expect((error as RegistryRefused).key).toContain(key)
}

for (const key of ["fragment", "settings", "mcp"]) {
  test(`ROLL-06 D-171 ${key} is an absolute readable file, with absent preserved`, () => {
    const f = rolloutFixture()
    try {
      expect(listAgents(loadRegistry(f.file))[0]).not.toHaveProperty(key)
      expect((listAgents(loadRegistry(f.write(f.field("p1-lair", key, JSON.stringify(f.files[key])))))[0] as any)[key]).toBe(f.files[key])
      for (const invalid of ['"relative/file"', '"/missing-synthetic-file"', "12", JSON.stringify(f.dir)]) {
        refused(f.write(f.field("p1-lair", key, invalid)), key)
      }
    } finally { f.stop() }
  })
}

for (const [key, valid, invalid] of [
  ["tools", '["Read", "Write"]', ['["Read", "Read"]', '[""]', '[1]', '"Read"']],
  ["mode", '"on-demand"', ['"sometimes"', 'true']],
  ["sleeping", 'true', ['"true"', '1']],
  ["idle_seconds", '17', ['0', '-1', '1.5', '"17"']],
] as const) {
  test(`ROLL-06 ROLL-14 D-171 agent ${key} validates type and domain`, () => {
    const f = rolloutFixture()
    try {
      expect(listAgents(loadRegistry(f.file))[0]).not.toHaveProperty(key)
      const loaded = listAgents(loadRegistry(f.write(f.field("p1-lair", key, valid))))[0] as any
      expect(loaded[key]).toEqual((Bun.TOML.parse(`value = ${valid}`) as any).value)
      for (const bad of invalid) refused(f.write(f.field("p1-lair", key, bad)), key)
    } finally { f.stop() }
  })
}

test("ROLL-06 ROLL-14 D-171 empty tools differ from absent and lifetime defaults stay out of entries", async () => {
  const f = rolloutFixture()
  try {
    const launch = await accessor("launchFor")
    const lifetime = await accessor("lifetimeFor")
    const base = loadRegistry(f.file)
    expect(launch(base, "p1-lair")).toMatchObject({ fragment: null, tools: null, settings: {}, mcp: { mcpServers: {} } })
    expect(lifetime(base, "p1-lair")).toEqual({ mode: "resident", sleeping: false, idle_seconds: 300 })
    expect(listAgents(base)[0]).not.toHaveProperty("mode")
    expect(launch(loadRegistry(f.write(f.field("p1-lair", "tools", "[]"))), "p1-lair").tools).toEqual([])
    let text = f.field("p1-lair", "mode", '"on-demand"')
    text = f.field("p1-lair", "sleeping", 'true', text)
    text = f.field("p1-lair", "idle_seconds", '17', text)
    expect(lifetime(loadRegistry(f.write(text)), "p1-lair")).toEqual({ mode: "on-demand", sleeping: true, idle_seconds: 17 })
  } finally { f.stop() }
})

for (const [key, valid, invalid] of [
  ["allowed_senders", '{ door-fake = ["p1"] }', ['["p1"]', '{ door-fake = [1] }', '{ door-fake = "p1" }', '{ absent = ["p1"] }']],
  ["history_harvest_after", '"2026-09-01T00:00:00Z"', ['"yesterday"', '"2026-09-01T00:00:00+02:00"', '1']],
] as const) {
  test(`ROLL-15 ROLL-18 D-171 people.${key} keeps explicit values and rejects malformed values`, () => {
    const f = rolloutFixture()
    try {
      expect(listPeople(loadRegistry(f.file))[0]).not.toHaveProperty(key)
      expect((listPeople(loadRegistry(f.write(f.field("p1", key, valid))))[0] as any)[key]).toEqual((Bun.TOML.parse(`v = ${valid}`) as any).v)
      for (const bad of invalid) refused(f.write(f.field("p1", key, bad)), key)
    } finally { f.stop() }
  })
}

test("ROLL-06 D-171 filing rules use the declared vault default and refuse relative or unreadable paths", async () => {
  const f = rolloutFixture()
  try {
    const get = await accessor("filingRulesFor")
    expect(get(loadRegistry(f.file), "p1")).toBeNull()
    const base = f.field("p1", "vault", JSON.stringify(f.trees.person("p1").tree))
    expect(get(loadRegistry(f.write(base)), "p1")).toBe(join(f.trees.person("p1").tree, "CLAUDE.md"))
    expect(get(loadRegistry(f.write(f.field("p1", "filing_rules", JSON.stringify(f.files.filing_rules), base))), "p1")).toBe(f.files.filing_rules)
    for (const bad of ['"relative.md"', '"/missing-synthetic-file"', 'false']) refused(f.write(f.field("p1", "filing_rules", bad, base)), "filing_rules")
  } finally { f.stop() }
})

test("ROLL-15 Forbidden empty allowlist granting access: accessor denies absent/empty and accepts stable IDs", async () => {
  const f = rolloutFixture()
  try {
    const accepts = (fn: (...args: any[]) => boolean) => {
      expect(fn(loadRegistry(f.write()), "p1", "door-fake", "p1")).toBe(false)
      expect(fn(loadRegistry(f.write(f.field("p1", "allowed_senders", '{ door-fake = [] }'))), "p1", "door-fake", "p1")).toBe(false)
      const listed = loadRegistry(f.write(f.field("p1", "allowed_senders", '{ door-fake = ["p1"] }')))
      expect(fn(listed, "p1", "door-fake", "p1")).toBe(true)
      expect(fn(listed, "p1", "door-fake", "p2")).toBe(false)
      expect(fn(listed, "p2", "door-fake", "p1")).toBe(false)
    }
    expect(() => accepts(() => true)).toThrow()
    accepts(await accessor("senderAllowed"))
  } finally { f.stop() }
})

for (const [scope, key, defaultValue] of [
  ["door", "media_max_bytes", 20971520], ["door", "delivery_retry_seconds", 30],
  ["door", "delivery_max_attempts", 5], ["door", "read_retry_seconds", 30],
  ["runner", "task_retry_seconds", 30],
] as const) {
  test(`ROLL-01 ROLL-20 D-171 ${scope}.${key} default and positive integer validation`, () => {
    const f = rolloutFixture()
    try {
      expect(() => readSetting(loadRegistry(f.file), `${scope}.${key}`), `D-171 missing setting ${scope}.${key}`).not.toThrow()
      expect(readSetting(loadRegistry(f.file), `${scope}.${key}`)).toBe(defaultValue)
      expect(readSetting(loadRegistry(f.write(`${f.base}\n[${scope}]\n${key} = 19\n`)), `${scope}.${key}`)).toBe(19)
      for (const bad of ["0", "-1", "1.5", '"19"']) refused(f.write(`${f.base}\n[${scope}]\n${key} = ${bad}\n`), key)
    } finally { f.stop() }
  })
}
for (const [key, fallback] of [["max_active_children", 4], ["child_memory_budget_mb", 2048]] as const) {
  test(`ROLL-14 D-171 runner ${key} preserves absence and supplies ${fallback}`, async () => {
    const f = rolloutFixture()
    try {
      const limits = await accessor("runnerLimitsFor")
      const base = loadRegistry(f.file)
      expect(listRunEntries(base).find(r => r.id === "runner-pi")).not.toHaveProperty(key)
      expect(limits(base, "runner-pi")[key]).toBe(fallback)
      expect(limits(loadRegistry(f.write(f.field("runner-pi", key, "13"))), "runner-pi")[key]).toBe(13)
      for (const bad of ["0", "-1", "1.5", '"13"']) refused(f.write(f.field("runner-pi", key, bad)), key)
    } finally { f.stop() }
  })
}

test("ROLL-18 D-171 cutover batch has no implicit gate and rejects non IDs", () => {
  const f = rolloutFixture()
  try {
    expect(() => readSetting(loadRegistry(f.file), "hub.cutover_batch"), "D-171 missing setting hub.cutover_batch").not.toThrow()
    expect(readSetting(loadRegistry(f.file), "hub.cutover_batch")).toBeUndefined()
    expect(readSetting(loadRegistry(f.write(f.base.replace('[hub]', '[hub]\ncutover_batch = "synthetic-batch"'))), "hub.cutover_batch")).toBe("synthetic-batch")
    for (const bad of ['""', "3", "false"]) refused(f.write(f.base.replace('[hub]', `[hub]\ncutover_batch = ${bad}`)), "cutover_batch")
  } finally { f.stop() }
})

test("ROLL-17 D-171 admin argv is explicit nonempty argv without passwords", () => {
  const f = rolloutFixture()
  try {
    expect(() => readSetting(loadRegistry(f.file), "install.admin_argv"), "D-171 missing setting install.admin_argv").not.toThrow()
    expect(readSetting(loadRegistry(f.file), "install.admin_argv")).toBeUndefined()
    const argv = ["psql", "-X"]
    expect(readSetting(loadRegistry(f.write(`${f.base}\n[install]\nadmin_argv = ${JSON.stringify(argv)}`)), "install.admin_argv")).toEqual(argv)
    for (const bad of ['[]', '"psql"', '["psql", 1]', '[""]', '["psql", "postgres://p1:synthetic-secret@localhost/hub"]', '["env", "PGPASSWORD=synthetic-secret", "psql"]']) refused(f.write(`${f.base}\n[install]\nadmin_argv = ${bad}`), "admin_argv")
  } finally { f.stop() }
})

test("ROLL-31 D-171 repositories validate ownership paths references and required default", async () => {
  const f = rolloutFixture()
  try {
    const get = await accessor("repositoriesFor")
    const repo = `\n[[repositories]]\nid = "p1-vault"\nperson = "p1"\npath = ${JSON.stringify(f.trees.person("p1").tree)}\nremote = "origin"\nbranch = "main"\n`
    const entry = '\n[[run]]\nid = "sync-p1"\nkind = "sync"\nschedule = "5m"\nmemory_limit_mb = 128\nrepositories = ["p1-vault"]\n'
    const good = f.base + repo + entry
    expect(get(loadRegistry(f.write(good)), "sync-p1")).toEqual([{ id: "p1-vault", person: "p1", path: f.trees.person("p1").tree, remote: "origin", branch: "main", required: true }])
    for (const [from, to, key] of [
      ['repositories = ["p1-vault"]', 'repositories = ["absent"]', 'repositories'],
      ['repositories = ["p1-vault"]', 'repositories = []', 'repositories'],
      ['repositories = ["p1-vault"]', '', 'repositories'],
      ['person = "p1"\npath', 'person = "absent"\npath', 'person'],
      [`path = ${JSON.stringify(f.trees.person("p1").tree)}`, 'path = "relative"', 'path'],
      ['remote = "origin"', 'remote = ""', 'remote'], ['branch = "main"', 'branch = ""', 'branch'],
      ['id = "p1-vault"', 'id = ""', 'id'],
      ['person = "p1"\npath', 'person = 1\npath', 'person'],
      ['remote = "origin"', 'remote = 1', 'remote'],
      ['branch = "main"', 'branch = false', 'branch'],
    ]) refused(f.write(good.replace(from, to)), key)
    refused(f.write(good.replace('branch = "main"', 'branch = "main"\nrequired = "true"')), "required")
    expect(get(loadRegistry(f.write(good.replace('branch = "main"', 'branch = "main"\nrequired = false'))), "sync-p1")[0].required).toBe(false)
  } finally { f.stop() }
})

test("ROLL-17 Forbidden fallback to hub: every supported kind resolves and unknown kind refuses by name", async () => {
  const accepts = (fn: (kind: string) => string) => {
    for (const kind of ["hub", "door", "runner", "sync"]) expect(fn(kind)).toEndWith(`/src/entry/${kind}.ts`)
    expect(() => fn("synthetic-unknown")).toThrow("unsupported-run-kind")
  }
  expect(() => accepts(kind => `${dir}/src/entry/${["door", "runner", "sync"].includes(kind) ? kind : "hub"}.ts`)).toThrow()
  const mod = await seam("src/hub/program.ts")
  expect(typeof mod.programForKind).toBe("function")
  accepts(mod.programForKind as (kind: string) => string)
})

test("ROLL-16 Forbidden private state outside person boundary: box inputs include both state roots", () => {
  const f = rolloutFixture()
  try {
    const accepts = (ctx: any) => {
      expect(ctx.stateRoot).toBe(join(f.stateDir, "p1"))
      expect(ctx.otherStateRoots).toEqual([join(f.stateDir, "p2")])
      expect(ctx.otherStateRoots).not.toContain(ctx.stateRoot)
    }
    const ctx = boxContextFor(loadRegistry(f.file), "p1-lair")
    expect(() => accepts({ ...ctx, stateRoot: join(f.stateDir, "p1"), otherStateRoots: [] })).toThrow()
    accepts(ctx)
  } finally { f.stop() }
})

test("ROLL-23 ROLL-06 identity is selected five-field preset, never reference name or launch configuration", () => {
  const f = rolloutFixture()
  try {
    const accepts = (hash: typeof presetId, registry: unknown) => {
      for (const name of ["daily", "alternate"]) expect(hash(getPreset(registry, name))).toBe(expectedPresetId({ ...getPreset(registry, name) }))
      expect(hash(getPreset(registry, "daily"))).not.toBe(hash(getPreset(registry, "alternate")))
    }
    const base = loadRegistry(f.file)
    expect(() => accepts(() => new Bun.CryptoHasher("sha256").update("daily").digest("hex").slice(0, 16), base)).toThrow()
    accepts(presetId, base)
    // The same identity must survive new explicit settings and empty tools.
    const registry = loadRegistry(f.write(f.field("p1-lair", "settings", JSON.stringify(f.files.settings), f.field("p1-lair", "tools", "[]"))))
    accepts(presetId, registry)
    expect(listAgents(registry)[0]).toHaveProperty("tools", [])
    expect(listAgents(registry)[0]).toHaveProperty("settings", f.files.settings)
    // New settings must not make an invalid instruction source legal.
    refused(f.write(f.field("p1-lair", "settings", '"relative.json"')), "settings")
  } finally { f.stop() }
})

test("ROLL-13 D-171 production adapters require declared credentials while fake adapters stay usable", () => {
  const f = rolloutFixture()
  try {
    expect(() => loadRegistry(f.file)).not.toThrow()
    const production = f.base.replaceAll('adapter = "synthetic-loop"', 'adapter = "claude-code"')
    const declared = production.replaceAll('adapter = "claude-code"', 'adapter = "claude-code"\ncredential = "synthetic-login"') + `\n[[credentials]]\nid = "synthetic-login"\nkind = "claude-login"\nowner = "household"\nfile = ${JSON.stringify(f.files.settings)}\n`
    expect(() => loadRegistry(f.write(declared))).not.toThrow()
    refused(f.write(production), "credential")
  } finally { f.stop() }
})

test("ROLL-17 D-171 loader refuses unsupported kinds by name", () => {
  const f = rolloutFixture()
  try {
    // Same syntactically valid standalone entry, changing only the kind.
    const entry = '\n[[run]]\nid = "hub-pi"\nkind = "hub"\nschedule = "always"\nmemory_limit_mb = 128\n'
    expect(() => loadRegistry(f.write(f.base + entry))).not.toThrow()
    for (const kind of ["watcher", "transcriber", "backup", "board", "synthetic-unknown"]) {
      const file = f.write(f.base + entry.replace('kind = "hub"', `kind = "${kind}"`))
      expect(() => loadRegistry(file), `unsupported-run-kind ${kind}`).toThrow("unsupported-run-kind")
    }
  } finally { f.stop() }
})
