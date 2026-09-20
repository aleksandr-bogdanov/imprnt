import { afterAll, beforeAll, expect, test } from "bun:test"
import { readFileSync, writeFileSync, renameSync } from "node:fs"
import { join } from "node:path"
import { startCluster, seam, startReadySubprocess, type Cluster, type ReadyProcess } from "./helpers/cluster.ts"
import { rolloutStage } from "./helpers/rollout-stage.ts"
import { serviceFixture, serviceOs } from "./helpers/rollout-service.ts"
import { superStore, insertInbound } from "./helpers/hub-fixture.ts"
import { servePlatform } from "./helpers/fake-platform.ts"
import { message } from "./helpers/rollout-ingress.ts"
import { observe } from "./helpers/rollout-runner.ts"
import { commandHarness } from "./helpers/rollout-command.ts"
import { runHub } from "../src/hub/run.ts"
import { createScriptedAdapter, serveAdapter, childGone } from "./helpers/scripted-adapter.ts"
let cluster: Cluster
beforeAll(async () => { cluster = await startCluster() })
afterAll(async () => { await cluster?.stop() })
for (const source of ["chat", "cli", "pending-before-start", "replay-after-restart"] as const) test(`ROLL-22 ${source} replaces only requested agent generation with one durable request and application`, async () => {
  const it = await rolloutStage(cluster, "telegram", { servers: true,
    machines: [{ id: "mac", os: process.platform === "darwin" ? "macos" : "linux" }],
    registry: base => ({ ...base, agents: base.agents!.map(a => ({ ...a, person: "p1" })) }),
  })
  const store = await superStore(cluster, it.db)
  const platform = await servePlatform({ ...it.fake, platform: it.edge.platform })
  const command = await commandHarness(it.stateDir)
  const children: ReadyProcess[] = []
  let hub: Awaited<ReturnType<typeof runHub>> | undefined
  const os = serviceOs(it.stateDir, "launchd", ["door-fake", "runner-pi"])
  os.os.render = () => [] // Inert control harness creates no unsuffixed service files.
  try {
    const { requestRecovery } = await seam("src/hub/control.ts")
    const request = { id: `recover-${crypto.randomUUID()}`, actor: "operator", person: "p1", source: "cli", target_kind: "agent", target_id: "p2-lair" }
    let runner = await startReadySubprocess("test/helpers/runner-subprocess.ts", [it.registryFile,"runner-pi",it.adapterUrl,it.adapterName,"child"])
    children.push(runner)
    for (const agent of ["p1-lair","p2-lair"]) await insertInbound(cluster,it.db,{ id:`seed-${agent}`,person:"p1",agent,body:"synthetic seed" })
    expect(await observe(async () => (await it.read.outbox()).length === 2)).toBe(true)
    const pidFor = (id: string) => it.adapterServer!.childFor(id)!
    const before = { asker: pidFor("seed-p1-lair"), target: pidFor("seed-p2-lair"), runner: runner.pid }
    expect(before.asker).toBeGreaterThan(0)
    expect(before.target).toBeGreaterThan(0)
    const acceptance = (after: typeof before) => { expect(after.asker, "F22 asker and sibling child survives").toBe(before.asker); expect(after.runner,"F22 runner survives").toBe(before.runner); expect(after.target,"F22 requested target changes generation").not.toBe(before.target) }
    // Observable controls use real killed/replaced children, below, after the good path.
    if (source !== "pending-before-start") hub = await runHub({ registryFile:it.registryFile,machine:"mac",os:os.os })
    if (source === "chat") {
      const door = await startReadySubprocess("test/helpers/door-subprocess.ts",[it.registryFile,"door-fake",platform.url])
      children.push(door)
      it.edge.batch([message("20","/recover p2-lair")],"21")
    } else if (source === "cli") {
      const result = await command.run(["recover",it.registryFile,"agent:p2-lair"])
      expect(result.code).toBe(0)
    } else await (requestRecovery as Function)(store,{...request,registryFile:it.registryFile})
    if (!hub) hub = await runHub({registryFile:it.registryFile,machine:"mac",os:os.os})
    expect(await observe(async () => (await it.read.sheet("control")).some(r => r.data.status === "applied")), "D-178 recovery must apply").toBe(true)
    await insertInbound(cluster,it.db,{id:"after-target",person:"p1",agent:"p2-lair",body:"after recovery"})
    await insertInbound(cluster,it.db,{id:"after-asker",person:"p1",agent:"p1-lair",body:"still serving"})
    // A chat request's outcome is said in that chat, one notice row beside the four replies.
    expect(await observe(async () => (await it.read.outbox()).length === 4 + (source === "chat" ? 1 : 0))).toBe(true)
    expect((await it.read.noticeRows()).filter(r => String(r.notice_key).startsWith("recovery-outcome:"))).toHaveLength(source === "chat" ? 1 : 0)
    const after = { asker:pidFor("after-asker"),target:pidFor("after-target"),runner:runner.pid }
    acceptance(after)
    expect(childGone(before.target)).toBe(true)
    const controls = await it.read.sheet("control")
    expect(controls).toHaveLength(1)
    expect(controls[0].data).toMatchObject({person:"p1",target_kind:"agent",target_id:"p2-lair",status:"applied"})
    const diary = (await it.read.ledger()).filter(r => r.subject === controls[0].id || r.detail.request_id === controls[0].id)
    expect(diary.filter(r => /request/.test(r.kind))).toHaveLength(1)
    expect(diary.filter(r => /applied/.test(r.kind))).toHaveLength(1)
    expect(diary.findIndex(r=>/request/.test(r.kind))).toBeLessThan(diary.findIndex(r=>/applied/.test(r.kind)))
    expect(os.calls.filter(c=>c.operation === "restart")).toEqual([])
    // Forbidden controls change actual live generations. They are never accepted as recovery.
    await (requestRecovery as Function)(store,{...request,id:crypto.randomUUID(),target_id:"p1-lair",registryFile:it.registryFile})
    expect(await observe(()=>childGone(after.asker))).toBe(true)
    await insertInbound(cluster,it.db,{id:"wrong-target-control",person:"p1",agent:"p1-lair",body:"wrong target control"})
    expect(await observe(()=>Boolean(pidFor("wrong-target-control")))).toBe(true)
    expect(()=>acceptance({...after,asker:pidFor("wrong-target-control")})).toThrow()
    await insertInbound(cluster,it.db,{id:"unchanged-target-control",person:"p1",agent:"p2-lair",body:"target was not recovered"})
    expect(await observe(()=>Boolean(pidFor("unchanged-target-control")))).toBe(true)
    const targetChanged=(old:number,current:number)=>expect(current,"F22 wrong target must fail generation check").not.toBe(old)
    targetChanged(before.target,after.target)
    expect(()=>targetChanged(after.target,pidFor("unchanged-target-control"))).toThrow()
    await runner.stop()
    runner=await startReadySubprocess("test/helpers/runner-subprocess.ts",[it.registryFile,"runner-pi",it.adapterUrl,it.adapterName,"child"])
    children.push(runner)
    await insertInbound(cluster,it.db,{id:"runner-restart-control",person:"p1",agent:"p1-lair",body:"runner unit restart control"})
    expect(await observe(()=>Boolean(pidFor("runner-restart-control")))).toBe(true)
    expect(()=>acceptance({...after,runner:runner.pid,asker:pidFor("runner-restart-control")})).toThrow()
    if (source === "replay-after-restart") {
      await hub.stop(); hub = undefined
      await runner.stop()
      runner = await startReadySubprocess("test/helpers/runner-subprocess.ts",[it.registryFile,"runner-pi",it.adapterUrl,it.adapterName,"child"])
      children.push(runner)
      hub = await runHub({registryFile:it.registryFile,machine:"mac",os:os.os})
      await (requestRecovery as Function)(store,{...request,registryFile:it.registryFile})
      await insertInbound(cluster,it.db,{id:"replayed",person:"p1",agent:"p2-lair",body:"after replay"})
      expect(await observe(async ()=>(await it.read.outbox()).some(r=>r.inbound_id === "replayed"))).toBe(true)
      expect((await it.read.ledger()).filter(r=>(r.subject===request.id || r.detail.request_id===request.id)&&/applied/.test(r.kind))).toHaveLength(1)
    }

  } finally { await hub?.stop(); for(const c of children.reverse()) await c.stop(); command.stop(); await platform.stop(); await store.close(); await it.stop() }
})
for(const refusal of ["unauthorized-sender","other-person","chat-door-restart","coordinator-target"]) test(`ROLL-22 ${refusal} refuses while same path permits authorized same-person agent`,async()=>{
  const it=await rolloutStage(cluster,"telegram")
  const store=await superStore(cluster,it.db)
  try {
    const {requestRecovery}=await seam("src/hub/control.ts")
    const good={id:crypto.randomUUID(),source:"chat",actor:"p1",sender_id:"p1",person:"p1",door:"door-fake",chat:"1000000001",target_kind:"agent",target_id:"p1-lair",registryFile:it.registryFile}
    await (requestRecovery as Function)(store,good)
    expect((await it.read.sheet("control")).some(r=>r.data.status==="pending")).toBe(true)
    const bad={...good,id:crypto.randomUUID(),...(refusal==="unauthorized-sender"?{sender_id:"unlisted"}:refusal==="other-person"?{target_id:"p2-lair"}:refusal==="chat-door-restart"?{target_kind:"door",target_id:"door-fake"}:{target_kind:"hub",target_id:"hub"})}
    await expect((requestRecovery as Function)(store,bad)).rejects.toThrow()
    expect((await it.read.sheet("control")).filter(r=>r.data.status==="pending")).toHaveLength(1)
    expect(await it.read.inbound()).toEqual([])
  } finally {await store.close();await it.stop()}
})
test("ROLL-22 operator door recovery loads atomically replaced token and preserves sibling door and runner PIDs",async()=>{
  const f=await serviceFixture(cluster)
  const store=await superStore(cluster,f.db)
  const requests:{url:string}[]=[]
  const server=Bun.serve({hostname:"127.0.0.1",port:0,async fetch(req){requests.push(await req.json() as {url:string});return Response.json({ok:true,result:[]})}})
  const children:ReadyProcess[]=[]
  const adapter=createScriptedAdapter({name:f.preset.adapter})
  const adapterServer=await serveAdapter(adapter)
  let hub:Awaited<ReturnType<typeof runHub>>|undefined
  try {
    const {requestRecovery}=await seam("src/hub/control.ts")
    const token=join(f.dir,"token")
    writeFileSync(token,"synthetic-before",{mode:0o600})
    writeFileSync(f.registryFile,readFileSync(f.registryFile,"utf8").replace('token_file = "/dev/null"',`token_file = ${JSON.stringify(token)}`)+`\n[[agents]]\nid = "p1-lair"\nperson = "p1"\npreset = "daily"\ndoor = "${f.ids.door}"\nrunner = "${f.ids.runner}"\nchat = "1000000001"\n`)
    const argv=[f.registryFile,f.ids.door,`http://127.0.0.1:${server.port}`]
    let door=await startReadySubprocess("test/helpers/rollout-token-door-child.ts",argv)
    children.push(door)
    expect(await observe(()=>requests.some(r=>r.url.includes("synthetic-before")))).toBe(true)
    // Another real door has an independent registry and token source.
    const siblingFile=join(f.dir,"sibling.toml")
    writeFileSync(siblingFile,readFileSync(f.registryFile,"utf8").replaceAll(f.ids.door,`door-${crypto.randomUUID().slice(0,8)}`))
    const {listRunEntries}=await import("../src/registry/entries.ts")
    const {loadRegistry}=await import("../src/registry/load.ts")
    const siblingId=listRunEntries(loadRegistry(siblingFile)).find(e=>e.kind==="door")!.id
    const sibling=await startReadySubprocess("test/helpers/rollout-token-door-child.ts",[siblingFile,siblingId,argv[2]])
    children.push(sibling)
    const runner=await startReadySubprocess("test/helpers/runner-subprocess.ts",[f.registryFile,f.ids.runner,adapterServer.url,f.preset.adapter,"child"])
    children.push(runner)
    const runnerPid=runner.pid
    const old=door.pid
    const os=serviceOs(f.dir,"launchd",Object.values(f.ids))
    const restart=os.os.restart
    os.os.restart=async id=>{await restart(id);expect(id).toBe(f.ids.door);await door.stop();door=await startReadySubprocess("test/helpers/rollout-token-door-child.ts",argv);children.push(door)}
    hub=await runHub({registryFile:f.registryFile,machine:f.machine,os:os.os})
    writeFileSync(token+".new","synthetic-after",{mode:0o600});renameSync(token+".new",token)
    await (requestRecovery as Function)(store,{id:crypto.randomUUID(),source:"cli",actor:"operator",target_kind:"door",target_id:f.ids.door,registryFile:f.registryFile})
    expect(await observe(()=>requests.some(r=>r.url.includes("synthetic-after")))).toBe(true)
    expect(door.pid).not.toBe(old)
    expect(childGone(sibling.pid)).toBe(false)
    expect(childGone(runnerPid)).toBe(false)
    expect(runner.pid).toBe(runnerPid)
    expect(os.calls.filter(c=>c.operation==="restart").map(c=>c.target)).toEqual([f.ids.door])
    expect((await f.read!.sheet("control"))[0].data.status).toBe("applied")
  } finally {await hub?.stop();for(const c of children.reverse())await c.stop();await server.stop(true);await adapterServer.stop();await store.close();await f.stop()}
})

test("ROLL-22 recovery releases an in-flight target claim and leaves a healthy sibling serving", async () => {
  const it = await rolloutStage(cluster, "telegram", { machines: [{ id: "mac", os: process.platform === "darwin" ? "macos" : "linux" }], registry: base => ({ ...base, agents: base.agents!.map(a => ({ ...a, person: "p1" })) }) })
  const store = await superStore(cluster, it.db)
  const { controlledAdapter } = await import("./helpers/rollout-runner.ts")
  const { runRunner } = await import("../src/runner/run.ts")
  const edge = controlledAdapter(it.adapterName)
  let runner: Awaited<ReturnType<typeof runRunner>> | undefined
  let hub: Awaited<ReturnType<typeof runHub>> | undefined
  try {
    const { requestRecovery } = await seam("src/hub/control.ts")
    edge.hold(m => m.id === "stuck-target")
    runner = await runRunner({ registryFile: it.registryFile, runner: "runner-pi", adapters: { [it.adapterName]: edge.adapter } })
    const os = serviceOs(it.stateDir, "launchd", ["door-fake", "runner-pi"])
    os.os.render = () => [] // Inert control harness creates no unsuffixed service files.
    hub = await runHub({ registryFile: it.registryFile, machine: "mac", os: os.os })
    await insertInbound(cluster, it.db, { id: "healthy-sibling", agent: "p1-lair", body: "healthy" })
    await insertInbound(cluster, it.db, { id: "stuck-target", agent: "p2-lair", person: "p1", body: "stuck" })
    expect(await observe(() => edge.sessions.some(r => r.fed.some(m => m.id === "stuck-target")))).toBe(true)
    expect(await observe(async () => (await it.read.outbox()).some(r => r.inbound_id === "healthy-sibling"))).toBe(true)
    const target = edge.sessions.find(r => r.fed.some(m => m.id === "stuck-target"))!
    const sibling = edge.sessions.find(r => r.fed.some(m => m.id === "healthy-sibling"))!
    expect((await it.read.inbound()).find(r => r.id === "stuck-target")!.claimed_by).not.toBeNull()
    edge.hold(() => false)
    await (requestRecovery as Function)(store, { id: crypto.randomUUID(), registryFile: it.registryFile, source: "cli", actor: "operator", person: "p1", target_kind: "agent", target_id: "p2-lair" })
    expect(await observe(async () => (await it.read.outbox()).some(r => r.inbound_id === "stuck-target")), "recovered claim must produce its owed answer").toBe(true)
    const successor = edge.sessions.filter(r => r.fed.some(m => m.id === "stuck-target")).at(-1)!
    expect(successor.session.pid).not.toBe(target.session.pid)
    expect(target.closed).toBe(true)
    expect(sibling.closed).toBe(false)
    expect(childGone(sibling.session.pid!)).toBe(false)
    expect((await it.read.inbound()).find(r => r.id === "stuck-target")!.claimed_by).toBeNull()
    expect((await it.read.outbox()).filter(r => r.inbound_id === "stuck-target")).toHaveLength(1)
    expect(os.calls.filter(c => c.operation === "restart")).toEqual([])
  } finally { await hub?.stop(); await runner?.stop(); await edge.stop(); await store.close(); await it.stop() }
})
