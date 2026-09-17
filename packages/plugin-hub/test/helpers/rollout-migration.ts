// Synthetic source shapes and observations only. No conversion or handoff policy.
import { strict as assert } from "node:assert"
import { mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from "node:fs"
import { dirname, isAbsolute, join } from "node:path"
import { loopFixture, digest } from "./rollout-loop.ts"
import { chatLogFile } from "./hub-fixture.ts"

export { digest }
export function privateJson(file: string, value: unknown) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 })
  return file
}
export function readPrivateManifest(file: string): any {
  assert(isAbsolute(file), "manifest path must be absolute")
  assert.equal(statSync(file).mode & 0o777, 0o600)
  const value = JSON.parse(readFileSync(file, "utf8"))
  assert.equal(value.version, 1)
  return value
}
export function inventory(paths: string[]) {
  return paths.slice().sort().map(path => ({ path, sha256: digest(readFileSync(path, "utf8")) }))
}
export function jsonlBytes(state: string, person: string, agent: string) {
  const dir = join(state, person, "chatlog", agent)
  try { return Object.fromEntries(readdirSync(dir).filter(n => n.endsWith(".jsonl")).sort().map(n => [n, readFileSync(join(dir, n), "utf8")])) }
  catch (error: any) { if (error.code === "ENOENT") return {}; throw error }
}
export function plantCanonical(state: string, person: string, agent: string, rows: any[]) {
  const files = new Map<string, string[]>()
  for (const row of rows) {
    const file = chatLogFile({ stateDir: state, person, agent, at: new Date(row.at) })
    files.set(file, [...(files.get(file) ?? []), JSON.stringify(row)])
  }
  for (const [file, lines] of files) {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, lines.join("\n") + "\n")
  }
  return [...files.keys()]
}
export function migrationFixture() {
  const f = loopFixture()
  const source = join(f.dir, "selected-source")
  const snapshot = join(f.dir, "reference-snapshot")
  const output = join(f.dir, "private-output")
  for (const dir of [source, snapshot, output]) mkdirSync(dir, { mode: 0o700 })
  const sources = ["p1", "p2"].map(person => {
    const root = join(source, person)
    mkdirSync(root)
    const rendered = join(root, "rendered.md")
    const fragment = join(root, "source.md")
    writeFileSync(rendered, `${person} synthetic rendered instructions.\nUnicode: λ.\n`)
    writeFileSync(fragment, "@./relative.md\n")
    writeFileSync(join(root, "relative.md"), "Synthetic imported instructions.\n")
    writeFileSync(join(snapshot, `${person}.md`), "Wrong snapshot sentinel.\n")
    const tools = person === "p1" ? ["Read", "Write", "Glob", "Grep"] : ["Read"]
    const allow = ["Read(./synthetic/**)"]
    const deny = ["Read(./excluded/**)"]
    const mcp = person === "p1" ? { synthetic: { command: process.execPath, args: ["-e", "process.exit(0)"] } } : undefined
    const settings = privateJson(join(root, "permissions.json"), { permissions: { allow, deny } })
    const agents = { person, vault: f.trees.person(person).tree, vault_origin: "synthetic-local-repository", locale: person === "p1" ? "en" : "ru", trust: "synthetic", credential: "loop-login", door: { platform: person === "p1" ? "discord" : "telegram" }, ...(mcp ? { mcp } : {}), rooms: [], agents: [{ name: `${person}-lair`, model: "synthetic-alias", effort: "medium", mode: person === "p1" ? "resident" : "on-demand", tools, allow, deny, fragment: rendered, door: { platform: person === "p1" ? "discord" : "telegram", chat: person === "p1" ? "synthetic-channel" : "1000000001" } }] }
    const file = privateJson(join(root, "agents.json"), agents)
    return { person, root, file, rendered, fragment, settings, agents, tools, allow, deny, mcp }
  })
  const token = join(f.dir, "door-token")
  writeFileSync(token, "synthetic-token", { mode: 0o600 })
  const lookups: any[] = []
  let channels = [{ id: "0000000000", name: "synthetic-channel" }]
  const lookup = async (request: any) => { lookups.push(structuredClone(request)); return structuredClone(channels) }
  const registryManifest: any = {
    version: 1, batch_id: "synthetic-cutover", source_registries: sources.map(s => s.file), fragment_roots: sources.map(s => s.root),
    expected_agents: ["p1-lair", "p2-lair"], active_registry: f.file,
    candidate: join(output, "candidate.toml"), inventory: join(output, "inventory.json"), runtime_dir: output,
    hub: { ...(f.registry().data.hub as Record<string, unknown>), cutover_batch: "synthetic-cutover" },
    machines: [{ id: "pi", os: process.platform === "darwin" ? "macos" : "linux", host: "127.0.0.1" }],
    credentials: [f.credential, { id: "door-discord", kind: "discord", file: token, owner: "p1" }, { id: "door-telegram", kind: "telegram", file: token, owner: "p2" }],
    people: sources.map(s => ({ id: s.person, tree: f.trees.person(s.person).tree, vault: f.trees.person(s.person).tree, harvester: "harvest", allowed_senders: { [s.person === "p1" ? "door-discord" : "door-telegram"]: [s.person] }, harvest_report: s.person === "p1" })),
    presets: { daily: { ...f.preset, adapter: "claude-code", credential: "loop-login" }, harvest: { ...f.preset, adapter: "claude-code", credential: "loop-login" } },
    bindings: sources.map(s => ({ agent: `${s.person}-lair`, runner: "runner-pi", door: s.person === "p1" ? "door-discord" : "door-telegram", token_file: token, guild: "synthetic-guild", chat: s.person === "p1" ? "synthetic-channel" : "1000000001" })),
    repositories: sources.map(s => ({ id: `${s.person}-vault`, person: s.person, path: f.trees.person(s.person).tree, remote: "origin", branch: "main", required: true })),
    resource_budget: { max_active_children: 4, child_memory_budget_mb: 2048 },
  }
  const roots = sources.map(s => {
    const root = join(s.root, "chatlog", `${s.person}-lair`)
    mkdirSync(root, { recursive: true })
    return { root, person: s.person, agent: `${s.person}-lair`, senders: { [s.person]: s.person, assistant: `${s.person}-lair`, [`${s.person}-lair`]: `${s.person}-lair` } }
  })
  const old = join(roots[0].root, "2026-07-01.md")
  writeFileSync(old, "# Synthetic chat\nDate: 2026-07-01\n\n12:00:00  p1: Unicode λ⏎second line\n12:01:00  assistant: (voice) synthetic transcript\n")
  const tab = join(roots[1].root, "2026-07-02.log")
  const tabRows = [
    ["2026-07-02T12:00:00.000Z", "p2", "telegram:1000000001:1", "equal text"],
    ["2026-07-02T12:00:00.000Z", "p2", "telegram:1000000001:2", "equal text"],
    ["2026-07-02T12:01:00.000Z", "p2-lair", "synthetic-turn/1 -> 3", "λ\n(voice) synthetic transcript"],
  ]
  writeFileSync(tab, tabRows.map(([at, from, id, text]) => [at, from, id, JSON.stringify(text)].join("\t")).join("\n") + "\n")
  const empty = join(source, "empty-logs")
  mkdirSync(empty)
  const logManifest: any = { version: 1, batch_id: "synthetic-cutover", sources: [...roots, { root: empty, person: "p1", agent: "p1-empty", senders: { p1: "p1", assistant: "p1-empty" } }], timezone: "UTC", state_dir: f.stateDir, inventory: inventory([old, tab]), reconciliation: [] }
  const freeze = "2026-07-03T12:00:00.000Z"
  const items: any[] = [
    { source_id: "1", state: "completed", text: "completed synthetic instruction" },
    { source_id: "2", state: "pending-input", text: "pending synthetic two", media: [] },
    { source_id: "3", state: "pending-input", text: "pending synthetic three", media: [] },
    { source_id: "4", state: "reply-owed", text: "answered already", parts: [{ seq: 1, text: "fully owed", receipt: null }] },
    { source_id: "5", state: "reply-owed", text: "partly answered already", parts: [{ seq: 1, text: "already delivered", receipt: { id: "synthetic-receipt", outcome: "delivered", at: freeze } }, { seq: 2, text: "remaining owed", receipt: null }] },
  ].map(item => ({ ...item, person: "p1", agent: "p1-lair", door: "door-fake", chat: "0000000000", at: freeze, kind: "human" }))
  // This is a reviewed source inventory, not an invented queue export reader.
  const frozen = privateJson(join(source, "reviewed-work.json"), { agents: ["p1-lair", "p2-lair"], items })
  const handoffManifest: any = { version: 1, batch_id: "synthetic-cutover", freeze_at: freeze, sources: inventory([frozen]), agents: ["p1-lair", "p2-lair"], source_inventory: items.map(i => ({ source_id: i.source_id, state: i.state })), cursors: [{ door: "door-fake", chat: "0000000000", cursor: "5" }], items }
  return { ...f, source, snapshot, output, sources, token, lookup, lookups, setChannels(value: typeof channels) { channels = value }, registryManifest, logManifest, roots, old, tab, frozen, handoffManifest }
}
export const historicalRows = [
  { at: "2026-07-01T12:00:00.000Z", text: "earliest-history-codeword" },
  { at: "2026-07-03T12:00:00.000Z", text: "middle-history-codeword" },
  { at: "2026-08-15T12:00:00.000Z", text: "final-history-one" },
  { at: "2026-08-15T12:00:00.000Z", text: "final-history-two" },
  { at: "2026-08-15T12:00:00.000Z", text: "final-history-three" },
].map((row, n) => ({ ...row, id: `synthetic-history-${n}`, direction: "in", from: "p2" }))
export const from = historicalRows[0].at
export const until = historicalRows.at(-1)!.at
export function note(title = "Synthetic history", body = "Synthetic history was retained.", valid = true) {
  return `---\n${valid ? "type: note\n" : ""}domain: life\nkind: reference\nsummary: ${body}\ntags: [synthetic]\n---\n\n# ${title}\n\n${body}\n`
}
export function envelope(text: string) { return `=== NOTE ===\n${text}\n=== END ===` }

import { stageHarvest } from "./harvest-stage.ts"
import type { Cluster } from "./cluster.ts"
// Stage the existing real ingest harness for the second person. No model work.
export async function migrationHarvestStage(cluster: Cluster) {
  return stageHarvest(cluster, {
    harvestPeople: [{ id: "p2", language: "en", harvest_report: false }],
    registry: base => ({ ...base, agents: [{ id: "p2-lair", person: "p2", preset: "daily", runner: "runner-pi", door: "door-fake", chat: "1000000001" }], run: [{ id: "runner-pi", kind: "runner", schedule: "always", memory_limit_mb: 512, child_memory_limit_mb: 512 }] }),
  })
}

export function plantTabHistory(root: string, rows: { at: string, id: string, text: string }[], sender = "p2") {
  const days = new Map<string, string[]>()
  for (const row of rows) {
    const file = join(root, row.at.slice(0, 10) + ".log")
    days.set(file, [...(days.get(file) ?? []), `${row.at}\t${sender}\t${row.id}\t${JSON.stringify(row.text)}`])
  }
  for (const [file, lines] of days) writeFileSync(file, lines.join("\n") + "\n")
  return [...days.keys()]
}
