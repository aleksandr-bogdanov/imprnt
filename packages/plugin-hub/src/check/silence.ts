import { findingId, type Finding } from "./finding.ts";

/**
 * A runner silent for N hours is a finding (STORE-01, D5).
 *
 * It is DERIVED with no heartbeat write, because the runner's wait issues no
 * statement at all and a per-tick heartbeat would turn that wait into a timer.
 * So silence is BOTH halves at once: no live backend for that runner in the
 * server's own view of its clients, AND the newest work event for any of its
 * agents older than the threshold.
 *
 * Both are required, and the two cases that are NOT findings say why. A
 * connected runner with nothing to do is a silent day, and a silent day is
 * never a finding (SPEC section 2): a rule that read only the ledger would
 * report a household on holiday every morning. A runner whose backend died a
 * minute ago with recent work is not a finding either, because the threshold is
 * hours.
 */
export function silentRunners(args: {
  runners: string[];
  liveApplications: string[];
  lastEventAt: Record<string, string | null>;
  hours: number;
  now: Date;
  machine: string;
}): Finding[] {
  const live = new Set(args.liveApplications);
  const out: Finding[] = [];
  for (const runner of args.runners) {
    if (live.has(runner)) continue;
    const last = args.lastEventAt?.[runner] ?? null;
    if (last === null) continue;
    const at = Date.parse(String(last));
    if (!Number.isFinite(at)) continue;
    const silentFor = Math.floor((args.now.getTime() - at) / 1000);
    if (silentFor <= args.hours * 3600) continue;
    out.push({
      id: findingId(args.machine, "runner-silent", runner),
      kind: "runner-silent",
      subject: runner,
      machine: args.machine,
      says: `${runner} has no connection to the store and its newest work is ${Math.floor(silentFor / 3600)} hours old, past the ${args.hours} hour threshold`,
      // No manager's name here: this module is under `src/check/`, and a name
      // `check` can spell is a name `check` could invoke.
      // The unit is named, because that is what a person looks up, and the
      // looking up is theirs.
      fix: `check whether ${runner}'s machine is on, then ask its service manager about the unit imprnt-hub-${runner}`,
    });
  }
  return out;
}
