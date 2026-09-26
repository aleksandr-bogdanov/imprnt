import { CLOCK_STREAM } from "../door/clock.ts";
import type { StoreLike } from "../store/connect.ts";
import { findingId, type Finding } from "./finding.ts";

/** A clock the door spoke about with no known reason, on a message still open. */
export interface UnexplainedWait {
  id: string;
  person: string;
  agent: string;
  stamp: string;
  state: string;
  /** The door's own instant, ISO. */
  at: string;
}

/**
 * Every open message this machine's agents own whose newest clock line
 * carried the `unknown` reason. ONE statement, and the agent filter in memory,
 * the way the stamp rows are read.
 */
export async function readUnexplainedWaits(store: StoreLike, where: { agents: string[] }): Promise<UnexplainedWait[]> {
  const mine = new Set(where.agents);
  // The NEWEST clock line of each message, and only then the ones that said
  // "unknown": a message whose later clock line found a reason is explained,
  // however its earlier one read.
  const rows = (await store.sql`
    select newest.id, i.person, i.agent, newest.stamp, newest.state, newest.at
      from (
        select distinct on (e.subject) e.subject as id, e.detail ->> 'stamp' as stamp,
               e.detail -> 'why' ->> 'kind' as kind, e.detail -> 'why' -> 'values' ->> 'state' as state, e.at
          from ledger_event e
         where e.stream = ${CLOCK_STREAM} and e.kind = 'expired'
         order by e.subject, e.at desc, e.seq desc
      ) newest
      join inbound i on i.id = newest.id
     where newest.kind = 'unknown'
       and i.state in ('received', 'acked', 'started')`) as unknown as {
    id: string; person: string; agent: string; stamp: string; state: string; at: Date | string;
  }[];
  return rows.filter(row => mine.has(row.agent)).map(row => ({
    id: row.id, person: row.person, agent: row.agent, stamp: row.stamp, state: row.state ?? "",
    at: new Date(row.at).toISOString(),
  }));
}

/**
 * The finding: a message the door could not explain the wait of. Pure. The
 * whole point of the closed list of reasons is that a new kind of silence is
 * not allowed to hide behind a vague sentence, and this is where it surfaces.
 */
export function unexplainedFindings(args: { waits: UnexplainedWait[]; runnerOf: (agent: string) => string; machine: string }): Finding[] {
  return args.waits.map(wait => ({
    id: findingId(args.machine, "wait-unexplained", wait.id),
    kind: "wait-unexplained",
    subject: wait.id,
    machine: args.machine,
    says:
      `${wait.person}'s message to ${wait.agent} is still waiting for its ${wait.stamp} stamp and the door found no known ` +
      `reason for it: raw state ${wait.state}`,
    fix:
      `read the journal of imprnt-hub-${args.runnerOf(wait.agent)}, which is the unit that owes this message its ` +
      `${wait.stamp} stamp, and add what it was doing to the list of reasons`,
  }));
}
