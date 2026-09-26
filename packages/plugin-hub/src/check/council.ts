import { COUNCIL_SHEET, openSeatsOf, type CouncilRow } from "../door/council.ts";
import { readSheet } from "../records/statesheet.ts";
import type { StoreLike } from "../store/connect.ts";
import { findingId, type Finding } from "./finding.ts";

/** One open council, as the sheet holds it, with its id. */
export type OpenCouncilRow = CouncilRow & { id: string };

/** Every open council, in one statement. A merged council has no row. */
export async function readOpenCouncils(store: StoreLike): Promise<OpenCouncilRow[]> {
  return (await readSheet(store, COUNCIL_SHEET)).map((row) => ({ id: row.id, ...(row.data as unknown as CouncilRow) }));
}

/**
 * A council older than the household's job grace with seats still open.
 *
 * Keyed on the council and not on its seats, the way the door says it is
 * late once: a person greps one finding per question they asked. The seats
 * that have not answered are named in the fix, because a seat that never
 * landed is a runner that stopped claiming or a child that keeps dying, and
 * its log is where that is written. Only the councils of this machine's own
 * agents, so two machines running `check` never both report one.
 */
export function councilFindings(args: {
  councils: OpenCouncilRow[];
  /** The agents this machine runs, by id. */
  agents: Set<string>;
  graceSeconds: number;
  machine: string;
  now: Date;
}): Finding[] {
  const out: Finding[] = [];
  for (const council of args.councils) {
    if (!args.agents.has(council.agent)) continue;
    const open = openSeatsOf(council);
    if (open.length === 0) continue;
    const age = Math.floor((args.now.getTime() - new Date(council.at).getTime()) / 1000);
    const lateBy = age - args.graceSeconds;
    if (lateBy <= 0) continue;
    out.push({
      id: findingId(args.machine, "council-overdue", council.id),
      kind: "council-overdue",
      subject: council.id,
      machine: args.machine,
      says:
        `${council.id} was convened for ${council.agent} ${age} seconds ago and ${open.length} of its ` +
        `${council.seats.length} seats have not answered, which is ${lateBy} seconds past the ` +
        `${args.graceSeconds} second grace`,
      fix: `read the runner log for ${open.join(", ")}`,
    });
  }
  return out;
}
