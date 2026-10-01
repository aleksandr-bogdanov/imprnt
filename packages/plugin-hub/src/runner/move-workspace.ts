import { existsSync, lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { listPeople, listRepositories, listRunEntries } from "../registry/entries.ts";
import type { Registry, RepositoryEntry } from "../registry/load.ts";
import { openStore } from "../store/connect.ts";
import type { MoveRow } from "../store/moves.ts";
import { syncLockKey } from "../sync/run.ts";
import { TransferError } from "../transfer/bundle.ts";
import { commonDirOf, ignoredCount, relationOf, repoState, revisionOf, type RepoState } from "../transfer/repos.ts";
import { lstatBelow } from "../transfer/workspace.ts";
import { isRecord, sha256, stableText, type WorkspaceHold, type WorkspaceVerdict } from "./move-handoff.ts";

/**
 * THE REPOSITORIES A MOVE VERIFIES: the checkouts the person declares (the vault's, the shared zone's, a project's), each kept in step by the
 * hub's own sync on BOTH machines. Nothing here carries a file. What a move says of them is a fact observed twice: at the source, under the
 * sync's own lock, each checkout is on its declared branch, CLEAN, and at the commit its remote-tracking ref holds (the commit is
 * sealed in the manifest); at the destination, again under the sync's lock and right before the import, each checkout is on its declared
 * branch, CLEAN, and at EXACTLY the sealed commit. That the source pushed proves nothing about the destination: only the destination's own
 * look does. What is not a fact of either look is not claimed: ignored files and untracked credential-shaped files are counted and reported as
 * not carried, and no file outside a declared repository is covered at all (`move-scope.ts` refuses it).
 *
 * "Clean" is git's answer from its index, so a checkout whose index cannot vouch for its files is never called clean: an assume-unchanged or
 * skip-worktree entry (which would hide a changed file), a sparse or split index, an unknown index version and a gitlink that is not exactly a
 * declared nested checkout are refused as `workspace_unavailable` / `dest_workspace_unavailable` with the library's code as `why`
 * (`repo-index-flags`, `repo-index-state`, `repo-submodule`). Nothing is inferred equal, and nothing is hashed or written to tell. "Clean" is also asked
 * with git's defaults pinned (every stat field, the executable bit and the link type compared), so a checkout configured to overlook one reads as dirty.
 *
 * A TRACKED SYMLINK THAT CANNOT BE SHOWN TO STAY INSIDE ITS OWN CHECKOUT IS NOT SUPPORTED, and is refused by the same names (`repo-symlink-outside`,
 * `repo-symlink-unresolved`): an absolute target, one that leaves the checkout at any hop (a vault's `Projects -> ~/Documents/Projects` included), one
 * into another declared checkout, a dangling link or a cycle. Nothing outside a declared checkout is verified, so nothing that a link reaches outside
 * one is claimed; no target is read. A link that stays inside its checkout is supported.
 *
 * A destination that is behind waits for its own sync to pull; one that is dirty, ahead, divergent or mid-operation is a named block and is
 * never reset, rebased, merged, cleaned or fetched into. A move whose commit the destination can never be at exactly (its sync committed
 * something of its own on top) is withdrawn by the owner and asked again: no rule here picks a side.
 *
 * THE SYNC'S LOCK is `sync:<machine>:<real path of the common git dir>` (`syncLockKey`), a Postgres advisory lock the sync holds for a whole
 * run of a checkout. The move TRIES it (never waits) on a connection of its own for every checkout it looks at and holds it until the
 * caller has committed what the look was for (the source's release, the destination's activation), so no sync commits, rebases or pushes in
 * between: a busy lock is a named wait. A process that dies frees it with its connection.
 */

/**
 * One git status or listing of one checkout is bounded to this much output: one that does not fit is named `too-large`, never read in part. That is
 * dirt that does not fit, and also a clean checkout whose index listings do (roughly 15 to 20 thousand tracked files): a known limit of this bound,
 * named the same way, which the owner reads as "this checkout is too large for a move" and not as dirt.
 */
const GIT_OUTPUT_BYTES = 1 << 20;
export const MOVE_WORKSPACE_REPOSITORIES = 16;

/** How often a refusal that waits on a worktree is looked at again when nothing cheap changed (git's own refs and index are watched by stat; a file edited in place is not). */
export const RECHECK = { ms: 30_000 };

export interface PlannedRepo { id: string; path: string; remote: string; branch: string; zone: boolean; nested: string[] }

/** `plan` is machine-neutral (ids, branches, nesting) and equal on both machines; `roots` names THIS machine's paths. */
export interface WorkspacePlan { repos: PlannedRepo[]; plan: string; roots: string }

export type WorkspaceLook =
  | { kind: "none" }
  | { kind: "plan"; plan: WorkspacePlan }
  | { kind: "refused"; refused: string; detail?: Record<string, unknown> };

const real = (path: string): string | null => { try { return realpathSync(path); } catch { return null; } };
const inside = (root: string, path: string): boolean => {
  const part = relative(root, path);
  return part === "" || (!isAbsolute(part) && part !== ".." && !part.startsWith("../"));
};

/** The person's declared repositories, in the one order every digest and comparison here uses (by id, code units). */
const declaredOf = (registry: Registry, person: string): RepositoryEntry[] =>
  listRepositories(registry).filter(one => one.person === person).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

const syncing = (registry: Registry, machine: string, repository: string): boolean =>
  listRunEntries(registry).some(entry => entry.kind === "sync" && entry.enabled !== false && entry.machine === machine && (entry.repositories ?? []).includes(repository));

/**
 * What the registry and a look at this machine's paths say a move of `person`'s agent must verify. `refused` names why it cannot be supported
 * (the owner's registry is the way out): a repository one of the two machines' sync does not list, more repositories than a move holds, a vault
 * no declared repository covers, a nested checkout that is not provably a separate one. Nothing is read from a checkout.
 */
export function workspacePlanOf(registry: Registry, person: string, machines: { source: string; dest: string }): WorkspaceLook {
  const declared = declaredOf(registry, person);
  const vault = listPeople(registry).find(one => one.id === person)?.vault;
  const wantsVault = typeof vault === "string" && vault !== "";
  if (declared.length === 0) return wantsVault ? { kind: "refused", refused: "dependency_unverified", detail: { dependencies: ["vault"] } } : { kind: "none" };
  if (declared.length > MOVE_WORKSPACE_REPOSITORIES) return { kind: "refused", refused: "too_many_repositories", detail: { count: declared.length } };
  for (const machine of [machines.source, machines.dest]) {
    const missing = declared.filter(one => !syncing(registry, machine, one.id)).map(one => one.id);
    if (missing.length > 0) return { kind: "refused", refused: "repository_unsynced", detail: { repositories: missing.slice(0, 8), machine } };
  }
  if (wantsVault) {
    const root = real(vault);
    if (root === null || !declared.some(one => !one.zone && inside(real(one.path) ?? "\0", root))) return { kind: "refused", refused: "dependency_unverified", detail: { dependencies: ["vault"] } };
  }
  const repos: PlannedRepo[] = [];
  for (const one of declared) {
    const nested: string[] = [];
    const outer = real(one.path);
    for (const other of declared) {
      const inner = other.id === one.id || outer === null ? null : real(other.path);
      if (inner === null || inner === outer || !inside(outer!, inner) || !existsSync(join(inner, ".git"))) continue;
      // A checkout inside another is set aside only as a directory that is really there, reached without a link, and covered by the plan on its own.
      const rel = relative(outer!, inner);
      try { if (!lstatBelow(outer!, rel).isDirectory()) throw new TransferError("path-missing"); } catch (error) {
        if (!(error instanceof TransferError)) throw error;
        return { kind: "refused", refused: "nested_repository_unproven", detail: { repository: other.id } };
      }
      nested.push(rel);
    }
    repos.push({ id: one.id, path: one.path, remote: one.remote, branch: one.branch, zone: one.zone === true, nested: nested.sort() });
  }
  return {
    kind: "plan",
    plan: {
      repos,
      plan: sha256(stableText(repos.map(one => ({ id: one.id, branch: one.branch, zone: one.zone, nested: one.nested })))),
      roots: sha256(stableText(repos.map(one => ({ id: one.id, path: one.path })))),
    },
  };
}

/** What a destination's preflight records of its repositories (`dest_facts.workspace`), or the named reason this machine cannot take them, or null for a person with none. */
export function workspaceFactsOf(registry: Registry, move: MoveRow): { plan: string; roots: string; repositories: number } | { refused: string; detail?: Record<string, unknown> } | null {
  const look = workspacePlanOf(registry, move.person, { source: move.source_machine, dest: move.dest_machine });
  if (look.kind === "none") return null;
  if (look.kind === "refused") return { refused: look.refused, ...(look.detail ? { detail: look.detail } : {}) };
  const absent = look.plan.repos.filter(one => !existsSync(join(one.path, ".git"))).map(one => one.id);
  if (absent.length > 0) return { refused: "not_a_checkout", detail: { repositories: absent.slice(0, 8) } };
  return { plan: look.plan.plan, roots: look.plan.roots, repositories: look.plan.repos.length };
}

// ---------------------------------------------------------------------------------------------------------------------
// the sync's lock
// ---------------------------------------------------------------------------------------------------------------------

/** Try, never wait, for the sync lock of every checkout at once, on a connection of its own. Null when any is held by someone else (nothing stays taken). */
async function holdSyncLocks(storeUrl: string, machine: string, commonDirs: string[]): Promise<WorkspaceHold | null> {
  const store = await openStore({ url: storeUrl, max: 1 });
  const connection = await store.sql.reserve();
  const taken: string[] = [];
  const release = async (): Promise<void> => {
    try { for (const key of taken.splice(0)) await connection`select pg_advisory_unlock(hashtextextended(${key}, 0))`; } finally {
      try { connection.release(); } finally { await store.close(); }
    }
  };
  try {
    for (const dir of [...new Set(commonDirs)].sort()) {
      const key = syncLockKey(machine, dir);
      const [row] = await connection`select pg_try_advisory_lock(hashtextextended(${key}, 0)) as held`;
      if (!row.held) { await release(); return null; }
      taken.push(key);
    }
  } catch (error) { await release().catch(() => {}); throw error; }
  return { release };
}

export interface WorkspaceContext { registry: Registry; storeUrl: string }

const fail = (code: string, detail: Record<string, unknown>): WorkspaceVerdict => ({ ok: false, code, detail });

/** A refusal of the transfer library as a named verdict, and anything else is a bug and propagates. */
function unavailable(code: string, repository: string, error: unknown): WorkspaceVerdict {
  if (error instanceof TransferError) return fail(code, { repository: repository.slice(0, 64), why: error.code });
  throw error;
}

/** The checkouts' common git directories (what the sync locks on) and the lock over them all, or the verdict that says why not. */
async function lockedCheckouts(ctx: WorkspaceContext, plan: WorkspacePlan, machine: string, unavailableCode: string, busy: WorkspaceVerdict): Promise<{ hold: WorkspaceHold } | WorkspaceVerdict> {
  const commons: string[] = [];
  for (const repo of plan.repos) {
    try { commons.push(await commonDirOf({ repo: repo.path, maxGitOutputBytes: GIT_OUTPUT_BYTES })); } catch (error) { return unavailable(unavailableCode, repo.id, error); }
  }
  const hold = await holdSyncLocks(ctx.storeUrl, machine, commons);
  return hold ? { hold } : busy;
}

const dirty = (state: RepoState): boolean => state.changed > 0 || state.untracked > 0 || state.conflicted > 0;

/**
 * SOURCE: every declared repository, under the sync locks, on its declared branch, clean, and at the commit its remote-tracking ref holds. The
 * sealed answer is what the manifest records (`workspace`): per repository the head, the branch and how many ignored and credential-shaped
 * entries stay behind (`ignored` is null when there are more than one status could list). That the remote-tracking ref IS the commit is a
 * pre-check that the destination's sync can arrive at exactly it, and proves nothing about the destination.
 */
export async function observeSource(ctx: WorkspaceContext, move: MoveRow): Promise<WorkspaceVerdict> {
  const look = workspacePlanOf(ctx.registry, move.person, { source: move.source_machine, dest: move.dest_machine });
  if (look.kind !== "plan") return fail("workspace_plan_mismatch", { why: look.kind === "none" ? "none-declared" : look.refused });
  const locked = await lockedCheckouts(ctx, look.plan, move.source_machine, "workspace_unavailable", fail("workspace_unsynced", { reason: "sync-running" }));
  if (!("hold" in locked)) return locked;
  const sealed: Record<string, unknown>[] = [];
  const out = async (verdict: WorkspaceVerdict): Promise<WorkspaceVerdict> => { await locked.hold.release(); return verdict; };
  try {
    for (const repo of look.plan.repos) {
      let state: RepoState;
      try { state = await repoState({ repo: repo.path, maxGitOutputBytes: GIT_OUTPUT_BYTES, nested: repo.nested }); } catch (error) {
        return await out(error instanceof TransferError && error.code === "repo-git-output" ? fail("workspace_unsynced", { repository: repo.id, reason: "too-large" }) : unavailable("workspace_unavailable", repo.id, error));
      }
      if (state.operation !== null) return await out(fail("workspace_unsynced", { repository: repo.id, reason: "operation" }));
      if (state.conflicted > 0) return await out(fail("workspace_unsynced", { repository: repo.id, reason: "conflict" }));
      if (state.branch !== repo.branch) return await out(fail("workspace_branch", { repository: repo.id }));
      if (dirty(state)) return await out(fail("workspace_unsynced", { repository: repo.id, reason: "dirty", changed: state.changed, untracked: state.untracked }));
      let ignored: number | null;
      try {
        const tip = await revisionOf({ repo: repo.path, ref: `refs/remotes/${repo.remote}/${repo.branch}`, maxGitOutputBytes: GIT_OUTPUT_BYTES });
        const relation = tip === null ? null : await relationOf({ repo: repo.path, head: state.head, revision: tip, maxGitOutputBytes: GIT_OUTPUT_BYTES });
        // The destination's sync can only arrive at the remote's tip, so a head BEHIND it is a commit the destination would never be exactly at.
        if (relation === "behind") return await out(fail("workspace_unsynced", { repository: repo.id, reason: "behind-remote" }));
        if (relation !== "same") return await out(fail("workspace_unpushed", { repository: repo.id }));
        ignored = await ignoredCount({ repo: repo.path, maxGitOutputBytes: GIT_OUTPUT_BYTES });
      } catch (error) { return await out(unavailable("workspace_unavailable", repo.id, error)); }
      sealed.push({ id: repo.id, head: state.head, branch: repo.branch, ignored, withheld: state.withheld });
    }
  } catch (error) { await locked.hold.release().catch(() => {}); throw error; }
  return { ok: true, sealed: { version: 1, plan: look.plan.plan, roots: look.plan.roots, repos: sealed }, hold: locked.hold };
}

/** The repositories a manifest sealed, as the destination reads them: a well-formed list or null. */
export function sealedRepositories(workspace: unknown): { id: string; head: string; branch: string; ignored: number | null; withheld: number }[] | null {
  if (!isRecord(workspace) || workspace.version !== 1 || !Array.isArray(workspace.repos) || workspace.repos.length === 0) return null;
  const found = [];
  for (const one of workspace.repos) {
    if (!isRecord(one) || typeof one.id !== "string" || typeof one.branch !== "string" || typeof one.head !== "string" || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(one.head)) return null;
    found.push({ id: one.id, head: one.head, branch: one.branch, ignored: typeof one.ignored === "number" ? one.ignored : null, withheld: typeof one.withheld === "number" ? one.withheld : 0 });
  }
  return found;
}

/**
 * DESTINATION, right before the import and under the sync locks: the sealed manifest is for this export and this profile, the plan and this
 * machine's roots are what the preflight recorded, and every checkout is on its declared branch, clean, and at EXACTLY the sealed commit. Anything
 * else is a named verdict; nothing is changed, fetched or discarded to make it pass. The hold is for the caller to release after activation.
 */
export async function observeDest(ctx: WorkspaceContext, move: MoveRow): Promise<WorkspaceVerdict> {
  const sealed = move.manifest?.workspace;
  const repos = sealedRepositories(sealed);
  const facts = move.dest_facts?.workspace;
  if (!repos || !isRecord(sealed)) return fail("dest_workspace_unavailable", { why: "sealed-invalid" });
  if (sealed.generation !== move.export_generation) return fail("dest_workspace_unavailable", { why: "generation" });
  if (sealed.profile !== sha256(stableText(move.dest_facts?.profile))) return fail("dest_workspace_unavailable", { why: "profile" });
  const look = workspacePlanOf(ctx.registry, move.person, { source: move.source_machine, dest: move.dest_machine });
  if (look.kind !== "plan") return fail("dest_workspace_unavailable", { why: look.kind === "none" ? "none-declared" : look.refused });
  // A declared checkout that is not there is that checkout's own named refusal. A missing nested one also drops out of its parent's `nested`, which
  // would change the derived plan and read as a registry that moved, so it is named here, by the library's code, before the plan is compared.
  for (const repo of look.plan.repos) {
    if (existsSync(join(repo.path, ".git"))) continue;
    try { await commonDirOf({ repo: repo.path, maxGitOutputBytes: GIT_OUTPUT_BYTES }); } catch (error) { return unavailable("dest_workspace_unavailable", repo.id, error); }
  }
  const named = look.plan.repos.map(one => one.id).join("\0");
  if (look.plan.plan !== sealed.plan || named !== repos.map(one => one.id).sort().join("\0")) return fail("dest_workspace_moved", { why: "plan" });
  if (!isRecord(facts) || facts.roots !== look.plan.roots) return fail("dest_workspace_moved", { why: "roots" });
  const locked = await lockedCheckouts(ctx, look.plan, move.dest_machine, "dest_workspace_unavailable", fail("dest_workspace_busy", { why: "sync-running" }));
  if (!("hold" in locked)) return locked;
  const out = async (verdict: WorkspaceVerdict): Promise<WorkspaceVerdict> => { await locked.hold.release(); return verdict; };
  try {
    for (const repo of look.plan.repos) {
      const want = repos.find(one => one.id === repo.id)!;
      let state: RepoState;
      try { state = await repoState({ repo: repo.path, maxGitOutputBytes: GIT_OUTPUT_BYTES, nested: repo.nested }); } catch (error) {
        return await out(error instanceof TransferError && error.code === "repo-git-output" ? fail("dest_workspace_dirty", { repository: repo.id, why: "too-large" }) : unavailable("dest_workspace_unavailable", repo.id, error));
      }
      if (state.operation !== null) return await out(fail("dest_workspace_busy", { repository: repo.id, why: state.operation }));
      if (state.branch !== repo.branch || want.branch !== repo.branch) return await out(fail("dest_workspace_branch", { repository: repo.id }));
      if (dirty(state)) return await out(fail("dest_workspace_dirty", { repository: repo.id, changed: state.changed, untracked: state.untracked, conflicted: state.conflicted }));
      let relation;
      try { relation = await relationOf({ repo: repo.path, head: state.head, revision: want.head, maxGitOutputBytes: GIT_OUTPUT_BYTES }); } catch (error) {
        return await out(unavailable("dest_workspace_unavailable", repo.id, error));
      }
      if (relation === "missing" || relation === "behind") return await out(fail("dest_workspace_behind", { repository: repo.id, why: relation === "missing" ? "revision-missing" : "behind" }));
      if (relation === "ahead") return await out(fail("dest_workspace_ahead", { repository: repo.id }));
      if (relation === "divergent") return await out(fail("dest_workspace_divergent", { repository: repo.id }));
    }
  } catch (error) { await locked.hold.release().catch(() => {}); throw error; }
  return { ok: true, sealed: {}, hold: locked.hold };
}

// ---------------------------------------------------------------------------------------------------------------------
// what a refusal made from a checkout waits on
// ---------------------------------------------------------------------------------------------------------------------

/** A file's identity as a short text, or `-` when it is not there: metadata only, one `lstat`. */
export function signatureOf(path: string): string {
  try { const seen = lstatSync(path); return `${seen.mtimeMs}:${seen.size}:${seen.ino}`; } catch { return "-"; }
}

/** The state git keeps that moves when a checkout is committed to, pulled, pushed or put in the middle of something, and the checkout's own top level. */
const GIT_STATE = ["HEAD", "index", "packed-refs", "FETCH_HEAD", "MERGE_HEAD", "rebase-merge", "rebase-apply"];

function stampOf(repo: RepositoryEntry): string {
  const git = join(repo.path, ".git");
  return [repo.path, git, ...GIT_STATE, `refs/heads/${repo.branch}`, `refs/remotes/${repo.remote}/${repo.branch}`].map((name, at) => signatureOf(at < 2 ? name : join(git, name))).join("|");
}

/**
 * WHAT A REFUSAL MADE FROM THE PERSON'S CHECKOUTS WAITS ON, as one comparable text, cheap enough for the runner's tick: for each declared
 * repository the stat of its top level and of the git files above, so a commit, a pull, a push, a rebase, an appearing repository and a file added
 * or removed at the top all change it. A file EDITED OR REMOVED DEEPER in the worktree changes none of them (the index is not rewritten by an
 * edit), so a bounded re-look is part of the text: it changes once per `RECHECK.ms`, which is the longest a repair of that kind goes unseen.
 * Nothing is hashed and no git is started. Null for a person with no declared repository.
 */
export function workspaceShapeOf(registry: Registry, person: string, now: number = Date.now()): string | null {
  const declared = declaredOf(registry, person);
  if (declared.length === 0) return null;
  return JSON.stringify({ at: Math.floor(now / RECHECK.ms), repositories: declared.map(one => [one.id, stampOf(one)]) });
}
