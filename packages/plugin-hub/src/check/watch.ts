import { intervalOf } from "./schedule.ts";
import { findingId, type Finding } from "./finding.ts";
import { HUNT_SOURCES, type Registry, type RunEntry } from "../registry/load.ts";
import { readSheet } from "../records/statesheet.ts";
import type { StoreLike } from "../store/connect.ts";
import { jobsSheetOf, ownerRuleOf, specsDirOf } from "../watch/hunt.ts";
import { loadSpecs, type RefusedSpec } from "../watch/spec.ts";

/**
 * What `check` says about a hunt: a spec file that will never run, and a
 * triage job the master has not answered.
 *
 * A refused spec is a file a person can fix, and the tick already says so in
 * the audit chat every half hour; this is the same fact on the findings page,
 * with the problems as the fix text, so a household that reads `check` and
 * not the chat still sees it. An overdue triage job is a master that stopped
 * answering: the job row is on the queue and `job-stale` would report it
 * against the person's own answered threshold, but a hunt has a clock of its
 * own, its interval plus the grace, and the fix names the master's runner.
 */

export interface PendingTriage {
  entry: string;
  jobId: string;
  at: Date;
  triage: string;
}

export interface WatchState {
  refused: { entry: string; specs: RefusedSpec[] }[];
  pending: PendingTriage[];
}

/** Every hunt entry of this machine read: its refused spec files, and its pending jobs from the sheet. */
export async function readWatchState(store: StoreLike, args: { registry: Registry; entries: RunEntry[] }): Promise<WatchState> {
  const state: WatchState = { refused: [], pending: [] };
  for (const entry of args.entries) {
    if (entry.kind !== "watch" || !(HUNT_SOURCES as readonly string[]).includes(String(entry.source))) continue;
    const loaded = loadSpecs(specsDirOf(args.registry, entry), String(entry.source), { owner: ownerRuleOf(args.registry, String(entry.person)) });
    if (loaded.refused.length > 0) state.refused.push({ entry: entry.id, specs: loaded.refused });
    if (entry.triage === undefined) continue;
    for (const row of await readSheet(store, jobsSheetOf(entry.id))) {
      const at = Date.parse(String((row.data as { at?: string }).at ?? ""));
      if (!Number.isFinite(at)) continue;
      state.pending.push({ entry: entry.id, jobId: row.id, at: new Date(at), triage: String(entry.triage) });
    }
  }
  return state;
}

export function watchFindings(args: {
  entries: RunEntry[];
  state: WatchState;
  graceSeconds: number;
  machine: string;
  now: Date;
}): Finding[] {
  const out: Finding[] = [];
  for (const { entry, specs } of args.state.refused) {
    for (const spec of specs) {
      out.push({
        id: findingId(args.machine, "watch-spec-refused", `${entry}/${spec.file}`),
        kind: "watch-spec-refused",
        subject: `${entry}/${spec.file}`,
        machine: args.machine,
        says: `${entry} refuses the spec file ${spec.file}, so that hunt never runs: ${spec.problems[0]}${spec.problems.length > 1 ? ` (and ${spec.problems.length - 1} more)` : ""}`,
        fix: spec.problems.join("; "),
      });
    }
  }
  for (const job of args.state.pending) {
    const entry = args.entries.find((one) => one.id === job.entry);
    const interval = entry === undefined ? null : intervalOf(entry.schedule);
    if (interval === null) continue;
    const age = Math.floor((args.now.getTime() - job.at.getTime()) / 1000);
    const lateBy = age - (interval + args.graceSeconds);
    if (lateBy <= 0) continue;
    out.push({
      id: findingId(args.machine, "watch-triage-overdue", job.jobId),
      kind: "watch-triage-overdue",
      subject: job.jobId,
      machine: args.machine,
      says: `${job.entry} handed ${job.jobId} to ${job.triage} ${age} seconds ago and no verdict has come back, which is ${lateBy} seconds past its ${interval} second interval plus the ${args.graceSeconds} second grace`,
      fix: `read the runner log for ${job.triage}`,
    });
  }
  return out;
}
