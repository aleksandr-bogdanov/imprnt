// Library migrations, not installer or native service operations.
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

test("migration 12 lands on an upgraded store as the same effect and confirmation objects, checks and grants a fresh install has, and rerunning it changes nothing", async () => {
  const upgraded = await rolloutDatabase(cluster, true)
  const fresh = await rolloutDatabase(cluster)
  const migrate = await migrator()
  await migrate(upgraded.store())
  await migrate(upgraded.store())
  const read = async (q: any) => ({
    functions: Array.from(await q`select p.proname, pg_get_function_identity_arguments(p.oid) as args, r.rolname as owner, p.prosecdef, p.prosrc
      from pg_proc p join pg_roles r on r.oid = p.proowner
      where p.proname in ('hub_effect_want', 'hub_effect_release_edit', 'hub_confirmation_freeze', 'hub_guard_platform_effect', 'hub_guard_confirmation', 'hub_notify_effect')
      order by p.proname`),
    columns: Array.from(await q`select table_name, column_name, data_type, is_nullable, column_default from information_schema.columns
      where table_name in ('platform_effect', 'confirmation') order by table_name, ordinal_position`),
    indexes: Array.from(await q`select indexname, indexdef from pg_indexes where tablename in ('platform_effect', 'confirmation') order by indexname`),
    checks: Array.from(await q`select conrelid::regclass::text as t, conname, pg_get_constraintdef(oid) as d from pg_constraint
      where conrelid in ('platform_effect'::regclass, 'confirmation'::regclass) order by conrelid::regclass::text, conname`),
    triggers: Array.from(await q`select t.tgname, pg_get_triggerdef(t.oid) as d from pg_trigger t
      where t.tgrelid in ('platform_effect'::regclass, 'confirmation'::regclass) and not t.tgisinternal order by t.tgname`),
    tableGrants: Array.from(await q`select table_name, grantee, privilege_type from information_schema.role_table_grants
      where table_name in ('platform_effect', 'confirmation') and grantee in ('hub_door', 'hub_runner', 'hub_hub', 'hub_agent')
      order by table_name, grantee, privilege_type`),
    columnGrants: Array.from(await q`select table_name, column_name, grantee, privilege_type from information_schema.column_privileges
      where table_name in ('platform_effect', 'confirmation') and grantee in ('hub_door', 'hub_runner', 'hub_hub', 'hub_agent')
        and privilege_type = 'UPDATE' order by table_name, column_name, grantee`),
    routineGrants: Array.from(await q`select routine_name, grantee from information_schema.routine_privileges
      where routine_name in ('hub_effect_want', 'hub_effect_release_edit', 'hub_confirmation_freeze') and grantee in ('hub_door', 'hub_runner', 'hub_hub', 'hub_agent')
      order by routine_name, grantee`),
  })
  const a = await read(fresh.sql)
  const b = await read(upgraded.sql)
  // The removed generic release of an unknown edit is looked for by name, on both stores, and is on neither.
  expect(a.functions.map((row: any) => row.proname)).not.toContain("hub_effect_release_edit")
  expect(a.functions).toHaveLength(5)
  expect(a.triggers.map((row: any) => row.tgname)).toEqual([
    "confirmation_notify", "confirmation_rules", "platform_effect_notify_content", "platform_effect_notify_insert", "platform_effect_rules",
  ])
  expect(a.checks.length).toBeGreaterThan(10)
  expect(b).toEqual(a)
  // What the roles hold, read off the catalog: nobody inserts or deletes, only the door updates, and only its own columns.
  expect(a.tableGrants.filter((row: any) => row.privilege_type !== "SELECT" && row.privilege_type !== "UPDATE")).toEqual([])
  expect(new Set(a.columnGrants.map((row: any) => row.grantee))).toEqual(new Set(["hub_door"]))
  expect(a.columnGrants.filter((row: any) => row.table_name === "confirmation").map((row: any) => row.column_name).sort())
    .toEqual(["approved_at", "approved_by", "cause", "evidence", "observed_at", "state"])
  // The edit's own columns are the door's, next to the create's: the claim, the pin and the outcome.
  expect(a.columnGrants.filter((row: any) => row.table_name === "platform_effect").map((row: any) => row.column_name))
    .toEqual(expect.arrayContaining(["applied_hash", "edit_state", "edit_attempt_id", "edit_revision", "edit_hash", "edit_attempts"]))
  // What was asked for is never the door's to change.
  expect(a.columnGrants.filter((row: any) => row.table_name === "platform_effect").map((row: any) => row.column_name))
    .not.toEqual(expect.arrayContaining(["wanted_content"]))
  // Nobody holds a way to release an unknown edit; the freeze and the want are the only routines.
  expect(a.routineGrants.map((row: any) => `${row.routine_name}:${row.grantee}`)).toEqual([
    "hub_confirmation_freeze:hub_door", "hub_confirmation_freeze:hub_hub", "hub_confirmation_freeze:hub_runner",
    "hub_effect_want:hub_door", "hub_effect_want:hub_hub", "hub_effect_want:hub_runner",
  ])
  const versions = (await upgraded.sql`select version from schema_version order by version`).map((row: any) => Number(row.version))
  expect(versions).toContain(12)
  expect(versions).toEqual((await fresh.sql`select version from schema_version order by version`).map((row: any) => Number(row.version)))
})

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

test("migration 18 upgrades council erasure and catch-up identically to a fresh install, and serving waits for it", async () => {
  const { readFileSync } = await import("node:fs")
  const { hubPath } = await import("./helpers/cluster.ts")
  const { MIGRATION_FILES } = await import("../src/store/migrate.ts")
  const { councilNoticeSchemaReady, deletionSchemaReady, applyErasureManifest } = await import("../src/store/deletions.ts")
  const { erasureFence } = await import("../src/erasure/startup.ts")
  const { requireSchema } = await import("../src/runner/execution.ts")
  const upgraded = await rolloutDatabase(cluster, true)
  const fresh = await rolloutDatabase(cluster)
  const migrate = await migrator()
  const store = { sql: upgraded.sql, url: cluster.url(upgraded.database) } as StoreLike
  await migrate(store, MIGRATION_FILES.filter(([version]) => version < 18)
    .map(([version, file]) => ({ version, sql: readFileSync(hubPath(`src/store/migrations/${file}`), "utf8") })))
  const door = store
  expect(await deletionSchemaReady(door)).toBe(true)
  expect(await councilNoticeSchemaReady(door)).toBe(false)
  expect(await erasureFence(door, null)).toContain("schema 18")
  await expect(requireSchema(store)).rejects.toThrow("apply migration 18")
  await expect(applyErasureManifest(store, {version: 1, generation: 0, tombstones: []})).rejects.toThrow("apply migration 18")
  await migrate(store)
  await migrate(store)
  expect(await councilNoticeSchemaReady(door)).toBe(true)
  expect(await erasureFence(door, null)).toBeNull()
  await requireSchema(store)
  const functions = async (sql: StoreLike['sql']) => Array.from(await sql`
    select p.proname, pg_get_function_identity_arguments(p.oid) as args, p.prosecdef, p.prosrc, p.proconfig,
      has_function_privilege('hub_door', p.oid, 'execute') as door,
      has_function_privilege('hub_runner', p.oid, 'execute') as runner,
      has_function_privilege('hub_hub', p.oid, 'execute') as hub,
      has_function_privilege('hub_agent', p.oid, 'execute') as agent
    from pg_proc p where p.proname in ('hub_erasure_owns_notice', 'hub_deletion_inventory', 'hub_erase_scope',
      'hub_erasure_remaining', 'hub_topic_attention_catchup', 'hub_topic_attention_lock', 'hub_council_notice_lock') order by p.proname`)
  const installed = await functions(fresh.sql as unknown as StoreLike['sql'])
  expect(installed).toHaveLength(7)
  expect(await functions(upgraded.sql as unknown as StoreLike['sql'])).toEqual(installed)
  expect(installed.every((row: any) => !row.agent)).toBe(true)
  await upgraded.sql.close()
  await fresh.sql.close()
  expect(readFileSync(hubPath('src/schema.sql'), 'utf8')).toContain(readFileSync(hubPath('src/store/migrations/018-council-notice-erasure.sql'), 'utf8').trim())
})
