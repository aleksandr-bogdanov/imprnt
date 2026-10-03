import { inSyncIsolation, isolatedGit, grantSyncRemotes, localRemoteProgram, SyncIsolationUnavailable } from "./isolation.ts";
import { tmpdir } from "node:os";
import { HUB_MCP_TEMP_PREFIX, LOOP_PROBE_TEMP_PREFIX, MAC_WRITABLE_SCRATCH } from "../box/scratch.ts";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { recordJobSuccess } from "../check/schedule.ts";
import { syncCause, syncStuck } from "../door/lines.ts";
import { prepareReply } from "../door/reply.ts";
import { recordOperationFailure } from "../door/health.ts";
import { appendEntry } from "../records/diary.ts";
import { putRow, readSheet } from "../records/statesheet.ts";
import { listAgents, listCredentials, listPeople, listRepositories, listRunEntries, noticeRoute, repositoriesFor } from "../registry/entries.ts";
import { readSetting, type Registry, type RunEntry } from "../registry/load.ts";
import { openStore, type StoreLike } from "../store/connect.ts";
import { configEntries } from "./git-config.ts";
import { storeUrlFor } from "../store/secrets.ts";

/**
 * One git call in a synced repository, with the repository's hooks turned off.
 *
 * Every Git process and descendant runs inside a sync-specific OS boundary.
 * Hooks remain disabled and executable repository configuration is refused
 * early; the sandbox contains configuration planted concurrently afterward.
 *
 * A failure throws a `GitFailure` that carries the step's label, its exit
 * status or signal and a reason from a closed list. What git printed is never
 * kept: it can contain credential-bearing remote urls. `discard` says the
 * caller reads no stdout, so only its tail is held, for the reason.
 */
async function git(path: string, args: string[], code: string, stage: Stage,
  options: { input?: string; raw?: boolean; config?: string[]; discard?: boolean } = {}): Promise<string> {
  // Preflight remains an early refusal, not the race boundary. Every command and
  // descendant is confined by launch(), even if configuration changes after this check.
  if (["unmerged", "status", "add", "diff", "commit", "fetch", "rebase", "push"].includes(stage) &&
      await plantsProgram(path, "config") !== null) throw new ConfigRefusal();
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
  const boxed = isolatedGit(["-C", path, "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false",
    "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", "-c", "push.gpgSign=false", "-c", "submodule.recurse=false", "-c", "diff.ignoreSubmodules=all",
    "-c", "protocol.ext.allow=never", "-c", "protocol.fd.allow=never",
    ...(options.config ?? []).flatMap(one => ["-c", one]), ...args]);
  return Bun.spawn(boxed.argv,
    { cwd: path, env: boxed.env, stdin: options.input === undefined ? "ignore" : new Blob([options.input]), stdout: "pipe", stderr: "pipe" });
}

/** The git steps a sync runs, by fixed label. A label is never built from a path or an argument. */
type Stage = "toplevel" | "common-dir" | "config" | "branch" | "remote" | "git-dir" | "unmerged"
  | "status" | "add" | "diff" | "commit" | "fetch" | "rebase" | "push" | "tracking-ref";

/**
 * What a failed step is called. A closed list of names and never git's own
 * words: git's diagnostics carry paths, remotes and credential-bearing urls,
 * and none of that may reach a row, the diary, the journal or a notice.
 * `unknown` is anything not recognised, which includes git speaking another
 * language, since the sync does not force one on git.
 */
type Reason = "index-lock" | "pathspec-missing" | "nothing-to-commit" | "permission" | "no-space"
  | "signal" | "spawn" | "internal" | "unknown";

type RemotePhase = "remote-list" | "fetch-urls" | "push-urls" | "writable-roots" | "local-fetch" | "local-push";
const EXCEPTION_TYPES = ["Error", "TypeError", "RangeError", "URIError", "SyntaxError", "ReferenceError", "EvalError", "AggregateError", "DOMException"] as const;
type ExceptionType = typeof EXCEPTION_TYPES[number] | "unknown";

/**
 * Where a run stopped and how, and nothing else: the step, the exit status or
 * the signal that ended it, and the reason's name. `local` is a failure outside
 * any git call, and `errno` is a standard code from the allowlist below. Remote
 * exceptions add a closed phase/type label, never their message or filesystem path.
 */
export interface SyncDiagnostic {
  stage: Stage | "local"; reason: Reason; exit?: number; signal?: string; errno?: string;
  remote_phase?: RemotePhase; exception?: ExceptionType;
}

/** How much of a step's output is held while it is drained. */
const DIAGNOSTIC_BYTES = 16 * 1024;

const SIGNALS = new Set(["SIGHUP", "SIGINT", "SIGQUIT", "SIGILL", "SIGABRT", "SIGBUS", "SIGFPE", "SIGKILL", "SIGSEGV", "SIGPIPE", "SIGTERM"]);
const ERRNOS = new Set(["ENOENT", "EACCES", "EPERM", "ENOMEM", "EMFILE", "ENFILE", "EAGAIN", "E2BIG", "ENOTDIR", "ELOOP",
  "ENAMETOOLONG", "EIO", "ENOSPC", "EINVAL", "ENOTSUP", "ENXIO", "ETIMEDOUT"]);

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

class ConfigRefusal extends Error {
  constructor() { super("config"); }
}

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

/** Attach only closed labels: exception messages and paths never leave this boundary. */
class RemoteFailure extends Error {
  readonly diagnostic: SyncDiagnostic;
  constructor(phase: RemotePhase, error: unknown) {
    super("remote");
    const name = (error as { name?: unknown } | null)?.name;
    const exception = EXCEPTION_TYPES.find(type => type === name) ?? "unknown";
    this.diagnostic = error instanceof GitFailure
      ? { ...error.diagnostic, remote_phase: phase }
      : { stage: "local", reason: "internal", remote_phase: phase, exception, errno: errnoOf(error) };
  }
}

async function remoteStep<T>(phase: RemotePhase, run: () => T | Promise<T>): Promise<T> {
  try { return await run(); }
  catch (error) {
    // A deliberate refusal retains its existing meaning, without an internal-error diagnostic.
    if (error instanceof Error && error.message === "remote" && !(error instanceof GitFailure)) throw error;
    throw new RemoteFailure(phase, error);
  }
}

/**
 * What a failure adds to the record. A refusal the sync made itself, which
 * throws its own code, is named by that code already and adds nothing.
 */
function diagnosisOf(error: unknown, code: string): SyncDiagnostic | undefined {
  if (error instanceof GitFailure || error instanceof RemoteFailure) return error.diagnostic;
  if (error instanceof Error && error.message === code) return undefined;
  return { stage: "local", reason: "internal", errno: errnoOf(error) };
}

function describe(one: SyncDiagnostic): string {
  const parts = [`stage=${one.stage}`, `reason=${one.reason}`];
  if (one.exit !== undefined) parts.push(`exit=${one.exit}`);
  if (one.signal !== undefined) parts.push(`signal=${one.signal}`);
  if (one.errno !== undefined) parts.push(`errno=${one.errno}`);
  if (one.remote_phase !== undefined) parts.push(`remote_phase=${one.remote_phase}`);
  if (one.exception !== undefined) parts.push(`exception=${one.exception}`);
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
  /^gpg\.ssh\.defaultkeycommand$/i,
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
  const listed = await git(path, ["config", "--list", "--show-scope", "--name-only", "-z"], code, "config", { raw: true });
  for (const { scope, key } of configEntries(Buffer.from(listed))) {
    if ((scope === "local" || scope === "worktree") && PROGRAM_KEYS.some(pattern => pattern.test(key))) return key;
  }
  return null;
}

/** Resolve components in filesystem order: symlink/.. is not a lexical parent. */
function canonical(path: string): string {
  let at = "/";
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") { at = dirname(at); continue; }
    const next = join(at, part);
    try { at = realpathSync(next); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      at = next;
    }
  }
  return at;
}

/** Local Git URLs are paths or file URLs; scp-style and network URLs are not local. */
function localRemote(path: string, url: string): string | null {
  if (url.startsWith("file://")) {
    // Preserve dot components until filesystem resolution (URL normalizes them).
    const match = /^file:\/\/[^/]*(\/.*)$/.exec(url);
    if (!match) throw new Error("remote");
    return decodeURIComponent(match[1]);
  }
  if (/^[^/]+:/.test(url)) return null;
  return isAbsolute(url) ? url : `${path}/${url}`;
}

/**
 * Local destinations any person can write are forbidden, even via a symlink
 * or separate pushurl. Passing this structural check does NOT authorize a
 * sandbox grant: grantSyncRemotes separately requires an exact owner-declared
 * canonical capability. get-url expands explicitly granted trusted rewrites.
 */
async function safeRemotes(path: string, remote: string, registry: Registry, code: string): Promise<{ fetch: string; push: string[] }> {
  // SSH-only sync must not touch unrelated local or automounted declarations.
  let forbidden: ((local: string, real: string) => boolean) | undefined;
  const writableRoots = () => {
    const state = readSetting(registry, "hub.state_dir");
    // Mirror effective box grants, not just each person's primary tree. Claude
    // rotates its login in the credential's parent; declared repositories can
    // live outside that tree. Include inactive declarations conservatively too.
    const granted = listPeople(registry).flatMap(person => [
      ...(person.tree ? [person.tree] : []),
      ...(typeof state === "string" && state ? [join(state, person.id)] : []),
    ]);
    granted.push(...listRepositories(registry).map(repo => repo.path).filter(Boolean));
    granted.push(...listCredentials(registry).filter(credential => credential.kind === "claude-login")
      .map(credential => dirname(credential.file)));
    if (process.platform === "darwin") granted.push(...MAC_WRITABLE_SCRATCH);
    const roots = [...new Set(granted)].map(root => ({ declared: resolve(root), real: canonical(resolve(root)) }));
    const temporary = canonical(tmpdir());
    // MCP grants only its per-launch directory, not all of tmpdir(). Protect the
    // namespace without scanning: launches can create new directories at any time.
    return (local: string, real: string) => {
      const path = relative(temporary, real);
      return (inside(temporary, real) && [HUB_MCP_TEMP_PREFIX, LOOP_PROBE_TEMP_PREFIX]
        .some(prefix => path.split("/")[0].startsWith(prefix))) ||
        roots.some(root => inside(root.declared, local) || inside(root.real, real));
    };
  };
  const resolved: string[][] = [];
  for (const push of [false, true]) {
    const destinations: string[] = [];
    const urls = await remoteStep(push ? "push-urls" : "fetch-urls", () =>
      git(path, ["remote", "get-url", "--all", ...(push ? ["--push"] : []), remote], code, "remote", { raw: true }));
    for (const url of urls.replace(/\n$/, "").split("\n")) {
      const phase = push ? "local-push" : "local-fetch";
      const local = await remoteStep(phase, () => localRemote(path, url));
      if (local === null) { destinations.push(url); continue; }
      forbidden ??= await remoteStep("writable-roots", writableRoots);
      const real = await remoteStep(phase, () => canonical(local));
      if (forbidden(local, real)) throw new Error(code);
      destinations.push(real);
    }
    resolved.push(destinations);
  }
  return { fetch: resolved[0][0], push: resolved[1] };
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
async function commitPending(path: string, nested: string[], code: string, guard: () => Promise<void>): Promise<number> {
  // Every untracked file is listed on its own, so the only directory status
  // names whole is a checkout of its own, which is left out. The paths are
  // handed over literally and on stdin: an excluding pathspec that names an
  // ignored directory makes `add` fail outright, and a vault left for days can
  // hold more changed paths than one command line takes.
  const entries = (await git(path, ["status", "--ignore-submodules=all", "--porcelain", "-z", "--untracked-files=all", "--", ".", ...nested],
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
    await guard();
    await git(path, ["--literal-pathspecs", "add", "--all", "--pathspec-from-file=-", "--pathspec-file-nul"], code, "add",
      { input: toAdd.join("\0"), discard: true });
  }
  // What the commit takes is re-read after `add`: a file staged and then
  // deleted is gone from the index now, and naming it would fail the commit.
  // `diff` takes no pathspec file, so the whole index is listed, without
  // rename pairing so both halves of a rename show, and cut down to what
  // status named here.
  const listed = new Set(changed);
  const paths = (await git(path, ["diff", "--ignore-submodules=all", "--cached", "--no-renames", "--name-only", "-z"], code, "diff", { raw: true }))
    .split("\0").filter(name => listed.has(name));
  if (paths.length === 0) return 0;
  await guard();
  await git(path, ["--literal-pathspecs", "-c", "user.name=imprnt hub", "-c", "user.email=hub@localhost", "-c", "commit.gpgsign=false",
    "commit", "--no-verify", "--quiet", "-m", `hub sync: ${paths.length} files`, "--pathspec-from-file=-", "--pathspec-file-nul"],
    code, "commit", { input: paths.join("\0"), discard: true });
  return paths.length;
}

/** A persistent failure reaches the owner after elapsed time, independent of cadence. */
export const SYNC_NOTICE_AFTER_MS = 30 * 60 * 1000;

interface RepoResult {
  id: string; required: boolean; status: string; code?: string; cause?: string;
  committed?: number; failed_runs?: number; failing_since?: string; notified_at?: string; diagnostic?: SyncDiagnostic;
}

/**
 * Tell the repository's person, in their own chat, that it has not synced for
 * at least thirty minutes. The notice is keyed on the start of the streak, so a run that
 * fails again says nothing new, and a streak that ends and starts again is a
 * new notice. A person with no chat agent has nowhere for it to land, and
 * `check` goes on reporting `sync-failed` for them.
 */
async function noticeStuck(store: StoreLike, registry: Registry, entry: string, person: string, repo: RepoResult, at: Date): Promise<boolean> {
  // The person's resident agent is the chat they keep open, the lair for the
  // owner and the main chat for anyone with one, so the notice lands where it
  // is read. A person with none gets it in their first chat.
  const chats = listAgents(registry).filter(one => one.person === person && one.chat !== undefined && one.door !== undefined);
  const agent = chats.find(one => one.mode === "resident") ?? chats[0];
  const where = agent ? noticeRoute(registry, agent.id) : null;
  if (!agent || !where) return false;
  const body = syncStuck(where.language, { target: repo.id, minutes: Math.floor((at.getTime() - Date.parse(repo.failing_since!)) / 60_000), cause: syncCause(where.language, repo.code!) });
  const key = `sync-stuck:${entry}:${repo.id}:${repo.failing_since}`;
  for (const [index, part] of prepareReply(body, where.platform, where.language).entries()) {
    await store.sql`select hub_door_notice(${person}, ${agent.id}, ${part}, ${index === 0 ? key : `${key}:part:${index + 1}`},
      ${where.route}::jsonb, ${index + 1})`;
  }
  return true;
}

/** The advisory lock a sync of one checkout holds on one machine, keyed by the real path of its common git directory. A move takes the same one. */
export const syncLockKey = (machine: string, commonDir: string): string => `sync:${machine}:${commonDir}`;

class SyncGuardRefusal extends Error {
  constructor(readonly code: "changed" | "operation") { super(code); }
}

/** Cooperative locks cannot fence an unrelated Git/file writer. These checks
 * detect changed ownership/state at each boundary and never repair it. */
async function checkoutGuard(path: string, gitDir: string, branch: string, expected?: string): Promise<string> {
  const unfinished = () => ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply", "sequencer"]
    .some(one => existsSync(join(gitDir, one)));
  if (unfinished() || await git(path, ["diff", "--ignore-submodules=all", "--name-only", "--diff-filter=U"], "operation", "unmerged")) throw new SyncGuardRefusal("operation");
  let currentBranch: string;
  try { currentBranch = await git(path, ["symbolic-ref", "--quiet", "HEAD"], "changed", "branch"); }
  catch (error) { if (error instanceof GitFailure) throw new SyncGuardRefusal("changed"); throw error; }
  const head = await git(path, ["rev-parse", "--verify", "HEAD^{commit}"], "changed", "tracking-ref");
  if (currentBranch !== branch || (expected !== undefined && head !== expected)) throw new SyncGuardRefusal("changed");
  if (unfinished()) throw new SyncGuardRefusal("operation");
  return head;
}

/** Entry ownership includes result publication, so a contending tick cannot
 * read stale streak state and later overwrite the active tick's success. */
export const syncEntryLockKey = (entry: string): string => `sync-entry:${entry}`;

export async function runSync(entry: RunEntry, registry: Registry, options: { now?: () => Date } = {}): Promise<void> {
  const declared = listRunEntries(registry).find(one => one.id === entry?.id && one.kind === "sync");
  if (!declared) throw new Error("sync-entry-unknown");
  const now = options.now ?? (() => new Date());
  const store = await openStore({ url: storeUrlFor(registry, "hub_hub", declared.id) });
  const results: RepoResult[] = [];
  let connection: Awaited<ReturnType<typeof store.sql.reserve>> | undefined;
  const held: string[] = [];
  try {
    connection = await store.sql.reserve();
    const entryKey = syncEntryLockKey(declared.id);
    const [owner] = await connection`select pg_try_advisory_lock(hashtextextended(${entryKey}, 0)) as held`;
    // This invocation did no work. The running owner alone publishes its result;
    // a skipped schedule neither clears nor advances a failure streak.
    if (!owner.held) return;
    held.push(entryKey);
    const previous = ((await readSheet(store, "sync")).find(row => row.id === declared.id)?.data.repositories ?? []) as RepoResult[];
    for (const repo of repositoriesFor(registry, declared.id)) {
      let committed = 0;
      let code = "path";
      try {
        const path = realpathSync(repo.path);
        code = "person";
        const person = listPeople(registry).find(one => one.id === repo.person);
        if (!person?.tree || !inside(realpathSync(person.tree), path)) throw new Error(code);
        await inSyncIsolation(registry, repo, async () => {
          code = "path";
          if (realpathSync(await git(path, ["rev-parse", "--show-toplevel"], code, "toplevel")) !== path) throw new Error(code);
          const identity = realpathSync(await git(path, ["rev-parse", "--path-format=absolute", "--git-common-dir"], code, "common-dir"));
          code = "locked";
          const key = syncLockKey(declared.machine, identity);
          if (!held.includes(key)) {
            const [row] = await connection!`select pg_try_advisory_lock(hashtextextended(${key}, 0)) as held`;
            if (!row.held) throw new Error(code);
            held.push(key);
          }
          code = "config";
          if (await plantsProgram(path, code) !== null) throw new Error(code);
          code = "branch";
          const branchRef = `refs/heads/${repo.branch}`;
          const trackingRef = `refs/remotes/${repo.remote}/${repo.branch}`;
          await git(path, ["check-ref-format", branchRef], code, "branch");
          await git(path, ["check-ref-format", trackingRef], code, "branch");
          if (await git(path, ["for-each-ref", "--format=%(symref)", trackingRef], code, "branch")) throw new Error(code);
          const gitDir = await git(path, ["rev-parse", "--absolute-git-dir"], code, "git-dir");
          let head = await checkoutGuard(path, gitDir, branchRef);
          const guard = async () => { await checkoutGuard(path, gitDir, branchRef, head); };
          code = "remote";
          if (!(await remoteStep("remote-list", () => git(path, ["remote"], code, "remote"))).split("\n").includes(repo.remote)) throw new Error(code);
          const remote = await safeRemotes(path, repo.remote, registry, code);
          grantSyncRemotes(remote.fetch, remote.push);
          code = "commit";
          const nested = nestedIn(path, registry).map(one => `:(exclude,literal)${one}`);
          committed = await commitPending(path, nested, code, guard);
          if (committed) {
            const created = await checkoutGuard(path, gitDir, branchRef);
            // Our normal commit has exactly the head we checked as its parent.
            const parent = await git(path, ["rev-list", "--parents", "-n", "1", created], "changed", "tracking-ref");
            if (parent !== `${created} ${head}`) throw new SyncGuardRefusal("changed");
            head = created;
          }
          code = "fetch";
          const dial = repo.ssh_command === undefined ? [] : [`core.sshCommand=${repo.ssh_command}`];
          await guard();
          // A local remote's upload-pack/receive-pack child gets exact granted trust and disables hooks, fsmonitor and alternate-ref commands.
          await git(path, ["fetch", "--no-recurse-submodules", ...(isAbsolute(remote.fetch) ? [`--upload-pack=${localRemoteProgram(remote.fetch, "upload-pack")}`] : []), "--", remote.fetch, `+${branchRef}:${trackingRef}`], code, "fetch", { config: dial, discard: true });
          const fetched = await git(path, ["rev-parse", "--verify", `${trackingRef}^{commit}`], code, "tracking-ref");
          code = "conflict";
          await guard();
          // FETCH_HEAD is shared mutable state. Rebase only the captured commit.
          await git(path, ["-c", "rebase.autoStash=false", "rebase", fetched], code, "rebase", { discard: true });
          head = await checkoutGuard(path, gitDir, branchRef);
          code = "push";
          for (const destination of remote.push) {
            await guard();
            await git(path, ["push", "--no-recurse-submodules", ...(isAbsolute(destination) ? [`--receive-pack=${localRemoteProgram(destination, "receive-pack")}`] : []), "--", destination, `${head}:${branchRef}`], code, "push", { config: dial, discard: true });
          }
          await guard();
          await git(path, ["update-ref", "--no-deref", trackingRef, head, fetched], code, "tracking-ref");
          await guard();
        });
        results.push({ id: repo.id, required: repo.required, status: "success", ...(committed ? { committed } : {}) });
      } catch (error) {
        if (error instanceof ConfigRefusal) code = "config";
        if (error instanceof SyncIsolationUnavailable) code = "isolation";
        if (error instanceof SyncGuardRefusal) code = error.code;
        const cause = syncCause("en", code);
        const diagnostic = diagnosisOf(error, code);
        const before = previous.find(one => one.id === repo.id && one.status === "failed");
        const failed_runs = (before ? before.failed_runs ?? 1 : 0) + 1;
        const failing_since = before?.failing_since && Number.isFinite(Date.parse(before.failing_since)) ? before.failing_since : now().toISOString();
        results.push({ id: repo.id, required: repo.required, status: "failed", code, cause, failed_runs, failing_since,
          ...(before?.notified_at ? { notified_at: before.notified_at } : {}),
          ...(committed ? { committed } : {}), ...(diagnostic ? { diagnostic } : {}) });
      }
    }
    const success = results.every(one => !one.required || one.status === "success");
    const at = now();
    const data = { machine: declared.machine, status: success ? "success" : "failed", repositories: results, at: at.toISOString() };
    await store.sql.begin(async sql => {
      const transaction = { sql, url: store.url } as StoreLike;
      for (const repo of results) if (repo.status === "failed") {
        await recordOperationFailure(transaction, "sync", declared.id, repo.id,
          { kind: "permanent", code: `sync-${repo.code}`, cause: repo.cause!,
            ...(repo.diagnostic ? { detail: describe(repo.diagnostic) } : {}) }, "hub");
        const person = repositoriesFor(registry, declared.id).find(one => one.id === repo.id)?.person;
        if (person && !repo.notified_at && at.getTime() - Date.parse(repo.failing_since!) >= SYNC_NOTICE_AFTER_MS &&
            await noticeStuck(transaction, registry, declared.id, person, repo, at)) repo.notified_at = at.toISOString();
      }
      // The notice marker and queued notice commit together. It survives outbox
      // retention, so a later tick cannot notify again in the same streak.
      await putRow(transaction, "sync", declared.id, data);
      await appendEntry(transaction, { stream: "machine", subject: declared.id, kind: "sync", actor: "hub", detail: data });
      if (success) await recordJobSuccess(transaction, { entry: declared.id, machine: declared.machine, at: data.at });
    });
    if (!success) throw new Error("sync-failed");
  } finally {
    try {
      if (connection) {
        try { for (const key of held.reverse()) await connection`select pg_advisory_unlock(hashtextextended(${key}, 0))`; }
        finally { connection.release(); }
      }
    } finally { await store.close(); }
  }
}
