import type { StoreLike } from "./connect.ts";

/**
 * A chunk the runner settled and the door has not delivered yet.
 *
 * D-113. Two things come through here now. A `reply` is half of an answer and
 * hangs on the message it answers. A `notice` is one line about a
 * household-wide cause and hangs on nothing, so it carries its own person and
 * agent and its `inbound_id` is null.
 */
export interface ReplyRoute { door: string; chat: string }

export interface PendingChunk {
  written_at: Date;
  route: ReplyRoute | null;
  id: number;
  kind: "reply" | "notice";
  inbound_id: string | null;
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
    await store.sql`insert into outbox (inbound_id, seq_in_reply, body, route)
                    values (${inboundId}, ${at + 1}, ${body},
                      (select case when source is null then null else
                        jsonb_build_object('door', source->>'door', 'chat', source->>'chat') end
                       from inbound where id = ${inboundId}))`;
  }
}

/**
 * One line about a household-wide cause, written once however many runners
 * write it. False when the key was already there.
 *
 * D-122. The arithmetic is the database's: `outbox.notice_key` is unique, so a
 * sibling runner on its own connection, a restart and a second turn on the same
 * tick all meet the same index. Nothing here reads before it writes, because a
 * read-then-insert is exactly the check-then-act that two runners defeat.
 *
 * `seq_in_reply` is 1 on every notice. THE CONTRACT IS SILENT ON IT (BUILD-NOTES
 * 2): the column is `not null` and `unique (inbound_id, seq_in_reply)` is inert
 * for a notice, because NULLs are distinct in a unique index, so a constant is
 * both legal and carries no meaning a reader could be misled by.
 */
export async function appendNotice(
  store: StoreLike,
  notice: { person: string; agent: string; body: string; noticeKey: string; route?: ReplyRoute },
): Promise<boolean> {
  const landed = (await store.sql`
    insert into outbox (kind, inbound_id, seq_in_reply, body, person, agent, notice_key, route)
    values ('notice', null, 1, ${notice.body}, ${notice.person}, ${notice.agent},
            ${notice.noticeKey}, ${notice.route ?? null}::jsonb)
    on conflict (notice_key) do nothing
    returning id`) as unknown as { id: number }[];
  return landed.length > 0;
}

/**
 * What this agent has to post, oldest reply first and in order inside a reply.
 *
 * A chunk whose message still has a turn open on it is not here. Between `acked`
 * and `answered` the runner holds that message and its settle has not committed,
 * so a chunk sitting there is half of a reply and posting it is the send before
 * the settle that L1 step 6 forbids.
 *
 * D-113. THAT SUPPRESSION IS A REPLY'S, and it is gated on the kind for that
 * reason: it is L1 step 6 about half of a reply, and a notice is not half of
 * anything. The join is a LEFT one so a notice reaches the door at all, and the
 * person and the agent come off the outbox row when there is no message to read
 * them off. A naive left join silently drops every notice instead, because
 * `i.state not in (...)` is NULL for a row with no `i`.
 */
export async function readPendingChunks(
  store: StoreLike,
  where: { agent: string },
): Promise<PendingChunk[]> {
  return (await store.sql`
    select o.id, o.kind, o.inbound_id, o.seq_in_reply, o.body, o.written_at, o.route,
           coalesce(o.person, i.person) as person,
           coalesce(o.agent, i.agent) as agent
    from outbox o
    left join inbound i on i.id = o.inbound_id
    where coalesce(o.agent, i.agent) = ${where.agent}
      and o.delivered_at is null
      and o.delivery_state = 'pending'
      and (o.kind = 'notice' or i.state not in ('acked', 'started'))
    order by o.id`) as unknown as PendingChunk[];
}

export async function markDelivered(store: StoreLike, chunkId: number): Promise<void> {
  await store.sql`update outbox set delivered_at = now(), delivery_state = 'delivered' where id = ${chunkId}`;
}
