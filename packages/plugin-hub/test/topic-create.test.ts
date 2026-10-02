// Confirmed topic creation, end to end below the model: the tool freezes an exact preview and
// nothing else, the owner's check (and only theirs) confirms it, the door makes the channel
// once and stores the owner's request as the new agent's first input, and the hub binds that
// agent to the machine the owner chose, whether or not it is running.
//
// Real store, real door task, real tool handlers and the real Discord seam over a fake
// Discord. A "restart" is a new memory for the topic task over the same database and the same
// fake, and time is the fake's clock, so nothing sleeps. What is planted decides nothing the
// code under test decides: the owner's messages, and a runner that is "online" is a connection
// with its name, which is what the door's own waiting line reads.

import { afterAll, afterEach, beforeAll, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { openStore, storeUrlAs } from "../src/store/connect.ts"
import { startCluster, until, type Cluster } from "./helpers/cluster.ts"
import { closeStages, removeEffectDirs } from "./helpers/effects-fixture.ts"
import { chatLogLines } from "./helpers/hub-fixture.ts"
import { DOOR, GENERAL, OWNER, PERSON, RUNNER_MAC, RUNNER_PI, STRANGER, stageTopics, type TopicsStage } from "./helpers/topics-fixture.ts"
import { ToolError } from "../src/mcp/contracts.ts"
import { callTool } from "../src/mcp/handlers.ts"
import { agentBlockOf, bindTopics } from "../src/hub/topics.ts"
import { REGISTRY_SHEET } from "../src/hub/digest.ts"
import { putRow } from "../src/records/statesheet.ts"
import { appendEntry } from "../src/registry/edit.ts"
import { loadRegistry } from "../src/registry/load.ts"
import { previewHash, readOperation } from "../src/store/confirmations.ts"
import { bindIntent, readTopic, setTopicStatus, type TopicRow } from "../src/store/topics.ts"
import { topicConfirmationAsk } from "../src/door/topic-lines.ts"
import { topicFindings } from "../src/check/topics.ts"

let cluster: Cluster
beforeAll(async () => { cluster = await startCluster() })
afterEach(closeStages)
afterAll(async () => {
  removeEffectDirs()
  await cluster?.stop()
})

const REQUEST = "Compare the two vendors, and keep it short."
const setup = (over: Record<string, unknown> = {}) => ({ chat_name: "coffee", initial_request: REQUEST, ...over })
const createPosts = (s: TopicsStage) => s.fake.requestsTo(new RegExp(`^POST /guilds/${s.fake.guild}/channels$`))
const count = async (s: TopicsStage, table: string, where = "true") =>
  Number((await s.admin.unsafe(`select count(*)::int as n from ${table} where ${where}`))[0].n)
const topicOf = async (s: TopicsStage, reply: Record<string, unknown>): Promise<TopicRow> => (await readTopic(s.as("hub_hub"), String(reply.object_id)))!
const topicById = async (s: TopicsStage, id: string): Promise<TopicRow> => (await readTopic(s.as("hub_hub"), id))!
const code = async (run: Promise<unknown>): Promise<string> => {
  try { await run; return "no error" } catch (error) { return error instanceof ToolError ? error.code : `not a ToolError: ${(error as Error).message}` }
}

/** The owner asks, the door delivers the preview, and the owner reacts: the topic is confirmed. */
async function confirmed(s: TopicsStage, over: Record<string, unknown> = {}) {
  const master = await s.binding()
  const reply = await s.ask(master, { action: "create", setup: setup(over) })
  await s.deliver()
  await s.react(String(reply.operation_id))
  return { master, reply }
}

test("asking freezes an exact preview and nothing else: both defaults are resolved and shown before anything is hashed, and nothing outside the store has happened", async () => {
  const s = await stageTopics(cluster)
  const master = await s.binding()
  const reply = await s.ask(master, { action: "create", setup: setup() })
  expect(reply).toMatchObject({ status: "awaiting_confirmation", stage: "preview", revision: 1 })
  // The tool tells the model what both defaults resolved to and who said so, so it can tell the owner.
  expect(reply.setup).toEqual({ chat: "coffee", execution_machine: { value: "pi", from: "person" },
    agent: { preset: "daily", from: "person", engine: "synthetic", model: "m-daily" } })
  // No channel, no registry entry, no message: a preview is a promise of nothing.
  expect(createPosts(s)).toHaveLength(0)
  expect(s.load().agents).toHaveLength(1)
  expect(await count(s, "inbound", "id like 'topic-create:%'")).toBe(0)
  const topic = await topicOf(s, reply)
  expect(topic).toMatchObject({ create_state: "previewed", lifecycle: "pending", machine: "pi", runner: "runner-pi", preset: "daily", display_name: "coffee" })
  expect(topic.setup).toMatchObject({ initial_request: REQUEST, machine_from: "person", preset_from: "person", requested_by: OWNER,
    origin: { door: DOOR, chat: s.general, agent: GENERAL } })
  // What is frozen carries the three identities and none of the topic's internals.
  expect(topic.setup).not.toHaveProperty("marker")
  expect(topic.setup).not.toHaveProperty("native_session")

  await s.deliver()
  const said = s.texts(s.general)
  expect(said).toHaveLength(2)
  const shown = `Chat: coffee\nExecution machine: pi\nAgent: synthetic (m-daily)\n\n${REQUEST}`
  // The labels in the owner's order, then the request verbatim, then only the marker line the ledger puts under every message.
  expect(said[0].split("\n").slice(0, -1).join("\n")).toBe(shown)
  expect(said[0].split("\n").at(-1)).toMatch(/^`hub:[0-9a-f]{16}`$/)
  const rows = await readOperation(s.as("hub_hub"), String(reply.operation_id))
  expect(rows).toHaveLength(1)
  // What is hashed is what is shown.
  expect(rows[0].payload_hash).toBe(previewHash("topic.create", topic.setup, shown, topicConfirmationAsk("en")))
  expect(said[1].startsWith(topicConfirmationAsk("en"))).toBe(true)
  expect(said[1]).toContain(`sha256:${rows[0].payload_hash}`)

  // An explicit choice overrides the default, per field, and the tool says it came from the request.
  const other = await s.ask(master, { action: "create", setup: setup({ chat_name: "tea", execution_machine: "mac", preset: "fast" }) })
  expect(other.setup).toMatchObject({ execution_machine: { value: "mac", from: "request" }, agent: { preset: "fast", from: "request", model: "m-fast" } })
  const tea = await topicOf(s, other)
  expect(tea).toMatchObject({ runner: "runner-mac", machine: "mac", preset: "fast" })
  expect(tea.id).not.toBe(topic.id)
  expect(tea.agent_id).not.toBe(topic.agent_id)
})

test("a missing or invalid configuration is a refusal that names it, before any preview exists, and a tool profile never names a tool that delegates", async () => {
  const s = await stageTopics(cluster, { person: { topic_machine: undefined } })
  const master = await s.binding()
  expect(await s.ask(master, { action: "create", setup: setup() })).toMatchObject({ status: "failed", cause: "execution_machine_missing" })
  expect(await s.ask(master, { action: "create", setup: setup({ execution_machine: "cloud" }) })).toMatchObject({ cause: "execution_machine_unknown" })
  expect(await s.ask(master, { action: "create", setup: setup({ execution_machine: "pi", preset: "gigantic" }) })).toMatchObject({ cause: "preset_unknown" })
  expect(await s.ask(master, { action: "create", setup: setup({ execution_machine: "pi", tool_profile: ["WebFetch", "Task"] }) })).toMatchObject({ cause: "tool_profile_refused" })
  // Nothing was made by any of them, and none of the owner's messages was spent on a request that did not happen.
  expect(await count(s, "topic")).toBe(0)
  expect(await count(s, "confirmation")).toBe(0)
  expect(await count(s, "source_consumption")).toBe(0)
  // A profile of working tools is shown after the request and travels with the setup.
  const reply = await s.ask(master, { action: "create", setup: setup({ execution_machine: "pi", tool_profile: ["WebFetch"] }) })
  expect(reply.setup).toMatchObject({ tools: ["WebFetch"] })
  await s.deliver()
  expect(s.texts(s.general)[0].split("\n").slice(0, -1).join("\n")).toBe(`Chat: coffee\nExecution machine: pi\nAgent: synthetic (m-daily)\n\n${REQUEST}\n\nTools: WebFetch`)
  // Only a chat's own master can ask, and the owner's own words have to be cited.
  expect(await code(callTool({ ...master, kind: "worker" }, "hub_topic", { action: "create", request_key: "k", source_message_ids: ["x"], setup: setup() }))).toBe("not_owner_conversation")
  expect(await code(callTool(master, "hub_topic", { action: "create", request_key: "k2", setup: setup() }))).toBe("invalid_arguments")
  expect(await code(callTool(master, "hub_topic", { action: "create", request_key: "k3", source_message_ids: ["nothing"], setup: setup() }))).toBe("source_invalid")
  expect(await code(callTool(master, "hub_topic", { action: "create", request_key: "k4", source_message_ids: [await s.said("hi", { sender: STRANGER })], setup: setup() }))).toBe("source_invalid")
  // A field a model could invent to approve its own request does not exist.
  expect(await code(callTool(master, "hub_topic", { action: "create", request_key: "k5", source_message_ids: [await s.said("hi")], setup: setup(), approved: true }))).toBe("invalid_arguments")
  expect(await code(callTool(master, "hub_topic", { action: "confirm", request_key: "k6" }))).toBe("unsupported_action")
})

test("only the owner's check approves the preview that stands: another user, a bot and a check on a replaced preview approve nothing, and a correction names the revision it replaces", async () => {
  const s = await stageTopics(cluster)
  const master = await s.binding()
  const first = await s.ask(master, { action: "create", setup: setup() })
  const op = String(first.operation_id)
  await s.deliver()
  const hub = s.as("hub_hub")
  const state = async () => (await readOperation(hub, op)).map(one => [one.revision, one.state])
  // Somebody else's check, and a bot's, are not the owner's.
  await s.react(op, STRANGER)
  await s.react(op, "900000000000000009", { bot: true })
  expect(await state()).toEqual([[1, "pending"]])
  expect((await topicOf(s, first)).create_state).toBe("previewed")

  // A correction that is not about the preview that stands is refused, and leaves it standing.
  expect(await s.ask(master, { action: "create", topic_id: first.object_id, expected_revision: 7, setup: setup({ initial_request: "changed" }) }))
    .toMatchObject({ status: "failed", cause: "stale_revision" })
  expect(await state()).toEqual([[1, "pending"]])
  // The correction replaces it: a new revision of the same topic, the old one superseded BEFORE anything of the new is posted.
  const old = await s.confirmationMessage(op)
  const second = await s.ask(master, { action: "create", topic_id: first.object_id, expected_revision: 1, setup: setup({ initial_request: "Compare three vendors instead." }) })
  expect(second).toMatchObject({ status: "awaiting_confirmation", revision: 2, object_id: first.object_id, operation_id: first.operation_id })
  expect(await state()).toEqual([[1, "superseded"], [2, "pending"]])
  const topic = await topicOf(s, second)
  expect(topic.setup.initial_request).toBe("Compare three vendors instead.")
  expect(topic).toMatchObject({ id: (await topicOf(s, first)).id, agent_id: (await topicOf(s, first)).agent_id })
  await s.deliver()
  expect(s.texts(s.general).filter(text => text.includes("Compare three vendors instead."))).toHaveLength(1)
  // The owner's check on the OLD message approves nothing of the new text.
  s.fake.react(s.general, old, "✅", OWNER)
  await s.poll()
  expect(await state()).toEqual([[1, "superseded"], [2, "pending"]])
  expect((await topicOf(s, first)).create_state).toBe("previewed")
  // Their check on the message that stands approves it, once, and the topic is confirmed in the same transaction.
  await s.react(op)
  expect(await state()).toEqual([[1, "superseded"], [2, "approved"]])
  const approved = await topicOf(s, first)
  expect(approved).toMatchObject({ create_state: "confirmed", confirmed_by: OWNER })
  expect(approved.confirmation_id).toBe((await readOperation(hub, op))[1].id)
  // An approved setup is not corrected: a change is a new request.
  expect(await s.ask(master, { action: "create", topic_id: first.object_id, expected_revision: 2, setup: setup({ initial_request: "late" }) }))
    .toMatchObject({ status: "failed", cause: "closed" })
})

test("a correction must cite words newer than the preview it corrects to the microsecond: a message a microsecond before or at the preview's creation is refused and spent on nothing, one a microsecond after revises it once", async () => {
  const s = await stageTopics(cluster)
  const master = await s.binding()
  const first = await s.ask(master, { action: "create", setup: setup() })
  const op = String(first.operation_id)
  const hub = s.as("hub_hub")
  const [standing] = await readOperation(hub, op)
  // The preview's creation is put at a whole number of milliseconds and half of one more, so that a microsecond either side of it is the same
  // millisecond: a bound cut to milliseconds would let the one before it through.
  await s.admin`update confirmation set created_at = date_trunc('milliseconds', created_at) + interval '500 microseconds' where id = ${standing.id}`
  const [t] = Array.from(await s.admin`select created_at::text as same, (created_at - interval '1 microsecond')::text as earlier, (created_at + interval '1 microsecond')::text as later,
    date_trunc('milliseconds', created_at - interval '1 microsecond') = date_trunc('milliseconds', created_at + interval '1 microsecond') as one_millisecond
    from confirmation where id = ${standing.id}`) as { same: string; earlier: string; later: string; one_millisecond: boolean }[]
  expect(t.one_millisecond).toBe(true)
  expect(new Set([t.earlier, t.same, t.later]).size).toBe(3)
  const owner = async (id: string, at: string) => {
    await s.admin`insert into inbound (id, person, agent, body, kind, source, received_at) values (${id}, ${PERSON}, ${GENERAL}, ${`words of ${id}`}, 'human',
      ${{ log_id: id, at: new Date().toISOString(), door: DOOR, chat: s.general, sender_id: OWNER, text: `words of ${id}` }}::jsonb, ${at}::timestamptz)`
  }
  await owner("us-earlier", t.earlier)
  await owner("us-same", t.same)
  await owner("us-later", t.later)

  const correction = "Compare three vendors instead."
  const correct = (source: string, over: Record<string, unknown> = {}) => callTool(master, "hub_topic", { action: "create", request_key: `fix-${source}`, topic_id: first.object_id,
    expected_revision: 1, source_message_ids: [source], setup: setup({ initial_request: correction }), ...over })
  const spent = () => count(s, "source_consumption", "source_id like 'us-%'")
  const state = async () => ({
    revisions: (await readOperation(hub, op)).map(one => [one.revision, one.state]),
    request: (await topicOf(s, first)).setup.initial_request,
    create_state: (await topicOf(s, first)).create_state,
    invocations: await count(s, "tool_invocation"),
    consumed: await count(s, "source_consumption"),
    confirmations: await count(s, "confirmation"),
  })
  const before = await state()
  expect(before).toMatchObject({ revisions: [[1, "pending"]], request: REQUEST, create_state: "previewed" })

  // A message before the preview, or at it, is refused whole: the preview, the setup and every count stand, and neither message is spent.
  for (const source of ["us-earlier", "us-same"]) {
    expect(await code(correct(source)), source).toBe("source_invalid")
    expect(await state(), source).toEqual(before)
    expect(await spent(), source).toBe(0)
  }

  // One a microsecond after it revises the same topic, once.
  expect(await correct("us-later")).toMatchObject({ status: "awaiting_confirmation", revision: 2, object_id: first.object_id, operation_id: first.operation_id })
  const revised = await state()
  expect(revised).toMatchObject({ revisions: [[1, "superseded"], [2, "pending"]], request: correction, create_state: "previewed",
    invocations: before.invocations + 1, consumed: before.consumed + 1, confirmations: before.confirmations + 1 })
  expect(await spent()).toBe(1)
  expect((await s.admin`select source_id from source_consumption where source_id like 'us-%'`).map((row: { source_id: string }) => row.source_id)).toEqual(["us-later"])

  // The same call again is the answer that was recorded and revises nothing more; the message that was refused is still not spent by a
  // later call, and the words that revised it are older than the preview that stands now.
  expect(await correct("us-later")).toMatchObject({ revision: 2 })
  expect(await state()).toEqual(revised)
  expect(await code(correct("us-same", { request_key: "fix-again", expected_revision: 2 }))).toBe("source_invalid")
  expect(await code(correct("us-later", { request_key: "fix-reuse", expected_revision: 2 }))).toBe("source_invalid")
  expect(await state()).toEqual(revised)
  expect(await spent()).toBe(1)
})

test("a repeated request, a repeated reaction, a restart and another pass make one channel, one topic and one first input", async () => {
  const s = await stageTopics(cluster)
  const master = await s.binding()
  const source = await s.said("please make a chat for coffee")
  const args = { action: "create", request_key: "fixed-key", source_message_ids: [source], setup: setup() }
  const one = await callTool(master, "hub_topic", args)
  // The same call is one request: the answer that was recorded, no second topic.
  expect(await callTool(master, "hub_topic", args)).toEqual(one)
  expect(await count(s, "topic")).toBe(1)
  expect(await code(callTool(master, "hub_topic", { ...args, request_key: "another-key" }))).toBe("source_already_used")
  expect(await code(callTool(master, "hub_topic", { ...args, setup: setup({ chat_name: "tea" }) }))).toBe("idempotency_conflict")
  expect(await count(s, "topic")).toBe(1)

  await s.deliver()
  await s.react(String(one.operation_id))
  await s.react(String(one.operation_id))
  await s.poll()
  expect(await count(s, "confirmation", "state = 'approved'")).toBe(1)
  for (let pass = 0; pass < 3; pass += 1) { await s.topicPass(); s.fake.advance(60_000) }
  s.restart()
  await s.topicPass()
  await s.react(String(one.operation_id))
  await s.topicPass()
  expect(createPosts(s)).toHaveLength(1)
  const topic = await topicOf(s, one)
  expect(topic.create_state).toBe("channel_known")
  expect(s.fake.channels().filter(channel => channel.topic === topic.marker)).toHaveLength(1)
  expect(await count(s, "inbound", `id = 'topic-create:${topic.id}'`)).toBe(1)
  // One topic of the Hub's making. (General is an ordinary master the door has linked as a topic of its own by now, which is not a second chat.)
  expect(await count(s, "topic", "origin = 'created'")).toBe(1)
})

test("the chat is made with the owner's request as the agent's FIRST input and the chat's first read position at its very start, so nothing sent while it was set up is lost", async () => {
  const s = await stageTopics(cluster)
  const { reply } = await confirmed(s)
  await s.topicPass()
  const topic = await topicOf(s, reply)
  const chat = topic.chat!
  const made = s.fake.channel(chat)!
  // A channel by the requested name, carrying only an opaque marker, and not deleted or renamed by anything after.
  expect(made).toMatchObject({ name: "coffee", topic: topic.marker, type: 0, parent_id: null })
  expect(topic.marker).not.toContain("coffee")
  expect(topic).toMatchObject({ create_state: "channel_known", lifecycle: "pending", initial_input_id: `topic-create:${topic.id}` })

  const [row] = await s.admin`select person, agent, body, kind, source, log_ready from inbound where id = ${`topic-create:${topic.id}`}`
  expect(row).toMatchObject({ person: PERSON, agent: topic.agent_id, body: REQUEST, kind: "human", log_ready: true })
  // Who asked and where the reply belongs: the owner, and the new chat, on this door.
  expect(row.source).toMatchObject({ door: DOOR, chat, sender_id: OWNER, text: REQUEST })
  expect(chatLogLines(s.dir, PERSON, topic.agent_id).map(line => line.text)).toEqual([REQUEST])
  // The first read position is the start of the chat, not where it stands now.
  const [cursor] = await s.admin`select data from state_row where sheet = 'door_cursor' and id = ${`${DOOR}/${chat}`}`
  expect(cursor.data).toEqual({ cursor: "0" })
  // The owner writes in it before its agent is bound; reading from that position finds it, and never the door's own line.
  s.fake.say(chat, "one more thing", OWNER)
  const pulled = await s.topicsContext().platform.pull({ chat, cursor: "0", timeoutMs: 0 })
  expect(pulled.messages.map(message => message.text)).toEqual(["one more thing"])
  // The first input was written before anything later could be: it is the oldest row of the new agent.
  const inputs = await s.admin`select id from inbound where agent = ${topic.agent_id} order by received_at, id`
  expect(inputs.map((one: { id: string }) => one.id)).toEqual([`topic-create:${topic.id}`])
})

test("an offline machine changes nothing: the chat is made, bound to THAT machine's runner and not the hub's, says Waiting for it once, and starts there when it is back", async () => {
  const s = await stageTopics(cluster)
  const { reply } = await confirmed(s, { execution_machine: "mac" })
  await s.topicPass()
  const topic = await topicOf(s, reply)
  expect(topic).toMatchObject({ create_state: "channel_known", machine: "mac", runner: "runner-mac" })

  // The hub is on the pi and binds the mac's runner, which is not its own.
  const hub = s.as("hub_hub")
  await bindTopics({ store: hub, registryFile: s.registryFile, machine: "pi", load: () => loadRegistry(s.registryFile, { machine: "pi" }) })
  expect(await readTopic(hub, topic.id)).toMatchObject({ create_state: "bound", lifecycle: "active", runner: "runner-mac" })
  expect(s.load().agents.find(agent => agent.id === topic.agent_id)).toMatchObject({
    person: PERSON, preset: "daily", chat: topic.chat, door: DOOR, runner: "runner-mac",
  })
  // Asking again binds nothing twice.
  await bindTopics({ store: hub, registryFile: s.registryFile, machine: "pi", load: () => loadRegistry(s.registryFile, { machine: "pi" }) })
  expect(s.load().agents.filter(agent => agent.id === topic.agent_id)).toHaveLength(1)

  // Nothing serves it: the chat says so, as one message, and where it was asked says the chat is made and waiting.
  await s.topicPass()
  await s.deliver()
  expect(s.texts(topic.chat!).map(text => text.split("\n")[0])).toEqual(["Waiting for mac"])
  const notices = await s.admin`select agent, body, route from outbox where notice_key = ${`topic:ready:${topic.id}`}`
  expect(notices).toHaveLength(1)
  expect(notices[0].agent).toBe(GENERAL)
  expect(notices[0].route).toEqual({ door: DOOR, chat: s.general })
  expect(notices[0].body).toContain(`<#${topic.chat}>`)
  expect(notices[0].body).toContain("Waiting for mac")
  // No second approval, no other machine, and the request is still waiting to be handled by that machine alone.
  expect(await count(s, "confirmation", "state = 'approved'")).toBe(1)
  expect((await readTopic(hub, topic.id))!.runner).toBe("runner-mac")
  expect(await count(s, "inbound", `id = 'topic-create:${topic.id}' and claimed_by is null`)).toBe(1)
  await s.topicPass()
  expect(s.texts(topic.chat!)).toHaveLength(1)

  // The machine's runner connects to the store. A connection is not serving: the line does not move, and it still says Waiting.
  const online = await openStore({ url: storeUrlAs(cluster.url(s.db), "hub_runner", RUNNER_MAC) })
  try {
    await s.topicPass()
    await s.deliver()
    expect(s.texts(topic.chat!)).toHaveLength(1)
    expect(s.texts(topic.chat!)[0].startsWith("Waiting for mac")).toBe(true)
    // The runner takes the owner's first message up (planted the way the runner claims a row): the SAME message says so, once, and
    // nothing is posted again. It says "Started", which is one moment, and not that the agent is running now.
    await s.admin`update inbound set claimed_by = ${RUNNER_MAC} where id = ${`topic-create:${topic.id}`}`
    await s.topicPass()
    await s.deliver()
    expect(s.texts(topic.chat!)).toHaveLength(1)
    expect(s.texts(topic.chat!)[0].startsWith("Started on mac")).toBe(true)
    expect(s.texts(topic.chat!)[0]).not.toContain("Running")
    // A restart says nothing new, and nothing follows the agent afterwards.
    s.restart()
    await s.topicPass()
    await s.deliver()
    expect(s.texts(topic.chat!)).toHaveLength(1)
    expect(await count(s, "outbox", `notice_key = 'topic:ready:${topic.id}'`)).toBe(1)
  } finally {
    await online.close()
  }
})

test("a create whose answer was lost is found again by its marker and never by its name, and it is asked for once", async () => {
  const s = await stageTopics(cluster)
  const { reply } = await confirmed(s)
  // A channel with the same name and no marker is somebody else's.
  const decoy = s.fake.addChannel({ name: "coffee" })
  s.fake.script(new RegExp(`^POST /guilds/${s.fake.guild}/channels$`), { kind: "drop", afterEffect: true })
  await s.topicPass()
  expect(createPosts(s)).toHaveLength(1)
  expect((await topicOf(s, reply)).create_state).toBe("create_intent")
  expect(s.fake.channels().filter(channel => channel.name === "coffee")).toHaveLength(2)
  // Nothing is asked for again on any restart or pass before the look is due.
  s.restart()
  await s.topicPass()
  expect(createPosts(s)).toHaveLength(1)
  // The look finds the one that carries the marker.
  s.fake.advance(31_000)
  await s.topicPass()
  const topic = await topicOf(s, reply)
  expect(topic.create_state).toBe("channel_known")
  expect(topic.chat).toBe(s.fake.channels().find(channel => channel.topic === topic.marker)!.id)
  expect(topic.chat).not.toBe(decoy)
  expect(createPosts(s)).toHaveLength(1)
  expect(s.fake.channel(decoy)!.topic).toBeNull()
})

test("when the outcome cannot be established it stays unknown: machinery never creates another, an empty look proves nothing, and only the owner's decision asks once more", async () => {
  const s = await stageTopics(cluster)
  const { master, reply } = await confirmed(s)
  // The request never arrives and the answer is a throw: from here it is not knowable that nothing was made.
  s.fake.script(new RegExp(`^POST /guilds/${s.fake.guild}/channels$`), { kind: "drop" })
  await s.topicPass()
  for (let look = 0; look < 6; look += 1) { s.fake.advance(31_000); await s.topicPass() }
  const topic = await topicOf(s, reply)
  expect(topic.create_state).toBe("creation_unknown")
  expect(createPosts(s)).toHaveLength(1)
  const said = await s.admin`select agent, body from outbox where notice_key = ${`topic:create-unknown:${topic.id}`}`
  expect(said).toHaveLength(1)
  expect(said[0].agent).toBe(GENERAL)
  expect(said[0].body).toContain("could not confirm whether the chat coffee was created")
  expect(said[0].body).toContain("Nothing was created again")
  // A restart looks once more, finds nothing, and changes nothing. No amount of time is proof.
  s.restart()
  s.fake.advance(3_600_000)
  await s.topicPass()
  await s.topicPass()
  expect((await topicOf(s, reply)).create_state).toBe("creation_unknown")
  expect(createPosts(s)).toHaveLength(1)
  // It is a finding, named, until it is decided.
  const findings = await topicFindings({ store: s.as("hub_hub"), registry: s.load(), machine: "pi", now: new Date(), doors: new Set([DOOR]), agents: [] })
  expect(findings.map(one => one.kind)).toEqual(["topic-creation-unknown"])
  // The owner decides. Only then is it asked for again, once.
  expect(await s.ask(master, { action: "create", topic_id: reply.object_id, creation_decision: { choice: "recreate" } })).toMatchObject({ status: "queued" })
  await s.topicPass()
  expect(createPosts(s)).toHaveLength(2)
  expect((await topicOf(s, reply)).create_state).toBe("channel_known")
  // And a decision is only ever about a creation that is unsettled.
  expect(await s.ask(master, { action: "create", topic_id: reply.object_id, creation_decision: { choice: "recreate" } })).toMatchObject({ status: "failed", cause: "closed" })
})

test("a listing that cannot be read is no proof either: the create is looked for and never repeated while the platform will not say", async () => {
  // A door with no archive mapping mirrors no chat, so its task lists the server only to look for this channel: the two failures
  // scripted below are the two looks, not the observation of the other chats a door with an archive watches (see topic-lifecycle).
  const s = await stageTopics(cluster, { door: { archive_category: undefined, archive_readonly_roles: undefined } })
  const { reply } = await confirmed(s)
  s.fake.script(new RegExp(`^POST /guilds/${s.fake.guild}/channels$`), { kind: "server_error", afterEffect: true })
  // The two looks the door makes before it gives up are the two that fail.
  s.fake.script(new RegExp(`^GET /guilds/${s.fake.guild}/channels$`), { kind: "server_error" }, { times: 2 })
  await s.topicPass()
  for (let look = 0; look < 4; look += 1) { s.fake.advance(31_000); await s.topicPass() }
  const topic = await topicOf(s, reply)
  // The channel WAS made (the fake handled it), the door could not read the list, so it does not know, and it does not make another.
  expect(topic.create_state).toBe("creation_unknown")
  expect(createPosts(s)).toHaveLength(1)
  expect(s.fake.channels().filter(channel => channel.name === "coffee")).toHaveLength(1)
  // When the list can be read again, a door that starts looks once more, finds it by its marker and moves to that channel, which is
  // the only way an unknown creation moves without the owner's decision.
  s.restart()
  await s.topicPass()
  const found = await topicOf(s, reply)
  expect(found.create_state).toBe("channel_known")
  expect(found.chat).toBe(s.fake.channels().find(channel => channel.topic === found.marker)!.id)
  expect(createPosts(s)).toHaveLength(1)
})

test("a create the platform refuses names the step, keeps everything and is not asked again, and nothing is deleted", async () => {
  const s = await stageTopics(cluster)
  const { master, reply } = await confirmed(s)
  s.fake.script(new RegExp(`^POST /guilds/${s.fake.guild}/channels$`), { kind: "refuse", status: 403, code: 50013 })
  await s.topicPass()
  const topic = await topicOf(s, reply)
  expect(topic.create_state).toBe("failed")
  expect(topic.create_failure).toMatchObject({ step: "channel", cause: "access denied" })
  const [notice] = await s.admin`select body from outbox where notice_key = ${`topic:create-failed:${topic.id}`}`
  expect(notice.body).toContain("creating the channel")
  expect(notice.body).toContain("access denied")
  expect(notice.body).toContain("Nothing was deleted and nothing was created again")
  for (let pass = 0; pass < 3; pass += 1) { s.fake.advance(3_600_000); await s.topicPass() }
  s.restart()
  await s.topicPass()
  expect(createPosts(s)).toHaveLength(1)
  expect(s.fake.requests().filter(one => one.method === "DELETE")).toHaveLength(0)
  expect(await count(s, "topic", "origin = 'created'")).toBe(1)
  // Only an explicit decision asks again, once the owner has fixed what was refused.
  expect(await s.ask(master, { action: "create", topic_id: reply.object_id, creation_decision: { choice: "recreate" } })).toMatchObject({ status: "queued" })
  await s.topicPass()
  expect(createPosts(s)).toHaveLength(2)
  expect((await topicOf(s, reply)).create_state).toBe("channel_known")
})

test("a rate limit on the create is waited out exactly, is not a failed attempt, and makes one channel", async () => {
  const s = await stageTopics(cluster)
  const { reply } = await confirmed(s)
  s.fake.script(new RegExp(`^POST /guilds/${s.fake.guild}/channels$`), { kind: "rate_limit", retryAfter: 5 }, { times: 2 })
  const first = await s.topicPass()
  expect(createPosts(s)).toHaveLength(1)
  expect((await topicOf(s, reply)).create_state).toBe("confirmed")
  expect(first).toBe(s.fake.now() + 5000)
  // Not before it is over: the seam holds the route, and nothing is sent.
  s.fake.advance(2000)
  await s.topicPass()
  expect(createPosts(s)).toHaveLength(1)
  s.fake.advance(4000)
  await s.topicPass()
  expect(createPosts(s)).toHaveLength(2)
  s.fake.advance(6000)
  await s.topicPass()
  expect(createPosts(s)).toHaveLength(3)
  expect((await topicOf(s, reply)).create_state).toBe("channel_known")
  expect(s.fake.channels().filter(channel => channel.name === "coffee")).toHaveLength(1)
})

test("a registry write that is refused leaves the chat and the owner's request where they are, says which step, and is tried again later without making anything twice", async () => {
  const s = await stageTopics(cluster)
  const { reply } = await confirmed(s, { execution_machine: "mac" })
  await s.topicPass()
  const topic = await topicOf(s, reply)
  // The owner's file changed after they approved: the mac's runner is not kept running any more.
  s.rewrite({ runner: { [RUNNER_MAC]: { enabled: false } } })
  const hub = s.as("hub_hub")
  const bind = (at = Date.now()) => bindTopics({ store: hub, registryFile: s.registryFile, machine: "pi", now: () => at, load: () => loadRegistry(s.registryFile, { machine: "pi" }) })
  await bind()
  expect(await readTopic(hub, topic.id)).toMatchObject({ create_state: "channel_known", create_failure: { step: "binding", cause: "invalid configuration" } })
  expect(s.load().agents.find(agent => agent.id === topic.agent_id)).toBeUndefined()
  const [said] = await s.admin`select body from outbox where notice_key = ${`topic:bind-failed:${topic.id}`}`
  expect(said.body).toContain("connecting the agent")
  expect(said.body).toContain("Nothing was deleted and nothing was created again")
  // The chat, the request and the channel are all still there, and nothing was made again.
  expect(await count(s, "inbound", `id = 'topic-create:${topic.id}'`)).toBe(1)
  expect(createPosts(s)).toHaveLength(1)
  expect(s.fake.requests().filter(one => one.method === "DELETE")).toHaveLength(0)
  // Tried again no sooner than a minute later, and said once.
  await bind()
  expect((await readTopic(hub, topic.id))!.create_state).toBe("channel_known")
  expect(await count(s, "outbox", `notice_key = 'topic:bind-failed:${topic.id}'`)).toBe(1)
  // The file is fixed: the next try binds, once.
  s.rewrite({})
  await bind(Date.now() + 61_000)
  expect(await readTopic(hub, topic.id)).toMatchObject({ create_state: "bound", lifecycle: "active" })
  expect(s.load().agents.filter(agent => agent.id === topic.agent_id)).toHaveLength(1)
  expect(createPosts(s)).toHaveLength(1)
})

test("a chat that is made and not yet connected is a finding once it has waited, and one whose agent is never bound is not lost", async () => {
  const s = await stageTopics(cluster)
  const { reply } = await confirmed(s)
  await s.topicPass()
  const topic = await topicOf(s, reply)
  const find = (at: Date) => topicFindings({ store: s.as("hub_hub"), registry: s.load(), machine: "pi", now: at, doors: new Set([DOOR]), agents: [] })
  expect(await find(new Date())).toEqual([])
  const later = await find(new Date(Date.now() + 10 * 60 * 1000))
  expect(later.map(one => [one.kind, one.subject])).toEqual([["topic-bind-stuck", topic.id]])
  expect(later[0].says).toContain("its agent is not connected to it yet")
})

// ---------------------------------------------------------------------------------------------
// What is bound is what was approved
// ---------------------------------------------------------------------------------------------

const hubBind = (s: TopicsStage, at = Date.now(), load?: () => ReturnType<typeof loadRegistry>) =>
  bindTopics({ store: s.as("hub_hub"), registryFile: s.registryFile, machine: "pi", now: () => at, load: load ?? (() => loadRegistry(s.registryFile, { machine: "pi" })) })

/** A confirmed topic whose channel is made and whose agent is not yet bound: the state the hub finds it in. */
async function made(s: TopicsStage, over: Record<string, unknown> = {}) {
  const { master, reply } = await confirmed(s, over)
  await s.topicPass()
  return { master, reply, topic: await topicOf(s, reply) }
}

test("what is bound is what was approved: a preset that changed its model or its engine between the preview and the bind is refused by name, nothing is substituted, and putting it back lets the same bind finish", async () => {
  const s = await stageTopics(cluster)
  const { topic } = await made(s)
  const hub = s.as("hub_hub")
  expect(topic.setup).toMatchObject({ adapter: "synthetic", model: "m-daily", preset: "daily" })

  // The model behind the same preset name is swapped after the owner approved "synthetic (m-daily)".
  s.rewrite({ presets: { daily: { model: "m-swapped" } } })
  await hubBind(s)
  expect(await readTopic(hub, topic.id)).toMatchObject({ create_state: "channel_known", lifecycle: "pending", create_failure: { step: "binding", code: "preset_changed" } })
  expect(s.load().agents.find(agent => agent.id === topic.agent_id)).toBeUndefined()
  // Said once, where it was asked for, and in words: what was approved, what it is now, and that anything else needs a new approval.
  const [said] = await s.admin`select agent, body from outbox where notice_key = ${`topic:bind-failed:${topic.id}`}`
  expect(said.agent).toBe(GENERAL)
  expect(said.body).toContain("approved setup changed")
  expect(said.body).toContain("m-swapped")
  expect(said.body).toContain("m-daily")
  expect(said.body).toContain("anything else is a new request and a new approval")
  // The chat, the owner's message and the approval are all kept, and nothing was made again.
  expect(await count(s, "inbound", `id = 'topic-create:${topic.id}'`)).toBe(1)
  expect(createPosts(s)).toHaveLength(1)
  expect(await count(s, "confirmation", "state = 'approved'")).toBe(1)

  // The engine behind it is swapped as well: the same refusal, still without writing.
  s.rewrite({ presets: { daily: { adapter: "synthetic-2" } } })
  await hubBind(s, Date.now() + 61_000)
  expect((await readTopic(hub, topic.id))!.create_failure).toMatchObject({ step: "binding", code: "preset_changed" })
  expect(String((await readTopic(hub, topic.id))!.create_failure!.cause)).toContain("synthetic-2")
  expect(s.load().agents.find(agent => agent.id === topic.agent_id)).toBeUndefined()
  expect(await count(s, "outbox", `notice_key = 'topic:bind-failed:${topic.id}'`)).toBe(1)

  // What was approved is put back: the same step finishes, bound to exactly what the owner saw.
  s.rewrite({})
  await hubBind(s, Date.now() + 122_000)
  expect(await readTopic(hub, topic.id)).toMatchObject({ create_state: "bound", lifecycle: "active", create_failure: null })
  expect(s.load().agents.filter(agent => agent.id === topic.agent_id)).toEqual([expect.objectContaining({ preset: "daily", chat: topic.chat, runner: RUNNER_PI, door: DOOR, person: PERSON })])
  expect(s.load().presets.daily).toMatchObject({ adapter: "synthetic", model: "m-daily" })
  expect(createPosts(s)).toHaveLength(1)
})

test("an agent entry that is already there is the write having landed only if it is exactly what this bind writes: that one is recovered without a second write, and any other is refused by name and never overwritten", async () => {
  const s = await stageTopics(cluster)
  const hub = s.as("hub_hub")
  const agentsOf = (id: string) => s.load().agents.filter(one => one.id === id)

  // The exact write landed, and the hub died before it said so: `bind_intent` is what it left. Recovery writes nothing.
  const exact = await made(s, { chat_name: "exact" })
  await appendEntry(s.registryFile, "agents", agentBlockOf(exact.topic))
  await bindIntent(hub, exact.topic.id)
  const landed = readFileSync(s.registryFile, "utf8")
  await hubBind(s)
  expect(await readTopic(hub, exact.topic.id)).toMatchObject({ create_state: "bound", lifecycle: "active" })
  expect(readFileSync(s.registryFile, "utf8")).toBe(landed)
  expect(agentsOf(exact.topic.agent_id)).toHaveLength(1)

  // An entry of that id that says another preset, other tools or another runner is somebody else's, or an older attempt's.
  const cases: { name: string; over: Record<string, unknown>; entry: (topic: TopicRow) => Record<string, string | string[]>; differs: string }[] = [
    { name: "preset", over: {}, entry: topic => ({ ...agentBlockOf(topic), preset: "fast" }) as Record<string, string | string[]>, differs: "preset" },
    { name: "tools", over: { tool_profile: ["WebFetch"] }, entry: topic => { const { tools: _tools, ...rest } = agentBlockOf(topic); return rest as Record<string, string> }, differs: "tools" },
    { name: "runner", over: { execution_machine: "mac" }, entry: topic => ({ ...agentBlockOf(topic), runner: RUNNER_PI }) as Record<string, string>, differs: "runner" },
  ]
  for (const one of cases) {
    const other = await made(s, { chat_name: one.name, ...one.over })
    await appendEntry(s.registryFile, "agents", one.entry(other.topic) as never)
    const before = readFileSync(s.registryFile, "utf8")
    await hubBind(s)
    const after = await readTopic(hub, other.topic.id)
    expect(after, one.name).toMatchObject({ create_state: "channel_known", create_failure: { step: "binding", code: "binding_conflict" } })
    expect(String(after!.create_failure!.cause), one.name).toContain(`differs in ${one.differs}`)
    // Not overwritten, not repeated, and the chat and the owner's message are where they were.
    expect(readFileSync(s.registryFile, "utf8"), one.name).toBe(before)
    expect(agentsOf(other.topic.agent_id), one.name).toHaveLength(1)
    expect(await count(s, "inbound", `id = 'topic-create:${other.topic.id}'`), one.name).toBe(1)
  }
  expect(createPosts(s)).toHaveLength(4)
})

test("an exact entry does not pass for the approved binding once the runner is no longer the chosen machine's: refused by name, and left as it is", async () => {
  const s = await stageTopics(cluster)
  const hub = s.as("hub_hub")
  const { topic } = await made(s, { execution_machine: "mac" })
  // The file now says runner-mac runs on the pi. The entry the earlier write made is exactly what would be written, and is still refused.
  s.rewrite({ runner: { [RUNNER_MAC]: { machine: "pi" } } })
  await appendEntry(s.registryFile, "agents", agentBlockOf(topic))
  await bindIntent(hub, topic.id)
  const before = readFileSync(s.registryFile, "utf8")
  await hubBind(s)
  expect(await readTopic(hub, topic.id)).toMatchObject({ create_state: "channel_known", create_failure: { step: "binding", code: "machine_changed" } })
  expect(readFileSync(s.registryFile, "utf8")).toBe(before)
})

test("the binding is judged on the file the edit replaces: a change that lands after the binder loaded the registry and before the writer holds its lock is caught, and one that is put right in that window is not held against it", async () => {
  const s = await stageTopics(cluster)
  const hub = s.as("hub_hub")
  const { topic } = await made(s)
  let loads = 0
  // The binder's own picture is the registry as approved. A hand edit lands after it and before the writer's lock.
  await bindTopics({ store: hub, registryFile: s.registryFile, machine: "pi", now: () => Date.now(), load: () => {
    const picture = loadRegistry(s.registryFile, { machine: "pi" })
    loads += 1
    s.rewrite({ presets: { daily: { model: "m-swapped" } } })
    return picture
  } })
  expect(loads).toBe(1)
  expect(await readTopic(hub, topic.id)).toMatchObject({ create_state: "channel_known", create_failure: { code: "preset_changed" } })
  expect(s.load().agents.find(agent => agent.id === topic.agent_id)).toBeUndefined()
  expect(s.load().presets.daily.model).toBe("m-swapped")

  // And the other way about: the binder's picture shows the swap, and the file is put back before the lock. The file is what counts.
  await bindTopics({ store: hub, registryFile: s.registryFile, machine: "pi", now: () => Date.now() + 61_000, load: () => {
    const picture = loadRegistry(s.registryFile, { machine: "pi" })
    s.rewrite({})
    return picture
  } })
  expect(await readTopic(hub, topic.id)).toMatchObject({ create_state: "bound", lifecycle: "active" })
  expect(s.load().agents.filter(agent => agent.id === topic.agent_id)).toHaveLength(1)
  expect(createPosts(s)).toHaveLength(1)
})

test("a bind that keeps being refused is still stuck: the finding counts from when the channel became known, not from the last retry, and says which refusal", async () => {
  const s = await stageTopics(cluster)
  const { topic } = await made(s, { execution_machine: "mac" })
  const hub = s.as("hub_hub")
  s.rewrite({ runner: { [RUNNER_MAC]: { enabled: false } } })
  // The channel became known long ago; every retry rewrites the row, so its last change is always fresh.
  await s.admin`update topic set channel_known_at = now() - interval '20 minutes' where id = ${topic.id}`
  for (let retry = 0; retry < 4; retry += 1) await hubBind(s, Date.now() + retry * 61_000)
  const row = (await readTopic(hub, topic.id))!
  expect(row.create_failure).toMatchObject({ step: "binding", code: "runner_not_running", cause: "invalid configuration" })
  expect(Date.now() - row.updated_at.getTime()).toBeLessThan(60_000)
  const found = await topicFindings({ store: hub, registry: s.load(), machine: "pi", now: new Date(), doors: new Set([DOOR]), agents: [] })
  expect(found.map(one => [one.kind, one.subject])).toEqual([["topic-bind-stuck", topic.id]])
  expect(found[0].says).toContain("invalid configuration (runner_not_running)")
  // A bind that only just started is not, however often it has been refused so far.
  await s.admin`update topic set channel_known_at = now() where id = ${topic.id}`
  expect(await topicFindings({ store: hub, registry: s.load(), machine: "pi", now: new Date(), doors: new Set([DOOR]), agents: [] })).toEqual([])
})

test("a door that is known not to be able to make a chat is refused before any preview: no preview, no approval, no channel, no input, and no probe of what the bot may do", async () => {
  const s = await stageTopics(cluster, { door: { guild: undefined } })
  const master = await s.binding()
  const reply = await s.ask(master, { action: "create", setup: setup() })
  expect(reply).toMatchObject({ status: "failed", cause: "create_unsupported" })
  expect(JSON.stringify(reply)).toContain("guild")
  expect(await count(s, "topic")).toBe(0)
  expect(await count(s, "confirmation")).toBe(0)
  expect(await count(s, "source_consumption")).toBe(0)
  expect(await count(s, "inbound", "id like 'topic-create:%'")).toBe(0)
  await s.deliver()
  await s.topicPass()
  // Nothing was asked of the platform at all: not a create, not a look at what the bot may do.
  expect(s.fake.requests().filter(one => one.method !== "GET" || !one.path.includes("/channels"))).toEqual([])
  expect(createPosts(s)).toHaveLength(0)
})

// ---------------------------------------------------------------------------------------------
// The owner names the channel
// ---------------------------------------------------------------------------------------------

const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }
const POST_CHANNEL = (s: TopicsStage) => new RegExp(`^POST /guilds/${s.fake.guild}/channels$`)
const adopt = (s: TopicsStage, master: Awaited<ReturnType<TopicsStage["binding"]>>, reply: Record<string, unknown>, chat: string) =>
  s.ask(master, { action: "create", topic_id: reply.object_id, creation_decision: { choice: "adopt", chat } })

/** A create nobody could settle: the request never came back, and looking found nothing. */
async function unsettled(s: TopicsStage) {
  const { master, reply } = await confirmed(s)
  s.fake.script(POST_CHANNEL(s), { kind: "drop" })
  await s.topicPass()
  for (let look = 0; look < 6; look += 1) { s.fake.advance(31_000); await s.topicPass() }
  expect((await topicOf(s, reply)).create_state).toBe("creation_unknown")
  return { master, reply }
}

/** A create the platform refused: nothing was made. */
async function refused(s: TopicsStage) {
  const { master, reply } = await confirmed(s)
  s.fake.script(POST_CHANNEL(s), { kind: "refuse", status: 403, code: 50013 })
  await s.topicPass()
  expect((await topicOf(s, reply)).create_state).toBe("failed")
  return { master, reply }
}

for (const [name, get] of [["unknown", unsettled], ["refused by the platform", refused]] as const) {
  test(`a create that was ${name} is finished by the owner's adoption of a channel that is there, by the resting task itself: it hears the decision, and makes one input, one first read position and no channel`, async () => {
    const s = await stageTopics(cluster)
    const { master, reply } = await get(s)
    const target = s.fake.addChannel({ name: "made-by-hand" })
    const idle = await s.idleTask()
    try {
      // The task's own first look changed nothing, and nobody calls a pass from here on: only the store's notification can wake it.
      expect((await topicOf(s, reply)).create_state).toBe(name === "unknown" ? "creation_unknown" : "failed")
      expect(await adopt(s, master, reply, target)).toMatchObject({ status: "accepted" })
      await until("the resting task heard the decision and adopted the channel", async () => (await topicOf(s, reply)).create_state === "channel_known", 20_000,
        async () => JSON.stringify(await topicOf(s, reply)))
      const topic = await topicOf(s, reply)
      expect(topic).toMatchObject({ chat: target, decision_seq: 1, create_failure: null })
      expect(topic.channel_known_at).not.toBeNull()
      expect(createPosts(s)).toHaveLength(1)
      expect(await count(s, "inbound", `id = 'topic-create:${topic.id}'`)).toBe(1)
      const cursors = await s.admin`select id, data from state_row where sheet = 'door_cursor' and id like ${`${DOOR}/${target}%`}`
      expect(cursors.map((row: { id: string; data: unknown }) => [row.id, row.data])).toEqual([[`${DOOR}/${target}`, { cursor: "0" }]])
      // The hub then binds it once, to the chat the owner named.
      await hubBind(s)
      expect(await readTopic(s.as("hub_hub"), topic.id)).toMatchObject({ create_state: "bound", chat: target })
      expect(s.load().agents.filter(agent => agent.chat === target)).toHaveLength(1)
      expect(createPosts(s)).toHaveLength(1)
    } finally {
      await idle.stop()
    }
  })
}

test("an adoption that cannot be used is refused durably and by name for its own decision: not there, not a text channel, already a topic's, already answered in by an agent; nothing is created, and another decision is a new look", async () => {
  const s = await stageTopics(cluster)
  const { master, reply } = await unsettled(s)
  const voice = s.fake.addChannel({ name: "voice", type: 2 })
  // A chat another topic was made with and that its agent is not bound to yet: it is that topic's.
  const other = await made(s, { chat_name: "other" })
  const cases = [
    { chat: "999999999999999999", code: "not_found" },
    { chat: voice, code: "not_text" },
    { chat: other.topic.chat!, code: "owned_by_topic" },
    { chat: s.general, code: "answered_in_registry" },
  ]
  let seq = 0
  // A chat that already belongs to another topic has that topic's own first read position: what a refused adoption may not do is add or move one.
  const cursorsOf = async (chat: string) => Array.from(await s.admin`select id, data from state_row where sheet = 'door_cursor' and id = ${`${DOOR}/${chat}`}`)
  for (const one of cases) {
    const cursorsBefore = await cursorsOf(one.chat)
    await adopt(s, master, reply, one.chat)
    seq += 1
    await s.topicPass()
    const topic = await topicOf(s, reply)
    // The topic stays exactly where it was, and says what it was told and why it cannot.
    expect(topic.create_state, one.code).toBe("creation_unknown")
    expect(topic.decision_seq, one.code).toBe(seq)
    expect(topic.create_evidence.adopt_refused, one.code).toMatchObject({ seq, chat: one.chat, code: one.code })
    expect(await count(s, "inbound", `id = 'topic-create:${topic.id}'`), one.code).toBe(0)
    expect(await cursorsOf(one.chat), one.code).toEqual(cursorsBefore)
    const [said] = await s.admin`select agent, body from outbox where notice_key = ${`topic:adopt-refused:${seq}:${topic.id}`}`
    expect(said.agent, one.code).toBe(GENERAL)
    expect(said.body, one.code).toContain("cannot be used")
    expect(said.body, one.code).toContain("Nothing was created and nothing was deleted")
    // Said once however many passes and restarts, and not looked at again for the same decision.
    const gets = s.fake.requestsTo(new RegExp(`^GET /channels/${one.chat}$`)).length
    await s.topicPass()
    s.restart()
    await s.topicPass()
    expect(await count(s, "outbox", `notice_key like 'topic:adopt-refused:${seq}:%'`), one.code).toBe(1)
    expect(s.fake.requestsTo(new RegExp(`^GET /channels/${one.chat}$`)).length, one.code).toBe(gets)
  }
  expect(createPosts(s)).toHaveLength(2)
  // It is named in check until it is decided again.
  const find = () => topicFindings({ store: s.as("hub_hub"), registry: s.load(), machine: "pi", now: new Date(), doors: new Set([DOOR]), agents: [] })
  const named = await find()
  expect(named.map(one => [one.kind, one.subject])).toEqual(expect.arrayContaining([["topic-creation-unknown", reply.object_id], ["topic-adopt-refused", reply.object_id]]))
  expect(named.find(one => one.kind === "topic-adopt-refused")!.says).toContain("answered_in_registry")

  // A new decision is a new look: a channel that is there and free is used, once.
  const good = s.fake.addChannel({ name: "good" })
  await adopt(s, master, reply, good)
  await s.topicPass()
  expect(await topicOf(s, reply)).toMatchObject({ create_state: "channel_known", chat: good, decision_seq: seq + 1 })
  expect(await count(s, "inbound", `id = 'topic-create:${reply.object_id}'`)).toBe(1)
  expect((await find()).map(one => one.kind)).not.toContain("topic-adopt-refused")
})

test("a lookup that was slow for one decision cannot commit it over a newer one: the delayed answer for channel A is stale once B is decided, and only B is used, with one input and one first read position", async () => {
  const s = await stageTopics(cluster)
  const { master, reply } = await unsettled(s)
  const a = s.fake.addChannel({ name: "channel-a" })
  const b = s.fake.addChannel({ name: "channel-b" })
  const reading = deferred()
  const release = deferred()
  let held = false
  // The platform's answer about A is held on its way back until the owner has decided B.
  const platform = s.platform(async (method, url) => {
    if (!held && method === "GET" && url.pathname.endsWith(`/channels/${a}`)) {
      held = true
      reading.resolve()
      await release.promise
    }
  })
  const idle = await s.idleTask({ platform })
  try {
    await adopt(s, master, reply, a)
    await reading.promise
    // The task is in the middle of reading A. B is decided now, and the task hears it while it is busy.
    await adopt(s, master, reply, b)
    release.resolve()
    await until("only the newer decision was used", async () => (await topicOf(s, reply)).create_state === "channel_known", 20_000,
      async () => JSON.stringify(await topicOf(s, reply)))
    const topic = await topicOf(s, reply)
    expect(topic).toMatchObject({ chat: b, decision_seq: 2 })
    expect(topic.create_evidence.adopt_refused).toBeUndefined()
    expect(await count(s, "inbound", `id = 'topic-create:${topic.id}'`)).toBe(1)
    const cursors = await s.admin`select id from state_row where sheet = 'door_cursor' and (id = ${`${DOOR}/${a}`} or id = ${`${DOOR}/${b}`})`
    expect(cursors.map((row: { id: string }) => row.id)).toEqual([`${DOOR}/${b}`])
    expect(createPosts(s)).toHaveLength(1)
  } finally {
    release.resolve()
    await idle.stop()
  }
})

test("a binding that lands in the registry while the platform is still answering about the channel is not adopted over: the choice is checked again after the lookup, refused by name for its own decision, and nothing is created", async () => {
  const s = await stageTopics(cluster)
  const { master, reply } = await unsettled(s)
  const target = s.fake.addChannel({ name: "taken-meanwhile" })
  const reading = deferred()
  const release = deferred()
  let held = false
  // The platform's answer about the channel is held on its way back until the registry has been changed.
  const platform = s.platform(async (method, url) => {
    if (!held && method === "GET" && url.pathname.endsWith(`/channels/${target}`)) {
      held = true
      reading.resolve()
      await release.promise
    }
  })
  const idle = await s.idleTask({ platform })
  try {
    await adopt(s, master, reply, target)
    await reading.promise
    // The task has passed its first look at the registry (nothing answered in the channel) and is waiting for the platform. Now an agent does.
    s.rewrite({ agents: [{ id: "p1-taker", person: PERSON, preset: "daily", chat: target, door: DOOR, runner: RUNNER_PI }] })
    release.resolve()
    await until("the choice was refused after the lookup", async () => (await topicOf(s, reply)).create_evidence.adopt_refused !== undefined, 20_000,
      async () => JSON.stringify(await topicOf(s, reply)))
    const topic = await topicOf(s, reply)
    expect(topic.create_state).toBe("creation_unknown")
    expect(topic.create_evidence.adopt_refused).toMatchObject({ seq: 1, chat: target, code: "answered_in_registry" })
    expect(await count(s, "inbound", `id = 'topic-create:${topic.id}'`)).toBe(0)
    expect(await count(s, "state_row", `sheet = 'door_cursor' and id = '${DOOR}/${target}'`)).toBe(0)
    expect(createPosts(s)).toHaveLength(1)
  } finally {
    release.resolve()
    await idle.stop()
  }
})

// ---------------------------------------------------------------------------------------------
// What "started" is evidence of
// ---------------------------------------------------------------------------------------------

const firstLines = (s: TopicsStage, chat: string) => s.texts(chat).map(text => text.split("\n")[0])

test("started is said only on evidence that the chosen machine took the first message up: a connected runner with a stale registry copy still waits and says why, the sync only changes the reason, and another runner's claim is not it", async () => {
  const s = await stageTopics(cluster, { hub: { store_machine: "pi" } })
  const asked = await confirmed(s, { execution_machine: "mac" })
  await s.topicPass()
  await hubBind(s)
  const master = asked.master
  const topic = await topicOf(s, asked.reply)
  const hub = s.as("hub_hub")
  const initial = `topic-create:${topic.id}`
  const evidence = async () => (await readTopic(hub, topic.id))!.create_evidence
  await s.topicPass()
  await s.deliver()
  expect(firstLines(s, topic.chat!)).toEqual(["Waiting for mac"])

  const online = await openStore({ url: storeUrlAs(cluster.url(s.db), "hub_runner", RUNNER_MAC) })
  try {
    // The mac's runner is connected, and its registry copy is not the store machine's: it may not have this agent, and it claims nothing.
    await putRow(hub, REGISTRY_SHEET, "pi", { sha256: "a".repeat(64), at: new Date().toISOString() })
    await putRow(hub, REGISTRY_SHEET, "mac", { sha256: "b".repeat(64), at: new Date().toISOString() })
    await s.topicPass()
    await s.deliver()
    expect(firstLines(s, topic.chat!)).toEqual(["Waiting for mac"])
    expect(await evidence()).toMatchObject({ announced: true, status: "waiting", status_reason: "registry_not_synced" })
    expect(await s.ask(master, { action: "inspect", topic_id: topic.id })).toMatchObject({
      status: "queued", stage: "waiting_for_machine", topic: { waiting_reason: "registry_not_synced" },
    })
    // It syncs. That changes what it is waiting for and nothing else: the first message has not been picked up.
    await putRow(hub, REGISTRY_SHEET, "mac", { sha256: "a".repeat(64), at: new Date().toISOString() })
    await s.topicPass()
    await s.deliver()
    expect(firstLines(s, topic.chat!)).toEqual(["Waiting for mac"])
    expect(await evidence()).toMatchObject({ status: "waiting", status_reason: "not_picked_up_yet" })
    // Another machine's runner claiming the message is not the chosen machine's, and nothing fails over.
    await s.admin`update inbound set claimed_by = ${RUNNER_PI} where id = ${initial}`
    await s.topicPass()
    await s.deliver()
    expect(firstLines(s, topic.chat!)).toEqual(["Waiting for mac"])
    await s.admin`update inbound set claimed_by = null where id = ${initial}`
    expect((await readTopic(hub, topic.id))!.runner).toBe(RUNNER_MAC)

    // The chosen runner takes the message up. That, and only that, moves the one line, edited in place, to a milestone.
    await s.admin`update inbound set claimed_by = ${RUNNER_MAC} where id = ${initial}`
    await s.topicPass()
    await s.deliver()
    expect(firstLines(s, topic.chat!)).toEqual(["Started on mac"])
    expect(await evidence()).toMatchObject({ status: "running" })
    expect(await evidence()).not.toHaveProperty("status_reason")
    const started = await s.ask(master, { action: "inspect", topic_id: topic.id })
    expect(started).toMatchObject({ status: "complete", stage: "active" })
    expect(String(started.status_message)).toContain("started on mac")
    expect(String(started.status_message)).toContain("says nothing of whether it runs now")
    // Nothing follows the agent after that: what the claim does next changes no line.
    await s.admin`update inbound set claimed_by = null where id = ${initial}`
    s.restart()
    await s.topicPass()
    await s.deliver()
    expect(firstLines(s, topic.chat!)).toEqual(["Started on mac"])
    expect(await count(s, "outbox", `notice_key = 'topic:ready:${topic.id}'`)).toBe(1)
  } finally {
    await online.close()
  }
})

test("a chat that is archived, being reopened or gone never publishes that it started, even when its machine's evidence is there: the store refuses it, the phase skips it, and a reopen lets the milestone through", async () => {
  const s = await stageTopics(cluster)
  const { reply } = await confirmed(s, { execution_machine: "mac" })
  await s.topicPass()
  await hubBind(s)
  await s.topicPass()
  await s.deliver()
  const topic = await topicOf(s, reply)
  const initial = `topic-create:${topic.id}`
  expect(firstLines(s, topic.chat!)).toEqual(["Waiting for mac"])
  const general = await s.binding()

  // The runner had taken the first message up, and the owner archived the chat before the door looked at it.
  await s.admin`update inbound set claimed_by = ${RUNNER_MAC} where id = ${initial}`
  await s.ask(general, { action: "archive", topic_id: topic.id })
  for (let pass = 0; pass < 4; pass += 1) { await s.topicPass(); await s.deliver() }
  expect((await topicById(s, topic.id)).lifecycle).toBe("archived")
  expect(firstLines(s, topic.chat!)).toEqual(["Waiting for mac"])
  expect((await topicById(s, topic.id)).create_evidence.status).toBe("waiting")
  // The store itself will not move the line of a chat that is not active.
  expect(await setTopicStatus(s.as("hub_door"), topic.id, "running")).toBe(false)
  expect((await topicById(s, topic.id)).create_evidence.status).toBe("waiting")

  // Reopened, the chat is tracked again, and the evidence that was there all along publishes the milestone once.
  await s.ask(general, { action: "reopen", topic_id: topic.id })
  for (let pass = 0; pass < 3; pass += 1) { await s.topicPass(); await s.deliver() }
  expect((await topicById(s, topic.id)).lifecycle).toBe("active")
  expect(firstLines(s, topic.chat!)).toEqual(["Started on mac"])
})


test("unreadable registry waits before create intent and retries with the configured category", async () => {
  const s = await stageTopics(cluster)
  const category = s.fake.addChannel({ name: "topics", type: 4 })
  s.rewrite({ door: { topic_category: category } })
  const { reply } = await confirmed(s)
  const due = await s.topicPass({ registry: () => { throw new Error("registry edit in progress") } })
  expect(due).not.toBeNull()
  expect((await topicOf(s, reply)).create_state).toBe("confirmed")
  expect(createPosts(s)).toHaveLength(0)
  await s.topicPass()
  expect(createPosts(s)).toHaveLength(1)
  expect(createPosts(s)[0].body).toMatchObject({ parent_id: category })
  expect((await topicOf(s, reply)).create_state).toBe("channel_known")
})
