import { strict as assert } from "node:assert"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { loopFixture } from "../test/helpers/rollout-loop.ts"
import { harvestPreload, discordPreload } from "../test/helpers/rollout-preload.ts"
export function provePreload() {
  const f = loopFixture()
  try {
    const module = join(f.dir, "harvest.ts")
    const capture = join(f.dir, "capture.json")
    writeFileSync(module, "export function catchUpHarvest(){throw new Error('unreplaced')}\n")
    for (const refuse of [false, true]) {
      const preload = harvestPreload(f.dir, module, capture, refuse)
      const child = Bun.spawnSync([process.execPath, "--preload", preload, "-e", `const {catchUpHarvest}=await import(${JSON.stringify(module)});try{await catchUpHarvest({data:{hub:{store_url:'synthetic-store'}}},'p2','from','until')}catch{process.exit(1)}`], { stdout: "pipe", stderr: "pipe" })
      assert.equal(child.exitCode, refuse ? 1 : 0)
      assert.deepEqual(JSON.parse(readFileSync(capture,"utf8")), {person:"p2",from:"from",until:"until",store:"synthetic-store"})
    }
    writeFileSync(capture, "")
    const preload = discordPreload(f.dir,capture,[{id:"0000000000",name:"synthetic-channel"}])
    const child = Bun.spawnSync([process.execPath,"--preload",preload,"-e",`const r=await fetch('https://discord.com/api/v10/guilds/synthetic-guild/channels',{headers:{authorization:'Bot synthetic-token'}});console.log(JSON.stringify(await r.json()))`], { stdout:"pipe",stderr:"pipe" })
    assert.equal(child.exitCode,0)
    assert.equal(JSON.parse(child.stdout.toString())[0].id,"0000000000")
    assert.equal(JSON.parse(readFileSync(capture,"utf8")).authorization,"Bot synthetic-token")
    const bad=Bun.spawnSync([process.execPath,"--preload",preload,"-e","await fetch('https://example.invalid')"],{stdout:"pipe",stderr:"pipe"})
    assert.notEqual(bad.exitCode,0)
    console.log("HELPER PASS round-3 child preloads capture exact bounds, await refusal, record authenticated lookup and block unexpected network")
  } finally { f.stop() }
}
if(import.meta.main) provePreload()
