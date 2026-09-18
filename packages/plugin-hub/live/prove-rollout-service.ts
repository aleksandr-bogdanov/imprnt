import { strict as assert } from "node:assert"
import { existsSync, readFileSync } from "node:fs"
import { startCluster, hubPath } from "../test/helpers/cluster.ts"
import { serviceFixture, serviceOs, renderContext } from "../test/helpers/rollout-service.ts"
import { scheduledArgv } from "../test/helpers/rollout-sync.ts"
export async function proveRolloutService() {
  const cluster = await startCluster()
  const f = await serviceFixture(cluster)
  try {
    assert.equal(f.entries().length, 4)
    assert.equal((await f.read!.sheet("control")).length, 0)
    for (const flavour of ["systemd", "launchd"] as const) {
      const probe = serviceOs(f.dir, flavour, Object.values(f.ids))
      const files = probe.os.render(f.entries()[0], renderContext(f, hubPath("src/entry/hub.ts")))
      assert.equal(scheduledArgv(files, flavour)[4], f.ids.hub)
      await probe.os.install(files)
      assert.equal(readFileSync(files[0].path, "utf8"), files[0].text)
      await probe.os.start(f.ids.hub)
      assert.equal((await probe.os.show(f.ids.hub))?.running, true)
      probe.fail("restart")
      await assert.rejects(probe.os.restart(f.ids.hub), /synthetic-restart-denied/)
      probe.fail(null)
      await probe.os.restart(f.ids.hub)
      await assert.rejects(probe.os.start("foreign"), /foreign/)
      await probe.os.remove(f.ids.hub)
      assert.equal(existsSync(files[0].path), false)
    }
  } finally { await f.stop(); await cluster.stop() }
  assert.equal(existsSync(f.dir), false)
  console.log("rollout-service helper proof passed")
}
if (import.meta.main) await proveRolloutService()
