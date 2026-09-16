import type { StoreLike } from "../store/connect.ts";

/**
 * D-141. The watermark: how far each chat has been harvested.
 *
 * One row per chat, edited in place, which L17 rules is a state sheet rather
 * than a diary. D-115 already granted the runner `insert, update, delete on
 * state_row` in phase 4, so this whole file adds no schema object at all.
 */
export const HARVEST_SHEET = "harvest";

export interface Watermark {
  /** The LAST HARVESTED LINE's own time, never the row's `until`. */
  at: string;
  /** The harvest row this watermark was written by. */
  row: string;
  harvested_at: string;
  notes: number;
  lines: number;
}

/** Per CHAT, so two chats of one person are two watermarks. */
export function watermarkId(person: string, agent: string): string {
  return `${person}/${agent}`;
}

/**
 * The row, PURE, so a check can compute what a settle must write.
 *
 * `at` IS THE VALUE HANDED IN AND NEVER A CLOCK OF THIS FUNCTION'S, and that is
 * what makes a late line safe. An `in` line's `at` is the platform's clock
 * (Telegram's `message.date * 1000`, second precision) and an `out` line's is
 * the door's own, so a line can land in the file with an `at` a little before
 * the `until` the door already fixed. With the watermark at `until` that line
 * would be invisible for ever, which is L19's forbidden "deleting an
 * unharvested slice". With it at the last line actually read, the line falls
 * into the next slice.
 */
export function watermarkRow(args: {
  person: string;
  agent: string;
  at: string;
  row: string;
  harvestedAt: string;
  notes: number;
  lines: number;
}): { id: string; data: Record<string, unknown> } {
  return {
    id: watermarkId(args.person, args.agent),
    data: {
      at: args.at,
      row: args.row,
      harvested_at: args.harvestedAt,
      notes: args.notes,
      lines: args.lines,
    },
  };
}

/**
 * How far this chat has been harvested, or null when nothing has been.
 *
 * NO ROW MEANS NOTHING HARVESTED, which is a different fact from a harvest that
 * found nothing worth keeping: the second moves the watermark (D-153) and the
 * first has none to move. One row by its key rather than the whole sheet,
 * because the runner asks this once per harvest turn and the door asks it only
 * when it is about to write a row.
 */
export async function readWatermark(
  store: StoreLike,
  where: { person: string; agent: string },
): Promise<Watermark | null> {
  const rows = (await store.sql`select data from state_row
                                where sheet = ${HARVEST_SHEET}
                                  and id = ${watermarkId(where.person, where.agent)}`) as unknown as {
    data: Watermark;
  }[];
  return rows.length === 0 ? null : rows[0].data;
}
