import { strict as assert } from "node:assert"
import { readFileSync, writeFileSync, renameSync } from "node:fs"
import { join } from "node:path"
import { startCluster, startReadySubprocess, type ReadyProcess } from "../test/helpers/cluster.ts"
import { serviceFixture } from "../test/helpers/rollout-service.ts"
import { observe } from "../test/helpers/rollout-runner.ts"
export async function proveRolloutTokenDoor() {
  const cluster = await startCluster()
  const f = await serviceFixture(cluster)
  const calls: string[] = []
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) { calls.push(((await req.json()) as {url:string}).url); return Response.json({ ok: true, result: [] }) } })
  let child: ReadyProcess | undefined
  try {
    const token = join(f.dir, "token")
    writeFileSync(token, "synthetic-first", { mode: 0o600 })
    writeFileSync(f.registryFile, readFileSync(f.registryFile, "utf8").replace('token_file = "/dev/null"', `token_file = ${JSON.stringify(token)}`) + `\n[[agents]]\nid = "p1-lair"\nperson = "p1"\npreset = "daily"\ndoor = "${f.ids.door}"\nrunner = "${f.ids.runner}"\nchat = "1000000001"\n`)
    const argv = [f.registryFile, f.ids.door, `http://127.0.0.1:${server.port}`]
    child = await startReadySubprocess("test/helpers/rollout-token-door-child.ts", argv)
    assert(await observe(() => calls.some(url => url.includes("synthetic-first"))))
    await child.stop()
    writeFileSync(token + ".new", "synthetic-second", { mode: 0o600 })
    renameSync(token + ".new", token)
    child = await startReadySubprocess("test/helpers/rollout-token-door-child.ts", argv)
    assert(await observe(() => calls.some(url => url.includes("synthetic-second"))))
  } finally { await child?.stop(); await server.stop(true); await f.stop(); await cluster.stop() }
  console.log("rollout-token-door helper proof passed")
}
if (import.meta.main) await proveRolloutTokenDoor()
