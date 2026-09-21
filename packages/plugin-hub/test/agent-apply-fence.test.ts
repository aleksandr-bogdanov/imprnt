// The hub applies a lifecycle row only when the door that asks would have
// asked for it.
//
// The door, the runner and the hub roles all hold insert on the control sheet,
// so a row can reach the hub without ever passing through the door's rule. The
// recovery rows already have their rule asked again on the apply side for that
// reason, and a lifecycle row edits the registry, so it gets the same: the
// front end is a chat, the sender is on that person's allowlist for that door,
// the route is that door and a chat one of that person's agents answers in, and
// the verb is one of the two there are. Each planted row below is one the door
// would have refused, and the control is the same row with nothing wrong.
import { afterAll, beforeAll, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { startCluster, type Cluster } from "./helpers/cluster.ts"
import { rolloutStage } from "./helpers/rollout-stage.ts"
import { serviceOs } from "./helpers/rollout-service.ts"
import { superStore } from "./helpers/hub-fixture.ts"
import { observe } from "./helpers/rollout-runner.ts"
import { runHub } from "../src/hub/run.ts"
import { loadRegistry } from "../src/registry/load.ts"

let cluster: Cluster
beforeAll(async () => { cluster = await startCluster() })
afterAll(async () => { await cluster?.stop() })

const LAIR = "1000000001"
const OTHER = "0000000000"
const RESEARCH = "1000000009"
const GUILD = "2000000000"

/** The owner's door, which the second person's lair also answers on. */
function household() {
  const os = process.platform === "darwin" ? "macos" : "linux"
  return {
    admin: { chats: [{ name: "lair", chat: LAIR }, { name: "research", chat: RESEARCH }, { name: "other", chat: OTHER }] },
    machines: [{ id: "mac", os }],
    registry: (base: any) => ({
      ...base,
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

/** A row exactly as the door writes one for `/agent adopt p1-new research` in the owner's lair. */
function asked(id: string) {
  return {
    id, actor: "p1", source: "chat", person: "p1", target_kind: "agent-lifecycle",
    target_id: "p1-new", requested_at: new Date().toISOString(), status: "pending", cause: null,
    door: "door-fake", agent: "p1-lair", route: { door: "door-fake", chat: LAIR },
    operation: "adopt", arguments: { chat: RESEARCH, name: "research" },
  }
}

const PLANTED: { what: string; row: (id: string) => Record<string, unknown>; cause: string }[] = [
  { what: "a front end that is not a chat", row: id => ({ ...asked(id), source: "board" }), cause: "access denied" },
  { what: "a sender the allowlist does not name", row: id => ({ ...asked(id), actor: "unlisted" }), cause: "access denied" },
  { what: "a route in a chat none of this person's agents answers in",
    row: id => ({ ...asked(id), route: { door: "door-fake", chat: OTHER }, agent: "p2-lair" }), cause: "access denied" },
  { what: "a route on another door than the row names",
    row: id => ({ ...asked(id), route: { door: "door-elsewhere", chat: LAIR } }), cause: "access denied" },
  { what: "an agent that is not the one answering in the route's chat",
    row: id => ({ ...asked(id), agent: "p2-lair" }), cause: "access denied" },
  { what: "a verb that is neither adopt nor retire", row: id => ({ ...asked(id), operation: "rename" }), cause: "invalid configuration" },
]

for (const planted of PLANTED) {
  test(`a lifecycle row planted with ${planted.what} is refused by the hub and the registry is byte-identical`, async () => {
    const it = await rolloutStage(cluster, "discord", household())
    const store = await superStore(cluster, it.db)
    let hub: Awaited<ReturnType<typeof runHub>> | undefined
    try {
      hub = await runHub({ registryFile: it.registryFile, machine: "mac", os: inertOs(it.stateDir).os })
      const before = readFileSync(it.registryFile, "utf8")
      const id = `agent:planted-${crypto.randomUUID().slice(0, 8)}`
      await store.sql`insert into state_row (sheet, id, data) values ('control', ${id}, ${planted.row(id)})`
      await store.sql`select pg_notify('hub_control', ${id})`
      expect(await observe(async () => (await it.read.sheet("control")).some(row => row.id === id && row.data.status !== "pending"), 10000)).toBe(true)
      expect((await it.read.sheet("control")).find(row => row.id === id)!.data).toMatchObject({ status: "refused", cause: planted.cause })
      expect(readFileSync(it.registryFile, "utf8")).toBe(before)
    } finally { await hub?.stop(); await store.close(); await it.stop() }
  }, 60_000)
}

// The control: the row the door writes, planted the same way, is applied, so
// every refusal above is about the one field each changes.
test("the same lifecycle row with nothing wrong in it is applied by the hub", async () => {
  const it = await rolloutStage(cluster, "discord", household())
  const store = await superStore(cluster, it.db)
  let hub: Awaited<ReturnType<typeof runHub>> | undefined
  try {
    hub = await runHub({ registryFile: it.registryFile, machine: "mac", os: inertOs(it.stateDir).os })
    const id = "agent:planted-as-asked"
    await store.sql`insert into state_row (sheet, id, data) values ('control', ${id}, ${asked(id)})`
    await store.sql`select pg_notify('hub_control', ${id})`
    expect(await observe(async () => (await it.read.sheet("control")).some(row => row.id === id && row.data.status !== "pending"), 10000)).toBe(true)
    expect((await it.read.sheet("control")).find(row => row.id === id)!.data).toMatchObject({ status: "applied", cause: null })
    expect(loadRegistry(it.registryFile).agents.find(one => one.id === "p1-new")).toMatchObject({ person: "p1", chat: RESEARCH, door: "door-fake" })
  } finally { await hub?.stop(); await store.close(); await it.stop() }
}, 60_000)
