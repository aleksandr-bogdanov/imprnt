// The registry is a hand-edited file and stays one. The hub changes three
// kinds of line surgically, and the whole of what is asserted here is that
// EVERY OTHER BYTE IS IDENTICAL afterwards: a person's comments, their key
// order, their blank lines and the shape of the end of their file.
//
// Every primitive is asserted as a LINE DIFF against the original bytes and
// never merely by loading the result, because a writer that parsed the file and
// serialized it back would load perfectly and would have thrown away
// everything a person wrote in it.
//
// The validation is a load AND a diff, and both halves are asserted, because a
// text edit can produce a file that loads and says something other than what
// was asked for.
import { afterAll, beforeAll, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { tmpdir } from "node:os"
import { handWrittenRegistry, lineDiff } from "./helpers/registry-fixture.ts"
import { seam, startCluster, startReadySubprocess, type Cluster, type ReadyProcess } from "./helpers/cluster.ts"
import { rolloutStage } from "./helpers/rollout-stage.ts"
import { servePlatform } from "./helpers/fake-platform.ts"
import { observe } from "./helpers/rollout-runner.ts"
import { loadRegistry } from "../src/registry/load.ts"
import type { RegistryKeyWriter } from "../src/board/run.ts"

let cluster: Cluster
beforeAll(async () => { cluster = await startCluster() })
afterAll(async () => { await cluster?.stop() })

type Edit = (...args: unknown[]) => Promise<{ changed: boolean }>

async function writer() {
  const module = await seam("src/registry/edit.ts")
  for (const name of ["appendEntry", "setKey", "removeEntry"]) {
    expect(typeof module[name], `src/registry/edit.ts exports ${name}`).toBe("function")
  }
  return {
    appendEntry: module.appendEntry as Edit,
    setKey: module.setKey as Edit,
    removeEntry: module.removeEntry as Edit,
    RegistryEditRefused: module.RegistryEditRefused as { new (): Error },
  }
}

function scratch(): { dir: string; file: string; bytes: string; stop(): void } {
  const dir = mkdtempSync(join(tmpdir(), "registry-edit-"))
  const { file, bytes } = handWrittenRegistry(dir)
  return { dir, file, bytes, stop: () => rmSync(dir, { recursive: true, force: true }) }
}

const NEW_AGENT = {
  id: "p1-new", person: "p1", preset: "daily", chat: "1000000007",
  door: "door-fake", runner: "runner-pi",
}

test("D-219 appendEntry adds one block at the end of the file and changes no other byte", async () => {
  const it = scratch()
  try {
    const { appendEntry } = await writer()
    const result = await appendEntry(it.file, "agents", NEW_AGENT)
    expect(result.changed).toBe(true)
    const after = readFileSync(it.file, "utf8")
    const diff = lineDiff(it.bytes, after)
    // Nothing is removed at all, which is the whole claim of an append.
    expect(diff.removed).toEqual([])
    expect(diff.added.filter(line => line !== "")).toEqual([
      "[[agents]]",
      'id = "p1-new"',
      'person = "p1"',
      'preset = "daily"',
      'chat = "1000000007"',
      'door = "door-fake"',
      'runner = "runner-pi"',
    ])
    const registry = loadRegistry(it.file)
    expect(registry.agents.map(one => one.id)).toEqual(["p1-lair", "p2-lair", "p1-batch", "p1-new"])
    expect(registry.agents.at(-1)).toEqual(NEW_AGENT)
    // The file a person promotes by hand ends the way they left it.
    expect(after.endsWith("\n")).toBe(it.bytes.endsWith("\n"))
  } finally { it.stop() }
})

test("D-219 setKey replaces one key's line inside a named entry and leaves the rest byte for byte", async () => {
  const it = scratch()
  try {
    const { setKey } = await writer()
    expect((await setKey(it.file, "agents[p2-lair]", "chat", "2000000009")).changed).toBe(true)
    const after = readFileSync(it.file, "utf8")
    expect(lineDiff(it.bytes, after)).toEqual({
      removed: ['chat = "2000000001"'],
      added: ['chat = "2000000009"'],
    })
    // The line that changed is the one the loader's own index points at.
    const was = it.bytes.split("\n")
    const now = after.split("\n")
    const at = was.findIndex(line => line === 'chat = "2000000001"')
    expect(now[at]).toBe('chat = "2000000009"')
    // The comment INSIDE that entry, between two of its keys, is still there.
    expect(now[at - 1]).toBe("# this chat was made again after the first one was deleted")
    const agent = loadRegistry(it.file).agents.find(one => one.id === "p2-lair")!
    expect(agent).toEqual({ id: "p2-lair", person: "p2", preset: "daily", chat: "2000000009",
      door: "door-fake", runner: "runner-pi" })
  } finally { it.stop() }
})

// The board of the next phase sets a field a hand-written file does not carry,
// so a writer that could only replace a line it found would leave that board
// with a button it cannot press.
test("D-219 setKey writes a key the entry does not carry yet, inside that entry", async () => {
  const it = scratch()
  try {
    const { setKey } = await writer()
    expect((await setKey(it.file, "agents[p1-lair]", "sleeping", true)).changed).toBe(true)
    const after = readFileSync(it.file, "utf8")
    expect(lineDiff(it.bytes, after)).toEqual({ removed: [], added: ["sleeping = true"] })
    // Inside the entry it names, which is the last of that entry's own keys.
    const now = after.split("\n")
    const header = now.indexOf("[[agents]]")
    expect(now.slice(header, header + 8)).toEqual([
      "[[agents]]", 'person = "p1"', 'id = "p1-lair"', 'preset = "daily"',
      'chat = "1000000001"', 'door = "door-fake"', 'runner = "runner-pi"', "sleeping = true",
    ])
    expect(loadRegistry(it.file).agents.find(one => one.id === "p1-lair")!.sleeping).toBe(true)
  } finally { it.stop() }
})

test("D-219 removeEntry takes a middle entry's block, its own comment with it, and the next entry's comment stays", async () => {
  const it = scratch()
  try {
    const { removeEntry } = await writer()
    expect((await removeEntry(it.file, "agents[p2-lair]")).changed).toBe(true)
    const after = readFileSync(it.file, "utf8")
    const diff = lineDiff(it.bytes, after)
    expect(diff.added).toEqual([])
    expect(diff.removed).toEqual([
      "# the second person's lair",
      "[[agents]]",
      'id = "p2-lair"',
      'person = "p2"',
      "# this chat was made again after the first one was deleted",
      'chat = "2000000001"',
      'door = "door-fake"',
      'preset = "daily"',
      'runner = "runner-pi"',
      "",
    ])
    // A block boundary drawn one line wrong eats somebody's note about the
    // next thing, so both notes are asserted, not only the one that goes. The
    // note directly above the entry goes WITH it, because a note left standing
    // over the next entry would label that one wrongly.
    expect(after).not.toContain("# this chat was made again")
    expect(after).not.toContain("# the second person's lair")
    expect(after).toContain("# takes jobs only, and answers in no chat")
    expect(after).toContain("# the lair, the one that is always on")
    expect(loadRegistry(it.file).agents.map(one => one.id)).toEqual(["p1-lair", "p1-batch"])
  } finally { it.stop() }
})

// Two shapes, because a bound written as "up to the next entry of my own table"
// works for a middle entry and deletes to the end of the file for the last one.
// The last agent has the run entries under it, so that bug takes the whole
// household's processes with it and a middle-only check never sees it.
test("D-219 removeEntry takes the last entry of a table and leaves the table below it alone", async () => {
  const it = scratch()
  try {
    const { removeEntry } = await writer()
    expect((await removeEntry(it.file, "agents[p1-batch]")).changed).toBe(true)
    const after = readFileSync(it.file, "utf8")
    const diff = lineDiff(it.bytes, after)
    expect(diff.added).toEqual([])
    expect(diff.removed).toEqual([
      "# takes jobs only, and answers in no chat",
      "[[agents]]", 'id = "p1-batch"', 'person = "p1"', 'preset = "daily"', 'runner = "runner-pi"', "",
    ])
    const registry = loadRegistry(it.file)
    expect(registry.agents.map(one => one.id)).toEqual(["p1-lair", "p2-lair"])
    expect(registry.run.map(one => one.id)).toEqual(["door-fake", "runner-pi"])
    expect(after).toContain("# one bot for the household")
    expect(after).toContain("# the runner beside it")
  } finally { it.stop() }
})

test("D-219 removeEntry takes the last entry in the file, where the end of the file is the bound", async () => {
  const it = scratch()
  try {
    const { removeEntry } = await writer()
    expect((await removeEntry(it.file, "run[runner-pi]")).changed).toBe(true)
    const after = readFileSync(it.file, "utf8")
    const diff = lineDiff(it.bytes, after)
    expect(diff.added).toEqual([])
    expect(diff.removed).toEqual([
      "# the runner beside it", "[[run]]", 'id = "runner-pi"', 'kind = "runner"', 'machine = "pi"',
      'schedule = "always"', "memory_limit_mb = 512", "child_memory_limit_mb = 2048",
    ])
    expect(loadRegistry(it.file).run.map(one => one.id)).toEqual(["door-fake"])
    expect(after).toContain("# one bot for the household")
  } finally { it.stop() }
})

test("D-219 a candidate that fails to load leaves the live file identical and the candidate on disk for a person", async () => {
  const it = scratch()
  try {
    const { setKey, RegistryEditRefused } = await writer()
    // A preset this file does not define, which the shipped loader refuses by
    // name. The text edit is perfectly well formed and the FILE is not.
    const refused = await setKey(it.file, "agents[p1-lair]", "preset", "a-preset-nobody-declared")
      .then(() => null, (error: Error) => error)
    expect(refused).toBeInstanceOf(RegistryEditRefused)
    expect(readFileSync(it.file, "utf8")).toBe(it.bytes)
    const candidate = (refused as unknown as { candidate: string }).candidate
    expect(dirname(candidate)).toBe(dirname(it.file))
    // LEFT ON PURPOSE, for a person to read and delete: it is the only record
    // of what the hub was about to write.
    expect(readFileSync(candidate, "utf8")).toContain('preset = "a-preset-nobody-declared"')
    expect(String((refused as Error).message)).toContain("a-preset-nobody-declared")
    expect((refused as unknown as { step: string }).step).toBe("load")
  } finally { it.stop() }
})

// A LOAD ALONE IS NOT ENOUGH. The candidate here is legal TOML that the loader
// accepts, and it says something other than what the caller asked for, which is
// what a text edit that went one line wrong produces.
test("D-219 a candidate that loads and means something other than the edit asked for is refused", async () => {
  const it = scratch()
  try {
    const { setKey, RegistryEditRefused } = await writer()
    const refused = await setKey(it.file, "agents[p1-lair]", "chat", "1000000009", {
      seam: {
        beforeValidate(candidate: string) {
          // The same edit, landed inside the WRONG entry: the file loads, and
          // the agent the caller named still carries its old chat.
          writeFileSync(candidate, readFileSync(candidate, "utf8")
            .replace('chat = "1000000009"', 'chat = "1000000001"')
            .replace('chat = "2000000001"', 'chat = "1000000009"'))
        },
      },
    }).then(() => null, (error: Error) => error)
    expect(refused).toBeInstanceOf(RegistryEditRefused)
    expect((refused as unknown as { step: string }).step).toBe("diff")
    expect(readFileSync(it.file, "utf8")).toBe(it.bytes)
    expect(loadRegistry(it.file).agents.find(one => one.id === "p1-lair")!.chat).toBe("1000000001")
  } finally { it.stop() }
})

// Somebody editing the file in an editor while the hub applies a command from a
// phone is the case that loses work, so the bytes are read again at the last
// moment and a change refuses the edit rather than overwriting it.
test("D-219 a hand edit that lands between the read and the rename is detected and refused", async () => {
  const it = scratch()
  try {
    const { setKey, RegistryEditRefused } = await writer()
    const byHand = it.bytes.replace('tick_seconds = 1', "tick_seconds = 2\n# somebody was in here")
    const refused = await setKey(it.file, "agents[p1-lair]", "chat", "1000000009", {
      seam: { beforeRename() { writeFileSync(it.file, byHand) } },
    }).then(() => null, (error: Error) => error)
    expect(refused).toBeInstanceOf(RegistryEditRefused)
    expect((refused as unknown as { step: string }).step).toBe("concurrent")
    // The person's own edit is still there, byte for byte, and the hub's is not.
    expect(readFileSync(it.file, "utf8")).toBe(byHand)
    expect(readFileSync(it.file, "utf8")).not.toContain("1000000009")
  } finally { it.stop() }
})

test("D-219 the candidate carries the registry's own mode and a failure before the rename leaves the original bytes", async () => {
  const it = scratch()
  try {
    const { setKey } = await writer()
    chmodSync(it.file, 0o600)
    let seen: { mode: number; candidate: string; live: string } | null = null
    const refused = await setKey(it.file, "agents[p1-lair]", "chat", "1000000009", {
      seam: {
        beforeRename(candidate: string) {
          seen = {
            mode: statSync(candidate).mode & 0o777,
            candidate: readFileSync(candidate, "utf8"),
            live: readFileSync(it.file, "utf8"),
          }
          throw new Error("the machine went away between the write and the rename")
        },
      },
    }).then(() => null, (error: Error) => error)
    expect(refused).toBeInstanceOf(Error)
    const at = seen as unknown as { mode: number; candidate: string; live: string }
    expect(at.mode).toBe(0o600)
    // The whole candidate is on disk BEFORE the rename, and the live file is
    // untouched, which is what makes a half-written live file impossible.
    expect(at.candidate).toContain('chat = "1000000009"')
    expect(at.live).toBe(it.bytes)
    expect(readFileSync(it.file, "utf8")).toBe(it.bytes)
  } finally { it.stop() }
})

// The durability calls themselves cannot be seen from inside this process, so
// they are asserted on the module's own text: the bytes are flushed, then the
// rename, then the directory is flushed, in that order.
test("D-219 the writer flushes the candidate, renames, and flushes the directory", async () => {
  const source = readFileSync(join(import.meta.dir, "../src/registry/edit.ts"), "utf8")
  const flushFile = source.indexOf("fsyncSync(handle)")
  const rename = source.indexOf("renameSync(")
  const flushDirectory = source.indexOf("fsyncSync(directory)")
  expect(flushFile).toBeGreaterThan(0)
  expect(rename).toBeGreaterThan(flushFile)
  expect(flushDirectory).toBeGreaterThan(rename)
})

test("D-219 each primitive refuses a path that is not its own and leaves the file untouched", async () => {
  const it = scratch()
  try {
    const { appendEntry, setKey, removeEntry, RegistryEditRefused } = await writer()
    const missingKey = await setKey(it.file, "agents[p1-nobody]", "chat", "1").then(() => null, (e: Error) => e)
    expect(missingKey).toBeInstanceOf(RegistryEditRefused)
    expect(String((missingKey as Error).message)).toContain("p1-nobody")
    const missingEntry = await removeEntry(it.file, "run[nothing-runs-this]").then(() => null, (e: Error) => e)
    expect(missingEntry).toBeInstanceOf(RegistryEditRefused)
    // A block the loader requires a key of is refused by the loader's own words.
    const halfBlock = await appendEntry(it.file, "agents", { id: "p1-half", person: "p1", runner: "runner-pi" })
      .then(() => null, (e: Error) => e)
    expect(halfBlock).toBeInstanceOf(RegistryEditRefused)
    expect(String((halfBlock as Error).message)).toContain("preset")
    expect(readFileSync(it.file, "utf8")).toBe(it.bytes)
  } finally { it.stop() }
})

// The board sets two fields a hand-written file usually does not carry, through
// the writer contract it already declares. The adapter below is typed against
// that contract, so `setKey` fitting it is checked by the compiler as well as
// by the diffs, and the board's own code changes by not one line.
test("D-219 the board's writer contract is setKey, for both fields the board sets", async () => {
  const it = scratch()
  try {
    const { setKey } = await writer()
    const write: RegistryKeyWriter = async ({ file, table, id, key, value }) => {
      await setKey(file, `${table}[${id}]`, key, value)
    }
    await write({ file: it.file, table: "run", id: "door-fake", key: "enabled", value: false })
    const stopped = readFileSync(it.file, "utf8")
    expect(lineDiff(it.bytes, stopped)).toEqual({ removed: [], added: ["enabled = false"] })
    await write({ file: it.file, table: "agents", id: "p1-lair", key: "sleeping", value: true })
    const paused = readFileSync(it.file, "utf8")
    expect(lineDiff(stopped, paused)).toEqual({ removed: [], added: ["sleeping = true"] })
    // Pressing start again replaces the line rather than writing a second one.
    await write({ file: it.file, table: "run", id: "door-fake", key: "enabled", value: true })
    expect(lineDiff(paused, readFileSync(it.file, "utf8"))).toEqual({ removed: ["enabled = false"], added: ["enabled = true"] })
    const registry = loadRegistry(it.file)
    expect(registry.run.find(one => one.id === "door-fake")!.enabled).toBe(true)
    expect(registry.agents.find(one => one.id === "p1-lair")!.sleeping).toBe(true)
  } finally { it.stop() }
})

// The control: a build that rewrote the file on every call passes every
// assertion above and fails this one.
test("D-219 an edit that is already true changes nothing and says so", async () => {
  const it = scratch()
  try {
    const { setKey } = await writer()
    const result = await setKey(it.file, "agents[p1-lair]", "chat", "1000000001")
    expect(result.changed).toBe(false)
    expect(readFileSync(it.file, "utf8")).toBe(it.bytes)
    expect(statSync(it.file).mode & 0o777).toBe(0o640)
  } finally { it.stop() }
})

// The whole reason a surgical edit is enough: every door re-reads the file on
// its own tick, so an agent appended by the hub is served by a door that was
// already running, and no process is restarted for it.
test("D-219 a door mid-run serves an agent the writer appended, with its process id unchanged", async () => {
  const it = await rolloutStage(cluster, "telegram", {
    registry: base => ({ ...base, agents: base.agents!.map(one => ({ ...one, person: "p1" })) }),
  })
  const platform = await servePlatform({ ...it.fake, platform: it.edge.platform })
  const children: ReadyProcess[] = []
  try {
    const { appendEntry } = await writer()
    const door = await startReadySubprocess("test/helpers/door-subprocess.ts", [it.registryFile, "door-fake", platform.url])
    children.push(door)
    const before = door.pid
    expect(await observe(() => it.edge.pulls().some(one => one.chat === "1000000001"))).toBe(true)
    const bytes = readFileSync(it.registryFile, "utf8")
    await appendEntry(it.registryFile, "agents", { ...NEW_AGENT, runner: "runner-pi" })
    expect(lineDiff(bytes, readFileSync(it.registryFile, "utf8")).removed).toEqual([])
    expect(await observe(() => it.edge.pulls().some(one => one.chat === NEW_AGENT.chat), 8000),
      "the door reads the new agent's chat within a tick").toBe(true)
    expect(door.pid).toBe(before)
  } finally { for (const child of children.reverse()) await child.stop(); await platform.stop(); await it.stop() }
})

// AN ID IS NEVER A POSITION. The hub and the board both hand this writer an id
// somebody typed, and an agent id may be all digits. Read as a list position,
// `agents[0]` is whichever entry happens to be first in the file, which can be
// the other person's.
function withDigitAgent(it: { file: string }, id: string): string {
  const bytes = readFileSync(it.file, "utf8") +
    `\n\n# an agent whose id is all digits\n[[agents]]\nid = "${id}"\nperson = "p1"\npreset = "daily"\nrunner = "runner-pi"`
  writeFileSync(it.file, bytes)
  return bytes
}

test("an all-digit id names the entry carrying that id, and never the entry at that position", async () => {
  const it = scratch()
  try {
    const { setKey } = await writer()
    const bytes = withDigitAgent(it, "0")
    expect(loadRegistry(it.file).agents.map(one => one.id)).toEqual(["p1-lair", "p2-lair", "p1-batch", "0"])
    expect((await setKey(it.file, "agents[0]", "sleeping", true)).changed).toBe(true)
    const after = readFileSync(it.file, "utf8")
    expect(lineDiff(bytes, after)).toEqual({ removed: [], added: ["sleeping = true"] })
    // The new line is the last line of the file, inside the block of the agent
    // whose id is "0", and the first agent in the file is untouched.
    expect(after.endsWith('runner = "runner-pi"\nsleeping = true')).toBe(true)
    const agents = loadRegistry(it.file).agents
    expect(agents.find(one => one.id === "0")!.sleeping).toBe(true)
    expect(agents.find(one => one.id === "p1-lair")!.sleeping).toBeUndefined()
  } finally { it.stop() }
})

test("a position with no entry of that id behind it is refused, and the entry at that position is left alone", async () => {
  const it = scratch()
  try {
    const { setKey, removeEntry, RegistryEditRefused } = await writer()
    for (const edit of [
      () => removeEntry(it.file, "agents[1]"),
      () => setKey(it.file, "agents[0]", "chat", "1000000009"),
      () => setKey(it.file, "run[0]", "enabled", false),
    ]) {
      const refused = await edit().then(() => null, (error: Error) => error)
      expect(refused).toBeInstanceOf(RegistryEditRefused)
      expect((refused as unknown as { step: string }).step).toBe("path")
      expect(readFileSync(it.file, "utf8")).toBe(it.bytes)
    }
    // A refusal about the path is answered before anything is written at all.
    expect(readdirSync(it.dir).filter(name => name !== "hand-written.toml")).toEqual([])
    // The control: the same writer with the id of the entry at that position.
    expect((await removeEntry(it.file, "agents[p2-lair]")).changed).toBe(true)
    expect(loadRegistry(it.file).agents.map(one => one.id)).toEqual(["p1-lair", "p1-batch"])
  } finally { it.stop() }
})

// A board page on the tailnet can press the same refused edit as often as it
// likes, so what a refusal leaves beside the registry has to have a bound.
test("a refusal repeated many times leaves one candidate beside the registry, and the latest one is readable", async () => {
  const it = scratch()
  try {
    const { setKey, RegistryEditRefused } = await writer()
    let last: { candidate: string } | null = null
    for (let n = 0; n < 12; n += 1) {
      const refused = await setKey(it.file, "agents[p1-lair]", "preset", `a-preset-nobody-declared-${n}`)
        .then(() => null, (error: Error) => error)
      expect(refused).toBeInstanceOf(RegistryEditRefused)
      last = refused as unknown as { candidate: string }
    }
    const left = readdirSync(it.dir).filter(name => name !== "hand-written.toml")
    expect(left).toHaveLength(1)
    expect(dirname(last!.candidate)).toBe(it.dir)
    expect(readFileSync(last!.candidate, "utf8")).toContain('preset = "a-preset-nobody-declared-11"')
    expect(readFileSync(it.file, "utf8")).toBe(it.bytes)
  } finally { it.stop() }
})
