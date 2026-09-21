import { appendEntry } from "../records/diary.ts";
import type { StampThresholds } from "../registry/entries.ts";
import { TRANSCRIBED_DEFAULT_SECONDS } from "../registry/load.ts";
import type { StoreLike } from "../store/connect.ts";
import type { OpenTurnRow } from "../store/turns.ts";

/** The door's own stream, and the one kind it holds. */
export const CLOCK_STREAM = "clock";

/** One clock: the stamp it is waiting for, and the moment it runs out. */
export interface ClockDeadline {
  stamp: string;
  /** Milliseconds since the epoch, derived from the row's own `received_at`. */
  at: number;
}

/**
 * The clocks a row is waiting on right now, derived from that person's own
 * thresholds and the moment their message became a message with text in it.
 *
 * All three are measured from ONE base and not from the stamp before them,
 * because that base is the moment the person sent it and that is what they are
 * counting from. The row's STATE says which one is armed: a `received` row is
 * waiting for `acked` and for nothing else, an `acked` row for `started`, a
 * `started` row for `answered`.
 *
 * A ROW WAITING FOR ITS OWN TEXT ARMS ONE CLOCK AND IT IS NOT `acked`. While
 * the door is still transcribing a voice note, "the loop has not accepted this
 * message" is a false sentence: there is nothing yet to accept. So a pending
 * row arms `transcribed` alone, and once the text exists the base moves to the
 * moment it existed. A row with no media is unchanged in every case.
 *
 * `delivered` is NOT here and never will be. The thing it measures is the
 * door's own post, and a door that cannot post cannot post a line about not
 * being able to post. It is a `check` finding and nothing else.
 *
 * Pure, so the arithmetic is readable without a store or a clock. The third
 * argument carries its own default, so every two-argument call is unchanged.
 */
export function clockDeadlines(
  row: Pick<OpenTurnRow, "state" | "received_at"> & {
    media_state?: string | null;
    media_done_at?: Date | string | null;
  },
  thresholds: StampThresholds,
  transcribedSeconds: number = TRANSCRIBED_DEFAULT_SECONDS,
): ClockDeadline[] {
  const received = new Date(row.received_at).getTime();
  if (row.media_state === "pending") {
    return [{ stamp: "transcribed", at: received + transcribedSeconds * 1000 }];
  }
  const from =
    row.media_done_at === undefined || row.media_done_at === null
      ? received
      : new Date(row.media_done_at).getTime();
  const waits: Record<string, { stamp: string; seconds: number }> = {
    received: { stamp: "acked", seconds: thresholds.acked_seconds },
    acked: { stamp: "started", seconds: thresholds.started_seconds },
    started: { stamp: "answered", seconds: thresholds.answered_seconds },
  };
  const waiting = waits[row.state];
  if (!waiting) return [];
  return [{ stamp: waiting.stamp, at: from + waiting.seconds * 1000 }];
}

/**
 * The one diary line an expiry writes, as the DOOR.
 *
 * SPEC §2's Forbidden is "an expired clock with no chat line and no finding",
 * and this is the record half: a household can group its own waits by stamp,
 * which is why the stamp here is the ASCII key and never the person's own
 * translated sentence.
 */
export async function recordExpiry(
  store: StoreLike,
  expiry: {
    messageId: string;
    stamp: string;
    seconds: number;
    person: string;
    agent: string;
    /** The chat log line's own id, the one the once-only append wrote under. */
    id: string;
    /** That line's own time, the same ISO instant the file got. */
    at: string;
  },
): Promise<void> {
  await appendEntry(store, {
    stream: CLOCK_STREAM,
    subject: expiry.messageId,
    kind: "expired",
    actor: "door",
    // The line's id and its time are here and its TEXT is not. The sentence is
    // a pure function of the stamp, the seconds and the person's language, so
    // a reader that has this row can render it, and a second copy of a
    // sentence is a copy that drifts from the one the person read.
    detail: {
      stamp: expiry.stamp,
      seconds: expiry.seconds,
      person: expiry.person,
      agent: expiry.agent,
      id: expiry.id,
      at: expiry.at,
    },
  });
}

/**
 * Which (message, stamp) pairs this door has ALREADY spoken about.
 *
 * One statement at connect. A restarted door re-arms every clock it owed,
 * and without this it would also re-post every line the door before it
 * had already posted, because the deadline it reads is the message's own and
 * that deadline is long past.
 */
export async function readSpokenClocks(
  store: StoreLike,
  where: { agent: string },
): Promise<Set<string>> {
  const rows = (await store.sql`
    select e.subject, e.detail ->> 'stamp' as stamp
    from ledger_event e
    join inbound i on i.id = e.subject
    where e.stream = ${CLOCK_STREAM} and e.kind = 'expired'
      and i.agent = ${where.agent}`) as unknown as {
    subject: string;
    stamp: string;
  }[];
  return new Set(rows.map((row) => `${row.subject}/${row.stamp}`));
}
