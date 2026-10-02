// What the registry, `check` and the topic preview say about an OpenCode preset and its model
// key: the credential kind, how it is opened and scanned, how a preset on it is shown and bound.
//
// Offline and synthetic: every key is a random placeholder and nothing dials a provider.

import { afterAll, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { realProber } from "../src/check/credentials.ts"
import { topicPreview } from "../src/door/topic-lines.ts"
import { bindingVerdict } from "../src/hub/topics.ts"
import { listCredentials } from "../src/registry/entries.ts"
import { RegistryRefused, loadRegistry, modelBaseUrlRefusal, type CredentialEntry } from "../src/registry/load.ts"
import { presetId } from "../src/registry/presets.ts"
import { engineLabel, resolveTopicSetup } from "../src/registry/topics.ts"
import { writeRegistry } from "./helpers/authorized-registry.ts"

const dirs: string[] = []
afterAll(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

const BASE = "https://provider.example.invalid/v1"

function registryWith(credential: Record<string, string | undefined>) {
  const dir = mkdtempSync(join(tmpdir(), "hub-opencode-registry-"))
  dirs.push(dir)
  const file = writeRegistry(dir, {
    hub: { state_dir: dir },
    people: [{ id: "p1", tree: join(dir, "p1") }],
    credentials: [{ id: "provider-key", kind: "model-key", file: "/var/lib/imprnt-hub/secrets/provider.token", owner: "p1", ...credential }],
    presets: { keyed: { adapter: "opencode", model: "synthetic-model", provider: "synthetic-provider", effort: "default", paid: "key", credential: "provider-key" } },
  })
  return () => loadRegistry(file)
}
function refusal(credential: Record<string, string | undefined>): RegistryRefused {
  try { registryWith(credential)() } catch (error) { return error as RegistryRefused }
  throw new Error("the registry loaded, and this check is about a refusal")
}

test("a model key loads with no base_url, or with an https one, and the entry carries only what the file said", () => {
  expect(listCredentials(registryWith({})())).toEqual([{ id: "provider-key", kind: "model-key", file: "/var/lib/imprnt-hub/secrets/provider.token", owner: "p1" }])
  expect(listCredentials(registryWith({ base_url: BASE })())).toEqual([{ id: "provider-key", kind: "model-key", file: "/var/lib/imprnt-hub/secrets/provider.token", owner: "p1", base_url: BASE }])
})

test("a base_url that is not a plain https origin is refused on its own line, and so is one on any other kind", () => {
  for (const [base_url, said] of [
    ["", "names no base_url"],
    ["not a url", "not a URL"],
    ["http://provider.example.invalid/v1", "not https"],
    ["https://user:pass@provider.example.invalid/v1", "login in it"],
    ["https://provider.example.invalid/v1?token=x", "query or a fragment"],
    ["https://provider.example.invalid/v1#frag", "query or a fragment"],
  ] as const) {
    const refused = refusal({ base_url })
    expect(refused.key, base_url).toBe("credentials[0].base_url")
    expect(refused.message, base_url).toContain(said)
    expect(modelBaseUrlRefusal(base_url)).toContain(said)
  }
  expect(modelBaseUrlRefusal(BASE)).toBeNull()
  // A URL on a kind that never sends one would look as if it did something.
  for (const kind of ["api-key", "claude-login", "telegram"]) {
    const stray = refusal({ kind, base_url: BASE })
    expect(stray.key).toBe("credentials[0].base_url")
    expect(stray.message).toContain("only a model-key does")
  }
})

test("a preset on a provider is a different preset from the same model on another, and the engine is named", () => {
  const preset = { adapter: "opencode", model: "m", effort: "default", paid: "key" }
  expect(presetId({ ...preset, provider: "a" })).not.toBe(presetId({ ...preset, provider: "b" }))
  expect(presetId({ ...preset, provider: "a" })).not.toBe(presetId({ ...preset, adapter: "claude-code", provider: "a" }))
  expect(engineLabel("opencode")).toBe("OpenCode")
  expect(engineLabel("claude-code")).toBe("Claude Code")
})

test("check opens a model key without dialling anyone, reports a blank or missing file, and the leak scan knows its token", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hub-opencode-check-"))
  dirs.push(dir)
  const file = join(dir, "provider.token"), key = "synthetic-model-key-" + crypto.randomUUID()
  const entry: CredentialEntry = { id: "provider-key", kind: "model-key", file, owner: "household" }
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

test("a topic preview names the provider for a preset on a model key and for no other, and only an explicit preset selects it", () => {
  const asked = { chat_name: "chat", machine: "pi", adapter: "opencode", model: "synthetic-model", initial_request: "hello" }
  expect(topicPreview("en", { ...asked, adapter: "claude-code" })).toContain("Agent: Claude Code (synthetic-model)\n")
  expect(topicPreview("en", asked)).toContain("Agent: OpenCode (synthetic-model)\n")
  expect(topicPreview("en", { ...asked, provider: "synthetic-provider" })).toContain("Agent: OpenCode (synthetic-model, synthetic-provider)\n")

  const dir = mkdtempSync(join(tmpdir(), "hub-opencode-topic-"))
  dirs.push(dir)
  const it = loadRegistry(writeRegistry(dir, {
    hub: { state_dir: dir },
    machines: [{ id: "pi", os: "linux" }],
    people: [{ id: "p1", allowed_senders: { "door-d": ["100000000000000001"] } }],
    credentials: [
      { id: "provider-key", kind: "model-key", file: "/var/lib/imprnt-hub/secrets/provider.token", owner: "p1" },
      { id: "household-claude", kind: "claude-login", file: "/var/lib/imprnt-hub/credentials/.credentials.json", owner: "p1" },
    ],
    presets: {
      keyed: { adapter: "opencode", model: "synthetic-model", provider: "synthetic-provider", effort: "default", paid: "key", credential: "provider-key" },
      login: { adapter: "claude-code", model: "synthetic-model", provider: "anthropic", effort: "medium", paid: "plan", credential: "household-claude" },
    },
    agents: [{ id: "p1-lair", person: "p1", preset: "login", chat: "1000000001", door: "door-d", runner: "runner-pi" }],
    run: [
      { id: "door-d", kind: "door", machine: "pi", platform: "discord", person: "p1", token_file: "/dev/null", schedule: "always", memory_limit_mb: 192, guild: "800000000000000001", topic_machine: "pi", topic_preset: "login" },
      { id: "runner-pi", kind: "runner", machine: "pi", schedule: "always", memory_limit_mb: 512, child_memory_limit_mb: 2048 },
    ],
  }))
  const ask = (name?: string) => resolveTopicSetup(it, { person: "p1", door: "door-d", chat_name: "chat", ...(name ? { preset: name } : {}) })
  // The door's default is untouched and says nothing of a provider: nothing moves to the new engine by itself.
  expect(ask()).toMatchObject({ ok: true, preset: "login", preset_from: "door", adapter: "claude-code" })
  expect(ask()).not.toHaveProperty("provider")
  expect(ask("keyed")).toMatchObject({ ok: true, preset: "keyed", preset_from: "request", adapter: "opencode", provider: "synthetic-provider" })
})

test("an approved setup is approved for its provider: the same model behind another is a changed setup", () => {
  const topic = (setup: Record<string, unknown>) => ({ person: "p1", door: "door-d", agent_id: "a", machine: "pi", runner: "r", preset: "keyed", chat: "1", setup: { person: "p1", door: "door-d", agent_id: "a", machine: "pi", runner: "r", preset: "keyed", ...setup } }) as never
  const registry = (provider: string) => ({ presets: { keyed: { adapter: "opencode", model: "m", provider, effort: "default", paid: "key" } } }) as never
  const verdict = bindingVerdict(registry("another-provider"), topic({ adapter: "opencode", model: "m", provider: "synthetic-provider" }))
  expect(verdict).toMatchObject({ verdict: "refused", code: "preset_changed" })
  expect((verdict as { cause: string }).cause).toContain("another-provider")
  expect((verdict as { cause: string }).cause).toContain("synthetic-provider")
  // The model changing is still refused as it always was, and a setup approved with no provider (every Claude one) is not asked one.
  expect(bindingVerdict(registry("p"), topic({ adapter: "opencode", model: "other", provider: "p" }))).toMatchObject({ verdict: "refused", code: "preset_changed" })
  // A setup approved with no provider is past the gate: it goes on to read the rest of the registry, which this stub is not.
  expect(() => bindingVerdict(registry("anything"), topic({ adapter: "opencode", model: "m" }))).toThrow(TypeError)
})
