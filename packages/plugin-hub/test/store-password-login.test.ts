// The other half of check (c): with the hub roles off trust, every
// hub process logs in with its own role's password file, and nothing else can.
//
// The install writes `<role>.password` into the secrets directory
// (test/install-passwords.test.ts). This file stands up a household on a
// cluster that asks the four roles for scram-sha-256 and runs the REAL door and
// the REAL runner as processes of their own, so the proof is a message read,
// answered and posted, through every connection those processes open: the
// store each one opens, the second connection the door opens for its ingress,
// and the notification connections the door and the runner wait on, which
// speak the wire protocol themselves and so need scram of their own. The hub
// role's own path is the metrics command, a process of its own too.
//
// Red reason: every process opened its store with no password, so under
// scram the door refused to start, and the notification connection offered
// only a trusted login.

import { afterAll, beforeAll, expect, test } from "bun:test"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { stageHub } from "./helpers/authorized-registry.ts"
import { hubPath, pgBin, seam, startCluster, startReadySubprocess, until, type Cluster, type ReadyProcess } from "./helpers/cluster.ts"
import { scriptedReply } from "./helpers/scripted-adapter.ts"
import { DOOR, RUNNER } from "./helpers/hub-fixture.ts"
import { requirePasswords } from "./helpers/scram.ts"

const SLOW = 120_000
const MESSAGE = "which role am I logged in as"

let cluster: Cluster
beforeAll(async () => { cluster = await startCluster() })
afterAll(async () => { await cluster?.stop() })

/** The household's store roles get their passwords the way a real one does: from the install. */
async function givePasswords(registryFile: string): Promise<void> {
  const admin = [pgBin("psql"), "-h", "127.0.0.1", "-p", String(cluster.port), "-U", cluster.superuser]
  writeFileSync(registryFile, `${readFileSync(registryFile, "utf8")}\n[install]\nadmin_argv = ${JSON.stringify(admin)}\n`)
  const { runInstall } = await seam("src/install/run.ts")
  const write = process.stdout.write.bind(process.stdout)
  process.stdout.write = (() => true) as typeof process.stdout.write
  try {
    await (runInstall as Function)({ registryFile, stage: "database" })
  } finally {
    process.stdout.write = write
  }
}

test("IMP-158 the real door and runner log in with their own password files and answer a message on a cluster that trusts no hub role", async () => {
  const it = await stageHub(cluster, { servers: true })
  let door: ReadyProcess | null = null
  let runner: ReadyProcess | null = null
  try {
    await givePasswords(it.registryFile)
    await requirePasswords(cluster)

    door = await startReadySubprocess("test/helpers/door-subprocess.ts", [it.registryFile, DOOR, it.platformUrl])
    runner = await startReadySubprocess("test/helpers/runner-subprocess.ts", [it.registryFile, RUNNER, it.adapterUrl, it.adapterName])
    it.fake.deliver({ text: MESSAGE })
    await until("the reply was posted", () => it.fake.posts().length >= 1, 60_000,
      async () => `inbound=${JSON.stringify(await it.read.inbound())} outbox=${JSON.stringify(await it.read.outbox())}`)
    expect(it.fake.posts()[0].text).toBe(scriptedReply(MESSAGE))

    // Each process was its own role, on the password in its own file.
    const seen = await it.read.sql(`select distinct usename from pg_stat_activity where datname = '${it.db}' and usename in ('hub_door', 'hub_runner', 'hub_agent', 'hub_hub')`)
    expect(seen.map((row: Record<string, unknown>) => row.usename).sort()).toEqual(["hub_door", "hub_runner"])

    // The hub role, through the metrics command.
    const metrics = Bun.spawnSync([process.execPath, "run", hubPath("src/entry/metrics.ts"), it.registryFile], { cwd: hubPath("."), stdout: "pipe", stderr: "pipe" })
    expect(metrics.stderr.toString()).toBe("")
    expect(metrics.exitCode).toBe(0)
  } finally {
    await runner?.stop()
    await door?.stop()
    await it.stop()
  }
}, SLOW)

test("IMP-158 the notification connection answers scram with the password and is refused without it", async () => {
  const it = await stageHub(cluster, {})
  try {
    await givePasswords(it.registryFile)
    await requirePasswords(cluster)
    const { listenForWork } = await seam("src/store/listen.ts")
    const { storeUrlAs } = await seam("src/store/connect.ts")
    const password = readFileSync(join(it.stateDir, "secrets", "hub_runner.password"), "utf8").trim()
    const bare = (storeUrlAs as Function)(it.storeUrl, "hub_runner") as string
    const withPassword = new URL(bare)
    withPassword.password = password

    const heard: string[] = []
    const listener = await (listenForWork as Function)({ url: withPassword.toString(), channel: "hub_scram_probe", onNotify: (payload: string) => heard.push(payload) })
    try {
      await it.read.sql("select pg_notify('hub_scram_probe', 'heard it')")
      await until("the notification arrived", () => heard.length > 0, 10_000)
      expect(heard).toEqual(["heard it"])
    } finally { await listener.close() }

    const wrong = new URL(bare)
    wrong.password = "not-the-password"
    for (const url of [bare, wrong.toString()]) {
      await expect((listenForWork as Function)({ url, channel: "hub_scram_probe", onNotify() {} })).rejects.toThrow(/password authentication failed|no password/)
    }
  } finally { await it.stop() }
}, SLOW)
