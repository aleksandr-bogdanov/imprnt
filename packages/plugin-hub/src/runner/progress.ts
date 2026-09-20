import { putRow, removeRow } from "../records/statesheet.ts";
import type { StoreLike } from "../store/connect.ts";

/**
 * What the open turn has done so far, one row per message.
 *
 * The runner writes it while the turn runs and the settle removes it, and the
 * trigger on that write is what wakes the door to edit the one platform message
 * it posted at `started`.
 */
export const TURN_PROGRESS_SHEET = "turn_progress";

export interface ProgressRow {
  person: string;
  agent: string;
  actions: number;
  last_action: string;
  started_at: string;
}

export async function writeProgress(
  store: StoreLike,
  progress: {
    messageId: string;
    person: string;
    agent: string;
    actions: number;
    lastAction: string;
    startedAt: string;
  },
): Promise<void> {
  await putRow(store, TURN_PROGRESS_SHEET, progress.messageId, {
    person: progress.person,
    agent: progress.agent,
    actions: progress.actions,
    last_action: progress.lastAction,
    started_at: progress.startedAt,
  });
}

export async function clearProgress(store: StoreLike, messageId: string): Promise<void> {
  await removeRow(store, TURN_PROGRESS_SHEET, messageId);
}

export async function readProgress(
  store: StoreLike,
  messageId: string,
): Promise<ProgressRow | null> {
  const rows = (await store.sql`select data from state_row
                                where sheet = ${TURN_PROGRESS_SHEET}
                                  and id = ${messageId}`) as unknown as {
    data: Record<string, unknown>;
  }[];
  return rows.length === 0 ? null : (rows[0].data as unknown as ProgressRow);
}
