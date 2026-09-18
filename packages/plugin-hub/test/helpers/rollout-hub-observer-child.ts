// Real coordinator with an inert service-manager seam. No native unit calls.
import { appendFileSync } from "node:fs"
import { runHub } from "../../src/hub/run.ts"
import { loadRegistry } from "../../src/registry/load.ts"
import { runEntriesFor } from "../../src/registry/entries.ts"
import { unitName } from "../../src/os/names.ts"
import type { OsSeam } from "../../src/os/types.ts"
const [registryFile, machine, trace] = process.argv.slice(2)
const actions = (verb: string, id: string) => { appendFileSync(trace, JSON.stringify({ verb, id }) + "\n") }
const view = (id: string) => ({ name: unitName(id), loaded: true, running: true, pid: null,
  runs: 1, ran: true, restarts: 0, lastExit: null, since: null, state: "running", result: null })
const os: OsSeam = {
  flavour: process.platform === "darwin" ? "launchd" : "systemd",
  render: () => [], install: async () => [],
  list: async () => runEntriesFor(loadRegistry(registryFile), machine).map(row => view(row.id)),
  show: async id => view(id),
  start: async id => actions("start", id), stop: async id => actions("stop", id),
  restart: async id => actions("restart", id), remove: async id => actions("remove", id),
  memory: async () => ({ current_bytes: 0, peak_bytes: 0, source: "ps-rss" }),
  available: async () => ({ ok: true, reason: "synthetic seam" }),
}
try {
  if (process.argv[5] === "proof") {
    await os.start("synthetic-owned"); await os.restart("synthetic-owned"); await os.stop("synthetic-owned"); await os.remove("synthetic-owned")
    console.log(JSON.stringify({ ready: true, pid: process.pid }))
  } else {
    const hub = await runHub({ registryFile, machine, os })
    console.log(JSON.stringify({ ready: true, pid: process.pid }))
    process.on("SIGTERM", async () => { await hub.stop(); process.exit(0) })
  }
  await new Promise(() => {})
} catch (error) { console.log(JSON.stringify({ ready: false, error: String(error) })); process.exit(1) }
