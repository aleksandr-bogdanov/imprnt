// The inventory of what a deletion has to account for: every state sheet the source writes is classified (and a new one fails here until it
// is), the store removes exactly the scoped ones, and the copies that are not rows (a movement copy's location, the notes staged for the vault,
// the council proposals and the messages posted elsewhere) are erased by what recorded them, with the one that cannot be proved left named.
//
// Real store, real door task, real hub pass over a fake Discord. What is PLANTED, and decides nothing the code under test decides: the rows and
// files a topic would hold, and the movement the owner withdrew.

import { afterAll, afterEach, beforeAll, expect, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { hubPath, startCluster, type Cluster } from "./helpers/cluster.ts"
import { bound, confirmed, count, finish, hub } from "./helpers/deletion-fixture.ts"
import { closeStages, removeEffectDirs } from "./helpers/effects-fixture.ts"
import { DOOR, OWNER, PERSON, RUNNER_MAC, RUNNER_PI, stageTopics } from "./helpers/topics-fixture.ts"
import { SCOPED_SHEETS, UNSCOPED_SHEETS, sampleRow } from "../src/erasure/inventory.ts"
import { harvestStagesOf, managedPath, recordedAgrees } from "../src/erasure/files.ts"
import { readDeletion, receiptsOf } from "../src/store/deletions.ts"

let cluster: Cluster
beforeAll(async () => { cluster = await startCluster() })
afterEach(closeStages)
afterAll(async () => {
  removeEffectDirs()
  await cluster?.stop()
})

/** Every state sheet the source writes or reads by name. A sheet found nowhere here is not looked for, so the patterns are the code's own. */
function sheetsInSource(): Set<string> {
  const root = hubPath("src")
  const found = new Set<string>()
  for (const file of new Bun.Glob("**/*.ts").scanSync(root)) {
    const text = readFileSync(join(root, file), "utf8")
    for (const one of text.matchAll(/_SHEET\s*=\s*"([a-z_]+)"/g)) found.add(one[1])
    for (const one of text.matchAll(/\b(?:putRow|claimRow|readRow|readSheet|removeRow)\(\s*[A-Za-z_.]+\s*,\s*"([a-z_]+)"/g)) found.add(one[1])
    for (const one of text.matchAll(/sheet\s*=\s*'([a-z_]+)'/g)) found.add(one[1])
  }
  return found
}

test("every state sheet the source writes is a topic's or is not, and the store removes exactly the topic's: a sheet nobody classified fails here instead of surviving a deletion", async () => {
  const found = sheetsInSource()
  // The control: the search finds what is known to be there.
  for (const known of ["harvest", "move_command", "agent_wait", "door_cursor", "sender_denied", "outage"]) expect(found.has(known), known).toBe(true)
  const classified = new Set([...Object.keys(SCOPED_SHEETS), ...Object.keys(UNSCOPED_SHEETS)])
  expect([...found].filter(name => !classified.has(name)), "sheets in neither list").toEqual([])
  expect(Object.keys(SCOPED_SHEETS).filter(name => name in UNSCOPED_SHEETS), "a sheet in both lists").toEqual([])

  // The store's own closed list says yes to every scoped sheet's row for the topic, and no to the same row of another topic or to an unscoped sheet.
  const s = await stageTopics(cluster)
  const mine = { agent: "t-mine", person: "p1", door: "door-1", chat: "chat-1", input: "in-1" }
  const theirs = { agent: "t-theirs", person: "p1", door: "door-1", chat: "chat-2", input: "in-2" }
  const owns = async (sheet: string, who: typeof mine): Promise<boolean> => {
    const row = sampleRow(sheet, who)
    const [answer] = await s.admin`select hub_erasure_owns_row(${sheet}, ${row.id}, ${row.data}::jsonb, ${mine.agent}, ${mine.person}, ${mine.door}, ${mine.chat}, array[${mine.input}]::text[]) as owns`
    return answer.owns === true
  }
  for (const sheet of Object.keys(SCOPED_SHEETS)) {
    expect(await owns(sheet, mine), `${sheet} is removed for its own topic`).toBe(true)
    expect(await owns(sheet, theirs), `${sheet} is kept for another topic`).toBe(false)
  }
  for (const sheet of Object.keys(UNSCOPED_SHEETS)) {
    const [answer] = await s.admin`select hub_erasure_owns_row(${sheet}, ${mine.agent}, ${{ agent: mine.agent }}::jsonb, ${mine.agent}, ${mine.person}, ${mine.door}, ${mine.chat}, array[${mine.agent}]::text[]) as owns`
    expect(answer.owns, `${sheet} is not a topic's`).toBe(false)
  }
}, 120_000)

test("a movement copy's location is the one the movement manifest derives and the copy's own record is checked against it; the notes staged for the vault are removed by the agent's own name and no other's", () => {
  const state = "/state"
  const agent = "t-3f2a-11"
  const conversation = "9d4c0b7e-1111-2222-3333-444455556666"
  const derived = managedPath(state, "p1", { class: "move_copy", location: "move-1-g1", detail: { agent, conversation } })
  expect(derived).toBe(join("/state", "p1", "sessions", agent, conversation))
  // Nothing is derived from a copy that does not name its agent and conversation in the shapes the id system makes.
  for (const detail of [{}, { agent, conversation: "../x" }, { agent: "Upper", conversation }, { agent: "a/b", conversation }, { agent, conversation: 7 }]) {
    expect(managedPath(state, "p1", { class: "move_copy", location: "move-1-g1", detail: detail as Record<string, unknown> }), JSON.stringify(detail)).toBeNull()
  }
  // What the copy recorded must be that location (as configured, or as the file system names it); another place is named and never removed.
  expect(recordedAgrees(state, "p1", { agent, conversation }, derived!, [derived, `${state}/p1/sessions/${agent}/${conversation}`])).toEqual({ agrees: true })
  expect(recordedAgrees(state, "p1", { agent, conversation }, derived!, [])).toEqual({ agrees: true })
  expect(recordedAgrees(state, "p1", { agent, conversation }, derived!, [derived, "/elsewhere/session"])).toEqual({ agrees: false, differs: "/elsewhere/session" })
  expect(recordedAgrees(state, "p1", { agent, conversation }, derived!, [42])).toMatchObject({ agrees: false })

  const names = [
    `harvest-${agent}-2026-01-01T00-00-00.000Z`, `harvest-${agent}-2026-02-03T10-11-12.000Z`,
    `harvest-${agent}-notes-2026-01-01T00-00-00.000Z`, `harvest-${agent}x-2026-01-01T00-00-00.000Z`, "harvest-t-other-2026-01-01T00-00-00.000Z", "readme.md",
  ]
  expect(harvestStagesOf(names, agent)).toEqual(names.slice(0, 2))
  expect(harvestStagesOf(names, "../t-x")).toEqual([])
})

test("the active copies that are not rows: movement copies by their recorded location, staged notes, refused-sender rows, and the council proposals and the messages they left elsewhere", async () => {
  const s = await stageTopics(cluster)
  const topic = await bound(s)
  const agent = topic.agent_id
  const conversation = topic.conversation_id
  const root = join(s.dir, PERSON)

  // The session directory every movement copy of this conversation shares, with the transcript an import staged in it.
  const sessionDir = join(root, "sessions", agent, conversation)
  mkdirSync(join(sessionDir, "config"), { recursive: true })
  writeFileSync(join(sessionDir, "config", "t.jsonl"), "UNIQUE-SECRET-NATIVE\n")
  // A reconciled return preserves the old bytes under the same managed agent
  // directory; the master engine_state receipt must erase this sibling too.
  const retainedArchive = `${sessionDir}-retained-${crypto.randomUUID()}`
  mkdirSync(join(retainedArchive, "session"), { recursive: true })
  writeFileSync(join(retainedArchive, "session", "old.jsonl"), "RETAINED-NATIVE-SECRET")
  // A place a copy recorded that is NOT the derived one: it is named, and never touched.
  const elsewhere = join(s.dir, "elsewhere-session")
  mkdirSync(elsewhere)
  writeFileSync(join(elsewhere, "keep.txt"), "not this topic's to remove\n")
  // Notes staged for the vault: this agent's, and another agent's.
  const mine = join(root, "harvest", `harvest-${agent}-2026-01-01T00-00-00.000Z`)
  const other = join(root, "harvest", "harvest-p1-general-2026-01-01T00-00-00.000Z")
  for (const dir of [mine, other]) { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, "1.md"), "UNIQUE-SECRET-NOTE\n") }

  // A withdrawn movement and its two copies: the source's retained session on the Pi (it recorded nothing), and the destination's staged
  // import on the Mac, which recorded a place the derivation does not give.
  await s.admin`insert into topic_move (id, operation_id, topic_id, agent, person, requested_by, source_runner, source_machine, dest_runner, dest_machine,
      conversation_id, adapter, native_session, native_state, source_generation, stage)
    values ('mv-1', 'op-mv-1', ${topic.id}, ${agent}, ${PERSON}, ${OWNER}, ${RUNNER_PI}, 'pi', ${RUNNER_MAC}, 'mac', ${conversation}, 'synthetic', 'n', 'new', 1, 'withdrawn')`
  await s.admin`insert into move_copy (move_id, machine, kind, generation, state, staging_id, runner, incarnation, conversation_id, native_session, placement_generation, evidence)
    values ('mv-1', 'pi', 'source_session_retained', 1, 'retained_stale', 'source-mv-1', ${RUNNER_PI}, 'inc-1', ${conversation}, 'n', 1, ${{ promoted: { receipt: { destination: realpathSync(sessionDir) } } }}::jsonb),
           ('mv-1', 'mac', 'dest_import', 1, 'cleanup_due', 'move-mv-1-g1', ${RUNNER_MAC}, 'inc-2', ${conversation}, 'n', 1, ${{ promote_intent: { session_dir: elsewhere } }}::jsonb)`

  // Refused-sender rows of this chat and of General's.
  const denied = (chat: string, who: string) => ({ door: DOOR, chat, sender_id: "300000000000000001", person: PERSON, agent: who, first_at: "2026-01-01T00:00:00Z", last_at: "2026-01-01T00:00:00Z" })
  await s.admin`insert into state_row (sheet, id, data) values ('sender_denied', ${`${DOOR}/${topic.chat}/300000000000000001`}, ${denied(topic.chat!, agent)}::jsonb),
    ('sender_denied', ${`${DOOR}/${s.general}/300000000000000001`}, ${denied(s.general, "p1-general")}::jsonb)`

  // A council proposal this agent made (it carries the question), the message that showed it in General, and another agent's proposal.
  const proposal = (who: string) => ({ kind: "council.start", master: { agent: who }, question: "UNIQUE-SECRET-QUESTION" })
  await s.admin`insert into confirmation (id, operation_id, operation_kind, revision, person, door, chat, owner_sender, payload, payload_hash, effect_keys, state)
    values ('cf-mine', 'op-cf-mine', 'council.start', 1, ${PERSON}, ${DOOR}, ${topic.chat}, ${OWNER}, ${proposal(agent)}::jsonb, 'h1', array['eff-mine'], 'pending'),
           ('cf-theirs', 'op-cf-theirs', 'council.start', 1, ${PERSON}, ${DOOR}, ${s.general}, ${OWNER}, ${proposal("p1-general")}::jsonb, 'h2', array['eff-theirs'], 'pending')`
  await s.admin`insert into platform_effect (key, door, chat, owner_ref, marker, nonce, state, platform_id, wanted_content, applied_revision, attempt_id, attempt_revision, attempt_hash)
    values ('eff-mine', ${DOOR}, ${s.general}, 'confirmation:cf-mine', 'mk-1', 'nonce-1', 'confirmed', '900000000000000123', 'proposal mk-1 UNIQUE-SECRET-QUESTION', 1, 'att-1', 1, 'hash-1'),
           ('eff-theirs', ${DOOR}, ${s.general}, 'confirmation:cf-theirs', 'mk-2', 'nonce-2', 'confirmed', '900000000000000124', 'proposal mk-2 another question', 1, 'att-2', 1, 'hash-2')`

  const op = await confirmed(s, topic)
  const store = s.as("hub_hub")
  const preview = (await readDeletion(store, op))!
  // The receipts were written before anything was erased, and say where each copy is: the movement copies by machine, the notes by agent.
  expect((await receiptsOf(store, op, { classes: ["harvest_stage"] })).map(one => `${one.machine}:${one.location}`)).toEqual([`mac:${agent}`, `pi:${agent}`])
  const copies = await receiptsOf(store, op, { classes: ["move_copy"] })
  expect(copies.map(one => `${one.machine}:${one.detail.kind}`)).toEqual(["mac:dest_import", "pi:source_session_retained"])
  expect(copies.find(one => one.machine === "mac")!.detail).toMatchObject({ agent, conversation, recorded: [elsewhere] })
  expect(preview.stage).toBe("quiescing")

  await finish(s)

  // THE SESSION AND THE STAGED NOTES of this topic are gone; another agent's staged notes and the unrelated place the copy recorded are not.
  expect(existsSync(sessionDir)).toBe(false)
  expect(existsSync(retainedArchive)).toBe(false)
  expect([existsSync(mine), existsSync(other), existsSync(elsewhere)]).toEqual([false, true, true])
  // THE MOVEMENT COPIES: the retained one is shown gone at the location the manifest derives; the destination's recorded another place, so
  // it is blocked by name and nothing was removed at that place.
  const after = await receiptsOf(store, op, { classes: ["move_copy"] })
  expect(after.find(one => one.machine === "pi")).toMatchObject({ state: "erased", detail: { derived: "movement-manifest" } })
  expect(after.find(one => one.machine === "mac")).toMatchObject({ state: "blocked", detail: { code: "movement_copy_path_differs", recorded: elsewhere } })
  expect((await receiptsOf(store, op, { classes: ["harvest_stage"] })).map(one => one.state)).toEqual(["erased", "erased"])
  // So the deletion is not complete, and says which copy is the reason.
  const done = (await readDeletion(store, op))!
  expect(done.stage).toBe("blocked_scope")
  expect(done.blocked!.refused.map(one => `${one.class}:${one.machine}`)).toEqual(["move_copy:mac"])
  const said = (await s.admin`select body from outbox where notice_key = ${`topic:deletion-blocked:${op}`}`)[0]
  expect(said.body).toContain("a copy kept by a machine move (mac)")
  expect((await s.admin`select 1 from outbox where notice_key = ${`topic:deleted:${op}`}`).length).toBe(0)

  // THE ROWS: the refused-sender row, the proposal and the message that showed it are this topic's and are gone; General's are not.
  expect(await count(s, "state_row", `sheet = 'sender_denied' and data ->> 'agent' = '${agent}'`)).toBe(0)
  expect(await count(s, "state_row", "sheet = 'sender_denied' and data ->> 'agent' = 'p1-general'")).toBe(1)
  expect(await count(s, "confirmation", "id = 'cf-mine'")).toBe(0)
  expect(await count(s, "confirmation", "id = 'cf-theirs'")).toBe(1)
  expect(await count(s, "platform_effect", "key = 'eff-mine'")).toBe(0)
  expect(await count(s, "platform_effect", "key = 'eff-theirs'")).toBe(1)
  expect(await count(s, "topic_move", "id = 'mv-1'")).toBe(0)
  expect(await count(s, "move_copy", "move_id = 'mv-1'")).toBe(0)
  const shown = (await receiptsOf(store, op, { classes: ["platform_message"] })).find(one => one.location === `${s.general}/900000000000000123`)
  expect(shown, "the message that showed the proposal was inventoried").toBeDefined()
  expect(shown!.state).toBe("erased")
  // A pass again changes nothing: the blocked copy stays blocked, and is asked about again rather than called erased.
  await hub(s, "mac")
  expect((await readDeletion(store, op))!.stage).toBe("blocked_scope")
}, 120_000)
