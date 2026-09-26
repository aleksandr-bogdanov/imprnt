// A registry the loader reads and the editor cannot is put into the layout
// the editor works on, and nothing it said changes.
//
// The converter used to write every table as one inline array on one line.
// The loader accepts that, and every registry edit finds an entry by its own
// `[[table]]` header line, so on such a file adopt, retire and every board
// press were refused. The rewrite goes through the editor's own lock, load and
// structure diff, which is what makes the "says the same thing" half a proof
// rather than a hope.
//
// No Postgres: the whole of it is a file, a parse and a rename.
import { expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadRegistry } from "../src/registry/load.ts"
import { relayoutRegistry } from "../src/registry/relayout.ts"
import { setKey, appendEntry, removeEntry, RegistryEditRefused } from "../src/registry/edit.ts"
import { toml } from "../src/migrate/files.ts"
import { handWrittenRegistry } from "./helpers/registry-fixture.ts"

/** The shape the v2 converter produced: every table one line, every key quoted. */
function inlineRegistry(dir: string): string {
  const file = join(dir, "registry.toml")
  const stateDir = join(dir, "state")
  const lines = [
    `"hub" = { "tick_seconds" = 1, "state_dir" = ${JSON.stringify(stateDir)}, "store_url" = "postgres://127.0.0.1:1/unused" }`,
    `"machines" = [{ "id" = "pi", "os" = ${JSON.stringify(process.platform === "darwin" ? "macos" : "linux")} }]`,
    `"people" = [{ "id" = "p1", "tree" = ${JSON.stringify(join(stateDir, "p1"))}, "allowed_senders" = { "door-fake" = ["the-owner"] }, "language" = "en" }]`,
    `"presets" = { "daily" = { "adapter" = "a-scripted-adapter", "model" = "a-model-name", "provider" = "a-provider", "effort" = "medium", "paid" = "key" } }`,
    `"agents" = [{ "id" = "p1-lair", "person" = "p1", "preset" = "daily", "chat" = "1000000001", "door" = "door-fake", "runner" = "runner-pi" }, { "id" = "p1-batch", "person" = "p1", "preset" = "daily", "runner" = "runner-pi" }]`,
    `"run" = [{ "id" = "door-fake", "kind" = "door", "platform" = "fake", "person" = "p1", "machine" = "pi", "token_file" = "/dev/null", "schedule" = "always", "memory_limit_mb" = 192 }, { "id" = "runner-pi", "kind" = "runner", "machine" = "pi", "schedule" = "always", "memory_limit_mb" = 512, "child_memory_limit_mb" = 2048 }]`,
    `"repositories" = []`,
  ]
  writeFileSync(file, lines.join("\n") + "\n", { mode: 0o640 })
  return file
}

function scratch(): { dir: string; stop(): void } {
  const dir = mkdtempSync(join(tmpdir(), "registry-relayout-"))
  return { dir, stop: () => rmSync(dir, { recursive: true, force: true }) }
}

test("a one-line-per-table registry is refused by the editor, and after the relayout every edit works and the file says the same thing", async () => {
  const it = scratch()
  try {
    const file = inlineRegistry(it.dir)
    const before = loadRegistry(file).data
    // The defect: the loader reads it and the editor cannot find an entry in it.
    await expect(setKey(file, "agents[p1-lair]", "sleeping", true)).rejects.toBeInstanceOf(RegistryEditRefused)
    const mode = statSync(file).mode & 0o777

    expect((await relayoutRegistry(file)).changed).toBe(true)

    const text = readFileSync(file, "utf8")
    expect(text.match(/^\[\[agents\]\]$/gm), "one header per agent").toHaveLength(2)
    expect(text.match(/^\[\[run\]\]$/gm), "one header per run entry").toHaveLength(2)
    expect(text).toContain("\n[hub]\n")
    expect(text).toContain("\n[presets.daily]\n")
    expect(text, "an empty table stays a bare key, above every header").toMatch(/^repositories = \[\]$/m)
    expect(text.indexOf("repositories = []")).toBeLessThan(text.indexOf("[hub]"))
    expect(text, "a table nested in an entry is an inline table on that entry's line")
      .toContain('allowed_senders = { door-fake = ["the-owner"] }')
    expect(loadRegistry(file).data, "the structure is the one the file had").toEqual(before)
    expect(statSync(file).mode & 0o777, "the file keeps its own mode").toBe(mode)

    // A second relayout of a file already in the layout changes nothing.
    expect((await relayoutRegistry(file)).changed).toBe(false)
    expect(readFileSync(file, "utf8")).toBe(text)

    // Every primitive now finds its entry.
    expect((await setKey(file, "agents[p1-lair]", "sleeping", true)).changed).toBe(true)
    expect((await appendEntry(file, "agents", { id: "p1-new", person: "p1", preset: "daily", runner: "runner-pi" })).changed).toBe(true)
    expect((await removeEntry(file, "agents[p1-batch]")).changed).toBe(true)
    const after = loadRegistry(file)
    expect(after.agents.map(a => a.id)).toEqual(["p1-lair", "p1-new"])
    expect(after.agents[0].sleeping).toBe(true)
  } finally { it.stop() }
})

test("a registry a person wrote is refused whole, because a render from the parse would drop their notes", async () => {
  const it = scratch()
  try {
    const { file, bytes } = handWrittenRegistry(it.dir)
    await expect(relayoutRegistry(file)).rejects.toMatchObject({ step: "notes" })
    expect(readFileSync(file, "utf8"), "every byte is still theirs").toBe(bytes)
  } finally { it.stop() }
})

test("a note at the end of a line is a note too, and a hash inside a quoted value is not", async () => {
  const it = scratch()
  try {
    const file = inlineRegistry(it.dir)
    const before = readFileSync(file, "utf8")
    // The structure diff cannot see a note, so the refusal is the only thing
    // standing between an end-of-line note and its silent loss.
    writeFileSync(file, before.replace('"repositories" = []', '"repositories" = [] # nothing declared yet'))
    await expect(relayoutRegistry(file)).rejects.toMatchObject({ step: "notes" })
    writeFileSync(file, before.replace('"language" = "en"', '"language" = "en", "aliases" = ["the #1 owner"]'))
    expect((await relayoutRegistry(file)).changed, "a hash in a string is a value").toBe(true)
    expect((loadRegistry(file).data as { people: { aliases?: string[] }[] }).people[0].aliases).toEqual(["the #1 owner"])
  } finally { it.stop() }
})

test("the writer's output is what the loader reads back, with bare keys where the grammar allows and quoted ones where it does not", () => {
  const it = scratch()
  try {
    const data = {
      hub: { tick_seconds: 5, state_dir: "/tmp/x" },
      presets: { "import-p1-lair": { adapter: "a", model: "m", provider: "p", effort: "e", paid: "key" } },
      people: [{ id: "p1", tree: "/tmp/x/p1", allowed_senders: { "a door": ["one"] } }],
      agents: [],
    }
    const file = join(it.dir, "rendered.toml")
    writeFileSync(file, toml(data))
    const text = readFileSync(file, "utf8")
    expect(text).toContain('[presets.import-p1-lair]')
    expect(text).toContain('allowed_senders = { "a door" = ["one"] }')
    expect(Bun.TOML.parse(text)).toEqual(data)
  } finally { it.stop() }
})
