import type { StoreLike } from "./connect.ts";
import { listenForWork } from "./listen.ts";

/** Why a waiting runner woke up. */
export type WakeReason = "notified" | "deadline" | "timeout";

export const WORK_CHANNEL = "hub_work";
export const OUTBOX_CHANNEL = "hub_outbox";

export interface EligibleRow {
  id: string;
  person: string;
  agent: string;
  body: string;
  kind: string;
  rank: number;
  received_at: Date;
  state: string;
  claimed_by: string | null;
  claim_deadline: Date | null;
  retry_at: Date | null;
}

/**
 * A wake lands a moment after the deadline rather than on it, because a runner
 * woken before the row is eligible has been woken about nothing.
 */
const PAST_THE_DEADLINE_MS = 50;

/**
 * The work waiting for this agent: the table holds it, and this is the read.
 * Feed order is rank first, so a report a human is waiting on goes before a
 * later message, and only then oldest first.
 */
export async function readEligible(
  store: StoreLike,
  where: { agent: string },
): Promise<EligibleRow[]> {
  return (await store.sql`
    select id, person, agent, body, kind, rank, received_at, state,
           claimed_by, claim_deadline, retry_at
    from inbound
    where agent = ${where.agent}
      and state not in ('answered', 'delivered')
      and (claimed_by is null or (claim_deadline is not null and claim_deadline <= now()))
      and (retry_at is null or retry_at <= now())
    order by rank, received_at, id`) as unknown as EligibleRow[];
}

/**
 * How long until the nearest deadline this agent has recorded, measured by the
 * server so the sleep never rides on a second clock. Null when nothing is due.
 */
async function untilNextDeadline(
  store: StoreLike,
  agent: string,
): Promise<number | null> {
  const [row] = (await store.sql`
    select ceil(extract(epoch from (min(due) - now())) * 1000)::bigint as ms
    from (
      select retry_at as due from inbound
       where agent = ${agent} and retry_at is not null and retry_at > now()
         and state not in ('answered', 'delivered')
      union all
      select claim_deadline as due from inbound
       where agent = ${agent} and claim_deadline is not null and claim_deadline > now()
         and state not in ('answered', 'delivered')
    ) deadlines`) as { ms: string | null }[];
  return row.ms === null ? null : Number(row.ms);
}

/**
 * Sleep until something wakes this waiter, and issue nothing while it sleeps.
 *
 * The LISTEN happens on the way in. After it the waiter is asleep on the
 * notification the producing transaction emits, on a deadline it was handed, or
 * on the bound it was given. A read on a timer would be the polling the store
 * exists to avoid.
 */
async function sleepUntilWoken(options: {
  url: string;
  channel: string;
  wakesOn: string;
  deadlineMs: number | null;
  timeoutMs: number;
}): Promise<WakeReason> {
  let wake: (reason: WakeReason) => void = () => {};
  const woken = new Promise<WakeReason>((resolve) => {
    wake = resolve;
  });
  let settled = false;
  const finish = (reason: WakeReason) => {
    if (settled) return;
    settled = true;
    wake(reason);
  };

  const listener = await listenForWork({
    url: options.url,
    channel: options.channel,
    onNotify: (payload) => {
      if (payload === options.wakesOn) finish("notified");
    },
  });

  const timers: ReturnType<typeof setTimeout>[] = [];
  try {
    if (options.deadlineMs !== null) {
      timers.push(
        setTimeout(
          () => finish("deadline"),
          Math.max(0, options.deadlineMs) + PAST_THE_DEADLINE_MS,
        ),
      );
    }
    timers.push(setTimeout(() => finish("timeout"), options.timeoutMs));
    return await woken;
  } finally {
    for (const timer of timers) clearTimeout(timer);
    await listener.close();
  }
}

/**
 * Wait for work without asking for it. The nearest recorded deadline is read
 * here, on the way in, so the sleep never rides on a second clock.
 */
export async function waitForWork(
  store: StoreLike,
  options: { agent: string; timeoutMs: number },
): Promise<WakeReason> {
  const due = await untilNextDeadline(store, options.agent);
  return await sleepUntilWoken({
    url: store.url,
    channel: WORK_CHANNEL,
    wakesOn: options.agent,
    deadlineMs: due,
    timeoutMs: options.timeoutMs,
  });
}

/**
 * Wait for a reply to post. A chunk carries no deadline of its own: it is
 * postable the moment the settling transaction that wrote it commits, and that
 * commit is what emits the notification.
 */
export async function waitForOutbox(
  store: StoreLike,
  options: { person: string; timeoutMs: number },
): Promise<WakeReason> {
  return await sleepUntilWoken({
    url: store.url,
    channel: OUTBOX_CHANNEL,
    wakesOn: options.person,
    deadlineMs: null,
    timeoutMs: options.timeoutMs,
  });
}
