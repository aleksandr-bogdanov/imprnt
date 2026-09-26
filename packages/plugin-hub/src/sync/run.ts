import { existsSync, lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { recordJobSuccess } from "../check/schedule.ts";
import { syncCause, syncStuck } from "../door/lines.ts";
import { prepareReply } from "../door/reply.ts";
import { recordOperationFailure } from "../door/health.ts";
import { appendEntry } from "../records/diary.ts";
import { putRow, readSheet } from "../records/statesheet.ts";
import { listAgents, listPeople, listRepositories, listRunEntries, noticeRoute, repositoriesFor } from "../registry/entries.ts";
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
async function git(path: string, args: string[], code: string, options: { input?: string; raw?: boolean } = {}): Promise<string> {
  const child = Bun.spawn(["git", "-C", path, "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args],
    { env: process.env, stdin: options.input === undefined ? "ignore" : new Blob([options.input]), stdout: "pipe", stderr: "ignore" });
  const [out, status] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  // Git diagnostics can contain credential-bearing remote URLs.
  if (status !== 0) throw new Error(code);
  return options.raw ? out : out.trim();
}

function inside(root: string, path: string): boolean {
  const part = relative(root, path);
  return part === "" || (!isAbsolute(part) && part !== ".." && !part.startsWith("../"));
}

// The declared repositories checked out inside this one, relative to it. A
// vault's mount is its own checkout, synced by whichever entry lists it on its
// own branch, and the vault's status shows it as an untracked directory (or a
// moved gitlink) that is not the vault's work. A declared path with no `.git`
// of its own is left in, so a file under it is the vault's own to commit. The
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

/**
 * A filter driver the repository's own config declares. Git runs its `clean`
 * program on every `add` and its `smudge` program on every checkout, so one an
 * agent wrote into `.git/config` would run here, unboxed, when the sync commits
 * or rebases. Only the repository's own scopes are asked: a filter the
 * household's account installed for itself, such as a large-file store, is
 * that account's own choice.
 */
async function plantsFilter(path: string, code: string): Promise<boolean> {
  const listed = await git(path, ["config", "--list", "--show-scope", "--name-only"], code);
  return listed.split("\n").some(line => {
    const [scope, key = ""] = line.split("\t");
    return (scope === "local" || scope === "worktree") && /^filter\..+\.(clean|smudge|process)$/i.test(key);
  });
}

/**
 * A directory that is its own checkout, which the vault's commit leaves out.
 * Judged without following a symlink: a link the vault holds is the vault's
 * own file even when it points at a checkout, and git records the link.
 */
function isCheckout(root: string, name: string): boolean {
  const entry = join(root, name.replace(/\/+$/, ""));
  try { return lstatSync(entry).isDirectory() && existsSync(join(entry, ".git")); } catch { return false; }
}

/**
 * Commit whatever the repository holds uncommitted, so the pull and push that
 * follow move it. Agents file notes into a vault and never commit them, and a
 * sync that refused an uncommitted tree left that vault standing still in both
 * directions until somebody noticed. Declared checkouts inside this one are
 * set aside, and so is any other directory that is its own checkout, which
 * `add` would otherwise record as an embedded repository. Returns how many
 * files the commit took, zero when there was nothing to take.
 *
 * The commit names its paths, so it takes exactly what status listed and
 * nothing else the index happens to hold: a set-aside checkout somebody staged
 * by hand stays out. Only paths whose working copy differs from the index go
 * through `add`. One already staged, a deletion made with `git rm` above all,
 * is in neither the working tree nor the index any more, and naming it to
 * `add` would fail the run, and every run after it.
 */
async function commitPending(path: string, nested: string[], code: string): Promise<number> {
  // Every untracked file is listed on its own, so the only directory status
  // names whole is a checkout of its own, which is left out. The paths are
  // handed over literally and on stdin: an excluding pathspec that names an
  // ignored directory makes `add` fail outright, and a vault left for days can
  // hold more changed paths than one command line takes.
  const entries = (await git(path, ["status", "--porcelain", "-z", "--untracked-files=all", "--", ".", ...nested],
    code, { raw: true })).split("\0");
  const changed: string[] = [], toAdd: string[] = [];
  for (let n = 0; n < entries.length; n++) {
    const entry = entries[n];
    if (entry.length < 4) continue;
    const name = entry.slice(3);
    // A rename or copy names its source in the next field, which is always
    // consumed here, so the source is never read as a record of its own.
    const source = "RC".includes(entry[0]) ? entries[++n] : undefined;
    if (isCheckout(path, name) || (source !== undefined && isCheckout(path, source))) continue;
    changed.push(name);
    if (source !== undefined) changed.push(source);
    if (entry[0] === "?" || entry[1] !== " ") toAdd.push(name);
  }
  if (changed.length === 0) return 0;
  if (toAdd.length > 0) {
    await git(path, ["--literal-pathspecs", "add", "--all", "--pathspec-from-file=-", "--pathspec-file-nul"], code,
      { input: toAdd.join("\0") });
  }
  // What the commit takes is re-read after `add`: a file staged and then
  // deleted is gone from the index now, and naming it would fail the commit.
  // `diff` takes no pathspec file, so the whole index is listed, without
  // rename pairing so both halves of a rename show, and cut down to what
  // status named here.
  const listed = new Set(changed);
  const paths = (await git(path, ["diff", "--cached", "--no-renames", "--name-only", "-z"], code, { raw: true }))
    .split("\0").filter(name => listed.has(name));
  if (paths.length === 0) return 0;
  await git(path, ["--literal-pathspecs", "-c", "user.name=imprnt hub", "-c", "user.email=hub@localhost", "-c", "commit.gpgsign=false",
    "commit", "--no-verify", "--quiet", "-m", `hub sync: ${paths.length} files`, "--pathspec-from-file=-", "--pathspec-file-nul"],
    code, { input: paths.join("\0") });
  return paths.length;
}

/** How many failed runs in a row reach the person, not only the journal. */
export const SYNC_NOTICE_AFTER_RUNS = 3;

interface RepoResult {
  id: string; required: boolean; status: string; code?: string; cause?: string;
  committed?: number; failed_runs?: number; failing_since?: string;
}

/**
 * Tell the repository's person, in their own chat, that it has not synced for
 * several runs. The notice is keyed on the start of the streak, so a run that
 * fails again says nothing new, and a streak that ends and starts again is a
 * new notice. A person with no chat agent has nowhere for it to land, and
 * `check` goes on reporting `sync-failed` for them.
 */
async function noticeStuck(store: StoreLike, registry: Registry, entry: string, person: string, repo: RepoResult): Promise<void> {
  // The person's resident agent is the chat they keep open, the lair for the
  // owner and the main chat for anyone with one, so the notice lands where it
  // is read. A person with none gets it in their first chat.
  const chats = listAgents(registry).filter(one => one.person === person && one.chat !== undefined && one.door !== undefined);
  const agent = chats.find(one => one.mode === "resident") ?? chats[0];
  const where = agent ? noticeRoute(registry, agent.id) : null;
  if (!agent || !where) return;
  const body = syncStuck(where.language, { target: repo.id, count: repo.failed_runs, cause: syncCause(where.language, repo.code!) });
  const key = `sync-stuck:${entry}:${repo.id}:${repo.failing_since}`;
  for (const [index, part] of prepareReply(body, where.platform, where.language).entries()) {
    await store.sql`select hub_door_notice(${person}, ${agent.id}, ${part}, ${index === 0 ? key : `${key}:part:${index + 1}`},
      ${where.route}::jsonb, ${index + 1})`;
  }
}

export async function runSync(entry: RunEntry, registry: Registry): Promise<void> {
  const declared = listRunEntries(registry).find(one => one.id === entry?.id && one.kind === "sync");
  if (!declared) throw new Error("sync-entry-unknown");
  const store = await openStore({ url: storeUrlFor(registry, "hub_hub", declared.id) });
  const results: RepoResult[] = [];
  try {
    const previous = ((await readSheet(store, "sync")).find(row => row.id === declared.id)?.data.repositories ?? []) as RepoResult[];
    for (const repo of repositoriesFor(registry, declared.id)) {
      let committed = 0;
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
          // Before any command that reads the working tree: git runs a filter's
          // program while it compares file contents, so a filter an agent wrote
          // into the repository's config would run on the first such command.
          code = "config";
          if (await plantsFilter(path, code)) throw new Error(code);
          code = "branch";
          if (await git(path, ["symbolic-ref", "--quiet", "--short", "HEAD"], code) !== repo.branch) throw new Error(code);
          code = "remote";
          if (!(await git(path, ["remote"], code)).split("\n").includes(repo.remote)) throw new Error(code);
          // A merge left half done is refused before anything is added: an
          // `add` over conflict markers would commit them as the resolution.
          code = "conflict";
          const gitDir = await git(path, ["rev-parse", "--absolute-git-dir"], code);
          if (["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply"].some(one => existsSync(join(gitDir, one))) ||
              await git(path, ["diff", "--name-only", "--diff-filter=U"], code)) throw new Error(code);
          code = "commit";
          const nested = nestedIn(path, registry).map(one => `:(exclude,literal)${one}`);
          committed = await commitPending(path, nested, code);
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
        results.push({ id: repo.id, required: repo.required, status: "success", ...(committed ? { committed } : {}) });
      } catch {
        const cause = syncCause("en", code);
        // The streak carries over from the last run's row, so a failure that
        // repeats every run is counted rather than only overwritten.
        const before = previous.find(one => one.id === repo.id && one.status === "failed");
        const failed_runs = (before ? before.failed_runs ?? 1 : 0) + 1;
        const failing_since = before?.failing_since ?? new Date().toISOString();
        results.push({ id: repo.id, required: repo.required, status: "failed", code, cause, failed_runs, failing_since,
          ...(committed ? { committed } : {}) });
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
        const person = repositoriesFor(registry, declared.id).find(one => one.id === repo.id)?.person;
        if (person && repo.failed_runs! >= SYNC_NOTICE_AFTER_RUNS) await noticeStuck(transaction, registry, declared.id, person, repo);
      }
      if (success) await recordJobSuccess(transaction, { entry: declared.id, machine: declared.machine, at: data.at });
    });
    if (!success) throw new Error("sync-failed");
  } finally { await store.close(); }
}
