import type { StoreLike } from "./connect.ts";

/**
 * Operator-recorded health (migration 22): the store's own answer, as it gave it.
 *
 * Every verdict and every refusal is the store's, made under the locks the
 * work it races with takes, so nothing here decides anything: a preview says
 * what a record would rest on (`verdict`, and the `digest` or `fingerprint` a
 * record must name), and a record names that evidence back and is refused once
 * any of it moved. The rows, the health row, the input, its attempt and its hold
 * are never changed by a resolution, and a dismissal changes only the state of
 * the rows it names.
 */
export type HealthAnswer = Record<string, unknown> & {
  verdict?: string;
  result?: "dismissed" | "resolved" | "unchanged" | "cleared" | "refused";
  cause?: string;
};

/** Who records it: the operator's own account on the machine the command ran on, and that command. */
export interface Operator { by: string; source: string }

/** What dismissing exactly these outbox rows would be, and its digest. */
export async function previewDismissal(store: StoreLike, ids: number[]): Promise<HealthAnswer> {
  const [row] = await store.sql`select hub_outbox_dismissal_plan(${JSON.stringify(ids)}::text::jsonb) as plan`;
  return row.plan as HealthAnswer;
}

export async function dismissNotices(store: StoreLike, ids: number[], digest: string, reason: string, who: Operator): Promise<HealthAnswer> {
  const [row] = await store.sql`select hub_outbox_dismiss(${JSON.stringify(ids)}::text::jsonb, ${digest}, ${reason},
    ${who.by}, ${who.source}) as answer`;
  return row.answer as HealthAnswer;
}

/** Whether an agent's retry is history, judged against the runner the registry names for it. */
export async function previewRetry(store: StoreLike, agent: string, runner: string): Promise<HealthAnswer> {
  const [row] = await store.sql`select hub_health_retry_plan(${agent}, ${runner}) as plan`;
  return row.plan as HealthAnswer;
}

export async function resolveRetry(store: StoreLike, args: { agent: string; runner: string; fingerprint: string; incarnation: string;
  reason: string; who: Operator }): Promise<HealthAnswer> {
  const [row] = await store.sql`select hub_health_resolve_retry(${args.agent}, ${args.runner}, ${args.fingerprint},
    ${args.incarnation}, ${args.reason}, ${args.who.by}, ${args.who.source}) as answer`;
  return row.answer as HealthAnswer;
}

/** Whether an input's missing stamps are history: its attempt over with its exit confirmed, and its hold released. */
export async function previewStamp(store: StoreLike, input: string): Promise<HealthAnswer> {
  const [row] = await store.sql`select hub_health_stamp_plan(${input}) as plan`;
  return row.plan as HealthAnswer;
}

export async function resolveStamp(store: StoreLike, args: { input: string; attempt: string; revision: number; fingerprint: string;
  reason: string; who: Operator }): Promise<HealthAnswer> {
  const [row] = await store.sql`select hub_health_resolve_stamp(${args.input}, ${args.attempt}, ${args.revision}::integer,
    ${args.fingerprint}, ${args.reason}, ${args.who.by}, ${args.who.source}) as answer`;
  return row.answer as HealthAnswer;
}

/** Whether this store has the step at all, so a reader on an older one says nothing rather than failing. */
export async function recordedHealthReady(store: StoreLike): Promise<boolean> {
  const [row] = await store.sql`select to_regprocedure('hub_health_retry_fingerprint(text)') is not null as ready`;
  return row.ready === true;
}

/**
 * The notice batches that are stuck behind a failed part: every undelivered part
 * of each, oldest batch first. What an operator would name to dismiss one.
 */
export async function stuckNoticeBatches(store: StoreLike): Promise<{ batch: string; ids: number[] }[]> {
  const rows = (await store.sql`
    select regexp_replace(o.notice_key, ':part:[0-9]+$', '') as batch, jsonb_agg(o.id order by o.id) as ids
      from outbox o
     where o.kind = 'notice' and o.delivered_at is null and o.delivery_state in ('pending', 'failed')
       and exists (select 1 from outbox f where f.kind = 'notice' and f.delivered_at is null and f.delivery_state = 'failed'
                    and regexp_replace(f.notice_key, ':part:[0-9]+$', '') = regexp_replace(o.notice_key, ':part:[0-9]+$', ''))
     group by 1 order by min(o.id)`) as unknown as { batch: string; ids: (number | string)[] }[];
  return rows.map(row => ({ batch: row.batch, ids: row.ids.map(Number) }));
}

/** Agents whose newest health line is a retry. */
export async function retryAgents(store: StoreLike): Promise<string[]> {
  const rows = (await store.sql`select id from state_row
    where sheet = 'agent_health' and data ->> 'status' = 'retry' order by id`) as unknown as { id: string }[];
  return rows.map(row => row.id);
}

/** Inputs still waiting for a stamp whose hold an owner released: the only inputs a stamp resolution can ever stand on. */
export async function releasedUnfinishedInputs(store: StoreLike): Promise<string[]> {
  const rows = (await store.sql`select i.id from inbound i join replay_hold h on h.inbound_id = i.id
    where h.state = 'released' and i.kind = 'human' and i.state in ('received', 'acked', 'started')
    order by i.received_at, i.id`) as unknown as { id: string }[];
  return rows.map(row => row.id);
}

/** The newest resolution recorded against this exact evidence, or null. */
export async function standingResolution(store: StoreLike, kind: "retry" | "stamp", subject: string):
  Promise<{ at: Date; detail: Record<string, unknown> } | null> {
  const [row] = (kind === "retry"
    ? await store.sql`select at, detail from ledger_event where stream = 'health' and kind = 'retry.resolved' and subject = ${subject}
        and detail ->> 'fingerprint' = hub_health_retry_fingerprint(${subject}) order by seq desc limit 1`
    : await store.sql`select at, detail from ledger_event where stream = 'health' and kind = 'stamp.resolved' and subject = ${subject}
        and detail ->> 'fingerprint' = hub_health_stamp_fingerprint(${subject}) order by seq desc limit 1`) as unknown as
    { at: Date | string; detail: Record<string, unknown> }[];
  return row ? { at: new Date(row.at), detail: row.detail } : null;
}
