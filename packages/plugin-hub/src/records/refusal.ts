import { SQL } from "bun";
import type { StoreLike } from "../store/connect.ts";

/**
 * Record a refusal in the diary on a connection of its own. The refusal that is
 * being recorded aborts the transaction it happened in, and an event written
 * there would go down with it.
 */
export async function recordRefusal(
  store: StoreLike,
  kind: string,
  subject: string,
  detail: Record<string, unknown>,
): Promise<void> {
  const sql = new SQL(store.url, { max: 1 });
  try {
    await sql`insert into ledger_event (stream, subject, kind, actor, detail)
              values ('refusal', ${subject}, ${kind}, 'hub', ${JSON.stringify(detail)}::jsonb)`;
  } finally {
    await sql.close().catch(() => {});
  }
}
