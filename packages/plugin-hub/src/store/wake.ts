import type { StoreLike } from "./connect.ts";
import { listenForWork, type Listener } from "./listen.ts";

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

/**
 * A waiter that holds its LISTEN open across many waits.
 *
 * The one above opens its LISTEN on the way in, which leaves a gap: a loop
 * reads the table, finds nothing, and only then starts listening, so a
 * transaction that commits in between emits a notification nobody is listening
 * for. The runner recovers on its tick and the door never re-reads on a bare
 * timeout, so on a slow box that gap is a reply that waits for the next commit.
 *
 * Opened once before the first read and kept open, the two halves cover each
 * other: a commit before the read is seen by the read, and a commit after it is
 * delivered to a listener that already exists.
 */
export interface Waiter {
  /** Sleep until something wakes this waiter, at most `timeoutMs`. */
  wait(timeoutMs: number): Promise<WakeReason>;
  /** Close the connection, settling a wait that is in flight. */
  close(): Promise<void>;
}

async function openWaiter(
  store: StoreLike,
  options: {
    channel: string;
    wakesOn: string;
    deadline(): Promise<number | null>;
  },
): Promise<Waiter> {
  // A notification that lands while the caller is reading the table or working
  // through what it found belongs to the next wait. Kept here, it is consumed
  // by that wait instead of being dropped between the two.
  let pending = false;
  /**
   * The nearest recorded deadline, as a local moment with the grace already in
   * it, and whether it has been asked for since anything could have moved it.
   *
   * 03b row 6. THE DEADLINE READ IS ONE STATEMENT, and a wait that asked for it
   * on the way in every time was a statement per bound: a runner on a one
   * second tick asked the store what its nearest deadline was once a second
   * forever, which is the polling `docs/SPEC.md` forbids wearing the costume of
   * arming a wait.
   *
   * A BARE TIMEOUT IS THE PROOF THAT NOTHING MOVED. The timeout timer fires
   * only when no notification arrived AND the deadline timer did not, so the
   * deadline this waiter read is still ahead of it by exactly what is left on
   * the clock. It is carried into the next wait rather than asked for again.
   * Anything else invalidates it: a notification, the deadline itself falling
   * due, and a listener that had to be opened again (which is a window this
   * waiter was deaf through).
   *
   * WHAT MAKES THAT SOUND is that nothing but this waiter's own caller records
   * a deadline on the rows it is waiting on without announcing it:
   * `claimNext` and `settleTurn` are the only writers of `claim_deadline` and
   * `retry_at` in `src/`, both belong to the runner that owns this waiter, and
   * both run between waits after a wake that was not a bare timeout. A third
   * party that started recording deadlines on this agent's rows in silence
   * would have to invalidate this, and would be wrong not to notify anyway.
   */
  let deadlineAt: number | null = null;
  let deadlineKnown = false;
  // The connection died on its own, so it is opened again on the next wait.
  let lost = false;
  let closed = false;
  let listener: Listener | null = null;
  let wake: ((reason: WakeReason) => void) | null = null;

  const arrived = (payload: string) => {
    if (payload !== options.wakesOn) return;
    if (wake) wake("notified");
    else pending = true;
  };

  const dropped = () => {
    if (closed) return;
    lost = true;
    if (wake) wake("notified");
    else pending = true;
  };

  const open = async (): Promise<Listener> =>
    await listenForWork({
      url: store.url,
      channel: options.channel,
      onNotify: arrived,
      onLost: dropped,
    });

  try {
    listener = await open();
  } catch {
    // A store that cannot be listened on is not a reason to refuse the loop
    // that owns this waiter. The first wait tries again, on the bound it was
    // given, which is what the loop did before it held a listener at all.
    lost = true;
  }

  return {
    async wait(timeoutMs: number): Promise<WakeReason> {
      if (closed) return "timeout";

      if (lost) {
        try {
          listener = await open();
          lost = false;
          pending = false;
          // A window this waiter was deaf through is a window a deadline could
          // have been recorded in without it hearing, so what it carried is
          // dropped and the next wait asks again.
          deadlineKnown = false;
          // The caller's last read ran with nothing listening, so it is sent
          // back to read once more now that something is.
          return "notified";
        } catch {
          // Nothing announces a server's return, so this wait is the bound.
        }
      } else if (pending) {
        pending = false;
        deadlineKnown = false;
        return "notified";
      }

      let settle: (reason: WakeReason) => void = () => {};
      const woken = new Promise<WakeReason>((resolve) => {
        settle = resolve;
      });
      let done = false;
      const finish = (reason: WakeReason) => {
        if (done) return;
        done = true;
        // Everything but the bound running out is something happening, and
        // something happening is what can move a deadline.
        if (reason !== "timeout") deadlineKnown = false;
        wake = null;
        settle(reason);
      };
      // Armed before the deadline is read, so a notification that lands during
      // that read is this wait's wake rather than a flag nobody consumes.
      wake = finish;

      // The deadline is read here, on the way in, and ONLY when this waiter
      // does not already know it. After it this waiter issues no statement at
      // all until it is woken, which is what makes a wait tellable apart from a
      // poll in the server's own statement log.
      if (!deadlineKnown && !lost && !done) {
        const due = await options.deadline();
        deadlineAt =
          due === null ? null : Date.now() + Math.max(0, due) + PAST_THE_DEADLINE_MS;
        deadlineKnown = true;
      }

      const timers: ReturnType<typeof setTimeout>[] = [];
      try {
        if (!done) {
          if (deadlineKnown && deadlineAt !== null) {
            // What is left of it, so a deadline carried across three bounds
            // still lands at the moment the server named rather than three
            // bounds after it.
            timers.push(
              setTimeout(() => finish("deadline"), Math.max(0, deadlineAt - Date.now())),
            );
          }
          timers.push(setTimeout(() => finish("timeout"), timeoutMs));
        }
        return await woken;
      } finally {
        for (const timer of timers) clearTimeout(timer);
        if (wake === finish) wake = null;
      }
    },

    async close(): Promise<void> {
      closed = true;
      // A loop that stops while a wait is in flight leaves that wait holding
      // two timers and a socket. Settling it here is what lets both go.
      if (wake) wake("timeout");
      const held = listener;
      listener = null;
      if (held) await held.close();
    },
  };
}

/** The runner's waiter: one agent, and the deadlines recorded on its rows. */
export async function openWorkWaiter(
  store: StoreLike,
  options: { agent: string },
): Promise<Waiter> {
  return await openWaiter(store, {
    channel: WORK_CHANNEL,
    wakesOn: options.agent,
    deadline: () => untilNextDeadline(store, options.agent),
  });
}

/** The door's waiter: one person, and no deadline, the way a chunk has none. */
export async function openOutboxWaiter(
  store: StoreLike,
  options: { person: string },
): Promise<Waiter> {
  return await openWaiter(store, {
    channel: OUTBOX_CHANNEL,
    wakesOn: options.person,
    deadline: async () => null,
  });
}
