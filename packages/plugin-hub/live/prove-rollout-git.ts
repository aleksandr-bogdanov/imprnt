// Standalone helper proof. No product behavior is substituted here.
import assert from "node:assert/strict"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fixtureGit, localRepository } from "../test/helpers/rollout-git.ts"

const root = mkdtempSync(join(tmpdir(), "hub-rollout-git-proof-"))
try {
  const repo = localRepository(root, "p1-vault")
  const initial = fixtureGit(repo.path, "rev-parse", "HEAD")
  assert.equal(fixtureGit(repo.peer, "rev-parse", "HEAD"), initial)
  assert.equal(fixtureGit(root, "--git-dir", repo.remote, "rev-parse", "main"), initial)
  assert.equal(fixtureGit(repo.path, "show", "-s", "--format=%an <%ae>"), "p1 <p1@example.invalid>")
  writeFileSync(join(repo.path, "local.txt"), "synthetic local\n")
  fixtureGit(repo.path, "add", "local.txt")
  fixtureGit(repo.path, "commit", "-m", "synthetic local")
  const local = fixtureGit(repo.path, "rev-parse", "HEAD")
  writeFileSync(join(repo.peer, "peer.txt"), "synthetic peer\n")
  fixtureGit(repo.peer, "add", "peer.txt")
  fixtureGit(repo.peer, "commit", "-m", "synthetic peer")
  fixtureGit(repo.peer, "push", "origin", "main")
  assert.notEqual(fixtureGit(root, "--git-dir", repo.remote, "rev-parse", "main"), local)
  fixtureGit(repo.path, "fetch", "origin", "main")
  fixtureGit(repo.path, "rebase", "origin/main")
  fixtureGit(repo.path, "push", "origin", "main")
  assert.equal(fixtureGit(root, "--git-dir", repo.remote, "rev-parse", "main"), fixtureGit(repo.path, "rev-parse", "HEAD"))
  assert.equal(fixtureGit(root, "--git-dir", repo.remote, "show", "main:local.txt"), "synthetic local")
  assert.equal(fixtureGit(root, "--git-dir", repo.remote, "show", "main:peer.txt"), "synthetic peer")
  assert.throws(() => localRepository(root, "../escape"), /invalid fixture/)
  assert.throws(() => fixtureGit(repo.path, "fetch", "https://example.invalid/fixture.git"), /not allowed/)
  console.log("PASS rollout Git helper: divergence, fetch, rebase, push, identity, invalid ID, network refusal")
} finally {
  rmSync(root, { recursive: true, force: true })
}
assert.equal(existsSync(root), false)
console.log("PASS rollout Git helper cleanup")
