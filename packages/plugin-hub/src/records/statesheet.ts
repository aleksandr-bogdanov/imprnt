import type { StoreLike } from "../store/connect.ts";
import { recordRefusal } from "./refusal.ts";

export class StateSheetDuplicate extends Error {
  readonly sheet: string;
  readonly id: string;

  constructor(sheet: string, id: string) {
    super(
      `${sheet} already holds a row for ${id}. A state sheet holds one row per id: ` +
        `edit that row, or remove it when the thing is gone.`,
    );
    this.name = "StateSheetDuplicate";
    this.sheet = sheet;
    this.id = id;
  }
}

export interface StateRow {
  sheet: string;
  id: string;
  data: Record<string, unknown>;
  updated_at: Date;
}

const DUPLICATE_KEY = "23505";

function isDuplicate(error: unknown): boolean {
  const errno = (error as { errno?: string }).errno;
  return errno === DUPLICATE_KEY || /duplicate key value/i.test(String((error as Error).message));
}

export async function appendRow(
  store: StoreLike,
  sheet: string,
  id: string,
  data: Record<string, unknown>,
): Promise<void> {
  try {
    await store.sql`insert into state_row (sheet, id, data)
                    values (${sheet}, ${id}, ${data})`;
  } catch (error) {
    if (!isDuplicate(error)) throw error;
    await recordRefusal(store, "refused.state_sheet_duplicate", `${sheet}/${id}`, {
      sheet,
      id,
      reason: String((error as Error).message),
    });
    throw new StateSheetDuplicate(sheet, id);
  }
}

/** A change is an edit to that row. */
export async function putRow(
  store: StoreLike,
  sheet: string,
  id: string,
  data: Record<string, unknown>,
): Promise<void> {
  await store.sql`insert into state_row (sheet, id, data)
                  values (${sheet}, ${id}, ${data})
                  on conflict (sheet, id)
                  do update set data = excluded.data, updated_at = now()`;
}

/** A thing that is gone leaves no line behind. */
export async function removeRow(store: StoreLike, sheet: string, id: string): Promise<void> {
  await store.sql`delete from state_row where sheet = ${sheet} and id = ${id}`;
}

export async function readSheet(store: StoreLike, sheet: string): Promise<StateRow[]> {
  return (await store.sql`select sheet, id, data, updated_at from state_row
                          where sheet = ${sheet} order by id`) as unknown as StateRow[];
}
