import type { StoreLike } from "./connect.ts";

/** A chunk the runner settled and the door has not delivered yet. */
export interface PendingChunk {
  id: number;
  inbound_id: string;
  seq_in_reply: number;
  body: string;
  person: string;
  agent: string;
}

/** Every chunk of one reply, numbered from one, written by the runner. */
export async function appendChunks(
  store: StoreLike,
  inboundId: string,
  texts: string[],
): Promise<void> {
  for (const [at, body] of texts.entries()) {
    await store.sql`insert into outbox (inbound_id, seq_in_reply, body)
                    values (${inboundId}, ${at + 1}, ${body})`;
  }
}

/**
 * What this agent has to post, oldest reply first and in order inside a reply.
 *
 * A chunk whose row is not settled yet is not here. The reply is postable only
 * once the transaction that wrote it committed the `answered` stamp with it, and
 * a chunk on disk without that stamp is exactly what the door must hold.
 */
export async function readPendingChunks(
  store: StoreLike,
  where: { agent: string },
): Promise<PendingChunk[]> {
  return (await store.sql`
    select o.id, o.inbound_id, o.seq_in_reply, o.body, i.person, i.agent
    from outbox o
    join inbound i on i.id = o.inbound_id
    where i.agent = ${where.agent}
      and o.delivered_at is null
      and i.state in ('answered', 'delivered')
    order by o.id`) as unknown as PendingChunk[];
}

export async function markDelivered(store: StoreLike, chunkId: number): Promise<void> {
  await store.sql`update outbox set delivered_at = now() where id = ${chunkId}`;
}
