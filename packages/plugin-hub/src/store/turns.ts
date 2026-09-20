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
   * A row a turn was REFUSED on is left at `acked` and is
   * released onto its `retry_at`, so its state alone cannot tell a turn that is
   * running from one that is waiting out an outage. The door shows typing for
   * the first and must not for the second.
   */
  claimed_by: string | null;
}

/**
 * The one read that tells a door which of its agent's messages are still open.
 *
 * `answered` is NOT here, and the branch table is why: a turn opens at
 * `acked` and ends at `answered`, and from `answered` on the reply is in the
 * outbox and the door's `post` owns it. A row still at `received` is here
 * because a CLOCK is armed on it (nobody has accepted it yet) even though no
 * turn has opened, so the row's own `state` comes back and `attend` branches on
 * it. One read serves two rules with two different state sets, and a build that
 * treated "open" as one set would get one of them wrong.
 *
 * A ROW A HUMAN IS WAITING ON, AND NEVER
 * MACHINERY. Every consumer of this read is about a person's wait: the typing,
 * the progress line and all three clock lines. Without the filter a `harvest`
 * row sits at `received` from the moment the door writes it until the runner
 * claims it, and the door arms the acked clock on it and posts `[door] still
 * waiting: the loop has not accepted this message. 45 s so far.` into a
 * person's chat about a row nobody sent.
 *
 * THE SET IS RANK 0 AND NOT `human` ALONE.
 * SPEC §2 defines rank 0 in these words: "anything a human is waiting on (a
 * human's message, a report on a job that answers a human's message)". A
 * `report` is a person waiting for an answer as surely as their own message is,
 * and it had typing, a progress line and all three clock lines before this
 * filter existed. `kind in ('human', 'report')` rather than `rank = 0` because
 * the two rank 0 kinds are named in the spec sentence this stands on, and a
 * reader of the statement should see which rows it means.
 *
 * The filter lives HERE and not in `clockDeadlines`, because the read is the
 * one thing all three rules share.
 */
export async function readOpenTurns(
  store: StoreLike,
  where: { agent: string },
): Promise<OpenTurnRow[]> {
  return (await store.sql`
    select id, person, agent, received_at, state, claimed_by
    from inbound
    where agent = ${where.agent}
      and kind in ('human', 'report')
      and state in ('received', 'acked', 'started')
    order by received_at, id`) as unknown as OpenTurnRow[];
}
