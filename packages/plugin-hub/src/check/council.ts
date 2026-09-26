import { COUNCIL_SHEET, openSeatsOf, seatJobId, type CouncilRow } from "../door/council.ts";
import { readSheet } from "../records/statesheet.ts";
import type { StoreLike } from "../store/connect.ts";
import { findingId, type Finding } from "./finding.ts";

/**
 * One open council, as the sheet holds it, with its id and, per seat, which
 * runner holds that seat's job right now (null for a seat nobody claimed).
 */
export type OpenCouncilRow = CouncilRow & { id: string; claims: Record<string, string | null> };

/**
 * Every open council, and the claim on each of its seats' jobs, in two
 * statements. A merged council has no row.
 */
export async function readOpenCouncils(store: StoreLike): Promise<OpenCouncilRow[]> {
  const rows = (await readSheet(store, COUNCIL_SHEET)).map((row) => ({ id: row.id, ...(row.data as unknown as CouncilRow) }));
  const ids = rows.flatMap((row) => row.seats.map((seat) => seatJobId(row.id, seat)));
  const claimed = ids.length === 0 ? [] : (await store.sql`
    select id, claimed_by from inbound
    where id in (select jsonb_array_elements_text(${JSON.stringify(ids)}::text::jsonb))`) as unknown as { id: string; claimed_by: string | null }[];
  const byJob = new Map(claimed.map((one) => [one.id, one.claimed_by]));
  return rows.map((row) => ({
    ...row,
    claims: Object.fromEntries(row.seats.map((seat) => [seat, byJob.get(seatJobId(row.id, seat)) ?? null])),
  }));
}

/**
 * A council older than the household's job grace with seats still open.
 *
 * Keyed on the council and not on its seats, the way the door says it is
 * late once: a person greps one finding per question they asked. The seats
 * that have not answered are named in the fix with who holds each, because
 * an unclaimed seat is a runner that stopped claiming and a claimed one is a
 * child that is still running or keeps dying, and the runner's log is where
 * either is written. Only the councils of this machine's own agents, so two
 * machines running `check` never both report one.
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
      fix: `read the runner log for ${open.map((seat) => {
        const holder = council.claims?.[seat] ?? null;
        return `${seat} (${holder === null ? "unclaimed" : `claimed by ${holder}`})`;
      }).join(", ")}`,
    });
  }
  return out;
}
