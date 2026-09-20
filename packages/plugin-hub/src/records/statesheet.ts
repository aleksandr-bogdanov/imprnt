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

/**
 * Claim the one row an id may have: one winner, and the loser is handed what
 * the winner wrote.
 *
 * `appendRow` is the wrong primitive here for a concrete reason. On a
 * duplicate it calls `recordRefusal`, which opens a SECOND connection on the
 * caller's own url and inserts a `refusal` row as actor `hub`, and only
 * `hub_hub` may write that actor. From a `hub_runner` connection that insert is
 * refused by the policy, so the caller meets a permission error instead of a
 * losing claim and the loser's re-read never happens. Beyond that, two runners
 * racing for one outage row is an EXPECTED race, and a refusal per race is
 * noise in the one diary a household reads.
 *
 * The loser's answer is the WINNER'S DATA, and that is what the whole
 * one-notice arithmetic stands on: the notice key is built from the outage's
 * `since`, so a loser that kept its own would write a second notice per person.
 * The primary key does the arithmetic, which is why this holds across two
 * runners and across a restart.
 */
export async function claimRow(
  store: StoreLike,
  sheet: string,
  id: string,
  data: Record<string, unknown>,
): Promise<{ mine: boolean; data: Record<string, unknown> }> {
  const won = (await store.sql`insert into state_row (sheet, id, data)
                               values (${sheet}, ${id}, ${data})
                               on conflict (sheet, id) do nothing
                               returning data`) as unknown as {
    data: Record<string, unknown>;
  }[];
  if (won.length > 0) return { mine: true, data: won[0].data };
  // Only when it lost, so the common case is one statement.
  const standing = (await store.sql`select data from state_row
                                    where sheet = ${sheet} and id = ${id}`) as unknown as {
    data: Record<string, unknown>;
  }[];
  // THE ONE HOLE IN THE ONE-NOTICE ARITHMETIC, named rather than left to be
  // found. A loser whose re-read finds no row at all
  // answers with its OWN data, which carries its own `since` and therefore a
  // second notice key. It needs a row opened and cleared between one statement
  // and the next, so it is remote, and the alternative is answering with
  // nothing, which every caller would have to branch on.
  return { mine: false, data: standing[0]?.data ?? { ...data } };
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
