// Check (c) of IMP-158: the install gives every hub role a password, and only
// the owner of the hub processes can read it.
//
// The box an agent runs in shares the machine's network, so an agent's shell
// reaches the store on loopback. The cutover procedure used to let the four hub
// roles in with `trust`, so an agent steered by outside content it read, a web
// page or an email, could log in to the store with no password. The fix takes
// the roles off trust: the install creates each role
// with a password it generates, writes it to `<role>.password` in the hub's
// secrets directory with mode 0600 in a directory of mode 0700, and each hub
// process reads its own file when it opens its store. The box masks that
// directory (test/box-secrets.test.ts).
//
// The secrets directory here is the default one, `<hub.state_dir>/secrets`,
// because the fixture's registry names no `hub.secrets_dir`.
//
// Measured against a cluster that asks these roles for a password
// (`requirePasswords`), because on the helper's trust cluster a login succeeds
// with or without one and says nothing.
//
// Red reason: the install writes no password file and sets no password, so the
// files are missing and `pg_authid.rolpassword` is null.

import { afterAll, beforeAll, expect, test } from "bun:test"
import { readFileSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { SQL } from "bun"
import { startCluster, seam, hubPath, type Cluster } from "./helpers/cluster.ts"
import { serviceFixture, serviceOs } from "./helpers/rollout-service.ts"
import { logsIn, requirePasswords } from "./helpers/scram.ts"

const ROLES = ["hub_door", "hub_runner", "hub_agent", "hub_hub"]
const SLOW = 120_000

let cluster: Cluster
beforeAll(async () => { cluster = await startCluster() })
afterAll(async () => { await cluster?.stop() })

/** What the install printed, and whatever it returned. */
async function install(registryFile: string, os: unknown): Promise<string> {
  const { runInstall } = await seam("src/install/run.ts")
  const said: string[] = []
  const write = process.stdout.write.bind(process.stdout)
  process.stdout.write = ((chunk: unknown) => { said.push(String(chunk)); return true }) as typeof process.stdout.write
  try {
    await (runInstall as Function)({ registryFile, stage: "database", os })
  } finally {
    process.stdout.write = write
  }
  return said.join("")
}

async function stored(admin: SQL): Promise<Record<string, string | null>> {
  const rows = await admin`select rolname, rolpassword from pg_authid where rolname in ${admin(ROLES)}`
  return Object.fromEntries(rows.map((row: { rolname: string; rolpassword: string | null }) => [row.rolname, row.rolpassword]))
}

const mode = (path: string) => statSync(path).mode & 0o777

test("IMP-158 (c) install writes each hub role's password to a 0600 file, the role requires it, and a second run changes nothing", async () => {
  const f = await serviceFixture(cluster, true)
  const admin = cluster.connect("postgres")
  try {
    const probe = serviceOs(f.dir, "systemd", Object.values(f.ids))
    const said = await install(f.registryFile, probe.os)
    const secrets = join(f.stateDir, "secrets")
    expect(mode(secrets), "the secrets directory is the owner's alone").toBe(0o700)
    const passwords: Record<string, string> = {}
    for (const role of ROLES) {
      const file = join(secrets, `${role}.password`)
      expect(mode(file), `${file} is readable by its owner only`).toBe(0o600)
      passwords[role] = readFileSync(file, "utf8").trim()
      expect(passwords[role].length, `${role} has a password worth the name`).toBeGreaterThanOrEqual(32)
    }
    expect(new Set(Object.values(passwords)).size, "every role has its own password").toBe(4)
    const first = await stored(admin)
    for (const role of ROLES) expect(first[role], `${role} carries a scram verifier`).toMatch(/^SCRAM-SHA-256\$/)

    // The password is in the file and nowhere a person or a log reads it.
    for (const role of ROLES) expect(said).not.toContain(passwords[role])
    expect(said).toContain("hub_door")

    await requirePasswords(cluster)
    for (const role of ROLES) {
      expect(await logsIn(cluster, f.db, role, null), `${role} with no password`).toBe(false)
      expect(await logsIn(cluster, f.db, role, "not-the-password"), `${role} with a wrong password`).toBe(false)
      expect(await logsIn(cluster, f.db, role, passwords[role]), `${role} with its own file`).toBe(true)
    }

    // Idempotent: the same passwords, the same verifiers, no line saying it set one.
    const again = await install(f.registryFile, probe.os)
    for (const role of ROLES) expect(readFileSync(join(secrets, `${role}.password`), "utf8").trim()).toBe(passwords[role])
    expect(await stored(admin)).toEqual(first)
    expect(again).not.toContain("password")

    // A file that no longer matches its role is replaced, and the role follows it.
    writeFileSync(join(secrets, "hub_runner.password"), "a-file-somebody-edited\n", { mode: 0o600 })
    await install(f.registryFile, probe.os)
    const replaced = readFileSync(join(secrets, "hub_runner.password"), "utf8").trim()
    expect(replaced).not.toBe("a-file-somebody-edited")
    expect(mode(join(secrets, "hub_runner.password"))).toBe(0o600)
    expect(await logsIn(cluster, f.db, "hub_runner", replaced)).toBe(true)
    expect(await logsIn(cluster, f.db, "hub_runner", passwords.hub_runner)).toBe(false)
    expect(probe.calls).toEqual([])
  } finally { await f.stop() }
}, SLOW)

test("IMP-158 (c) an upgrade over roles an earlier install left without a password sets one on each and says so", async () => {
  // Roles are cluster-wide, so this one starts from a cluster of its own where
  // the roles exist exactly as the earlier schema made them: `login`, no password.
  const earlier = await startCluster()
  const f = await serviceFixture(earlier, true)
  const admin = earlier.connect("postgres")
  try {
    await admin.unsafe(`create database "${f.db}"`)
    await earlier.runSqlFile(f.db, hubPath("test/fixtures/rollout-schema-v5.sql"))
    for (const [role, password] of Object.entries(await stored(admin))) expect(password, `${role} before the upgrade`).toBeNull()
    await requirePasswords(earlier)
    const probe = serviceOs(f.dir, "systemd", Object.values(f.ids))
    const said = await install(f.registryFile, probe.os)
    for (const role of ROLES) {
      const password = readFileSync(join(f.stateDir, "secrets", `${role}.password`), "utf8").trim()
      expect(await logsIn(earlier, f.db, role, password), `${role} after the upgrade`).toBe(true)
      expect(await logsIn(earlier, f.db, role, null)).toBe(false)
    }
    expect(said).toMatch(/hub_door, hub_runner, hub_agent, hub_hub had no password/)
    // This cluster trusts nobody but its superuser, so there is no rule to warn about.
    expect(said).not.toContain("pg_hba.conf")
  } finally { await f.stop(); await earlier.stop() }
}, SLOW)

test("IMP-158 (c) install names the pg_hba.conf lines that still let a hub role in without a password", async () => {
  // A fresh trust cluster: every line of its pg_hba.conf is trust, which is
  // what the old cutover line did for the four roles.
  const open = await startCluster()
  const f = await serviceFixture(open, true)
  try {
    const hba = readFileSync(join(open.dataDir, "pg_hba.conf"), "utf8").split("\n")
    const trusted = hba.flatMap((line, at) => /^\s*(local|host)\s+all\s+all\s.*\btrust\s*$/.test(line) ? [at + 1] : [])
    expect(trusted.length).toBeGreaterThan(0)
    const said = await install(f.registryFile, serviceOs(f.dir, "systemd", Object.values(f.ids)).os)
    expect(said).toContain("pg_hba.conf")
    for (const line of trusted) expect(said).toMatch(new RegExp(`\\b${line}\\b`))
  } finally { await f.stop(); await open.stop() }
}, SLOW)
