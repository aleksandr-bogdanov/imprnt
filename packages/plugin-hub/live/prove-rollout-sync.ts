import assert from "node:assert/strict"
import { existsSync, writeFileSync } from "node:fs"
import { startCluster } from "../test/helpers/cluster.ts"
import { fixtureGit } from "../test/helpers/rollout-git.ts"
import { syncFixture, observeGit, commitChange, syncChild, scheduleProbe, scheduledArgv, auditSyncWrites } from "../test/helpers/rollout-sync.ts"
const cluster = await startCluster()
let root = ""
try {
  const f = await syncFixture(cluster)
  root = f.stateDir
  try {
    assert.equal(f.entry().kind, "sync")
    assert.equal(f.repos.length, 3)
    assert.equal(fixtureGit(f.repos[0].path, "status", "--porcelain"), "")
    await auditSyncWrites(f)
    await f.read.sql("begin")
    await f.read.sql("set local role hub_hub")
    await f.read.sql("insert into state_row (sheet,id,data) values ('sync','proof','{}'), ('job_success','proof','{}')")
    await f.read.sql("commit")
    let writes = await f.read.sql("select * from sync_audit")
    assert.equal(writes.length, 2)
    assert.equal(writes[0].transaction_id, writes[1].transaction_id)
    await f.read.sql("update state_row set data = '{\"at\":\"synthetic\"}' where sheet = 'job_success' and id = 'proof'")
    writes = await f.read.sql("select * from sync_audit")
    assert.notEqual(writes[0].transaction_id, writes[2].transaction_id)
    console.log("PASS transaction observer: runtime-role grant, same transaction detected, separate success write distinguished")
    const git = observeGit(f.root)
    const repo = f.repos[0]
    commitChange(repo.path)
    commitChange(repo.peer, "peer.txt", "synthetic peer\n")
    fixtureGit(repo.peer, "push", "origin", "main")
    const run = (args: string[]) => syncChild(f, git.env, f.id, ["git", "-C", repo.path, ...args])
    assert.equal((await run(["fetch", "origin", "main"])).code, 0)
    assert.equal((await run(["rebase", "origin/main"])).code, 0)
    git.control({ noPush: true })
    assert.equal((await run(["push", "origin", "main"])).code, 0)
    assert.throws(() => fixtureGit(f.root, "--git-dir", repo.remote, "show", "main:local.txt"))
    git.control({ fail: "push" })
    assert.equal((await run(["push", "origin", "main"])).code, 73)
    git.control({ fail: "fetch" })
    assert.equal((await run(["fetch", "origin", "main"])).code, 73)
    git.control({})
    assert.equal((await run(["push", "origin", "main"])).code, 0)
    assert.equal(fixtureGit(f.root, "--git-dir", repo.remote, "show", "main:local.txt"), "synthetic local change")
    assert.equal(fixtureGit(repo.path, "show", "-s", "--format=%an <%ae>"), "p1 <p1@example.invalid>")
    assert.equal((await run(["fetch", "https://example.invalid/fixture.git"])).code === 0, false)
    git.clear()
    git.control({ delay: 500 })
    await Promise.all([run(["rebase", "origin/main"]), run(["rebase", "origin/main"])])
    const events = git.events().filter(e => e.args.includes("rebase"))
    assert.deepEqual(events.slice(0, 2).map(e => e.phase), ["start", "start"])
    assert.equal(events.filter(e => e.phase === "end").length, 2)
    for (const flavour of ["systemd", "launchd"] as const) {
      const probe = scheduleProbe(f, flavour)
      const script = f.stateDir + "/scheduled proof.ts"
      writeFileSync(script, "console.log('synthetic scheduled proof')")
      const files = probe.os.render(f.entry(), { machine: f.machine, execPath: process.execPath, entryScript: script, registryFile: f.registryFile, restartDelaySeconds: 1, giveUpAfter: 5, giveUpWindowSeconds: 300 })
      assert.deepEqual(scheduledArgv(files, flavour), [process.execPath, "run", script, f.registryFile, f.id])
      try {
        await probe.os.install(files)
        assert.ok(probe.calls().some(a => flavour === "systemd" ? a.includes("--now") && a.includes(`imprnt-hub-${f.id}.timer`) : a[0] === "bootstrap"))
        const fired = await probe.fire(files, git.env)
        assert.equal(fired.code, 0)
        assert.equal(fired.out.trim(), "synthetic scheduled proof")
      } finally { await probe.os.remove(f.id) }
      assert.ok(files.every(file => !existsSync(file.path)))
    }
    console.log("PASS schedule probe: both real renderers, exact quoted argv, fake manager activation, installed program execution, owned-file removal")
    assert.notEqual(f.addEntry(), f.id)
    console.log("PASS sync fixture: loaded registry, both vaults, nested repository, second entry, clean parent")
    console.log("PASS Git observer: real fetch/rebase/push, synthetic identity, no-push exit zero, fetch/push refusals, repair, network denial, overlapping child observation")
  } finally { await f.stop() }
} finally { await cluster.stop() }
assert.equal(existsSync(root), false)
console.log("PASS sync fixture cleanup")
