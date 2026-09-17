import { strict as assert } from "node:assert"
import { existsSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { rolloutFixture } from "../test/helpers/rollout-fixtures.ts"
import { commandHarness } from "../test/helpers/rollout-command.ts"
export async function proveRolloutCommand() {
  const f = rolloutFixture()
  const h = await commandHarness(f.dir)
  try {
    h.replacePlugin(`console.log(JSON.stringify({argv:process.argv.slice(2),node:!!process.versions.node,bun:!!process.versions.bun}));process.exit(7)`)
    const result = await h.run(["synthetic", "argument with spaces"])
    assert.equal(result.code, 7)
    assert.deepEqual(JSON.parse(result.out), { argv: ["synthetic", "argument with spaces"], node: true, bun: false })
    // Prove the preload both calls the original and records a distinguishable result.
    const module = join(h.cwd, "proof.ts")
    writeFileSync(module, "export async function proof(x){return {value:x.value+1}}")
    h.spy(module, "proof")
    h.restorePlugin()
    h.replacePlugin(`import {spawnSync} from 'node:child_process'; const r=spawnSync('bun',['-e',${JSON.stringify(`const {proof}=await import(${JSON.stringify(module)});console.log(JSON.stringify(await proof({value:4})))`)}],{stdio:'inherit'});process.exit(r.status??1)`)
    const observed = await h.run([])
    assert.equal(observed.code, 0, observed.err)
    assert.equal(JSON.parse(observed.out).value, 5)
    assert.equal(observed.calls.filter(c => c.phase === "call").length, 1)
    h.restorePlugin()
    h.clearSpy()
  } finally { h.stop(); f.stop() }
  assert.equal(existsSync(f.dir), false)
  console.log("rollout-command helper proof passed")
}
if (import.meta.main) await proveRolloutCommand()
