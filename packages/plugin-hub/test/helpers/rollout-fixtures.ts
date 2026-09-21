// Synthetic additions compose the shipped registry and tree builders.
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { writeRegistry } from "./registry.ts"
import { plantTrees } from "./trees.ts"

export function rolloutFixture() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "hub-rollout-")))
  chmodSync(dir, 0o700)
  const trees = plantTrees(dir)
  for (const person of trees.people) writeFileSync(join(person.tree, "CLAUDE.md"), "Synthetic filing rules.\n", { mode: 0o600 })
  const stateDir = join(dir, "state")
  mkdirSync(stateDir)
  const files = Object.fromEntries(["fragment", "settings", "mcp", "filing_rules"].map(key => {
    const file = join(dir, key)
    writeFileSync(file, key === "settings" ? '{"permissions":{"allow":["Read"],"deny":[]}}' : key === "mcp" ? '{"mcpServers":{}}' : "Synthetic instructions.\n", { mode: 0o600 })
    return [key, file]
  }))
  const preset = { adapter: "synthetic-loop", model: "synthetic-alias", provider: "synthetic-provider", effort: "medium", paid: "key" }
  const file = writeRegistry(dir, {
    hub: { state_dir: stateDir },
    people: trees.people.map(p => ({ id: p.id, tree: p.tree })),
    presets: { daily: preset, alternate: { ...preset, model: "synthetic-other" } },
    agents: [{ id: "p1-lair", person: "p1", preset: "daily", chat: "0000000000", door: "door-fake", runner: "runner-pi" }],
  })
  const base = readFileSync(file, "utf8")
  return {
    dir, stateDir, trees, files, file, base, preset,
    write(text = base) { writeFileSync(file, text, { mode: 0o600 }); return file },
    // Insert into an existing TOML array table identified by its synthetic ID.
    field(id: string, key: string, toml: string, text = base) {
      const needle = `id = ${JSON.stringify(id)}\n`
      if (!text.includes(needle)) throw new Error(`fixture has no ${id}`)
      return text.replace(needle, `${needle}${key} = ${toml}\n`)
    },
    stop() { rmSync(dir, { recursive: true, force: true }) },
  }
}

import { storeUrlAs } from "../../src/store/connect.ts"
import type { Cluster } from "./cluster.ts"
import { hubPath, SCHEMA_SQL } from "./cluster.ts"
export async function rolloutDatabase(cluster: Cluster, legacy = false) {
  const database = await cluster.createDatabase()
  await cluster.runSqlFile(database, legacy ? hubPath("test/fixtures/rollout-schema-v5.sql") : SCHEMA_SQL)
  const sql = cluster.connect(database)
  await sql`insert into inbound (id, person, agent, body) values ('old-input', 'p1', 'p1-lair', 'synthetic history')`
  await sql`insert into outbox (inbound_id, seq_in_reply, body, written_at, delivered_at) values
    ('old-input', 1, 'delivered', '2026-09-01T12:00:00Z', '2026-09-01T12:00:01Z'),
    ('old-input', 2, 'pending', '2026-09-01T12:00:00Z', null)`
  const store = (role?: string) => ({ sql: role ? cluster.connectAs(role, database) : cluster.connect(database), url: role ? storeUrlAs(cluster.url(database), role) : cluster.url(database) })
  return { database, sql, store }
}
