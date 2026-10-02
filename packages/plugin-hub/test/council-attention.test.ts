// What a council needs the owner for, and the chats it is said in: a council's notice goes only to a chat that can take it (the
// topics' own measure), and what no chat could take is kept on the topic of the council's chat and caught up with, once, by the
// topic catch-up. A real store; the council watch and the topic catch-up are the shipped code, and the archive and reopen are the
// store's own transitions (the door's seam over Discord is not what this is about).

import { afterAll, afterEach, beforeAll, expect, test } from "bun:test"
import { startCluster, type Cluster } from "./helpers/cluster.ts"
import { councilStage, startArgs } from "./helpers/council-stage.ts"
import { CHAT, DOOR, PERSON, RUNNER } from "./helpers/hub-fixture.ts"
import { callTool } from "../src/mcp/handlers.ts"
import { loadRegistry } from "../src/registry/load.ts"
import { projectCouncil } from "../src/council/watch.ts"
import { councilGapOf } from "../src/council/attention.ts"
import { catchupPhase, newTopicsMemory, type TopicsContext } from "../src/door/topic-task.ts"
import type { StoreLike } from "../src/store/connect.ts"
import {
  attentionCatchup, attentionDebtOf, completeTransition, linkLegacyTopic, readTopic, recordChannel, requestTransition, type TopicRow,
} from "../src/store/topics.ts"

let cluster: Cluster
beforeAll(async () => { cluster = await startCluster() })
afterAll(async () => { await cluster?.stop() })

const mine: { close(): Promise<void> }[] = []
const track = <T extends { close(): Promise<void> }>(sql: T): T => { mine.push(sql); return sql }
afterEach(async () => { for (const one of mine.splice(0)) await one.close().catch(() => {}) })

const MASTER = "p1-lair"
const GENERAL = "p1-general"
const GENERAL_CHAT = `${CHAT}1`

type Stage = Awaited<ReturnType<typeof councilStage>>

interface Rig {
  s: Stage
  id: string
  master: TopicRow
  general: TopicRow
  /** One pass of the council watch, as a door that has just started would make it (a registry loaded again, the store given or this stage's own). */
  project(over?: { store?: StoreLike; at?: number }): Promise<number | null>
  /** One pass of the topic task's catch-up phase over the door's topics. */
  catchup(store?: StoreLike): Promise<number | null>
  archive(topic: TopicRow): Promise<void>
  reopen(topic: TopicRow): Promise<void>
  /** A door that was started again: a connection of its own. */
  restarted(): StoreLike
  /** The council's first member cannot be waited for: the owner is needed. */
  lose(): Promise<void>
  /** The checkpoint has passed: the owner is needed for something else. */
  checkpoint(): Promise<void>
}

/**
 * A staged hub with a master that has a chat and a running council, and a General that is a chat of its own (the stage's default
 * General is the master itself, and that would be one chat, not two). Both are topics, so both can be archived and reopened.
 */
async function rig(options: { general?: boolean } = {}): Promise<Rig> {
  const general = options.general ?? true
  const s = await councilStage(cluster, track, {
    people: [{ id: PERSON, allowed_senders: { [DOOR]: [PERSON] }, ...(general ? { general: GENERAL } : {}) }] as never,
    registry: (base: any) => ({ ...base, agents: [...base.agents, { id: GENERAL, person: PERSON, preset: "daily", chat: GENERAL_CHAT, door: DOOR, runner: RUNNER }] }),
  })
  const id = String((await callTool(s.binding("attempt-start"), "hub_council", startArgs())).object_id)
  const link = async (agent: string, chat: string): Promise<TopicRow> => {
    const where = s.placement(agent)
    return await linkLegacyTopic(s.runner, { person: PERSON, agent, door: DOOR, chat, machine: where.machine, runner: RUNNER, preset: "daily",
      adapter: where.adapter, display_name: agent })
  }
  const master = await link(MASTER, CHAT)
  const other = await link(GENERAL, GENERAL_CHAT)
  let operations = 0
  const transition = async (topic: TopicRow, kind: "archive" | "reopen") => {
    const operation = `op-${kind}-${++operations}`
    expect(await requestTransition(s.runner, { operation, topic: topic.id, kind, source: "tool", by: PERSON, route: { door: DOOR, chat: topic.chat! }, evidence: {} })).toBe("ok")
    if (kind === "archive") expect(await completeTransition(s.door, operation, {}, null)).toBe("channel-pending")
    expect(await recordChannel(s.door, operation, "applied", { parent: null }, { ok: true })).toBe("applied")
    expect(await completeTransition(s.door, operation, {}, null)).toBe("complete")
    expect((await readTopic(s.door, topic.id))!.lifecycle).toBe(kind === "archive" ? "archived" : "active")
  }
  const context = (store: StoreLike): TopicsContext => ({ store, platform: {}, door: DOOR, retrySeconds: 30, maxAttempts: 3, now: Date.now,
    registry: () => loadRegistry(s.registryFile), stateDir: s.stateDir, pollSeconds: 30, tickMs: 1000 }) as unknown as TopicsContext
  return {
    s, id, master, general: other,
    project: (over = {}) => projectCouncil(over.store ?? s.door, id, loadRegistry(s.registryFile), () => over.at ?? Date.now()),
    catchup: (store = s.door) => catchupPhase(context(store), newTopicsMemory()),
    archive: (topic) => transition(topic, "archive"),
    reopen: (topic) => transition(topic, "reopen"),
    restarted: () => ({ sql: track(cluster.connectAs("hub_door", s.db)), url: cluster.url(s.db) }) as StoreLike,
    async lose() { await s.interrupt((await s.jobsOf(id))[0].id) },
    async checkpoint() { await s.su`update council set checkpoint_deadline = now() - interval '1 minute' where id = ${id}` },
  }
}

/** What the council said (`council-…`), the keys and where each went. */
const said = async (r: Rig, like = "council-%") =>
  (await r.s.su`select notice_key, agent, route from outbox where notice_key like ${like} order by notice_key`) as unknown as { notice_key: string; agent: string; route: { door: string; chat: string } }[]

/** The catch-up notices of a topic. */
const caught = async (r: Rig, topic: TopicRow) =>
  (await r.s.su`select notice_key, agent, body, route, delivered_at from outbox where notice_key like ${`topic:attention-catchup:${topic.id}:%`} order by notice_key`) as unknown as
    { notice_key: string; agent: string; body: string; route: { door: string; chat: string }; delivered_at: Date | null }[]

/** What a topic still owes, as the store holds it, with the need each council gap is for. */
const owed = async (r: Rig, topic: TopicRow) =>
  attentionDebtOf((await readTopic(r.s.door, topic.id))!).map(one => ({ ...one, need: councilGapOf(one.kind)?.need ?? null }))

const missingKeys = (rows: { notice_key: string }[]) => rows.filter(one => one.notice_key.startsWith("council-missing:")).map(one => one.notice_key)

test("A1 the council's chat and General both archived: nothing is queued for either, the need is kept on the council chat's topic once, and it is not invented again however often or after whatever restart it is looked at", async () => {
  const r = await rig()
  await r.archive(r.master)
  await r.archive(r.general)
  await r.lose()
  await r.project()
  expect(await said(r), "no line is written to a chat that is archived").toEqual([])
  const [gap, ...more] = await owed(r, r.master)
  expect(more).toEqual([])
  expect(gap).toMatchObject({ need: "members_missing", cause: "general_unusable", seq: 1 })
  // The gap is on the council chat's topic and on nothing else.
  expect(await owed(r, r.general)).toEqual([])
  // Looked at again, by this door and by one started afresh: the same gap, the same occurrence, no notice.
  await r.project()
  await r.project({ store: r.restarted() })
  expect((await owed(r, r.master)).map(one => [one.kind, one.seq])).toEqual([[gap.kind, 1]])
  expect(await said(r)).toEqual([])
  // Nothing can take it, so the catch-up pays nothing and the door stays due for it.
  expect(await r.catchup()).not.toBeNull()
  expect(await caught(r, r.master)).toEqual([])
  expect((await owed(r, r.master)).map(one => one.kind)).toEqual([gap.kind])
})

test("A2 reopening the council's chat pays what was kept, once: ONE keyed summary in that chat, the gap is cleared with it, the original is never sent after it, and restarts and repeats add nothing", async () => {
  const r = await rig()
  await r.archive(r.master)
  await r.archive(r.general)
  await r.lose()
  await r.project()
  const [gap] = await owed(r, r.master)

  const inputs = await r.s.count("inbound")
  await r.reopen(r.master)
  // Reopening delivers nothing by itself: it is the catch-up that pays.
  expect(await caught(r, r.master)).toEqual([])
  expect(await r.catchup()).toBeNull()
  const [summary, ...rest] = await caught(r, r.master)
  expect(rest).toEqual([])
  expect(summary.notice_key).toBe(`topic:attention-catchup:${r.master.id}:${gap.kind}.1`)
  expect(summary).toMatchObject({ agent: MASTER, route: { door: DOOR, chat: CHAT }, delivered_at: null })
  expect(summary.body).toContain("a council in it needed you (a participant did not answer)")
  expect(summary.body).toContain("not the original message")
  expect(summary.body).toContain("Right now it is open")
  expect(await owed(r, r.master)).toEqual([])
  // The council still has the same need, and it is said no other way: the summary stands for it.
  await r.project()
  await r.project({ store: r.restarted() })
  expect(await said(r), "the original is not sent after its summary").toEqual([])
  // And the same again after every kind of restart.
  await r.catchup(r.restarted())
  await r.project({ store: r.restarted() })
  expect((await caught(r, r.master)).map(one => one.notice_key)).toEqual([summary.notice_key])
  expect(await owed(r, r.master)).toEqual([])
  // No agent is handed an input: nothing here is a continuation of the council, and no other master speaks for it.
  expect(await r.s.count("inbound")).toBe(inputs)
})

test("A3 General reopens while the council's chat stays archived: the summary goes to General, once, says where the chat stands now, and nothing is sent to the archived chat", async () => {
  const r = await rig()
  await r.archive(r.master)
  await r.archive(r.general)
  await r.lose()
  await r.project()
  await r.reopen(r.general)
  expect(await r.catchup()).toBeNull()
  const [summary, ...rest] = await caught(r, r.master)
  expect(rest).toEqual([])
  expect(summary).toMatchObject({ agent: GENERAL, route: { door: DOOR, chat: GENERAL_CHAT }, delivered_at: null })
  expect(summary.body).toContain("a participant did not answer")
  expect(summary.body).toContain("Right now it is archived")
  expect(await owed(r, r.master)).toEqual([])
  expect(await said(r)).toEqual([])
  await r.project()
  await r.catchup(r.restarted())
  expect((await caught(r, r.master)).map(one => one.notice_key)).toEqual([summary.notice_key])
  expect(await said(r), "the archived chat is still not written to").toEqual([])
})

test("A4 the council's chat archived and General usable: General is told once, as it always was, nothing is written to the archived chat or kept, and a reopen replays nothing", async () => {
  const r = await rig()
  await r.archive(r.master)
  await r.lose()
  await r.project()
  await r.project({ store: r.restarted() })
  const told = await said(r)
  expect(told.map(one => one.notice_key.endsWith(":general"))).toEqual([true])
  expect(told[0]).toMatchObject({ agent: GENERAL, route: { door: DOOR, chat: GENERAL_CHAT } })
  expect(await owed(r, r.master)).toEqual([])
  await r.reopen(r.master)
  expect(await r.catchup()).toBeNull()
  await r.project()
  expect((await said(r)).map(one => one.notice_key), "the chat that was archived is not told of what General was").toEqual(told.map(one => one.notice_key))
  expect(await caught(r, r.master)).toEqual([])
})

test("A5 General archived and the council's chat usable: the chat is told once as before, nothing is queued for General or kept for it, and General reopening replays nothing", async () => {
  const r = await rig()
  await r.archive(r.general)
  await r.lose()
  await r.project()
  await r.project({ store: r.restarted() })
  const told = await said(r)
  expect(told.map(one => one.notice_key.endsWith(":general"))).toEqual([false])
  expect(told[0].route).toEqual({ door: DOOR, chat: CHAT })
  expect(await owed(r, r.master)).toEqual([])
  expect(await owed(r, r.general)).toEqual([])
  await r.reopen(r.general)
  expect(await r.catchup()).toBeNull()
  await r.project()
  expect((await said(r)).map(one => one.notice_key)).toEqual(told.map(one => one.notice_key))
  expect(await caught(r, r.general)).toEqual([])
})

test("A6 a need that opens while another is being caught up with is its own occurrence: the older summary clears only what it named, the newer gap stays for its own, and neither is said twice", async () => {
  const r = await rig()
  await r.archive(r.master)
  await r.archive(r.general)
  await r.lose()
  await r.project()
  const [first] = await owed(r, r.master)
  const read = await owed(r, r.master)

  // A second need opens after the first catch-up has read the debt.
  await r.checkpoint()
  await r.project()
  const both = await owed(r, r.master)
  expect(both.map(one => one.need).sort()).toEqual(["checkpoint", "members_missing"])
  const later = both.find(one => one.need === "checkpoint")!

  // The catch-up that had read only the first pays it, and only it.
  expect(await attentionCatchup(r.s.door, r.master.id, read.map(({ kind, seq }) => ({ kind, seq })),
    { person: PERSON, agent: MASTER, route: { door: DOOR, chat: CHAT }, key: "topic:attention-catchup", body: "the first" })).toBe("queued")
  expect((await owed(r, r.master)).map(one => [one.kind, one.seq])).toEqual([[later.kind, later.seq]])
  expect((await caught(r, r.master)).map(one => one.notice_key)).toEqual([`topic:attention-catchup:${r.master.id}:${first.kind}.${first.seq}`])
  // Still archived, the first need is not kept again: its summary stands for it.
  await r.project()
  expect((await owed(r, r.master)).map(one => one.kind)).toEqual([later.kind])

  await r.reopen(r.master)
  expect(await r.catchup()).toBeNull()
  const notices = await caught(r, r.master)
  expect(notices.map(one => one.notice_key)).toEqual([
    `topic:attention-catchup:${r.master.id}:${first.kind}.${first.seq}`,
    `topic:attention-catchup:${r.master.id}:${later.kind}.${later.seq}`,
  ].sort())
  expect(notices.find(one => one.notice_key.includes(later.kind))!.body).toContain("the checkpoint needs your decision")
  expect(notices.find(one => one.notice_key.includes(later.kind))!.body).not.toContain("did not answer")
  expect(await owed(r, r.master)).toEqual([])
  await r.project()
  await r.catchup(r.restarted())
  expect(await said(r)).toEqual([])
  expect(await caught(r, r.master)).toHaveLength(2)
})

test("A7 with no General configured and the council's chat archived the need is kept, only a reopen can pay it (nothing is polled for), and the reopened chat is told once", async () => {
  const r = await rig({ general: false })
  await r.archive(r.master)
  await r.lose()
  await r.project()
  expect(await said(r)).toEqual([])
  expect((await owed(r, r.master)).map(one => [one.need, one.cause])).toEqual([["members_missing", "general_not_configured"]])
  // Only the registry or a reopen can pay it: nothing is polled for.
  expect(await r.catchup()).toBeNull()
  await r.reopen(r.master)
  expect(await r.catchup()).toBeNull()
  expect(await caught(r, r.master)).toHaveLength(1)
  await r.project()
  expect(await said(r)).toEqual([])
  expect(await owed(r, r.master)).toEqual([])
})

test("A8 an erased council is not told about: a gap whose council is gone is cleared without a notice, and an erased topic leaves nothing to say anything for", async () => {
  const r = await rig()
  await r.archive(r.master)
  await r.archive(r.general)
  await r.lose()
  await r.project()
  expect(await owed(r, r.master)).toHaveLength(1)
  await r.reopen(r.master)

  // The council is erased (a topic's deletion does it, with the topic; here only the council goes, so the gap outlives it).
  const councils = `'${r.id}'`
  for (const table of ["council_event", "round_member", "council_round", "council_decision", "council_participant"]) {
    await r.s.su.unsafe(`delete from ${table} where council_id = ${councils}`)
  }
  await r.s.su.unsafe(`delete from council where id = ${councils}`)
  expect(await r.project()).toBeNull()
  expect(await r.catchup()).toBeNull()
  expect(await caught(r, r.master), "nothing is summarised for a council that no longer exists").toEqual([])
  expect(await owed(r, r.master), "and nothing is kept").toEqual([])
  expect(await said(r)).toEqual([])
})

test("A9 an erased topic is not brought back by the council that stood in its chat: no gap, no summary, no line anywhere", async () => {
  const r = await rig()
  await r.archive(r.master)
  await r.archive(r.general)
  await r.lose()
  await r.project()
  const councils = `'${r.id}'`
  for (const table of ["council_event", "round_member", "council_round", "council_decision", "council_participant"]) {
    await r.s.su.unsafe(`delete from ${table} where council_id = ${councils}`)
  }
  await r.s.su.unsafe(`delete from council where id = ${councils}`)
  await r.s.su.unsafe(`delete from topic_transition where topic_id = '${r.master.id}'`)
  await r.s.su.unsafe(`delete from topic_channel_seen where topic_id = '${r.master.id}'`)
  await r.s.su.unsafe(`delete from topic where id = '${r.master.id}'`)
  expect(await r.project()).toBeNull()
  await r.reopen(r.general)
  expect(await r.catchup()).toBeNull()
  expect(await r.catchup(r.restarted())).toBeNull()
  expect(await said(r)).toEqual([])
  expect(await r.s.count("outbox", "notice_key like 'topic:attention-catchup:%'")).toBe(0)
  expect(await r.s.count("topic", `id = '${r.master.id}'`)).toBe(0)
})

test("A10 the card is not edited in a chat known not to take it, and is written once the chat is reopened", async () => {
  const r = await rig()
  const effect = async () => (await r.s.su`select wanted_revision as revision, wanted_content from platform_effect where owner_ref = ${r.id}`)[0] as { revision: number; wanted_content: string }
  const start = await effect()
  await r.archive(r.master)
  // A member answers: the card's words change, long after the write window.
  await r.s.answer((await r.s.jobsOf(r.id))[0].id, "one")
  const hour = Date.now() + 3_600_000
  const next = await r.project({ at: hour })
  expect(next, "the door looks again, so a reopened chat is written to without waiting for anything else").not.toBeNull()
  expect(await effect(), "no edit was asked of the archived chat").toEqual(start)
  await r.project({ at: hour + 60_000 })
  expect((await effect()).revision).toBe(start.revision)

  await r.reopen(r.master)
  await r.project({ at: hour + 120_000 })
  const written = await effect()
  expect(written.revision).toBeGreaterThan(start.revision)
  expect(written.wanted_content).toContain("1 of 2 answered")
})
