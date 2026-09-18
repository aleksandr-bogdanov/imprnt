import assert from "node:assert/strict"
import { writeFileSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { startCluster, startReadySubprocess } from "../test/helpers/cluster.ts"
import { rolloutFixture, rolloutDatabase } from "../test/helpers/rollout-fixtures.ts"
import { message } from "../test/helpers/rollout-ingress.ts"
const cluster = await startCluster()
try {
  for (const point of ["media-save", "accepted-commit", "projection", "demand-before-cursor", "demand-after-cursor"]) {
    const f = rolloutFixture()
    let child: Awaited<ReturnType<typeof startReadySubprocess>> | undefined
    try {
      const db = await rolloutDatabase(cluster)
      const config = join(f.dir, "config.json")
      const trace = join(f.dir, "trace.jsonl")
      writeFileSync(config, JSON.stringify({ mode: "ingress", proof: true, point, trace, stateDir: f.stateDir, url: db.store("hub_door").url, id: "proof-id", message: { ...message(), media: [{}] } }))
      child = await startReadySubprocess("test/helpers/rollout-crash-child.ts", [config], 5000)
      const events = readFileSync(trace, "utf8").trim().split("\n").map(line => JSON.parse(line))
      assert.ok(events.some(e => e.event === "directory-sync"))
      assert.equal(events.filter(e => e.event === "file-sync").length, 2)
      assert.equal(events.filter(e => e.event === "rename").length, 2)
      assert.equal(events.filter(e => e.event === "open" && e.detail.flags === "wx").length, 2)
      assert.equal((await db.sql`select id from inbound where id = 'proof-id'`).length, 0)
      assert.equal((await db.sql`select id from state_row where sheet = 'door_cursor'`).length, point === "demand-after-cursor" ? 1 : 0)
      await child.stop(9)
      assert.equal(child.proc.signalCode, "SIGKILL")
      assert.equal((await db.sql`select id from inbound where id = 'proof-id'`).length, 0)
      console.log(`PASS ingress crash ${point}, parent observation, SIGKILL and rollback`)
    } finally { await child?.stop(9); f.stop() }
  }
} finally { await cluster.stop() }
