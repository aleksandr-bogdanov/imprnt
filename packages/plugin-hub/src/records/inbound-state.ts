import type { StoreLike } from "../store/connect.ts";

/**
 * What is true now about a message. The column is maintained from the diary by
 * trigger, so this reads one place and never derives a second, divergent answer.
 */
export async function inboundState(store: StoreLike, messageId: string): Promise<string> {
  const rows = (await store.sql`select state from inbound
                                where id = ${messageId}`) as { state: string }[];
  if (rows.length === 0) throw new Error(`no inbound message ${messageId}`);
  return String(rows[0].state);
}
