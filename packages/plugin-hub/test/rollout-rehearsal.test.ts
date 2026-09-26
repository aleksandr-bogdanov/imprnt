import { afterAll, expect, test } from "bun:test"
import { existsSync, readFileSync, writeFileSync, copyFileSync, mkdirSync, statfsSync } from "node:fs"
import { join } from "node:path"
import { startCluster, seam, hubPath, type Cluster } from "./helpers/cluster.ts"
import { serviceFixture, serviceOs } from "./helpers/rollout-service.ts"
import { commandHarness } from "./helpers/rollout-command.ts"
import { migrationFixture, inventory, historicalRows, privateJson, plantTabHistory, from, until, jsonlBytes, envelope, note } from "./helpers/rollout-migration.ts"
import { localRepository, fixtureGit } from "./helpers/rollout-git.ts"
import { commitChange, observeGit, syncChild } from "./helpers/rollout-sync.ts"
import { rolloutPlatform } from "./helpers/rollout-platform.ts"
import { controlledAdapter, observe, editAgent } from "./helpers/rollout-runner.ts"
import { scratchVault } from "./helpers/scratch-vault.ts"
import { writeImprntShim } from "./helpers/imprnt-shim.ts"
import { storeReader } from "./helpers/hub-fixture.ts"
import { loadRegistry } from "../src/registry/load.ts"
import { listRunEntries } from "../src/registry/entries.ts"
import { runDoor } from "../src/door/run.ts"
import { runRunner } from "../src/runner/run.ts"
import { runHub } from "../src/hub/run.ts"
import { launchSeam, launchInput, captureCli, ending, appended } from "./helpers/rollout-loop.ts"
import { claudeCode } from "../src/adapters/claude-code.ts"
import { boxGate } from "./helpers/box-gate.ts"
import { clockGate, clockSuffix, announceClock } from "./helpers/clock-gate.ts"
import { harvestPrompt } from "../src/harvest/prompt.ts"
import { proveRolloutCommand } from "../live/prove-rollout-command.ts"
import { childGone } from "./helpers/scripted-adapter.ts"

const clock = clockGate(3)
function memoryRoom() {
  try { const fs = statfsSync("/dev/shm"); return fs.bavail * fs.bsize >= 512 * 1024 * 1024 } catch { return false }
}
announceClock(clock, "06-09 demand after activation")
// Cleanup is registered before any fixture is allocated, including unit files.
const cleanups: (() => Promise<unknown> | unknown)[] = []
afterAll(async () => {
  const errors: unknown[] = []
  for (const close of cleanups.reverse()) {
    try { await close() } catch (error) { errors.push(error) }
  }
  if (errors.length) throw new AggregateError(errors, "rehearsal cleanup failed")
})
for (const osName of ["linux", "macos"] as const) {
  const native = process.platform === (osName === "macos" ? "darwin" : "linux")
  if (!native) console.error(`SKIP: 06-09 rehearsal requires ${osName === "macos" ? "macOS" : "Linux"}`)
  test.skipIf(!native || !clock.ok)(`ROLL-01/02/03/04/05/06/07/08/09/12/18/20/22/23/30/31 ${osName} integrated rehearsal${native ? "" : ` [SKIP: requires ${osName === "macos" ? "macOS" : "Linux"}]`}${clockSuffix(clock)}`, async () => {
    expect(boxGate().ok, "D-184 host kernel box prerequisite").toBe(true)
    // On the Linux box the install below spent 11 to 34 s in four of 25 runs waiting for Postgres to sync the SD
    // card (IO:WALSync and IO:DataFileImmediateSync), which no window can measure. So the cluster lives in memory
    // where there is room for it: it measured 48.5 MB at the end of the rehearsal, and /dev/shm is used only with 512 MB free.
    const cluster: Cluster = await startCluster(memoryRoom() ? { parent: "/dev/shm" } : {})
    cleanups.push(() => cluster.stop())
    const bootstrap = await serviceFixture(cluster, true)
    cleanups.push(() => bootstrap.stop())
    const f = migrationFixture()
    cleanups.push(() => f.stop())
    await proveRolloutCommand()
    const command = await commandHarness(f.dir)
    cleanups.push(() => command.stop())
    const os = serviceOs(f.dir, osName === "macos" ? "launchd" : "systemd", [...Object.values(bootstrap.ids), `door-telegram-${bootstrap.ids.hub}`])
    cleanups.push(async () => { for (const id of [...Object.values(bootstrap.ids), `door-telegram-${bootstrap.ids.hub}`]) { await os.os.stop(id); await os.os.remove(id) } })

    // First stage crosses the actual Node core -> package shim -> Bun boundary.
    // No plugin replacement, no implementation spy and no native manager call.
    // The command watchdog is in helpers/rollout-command.ts. With the cluster in memory this install measured 309 to 352 ms in 13 runs on the Linux box.
    const installed = await command.run(["install", bootstrap.registryFile, "database"])
    expect(installed.code, `D-170 real core database dispatch must succeed (package hub.mjs ${existsSync(hubPath("hub.mjs")) ? "present" : "missing"})`).toBe(0)
    expect(os.calls).toEqual([])
    const read = storeReader(cluster, bootstrap.db)
    cleanups.push(() => read.close())
    expect(await read.inbound()).toEqual([])
    const { runInstall } = await seam("src/install/run.ts")
    const { convertV2Registry } = await seam("src/migrate/registry.ts")
    const { convertV2Chatlog } = await seam("src/migrate/chatlog.ts")
    const { prepareHandoff, applyHandoff } = await seam("src/migrate/handoff.ts")
    const { catchUpHarvest } = await seam("src/migrate/harvest.ts")

    const repos = ["p1-vault", "p2-vault", "shared"].map(id => localRepository(f.dir, id))
    const sharedPath = join(repos[0].path, "shared")
    fixtureGit(f.dir, "clone", repos[2].remote, sharedPath)
    repos[2].path = sharedPath
    const exclude = join(repos[0].path, ".git", "info", "exclude")
    writeFileSync(exclude, readFileSync(exclude, "utf8") + "\n/shared/\n")
    const vault = await scratchVault(repos[1].path)
    cleanups.push(() => vault.remove())
    const shim = writeImprntShim(f.dir)
    const model = controlledAdapter("claude-code")
    cleanups.push(() => model.stop())
    const transcript: string[] = []
    let harvestingHistory = true
    const long = "synthetic long answer λ ".repeat(260)
    model.onStart(row => row.loop.setAnswer(({ text }) => {
      transcript.push(text)
      if (text.includes(harvestPrompt("en")) || text.includes(harvestPrompt("ru"))) {
        const title = historicalRows.find(r => text.includes(r.text))?.text ?? (harvestingHistory ? "history-other" : "demand-note")
        return envelope(note(title))
      }
      return text.includes("media rehearsal") ? long : `reply to ${text}`
    }))
    const manifest = structuredClone(f.registryManifest)
    manifest.active_registry = bootstrap.registryFile
    manifest.hub = { ...(loadRegistry(bootstrap.registryFile).data.hub as object), imprnt: shim, cutover_batch: manifest.batch_id }
    manifest.machines = [{ id: bootstrap.machine, os: osName }]
    manifest.run = listRunEntries(loadRegistry(bootstrap.registryFile))
    manifest.run.push({ id: `door-telegram-${bootstrap.ids.hub}`, kind: "door", machine: bootstrap.machine, platform: "telegram", person: "p2", token_file: f.token, schedule: "always", memory_limit_mb: 256 })
    manifest.bindings.forEach((b: any, i: number) => { b.runner = bootstrap.ids.runner; b.door = i ? `door-telegram-${bootstrap.ids.hub}` : bootstrap.ids.door })
    manifest.people.forEach((p: any, i: number) => {
      p.tree = repos[i].path
      p.vault = i ? vault.root : repos[i].path
      p.filing_rules = i ? join(vault.root, "CLAUDE.md") : f.files.filing_rules
      p.allowed_senders = { [manifest.bindings[i].door]: [p.id] }
      p.harvest_min_messages = 1
      p.harvest_quiet_minutes = 1440
      if (!i) p.history_harvest_after = f.handoffManifest.freeze_at
    })
    manifest.repositories = repos.map((r, i) => ({ id:r.id, person:i === 1 ? "p2" : "p1", path:r.path, remote:"origin", branch:"main", required:true }))
    manifest.run = manifest.run.map((r: any) => ({...r, ...(r.kind === "sync" ? {repositories:repos.map(r=>r.id)} : {}), ...(r.id === bootstrap.ids.door ? {platform:"discord", person:"p1", token_file:f.token} : {})}))
    manifest.people[0].history_harvest_after = new Date().toISOString()
    const before = readFileSync(bootstrap.registryFile, "utf8")
    await (convertV2Registry as Function)(manifest, f.lookup)
    expect(readFileSync(bootstrap.registryFile,"utf8")).toBe(before)
    const reviewed = JSON.parse(readFileSync(manifest.inventory,"utf8"))
    expect(reviewed.agents.map((a:any)=>a.id).sort()).toEqual(["p1-lair","p2-lair"])
    // Synthetic review boundary. Only this test promotes this private candidate.
    copyFileSync(manifest.candidate, bootstrap.registryFile)
    const registryFile = bootstrap.registryFile
    let text = readFileSync(registryFile,"utf8")
    text += "\n[runner]\ntask_retry_seconds = 1\n[door]\ndelivery_retry_seconds = 1\n"
    writeFileSync(registryFile,text)
    let registry = loadRegistry(registryFile)
    expect(registry.agents.map(a=>a.runner)).toEqual([bootstrap.ids.runner,bootstrap.ids.runner])
    // Imported configuration reaches the real adapter through its real kernel
    // wrapper. The executable is synthetic and cannot count as live Write proof.
    const make = await launchSeam()
    for (const agent of registry.agents) {
      const person = registry.people.find(p=>p.id===agent.person)!
      for (const purpose of ["ordinary", "harvest"]) {
        const sessionDir=join(bootstrap.stateDir,person.id,"sessions",agent.id,crypto.randomUUID())
        mkdirSync(sessionDir,{recursive:true})
        const preset=(registry as any).presets[purpose === "harvest" ? (person as any).harvester : agent.preset]
        const input={...launchInput(f,purpose),registry,agent,preset,sessionDir,box:{agent:agent.id,person:person.id,tree:person.tree,otherTrees:registry.people.filter(p=>p.id!==person.id).map(p=>p.tree),stateRoot:join(bootstrap.stateDir,person.id),otherStateRoots:registry.people.filter(p=>p.id!==person.id).map(p=>join(bootstrap.stateDir,p.id)),sessionDir,purpose}}
        const launch=await make(input)
        const capture=join(sessionDir,"launch.json")
        const session=await claudeCode.start({...launch,preset,sessionId:null,wrap:argv=>launch.wrap(captureCli(capture,f)(argv))})
        // ending() waits 5000 ms. Measured max 82 ms over 124 turns in 31 runs on the Linux box.
        try {await ending(session)} finally {await session.close()}
        const got=JSON.parse(readFileSync(capture,"utf8"))
        const source=f.sources.find(s=>s.person===person.id)!
        if(purpose === "ordinary") {
          expect(appended(got.fragment).preamble).toBe(true)
          expect(got.fragment.endsWith(readFileSync(source.rendered,"utf8"))).toBe(true)
          expect(got.mcp).toEqual({mcpServers:source.mcp??{}})
          expect(got.argv).toContain("--dangerously-skip-permissions")
          for(const tool of source.tools) expect(got.argv.join(" ")).toContain(tool)
        } else {
          expect(got.argv).not.toContain("--dangerously-skip-permissions")
          const at=got.argv.indexOf("--tools")
          expect(at).toBeGreaterThan(-1)
          const tail=got.argv.slice(at+1)
          const end=tail.findIndex((v:string)=>v.startsWith("--"))
          const tools=tail.slice(0,end<0?undefined:end).flatMap((v:string)=>v.split(/[, ]/)).filter(Boolean)
          expect(tools.sort()).toEqual(["Glob","Grep","Read"])
        }
      }
    }
    for (const r of repos) { fixtureGit(r.path,"add","."); fixtureGit(r.path,"commit","--allow-empty","-m","synthetic staged vault"); commitChange(r.path) }
    const remoteProof = () => {
      for (const r of repos) expect(fixtureGit(f.dir,"--git-dir",r.remote,"show","main:local.txt")).toBe("synthetic local change")
    }
    expect(remoteProof).toThrow() // No push cannot masquerade as sync success.
    await (runInstall as Function)({registryFile,stage:"entry",target:bootstrap.ids.sync,os:os.os})
    expect(os.calls.every(c=>c.target===bootstrap.ids.sync)).toBe(true)
    const git = observeGit(f.dir)
    // syncChild kills at 15000 ms. Measured max 2308 ms in 31 runs on the Linux box, once 10.4 s in an SD card stall.
    const sync = await syncChild({registryFile,id:bootstrap.ids.sync} as Parameters<typeof syncChild>[0],git.env)
    expect(sync.code,sync.err).toBe(0)
    remoteProof()
    expect((await read.sheet("job_success")).some(r=>r.id===bootstrap.ids.sync)).toBe(true)

    const recent=plantTabHistory(f.roots[0].root,[{id:"synthetic-recent-tail",at:new Date(Date.now()-60000).toISOString(),text:"converted-tail-codeword"}],"p1")
    const history = plantTabHistory(f.roots[1].root,historicalRows)
    await (convertV2Chatlog as Function)({...f.logManifest,state_dir:bootstrap.stateDir,inventory:inventory([f.old,f.tab,...history,...recent])})
    const logs = jsonlBytes(bootstrap.stateDir,"p2","p2-lair")
    await (convertV2Chatlog as Function)({...f.logManifest,state_dir:bootstrap.stateDir,inventory:inventory([f.old,f.tab,...history,...recent])})
    expect(jsonlBytes(bootstrap.stateDir,"p2","p2-lair")).toEqual(logs)
    const frozen = structuredClone(f.handoffManifest)
    frozen.items.forEach((item:any)=>{item.door=bootstrap.ids.door;item.platform="discord"})
    privateJson(f.frozen,{agents:frozen.agents,items:frozen.items})
    frozen.sources=inventory([f.frozen])
    frozen.cursors=[{door:bootstrap.ids.door,chat:"0000000000",cursor:"5"},{door:manifest.bindings[1].door,chat:"1000000001",cursor:"5"}]
    const edges = [rolloutPlatform("discord"),rolloutPlatform("telegram")]
    for (let i=0;i<2;i++) {
      let early: Awaited<ReturnType<typeof runDoor>> | undefined
      try {
        // Before the handoff the door waits and says why instead of
        // exiting into its unit's start limit, so this control stops it waiting.
        const abort=new AbortController()
        const waiting=runDoor({door:manifest.bindings[i].door,registryFile,platform:edges[i].platform,signal:abort.signal}).then(d=>{early=d;return d})
        expect(await observe(async()=>(await read.ledger({stream:"operation",subject:manifest.bindings[i].door})).some(r=>r.detail.code==="cutover-incomplete"))).toBe(true)
        abort.abort()
        await expect(waiting).rejects.toThrow(/cutover|handoff|batch/i)
        expect(edges[i].pulls()).toHaveLength(0)
      } finally { await early?.stop() }
    }
    const prepared = await (prepareHandoff as Function)(frozen)
    await (applyHandoff as Function)(prepared,{registryFile})
    expect((await read.sheet("cutover"))[0].data.complete).toBe(true)
    await (catchUpHarvest as Function)(registry,"p2",from,until,{adapters:{"claude-code":model.adapter}})
    expect(existsSync(join(vault.vaultDir,"life","earliest-history-codeword.md"))).toBe(true)
    expect((await read.harvestSheet()).find(r=>r.id==="p2/p2-lair")?.data.at).toBe(until)
    for (const row of historicalRows) expect(transcript.some(t=>t.includes(row.text))).toBe(true)
    expect((await read.harvestSheet()).some(r=>r.id.startsWith("p1/"))).toBe(false)
    const historyCalls=transcript.length
    await (catchUpHarvest as Function)(registry,"p2",from,until,{adapters:{"claude-code":model.adapter}})
    expect(transcript).toHaveLength(historyCalls)

    harvestingHistory = false
    expect(existsSync(join(vault.vaultDir,"life","demand-note.md"))).toBe(false)
    await (runInstall as Function)({registryFile,stage:"services",target:bootstrap.ids.hub,os:os.os})
    expect(os.files.some(file=>file.path.includes(`imprnt-hub-${bootstrap.ids.hub}.`))).toBe(true)
    const hub=await runHub({registryFile,machine:bootstrap.machine,os:os.os})
    cleanups.push(()=>hub.stop())
    const runner=await runRunner({registryFile,runner:bootstrap.ids.runner,adapters:{"claude-code":model.adapter}})
    cleanups.push(()=>runner.stop())
    const servicePid=process.pid
    for (let i=0;i<2;i++) {
      const door=await runDoor({registryFile,door:manifest.bindings[i].door,platform:edges[i].platform})
      cleanups.push(()=>door.stop())
      edges[i].file("synthetic-photo",new Uint8Array([11,22,33,44]))
      edges[i].batch([{platform_message_id:"6",chat:i?"1000000001":"0000000000",sender_id:i?"p2":"p1",from:i?"p2":"p1",text:"media rehearsal",at:new Date().toISOString(),media:[{kind:"photo",remote_id:"synthetic-photo",name:"fixture.png",mime:"image/png",bytes:4,caption:"synthetic caption"}]}],"7")
    }
    // Measured max 2785 ms in 30 runs on the Linux box. Three times that is 8355, so 10000 stays.
    expect(await observe(async()=> (await read.outbox()).filter(r=>r.body.includes("synthetic long answer")).every(r=>r.delivered_at!==null) && edges.every(e=>e.posts().some(p=>p.text.includes("synthetic long answer"))),10000)).toBe(true)
    for(let i=0;i<2;i++) {
      const posts=edges[i].posts().filter(p=>p.text.includes("synthetic long answer"))
      const accepts=(parts:string[])=>{expect(parts.join("")).toBe(long);expect(parts.every(p=>p.length<=(i?4000:2000))).toBe(true)}
      accepts(posts.map(p=>p.text))
      expect(()=>accepts([long])).toThrow()
      const inbound=(await read.sql("select * from inbound where body like '%media rehearsal%' and person=$1",[i?"p2":"p1"]))[0] as any
      expect(inbound.source.media).toHaveLength(1)
      const path=inbound.body.match(/\((?:photo|фото) ([^)]+)\)/)![1]
      expect([...readFileSync(path)]).toEqual([11,22,33,44])
      const ledger=await read.ledger({subject:inbound.id})
      for(const stamp of ["received","acked","started","answered","delivered"]) expect(ledger.some(r=>r.kind===stamp)).toBe(true)
      const lines=Object.values(jsonlBytes(bootstrap.stateDir,i?"p2":"p1",i?"p2-lair":"p1-lair")).join("").trim().split("\n").map(s=>JSON.parse(s))
      expect(lines.filter(l=>l.id===inbound.source.log_id)).toHaveLength(1)
      expect((await read.sheet("door_cursor")).find(r=>r.id===`${manifest.bindings[i].door}/${i?"1000000001":"0000000000"}`)?.data.cursor).toBe("7")
    }
    expect(transcript.some(t=>t.includes("converted-tail-codeword"))).toBe(true)
    expect(transcript.some(t=>t==="completed synthetic instruction")).toBe(false)
    for(const owed of ["fully owed","remaining owed"]) expect(edges[0].posts().filter(p=>p.text===owed)).toHaveLength(1)
    expect(edges[0].posts().some(p=>p.text==="already delivered")).toBe(false)
    model.hold(m=>m.text === "death during turn")
    edges[0].batch([{platform_message_id:"8",chat:"0000000000",sender_id:"p1",from:"p1",text:"death during turn",at:new Date().toISOString(),media:[]}],"9")
    // Default 3500 ms window. Measured max 48 ms in 29 runs on the Linux box.
    expect(await observe(()=>model.sessions.some(r=>r.fed.some(m=>m.text==="death during turn")))).toBe(true)
    const target=model.sessions.findLast(r=>r.fed.some(m=>m.text==="death during turn"))!
    expect(target.session.pid).toBeGreaterThan(0)
    const sibling=model.sessions.findLast(r=>r.fed.some(m=>m.id.startsWith("telegram:")) && !r.closed)!
    expect(sibling).toBeDefined()
    const siblingPid=sibling.session.pid
    model.hold(()=>false)
    target.fail()
    // Default 3500 ms window. Measured max 33 ms in 29 runs on the Linux box.
    expect(await observe(()=>childGone(target.session.pid!))).toBe(true)
    // Measured max 3867 ms in 29 runs on the Linux box, a 1 s retry plus runner ticks. Three times that is 11601, rounded up.
    expect(await observe(()=>edges[0].posts().some(p=>p.text==="reply to death during turn"),12000)).toBe(true)
    expect((await read.ledger({subject:"p1-lair"})).some(r=>r.kind==="refused.turn" && Number.isFinite(Date.parse(String(r.detail.retry_at))))).toBe(true)
    expect((await read.sheet("agent_health")).some(r=>r.id==="p1-lair")).toBe(false)
    // The command watchdog is in helpers/rollout-command.ts. This recover measured max 269 ms in 29 runs on the Linux box.
    const recovery=await command.run(["recover",registryFile,"agent:p1-lair"])
    expect(recovery.code,recovery.err).toBe(0)
    // Measured max 1341 ms in 29 runs on the Linux box. Three times that is 4023, so 7000 stays.
    expect(await observe(async()=>(await read.sheet("control")).some(r=>r.data.status==="applied"),7000)).toBe(true)
    expect(sibling.session.pid).toBe(siblingPid)
    expect(childGone(siblingPid!)).toBe(false)
    expect(process.pid).toBe(servicePid)
    const originalChat=registry.agents.find(a=>a.id==="p1-lair")!.chat
    editAgent(registryFile,"p1-lair",{chat:"1000000001"})
    // A chat the door holds no cursor for starts at the edge's newest cursor, "9", which the door asks
    // the platform for once when it activates the chat and saves before its first pull.
    // Everything sent after that is answered, so this waits for the door to be reading the new chat.
    // Measured max 1286 ms in 27 runs on the Linux box. Three times that is 3858, so 5000 stays.
    expect(await observe(()=>edges[0].pulls().some(p=>p.chat==="1000000001" && p.cursor==="9"),5000)).toBe(true)
    edges[0].batch([{platform_message_id:"10",chat:"1000000001",sender_id:"p1",from:"p1",text:"after recovery and mapping",at:new Date().toISOString(),media:[]}],"11")
    // Measured max 89 ms in 25 runs on the Linux box once the send waits for the walk. Three times that is 267, so 7000 stays.
    expect(await observe(()=>edges[0].posts().some(p=>p.chat==="1000000001" && p.text.includes("after recovery and mapping")),7000)).toBe(true)
    expect(edges[0].posts().some(p=>p.chat===originalChat && p.text.includes("after recovery and mapping"))).toBe(false)
    expect(os.calls.filter(c=>c.operation==="restart")).toEqual([])
    edges[1].batch([{platform_message_id:"10",chat:"1000000001",sender_id:"p2",from:"p2",text:"harvest this",at:new Date().toISOString(),media:[]}],"11")
    // Measured max 1807 ms in 25 runs on the Linux box. Three times that is 5421, rounded up.
    expect(await observe(async()=>(await read.sql("select * from inbound where kind='harvest' and id like 'harvest-demand:%'")).length===1,6000)).toBe(true)
    // Measured max 1494 ms in 25 runs on the Linux box. Three times that is 4482, so 10000 stays.
    expect(await observe(()=>existsSync(join(vault.vaultDir,"life","demand-note.md")),10000)).toBe(true)
    // Measured max 28 ms in 25 runs on the Linux box. Three times that is 84, so 5000 stays.
    expect(await observe(async()=>(await read.noticeRows()).some(r=>r.person==="p2" && /harvest|saved|сохран/i.test(r.body)),5000)).toBe(true)
    expect(transcript).not.toContain("harvest this")
    expect(process.pid).toBe(servicePid)
  })
}
