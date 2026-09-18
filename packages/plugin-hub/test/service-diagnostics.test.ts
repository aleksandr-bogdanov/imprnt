import { afterAll, beforeAll, expect, spyOn, test } from "bun:test"
import { existsSync, readFileSync, writeFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { startCluster, seam, type Cluster } from "./helpers/cluster.ts"
import { serviceFixture, serviceOs, renderContext } from "./helpers/rollout-service.ts"
import { rolloutStage } from "./helpers/rollout-stage.ts"
import { deliveryEdge } from "./helpers/rollout-delivery.ts"
import { superStore, insertInbound } from "./helpers/hub-fixture.ts"
import { observe } from "./helpers/rollout-runner.ts"
import { runDoor } from "../src/door/run.ts"
import { runRunner } from "../src/runner/run.ts"
import { runHub } from "../src/hub/run.ts"
import { parsePlistDict } from "./helpers/plist.ts"
import { launchd } from "../src/os/launchd.ts"
import { systemd } from "../src/os/systemd.ts"
import { unitFixture } from "./helpers/units.ts"
let cluster: Cluster
const native=unitFixture()
beforeAll(async()=>{cluster=await startCluster()})
afterAll(async()=>{try{await native.removeAll()}finally{await cluster?.stop()}})

for(const platform of ["telegram","discord"] as const) for(const operation of ["read","post"] as const) test(`ROLL-29 ${platform} ${operation} real door records safe cause and target in state diary and service stderr`,async()=>{
  const it=await rolloutStage(cluster,platform)
  const edge=deliveryEdge(platform)
  const secret=`synthetic-secret-${crypto.randomUUID()}`
  const cause=`synthetic-${operation}-denied`
  const error=Object.assign(new Error(`${cause} Authorization: Bearer ${secret} https://example.invalid/media?signature=${secret}`),{status:403})
  let stderr=""
  const capture=spyOn(process.stderr,"write").mockImplementation((chunk:any)=>{stderr+=String(chunk);return true})
  let door:Awaited<ReturnType<typeof runDoor>>|undefined
  let runner:Awaited<ReturnType<typeof runRunner>>|undefined
  try{
    if(operation==="read") {
      await expect(edge.platform.pull({chat:"1000000001",cursor:null,timeoutMs:1})).resolves.toBeDefined()
    } else {
      await edge.platform.post({chat:"1000000001",text:"synthetic transport control"})
      expect(edge.posts().length).toBe(1)
    }
    if(operation==="read")edge.readFault("1000000001",error)
    else edge.postFault("1000000001",error)
    door=await runDoor({registryFile:it.registryFile,door:"door-fake",platform:edge.platform})
    if(operation==="post"){
      runner=await runRunner({registryFile:it.registryFile,runner:"runner-pi",adapters:{[it.adapterName]:it.scripted.adapter}})
      await insertInbound(cluster,it.db,{id:"diagnostic-post",body:"synthetic reply"})
    }
    const predicate=(text:string)=>{expect(text,"F29 safe diagnostic cause and route").toContain(cause);expect(text).toContain("door-fake");expect(text).toContain("1000000001");expect(text).not.toContain(secret);expect(text).not.toContain("https://example.invalid/media")}
    expect(()=>predicate("")).toThrow()
    await observe(()=>stderr.includes(cause))
    expect(operation==="read" ? edge.reads.some(r=>r.chat==="1000000001") : edge.sends.some(r=>r.chat==="1000000001"&&r.text!=="synthetic transport control"), "failed operation was actually attempted").toBe(true)
    predicate(stderr)
    const state=operation==="read"?await it.read.sheet("door_health"):await it.read.sql("select failure,route from outbox where failure is not null")
    predicate(JSON.stringify(state))
    predicate(JSON.stringify(await it.read.ledger()))
    edge.readFault("1000000001",null)
    edge.postFault("1000000001",null)
  }finally{edge.release();await runner?.stop();await door?.stop();capture.mockRestore();await it.stop()}
})
for(const operation of ["install","start","restart"] as const) test(`ROLL-29 OS ${operation} failure reaches diary and stderr and suppress-only control is rejected`,async()=>{
  const f=await serviceFixture(cluster)
  const store=await superStore(cluster,f.db)
  const probe=serviceOs(f.dir,"launchd",Object.values(f.ids))
  let stderr=""
  let hub:Awaited<ReturnType<typeof runHub>>|undefined
  const capture=spyOn(process.stderr,"write").mockImplementation((chunk:any)=>{stderr+=String(chunk);return true})
  try{
    const cause=`synthetic-${operation}-denied`
    const accept=(text:string)=>{expect(text,"F29 OS failure retains its cause").toContain(cause);expect(text).toContain(f.ids.door);expect(text).toContain(operation)}
    // Same input and destination, with only recording and stderr suppressed.
    const discarded=async(_store:unknown,_failure:unknown)=>{}
    probe.fail(operation)
    let captured:unknown
    try {
      if(operation==="install") await probe.os.install(probe.os.render(f.entries().find(e=>e.id===f.ids.door)!,renderContext(f,join(f.dir,"synthetic.ts"))))
      else await probe.os[operation](f.ids.door)
    } catch(error) { captured=error }
    expect(String(captured)).toContain(cause)
    const failure={operation,target:f.ids.door,error:captured}
    await discarded(store,failure)
    expect(()=>accept(stderr)).toThrow()
    expect(await f.read!.ledger()).toHaveLength(0)
    const {recordOperationFailure}=await seam("src/diagnostics.ts")
    await (recordOperationFailure as Function)(store,failure)
    accept(stderr)
    accept(JSON.stringify(await f.read!.ledger()))
    stderr=""
    // Require actual coordinator wiring as well as the shared writer.
    probe.fail(operation)
    if(operation==="restart"){
      const {requestRecovery}=await seam("src/hub/control.ts")
      hub=await runHub({registryFile:f.registryFile,machine:f.machine,os:probe.os})
      await (requestRecovery as Function)(store,{id:crypto.randomUUID(),source:"cli",actor:"operator",target_kind:"door",target_id:f.ids.door,registryFile:f.registryFile})
    }else{
      try{hub=await runHub({registryFile:f.registryFile,machine:f.machine,os:probe.os})}catch{}
    }
    await observe(()=>stderr.includes(cause))
    expect(stderr,"coordinator must record its own failed OS operation").toContain(cause)
    const events=await f.read!.ledger()
    expect(events.filter(r=>JSON.stringify(r.detail).includes(cause)).length).toBeGreaterThan(1)
    probe.fail(null)
    // Identical operation without the failure is allowed.
    if(operation==="install")await probe.os.install(probe.os.render(f.entries().find(e=>e.id===f.ids.door)!,renderContext(f,join(f.dir,"synthetic.ts"))))
    else await probe.os[operation](f.ids.door)
  }finally{await hub?.stop();capture.mockRestore();await store.close();await f.stop()}
})
test("ROLL-29 macOS renderer declares private stdout and stderr paths before manager load",async()=>{
  const f=await serviceFixture(cluster)
  try{
    const probe=serviceOs(f.dir,"launchd",Object.values(f.ids))
    const entry=f.entries()[0]
    const files=probe.os.render(entry,renderContext(f,join(f.dir,"synthetic.ts")))
    const paths=(plist:Record<string,unknown>)=>{expect(plist.StandardOutPath,"D-179 missing macOS stdout destination").toBe(join(f.stateDir,"service-log",`${entry.id}.out.log`));expect(plist.StandardErrorPath,"D-179 missing macOS stderr destination").toBe(join(f.stateDir,"service-log",`${entry.id}.err.log`))}
    const wanted={StandardOutPath:join(f.stateDir,"service-log",`${entry.id}.out.log`),StandardErrorPath:join(f.stateDir,"service-log",`${entry.id}.err.log`)}
    paths(wanted)
    expect(()=>paths({...wanted,StandardErrorPath:undefined})).toThrow()
    paths(parsePlistDict(files[0].text))
    // Use the existing recording manager rather than the inert file writer.
    const {syncFixture,scheduleProbe}=await import("./helpers/rollout-sync.ts")
    const s=await syncFixture(cluster)
    try{
      const p=scheduleProbe(s,"launchd")
      const rendered=p.os.render({...entry,id:s.id}, {...renderContext(f,join(f.dir,"synthetic.ts")),stateDir:s.stateDir} as any)
      await p.os.install(rendered)
      const directory=join(s.stateDir,"service-log")
      expect(statSync(directory).mode&0o777).toBe(0o700)
      expect(p.calls().some(args=>args[0]==="bootstrap")).toBe(true)
    }finally{await s.stop()}
  }finally{await f.stop()}
})
for(const host of ["linux","darwin"] as const){
  if(process.platform!==host)console.log(`SKIP: requires ${host==="linux"?"Linux":"macOS"}: ROLL-29 native inherited stderr`)
  test.skipIf(process.platform!==host)(`ROLL-29 native ${host} locates inherited child stderr only at the contract destination`,async()=>{
    const f=await serviceFixture(cluster)
    try{
      const id=native.entryId("diagnostic")
      const marker=`synthetic-child-${crypto.randomUUID()}`
      const script=join(f.dir,"child-stderr.ts")
      writeFileSync(script,`const c=Bun.spawn([process.execPath,'-e',${JSON.stringify(`process.stderr.write(${JSON.stringify(marker+"\n")})`)}],{stdout:'inherit',stderr:'inherit'});await c.exited;`)
      // Standalone proof of the child program before any service uses it.
      const proof=Bun.spawn([process.execPath,script],{stdout:"pipe",stderr:"pipe"})
      expect(await new Response(proof.stderr).text()).toContain(marker)
      expect(await proof.exited).toBe(0)
      const os=host==="darwin"?launchd({unitDir:native.unitDir()}):systemd({unitDir:native.unitDir()})
      const entry={...f.entries()[0],id,schedule:"manual"}
      const files=os.render(entry,renderContext(f,script))
      if(host==="darwin"){
        const path=join(f.stateDir,"service-log",`${id}.err.log`)
        expect(parsePlistDict(files[0].text).StandardErrorPath,"D-179 inherited child has no declared stderr destination").toBe(path)
        // Remove only StandardErrorPath from the actual service definition.
        const broken=files.map(file=>({...file,text:file.text.replace(/\s*<key>StandardErrorPath<\/key>\s*<string>[^<]*<\/string>/,"")}))
        await os.install(broken);await os.start(id)
        expect(await observe(async()=>Boolean((await os.show(id))?.ran))).toBe(true)
        expect(existsSync(path)?readFileSync(path,"utf8"):"").not.toContain(marker)
        await os.remove(id)
        await os.install(files);await os.start(id)
        expect(await observe(()=>existsSync(path)&&readFileSync(path,"utf8").includes(marker))).toBe(true)
        expect(statSync(join(f.stateDir,"service-log")).mode&0o777).toBe(0o700)
      }else{
        // The journal query selects only this check's random owned unit.
        await os.install(files);await os.start(id)
        const read=()=>Bun.spawnSync(["journalctl","--user","--unit",`imprnt-hub-${id}.service`,"--no-pager","--output=cat"]).stdout.toString()
        expect(await observe(()=>read().includes(marker))).toBe(true)
        expect(read()).toContain(marker)
      }
    }finally{try{await native.removeAll();expect(native.mine()).toEqual([]);console.log("L15 native diagnostic cleanup completed")}finally{await f.stop()}}
  })
}
