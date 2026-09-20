// The queue learns what a job is, and the report goes back through one function.
//
// SPEC §6's Forbidden carries "a message or job stored outside the one
// database", so a job is a row on the queue that already exists rather than a
// table of its own with a second claim path. SPEC §2 keeps one owner per table,
// which is why the runner still holds no insert on `inbound` and reports
// through a function the door owns instead.
//
// Every fence below is raised by Postgres on a role connection, never by a
// guard in TypeScript, because a second process opens its own connection.

import { afterAll, beforeAll, expect, test } from "bun:test"
import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { startCluster, seam, hubPath, until, type Cluster } from "./helpers/cluster.ts"
import { rolloutDatabase } from "./helpers/rollout-fixtures.ts"
import type { StoreLike } from "../src/store/connect.ts"

let cluster: Cluster
beforeAll(async () => { cluster = await startCluster() })
afterAll(async () => { await cluster?.stop() })

/** The version this wave takes. The four places below must all carry it. */
const VERSION = 5
const FILE = "005-dispatch.sql"

async function migrator() {
  const mod = await seam("src/store/migrate.ts")
  expect(typeof mod.migrate).toBe("function")
  return mod.migrate as (store: StoreLike, steps?: { version: number; sql: string }[]) => Promise<void>
}

/** A legacy store brought all the way up, which is what an upgraded box is. */
async function upgraded() {
  const f = await rolloutDatabase(cluster, true)
  await (await migrator())(f.store())
  return f
}

/** The envelope the door writes, planted here so the store can be read alone. */
function envelope(over: Record<string, unknown> = {}) {
  return {
    log_id: "fake:1000000001:7", at: "2026-09-20T10:00:00.000Z", door: "door-fake",
    chat: "1000000002", sender_id: "p1", from: "p1", text: "weigh the synthetic codeword",
    dispatch: {
      dispatcher: "p1-lair", target: "p1-research",
      approved: { by: "p1", at: "2026-09-20T10:00:00.000Z", digest: "a".repeat(64), source: "chat-command" },
      return: { agent: "p1-lair", door: "door-fake", chat: "1000000001" },
    },
    ...over,
  }
}

async function plantJob(sql: any, id: string, over: Record<string, unknown> = {}) {
  await sql`insert into inbound (id, person, agent, body, kind, source, log_ready)
            values (${id}, 'p1', 'p1-research', 'weigh the synthetic codeword', 'job',
                    ${envelope(over)}::jsonb, false)`
}

test("D-210 the dispatch migration is ordered, idempotent, and the version set is whole", async () => {
  const f = await rolloutDatabase(cluster, true)
  const migrate = await migrator()
  await migrate(f.store())
  await migrate(f.store())
  const versions = (await f.sql`select version from schema_version order by version`).map((r: any) => Number(r.version))
  // The WHOLE sorted set, which is the assertion that catches a skipped number:
  // a gap breaks the ordered list every later step is applied against.
  expect(versions).toEqual([1, 2, 3, 4, VERSION])
  expect((await f.sql`select count(*)::int as n from schema_version where version = ${VERSION}`)[0].n).toBe(1)
})

test("D-210 a fresh install and an upgraded store carry the same dispatch objects", async () => {
  const fresh = await rolloutDatabase(cluster)
  const old = await upgraded()
  const read = async (sql: any) => ({
    kinds: (await sql`select pg_get_constraintdef(oid) as d from pg_constraint
                      where conrelid = 'inbound'::regclass and conname = 'inbound_kind_is_known'`)[0]?.d ?? null,
    report: (await sql`select pg_get_function_identity_arguments(p.oid) as args, r.rolname as owner,
                              p.prosecdef, l.lanname as language, p.prosrc
                         from pg_proc p join pg_roles r on r.oid = p.proowner
                         join pg_language l on l.oid = p.prolang
                        where p.proname = 'hub_report'`)[0] ?? null,
    policies: (await sql`select policyname, cmd, roles::text as roles, with_check
                           from pg_policies where tablename = 'ledger_event'
                            and with_check like '%dispatch.%' order by policyname`),
    trigger: (await sql`select pg_get_triggerdef(t.oid) as d from pg_trigger t
                         where t.tgrelid = 'inbound'::regclass and not t.tgisinternal
                           and t.tgname = 'inbound_notify_project'`)[0]?.d ?? null,
  })
  const a = await read(fresh.sql)
  const b = await read(old.sql)
  expect(a.kinds).not.toBeNull()
  expect(a.report).not.toBeNull()
  expect(a.trigger).not.toBeNull()
  // Read from the catalog on both sides and compared, which is the property the
  // four-place rule exists for, asserted rather than counted.
  expect(b.kinds).toEqual(a.kinds)
  expect(b.report).toEqual(a.report)
  expect(Array.from(b.policies)).toEqual(Array.from(a.policies))
  expect(b.trigger).toEqual(a.trigger)
})

test("D-210 the migration file is named in the ordered list and in the installer's own list", async () => {
  // The installer's list is the one place a check cannot reach by running, so
  // it is bound by reading: an upgraded box whose migration never ran would
  // otherwise be left behind a fresh one with nothing saying so.
  expect(existsSync(hubPath(join("src/store/migrations", FILE)))).toBe(true)
  const ordered = readFileSync(hubPath("src/store/migrate.ts"), "utf8")
  expect(ordered).toContain(`version: ${VERSION}`)
  expect(ordered).toContain(`./migrations/${FILE}`)
  const installer = readFileSync(hubPath("src/install/run.ts"), "utf8")
  expect(installer).toContain(`[${VERSION}, "${FILE}"]`)
})

for (const [kind, rank] of [["human", 0], ["report", 0], ["triage", 1], ["room", 1],
  ["harvest", 1], ["measure", 1], ["job", 1]] as const) {
  test(`D-212 an inbound row of kind ${kind} is admitted and ranks ${rank}`, async () => {
    const f = await upgraded()
    const door = cluster.connectAs("hub_door", f.database)
    try {
      await door`insert into inbound (id, person, agent, body, kind)
                 values (${`row-${kind}`}, 'p1', 'p1-lair', 'synthetic body', ${kind})`
      const [row] = await f.sql`select rank from inbound where id = ${`row-${kind}`}`
      expect(row.rank).toBe(rank)
    } finally { await door.close() }
  })
}

test("D-212 a kind the constraint does not know is refused by the database", async () => {
  const f = await upgraded()
  const door = cluster.connectAs("hub_door", f.database)
  try {
    await expect(door`insert into inbound (id, person, agent, body, kind)
      values ('invented', 'p1', 'p1-lair', 'synthetic body', 'errand')`.execute()).rejects.toThrow(/inbound_kind_is_known/)
  } finally { await door.close() }
})

test("D-212 the rank expression is untouched by the dispatch migration", async () => {
  // Postgres 16 cannot alter a generated expression and this suite runs on it,
  // so a changed expression would mean dropping and re-adding a column on the
  // one table that holds every message. Adding a kind to a check constraint is
  // a cheap swap, and this is what says the cheap one was taken.
  const expression = "\nCASE\n    WHEN (kind = ANY (ARRAY['human'::text, 'report'::text])) THEN 0\n    ELSE 1\nEND"
  for (const f of [await rolloutDatabase(cluster), await upgraded()]) {
    const [row] = await f.sql`select pg_get_expr(d.adbin, d.adrelid) as e from pg_attrdef d
      join pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum
      where d.adrelid = 'inbound'::regclass and a.attname = 'rank'`
    expect(row.e).toBe(expression)
  }
})

test("D-212 the report function is owned by the role that writes the table it inserts into", async () => {
  const f = await upgraded()
  const [report] = await f.sql`select r.rolname as owner, p.prosecdef, l.lanname as language,
                                      pg_get_function_identity_arguments(p.oid) as args
                                 from pg_proc p join pg_roles r on r.oid = p.proowner
                                 join pg_language l on l.oid = p.prolang
                                where p.proname = 'hub_report'`
  expect(report).toBeDefined()
  // The owner is the role that already writes the table. `hub_report` inserts
  // into `inbound`, which the door owns, so the door owns it and the runner is
  // granted it.
  expect(report.owner).toBe("hub_door")
  expect(report.prosecdef).toBe(true)
  // Not `language sql`: a plain SQL function cannot raise, so the two refusals
  // below would silently insert nothing where they must refuse by name.
  expect(report.language).toBe("plpgsql")
  // No destination argument: the route is read off the row.
  expect(report.args).toBe("job_id text, report text")
  expect((await f.sql`select has_function_privilege('hub_runner', 'hub_report(text, text)', 'execute') as may`)[0].may).toBe(true)
  expect((await f.sql`select has_function_privilege('hub_hub', 'hub_report(text, text)', 'execute') as may`)[0].may).toBe(false)
  // The control, and it is what says the assertion is about ownership rather
  // than about luck: the shipped function beside it inserts into `outbox`, so
  // it is owned and granted the other way round by the same rule.
  const [notice] = await f.sql`select r.rolname as owner from pg_proc p join pg_roles r on r.oid = p.proowner
                                where p.proname = 'hub_door_notice'`
  expect(notice.owner).toBe("hub_runner")
  expect((await f.sql`select has_function_privilege('hub_door',
    'hub_door_notice(text, text, text, text, jsonb, integer)', 'execute') as may`)[0].may).toBe(true)
})

test("D-212 the runner still holds no insert on inbound and still holds its three columns", async () => {
  const f = await upgraded()
  await plantJob(f.sql, "job-fence")
  const runner = cluster.connectAs("hub_runner", f.database)
  try {
    await expect(runner`insert into inbound (id, person, agent, body, kind)
      values ('runner-wrote-this', 'p1', 'p1-lair', 'synthetic body', 'report')`.execute())
      .rejects.toThrow(/permission denied|row-level security/i)
    // The control that says the fence was kept and not replaced.
    await runner`update inbound set claimed_by = 'runner-pi', claim_deadline = now(), retry_at = now()
                  where id = 'job-fence'`
    const [row] = await f.sql`select claimed_by from inbound where id = 'job-fence'`
    expect(row.claimed_by).toBe("runner-pi")
  } finally { await runner.close() }
})

test("D-212 D-213 the report is built from the job row and takes the job's own time", async () => {
  const f = await upgraded()
  const at = new Date(Date.now() - 3600_000).toISOString()
  await f.sql`insert into inbound (id, person, agent, body, kind, source, log_ready, received_at)
              values ('job-1', 'p1', 'p1-research', 'weigh the synthetic codeword', 'job',
                      ${envelope()}::jsonb, false, ${at}::timestamptz)`
  const runner = cluster.connectAs("hub_runner", f.database)
  try {
    await runner`select hub_report('job-1', 'the synthetic codeword weighs four')`
  } finally { await runner.close() }
  const [row] = await f.sql`select * from inbound where id = 'report:job-1'`
  expect(row).toBeDefined()
  expect(row.kind).toBe("report")
  expect(row.rank).toBe(0)
  expect(row.person).toBe("p1")
  expect(row.agent).toBe("p1-lair")
  expect(row.body).toBe("the synthetic codeword weighs four")
  expect(row.log_ready).toBe(false)
  expect(row.source.door).toBe("door-fake")
  expect(row.source.chat).toBe("1000000001")
  expect(row.source.from).toBe("p1-research")
  expect(row.source.job).toBe("job-1")
  expect(row.source.log_id).toBe("report:job-1")
  expect(row.source.text).toBe("the synthetic codeword weighs four")
  // The job's own instant, never the completion time. Under the shipped feed
  // order a report stamped when the job finished would sort after a human
  // message that arrived while it ran.
  expect(new Date(row.received_at).toISOString()).toBe(at)
  // The row is on the queue like every other, so the household's own timing
  // numbers see it: they are computed from this stamp.
  const diary = await f.sql`select kind, actor from ledger_event where subject = 'report:job-1'`
  expect(Array.from(diary)).toEqual([{ kind: "received", actor: "door" }])
})

test("D-212 a replayed settle lands nothing and a row that is not a job is refused by name", async () => {
  const f = await upgraded()
  await plantJob(f.sql, "job-2")
  await f.sql`insert into inbound (id, person, agent, body, kind) values ('human-1', 'p1', 'p1-lair', 'a sentence', 'human')`
  const runner = cluster.connectAs("hub_runner", f.database)
  try {
    await runner`select hub_report('job-2', 'first')`
    await runner`select hub_report('job-2', 'second')`
    const rows = await f.sql`select body from inbound where id = 'report:job-2'`
    expect(rows).toHaveLength(1)
    expect(rows[0].body).toBe("first")
    await expect(runner`select hub_report('human-1', 'a report on nothing')`.execute())
      .rejects.toThrow(/belongs to a job/)
    await expect(runner`select hub_report('no-such-row', 'a report on nothing')`.execute())
      .rejects.toThrow(/no job/)
  } finally { await runner.close() }
})

test("D-212 the diary admits the three dispatch kinds, each from its own actor only", async () => {
  const f = await upgraded()
  const door = cluster.connectAs("hub_door", f.database)
  const runner = cluster.connectAs("hub_runner", f.database)
  const entry = (conn: any, kind: string, actor: string) =>
    conn`insert into ledger_event (stream, subject, kind, actor)
         values ('control', 'job-3', ${kind}, ${actor})`.execute()
  try {
    await entry(door, "dispatch.requested", "door")
    await entry(runner, "dispatch.reported", "runner")
    await entry(runner, "dispatch.refused", "runner")
    // Without these two the policy asserted above would be one that permits
    // everything, and who authorized what would stop being a recorded fact.
    await expect(entry(door, "dispatch.reported", "door")).rejects.toThrow(/row-level security/i)
    await expect(entry(runner, "dispatch.requested", "runner")).rejects.toThrow(/row-level security/i)
    // The control that says the policy was widened and not replaced.
    await entry(door, "recovery.requested", "door")
    await entry(runner, "recovery.applied", "runner")
    const kinds = (await f.sql`select kind from ledger_event where stream = 'control' order by seq`).map((r: any) => r.kind)
    expect(kinds).toEqual(["dispatch.requested", "dispatch.reported", "dispatch.refused",
      "recovery.requested", "recovery.applied"])
  } finally { await door.close(); await runner.close() }
})

test("D-213 an unprojected report or job wakes its door, and nothing else on that channel does", async () => {
  const f = await upgraded()
  const { listenForWork } = await seam("src/store/listen.ts") as {
    listenForWork: (a: { url: string; channel: string; onNotify(payload: string): void }) => Promise<{ close(): Promise<void> }>
  }
  const projected: string[] = []
  const woken: string[] = []
  const url = cluster.url(f.database)
  const project = await listenForWork({ url, channel: "hub_project", onNotify: p => { projected.push(p) } })
  const work = await listenForWork({ url, channel: "hub_work", onNotify: p => { woken.push(p) } })
  try {
    // Each silent case is inserted BEFORE a loud one, so waiting for the loud
    // payload proves the silent one really fired nothing: one connection
    // delivers notifications in commit order.
    await f.sql`insert into inbound (id, person, agent, body, kind, source, log_ready)
                values ('ready-report', 'p1', 'p1-lair', 'a report', 'report',
                        ${{ door: "door-fake", chat: "1000000001" }}::jsonb, true)`
    await f.sql`insert into inbound (id, person, agent, body, kind, source, log_ready)
                values ('unready-human', 'p1', 'p1-lair', 'a sentence', 'human',
                        ${{ door: "door-fake", chat: "1000000001" }}::jsonb, false)`
    await f.sql`insert into inbound (id, person, agent, body, kind, source, log_ready)
                values ('unready-report', 'p1', 'p1-lair', 'a report', 'report',
                        ${{ door: "door-fake", chat: "1000000001" }}::jsonb, false)`
    await until("the door is told to sweep for a report", () => projected.length > 0, 10_000)
    await plantJob(f.sql, "unready-job")
    await until("the door is told to sweep for a job", () => projected.length > 1, 10_000)
    expect(projected).toEqual(["door-fake", "door-fake"])
    // The control that says the shipped notification was not disturbed. The
    // wait counts, because the ready report above already woke the runner once
    // and a wait on the payload alone would return before this one arrived.
    const before = woken.length
    await f.sql`insert into inbound (id, person, agent, body, kind) values ('ready-human', 'p1', 'p1-lair', 'a sentence', 'human')`
    await until("the shipped work notification still fires", () => woken.length > before, 10_000)
    expect(woken).toEqual(["p1-lair", "p1-lair"])
  } finally { await project.close(); await work.close() }
})

test("D-210 a store with the migration applied and nothing planted holds nothing of its own", async () => {
  const f = await upgraded()
  expect((await f.sql`select count(*)::int as n from inbound where kind = 'job'`)[0].n).toBe(0)
  expect((await f.sql`select count(*)::int as n from ledger_event where stream = 'control'`)[0].n).toBe(0)
})
