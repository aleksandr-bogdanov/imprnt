import type { StoreLike } from "./connect.ts";

export interface InboundMessage {
  id: string;
  person: string;
  agent: string;
  body: string;
  kind?: string;
}

/**
 * The id a platform message always gets, however often it is handed out. A
 * platform that redelivers after a door died mid-write hands back the same
 * triple, so the insert below meets the row it already wrote.
 */
export function inboundId(
  platform: string,
  chat: string,
  platformMessageId: string,
): string {
  return `${platform}:${chat}:${platformMessageId}`;
}

/**
 * Write the message and its first event through whatever `sql` the store
 * carries, so a caller that hands over its own transaction gets both halves
 * committed or rolled back with it. Ledger and queue are one system, which is
 * what makes that possible.
 *
 * Returns whether the row is new. A redelivery writes nothing and says so, and
 * the caller's own diary line depends on that answer: a second chat log line
 * for one message is a message that never happened.
 */
export async function enqueueInbound(
  store: StoreLike,
  message: InboundMessage,
): Promise<boolean> {
  const sql = store.sql;
  const written = (await sql`insert into inbound (id, person, agent, body, kind)
            values (${message.id}, ${message.person}, ${message.agent},
                    ${message.body}, ${message.kind ?? "human"})
            on conflict (id) do nothing
            returning id`) as unknown as { id: string }[];
  if (written.length === 0) return false;
  await sql`insert into ledger_event (stream, subject, kind, actor)
            values ('inbound', ${message.id}, 'received', 'door')`;
  return true;
}
