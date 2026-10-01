// A synthetic household for the workspace half of a move: one person whose vault is a checkout of a bare remote, with the shared zone mounted inside
// it as a checkout of another and a project checkout beside it, on two machines (`pi`, the source, and `mac`, the destination) that are two
// directories of one scratch root, each synced by its own `[[run]]` entry. Every remote is a local bare repository and nothing reaches a network.
// The registry parts it returns go into `writeRegistry` (and `writeMoveRegistry` of the runtime tests).

import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fixtureGit } from "./rollout-git.ts"

export interface Checkout { id: string; remote: string; src: string; dst: string }

export function stageHousehold(root: string, ids: readonly string[] = ["vault", "zone", "proj"]) {
  const tree = { pi: join(root, "pi", "p1"), mac: join(root, "mac", "p1") }
  const where = (machine: "pi" | "mac", id: string) => id === "vault" ? tree[machine] : id === "zone" ? join(tree[machine], "vault", "zone") : join(tree[machine], id)
  const put = (repo: string, rel: string, text: string) => { mkdirSync(dirname(join(repo, rel)), { recursive: true }); writeFileSync(join(repo, rel), text) }
  const checkouts: Record<string, Checkout> = {}
  // The vault first: the zone and the project are inside its tree, and the vault's own history never holds them.
  for (const id of [...ids].sort((a, b) => (a === "vault" ? -1 : b === "vault" ? 1 : 0))) {
    const remote = join(root, `${id}.git`)
    const src = where("pi", id)
    const dst = where("mac", id)
    fixtureGit(root, "init", "--bare", "--initial-branch=main", remote)
    mkdirSync(src, { recursive: true })
    fixtureGit(src, "init", "--initial-branch=main")
    put(src, ".gitignore", "ignored.log\n")
    put(src, "notes/start.md", `${id} notes\n`)
    if (id === "vault") put(src, "CLAUDE.md", "house rules of the synthetic vault\n")
    fixtureGit(src, "add", ".")
    fixtureGit(src, "commit", "-m", `${id} start`)
    fixtureGit(src, "remote", "add", "origin", remote)
    fixtureGit(src, "push", "--set-upstream", "origin", "main")
    mkdirSync(dirname(dst), { recursive: true })
    fixtureGit(root, "clone", "-q", remote, dst)
    checkouts[id] = { id, remote, src, dst }
  }
  const declared = ids.map(id => ({
    id, person: "p1", path: checkouts[id].src, remote: "origin", branch: "main", ...(id === "zone" ? { zone: true } : {}),
    on: { mac: { path: checkouts[id].dst } },
  }))
  const sync = (machine: "pi" | "mac", listed: readonly string[] = ids) => ({ id: `sync-${machine}`, kind: "sync", machine, schedule: "every 15m", memory_limit_mb: 128, repositories: [...listed] })
  return {
    tree, checkouts,
    /** What the registry needs, for the person and the repositories (and the zone, when it is one of them). */
    registry: {
      person: { tree: tree.pi, vault: tree.pi, on: { mac: { tree: tree.mac, vault: tree.mac } } },
      repositories: declared,
      ...(ids.includes("zone") ? { zone: { mount: "zone", remote: "origin", url: `file://${join(root, "zone.git")}` } } : {}),
      run: [sync("pi"), sync("mac")],
    },
    sync,
    /** A commit of `text` into `rel` of the checkout at `repo`, and its id. */
    commit(repo: string, rel: string, text: string, message = "change"): string {
      put(repo, rel, text)
      fixtureGit(repo, "add", rel)
      fixtureGit(repo, "commit", "-m", message)
      return fixtureGit(repo, "rev-parse", "HEAD")
    },
    push: (repo: string) => fixtureGit(repo, "push", "origin", "main"),
    pull: (repo: string) => fixtureGit(repo, "pull", "-q", "--ff-only", "origin", "main"),
    put,
    git: (repo: string, ...args: string[]) => fixtureGit(repo, ...args),
    head: (repo: string) => fixtureGit(repo, "rev-parse", "HEAD"),
  }
}
export type Household = ReturnType<typeof stageHousehold>
