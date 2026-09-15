import { scheduleSeconds } from "../os/diff.ts";
import { putRow, readSheet } from "../records/statesheet.ts";
import type { RunEntry } from "../registry/load.ts";
import type { StoreLike } from "../store/connect.ts";
import { findingId, type Finding } from "./finding.ts";

/**
 * A scheduled job's staleness comes from the job's OWN success stamp.
 *
 * L13: "a scheduled job whose last success is older than its interval plus a
 * grace is reported, read from the job's own 'I ran and it landed' stamp,
 * because systemd knows a job ran, not whether it worked", and its Forbidden
 * line: "reading 'timer enabled' as 'job ran'". D-89 makes the stamp a state
 * sheet, one row per entry id, written by the job when it ran AND landed, and
 * makes a scheduled entry with NO row its own finding: a job nobody ever
 * stamped would otherwise look like a job that has not run yet, forever.
 */
export const JOB_SUCCESS_SHEET = "job_success";

/** Seconds, or null for the two schedules that are not scheduled jobs. */
export function intervalOf(schedule: string): number | null {
  return scheduleSeconds(schedule);
}

/** The stamp the job writes itself, when it ran and it landed. */
export async function recordJobSuccess(
  store: StoreLike,
  args: { entry: string; machine: string; at?: string },
): Promise<void> {
  await putRow(store, JOB_SUCCESS_SHEET, args.entry, {
    at: args.at ?? new Date().toISOString(),
    machine: args.machine,
  });
}

export async function readJobStamps(store: StoreLike): Promise<
  { id: string; data: Record<string, unknown> }[]
> {
  return (await readSheet(store, JOB_SUCCESS_SHEET)).map((row) => ({ id: row.id, data: row.data }));
}

export function staleJobs(args: {
  entries: RunEntry[];
  stamps: { id: string; data: Record<string, unknown> }[];
  graceSeconds: number;
  now: Date;
}): Finding[] {
  const out: Finding[] = [];
  for (const entry of args.entries ?? []) {
    const interval = intervalOf(entry.schedule);
    // `always` and `on demand` are not scheduled jobs, so they are never asked
    // for a stamp. Without that the transcriber is reported forever, and a
    // permanent finding is worse than no check at all.
    if (interval === null) continue;
    const stamp = (args.stamps ?? []).find((row) => row.id === entry.id);
    const machine = String(stamp?.data?.machine ?? entry.machine ?? "");
    if (!stamp) {
      out.push({
        id: findingId(machine, "job-no-stamp", entry.id),
        kind: "job-no-stamp",
        subject: entry.id,
        machine,
        says: `${entry.id} runs ${entry.schedule} and has never written a success stamp, so nothing knows whether it has ever landed`,
        fix: `run ${entry.id} and let it record its own success, or remove the entry from the registry`,
      });
      continue;
    }
    const at = Date.parse(String(stamp.data?.at ?? ""));
    if (!Number.isFinite(at)) continue;
    const lateBy = Math.floor((args.now.getTime() - at) / 1000) - (interval + args.graceSeconds);
    if (lateBy <= 0) continue;
    out.push({
      id: findingId(machine, "job-stale", entry.id),
      kind: "job-stale",
      subject: entry.id,
      machine,
      says: `${entry.id} last landed ${Math.floor((args.now.getTime() - at) / 1000)} seconds ago, which is ${lateBy} seconds past its ${interval} second interval plus the ${args.graceSeconds} second grace`,
      fix: `run ${entry.id} by hand and read why it stopped landing`,
    });
  }
  return out;
}
