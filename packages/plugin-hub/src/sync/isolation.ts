import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { listCredentials, listPeople, listRepositories, listRunEntries, backupStagingFor } from "../registry/entries.ts";
import { readSetting, type Registry, type RepositoryEntry } from "../registry/load.ts";
import { secretsDirOf } from "../store/secrets.ts";

/** No unboxed fallback: a missing/refused sandbox stops this repository's sync. */
export class SyncIsolationUnavailable extends Error {
  constructor() { super("isolation"); }
}

interface Boundary {
  scratch: string;
  read: string[];
  write: string[];
  deny: string[];
  git: string;
}
const active = new AsyncLocalStorage<Boundary>();
const existing = (paths: string[]) => [...new Set(paths.filter(Boolean).filter(existsSync).map(path => realpathSync(path)))];
const within = (root: string, path: string) => path === root || path.startsWith(`${root}/`);

let macGit: string | undefined;
function developerGit(): string {
  if (macGit !== undefined) return macGit;
  const result = Bun.spawnSync(["/usr/bin/xcrun", "--find", "git"], { stdout: "pipe", stderr: "ignore" });
  if (result.exitCode !== 0) throw new SyncIsolationUnavailable();
  return macGit = result.stdout.toString().trim();
}

/** Resolve the system's real Git, avoiding Apple's xcrun launcher inside the box. */
function gitBinary(): string {
  let git = Bun.which("git");
  if (process.platform === "darwin" && git === "/usr/bin/git") {
    git = developerGit();
  }
  if (!git || !existsSync(git)) throw new SyncIsolationUnavailable();
  return realpathSync(git);
}

/** Every Git process, including configuration/discovery, is already confined when Git first reads mutable metadata. */
export async function inSyncIsolation<T>(registry: Registry, repo: RepositoryEntry, work: () => Promise<T>): Promise<T> {
  if (!(process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec")) &&
      !(process.platform === "linux" && existsSync("/usr/bin/bwrap"))) throw new SyncIsolationUnavailable();
  const person = listPeople(registry).find(one => one.id === repo.person);
  if (!person?.tree) throw new SyncIsolationUnavailable();
  const state = String(readSetting(registry, "hub.state_dir") ?? "");
  const denied = existing([
    ...listPeople(registry).filter(one => one.id !== repo.person).flatMap(one => [one.tree ?? "", state ? join(state, one.id) : ""]),
    ...listRepositories(registry).filter(one => one.person !== repo.person).map(one => one.path),
    secretsDirOf(registry) ?? "", backupStagingFor(registry) ?? "",
    ...listCredentials(registry).map(one => one.file), ...listRunEntries(registry).map(one => one.token_file ?? ""),
  ]).filter(path => path !== "/dev/null");
  const read = existing(repo.sync_read_paths ?? []);
  const tree = realpathSync(person.tree);
  if (!within(tree, realpathSync(repo.path))) throw new SyncIsolationUnavailable();
  // A grant is not allowed to expose declared household secrets or another person's tree.
  if ([tree, ...read].some(path => denied.some(secret => within(path, secret) || within(secret, path)))) throw new SyncIsolationUnavailable();
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), "hub-sync-box-")));
  try {
    return await active.run({ scratch, read, write: [tree], deny: denied, git: gitBinary() }, async () => {
      const probe = isolatedGit(["-C", repo.path, "--version"]);
      try {
        const child = Bun.spawn(probe.argv, { cwd: repo.path, env: probe.env, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
        if (await child.exited !== 0) throw new SyncIsolationUnavailable();
      } catch { throw new SyncIsolationUnavailable(); }
      return await work();
    });
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}

/** Called only after safeRemotes accepted every destination. This is not a grant from a config file. */
export function grantSyncRemotes(fetch: string, push: string[]): void {
  const boundary = active.getStore();
  if (!boundary) throw new SyncIsolationUnavailable();
  for (const path of [fetch, ...push].filter(one => one.startsWith("/"))) {
    if (boundary.deny.some(secret => within(path, secret) || within(secret, path))) throw new SyncIsolationUnavailable();
  }
  boundary.read.push(...existing([fetch].filter(one => one.startsWith("/"))));
  boundary.write.push(...existing(push.filter(one => one.startsWith("/"))));
}

/** Trusted inherited process configuration only; no tokens, sockets, loaders or Git environment overrides enter the child. */
function environment(scratch: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of ["PATH", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "USER", "LOGNAME", "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"]) {
    if (process.env[name] !== undefined) env[name] = process.env[name]!;
  }
  return { ...env, HOME: scratch, XDG_CONFIG_HOME: scratch, TMPDIR: scratch,
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" };
}

/** Build a kernel boundary inherited by filters, aliases, transport helpers, and all their descendants. */
export function isolatedGit(args: string[]): { argv: string[]; env: Record<string, string> } {
  const b = active.getStore();
  if (!b) throw new SyncIsolationUnavailable();
  const system = process.platform === "darwin"
    ? ["/usr", "/bin", "/sbin", "/System", "/Library/Developer", "/Library/Apple", "/private/etc", "/private/var/db", "/private/var/select", "/opt/homebrew"]
    : ["/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc/ssl", "/etc/ssh", "/etc/hosts", "/etc/resolv.conf", "/etc/nsswitch.conf", "/etc/passwd", "/etc/group", "/etc/ld.so.cache"];
  const developer = process.platform === "darwin" ? developerGit() : "";
  const tools = [dirname(b.git), dirname(realpathSync(process.execPath)),
    ...(developer.includes(".app/") ? [developer.slice(0, developer.indexOf(".app/") + 4)] : []),
    ...(b.git.includes(".app/") ? [b.git.slice(0, b.git.indexOf(".app/") + 4)] : [])];
  const read = [...new Set([...system, ...b.read, ...tools].filter(existsSync))];
  const write = existing([...b.write, b.scratch]);
  const env = environment(b.scratch);
  // Explicit auth configuration can be selected by ssh_command (-F/-i); Git credentials can use a declared config file.
  const config = b.read.find(path => path.endsWith("/.gitconfig"));
  if (config) env.GIT_CONFIG_GLOBAL = config;
  if (process.platform === "darwin") {
    const subpath = (path: string) => `(subpath ${JSON.stringify(path)})`;
    const profile = ["(version 1)", "(deny default)", "(allow file-read-metadata)",
      '(allow file-read* (literal "/") (subpath "/dev"))', '(allow file-write* (literal "/dev/null"))',
      ...read.map(path => `(allow file-read* ${subpath(path)})`),
      ...write.map(path => `(allow file-read* file-write* ${subpath(path)})`),
      "(allow process-exec process-fork sysctl-read)", "(deny job-creation)",
      "(allow network-outbound network-inbound (remote ip))",
      ...b.deny.map(path => `(deny file-read* file-write* ${subpath(path)})`)].join("\n");
    return { argv: ["/usr/bin/sandbox-exec", "-p", profile, b.git, ...args], env };
  }
  // An empty filesystem (not a host-root bind) and private PID/IPC namespaces keep undeclared secrets and control sockets out.
  const mounts = new Map<string, string>();
  for (const path of read) mounts.set(path, "--ro-bind");
  for (const path of write) mounts.set(path, "--bind");
  // Hide whole parents for file secrets rather than a replaceable file-entry mask.
  const hidden = existing(b.deny.filter(path => [...mounts.keys()].some(root => within(root, path)))
    .map(path => statSync(path).isDirectory() ? path : dirname(path)));
  return { argv: ["/usr/bin/bwrap", "--unshare-pid", "--unshare-ipc", "--die-with-parent", "--new-session",
    "--tmpfs", "/", ...[...mounts].sort(([a], [z]) => a.length - z.length).flatMap(([path, mode]) => [mode, path, path]),
    ...hidden.filter(path => !hidden.some(parent => parent !== path && within(parent, path))).flatMap(path => ["--tmpfs", path]),
    "--dev", "/dev", "--proc", "/proc", "--chdir", b.scratch, "--", b.git, ...args], env };
}
