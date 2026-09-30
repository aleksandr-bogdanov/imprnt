// How a council begins: the roster is explicit and exact, an owner's own request starts at once, an
// agent's own idea is frozen whole and starts only on the owner's reaction, a worker can only propose
// and is pinned to its parent's master and owner, and every one of them is one request however often
// it is asked. Real store, real handlers, no runner and no door: the rows are what is asserted.

import { afterAll, afterEach, beforeAll, expect, test } from "bun:test"
import { startCluster, type Cluster } from "./helpers/cluster.ts"
import { CHAT, DOOR, PERSON, RUNNER } from "./helpers/hub-fixture.ts"
import { councilStage, QUESTION, roster, startArgs, WORKERS } from "./helpers/council-stage.ts"
import { jobSource } from "./helpers/conversations.ts"
import { callTool } from "../src/mcp/handlers.ts"
import { ToolError } from "../src/mcp/contracts.ts"
import { readCouncilRequest } from "../src/mcp/council-contract.ts"
import { admitJob } from "../src/runner/job.ts"
import { taskDigest } from "../src/door/dispatch.ts"
import { councilApprovals } from "../src/council/approval.ts"
import { councilIdOf } from "../src/council/start.ts"
import { loadRegistry } from "../src/registry/load.ts"
import { readConfirmation } from "../src/store/confirmations.ts"
import { conversationFor } from "../src/store/conversations.ts"

let cluster: Cluster
beforeAll(async () => { cluster = await startCluster() })
afterAll(async () => { await cluster?.stop() })

const mine: { close(): Promise<void> }[] = []
const track = <T extends { close(): Promise<void> }>(sql: T): T => { mine.push(sql); return sql }
afterEach(async () => { for (const one of mine.splice(0)) await one.close().catch(() => {}) })

async function code(run: Promise<unknown>): Promise<string> {
  try { await run; return "no error" } catch (error) { return error instanceof ToolError ? error.code : `not a ToolError: ${(error as Error).message}` }
}

const TABLES = ["council", "council_participant", "council_round", "round_member", "council_decision", "council_event", "tool_invocation", "source_consumption", "platform_effect", "confirmation"]

async function nothingWritten(s: Awaited<ReturnType<typeof councilStage>>, why: string) {
  for (const table of TABLES) expect(await s.count(table), `${why}: ${table}`).toBe(0)
  expect(await s.count("inbound", "kind = 'job'"), `${why}: no job`).toBe(0)
}

// ---------------------------------------------------------------------------
// The tool's arguments, read strictly (pure).
// ---------------------------------------------------------------------------

test("C1 the tool reads only what its schema names: no identity, no route, no approval, one authority, one tagged decision", () => {
  const good = { action: "start", request_key: "k", authority: { source_message_ids: ["a"] }, question: "q" }
  expect(readCouncilRequest(good)).toMatchObject({ action: "start", source_message_ids: ["a"], proposal: false, debate: false, context: [] })
  expect(readCouncilRequest({ ...good, authority: { proposal: true } })).toMatchObject({ action: "start", proposal: true })
  expect(() => readCouncilRequest({ ...good, authority: { proposal: true, source_message_ids: ["a"] } }), "both authorities").toThrow(ToolError)
  expect(() => readCouncilRequest({ ...good, authority: {} }), "no authority").toThrow(ToolError)
  for (const extra of [{ person: "p2" }, { agent: "x" }, { conversation: "c" }, { route: "door/chat" }, { approved: true }, { approver: "p1" }]) {
    expect(() => readCouncilRequest({ ...good, ...extra }), JSON.stringify(extra)).toThrow(/does not take/)
  }
  expect(() => readCouncilRequest({ ...good, context: [{ artifact_ref: "x" }] })).toThrow(ToolError)
  expect(() => readCouncilRequest({ action: "delete" })).toThrow(/no action/)

  const move = { action: "continue", request_key: "k", council_id: "c", expected_revision: 3 }
  expect(() => readCouncilRequest({ ...move, kind: "finalize", participants: ["p"] }), "finalize takes no participants").toThrow(/does not take/)
  expect(() => readCouncilRequest({ ...move, kind: "owner_decision" }), "a decision needs the owner's messages").toThrow(/source_message_ids/)
  const decide = (decision: unknown) => readCouncilRequest({ ...move, kind: "owner_decision", source_message_ids: ["m"], decision })
  expect(decide({ choice: "use_available", affected_ids: ["p1"] })).toMatchObject({ decision: { choice: "use_available", affected_ids: ["p1"] } })
  expect(decide({ choice: "extend", extension_scope: { minutes: 30 } })).toMatchObject({ decision: { choice: "extend", extension_scope: { minutes: 30 } } })
  expect(() => decide({ choice: "extend", extension_scope: { minutes: 30, rounds: 1 } }), "not two scopes at once").toThrow(ToolError)
  expect(() => decide({ choice: "wait", affected_ids: ["p1"], extension_scope: { rounds: 1 } }), "not flags of another choice").toThrow(/does not take/)
  expect(() => decide({ choice: "replace", affected_ids: ["p1", "p2"], replacement_spec: { worker_ref: "w", preset_ref: "d", machine_ref: "m", brief: "b" } })).toThrow(ToolError)
  expect(() => decide({ choice: "retry" }), "a retry names who").toThrow(ToolError)
  expect(() => readCouncilRequest({ ...move, kind: "debate_round", participants: ["p1"], briefs: [{ participant_id: "p1", text: "t" }], expected_revision: 0 })).toThrow(/revision/)
  expect(() => readCouncilRequest({ ...move, kind: "follow_up", participants: ["p1"], briefs: [{ participant_id: "p1", text: "t" }] }), "a follow-up cites the owner").toThrow(/source_message_ids/)
})

// ---------------------------------------------------------------------------
// The roster is explicit.
// ---------------------------------------------------------------------------

test("C2 a roster that is not fully named starts nothing, queues nothing, writes nothing, and answers with the real choices", async () => {
  const s = await councilStage(cluster, track)
  try {
    const call = (args: Record<string, unknown>) => callTool(s.binding(), "hub_council", args)
    const { participants: _left, ...noRoster } = startArgs()
    const asked = await call(noRoster)
    expect(asked).toMatchObject({ status: "waiting_owner", stage: "needs_participants", cause: "needs_participants", object_id: null, revision: null })
    const choices = asked.choices as { worker_ref: string; preset_ref: string; machine_ref: string }[]
    expect(choices.map(one => one.worker_ref).sort()).toEqual([...WORKERS])
    expect(choices.every(one => one.preset_ref === "daily" && one.machine_ref === RUNNER)).toBe(true)
    expect(choices.map(one => one.worker_ref), "the master has a chat and is never offered").not.toContain("p1-lair")
    await nothingWritten(s, "no roster")

    const partial = await call(startArgs({ participants: [{ worker_ref: "p1-w1" }, { worker_ref: "p1-w2", preset_ref: "daily", machine_ref: RUNNER, brief: "b" }] }))
    expect(partial).toMatchObject({ status: "waiting_owner", stage: "needs_participants", incomplete: [{ index: 0, missing: ["preset_ref", "machine_ref", "brief"] }] })
    const empty = await call(startArgs({ participants: [] }))
    expect(empty).toMatchObject({ stage: "needs_participants" })
    await nothingWritten(s, "a partial roster")

    // What is named is exactly what is configured: nothing is chosen, changed or filled in.
    const named = (over: Record<string, unknown>[]) => startArgs({ participants: roster(["p1-w1", "p1-w2"]).map((one, at) => ({ ...one, ...(over[at] ?? {}) })) })
    expect(await code(call(named([{ worker_ref: "p1-nobody" }])))).toBe("unknown_participant")
    expect(await code(call(named([{ worker_ref: "p1-lair" }])))).toBe("unknown_participant")
    expect(await code(call(named([{ preset_ref: "cheap" }])))).toBe("unsupported_override")
    expect(await code(call(named([{ machine_ref: "another-machine" }])))).toBe("unsupported_override")
    expect(await code(call(named([{}, { worker_ref: "p1-w1" }])))).toBe("invalid_roster")
    expect(await code(call(startArgs({ participants: roster(["p1-w1"]) })))).toBe("invalid_roster")
    await nothingWritten(s, "a roster the registry cannot honour")
  } finally { await s.close() }
}, 60_000)

test("C3 an owner's explicit request starts at once: one council, one job per participant, one card, no confirmation, and one request however often it is asked", async () => {
  const s = await councilStage(cluster, track)
  try {
    const call = (args: Record<string, unknown>) => callTool(s.binding("attempt-1"), "hub_council", args)
    const reply = await call(startArgs())
    expect(reply).toMatchObject({ status: "running", stage: "workers_running", revision: 1 })
    const id = String(reply.object_id)
    const [council] = Array.from(await s.su`select * from council where id = ${id}`) as any[]
    expect(council).toMatchObject({ person: PERSON, agent: "p1-lair", origin_kind: "owner_request", lifecycle: "running", question: QUESTION,
      question_revision: 1, roster_revision: 1, epoch: 1, current_round: 1, debate_opt_in: null, parent_job: null })
    expect(council.return_route).toEqual({ agent: "p1-lair", door: DOOR, chat: CHAT })
    expect(council.origin).toMatchObject({ source_message_ids: ["h2"], sender: PERSON })
    // The checkpoint is persisted at start: thirty minutes from the start of the first period.
    expect(Math.round((new Date(council.checkpoint_deadline).getTime() - new Date(council.created_at).getTime()) / 60_000)).toBe(30)

    const participants = Array.from(await s.su`select id, worker_agent, preset_name, preset_id, preset_snapshot, machine, ordinal from council_participant where council_id = ${id} order by ordinal`) as any[]
    expect(participants.map(one => one.worker_agent)).toEqual(["p1-w1", "p1-w2"])
    expect(participants[0]).toMatchObject({ preset_name: "daily", machine: RUNNER })
    expect(participants[0].preset_snapshot).toMatchObject({ model: "a-model-name", provider: "a-provider", effort: "medium", paid: "plan" })

    const jobs = await s.jobsOf(id)
    expect(jobs).toHaveLength(2)
    for (const job of jobs) {
      const who = participants.find(one => one.worker_agent === job.agent)!
      expect(job).toMatchObject({ kind: "job", log_ready: true })
      expect(job.source.dispatch.approved).toEqual({ by: PERSON, at: expect.any(String), digest: taskDigest(job.body), source: "council" })
      expect(job.source.dispatch.return).toEqual({ agent: "p1-lair", door: DOOR, chat: CHAT })
      expect(job.source.dispatch.council_round).toEqual({ council: id, round: 1, participant: who.id, revision: 1 })
      expect(job.source.origin).toBe("council")
      // Each participant is told its own brief and the question, verbatim, and nobody else's brief.
      expect(job.body).toContain(`brief for ${job.agent}`)
      expect(job.body).toContain(QUESTION)
      for (const other of participants.filter(one => one.id !== who.id)) expect(job.body).not.toContain(`brief for ${other.worker_agent}`)
      // The runner's own gate admits it as it stands.
      expect(admitJob({ body: job.body, source: job.source })).toBeNull()
    }
    // The card is asked for through the ledger, once, addressed to the council's pinned chat.
    const effects = Array.from(await s.su`select key, door, chat, owner_ref, wanted_content, state from platform_effect`) as any[]
    expect(effects).toEqual([expect.objectContaining({ key: `council-status:${id}`, door: DOOR, chat: CHAT, owner_ref: id, state: "not_sent" })])
    expect(effects[0].wanted_content).toContain("Council")
    expect(effects[0].wanted_content).toContain("0 of 2 answered")
    expect(await s.count("confirmation"), "the owner asked for it: no green check").toBe(0)
    expect((await s.su`select kind, actor from ledger_event where stream = 'council' and subject = ${id}`)[0]).toMatchObject({ kind: "started", actor: "runner" })

    // One request, however often: the recorded answer, unchanged, and nothing new.
    expect(await call(startArgs())).toEqual(reply)
    expect(await code(call(startArgs({ question: "another question" })))).toBe("idempotency_conflict")
    expect(await code(call(startArgs({ request_key: "start-2" })))).toBe("source_already_used")
    expect([await s.count("council"), await s.count("platform_effect"), await s.count("inbound", "kind = 'job'"), await s.count("tool_invocation")]).toEqual([1, 1, 2, 1])
  } finally { await s.close() }
}, 60_000)

test("C4 debate is opt-in at the start only on the owner's evidence, and the owner's words are the only source of a council", async () => {
  const s = await councilStage(cluster, track)
  try {
    const reply = await callTool(s.binding("attempt-1"), "hub_council", startArgs({ debate: true }))
    const [council] = Array.from(await s.su`select debate_opt_in from council where id = ${String(reply.object_id)}`) as any[]
    expect(council.debate_opt_in).toMatchObject({ kind: "start", source_message_ids: ["h2"] })
    // Evidence is checked: a message that is not the owner's, that is another agent's, or that is not there.
    await s.human("stranger", { sender: "not-allowed" })
    await s.human("elsewhere", { agent: "p1-other" })
    await s.human("a-report", { kind: "report" })
    for (const [id, why] of [["missing", "no such message"], ["stranger", "an unlisted sender"], ["elsewhere", "another agent's"], ["a-report", "not a person's message"]] as const) {
      expect(await code(callTool(s.binding(), "hub_council", startArgs({ request_key: `k-${id}`, authority: { source_message_ids: [id] } }))), why).toBe("source_invalid")
    }
    expect(await s.count("council"), "refusals wrote nothing more").toBe(1)
  } finally { await s.close() }
}, 60_000)

// ---------------------------------------------------------------------------
// An agent's own idea, and a worker's.
// ---------------------------------------------------------------------------

test("C5 an agent's own idea is frozen whole, starts nothing, and starts exactly what was approved, once, when the owner reacts", async () => {
  const s = await councilStage(cluster, track)
  try {
    const reply = await callTool(s.binding("attempt-1"), "hub_council", { action: "start", request_key: "idea-1", authority: { proposal: true }, question: QUESTION, participants: roster(), debate: true })
    expect(reply).toMatchObject({ status: "awaiting_confirmation", stage: "awaiting_confirmation", revision: null })
    for (const table of ["council", "council_participant", "round_member", "council_event"]) expect(await s.count(table), `a proposal starts nothing: ${table}`).toBe(0)
    expect(await s.count("inbound", "kind = 'job'"), "and queues no job").toBe(0)
    const [pending] = Array.from(await s.su`select id, operation_id, operation_kind, owner_sender, state, payload, door, chat from confirmation`) as any[]
    expect(pending).toMatchObject({ operation_kind: "council.start", owner_sender: PERSON, state: "pending", door: DOOR, chat: CHAT })
    expect(reply.object_id, "the reply names a council").not.toBeNull()
    expect(councilIdOf(pending.operation_id), "the reply names the council that will exist").toBe(String(reply.object_id))
    expect(pending.payload.participants.map((one: any) => [one.worker_ref, one.preset_ref, one.machine])).toEqual([["p1-w1", "daily", RUNNER], ["p1-w2", "daily", RUNNER]])
    expect(pending.payload.debate).toBe(true)
    // What the owner reads is what is frozen: the preview parts are in the ledger, in this chat, the last one asking for the reaction.
    const parts = Array.from(await s.su`select wanted_content, frozen from platform_effect where key like 'confirmation:%' order by key`) as any[]
    expect(parts.length).toBeGreaterThanOrEqual(2)
    expect(parts.every(one => one.frozen)).toBe(true)
    expect(parts.map(one => one.wanted_content).join("\n")).toContain("p1-w1")
    // Same request: the same reply and no second preview.
    expect(await callTool(s.binding("attempt-1"), "hub_council", { action: "start", request_key: "idea-1", authority: { proposal: true }, question: QUESTION, participants: roster(), debate: true })).toEqual(reply)
    expect(await s.count("confirmation")).toBe(1)

    // The owner reacts: the door records the approval and, in the same transaction, the hook starts what was approved.
    await s.su`update confirmation set state = 'approved', approved_by = owner_sender, approved_at = now(), cause = null where id = ${pending.id}`
    const approved = (await readConfirmation(s.door, pending.id))!
    const hooks = councilApprovals({ registry: () => loadRegistry(s.registryFile) })
    await s.door.sql.begin(async (tx) => { await hooks["council.start"]({ sql: tx as never, url: s.door.url }, approved) })
    const [council] = Array.from(await s.su`select * from council where id = ${String(reply.object_id)}`) as any[]
    expect(council).toMatchObject({ origin_kind: "proposal", lifecycle: "running", question: QUESTION })
    expect(council.origin.confirmation).toMatchObject({ id: pending.id, approved_by: PERSON })
    expect(council.debate_opt_in).toMatchObject({ kind: "proposal", confirmation: pending.id })
    const jobs = await s.jobsOf(council.id)
    expect(jobs.map(job => job.agent).sort()).toEqual(["p1-w1", "p1-w2"])
    expect(jobs.every(job => job.source.dispatch.approved.by === PERSON), "every job is approved by the owner who reacted").toBe(true)
    expect((await s.su`select kind, actor from ledger_event where stream = 'council' and subject = ${council.id}`)[0]).toMatchObject({ kind: "started", actor: "door" })
    // An approval acted on twice starts nothing twice.
    await s.door.sql.begin(async (tx) => { await hooks["council.start"]({ sql: tx as never, url: s.door.url }, approved) })
    expect([await s.count("council"), await s.count("inbound", "kind = 'job'")]).toEqual([1, 2])
  } finally { await s.close() }
}, 60_000)

test("C6 a worker can only propose: it is pinned to the master and owner of the job it is doing, inherits nothing, and cannot put itself on the council", async () => {
  const s = await councilStage(cluster, track)
  try {
    const source = jobSource("job-w3", { target: "p1-w3", task: "do the thing" })
    await s.su`insert into inbound (id, person, agent, body, kind, source) values ('job-w3', ${PERSON}, 'p1-w3', 'do the thing', 'job', ${source}::jsonb)`
    const conversation = await conversationFor(s.runner, { row: { id: "job-w3", person: PERSON, agent: "p1-w3", kind: "job", source: source as never }, ...s.placement("p1-w3") })
    const worker = s.binding(null, { agent: "p1-w3", conversation: conversation.id, kind: "worker" })
    // A worker has no owner messages: the owner's words cannot be its authority.
    expect(await code(callTool(worker, "hub_council", startArgs()))).toBe("not_owner_conversation")
    // It cannot sit on the council it proposes.
    expect(await code(callTool(worker, "hub_council", { action: "start", request_key: "w-1", authority: { proposal: true }, question: QUESTION, participants: roster(["p1-w1", "p1-w3"]) }))).toBe("unknown_participant")
    // A proposal is pinned to its parent's master, its chat and the owner who approved that job.
    const reply = await callTool(worker, "hub_council", { action: "start", request_key: "w-2", authority: { proposal: true }, question: QUESTION, participants: roster(["p1-w1", "p1-w2"]) })
    expect(reply).toMatchObject({ status: "awaiting_confirmation" })
    const [pending] = Array.from(await s.su`select owner_sender, door, chat, payload from confirmation`) as any[]
    expect(pending).toMatchObject({ owner_sender: PERSON, door: DOOR, chat: CHAT })
    expect(pending.payload).toMatchObject({ proposer: { kind: "worker", agent: "p1-w3", conversation: conversation.id }, parent_job: "job-w3", master: { agent: "p1-lair" },
      route: { agent: "p1-lair", door: DOOR, chat: CHAT } })
    expect(await s.count("council"), "nothing starts on a worker's word").toBe(0)
    // Reading a council is the master's: a worker cannot inspect one.
    expect(await code(callTool(worker, "hub_council", { action: "inspect", council_id: "anything" }))).toBe("not_owner_conversation")
  } finally { await s.close() }
}, 60_000)
