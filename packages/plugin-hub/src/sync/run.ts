import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { recordJobSuccess } from "../check/schedule.ts";
import { syncCause } from "../door/lines.ts";
import { recordOperationFailure } from "../door/health.ts";
import { appendEntry } from "../records/diary.ts";
import { putRow } from "../records/statesheet.ts";
import { listPeople, listRepositories, listRunEntries, repositoriesFor } from "../registry/entries.ts";
import { type Registry, type RunEntry } from "../registry/load.ts";
import { openStore, type StoreLike } from "../store/connect.ts";
import { storeUrlFor } from "../store/secrets.ts";

/**
 * One git call in a synced repository, with the repository's hooks turned off.
 *
 * The sync runs outside every box, as the household's account, in trees an
 * agent can write, and a hook is a program git runs on the repository's
 * behalf. A hook an agent planted in `.git/hooks` would otherwise run here,
 * unboxed, on the next fetch, rebase or push.
 */
async function git(path: string, args: string[], code: string): Promise<string> {
  const child = Bun.spawn(["git", "-C", path, "-c", "core.hooksPath=/dev/null", ...args],
    { env: process.env, stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  const [out, status] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  // Git diagnostics can contain credential-bearing remote URLs.
  if (status !== 0) throw new Error(code);
  return out.trim();
}

function inside(root: string, path: string): boolean {
  const part = relative(root, path);
  return part === "" || (!isAbsolute(part) && part !== ".." && !part.startsWith("../"));
}

// The declared repositories checked out inside this one, relative to it. A
// vault's mount is its own checkout, synced by whichever entry lists it on its
// own branch, and the vault's status shows it as an untracked directory (or a
// moved gitlink) that is not the vault's work. A declared path with no `.git`
// of its own is left in, so an uncommitted file under it is still refused. The
// test is the one the v2 sync used, and it spawns nothing while the lock is held.
function nestedIn(path: string, registry: Registry): string[] {
  const nested: string[] = [];
  for (const other of listRepositories(registry)) {
    try {
      const real = realpathSync(other.path);
      if (real !== path && inside(path, real) && existsSync(join(real, ".git"))) nested.push(relative(path, real));
    } catch { /* absent: nothing to set aside */ }
  }
  return nested;
}

export async function runSync(entry: RunEntry, registry: Registry): Promise<void> {
  const declared = listRunEntries(registry).find(one => one.id === entry?.id && one.kind === "sync");
  if (!declared) throw new Error("sync-entry-unknown");
  const store = await openStore({ url: storeUrlFor(registry, "hub_hub", declared.id) });
  const results: { id: string; required: boolean; status: string; code?: string; cause?: string }[] = [];
  try {
    for (const repo of repositoriesFor(registry, declared.id)) {
      let code = "path";
      try {
        const path = realpathSync(repo.path);
        code = "person";
        const person = listPeople(registry).find(one => one.id === repo.person);
        if (!person?.tree || !inside(realpathSync(person.tree), path)) throw new Error(code);
        code = "path";
        if (realpathSync(await git(path, ["rev-parse", "--show-toplevel"], code)) !== path) throw new Error(code);
        const identity = realpathSync(await git(path, ["rev-parse", "--path-format=absolute", "--git-common-dir"], code));
        const connection = await store.sql.reserve();
        let locked = false;
        try {
          code = "locked";
          const [row] = await connection`select pg_try_advisory_lock(hashtextextended(${`sync:${declared.machine}:${identity}`}, 0)) as held`;
          locked = row.held;
          if (!locked) throw new Error(code);
          code = "dirty";
          const nested = nestedIn(path, registry).map(one => `:(exclude,literal)${one}`);
          if (await git(path, ["status", "--porcelain", "--", ".", ...nested], code)) throw new Error(code);
          code = "branch";
          if (await git(path, ["symbolic-ref", "--quiet", "--short", "HEAD"], code) !== repo.branch) throw new Error(code);
          code = "remote";
          if (!(await git(path, ["remote"], code)).split("\n").includes(repo.remote)) throw new Error(code);
          code = "fetch";
          await git(path, ["fetch", "--", repo.remote, repo.branch], code);
          code = "conflict";
          await git(path, ["-c", "rebase.autoStash=false", "rebase", "FETCH_HEAD"], code);
          code = "push";
          await git(path, ["push", "--", repo.remote, `HEAD:refs/heads/${repo.branch}`], code);
        } finally {
          try {
            if (locked) await connection`select pg_advisory_unlock(hashtextextended(${`sync:${declared.machine}:${identity}`}, 0))`;
          } finally { connection.release(); }
        }
        results.push({ id: repo.id, required: repo.required, status: "success" });
      } catch {
        const cause = syncCause("en", code);
        results.push({ id: repo.id, required: repo.required, status: "failed", code, cause });
      }
    }
    const success = results.every(one => !one.required || one.status === "success");
    const data = { machine: declared.machine, status: success ? "success" : "failed", repositories: results, at: new Date().toISOString() };
    await store.sql.begin(async sql => {
      const transaction = { sql, url: store.url } as StoreLike;
      await putRow(transaction, "sync", declared.id, data);
      await appendEntry(transaction, { stream: "machine", subject: declared.id, kind: "sync", actor: "hub", detail: data });
      for (const repo of results) if (repo.status === "failed") {
        await recordOperationFailure(transaction, "sync", declared.id, repo.id,
          { kind: "permanent", code: `sync-${repo.code}`, cause: repo.cause! }, "hub");
      }
      if (success) await recordJobSuccess(transaction, { entry: declared.id, machine: declared.machine, at: data.at });
    });
    if (!success) throw new Error("sync-failed");
  } finally { await store.close(); }
}
