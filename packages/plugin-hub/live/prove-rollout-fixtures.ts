import assert from "node:assert/strict"
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { rolloutFixture, rolloutDatabase } from "../test/helpers/rollout-fixtures.ts"
import { startCluster, freshDatabase, startReadySubprocess } from "../test/helpers/cluster.ts"
import { storeUrlAs } from "../src/store/connect.ts"
import { loadRegistry } from "../src/registry/load.ts"
const f = rolloutFixture()
const cluster = await startCluster()
try {
  loadRegistry(f.file)
  assert.equal(statSync(f.dir).mode & 0o777, 0o700)
  const text = f.field("p1-lair", "tools", '["Read", "Write"]')
  const parsed = Bun.TOML.parse(text) as any
  assert.deepEqual(parsed.agents[0].tools, ["Read", "Write"])
  assert.throws(() => f.field("absent", "tools", "[]"))
  for (const file of Object.values(f.files)) assert.equal(statSync(file).mode & 0o777, 0o600)
  for (const legacy of [true, false]) {
    const seeded = await rolloutDatabase(cluster, legacy)
    assert.equal((await seeded.sql`select count(*)::int as n from outbox`)[0].n, 2)
    assert.equal((await seeded.sql`select count(*)::int as n from outbox where delivered_at is not null`)[0].n, 1)
    assert.equal((await seeded.store("hub_door").sql`select current_user as role`)[0].role, "hub_door")
  }
  console.log("PASS rollout database: frozen v5 and current schema, preserved timestamps, pending and delivered rows, role connections")
  const db = await freshDatabase(cluster)
  const sql = cluster.connect(db)
  for (const point of ["inbound-commit", "append-before-fsync", "outgoing-before-send"]) {
    const config = join(f.dir, "barrier.json")
    const file = join(f.dir, `${point}.jsonl`)
    writeFileSync(config, JSON.stringify({ proof: true, point, file, url: storeUrlAs(cluster.url(db), "hub_door"),
      message: { id: "proof", person: "p1", agent: "p1-lair", body: "synthetic" },
      line: { id: point, text: "synthetic" } }))
    const child = await startReadySubprocess("test/helpers/rollout-crash-child.ts", [config], 5000)
    try {
      assert(child.pid > 0)
      if (point === "inbound-commit") assert.equal((await sql`select body from inbound where id = 'proof'`)[0].body, "synthetic")
      else assert.equal(JSON.parse(readFileSync(file, "utf8")).id, point)
    } finally { await child.stop(9) }
    assert.equal(child.proc.signalCode, "SIGKILL")
  }
  console.log("PASS rollout fixtures: private paths, registry arrays, both people, source files, commit/append/send barriers and SIGKILL cleanup")
} finally { await cluster.stop(); f.stop() }
assert.equal(existsSync(f.dir), false)
console.log("PASS rollout fixture directory cleanup")
