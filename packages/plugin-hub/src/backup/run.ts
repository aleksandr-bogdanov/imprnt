import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, sep } from "node:path";
import { recordJobSuccess } from "../check/schedule.ts";
import { recordOperationFailure } from "../diagnostics.ts";
import { putRow } from "../records/statesheet.ts";
import {
  backupStagingFor,
  listAgents,
  listCredentials,
  listPeople,
  listRepositories,
  listRunEntries,
} from "../registry/entries.ts";
import { BACKUP_PLACEHOLDERS, readSetting, type Registry, type RepositoryEntry, type RunEntry } from "../registry/load.ts";
import { localRemotePath, remoteUrlOf } from "../registry/remote.ts";
import { openStore, type StoreLike } from "../store/connect.ts";
import { secretsDirOf, storeUrlFor } from "../store/secrets.ts";
import { buildManifest, MANIFEST_FILE, renderManifest, sameBytes, sha256 } from "./manifest.ts";

/**
 * The interim off-box copy: the store, the vaults, the chat state and the
 * configuration, assembled on the box and sent somewhere else every hour.
 *
 * NO PROVIDER IS NAMED HERE, and none may be. The three commands are argv lists
 * from the registry and the destination is a string they receive. The job fills
 * each placeholder into the argument it appears in and hands every argument to
 * the program as one argument, so nothing is ever read by a shell and changing
 * where the copy goes is one line in a private file. Which tool moves the bytes
 * is the household's business and none of this module's.
 *
 * WHERE IT GOES IS AN ASSUMPTION, not a ruling. The household's other machine,
 * the mac, over the household's private network, into a private directory
 * outside every repository, because it is the only other machine that is always
 * reachable and already trusted. Two things about it are not measured: whether
 * that machine is reachable at every hour, and how large and how long a copy
 * is. A missed hour is the shipped `job-stale` finding, by design.
 *
 * A COPY COUNTS ONLY WHEN IT READS BACK. The upload exiting zero proves that a
 * program exited zero. So the dump and the manifest are read back from the
 * destination and compared byte for byte, and only then are the sheet row and
 * the shipped success stamp written, in one transaction. An upload that did
 * nothing, or that left last hour's copy in place, reads back something else
 * and is a failure with a cause.
 */
export const BACKUP_SHEET = "backup";

/** Where the copy is assembled, relative to the staging directory. */
const DUMP_DIR = "dump";
const DUMP_FILE = "hub.sql";
const FILES_DIR = "files";
const READBACK_DIR = ".readback";

/** The two files a copy is judged by, relative to the copy's root. */
const READ_BACK = [`${DUMP_DIR}/${DUMP_FILE}`, MANIFEST_FILE];

/**
 * What never leaves the box, and why, one line each. Every path they name is
 * left out of every tree the copy walks, so a secret kept inside a vault stays
 * behind too. Getting each one back is a step of the owner's procedure, never
 * a copy.
 */
export const NEVER_COPIED: { what: string; why: string; paths(registry: Registry, stateDir: string): string[] }[] = [
  { what: "the store role passwords", why: "installing the database writes them again",
    paths: (registry) => [secretsDirOf(registry) ?? ""] },
  { what: "every door's token file", why: "a bot token, issued again by its platform",
    paths: (registry) => listRunEntries(registry).map((entry) => entry.token_file ?? "") },
  { what: "every declared credential file", why: "a login or a key, obtained again from its issuer",
    paths: (registry) => listCredentials(registry).map((one) => one.file) },
  { what: "every session cache", why: "a model's working copy, rebuilt from the chat log",
    paths: (registry, stateDir) => listPeople(registry).map((person) => join(stateDir, person.id, "sessions")) },
  { what: "the service logs", why: "a program's own output, which can carry what it was handed",
    paths: (_registry, stateDir) => [join(stateDir, "service-log")] },
];

export interface BackupResult {
  at: string;
  machine: string;
  files: number;
  bytes: number;
  dump_sha256: string;
  /** Whether the dump changed since the last copy and was committed. */
  committed: boolean;
  /** The declared repositories left out because their remote is off the box. */
  left_out?: string[];
}

/**
 * Which declared repositories the copy takes, and which it leaves out.
 *
 * A repository whose remote is on another host is already kept somewhere
 * else, and sending its whole history off the box every day was most of a
 * copy for nothing. One whose remote is on this box, or whose checkout names
 * no remote this can read, is the household's only copy and goes.
 */
/**
 * Every path the copy's walk steps over, as the file system names it: what
 * never leaves the box, the staging directory itself, and every repository
 * left out because its remote is off the box. The last matters when such a
 * repository is a person's vault or sits inside one: the vault is copied
 * whole, and without this the repository named as left out went anyway.
 */
export function excludedFromCopy(registry: Registry, where: { stateDir: string; staging: string; leftOut: RepositoryEntry[] }): string[] {
  return [
    ...NEVER_COPIED.flatMap((one) => one.paths(registry, where.stateDir)),
    where.staging,
    ...where.leftOut.map((repo) => repo.path),
  ].filter((path) => path !== "").map((path) => real(path) ?? path);
}

export function repositoriesToCopy(registry: Registry): { copied: RepositoryEntry[]; leftOut: RepositoryEntry[] } {
  const copied: RepositoryEntry[] = [];
  const leftOut: RepositoryEntry[] = [];
  for (const repo of listRepositories(registry)) {
    let url: string | null = null;
    let local: string | null = null;
    try { url = remoteUrlOf(repo.path, repo.remote); local = localRemotePath(repo.path, repo.remote); } catch { url = null; }
    (url !== null && local === null ? leftOut : copied).push(repo);
  }
  return { copied, leftOut };
}

/**
 * A copy that did not land. `code` is the step it stopped at, `reason` is one
 * of the closed list's causes, and `detail` is for the diary only.
 */
export class BackupRefused extends Error {
  readonly code: string;
  readonly reason: string;
  readonly detail: string;

  constructor(code: string, reason: string, detail = "") {
    super(`backup-${code}: ${reason}${detail === "" ? "" : `: ${detail}`}`);
    this.name = "BackupRefused";
    this.code = code;
    this.reason = reason;
    this.detail = detail;
  }
}

type Placeholder = (typeof BACKUP_PLACEHOLDERS)[number] extends `{${infer Name}}` ? Name : never;

/**
 * The placeholders filled into each argument in ONE pass, so a value that
 * happens to contain a placeholder's spelling is never filled in again.
 */
function fill(argv: string[], values: Partial<Record<Placeholder, string>>): string[] {
  const known = new Set<string>(BACKUP_PLACEHOLDERS);
  return argv.map((arg) => arg.replace(/\{[A-Za-z_]+\}/g, (token) =>
    known.has(token) ? values[token.slice(1, -1) as Placeholder] ?? token : token));
}

/**
 * One command, as argv. Its diagnostics are discarded: a copy tool's own words
 * can carry a destination with a login in it, and they would land in a journal
 * every process of this account can read.
 */
async function run(argv: string[], code: string, reason: string, keep = false): Promise<Uint8Array> {
  let child;
  try {
    child = Bun.spawn(argv, { env: process.env, stdin: "ignore", stdout: keep ? "pipe" : "ignore", stderr: "ignore" });
  } catch {
    throw new BackupRefused(code, reason, `${argv[0]} could not be started`);
  }
  const [out, status] = await Promise.all([
    keep ? new Response(child.stdout as ReadableStream).arrayBuffer().then((buffer) => new Uint8Array(buffer)) : Promise.resolve(new Uint8Array()),
    child.exited,
  ]);
  if (status !== 0) throw new BackupRefused(code, reason, `${argv[0]} exited ${status}`);
  return out;
}

/**
 * Git in the dump's own repository, answering what it printed. `absent` is the
 * one call whose exit 1 is an answer rather than a failure: the name it was
 * asked about is not in the last commit, or there is no commit yet.
 */
async function git(dir: string, args: string[], absent = false): Promise<string | null> {
  const child = Bun.spawn(["git", "-C", dir, "-c", "user.name=imprnt-hub", "-c", "user.email=hub@localhost",
    "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args],
  { env: process.env, stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  const [out, status] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  if (absent && status === 1) return null;
  if (status !== 0) throw new BackupRefused("commit", "operation failed", `git ${args[0]} exited ${status}`);
  return out.trim();
}

/**
 * The filesystem a destination would be written to, or null when it does not
 * name a local path at all. This is the one question asked of the
 * destination, and it is asked of the filesystem rather than of the string: an
 * absolute path is judged by the nearest directory of it that exists, so a copy
 * aimed at a drive that is not plugged in is judged by the card it would really
 * land on.
 *
 * WHAT IT CAN PROMISE, AND WHAT IT CANNOT. It compares filesystems, which is
 * all a device number says. A destination on the staging directory's own
 * filesystem is refused. Another filesystem on the same card or disk is NOT
 * told apart from a separate drive: a boot partition beside the root one, a
 * sibling volume in the same APFS container, and a RAM disk, which is gone at
 * the next boot, all pass. Choosing a destination that is really somewhere
 * else stays the household's part.
 */
function deviceOf(destination: string): number | null {
  if (!isAbsolute(destination)) return null;
  for (let at = destination; ; at = dirname(at)) {
    try {
      return statSync(at).dev;
    } catch {
      if (dirname(at) === at) return null;
    }
  }
}

function real(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

function within(root: string, path: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

/**
 * Copy one tree into the copy, links as links and nothing else but files and
 * directories. Every path is compared by its real path, so a secret reached
 * through another spelling of its directory is still left out.
 */
function copyTree(from: string, to: string, left: string[]): void {
  if (left.some((out) => within(out, from))) return;
  const kind = lstatSync(from);
  if (kind.isSymbolicLink()) {
    mkdirSync(dirname(to), { recursive: true });
    symlinkSync(readlinkSync(from), to);
  } else if (kind.isDirectory()) {
    mkdirSync(to, { recursive: true });
    for (const name of readdirSync(from)) copyTree(join(from, name), join(to, name), left);
  } else if (kind.isFile()) {
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(from, to);
  }
}

/**
 * Whether the upload command is handed the destination as a path of its own,
 * which is the only case in which the destination names a place on this box.
 *
 * The household's likely shape puts the other machine in the command itself
 * (`mac:{destination}`) and keeps the destination a plain path on that
 * machine. Judged here, that path is a directory on this box's own disk, and
 * every copy would be refused. Nothing about the argument is parsed: one that
 * starts with the destination hands the command a path, and one that carries
 * it after anything else is the command's business.
 */
function handedAsPath(upload: string[]): boolean {
  return upload.some((arg) => arg.startsWith("{destination}"));
}

/** Where a path on the box lands inside the copy: its own absolute path, under `files/`. */
function mirror(staging: string, path: string): string {
  return join(staging, FILES_DIR, path.replace(/^\/+/, ""));
}

export async function runBackup(entry: RunEntry, registry: Registry): Promise<BackupResult> {
  const declared = listRunEntries(registry).find((one) => one.id === entry?.id && one.kind === "backup");
  if (!declared) throw new Error("backup-entry-unknown");
  const stateDir = String(readSetting(registry, "hub.state_dir") ?? "");
  const staging = backupStagingFor(registry);
  if (staging === null || stateDir === "") throw new BackupRefused("stage", "invalid configuration", "hub.state_dir is not set");
  const destination = String(declared.destination);
  const machine = declared.machine;
  const store = await openStore({ url: storeUrlFor(registry, "hub_hub", declared.id) });
  const readback = join(staging, READBACK_DIR);
  try {
    // REFUSE FIRST, before anything is dumped or sent. A copy on the filesystem
    // that dies is not a copy. The staging directory is the account's own,
    // because it holds every person's files at once.
    mkdirSync(staging, { recursive: true, mode: 0o700 });
    if (handedAsPath(declared.upload_argv ?? []) && deviceOf(destination) === statSync(staging).dev) {
      throw new BackupRefused("device", "same device", "the destination is on the staging directory's own filesystem");
    }

    // THE DUMP, in its own repository, committed only when it changed. A dump
    // command that exits zero and says nothing is the same failure as an
    // upload that does nothing.
    const dump = await run(fill(declared.dump_argv ?? [], { staging, destination }), "dump", "operation failed", true);
    if (dump.length === 0) throw new BackupRefused("dump", "operation failed", "the dump command wrote nothing");
    const dumpDir = join(staging, DUMP_DIR);
    mkdirSync(dumpDir, { recursive: true });
    if (!existsSync(join(dumpDir, ".git"))) await git(dumpDir, ["init", "-q"]);
    const dumpFile = join(dumpDir, DUMP_FILE);
    if (!existsSync(dumpFile) || !sameBytes(readFileSync(dumpFile), dump)) writeFileSync(dumpFile, dump);
    // Whether it changed is asked of the last COMMIT, with two calls that never
    // write git's index. An unchanged dump then leaves every byte of the
    // repository as it was, and a dump written by a copy that died before its
    // commit is still committed by the next one.
    const changed = (await git(dumpDir, ["hash-object", "--", DUMP_FILE])) !==
      (await git(dumpDir, ["rev-parse", "--verify", "--quiet", `HEAD:${DUMP_FILE}`], true));
    if (changed) {
      await git(dumpDir, ["add", "--", DUMP_FILE]);
      await git(dumpDir, ["commit", "-q", "-m", `the hub's store, dumped at ${new Date().toISOString()}`]);
    }

    // THE REST, fresh every time. Only what this job put here is cleared, so
    // nothing else that happens to sit beside the dump is ever deleted.
    for (const own of [FILES_DIR, MANIFEST_FILE, READBACK_DIR]) rmSync(join(staging, own), { recursive: true, force: true });
    const repositories = repositoriesToCopy(registry);
    const left = excludedFromCopy(registry, { stateDir, staging, leftOut: repositories.leftOut });
    const trees: { path: string; required: boolean }[] = [
      // Working trees whole, repositories included, so uncommitted and
      // unpushed work is in the copy. A zone checkout sits inside its vault.
      ...listPeople(registry).filter((person) => person.vault).map((person) => ({ path: person.vault!, required: true })),
      ...repositories.copied.map((repo) => ({ path: repo.path, required: true })),
      ...listPeople(registry).flatMap((person) => [
        { path: join(stateDir, person.id, "chatlog"), required: false },
        { path: join(stateDir, person.id, "inbox"), required: false },
      ]),
      { path: registry.file, required: true },
      // The non-secret files the registry names.
      ...listAgents(registry).flatMap((agent) => [agent.fragment, agent.settings, agent.mcp])
        .filter((path): path is string => typeof path === "string" && path !== "")
        .map((path) => ({ path, required: true })),
      ...listPeople(registry).map((person) => person.filing_rules)
        .filter((path): path is string => typeof path === "string" && path !== "")
        .map((path) => ({ path, required: true })),
    ];
    const taken: string[] = [];
    for (const tree of trees) {
      const from = real(tree.path);
      if (from === null) {
        if (tree.required) throw new BackupRefused("stage", "operation failed", `${tree.path} is declared and absent`);
        continue;
      }
      // One inside another is already in the copy, once.
      if (taken.some((root) => within(root, from))) continue;
      copyTree(from, mirror(staging, isAbsolute(tree.path) ? tree.path : from), left);
      taken.push(from);
    }

    // THE MANIFEST, last.
    const at = new Date().toISOString();
    const files = buildManifest(staging);
    writeFileSync(join(staging, MANIFEST_FILE), renderManifest({ at, machine, files }));

    await run(fill(declared.upload_argv ?? [], { staging, destination }), "upload", "operation failed");

    // THE READ-BACK, into a scratch directory inside the staging directory so
    // it is fenced from every agent's box the way the copy is. It is made after
    // the upload and gone before the next one.
    mkdirSync(readback, { recursive: true });
    const names = declared.readback_argv ?? [];
    const intoFile = names.some((arg) => arg.includes("{out}"));
    for (const [n, path] of READ_BACK.entries()) {
      const out = join(readback, String(n));
      const said = await run(fill(names, { destination, path, out }), "readback", "copy does not match", !intoFile);
      let received: Uint8Array;
      try {
        received = intoFile ? readFileSync(out) : said;
      } catch {
        throw new BackupRefused("readback", "copy does not match", `nothing was read back for ${path}`);
      }
      if (!sameBytes(readFileSync(join(staging, path)), received)) {
        throw new BackupRefused("compare", "copy does not match", `${path} read back different bytes`);
      }
    }

    // THE STAMP, only now, and the sheet row with it or neither.
    const landed = {
      at: new Date().toISOString(),
      machine,
      files: files.length,
      bytes: files.reduce((sum, one) => sum + one.size, 0),
      dump_sha256: sha256(dump),
      ...(repositories.leftOut.length === 0 ? {} : { left_out: repositories.leftOut.map((repo) => repo.id) }),
    };
    try {
      await store.sql.begin(async (sql) => {
        const transaction = { sql, url: store.url } as StoreLike;
        await putRow(transaction, BACKUP_SHEET, declared.id, landed);
        await recordJobSuccess(transaction, { entry: declared.id, machine, at: landed.at });
      });
    } catch {
      throw new BackupRefused("stamp", "operation failed", "the stamp could not be written");
    }
    return { ...landed, committed: changed };
  } catch (error) {
    // Anything else is the filesystem refusing the copy, and its errno code is
    // the one part of it that is safe to keep.
    const refused = error instanceof BackupRefused ? error : new BackupRefused("stage", "operation failed",
      `the copy could not be assembled: ${String((error as { code?: unknown })?.code ?? "unknown error")}`);
    try {
      await store.sql.begin(async (sql) => {
        const transaction = { sql, url: store.url } as StoreLike;
        await putRow(transaction, BACKUP_SHEET, declared.id,
          { at: new Date().toISOString(), machine, status: "failed", code: refused.code, cause: refused.reason });
        await recordOperationFailure(transaction, { operation: "backup", target: declared.id,
          error: { code: `backup-${refused.code}`, message: refused.detail === "" ? refused.reason : `${refused.reason}: ${refused.detail}` } });
      });
    } catch { /* the failure is thrown whether or not it could be recorded */ }
    throw refused;
  } finally {
    rmSync(readback, { recursive: true, force: true });
    await store.close();
  }
}
