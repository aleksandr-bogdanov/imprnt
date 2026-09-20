import type { StoreLike } from "../store/connect.ts";
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
  who: { runner: string; agent: string; leaseMs: number; maxRank?: number; rowId?: string },
): Promise<EligibleRow | null> {
  // The pause is a WHERE clause on the statement the runner already
  // runs, not a second query: at the household's own pause threshold proactive
  // work stops and a row a human is waiting on still goes first. 1 is
  // everything, 0 is rank-0 only. Claiming nothing at all is the caller's
  // decision and it never reaches this statement.
  const maxRank = who.maxRank ?? 1;
  // Keep concurrent fleet queries off the same client connection until each
  // result has settled; releasing capacity must not strand an in-flight read.
  const connection = await store.sql.reserve();
  try {
    const rows = (await connection`
      update inbound
         set claimed_by = ${who.runner},
             claim_deadline = now() + make_interval(secs => ${who.leaseMs / 1000})
       where id = (
         select id from inbound
          where agent = ${who.agent}
            and log_ready
            and rank <= ${maxRank}
            and state not in ('answered', 'delivered')
            and (claimed_by is null or claimed_by = ${who.runner}
                 or (claim_deadline is not null and claim_deadline <= now()))
            and (retry_at is null or retry_at <= now())
          order by rank, received_at, id
          limit 1
          for update skip locked
       )
         and (${who.rowId ?? null}::text is null or id = ${who.rowId ?? null})
      returning id, person, agent, body, kind, rank, received_at, state, source,
                claimed_by, claim_deadline, retry_at`) as unknown as EligibleRow[];
    return rows.length === 0 ? null : rows[0];
  } finally { connection.release(); }
}
