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
  /**
   * The door's transcription step, on the row it belongs to.
   *
   * They come back with this read because the door derives a CLOCK from them,
   * and this read is the one thing all of its rules share: a row still waiting
   * for its own text is waiting for a different stamp, and one whose text
   * arrived late is measured from the moment it arrived. Reading them here is
   * what keeps that clock free of a second statement per tick.
   */
  media_state: string | null;
  media_done_at: Date | null;
  /**
   * When a report landed, and null on every other row.
   *
   * It comes back with this read for the reason the two above do: the door
   * derives a CLOCK from it. A report carries the arrival stamp of the job it
   * answers, so the queue feeds it ahead of a message that arrived while the
   * job ran, and a clock measured from that stamp has run out before the row
   * exists.
   */
  reported_at: Date | null;
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
    select id, person, agent, received_at, state, claimed_by,
           media_state, media_done_at, reported_at
    from inbound
    where agent = ${where.agent}
      and kind in ('human', 'report')
      and state in ('received', 'acked', 'started')
    order by received_at, id`) as unknown as OpenTurnRow[];
}

/**
 * What the door needs beside the open rows to say WHY a clock ran out: the
 * wait its runner wrote down, the agent's retry after a failed turn, the
 * household's outage on the agent's credential, and whether the runner is
 * connected at all, which the server's own view of its clients answers with
 * no heartbeat written. Every one of them is a row keyed by an id the door
 * already holds, and nothing here is interpreted: that is `waitReason`'s job.
 */
export interface WaitSidecar {
  wait: Record<string, unknown> | null;
  health: Record<string, unknown> | null;
  outage: Record<string, unknown> | null;
  runnerLive: boolean;
}

/**
 * The same read as above, carrying the sidecar in the same statement.
 *
 * ONE statement on purpose. A clock running out is allowed its own read and
 * nothing that looks like a tick, and the door's wait is measured in
 * statements, so the facts ride as scalar subqueries on the read the expiry
 * already makes rather than as reads of their own. The sidecar is the same on
 * every row and is taken off the first, or read once more with no rows when
 * the table holds none, so a caller with nothing open still learns whether
 * its runner is there.
 */
export async function readOpenTurnsWithWait(
  store: StoreLike,
  where: { agent: string; runner: string; credential: string | null },
): Promise<{ rows: OpenTurnRow[]; sidecar: WaitSidecar }> {
  const rows = (await store.sql`
    with facts as (
      select (select data from state_row where sheet = 'agent_wait' and id = ${where.agent}) as wait,
             (select data from state_row where sheet = 'agent_health' and id = ${where.agent}) as health,
             (select data from state_row where sheet = 'outage' and id = ${where.credential ?? ""}) as outage,
             exists (select 1 from pg_stat_activity
                      where datname = current_database() and application_name = ${where.runner}) as runner_live
    )
    select i.id, i.person, i.agent, i.received_at, i.state, i.claimed_by,
           i.media_state, i.media_done_at, i.reported_at,
           f.wait, f.health, f.outage, f.runner_live
    from facts f
    left join inbound i on i.agent = ${where.agent}
      and i.kind in ('human', 'report')
      and i.state in ('received', 'acked', 'started')
    order by i.received_at, i.id`) as unknown as (OpenTurnRow & {
    wait: Record<string, unknown> | null; health: Record<string, unknown> | null;
    outage: Record<string, unknown> | null; runner_live: boolean;
  })[];
  const first = rows[0];
  const sidecar: WaitSidecar = {
    wait: first?.wait ?? null,
    health: first?.health ?? null,
    outage: where.credential === null ? null : first?.outage ?? null,
    runnerLive: Boolean(first?.runner_live),
  };
  // The left join yields one row of facts with no message when nothing is open.
  return {
    rows: rows.filter(row => row.id !== null).map(({ wait: _w, health: _h, outage: _o, runner_live: _l, ...row }) => row as OpenTurnRow),
    sidecar,
  };
}
