// Actual remote commits and one success stamp are required.
import { afterAll, beforeAll, expect, test } from "bun:test"
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync, symlinkSync } from "node:fs"
import { join } from "node:path"
import { startCluster, seam, hubPath, type Cluster } from "./helpers/cluster.ts"
import { stageHub } from "./helpers/hub-fixture.ts"
import { fixtureGit, localRepository } from "./helpers/rollout-git.ts"
import { loadRegistry } from "../src/registry/load.ts"
import { listRunEntries } from "../src/registry/entries.ts"

let cluster: Cluster
beforeAll(async () => { cluster = await startCluster() })
afterAll(async () => { if (cluster) await cluster.stop() })

test("ROLL-07 ROLL-31 required vault and nested repository commits reach local remotes before job_success", async () => {
  const it = await stageHub(cluster, {
    machines: [{ id: process.platform === "darwin" ? "mac" : "pi", os: process.platform === "darwin" ? "macos" : "linux" }],
    registry: base => ({ ...base, agents: base.agents!.map(one => ({ ...one, runner: "runner-pi" })) }),
  })
  try {
    const root = join(it.stateDir, "repositories")
    mkdirSync(root)
    const repos = [
      localRepository(root, "p1-vault"),
      localRepository(root, "p2-vault"),
      localRepository(root, "shared"),
    ]
    for (const repo of repos) {
      writeFileSync(join(repo.path, "local.txt"), `${repo.id} local change\n`)
      fixtureGit(repo.path, "add", "local.txt")
      fixtureGit(repo.path, "commit", "-m", "synthetic local change")
      writeFileSync(join(repo.peer, "peer.txt"), `${repo.id} peer change\n`)
      fixtureGit(repo.peer, "add", "peer.txt")
      fixtureGit(repo.peer, "commit", "-m", "synthetic peer change")
      fixtureGit(repo.peer, "push", "origin", "main")
      // No-push control. A zero exit cannot make the new file exist remotely.
      expect(() => fixtureGit(root, "--git-dir", repo.remote, "show", "main:local.txt")).toThrow()
    }
    const childPath = join(repos[0].path, "shared")
    fixtureGit(root, "clone", repos[2].remote, childPath)
    // The used nested repository has its own unpushed change.
    writeFileSync(join(childPath, "nested.txt"), "synthetic nested change\n")
    fixtureGit(childPath, "add", "nested.txt")
    fixtureGit(childPath, "commit", "-m", "synthetic nested change")
    appendFileSync(join(repos[0].path, ".git", "info", "exclude"), "\n/shared/\n")
    const declared = [repos[0], repos[1], { ...repos[2], path: childPath }]
    appendFileSync(it.registryFile, [
      "", "[[people]]", 'id = "p1"', `tree = ${JSON.stringify(repos[0].path)}`,
      "", "[[people]]", 'id = "p2"', `tree = ${JSON.stringify(repos[1].path)}`,
      "", "[[run]]", 'id = "sync-fixture"', 'kind = "sync"',
      'schedule = "every 5m"', "memory_limit_mb = 128",
      'repositories = ["p1-vault", "p2-vault", "shared"]',
      ...declared.flatMap((repo, index) => [
        "", "[[repositories]]", `id = ${JSON.stringify(repo.id)}`,
        `person = ${JSON.stringify(index === 1 ? "p2" : "p1")}`,
        `path = ${JSON.stringify(repo.path)}`, 'remote = "origin"',
        'branch = "main"', "required = true",
      ]), "",
    ].join("\n"))
    const { runSync } = await seam("src/sync/run.ts")
    expect(typeof runSync).toBe("function")
    const registry = loadRegistry(it.registryFile)
    const entry = listRunEntries(registry).find(one => one.id === "sync-fixture")!
    const isolated = observeGit(root)
    const env = Object.fromEntries(Object.entries(isolated.env).filter((pair): pair is [string, string] => typeof pair[1] === "string"))
    const sync = (entry: unknown, registry: unknown) => withAmbient(env, () => (runSync as (entry: unknown, registry: unknown) => Promise<unknown>)(entry, registry))
    await sync(entry, registry)
    for (const repo of declared) {
      expect(fixtureGit(root, "--git-dir", repo.remote, "rev-parse", "main"))
        .toBe(fixtureGit(repo.path, "rev-parse", "HEAD"))
      expect(fixtureGit(root, "--git-dir", repo.remote, "show", "main:peer.txt"))
        .toBe(`${repo.id} peer change`)
    }
    expect(fixtureGit(root, "--git-dir", repos[2].remote, "show", "main:nested.txt"))
      .toBe("synthetic nested change")
    const success = (await it.read.sheet("job_success")).find(row => row.id === entry.id)
    expect(success).toBeDefined()
    expect(Number.isFinite(Date.parse(String(success!.data.at)))).toBe(true)
    const before = JSON.stringify(success)
    const remoteConfig = readFileSync(join(childPath, ".git", "config"), "utf8")
    fixtureGit(childPath, "remote", "set-url", "--push", "origin", join(root, "absent.git"))
    writeFileSync(join(childPath, "second.txt"), "required change\n")
    fixtureGit(childPath, "add", "second.txt")
    fixtureGit(childPath, "commit", "-m", "required change")
    await sync(entry, registry).catch(() => {})
    expect(JSON.stringify((await it.read.sheet("job_success")).find(row => row.id === entry.id))).toBe(before)
    expect(JSON.stringify(await it.read.sheet("sync"))).toContain("shared")
    expect(() => fixtureGit(root, "--git-dir", repos[2].remote, "show", "main:second.txt")).toThrow()
    // Forbidden control: a defective writer reports a new success after that refusal.
    // The same freshness assertion must reject its observable result.
    await it.read.sql("update state_row set data = jsonb_set(data, '{at}', '\"2099-01-01T00:00:00.000Z\"') where sheet = 'job_success' and id = $1", [entry.id])
    const defective = (await it.read.sheet("job_success")).find(row => row.id === entry.id)
    expect(() => expect(JSON.stringify(defective)).toBe(before)).toThrow()
    await it.read.sql("update state_row set data = $1::jsonb where sheet = 'job_success' and id = $2", [JSON.stringify(success!.data), entry.id])
    // The same production path succeeds after only the refused destination is repaired.
    writeFileSync(join(childPath, ".git", "config"), remoteConfig)
    await sync(entry, registry)
    expect(fixtureGit(root, "--git-dir", repos[2].remote, "show", "main:second.txt")).toBe("required change")
  } finally {
    await it.stop()
  }
})

import { realpathSync } from "node:fs"
import { syncFixture, observeGit, commitChange, syncChild, auditSyncWrites } from "./helpers/rollout-sync.ts"
import { withAmbient } from "./helpers/rollout-loop.ts"
import { recordJobSuccess, staleJobs } from "../src/check/schedule.ts"
import { superStore } from "./helpers/hub-fixture.ts"

// Independent cases keep each missing behavior visible even before runSync exists.
test("ROLL-07 ordered fetch rebase push preserves divergent commits and rejects a zero-exit no-push implementation", async () => {
  const f = await syncFixture(cluster)
  try {
    const git = observeGit(f.root)
    for (const r of f.repos) {
      commitChange(r.path)
      commitChange(r.peer, "peer.txt", "synthetic remote change\n")
      fixtureGit(r.peer, "push", "origin", "main")
    }
    const landed = () => {
      for (const r of f.repos) {
        expect(fixtureGit(f.root, "--git-dir", r.remote, "show", "main:local.txt")).toBe("synthetic local change")
        expect(fixtureGit(f.root, "--git-dir", r.remote, "show", "main:peer.txt")).toBe("synthetic remote change")
        expect(fixtureGit(f.root, "--git-dir", r.remote, "rev-parse", "main")).toBe(fixtureGit(r.path, "rev-parse", "HEAD"))
      }
    }
    const noPush = async () => ({ code: 0 })
    expect((await noPush()).code).toBe(0)
    expect(landed).toThrow()
    await seam("src/sync/run.ts")
    expect((await syncChild(f, git.env)).code).toBe(0)
    landed()
    for (const r of f.repos) {
      const commands = git.events().filter(e => e.cwd === realpathSync(r.path) && e.phase === "start")
      const ordered = commands.filter(e => e.args.some(a => ["fetch", "rebase", "push"].includes(a)))
      expect(ordered.map(e => e.args.find(a => ["fetch", "rebase", "push"].includes(a)))).toEqual(["fetch", "rebase", "push"])
      for (const verb of ["fetch", "push"]) {
        const args = ordered.find(e => e.args.includes(verb))!.args
        expect(args).toContain("origin")
        expect(args.some(a => a === "main" || a === "main:main" || a === "HEAD:main" || a === "HEAD:refs/heads/main")).toBe(true)
        expect(args.some(a => a === "--force" || a === "-f" || a.startsWith("+"))).toBe(false)
      }
    }
  } finally { await f.stop() }
})

for (const refusal of ["wrong branch", "absent remote", "conflict", "fetch", "push", "absent path", "wrong person"] as const) {
  test(`ROLL-07 ${refusal} names the repository cause preserves work and succeeds after repair`, async () => {
    const f = await syncFixture(cluster)
    try {
      const git = observeGit(f.root)
      const r = f.repos[0]
      commitChange(r.path)
      const remoteHead = fixtureGit(f.root, "--git-dir", r.remote, "rev-parse", "main")
      const oldPath = r.path
      if (refusal === "wrong branch") fixtureGit(r.path, "switch", "-c", "other")
      if (refusal === "absent remote") fixtureGit(r.path, "remote", "remove", "origin")
      if (refusal === "conflict") {
        commitChange(r.path, "base.txt", "local conflict\n")
        commitChange(r.peer, "base.txt", "remote conflict\n")
        fixtureGit(r.peer, "push", "origin", "main")
      }
      if (refusal === "fetch" || refusal === "push") git.control({ fail: refusal, path: realpathSync(r.path) })
      if (refusal === "absent path") r.path = join(f.root, "absent")
      if (refusal === "wrong person") r.person = "p2"
      const before = fixtureGit(oldPath, "rev-parse", "HEAD")
      const bytes = readFileSync(join(oldPath, "base.txt"), "utf8")
      f.registry()
      await seam("src/sync/run.ts")
      await syncChild(f, git.env)
      expect((await f.read.sheet("job_success")).find(row => row.id === f.id)).toBeUndefined()
      const result = (await f.read.sheet("sync")).find(row => row.id === f.id)
      expect(result).toBeDefined()
      const evidence = JSON.stringify(result!.data)
      expect(evidence).toContain(r.id)
      // Cause spelling is not pinned. Require the concrete failed operation or input.
      const cause = { "wrong branch": /branch/i, "absent remote": /remote/i,
        conflict: /conflict/i, fetch: /fetch/i, push: /push/i, "absent path": /path|missing|exist/i, "wrong person": /person|owner|tree/i }[refusal]
      expect(evidence).toMatch(cause)
      // Even a stopped conflict must retain the original commit and its bytes.
      expect(fixtureGit(oldPath, "show", `${before}:local.txt`)).toBe("synthetic local change")
      if (refusal !== "conflict") {
        expect(readFileSync(join(oldPath, "base.txt"), "utf8")).toBe(bytes)
        expect(fixtureGit(oldPath, "rev-parse", "HEAD")).toBe(before)
        expect(fixtureGit(f.root, "--git-dir", r.remote, "rev-parse", "main")).toBe(remoteHead)
      } else {
        expect(fixtureGit(oldPath, "show", `${before}:base.txt`)).toBe("local conflict")
        expect(readFileSync(join(oldPath, "base.txt"), "utf8")).toContain("local conflict")
        expect(readFileSync(join(oldPath, "local.txt"), "utf8")).toBe("synthetic local change\n")
        expect(fixtureGit(oldPath, "show", "HEAD:base.txt")).toMatch(/local conflict|remote conflict/)
      }
      expect(fixtureGit(oldPath, "stash", "list")).toBe("")
      // Repair only the refused input, then use the same production path.
      if (refusal === "wrong branch") fixtureGit(oldPath, "switch", "main")
      if (refusal === "absent remote") fixtureGit(oldPath, "remote", "add", "origin", r.remote)
      if (refusal === "conflict") {
        // The owner explicitly aborts an unfinished rebase and resolves the remote input.
        try { fixtureGit(oldPath, "rebase", "--abort") } catch {}
        fixtureGit(r.peer, "revert", "--no-edit", "HEAD")
        fixtureGit(r.peer, "push", "origin", "main")
      }
      r.path = oldPath
      r.person = "p1"
      git.control({})
      f.registry()
      expect((await syncChild(f, git.env)).code).toBe(0)
      expect(fixtureGit(f.root, "--git-dir", r.remote, "show", "main:local.txt")).toBe("synthetic local change")
      expect((await f.read.sheet("job_success")).find(row => row.id === f.id)).toBeDefined()
    } finally { await f.stop() }
  })
}

test("ROLL-31 required nested push failure cannot refresh the authoritative stamp even after both vault pushes land", async () => {
  const f = await syncFixture(cluster)
  const store = await superStore(cluster, f.db)
  try {
    const git = observeGit(f.root)
    const oldAt = "2000-01-01T00:00:00.000Z"
    await recordJobSuccess(store, { entry: f.id, machine: f.machine, at: oldAt })
    for (const r of f.repos) commitChange(r.path)
    git.control({ fail: "push", path: realpathSync(f.repos[2].path) })
    expect((await syncChild(f, git.env, f.id, ["git", "-C", f.repos[2].path, "push", "origin", "main"])).code).toBe(73)
    const noFalseSuccess = async () => {
      expect(fixtureGit(f.root, "--git-dir", f.repos[2].remote, "rev-parse", "main"))
        .not.toBe(fixtureGit(f.repos[2].path, "rev-parse", "HEAD"))
      const stamps = await f.read.sheet("job_success")
      expect(stamps.find(row => row.id === f.id)!.data.at).toBe(oldAt)
      expect(staleJobs({ entries: [f.entry()], stamps, graceSeconds: 0, now: new Date() }).map(v => v.subject)).toContain(f.id)
    }
    await noFalseSuccess()
    // Forbidden control uses the real success writer to forge freshness while
    // the same required remote still lacks its commit.
    await recordJobSuccess(store, { entry: f.id, machine: f.machine })
    await expect(noFalseSuccess()).rejects.toThrow()
    expect(() => fixtureGit(f.root, "--git-dir", f.repos[2].remote, "show", "main:local.txt")).toThrow()
    await recordJobSuccess(store, { entry: f.id, machine: f.machine, at: oldAt })
    await seam("src/sync/run.ts")
    await syncChild(f, git.env)
    for (const r of f.repos.slice(0, 2)) expect(fixtureGit(f.root, "--git-dir", r.remote, "show", "main:local.txt")).toBe("synthetic local change")
    expect(() => fixtureGit(f.root, "--git-dir", f.repos[2].remote, "show", "main:local.txt")).toThrow()
    await noFalseSuccess()
    expect(JSON.stringify((await f.read.sheet("sync")).find(row => row.id === f.id))).toContain("shared")
    git.control({})
    const started = Date.now()
    expect((await syncChild(f, git.env)).code).toBe(0)
    for (const r of f.repos) expect(fixtureGit(f.root, "--git-dir", r.remote, "show", "main:local.txt")).toBe("synthetic local change")
    const stamps = await f.read.sheet("job_success")
    expect(Date.parse(String(stamps.find(row => row.id === f.id)!.data.at))).toBeGreaterThanOrEqual(started)
    expect(staleJobs({ entries: [f.entry()], stamps, graceSeconds: 0, now: new Date() })).toEqual([])
  } finally { await store.close(); await f.stop() }
})

test("ROLL-07 optional nested failure remains a finding with diary and atomic aggregate success", async () => {
  const f = await syncFixture(cluster)
  try {
    f.repos[2].required = false
    f.registry()
    const git = observeGit(f.root)
    git.control({ fail: "push", path: realpathSync(f.repos[2].path) })
    for (const r of f.repos) commitChange(r.path)
    // Audit actual transaction IDs, not timestamp proximity.
    await auditSyncWrites(f)
    await seam("src/sync/run.ts")
    const started = Date.now()
    await syncChild(f, git.env)
    for (const r of f.repos.slice(0, 2)) expect(fixtureGit(f.root, "--git-dir", r.remote, "show", "main:local.txt")).toBe("synthetic local change")
    const success = (await f.read.sheet("job_success")).find(row => row.id === f.id)!
    expect(success).toBeDefined()
    expect(success.data.machine).toBe(f.machine)
    expect(Date.parse(String(success.data.at))).toBeGreaterThanOrEqual(started)
    const syncRow = (await f.read.sheet("sync")).find(row => row.id === f.id)!
    expect(syncRow).toBeDefined()
    const outcome = JSON.stringify(syncRow)
    for (const r of f.repos) expect(outcome).toContain(r.id)
    expect(outcome).toMatch(/push|failed|refused/i)
    const diary = await f.read.ledger({ subject: f.id })
    expect(diary.length).toBeGreaterThan(0)
    expect(diary.every(row => new Date(row.at).getTime() >= started && new Date(row.at).getTime() <= Date.now())).toBe(true)
    expect(JSON.stringify(diary)).toContain("shared")
    const audit = await f.read.sql("select * from sync_audit")
    const stampWrite = audit.find(row => row.sheet === "job_success")!
    expect(stampWrite).toBeDefined()
    expect(audit.some(row => row.sheet === "sync" && row.transaction_id === stampWrite.transaction_id
      && JSON.stringify(row.data) === JSON.stringify(syncRow.data))).toBe(true)
    const lastPush = Math.max(...git.events().filter(e => e.phase === "end" && e.code === 0 && e.args.includes("push")).map(e => e.at))
    expect(Date.parse(String(success.data.at))).toBeGreaterThanOrEqual(lastPush)
    expect(diary.some(row => new Date(row.at).getTime() >= lastPush)).toBe(true)
    // runCheck must expose the optional failure, not merely hide it in a sheet.
    const { runCheck } = await seam("src/check/run.ts")
    const checkStore = await superStore(cluster, f.db)
    try {
      const checked = await (runCheck as Function)({ registryFile: f.registryFile, machine: f.machine, store: checkStore, os: null })
      expect(JSON.stringify(checked)).toContain("shared")
    } finally { await checkStore.close() }
    git.control({})
    expect((await syncChild(f, git.env)).code).toBe(0)
    expect(fixtureGit(f.root, "--git-dir", f.repos[2].remote, "show", "main:local.txt")).toBe("synthetic local change")
  } finally { await f.stop() }
})

for (const alias of [false, true]) test(`ROLL-07 repository lock spans different sync entries ${alias ? "through a symlink alias" : "on the same path"} and prevents overlapping rebases`, async () => {
  const f = await syncFixture(cluster)
  try {
    const second = f.addEntry()
    if (alias) {
      const aliasPath = join(f.root, "vault-alias")
      symlinkSync(f.repos[0].path, aliasPath)
      let text = readFileSync(f.registryFile, "utf8")
      text = text.replace(`repositories = ["p1-vault"]`, `repositories = ["p1-alias"]`)
      text += `\n[[repositories]]\nid = "p1-alias"\nperson = "p1"\npath = ${JSON.stringify(aliasPath)}\nremote = "origin"\nbranch = "main"\nrequired = true\n`
      writeFileSync(f.registryFile, text)
    }
    const git = observeGit(f.root)
    git.control({ delay: 500 })
    const r = f.repos[0]
    commitChange(r.path)
    commitChange(r.peer, "peer.txt", "remote divergence\n")
    fixtureGit(r.peer, "push", "origin", "main")
    const serial = (events: ReturnType<typeof git.events>) => {
      const active = new Set<number>()
      for (const e of events.filter(e => e.cwd === realpathSync(r.path) && e.args.includes("rebase"))) {
        if (e.phase === "start") { active.add(e.pid); expect(active.size).toBe(1) }
        else active.delete(e.pid)
      }
      expect(active.size).toBe(0)
    }
    // Deliberately unlocked real Git calls establish sensitivity before the seam.
    await Promise.all([1, 2].map(() => syncChild(f, git.env, f.id, ["git", "-C", r.path, "rebase", "HEAD"])))
    expect(() => serial(git.events())).toThrow()
    git.clear()
    await seam("src/sync/run.ts")
    const results = await Promise.all([syncChild(f, git.env), syncChild(f, git.env, second)])
    expect(results.some(r => r.code === 0)).toBe(true)
    expect(git.events().some(e => e.args.includes("rebase"))).toBe(true)
    serial(git.events())
    expect(fixtureGit(f.root, "--git-dir", r.remote, "show", "main:local.txt")).toBe("synthetic local change")
    // A lock must be released for the next schedule, including a refused peer.
    expect((await syncChild(f, git.env, second)).code).toBe(0)
  } finally { await f.stop() }
})

test("ROLL-07 configured remote and branch override the upstream and undeclared nested repositories stay untouched", async () => {
  const f = await syncFixture(cluster)
  try {
    const r = f.repos[0]
    const decoy = join(f.root, "decoy.git")
    fixtureGit(f.root, "clone", "--bare", r.remote, decoy)
    const before = fixtureGit(f.root, "--git-dir", decoy, "rev-parse", "main")
    fixtureGit(r.path, "remote", "set-url", "origin", decoy)
    fixtureGit(r.path, "remote", "add", "archive", r.remote)
    fixtureGit(r.path, "branch", "-m", "release")
    fixtureGit(r.path, "push", "archive", "release")
    r.remoteName = "archive"
    r.branch = "release"
    const nested = localRepository(r.path, "undeclared")
    for (const path of ["undeclared", "undeclared-peer", "undeclared-remote.git"]) appendFileSync(join(r.path, ".git", "info", "exclude"), `\n/${path}/\n`)
    commitChange(nested.path, "private.txt", "undeclared synthetic change\n")
    writeFileSync(join(nested.path, "base.txt"), "uncommitted nested change\n")
    commitChange(r.path)
    expect(fixtureGit(r.path, "status", "--porcelain")).toBe("")
    f.registry()
    const git = observeGit(f.root)
    await seam("src/sync/run.ts")
    expect((await syncChild(f, git.env)).code).toBe(0)
    expect(fixtureGit(f.root, "--git-dir", r.remote, "show", "release:local.txt")).toBe("synthetic local change")
    expect(fixtureGit(f.root, "--git-dir", decoy, "rev-parse", "main")).toBe(before)
    expect(() => fixtureGit(f.root, "--git-dir", nested.remote, "show", "main:private.txt")).toThrow()
    expect(readFileSync(join(nested.path, "base.txt"), "utf8")).toBe("uncommitted nested change\n")
    expect(git.events().some(e => e.cwd === realpathSync(nested.path))).toBe(false)
    expect((await f.read.sheet("job_success")).find(row => row.id === f.id)).toBeDefined()
  } finally { await f.stop() }
})

test("L14 a fresh scheduled process recovers a failed push and advances success", async () => {
  const f = await syncFixture(cluster)
  try {
    const r = f.repos[0]
    const wanted = commitChange(r.path)
    const git = observeGit(f.root)
    await seam("src/sync/run.ts")
    git.control({ fail: "push", path: realpathSync(r.path) })
    const oldAt = "2026-01-01T00:00:00.000Z"
    await f.read.sql("insert into state_row (sheet,id,data) values ('job_success',$1,$2)", [f.id, JSON.stringify({ at: oldAt, machine: "pi" })])
    const stamp = await f.read.sheet("job_success")
    expect((await syncChild(f, git.env)).code).not.toBe(0)
    expect(await f.read.sheet("job_success")).toEqual(stamp)
    expect(fixtureGit(f.root, "--git-dir", r.remote, "rev-parse", "main")).not.toBe(wanted)
    git.control({})
    const retryStarted = Date.now()
    expect((await syncChild(f, git.env)).code).toBe(0)
    expect(fixtureGit(f.root, "--git-dir", r.remote, "rev-parse", "main")).toBe(wanted)
    const fresh = (at: string) => {
      expect(Date.parse(at), "D-180a success advances beyond previous stamp").toBeGreaterThan(Date.parse(oldAt))
      expect(Date.parse(at), "D-180a success belongs to this retry").toBeGreaterThanOrEqual(retryStarted)
      expect(Date.parse(at)).toBeLessThanOrEqual(Date.now())
    }
    expect(() => fresh(oldAt)).toThrow()
    fresh((await f.read.sheet("job_success")).find(row => row.id === f.id)!.data.at as string)
  } finally { await f.stop() }
})

test("L14 killed sync owner releases repository lock for the next process", async () => {
  const f = await syncFixture(cluster)
  let child: ReturnType<typeof Bun.spawn> | undefined
  try {
    const git = observeGit(f.root)
    const r = f.repos[0]
    const wanted = commitChange(r.path)
    await seam("src/sync/run.ts")
    git.control({ delay: 1500 })
    child = Bun.spawn([process.execPath, hubPath("src/entry/sync.ts"), f.registryFile, f.id], { env: git.env, stdout: "ignore", stderr: "ignore" })
    expect(await observe(() => git.events().some(e => e.phase === "start" && e.args.includes("rebase")), 5000), "sync owner reached held repository operation").toBe(true)
    child.kill("SIGKILL")
    await child.exited
    expect(child.signalCode).toBe("SIGKILL")
    expect(await observe(() => git.events().some(e => e.phase === "end" && e.args.includes("rebase")), 3500), "orphan Git command finishes before retry").toBe(true)
    git.control({})
    const result = await syncChild(f, git.env)
    expect(result.code, "D-180a dead owner must not retain the lock").toBe(0)
    expect(fixtureGit(f.root, "--git-dir", r.remote, "rev-parse", "main")).toBe(wanted)
    expect((await f.read.sheet("job_success")).some(row => row.id === f.id)).toBe(true)
  } finally { if (child?.exitCode === null) { child.kill(); await child.exited }; await f.stop() }
})

import { observe } from "./helpers/rollout-runner.ts"

// A vault holds its mount as a separate checkout, and the parent's
// status lists it as an untracked directory. The converter gives the mount its
// own sync entry, so the vault's entry does not name it.
test("ROLL-31 a declared repository checked out inside a vault is synced on its own branch and is never the vault's uncommitted change", async () => {
  const f = await syncFixture(cluster)
  try {
    const [vault, , mount] = f.repos
    const own = f.addEntry()
    fixtureGit(mount.path, "branch", "-m", "master")
    fixtureGit(mount.path, "push", "origin", "master")
    mount.branch = "master"
    f.registry()
    const git = observeGit(f.root)
    await seam("src/sync/run.ts")
    const outcome = async (id: string) => {
      const row = (await f.read.sheet("sync")).find(one => one.id === id)!
      return Object.fromEntries((row.data.repositories as { id: string; status: string; code?: string }[]).map(one => [one.id, one.code ?? one.status]))
    }
    // Control: the same path passes while the fixture still hides the mount.
    const hidden = commitChange(vault.path, "hidden.txt")
    expect((await syncChild(f, git.env, own)).code).toBe(0)
    expect(fixtureGit(f.root, "--git-dir", vault.remote, "rev-parse", "main")).toBe(hidden)
    const exclude = join(vault.path, ".git", "info", "exclude")
    writeFileSync(exclude, readFileSync(exclude, "utf8").replace("\n/shared/\n", "\n"))
    expect(fixtureGit(vault.path, "status", "--porcelain")).toBe("?? shared/")
    const vaultHead = commitChange(vault.path)
    const mountHead = commitChange(mount.path, "nested.txt", "synthetic nested change\n")
    const started = Date.now()
    expect((await syncChild(f, git.env, own)).code).toBe(0)
    expect(fixtureGit(f.root, "--git-dir", vault.remote, "rev-parse", "main")).toBe(vaultHead)
    expect(Date.parse(String((await f.read.sheet("job_success")).find(row => row.id === own)!.data.at))).toBeGreaterThanOrEqual(started)
    expect((await syncChild(f, git.env)).code).toBe(0)
    expect(await outcome(f.id)).toEqual({ "p1-vault": "success", "p2-vault": "success", shared: "success" })
    expect(fixtureGit(f.root, "--git-dir", mount.remote, "rev-parse", "master")).toBe(mountHead)
    expect(fixtureGit(mount.path, "symbolic-ref", "--short", "HEAD")).toBe("master")
    expect(fixtureGit(vault.path, "symbolic-ref", "--short", "HEAD")).toBe("main")
    // A real uncommitted change in the vault is committed and pushed, and the
    // mount beside it is never recorded in the vault's commit.
    writeFileSync(join(vault.path, "draft.md"), "uncommitted owner draft\n")
    commitChange(vault.path, "after.txt")
    expect((await syncChild(f, git.env, own)).code).toBe(0)
    expect(await outcome(own)).toEqual({ "p1-vault": "success" })
    expect(fixtureGit(f.root, "--git-dir", vault.remote, "show", "main:draft.md")).toBe("uncommitted owner draft")
    expect(fixtureGit(f.root, "--git-dir", vault.remote, "ls-tree", "--name-only", "main")).not.toContain("shared")
    // A declared path that is not its own checkout hides nothing under it: its
    // loose file is the vault's own work and goes with the vault.
    const plain = join(vault.path, "notes")
    mkdirSync(plain)
    writeFileSync(join(plain, "loose.md"), "uncommitted loose note\n")
    f.repos.push({ ...mount, id: "p1-notes", path: plain, branch: "main" })
    f.registry()
    expect((await syncChild(f, git.env, own)).code).toBe(0)
    expect(fixtureGit(f.root, "--git-dir", vault.remote, "show", "main:notes/loose.md")).toBe("uncommitted loose note")
    f.repos.pop()
    f.registry()
    // The mount's own uncommitted change is committed by the mount's own entry, into the mount.
    writeFileSync(join(mount.path, "base.txt"), "uncommitted nested change\n")
    expect((await syncChild(f, git.env)).code).toBe(0)
    expect(await outcome(f.id)).toEqual({ "p1-vault": "success", "p2-vault": "success", shared: "success" })
    expect(fixtureGit(f.root, "--git-dir", mount.remote, "show", "master:base.txt")).toBe("uncommitted nested change")
    expect(fixtureGit(f.root, "--git-dir", vault.remote, "show", "main:after.txt")).toBe("synthetic local change")
  } finally { await f.stop() }
})

// Agents file notes and never commit them. The sync commits what a person's
// repository holds before it pulls and pushes, so a filed note leaves the
// machine on the next run instead of stopping the vault in both directions.
test("the sync commits a note an agent wrote, then pulls and pushes it, and leaves an embedded checkout out", async () => {
  const f = await syncFixture(cluster)
  try {
    const r = f.repos[0]
    commitChange(r.peer, "peer.txt", "synthetic remote change\n")
    fixtureGit(r.peer, "push", "origin", "main")
    mkdirSync(join(r.path, "vault", "people"), { recursive: true })
    writeFileSync(join(r.path, "vault", "people", "p9.md"), "# a note an agent filed\n")
    writeFileSync(join(r.path, "base.txt"), "an edit an agent made\n")
    // A checkout nobody declared, not excluded: `add` would record it as an embedded repository.
    const scratch = join(r.path, "scratch-checkout")
    mkdirSync(scratch)
    fixtureGit(scratch, "init", "--quiet")
    writeFileSync(join(scratch, "private.txt"), "not the vault's\n")
    const git = observeGit(f.root)
    await seam("src/sync/run.ts")
    const run = await syncChild(f, git.env)
    expect(run.code, run.err).toBe(0)
    expect(fixtureGit(f.root, "--git-dir", r.remote, "show", "main:vault/people/p9.md")).toBe("# a note an agent filed")
    expect(fixtureGit(f.root, "--git-dir", r.remote, "show", "main:base.txt")).toBe("an edit an agent made")
    expect(fixtureGit(f.root, "--git-dir", r.remote, "log", "-1", "--format=%s", "main")).toBe("hub sync: 2 files")
    expect(fixtureGit(f.root, "--git-dir", r.remote, "rev-parse", "main")).toBe(fixtureGit(r.path, "rev-parse", "HEAD"))
    expect(readFileSync(join(r.path, "peer.txt"), "utf8"), "the remote change came back down").toBe("synthetic remote change\n")
    expect(fixtureGit(f.root, "--git-dir", r.remote, "ls-tree", "--name-only", "main")).not.toContain("scratch-checkout")
    const row = (await f.read.sheet("sync")).find(one => one.id === f.id)!
    const repos = row.data.repositories as { id: string; status: string; committed?: number }[]
    expect(repos.find(one => one.id === r.id)).toMatchObject({ status: "success", committed: 2 })
    // A second run with nothing new makes no empty commit.
    const head = fixtureGit(r.path, "rev-parse", "HEAD")
    expect((await syncChild(f, git.env)).code).toBe(0)
    expect(fixtureGit(r.path, "rev-parse", "HEAD")).toBe(head)
  } finally { await f.stop() }
})

test("the sync commits a deletion made with git rm and leaves a checkout somebody staged by hand out of the commit", async () => {
  const f = await syncFixture(cluster)
  try {
    const r = f.repos[0]
    commitChange(r.path, "old.md", "a note that goes\n")
    const git = observeGit(f.root)
    await seam("src/sync/run.ts")
    expect((await syncChild(f, git.env)).code).toBe(0)
    fixtureGit(r.path, "rm", "--quiet", "old.md")
    writeFileSync(join(r.path, "new.md"), "a note that comes\n")
    const scratch = join(r.path, "scratch-checkout")
    mkdirSync(scratch)
    fixtureGit(scratch, "init", "--quiet")
    commitChange(scratch, "private.txt", "not the vault's\n")
    try { fixtureGit(r.path, "add", "scratch-checkout") } catch { /* git warns about an embedded repository and stages it anyway */ }
    for (let run = 1; run <= 2; run++) {
      const done = await syncChild(f, git.env)
      expect(done.code, `run ${run}: ${done.err}`).toBe(0)
    }
    const tree = fixtureGit(f.root, "--git-dir", r.remote, "ls-tree", "--name-only", "main")
    expect(tree).toContain("new.md")
    expect(tree).not.toContain("old.md")
    expect(tree).not.toContain("scratch-checkout")
    expect(fixtureGit(r.path, "diff", "--cached", "--name-only"), "the hand-staged checkout is still staged, untouched").toBe("scratch-checkout")
  } finally { await f.stop() }
})

test("the sync refuses to commit over an unfinished merge or under a filter program the repository's config names", async () => {
  const f = await syncFixture(cluster)
  try {
    const r = f.repos[0]
    const git = observeGit(f.root)
    await seam("src/sync/run.ts")
    const code = async () => {
      await syncChild(f, git.env)
      const row = (await f.read.sheet("sync")).find(one => one.id === f.id)!
      return (row.data.repositories as { id: string; code?: string }[]).find(one => one.id === r.id)!.code
    }
    const marker = join(f.root, "filter-ran")
    fixtureGit(r.path, "config", "filter.planted.clean", `sh -c 'echo ran > ${marker}; cat'`)
    writeFileSync(join(r.path, ".gitattributes"), "*.md filter=planted\n")
    writeFileSync(join(r.path, "note.md"), "a note\n")
    expect(await code()).toBe("config")
    expect(() => readFileSync(marker)).toThrow()
    fixtureGit(r.path, "config", "--unset", "filter.planted.clean")
    rmSync(join(r.path, ".gitattributes"))
    rmSync(join(r.path, "note.md"))
    // A merge stopped on a conflict: the markers must never be committed as the resolution.
    commitChange(r.path, "base.txt", "local side\n")
    fixtureGit(r.path, "switch", "--quiet", "-c", "other", "HEAD~1")
    commitChange(r.path, "base.txt", "other side\n")
    fixtureGit(r.path, "switch", "--quiet", "main")
    try { fixtureGit(r.path, "merge", "other") } catch { /* stops on the conflict, which is the point */ }
    const before = fixtureGit(r.path, "rev-parse", "HEAD")
    expect(await code()).toBe("conflict")
    expect(fixtureGit(r.path, "rev-parse", "HEAD")).toBe(before)
    expect(readFileSync(join(r.path, "base.txt"), "utf8")).toContain("<<<<<<<")
    fixtureGit(r.path, "merge", "--abort")
    expect(await code()).toBeUndefined()
  } finally { await f.stop() }
})

test("three failed runs in a row reach the person in their resident agent's chat, once per streak", async () => {
  const f = await syncFixture(cluster, { chat: true, busy: true })
  try {
    const r = f.repos[0]
    commitChange(r.path)
    const git = observeGit(f.root)
    await seam("src/sync/run.ts")
    git.control({ fail: "push", path: realpathSync(r.path) })
    const notices = async () => await f.read.sql(
      "select person, agent, body, notice_key from outbox where kind = 'notice' and notice_key like 'sync-stuck:%' order by id")
    const row = async () => ((await f.read.sheet("sync")).find(one => one.id === f.id)!.data.repositories as
      { id: string; failed_runs?: number }[]).find(one => one.id === r.id)!
    for (let run = 1; run <= 2; run++) {
      expect((await syncChild(f, git.env)).code).not.toBe(0)
      expect(await notices(), `run ${run} stays in the journal`).toEqual([])
    }
    expect((await row()).failed_runs).toBe(2)
    expect((await syncChild(f, git.env)).code).not.toBe(0)
    const said = await notices()
    expect(said).toHaveLength(1)
    expect(said[0], "the notice goes to the resident agent's chat").toMatchObject({ person: "p1", agent: "p1-lair" })
    expect(String(said[0].body)).toContain(r.id)
    expect(String(said[0].body)).toContain("3 times in a row")
    expect(String(said[0].body)).toContain("push failed")
    // A fourth failure is the same streak, and says nothing new.
    expect((await syncChild(f, git.env)).code).not.toBe(0)
    expect(await notices()).toHaveLength(1)
    expect((await row()).failed_runs).toBe(4)
    git.control({})
    expect((await syncChild(f, git.env)).code).toBe(0)
    expect((await row()).failed_runs).toBeUndefined()
  } finally { await f.stop() }
})
