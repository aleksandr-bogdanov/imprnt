// The OpenCode launch rules, as pure functions: the permission object, the inline
// configuration, the MCP servers in the engine's spelling, the identity a session is bound
// to, and the check that a running server holds what was asked for.
//
// Offline and synthetic: nothing here starts a process, dials a provider or reads a key. What
// it proves is the hub's own rules. It proves nothing about what a real OpenCode build does
// with them: that is what `effectiveRefusal` asks of a running server, and what the live
// proof script does against the pinned binary.

import { expect, test } from "bun:test"
import {
  BUILTIN_SUBAGENTS, HARVEST_PROFILE, ORDINARY_PROFILE, OPENCODE_KEY_ENV,
  effectiveRefusal, identityOf, openCodeConfig, permissionsFor, refuseRoutingOf, translateMcp,
} from "../src/adapters/opencode-config.ts"

const DELEGATION = ["Agent", "Task", "TeamCreate", "SendMessage", "Workflow"]
const identity = identityOf({ provider: "synthetic-provider", model: "synthetic/model-1" }, null)

function configFor(tools: readonly string[] = ORDINARY_PROFILE, servers: Record<string, unknown> = {}) {
  const mcp = translateMcp(servers)
  const permission = permissionsFor({ tools, servers: Object.keys(mcp), outside: ["/tree"], delegation: DELEGATION })
  return openCodeConfig({ identity, permission, mcp, instructions: [] })
}

test("permissions are deny by default and name exactly the tools asked for", () => {
  const permission = permissionsFor({ tools: ["Bash", "Read", "Write", "Edit", "Glob", "Grep", "WebFetch"], servers: [], outside: [], delegation: DELEGATION })
  // The catch-all comes FIRST, because the last matching rule wins.
  expect(Object.keys(permission)[0]).toBe("*")
  expect(permission["*"]).toBe("deny")
  for (const key of ["bash", "edit", "glob", "grep", "webfetch", "list"]) expect(permission[key]).toBe("allow")
  expect(permission.read).toMatchObject({ "*": "allow", "*.env": "deny" })
  expect(permission.websearch).toBeUndefined()
  // Delegation and every key that would otherwise stop and ask are answered, none is left at ask.
  for (const key of ["task", "skill", "question", "lsp", "doom_loop", "todowrite"]) expect(permission[key]).toBe("deny")
  expect(JSON.stringify(permission)).not.toContain('"ask"')
})

test("a read-only profile allows no write, no shell and no web", () => {
  const permission = permissionsFor({ tools: HARVEST_PROFILE, servers: [], outside: ["/tree"], delegation: DELEGATION })
  expect(permission.edit).toBeUndefined()
  expect(permission.bash).toBeUndefined()
  expect(permission.webfetch).toBeUndefined()
  expect(permission.read).toBeDefined()
  // A tool that is not named is denied by the catch-all, which is the whole of the rule.
  expect(permission["*"]).toBe("deny")
  expect(permissionsFor({ tools: [], servers: [], outside: [], delegation: DELEGATION }).read).toBeUndefined()
})

test("a tool list that names delegation, or a builtin with no permission, is refused by name", () => {
  for (const name of ["Agent", "Task", "task", "SendMessage", "Workflow"]) {
    expect(() => permissionsFor({ tools: ["Read", name], servers: [], outside: [], delegation: DELEGATION })).toThrow("native-delegation-configured")
  }
  expect(() => permissionsFor({ tools: ["NotebookEdit"], servers: [], outside: [], delegation: DELEGATION })).toThrow("tool-profile-unvalidated: NotebookEdit")
  // A specifier counts by its name, and an MCP tool is not a builtin.
  expect(permissionsFor({ tools: ["Bash(git:*)", "mcp__hub__anything"], servers: [], outside: [], delegation: DELEGATION }).bash).toBe("allow")
})

test("an MCP server's tools are let in by its name, and outside paths are the only external directories allowed", () => {
  const permission = permissionsFor({ tools: ["Read"], servers: ["hub", "notes"], outside: ["/tree", "/vault"], delegation: DELEGATION })
  expect(permission["hub_*"]).toBe("allow")
  expect(permission["notes_*"]).toBe("allow")
  expect(permission.external_directory).toEqual({ "*": "deny", "/tree": "allow", "/tree/*": "allow", "/vault": "allow", "/vault/*": "allow" })
})

test("MCP servers are translated into the engine's spelling, and a shape it does not know is refused", () => {
  expect(translateMcp({
    notes: { command: "node", args: ["server.js", "--x"], env: { A: "1" } },
    plain: { command: "tool" },
    remote: { type: "http", url: "https://mcp.example.invalid/mcp", headers: { Authorization: "Bearer x" } },
    open: { url: "https://mcp.example.invalid/open" },
  })).toEqual({
    notes: { type: "local", command: ["node", "server.js", "--x"], enabled: true, environment: { A: "1" } },
    plain: { type: "local", command: ["tool"], enabled: true },
    remote: { type: "remote", url: "https://mcp.example.invalid/mcp", enabled: true, headers: { Authorization: "Bearer x" }, oauth: false },
    open: { type: "remote", url: "https://mcp.example.invalid/open", enabled: true },
  })
  for (const bad of [
    { "bad name": { command: "x" } }, { "a*": { command: "x" } }, { x: null }, { x: {} },
    { x: { command: "node", args: [1] } }, { x: { command: "node", env: { A: 1 } } },
    { x: { url: "https://a.invalid", type: "stdio" } }, { x: { url: "https://a.invalid", headers: [] } },
  ]) expect(() => translateMcp(bad as Record<string, unknown>)).toThrow("invalid-mcp-configuration")
})

test("an identity needs a plain provider id and a model with no whitespace, and a model may carry a slash", () => {
  expect(identity).toEqual({ adapter: "opencode", provider: "synthetic-provider", model: "synthetic/model-1", endpoint: null })
  for (const provider of ["", "a/b", "a b", "-a"]) expect(() => identityOf({ provider, model: "m" }, null)).toThrow("opencode-provider-invalid")
  for (const model of ["", " ", "a b", "a\nb"]) expect(() => identityOf({ provider: "p", model }, null)).toThrow("opencode-model-invalid")
})

test("the configuration pins one provider, one model for every auxiliary use, and no key", () => {
  const config = configFor() as Record<string, any>
  expect(config.model).toBe("synthetic-provider/synthetic/model-1")
  // The engine's default for titles and summaries is "a cheaper model if one is available".
  expect(config.small_model).toBe(config.model)
  expect(config.enabled_providers).toEqual(["synthetic-provider"])
  expect(config.provider["synthetic-provider"].options.apiKey).toBe(`{env:${OPENCODE_KEY_ENV}}`)
  expect(config.provider["synthetic-provider"].options.baseURL).toBeUndefined()
  expect(config.plugin).toEqual([])
  expect(config.autoupdate).toBe(false)
  expect(config.share).toBe("disabled")
  expect(config.lsp).toBeUndefined()
  expect(config.formatter).toBeUndefined()
  // A named endpoint is the one place the key goes.
  const bound = identityOf({ provider: "p", model: "m" }, "https://provider.example.invalid/v1")
  const named = openCodeConfig({ identity: bound, permission: {}, mcp: {}, instructions: ["/session/instructions.md"] }) as Record<string, any>
  expect(named.provider.p.options.baseURL).toBe("https://provider.example.invalid/v1")
  expect(named.instructions).toEqual(["/session/instructions.md"])
})

test("subagents are off four ways: the task permission, a depth of zero, each built-in disabled, and the legacy switch", () => {
  const config = configFor() as Record<string, any>
  expect(config.permission.task).toBe("deny")
  expect(config.agent.build.permission.task).toBe("deny")
  expect(config.subagent_depth).toBe(0)
  expect(config.tools).toEqual({ task: false })
  expect(config.default_agent).toBe("build")
  for (const name of BUILTIN_SUBAGENTS) expect(config.agent[name]).toEqual({ disable: true })
})

test("a fallback or advisor route in the argv, the environment or a configuration KEY is refused, and a value is not read", () => {
  expect(() => refuseRoutingOf(["opencode", "--fallback-model", "x"], {}, {})).toThrow("fallback-route-refused")
  expect(() => refuseRoutingOf(["opencode"], { OPENCODE_FALLBACK_MODEL: "x" }, {})).toThrow("fallback-route-refused")
  expect(() => refuseRoutingOf(["opencode"], {}, { agent: { build: { advisor: "x" } } })).toThrow("fallback-route-refused")
  // The person's own words are not a route.
  expect(() => refuseRoutingOf(["opencode"], {}, { mcp: { notes: { command: ["fallback-notes"] } } })).not.toThrow()
  expect(() => refuseRoutingOf(["opencode"], {}, configFor())).not.toThrow()
})

test("the effective configuration is accepted only if it holds what was asked for", () => {
  const expected = configFor() as Record<string, any>
  const held = () => JSON.parse(JSON.stringify(expected))
  expect(effectiveRefusal(expected, held())).toBeNull()
  // Keys the engine adds of its own are not a difference.
  expect(effectiveRefusal(expected, { ...held(), username: "x", keybinds: {} })).toBeNull()

  const without = (change: (config: Record<string, any>) => void) => { const copy = held(); change(copy); return effectiveRefusal(expected, copy) }
  expect(without(c => { c.permission.task = "allow" })).toBe("config-permission-differs: task")
  expect(without(c => { c.permission.bash = "ask" })).toBe("config-permission-differs: bash")
  // A deleted rule is still a deny while the catch-all stands, and is not one once it is gone.
  expect(without(c => { delete c.permission.task })).toBeNull()
  expect(without(c => { c.permission["*"] = "allow"; delete c.permission.task })).toBe("config-permission-differs: *")
  expect(without(c => { c.permission.external_directory = { "*": "allow" } })).toBe("config-permission-differs: external_directory")
  expect(without(c => { c.model = "other/model" })).toBe("config-differs: model")
  expect(without(c => { c.small_model = "other/small" })).toBe("config-differs: small_model")
  expect(without(c => { c.enabled_providers = ["synthetic-provider", "other"] })).toBe("config-differs: enabled_providers")
  expect(without(c => { c.subagent_depth = 1 })).toBe("config-differs: subagent_depth")
  expect(without(c => { c.plugin = ["something"] })).toBe("config-differs: plugin")
  expect(without(c => { c.mcp = { stray: { type: "local", command: ["x"] } } })).toBe("config-differs: mcp")
  expect(without(c => { c.agent.general = { disable: false } })).toBe("config-differs: agent.general")
  expect(without(c => { delete c.agent })).toBe("config-differs: agent.general")
})

test("a configuration shape it cannot read is refused and never waved through", () => {
  const expected = configFor()
  for (const effective of [null, "text", [], { permission: [{ permission: "task", action: "deny" }] }, { permission: "deny" }, {}]) {
    expect(effectiveRefusal(expected, effective)).not.toBeNull()
  }
})
