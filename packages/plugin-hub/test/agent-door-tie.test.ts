// A lifecycle command acts on an agent of the door it came through, and on no
// other.
//
// An agent's chat id means something only on its own door: a Telegram agent
// whose chat is overwritten with a Discord channel id answers nowhere, the
// check that no two agents share a chat is about one door, and the cursor a
// retire removes is keyed by the agent's door. So repair and retire from one
// door refuse an agent that answers on another, on the asking side and again
// on the applying side, and the same verb typed on the agent's own door goes
// through.
import { afterAll, beforeAll, expect, test } from "bun:test"
import { readFileSync, writeFileSync } from "node:fs"
import { startCluster, type Cluster } from "./helpers/cluster.ts"
import { rolloutStage } from "./helpers/rollout-stage.ts"
import { serviceOs } from "./helpers/rollout-service.ts"
import { superStore } from "./helpers/hub-fixture.ts"
import { message } from "./helpers/rollout-ingress.ts"
import { observe } from "./helpers/rollout-runner.ts"
import { runDoor } from "../src/door/run.ts"
import { runHub } from "../src/hub/run.ts"
import { agentAccepted, agentRefused } from "../src/door/lines.ts"
import { loadRegistry } from "../src/registry/load.ts"

let cluster: Cluster
beforeAll(async () => { cluster = await startCluster() })
afterAll(async () => { await cluster?.stop() })

const LAIR = "1000000001"
const RESEARCH = "1000000009"
const GUILD = "2000000000"
/** The owner's agent on a second door, in a chat of that door's own. */
const ELSEWHERE = "p1-elsewhere"
const ELSEWHERE_CHAT = "3000000001"

function household() {
  const os = process.platform === "darwin" ? "macos" : "linux"
  return {
    admin: { chats: [{ name: "lair", chat: LAIR }, { name: "research", chat: RESEARCH }] },
    machines: [{ id: "mac", os }],
    registry: (base: any) => ({
      ...base,
      agents: [
        ...base.agents!.map((one: any) => ({ ...one, person: "p1" })),
        { id: ELSEWHERE, person: "p1", preset: "daily", chat: ELSEWHERE_CHAT, door: "door-second", runner: "runner-pi" },
      ],
      run: [
        { id: "door-fake", kind: "door", platform: "fake", person: "p1", token_file: "/dev/null",
          schedule: "always", memory_limit_mb: 192, guild: GUILD, default_preset: "daily" },
        { id: "door-second", kind: "door", platform: "fake", person: "p1", token_file: "/dev/null",
          schedule: "always", memory_limit_mb: 192, default_preset: "daily" },
        { id: "runner-pi", kind: "runner", schedule: "always", memory_limit_mb: 512, child_memory_limit_mb: 2048 },
      ],
    }),
  }
}

/** The owner is allowed on the second door too, so the only thing wrong below is the door. */
function allowOnSecondDoor(file: string): void {
  const text = readFileSync(file, "utf8")
  const allowed = text.replace('allowed_senders = { door-fake = ["p1"] }', 'allowed_senders = { door-fake = ["p1"], door-second = ["p1"] }')
  expect(allowed).not.toBe(text)
  writeFileSync(file, allowed)
}

const inertOs = (stateDir: string) => {
  const os = serviceOs(stateDir, "launchd", ["door-fake", "door-second", "runner-pi"])
  os.os.render = () => []
  return os
}

test("a repair or a retire typed on one door of an agent that answers on another is refused at the door", async () => {
  const it = await rolloutStage(cluster, "discord", household())
  allowOnSecondDoor(it.registryFile)
  let door: Awaited<ReturnType<typeof runDoor>> | undefined
  let hub: Awaited<ReturnType<typeof runHub>> | undefined
  try {
    door = await runDoor({ door: "door-fake", registryFile: it.registryFile, platform: it.edge.platform })
    hub = await runHub({ registryFile: it.registryFile, machine: "mac", os: inertOs(it.stateDir).os })
    const before = readFileSync(it.registryFile, "utf8")
    it.edge.batch([message("20", `/agent adopt ${ELSEWHERE} research`), message("21", `/agent retire ${ELSEWHERE}`)], "22")
    for (const operation of ["adopt", "retire"]) {
      const refused = agentRefused("en", { operation, agent: ELSEWHERE, cause: "access denied" })
      expect(await observe(() => it.edge.posts().some(post => post.text === refused), 10000),
        `${operation}: the door said ${JSON.stringify(it.edge.posts().map(post => post.text))}`).toBe(true)
    }
    expect(await it.read.sheet("control")).toEqual([])
    expect(readFileSync(it.registryFile, "utf8")).toBe(before)
    // The control in the same run: an agent of this door is still this door's
    // to make.
    it.edge.batch([message("30", "/agent adopt p1-new research")], "31")
    expect(await observe(() => it.edge.posts().some(post =>
      post.text === agentAccepted("en", { operation: "adopt", agent: "p1-new" })), 10000)).toBe(true)
  } finally { await hub?.stop(); await door?.stop(); await it.stop() }
}, 90_000)

/** A row as a door that did not tie the agent to itself would have written it. */
function asked(id: string, operation: "adopt" | "retire", door: string, chat: string, agent: string) {
  return {
    id, actor: "p1", source: "chat", person: "p1", target_kind: "agent-lifecycle",
    target_id: ELSEWHERE, requested_at: new Date().toISOString(), status: "pending", cause: null,
    door, agent, route: { door, chat },
    operation, arguments: operation === "adopt" ? { chat: RESEARCH, name: "research" } : {},
  }
}

for (const operation of ["adopt", "retire"] as const) {
  test(`a planted ${operation} from one door of an agent on another is refused by the hub, and its cursor stays`, async () => {
    const it = await rolloutStage(cluster, "discord", household())
    allowOnSecondDoor(it.registryFile)
    const store = await superStore(cluster, it.db)
    let hub: Awaited<ReturnType<typeof runHub>> | undefined
    try {
      hub = await runHub({ registryFile: it.registryFile, machine: "mac", os: inertOs(it.stateDir).os })
      const before = readFileSync(it.registryFile, "utf8")
      const cursor = `door-second/${ELSEWHERE_CHAT}`
      await store.sql`insert into state_row (sheet, id, data) values ('door_cursor', ${cursor}, ${{ cursor: "41" }})`
      const id = `agent:across-doors-${operation}`
      await store.sql`insert into state_row (sheet, id, data) values ('control', ${id}, ${asked(id, operation, "door-fake", LAIR, "p1-lair")})`
      await store.sql`select pg_notify('hub_control', ${id})`
      expect(await observe(async () => (await it.read.sheet("control")).some(row => row.id === id && row.data.status !== "pending"), 10000)).toBe(true)
      expect((await it.read.sheet("control")).find(row => row.id === id)!.data).toMatchObject({ status: "refused", cause: "access denied" })
      expect(readFileSync(it.registryFile, "utf8")).toBe(before)
      expect((await it.read.sheet("door_cursor")).map(row => row.id)).toContain(cursor)
    } finally { await hub?.stop(); await store.close(); await it.stop() }
  }, 60_000)
}

// The control for both: the retire asked from the agent's OWN door and chat is
// applied, and the cursor it removes is the one under that door's key.
test("a retire asked from the agent's own door is applied, and removes the cursor under that door's key", async () => {
  const it = await rolloutStage(cluster, "discord", household())
  allowOnSecondDoor(it.registryFile)
  const store = await superStore(cluster, it.db)
  let hub: Awaited<ReturnType<typeof runHub>> | undefined
  try {
    hub = await runHub({ registryFile: it.registryFile, machine: "mac", os: inertOs(it.stateDir).os })
    const cursor = `door-second/${ELSEWHERE_CHAT}`
    await store.sql`insert into state_row (sheet, id, data) values ('door_cursor', ${cursor}, ${{ cursor: "41" }})`
    const id = "agent:own-door-retire"
    await store.sql`insert into state_row (sheet, id, data) values ('control', ${id}, ${asked(id, "retire", "door-second", ELSEWHERE_CHAT, ELSEWHERE)})`
    await store.sql`select pg_notify('hub_control', ${id})`
    expect(await observe(async () => (await it.read.sheet("control")).some(row => row.id === id && row.data.status !== "pending"), 10000)).toBe(true)
    expect((await it.read.sheet("control")).find(row => row.id === id)!.data).toMatchObject({ status: "applied", cause: null })
    expect(loadRegistry(it.registryFile).agents.map(one => one.id)).not.toContain(ELSEWHERE)
    expect((await it.read.sheet("door_cursor")).map(row => row.id)).not.toContain(cursor)
  } finally { await hub?.stop(); await store.close(); await it.stop() }
}, 60_000)
