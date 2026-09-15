import { putRow, readSheet } from "../records/statesheet.ts";
import type { StoreLike } from "../store/connect.ts";

/**
 * How far a door has told a platform it has read. It lives in the one store as
 * an ordinary state sheet, not in a file beside the door, because a file is a
 * second place a machine's state can live.
 *
 * It moves only after the inbound row has committed. A cursor that moved first
 * is a message the platform will never hand out again and nothing wrote down.
 */
export const CURSOR_SHEET = "door_cursor";

export function cursorId(door: string, chat: string): string {
  return `${door}/${chat}`;
}

export async function readCursor(
  store: StoreLike,
  door: string,
  chat: string,
): Promise<string | null> {
  const mine = (await readSheet(store, CURSOR_SHEET)).find(
    (row) => row.id === cursorId(door, chat),
  );
  return mine ? ((mine.data as { cursor: string }).cursor ?? null) : null;
}

export async function writeCursor(
  store: StoreLike,
  door: string,
  chat: string,
  cursor: string,
): Promise<void> {
  await putRow(store, CURSOR_SHEET, cursorId(door, chat), { cursor });
}
