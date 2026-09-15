import { readFileSync } from "node:fs";
import { putRow, readSheet } from "../records/statesheet.ts";
import { runEntriesFor } from "../registry/entries.ts";
import { readSetting } from "../registry/load.ts";
import type { StoreLike } from "../store/connect.ts";

/**
 * Every long-running program the household ships has a known memory peak,
 * measured once and written down (L4). D-84 makes that a state sheet: one row
 * per id, edited in place, with Postgres under a fixed id because the household
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
}

/** The larger of the reading and the row already there. Never the smaller. */
export async function recordPeak(
  store: StoreLike,
  row: { id: string; bytes: number; at?: string; how: PeakMethod; machine: string; pid?: number | null },
): Promise<void> {
  const already = (await readPeaks(store)).find((one) => one.id === row.id);
  if (already && Number(already.bytes) >= Number(row.bytes)) return;
  await putRow(store, MEMORY_PEAK_SHEET, row.id, {
    bytes: Number(row.bytes),
    at: row.at ?? new Date().toISOString(),
    how: row.how,
    machine: row.machine,
    pid: row.pid ?? null,
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
  }));
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
 * BUILD-NOTES 9's residue. Phase 3 asked the store for `pg_backend_pid()`, read
 * that backend's parent and believed it when the parent's command name held
 * `postgres`. It works, and it is a guess about process trees that is only true
 * when the store happens to sit on this machine. MEASURED on both boxes: every
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
