import type { StoreLike } from "./connect.ts";

/**
 * One message of this agent's that is not finished, with the state that says
 * what the door owes it.
 */
export interface OpenTurnRow {
  id: string;
  person: string;
  agent: string;
  received_at: Date;
  state: string;
  /**
   * The runner that holds this row right now, or null.
   *
   * REVIEW S4. A row a turn was REFUSED on is left at `acked` (D-121a) and is
   * released onto its `retry_at`, so its state alone cannot tell a turn that is
   * running from one that is waiting out an outage. The door shows typing for
   * the first and must not for the second.
   */
  claimed_by: string | null;
}

/**
 * The one read that tells a door which of its agent's messages are still open.
 *
 * D-126. `answered` is NOT here, and the branch table is why: a turn opens at
 * `acked` and ends at `answered`, and from `answered` on the reply is in the
 * outbox and the door's `post` owns it. A row still at `received` is here
 * because a CLOCK is armed on it (nobody has accepted it yet) even though no
 * turn has opened, so the row's own `state` comes back and `attend` branches on
 * it. One read serves two rules with two different state sets, and a build that
 * treated "open" as one set would get one of them wrong.
 *
 * D-143. A PERSON'S OWN MESSAGE AND NEVER MACHINERY. Every consumer of this
 * read is about a person's wait: the typing, the progress line and all three
 * clock lines, and `readStampRows` and `readStampMetrics` already select
 * `kind = 'human'` for exactly that reason. Without the filter a `harvest` row
 * sits at `received` from the moment the door writes it until the runner claims
 * it, and the door arms the acked clock on it and posts `[door] still waiting:
 * the loop has not accepted this message. 45 s so far.` into a person's chat
 * about a row nobody sent. The filter lives HERE and not in `clockDeadlines`,
 * because the read is the one thing all three rules share.
 */
export async function readOpenTurns(
  store: StoreLike,
  where: { agent: string },
): Promise<OpenTurnRow[]> {
  return (await store.sql`
    select id, person, agent, received_at, state, claimed_by
    from inbound
    where agent = ${where.agent}
      and kind = 'human'
      and state in ('received', 'acked', 'started')
    order by received_at, id`) as unknown as OpenTurnRow[];
}
