import { appendEntry } from "../records/diary.ts";
import type { StoreLike } from "../store/connect.ts";

/**
 * What one note's transcription cost, as its own diary stream.
 *
 * It is a stream rather than a state sheet because it is a HISTORY: a household
 * that wants to know what transcription is costing it reads the interval per
 * note, and the row's own columns below carry only what the step still owes.
 */
export const MEDIA_STREAM = "media";

/** The three moments worth a line. */
export const MEDIA_KINDS = [
  "transcribe.started",
  "transcribe.done",
  "transcribe.failed",
] as const;

export interface TranscribeRecord {
  /** The inbound row the audio belongs to. */
  id: string;
  kind: (typeof MEDIA_KINDS)[number];
  recognizer: string;
  /** How many pieces the note was cut into, and 1 when it was not cut. */
  chunks: number | null;
  audio_s: number | null;
  decode_ms: number | null;
  attempts: number | null;
  /** `infra` or `content` on a failure, and null otherwise. */
  class?: string | null;
  cause?: string | null;
}

/** One line, as the DOOR, which is the only process that runs the step. */
export async function recordTranscribe(
  store: StoreLike,
  what: TranscribeRecord,
): Promise<number> {
  return await appendEntry(store, {
    stream: MEDIA_STREAM,
    subject: what.id,
    kind: what.kind,
    actor: "door",
    // Every key every time, so a household reading the stream never has to tell
    // a field that was absent from one that was null.
    detail: {
      recognizer: what.recognizer,
      chunks: what.chunks ?? null,
      audio_s: what.audio_s ?? null,
      decode_ms: what.decode_ms ?? null,
      attempts: what.attempts ?? null,
      class: what.class ?? null,
      cause: what.cause ?? null,
    },
  });
}

/** The step's own state, as the row carries it. */
export interface MediaState {
  id: string;
  state: string | null;
  attempts: number;
  retry_at: Date | null;
  failure: Record<string, unknown> | null;
  done_at: Date | null;
}

export async function readMediaState(
  store: StoreLike,
  id: string,
): Promise<MediaState | null> {
  const rows = (await store.sql`
    select id, media_state, media_attempts, media_retry_at, media_failure, media_done_at
      from inbound where id = ${id}`) as unknown as {
    id: string;
    media_state: string | null;
    media_attempts: number;
    media_retry_at: Date | null;
    media_failure: Record<string, unknown> | null;
    media_done_at: Date | null;
  }[];
  if (rows.length === 0) return null;
  const [row] = rows;
  return {
    id: row.id,
    state: row.media_state,
    attempts: Number(row.media_attempts),
    retry_at: row.media_retry_at,
    failure: row.media_failure,
    done_at: row.media_done_at,
  };
}

/**
 * The note is waiting for its text, and this is where the step will pick it up.
 *
 * THE ONE MODULE THAT WRITES THE FIVE COLUMNS, and each writer sets everything
 * it touches in ONE statement, so a caller cannot leave half a state behind for
 * a restart to read.
 */
export async function markMediaPending(
  store: StoreLike,
  what: { id: string; retryAt?: Date | string | null },
): Promise<void> {
  const retry = what.retryAt ?? null;
  await store.sql`
    update inbound
       set media_state = 'pending',
           media_retry_at = ${retry === null ? null : new Date(retry).toISOString()}::timestamptz,
           media_failure = null
     where id = ${what.id}`;
}

/**
 * The text exists. The transcript goes into the message it belongs to and the
 * provenance into its source, in the same statement that closes the step, so
 * the row is never half transcribed.
 *
 * `media_done_at` is the moment the text existed, and the door's three shipped
 * clocks are measured from it for this row: the loop cannot accept a message
 * whose text is not there yet.
 */
export async function markMediaDone(
  store: StoreLike,
  what: {
    id: string;
    body: string;
    source: Record<string, unknown>;
    at?: Date | string;
  },
): Promise<void> {
  const at = what.at === undefined ? new Date() : new Date(what.at);
  await store.sql`
    update inbound
       set body = ${what.body},
           source = ${what.source}::jsonb,
           media_state = 'done',
           media_retry_at = null,
           media_failure = null,
           media_done_at = ${at.toISOString()}::timestamptz
     where id = ${what.id}`;
}

/**
 * The step did not get the text this time.
 *
 * `state` is the caller's call and not this module's, because the two failure
 * classes end differently: an infra failure leaves the row PENDING with a
 * retry, and a content failure is over at once, with the text the person will
 * read written in the same statement.
 */
export async function markMediaFailed(
  store: StoreLike,
  what: {
    id: string;
    state: "pending" | "failed";
    failure: Record<string, unknown>;
    retryAt?: Date | string | null;
    body?: string;
    source?: Record<string, unknown>;
  },
): Promise<void> {
  const retry = what.retryAt ?? null;
  await store.sql`
    update inbound
       set media_state = ${what.state},
           media_attempts = media_attempts + 1,
           media_retry_at = ${retry === null ? null : new Date(retry).toISOString()}::timestamptz,
           media_failure = ${what.failure}::jsonb,
           body = coalesce(${what.body ?? null}, body),
           source = coalesce(${what.source ?? null}::jsonb, source)
     where id = ${what.id}`;
}
