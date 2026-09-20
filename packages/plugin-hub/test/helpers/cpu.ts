// Test infrastructure: how much processor time a process has actually burned.
//
// THE RESIDUE a statement count cannot see: a waiter that
// keeps a flag in memory and re-checks it on a 100 ms timer issues no SQL at
// all, so it is invisible to a statement count and to any other black-box
// probe. This is the
// other thing a black box can see: a poll that does any work at all costs
// processor time, and a process genuinely asleep on a notification costs almost
// none.
//
// WHAT IT CANNOT CATCH, stated here rather than discovered later: a timer that
// wakes, reads one boolean and goes back to sleep is a few microseconds per
// wake, so at 100 ms it can still finish a three second window under any bound
// loose enough not to be flaky. So this is the GUARD and the written review of
// the waits is the CLOSURE.
//
// Both readers convert at their own edge, the way the memory seam does, and the
// unit here is SECONDS of processor time (user + system).
//
//   darwin: `ps -o cputime= -p <pid>` prints `[[dd-]hh:]mm:ss.ss`. Measured on
//           this Mac: a fresh shell reads `0:00.01` and launchd reads
//           `227:22.78`, so the minutes field is not capped at 60 and the
//           parser folds from the right.
//   linux:  `/proc/<pid>/stat` fields 14 and 15 (utime, stime) in clock ticks,
//           at the usual 100 ticks a second. The comm field can hold spaces and
//           parentheses, so the scan starts after the LAST `)`.

import { readFileSync } from "node:fs";

/** Clock ticks a second on every Linux this hub runs on. */
const USER_HZ = 100;

/** `[[dd-]hh:]mm:ss.ss` as seconds, folded from the right. */
export function parseCpuTime(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  const dash = trimmed.indexOf("-");
  const days = dash > 0 ? Number(trimmed.slice(0, dash)) : 0;
  const rest = dash > 0 ? trimmed.slice(dash + 1) : trimmed;
  const parts = rest.split(":");
  if (parts.some((part) => part.trim() === "" || !/^\d+(\.\d+)?$/.test(part.trim()))) {
    return null;
  }
  if (!Number.isFinite(days)) return null;
  let seconds = 0;
  for (const part of parts) seconds = seconds * 60 + Number(part);
  return seconds + days * 86_400;
}

/**
 * Processor time this process has used, in seconds, or null when the process is
 * gone or the platform would not say.
 *
 * Null rather than zero, deliberately: a dead process and an idle one are
 * different answers, and a check that read one as the other would score a
 * crashed door as a perfectly quiet one.
 */
export function cpuSeconds(pid: number): number | null {
  if (!pid || pid <= 0) return null;
  if (process.platform === "linux") {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const after = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/);
      // After the comm field, `state` is index 0, so utime is field 14 of the
      // whole line at index 11 and stime at index 12.
      const utime = Number(after[11]);
      const stime = Number(after[12]);
      if (!Number.isFinite(utime) || !Number.isFinite(stime)) return null;
      return (utime + stime) / USER_HZ;
    } catch {
      return null;
    }
  }
  const out = Bun.spawnSync(["ps", "-o", "cputime=", "-p", String(pid)], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if ((out.exitCode ?? 1) !== 0) return null;
  return parseCpuTime(out.stdout?.toString() ?? "");
}
