// The sync runs git outside any box, in repositories an agent can write, and
// a repository's own hooks are programs git runs on its behalf. An agent that
// plants one would have it run by the sync, unboxed, as the household's
// account. So the sync runs every git call with hooks turned off, which is what
// the off-box copy already does for its own repository.
//
// The scene is run against PLAIN git, never the observing shim other sync
// checks use, because that shim turns hooks off itself and would hide the
// defect. The control plants the same hooks in the second person's vault and
// runs the sync's own three operations there with plain git, which proves the
// hooks are executable and fire for exactly what the sync does.
import { afterAll, beforeAll, expect, test } from "bun:test"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { startCluster, type Cluster } from "./helpers/cluster.ts"
import { fixtureGit } from "./helpers/rollout-git.ts"
import { commitChange, syncChild, syncFixture } from "./helpers/rollout-sync.ts"

let cluster: Cluster
beforeAll(async () => { cluster = await startCluster() })
afterAll(async () => { await cluster?.stop() })

const HOOKS = ["pre-rebase", "post-rewrite", "pre-push", "reference-transaction", "post-checkout", "post-merge"]

/** Every hook the sync's operations could reach, each noting its own name in `marker`. */
function plantHooks(repository: string, marker: string): void {
  for (const hook of HOOKS) {
    writeFileSync(join(repository, ".git", "hooks", hook), `#!/bin/sh\necho ${hook} >> ${JSON.stringify(marker)}\n`, { mode: 0o755 })
  }
}

/** A local commit and a remote one the local branch lacks, so a rebase rewrites and a push moves the remote. */
function diverge(repo: { path: string; peer: string }): void {
  commitChange(repo.path)
  commitChange(repo.peer, "peer.txt", "synthetic remote change\n")
  fixtureGit(repo.peer, "push", "origin", "main")
}

function plainGit(cwd: string, env: Record<string, string>, ...args: string[]): void {
  const result = Bun.spawnSync(["git", ...args], { cwd, env, stdout: "pipe", stderr: "pipe" })
  if (result.exitCode !== 0) throw new Error(`plain git ${args[0]} failed: ${result.stderr.toString()}`)
}

test("a hook an agent planted in a synced repository does not run when the sync runs", async () => {
  const f = await syncFixture(cluster)
  try {
    const env = Object.fromEntries(Object.entries({
      ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0",
      GIT_ALLOW_PROTOCOL: "file", GIT_AUTHOR_NAME: "p1", GIT_AUTHOR_EMAIL: "p1@example.invalid",
      GIT_COMMITTER_NAME: "p1", GIT_COMMITTER_EMAIL: "p1@example.invalid",
    }).filter((pair): pair is [string, string] => typeof pair[1] === "string"))
    const [planted, control] = f.repos
    const plantedMarker = join(f.root, "planted-hooks-ran")
    const controlMarker = join(f.root, "control-hooks-ran")
    for (const repo of [planted, control]) diverge(repo)
    plantHooks(planted.path, plantedMarker)
    plantHooks(control.path, controlMarker)

    // The control: the sync's own three operations with plain git fire the hooks.
    plainGit(control.path, env, "fetch", "--", "origin", "main")
    plainGit(control.path, env, "-c", "rebase.autoStash=false", "rebase", "FETCH_HEAD")
    plainGit(control.path, env, "push", "--", "origin", "HEAD:refs/heads/main")
    const fired = readFileSync(controlMarker, "utf8").trim().split("\n")
    for (const hook of ["pre-rebase", "post-rewrite", "pre-push"]) expect(fired, `${hook} fires under plain git`).toContain(hook)

    const run = await syncChild(f, env)
    expect(run.code, run.err).toBe(0)
    // The sync did its work in the planted repository...
    expect(fixtureGit(f.root, "--git-dir", planted.remote, "show", "main:local.txt")).toBe("synthetic local change")
    expect(fixtureGit(f.root, "--git-dir", planted.remote, "rev-parse", "main")).toBe(fixtureGit(planted.path, "rev-parse", "HEAD"))
    // ...and none of the hooks planted there ran.
    expect(existsSync(plantedMarker) ? readFileSync(plantedMarker, "utf8") : "").toBe("")
  } finally { await f.stop() }
}, 60_000)
