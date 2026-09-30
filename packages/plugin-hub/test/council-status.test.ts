// The card and the notices are functions of rows. A pure part (the words, both languages, every stage) and a
// stored part (coalescing, a restarted door, a notice said once, General or a named routing issue, a quiet or long
// worker that is only said and never touched).

import { afterAll, afterEach, beforeAll, expect, test } from "bun:test"
import { startCluster, type Cluster } from "./helpers/cluster.ts"
import { councilStage, startArgs, roster } from "./helpers/council-stage.ts"
import { CHAT, DOOR, PERSON } from "./helpers/hub-fixture.ts"
import { callTool } from "../src/mcp/handlers.ts"
import { markProgress } from "../src/store/conversations.ts"
import { writeProgress } from "../src/runner/progress.ts"
import { loadRegistry, type Registry } from "../src/registry/load.ts"
import { projectCouncil } from "../src/council/watch.ts"
import { statusLine, stageKey } from "../src/council/lines.ts"
import { readSnapshot, type CouncilSnapshot, type MemberSnapshot, type MemberView } from "../src/council/snapshot.ts"

let cluster: Cluster
beforeAll(async () => { cluster = await startCluster() })
afterAll(async () => { await cluster?.stop() })

const mine: { close(): Promise<void> }[] = []
const track = <T extends { close(): Promise<void> }>(sql: T): T => { mine.push(sql); return sql }
afterEach(async () => { for (const one of mine.splice(0)) await one.close().catch(() => {}) })

const member = (name: string, view: MemberView, over: Partial<MemberSnapshot> = {}): MemberSnapshot => ({
  participant: `c:${name}`, ordinal: 1, name, view, round: 1, input_revision: 1, cause: null, activity_at: null, activity: null,
  running_seconds: null, attempt: null, wait: null, superseded: 0, ...over })

const snapshot = (members: MemberSnapshot[], over: Partial<CouncilSnapshot> = {}): CouncilSnapshot => ({
  id: "council:x", label: "Should the ledger be weighed twice?", person: "p1", route: { agent: "p1-lair", door: "door-fake", chat: "1" } as never,
  lifecycle: "running", stage: "workers-running", origin_kind: "owner_request", legacy: false, round: 1, question_revision: 1, epoch: 1, elapsed_seconds: 125,
  answered: members.filter(one => one.view === "answered").length, required: members.length, omitted: 0, members, waiting: null,
  checkpoint: { reached: false, deadline: new Date().toISOString(), extension: false }, master: null, pending_event: false, ...over })

test("S1 the card says the stage, the round and revision, the counts and each participant in plain English and in Russian, and never diagnoses", () => {
  const s = snapshot([member("p1-w1", "answered"), member("p1-w2", "running", { running_seconds: 130 }), member("p1-w3", "waiting-capacity", { wait: { kind: "slots", count: 2, held_for_master: 1 } })])
  const en = statusLine("en", s)
  expect(en).toContain("Council: Should the ledger be weighed twice?")
  expect(en).toContain("round 1 · question v1 · workers running · 1 of 3 answered · 2 min")
  expect(en).toContain("• p1-w1: answered")
  expect(en).toContain("• p1-w2: running")
  expect(en).toContain("every slot on the machine is in use (2), one is kept free for the master")
  const ru = statusLine("ru", s)
  expect(ru).toContain("Совет: Should the ledger be weighed twice?")
  expect(ru).toContain("раунд 1 · вопрос v1 · участники работают · ответили 1 из 3 · 2 мин")
  expect(ru).toContain("• p1-w1: ответил")
  expect(ru).toContain("одно оставлено для мастера")
  for (const text of [en, ru]) expect(text).not.toMatch(/stuck|failed|hung|зависл|сбо[йя]|упал/i)
  // Nothing of the machinery leaks into the words.
  for (const text of [en, ru]) expect(text).not.toMatch(/round_member|inbound|execution|claim_gate|hub_|uuid|jsonb/i)
})

test("S2 quiet is an observation about output and still says running; a waiting-owner gate and running members are shown together", () => {
  const quiet = snapshot([member("p1-w1", "quiet", { running_seconds: 900, activity_at: new Date(Date.now() - 600_000).toISOString() }), member("p1-w2", "running", { running_seconds: 900 })])
  const en = statusLine("en", quiet)
  expect(en).toMatch(/• p1-w1: running, no output observed for 10 min/)
  expect(statusLine("ru", quiet)).toMatch(/• p1-w1: работает, вывода нет уже 10 мин/)
  expect(en).not.toMatch(/missing|no answer/)

  const both = snapshot([member("p1-w1", "missing", { cause: "attempt_interrupted" as never }), member("p1-w2", "running", { running_seconds: 60 })], { lifecycle: "waiting_owner", stage: "waiting-owner",
    waiting: { kind: "members_missing" } as never })
  const text = statusLine("en", both)
  expect(text).toContain("waiting for you")
  expect(text).toContain("• p1-w1: missing")
  expect(text).toContain("• p1-w2: running")
  expect(text).toContain("Nothing is rerun without your word")
  expect(statusLine("ru", both)).toContain("Без вашего слова ничего не перезапускается")
})

test("S3 every stage has a sentence in both languages, the checkpoint line appears once it has passed, and a card stays inside the platform's limit however many participants", () => {
  const stages = ["workers-running", "waiting-machine", "waiting-capacity", "waiting-master", "assessing-next-round", "preparing-result", "waiting-owner", "stopping", "stopped", "complete"] as const
  const seen = new Set<string>()
  for (const stage of stages) {
    for (const language of ["en", "ru"] as const) {
      const text = statusLine(language, snapshot([member("p1-w1", "running")], { stage }))
      expect(text.length).toBeLessThan(1701)
      seen.add(`${language}:${stage}:${text.split("\n")[1]}`)
    }
  }
  expect(seen.size, "no two stages read the same").toBe(stages.length * 2)
  const passed = snapshot([member("p1-w1", "running")], { checkpoint: { reached: true, deadline: new Date().toISOString(), extension: false } })
  expect(statusLine("en", passed)).toContain("The checkpoint has passed: the round in progress may finish, but another round needs your OK.")
  expect(statusLine("ru", passed)).toContain("Контрольная отметка пройдена")
  const many = snapshot(Array.from({ length: 12 }, (_, at) => member(`worker-with-a-long-name-${at}`, "running", { running_seconds: 400, activity: "reading a very long file name ".repeat(4), activity_at: new Date().toISOString() })))
  for (const language of ["en", "ru"] as const) expect(statusLine(language, many).length).toBeLessThan(1701)
  // The stage key moves when the stage, the round, the revision or the count does, and not when only the clock does.
  const a = snapshot([member("p1-w1", "running")])
  expect(stageKey(a)).toBe(stageKey({ ...a, elapsed_seconds: 999 }))
  expect(stageKey(a)).not.toBe(stageKey({ ...a, round: 2 }))
  expect(stageKey(a)).not.toBe(stageKey(snapshot([member("p1-w1", "answered")])))
})

type Stage = Awaited<ReturnType<typeof councilStage>>

async function live(s: Stage, over: Record<string, unknown> = {}) {
  const started = await callTool(s.binding("attempt-start"), "hub_council", startArgs(over))
  return String(started.object_id)
}

const effectOf = async (s: Stage, id: string) => (await s.su`select key, wanted_revision as revision, wanted_content, state from platform_effect where owner_ref = ${id}`) as any[]
const noticesOf = async (s: Stage, like = "council-%") => (await s.su`select notice_key, body, route from outbox where notice_key like ${like} order by notice_key`) as any[]

test("S4 the card is coalesced: written again on a stage change only after the write window, never twice for the same words, edited (not duplicated) as the elapsed minutes it shows move, and a restarted door builds the same card", async () => {
  const s = await councilStage(cluster, track, { general: true })
  try {
    const registry = loadRegistry(s.registryFile)
    const id = await live(s)
    const jobs = await s.jobsOf(id)
    // The card SAYS how long the council has run, in whole minutes (`ago`), and that is evidence the owner reads: it is not frozen. So every
    // clock below is a number of seconds since the council's own epoch, and the minute each one shows is known, not left to how long the
    // test took to get here.
    const epoch = new Date((await s.su`select epoch_started_at from council where id = ${id}`)[0].epoch_started_at).getTime()
    const project = (seconds: number, at: Registry = registry) => projectCouncil(s.door, id, at, () => epoch + seconds * 1_000)
    const revision = async () => (await effectOf(s, id))[0].revision as number
    const words = async () => (await effectOf(s, id))[0].wanted_content as string

    // The start wanted the card already (one message, edited in place), so a first pass changes nothing it does not have to.
    expect(await effectOf(s, id)).toHaveLength(1)
    await project(0)
    const settled = await effectOf(s, id)
    expect(settled).toHaveLength(1)
    expect(settled[0].wanted_content).toContain("under a minute")

    // A member answers: the stage key changes, but the write window has not passed, so the door waits and says when.
    await s.answer(jobs[0].id, "one")
    const next = await project(1)
    expect(await revision(), "not yet written").toBe(settled[0].revision)
    expect(next).not.toBeNull()
    // After the window it is written, once, and says one of two answered.
    await project(6)
    const written = (await effectOf(s, id))[0]
    expect(written.revision).toBeGreaterThan(settled[0].revision)
    expect(written.wanted_content).toContain("1 of 2 answered")
    expect(written.wanted_content).toContain("under a minute")

    // IDENTICAL words are not another write, however often and however late inside the same displayed minute (every one of these is
    // under 60 seconds, so the card reads the same).
    for (const seconds of [7, 8, 20, 45, 59]) await project(seconds)
    expect(await revision(), "the same rendered card is one revision").toBe(written.revision)

    // The minute moves, and so do the words: ONE timed edit of the same card (same key, same row), and then nothing more inside that minute.
    await project(61)
    const minuteOne = await effectOf(s, id)
    expect(minuteOne, "one card, edited in place").toHaveLength(1)
    expect(minuteOne[0].key).toBe(written.key)
    expect(minuteOne[0].revision, "one timed edit").toBe(written.revision + 1)
    expect(minuteOne[0].wanted_content).toContain("1 min")
    expect(minuteOne[0].wanted_content).toContain("1 of 2 answered")
    for (const seconds of [61, 62, 75, 90, 100, 117]) await project(seconds)
    expect(await revision(), "the same minute is the same words").toBe(minuteOne[0].revision)

    // A stage change is written at once (after the write window), and a timed edit right behind it is COALESCED: the minute turns at 120
    // seconds, two seconds after this write, so the door waits out the edit window and says exactly when it will look again.
    await s.answer(jobs[1].id, "two")
    await project(118)
    const both = (await effectOf(s, id))[0]
    expect(both.revision).toBe(minuteOne[0].revision + 1)
    expect(both.wanted_content).toContain("2 of 2 answered")
    expect(both.wanted_content).toContain("1 min")
    const coalesced = await project(120)
    expect(await revision(), "inside the edit window: not written yet").toBe(both.revision)
    expect(coalesced).toBe(epoch + 128_000)
    await project(128)
    expect(await revision(), "written when the window opened, once").toBe(both.revision + 1)
    expect(await words()).toContain("2 min")

    // Over a long stretch, a pass every 13 seconds writes once per displayed minute and never more: the writes are bounded by the words.
    const before = await revision()
    const stretch: number[] = []
    for (let seconds = 129; seconds <= 400; seconds += 13) stretch.push(seconds)
    for (const seconds of stretch) await project(seconds)
    const newMinutes = new Set(stretch.map(seconds => Math.floor(seconds / 60)).filter(minutes => minutes > 2))
    expect(await revision()).toBe(before + newMinutes.size)
    expect(await words()).toContain(`${Math.max(...newMinutes)} min`)
    expect(await effectOf(s, id), "still one card").toHaveLength(1)

    // A restarted door starts from the rows: the same current snapshot, so the same card, no duplicate row, no new revision, wherever in
    // the same minute it looks.
    const current = (await effectOf(s, id))[0]
    const last = stretch[stretch.length - 1]
    for (const seconds of [last, Math.floor(last / 60) * 60 + 59]) await project(seconds, loadRegistry(s.registryFile))
    const after = await effectOf(s, id)
    expect(after).toHaveLength(1)
    expect(after[0].revision).toBe(current.revision)
    expect(after[0].key).toBe(current.key)
    expect(after[0].wanted_content).toBe(current.wanted_content)
  } finally { await s.close() }
}, 90_000)

test("S5 a worker that is quiet or on one attempt too long is said once, in the council's chat, and nothing is stopped, retried or called failed", async () => {
  const s = await councilStage(cluster, track, { general: true })
  try {
    const registry = loadRegistry(s.registryFile)
    const id = await live(s)
    const [j1] = await s.jobsOf(id)
    const running = await s.running(j1.id)
    // `running` leaves the attempt at feed intent: the loop has not yet been shown to have received anything, so the card calls it
    // starting and no silence is measured. It is running once the engine has the input, which is what the runner then records.
    await markProgress(s.runner, running.execution, "running")
    const [{ started_at }] = Array.from(await s.su`select started_at from execution where id = ${running.execution}`) as any[]
    const t0 = new Date(started_at).getTime()
    const minute = 60_000
    // The loop itself was seen doing something half a minute in (the runner's own progress row); silence is measured from there.
    const seen = (at: number) => writeProgress(s.runner, { messageId: j1.id, person: PERSON, agent: "p1-w1", actions: 1, lastAction: "read a file",
      startedAt: new Date(t0).toISOString(), activityAt: new Date(at).toISOString(), activity: "action" })
    await seen(t0 + 30_000)
    await projectCouncil(s.door, id, registry, () => t0 + minute)
    expect(await noticesOf(s, "council-quiet:%"), "thirty seconds of silence is not quiet").toEqual([])
    expect((await readSnapshot(s.door, id, { now: new Date(t0 + minute), quietSeconds: 300 }))?.members[0].view).toBe("running")
    // Six minutes in, five and a half of them silent (the threshold is five), and then the same pass again and again.
    for (const at of [6, 7, 8, 9]) await projectCouncil(s.door, id, registry, () => t0 + at * minute)
    const quiet = await noticesOf(s, "council-quiet:%")
    expect(quiet).toHaveLength(1)
    // The council's identity, the participant and the attempt: one condition, one key.
    expect(quiet[0].notice_key).toBe(`council-quiet:${id}:p1:${running.execution}`)
    expect(quiet[0].body).toContain("no output observed")
    expect(quiet[0].body).toContain("still running and nothing was stopped")
    // The silence said is the silence the pass's clock observed at the FIRST pass that saw it: 5.5 minutes, not what the wall clock says.
    expect(quiet[0].body).toContain("for 5 min")
    expect(quiet[0].route).toMatchObject({ door: DOOR, chat: CHAT })
    expect(await noticesOf(s, "council-overrun:%"), "nine minutes on one attempt is not an overrun").toEqual([])
    // Thirty-one minutes on one attempt: the overrun is said, once.
    for (const at of [31, 32, 40]) await projectCouncil(s.door, id, registry, () => t0 + at * minute)
    const overrun = await noticesOf(s, "council-overrun:%")
    expect(overrun).toHaveLength(1)
    expect(overrun[0].notice_key).toBe(`council-overrun:${id}:p1:${running.execution}`)
    expect(overrun[0].body).toContain("still running and nothing was stopped or rerun")
    expect(overrun[0].body).toContain("current attempt for 31 min")
    expect(overrun[0].route).toMatchObject({ door: DOOR, chat: CHAT })
    expect(await noticesOf(s, "council-quiet:%"), "the same silence is not said again as it goes on").toHaveLength(1)
    expect((await noticesOf(s, "council-%")).filter(one => one.notice_key.startsWith("council-missing")), "quiet is never called missing").toEqual([])
    // The attempt itself was never touched.
    expect((await s.su`select state from execution where id = ${running.execution}`)[0].state).toMatch(/running|feed_intent|received/)
    expect(await s.count("stop_request")).toBe(0)
    expect((await s.su`select lifecycle from council where id = ${id}`)[0].lifecycle).toBe("running")
    expect((await s.su`select state from round_member where council_id = ${id} and inbound_id = ${j1.id}`)[0].state).toBe("open")
    // Output resumes: quiet clears in the card, and there is nothing to un-say.
    // (Before it does, the same clock reads the member as quiet: the flag is an observation, and it is the output that clears it.)
    expect((await readSnapshot(s.door, id, { now: new Date(t0 + 41 * minute), quietSeconds: 300 }))?.members[0].view).toBe("quiet")
    await seen(t0 + 40 * minute)
    const snap = await readSnapshot(s.door, id, { now: new Date(t0 + 41 * minute), quietSeconds: 300 })
    expect(snap?.members[0].view).toBe("running")
  } finally { await s.close() }
}, 90_000)

test("S6 a participant that cannot be waited for is said once for that condition, with its cause, in the chat and in General; the council waits for the owner and the sibling keeps running", async () => {
  const s = await councilStage(cluster, track, { general: true })
  try {
    const registry = loadRegistry(s.registryFile)
    const id = await live(s)
    const [j1, j2] = await s.jobsOf(id)
    await s.interrupt(j1.id)
    // The sibling is really running: the engine has its input, and its attempt is the one unresolved attempt of its agent.
    const sibling = await s.running(j2.id)
    await markProgress(s.runner, sibling.execution, "running")
    const t0 = Date.now()
    for (const at of [0, 1_000, 30_000]) await projectCouncil(s.door, id, registry, () => t0 + at)
    const said = await noticesOf(s, "council-missing:%")
    expect(said.map(one => one.notice_key.endsWith(":general"))).toEqual([false, true])
    expect(said[0].body).toContain("no answer from p1-w1")
    expect(said[0].body).toContain("Nothing is rerun, replaced or left out without your word")
    expect(said[1].body).toContain("needs you: a participant did not answer")
    const [council] = Array.from(await s.su`select lifecycle, waiting from council where id = ${id}`) as any[]
    expect(council).toMatchObject({ lifecycle: "waiting_owner", waiting: { kind: "members_missing" } })
    // The sibling still runs, and nothing was replaced or rerun.
    expect((await s.su`select state from round_member where council_id = ${id} and inbound_id = ${j2.id}`)[0].state).toBe("open")
    expect(await s.count("inbound", "kind = 'job'")).toBe(2)
    expect((await s.su`select state from execution where id = ${sibling.execution}`)[0].state, "the sibling's attempt was not touched").toBe("running")
    // A different condition (another participant lost) is a new sentence; the same one is not. The sibling is lost by ENDING the attempt it
    // has (the store allows an agent one unresolved attempt and refuses a second claim on its row), not by claiming it again.
    const ended = await s.interrupt(j2.id)
    expect(ended.execution, "the running attempt itself was ended").toBe(sibling.execution)
    expect(await s.count("execution"), "no second attempt was made for either job").toBe(2)
    expect((await s.su`select state, cause from replay_hold where inbound_id = ${j2.id}`)[0]).toMatchObject({ state: "held", cause: "interrupted" })
    await projectCouncil(s.door, id, registry, () => t0 + 60_000)
    await projectCouncil(s.door, id, registry, () => t0 + 61_000)
    expect(await noticesOf(s, "council-missing:%")).toHaveLength(4)
  } finally { await s.close() }
}, 90_000)

test("S7 with no General configured the need is named as a routing issue in the council's own chat and goes nowhere else", async () => {
  const s = await councilStage(cluster, track, { general: false })
  try {
    const registry = loadRegistry(s.registryFile)
    const id = await live(s)
    const [j1] = await s.jobsOf(id)
    await s.interrupt(j1.id)
    await s.su`update council set checkpoint_deadline = now() - interval '1 minute' where id = ${id}`
    await projectCouncil(s.door, id, registry, () => Date.now())
    const said = await noticesOf(s)
    const keys = said.map(one => one.notice_key)
    expect(keys.filter(key => key.endsWith(":general")), "no General, no General notice").toEqual([])
    const routing = said.filter(one => one.notice_key.endsWith(":routing"))
    expect(routing.length).toBeGreaterThan(0)
    for (const one of routing) {
      expect(one.body).toContain("no General chat is configured for you")
      expect(one.route).toMatchObject({ door: "door-fake" })
    }
    // Every notice went to the chat the council answers in, and to none of the person's other chats.
    const chats = new Set(said.map(one => one.route.chat))
    expect(chats.size).toBe(1)
    // The same passes again say nothing new.
    await projectCouncil(s.door, id, registry, () => Date.now() + 1_000)
    expect(await noticesOf(s)).toHaveLength(said.length)
  } finally { await s.close() }
}, 60_000)

test("S8 a council that answers in another door's chats is not this door's to project, and a finished one whose last card was written is not a candidate", async () => {
  const s = await councilStage(cluster, track, { general: true })
  try {
    const id = await live(s)
    const rows = async (door: string) => Array.from(await s.su`select id from council where return_route ->> 'door' = ${door}
      and (lifecycle not in ('complete', 'stopped') or (origin_kind <> 'legacy' and (status_stage is null or (status_stage not like 'complete:%' and status_stage not like 'stopped:%'))))`).map((one: any) => one.id)
    expect(await rows("door-fake")).toEqual([id])
    expect(await rows("door-elsewhere")).toEqual([])
    await s.su`update council set lifecycle = 'complete', status_stage = 'complete:1:1:2/2:0' where id = ${id}`
    expect(await rows("door-fake")).toEqual([])
  } finally { await s.close() }
}, 60_000)

test("S9 a second council of the same person does not share a card, a notice key or an effect", async () => {
  const s = await councilStage(cluster, track, { general: true })
  try {
    const registry = loadRegistry(s.registryFile)
    const one = await live(s)
    await s.human("h3")
    const two = String((await callTool(s.binding("attempt-2"), "hub_council", startArgs({ request_key: "start-2", authority: { source_message_ids: ["h3"] }, participants: roster(["p1-w2", "p1-w3"]) }))).object_id)
    expect(two).not.toBe(one)
    await projectCouncil(s.door, one, registry, () => Date.now())
    await projectCouncil(s.door, two, registry, () => Date.now())
    const effects = await s.su`select key, owner_ref from platform_effect order by owner_ref`
    expect(new Set(effects.map((row: any) => row.key)).size).toBe(2)
    expect(new Set(effects.map((row: any) => row.owner_ref))).toEqual(new Set([one, two]))
  } finally { await s.close() }
}, 60_000)
