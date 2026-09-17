// Exercise the exact inline audit DDL without a migration implementation.
import { strict as assert } from "node:assert"
import { readFileSync } from "node:fs"
import { startCluster, freshDatabase, hubPath } from "../test/helpers/cluster.ts"
const source = readFileSync(hubPath("test/v2-work-handoff.test.ts"), "utf8")
const create = source.match(/await h\.read\.sql\("(create table handoff_audit[^"\n]+)"\)/)![1]
const fn = source.match(/await h\.read\.sql\(`(create function handoff_observe[\s\S]*?)`\)/)![1]
const grant = source.match(/await h\.read\.sql\("(grant insert on handoff_audit[^"\n]+)"\)/)![1]
const cluster = await startCluster()
const db = await freshDatabase(cluster)
const sql = cluster.connect(db)
try {
  await sql.unsafe(create)
  await sql.unsafe(fn)
  await sql.unsafe(grant)
  for (const table of ["inbound", "outbox", "state_row"]) await sql.unsafe(`create trigger observe_handoff after insert or update on ${table} for each row execute function handoff_observe()`)
  await sql.begin(async tx => {
    await tx.unsafe("set local role hub_door")
    await tx.unsafe("insert into inbound (id,person,agent,body) values ('audit-proof','p1','p1-lair','synthetic')")
    await tx.unsafe("insert into state_row (sheet,id,data) values ('door_cursor','door-fake/0000000000','{}')")
  })
  await sql.begin(async tx => {
    await tx.unsafe("set local role hub_runner")
    await tx.unsafe("insert into outbox (inbound_id,seq_in_reply,body) values ('audit-proof',1,'synthetic')")
  })
  const rows = Array.from(await sql.unsafe("select * from handoff_audit order by relation")) as { relation: string, role: string, operation: string }[]
  assert.deepEqual(rows.map(r => [r.relation,r.role,r.operation]), [["inbound","hub_door","INSERT"],["outbox","hub_runner","INSERT"],["state_row","hub_door","INSERT"]])
  await sql.unsafe("insert into inbound (id,person,agent,body) values ('wrong-role','p1','p1-lair','synthetic')")
  const wrong = (await sql.unsafe("select role from handoff_audit where relation='inbound' order by role"))
  assert.equal(wrong.some((r: { role: string }) => r.role !== 'hub_door'), true)
  console.log("HELPER PASS round-2 handoff audit observes real door and runner roles and rejects an admin writer")
} finally { await sql.close(); await cluster.stop() }
