// Operator-recorded health (migration 22): a stuck notice batch dismissed whole and kept, and an agent's historical retry or an
// input's missing stamps resolved on the exact evidence they stand on, with nothing of that evidence changed.
//
// A real Postgres, and every call goes through the role that makes it: the hub's own (`hub_hub`) for the operator, the door's
// for delivery, the runner's for health and claims. Every row is synthetic; nothing here names a household's row.

import { afterAll, afterEach, beforeAll, expect, spyOn, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { hubPath, startCluster, type Cluster } from "./helpers/cluster.ts"
import { rolloutDatabase } from "./helpers/rollout-fixtures.ts"
import { MIGRATION_FILES, migrate } from "../src/store/migrate.ts"
import { markDelivered, readPendingChunks } from "../src/store/outbox.ts"
import { putRow } from "../src/records/statesheet.ts"
import { dismissNotices, previewDismissal, previewRetry, previewStamp, resolveRetry, resolveStamp } from "../src/store/health.ts"
import { recordedHealth } from "../src/check/resolutions.ts"
import { healthCommand } from "../src/entry/health.ts"
import type { Finding } from "../src/check/finding.ts"

let cluster: Cluster
beforeAll(async () => { cluster = await startCluster() })
afterAll(async () => { await cluster?.stop() })

const mine: { close(): Promise<void> }[] = []
afterEach(async () => { for (const one of mine.splice(0)) await one.close().catch(() => {}) })

/** A statement as a real promise, so that `expect(...).rejects` reads what the store said. */
const attempt = async (query: PromiseLike<unknown>): Promise<void> => { await query }

const AGENT = "p1-lair"
const PERSON = "p1"
const DOOR = "door-fake"
const RUNNER = "runner-pi"
const ROUTE = { door: DOOR, chat: "0000000000" }
const OPERATOR = { by: "operator:synthetic", source: "imprnt hub health on pi" }
const REASON = "synthetic: the batch answers a question nobody is waiting on any more"
const RATE_LIMITED = { kind: "transient", code: "rate-limited", cause: "rate limited" }
const UNKNOWN_OUTCOME = { kind: "uncertain", code: "send-interrupted", cause: "delivery outcome unknown" }
const NO_DIGEST = "0".repeat(64)

async function stage() {
  const f = await rolloutDatabase(cluster)
  const hub = f.store("hub_hub")
  const door = f.store("hub_door")
  const runner = f.store("hub_runner")
  for (const one of [f.sql, hub.sql, door.sql, runner.sql]) mine.push(one)
  const su = f.sql
  /** One part of one notice, as a door left it. */
  const part = async (key: string, n: number, state: "pending" | "failed" | "delivered", attempts = 0,
    failure: Record<string, string> | null = null): Promise<number> =>
    Number((await su`insert into outbox (kind, inbound_id, seq_in_reply, body, person, agent, notice_key, route,
        delivery_state, attempts, failure, delivered_at)
      values ('notice', null, ${n}, ${`synthetic notice ${key} part ${n}`}, ${PERSON}, ${AGENT}, ${n === 1 ? key : `${key}:part:${n}`},
        ${ROUTE}::jsonb, ${state}, ${attempts}, ${failure}::jsonb, ${state === "delivered" ? new Date() : null})
      returning id`)[0].id)
  const rows = async (ids: number[]) => Array.from(await su`select id, kind, notice_key, seq_in_reply, body, written_at, delivered_at,
      delivery_state, attempts, retry_at, failure, route, person, agent
    from outbox where id in (select jsonb_array_elements_text(${JSON.stringify(ids)}::text::jsonb)::bigint) order by id`)
    .map((row: any) => ({ ...row }))
  const health = async () => Array.from(await su`select subject, kind, actor, detail from ledger_event where stream = 'health' order by seq`)
    .map((row: any) => ({ ...row }))
  /** Until a backend of this role stands waiting on a lock, which is the race this file stages. */
  const waitingOnLock = async (role: string): Promise<void> => {
    const deadline = Date.now() + 15_000
    for (;;) {
      const [row] = await su`select count(*)::int as n from pg_stat_activity where usename = ${role} and wait_event_type = 'Lock'`
      if (Number(row.n) > 0) return
      if (Date.now() > deadline) throw new Error(`no ${role} backend waited on a lock within 15 s`)
      await Bun.sleep(25)
    }
  }
  return { ...f, su, hub, door, runner, part, rows, health, waitingOnLock }
}

const finding = (kind: string, subject: string): Finding =>
  ({ id: `pi/${kind}:${subject}`, kind, subject, machine: "pi", says: `${kind} ${subject}`, fix: "" })
const consult = (store: Awaited<ReturnType<typeof stage>>["hub"], findings: Finding[]) =>
  recordedHealth({ store, findings, machine: "pi", doors: new Set([DOOR]), doorOf: () => DOOR })

// ---------------------------------------------------------------------------
// H1-H3. A notice batch, dismissed whole and kept.
// ---------------------------------------------------------------------------

test("H1 a dismissed batch keeps every row, byte, attempt and failure, is neither delivered nor pending, releases nothing, and nothing can send, retry, reset or mark it", async () => {
  const s = await stage()
  const ids = [
    await s.part("triage:synthetic-a", 1, "failed", 5, RATE_LIMITED),
    await s.part("triage:synthetic-a", 2, "pending"),
    await s.part("triage:synthetic-a", 3, "pending"),
  ]
  const [failed, second] = ids
  const before = await s.rows(ids)
  const offered = async () => (await readPendingChunks(s.door, { agent: AGENT })).map(chunk => Number(chunk.id)).filter(id => ids.includes(id))
  expect(await offered(), "the later parts are held back by the failed one").toEqual([])

  const preview = await previewDismissal(s.hub, ids)
  expect(preview).toMatchObject({ verdict: "eligible", ids, outside: [] })
  expect(String(preview.digest)).toMatch(/^[0-9a-f]{64}$/)
  expect(await dismissNotices(s.hub, ids, String(preview.digest), REASON, OPERATOR)).toMatchObject({ result: "dismissed" })

  const after = await s.rows(ids)
  const unmoved = (row: Record<string, unknown>) => { const { delivery_state: _, ...rest } = row; return rest }
  expect(after.map(unmoved), "every byte, attempt, failure and route is the one the door left").toEqual(before.map(unmoved))
  expect(after.map(row => [row.delivery_state, row.delivered_at])).toEqual(ids.map(() => ["dismissed", null]))
  const records = Array.from(await s.su`select dismissed_at, dismissal from outbox
    where id in (select jsonb_array_elements_text(${JSON.stringify(ids)}::text::jsonb)::bigint) order by id`)
  for (const row of records as any[]) {
    expect(row.dismissed_at).not.toBeNull()
    expect(row.dismissal).toMatchObject({ reason: REASON, by: OPERATOR.by, source: OPERATOR.source, session: "hub_hub", digest: preview.digest })
  }
  expect(records.map((row: any) => row.dismissal.was)).toEqual(["failed", "pending", "pending"])
  const diary = await s.health()
  expect(diary).toHaveLength(1)
  expect(diary[0]).toMatchObject({ subject: AGENT, kind: "notice.dismissed", actor: "hub",
    detail: { outbox: ids, digest: preview.digest, reason: REASON, by: OPERATOR.by, session: "hub_hub" } })

  expect(await offered(), "a dismissal releases no part").toEqual([])
  // A door that read a part before the dismissal: its send claim finds nothing pending, and the rest is refused by the row.
  expect(Array.from(await s.door.sql`update outbox set attempts = attempts + 1
    where id = ${second} and delivery_state = 'pending' and delivered_at is null returning id`)).toEqual([])
  await expect(markDelivered(s.door, second)).rejects.toThrow(/dismissed by an operator/)
  await expect(attempt(s.door.sql`update outbox set delivery_state = 'pending', attempts = 0, failure = null where id = ${failed}`))
    .rejects.toThrow(/dismissed by an operator/)
  // An operator's door recovery releases failed parts only, and these are not failed.
  await s.door.sql`update outbox set delivery_state = 'pending', attempts = 0, retry_at = null, failure = null
    where delivery_state = 'failed' and route ->> 'door' = ${DOOR}`
  expect(await s.rows(ids)).toEqual(after)

  // Asked again, it is already made, and nothing more is written.
  expect(await dismissNotices(s.hub, ids, String(preview.digest), REASON, OPERATOR)).toMatchObject({ result: "unchanged" })
  expect(await s.health()).toHaveLength(1)
  // `check` reports no delivery failure for them, and says they are kept rather than letting them vanish.
  expect(Number((await s.su`select count(*)::int as n from outbox where delivery_state = 'failed'`)[0].n)).toBe(0)
  const said = await consult(s.hub, [])
  expect(said.standing).toEqual([])
  expect(said.acknowledged).toMatchObject([{ kind: "notice-dismissed", subject: DOOR }])
  expect(said.acknowledged[0].says).toContain("3 notice parts kept undelivered")
}, 120_000)

test("H2 only whole stuck batches are dismissed: a part left out, a reply, a delivered part, a part in flight, a part nothing holds back, a moved row and a missing reason are each refused by name and change nothing", async () => {
  const s = await stage()
  const a1 = await s.part("triage:synthetic-b", 1, "failed", 5, RATE_LIMITED)
  const a2 = await s.part("triage:synthetic-b", 2, "pending")
  const a3 = await s.part("triage:synthetic-b", 3, "pending")
  const c1 = await s.part("triage:synthetic-c", 1, "failed", 5, RATE_LIMITED)
  const c2 = await s.part("triage:synthetic-c", 2, "pending", 1, UNKNOWN_OUTCOME)
  const d1 = await s.part("triage:synthetic-d", 1, "pending")
  const e1 = await s.part("triage:synthetic-e", 1, "delivered")
  const e2 = await s.part("triage:synthetic-e", 2, "failed", 5, RATE_LIMITED)
  const reply = Number((await s.su`select id from outbox where inbound_id = 'old-input' and seq_in_reply = 2`)[0].id)
  const every = [a1, a2, a3, c1, c2, d1, e1, e2, reply]
  const before = await s.rows(every)
  const refused = async (ids: number[], cause: string, extra: Record<string, unknown> = {}) => {
    const preview = await previewDismissal(s.hub, ids)
    expect(preview.verdict, `preview of ${ids}`).toBe(cause)
    expect(await dismissNotices(s.hub, ids, String(preview.digest ?? NO_DIGEST), REASON, OPERATOR), `dismissal of ${ids}`)
      .toMatchObject({ result: "refused", cause, ...extra })
  }
  // The batch is every undelivered part of one notice, and no part of it is dismissed alone.
  await refused([a1], "partial-batch", { outside: [a2, a3] })
  await refused([a1, a2], "partial-batch", { outside: [a3] })
  await refused([a2, a3], "partial-batch", { outside: [a1] })
  // Two batches are dismissed together or not at all.
  await refused([a1, a2, a3, c1], "partial-batch", { outside: [c2] })
  await refused([reply], "reply-not-dismissible")
  // A part with an attempt or an unknown outcome may be being sent, or may have been.
  await refused([c1, c2], "in-flight")
  // A pending part nothing holds back is the door's to deliver at any moment.
  await refused([d1], "pending-not-blocked")
  await refused([e1, e2], "delivered")
  await refused([a1, a1], "invalid-ids")
  await refused([999_999_999], "unknown-row")
  expect(await s.rows(every)).toEqual(before)
  expect(await s.health()).toEqual([])

  const preview = await previewDismissal(s.hub, [a1, a2, a3])
  expect(preview.verdict).toBe("eligible")
  for (const reason of ["", "   "]) {
    expect(await dismissNotices(s.hub, [a1, a2, a3], String(preview.digest), reason, OPERATOR)).toMatchObject({ result: "refused", cause: "reason-required" })
  }
  expect(await dismissNotices(s.hub, [a1, a2, a3], String(preview.digest), REASON, { by: "", source: OPERATOR.source }))
    .toMatchObject({ result: "refused", cause: "operator-required" })
  expect(await dismissNotices(s.hub, [a1, a2, a3], NO_DIGEST, REASON, OPERATOR)).toMatchObject({ result: "refused", cause: "stale-digest" })
  // The door's record of the failure moved after the preview, so the preview no longer describes the rows.
  await s.su`update outbox set failure = ${{ ...RATE_LIMITED, cause: "rate limited again" }}::jsonb where id = ${a1}`
  expect(await dismissNotices(s.hub, [a1, a2, a3], String(preview.digest), REASON, OPERATOR)).toMatchObject({ result: "refused", cause: "stale-digest" })
  expect((await s.rows([a1, a2, a3])).map(row => row.delivery_state)).toEqual(["failed", "pending", "pending"])
  expect(await s.health()).toEqual([])

  // The undelivered rest of a batch whose first part was delivered is a whole batch, and the delivered part is left as it is.
  const rest = await previewDismissal(s.hub, [e2])
  expect(rest).toMatchObject({ verdict: "eligible", outside: [] })
  expect(await dismissNotices(s.hub, [e2], String(rest.digest), REASON, OPERATOR)).toMatchObject({ result: "dismissed" })
  expect((await s.rows([e1, e2])).map(row => row.delivery_state)).toEqual(["delivered", "dismissed"])
}, 120_000)

test("H3 a dismissal and a door's write to the same part are ordered by the row: a send claim first refuses the dismissal as in flight, a dismissal first leaves the claim nothing to send, and a recovery first leaves nothing stuck to dismiss", async () => {
  const s = await stage()
  // The door's pre-send stamp (`door/run.ts`), which is its claim on the row: a send follows it only when it returns the row.
  const claim = (sql: any, id: number) => sql`update outbox set attempts = attempts + 1, retry_at = now() + interval '30 seconds',
      failure = ${UNKNOWN_OUTCOME}::jsonb
    where id = ${id} and delivery_state = 'pending' and delivered_at is null returning id`

  // The send was claimed first: the dismissal waits for it, then finds an attempt and refuses.
  {
    const ids = [await s.part("triage:race-a", 1, "failed", 5, RATE_LIMITED), await s.part("triage:race-a", 2, "pending")]
    const preview = await previewDismissal(s.hub, ids)
    expect(preview.verdict).toBe("eligible")
    const held = await s.door.sql.reserve()
    try {
      await held.unsafe("begin")
      expect(Array.from(await claim(held, ids[1]))).toHaveLength(1)
      const racing = dismissNotices(s.hub, ids, String(preview.digest), REASON, OPERATOR)
      await s.waitingOnLock("hub_hub")
      await held.unsafe("commit")
      expect(await racing).toMatchObject({ result: "refused", cause: "in-flight" })
    } finally { held.release() }
    expect((await s.rows(ids)).map(row => [row.delivery_state, row.attempts])).toEqual([["failed", 5], ["pending", 1]])
  }

  // The dismissal was first: the claim waits for it, then finds nothing pending, so nothing is sent or marked.
  {
    const ids = [await s.part("triage:race-b", 1, "failed", 5, RATE_LIMITED), await s.part("triage:race-b", 2, "pending")]
    const preview = await previewDismissal(s.hub, ids)
    const held = await s.hub.sql.reserve()
    try {
      await held.unsafe("begin")
      const [made] = await held`select hub_outbox_dismiss(${JSON.stringify(ids)}::text::jsonb, ${String(preview.digest)}, ${REASON},
        ${OPERATOR.by}, ${OPERATOR.source}) as answer`
      expect(made.answer).toMatchObject({ result: "dismissed" })
      const racing = (async () => Array.from(await claim(s.door.sql, ids[1])))()
      await s.waitingOnLock("hub_door")
      await held.unsafe("commit")
      expect(await racing, "the stale claim finds nothing pending").toEqual([])
    } finally { held.release() }
    await expect(markDelivered(s.door, ids[1])).rejects.toThrow(/dismissed by an operator/)
    expect((await s.rows(ids)).map(row => [row.delivery_state, row.attempts, row.delivered_at])).toEqual([["dismissed", 5, null], ["dismissed", 0, null]])
  }

  // An operator's door recovery released the failed part first: the batch is the door's to deliver again, and not stuck.
  {
    const ids = [await s.part("triage:race-c", 1, "failed", 5, RATE_LIMITED), await s.part("triage:race-c", 2, "pending")]
    const preview = await previewDismissal(s.hub, ids)
    expect(preview.verdict).toBe("eligible")
    const held = await s.door.sql.reserve()
    try {
      await held.unsafe("begin")
      await held`update outbox set delivery_state = 'pending', attempts = 0, retry_at = null, failure = null
        where delivery_state = 'failed' and route ->> 'door' = ${DOOR}`
      const racing = dismissNotices(s.hub, ids, String(preview.digest), REASON, OPERATOR)
      await s.waitingOnLock("hub_hub")
      await held.unsafe("commit")
      expect(await racing).toMatchObject({ result: "refused", cause: "pending-not-blocked" })
    } finally { held.release() }
    expect((await s.rows(ids)).map(row => row.delivery_state)).toEqual(["pending", "pending"])
  }
  expect(await s.health(), "only the dismissal that was first is recorded").toHaveLength(1)
}, 120_000)

// ---------------------------------------------------------------------------
// H4. An agent's retry recorded by an earlier runner process.
// ---------------------------------------------------------------------------

test("H4 an agent's retry recorded by an earlier runner process is resolved on its exact health row, which stays as it was; queued, held, unresolved or busy work and a restart in between are refused, and a new failure resurfaces", async () => {
  const s = await stage()
  const failedAt = new Date(Date.now() - 3_600_000)
  await s.su`insert into state_row (sheet, id, data, updated_at) values ('agent_health', ${AGENT},
    ${{ status: "retry", cause: "Error: Connection closed", retry_at: new Date(failedAt.getTime() + 30_000).toISOString() }}::jsonb, ${failedAt})`
  await s.su`insert into runner_incarnation (runner, incarnation, protocol, machine, started_at) values (${RUNNER}, 'incarnation-2', 3, 'pi', now())`
  await s.su`insert into conversation (id, person, agent, kind, adapter, native_session) values ('conv-lair', ${PERSON}, ${AGENT}, 'master', 'synthetic', 'native-1')`
  const health = async () => ({ ...(await s.su`select data, updated_at from state_row where sheet = 'agent_health' and id = ${AGENT}`)[0] })
  const original = await health()
  const verdict = async () => (await previewRetry(s.hub, AGENT, RUNNER)).verdict

  // The fixture's unanswered input is work the runner will retry: the retry is that, and is live.
  expect(await verdict()).toBe("work-queued")
  await s.su`insert into ledger_event (stream, subject, kind, actor) values ('inbound', 'old-input', 'answered', 'runner'), ('inbound', 'old-input', 'delivered', 'door')`
  const plan = await previewRetry(s.hub, AGENT, RUNNER)
  // An idle resident has no attempt, and is not a failed one.
  expect(plan).toMatchObject({ verdict: "eligible", incarnation: "incarnation-2", attempt: null, health: { status: "retry", cause: "Error: Connection closed" } })
  const fingerprint = String(plan.fingerprint)
  const resolve = (over: Partial<Parameters<typeof resolveRetry>[1]> = {}) =>
    resolveRetry(s.hub, { agent: AGENT, runner: RUNNER, fingerprint, incarnation: "incarnation-2", reason: REASON, who: OPERATOR, ...over })

  // A resident that is running a turn may yet clear or rewrite the retry itself.
  await s.su`insert into execution (id, inbound_id, conversation_id, agent, runner, incarnation, placement_generation, state, input_digest, purpose)
    values ('attempt-busy', null, 'conv-lair', ${AGENT}, ${RUNNER}, 'incarnation-2', 1, 'running', 'tail', 'tail')`
  expect(await verdict()).toBe("execution-unresolved")
  await s.su`update execution set state = 'unknown' where id = 'attempt-busy'`
  expect(await resolve()).toMatchObject({ result: "refused", cause: "execution-unresolved" })
  await s.su`delete from execution where id = 'attempt-busy'`

  // The attempt the failure was recorded after: its input held for its owner, then released; its exit must be confirmed.
  await s.su`insert into inbound (id, person, agent, body) values ('held-input', ${PERSON}, ${AGENT}, 'synthetic held input')`
  await s.su`insert into execution (id, inbound_id, conversation_id, agent, runner, incarnation, placement_generation, state, input_digest, evidence, started_at)
    values ('attempt-old', 'held-input', 'conv-lair', ${AGENT}, ${RUNNER}, 'incarnation-1', 1, 'interrupted', 'digest',
      '{"exit":{"confirmed":true}}'::jsonb, ${new Date(failedAt.getTime() - 60_000)})`
  await s.su`insert into replay_hold (inbound_id, execution_id, conversation_id, cause) values ('held-input', 'attempt-old', 'conv-lair', 'interrupted')`
  expect(await verdict()).toBe("hold-open")
  await s.su`update replay_hold set state = 'released', choice = 'fresh_context', revision = 2 where inbound_id = 'held-input'`
  await s.su`update execution set evidence = '{}'::jsonb where id = 'attempt-old'`
  expect(await verdict()).toBe("exit-unconfirmed")
  await s.su`update execution set evidence = '{"exit":{"confirmed":true}}'::jsonb where id = 'attempt-old'`
  expect(await previewRetry(s.hub, AGENT, RUNNER)).toMatchObject({ verdict: "eligible", fingerprint,
    attempt: { id: "attempt-old", state: "interrupted", incarnation: "incarnation-1", exit_confirmed: true } })
  // Work a runner holds a claim on is in flight, whoever claimed it.
  await s.su`insert into inbound (id, person, agent, body, claimed_by) values ('claimed-input', ${PERSON}, ${AGENT}, 'synthetic claimed input', ${RUNNER})`
  expect(await verdict()).toBe("work-claimed")
  await s.su`delete from inbound where id = 'claimed-input'`

  expect(await resolve({ reason: " " })).toMatchObject({ result: "refused", cause: "reason-required" })
  expect(await resolve({ fingerprint: NO_DIGEST })).toMatchObject({ result: "refused", cause: "stale-fingerprint" })
  // The operator named the incarnation they read: a restart since is a different process, and the record is refused.
  expect(await resolve({ incarnation: "incarnation-1" })).toMatchObject({ result: "refused", cause: "incarnation-changed" })
  expect(await s.health()).toEqual([])

  expect(await resolve()).toMatchObject({ result: "resolved", fingerprint })
  expect(await health(), "the health row is the runner's, as it wrote it").toEqual(original)
  expect(await resolve()).toMatchObject({ result: "unchanged" })
  const diary = await s.health()
  expect(diary).toHaveLength(1)
  expect(diary[0]).toMatchObject({ subject: AGENT, kind: "retry.resolved", actor: "hub", detail: { fingerprint, reason: REASON, by: OPERATOR.by,
    source: OPERATOR.source, session: "hub_hub", runner: RUNNER, incarnation: "incarnation-2", health: { cause: "Error: Connection closed" } } })

  // `check` sets the finding aside on this evidence only, and says so.
  const said = await consult(s.hub, [finding("agent-retry", AGENT), finding("agent-retry", "p1-other"), finding("unit-missing", "door-fake")])
  expect(said.standing.map(one => one.id)).toEqual(["pi/agent-retry:p1-other", "pi/unit-missing:door-fake"])
  expect(said.acknowledged).toMatchObject([{ kind: "agent-retry", subject: AGENT }])
  expect(said.acknowledged[0].says).toContain(REASON)

  // A new failure is the runner rewriting its row: new evidence, a finding again, and recorded by the process now running.
  await putRow(s.runner, "agent_health", AGENT, { status: "retry", cause: "Error: child-exited", retry_at: new Date(Date.now() + 30_000).toISOString() })
  expect((await consult(s.hub, [finding("agent-retry", AGENT)])).standing).toHaveLength(1)
  expect(await verdict()).toBe("recorded-by-current-incarnation")
  // The runner's own success clears its row: there is nothing to resolve, and nothing is recorded.
  await s.runner.sql`delete from state_row where sheet = 'agent_health' and id = ${AGENT}`
  expect(await resolve()).toMatchObject({ result: "cleared" })
  expect(await s.health()).toHaveLength(1)
}, 120_000)

// ---------------------------------------------------------------------------
// H5. An input's missing stamps after a confirmed-dead attempt and a released hold.
// ---------------------------------------------------------------------------

test("H5 an input's missing acknowledgement after a confirmed-dead attempt and the owner's fresh context is resolved with its stamps, attempt and hold kept, nothing fabricated, and the input never claimable again; a new stamp resurfaces it", async () => {
  const s = await stage()
  const INPUT = "discord:100000000000000001:200000000000000002"
  await s.su`insert into inbound (id, person, agent, body) values (${INPUT}, ${PERSON}, ${AGENT}, 'synthetic original input')`
  await s.su`insert into ledger_event (stream, subject, kind, actor) values ('inbound', ${INPUT}, 'received', 'door')`
  await s.su`insert into conversation (id, person, agent, kind, adapter, native_session) values ('conv-lair', ${PERSON}, ${AGENT}, 'master', 'synthetic', 'native-1')`
  await s.su`insert into execution (id, inbound_id, conversation_id, agent, runner, incarnation, placement_generation, state, input_digest, evidence, started_at, ended_at)
    values ('attempt-dead', ${INPUT}, 'conv-lair', ${AGENT}, ${RUNNER}, 'incarnation-1', 1, 'interrupted', 'digest',
      '{"exit":{"confirmed":true}}'::jsonb, now() - interval '2 days', now() - interval '2 days')`
  await s.su`insert into replay_hold (inbound_id, execution_id, conversation_id, cause) values (${INPUT}, 'attempt-dead', 'conv-lair', 'interrupted')`
  expect((await previewStamp(s.hub, INPUT)).verdict, "the owner has not chosen yet").toBe("hold-open")
  // The owner's own choice, through the door's function: fresh context, revision 1 to 2, nothing continued.
  expect((await s.door.sql`select hub_hold_choice('attempt-dead', ${AGENT}, 1, 'fresh_context', ${PERSON}, '{}'::jsonb, null) as answer`)[0].answer).toBe("fresh_context")

  const snapshot = async () => ({
    input: { ...(await s.su`select id, person, agent, body, kind, state, received_at, claimed_by, retry_at from inbound where id = ${INPUT}`)[0] },
    attempts: Array.from(await s.su`select id, state, evidence, ended_at from execution where inbound_id = ${INPUT}`).map((row: any) => ({ ...row })),
    hold: { ...(await s.su`select * from replay_hold where inbound_id = ${INPUT}`)[0] },
    stamps: Array.from(await s.su`select seq, kind, actor from ledger_event where stream = 'inbound' and subject = ${INPUT} order by seq`).map((row: any) => ({ ...row })),
    executions: Number((await s.su`select count(*)::int as n from execution`)[0].n),
    inputs: Number((await s.su`select count(*)::int as n from inbound`)[0].n),
  })
  const before = await snapshot()
  const plan = await previewStamp(s.hub, INPUT)
  expect(plan).toMatchObject({ verdict: "eligible", state: "received", missing: "acked",
    attempt: { id: "attempt-dead", state: "interrupted", exit_confirmed: true },
    hold: { attempt: "attempt-dead", state: "released", revision: 2, choice: "fresh_context" } })
  const fingerprint = String(plan.fingerprint)
  const resolve = (over: Partial<Parameters<typeof resolveStamp>[1]> = {}) =>
    resolveStamp(s.hub, { input: INPUT, attempt: "attempt-dead", revision: 2, fingerprint, reason: REASON, who: OPERATOR, ...over })

  expect(await resolve({ reason: "" })).toMatchObject({ result: "refused", cause: "reason-required" })
  expect(await resolve({ attempt: "attempt-other" })).toMatchObject({ result: "refused", cause: "attempt-mismatch" })
  expect(await resolve({ revision: 1 })).toMatchObject({ result: "refused", cause: "stale-revision" })
  expect(await resolve({ fingerprint: NO_DIGEST })).toMatchObject({ result: "refused", cause: "stale-fingerprint" })
  // An attempt of the agent whose ownership nobody resolved: nothing about the agent's work is history while it stands.
  await s.su`insert into execution (id, inbound_id, conversation_id, agent, runner, incarnation, placement_generation, state, input_digest, purpose)
    values ('attempt-unknown', null, 'conv-lair', ${AGENT}, ${RUNNER}, 'incarnation-2', 2, 'unknown', 'tail', 'tail')`
  expect(await resolve()).toMatchObject({ result: "refused", cause: "ownership-unresolved" })
  await s.su`delete from execution where id = 'attempt-unknown'`
  // The exit is part of the evidence.
  await s.su`update execution set evidence = '{}'::jsonb where id = 'attempt-dead'`
  expect((await previewStamp(s.hub, INPUT)).verdict).toBe("exit-unconfirmed")
  await s.su`update execution set evidence = '{"exit":{"confirmed":true}}'::jsonb where id = 'attempt-dead'`
  // An input whose only trace is an old runner's claim has no attempt to show any of it.
  expect((await previewStamp(s.hub, "old-input")).verdict).toBe("no-attempt")
  expect(await s.health()).toEqual([])

  expect(await resolve()).toMatchObject({ result: "resolved" })
  expect(await snapshot(), "no stamp, attempt, input or hold was written or changed").toEqual(before)
  expect(await resolve()).toMatchObject({ result: "unchanged" })
  const diary = await s.health()
  expect(diary).toHaveLength(1)
  expect(diary[0]).toMatchObject({ subject: INPUT, kind: "stamp.resolved", actor: "hub", detail: { fingerprint, reason: REASON, by: OPERATOR.by,
    session: "hub_hub", missing: "acked", attempt: { id: "attempt-dead" }, hold: { revision: 2, choice: "fresh_context" } } })
  // Never replayed: the replay predicate still holds it, and a claim is refused by the table.
  expect((await s.su`select hub_row_held(${INPUT}) as held`)[0].held).toBe(true)
  await expect(attempt(s.runner.sql`update inbound set claimed_by = ${RUNNER}, claim_deadline = now() + interval '1 minute' where id = ${INPUT}`))
    .rejects.toThrow(/held/)

  // `check` sets aside both findings that say this input still waits, on this evidence only.
  const said = await consult(s.hub, [finding("stamp-missing", INPUT), finding("wait-unexplained", INPUT), finding("stamp-missing", "synthetic-other")])
  expect(said.standing.map(one => one.id)).toEqual(["pi/stamp-missing:synthetic-other"])
  expect(said.acknowledged.map(one => one.kind)).toEqual(["stamp-missing", "wait-unexplained"])
  // A new stamp is new evidence: the finding is back as itself.
  await s.su`insert into ledger_event (stream, subject, kind, actor) values ('inbound', ${INPUT}, 'received', 'door')`
  const again = await consult(s.hub, [finding("stamp-missing", INPUT)])
  expect([again.standing.length, again.acknowledged.length]).toEqual([1, 0])
}, 120_000)

// ---------------------------------------------------------------------------
// H6-H8. Who may, the command's own refusals, and the step.
// ---------------------------------------------------------------------------

test("H6 only the hub's role previews or records, no role writes the dismissed state around the function, and the hub's role cannot touch the outbox itself", async () => {
  const s = await stage()
  const callable = ["hub_outbox_dismissal_plan(jsonb)", "hub_outbox_dismiss(jsonb, text, text, text, text)",
    "hub_health_retry_fingerprint(text)", "hub_health_stamp_fingerprint(text)", "hub_health_retry_plan(text, text)",
    "hub_health_resolve_retry(text, text, text, text, text, text, text)", "hub_health_stamp_plan(text)",
    "hub_health_resolve_stamp(text, text, integer, text, text, text, text)"]
  const internal = ["hub_health_instant(timestamptz)", "hub_health_operator_refusal(text, text, text)", "hub_outbox_ids(jsonb)"]
  for (const fn of [...callable, ...internal]) {
    const [row] = await s.su`select has_function_privilege('hub_hub', ${fn}, 'execute') as hub, has_function_privilege('hub_door', ${fn}, 'execute') as door,
      has_function_privilege('hub_runner', ${fn}, 'execute') as runner, has_function_privilege('hub_agent', ${fn}, 'execute') as agent`
    expect({ ...row }, fn).toEqual({ hub: callable.includes(fn), door: false, runner: false, agent: false })
  }
  const id = await s.part("triage:roles", 1, "failed", 5, RATE_LIMITED)
  for (const role of [s.door, s.runner]) {
    await expect(attempt(role.sql`select hub_outbox_dismiss(${JSON.stringify([id])}::text::jsonb, ${NO_DIGEST}, ${REASON}, 'x', 'y')`))
      .rejects.toThrow(/permission denied/)
  }
  const model = s.store("hub_agent")
  mine.push(model.sql)
  await expect(attempt(model.sql`select hub_health_stamp_plan('old-input')`)).rejects.toThrow(/permission denied/)
  // The door writes delivery states, and still cannot reach this one: who, why and when are not its columns.
  await expect(attempt(s.door.sql`update outbox set delivery_state = 'dismissed' where id = ${id}`)).rejects.toThrow(/outbox_dismissal_is_whole/)
  await expect(attempt(s.door.sql`update outbox set dismissed_at = now() where id = ${id}`)).rejects.toThrow(/permission denied/)
  await expect(attempt(s.hub.sql`update outbox set delivery_state = 'pending' where id = ${id}`)).rejects.toThrow(/permission denied/)
  expect((await s.rows([id]))[0]).toMatchObject({ delivery_state: "failed", attempts: 5 })
  expect(await s.health()).toEqual([])
}, 120_000)

test("H7 the command refuses a record with no reason, or without the exact evidence its target needs, before it reads a registry or opens a store", async () => {
  const registry = "/nonexistent-hub-health/registry.toml"
  const hex = "a".repeat(64)
  const quiet = spyOn(process.stderr, "write").mockImplementation((() => true) as any)
  try {
    expect(await healthCommand([registry, "resolve", "outbox:1,2", "--digest", hex])).toBe(2)
    expect(await healthCommand([registry, "resolve", "outbox:1,2", "--reason", "why"])).toBe(2)
    expect(await healthCommand([registry, "resolve", "outbox:1,2", "--reason", "why", "--digest", "not-a-digest"])).toBe(2)
    expect(await healthCommand([registry, "resolve", "agent:p1-lair", "--reason", "why", "--fingerprint", hex])).toBe(2)
    expect(await healthCommand([registry, "resolve", "input:discord:1:2", "--reason", "why", "--attempt", "a", "--fingerprint", hex])).toBe(2)
    expect(await healthCommand([registry, "resolve", "reply:1", "--reason", "why"])).toBe(2)
    expect(await healthCommand([registry, "resolve", "outbox:1", "--reason", "why", "--digest", hex, "--force", "yes"])).toBe(2)
    expect(await healthCommand([registry, "inspect", "outbox:1", "--reason", "why"])).toBe(2)
    // A whole command gets as far as the registry, which here is not there.
    expect(await healthCommand([registry, "resolve", "input:discord:1:2", "--reason", "why", "--attempt", "a", "--revision", "2", "--fingerprint", hex])).toBe(1)
  } finally { quiet.mockRestore() }
})

test("H8 migration 22 is registered, carried by the fresh schema byte for byte, keeps a failed part failed, and an upgraded store has what a fresh one has", async () => {
  expect(MIGRATION_FILES).toContainEqual([22, "022-recorded-health.sql"])
  const migration = readFileSync(hubPath("src/store/migrations/022-recorded-health.sql"), "utf8")
  expect(readFileSync(hubPath("src/schema.sql"), "utf8").includes(`${migration}\ninsert into schema_version (version) values (22);\n`)).toBe(true)

  const stepped = await rolloutDatabase(cluster, true)
  mine.push(stepped.sql)
  const opened = () => { const store = stepped.store(); mine.push(store.sql); return store }
  const files = (upTo: number) => MIGRATION_FILES.filter(([version]) => version <= upTo)
    .map(([version, file]) => ({ version, sql: readFileSync(join(hubPath("src/store/migrations"), file), "utf8") }))
  await migrate(opened(), files(21))
  await stepped.sql`insert into outbox (kind, seq_in_reply, body, person, agent, notice_key, delivery_state, attempts)
    values ('notice', 1, 'synthetic', ${PERSON}, ${AGENT}, 'triage:before-22', 'failed', 5)`
  await migrate(opened())
  await migrate(opened())
  const fresh = await rolloutDatabase(cluster)
  mine.push(fresh.sql)

  const shape = async (q: any) => {
    const all = async (query: string) => Array.from(await q.unsafe(query)).map((row: any) => ({ ...row }))
    return {
      versions: (await all("select version from schema_version order by version")).map(row => Number(row.version)),
      constraints: await all(`select conname, pg_get_constraintdef(oid) as def from pg_constraint
        where conrelid = 'outbox'::regclass and conname in ('outbox_delivery_state_check', 'outbox_dismissal_is_whole') order by conname`),
      columns: await all(`select column_name, data_type, is_nullable, column_default from information_schema.columns
        where table_name = 'outbox' and column_name in ('delivery_state', 'dismissed_at', 'dismissal') order by column_name`),
      triggers: await all(`select tgname, pg_get_triggerdef(oid) as def from pg_trigger where tgrelid = 'outbox'::regclass and tgname = 'outbox_dismissal_is_final'`),
      functions: await all(`select p.proname, pg_get_function_identity_arguments(p.oid) as args, p.prosecdef, p.prosrc, p.proconfig,
          has_function_privilege('hub_hub', p.oid, 'execute') as hub, has_function_privilege('hub_door', p.oid, 'execute') as door,
          has_function_privilege('hub_runner', p.oid, 'execute') as runner, has_function_privilege('hub_agent', p.oid, 'execute') as agent
        from pg_proc p where p.pronamespace = 'public'::regnamespace
          and (p.proname like 'hub\\_health\\_%' or p.proname like 'hub\\_outbox\\_%' or p.proname = 'hub_guard_outbox_dismissal')
        order by p.proname, args`),
    }
  }
  const upgraded = await shape(stepped.sql)
  const born = await shape(fresh.sql)
  expect(upgraded.versions).toEqual(MIGRATION_FILES.map(([version]) => version))
  expect(born.functions).toHaveLength(12)
  for (const part of Object.keys(born) as (keyof typeof born)[]) expect(upgraded[part], part).toEqual(born[part])
  expect({ ...(await stepped.sql`select delivery_state, dismissed_at, dismissal from outbox where notice_key = 'triage:before-22'`)[0] })
    .toEqual({ delivery_state: "failed", dismissed_at: null, dismissal: null })
}, 180_000)
