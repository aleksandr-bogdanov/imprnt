// Where a declared repository's git copy really is, read off the checkout's
// own configuration as a file, and the two things that depend on the answer.
//
// The box hides another person's tree and state, and it hid nothing else: the
// ordinary layout keeps a vault's bare repository outside the person's tree,
// so the other person's whole history was one read away through their origin.
// The daily off-box copy sent every declared repository, including one whose
// remote is on another host already, which was most of the copy for nothing.
//
// No Postgres and no git: a configuration file is a file.
import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { boxContextFor, otherPeoplesRemotes } from "../src/box/index.ts"
import { repositoriesToCopy } from "../src/backup/run.ts"
import { loadRegistry } from "../src/registry/load.ts"
import { localRemotePath, remoteUrlOf } from "../src/registry/remote.ts"
import { writeRegistry } from "./helpers/registry.ts"

/** A checkout whose only configuration names one remote. */
function checkout(dir: string, name: string, remotes: Record<string, string>, shape: "directory" | "pointer" = "directory"): string {
  const path = join(dir, name)
  const config = Object.entries(remotes).map(([remote, url]) => `[remote "${remote}"]\n\turl = ${url}\n\tfetch = +refs/heads/*:refs/remotes/${remote}/*\n`).join("")
  if (shape === "directory") {
    mkdirSync(join(path, ".git"), { recursive: true })
    writeFileSync(join(path, ".git", "config"), `[core]\n\tbare = false\n${config}`)
  } else {
    const real = join(dir, `${name}-gitdir`)
    mkdirSync(real, { recursive: true })
    mkdirSync(path, { recursive: true })
    writeFileSync(join(path, ".git"), `gitdir: ${real}\n`)
    writeFileSync(join(real, "config"), config)
  }
  return path
}

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "hub-remote-"))
  return { dir, stop: () => rmSync(dir, { recursive: true, force: true }) }
}

test("the remote url is read off the checkout's configuration, a pointer .git is followed, and only a path on this box is a local remote", () => {
  const it = scratch()
  try {
    const bare = join(it.dir, "remotes", "vault.git")
    const local = checkout(it.dir, "local", { origin: bare, upstream: "git@example.invalid:x/y.git" })
    expect(remoteUrlOf(local, "origin")).toBe(bare)
    expect(remoteUrlOf(local, "upstream")).toBe("git@example.invalid:x/y.git")
    expect(remoteUrlOf(local, "nowhere")).toBeNull()
    expect(localRemotePath(local, "origin")).toBe(bare)
    expect(localRemotePath(local, "upstream"), "an ssh remote is off the box").toBeNull()
    const pointed = checkout(it.dir, "pointed", { origin: "../remotes/other.git" }, "pointer")
    expect(localRemotePath(pointed, "origin"), "a relative path is resolved against the checkout").toBe(join(it.dir, "remotes", "other.git"))
    const file = checkout(it.dir, "file-url", { origin: `file://${bare}` })
    expect(localRemotePath(file, "origin")).toBe(bare)
    const https = checkout(it.dir, "https", { origin: "https://github.invalid/x/y.git" })
    expect(localRemotePath(https, "origin")).toBeNull()
    expect(remoteUrlOf(join(it.dir, "not-a-checkout"), "origin")).toBeNull()
  } finally { it.stop() }
})

test("the box hides the git copy of every repository another person declares, and not one this person's own repositories share", () => {
  const it = scratch()
  try {
    const bareP1 = join(it.dir, "remotes", "p1-vault.git"), bareP2 = join(it.dir, "remotes", "p2-vault.git")
    const zone = join(it.dir, "remotes", "shared-notes.git")
    const p1 = join(it.dir, "p1"), p2 = join(it.dir, "p2")
    mkdirSync(p1, { recursive: true }); mkdirSync(p2, { recursive: true })
    checkout(p1, "vault-project", { origin: bareP1 })
    checkout(p2, "vault-project", { origin: bareP2 })
    checkout(join(p1, "vault-project", "vault"), "shared-notes", { origin: zone })
    checkout(join(p2, "vault-project", "vault"), "shared-notes", { origin: zone })
    const file = writeRegistry(it.dir, {
      hub: { state_dir: join(it.dir, "state") },
      people: [{ id: "p1", tree: p1 }, { id: "p2", tree: p2 }],
      presets: { daily: { adapter: "a", model: "m", provider: "p", effort: "medium", paid: "key" } },
      agents: [{ id: "p1-lair", person: "p1", preset: "daily", chat: "0000000000", door: "door-fake", runner: "runner-pi" }],
      repositories: [
        { id: "p1-vault", person: "p1", path: join(p1, "vault-project"), remote: "origin", branch: "main", required: true },
        { id: "p2-vault", person: "p2", path: join(p2, "vault-project"), remote: "origin", branch: "main", required: true },
        { id: "p1-zone", person: "p1", path: join(p1, "vault-project", "vault", "shared-notes"), remote: "origin", branch: "main", required: true },
        { id: "p2-zone", person: "p2", path: join(p2, "vault-project", "vault", "shared-notes"), remote: "origin", branch: "main", required: true },
      ],
    })
    const registry = loadRegistry(file)
    expect(otherPeoplesRemotes(registry, "p1")).toEqual([bareP2])
    const ctx = boxContextFor(registry, "p1-lair")
    expect(ctx.otherTrees).toContain(p2)
    expect(ctx.otherTrees, "the other person's git copy is hidden").toContain(bareP2)
    expect(ctx.otherTrees, "this person's own copy is not").not.toContain(bareP1)
    expect(ctx.otherTrees, "the shared zone's copy is both people's and stays reachable").not.toContain(zone)
  } finally { it.stop() }
})

test("the off-box copy leaves out a repository whose remote is on another host, and keeps one whose only copy is here", () => {
  const it = scratch()
  try {
    const p1 = join(it.dir, "p1")
    mkdirSync(p1, { recursive: true })
    const vault = checkout(p1, "vault-project", { origin: join(it.dir, "remotes", "p1-vault.git") })
    const elsewhere = checkout(p1, "whenful", { origin: "git@github.invalid:household/whenful.git" })
    const unnamed = join(p1, "notes")
    mkdirSync(unnamed, { recursive: true })
    const file = writeRegistry(it.dir, {
      hub: { state_dir: join(it.dir, "state") },
      people: [{ id: "p1", tree: p1 }],
      presets: { daily: { adapter: "a", model: "m", provider: "p", effort: "medium", paid: "key" } },
      agents: [{ id: "p1-lair", person: "p1", preset: "daily", chat: "0000000000", door: "door-fake", runner: "runner-pi" }],
      repositories: [
        { id: "p1-vault", person: "p1", path: vault, remote: "origin", branch: "main", required: true },
        { id: "whenful", person: "p1", path: elsewhere, remote: "origin", branch: "main", required: false },
        { id: "notes", person: "p1", path: unnamed, remote: "origin", branch: "main", required: false },
      ],
    })
    const { copied, leftOut } = repositoriesToCopy(loadRegistry(file))
    expect(copied.map(r => r.id).sort()).toEqual(["notes", "p1-vault"])
    expect(leftOut.map(r => r.id)).toEqual(["whenful"])
  } finally { it.stop() }
})
