// The workspace half of a move (`move-workspace.ts`): the person's declared repositories, each kept in step by the sync of BOTH machines, looked at under
// the sync's own lock. The source must be clean and on one exact commit its remote-tracking ref holds; the destination must be clean and at EXACTLY that
// commit, observed there and then. Dirt, a descendant commit and a commit not yet pulled are named, never repaired. Real scratch git repositories with
// local bare remotes (`stageHousehold`) and a disposable Postgres for the lock; nothing reaches a network and no real data is read.

import { afterAll, afterEach, beforeAll, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { startCluster, type Cluster } from "./helpers/cluster.ts"
import { moveStage } from "./helpers/move-store-stage.ts"
import { stageHousehold, type Household } from "./helpers/move-workspace-stage.ts"
import { writeRegistry, type PersonSpec, type RepositorySpec, type RunSpec } from "./helpers/registry.ts"
import { loadRegistry, type Registry } from "../src/registry/load.ts"
import { sha256, stableText, type WorkspaceVerdict } from "../src/runner/move-handoff.ts"
import { scopeOf } from "../src/runner/move-scope.ts"
import { RECHECK, observeDest, observeSource, workspaceFactsOf, workspacePlanOf, workspaceShapeOf, MOVE_WORKSPACE_REPOSITORIES } from "../src/runner/move-workspace.ts"
import type { MoveRow } from "../src/store/moves.ts"
import { syncLockKey } from "../src/sync/run.ts"

let cluster: Cluster
const mine: { close(): Promise<void> }[] = []
const made: string[] = []
beforeAll(async () => { cluster = await startCluster() })
afterEach(async () => { for (const one of mine.splice(0)) await one.close().catch(() => {}) })
afterAll(async () => { for (const dir of made) rmSync(dir, { recursive: true, force: true }); await cluster?.stop() })

const SLOW = 120_000
const scratch = (): string => { const dir = realpathSync(mkdtempSync(join(tmpdir(), "ws-"))); made.push(dir); return dir }
const track = <T extends { close(): Promise<void> }>(sql: T): T => { mine.push(sql); return sql }
const PROFILE = { model: "m", tools: "t1" }

interface Rig { root: string; h: Household; file: string; registry: (machine: "pi" | "mac") => Registry }
function rig(ids?: readonly string[], over: { repositories?: RepositorySpec[]; run?: RunSpec[]; person?: Record<string, unknown> } = {}): Rig {
  const root = scratch()
  const h = stageHousehold(root, ids)
  const file = writeRegistry(root, {
    hub: { state_dir: join(root, "state"), store_url: "postgres://127.0.0.1:1/unused" },
    machines: [{ id: "pi", os: "linux" }, { id: "mac", os: "macos" }],
    people: [{ id: "p1", ...h.registry.person, ...over.person } as PersonSpec],
    presets: { daily: { adapter: "a-scripted-adapter", model: "m", provider: "p", effort: "medium", paid: "key" } },
    agents: [{ id: "a1", person: "p1", preset: "daily", chat: "1000000001", door: "door-fake", runner: "runner-pi" }],
    run: [
      { id: "door-fake", kind: "door", machine: "pi", platform: "fake", person: "p1", token_file: "/dev/null", schedule: "always", memory_limit_mb: 192 },
      { id: "runner-pi", kind: "runner", machine: "pi", schedule: "always", memory_limit_mb: 512, child_memory_limit_mb: 512 },
      { id: "runner-mac", kind: "runner", machine: "mac", schedule: "always", memory_limit_mb: 512, child_memory_limit_mb: 512 },
      ...(over.run ?? h.registry.run),
    ],
    repositories: over.repositories ?? h.registry.repositories,
    ...(h.registry.zone ? { zone: h.registry.zone } : {}),
  })
  return { root, h, file, registry: machine => loadRegistry(file, { machine }) }
}

const moveOf = (over: Record<string, unknown> = {}): MoveRow =>
  ({ id: "m1", person: "p1", agent: "a1", source_machine: "pi", dest_machine: "mac", export_generation: 3, manifest: null, dest_facts: null, ...over }) as unknown as MoveRow

const ok = (verdict: WorkspaceVerdict) => { if (!verdict.ok) throw new Error(`refused: ${verdict.code} ${JSON.stringify(verdict.detail)}`); return verdict }
/** A refusal flattened to its code and its detail fields, which differ by code: the assertions name the fields each code carries. */
type Refusal = { code: string } & Record<string, unknown>
const refused = (verdict: WorkspaceVerdict): Refusal => { if (verdict.ok) throw new Error("passed"); return { ...verdict.detail, code: verdict.code } }

/** The sealed manifest section the way `exportSource` builds it, and the destination's preflight facts, for a move between the two views. */
async function sealed(r: Rig, ctx: { storeUrl: string }, over: Record<string, unknown> = {}) {
  const move = moveOf({ dest_facts: { profile: PROFILE } })
  const seen = ok(await observeSource({ registry: r.registry("pi"), storeUrl: ctx.storeUrl }, move))
  await seen.hold.release()
  const workspace = { ...seen.sealed, generation: 3, profile: sha256(stableText(PROFILE)), ...over }
  const facts = workspaceFactsOf(r.registry("mac"), move)
  if (!facts || "refused" in facts) throw new Error("the destination cannot take it")
  return moveOf({ manifest: { workspace }, dest_facts: { profile: PROFILE, workspace: { version: 1, ...facts } } })
}

// ---------------------------------------------------------------------------------------------------------------------
// the plan
// ---------------------------------------------------------------------------------------------------------------------

test("WS-1: the plan is the declared repositories, with the nested checkouts proved separate; both machines derive the same plan and each its own roots", () => {
  const r = rig()
  const look = (machine: "pi" | "mac") => { const found = workspacePlanOf(r.registry(machine), "p1", { source: "pi", dest: "mac" }); if (found.kind !== "plan") throw new Error(JSON.stringify(found)); return found.plan }
  const src = look("pi")
  const dst = look("mac")
  expect(src.repos.map(one => [one.id, one.nested])).toEqual([["proj", []], ["vault", ["proj", "vault/zone"]], ["zone", []]])
  expect(dst.plan, "machine-neutral").toBe(src.plan)
  expect(dst.roots, "each machine's own paths").not.toBe(src.roots)
  expect(workspaceFactsOf(r.registry("mac"), moveOf())).toMatchObject({ plan: src.plan, roots: dst.roots, repositories: 3 })

  // A person that declares nothing has nothing to verify.
  const none = rig([], { person: { vault: undefined, on: undefined }, repositories: [], run: [] })
  expect(workspacePlanOf(none.registry("pi"), "p1", { source: "pi", dest: "mac" })).toEqual({ kind: "none" })
})

test("WS-2: a repository either machine's sync does not keep in step, a vault nothing covers and too many repositories are named refusals", () => {
  const r = rig()
  const refuse = (registry: Registry) => workspacePlanOf(registry, "p1", { source: "pi", dest: "mac" })
  const unsyncedOnMac = rig(undefined, { run: [r.h.sync("pi"), r.h.sync("mac", ["vault", "zone"])] })
  expect(refuse(unsyncedOnMac.registry("pi"))).toEqual({ kind: "refused", refused: "repository_unsynced", detail: { repositories: ["proj"], machine: "mac" } })
  const unsyncedOnPi = rig(undefined, { run: [r.h.sync("pi", ["vault"]), r.h.sync("mac")] })
  expect(refuse(unsyncedOnPi.registry("pi"))).toEqual({ kind: "refused", refused: "repository_unsynced", detail: { repositories: ["proj", "zone"], machine: "pi" } })
  // An entry the owner switched off does not keep anything in step.
  const off = rig(undefined, { run: [r.h.sync("pi"), { ...r.h.sync("mac"), enabled: false }] })
  expect(refuse(off.registry("pi"))).toMatchObject({ refused: "repository_unsynced", detail: { machine: "mac" } })

  // A vault is declared and only a project is: nothing covers the vault.
  const vaultless = rig(["proj"])
  expect(refuse(vaultless.registry("pi"))).toEqual({ kind: "refused", refused: "dependency_unverified", detail: { dependencies: ["vault"] } })

  const many: RepositorySpec[] = Array.from({ length: MOVE_WORKSPACE_REPOSITORIES + 1 }, (_, n) => ({ id: `r${n}`, person: "p1", path: join(r.h.tree.pi, `r${n}`), remote: "origin", branch: "main", on: { mac: { path: join(r.h.tree.mac, `r${n}`) } } }))
  const crowded = rig(["proj"], { repositories: many, run: [r.h.sync("pi", many.map(one => one.id!)), r.h.sync("mac", many.map(one => one.id!))], person: { vault: undefined, on: { mac: { tree: r.h.tree.mac } } } })
  expect(refuse(crowded.registry("pi"))).toEqual({ kind: "refused", refused: "too_many_repositories", detail: { count: MOVE_WORKSPACE_REPOSITORIES + 1 } })
})

test("WS-2b: with repositories declared the person's tree must be covered by them: an entry that is a repository is, a stray file beside them is local content refused by count, and the proof states what was verified", () => {
  const r = rig(["proj"], { person: { vault: undefined, on: { mac: { tree: join(scratch(), "mac-tree") } } } })
  const move = moveOf({ drain: { incarnation: "i", export_generation: 3 }, conversation_id: "c1" })
  const registry = r.registry("pi")
  const proof = scopeOf(registry, move)
  if (proof === null || !("basis" in proof)) throw new Error(`no proof: ${JSON.stringify(proof)}`)
  expect(proof.carries).toBe("native+workspace")
  expect(proof.basis).toContain("1 repositories synced on both machines are verified at the handoff, not carried")
  expect(proof.basis.length, "the sealed basis is bounded").toBeLessThanOrEqual(256)

  writeFileSync(join(r.h.tree.pi, "stray-note.md"), "words that exist on this machine only")
  const refusal = scopeOf(registry, move)
  expect(refusal).toEqual({ refused: "workspace_carriage_required", detail: { local_tree: { entries: 1 } } })
  expect(JSON.stringify(refusal), "no name and no content").not.toMatch(/stray-note|words that exist/)
  // A repository the sync of one machine does not keep: named before the tree is even looked at.
  const unsynced = rig(["proj"], { run: [r.h.sync("pi", ["proj"])], person: { vault: undefined, on: { mac: { tree: join(scratch(), "mac-tree") } } } })
  expect(scopeOf(unsynced.registry("pi"), move)).toEqual({ refused: "repository_unsynced", detail: { repositories: ["proj"], machine: "mac" } })
})

// ---------------------------------------------------------------------------------------------------------------------
// the source
// ---------------------------------------------------------------------------------------------------------------------

test("WS-3: the source passes when every repository is clean on its branch at a commit its remote-tracking ref holds, seals what it saw, and holds the sync locks until released", async () => {
  const r = rig()
  const s = await moveStage(cluster, track)
  const ctx = { registry: r.registry("pi"), storeUrl: s.tool.url }
  // What stays behind is counted, never carried: an ignored file, and an untracked credential-shaped one.
  r.h.put(r.h.checkouts.proj.src, "ignored.log", "noise\n")
  r.h.put(r.h.checkouts.proj.src, ".env", "KEY=1\n")
  const seen = ok(await observeSource(ctx, moveOf({ dest_facts: { profile: PROFILE } })))
  expect(seen.sealed).toMatchObject({ version: 1, repos: [
    { id: "proj", head: r.h.head(r.h.checkouts.proj.src), branch: "main", ignored: 1, withheld: 1 },
    { id: "vault", head: r.h.head(r.h.checkouts.vault.src), branch: "main", ignored: 0, withheld: 0 },
    { id: "zone", head: r.h.head(r.h.checkouts.zone.src), branch: "main", ignored: 0, withheld: 0 },
  ] })
  expect(JSON.stringify(seen.sealed), "no path, no file name").not.toContain(r.root)

  // The sync's lock is HELD for as long as the caller keeps the hold (its release is committed under it), and free after.
  const probe = async (repo: string) => {
    const connection = await s.tool.sql.reserve()
    try {
      const key = syncLockKey("pi", realpathSync(join(repo, ".git")))
      const [row] = await connection`select pg_try_advisory_lock(hashtextextended(${key}, 0)) as held`
      if (row.held) await connection`select pg_advisory_unlock(hashtextextended(${key}, 0))`
      return row.held as boolean
    } finally { connection.release() }
  }
  for (const id of ["vault", "zone", "proj"]) expect(await probe(r.h.checkouts[id].src), `${id} is locked`).toBe(false)
  await seen.hold.release()
  for (const id of ["vault", "zone", "proj"]) expect(await probe(r.h.checkouts[id].src), `${id} is free`).toBe(true)
}, SLOW)

test("WS-4: dirt, an unpushed commit, another branch, a half-done operation and a sync running are each named at the source, and each clears when it is repaired", async () => {
  const r = rig()
  const s = await moveStage(cluster, track)
  const ctx = { registry: r.registry("pi"), storeUrl: s.tool.url }
  const look = async () => refused(await observeSource(ctx, moveOf({ dest_facts: { profile: PROFILE } })))
  const vault = r.h.checkouts.vault.src
  const proj = r.h.checkouts.proj.src

  // An edit of a tracked file, and an untracked file the sync would commit: dirt, with counts and no name.
  r.h.put(proj, "notes/start.md", "edited by the agent\n")
  r.h.put(proj, "notes/new.md", "new\n")
  expect(await look()).toEqual({ code: "workspace_unsynced", repository: "proj", reason: "dirty", changed: 1, untracked: 1 })
  // The sync commits and pushes: the very next look passes.
  r.h.git(proj, "add", "-A")
  r.h.git(proj, "commit", "-m", "hub sync")
  expect(await look(), "committed, not pushed").toEqual({ code: "workspace_unpushed", repository: "proj" })
  r.h.push(proj)
  await ok(await observeSource(ctx, moveOf({ dest_facts: { profile: PROFILE } }))).hold.release()

  r.h.git(vault, "checkout", "-q", "-b", "side")
  expect(await look()).toEqual({ code: "workspace_branch", repository: "vault" })
  r.h.git(vault, "checkout", "-q", "main")

  // A file in the vault next to the nested zone checkout is the vault's own dirt: the nested name sets aside the checkout and nothing else.
  r.h.put(vault, "vault/filed.md", "filed by the agent\n")
  expect(await look()).toMatchObject({ code: "workspace_unsynced", repository: "vault", reason: "dirty", untracked: 1 })
  rmSync(join(vault, "vault", "filed.md"))

  // Dirt inside the nested checkout is that repository's, found by its own entry.
  r.h.put(r.h.checkouts.zone.src, "notes/zone-note.md", "zone note\n")
  expect(await look()).toMatchObject({ code: "workspace_unsynced", repository: "zone", reason: "dirty" })
  rmSync(join(r.h.checkouts.zone.src, "notes", "zone-note.md"))

  // A conflict half resolved is an operation, never recovered here.
  r.h.git(vault, "checkout", "-q", "-b", "topic")
  r.h.commit(vault, "notes/start.md", "topic\n", "topic")
  r.h.git(vault, "checkout", "-q", "main")
  r.h.commit(vault, "notes/start.md", "main\n", "main")
  r.h.push(vault)
  expect(() => r.h.git(vault, "merge", "topic")).toThrow()
  expect(await look()).toMatchObject({ code: "workspace_unsynced", repository: "vault", reason: "operation" })
  r.h.git(vault, "merge", "--abort")

  // The remote moved on (someone else pushed) and this checkout fetched it: a head behind the remote's tip is a commit the destination's sync can never be at
  // exactly, so it waits for the sync to take the checkout to the tip.
  const peer = join(r.root, "peer-proj")
  r.h.git(r.root, "clone", "-q", r.h.checkouts.proj.remote, peer)
  r.h.commit(peer, "notes/peer.md", "from elsewhere\n", "peer")
  r.h.git(peer, "push", "-q", "origin", "main")
  r.h.git(proj, "fetch", "-q", "origin")
  expect(await look()).toEqual({ code: "workspace_unsynced", repository: "proj", reason: "behind-remote" })
  r.h.pull(proj)

  // The sync is running right now (it holds the lock): a named wait, and nothing was read from the checkout.
  const held = await s.tool.sql.reserve()
  const key = syncLockKey("pi", realpathSync(join(proj, ".git")))
  await held`select pg_advisory_lock(hashtextextended(${key}, 0))`
  try { expect(await look()).toEqual({ code: "workspace_unsynced", reason: "sync-running" }) } finally {
    await held`select pg_advisory_unlock(hashtextextended(${key}, 0))`
    held.release()
  }
  const seen = ok(await observeSource(ctx, moveOf({ dest_facts: { profile: PROFILE } })))
  expect(seen.sealed.repos).toHaveLength(3)
  await seen.hold.release()
}, SLOW)

test("WS-5: a checkout reached through a link, a missing checkout and a plan the registry no longer makes are never skipped or guessed", async () => {
  const r = rig()
  const s = await moveStage(cluster, track)
  const look = async (registry: Registry) => refused(await observeSource({ registry, storeUrl: s.tool.url }, moveOf({ dest_facts: { profile: PROFILE } })))

  // The zone's path is a link to a checkout outside the vault: it is not "nested" (its real path is elsewhere), so the vault sees an untracked link and is dirty.
  const elsewhere = join(r.root, "elsewhere-zone")
  r.h.git(r.root, "clone", "-q", r.h.checkouts.zone.remote, elsewhere)
  rmSync(r.h.checkouts.zone.src, { recursive: true })
  symlinkSync(elsewhere, r.h.checkouts.zone.src)
  expect(await look(r.registry("pi"))).toMatchObject({ code: "workspace_unsynced", repository: "vault", reason: "dirty", untracked: 1 })
  rmSync(r.h.checkouts.zone.src)

  // No checkout at the declared path: named, with the library's code and no path.
  const gone = await look(r.registry("pi"))
  expect(gone).toEqual({ code: "workspace_unavailable", repository: "zone", why: "root-invalid" })
  expect(JSON.stringify(gone)).not.toContain(r.root)

  // The registry no longer makes the plan the proof was for: the look refuses to invent one.
  const none = rig([], { person: { vault: undefined, on: undefined }, repositories: [], run: [] })
  expect(await look(none.registry("pi"))).toEqual({ code: "workspace_plan_mismatch", why: "none-declared" })
}, SLOW)

// ---------------------------------------------------------------------------------------------------------------------
// the destination
// ---------------------------------------------------------------------------------------------------------------------

test("WS-6: the destination passes at exactly the sealed commit, whatever it keeps of its own that is ignored or credential-shaped, and holds the locks until released", async () => {
  const r = rig()
  const s = await moveStage(cluster, track)
  const move = await sealed(r, { storeUrl: s.tool.url })
  r.h.put(r.h.checkouts.vault.dst, "ignored.log", "its own noise\n")
  r.h.put(r.h.checkouts.vault.dst, ".env", "ITS_OWN=1\n")
  const seen = ok(await observeDest({ registry: r.registry("mac"), storeUrl: s.tool.url }, move))
  const connection = await s.tool.sql.reserve()
  try {
    const key = syncLockKey("mac", realpathSync(join(r.h.checkouts.vault.dst, ".git")))
    const [row] = await connection`select pg_try_advisory_lock(hashtextextended(${key}, 0)) as held`
    expect(row.held, "locked while held").toBe(false)
  } finally { connection.release() }
  await seen.hold.release()
}, SLOW)

test("WS-7: a dirty destination is refused and left exactly as it was; its dirt is never taken for the source's content", async () => {
  const r = rig()
  const s = await moveStage(cluster, track)
  const move = await sealed(r, { storeUrl: s.tool.url })
  const ctx = { registry: r.registry("mac"), storeUrl: s.tool.url }
  const proj = r.h.checkouts.proj.dst
  const head = r.h.head(proj)

  r.h.put(proj, "notes/start.md", "the destination's own edit\n")
  r.h.put(proj, "mine.md", "mine\n")
  expect(refused(await observeDest(ctx, move))).toEqual({ code: "dest_workspace_dirty", repository: "proj", changed: 1, untracked: 1, conflicted: 0 })
  expect(r.h.head(proj), "nothing was reset, committed or cleaned").toBe(head)
  const status = r.h.git(proj, "status", "--porcelain")
  expect(status).toContain("M notes/start.md")
  expect(status).toContain("?? mine.md")

  // Repaired by its owner: the same look passes.
  r.h.git(proj, "checkout", "-q", "--", "notes/start.md")
  rmSync(join(proj, "mine.md"))
  await ok(await observeDest(ctx, move)).hold.release()
}, SLOW)

test("WS-8: a destination ahead of, behind, diverged from or on another branch than the sealed commit is named and never reset, rebased, merged or fetched into", async () => {
  const r = rig()
  const s = await moveStage(cluster, track)
  const move = await sealed(r, { storeUrl: s.tool.url })
  const ctx = { registry: r.registry("mac"), storeUrl: s.tool.url }
  const look = async () => refused(await observeDest(ctx, move))
  const dst = r.h.checkouts.proj.dst
  const src = r.h.checkouts.proj.src
  const sealedHead = r.h.head(src)

  // A descendant is not the sealed commit: the destination's own commit on top is "ahead", never accepted for having the source's content.
  const own = r.h.commit(dst, "notes/own.md", "the destination's own\n", "own")
  expect(await look()).toEqual({ code: "dest_workspace_ahead", repository: "proj" })
  expect(r.h.head(dst)).toBe(own)
  r.h.git(dst, "reset", "-q", "--hard", sealedHead)

  // Behind: the source's sync pushed a commit the destination does not hold yet (the sealed one is the one before it, so the destination is still AT it)...
  // ...so seal the later one instead, as a move made after that push would have.
  const later = r.h.commit(src, "notes/later.md", "later\n", "later")
  r.h.push(src)
  const move2 = await sealed(r, { storeUrl: s.tool.url })
  const look2 = async () => refused(await observeDest(ctx, move2))
  expect(r.h.head(src)).toBe(later)
  expect(await look2(), "the commit is not in its object store").toEqual({ code: "dest_workspace_behind", repository: "proj", why: "revision-missing" })
  expect(existsSync(join(dst, ".git", "FETCH_HEAD")), "nothing was fetched").toBe(false)
  r.h.git(dst, "fetch", "-q", "origin")
  expect(await look2(), "fetched but not merged").toEqual({ code: "dest_workspace_behind", repository: "proj", why: "behind" })
  r.h.pull(dst)
  await ok(await observeDest(ctx, move2)).hold.release()

  // Diverged: the destination committed its own thing, and the sealed commit is the source's other one.
  r.h.git(dst, "reset", "-q", "--hard", sealedHead)
  r.h.commit(dst, "notes/diverged.md", "diverged\n", "diverged")
  r.h.git(dst, "fetch", "-q", "origin")
  expect(await look2()).toEqual({ code: "dest_workspace_divergent", repository: "proj" })

  r.h.git(dst, "reset", "-q", "--hard", later)
  r.h.git(dst, "checkout", "-q", "-b", "side")
  expect(await look2()).toEqual({ code: "dest_workspace_branch", repository: "proj" })
  r.h.git(dst, "checkout", "-q", "main")
  await ok(await observeDest(ctx, move2)).hold.release()
}, SLOW)

test("WS-9: a destination mid-operation, one whose sync is running, a moved root, another plan and a manifest that is not this export's are each named", async () => {
  const r = rig()
  const s = await moveStage(cluster, track)
  const move = await sealed(r, { storeUrl: s.tool.url })
  const ctx = { registry: r.registry("mac"), storeUrl: s.tool.url }
  const dst = r.h.checkouts.vault.dst
  const look = async (m: MoveRow = move, c = ctx) => refused(await observeDest(c, m))

  const held = await s.tool.sql.reserve()
  const key = syncLockKey("mac", realpathSync(join(r.h.checkouts.proj.dst, ".git")))
  await held`select pg_advisory_lock(hashtextextended(${key}, 0))`
  try { expect(await look()).toEqual({ code: "dest_workspace_busy", why: "sync-running" }) } finally {
    await held`select pg_advisory_unlock(hashtextextended(${key}, 0))`
    held.release()
  }

  r.h.git(dst, "checkout", "-q", "-b", "topic")
  r.h.commit(dst, "notes/start.md", "topic\n", "topic")
  r.h.git(dst, "checkout", "-q", "main")
  r.h.commit(dst, "notes/start.md", "main\n", "main")
  expect(() => r.h.git(dst, "merge", "topic")).toThrow()
  expect(await look()).toEqual({ code: "dest_workspace_busy", repository: "vault", why: "MERGE_HEAD" })
  r.h.git(dst, "merge", "--abort")
  r.h.git(dst, "reset", "-q", "--hard", r.h.head(r.h.checkouts.vault.src))

  // The manifest is not this export's, or not under this profile: the look refuses before it reads a checkout.
  const wk = (over: Record<string, unknown>) => moveOf({ manifest: { workspace: { ...(move.manifest!.workspace as object), ...over } }, dest_facts: move.dest_facts })
  expect(await look(wk({ generation: 4 }))).toEqual({ code: "dest_workspace_unavailable", why: "generation" })
  expect(await look(wk({ profile: sha256("another profile") }))).toEqual({ code: "dest_workspace_unavailable", why: "profile" })
  expect(await look(wk({ repos: [] }))).toEqual({ code: "dest_workspace_unavailable", why: "sealed-invalid" })
  expect(await look(wk({ plan: sha256("another plan") }))).toEqual({ code: "dest_workspace_moved", why: "plan" })
  // This machine's placement is not the one its preflight recorded.
  const placed = rig()
  const moved = refused(await observeDest({ registry: placed.registry("mac"), storeUrl: s.tool.url }, moveOf({ manifest: move.manifest, dest_facts: move.dest_facts })))
  expect(moved).toEqual({ code: "dest_workspace_moved", why: "roots" })
  // A destination that has no checkout at all: named by the library's code.
  rmSync(r.h.checkouts.zone.dst, { recursive: true })
  expect(await look()).toMatchObject({ code: "dest_workspace_unavailable", repository: "zone" })
  expect(JSON.stringify(await look())).not.toContain(r.root)
}, SLOW)

test("WS-9b: a checkout whose index hides changed bytes (assume-unchanged, skip-worktree), a sparse or split index and an undeclared gitlink are refused on BOTH machines, never taken for clean, and nothing is written", async () => {
  const r = rig()
  const s = await moveStage(cluster, track)
  const src = { registry: r.registry("pi"), storeUrl: s.tool.url }
  const dst = { registry: r.registry("mac"), storeUrl: s.tool.url }
  const move = await sealed(r, { storeUrl: s.tool.url })
  const sourceLook = async () => refused(await observeSource(src, moveOf({ dest_facts: { profile: PROFILE } })))
  const destLook = async () => refused(await observeDest(dst, move))
  const hiding = { code: "workspace_unavailable", repository: "proj", why: "repo-index-flags" }

  // SOURCE: git calls an edit clean under either flag, so the look reads the flags first.
  const proj = r.h.checkouts.proj.src
  r.h.git(proj, "update-index", "--assume-unchanged", "notes/start.md")
  r.h.put(proj, "notes/start.md", "edited behind the index's back\n")
  expect(r.h.git(proj, "status", "--porcelain"), "git itself says clean").toBe("")
  expect(await sourceLook()).toEqual(hiding)
  r.h.git(proj, "update-index", "--no-assume-unchanged", "notes/start.md")
  r.h.git(proj, "update-index", "--skip-worktree", "notes/start.md")
  expect(await sourceLook()).toEqual(hiding)
  r.h.git(proj, "update-index", "--no-skip-worktree", "notes/start.md")
  expect(await sourceLook(), "with the flags gone the edit is plain dirt").toEqual({ code: "workspace_unsynced", repository: "proj", reason: "dirty", changed: 1, untracked: 0 })
  r.h.git(proj, "checkout", "-q", "--", "notes/start.md")
  await ok(await observeSource(src, moveOf({ dest_facts: { profile: PROFILE } }))).hold.release()

  // DESTINATION: the same, on a repository that is at the sealed commit and would otherwise pass.
  const vault = r.h.checkouts.vault.dst
  r.h.git(vault, "update-index", "--skip-worktree", "CLAUDE.md")
  r.h.put(vault, "CLAUDE.md", "the destination's own words\n")
  // (The vault's tree holds the declared project and zone checkouts as untracked directories, which the plan sets aside by name: git's answer about
  // the TRACKED files is the one the flag hides.)
  expect(r.h.git(vault, "status", "--porcelain", "--untracked-files=no"), "git itself says clean").toBe("")
  expect(await destLook()).toEqual({ code: "dest_workspace_unavailable", repository: "vault", why: "repo-index-flags" })
  r.h.git(vault, "update-index", "--assume-unchanged", "notes/start.md")
  r.h.git(vault, "update-index", "--no-skip-worktree", "CLAUDE.md")
  r.h.git(vault, "checkout", "-q", "--", "CLAUDE.md")
  expect(await destLook()).toEqual({ code: "dest_workspace_unavailable", repository: "vault", why: "repo-index-flags" })
  r.h.git(vault, "update-index", "--no-assume-unchanged", "notes/start.md")

  // A split index keeps its entries in a second file, a state this proof does not describe: refused, never inferred equal to the sealed commit.
  // (A sparse checkout is skip-worktree entries, refused above by their flag; `transfer-repos.test.ts` shows it on a real cone.)
  const zone = r.h.checkouts.zone.dst
  r.h.git(zone, "update-index", "--split-index")
  expect(await destLook()).toEqual({ code: "dest_workspace_unavailable", repository: "zone", why: "repo-index-state" })
  r.h.git(zone, "update-index", "--no-split-index")

  // A gitlink that is not a declared nested checkout hides what it points at.
  const projDst = r.h.checkouts.proj.dst
  r.h.put(projDst, "sub/f.txt", "inner\n")
  r.h.git(join(projDst, "sub"), "init", "-q", "--initial-branch=main")
  r.h.git(join(projDst, "sub"), "add", ".")
  r.h.git(join(projDst, "sub"), "commit", "-q", "-m", "inner")
  r.h.git(projDst, "add", "sub")
  expect(await destLook()).toEqual({ code: "dest_workspace_unavailable", repository: "proj", why: "repo-submodule" })
  // An untracked nested repository that the plan does not name is dirt, as it always was. The gitlink is staged and HEAD has none, so git
  // will not unstage it without `-f`; the force only drops the entry from this scratch index, the nested repository stays on disk.
  r.h.git(projDst, "rm", "-q", "--cached", "-f", "sub")
  expect(await destLook()).toEqual({ code: "dest_workspace_dirty", repository: "proj", changed: 0, untracked: 1, conflicted: 0 })
}, SLOW)

test("WS-9c: a tracked link that leaves its checkout (a vault's folder link to elsewhere on the machine) is refused on BOTH machines, by name and with nothing read; a link that stays inside is looked at like any file", async () => {
  const r = rig()
  const s = await moveStage(cluster, track)
  const src = { registry: r.registry("pi"), storeUrl: s.tool.url }
  const dst = { registry: r.registry("mac"), storeUrl: s.tool.url }
  const move = await sealed(r, { storeUrl: s.tool.url })
  const proj = r.h.checkouts.proj
  const outside = scratch()

  // The sync committed the link and pushed it, and the destination pulled it: both machines hold the same tracked link.
  symlinkSync(outside, join(proj.src, "Projects"))
  r.h.git(proj.src, "add", "Projects")
  r.h.git(proj.src, "commit", "-q", "-m", "a link to a folder elsewhere")
  r.h.push(proj.src)
  r.h.pull(proj.dst)
  const named = { repository: "proj", why: "repo-symlink-outside" }
  expect(refused(await observeSource(src, moveOf({ dest_facts: { profile: PROFILE } })))).toEqual({ code: "workspace_unavailable", ...named })
  expect(refused(await observeDest(dst, move))).toEqual({ code: "dest_workspace_unavailable", ...named })
  expect(JSON.stringify([await observeSource(src, moveOf({ dest_facts: { profile: PROFILE } })), await observeDest(dst, move)]), "no path in what is said").not.toContain(outside)

  // Replaced by a link that stays inside the checkout: the source passes, and the destination goes on to the question of the commit it is at.
  rmSync(join(proj.src, "Projects"))
  symlinkSync("notes/start.md", join(proj.src, "Projects"))
  r.h.git(proj.src, "add", "Projects")
  r.h.git(proj.src, "commit", "-q", "-m", "the link stays inside")
  r.h.push(proj.src)
  r.h.pull(proj.dst)
  await ok(await observeSource(src, moveOf({ dest_facts: { profile: PROFILE } }))).hold.release()
  expect(refused(await observeDest(dst, move))).toEqual({ code: "dest_workspace_ahead", repository: "proj" })
}, SLOW)

// ---------------------------------------------------------------------------------------------------------------------
// what a refusal made from a checkout waits on
// ---------------------------------------------------------------------------------------------------------------------

test("WS-10: the shape a refusal waits on moves with a commit, a push, a file added at the top and a repository that appears, and a worktree edit is seen at the bounded re-look", () => {
  const r = rig()
  const registry = r.registry("pi")
  const at = 1_000_000
  const shape = (now = at) => workspaceShapeOf(registry, "p1", now)
  const base = shape()
  expect(shape(), "nothing changed, nothing is asked again").toBe(base)
  expect(workspaceShapeOf(registry, "nobody")).toBeNull()

  const proj = r.h.checkouts.proj.src
  r.h.commit(proj, "notes/more.md", "more\n")
  const committed = shape()
  expect(committed, "a commit moves HEAD, the branch ref and the index").not.toBe(base)
  r.h.push(proj)
  const pushed = shape()
  expect(pushed, "a push moves the remote-tracking ref").not.toBe(committed)
  r.h.put(r.h.checkouts.vault.src, "top.md", "a file at the top\n")
  const topped = shape()
  expect(topped, "a file at the top of the checkout").not.toBe(pushed)

  // An edit in place, deeper down, changes none of git's own files: only the bounded re-look sees it.
  const deep = join(proj, "notes", "more.md")
  writeFileSync(deep, "edited in place, same size\n")
  expect(shape(), "within the interval it is not seen").toBe(topped)
  expect(shape(at + RECHECK.ms), "at the next interval it is looked at again").not.toBe(topped)
  expect(shape(at + RECHECK.ms)).toBe(shape(at + RECHECK.ms + 1))

  // A repository that was not there and now is.
  const missing = r.h.checkouts.proj.src
  rmSync(missing, { recursive: true })
  const absent = shape()
  expect(absent).not.toBe(topped)
  mkdirSync(missing)
  expect(shape(), "the directory appearing").not.toBe(absent)
  r.h.git(missing, "init", "--initial-branch=main")
  const empty = shape()
  r.h.commit(missing, "x.md", "x\n")
  expect(shape(), "and a repository in it").not.toBe(empty)
})
