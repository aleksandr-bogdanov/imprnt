// D-172. Library migrations, not installer or native service operations.
import { afterAll, beforeAll, expect, test } from "bun:test"
import { startCluster, seam, type Cluster } from "./helpers/cluster.ts"
import { rolloutDatabase } from "./helpers/rollout-fixtures.ts"
import type { StoreLike } from "../src/store/connect.ts"
let cluster: Cluster
beforeAll(async () => { cluster = await startCluster() })
afterAll(async () => { await cluster?.stop() })

async function migrator() {
  const mod = await seam("src/store/migrate.ts")
  expect(typeof mod.migrate).toBe("function")
  // The optional ordered migration list is a library dependency seam. It is
  // not a production registry, environment or command-line behavior switch.
  return mod.migrate as (store: StoreLike, steps?: { version: number; sql: string }[]) => Promise<void>
}

test("ROLL-18 ROLL-20 D-172 ordered migrations preserve old records and rerun twice", async () => {
  const f = await rolloutDatabase(cluster, true)
  const before = await f.sql`select * from outbox order by id /* before migration */`
  const migrate = await migrator()
  await migrate(f.store())
  await migrate(f.store())
  const input = (await f.sql`select source, log_ready, body, received_at from inbound where id = 'old-input'`)[0]
  expect(input.source).toBeNull()
  expect(input.log_ready).toBe(true)
  expect(input.body).toBe("synthetic history")
  const rows = await f.sql`select * from outbox order by id`
  expect(rows).toHaveLength(2)
  for (let i = 0; i < rows.length; i++) {
    for (const key of Object.keys(before[i])) expect(rows[i][key]).toEqual(before[i][key])
    expect(rows[i].delivery_state).toBe(i === 0 ? "delivered" : "pending")
    expect(rows[i].attempts).toBe(0)
    expect(rows[i].retry_at).toBeNull()
    expect(rows[i].failure).toBeNull()
    expect(rows[i].route).toBeNull()
  }
  const versions = await f.sql`select version from schema_version order by version`
  expect(versions.length).toBeGreaterThan(0)
  expect(new Set(versions.map((row: any) => row.version)).size).toBe(versions.length)
  await migrate(f.store())
  expect(await f.sql`select version from schema_version order by version`).toEqual(versions)
})

test("ROLL-18 ROLL-20 D-172 a failed migration rolls back its DDL and version before corrected retry", async () => {
  const f = await rolloutDatabase(cluster, true)
  const migrate = await migrator()
  await migrate(f.store())
  const before = await f.sql`select version from schema_version order by version`
  const version = Math.max(...before.map((r: any) => Number(r.version))) + 1
  const create = "create table synthetic_migration_probe (id int primary key)"
  await expect(migrate(f.store(), [{ version, sql: `${create}; select 1 / 0` }])).rejects.toThrow("division by zero")
  expect((await f.sql`select to_regclass('synthetic_migration_probe') as name`)[0].name).toBeNull()
  expect(await f.sql`select version from schema_version order by version`).toEqual(before)
  const fixed = [{ version, sql: `${create}; insert into synthetic_migration_probe values (1)` }]
  await migrate(f.store(), fixed)
  await migrate(f.store(), fixed)
  expect(Array.from(await f.sql`select * from synthetic_migration_probe`)).toEqual([{ id: 1 }])
  expect((await f.sql`select count(*)::int as n from schema_version where version = ${version}`)[0].n).toBe(1)
})

test("ROLL-20 ROLL-18 D-172 fresh schema defaults match migration and delivery state is constrained", async () => {
  const f = await rolloutDatabase(cluster)
  const columns = await f.sql`select column_name from information_schema.columns where table_name = 'inbound'`
  expect(columns.map((r: any) => r.column_name), "D-172 inbound projection columns").toContain("log_ready")
  expect(columns.map((r: any) => r.column_name)).toContain("source")
  const row = (await f.sql`select log_ready, source from inbound`)[0]
  expect(row).toEqual({ log_ready: true, source: null })
  const pending = (await f.sql`select route, delivery_state, attempts, retry_at, failure from outbox where seq_in_reply = 2`)[0]
  expect(pending).toEqual({ route: null, delivery_state: "pending", attempts: 0, retry_at: null, failure: null })
  await f.sql`update outbox set delivery_state = 'failed', attempts = 1, failure = '{"code":"access-denied"}' where seq_in_reply = 2`
  expect((await f.sql`select delivered_at from outbox where seq_in_reply = 2`)[0].delivered_at).toBeNull()
  await expect(f.sql`update outbox set delivery_state = 'invented' where seq_in_reply = 2`.execute()).rejects.toThrow()
  await expect(f.sql`update outbox set attempts = -1 where seq_in_reply = 2`.execute()).rejects.toThrow()
})

for (const role of ["hub_door", "hub_runner", "hub_agent", "hub_hub"]) {
  test(`ROLL-20 ROLL-18 D-172 ${role} has only its projection delivery and stamp privileges`, async () => {
    const f = await rolloutDatabase(cluster)
    const columns = await f.sql`select column_name from information_schema.columns where table_name = 'inbound'`
    expect(columns.map((r: any) => r.column_name), "D-172 role fence needs source/log_ready").toContain("log_ready")
    const sql = f.store(role).sql
    // Each denied operation is paired with the owner doing it on the same row.
    const door = f.store("hub_door").sql
    const runner = f.store("hub_runner").sql
    await door`update inbound set log_ready = false where id = 'old-input'`
    await door`update inbound set log_ready = true where id = 'old-input'`
    expect((await f.sql`select log_ready from inbound where id = 'old-input'`)[0].log_ready).toBe(true)
    await runner`update inbound set claimed_by = 'runner-pi' where id = 'old-input'`
    for (const stamp of ["acked", "started", "answered"]) {
      await runner`insert into ledger_event (stream, subject, kind, actor) values ('inbound', 'old-input', ${stamp}, 'runner')`
      if (role !== "hub_runner") await expect(sql`insert into ledger_event (stream, subject, kind, actor) values ('inbound', 'old-input', ${stamp}, 'runner')`.execute()).rejects.toThrow()
    }
    // A legacy row may acquire a route once before its first attempt.
    await door`update outbox set route = '{"door":"door-fake","chat":"0000000000"}' where seq_in_reply = 2`
    expect((await f.sql`select route from outbox where seq_in_reply = 2`)[0].route.chat).toBe("0000000000")
    await door`update outbox set delivery_state = 'failed' , attempts = 1, retry_at = null, failure = '{"code":"access-denied"}' where seq_in_reply = 2`
    await door`update outbox set delivered_at = now(), delivery_state = 'delivered' where seq_in_reply = 1`
    if (role !== "hub_door") {
      await expect(sql`update inbound set log_ready = false where id = 'old-input'`.execute()).rejects.toThrow()
      await expect(sql`update outbox set delivery_state = 'pending', attempts = 0, retry_at = now(), failure = null where seq_in_reply = 2`.execute()).rejects.toThrow()
      await expect(sql`update outbox set delivered_at = now() where seq_in_reply = 2`.execute()).rejects.toThrow()
    }
    if (role !== "hub_runner") {
      await expect(sql`update inbound set claimed_by = 'runner-mac' where id = 'old-input'`.execute()).rejects.toThrow()
      await expect(sql`insert into outbox (inbound_id, seq_in_reply, body) values ('old-input', 3, 'forged')`.execute()).rejects.toThrow()
    }
    // Source identity is immutable after acceptance, including for the runner.
    await expect(sql`update inbound set source = '{"sender_id":"p2"}' where id = 'old-input'`.execute()).rejects.toThrow()
    await expect(sql`update inbound set body = 'forged' where id = 'old-input'`.execute()).rejects.toThrow()
    await expect(sql`update inbound set state = 'answered' where id = 'old-input'`.execute()).rejects.toThrow()
    await expect(sql`update outbox set body = 'forged' where seq_in_reply = 2`.execute()).rejects.toThrow()
    // Populate a pinned accepted route through the owner on insertion, then
    // demand refusal even for a runner trying to redirect an existing reply.
    await runner`insert into outbox (inbound_id, seq_in_reply, body, route) values ('old-input', 4, 'routed', '{"door":"door-fake","chat":"0000000000"}')`
    await expect(sql`update outbox set route = '{"door":"door-fake","chat":"1000000001"}' where seq_in_reply = 4`.execute()).rejects.toThrow()
    expect((await f.sql`select route from outbox where seq_in_reply = 4`)[0].route.chat).toBe("0000000000")
  })
}

test("ROLL-20 ROLL-23 D-172 replies inherit source route and notices pin their creation route", async () => {
  const f = await rolloutDatabase(cluster)
  const columns = await f.sql`select column_name from information_schema.columns where table_name = 'inbound'`
  expect(columns.map((r: any) => r.column_name), "D-172 accepted source route missing").toContain("source")
  const { enqueueInbound } = await import("../src/store/inbound.ts")
  const { appendChunks, appendNotice } = await import("../src/store/outbox.ts")
  const door = f.store("hub_door")
  const runner = f.store("hub_runner")
  const route = { door: "door-fake", chat: "0000000000" }
  const source = { ...route, log_id: "synthetic-route", at: "2026-09-01T12:00:00Z", sender_id: "p1", text: "synthetic" }
  await door.sql.begin(async sql => { await enqueueInbound({ sql, url: door.url }, { id: "synthetic-route", person: "p1", agent: "p1-lair", body: source.text, source, log_ready: false } as any) })
  await runner.sql.begin(async sql => { await appendChunks({ sql, url: runner.url }, "synthetic-route", ["one", "two"]) })
  expect(Array.from(await f.sql`select route from outbox where inbound_id = 'synthetic-route' order by seq_in_reply`)).toEqual([{ route }, { route }])
  const noticeRoute = { door: "door-fake", chat: "1000000001" }
  const notice = { person: "p1", agent: "p1-lair", body: "synthetic notice", noticeKey: "synthetic-notice", route: noticeRoute }
  expect(await appendNotice(runner, notice)).toBe(true)
  const replay = { ...notice, route }
  expect(await appendNotice(runner, replay)).toBe(false)
  expect((await f.sql`select route from outbox where notice_key = 'synthetic-notice'`)[0].route).toEqual(noticeRoute)
})
