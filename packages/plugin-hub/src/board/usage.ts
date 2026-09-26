import { WINDOW_SHEET } from "../runner/outage.ts";
import { readSheet } from "../records/statesheet.ts";
import type { StoreLike } from "../store/connect.ts";

/**
 * What the agents spent, read off the turn records the runner writes.
 *
 * ONE STATEMENT for the turns and one sheet read for the windows, and the
 * page prints what comes back. Every turn record is a `ledger_event` on the
 * `turn` stream of kind `turn`, and its detail carries the three token counts
 * and the price when the household's rates could name one. Nothing is
 * computed on the page: the sums are the database's, and a sum over nothing
 * is null, which the page prints as the nothing mark and never as a zero.
 */

export interface UsageRow {
  agent: string;
  window: "today" | "week";
  /** Null when no turn ran in the window. */
  turns: number | null;
  /** Null when no turn in the window carried a count. */
  tokens: number | null;
  /** Null when no turn in the window carried a price. */
  price: number | null;
  currency: string | null;
}

export interface WindowLine {
  credential: string;
  /** The sheet's own fields, as the runner wrote them. */
  utilization: unknown;
  resets_at: unknown;
  at: unknown;
  reported_by: unknown;
}

/** The UTC day `now` falls in, which is the day every other window on the board is cut by. */
function dayStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0));
}

/**
 * Per agent, today and the last seven UTC days including today, the same
 * two windows the metrics page cuts. An agent with no turn in the week is not
 * a row, and one with turns in the week and none today prints the nothing
 * mark for today.
 */
export async function readUsage(store: StoreLike, args: { now: Date }): Promise<UsageRow[]> {
  const today = dayStart(args.now);
  const week = new Date(today.getTime() - 6 * 86_400_000);
  const rows = (await store.sql.unsafe(
    `select detail ->> 'agent' as agent,
            w.name as window,
            count(*)::int as turns,
            sum(coalesce((detail ->> 'input_tokens')::bigint, 0)
                + coalesce((detail ->> 'cached_input_tokens')::bigint, 0)
                + coalesce((detail ->> 'output_tokens')::bigint, 0))
              filter (where detail ->> 'input_tokens' is not null
                         or detail ->> 'cached_input_tokens' is not null
                         or detail ->> 'output_tokens' is not null) as tokens,
            sum((detail -> 'price' ->> 'amount')::numeric) as price,
            max(detail -> 'price' ->> 'currency') as currency
       from ledger_event
       join (values ('today', $1::timestamptz), ('week', $2::timestamptz)) as w (name, since)
         on at >= w.since
      where stream = 'turn' and kind = 'turn' and detail ->> 'agent' is not null
      group by 1, 2
      order by 1, 2 desc`,
    [today.toISOString(), week.toISOString()],
  )) as { agent: string; window: string; turns: number | string; tokens: string | null; price: string | null; currency: string | null }[];
  // The rows the query answers are the windows that HAVE a turn. The page
  // wants both windows for every agent that has either, so the missing one
  // is filled in here as nothing.
  const out: UsageRow[] = [];
  const agents = [...new Set(rows.map((row) => row.agent))].sort();
  for (const agent of agents) {
    for (const window of ["today", "week"] as const) {
      const found = rows.find((row) => row.agent === agent && row.window === window);
      out.push({
        agent,
        window,
        turns: found ? Number(found.turns) : null,
        tokens: found?.tokens === null || found?.tokens === undefined ? null : Number(found.tokens),
        price: found?.price === null || found?.price === undefined ? null : Number(found.price),
        currency: found?.currency ?? null,
      });
    }
  }
  return out;
}

/** Every credential's newest window reading, in the sheet's own words. */
export async function readWindows(store: StoreLike): Promise<WindowLine[]> {
  return (await readSheet(store, WINDOW_SHEET)).map((row) => ({
    credential: row.id,
    utilization: row.data.utilization,
    resets_at: row.data.resets_at,
    at: row.data.at,
    reported_by: row.data.reported_by,
  }));
}
