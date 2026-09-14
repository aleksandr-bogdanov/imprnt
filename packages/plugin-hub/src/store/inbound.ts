import type { StoreLike } from "./connect.ts";

export interface InboundMessage {
  id: string;
  person: string;
  agent: string;
  body: string;
}

/**
 * Write the message and its first event through whatever `sql` the store
 * carries, so a caller that hands over its own transaction gets both halves
 * committed or rolled back with it. Ledger and queue are one system, which is
 * what makes that possible.
 */
export async function enqueueInbound(
  store: StoreLike,
  message: InboundMessage,
): Promise<void> {
  const sql = store.sql;
  await sql`insert into inbound (id, person, agent, body)
            values (${message.id}, ${message.person}, ${message.agent}, ${message.body})`;
  await sql`insert into ledger_event (stream, subject, kind, actor)
            values ('inbound', ${message.id}, 'received', 'door')`;
}
