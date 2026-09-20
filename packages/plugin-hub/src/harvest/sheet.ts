import type { StoreLike } from "../store/connect.ts";

/**
 * The watermark: how far each chat has been harvested.
 *
 * One row per chat, edited in place, which L17 rules is a state sheet rather
 * than a diary. The runner already holds `insert, update, delete on
 * state_row`, so this whole file adds no schema object at all.
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
 * One sheet row's data, whichever of the two encodings it was written in.
 *
 * MEASURED 2026-09-16, and it is the same platform fact `src/check/run.ts`'s
 * `fieldOf` already records for a diary detail. `putRow` binds a JS OBJECT, and
 * this client sends that as a jsonb object: `jsonb_typeof` answers `object` and
 * the read comes back as an object. A writer that binds an ALREADY SERIALISED
 * string (`$2::jsonb` with `JSON.stringify(...)` as the parameter, which is how
 * a check plants a row by hand) stores a jsonb SCALAR STRING whose contents are
 * the object: `jsonb_typeof` answers `string` and the read comes back as a
 * string. A reader that understood only one of them would report a watermark
 * that is really there as absent, and a watermark read as absent is a slice
 * harvested again from the beginning.
 */
function sheetData<T>(raw: unknown): T | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "string") return raw as T;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/**
 * How far this chat has been harvested, or null when nothing has been.
 *
 * NO ROW MEANS NOTHING HARVESTED, which is a different fact from a harvest that
 * found nothing worth keeping: the second moves the watermark and the
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
    data: unknown;
  }[];
  return rows.length === 0 ? null : sheetData<Watermark>(rows[0].data);
}

/** The same unwrapping, for a reader that has the whole sheet in hand. */
export function watermarkOf(data: unknown): Watermark | null {
  return sheetData<Watermark>(data);
}
