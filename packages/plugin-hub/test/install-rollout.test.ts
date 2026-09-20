import { afterAll, beforeAll, expect, test } from "bun:test"
import { readFileSync, writeFileSync } from "node:fs"
import { startCluster, seam, hubPath, type Cluster } from "./helpers/cluster.ts"
import { serviceFixture, serviceOs } from "./helpers/rollout-service.ts"
import { loadRegistry, readSetting } from "../src/registry/load.ts"
let cluster: Cluster
beforeAll(async () => { cluster = await startCluster() })
afterAll(async () => { await cluster?.stop() })

test("ROLL-04 ROLL-05 database stage creates roles schema migrations and writes store exactly once without services", async () => {
  // This cluster has never had a hub schema or runtime role.
  const blank = await startCluster()
  const f = await serviceFixture(blank, true)
  const admin = blank.connect("postgres")
  try {
    expect(await admin`select rolname from pg_roles where rolname in ('hub_door','hub_runner','hub_agent','hub_hub')`).toHaveLength(0)
    expect(await admin`select datname from pg_database where datname = ${f.db}`).toHaveLength(0)
    const hba = readFileSync(`${blank.dataDir}/pg_hba.conf`, "utf8")
    const probe = serviceOs(f.dir, "systemd", Object.values(f.ids))
    const { runInstall } = await seam("src/install/run.ts")
    await (runInstall as Function)({ registryFile: f.registryFile, stage: "database", os: probe.os })
    expect(await admin`select rolname from pg_roles where rolname in ('hub_door','hub_runner','hub_agent','hub_hub')`).toHaveLength(4)
    const sql = blank.connect(f.db)
    expect(await sql`select column_name from information_schema.columns where table_name = 'inbound' and column_name in ('source','log_ready')`).toHaveLength(2)
    expect(await sql`select column_name from information_schema.columns where table_name = 'outbox' and column_name in ('route','delivery_state','attempts','retry_at','failure')`).toHaveLength(5)
    const first = readFileSync(f.registryFile, "utf8")
    expect(first.match(/^\[store\]$/gm)).toHaveLength(1)
    expect(readSetting(loadRegistry(f.registryFile), "store.pid_file")).toBe(`${blank.dataDir}/postmaster.pid`)
    await (runInstall as Function)({ registryFile: f.registryFile, stage: "database", os: probe.os })
    expect(readFileSync(f.registryFile, "utf8")).toBe(first)
    expect(probe.calls).toEqual([])
    expect(readFileSync(`${blank.dataDir}/pg_hba.conf`, "utf8")).toBe(hba)
    for (const role of ["hub_door", "hub_runner", "hub_agent", "hub_hub"]) {
      const runtime = blank.connectAs(role, f.db)
      expect((await runtime`select current_user as role`)[0].role).toBe(role)
    }
  } finally { await f.stop(); await blank.stop() }
})

test("ROLL-05 database stage migrates an existing previous schema and preserves pending work on rerun", async () => {
  const f = await serviceFixture(cluster, true)
  try {
    const sql = cluster.connect("postgres")
    await sql.unsafe(`create database "${f.db}"`)
    await cluster.runSqlFile(f.db, hubPath("test/fixtures/rollout-schema-v5.sql"))
    const db = cluster.connect(f.db)
    await db`insert into inbound (id,person,agent,body) values ('pending','p1','p1-lair','synthetic pending')`
    const { runInstall } = await seam("src/install/run.ts")
    const probe = serviceOs(f.dir, "systemd", Object.values(f.ids))
    for (let n = 0; n < 2; n++) await (runInstall as Function)({ registryFile: f.registryFile, stage: "database", os: probe.os })
    const rows = await db`select id,body,log_ready,source from inbound`
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id: "pending", body: "synthetic pending", log_ready: true, source: null })
    expect(probe.calls).toEqual([])
  } finally { await f.stop() }
})

for (const invalid of ["database-not-ready", "missing-hub", "multiple-hubs", "unsupported-run-kind"]) test(`ROLL-05 services validates ${invalid} before the first unit write`, async () => {
  const f = await serviceFixture(cluster, invalid === "database-not-ready")
  try {
    const probe = serviceOs(f.dir, "launchd", Object.values(f.ids))
    const good = readFileSync(f.registryFile, "utf8")
    const { runInstall } = await seam("src/install/run.ts")
    if (invalid === "missing-hub") writeFileSync(f.registryFile, good.replace(/\[\[run\]\]\nid = "hub-[\s\S]*?(?=\n\[|$)/, ""))
    if (invalid === "multiple-hubs") writeFileSync(f.registryFile, good + `\n[[run]]\nid = "hub-extra-${crypto.randomUUID().slice(0,8)}"\nkind = "hub"\nmachine = "${f.machine}"\nschedule = "always"\nmemory_limit_mb = 256\n`)
    // The stand-in unsupported kind. It has to be one the loader still refuses
    // by that name, and the board is supported now.
    if (invalid === "unsupported-run-kind") writeFileSync(f.registryFile, good.replace('kind = "sync"', 'kind = "watcher"'))
    await expect((runInstall as Function)({ registryFile: f.registryFile, stage: "services", target: f.ids.hub, os: probe.os })).rejects.toThrow()
    expect(probe.files).toEqual([])
    expect(probe.calls).toEqual([])
    writeFileSync(f.registryFile, good)
    if (invalid === "database-not-ready") await (runInstall as Function)({ registryFile: f.registryFile, stage: "database", os: probe.os })
    await (runInstall as Function)({ registryFile: f.registryFile, stage: "services", target: f.ids.hub, os: probe.os })
    expect(probe.files.length).toBeGreaterThan(0)
  } finally { await f.stop() }
})

for (const flavour of ["systemd", "launchd"] as const) test(`ROLL-05 ${flavour} entry rehearsal activates only named sync and its timer`, async () => {
  const f = await serviceFixture(cluster)
  try {
    const probe = serviceOs(f.dir, flavour, Object.values(f.ids))
    const { runInstall } = await seam("src/install/run.ts")
    await (runInstall as Function)({ registryFile: f.registryFile, stage: "entry", target: f.ids.sync, os: probe.os })
    expect(probe.files).toHaveLength(flavour === "systemd" ? 2 : 1)
    expect(probe.files.every(file => file.path.includes(`imprnt-hub-${f.ids.sync}.`))).toBe(true)
    expect(probe.calls.every(call => call.target === f.ids.sync)).toBe(true)
    expect(probe.calls.some(call => call.operation === "install")).toBe(true)
    // Full registry validation also applies to the restricted entry stage.
    const text = readFileSync(f.registryFile, "utf8")
    writeFileSync(f.registryFile, text.replace('kind = "runner"', 'kind = "watcher"'))
    const clean = serviceOs(f.dir, flavour, Object.values(f.ids))
    await expect((runInstall as Function)({ registryFile: f.registryFile, stage: "entry", target: f.ids.sync, os: clean.os })).rejects.toThrow(/unsupported-run-kind/)
    expect(clean.files).toHaveLength(0)
  } finally { await f.stop() }
})
