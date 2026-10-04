// The namespace and not the name: a runtime without `statfsSync` then reads as unreadable instead of refusing to import.
import * as fs from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { findingId, type Finding } from "./finding.ts";

/**
 * Whether the filesystems this machine writes the household onto are running out of room.
 *
 * A Pi's card fills from chat logs, sessions, backup staging and the store long before anything refuses a write, and the
 * first sign of it would otherwise be a write that failed. So `check` reads the room left under the paths it already knows
 * this machine writes to and says so while there is still time to act.
 *
 * WHAT IS READ. The filesystem's own counters, one `statfs` per filesystem, and one `stat` per path to learn which
 * filesystem it is on. Nothing is listed, walked, measured, deleted or reclaimed: the fix is TEXT, like every other one.
 *
 * WHAT COUNTS AS FREE. The blocks available to an unprivileged account (`bavail`), which is what the hub's own account can
 * still write, and never the blocks free to root (`bfree`): on ext4 the difference is the reserved five percent, and a
 * reading that counted it would report room the hub cannot use. The percentage is `bavail` over the filesystem's total
 * blocks.
 *
 * WHEN IT SPEAKS. When EITHER floor is crossed: fewer than `hub.disk_free_min_mb` mebibytes available, or less than
 * `hub.disk_free_min_percent` of the filesystem. The bytes floor is the one that bites on a small card and the percentage
 * the one that bites on a large disk; setting either to 1 all but silences that half.
 */

/** What one filesystem reports, in its own units. A bigint read keeps a large filesystem's block counts exact. */
export interface DiskStat {
  bsize: bigint | number;
  blocks: bigint | number;
  bavail: bigint | number;
}

/**
 * How the filesystem is read, in the style of `os` and `kernel`: supplied by a check, real by default. Each throws what
 * the system threw, and the caller turns that into a finding.
 */
export interface DiskSeam {
  /** The filesystem counters for the filesystem holding `path`. */
  statfs(path: string): DiskStat;
  /** An identity for the filesystem holding `path`, equal for two paths on the same one. */
  device(path: string): string;
}

/** The real box, read with bigint counters. A runtime without `statfs` throws, and that is reported as unreadable. */
export function realDiskSeam(): DiskSeam {
  return {
    statfs(path) {
      if (typeof fs.statfsSync !== "function") throw Object.assign(new Error("this runtime cannot read filesystem sizes"), { code: "ENOSYS" });
      const read = fs.statfsSync(path, { bigint: true });
      return { bsize: read.bsize, blocks: read.blocks, bavail: read.bavail };
    },
    device(path) {
      return String(fs.statSync(path, { bigint: true }).dev);
    },
  };
}

const MIB = 1024n * 1024n;

/** One whole, non-negative count as a bigint, or null for anything a filesystem should not have said. */
function count(value: unknown): bigint | null {
  if (typeof value === "bigint") return value >= 0n ? value : null;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  return null;
}

export type DiskVerdict =
  | { valid: false; reason: string }
  | { valid: true; low: boolean; availableBytes: bigint; totalBytes: bigint; byBytes: boolean; byPercent: boolean };

/**
 * The calculation alone, with no filesystem. Exact integer arithmetic throughout, so a filesystem of many terabytes is
 * compared to the byte: `bavail * 100 < blocks * percent` rather than a division in floating point.
 *
 * A reading with no blocks, no block size, or more available than there is in total is NOT a full disk and NOT an empty
 * one. It is a reading that cannot be judged, and it says so.
 */
export function diskVerdict(stat: DiskStat, minMb: number, minPercent: number): DiskVerdict {
  const bsize = count(stat?.bsize);
  const blocks = count(stat?.blocks);
  const bavail = count(stat?.bavail);
  if (bsize === null || blocks === null || bavail === null) return { valid: false, reason: "the filesystem reported counts that are not whole numbers" };
  if (bsize === 0n || blocks === 0n) return { valid: false, reason: "the filesystem reported no size at all" };
  if (bavail > blocks) return { valid: false, reason: "the filesystem reported more space available than it holds" };
  const availableBytes = bavail * bsize;
  const totalBytes = blocks * bsize;
  const byBytes = availableBytes < BigInt(Math.max(0, Math.floor(minMb))) * MIB;
  const byPercent = bavail * 100n < blocks * BigInt(Math.min(100, Math.max(0, Math.floor(minPercent))));
  return { valid: true, low: byBytes || byPercent, availableBytes, totalBytes, byBytes, byPercent };
}

/** Bytes as GiB with one decimal, for a sentence. Precision past that is not what a person reads. */
function gib(bytes: bigint): string {
  return `${(Number((bytes * 10n) / (1024n * MIB)) / 10).toFixed(1)} GiB`;
}

/** A percentage with one decimal, rounded down, so a reading just under the floor never prints as the floor. */
function percent(part: bigint, whole: bigint): string {
  return `${(Number((part * 1000n) / whole) / 10).toFixed(1)}%`;
}

/** What the system said, bounded: its code when it has one, or the first line of its message. */
function cause(error: unknown): string {
  const code = (error as { code?: unknown })?.code;
  if (typeof code === "string" && code !== "") return code;
  return String((error as Error)?.message ?? error).split("\n")[0].slice(0, 160) || "an unknown error";
}

const MISSING = new Set(["ENOENT", "ENOTDIR"]);

export function diskFindings(options: {
  /** The paths this machine writes the household onto, in the order they are reported by; empty strings are skipped. */
  paths: string[];
  seam: DiskSeam;
  minMb: number;
  minPercent: number;
  machine: string;
  registryFile: string;
}): Finding[] {
  const { machine } = options;
  const out: Finding[] = [];
  const unreadable = (path: string, why: string) => out.push({
    id: findingId(machine, "disk-unreadable", path),
    kind: "disk-unreadable",
    subject: path,
    machine,
    says: `the room left on the filesystem holding ${path} cannot be read (${why}), so nothing here can say whether it is filling up`,
    // Single-quoted, because a person pastes it: a path carrying `$(...)` or a backtick must arrive as a path.
    fix: `run df -h '${path.replace(/'/g, `'\\''`)}' on ${machine} to see the room left there by hand`,
  });

  /** One group per filesystem: the paths on it in order, and the existing directory it is read at. */
  const groups = new Map<string, { paths: string[]; at: string }>();
  for (const path of [...new Set(options.paths)]) {
    // The loader refuses a relative state directory, tree or vault, so one here would be a path nobody asked for.
    if (path === "" || !isAbsolute(path)) continue;
    // A directory not made yet is written onto the filesystem of its nearest existing parent, so that is what is read.
    // Bounded by the path's own depth: `dirname` reaches the root and stops.
    let at = path;
    let device: string | null = null;
    let failed: string | null = null;
    for (;;) {
      try {
        device = options.seam.device(at);
        break;
      } catch (error) {
        const why = cause(error);
        const parent = dirname(at);
        if (!MISSING.has(why) || parent === at) { failed = why; break; }
        at = parent;
      }
    }
    if (device === null) { unreadable(path, failed ?? "no part of the path exists"); continue; }
    const group = groups.get(device);
    if (group) group.paths.push(path);
    else groups.set(device, { paths: [path], at });
  }

  for (const { paths, at } of groups.values()) {
    const [first, ...others] = paths;
    let stat: DiskStat;
    try {
      stat = options.seam.statfs(at);
    } catch (error) {
      unreadable(first, cause(error));
      continue;
    }
    const verdict = diskVerdict(stat, options.minMb, options.minPercent);
    if (!verdict.valid) { unreadable(first, verdict.reason); continue; }
    if (!verdict.low) continue;
    const floors = [
      verdict.byBytes ? `${options.minMb} MiB` : "",
      verdict.byPercent ? `${options.minPercent}%` : "",
    ].filter(Boolean).join(" and ");
    const also = others.length === 0 ? "" : ` (the same filesystem as ${others.join(", ")})`;
    out.push({
      id: findingId(machine, "disk-low", first),
      kind: "disk-low",
      subject: first,
      machine,
      says:
        `the filesystem holding ${first}${also} has ${gib(verdict.availableBytes)} available to the hub's account, ` +
        `${percent(verdict.availableBytes, verdict.totalBytes)} of ${gib(verdict.totalBytes)}, below the ${floors} floor, ` +
        `so chat logs, sessions and backups written there will start failing as it fills`,
      fix:
        `free space on the filesystem holding ${first} on ${machine} (nothing here deletes anything), ` +
        `or change hub.disk_free_min_mb and hub.disk_free_min_percent in ${options.registryFile}`,
    });
  }
  return out;
}
