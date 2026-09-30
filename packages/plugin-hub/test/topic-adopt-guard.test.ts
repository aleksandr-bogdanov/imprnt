// The old adopt and retire verbs are compatibility operations: they cannot bypass a topic's
// lifecycle or an identity the store retired. Driven the way the agent lifecycle checks drive
// them: control rows planted on the sheet, applied by the real hub, which is where a refusal
// can be written down and said to the person.

import { afterAll, beforeAll, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { startCluster, type Cluster } from "./helpers/cluster.ts"
import { rolloutStage } from "./helpers/rollout-stage.ts"
import { serviceOs } from "./helpers/rollout-service.ts"
import { superStore } from "./helpers/hub-fixture.ts"
import { observe } from "./helpers/rollout-runner.ts"
import { runHub } from "../src/hub/run.ts"
import { setKey } from "../src/registry/edit.ts"
import { loadRegistry } from "../src/registry/load.ts"
import { allocateTopic, linkLegacyTopic, markChannelMissing, observeChannel, readSeen, readTopicByAgent, reserveIdentity } from "../src/store/topics.ts"

let cluster: Cluster
beforeAll(async () => { cluster = await startCluster() })
afterAll(async () => { await cluster?.stop() })

const LAIR = "1000000001"
const RESEARCH = "1000000009"
const OTHER = "0000000000"
const GUILD = "2000000000"

function household() {
  const os = process.platform === "darwin" ? "macos" : "linux"
  return {
    admin: { chats: [{ name: "lair", chat: LAIR }, { name: "research", chat: RESEARCH }, { name: "other", chat: OTHER }] },
    machines: [{ id: "mac", os }],
    registry: (base: any) => ({
      ...base,
      agents: base.agents!.map((one: any) => ({ ...one, person: "p1" })),
      run: [
        { id: "door-fake", kind: "door", platform: "fake", person: "p1", token_file: "/dev/null", schedule: "always", memory_limit_mb: 192, guild: GUILD, default_preset: "daily" },
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

test("a reserved identity is never adopted, an id a topic owns is not made or retired by hand, and a legacy topic follows its master's repair", async () => {
  const it = await rolloutStage(cluster, "discord", household())
  const store = await superStore(cluster, it.db)
  let hub: Awaited<ReturnType<typeof runHub>> | undefined
  try {
    hub = await runHub({ registryFile: it.registryFile, machine: "mac", os: inertOs(it.stateDir).os })
    let n = 0
    /** A row planted the way the door writes one, applied by the hub, and what became of it. */
    const ask = async (operation: "adopt" | "retire", target: string, chat?: string, from = LAIR) => {
      const id = `agent:guard-${++n}`
      // Typed in the chat p1-lair answers in NOW, which is what the hub authorizes the command against.
      await store.sql`insert into state_row (sheet, id, data) values ('control', ${id}, ${{
        id, actor: "p1", source: "chat", person: "p1", target_kind: "agent-lifecycle", target_id: target,
        requested_at: new Date().toISOString(), status: "pending", cause: null, door: "door-fake", agent: "p1-lair",
        route: { door: "door-fake", chat: from }, operation, arguments: chat === undefined ? {} : { chat },
      }})`
      await store.sql`select pg_notify('hub_control', ${id})`
      expect(await observe(async () => (await it.read.sheet("control")).some(row => row.id === id && row.data.status !== "pending"), 10000), `${operation} ${target} was answered`).toBe(true)
      return (await it.read.sheet("control")).find(row => row.id === id)!.data
    }
    const before = () => readFileSync(it.registryFile, "utf8")
    const diary = async (target: string) => (await it.read.ledger()).filter(one => one.subject === target && one.kind === "failed").map(one => String(one.detail.cause))

    // A retired identity: refused by name in the diary, and "invalid configuration" to the person, and the file is untouched.
    await reserveIdentity(store, "agent", "p1-retired", "topic deleted")
    const file = before()
    expect(await ask("adopt", "p1-retired", RESEARCH)).toMatchObject({ status: "refused", cause: "invalid configuration" })
    expect(before()).toBe(file)
    expect((await diary("p1-retired")).join("\n")).toContain("identity-reserved")

    // An id that belongs to a topic is not adoptable by hand, while its channel is being made or after.
    const made = await allocateTopic(store, { operation: "op-guard", person: "p1", door: "door-fake", display_name: "coffee", machine: "mac", runner: "runner-pi",
      preset: "daily", adapter: "synthetic", setup: identity => ({ topic_id: identity.topic_id, agent_id: identity.agent_id, conversation_id: identity.conversation_id,
        person: "p1", door: "door-fake", chat_name: "coffee", machine: "mac", machine_from: "person", runner: "runner-pi", preset: "daily", preset_from: "person",
        adapter: "synthetic", model: "m", initial_request: "hello", origin: { door: "door-fake", chat: LAIR, agent: "p1-lair" }, requested_by: "p1" }) })
    expect(await ask("adopt", made.agent_id, RESEARCH)).toMatchObject({ status: "refused", cause: "invalid configuration" })
    expect(await ask("retire", made.agent_id)).toMatchObject({ status: "refused", cause: "invalid configuration" })
    expect(before()).toBe(file)
    expect((await diary(made.agent_id)).join("\n")).toContain("topic-managed")

    // A legacy master that is linked follows its repair onto another chat, and is not retired out from under its lifecycle once archived.
    const legacy = await linkLegacyTopic(store, { person: "p1", agent: "p1-lair", door: "door-fake", chat: LAIR, machine: "mac", runner: "runner-pi", preset: "daily",
      adapter: "synthetic", display_name: "p1-lair" })
    expect(await ask("adopt", "p1-lair", RESEARCH)).toMatchObject({ status: "applied", cause: null })
    expect(loadRegistry(it.registryFile).agents.find(one => one.id === "p1-lair")!.chat).toBe(RESEARCH)
    expect((await readTopicByAgent(store, "p1-lair"))!.chat).toBe(RESEARCH)
    await store.sql`update topic set lifecycle = 'archiving' where id = ${legacy.id}`
    const archived = before()
    expect(await ask("retire", "p1-lair", undefined, RESEARCH)).toMatchObject({ status: "refused", cause: "invalid configuration" })
    expect(before()).toBe(archived)
    expect((await diary("p1-lair")).join("\n")).toContain("topic-managed")
  } finally { await hub?.stop(); await store.close(); await it.stop() }
}, 90_000)

// ---------------------------------------------------------------------------------------------
// A legacy master keeps working through the old verbs
// ---------------------------------------------------------------------------------------------

/** The real hub over the household above, with `ask` as the old verbs are asked: a row planted the way the door writes one. */
async function withHub(run: (h: {
  it: Awaited<ReturnType<typeof rolloutStage>>
  store: Awaited<ReturnType<typeof superStore>>
  adapter: string
  ask: (operation: "adopt" | "retire", target: string, chat?: string, from?: string, commander?: string) => Promise<Record<string, unknown>>
  diary: (target: string) => Promise<string>
  file: () => string
}) => Promise<void>): Promise<void> {
  const it = await rolloutStage(cluster, "discord", household())
  const store = await superStore(cluster, it.db)
  let hub: Awaited<ReturnType<typeof runHub>> | undefined
  try {
    hub = await runHub({ registryFile: it.registryFile, machine: "mac", os: inertOs(it.stateDir).os })
    let n = 0
    // The commander is an agent whose chat the command is typed in NOW: p1-lair by default, and another when p1-lair is the one being changed.
    const ask = async (operation: "adopt" | "retire", target: string, chat?: string, from = LAIR, commander = "p1-lair") => {
      const id = `agent:legacy-${++n}`
      await store.sql`insert into state_row (sheet, id, data) values ('control', ${id}, ${{
        id, actor: "p1", source: "chat", person: "p1", target_kind: "agent-lifecycle", target_id: target,
        requested_at: new Date().toISOString(), status: "pending", cause: null, door: "door-fake", agent: commander,
        route: { door: "door-fake", chat: from }, operation, arguments: chat === undefined ? {} : { chat },
      }})`
      await store.sql`select pg_notify('hub_control', ${id})`
      expect(await observe(async () => (await it.read.sheet("control")).some(row => row.id === id && row.data.status !== "pending"), 10000), `${operation} ${target} was answered`).toBe(true)
      return (await it.read.sheet("control")).find(row => row.id === id)!.data
    }
    const diary = async (target: string) => (await it.read.ledger()).filter(one => one.subject === target && one.kind === "failed").map(one => String(one.detail.cause)).join("\n")
    await run({ it, store, adapter: loadRegistry(it.registryFile).presets.daily.adapter, ask, diary, file: () => readFileSync(it.registryFile, "utf8") })
  } finally { await hub?.stop(); await store.close(); await it.stop() }
}

const link = (store: Awaited<ReturnType<typeof superStore>>, agent: string, chat: string, adapter: string, over: { runner?: string } = {}) =>
  linkLegacyTopic(store, { person: "p1", agent, door: "door-fake", chat, machine: "mac", runner: over.runner ?? "runner-pi", preset: "daily", adapter, display_name: agent })

test("an ACTIVE adopted master can still be retired and adopted again, as itself: the same topic, conversation, preset and runner on the chat it is adopted onto, and no blanket ban on retiring", async () => {
  await withHub(async ({ it, store, adapter, ask, file }) => {
    const legacy = await link(store, "p1-lair", LAIR, adapter)
    const history = (await store.sql`select id from conversation where agent = 'p1-lair'`).map((row: { id: string }) => row.id)
    expect(history).toEqual([legacy.conversation_id])
    // Retired from the chat of another of the person's agents: the entry goes, the topic is left as it was, and nothing was refused.
    expect(await ask("retire", "p1-lair", undefined, OTHER, "p2-lair")).toMatchObject({ status: "applied", cause: null })
    expect(loadRegistry(it.registryFile).agents.find(one => one.id === "p1-lair")).toBeUndefined()
    expect(await readTopicByAgent(store, "p1-lair")).toMatchObject({ id: legacy.id, lifecycle: "active", chat: LAIR })
    // Adopted again onto another chat: the same identity comes back, with the preset and the runner it had.
    expect(await ask("adopt", "p1-lair", RESEARCH, OTHER, "p2-lair")).toMatchObject({ status: "applied", cause: null })
    const entry = loadRegistry(it.registryFile).agents.find(one => one.id === "p1-lair")
    expect(entry).toMatchObject({ id: "p1-lair", person: "p1", preset: "daily", chat: RESEARCH, door: "door-fake", runner: "runner-pi" })
    expect(await readTopicByAgent(store, "p1-lair")).toMatchObject({ id: legacy.id, conversation_id: legacy.conversation_id, lifecycle: "active", chat: RESEARCH })
    expect((await store.sql`select id from conversation where agent = 'p1-lair'`).map((row: { id: string }) => row.id)).toEqual(history)
    expect(file()).toContain(`chat = "${RESEARCH}"`)
  })
}, 90_000)

test("every guard of the old verbs stays where it was: a re-adopt of a retired master that was made by the Hub, is archived, is gone, has another runner or has retired history is refused by name, and the file is never touched", async () => {
  await withHub(async ({ it, store, adapter, ask, diary, file }) => {
    // A topic that vanished with its chat is not retired: it is repaired, or it waits.
    const gone = await link(store, "p1-lair", LAIR, adapter)
    await markChannelMissing(store, gone.id, { read: "unknown-channel" }, null)
    const before = file()
    expect(await ask("retire", "p1-lair", undefined, OTHER, "p2-lair")).toMatchObject({ status: "refused", cause: "invalid configuration" })
    expect(await diary("p1-lair")).toContain("topic-managed: a topic master is archived or deleted, not retired")
    expect(file()).toBe(before)
    expect(loadRegistry(it.registryFile).agents.find(one => one.id === "p1-lair")).toBeDefined()

    // Another runner than the one this machine keeps running: the chat's history was made there.
    const away = await link(store, "p2-lair", OTHER, adapter, { runner: "runner-elsewhere" })
    expect(await ask("retire", "p2-lair", undefined, LAIR)).toMatchObject({ status: "applied" })
    const untouched = file()
    expect(await ask("adopt", "p2-lair", RESEARCH, LAIR)).toMatchObject({ status: "refused", cause: "invalid configuration" })
    expect(await diary("p2-lair")).toContain("the runner that served this chat is not the one this machine keeps running")
    expect(file()).toBe(untouched)
    expect(await readTopicByAgent(store, "p2-lair")).toMatchObject({ id: away.id, chat: OTHER })

    // The runner is the right one, and the history's own identity was retired: never used again.
    await store.sql`update topic set runner = 'runner-pi' where agent_id = 'p2-lair'`
    await reserveIdentity(store, "conversation", away.conversation_id, "history erased")
    expect(await ask("adopt", "p2-lair", RESEARCH, LAIR)).toMatchObject({ status: "refused", cause: "invalid configuration" })
    expect(await diary("p2-lair")).toContain("identity-reserved: this chat's history was retired")
    expect(file()).toBe(untouched)
  })
}, 90_000)

test("a master whose chat was deleted while it was ACTIVE is repaired by the old adopt verb and comes back as itself: only its missing gate is released, holds and other gates stay, and a hub that died after the file was edited finds it done", async () => {
  await withHub(async ({ it, store, adapter, ask, file }) => {
    const legacy = await link(store, "p1-lair", LAIR, adapter)
    await store.sql`insert into inbound (id, person, agent, body, kind) values ('held-input', 'p1', 'p1-lair', 'interrupted', 'human')`
    await store.sql`insert into execution (id, inbound_id, conversation_id, agent, runner, incarnation, placement_generation, state, input_digest)
      values ('held-attempt', 'held-input', ${legacy.conversation_id}, 'p1-lair', 'runner-pi', 'inc-1', 1, 'running', 'd')`
    await store.sql`update execution set state = 'stopped', ended_at = now() where id = 'held-attempt'`
    await store.sql`insert into replay_hold (inbound_id, execution_id, conversation_id, cause, state) values ('held-input', 'held-attempt', ${legacy.conversation_id}, 'stopped', 'held')`
    await store.sql`select hub_gate_place('op-other', 'agent', 'p1-lair', 'council', '{}'::jsonb)`
    await observeChannel(store, legacy.id, { present: true, parent_id: null, name: "old" }, null)
    expect(await markChannelMissing(store, legacy.id, { read: "unknown-channel" }, null)).toBe("ok")

    // The file was edited to the new chat and the hub died before the topic followed: the topic is still gated and says the old chat.
    await setKey(it.registryFile, "agents[p1-lair]", "chat", RESEARCH)
    expect(await readTopicByAgent(store, "p1-lair")).toMatchObject({ lifecycle: "channel_missing", chat: LAIR })
    // Asked again, the repair finishes without a second edit of the file.
    const edited = file()
    expect(await ask("adopt", "p1-lair", RESEARCH, OTHER, "p2-lair")).toMatchObject({ status: "applied", cause: null })
    expect(file()).toBe(edited)
    expect(await readTopicByAgent(store, "p1-lair")).toMatchObject({ id: legacy.id, conversation_id: legacy.conversation_id, lifecycle: "active", chat: RESEARCH, missing_from: null })
    expect(await readSeen(store, legacy.id)).toBeNull()
    expect((await store.sql`select state from claim_gate where operation_id = ${`missing:${legacy.id}:1`}`)[0].state).toBe("released")
    expect((await store.sql`select state from claim_gate where operation_id = 'op-other'`)[0].state).toBe("open")
    expect((await store.sql`select hub_row_held('held-input') as held`)[0].held).toBe(true)
    expect((await store.sql`select state, stage from topic_transition where topic_id = ${legacy.id} and kind = 'deletion_request'`)[0]).toEqual({ state: "failed", stage: "repaired" })
    // Asked once more: the same answer, and nothing more happens.
    expect(await ask("adopt", "p1-lair", RESEARCH, OTHER, "p2-lair")).toMatchObject({ status: "applied", cause: null })
    expect(file()).toBe(edited)
  })
}, 90_000)

test("a master whose chat was deleted while it was being archived is not brought back by the old adopt verb: refused by name before the file is touched, still gated, and nothing of the old chat's archive is applied to a replacement", async () => {
  await withHub(async ({ it, store, adapter, ask, diary, file }) => {
    const legacy = await link(store, "p1-lair", LAIR, adapter)
    await store.sql`update topic set lifecycle = 'archiving' where id = ${legacy.id}`
    expect(await markChannelMissing(store, legacy.id, { read: "unknown-channel" }, null)).toBe("ok")
    const before = file()
    expect(await ask("adopt", "p1-lair", RESEARCH, OTHER, "p2-lair")).toMatchObject({ status: "refused", cause: "invalid configuration" })
    expect(await diary("p1-lair")).toContain("that archive still holds it")
    expect(file()).toBe(before)
    expect(loadRegistry(it.registryFile).agents.find(one => one.id === "p1-lair")!.chat).toBe(LAIR)
    expect(await readTopicByAgent(store, "p1-lair")).toMatchObject({ id: legacy.id, lifecycle: "channel_missing", chat: LAIR, missing_from: "archiving" })
    expect((await store.sql`select state from claim_gate where operation_id = ${`missing:${legacy.id}:1`}`)[0].state).toBe("open")
  })
}, 90_000)
