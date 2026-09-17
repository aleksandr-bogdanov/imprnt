// Prove the reply check's server-log configuration using the existing observer.
import { strict as assert } from "node:assert"
import { startCluster, statementWatch } from "../test/helpers/cluster.ts"
const cluster = await startCluster({ settings: { log_statement: "'all'", log_line_prefix: "'pid=%p '", log_min_duration_statement: "-1" } })
const query = cluster.connect("postgres")
try {
  await query.unsafe("select 1")
  const quiet = await statementWatch(cluster)
  await Bun.sleep(100)
  assert.equal(await quiet.count(), 0)
  await query.unsafe("select 1 as synthetic_poll")
  await Bun.sleep(100)
  const count = await quiet.count()
  assert(count > 0)
  assert.throws(() => assert.equal(count, 0))
  const pid = Number((await query.unsafe("select pg_backend_pid() as pid"))[0].pid)
  const ignored = await statementWatch(cluster, [pid])
  await query.unsafe("select 2 as observer_only")
  await Bun.sleep(100)
  assert.equal(await ignored.count(), 0)
  console.log("HELPER PASS round-3 real log detects a foreign query, rejects it as quiet and excludes the named observer")
} finally { await query.close(); await cluster.stop() }
