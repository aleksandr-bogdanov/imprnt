import type { StoreLike } from "../store/connect.ts";

/**
 * L6's own table, with its alert column.
 *
 * The first four alert and the last does not, which is the ruling's own
 * classification. ALERTING IS `check`'s STAMP FINDING and nothing here raises
 * one: a second path over the same numbers would be two implementations of one
 * verb, so this flag is a fact about the metric rather than a switch this
 * module reads.
 */
export const STAMP_METRICS = [
  { id: "time-to-ack", from: "received", to: "acked", alerts: true },
  { id: "time-to-start", from: "received", to: "started", alerts: true },
  { id: "ack-to-start", from: "acked", to: "started", alerts: true },
  { id: "answered-to-delivered", from: "answered", to: "delivered", alerts: true },
  { id: "time-to-delivered", from: "received", to: "delivered", alerts: false },
] as const;

/**
 * One metric over one window. NULL and not zero when nothing was measured: zero
 * milliseconds is a measurement and "nothing was measured" is not.
 *
 * THE UNIT IS IN THE NAME. Every one of these is a duration, and a bare `p50`
 * in a row a board reads is a number whose unit lives in somebody's head.
 */
export interface Measure {
  p50_ms: number | null;
  p99_ms: number | null;
  count: number;
}

export interface MetricsRow {
  scope: "person" | "agent";
  id: string;
  window: "today" | "week";
  measures: Record<string, Measure>;
}

/** The UTC day `now` falls in, which is the day `src/chatlog.ts` dates a file by. */
function dayStart(now: Date): Date {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0),
  );
}

const SQL = `
with first_stamp as (
  -- D-121a. The FIRST event of each kind per message. A refused turn re-stamps
  -- acked on every retry, and a retry cannot be allowed to shorten a
  -- household's time-to-ack.
  select subject, kind, min(at) as at
    from ledger_event
   where stream = 'inbound'
     and kind in ('received', 'acked', 'started', 'answered', 'delivered')
   group by subject, kind
),
metric (id, from_kind, to_kind) as (
  values ('time-to-ack', 'received', 'acked'),
         ('time-to-start', 'received', 'started'),
         ('ack-to-start', 'acked', 'started'),
         ('answered-to-delivered', 'answered', 'delivered'),
         ('time-to-delivered', 'received', 'delivered')
),
gap as (
  select i.person, i.agent, m.id as metric,
         b.at as landed,
         extract(epoch from (b.at - a.at))::float8 * 1000 as ms
    from inbound i
    cross join metric m
    join first_stamp a on a.subject = i.id and a.kind = m.from_kind
    join first_stamp b on b.subject = i.id and b.kind = m.to_kind
   where i.kind = 'human'
),
scoped as (
  select 'person' as scope, person as id, metric, landed, ms from gap
  union all
  select 'agent' as scope, agent as id, metric, landed, ms from gap
)
select s.scope, s.id, w.name as win, s.metric,
       count(*)::int as n,
       string_agg(s.ms::text, ',' order by s.ms) as gaps
  from scoped s
  join (values ('today', $1::timestamptz), ('week', $2::timestamptz)) as w (name, since)
    on s.landed >= w.since
 group by s.scope, s.id, w.name, s.metric
`;

/**
 * `percentile_cont`'s own definition: linear interpolation over the ordered set.
 *
 * MEASURED 2026-09-16, and this is why the arithmetic is here rather than in
 * the aggregate (BUILD-NOTES 21). The server computes `percentile_cont`'s
 * interpolation with a FUSED multiply-add: asked for the 99th percentile of
 * eighteen values it answers 431999.99999999994, while the same formula
 * evaluated step by step answers 431999.9999999993, in SQL on that same server
 * as much as here. Two ulps, and no board would notice, but a number a
 * household can reproduce by hand is worth more than two ulps, and the server
 * still does the ordering and the grouping.
 */
function percentileOf(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const at = p * (sorted.length - 1);
  const below = Math.floor(at);
  const above = Math.ceil(at);
  if (below === above) return sorted[below];
  return sorted[below] + (at - below) * (sorted[above] - sorted[below]);
}

/**
 * MSG-07 and MSG-09's data: the five metrics, p50, p99 and a count, per person
 * and per agent, over today and over this week.
 *
 * D-133. A MEASUREMENT BELONGS TO THE WINDOW HOLDING ITS LATER STAMP, because
 * that is the moment the number became knowable. Anchoring on `received_at`
 * instead would put a message received at 23:50 and delivered at 00:10 in
 * yesterday's p99, and yesterday's numbers would keep changing after the day
 * was over.
 *
 * The week is the last SEVEN UTC days INCLUDING today, and not an ISO week from
 * Monday, under which a Monday morning board shows one day of data and a
 * household asking "this week" gets an answer that depends on the calendar
 * rather than on the last week of its life.
 *
 * It writes no sheet and raises no finding.
 */
export async function readStampMetrics(
  store: StoreLike,
  options: { now?: Date } = {},
): Promise<MetricsRow[]> {
  const now = options.now ?? new Date();
  const today = dayStart(now);
  const week = new Date(today.getTime() - 6 * 24 * 3_600_000);

  const measured = (await store.sql.unsafe(SQL, [
    today.toISOString(),
    week.toISOString(),
  ])) as {
    scope: string;
    id: string;
    win: string;
    metric: string;
    n: number;
    gaps: string | null;
  }[];

  const who = (await store.sql`
    select distinct person, agent from inbound where kind = 'human'`) as unknown as {
    person: string;
    agent: string;
  }[];

  const scopes: { scope: "person" | "agent"; id: string }[] = [];
  const seen = new Set<string>();
  for (const row of who) {
    for (const one of [
      { scope: "person" as const, id: row.person },
      { scope: "agent" as const, id: row.agent },
    ]) {
      const key = `${one.scope}/${one.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      scopes.push(one);
    }
  }
  scopes.sort((a, b) =>
    a.scope === b.scope ? a.id.localeCompare(b.id) : a.scope < b.scope ? -1 : 1,
  );

  const found = new Map<string, { n: number; p50: number | null; p99: number | null }>();
  for (const row of measured) {
    // Ordered by the server, which is where the ordering belongs.
    const sorted = String(row.gaps ?? "")
      .split(",")
      .filter((one) => one !== "")
      .map((one) => Number(one));
    found.set(`${row.scope}/${row.id}/${row.win}/${row.metric}`, {
      n: Number(row.n),
      p50: percentileOf(sorted, 0.5),
      p99: percentileOf(sorted, 0.99),
    });
  }

  const rows: MetricsRow[] = [];
  for (const one of scopes) {
    for (const window of ["today", "week"] as const) {
      const measures: Record<string, Measure> = {};
      for (const metric of STAMP_METRICS) {
        const said = found.get(`${one.scope}/${one.id}/${window}/${metric.id}`);
        measures[metric.id] = said
          ? { p50_ms: said.p50, p99_ms: said.p99, count: said.n }
          : { p50_ms: null, p99_ms: null, count: 0 };
      }
      rows.push({ scope: one.scope, id: one.id, window, measures });
    }
  }
  return rows;
}

/** What a measure with no data prints. A zero in a table a human reads is a claim. */
const NOTHING_MEASURED = "-";

const HEADINGS = ["scope", "who", "window", "metric", "p50 ms", "p99 ms", "count"];

/**
 * MSG-09's smallest honest display: the table as text.
 *
 * Pure, so a check binds it without a process and phase 7's board binds it
 * without a browser. One implementation, two front ends, which is the whole of
 * D-134.
 */
export function renderMetrics(rows: MetricsRow[]): string {
  const cells: string[][] = [HEADINGS];
  for (const row of rows) {
    for (const metric of STAMP_METRICS) {
      const measure = row.measures[metric.id] ?? { p50_ms: null, p99_ms: null, count: 0 };
      const nothing = measure.count === 0;
      cells.push([
        row.scope,
        row.id,
        row.window,
        metric.id,
        nothing ? NOTHING_MEASURED : String(Math.round(measure.p50_ms ?? 0)),
        nothing ? NOTHING_MEASURED : String(Math.round(measure.p99_ms ?? 0)),
        nothing ? NOTHING_MEASURED : String(measure.count),
      ]);
    }
  }
  const width = HEADINGS.map((_, column) =>
    cells.reduce((widest, line) => Math.max(widest, line[column].length), 0),
  );
  return cells
    .map((line) =>
      line
        .map((cell, column) =>
          column === line.length - 1 ? cell : cell.padEnd(width[column]),
        )
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
}
