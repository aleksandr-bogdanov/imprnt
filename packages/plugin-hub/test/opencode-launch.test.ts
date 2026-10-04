// What a launch of OpenCode is made of: the one object `Adapter.start` is handed, and
// everything refused before a model child could start.
//
// Offline and synthetic: the binary is a shell script that prints a version, every key is a
// random placeholder, and nothing dials a provider. It proves the hub's own preparation. What
// the engine then does with the environment, the configuration and the permissions it is given
// is asked of a running server by `start` and proved against the pinned binary by
// `live/prove-opencode.ts`.

import { afterAll, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ADAPTERS, adapterFor, checkLoopSource, loopLaunch } from "../src/adapters/index.ts"
import { VALIDATED, createOpenCode, openCode } from "../src/adapters/opencode.ts"
import { OPENCODE_CONFIG_ENV, OPENCODE_KEY_ENV } from "../src/adapters/opencode-config.ts"
import { makeOpenCodeLaunch, probeOpenCodeVersion, readModelKey } from "../src/adapters/opencode-launch.ts"
import { makeLoopLaunch } from "../src/adapters/launch.ts"
import { loadRegistry } from "../src/registry/load.ts"
import { writeRegistry } from "./helpers/authorized-registry.ts"

const dirs: string[] = []
afterAll(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

const PRESET = { adapter: "opencode", model: "synthetic-model", provider: "synthetic-provider", effort: "default", paid: "key" }

function fixture(purpose = "ordinary") {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "hub-opencode-launch-")))
  dirs.push(dir)
  const tree = join(dir, "tree")
  mkdirSync(join(tree, "vault"), { recursive: true })
  writeFileSync(join(tree, "CLAUDE.md"), "vault-rules-sentinel\n")
  const key = "synthetic-model-key-" + crypto.randomUUID()
  const keyFile = join(dir, "secrets", "provider.token")
  mkdirSync(join(dir, "secrets"), { recursive: true })
  writeFileSync(keyFile, key + "\n", { mode: 0o600 })
  const sessionDir = join(dir, "state", "p1", "sessions", "p1-lair", "conversation-1")
  const bin = join(dir, "bin", "opencode")
  mkdirSync(join(dir, "bin"))
  writeFileSync(bin, '#!/bin/sh\necho "opencode 9.9.9"\n', { mode: 0o755 })
  const credential = { id: "provider-key", kind: "model-key", file: keyFile, owner: "p1" }
  const agent = { id: "p1-lair", person: "p1", preset: "opencode-daily", runner: "runner-pi", door: "door-d", chat: "1000000001", tools: ["Read", "Write", "Bash"] as string[] | undefined } as Record<string, unknown>
  const input = () => ({
    registry: null, preset: PRESET, credential, agent, sessionDir, purpose,
    box: { agent: "p1-lair", person: "p1", tree, otherTrees: [], stateRoot: join(dir, "state", "p1"), sessionDir, purpose },
  }) as any
  return { dir, tree, key, keyFile, sessionDir, bin, credential, agent, input }
}

/** Every byte under a directory, which is where a leaked key would be. */
function written(root: string): string {
  const out: string[] = []
  const walk = (at: string) => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(join(at, entry.name))
      else out.push(readFileSync(join(at, entry.name), "utf8"))
    }
  }
  walk(root)
  return out.join("\n")
}

const configOf = (launch: { env: Record<string, string | undefined> }) => JSON.parse(launch.env[OPENCODE_CONFIG_ENV]!) as Record<string, any>

test("an ordinary launch hands the child the key as one variable and nothing of it anywhere else", () => {
  const f = fixture()
  const ambient = { OPENAI_API_KEY: "ambient-openai", ANTHROPIC_API_KEY: "ambient-anthropic", DEEPSEEK_API_KEY: "ambient-deepseek", OPENCODE_EXPERIMENTAL: "1",
    OPENCODE_CONFIG: "/ambient/opencode.json", OPENCODE_ENABLE_EXA: "1", XDG_CONFIG_HOME: "/ambient/config" }
  const saved = Object.fromEntries(Object.keys(ambient).map(key => [key, process.env[key]]))
  let launch: any
  try {
    Object.assign(process.env, ambient)
    launch = makeOpenCodeLaunch(f.input(), f.bin)
  } finally {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
  }
  expect(launch.credentialId).toBe("provider-key")
  expect(typeof launch.wrap).toBe("function")
  expect(launch.argv).toEqual([f.bin, "serve", "--hostname", "127.0.0.1", "--pure"])
  // The key is one environment variable, and is not in the argv, the configuration or any file the launch wrote.
  expect(launch.env[OPENCODE_KEY_ENV]).toBe(f.key)
  expect(launch.argv.join("\n")).not.toContain(f.key)
  expect(launch.env[OPENCODE_CONFIG_ENV]).not.toContain(f.key)
  expect(written(launch.cwd)).not.toContain(f.key)
  expect(configOf(launch).provider["synthetic-provider"].options.apiKey).toBe(`{env:${OPENCODE_KEY_ENV}}`)
  // Nothing ambient is inherited: no provider key, no engine switch, no config path of the parent's.
  for (const name of Object.keys(ambient).filter(one => one !== "XDG_CONFIG_HOME")) expect(launch.env[name]).toBeUndefined()
  expect(launch.env.XDG_CONFIG_HOME).not.toBe("/ambient/config")
  expect(Object.keys(launch.env).filter(name => /^OPENCODE_EXPERIMENTAL|^OPENCODE_ENABLE|^OPENCODE_CONFIG$/.test(name))).toEqual([])
  // The engine's home, its XDG directories and its scratch are the conversation's own, inside its session directory.
  for (const name of ["HOME", "TMPDIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"]) {
    expect(launch.env[name].startsWith(launch.cwd + "/")).toBe(true)
    expect(existsSync(launch.env[name])).toBe(true)
  }
  expect(launch.cwd).toBe(f.sessionDir)
  expect(launch.env.OPENCODE_DISABLE_CLAUDE_CODE).toBe("1")
  expect(launch.env.OPENCODE_DISABLE_AUTOUPDATE).toBe("1")
  expect(launch.env.OPENCODE_DISABLE_DEFAULT_PLUGINS).toBe("1")
  // A password of its own, per launch.
  expect(launch.env.OPENCODE_SERVER_PASSWORD).toMatch(/^[0-9a-f]{48}$/)
  expect(makeOpenCodeLaunch(f.input(), f.bin).env.OPENCODE_SERVER_PASSWORD).not.toBe(launch.env.OPENCODE_SERVER_PASSWORD)
  // The vault is told where it is, and its rules are in the instructions the engine is handed.
  expect(launch.env.IMPRNT_VAULT).toBe(join(f.tree, "vault"))
  const config = configOf(launch)
  expect(config.instructions).toEqual([join(f.sessionDir, "instructions.md")])
  expect(readFileSync(config.instructions[0], "utf8")).toContain("vault-rules-sentinel")
})

test("the configuration is deny by default with exactly the agent's tools, and subagents are off", () => {
  const f = fixture()
  const config = configOf(makeOpenCodeLaunch(f.input(), f.bin))
  expect(config.model).toBe("synthetic-provider/synthetic-model")
  expect(config.small_model).toBe(config.model)
  expect(config.enabled_providers).toEqual(["synthetic-provider"])
  expect(config.permission["*"]).toBe("deny")
  expect(config.permission).toMatchObject({ read: expect.any(Object), edit: "allow", bash: "allow", list: "allow", task: "deny" })
  expect(config.permission.webfetch).toBeUndefined()
  // The tree is the one external directory, and it is allowed by name.
  expect(config.permission.external_directory).toEqual({ "*": "deny", [f.tree]: "allow", [`${f.tree}/*`]: "allow" })
  expect(config.subagent_depth).toBe(0)
  expect(config.mcp).toEqual({})
  // An agent that names no tools gets the explicit profile, never the engine's default.
  f.agent.tools = undefined
  const profiled = configOf(makeOpenCodeLaunch(f.input(), f.bin))
  expect(profiled.permission).toMatchObject({ bash: "allow", edit: "allow", glob: "allow", grep: "allow", webfetch: "allow" })
  expect(profiled.permission.websearch).toBeUndefined()
})

test("a hunt's master has no tool, no server and no instructions, and a harvest reads and writes nothing", () => {
  const triage = makeOpenCodeLaunch(fixture("triage").input(), "opencode") as any
  const config = configOf(triage)
  expect(config.permission["*"]).toBe("deny")
  for (const key of ["read", "edit", "bash", "glob", "grep", "webfetch", "list"]) expect(config.permission[key]).toBeUndefined()
  expect(config.permission.external_directory).toEqual({ "*": "deny" })
  expect(config.mcp).toEqual({})
  expect(config.instructions).toEqual([])
  expect(existsSync(join(triage.cwd, "instructions.md"))).toBe(false)
  expect(triage.env.IMPRNT_VAULT).toBeUndefined()

  const harvest = configOf(makeOpenCodeLaunch(fixture("harvest").input(), "opencode"))
  expect(harvest.permission).toMatchObject({ read: expect.any(Object), glob: "allow", grep: "allow", list: "allow" })
  for (const key of ["edit", "bash", "webfetch"]) expect(harvest.permission[key]).toBeUndefined()
})

test("the person's servers are translated, the hub's is added beside them, and a server of that name is refused", () => {
  const f = fixture()
  const mcp = join(f.dir, "mcp.json")
  writeFileSync(mcp, JSON.stringify({ mcpServers: { notes: { command: "node", args: ["notes.js"] } } }))
  f.agent.mcp = mcp
  const hubMcp = { command: "node", args: ["facade.js"], env: { SOCKET: "/session/hub.sock" }, reads: [join(f.dir, "facade.js")], writes: [join(f.dir, "socket-dir")] }
  const config = configOf(makeOpenCodeLaunch({ ...f.input(), hubMcp }, f.bin))
  expect(Object.keys(config.mcp).sort()).toEqual(["hub", "notes"])
  expect(config.mcp.hub).toEqual({ type: "local", command: ["node", "facade.js"], enabled: true, environment: { SOCKET: "/session/hub.sock" } })
  expect(config.permission).toMatchObject({ "hub_*": "allow", "notes_*": "allow" })
  writeFileSync(mcp, JSON.stringify({ mcpServers: { hub: { command: "node" } } }))
  expect(() => makeOpenCodeLaunch({ ...f.input(), hubMcp }, f.bin)).toThrow("invalid-mcp-configuration")
  writeFileSync(mcp, JSON.stringify({ mcpServers: { odd: { transport: "pipe" } } }))
  expect(() => makeOpenCodeLaunch(f.input(), f.bin)).toThrow("invalid-mcp-configuration")
})

test("everything the hub cannot honour is refused by name before anything starts", () => {
  const f = fixture()
  const refused = (change: (input: any) => void) => {
    const input = f.input()
    change(input)
    try { makeOpenCodeLaunch(input, f.bin) } catch (error) { return (error as Error).message }
    return "launched"
  }
  // A permission rule in the person's settings has no deterministic translation, so it is refused and not approximated.
  const settings = join(f.dir, "settings.json")
  writeFileSync(settings, JSON.stringify({ permissions: { allow: ["Bash(git:*)"] } }))
  expect(refused(input => { input.agent = { ...input.agent, settings } })).toBe("opencode-permissions-unsupported")
  writeFileSync(settings, JSON.stringify({ permissions: { allow: [], deny: [] } }))
  expect(refused(input => { input.agent = { ...input.agent, settings } })).toBe("launched")
  expect(refused(input => { input.agent = { ...input.agent, tools: ["Read", "Agent"] } })).toBe("native-delegation-configured")
  expect(refused(input => { input.agent = { ...input.agent, tools: ["NotebookEdit"] } })).toContain("tool-profile-unvalidated: NotebookEdit")
  expect(refused(input => { input.preset = { ...PRESET, adapter: "claude-code" } })).toBe("loop-configuration-unsupported")
  expect(refused(input => { input.preset = { ...PRESET, provider: "a/b" } })).toBe("opencode-provider-invalid")
  expect(refused(input => { input.preset = { ...PRESET, model: "two words" } })).toBe("opencode-model-invalid")
  expect(refused(input => { input.purpose = "anything" })).toBe("invalid-configuration")
  expect(refused(input => { input.box = undefined })).toBe("box-required")
  expect(refused(input => { input.box = { ...input.box, tree: join(f.dir, "missing") } })).toContain("ENOENT")
})

test("only a model key is a key: another kind, a relative path, a blank or missing file is refused, and never says the key", () => {
  const f = fixture()
  const message = (credential: unknown) => { try { readModelKey(credential as never) } catch (error) { return (error as Error).message } return "read" }
  expect(readModelKey(f.credential)).toBe(f.key)
  for (const kind of ["claude-login", "api-key", "telegram", "discord"]) expect(message({ ...f.credential, kind })).toBe("credential-source-unsupported")
  expect(message({ ...f.credential, file: "provider.token" })).toBe("credential-source-unsupported")
  writeFileSync(f.keyFile, " \n")
  expect(message(f.credential)).toBe("credential-source-unreadable")
  rmSync(f.keyFile)
  expect(message(f.credential)).not.toContain(f.key)
  expect(message(f.credential)).toContain("ENOENT")
})

test("a Claude launch is not given a model key, and the Claude launch is not the one that made this", async () => {
  const f = fixture()
  const claude = { ...f.input(), preset: { adapter: "claude-code", model: "m", provider: "anthropic", effort: "medium", paid: "plan" } }
  // The Claude adapter's own source check refuses anything but its login file.
  await expect(makeLoopLaunch(claude)).rejects.toThrow("credential-source-unsupported")
  await expect(makeLoopLaunch(f.input())).rejects.toThrow("loop-configuration-unsupported")
})

test("the adapter is registered beside Claude's, has no native session port, and an ordinary launch needs a build whose restrictions were read back", async () => {
  expect(Object.keys(ADAPTERS).sort()).toEqual(["claude-code", "codex", "opencode"])
  expect(adapterFor(ADAPTERS, "opencode")).toBe(openCode)
  expect(openCode.session).toBeUndefined()
  expect(ADAPTERS["claude-code"].session).toBeDefined()
  const f = fixture()
  const probe = { bin: f.bin }
  expect(probeOpenCodeVersion(f.bin)).toBe("9.9.9")
  // A build nobody measured (the stand-in's 9.9.9): an ordinary launch is refused by name and version, a restricted one is not.
  await expect(loopLaunch(f.input(), probe)).rejects.toThrow("native-tool-control-unvalidated: opencode 9.9.9")
  expect(await loopLaunch(fixture("harvest").input(), { bin: f.bin })).toMatchObject({ credentialId: "provider-key" })
  // Once a build is named as read back, the same launch is made.
  const measured = createOpenCode({ validated: { ...VALIDATED, delegationControl: ["9.9.9"] } })
  const made = await measured.prepareLaunch!(f.input(), probe) as any
  expect(made.env[OPENCODE_KEY_ENV]).toBe(f.key)
  // Only what root's evidence on the pinned 1.18.34 shows is listed: the session store and the configuration read back.
  // Safe resume of an interrupted turn is not, because nothing has interrupted a turn with an unfinished tool call.
  expect(VALIDATED).toEqual({ sessionStore: ["1.18.34"], delegationControl: ["1.18.34"], safeResume: [] })
})

test("capabilities are false for a build nobody measured and true only for what was", async () => {
  const f = fixture()
  const registryFile = writeRegistry(f.dir, {
    hub: { state_dir: join(f.dir, "state") },
    people: [{ id: "p1", tree: f.tree }],
    credentials: [{ id: "provider-key", kind: "model-key", file: f.keyFile, owner: "p1" }],
    presets: { "opencode-daily": { ...PRESET, credential: "provider-key" } },
    agents: [{ id: "p1-lair", person: "p1", preset: "opencode-daily", chat: "1000000001", door: "door-d", runner: "runner-pi" }],
  })
  const registry = loadRegistry(registryFile)
  const context = { registry, agent: { id: "p1-lair", preset: "opencode-daily" }, preset: "opencode-daily", probe: { bin: f.bin } }
  expect(await createOpenCode().capabilities!(context)).toEqual({ stableSession: false, delegationDisabled: false, safeResume: false, version: "9.9.9" })
  const some = createOpenCode({ validated: { sessionStore: ["9.9.9"], delegationControl: ["9.9.9"], safeResume: [] } })
  expect(await some.capabilities!(context)).toEqual({ stableSession: true, delegationDisabled: true, safeResume: false, version: "9.9.9" })
  const all = createOpenCode({ validated: { sessionStore: ["9.9.9"], delegationControl: ["9.9.9"], safeResume: ["9.9.9"] } })
  expect((await all.capabilities!(context)).safeResume).toBe(true)
  // Resume cannot be safe on a build whose session store was not shown to persist.
  const orphan = createOpenCode({ validated: { sessionStore: [], delegationControl: [], safeResume: ["9.9.9"] } })
  expect((await orphan.capabilities!(context)).safeResume).toBe(false)
  // A key that is gone is "nothing shown".
  rmSync(f.keyFile)
  await expect(openCode.capabilities!(context)).rejects.toThrow()
  // And the source check says so, and says it for the OpenCode preset only.
  await expect(checkLoopSource(registry, "opencode-daily", { bin: f.bin })).rejects.toThrow()
})

test("the pinned 1.18.34 is the build that was measured: its session store and read-back configuration count, safe resume still does not, and no other build is listed", async () => {
  const f = fixture()
  mkdirSync(join(f.dir, "bin", "pinned"))
  const pinned = join(f.dir, "bin", "pinned", "opencode")
  writeFileSync(pinned, '#!/bin/sh\necho "1.18.34"\n', { mode: 0o755 })
  expect(probeOpenCodeVersion(pinned)).toBe("1.18.34")
  const registry = loadRegistry(writeRegistry(f.dir, {
    hub: { state_dir: join(f.dir, "state") },
    people: [{ id: "p1", tree: f.tree }],
    credentials: [{ id: "provider-key", kind: "model-key", file: f.keyFile, owner: "p1" }],
    presets: { "opencode-daily": { ...PRESET, credential: "provider-key" } },
    agents: [{ id: "p1-lair", person: "p1", preset: "opencode-daily", chat: "1000000001", door: "door-d", runner: "runner-pi" }],
  }))
  const context = { registry, agent: { id: "p1-lair", preset: "opencode-daily" }, preset: "opencode-daily", probe: { bin: pinned } }
  // `delegationDisabled` here is the configuration as the running server reports it, which `start` re-reads every launch.
  expect(await createOpenCode().capabilities!(context)).toEqual({ stableSession: true, delegationDisabled: true, safeResume: false, version: "1.18.34" })
  // An ordinary launch is made on the pinned build, and is still refused on a build that was never measured.
  const made = await createOpenCode().prepareLaunch!(f.input(), { bin: pinned }) as any
  expect(made.argv[0]).toBe(pinned)
  await expect(createOpenCode().prepareLaunch!(f.input(), { bin: f.bin })).rejects.toThrow("native-tool-control-unvalidated: opencode 9.9.9")
  for (const list of Object.values(VALIDATED)) expect(list.every((version: string) => version === "1.18.34")).toBe(true)
  expect(VALIDATED.safeResume).toEqual([])
})

test("the production source check validates the selected credential and binary", async () => {
  const f = fixture()
  const registry = loadRegistry(writeRegistry(f.dir, {
    hub: { state_dir: join(f.dir, "state") },
    people: [{ id: "p1", tree: f.tree }],
    credentials: [{ id: "provider-key", kind: "model-key", file: f.keyFile, owner: "p1" }],
    presets: { "opencode-daily": { ...PRESET, credential: "provider-key" } },
  }))
  await checkLoopSource(registry, "opencode-daily", { bin: f.bin })
  await expect(checkLoopSource(registry, "opencode-daily", { bin: join(f.dir, "no-such-binary") })).rejects.toThrow("opencode-binary-missing")
  writeFileSync(join(f.dir, "bin", "broken"), "#!/bin/sh\nexit 3\n", { mode: 0o755 })
  await expect(checkLoopSource(registry, "opencode-daily", { bin: join(f.dir, "bin", "broken") })).rejects.toThrow("opencode-binary-unusable")
})


test("production routing prepares a pinned build without weakening other credential masks", async () => {
  const f = fixture()
  writeFileSync(f.bin, '#!/bin/sh\necho "opencode 1.18.34"\n', { mode: 0o755 })
  const other = join(f.dir, "other-secrets", "other.token")
  mkdirSync(join(f.dir, "other-secrets"))
  writeFileSync(other, "unrelated-synthetic-secret")
  const input = f.input()
  input.box.secretPaths = [other]
  const launch = await loopLaunch(input, { bin: f.bin }) as any
  expect(openCode.activationBlock).toBeUndefined()
  expect(launch.env[OPENCODE_KEY_ENV]).toBe(f.key)
  const direct = makeOpenCodeLaunch(input, f.bin)
  expect(launch.wrap(["/bin/true"])).toEqual(direct.wrap(["/bin/true"]))
  expect(written(launch.cwd)).not.toContain("unrelated-synthetic-secret")
})
