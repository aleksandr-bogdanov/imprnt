// A preset on a model key: the Claude Code engine run against a provider's own
// Anthropic-format endpoint, on a key file and an https base URL instead of a
// Claude login (docs/operations.md, "A model-key preset").
//
// Pure and offline: the CLI is a scripted file or a stand-in for one, every key
// is a random placeholder, every host is `example.invalid`, and nothing here dials
// a provider or spends a token.
//
// What is held up:
//   1. the registry takes a `model-key` only with an https `base_url`, and takes
//      a `base_url` on no other kind, so a key is never sent in the clear and a
//      stray URL is never ignored;
//   2. the launch hands the child the key and the endpoint as environment, and
//      nothing of the key reaches an argv or a file the hub writes; the session's
//      own directories stand in for the login and the keychain;
//   3. a Claude-login launch is untouched, and neither kind inherits an ambient
//      `ANTHROPIC_*` from the parent;
//   4. a key that is missing, blank, in the clear or of the wrong kind refuses the
//      launch by name and starts nothing, with no key in the message;
//   5. the real box keeps the key file out of the agent's reach even when the box
//      context does not list it;
//   6. `check` opens a key without dialling, and the leak scan knows its token;
//   7. a topic preview names the provider for a model-key preset and for no other.

import { afterAll, beforeAll, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { loopLaunch } from "../src/adapters/index.ts"
import { loopCapabilitiesFor } from "../src/adapters/launch.ts"
import { realProber } from "../src/check/credentials.ts"
import { topicPreview } from "../src/door/topic-lines.ts"
import { RegistryRefused, loadRegistry, modelBaseUrlRefusal, type CredentialEntry } from "../src/registry/load.ts"
import { listCredentials } from "../src/registry/entries.ts"
import { presetId } from "../src/registry/presets.ts"
import { resolveTopicSetup } from "../src/registry/topics.ts"
import { boxGate } from "./helpers/box-gate.ts"
import { writeRegistry } from "./helpers/authorized-registry.ts"
import { fileProbe, launchInput, launchSeam, loopFixture, scriptedClaude, type LoopFixture } from "./helpers/rollout-loop.ts"
beforeAll(async () => { await import("../live/prove-rollout-loop.ts") })

const BASE = "https://provider.example.invalid/anthropic"
const dirs: string[] = []
afterAll(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

// --- 1. the registry ---------------------------------------------------------

function registryWith(credential: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "hub-model-key-"))
  dirs.push(dir)
  const file = writeRegistry(dir, {
    hub: { state_dir: dir },
    people: [{ id: "p1", tree: join(dir, "p1") }],
    credentials: [{ id: "provider-key", kind: "model-key", file: "/var/lib/imprnt-hub/secrets/provider.token", owner: "p1", base_url: BASE, ...credential }],
    presets: { keyed: { adapter: "synthetic", model: "synthetic-model", provider: "synthetic-provider", effort: "medium", paid: "key", credential: "provider-key" } },
  })
  return () => loadRegistry(file)
}
function refusal(credential: Record<string, string | undefined>): RegistryRefused {
  try { registryWith(credential as Record<string, string>)() } catch (error) { return error as RegistryRefused }
  throw new Error("the registry loaded, and this check is about a refusal")
}

test("a model-key credential loads with its base_url, and the entry carries it", () => {
  const it = registryWith({})()
  expect(listCredentials(it)).toEqual([{ id: "provider-key", kind: "model-key", file: "/var/lib/imprnt-hub/secrets/provider.token", owner: "p1", base_url: BASE }])
})

test("a model-key without an https origin is refused on its base_url line, and a base_url on any other kind is refused too", () => {
  for (const [base_url, said] of [
    [undefined, "names no base_url"],
    ["", "names no base_url"],
    ["not a url", "not a URL"],
    ["http://provider.example.invalid/anthropic", "not https"],
    ["https://user:pass@provider.example.invalid/anthropic", "login in it"],
    ["https://provider.example.invalid/anthropic?token=x", "query or a fragment"],
    ["https://provider.example.invalid/anthropic#frag", "query or a fragment"],
  ] as const) {
    const refused = refusal({ base_url })
    expect(refused.key, String(base_url)).toBe("credentials[0].base_url")
    expect(refused.message, String(base_url)).toContain(said)
    expect(modelBaseUrlRefusal(base_url)).toContain(said)
  }
  expect(modelBaseUrlRefusal(BASE)).toBeNull()
  // A URL on a kind that never sends one would look as if it did something.
  const stray = refusal({ kind: "api-key" })
  expect(stray.key).toBe("credentials[0].base_url")
  expect(stray.message).toContain("only a model-key does")
})

// --- 2 to 4. the launch --------------------------------------------------------

function keyed(f: LoopFixture, text = "synthetic-model-key-" + crypto.randomUUID()) {
  const file = join(f.dir, "secrets", "provider.token")
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  writeFileSync(file, text + "\n", { mode: 0o600 })
  const credential: CredentialEntry = { id: "provider-key", kind: "model-key", file, owner: "p1", base_url: BASE }
  return { file, key: text, credential }
}

/** Every byte the launch wrote into the session directory, which is where a leaked key would land. */
function written(dir: string): string {
  const out: string[] = []
  const walk = (at: string) => {
    for (const name of readdirSync(at, { withFileTypes: true })) {
      if (name.isDirectory()) walk(join(at, name.name))
      else out.push(readFileSync(join(at, name.name), "utf8"))
    }
  }
  walk(dir)
  return out.join("\n")
}

const AMBIENT = { ANTHROPIC_BASE_URL: "https://ambient.example.invalid", ANTHROPIC_AUTH_TOKEN: "ambient-token-0000", ANTHROPIC_API_KEY: "ambient-key-0000", ANTHROPIC_DEFAULT_HAIKU_MODEL: "ambient-model" }

test("a model-key launch gives the child the endpoint and the key as environment and nothing of the key anywhere else", async () => {
  const f = loopFixture()
  try {
    const make = await launchSeam(), k = keyed(f), base = launchInput(f)
    const input = { ...base, credential: k.credential, ambientEnv: { ...base.ambientEnv, ...AMBIENT } }
    const launch = await make(input)
    expect(launch.credentialId).toBe("provider-key")
    expect(launch.env.ANTHROPIC_BASE_URL).toBe(BASE)
    expect(launch.env.ANTHROPIC_AUTH_TOKEN).toBe(k.key)
    // One model for every tier, so no helper call names a model the preset does not.
    const model = (input.preset as { model: string }).model
    expect(launch.argv[launch.argv.indexOf("--model") + 1]).toBe(model)
    for (const tier of ["OPUS", "SONNET", "HAIKU"]) expect(launch.env[`ANTHROPIC_DEFAULT_${tier}_MODEL`]).toBe(model)
    // Neither the parent's key nor its endpoint nor its helper model gets through.
    expect(launch.env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(Object.values(launch.env)).not.toContain(AMBIENT.ANTHROPIC_AUTH_TOKEN)
    // Isolated: the session's own config stands in for the login and for the keychain item.
    expect(launch.env.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBe(launch.env.CLAUDE_CONFIG_DIR)
    expect(launch.env.CLAUDE_CONFIG_DIR!.startsWith(launch.cwd)).toBe(true)
    expect(existsSync(join(launch.env.CLAUDE_CONFIG_DIR!, ".credentials.json"))).toBe(false)
    // No fallback flag, and no key in the argv or in a file the launch wrote.
    expect(launch.argv.some((arg: string) => /fallback|advisor/i.test(arg))).toBe(false)
    expect(launch.argv.join("\n")).not.toContain(k.key)
    expect(written(launch.cwd)).not.toContain(k.key)
  } finally { f.stop() }
})

test("a Claude-login launch is unchanged: no endpoint, no token, its own login directory, and nothing ambient inherited", async () => {
  const f = loopFixture()
  try {
    const make = await launchSeam(), base = launchInput(f)
    const launch = await make({ ...base, ambientEnv: { ...base.ambientEnv, ...AMBIENT } })
    expect(Object.keys(launch.env).filter(key => key.startsWith("ANTHROPIC_"))).toEqual([])
    expect(launch.env.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBe(dirname(f.login))
    expect(launch.env.CLAUDE_CONFIG_DIR).not.toBe(launch.env.CLAUDE_SECURESTORAGE_CONFIG_DIR)
  } finally { f.stop() }
})

test("a key that cannot be used refuses the launch by name, starts nothing and never says the key", async () => {
  const f = loopFixture()
  try {
    const make = await launchSeam(), k = keyed(f)
    const refused = async (credential: unknown) => (await make({ ...launchInput(f), credential }).then(() => null, (error: Error) => error))
    const message = (error: Error | null) => error === null ? "launched" : error.message
    expect(message(await refused({ ...k.credential, base_url: "http://provider.example.invalid" }))).toBe("credential-source-unsupported")
    expect(message(await refused({ ...k.credential, base_url: undefined }))).toBe("credential-source-unsupported")
    expect(message(await refused({ ...k.credential, file: "provider.token" }))).toBe("credential-source-unsupported")
    // A kind that is neither a login nor a model key is not a model source: a watch's key is never sent to a model host.
    expect(message(await refused({ ...k.credential, kind: "api-key" }))).toBe("credential-source-unsupported")
    writeFileSync(k.file, " \n")
    expect(message(await refused(k.credential))).toBe("credential-source-unreadable")
    rmSync(k.file)
    const gone = await refused(k.credential)
    expect(gone).toBeInstanceOf(Error)
    expect(gone!.message).not.toContain(k.key)
  } finally { f.stop() }
})

test("the full adapter path launches a model key on a measured build and probes the binary, never the key", async () => {
  const f = loopFixture(), cli = scriptedClaude("never", "2.1.285"), k = keyed(f)
  try {
    const got = await loopLaunch({ ...launchInput(f), credential: k.credential } as never, { bin: cli.bin, timeoutMs: 5000, writePaths: [dirname(cli.bin)] }) as { credentialId: string; env: Record<string, string> }
    expect(got.credentialId).toBe("provider-key")
    expect(got.env.ANTHROPIC_AUTH_TOKEN).toBe(k.key)
    // The same three login questions the probe always asks, about its own synthetic login.
    expect(cli.auth()).toBe(3)
    expect(cli.calls().join("\n")).not.toContain(k.key)
    // The capability read is cached by binary and credential id, and refuses a model key that went bad.
    expect((await loopCapabilitiesFor(k.credential, { bin: cli.bin, timeoutMs: 5000, writePaths: [dirname(cli.bin)] })).native).toContain("--disallowedTools")
    writeFileSync(k.file, "")
    expect(() => loopCapabilitiesFor(k.credential, { bin: cli.bin })).toThrow("credential-source-unreadable")
  } finally { cli.stop(); f.stop() }
}, 60_000)

// --- 5. the box ----------------------------------------------------------------

const gate = boxGate()
if (!gate.ok) console.log(`SKIP: no box on this machine (${gate.reason})`)
test.skipIf(!gate.ok)("the real box keeps a model key's file out of the agent's reach even when the box context does not list it", async () => {
  const f = loopFixture(), k = keyed(f)
  try {
    const make = await launchSeam(), input = launchInput(f)
    expect(input.box).not.toHaveProperty("secretPaths")
    const launch = await make({ ...input, credential: k.credential })
    // The control: the same probe, unboxed, reads the file, so a refusal below is the box's.
    expect(fileProbe([], k.file, "read").text.trim()).toBe(k.key)
    const boxed = (operation: "read" | "write") => {
      const done = Bun.spawnSync(launch.wrap(["/bin/sh", "-c", operation === "read" ? 'cat "$1"' : 'printf x >> "$1"', "sh", k.file]), { cwd: launch.cwd, stdout: "pipe", stderr: "pipe", timeout: 5000 })
      return { code: done.exitCode, text: done.stdout.toString() }
    }
    const read = boxed("read")
    expect(read.text).not.toContain(k.key)
    expect(boxed("write").code).not.toBe(0)
    expect(readFileSync(k.file, "utf8")).toBe(k.key + "\n")
  } finally { f.stop() }
}, 60_000)

// --- 6. check ------------------------------------------------------------------

test("check opens a model key without dialling anyone, reports a blank or missing file, and the leak scan knows its token", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hub-model-key-check-"))
  dirs.push(dir)
  const file = join(dir, "provider.token"), key = "synthetic-model-key-" + crypto.randomUUID()
  const entry: CredentialEntry = { id: "provider-key", kind: "model-key", file, owner: "household", base_url: BASE }
  const dialled: string[] = []
  const prober = realProber({ fetch: (async (input: unknown) => { dialled.push(String(input)); throw new Error("a check must not dial") }) as never })
  writeFileSync(file, key + "\n")
  expect(await prober.open(entry)).toEqual({ ok: true })
  expect(await prober.secrets(entry)).toEqual([key])
  writeFileSync(file, "\n")
  expect(await prober.open(entry)).toMatchObject({ ok: false, kind: "blank" })
  rmSync(file)
  expect(await prober.open(entry)).toMatchObject({ ok: false, kind: "unreadable" })
  expect(dialled).toEqual([])
})

// --- 7. labels and provenance --------------------------------------------------

test("a topic preview names the provider for a model-key preset only, and a preset id tells two providers of one model apart", () => {
  const asked = { chat_name: "chat", machine: "pi", adapter: "claude-code", model: "synthetic-model", initial_request: "hello" }
  expect(topicPreview("en", asked)).toContain("Agent: Claude Code (synthetic-model)\n")
  expect(topicPreview("en", { ...asked, provider: "synthetic-provider" })).toContain("Agent: Claude Code (synthetic-model, synthetic-provider)\n")

  const dir = mkdtempSync(join(tmpdir(), "hub-model-key-topic-"))
  dirs.push(dir)
  const preset = { adapter: "synthetic", model: "synthetic-model", effort: "medium", paid: "key" }
  const it = loadRegistry(writeRegistry(dir, {
    hub: { state_dir: dir },
    machines: [{ id: "pi", os: "linux" }],
    people: [{ id: "p1", allowed_senders: { "door-d": ["100000000000000001"] } }],
    credentials: [
      { id: "provider-key", kind: "model-key", file: "/var/lib/imprnt-hub/secrets/provider.token", owner: "p1", base_url: BASE },
      { id: "household-claude", kind: "claude-login", file: "/var/lib/imprnt-hub/credentials/.credentials.json", owner: "p1" },
    ],
    presets: {
      keyed: { ...preset, provider: "synthetic-provider", credential: "provider-key" },
      login: { ...preset, provider: "anthropic", credential: "household-claude" },
    },
    agents: [{ id: "p1-lair", person: "p1", preset: "login", chat: "1000000001", door: "door-d", runner: "runner-pi" }],
    run: [
      { id: "door-d", kind: "door", machine: "pi", platform: "discord", person: "p1", token_file: "/dev/null", schedule: "always", memory_limit_mb: 192, guild: "800000000000000001", topic_machine: "pi", topic_preset: "login" },
      { id: "runner-pi", kind: "runner", machine: "pi", schedule: "always", memory_limit_mb: 512, child_memory_limit_mb: 2048 },
    ],
  }))
  const ask = (name?: string) => resolveTopicSetup(it, { person: "p1", door: "door-d", chat_name: "chat", ...(name ? { preset: name } : {}) })
  // Only an explicit preset selects the key; the door's default is untouched and carries no provider.
  expect(ask()).toMatchObject({ ok: true, preset: "login", preset_from: "door" })
  expect(ask()).not.toHaveProperty("provider")
  expect(ask("keyed")).toMatchObject({ ok: true, preset: "keyed", preset_from: "request", provider: "synthetic-provider" })
  // The turn record's preset id hashes the provider, so one model on two providers never reads as one preset.
  expect(presetId(it.presets.keyed)).not.toBe(presetId(it.presets.login))
})
