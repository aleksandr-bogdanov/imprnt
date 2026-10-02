import { contextOf, contextSentence } from "../recovery/holds.ts";
import type { StoreLike } from "../store/connect.ts";
import { findingId, type Finding } from "./finding.ts";

/**
 * An input the hub will not run again by itself: its attempt reached the engine
 * and did not finish, and only the owner can say what happens next. It is a
 * finding for as long as it is open, because it is a thing a person has to
 * decide and nothing else in the fleet is going to surface, and it is keyed on
 * the ATTEMPT so a second interruption of the same agent is a second finding.
 */
export interface OpenHoldRow {
  execution_id: string;
  inbound_id: string;
  agent: string;
  cause: string;
  state: string;
  revision: number;
  created_at: Date;
  /** What the runner measured about the conversation's native context, for this attempt at this revision. */
  native_context?: unknown;
}

export async function readOpenHolds(store: StoreLike, where: { agents: string[] }): Promise<OpenHoldRow[]> {
  const mine = new Set(where.agents);
  const rows = (await store.sql`
    select h.execution_id, h.inbound_id, e.agent, h.cause, h.state, h.revision, h.created_at, h.native_context
      from replay_hold h join execution e on e.id = h.execution_id
     where h.state <> 'released'
     order by h.created_at, h.execution_id`) as unknown as OpenHoldRow[];
  return rows.filter((row) => mine.has(row.agent)).map((row) => ({ ...row, created_at: new Date(row.created_at) }));
}

export function holdFindings(args: { holds: OpenHoldRow[]; machine: string }): Finding[] {
  return args.holds.map((hold) => ({
    id: findingId(args.machine, "attempt-held", hold.execution_id),
    kind: "attempt-held",
    subject: hold.execution_id,
    machine: args.machine,
    says:
      `${hold.agent}'s input ${hold.inbound_id} is held after an interrupted attempt (${hold.cause}, recovery revision ${hold.revision}, ${hold.state}). ` +
      `It is not run again unless its owner chooses` +
      (hold.cause === "ownership-unknown" ? `, and no other work of ${hold.agent} starts while it is not known whether the attempt is still running` : "") +
      // Only once the attempt is over does the conversation's native context decide whether anything can run.
      (hold.cause === "ownership-unknown" ? "" : `. ${contextSentence(contextOf(hold.native_context))}`),
    fix: `in the owner's chat: /recover ${hold.agent} ${hold.execution_id} ${hold.revision} continue, keep-held, or fresh-context (discard native context after confirmed exit; do not continue unfinished work)`,
  }));
}
