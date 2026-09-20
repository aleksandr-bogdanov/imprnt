import { putRow, readSheet } from "../records/statesheet.ts";
import type { StoreLike } from "../store/connect.ts";

/**
 * The recognizer's own state sheet: one row per recognizer NAME.
 *
 * Not per person and not per machine, because the recognizer is one per
 * household and what has failed is the recognizer. It is the shape the door's
 * chat health already has, for the same reason: a household reads one sheet to
 * learn whether a thing is working, and `check` reports a row whose `since` is
 * set and stops reporting when it is cleared.
 *
 * NO ROW MEANS NOTHING HAS EVER FAILED, which is a different fact from a
 * failure that cleared, so nothing opens a row at startup.
 */
export const VOICE_HEALTH_SHEET = "voice_health";

export interface VoiceHealthRow {
  /** When the current episode of failure began, or null while it is working. */
  since: string | null;
  /** `infra` or `content`, the two the door's step classifies a failure into. */
  class: string | null;
  cause: string | null;
  attempts: number;
  retry_at: string | null;
  last_ok_at: string | null;
  last_ok_recognizer: string | null;
}

const CLEARED: VoiceHealthRow = {
  since: null,
  class: null,
  cause: null,
  attempts: 0,
  retry_at: null,
  last_ok_at: null,
  last_ok_recognizer: null,
};

/** Every recognizer this store has ever heard from, by name. */
export async function readVoiceHealth(
  store: StoreLike,
): Promise<Map<string, VoiceHealthRow>> {
  const rows = await readSheet(store, VOICE_HEALTH_SHEET);
  return new Map(
    rows.map((row) => [row.id, { ...CLEARED, ...(row.data as Partial<VoiceHealthRow>) }]),
  );
}

/**
 * The recognizer did not work, and this is the transition record.
 *
 * `since` survives the whole episode, because that is what tells a household
 * how long the thing has been down rather than how long ago the last retry was,
 * and `attempts` rises with each one.
 */
export async function voiceFailed(
  store: StoreLike,
  what: { recognizer: string; class: string; cause: string; retry_at?: Date | string | null },
): Promise<void> {
  const held = (await readVoiceHealth(store)).get(what.recognizer);
  const now = new Date().toISOString();
  const retry = what.retry_at ?? null;
  await putRow(store, VOICE_HEALTH_SHEET, what.recognizer, {
    ...CLEARED,
    ...held,
    since: held?.since ?? now,
    class: what.class,
    cause: what.cause,
    attempts: (held?.attempts ?? 0) + 1,
    retry_at: retry === null ? null : new Date(retry).toISOString(),
  });
}

/**
 * The recognizer worked, and success is known from real notes rather than from
 * a ping nothing else needs.
 *
 * A HEALTHY NOTE AFTER A HEALTHY NOTE WRITES NOTHING. Every note would
 * otherwise edit this row, and a sheet that changes on every success cannot be
 * read as a record of transitions.
 */
export async function voiceSucceeded(store: StoreLike, recognizer: string): Promise<void> {
  const held = (await readVoiceHealth(store)).get(recognizer);
  if (held && held.since === null) return;
  const now = new Date().toISOString();
  await putRow(store, VOICE_HEALTH_SHEET, recognizer, {
    ...CLEARED,
    last_ok_at: now,
    last_ok_recognizer: recognizer,
  });
}
