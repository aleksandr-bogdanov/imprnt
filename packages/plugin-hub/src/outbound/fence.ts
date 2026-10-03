import type { StoreLike } from "../store/connect.ts";

/** Same maintenance lock as deletion confirmation, erase and restore. Held on a
 * reserved connection across committed send intent, transport and publication. */
export async function outboundFence(store: StoreLike): Promise<{ store: StoreLike; release: () => Promise<void> }> {
  const connection = await store.sql.reserve();
  try { await connection`select pg_advisory_lock_shared(682151,1)`; }
  catch (error) { connection.release(); throw error; }
  return { store: { ...store, sql: connection } as unknown as StoreLike,
    release: async () => { try { await connection`select pg_advisory_unlock_shared(682151,1)`; } finally { connection.release(); } } };
}

/** A previously loaded outbox row cannot outlive its source deletion. */
export async function outboundNoticeFence(store: StoreLike, id: number | string) {
  const {release, store: fenced} = await outboundFence(store);
  try {
    const [row] = await fenced.sql`select cf.payload->>'agent' as agent from outbox o join confirmation cf
      on cf.operation_kind='outbound.send' and (o.route->>'outbound_confirmation'=cf.id or starts_with(o.notice_key,'outbound:' || cf.id || ':'))
      where o.id=${id} and public.hub_outbound_source_live(cf.payload->>'agent')`;
    if (!row) { await release(); return null; }
    return { sourceAgent: String(row.agent), release };
  } catch (error) { await release(); throw error; }
}
