import type { WindowReading } from "../adapters/types.ts";
import { claimRow, putRow } from "../records/statesheet.ts";
import type { WindowThresholds } from "../registry/presets.ts";
import type { StoreLike } from "../store/connect.ts";

/** D-117. The household's standing outage, one row per credential id. */
export const OUTAGE_SHEET = "outage";

/**
 * D-117. The household's newest window reading, one row per credential id.
 *
 * Household-wide because the allowance is one account's, which is v2's own
 * finding: it first kept the window per person and one person's burn was
 * invisible to the other's pause until a child of theirs happened to fire.
 */
export const WINDOW_SHEET = "window";

export interface OutageRow {
  cause: string;
  since: string;
  said: string;
  credential: string;
  reported_by: string;
  retry_at: string;
}

export interface WindowRow {
  utilization: number;
  resets_at: string | null;
  at: string;
  reported_by: string;
}

/**
 * Open the household's outage, or join the one that is already open.
 *
 * D-122. `claimRow` and never `putRow`, and the whole one-notice arithmetic
 * rests on it: the notice key is built from `since`, so a second runner that
 * overwrote the row with its own clock would produce a second key and a second
 * notice per person, which is the exact rule RUN-18 exists to enforce. The
 * loser is handed the winner's row and uses the winner's `since`.
 */
export async function openOutage(
  store: StoreLike,
  outage: {
    credential: string;
    cause: string;
    said: string;
    runner: string;
    retryAt: string;
  },
): Promise<OutageRow> {
  const claimed = await claimRow(store, OUTAGE_SHEET, outage.credential, {
    cause: outage.cause,
    since: new Date().toISOString(),
    said: outage.said,
    credential: outage.credential,
    reported_by: outage.runner,
    retry_at: outage.retryAt,
  });
  return claimed.data as unknown as OutageRow;
}

/**
 * Take the outage away, and say whether this caller is the one who took it.
 *
 * One statement, so two runners whose turns succeed in the same instant produce
 * one catch-up per person between them. A thing that is gone leaves no line
 * behind (L17), so the row is removed rather than marked fixed.
 */
export async function clearOutage(
  store: StoreLike,
  where: { credential: string },
): Promise<OutageRow | null> {
  const gone = (await store.sql`delete from state_row
                                where sheet = ${OUTAGE_SHEET} and id = ${where.credential}
                                returning data`) as unknown as {
    data: Record<string, unknown>;
  }[];
  return gone.length === 0 ? null : (gone[0].data as unknown as OutageRow);
}

export async function readOutage(
  store: StoreLike,
  credential: string,
): Promise<OutageRow | null> {
  const rows = (await store.sql`select data from state_row
                                where sheet = ${OUTAGE_SHEET} and id = ${credential}`) as unknown as {
    data: Record<string, unknown>;
  }[];
  return rows.length === 0 ? null : (rows[0].data as unknown as OutageRow);
}

/**
 * The newest reading, written by the runner whose turn reported one.
 *
 * `putRow` and not `claimRow`: the newest reading is the reading, up or down,
 * and a household held on a number that has already reset is the failure the
 * falling-reading rule exists to prevent.
 */
export async function recordWindow(
  store: StoreLike,
  reading: {
    credential: string;
    utilization: number;
    resetsAt: string | null;
    runner: string;
  },
): Promise<void> {
  await putRow(store, WINDOW_SHEET, reading.credential, {
    utilization: reading.utilization,
    resets_at: reading.resetsAt,
    at: new Date().toISOString(),
    reported_by: reading.runner,
  });
}

export async function readWindow(
  store: StoreLike,
  credential: string,
): Promise<WindowRow | null> {
  const rows = (await store.sql`select data from state_row
                                where sheet = ${WINDOW_SHEET} and id = ${credential}`) as unknown as {
    data: Record<string, unknown>;
  }[];
  return rows.length === 0 ? null : (rows[0].data as unknown as WindowRow);
}

/**
 * D-122. The key that makes one notice one notice.
 *
 * `outage:<credential>:<since>:<person>` and
 * `outage-over:<credential>:<since>:<person>`, and `since` comes off the sheet
 * so every runner and every restart computes the same string.
 */
export function noticeKey(
  kind: string,
  credential: string,
  since: string,
  person: string,
): string {
  return `${kind}:${credential}:${since}:${person}`;
}

/** The percent this reading is, as a whole number a person reads. */
export function percentOf(window: { utilization: number }): number {
  return Math.round(window.utilization * 100);
}

/**
 * D-123. The highest rank this household may claim right now, or null for
 * nothing at all.
 *
 * Pure, so the three-threshold rule is readable without a store: 1 is
 * everything, 0 is "a human is waiting on it" and proactive work pauses, and
 * null is the hold.
 *
 * A reading whose own reset has PASSED is stale and claims nothing back: the
 * only way the household can learn the window came back is a turn that reports
 * it, and the only way a turn can happen is the hold letting one through. That
 * is D-123's natural release, and without it a held household would sit on a
 * number from an hour ago forever.
 *
 * No reading at all, and no thresholds at all, are both "claim anything": a
 * household that has never seen a window is not a household on hold, and an
 * agent on a per-token key has no window (L10 rule 4).
 */
export function maxRankFor(
  window: WindowReading | WindowRow | null,
  thresholds: WindowThresholds | null,
  now: Date = new Date(),
): number | null {
  if (!window || !thresholds) return 1;
  if (window.resets_at !== null && Date.parse(window.resets_at) <= now.getTime()) return 1;
  const percent = window.utilization * 100;
  if (percent >= thresholds.hold_at) return null;
  if (percent >= thresholds.pause_at) return 0;
  return 1;
}

/** Whether this reading is still the window's own, rather than one that has reset. */
export function readingStands(
  window: WindowReading | WindowRow | null,
  now: Date = new Date(),
): boolean {
  if (!window) return false;
  return window.resets_at === null || Date.parse(window.resets_at) > now.getTime();
}
