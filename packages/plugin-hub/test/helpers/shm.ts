// Test infrastructure: the box's System V shared memory segments, read from
// `ipcs` and never from the code under test.
//
// BUILD-NOTES B.3 and RED-RUN-2's environment note: `kern.sysv.shmmni` is 32 on
// this Mac, each throwaway Postgres cluster holds one segment, and a cluster
// that is KILLED rather than stopped leaks it. About thirty interrupted runs
// later every `initdb` in the suite fails with "could not create shared memory
// segment: No space left on device", and the suite reports a setup error that
// says nothing about the real cause.
//
// THE ORACLE IS AN ID DIFF, NOT THE RULE UNDER TEST. `test/helpers/cluster.ts`
// is to sweep segments owned by this user with zero attaches whose creator pid
// is dead. A check that identified the leaked segment the same way would agree
// with an implementation that had the same bug in it, so this helper only lists
// what is there and the check names its own segment by diffing the list either
// side of the cluster it started. The same discipline `test/helpers/units.ts`
// applies to the two prefixes.

export interface ShmSegment {
  /** The segment id, which is what `ipcrm -m` takes. */
  id: number;
  key: string;
  owner: string;
  /** How many processes have it attached. A leaked one reads 0. */
  attached: number;
}

function ipcs(args: string[]): string {
  try {
    const out = Bun.spawnSync(["ipcs", ...args], { stdout: "pipe", stderr: "pipe" });
    return (out.stdout?.toString() ?? "") + (out.stderr?.toString() ?? "");
  } catch {
    return "";
  }
}

/**
 * Every shared memory segment the box currently has, with its attach count.
 *
 * `ipcs -mo` prints a header, a `Shared Memory:` line and then one row per
 * segment: `T ID KEY MODE OWNER GROUP NATTCH`. A row whose second column is not
 * a number is a header and is skipped, so the parser never invents a segment
 * from a caption.
 */
export function sharedSegments(): ShmSegment[] {
  const out: ShmSegment[] = [];
  for (const line of ipcs(["-mo"]).split("\n")) {
    const columns = line.trim().split(/\s+/);
    if (columns.length < 7) continue;
    if (columns[0] !== "m") continue;
    const id = Number(columns[1]);
    const attached = Number(columns[columns.length - 1]);
    if (!Number.isFinite(id) || !Number.isFinite(attached)) continue;
    out.push({ id, key: columns[2], owner: columns[4], attached });
  }
  return out;
}

export function segmentIds(): number[] {
  return sharedSegments().map((one) => one.id);
}

export function segmentById(id: number): ShmSegment | null {
  return sharedSegments().find((one) => one.id === id) ?? null;
}

/**
 * Remove ONE segment this check watched appear. Never a sweep, and never a
 * segment whose id was already there when the check started: on a shared box
 * the others are somebody else's.
 */
export function removeSegment(id: number): boolean {
  try {
    const out = Bun.spawnSync(["ipcrm", "-m", String(id)], { stdout: "pipe", stderr: "pipe" });
    return (out.exitCode ?? 1) === 0;
  } catch {
    return false;
  }
}
