import type { InboundSource } from "./inbound.ts";
import type { StoreLike } from "./connect.ts";
import { listenForWork, type Listener } from "./listen.ts";

/** Why a waiting runner woke up. */
export type WakeReason = "notified" | "deadline" | "timeout";

export const WORK_CHANNEL = "hub_work";
export const OUTBOX_CHANNEL = "hub_outbox";
/** D-114. A turn opened, or the progress of one moved. The payload is the person. */
export const TURN_CHANNEL = "hub_turn";

export interface EligibleRow {
  source?: InboundSource | null;
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
      and log_ready and state not in ('answered', 'delivered')
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
  const connection = await store.sql.reserve();
  try {
    const [row] = (await connection`
      select ceil(extract(epoch from (min(due) - now())) * 1000)::bigint as ms
      from (
        select retry_at as due from inbound
         where agent = ${agent} and retry_at is not null and retry_at > now()
           and log_ready and state not in ('answered', 'delivered')
        union all
        select claim_deadline as due from inbound
         where agent = ${agent} and claim_deadline is not null and claim_deadline > now()
           and log_ready and state not in ('answered', 'delivered')
      ) deadlines`) as { ms: string | null }[];
    return row.ms === null ? null : Number(row.ms);
  } finally { connection.release(); }
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
    /** More payloads that wake it, read at each notification, so the caller may change the set. */
    alsoWakesOn?: ReadonlySet<string>;
    deadline(): Promise<number | null>;
  },
): Promise<Waiter> {
  // A notification that lands while the caller is reading the table or working
  // through what it found belongs to the next wait. Kept here, it is consumed
  // by that wait instead of being dropped between the two.
  let pending = false;
  // The connection died on its own, so it is opened again on the next wait.
  let lost = false;
  let closed = false;
  let listener: Listener | null = null;
  let wake: ((reason: WakeReason) => void) | null = null;

  const arrived = (payload: string) => {
    if (payload !== options.wakesOn && !options.alsoWakesOn?.has(payload)) return;
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
          const reopened = await open();
          if (closed) {
            await reopened.close();
            return "timeout";
          }
          listener = reopened;
          lost = false;
          pending = false;
          // The caller's last read ran with nothing listening, so it is sent
          // back to read once more now that something is.
          return "notified";
        } catch {
          // Nothing announces a server's return, so this wait is the bound.
        }
      } else if (pending) {
        pending = false;
        return "notified";
      }
      if (closed) return "timeout";

      let settle: (reason: WakeReason) => void = () => {};
      const woken = new Promise<WakeReason>((resolve) => {
        settle = resolve;
      });
      let done = false;
      // A WAIT SETTLES ONLY ITSELF. A caller may race this wait against
      // something else and drop it when the other thing wins: the door drops it
      // for an arrival (`src/door/run.ts:786-791`) and arms the next wait in the
      // same drain, and the runner drops it for a stop, a leave or a failed
      // session (`src/runner/run.ts:929-936`). The dropped wait's timer still
      // fires. Clearing `wake` unconditionally there disarmed the wait that had
      // replaced it, so a notification landed in `pending` and was answered one
      // wait late, up to a whole bound. The check is "a wait its caller dropped
      // settles only itself" in `test/store-wake.test.ts`.
      //
      // What keeps a notification from landing ON a dropped wait is the rule
      // the callers keep: between the race settling and the next `wait()` there
      // is no await, so nothing can be delivered to the dropped wait's `finish`
      // in between. The runner keeps it by never waiting again on this waiter
      // after a drop (every non-wait winner ends its loop and the loop closes
      // the waiter). A change that needs an await there has to give the waiter a
      // way to hand an unconsumed wake back first.
      const finish = (reason: WakeReason) => {
        if (done) return;
        done = true;
        if (wake === finish) wake = null;
        settle(reason);
      };
      // Armed before the deadline is read, so a notification that lands during
      // that read is this wait's wake rather than a flag nobody consumes.
      wake = finish;

      // The deadline is read once, here, on the way in. After it this waiter
      // issues no statement at all until it is woken, which is what makes a
      // wait tellable apart from a poll in the server's own statement log.
      const due = lost || done ? null : await options.deadline();

      const timers: ReturnType<typeof setTimeout>[] = [];
      try {
        if (!done) {
          if (due !== null) {
            timers.push(
              setTimeout(
                () => finish("deadline"),
                Math.max(0, due) + PAST_THE_DEADLINE_MS,
              ),
            );
          }
          timers.push(setTimeout(() => finish("timeout"), timeoutMs));
        }
        const why = await woken;
        // A WAIT THAT RAN WITH NO LISTENER IS NOT A WAIT THAT WAS TOLD
        // NOTHING. Its bound is the only thing that could ever have ended it,
        // so the honest answer to "why are you awake" is the one that sends the
        // caller to the table: a runner whose LISTEN could not be opened or
        // reopened would otherwise sleep through every row committed for it,
        // for as long as the server refused the second connection. Measured:
        // with `listenForWork` throwing, `test/runner-drain.test.ts` waits out
        // its full minute for a message the door committed in the first second,
        // and with this line it answers it. It is the same reasoning the door
        // already applies to a refused post (`src/door/run.ts:190`): nothing
        // announces a thing coming back, so the clock is what has to.
        return lost && why === "timeout" ? "notified" : why;
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

/**
 * The door's waiter: one person, and no deadline, the way a chunk has none.
 *
 * `also` holds more people whose announcements wake it. A reply is announced
 * under the person of the message it answers, so an agent that now belongs to
 * another person still has its answers to earlier messages announced under
 * the earlier one. The set is the caller's and is read at each notification.
 */
export async function openOutboxWaiter(
  store: StoreLike,
  options: { person: string; also?: ReadonlySet<string> },
): Promise<Waiter> {
  return await openWaiter(store, {
    channel: OUTBOX_CHANNEL,
    wakesOn: options.person,
    alsoWakesOn: options.also,
    deadline: async () => null,
  });
}

/**
 * The door's second waiter: one person, and no deadline, because a turn opening
 * is a commit and not a time.
 *
 * D-126. It is a SECOND connection per agent, said plainly here so the cost is a
 * decision and not a surprise. One waiter listening on two channels was the
 * alternative, and it would change `openWaiter`, which is the one piece three
 * shipped statement-count windows sit on.
 */
export async function openTurnWaiter(
  store: StoreLike,
  options: { person: string },
): Promise<Waiter> {
  return await openWaiter(store, {
    channel: TURN_CHANNEL,
    wakesOn: options.person,
    deadline: async () => null,
  });
}
