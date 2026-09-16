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
 */
export async function readOpenTurns(
  store: StoreLike,
  where: { agent: string },
): Promise<OpenTurnRow[]> {
  return (await store.sql`
    select id, person, agent, received_at, state
    from inbound
    where agent = ${where.agent}
      and state in ('received', 'acked', 'started')
    order by received_at, id`) as unknown as OpenTurnRow[];
}
