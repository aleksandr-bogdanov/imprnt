// An agent's id is a folder name. The chat log lives at
// `<state_dir>/<person>/chatlog/<agent id>/` and the runner's session at
// `<state_dir>/<person>/sessions/<agent id>/`, so an id that can leave that
// folder is a path into another person's history. The loader refuses such an id
// by line and refuses a second agent with an id already taken, the door refuses
// one before any control row is written, and the hub refuses a planted row that
// carries one.
import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { startCluster, type Cluster } from "./helpers/cluster.ts"
import { handWrittenRegistry } from "./helpers/registry-fixture.ts"
import { rolloutStage } from "./helpers/rollout-stage.ts"
import { serviceOs } from "./helpers/rollout-service.ts"
import { superStore } from "./helpers/hub-fixture.ts"
import { message } from "./helpers/rollout-ingress.ts"
import { observe } from "./helpers/rollout-runner.ts"
import { runDoor } from "../src/door/run.ts"
import { runHub } from "../src/hub/run.ts"
import { agentAccepted, agentRefused } from "../src/door/lines.ts"
import { loadRegistry, RegistryRefused } from "../src/registry/load.ts"

let cluster: Cluster
beforeAll(async () => { cluster = await startCluster() })
afterAll(async () => { await cluster?.stop() })

const LAIR = "1000000001"
const RESEARCH = "1000000009"
const GUILD = "2000000000"
const TRAVERSAL = "../../p2/chatlog/p2-lair"

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "agent-id-"))
  const { file, bytes } = handWrittenRegistry(dir)
  return { dir, file, bytes, stop: () => rmSync(dir, { recursive: true, force: true }) }
}

/** The fixture with one agent's id line replaced, and the line it now sits on. */
function withAgentId(it: { file: string; bytes: string }, from: string, to: string): number {
  const lines = it.bytes.split("\n")
  const at = lines.indexOf(`id = "${from}"`)
  expect(at).toBeGreaterThan(0)
  lines[at] = `id = ${JSON.stringify(to)}`
  writeFileSync(it.file, lines.join("\n"))
  return at + 1
}

function refusal(file: string): RegistryRefused | null {
  try { loadRegistry(file); return null } catch (error) { return error as RegistryRefused }
}

test("an agent id that can leave its folder is refused by the line it is on", () => {
  const it = scratch()
  try {
    for (const bad of [TRAVERSAL, "..", "p1/lair", "p1\\lair", "P1-Lair", "p1_lair", "p1 lair", "-p1", "p1-", "p1--lair", ""]) {
      const line = withAgentId(it, "p1-batch", bad)
      const refused = refusal(it.file)
      expect(refused, `${JSON.stringify(bad)} loads`).toBeInstanceOf(RegistryRefused)
      expect(refused!.key).toBe("agents[2].id")
      expect(refused!.line).toBe(line)
    }
  } finally { it.stop() }
})

test("a second agent with an id already taken is refused by its own line, naming the first", () => {
  const it = scratch()
  try {
    const first = it.bytes.split("\n").indexOf('id = "p1-lair"') + 1
    const line = withAgentId(it, "p1-batch", "p1-lair")
    const refused = refusal(it.file)
    expect(refused).toBeInstanceOf(RegistryRefused)
    expect(refused!.key).toBe("agents[2].id")
    expect(refused!.line).toBe(line)
    expect(refused!.reason).toContain(`line ${first}`)
  } finally { it.stop() }
})

// The control: every shape an ordinary household writes, and the example the
// package ships, load under the same rule.
test("ordinary ids load, digits and single hyphens included, and so does the shipped example", () => {
  const it = scratch()
  try {
    for (const good of ["p1-batch", "research", "0", "123", "p1-research-2"]) {
      withAgentId(it, "p1-batch", good)
      expect(refusal(it.file), `${good} is refused`).toBeNull()
      expect(loadRegistry(it.file).agents.map(one => one.id)).toEqual(["p1-lair", "p2-lair", good])
    }
    const example = loadRegistry(join(import.meta.dir, "../src/registry/registry.example.toml"))
    expect(example.agents.length).toBeGreaterThan(0)
  } finally { it.stop() }
})

function household() {
  const os = process.platform === "darwin" ? "macos" : "linux"
  return {
    admin: { chats: [{ name: "lair", chat: LAIR }, { name: "research", chat: RESEARCH }] },
    machines: [{ id: "mac", os }],
    registry: (base: any) => ({
      ...base,
      agents: base.agents!.map((one: any) => ({ ...one, person: "p1" })),
      run: [
        { id: "door-fake", kind: "door", platform: "fake", person: "p1", token_file: "/dev/null",
          schedule: "always", memory_limit_mb: 192, guild: GUILD, default_preset: "daily" },
        { id: "runner-pi", kind: "runner", schedule: "always", memory_limit_mb: 512, child_memory_limit_mb: 2048 },
      ],
    }),
  }
}

const inertOs = (stateDir: string) => {
  const os = serviceOs(stateDir, "launchd", ["door-fake", "runner-pi"])
  os.os.render = () => []
  return os
}

test("an adopt typed with an id that leaves its folder is refused at the door, with no control row and no registry byte changed", async () => {
  const it = await rolloutStage(cluster, "discord", household())
  let door: Awaited<ReturnType<typeof runDoor>> | undefined
  let hub: Awaited<ReturnType<typeof runHub>> | undefined
  try {
    door = await runDoor({ door: "door-fake", registryFile: it.registryFile, platform: it.edge.platform })
    hub = await runHub({ registryFile: it.registryFile, machine: "mac", os: inertOs(it.stateDir).os })
    const before = readFileSync(it.registryFile, "utf8")
    it.edge.batch([message("20", `/agent adopt ${TRAVERSAL} research`)], "21")
    const refused = agentRefused("en", { operation: "adopt", agent: TRAVERSAL, cause: "invalid configuration" })
    expect(await observe(() => it.edge.posts().some(post => post.text === refused), 10000),
      `the door said: ${JSON.stringify(it.edge.posts().map(post => post.text))}`).toBe(true)
    expect(await it.read.sheet("control")).toEqual([])
    expect(readFileSync(it.registryFile, "utf8")).toBe(before)
    // The control in the same run: the same verb with an ordinary id goes through.
    it.edge.batch([message("30", "/agent adopt p1-new research")], "31")
    expect(await observe(() => it.edge.posts().some(post =>
      post.text === agentAccepted("en", { operation: "adopt", agent: "p1-new" })), 10000)).toBe(true)
    expect(await observe(async () => (await it.read.sheet("control")).some(row => row.data.status === "applied"), 10000)).toBe(true)
    expect(loadRegistry(it.registryFile).agents.map(one => one.id)).toContain("p1-new")
  } finally { await hub?.stop(); await door?.stop(); await it.stop() }
}, 90_000)

test("a control row planted with an id that leaves its folder is refused by the hub and the registry is byte-identical", async () => {
  const it = await rolloutStage(cluster, "discord", household())
  const store = await superStore(cluster, it.db)
  let hub: Awaited<ReturnType<typeof runHub>> | undefined
  try {
    hub = await runHub({ registryFile: it.registryFile, machine: "mac", os: inertOs(it.stateDir).os })
    const before = readFileSync(it.registryFile, "utf8")
    const id = "agent:planted-traversal"
    await store.sql`insert into state_row (sheet, id, data) values ('control', ${id}, ${{
      id, actor: "p1", source: "chat", person: "p1", target_kind: "agent-lifecycle",
      target_id: TRAVERSAL, requested_at: new Date().toISOString(), status: "pending", cause: null,
      door: "door-fake", agent: "p1-lair", route: { door: "door-fake", chat: LAIR },
      operation: "adopt", arguments: { chat: RESEARCH, name: "research" },
    }})`
    await store.sql`select pg_notify('hub_control', ${id})`
    expect(await observe(async () => (await it.read.sheet("control")).some(row => row.id === id && row.data.status !== "pending"), 10000)).toBe(true)
    expect((await it.read.sheet("control")).find(row => row.id === id)!.data).toMatchObject({ status: "refused", cause: "invalid configuration" })
    expect(readFileSync(it.registryFile, "utf8")).toBe(before)
  } finally { await hub?.stop(); await store.close(); await it.stop() }
}, 60_000)
