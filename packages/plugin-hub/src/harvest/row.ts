/**
 * D-142, D-145. The harvest row the DOOR writes, and the arithmetic that says
 * when one is owed.
 *
 * The row is an `inbound` row like every other, because SPEC §2 gives that
 * table one writer and the door is it, and `inbound.kind` already admits
 * `harvest` with rank 1 generated from it. Nothing here needs a schema object.
 */
export interface HarvestBody {
  /** The watermark's `at` at the moment the row was written, or null. */
  from: string | null;
  until: string;
  reason: "quiet" | "backstop" | "demand";
  lines: number;
  /** The demand's own text, on a demand row only. */
  said?: string;
}

/**
 * `harvest:<agent>:<until>`.
 *
 * THE ID CARRIES THE `until`, so two triggers that fire for one chat at one
 * instant meet the same primary key and `enqueueInbound`'s `on conflict (id) do
 * nothing` makes the second a no-op, which is the same machinery a redelivered
 * platform message already meets.
 */
export function harvestRowId(agent: string, until: string): string {
  return `harvest:${agent}:${until}`;
}

export function encodeHarvestBody(body: HarvestBody): string {
  return JSON.stringify(body);
}

export function decodeHarvestBody(body: string): HarvestBody {
  return JSON.parse(body) as HarvestBody;
}

const DAY_MS = 86_400_000;

/** The most recent UTC midnight at or before this moment. */
export function lastMidnight(now: Date): number {
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
}

/** The next UTC midnight after this moment. */
export function nextMidnight(now: Date): number {
  return lastMidnight(now) + DAY_MS;
}

/**
 * D-145. Which trigger is owed right now, or none. PURE: it takes its clock
 * rather than reading one, so the rule is readable and bindable without a store
 * and without waiting for a midnight.
 *
 * THE BACKSTOP IS ASKED FIRST, and it ignores the minimum. L19: "the daily
 * backstop over yesterday for chats that never went quiet, where small slices
 * merge into one turn." Its slice is the wider one, and a quiet row underneath
 * it would be the empty row D-149 describes. It needs no state of its own:
 * once that row is harvested the watermark passes the midnight and the
 * condition is false, and a door that was DOWN over a midnight serves it the
 * moment it comes up, which is what a backstop is for.
 */
export function dueTrigger(args: {
  /** The newest person-or-agent line's `at`, whether harvested or not. */
  newest: string | null;
  /** The oldest UNHARVESTED person-or-agent line's `at`. */
  oldest: string | null;
  /** How many unharvested person-or-agent lines there are. */
  count: number;
  quietMinutes: number;
  minMessages: number;
  now: Date;
}): "quiet" | "backstop" | null {
  // Nothing unharvested is nothing owed, whatever the times say.
  if (args.oldest === null || args.count <= 0) return null;
  if (Date.parse(args.oldest) < lastMidnight(args.now)) return "backstop";
  if (args.newest === null) return null;
  if (args.now.getTime() - Date.parse(args.newest) < args.quietMinutes * 60_000) return null;
  return args.count >= args.minMessages ? "quiet" : null;
}
