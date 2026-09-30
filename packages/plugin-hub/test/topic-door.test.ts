// A topic chat through a REAL door, end to end: the tool freezes the preview, the door delivers it
// and reads the owner's check on its own tick, the door's topic task makes the channel and stores
// the owner's request, the owner writes in the new chat before its agent exists, the hub binds the
// agent to the machine that was chosen (which is not running), and the door then reads the new chat
// from its start. The order is the point: the owner's request is the first thing the new agent
// has, and nothing written while the chat was being set up is skipped as history.
//
// Real store, real door, real tool handlers, the real Discord seam over a fake Discord.

import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { startCluster, until, type Cluster } from "./helpers/cluster.ts"
import { CHECK, createFakeDiscord } from "./helpers/fake-discord-rest.ts"
import { AGENT, DOOR, PERSON, RUNNER, RUNNER2, stageHub } from "./helpers/hub-fixture.ts"
import { discord } from "../src/door/platforms/discord.ts"
import { runDoor } from "../src/door/run.ts"
import { bindTopics } from "../src/hub/topics.ts"
import { appendEntry } from "../src/registry/edit.ts"
import { callTool, type McpBinding } from "../src/mcp/handlers.ts"
import { loadRegistry } from "../src/registry/load.ts"
import { storeUrlAs, type StoreLike } from "../src/store/connect.ts"
import { conversationFor } from "../src/store/conversations.ts"
import { readTopic } from "../src/store/topics.ts"

let cluster: Cluster
beforeAll(async () => { cluster = await startCluster() })
afterAll(async () => { await cluster?.stop() })

const OWNER = "100000000000000001"
const REQUEST = "Compare the two vendors, and keep it short."

test("through a real door: the request is the new agent's first input, a message sent while the chat was being set up is read from the start of the chat, and an offline machine only waits", async () => {
  const fake = createFakeDiscord({ start: Date.now() })
  const general = fake.addChannel({ name: "general" })
  const it = await stageHub(cluster, {
    hub: { tick_seconds: 1 },
    machines: [{ id: "pi", os: "linux" }, { id: "mac", os: "macos" }],
    people: [{ id: PERSON, allowed_senders: { [DOOR]: [OWNER] }, topic_machine: "mac", topic_preset: "daily", general: AGENT } as never],
    run: [
      { id: DOOR, kind: "door", machine: "pi", platform: "discord", person: PERSON, token_file: "/dev/null", schedule: "always", memory_limit_mb: 192, guild: fake.guild },
      { id: RUNNER, kind: "runner", machine: "pi", schedule: "always", memory_limit_mb: 512, child_memory_limit_mb: 512 },
      { id: RUNNER2, kind: "runner", machine: "mac", schedule: "always", memory_limit_mb: 512, child_memory_limit_mb: 2048 },
    ],
    registry: base => ({ ...base, agents: (base.agents ?? []).map(one => ({ ...one, chat: general })) }),
  })
  const dir = mkdtempSync(join(tmpdir(), "hub-topic-door-"))
  const tokenFile = join(dir, "token")
  writeFileSync(tokenFile, "placeholder-token\n", "utf8")
  const platform = discord({ tokenFile, guild: fake.guild, fetch: fake.fetch })
  const admin = cluster.connect(it.db)
  const runner: StoreLike = { sql: cluster.connectAs("hub_runner", it.db), url: storeUrlAs(cluster.url(it.db), "hub_runner") }
  const hub: StoreLike = { sql: cluster.connectAs("hub_hub", it.db), url: storeUrlAs(cluster.url(it.db), "hub_hub") }
  const door = await runDoor({ door: DOOR, registryFile: it.registryFile, platform })
  try {
    // The owner asks General for the chat. The tool freezes the preview and creates nothing.
    const said = async (id: string, text: string) => {
      await admin`insert into inbound (id, person, agent, body, kind, source) values (${id}, ${PERSON}, ${AGENT}, ${text}, 'human',
        ${{ log_id: id, at: new Date().toISOString(), door: DOOR, chat: general, sender_id: OWNER, text }}::jsonb)`
    }
    await said("h-1", "hello")
    const conversation = await conversationFor(runner, { row: { id: "h-1", person: PERSON, agent: AGENT, kind: "human" }, adapter: "claude-code", machine: "pi" })
    const binding: McpBinding = { store: runner, person: PERSON, agent: AGENT, conversation: conversation.id, kind: "master",
      registry: () => loadRegistry(it.registryFile), attempt: () => null }
    await said("h-2", "make a coffee chat")
    const reply = await callTool(binding, "hub_topic", { action: "create", request_key: "k-1", source_message_ids: ["h-2"],
      setup: { chat_name: "coffee", initial_request: REQUEST } })
    expect(reply).toMatchObject({ status: "awaiting_confirmation" })
    expect(reply.setup).toMatchObject({ execution_machine: { value: "mac", from: "person" } })
    const topicId = String(reply.object_id)
    expect(fake.requestsTo(new RegExp(`^POST /guilds/${fake.guild}/channels$`))).toHaveLength(0)

    // The door delivers the preview on its own and waits for the owner's check.
    await until("the door delivered the preview and its confirmation line", () => fake.messagesIn(general).length === 2, 20_000,
      () => JSON.stringify(fake.messagesIn(general).map(one => one.content)))
    const confirmation = fake.messagesIn(general).find(one => one.content.includes("sha256:"))!
    fake.react(general, confirmation.id, CHECK, OWNER)

    // The check is read from the platform, approves once, and the channel is made once.
    await until("the channel was made and its request stored", async () =>
      ["channel_known", "bind_intent", "bound"].includes((await readTopic(hub, topicId))!.create_state), 30_000,
      async () => JSON.stringify(await readTopic(hub, topicId)))
    const topic = (await readTopic(hub, topicId))!
    const chat = topic.chat!
    expect(fake.requestsTo(new RegExp(`^POST /guilds/${fake.guild}/channels$`))).toHaveLength(1)

    // The owner writes in the new chat before its agent exists.
    fake.say(chat, "one more thing", OWNER)

    // The hub binds the agent to the MAC's runner (the hub is on the pi), and the mac is not running.
    await bindTopics({ store: hub, registryFile: it.registryFile, machine: "pi", load: () => loadRegistry(it.registryFile, { machine: "pi" }) })
    expect(loadRegistry(it.registryFile).agents.find(agent => agent.id === topic.agent_id)).toMatchObject({ chat, door: DOOR, runner: RUNNER2 })

    // The door serves the new agent on its next tick and reads its chat from the very start.
    await until("the door read the message sent while the chat was being set up", async () =>
      Number((await admin`select count(*)::int as n from inbound where agent = ${topic.agent_id} and id like 'discord:%'`)[0].n) === 1, 30_000,
      async () => JSON.stringify(await admin`select id, body from inbound where agent = ${topic.agent_id}`))
    const rows = await admin`select id, body from inbound where agent = ${topic.agent_id} order by received_at, id`
    expect(rows.map((row: { id: string }) => row.id)).toEqual([`topic-create:${topicId}`, expect.stringMatching(new RegExp(`^discord:${chat}:`))])
    expect(rows.map((row: { body: string }) => row.body)).toEqual([REQUEST, "one more thing"])
    // The chat's position was never asked of the platform as "where does it stand now": nothing was skipped as history.
    expect(fake.requestsTo(new RegExp(`^GET /channels/${chat}/messages$`)).filter(one => one.query.after === undefined)).toHaveLength(0)

    // The machine that was chosen is offline: one status line says so, edited in place, and the request is not lost.
    await until("the chat says it is waiting for the mac", () => fake.messagesIn(chat).some(one => one.author === fake.botId && one.content.startsWith("Waiting for mac")), 30_000,
      () => JSON.stringify(fake.messagesIn(chat).map(one => one.content)))
    await until("General was told the chat is made and waiting", () => fake.messagesIn(general).some(one => one.content.includes(`<#${chat}>`)), 30_000,
      () => JSON.stringify(fake.messagesIn(general).map(one => one.content)))
    expect(fake.messagesIn(chat).filter(one => one.author === fake.botId)).toHaveLength(1)
    expect((await admin`select claimed_by from inbound where id = ${`topic-create:${topicId}`}`)[0].claimed_by).toBeNull()
    expect(Number((await admin`select count(*)::int as n from confirmation where state = 'approved'`)[0].n)).toBe(1)
  } finally {
    await door.stop()
    await runner.sql.close().catch(() => {})
    await hub.sql.close().catch(() => {})
    await admin.close().catch(() => {})
    await it.stop()
    rmSync(dir, { recursive: true, force: true })
  }
})

test("through a real door: the ordinary masters the registry already names are topics from the start, and one that is adopted later is linked on the door's own tick, with no tool call and with the task resting in between", async () => {
  const fake = createFakeDiscord({ start: Date.now() })
  const general = fake.addChannel({ name: "general" })
  const archive = fake.addChannel({ name: "archive", type: 4 })
  const later = fake.addChannel({ name: "later" })
  const it = await stageHub(cluster, {
    hub: { tick_seconds: 1 },
    machines: [{ id: "pi", os: "linux" }, { id: "mac", os: "macos" }],
    people: [{ id: PERSON, allowed_senders: { [DOOR]: [OWNER] }, topic_machine: "mac", topic_preset: "daily", general: AGENT } as never],
    run: [
      { id: DOOR, kind: "door", machine: "pi", platform: "discord", person: PERSON, token_file: "/dev/null", schedule: "always", memory_limit_mb: 192,
        guild: fake.guild, archive_category: archive, archive_readonly_roles: [fake.guild] },
      { id: RUNNER, kind: "runner", machine: "pi", schedule: "always", memory_limit_mb: 512, child_memory_limit_mb: 512 },
      { id: RUNNER2, kind: "runner", machine: "mac", schedule: "always", memory_limit_mb: 512, child_memory_limit_mb: 2048 },
    ],
    registry: base => ({ ...base, agents: (base.agents ?? []).map(one => ({ ...one, chat: general })) }),
  })
  const dir = mkdtempSync(join(tmpdir(), "hub-topic-door-backfill-"))
  const tokenFile = join(dir, "token")
  writeFileSync(tokenFile, "placeholder-token\n", "utf8")
  const platform = discord({ tokenFile, guild: fake.guild, fetch: fake.fetch })
  const admin = cluster.connect(it.db)
  const door = await runDoor({ door: DOOR, registryFile: it.registryFile, platform })
  try {
    // At start: the master that is there is a topic, with no tool call and nobody having asked for anything.
    await until("the master the registry names was linked", async () =>
      Number((await admin`select count(*)::int as n from topic where agent_id = ${AGENT}`)[0].n) === 1, 20_000,
      async () => JSON.stringify(await admin`select agent_id, lifecycle from topic`))
    const linked = (await admin`select origin, create_state, lifecycle, chat from topic where agent_id = ${AGENT}`)[0]
    expect(linked).toMatchObject({ origin: "legacy", create_state: "legacy", lifecycle: "active", chat: general })
    expect(Number((await admin`select count(*)::int as n from topic_transition`)[0].n)).toBe(0)

    // Adopted later, the way the hub does it: one entry appended to the registry. The door sees it on its tick and wakes the task.
    await appendEntry(it.registryFile, "agents", { id: "p1-later", person: PERSON, preset: "daily", chat: later, door: DOOR, runner: RUNNER })
    await until("the master adopted later was linked on the door's own tick", async () =>
      Number((await admin`select count(*)::int as n from topic where agent_id = 'p1-later'`)[0].n) === 1, 20_000,
      async () => JSON.stringify(await admin`select agent_id, lifecycle from topic`))
    expect((await admin`select origin, lifecycle, chat from topic where agent_id = 'p1-later'`)[0]).toMatchObject({ origin: "legacy", lifecycle: "active", chat: later })
    expect(Number((await admin`select count(*)::int as n from topic`)[0].n)).toBe(2)
    // Linking starts nothing.
    expect(Number((await admin`select count(*)::int as n from claim_gate`)[0].n)).toBe(0)
    expect(Number((await admin`select count(*)::int as n from topic_transition`)[0].n)).toBe(0)
  } finally {
    await door.stop()
    await admin.close().catch(() => {})
    await it.stop()
    rmSync(dir, { recursive: true, force: true })
  }
})
