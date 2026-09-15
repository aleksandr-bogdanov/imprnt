import { putRow, readSheet } from "../records/statesheet.ts";
import { runEntriesFor } from "../registry/entries.ts";
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
