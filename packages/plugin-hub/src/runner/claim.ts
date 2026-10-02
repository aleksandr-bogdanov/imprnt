import type { StoreLike } from "../store/connect.ts";
import { RUNNER_PROTOCOL } from "../store/conversations.ts";
import type { EligibleRow } from "../store/wake.ts";

/**
 * Take the next row for this agent, or nothing.
 *
 * One statement, so two runners racing for the same row cannot both take it.
 * Feed order is the table's: rank first, then oldest, then the id.
 * A planned row can be claimed only while it is still next in that order.
 *
 * A row already claimed by THIS runner is its own to redo. A runner that is
 * claiming is a runner that has just started or has just settled, so it was not
 * running that turn: it was killed in the middle of one. That is what lets a
 * restart pick the turn up without waiting a lease out.
 */
export async function claimNext(
  store: StoreLike,
  who: { runner: string; agent: string; leaseMs: number; maxRank?: number; rowId?: string;
    /**
     * Whether this runner's engine can resume an interrupted conversation
     * without replaying it. A row whose conversation holds an interrupted
     * assignment is only claimed when it can, and absent this it is taken to
     * be that it cannot: an unproved capability is not a yes.
     */
    resumeOk?: boolean;
    /** Exclude only master rows when its bound engine differs from the preset. */
    masterBlocked?: boolean },
): Promise<EligibleRow | null> {
  // The pause is a WHERE clause on the statement the runner already
  // runs, not a second query: at the household's own pause threshold proactive
  // work stops and a row a human is waiting on still goes first. 1 is
  // everything, 0 is rank-0 only. Claiming nothing at all is the caller's
  // decision and it never reaches this statement.
  const maxRank = who.maxRank ?? 1;
  // ONE TRANSACTION, on a connection of its own, and the protocol is said inside
  // it: `set_config(..., true)` lasts until this transaction ends, so a pooled
  // connection that claimed under this protocol hands the next borrower nothing,
  // and the claim trigger sees the setting on exactly this statement. A claim made
  // any other way (a runner that predates the protocol, including one of protocol 2
  // once 3 is active) does not carry it and is refused, and a council's job or
  // event is refused to it even before the protocol is activated.
  return await store.sql.begin(async (connection) => {
    await connection`select set_config('hub.runner_protocol', ${String(RUNNER_PROTOCOL)}, true)`;
    const rows = (await connection`
      update inbound
         set claimed_by = ${who.runner},
             claim_deadline = now() + make_interval(secs => ${who.leaseMs / 1000})
       where id = (
         select id from inbound
          where agent = ${who.agent}
            and (not ${who.masterBlocked ?? false}::boolean or kind in ('job', 'harvest'))
            and log_ready
            and rank <= ${maxRank}
            and state not in ('answered', 'delivered')
            and (claimed_by is null or claimed_by = ${who.runner}
                 or (claim_deadline is not null and claim_deadline <= now()))
            and (retry_at is null or retry_at <= now())
            -- An interrupted input is never claimed again, a lease that ran out
            -- proves nothing about the process, and an agent whose attempt is
            -- unresolved takes nothing else. The table's own trigger refuses
            -- the same claims, so a runner that does not ask is refused too.
            and not hub_row_held(id)
            -- A scheduled harvest is another executor of the agent's tools, so it
            -- asks the ownership question too: only an attempt of THIS runner's own
            -- current incarnation (a live turn) lets it run beside it.
            and not (case when kind = 'harvest' then hub_harvest_blocked(agent, ${who.runner}::text) else hub_agent_blocked(agent) end)
            and (${who.resumeOk ?? false}::boolean or not hub_row_needs_resume(id, agent, kind, source))
          order by rank, received_at, id
          limit 1
          for update skip locked
       )
         and (${who.rowId ?? null}::text is null or id = ${who.rowId ?? null})
      returning id, person, agent, body, kind, rank, received_at, state, source,
                claimed_by, claim_deadline, retry_at`) as unknown as EligibleRow[];
    return rows.length === 0 ? null : rows[0];
  });
}
