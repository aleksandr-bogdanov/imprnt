import type { StoreLike } from "../store/connect.ts";

/**
 * The master's own attempt has been handed a council's event: the bytes are about to go to the
 * engine. That is the moment the event is consumed, and a council that was waiting for its master is
 * being assessed by it from here (and is said to be, and only from here). Called by the feed intent,
 * which is committed before the first byte and is the one place every input passes; it does nothing
 * for any input that is not a council's event, and costs no statement for one.
 *
 * MANDATORY PRE-FEED BOOKKEEPING, NOT A HOOK THAT MAY FAIL. It runs inside the feed intent's own transaction
 * (`markFeedIntent`) and is written as ordinary statements of it: if it cannot be written, the feed intent does
 * not commit, so the attempt is still only claimed, no byte reaches the engine, and the event is not recorded as read by an
 * attempt that was never handed it. Swallowing its failure (the earlier design) rolled back the consumption and the
 * council's move to `assessing` while the feed intent still committed: the master was handed the event and the council
 * said nobody had read it. The consumed attempt is exactly the one this feed intent is about, and the event is only ever
 * consumed once (`consumed_at is null`).
 */
export async function noteEventFed(store: StoreLike, execution: { id: string; inbound_id: string | null }): Promise<void> {
  const inbound = execution.inbound_id;
  if (inbound === null || !inbound.startsWith("council-event:")) return;
  await store.sql`update council_event set consumed_at = now(), consumed_attempt = ${execution.id}, disposition = 'read'
    where inbound_id = ${inbound} and consumed_at is null`;
  await store.sql`update council set lifecycle = 'assessing', revision = revision + 1, updated_at = now()
    where lifecycle = 'waiting_master' and id = (select council_id from council_event where inbound_id = ${inbound})`;
}
