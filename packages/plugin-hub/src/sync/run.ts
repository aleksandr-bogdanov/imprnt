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
 *
 * A failure throws a `GitFailure` that carries the step's label, its exit
 * status or signal and a reason from a closed list. What git printed is never
 * kept: it can contain credential-bearing remote urls. `discard` says the
 * caller reads no stdout, so only its tail is held, for the reason.
 */
async function git(path: string, args: string[], code: string, stage: Stage,
  options: { input?: string; raw?: boolean; config?: string[]; discard?: boolean } = {}): Promise<string> {
  let child: ReturnType<typeof launch>;
  try { child = launch(path, args, options); } catch (error) {
    throw new GitFailure(code, { stage, reason: "spawn", errno: errnoOf(error) });
  }
  // Both pipes are read while the child runs, so a chatty stderr cannot fill
  // its pipe and stall a child the sync is waiting on. What git says is kept
  // only long enough to be sorted into a reason below, and only its tail: the
  // fatal line comes last, and stderr has no other use here.
  const [out, err, status] = await Promise.all([
    options.discard ? drain(child.stdout, DIAGNOSTIC_BYTES) : new Response(child.stdout).text(),
    drain(child.stderr, DIAGNOSTIC_BYTES), child.exited]);
  if (status !== 0 || child.signalCode) throw new GitFailure(code, diagnose(stage, status, child.signalCode, out, err));
  return options.raw ? out : out.trim();
}

function launch(path: string, args: string[], options: { input?: string; config?: string[] }) {
  // The two transports that run a program named in a remote url are shut on
  // the command line, which outranks anything the repository's config says.
  // `config` is what the registry says for this repository, on the same
  // command line and for the same reason: the owner's hand, not the file's.
  return Bun.spawn(["git", "-C", path, "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false",
    "-c", "protocol.ext.allow=never", "-c", "protocol.fd.allow=never",
    ...(options.config ?? []).flatMap(one => ["-c", one]), ...args],
    { env: process.env, stdin: options.input === undefined ? "ignore" : new Blob([options.input]), stdout: "pipe", stderr: "pipe" });
}

/** The git steps a sync runs, by fixed label. A label is never built from a path or an argument. */
type Stage = "toplevel" | "common-dir" | "config" | "branch" | "remote" | "git-dir" | "unmerged"
  | "status" | "add" | "diff" | "commit" | "fetch" | "rebase" | "push";

/**
 * What a failed step is called. A closed list of names and never git's own
 * words: git's diagnostics carry paths, remotes and credential-bearing urls,
 * and none of that may reach a row, the diary, the journal or a notice.
 * `unknown` is anything not recognised, which includes git speaking another
 * language, since the sync does not force one on git.
 */
type Reason = "index-lock" | "pathspec-missing" | "nothing-to-commit" | "permission" | "no-space"
  | "signal" | "spawn" | "internal" | "unknown";

/**
 * Where a run stopped and how, and nothing else: the step, the exit status or
 * the signal that ended it, and the reason's name. `local` is a failure outside
 * any git call, and `errno` is a standard code from the allowlist below.
 */
export interface SyncDiagnostic {
  stage: Stage | "local"; reason: Reason; exit?: number; signal?: string; errno?: string;
}

/** How much of a step's output is held while it is drained. */
const DIAGNOSTIC_BYTES = 16 * 1024;

const SIGNALS = new Set(["SIGHUP", "SIGINT", "SIGQUIT", "SIGILL", "SIGABRT", "SIGBUS", "SIGFPE", "SIGKILL", "SIGSEGV", "SIGPIPE", "SIGTERM"]);
const ERRNOS = new Set(["ENOENT", "EACCES", "EPERM", "ENOMEM", "EMFILE", "ENFILE", "EAGAIN", "E2BIG", "ENOTDIR", "ELOOP",
  "ENAMETOOLONG", "EIO", "ENOSPC"]);

// The shapes git is known to give. The lock, the missing path and the empty
// commit were reproduced against real git in a scratch repository (the empty
// commit says so on stdout, stderr empty). The permission and disk shapes are
// git's usual wording, canned in tests and not observed on a failing sync.
// Anything else is `unknown`, never a guess.
const SHAPES: { reason: Reason; stage?: Stage; pattern: RegExp }[] = [
  { reason: "index-lock", pattern: /unable to create '[^\n]*index\.lock': file exists/i },
  { reason: "pathspec-missing", pattern: /pathspec '[^\n]*' did not match any files/i },
  { reason: "nothing-to-commit", stage: "commit", pattern: /nothing (?:added )?to commit|no changes added to commit/i },
  { reason: "no-space", pattern: /no space left on device|disk quota exceeded/i },
  { reason: "permission", pattern: /permission denied|operation not permitted/i },
];

// An empty commit's verdict as git prints it on stdout: at the start of a line,
// ending at a word boundary.
const EMPTY_COMMIT_VERDICT = /^(?:nothing (?:added )?to commit|no changes added to commit)\b/im;

class GitFailure extends Error {
  diagnostic: SyncDiagnostic;
  constructor(code: string, diagnostic: SyncDiagnostic) { super(code); this.diagnostic = diagnostic; }
}

/**
 * Read a stream to its end and keep only the last `keep` bytes of it. Reading
 * to the end is the point: a child that is not read from stops writing.
 */
async function drain(stream: ReadableStream<Uint8Array>, keep: number): Promise<string> {
  const reader = stream.getReader();
  let held = new Uint8Array(0);
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const joined = new Uint8Array(held.length + value.length);
    joined.set(held);
    joined.set(value, held.length);
    held = joined.length > keep ? joined.slice(joined.length - keep) : joined;
  }
  return new TextDecoder().decode(held);
}

function diagnose(stage: Stage, status: number, signal: string | null, stdout: string, stderr: string): SyncDiagnostic {
  if (signal) return { stage, reason: "signal", ...(SIGNALS.has(signal) ? { signal } : {}) };
  // stderr is sorted first. The one thing read from stdout is an empty commit,
  // which real git was seen to say there with stderr empty, and only at the
  // start of a line: the report that follows lists file names, indented, and a
  // name could say anything. No other shape is looked for in stdout.
  const shape = SHAPES.find(one => (one.stage === undefined || one.stage === stage) && one.pattern.test(stderr));
  const empty = !shape && stage === "commit" && EMPTY_COMMIT_VERDICT.test(stdout);
  return { stage, reason: shape?.reason ?? (empty ? "nothing-to-commit" : "unknown"), exit: status };
}

function errnoOf(error: unknown): string {
  const named = (error as { code?: unknown } | null)?.code;
  return typeof named === "string" && ERRNOS.has(named) ? named : "unknown";
}

/**
 * What a failure adds to the record. A refusal the sync made itself, which
 * throws its own code, is named by that code already and adds nothing.
 */
function diagnosisOf(error: unknown, code: string): SyncDiagnostic | undefined {
  if (error instanceof GitFailure) return error.diagnostic;
  if (error instanceof Error && error.message === code) return undefined;
  return { stage: "local", reason: "internal", errno: errnoOf(error) };
}

function describe(one: SyncDiagnostic): string {
  const parts = [`stage=${one.stage}`, `reason=${one.reason}`];
  if (one.exit !== undefined) parts.push(`exit=${one.exit}`);
  if (one.signal !== undefined) parts.push(`signal=${one.signal}`);
  if (one.errno !== undefined) parts.push(`errno=${one.errno}`);
  return parts.join(" ");
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
 * Every configuration key that tells git to start a program, or to read
 * configuration from somewhere else that could. A filter's `clean` runs on
 * every `add` and its `smudge` on every checkout, `core.sshCommand` and the
 * credential helper run on a fetch, a diff driver or a merge driver runs on a
 * rebase, an `insteadOf` rewrites a remote into one the `ext` transport would
 * run, and an `include` pulls in a file that can say any of it. The list is
 * what git's own documentation names as a command, and a new key git grows is
 * added here by name.
 */
export const PROGRAM_KEYS: RegExp[] = [
  /^filter\..+\.(clean|smudge|process)$/i,
  /^core\.(sshcommand|askpass|gitproxy|hookspath|fsmonitor|fsmonitorhookversion|alternaterefscommand|editor|pager|worktree)$/i,
  /^credential\.(.+\.)?helper$/i,
  /^gpg\.(.+\.)?program$/i,
  /^diff\.external$/i,
  /^diff\..+\.(command|textconv)$/i,
  /^merge\..+\.driver$/i,
  /^sequence\.editor$/i,
  /^remote\..+\.(proxy|uploadpack|receivepack|vcs)$/i,
  /^protocol\./i,
  /^url\..+\.(insteadof|pushinsteadof)$/i,
  /^include\.path$/i,
  /^includeif\./i,
  /^alias\./i,
  /^submodule\..+\.update$/i,
  /^uploadpack\./i,
  /^receive\./i,
];

/**
 * A key in the repository's own config that would start a program. Only the
 * repository's own scopes are asked: a helper the household's account
 * installed for itself, such as a large-file store, is that account's own
 * choice. The answer names the key, so the refusal can say what to remove.
 */
async function plantsProgram(path: string, code: string): Promise<string | null> {
  const listed = await git(path, ["config", "--list", "--show-scope", "--name-only"], code, "config");
  for (const line of listed.split("\n")) {
    const [scope, key = ""] = line.split("\t");
    if ((scope === "local" || scope === "worktree") && PROGRAM_KEYS.some(pattern => pattern.test(key))) return key;
  }
  return null;
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
    code, "status", { raw: true })).split("\0");
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
    await git(path, ["--literal-pathspecs", "add", "--all", "--pathspec-from-file=-", "--pathspec-file-nul"], code, "add",
      { input: toAdd.join("\0"), discard: true });
  }
  // What the commit takes is re-read after `add`: a file staged and then
  // deleted is gone from the index now, and naming it would fail the commit.
  // `diff` takes no pathspec file, so the whole index is listed, without
  // rename pairing so both halves of a rename show, and cut down to what
  // status named here.
  const listed = new Set(changed);
  const paths = (await git(path, ["diff", "--cached", "--no-renames", "--name-only", "-z"], code, "diff", { raw: true }))
    .split("\0").filter(name => listed.has(name));
  if (paths.length === 0) return 0;
  await git(path, ["--literal-pathspecs", "-c", "user.name=imprnt hub", "-c", "user.email=hub@localhost", "-c", "commit.gpgsign=false",
    "commit", "--no-verify", "--quiet", "-m", `hub sync: ${paths.length} files`, "--pathspec-from-file=-", "--pathspec-file-nul"],
    code, "commit", { input: paths.join("\0"), discard: true });
  return paths.length;
}

/** How many failed runs in a row reach the person, not only the journal. */
export const SYNC_NOTICE_AFTER_RUNS = 3;

interface RepoResult {
  id: string; required: boolean; status: string; code?: string; cause?: string;
  committed?: number; failed_runs?: number; failing_since?: string; diagnostic?: SyncDiagnostic;
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

/** The advisory lock a sync of one checkout holds on one machine, keyed by the real path of its common git directory. A move takes the same one. */
export const syncLockKey = (machine: string, commonDir: string): string => `sync:${machine}:${commonDir}`;

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
        if (realpathSync(await git(path, ["rev-parse", "--show-toplevel"], code, "toplevel")) !== path) throw new Error(code);
        const identity = realpathSync(await git(path, ["rev-parse", "--path-format=absolute", "--git-common-dir"], code, "common-dir"));
        const connection = await store.sql.reserve();
        let locked = false;
        try {
          code = "locked";
          const [row] = await connection`select pg_try_advisory_lock(hashtextextended(${syncLockKey(declared.machine, identity)}, 0)) as held`;
          locked = row.held;
          if (!locked) throw new Error(code);
          // Before any command that reads the working tree or dials the remote:
          // git runs a filter's program while it compares file contents and a
          // helper's while it fetches, so a key an agent wrote into the
          // repository's config would run on the first such command.
          code = "config";
          if (await plantsProgram(path, code) !== null) throw new Error(code);
          code = "branch";
          if (await git(path, ["symbolic-ref", "--quiet", "--short", "HEAD"], code, "branch") !== repo.branch) throw new Error(code);
          code = "remote";
          if (!(await git(path, ["remote"], code, "remote")).split("\n").includes(repo.remote)) throw new Error(code);
          // A merge left half done is refused before anything is added: an
          // `add` over conflict markers would commit them as the resolution.
          code = "conflict";
          const gitDir = await git(path, ["rev-parse", "--absolute-git-dir"], code, "git-dir");
          if (["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply"].some(one => existsSync(join(gitDir, one))) ||
              await git(path, ["diff", "--name-only", "--diff-filter=U"], code, "unmerged")) throw new Error(code);
          code = "commit";
          const nested = nestedIn(path, registry).map(one => `:(exclude,literal)${one}`);
          committed = await commitPending(path, nested, code);
          code = "fetch";
          // The registry's own ssh command for this repository, a deploy key
          // above all, rides on the two calls that dial the remote.
          const dial = repo.ssh_command === undefined ? [] : [`core.sshCommand=${repo.ssh_command}`];
          await git(path, ["fetch", "--", repo.remote, repo.branch], code, "fetch", { config: dial, discard: true });
          code = "conflict";
          await git(path, ["-c", "rebase.autoStash=false", "rebase", "FETCH_HEAD"], code, "rebase", { discard: true });
          code = "push";
          await git(path, ["push", "--", repo.remote, `HEAD:refs/heads/${repo.branch}`], code, "push", { config: dial, discard: true });
        } finally {
          try {
            if (locked) await connection`select pg_advisory_unlock(hashtextextended(${syncLockKey(declared.machine, identity)}, 0))`;
          } finally { connection.release(); }
        }
        results.push({ id: repo.id, required: repo.required, status: "success", ...(committed ? { committed } : {}) });
      } catch (error) {
        const cause = syncCause("en", code);
        const diagnostic = diagnosisOf(error, code);
        // The streak carries over from the last run's row, so a failure that
        // repeats every run is counted rather than only overwritten.
        const before = previous.find(one => one.id === repo.id && one.status === "failed");
        const failed_runs = (before ? before.failed_runs ?? 1 : 0) + 1;
        const failing_since = before?.failing_since ?? new Date().toISOString();
        results.push({ id: repo.id, required: repo.required, status: "failed", code, cause, failed_runs, failing_since,
          ...(committed ? { committed } : {}), ...(diagnostic ? { diagnostic } : {}) });
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
          { kind: "permanent", code: `sync-${repo.code}`, cause: repo.cause!,
            ...(repo.diagnostic ? { detail: describe(repo.diagnostic) } : {}) }, "hub");
        const person = repositoriesFor(registry, declared.id).find(one => one.id === repo.id)?.person;
        if (person && repo.failed_runs! >= SYNC_NOTICE_AFTER_RUNS) await noticeStuck(transaction, registry, declared.id, person, repo);
      }
      if (success) await recordJobSuccess(transaction, { entry: declared.id, machine: declared.machine, at: data.at });
    });
    if (!success) throw new Error("sync-failed");
  } finally { await store.close(); }
}
