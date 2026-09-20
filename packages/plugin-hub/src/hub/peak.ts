import { readFileSync } from "node:fs";
import { putRow, readSheet } from "../records/statesheet.ts";
import { runEntriesFor } from "../registry/entries.ts";
import { readSetting } from "../registry/load.ts";
import type { StoreLike } from "../store/connect.ts";

/**
 * Every long-running program the household ships has a known memory peak,
 * measured once and written down (L4), and that record is a state sheet: one
 * row per id, edited in place, with Postgres under a fixed id because the household
 * installs it from its own package manager and it is not a registry entry.
 *
 * THE PEAK NEVER FALLS, and it is accumulated HERE rather than inside the
 * reader. `OsSeam.memory` is a stateless probe on both platforms and returns no
 * peak at all on macOS, where the kernel keeps none for a running process, so a
 * running maximum inside it would be hidden state in a function every caller
 * reads as a probe, and "the peak never falls" would be unassertable on a Mac.
 */
export const MEMORY_PEAK_SHEET = "memory_peak";
export const POSTGRES_PEAK_ID = "postgres";

/** How the number was arrived at. A closed set: a peak with no method is a guess. */
export type PeakMethod = "vmhwm" | "sampled" | "time-l";

export interface PeakRow {
  id: string;
  bytes: number;
  at: string;
  how: PeakMethod;
  machine: string;
  pid: number | null;
  /**
   * What the process was holding at the LAST sample, and when.
   *
   * The peak answers "how large can this get" and the reading answers "how
   * large is it now", and a household comparing what it asked for against what
   * it got needs the second. Null on a row written before anything measured a
   * current size.
   */
  reading_bytes: number | null;
  reading_at: string | null;
}

/**
 * The row after this sample: the reading always, the peak only when it grew.
 *
 * A LOW READING STILL WRITES A ROW, and that is the non-obvious half: a sample
 * below the peak is exactly the case where a household needs to know what the
 * process is holding right now, so what is skipped on such a sample is RAISING
 * the peak and never the write itself. `bytes` is monotonic, which is what the
 * peak means, and `reading_bytes` moves in both directions.
 */
export async function recordPeak(
  store: StoreLike,
  row: {
    id: string;
    bytes: number;
    at?: string;
    how: PeakMethod;
    machine: string;
    pid?: number | null;
    /** What it is holding now. Absent leaves whatever the row already says. */
    reading_bytes?: number | null;
    reading_at?: string | null;
  },
): Promise<void> {
  const already = (await readPeaks(store)).find((one) => one.id === row.id);
  const now = row.at ?? new Date().toISOString();
  const grew = !already || Number(already.bytes) < Number(row.bytes);
  const reading =
    row.reading_bytes === undefined || row.reading_bytes === null
      ? (already?.reading_bytes ?? null)
      : Number(row.reading_bytes);
  const readingAt =
    row.reading_bytes === undefined || row.reading_bytes === null
      ? (already?.reading_at ?? null)
      : (row.reading_at ?? now);
  // The whole blob is replaced on every write, so the held peak is carried
  // forward by name rather than left to survive a partial update.
  await putRow(store, MEMORY_PEAK_SHEET, row.id, {
    bytes: grew ? Number(row.bytes) : Number(already!.bytes),
    at: grew ? now : already!.at,
    how: grew ? row.how : already!.how,
    machine: grew ? row.machine : already!.machine,
    pid: grew ? (row.pid ?? null) : already!.pid,
    reading_bytes: reading,
    reading_at: readingAt,
  });
}

export async function readPeaks(store: StoreLike): Promise<PeakRow[]> {
  return (await readSheet(store, MEMORY_PEAK_SHEET)).map((row) => ({
    id: row.id,
    bytes: Number((row.data as Record<string, unknown>).bytes ?? 0),
    at: String((row.data as Record<string, unknown>).at ?? ""),
    how: String((row.data as Record<string, unknown>).how ?? "sampled") as PeakMethod,
    machine: String((row.data as Record<string, unknown>).machine ?? ""),
    pid: ((row.data as Record<string, unknown>).pid ?? null) as number | null,
    reading_bytes:
      (row.data as Record<string, unknown>).reading_bytes === undefined ||
      (row.data as Record<string, unknown>).reading_bytes === null
        ? null
        : Number((row.data as Record<string, unknown>).reading_bytes),
    reading_at:
      (row.data as Record<string, unknown>).reading_at === undefined ||
      (row.data as Record<string, unknown>).reading_at === null
        ? null
        : String((row.data as Record<string, unknown>).reading_at),
  }));
}

/** One resident holding more than its entry asked for. */
export interface OverLimit {
  id: string;
  /** What the last sample read, bytes. */
  reading_bytes: number;
  /** What the registry asked for, megabytes. */
  limit_mb: number;
}

/**
 * Which resident's latest reading is past its own `memory_limit_mb`.
 *
 * Pure, so the arithmetic is readable without a store. Three things keep it
 * quiet where it should be quiet. A piece that is not resident is skipped
 * whatever it holds, because a scheduled or on-demand piece has no reading to
 * keep and a permanent finding is noise. A resident nothing has measured is
 * skipped, because "nothing has measured it" is the missing-peak finding and
 * two findings saying one thing is noise. And the store is skipped for the same
 * reason it is in the resident set under a fixed id: it is not a registry entry
 * and declares no limit for anything to compare against.
 */
export function overLimit(args: {
  rows: PeakRow[];
  entries: { id: string; memory_limit_mb: number }[];
  resident: string[];
}): OverLimit[] {
  const out: OverLimit[] = [];
  const resident = new Set(args.resident);
  for (const entry of args.entries) {
    if (!resident.has(entry.id)) continue;
    const row = args.rows.find((one) => one.id === entry.id);
    if (!row || row.reading_bytes === null) continue;
    const limit = Number(entry.memory_limit_mb);
    if (!(limit > 0)) continue;
    if (row.reading_bytes <= limit * 1024 * 1024) continue;
    out.push({ id: entry.id, reading_bytes: row.reading_bytes, limit_mb: limit });
  }
  return out;
}

/**
 * Every resident piece on this machine, derived and never a list: the `always`
 * entries this machine runs, plus the store. A scheduled or on-demand piece is
 * not resident and is never asked for a peak, or the finding is permanent, and
 * a permanent finding is noise.
 */
export function residentIds(registry: unknown, machine: string): string[] {
  const own = runEntriesFor(registry, machine)
    .filter((entry) => String(entry.schedule).trim().toLowerCase() === "always")
    .map((entry) => entry.id);
  return [...own, POSTGRES_PEAK_ID];
}

/**
 * The store's own pid, read from the file the standard install writes.
 *
 * NEVER DERIVED FROM A BACKEND. Asking the store for `pg_backend_pid()`,
 * reading that backend's parent and believing it when the parent's command name
 * holds `postgres` works, and it is a guess about process trees that is only
 * true when the store happens to sit on this machine. MEASURED on both boxes: every
 * standard install writes a pid file whose FIRST LINE is the postmaster's pid
 * (`/var/run/postgresql/<n>-main.pid` on Debian, `postmaster.pid` inside the
 * data directory under Homebrew), so the household declares that file in
 * `[store]` and the hub reads one line. No `sudo`, no `pgrep`.
 *
 * Null with a REASON, never a thrown error and never a NaN passed on as a pid:
 * a household that moved its cluster has to be told which path was tried.
 */
export function readStorePid(registry: unknown): { pid: number | null; reason: string | null } {
  const declared = readSetting(registry, "store.pid_file");
  const file = declared === undefined || declared === null ? "" : String(declared);
  if (file === "") {
    return {
      pid: null,
      reason:
        "this registry declares no [store] pid_file, so nothing here knows where the store writes its pid",
    };
  }
  let first: string;
  try {
    first = readFileSync(file, "utf8").split("\n")[0].trim();
  } catch (error) {
    return { pid: null, reason: `${file} cannot be read: ${(error as Error).message}` };
  }
  if (!/^\d+$/.test(first)) {
    return {
      pid: null,
      reason: `${file} does not begin with a pid: its first line is ${JSON.stringify(first)}`,
    };
  }
  const pid = Number(first);
  if (!(pid > 0)) return { pid: null, reason: `${file} names ${first}, which is not a pid` };
  if (!alive(pid)) {
    return { pid: null, reason: `${file} names pid ${pid}, and no process by that id is running` };
  }
  return { pid, reason: null };
}

/**
 * Whether a pid names a live process.
 *
 * `EPERM` means it is alive and belongs to somebody else, which is the normal
 * case for a postmaster: the store runs as the `postgres` account and the hub
 * does not. Reading that as "gone" would make the pid file useless on every box
 * where the install is the standard one.
 */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: string }).code === "EPERM";
  }
}
