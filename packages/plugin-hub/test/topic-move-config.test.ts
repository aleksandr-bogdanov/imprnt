// The effective launch configuration of a move (`move-config.ts`): what two machines compare. Exact equality, named sections, and no value, path or
// prompt text in anything it returns. Synthetic files only; no store, no engine, no credential is read.

import { afterAll, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { writeRegistry, type AgentSpec, type PersonSpec } from "./helpers/registry.ts"
import { loadRegistry, type Registry } from "../src/registry/load.ts"
import { configDifference, effectiveConfigOf, MAX_MCP_SERVERS } from "../src/runner/move-config.ts"

const made: string[] = []
afterAll(() => { for (const dir of made) rmSync(dir, { recursive: true, force: true }) })
const SECRET = "sk-test-secret-0123456789"

interface Where { dir: string; tree: string }
interface Options { person?: Record<string, unknown>; agent?: Record<string, unknown> }

/** A scratch household of one person and one agent; `make` names its files, which are written with `write` before the registry is loaded. */
function setup(make: (where: Where) => Options = () => ({})) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "mc-")))
  made.push(dir)
  const tree = join(dir, "p1")
  mkdirSync(tree)
  const options = make({ dir, tree })
  const write = (file: string, value: unknown) => { writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value)); return file }
  const registry = (machine?: string): Registry => loadRegistry(writeRegistry(dir, {
    hub: { state_dir: dir, store_url: "postgres://127.0.0.1:1/unused" },
    machines: [{ id: "pi", os: "linux" }, { id: "mac", os: "macos" }],
    people: [{ id: "p1", tree, ...options.person } as PersonSpec],
    presets: { daily: { adapter: "a-scripted-adapter", model: "m", provider: "p", effort: "medium", paid: "key" } },
    agents: [{ id: "a1", person: "p1", preset: "daily", chat: "1000000001", door: "door-fake", runner: "runner-a", ...options.agent } as AgentSpec],
    run: [
      { id: "door-fake", kind: "door", machine: "pi", platform: "fake", person: "p1", token_file: "/dev/null", schedule: "always", memory_limit_mb: 192 },
      { id: "runner-a", kind: "runner", machine: "pi", schedule: "always", memory_limit_mb: 512, child_memory_limit_mb: 512 },
    ],
  }), machine ? { machine } : {})
  return { dir, tree, write, registry }
}

const sections = (registry: Registry, move = "move-1") => {
  const answer = effectiveConfigOf(registry, "a1", move)
  if ("unverifiable" in answer) throw new Error(`unverifiable: ${answer.unverifiable}`)
  return answer
}
const unverifiable = (registry: Registry) => { const answer = effectiveConfigOf(registry, "a1", "move-1"); return "unverifiable" in answer ? answer.unverifiable : null }
const server = (over: Record<string, unknown> = {}) => ({ command: "node", args: ["server.js"], env: { TOKEN: SECRET, MODE: "fast" }, headers: { Authorization: `Bearer ${SECRET}` }, ...over })

test("MC-1: a server's env and header values are compared exactly, a changed argument or a server added or removed is named, and an equal configuration is equal", () => {
  const s = setup(({ dir }) => ({ person: { mcp: join(dir, "mcp.json"), settings: join(dir, "settings.json") } }))
  const mcp = (value: unknown) => s.write(join(s.dir, "mcp.json"), { mcpServers: value })
  mcp({ files: server() })
  s.write(join(s.dir, "settings.json"), { permissions: { allow: ["Read"] } })
  const a = sections(s.registry())
  expect(Object.keys(a.sections).sort()).toEqual(["instructions", "mcp", "mcp:files", "preamble", "settings"])
  expect(a.excluded, "what the launch contracts keep for each machine: the login and the hub's own tool server").toEqual(["login", "hub-tool-server"])
  expect(configDifference(a, sections(s.registry()))).toEqual([])

  // A value of env is an ordinary setting as easily as a credential, and nothing here can tell which: it is compared, never excused.
  const changed = (over: Record<string, unknown>) => { mcp({ files: server(over) }); return configDifference(a, sections(s.registry())) }
  expect(changed({ env: { TOKEN: SECRET, MODE: "slow" } }), "a noncredential env value").toEqual(["mcp:files"])
  expect(changed({ env: { TOKEN: `${SECRET}-other`, MODE: "fast" } }), "a credential-shaped env value is not excused either").toEqual(["mcp:files"])
  expect(changed({ headers: { Authorization: "Bearer other" } })).toEqual(["mcp:files"])
  expect(changed({ args: ["server.js", "--verbose"] })).toEqual(["mcp:files"])
  expect(changed({})).toEqual([])

  mcp({ files: server(), extra: { command: "x" } })
  expect(configDifference(a, sections(s.registry()))).toEqual(["mcp", "mcp:extra"])
  mcp({})
  expect(configDifference(a, sections(s.registry()))).toEqual(["mcp", "mcp:files"])
  s.write(join(s.dir, "settings.json"), { permissions: { allow: ["Read", "Write"] } })
  expect(configDifference(a, sections(s.registry()))).toEqual(["mcp", "mcp:files", "settings"])
})

test("MC-2: no value, path or prompt text appears in a section, a name, a difference or a refusal", () => {
  const s = setup(({ dir, tree }) => ({ person: { mcp: join(dir, "mcp.json"), instructions: [join(tree, "rules.md")] } }))
  s.write(join(s.dir, "mcp.json"), { mcpServers: { files: server() } })
  s.write(join(s.tree, "rules.md"), `standing rules ${SECRET}\n`)
  const a = sections(s.registry())
  s.write(join(s.tree, "rules.md"), `other rules ${SECRET}\n`)
  const b = sections(s.registry())
  expect(configDifference(a, b)).toEqual(["instructions"])
  const seen = JSON.stringify([a, b, configDifference(a, b)])
  for (const leaked of [SECRET, "standing rules", "other rules", "Bearer", "server.js", s.dir]) expect(seen, leaked).not.toContain(leaked)

  s.write(join(s.dir, "mcp.json"), "{ not json")
  const refused = effectiveConfigOf(s.registry(), "a1", "move-1")
  expect(refused).toEqual({ unverifiable: "config_invalid" })
  expect(JSON.stringify(refused)).not.toContain(s.dir)
})

test("MC-3: an edited instruction file and an edited import are each named, the default files are part of the prompt, and a forbidden import is a refusal by code", () => {
  const s = setup(({ tree }) => ({ person: { instructions: [join(tree, "rules.md")] } }))
  s.write(join(s.tree, "rules.md"), "# rules\n@extra.md\n")
  s.write(join(s.tree, "extra.md"), "imported v1\n")
  const a = sections(s.registry())
  s.write(join(s.tree, "extra.md"), "imported v2\n")
  expect(configDifference(a, sections(s.registry())), "an import that changed").toEqual(["instructions"])
  s.write(join(s.tree, "rules.md"), "# rules\n@extra.md\nmore\n")
  expect(configDifference(a, sections(s.registry())), "the file itself").toEqual(["instructions"])

  // Where the person lists none, the vault root's own CLAUDE.md is what the launch reads: absent, then present, then changed.
  const plain = setup()
  const none = sections(plain.registry())
  plain.write(join(plain.tree, "CLAUDE.md"), "default rules\n")
  const one = sections(plain.registry())
  expect(configDifference(none, one)).toEqual(["instructions"])
  plain.write(join(plain.tree, "CLAUDE.local.md"), "local rules\n")
  expect(configDifference(one, sections(plain.registry()))).toEqual(["instructions"])

  // An import that leaves the person's vault is the launch's own refusal, by code: the path is not repeated.
  const bad = setup(({ tree }) => ({ person: { instructions: [join(tree, "rules.md")] } }))
  bad.write(join(bad.dir, "outside.md"), "elsewhere\n")
  bad.write(join(bad.tree, "rules.md"), `@${join(bad.dir, "outside.md")}\n`)
  expect(effectiveConfigOf(bad.registry(), "a1", "move-1")).toEqual({ unverifiable: "instructions_invalid" })
})

test("MC-4: an agent's own files replace its person's, a placement is compared by content and never by path, and a triage master compares nothing", () => {
  const own = setup(({ dir }) => ({ person: { mcp: join(dir, "p-mcp.json") }, agent: { mcp: join(dir, "a-mcp.json") } }))
  own.write(join(own.dir, "p-mcp.json"), { mcpServers: { person: { command: "p" } } })
  own.write(join(own.dir, "a-mcp.json"), { mcpServers: { agent: { command: "a" } } })
  expect(Object.keys(sections(own.registry()).sections).filter(name => name.startsWith("mcp:"))).toEqual(["mcp:agent"])

  // The same person on another machine: its own tree and file, other paths and the same content.
  const placed = setup(({ dir }) => ({ person: { mcp: join(dir, "p-mcp.json"), on: { mac: { tree: join(dir, "p1-mac"), mcp: join(dir, "mac-mcp.json") } } } }))
  mkdirSync(join(placed.dir, "p1-mac"))
  placed.write(join(placed.dir, "p-mcp.json"), { mcpServers: { files: { command: "node" } } })
  placed.write(join(placed.dir, "mac-mcp.json"), { mcpServers: { files: { command: "node" } } })
  expect(configDifference(sections(placed.registry("pi")), sections(placed.registry("mac"))), "same content at another path").toEqual([])
  placed.write(join(placed.dir, "mac-mcp.json"), { mcpServers: { files: { command: "node", args: ["x"] } } })
  expect(configDifference(sections(placed.registry("pi")), sections(placed.registry("mac")))).toEqual(["mcp:files"])

  const triage = setup(({ dir }) => ({ agent: { role: "triage" }, person: { mcp: join(dir, "none.json") } }))
  triage.write(join(triage.dir, "none.json"), { mcpServers: { x: { command: "x" } } })
  expect(effectiveConfigOf(triage.registry(), "a1", "move-1"), "its launch reads none of it").toEqual({ version: 1, sections: {}, excluded: [] })
  expect(effectiveConfigOf(triage.registry(), "nobody", "move-1")).toEqual({ unverifiable: "agent_unknown" })
})

test("MC-5: a server named hub, too many servers and a name that is no name are refusals by code; an invalid settings file is one too", () => {
  const s = setup(({ dir }) => ({ person: { mcp: join(dir, "mcp.json"), settings: join(dir, "settings.json") } }))
  const mcp = (value: unknown) => s.write(join(s.dir, "mcp.json"), { mcpServers: value })
  s.write(join(s.dir, "settings.json"), {})
  mcp({ hub: { command: "x" } })
  expect(unverifiable(s.registry()), "the hub adds its own: a person's server of that name is refused, never excluded by its name").toBe("mcp_invalid")
  mcp(Object.fromEntries(Array.from({ length: MAX_MCP_SERVERS + 1 }, (_, n) => [`s${n}`, { command: "x" }])))
  expect(unverifiable(s.registry())).toBe("mcp_too_many")
  mcp({ "a/b": { command: "x" } })
  expect(unverifiable(s.registry())).toBe("mcp_server_name")
  mcp({ ok: { command: "x" } })
  expect(unverifiable(s.registry())).toBeNull()
  s.write(join(s.dir, "settings.json"), { env: { KEY: SECRET } })
  expect(effectiveConfigOf(s.registry(), "a1", "move-1")).toEqual({ unverifiable: "settings_invalid" })
  s.write(join(s.dir, "settings.json"), { permissions: { allow: "Read" } })
  expect(unverifiable(s.registry())).toBe("settings_invalid")
})

test("MC-6: digests are keyed by the move, so two moves' are not comparable, and a difference needs both sides to be configurations", () => {
  const s = setup()
  const a = sections(s.registry(), "move-1")
  expect(sections(s.registry(), "move-1")).toEqual(a)
  expect(sections(s.registry(), "move-2").sections.instructions).not.toBe(a.sections.instructions)
  expect(configDifference(a, sections(s.registry(), "move-2"))).toEqual(Object.keys(a.sections).sort())
  expect(configDifference(a, undefined)).toEqual(["config"])
  expect(configDifference(null, a)).toEqual(["config"])
  expect(configDifference({ ...a, version: 2 }, a)).toEqual(["version"])
})
