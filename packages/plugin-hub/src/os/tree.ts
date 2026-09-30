import { readdirSync, readFileSync } from "node:fs";

/**
 * Every process under this one, on linux, host pids.
 *
 * THE BOX TOOL IS NOT THE LOOP. `bwrap` spawns the command inside a new pid
 * namespace and stays
 * outside it, so the pid the adapter hands up is the wrapper's, its resident
 * size is a megabyte or two, and a `child_memory_limit_mb` read off it can
 * never trip. The tree is not one level deep either: without `--as-pid-1` the
 * namespace's pid 1 is bwrap's own reaper and the loop is the reaper's child,
 * so a watch that took "the child" literally would read the reaper and be just
 * as blind. This walks the whole tree.
 *
 * `/proc/<pid>/task/<pid>/children` is the kernel's own list and is one read.
 * A kernel built without it answers nothing, so the fallback is the walk every
 * process table tool does: every numeric entry under `/proc` whose `stat` names
 * this pid as its parent. The `comm` field is parenthesised and may hold spaces
 * and parentheses of its own, so the fields are taken from after the LAST close
 * parenthesis, which is the only parse of that file that is not a guess.
 *
 * It lives here and not in the runner because two things read the same tree:
 * the memory watch, which kills what is over its limit, and the adapter, which
 * has to say whether a process it was asked to stop has really left nothing
 * behind.
 */
export function childrenOf(pid: number): number[] {
  return listChildren(pid) ?? [];
}

/**
 * The same list, except that a table that could not be READ answers null and not
 * an empty list: "nothing is under this process" and "the table would not say" are
 * different facts, and only the first one is ever evidence of anything.
 */
export function listChildren(pid: number): number[] | null {
  if (process.platform === "darwin") {
    const result = Bun.spawnSync(["ps", "-axo", "pid=,ppid="], { stdout: "pipe", stderr: "ignore" });
    // A table that did not answer, or answered nothing at all (a live system always has
    // at least this process in it), was not read.
    const text = result.exitCode === 0 ? result.stdout.toString().trim() : "";
    if (text === "") return null;
    return text.split("\n").map(line => line.trim().split(/\s+/).map(Number))
      .filter(row => row.length === 2 && row.every(Number.isFinite))
      .filter(row => row[1] === pid).map(row => row[0]);
  }
  try {
    const listed = readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8").trim();
    if (listed !== "") {
      return listed
        .split(/\s+/)
        .map((one) => Number(one))
        .filter((one) => Number.isFinite(one) && one > 0);
    }
    return [];
  } catch {
    // This kernel does not publish the list, so it is read off the table below.
  }
  const out: number[] = [];
  let entries: string[];
  try {
    entries = readdirSync("/proc");
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = readFileSync(`/proc/${entry}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/);
      // After the comm field come state and then ppid.
      if (Number(fields[1]) === pid) out.push(Number(entry));
    } catch {
      // A process that left between the listing and the read, which is a
      // process that is not under anything any more.
    }
  }
  return out;
}

/**
 * The same tree, flattened, with a depth bound so a cycle cannot spin it, and with
 * what it could not see said: `complete` is false when any level of it could not be
 * read or the bound cut it off, and the processes listed are then only those that
 * were seen.
 */
export function observeTree(pid: number): { pids: number[]; complete: boolean } {
  const seen = new Set<number>();
  let complete = true;
  const read = (one: number): number[] => {
    const listed = listChildren(one);
    if (listed === null) complete = false;
    return listed ?? [];
  };
  let frontier = read(pid);
  for (let depth = 0; depth < 8 && frontier.length > 0; depth++) {
    const next: number[] = [];
    for (const one of frontier) {
      if (seen.has(one) || one === pid) continue;
      seen.add(one);
      next.push(...read(one));
    }
    frontier = next;
  }
  if (frontier.some(one => !seen.has(one) && one !== pid)) complete = false;
  return { pids: [...seen], complete };
}

/** The same tree, flattened. What it could not see is not in it: `observeTree` says so. */
export function descendantsOf(pid: number): number[] {
  return observeTree(pid).pids;
}

/**
 * What a lookup of a process or a group found. ONLY "the system says no such
 * process" is `absent`: a lookup that failed any other way (a bad number, an error
 * that is not ESRCH) is `unknown`, and unknown is never gone.
 */
export type Presence = "present" | "absent" | "unknown";

function signalled(target: number): Presence {
  try {
    process.kill(target, 0);
    return "present";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // A process we may not signal still exists.
    if (code === "EPERM") return "present";
    return code === "ESRCH" ? "absent" : "unknown";
  }
}

/** Whether a process exists, with a failed lookup kept apart from an absent one. */
export function presence(pid: number): Presence {
  return Number.isInteger(pid) && pid > 1 ? signalled(pid) : "unknown";
}

/**
 * Whether ANY process is left in a process group. A signal of 0 to `-pgid` names
 * the group and reaches every member without disturbing one. Only a group this
 * hub started as the leader of (`groupOf` said so) is ever asked about: an
 * unrelated group that happens to have the number says nothing.
 */
export function groupPresence(pgid: number): Presence {
  return Number.isInteger(pgid) && pgid > 1 ? signalled(-pgid) : "unknown";
}

/** Whether a process may still exist: everything but a lookup that said it is not there. */
export function alive(pid: number): boolean {
  return presence(pid) !== "absent";
}

/** Whether a group may still have a member: everything but a lookup that said it is empty. */
export function groupAlive(pgid: number): boolean {
  return groupPresence(pgid) !== "absent";
}

/** The process group a live process is in, from the process table, or null when it cannot be read. */
export function groupOf(pid: number): number | null {
  const result = Bun.spawnSync(["ps", "-o", "pgid=", "-p", String(pid)], { stdout: "pipe", stderr: "ignore" });
  const said = Number(result.stdout.toString().trim());
  return result.exitCode === 0 && Number.isInteger(said) && said > 0 ? said : null;
}

let boot: string | null | undefined;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A boot identity is `<scheme>:<uuid>`, and the scheme says which kernel counter it was read from. */
const BOOT_IDENTITY = /^(linux|darwin):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Whether a stored or read value is a boot identity of a scheme this build reads. Anything else is no identity. */
export function isBootIdentity(value: unknown): value is string {
  return typeof value === "string" && BOOT_IDENTITY.test(value);
}

/**
 * The identity a platform's own boot counter answers with, tagged by scheme, or
 * null when the answer is not a UUID. Pure: the read is `readBootIdentity`'s.
 */
export function bootIdentityFrom(scheme: "linux" | "darwin", said: string): string | null {
  const uuid = said.trim().toLowerCase();
  return UUID.test(uuid) ? `${scheme}:${uuid}` : null;
}

/**
 * Whether the machine PROVABLY booted again between two identities, and nothing
 * else. Only two valid identities of the SAME scheme that differ say so. An
 * identity that is missing, malformed, from before identities were tagged (a
 * `kern.boottime` number, which moves whenever the clock is stepped) or of another
 * scheme is no evidence either way, and is never read as a different boot.
 */
export function bootMoved(recorded: unknown, current: string | null): boolean {
  if (!isBootIdentity(recorded) || !isBootIdentity(current)) return false;
  return recorded.slice(0, recorded.indexOf(":")) === current.slice(0, current.indexOf(":")) && recorded !== current;
}

/** What a platform can be asked, so the read is a function of it and a test needs no machine. */
export interface BootSources {
  platform: NodeJS.Platform;
  /** The text of a file, or null when it cannot be read. */
  file(path: string): string | null;
  /** The output of `sysctl -n <name>` when it exited 0, or null. */
  sysctl(name: string): string | null;
}

/**
 * Which boot of this machine this is, from the kernel's per-boot session id, or
 * null when the platform will not say. Linux: `boot_id`. macOS: `kern.bootsessionuuid`.
 * NEVER a boot TIME: the kernel moves `kern.boottime` whenever the calendar is set
 * (a manual change, a time daemon stepping the clock), so it is not a stable
 * per-boot identity and a difference in it proves nothing. There is no fallback to
 * it; a platform or a sandbox that will not answer has no identity.
 */
export function readBootIdentity(from: BootSources): string | null {
  if (from.platform === "linux") {
    const said = from.file("/proc/sys/kernel/random/boot_id");
    return said === null ? null : bootIdentityFrom("linux", said);
  }
  if (from.platform === "darwin") {
    const said = from.sysctl("kern.bootsessionuuid");
    return said === null ? null : bootIdentityFrom("darwin", said);
  }
  return null;
}

const HERE: BootSources = {
  platform: process.platform,
  file(path) {
    try { return readFileSync(path, "utf8"); } catch { return null; }
  },
  sysctl(name) {
    try {
      const result = Bun.spawnSync(["/usr/sbin/sysctl", "-n", name], { stdout: "pipe", stderr: "ignore" });
      return result.exitCode === 0 ? result.stdout.toString() : null;
    } catch {
      return null;
    }
  },
};

/** This machine's boot identity, read once. See `readBootIdentity`. */
export function bootId(): string | null {
  if (boot === undefined) boot = readBootIdentity(HERE);
  return boot;
}
