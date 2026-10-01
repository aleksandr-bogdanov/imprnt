// The "still waiting" line says which step is late, and the line under it
// says WHY, from a closed list of reasons, in the person's own language.
//
// A chat sat silent for hours showing only "the loop has not accepted this
// message", while the runner knew it was yielding to a paused harvest and
// never told the door. So the runner now writes down what it is waiting on,
// the door reads that beside what the store and the registry already say, and
// the clock line gets a second line naming the reason. What matches none of
// the reasons is said as such, with the raw state, and is a `check` finding.
//
// The pure half first: the whole precedence, both languages, the finding. Then
// the door itself, twice: with no runner connected at all, and with a runner
// connected that has written down the slots it is waiting for.
import { afterAll, beforeAll, expect, test } from "bun:test"
import { startCluster, until, type Cluster } from "./helpers/cluster.ts"
import { AGENT, CHAT, DOOR, PERSON, RUNNER, chatLogLines, insertInbound, stageHub, superStore } from "./helpers/hub-fixture.ts"
import { runDoor } from "../src/door/run.ts"
import { WAIT_REASONS, clockLine, waitReasonLine, waitReasonText } from "../src/door/lines.ts"
import { credentialKeyOf, waitFacts, waitReason, type WaitFacts } from "../src/door/reason.ts"
import { readUnexplainedWaits, unexplainedFindings } from "../src/check/waits.ts"
import { loadRegistry } from "../src/registry/load.ts"
import { withdrawMove } from "../src/store/moves.ts"
import { readOpenTurnsWithWait, type OpenTurnRow } from "../src/store/turns.ts"
import { moveStage } from "./helpers/move-store-stage.ts"

let cluster: Cluster
beforeAll(async () => { cluster = await startCluster() })
afterAll(async () => { await cluster?.stop() })

const NOW = Date.parse("2026-09-26T10:00:00.000Z")

/** The card's own two lines: the message-effect ledger appends a marker line under what it sends. */
const bare = (text: string): string => text.replace(/\n`hub:[0-9a-f]{16}`$/, "")

function row(fields: Partial<OpenTurnRow> = {}): OpenTurnRow {
  return { id: "m1", person: PERSON, agent: AGENT, received_at: new Date(NOW - 60_000), state: "received", claimed_by: null,
    media_state: null, media_done_at: null, reported_at: null, ...fields } as OpenTurnRow
}

function facts(fields: Partial<WaitFacts> = {}): WaitFacts {
  const it = row()
  return { row: it, stamp: "acked", open: [it], wait: null, health: null, outage: null, sleeping: false, runner: RUNNER, runnerLive: true,
    moveDest: null, moveSource: null, now: NOW, ...fields }
}

test("every reason has a sentence in both languages, and an unknown key falls back to the unknown sentence", () => {
  for (const reason of WAIT_REASONS) {
    for (const language of ["en", "ru"] as const) {
      const line = waitReasonLine(language, reason, { count: 2, holders: "a, b", cause: "x", seconds: 5, date: "d", runner: "r", state: "s", machine: "mac", source: "pi" })
      expect(line.startsWith(language === "ru" ? "[дверь] " : "[door] ")).toBe(true)
      expect(line, `${reason} in ${language} has every slot filled`).not.toMatch(/\{\w+\}/)
    }
  }
  expect(waitReasonLine("en", "something-new", { state: "x" })).toBe(waitReasonLine("en", "unknown", { state: "x" }))
})

test("the precedence: switched off, then the runner down, then the credential's outage, then the retry, then what the runner wrote, then the row itself", () => {
  expect(waitReason(facts({ sleeping: true, runnerLive: false })).kind).toBe("off")
  expect(waitReason(facts({ runnerLive: false }))).toEqual({ kind: "runner-down", values: { runner: RUNNER } })
  const outage = (cause: string) => ({ cause, since: "", said: "", credential: "c", reported_by: RUNNER, retry_at: "2026-09-27T08:00:00.000Z" })
  expect(waitReason(facts({ outage: outage("login") })).kind).toBe("login")
  expect(waitReason(facts({ outage: outage("window") }))).toEqual({ kind: "window", values: { date: "2026-09-27 08:00 UTC" } })
  const health = { status: "retry", cause: "Error: child exited", retry_at: new Date(NOW + 25_500).toISOString() }
  expect(waitReason(facts({ health }))).toEqual({ kind: "retry", values: { cause: "Error: child exited", seconds: 26 } })
  // A retry whose moment has passed explains nothing any more.
  expect(waitReason(facts({ health: { ...health, retry_at: new Date(NOW - 1000).toISOString() } })).kind).not.toBe("retry")
  expect(waitReason(facts({ wait: { kind: "slots", count: 1, holders: ["p2-lair"] } })))
    .toEqual({ kind: "slots", values: { count: 1, holders: "p2-lair" } })
  // A budget that is full with slots to spare is its own sentence, with the numbers.
  expect(waitReason(facts({ wait: { kind: "memory", budget_mb: 3072, used_mb: 2048, reserve_mb: 2048 } })))
    .toEqual({ kind: "memory", values: { budget: 3072, used: 2048, reserve: 2048 } })
  expect(waitReasonLine("en", "memory", { budget: 3072, used: 2048, reserve: 2048 }))
    .toBe("[door] the runner's memory budget of 3072 MB is used up: 2048 MB held, and this agent needs 2048 MB.")
  expect(waitReason(facts({ wait: { kind: "starting" } })).kind).toBe("starting")
  expect(waitReason(facts({ wait: { kind: "harvest" } })).kind).toBe("harvest")
  const started = row({ state: "started", claimed_by: RUNNER })
  expect(waitReason(facts({ row: started, open: [started], stamp: "answered" })).kind).toBe("working")
  const earlier = row({ id: "m0", state: "started", claimed_by: RUNNER, received_at: new Date(NOW - 120_000) })
  expect(waitReason(facts({ open: [earlier, row()] })).kind).toBe("previous")
  // Nothing matches: the raw state is carried, so a new silence is visible.
  expect(waitReason(facts())).toEqual({ kind: "unknown", values: { state: "received/unclaimed" } })
  const found = unexplainedFindings({ machine: "pi", runnerOf: () => RUNNER,
    waits: [{ id: "m1", person: PERSON, agent: AGENT, stamp: "acked", state: "received/unclaimed", at: new Date(NOW).toISOString() }] })
  expect(found).toHaveLength(1)
  expect(found[0]).toMatchObject({ id: "pi/wait-unexplained:m1", kind: "wait-unexplained", subject: "m1" })
  expect(found[0].says).toContain("received/unclaimed")
  expect(found[0].fix).toContain(`imprnt-hub-${RUNNER}`)
})

test("a message the move's gate holds says so: the move outranks a runner that is down, a switched-off agent outranks the move, and a claimed row is not held by it", () => {
  const moving = { moveDest: "mac", moveSource: "pi" }
  expect(waitReason(facts(moving))).toEqual({ kind: "moving", values: { machine: "mac", source: "pi" } })
  // The runner being down is a second fact the move already explains, and a switched-off agent explains everything after it.
  expect(waitReason(facts({ ...moving, runnerLive: false })).kind).toBe("moving")
  expect(waitReason(facts({ ...moving, runnerLive: false, sleeping: true })).kind).toBe("off")
  // A row somebody already claimed is not waiting on the gate (the gate holds only what was not yet taken).
  const claimed = row({ state: "started", claimed_by: RUNNER })
  expect(waitReason(facts({ ...moving, row: claimed, open: [claimed], stamp: "answered" })).kind).toBe("working")
  // The sentence names the machine it goes to and the one it stays on, never promises the destination alone, and sends the owner to the door's status,
  // which shows the exact withdrawal command: it never offers the bare words (they only read the status) and carries no id of the move.
  const en = waitReasonLine("en", "moving", { machine: "mac", source: "pi" })
  expect(en).toContain("being moved to mac")
  expect(en).toContain("on mac if it goes through, on pi if it is withdrawn")
  expect(en).toContain("Send /move to see where it stands: it shows the exact command to withdraw it")
  expect(en).not.toContain("/move withdraw")
  const ru = waitReasonLine("ru", "moving", { machine: "mac", source: "pi" })
  expect(ru).toContain("Напишите /перенос, чтобы узнать, где перенос: там точная команда, чтобы отозвать его")
  expect(ru).not.toContain("/перенос отозвать")
  expect(en).not.toContain("unknown")
})

test("the door's own read of a held message carries the agent's open move from the store, reads as `moving` and not `unknown`, and lets go of a move that was withdrawn", async () => {
  const mine: { close(): Promise<void> }[] = []
  const fix = await moveStage(cluster, sql => { mine.push(sql); return sql })
  try {
    await fix.fleet()
    const topic = await fix.topic("coffee")
    await fix.inbound("m-held", topic.agent_id)
    const read = () => readOpenTurnsWithWait(fix.door, { agent: topic.agent_id, runner: "runner-pi", credential: null })
    const reason = async () => {
      const seen = await read()
      return waitReason(waitFacts(seen.sidecar, { registry: {}, agent: { id: topic.agent_id, preset: "daily", runner: "runner-pi" } as never, row: seen.rows[0], stamp: "acked", open: seen.rows }))
    }
    // The runner's liveness is the store's own reading of a session named for it. Nothing here has connected as `runner-pi`, so with no move the
    // reason is the runner being down, and that is the baseline: the read is not "unknown" until a runner of that name really is on the store.
    expect((await read()).sidecar).toMatchObject({ moveDest: null, moveSource: null, runnerLive: false })
    expect(await reason()).toEqual({ kind: "runner-down", values: { runner: "runner-pi" } })
    // (`fix.as` tracks the session, so the cleanup below closes it even if this test stops before it disconnects on purpose.)
    const live = fix.as("hub_runner").sql as unknown as { unsafe(query: string, values?: unknown[]): Promise<unknown>; close(): Promise<void> }
    await live.unsafe("select set_config('application_name', $1, false)", ["runner-pi"])
    expect((await read()).sidecar).toMatchObject({ moveDest: null, moveSource: null, runnerLive: true })
    expect((await reason()).kind).toBe("unknown")

    const move = await fix.request(topic)
    expect((await read()).sidecar).toMatchObject({ moveDest: "mac", moveSource: "pi", runnerLive: true })
    expect(await reason()).toEqual({ kind: "moving", values: { machine: "mac", source: "pi" } })
    // Another agent's move holds nothing of this one's.
    const other = await fix.topic("tea")
    await fix.inbound("m-other", other.agent_id)
    expect((await readOpenTurnsWithWait(fix.door, { agent: other.agent_id, runner: "runner-pi", credential: null })).sidecar.moveDest).toBeNull()

    // The runner really disconnects while the move stands: the move still outranks the runner being down, as the precedence says.
    await live.close()
    await until("the store no longer sees runner-pi", async () => !(await read()).sidecar.runnerLive, 10_000)
    expect((await read()).sidecar).toMatchObject({ moveDest: "mac", moveSource: "pi", runnerLive: false })
    expect(await reason()).toEqual({ kind: "moving", values: { machine: "mac", source: "pi" } })

    // Withdrawn, the gate lets go: the reason is the runner's being down again, not the move and not unknown.
    expect(await withdrawMove(fix.door, move.id, "owner")).toBe("withdrawn")
    expect((await read()).sidecar).toMatchObject({ moveDest: null, moveSource: null, runnerLive: false })
    expect(await reason()).toEqual({ kind: "runner-down", values: { runner: "runner-pi" } })
  } finally { for (const one of mine) await one.close().catch(() => {}) }
}, 60_000)

/** A staged door whose acked clock is one second, with the fixture sender allowed. */
async function stage(language: "en" | "ru") {
  const it = await stageHub(cluster, {
    hub: { tick_seconds: 1 },
    people: [{ id: PERSON, language, acked_seconds: 1, started_seconds: 600, answered_seconds: 900 }],
  })
  await Bun.write(it.registryFile, (await Bun.file(it.registryFile).text())
    .replaceAll("[[people]]", '[[people]]\nallowed_senders = { "door-fake" = ["fixture-sender"] }'))
  return it
}

test("with no runner connected, the status card carries the runner-down reason under its state line, and the chat log and the ledger row carry the clock's own sentence and the reason line", async () => {
  const it = await stage("en")
  let door: Awaited<ReturnType<typeof runDoor>> | undefined
  try {
    door = await runDoor({ door: DOOR, registryFile: it.registryFile, platform: it.fake.platform })
    it.fake.deliver({ text: "a question nobody is there to take" })
    const reason = waitReasonLine("en", "runner-down", { runner: RUNNER })
    const sentence = waitReasonText("en", "runner-down", { runner: RUNNER })
    await until("the door said why", () => it.fake.posts().some(p => bare(p.text).endsWith(`\n${sentence}`)), 20_000,
      () => `posts=${JSON.stringify(it.fake.posts().map(p => p.text))}`)
    const posts = it.fake.posts().map(p => p.text)
    expect(posts, "one message: the reason is the card's second line and not a message of its own").toHaveLength(1)
    expect(posts[0], "the reason is the line right under the state line").toMatch(
      /^\[door\] still waiting: the loop has not accepted this message · (?:<1m|\d+m)\n/)
    expect(bare(posts[0]).endsWith(`\n${sentence}`)).toBe(true)
    expect(posts[0], "the ledger's marker is the only line under the card").toMatch(/\n`hub:[0-9a-f]{16}`$/)
    const logged = chatLogLines(it.stateDir, PERSON, AGENT).filter(line => line.text === reason)
    expect(logged, "written down once, as the door").toHaveLength(1)
    expect(logged[0].from).toBe(DOOR)
    const [expired] = await it.read.ledger({ stream: "clock" })
    expect(chatLogLines(it.stateDir, PERSON, AGENT).some(line => line.text === clockLine("en", "acked", Number(expired.detail.seconds))),
      "the clock's own sentence is in the chat log, unchanged").toBe(true)
    expect(expired.detail.why).toMatchObject({ kind: "runner-down", values: { runner: RUNNER } })
    expect(String((expired.detail.why as { id: string }).id)).toBe(`clock:${(await it.read.inbound())[0].id}:acked:why`)
  } finally { await door?.stop(); await it.stop() }
}, 60_000)

test("check reads the newest clock line of a message, so one explained later is no longer an unexplained wait, and a credential-less preset is keyed the way the runner keys it", async () => {
  const it = await stage("en")
  const store = await superStore(cluster, it.db)
  try {
    expect(credentialKeyOf(loadRegistry(it.registryFile), { preset: "daily" }), "the runner's own key for a preset with no credential").toBe("preset:daily")
    await insertInbound(cluster, it.db, { id: "m-explained", body: "first unknown, then working" })
    await insertInbound(cluster, it.db, { id: "m-unknown", body: "still unknown" })
    const clock = async (subject: string, stamp: string, kind: string, at: string) => {
      await it.read.sql("insert into ledger_event (at, stream, subject, kind, actor, detail) values ($1, 'clock', $2, 'expired', 'door', $3::text::jsonb)",
        [at, subject, JSON.stringify({ stamp, seconds: 30, why: { id: `clock:${subject}:${stamp}:why`, kind, values: { state: "received/unclaimed" } } })])
    }
    await clock("m-explained", "acked", "unknown", "2026-09-26T10:00:00.000Z")
    await clock("m-explained", "started", "working", "2026-09-26T10:01:00.000Z")
    await clock("m-unknown", "acked", "unknown", "2026-09-26T10:00:00.000Z")
    const waits = await readUnexplainedWaits(store, { agents: [AGENT] })
    expect(waits.map(w => w.id), "only the message whose newest line found no reason").toEqual(["m-unknown"])
    expect(waits[0].state, "the raw state the door wrote, read from where it wrote it").toBe("received/unclaimed")
    expect(unexplainedFindings({ waits, runnerOf: () => RUNNER, machine: "pi" })[0].says).toContain("received/unclaimed")
  } finally { await store.close(); await it.stop() }
}, 60_000)

test("with a runner connected that wrote down the slots it is waiting for, the reason names the agents holding them, in Russian", async () => {
  const it = await stage("ru")
  const runner = cluster.connect(it.db)
  let door: Awaited<ReturnType<typeof runDoor>> | undefined
  try {
    // The runner's own connection, named the way `openStore` names it, and
    // the row the runner writes while it waits for a slot.
    await runner.unsafe("select set_config('application_name', $1, false)", [RUNNER])
    await it.read.sql("insert into state_row (sheet, id, data) values ('agent_wait', $1, $2::text::jsonb)",
      [AGENT, JSON.stringify({ kind: "slots", count: 1, holders: ["p2-lair"], at: new Date().toISOString() })])
    door = await runDoor({ door: DOOR, registryFile: it.registryFile, platform: it.fake.platform })
    it.fake.deliver({ text: "вопрос, который ждёт слота" })
    const reason = waitReasonLine("ru", "slots", { count: 1, holders: "p2-lair" })
    expect(reason).toBe("[дверь] все слоты агентов заняты (1): p2-lair.")
    const sentence = waitReasonText("ru", "slots", { count: 1, holders: "p2-lair" })
    await until("the door said why, in Russian", () => it.fake.posts().some(p => bare(p.text).endsWith(`\n${sentence}`)), 20_000,
      () => `posts=${JSON.stringify(it.fake.posts().map(p => p.text))}`)
    expect(it.fake.posts().every(p => p.chat === CHAT)).toBe(true)
    expect(it.fake.posts().some(p => /runner-test|не работает/.test(p.text)), "the runner is connected, so it is not down").toBe(false)
  } finally { await door?.stop(); await runner.end?.(); await it.stop() }
}, 60_000)
