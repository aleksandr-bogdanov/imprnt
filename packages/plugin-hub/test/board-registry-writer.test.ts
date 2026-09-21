// The board's start, stop and pause edit the live registry, through the one
// registry writer, from the program the service manager starts.
//
// The owner ruled the board may edit the registry because it is reachable only
// on the tailnet. Every defence it already had stays: the Host header must
// name the listener, a request another page sent is refused, an act from the
// board's own machine is refused, and `enabled = false` is refused on the hub
// and the board. So the program is driven twice. Once with a preload that makes
// it take every request as coming from another machine, which is the only way
// a check on this machine can see an act accepted, and there a stop and a
// pause change exactly one line each and the hub stops the unit. Once as
// shipped, where the same press from this machine, or from another page, leaves
// the file byte for byte as it was.
import { afterAll, beforeAll, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { hubPath, startCluster, until, type Cluster } from "./helpers/cluster.ts"
import { stageHub, type StagedHub } from "./helpers/hub-fixture.ts"
import { freePort, plantedSeam } from "./helpers/board.ts"
import { lineDiff } from "./helpers/registry-fixture.ts"
import type { RunSpec } from "./helpers/registry.ts"
import type { OsSeam } from "../src/os/types.ts"
import { runHub } from "../src/hub/run.ts"
import { actRefused, editApplied } from "../src/door/lines.ts"

const HERE = process.platform === "darwin" ? "mac" : "pi"
const HERE_OS = process.platform === "darwin" ? "macos" : "linux"
const FLAVOUR = process.platform === "darwin" ? "launchd" : "systemd"
const SLOW = 120_000

let cluster: Cluster
const scratch: string[] = []
beforeAll(async () => { cluster = await startCluster() })
afterAll(async () => {
  try { for (const dir of scratch) rmSync(dir, { recursive: true, force: true }) } finally { await cluster?.stop() }
})

const DOOR_ENTRY: RunSpec = { id: "door-fake", kind: "door", machine: HERE, platform: "fake", person: "p1",
  token_file: "/dev/null", schedule: "always", memory_limit_mb: 192 }
const RUNNER_ENTRY: RunSpec = { id: "runner-test", kind: "runner", machine: HERE, schedule: "always",
  memory_limit_mb: 512, child_memory_limit_mb: 2048 }
const HUB_ENTRY: RunSpec = { id: "hub-one", kind: "hub", machine: HERE, schedule: "always", memory_limit_mb: 128 }

async function stage(): Promise<{ it: StagedHub; board: RunSpec }> {
  const tree = mkdtempSync(join(tmpdir(), "board-writer-tree-"))
  scratch.push(tree)
  const board: RunSpec = { id: "board", kind: "board", machine: HERE, schedule: "always", memory_limit_mb: 128,
    bind: "127.0.0.1", port: await freePort() }
  const it = await stageHub(cluster, {
    hub: { tick_seconds: 1 },
    machines: [{ id: HERE, os: HERE_OS }],
    people: [{ id: "p1", tree }],
    run: [DOOR_ENTRY, RUNNER_ENTRY, HUB_ENTRY, board],
  })
  return { it, board }
}

/** The board's own program, as the service manager starts it, with an optional preload. */
async function program(it: StagedHub, board: RunSpec, preload?: string) {
  const proc = Bun.spawn([process.execPath, ...(preload ? [`--preload=${preload}`] : []), "run",
    hubPath("src/entry/board.ts"), it.registryFile, board.id],
  { cwd: hubPath("."), stdout: "ignore", stderr: "pipe", stdin: "ignore" })
  const said = new Response(proc.stderr).text()
  const url = `http://${board.bind}:${board.port}`
  await until("the board answered its first page", async () => {
    if (proc.exitCode !== null) throw new Error(`the board exited ${proc.exitCode}: ${(await said).slice(0, 400)}`)
    try { return (await fetch(`${url}/`, { redirect: "manual" })).status === 200 } catch { return false }
  }, 30_000)
  return {
    async press(path: string, form: Record<string, string>, headers: Record<string, string> = {}) {
      const answer = await fetch(`${url}${path}`, { method: "POST", redirect: "manual",
        headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
        body: new URLSearchParams(form).toString() })
      const location = answer.headers.get("location")
      const landed = answer.status === 303 && location ? await (await fetch(`${url}${location}`, { redirect: "manual" })).text() : await answer.text()
      return { status: answer.status, landed }
    },
    async stop() { try { proc.kill(15) } catch { /* already gone */ } await proc.exited.catch(() => {}) },
  }
}

/** A manager that records what the hub asks of it and acts on it. */
function actingSeam() {
  const planted = plantedSeam(FLAVOUR)
  const calls: { verb: string; id: string }[] = []
  const os: OsSeam = {
    ...planted.os,
    async install() { return [] },
    async start(id) { calls.push({ verb: "start", id }); planted.plant(id, true) },
    async stop(id) { calls.push({ verb: "stop", id }); planted.plant(id, false) },
    async restart(id) { calls.push({ verb: "restart", id }); planted.plant(id, true) },
    async remove(id) { calls.push({ verb: "remove", id }); planted.forget(id) },
  }
  return { os, calls }
}

/** What an edit may leave beside the registry, which a refused path must not. */
function leftovers(file: string): string[] {
  const name = file.split("/").pop()!
  return readdirSync(dirname(file)).filter(one => one.startsWith(`.${name}.`))
}

test("from another machine, a stop and a pause through the board change exactly one line each, and the hub stops the unit", async () => {
  const { it, board } = await stage()
  const acting = actingSeam()
  let hub: Awaited<ReturnType<typeof runHub>> | undefined
  let served: Awaited<ReturnType<typeof program>> | undefined
  try {
    hub = await runHub({ registryFile: it.registryFile, machine: HERE, os: acting.os })
    served = await program(it, board, hubPath("test/helpers/board-peer-elsewhere.ts"))
    const before = readFileSync(it.registryFile, "utf8")

    const stopped = await served.press("/act/enabled", { target: RUNNER_ENTRY.id, value: "false" })
    expect(stopped.landed).toContain(editApplied("en", { field: "enabled", value: "false", target: RUNNER_ENTRY.id }))
    const afterStop = readFileSync(it.registryFile, "utf8")
    expect(lineDiff(before, afterStop)).toEqual({ removed: [], added: ["enabled = false"] })
    await until("the hub stops the unit the file now says is stopped", async () =>
      acting.calls.some(call => call.verb === "stop" && call.id === RUNNER_ENTRY.id), 10_000)

    const paused = await served.press("/act/sleeping", { target: "p1-lair", value: "true" })
    expect(paused.landed).toContain(editApplied("en", { field: "sleeping", value: "true", target: "p1-lair" }))
    const afterPause = readFileSync(it.registryFile, "utf8")
    expect(lineDiff(afterStop, afterPause)).toEqual({ removed: [], added: ["sleeping = true"] })

    // The hub and the board are never stopped from the page, whatever a hand
    // written form says, and the file is not touched to find that out.
    const hubStop = await served.press("/act/enabled", { target: HUB_ENTRY.id, value: "false" })
    expect(hubStop.landed).toContain(actRefused("en", { target: HUB_ENTRY.id, cause: "enabled-not-for-this-kind" }))
    // An id that is all digits names no entry here, and is never read as the
    // entry at that position.
    const byPosition = await served.press("/act/enabled", { target: "0", value: "false" })
    expect(byPosition.landed).toContain("restart refused for 0")
    expect(readFileSync(it.registryFile, "utf8")).toBe(afterPause)
    expect(leftovers(it.registryFile)).toEqual([])
  } finally { await served?.stop(); await hub?.stop(); await it.stop() }
}, SLOW)

test("from this machine, or sent by another page, the same presses leave the registry byte for byte as it was", async () => {
  const { it, board } = await stage()
  let shipped: Awaited<ReturnType<typeof program>> | undefined
  let elsewhere: Awaited<ReturnType<typeof program>> | undefined
  try {
    const before = readFileSync(it.registryFile, "utf8")
    // As shipped: every request a check can make comes from this machine.
    shipped = await program(it, board)
    for (const [path, form] of [["/act/enabled", { target: RUNNER_ENTRY.id, value: "false" }],
      ["/act/sleeping", { target: "p1-lair", value: "true" }]] as const) {
      expect((await shipped.press(path, form)).status, `${path} from this machine`).toBe(404)
      expect((await shipped.press(path, form, { "sec-fetch-site": "cross-site" })).status, `${path} from another page`).toBe(404)
    }
    await shipped.stop()
    shipped = undefined
    // And from another machine, a press another page sent is refused all the same.
    elsewhere = await program(it, board, hubPath("test/helpers/board-peer-elsewhere.ts"))
    const another: Record<string, string>[] = [{ "sec-fetch-site": "cross-site" }, { origin: "http://another-page.example" }]
    for (const headers of another) {
      expect((await elsewhere.press("/act/enabled", { target: RUNNER_ENTRY.id, value: "false" }, headers)).status).toBe(404)
      expect((await elsewhere.press("/act/sleeping", { target: "p1-lair", value: "true" }, headers)).status).toBe(404)
    }
    expect(readFileSync(it.registryFile, "utf8")).toBe(before)
    expect(leftovers(it.registryFile)).toEqual([])
  } finally { await shipped?.stop(); await elsewhere?.stop(); await it.stop() }
}, SLOW)
