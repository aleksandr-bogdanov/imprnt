import { recordJobSuccess } from "../check/schedule.ts";
import { prepareReply } from "../door/reply.ts";
import type { Language } from "../door/lines.ts";
import { appendEntry } from "../records/diary.ts";
import { putRow, removeRow } from "../records/statesheet.ts";
import type { StoreLike } from "../store/connect.ts";
import type { ReplyRoute } from "../store/outbox.ts";

/**
 * What every watch shares: the refusal it fails with, the cap every string it
 * read passes through, and the one transaction a sweep lands in.
 *
 * A watch is a program with no hands (SPEC section 5). It fetches, compares
 * with what it saw last time, and writes one notice the door delivers. No
 * model reads what it fetched, and nothing it fetched is ever an instruction:
 * every string is capped and stripped here, on the way into a record or a line.
 */

/**
 * A sweep that did not land. `code` is the step it stopped at, `reason` is one
 * of the closed list's causes, and `detail` is for the diary only, never a
 * person's chat. Nothing from the source's own answer goes into any of the
 * three, because an answer can carry a key or a person's data.
 */
export class WatchRefused extends Error {
  readonly code: string;
  readonly reason: string;
  readonly detail: string;

  constructor(code: string, reason: string, detail = "") {
    super(`watch-${code}: ${reason}${detail === "" ? "" : `: ${detail}`}`);
    this.name = "WatchRefused";
    this.code = code;
    this.reason = reason;
    this.detail = detail;
  }
}

/**
 * A string from a source, closed: control characters stripped, whitespace
 * collapsed to one space, cut at `max`. A newline in a title would otherwise
 * start a line of the digest the source wrote, and a control character is the
 * same trick by another route.
 */
export function field(value: unknown, max: number): string {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

/** A link a person may open: an https URL and nothing else, or empty. */
export function link(value: unknown): string {
  const text = field(value, 400);
  try {
    const url = new URL(text);
    return url.protocol === "https:" && !/[\s<>]/.test(text) ? text : "";
  } catch {
    return "";
  }
}

export interface SweepLanding {
  entry: string;
  machine: string;
  /** The state sheet, one row per thing the watch follows. */
  sheet: string;
  /** Every row as it is after this sweep, keyed by the thing's own id. */
  rows: Record<string, Record<string, unknown>>;
  /** The ids that are gone, so their rows go too. */
  removed: string[];
  /** The digest, or null when the day had nothing to say. */
  digest: string | null;
  notice: {
    person: string;
    agent: string;
    route: ReplyRoute;
    platform: string;
    language: Language;
    key: string;
  };
  /** The counts the diary line carries, never the text. */
  counts: Record<string, number>;
  at: Date;
}

/**
 * The sweep, landed in ONE transaction: the state, the notice, the diary line
 * and the success stamp, or none of them.
 *
 * The notice goes through the security-definer function the door and the hub
 * already ask with, because the hub's role owns no insert on the outbox. Its
 * key is the day's, so a second sweep on the same day writes the state again
 * and posts nothing: the function's own conflict clause is what makes that
 * true, and the read beside it only says so in the diary.
 *
 * The stamp is written here and nowhere else, in the same transaction as the
 * notice, so it means "ran AND landed" the way the backup's does.
 */
export async function landSweep(store: StoreLike, landing: SweepLanding): Promise<{ posted: boolean }> {
  let posted = false;
  await store.sql.begin(async (sql) => {
    const inside = { sql, url: store.url } as StoreLike;
    for (const id of landing.removed) await removeRow(inside, landing.sheet, id);
    for (const [id, data] of Object.entries(landing.rows)) await putRow(inside, landing.sheet, id, data);
    if (landing.digest !== null) {
      const { notice } = landing;
      const already = (await sql`select id from outbox where notice_key = ${notice.key}`) as unknown as unknown[];
      posted = already.length === 0;
      for (const [index, part] of prepareReply(landing.digest, notice.platform, notice.language).entries()) {
        const key = index === 0 ? notice.key : `${notice.key}:part:${index + 1}`;
        await sql`select hub_door_notice(${notice.person}, ${notice.agent}, ${part}, ${key},
          ${notice.route}::jsonb, ${index + 1})`;
      }
    }
    // The hub's own stream, because this process opens the store as the hub's
    // role and the ledger admits that role on this stream and no other kind
    // of its own. The counts and never the text: a title is a string a
    // stranger wrote, and the diary is what a household reads.
    await appendEntry(inside, {
      stream: "machine",
      subject: landing.entry,
      kind: "watch.swept",
      actor: "hub",
      detail: { watch: landing.entry, ...landing.counts, posted, at: landing.at.toISOString() },
    });
    await recordJobSuccess(inside, { entry: landing.entry, machine: landing.machine, at: landing.at.toISOString() });
  });
  return { posted };
}
