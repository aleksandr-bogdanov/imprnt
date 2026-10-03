import { outboundFence } from "./fence.ts";
import { prepareReply } from "../door/reply.ts";
import { generalOf } from "../registry/topics.ts";
import { inert } from "../watch/record.ts";
import { chatUsable } from "../store/topics.ts";
import { randomUUID } from "node:crypto";
import type { ApprovalHooks } from "../door/confirm.ts";
import { listAgents, senderAllowed, noticeRoute } from "../registry/entries.ts";
import type { Registry } from "../registry/load.ts";
import { readConfirmation, type ConfirmationRow } from "../store/confirmations.ts";
import type { StoreLike } from "../store/connect.ts";
import { accountHash, accountsOf } from "./accounts.ts";
import { adapterFor, validTarget, type Message } from "./adapter.ts";

export const OUTBOUND_SEND = "outbound.send";
export interface Payload extends Message { config_hash: string; person: string; agent: string }
export const outboundApprovals = (): ApprovalHooks => ({
  [OUTBOUND_SEND]: async (tx, approval) => {
    // The door calls this only inside its successful exact-preview approval transaction.
    await tx.sql`insert into outbound_delivery (confirmation_id, door)
      select id, door from confirmation where id = ${approval.id} and state = 'approved'
      and operation_kind = ${OUTBOUND_SEND} on conflict do nothing`;
  },
});

export async function bounded<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const limit = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error("outbound-timeout")); }, 60000); });
  try { return await Promise.race([work(controller.signal), limit]); }
  finally { clearTimeout(timer!); }
}

async function ownerRoute(store: StoreLike, registry: Registry, row: ConfirmationRow) {
  const p=row.payload as Payload;
  const own=listAgents(registry).find(a=>a.id===p.agent && a.person===row.person && a.door===row.door && a.chat===row.chat);
  if(own && await chatUsable(store,row.door,row.chat)) return {agent:own.id,door:row.door,chat:row.chat};
  const general=generalOf(registry,row.person);
  if(general && await chatUsable(store,general.door,general.chat)) return {agent:general.id,door:general.door,chat:general.chat};
  return null;
}
async function queueNotice(store: StoreLike, registry: Registry, row: ConfirmationRow, body: string, suffix: string, terminal?: string): Promise<void> {
  // This store uses the already-reserved publication-fence connection.
  // Only notice enqueueing is transactional; provider transport has completed.
  const sql = store.sql;
  await sql.unsafe("BEGIN");
  try {
    await (async () => {
      const tx = { ...store, sql } as StoreLike;
      await sql`select pg_advisory_xact_lock_shared(682151,1)`;
      const route = await ownerRoute(tx,registry,row); if(!route) return;
      const selected = noticeRoute(registry,route.agent); if(!selected) return;
      const key = `outbound:${row.id}:${suffix}`;
      for(const [index,part] of prepareReply(body,selected.platform,selected.language).entries()) {
        const [queued] = await sql`select hub_outbound_notice(${row.id},${row.person},${route.agent},${part},
          ${index===0 ? key : `${key}:part:${index+1}`},${{door:route.door,chat:route.chat}}::jsonb,${index+1}) as ok`;
        if(!queued.ok) return;
      }
      if(terminal) await sql`update outbound_delivery set notified=true where confirmation_id=${row.id} and state=${terminal}`;
    })();
    await sql.unsafe("COMMIT");
  } catch (error) {
    await sql.unsafe("ROLLBACK");
    throw error;
  }
}
async function held(store: StoreLike, registry: Registry, row: ConfirmationRow, cause: string): Promise<void> {
  await store.sql`update outbound_delivery set cause=${cause} where confirmation_id=${row.id} and state='queued'`;
  await queueNotice(store,registry,row,
    `Your approved message has not been sent: ${cause}. It is held until the account or route is repaired. Inspect the draft in your master chat for its exact state.`, `held:${cause}`);
}
async function notice(store: StoreLike, registry: Registry, row: ConfirmationRow, state: string): Promise<void> {
  const p = row.payload as Payload;
  const body = state === "sent" ? `Sent the approved message from ${inert(p.identity)} to ${inert(p.target.label)}.` :
    "The approved message's send result is uncertain. It will not be sent again automatically. Check the destination before preparing another message.";
  await queueNotice(store,registry,row,body,state,state);
}

/** At most one network attempt per approval, even across crashes, timeouts and concurrent doors. */
export async function deliverOutbound(store: StoreLike, registry: Registry, door: string): Promise<void> {
  const accounts = accountsOf(registry); // Unreadable authority never becomes an empty/default account.
  // Advance durable scan order BEFORE inspecting a batch, including rows whose
  // authority or notice route is held. Neither a crash nor one blocked account
  // can pin the oldest twenty forever. updated_at remains the send-attempt clock.
  const rows = await store.sql`with selected as (
    select confirmation_id from outbound_delivery where door = ${door}
      and (state = 'queued' or (state = 'sending' and updated_at < now() - interval '2 minutes')
        or (state in ('sent','uncertain') and not notified))
    order by checked_at, confirmation_id limit 20 for update skip locked
  ) update outbound_delivery d set checked_at = clock_timestamp() from selected s
    where d.confirmation_id = s.confirmation_id returning d.confirmation_id, d.state`;

  for (const delivery of rows) {
    const {release, store: fenced} = await outboundFence(store);
    try {
      const store = fenced;
      const row = await readConfirmation(store, String(delivery.confirmation_id));
      if (!row || row.state !== "approved" || row.operation_kind !== OUTBOUND_SEND) continue;
      const [source] = await store.sql`select hub_outbound_source_live(${(row.payload as Payload).agent}) as live`;
      if(!source.live) continue;
      if (["sent","uncertain"].includes(String(delivery.state))) { await notice(store, registry, row, String(delivery.state)); continue; }
      if (delivery.state === "sending") {
        // A process may have died after the provider accepted the message. Never acquire that claim again.
        await store.sql`update outbound_delivery set state = 'uncertain', cause = 'interrupted-send', updated_at = now()
          where confirmation_id = ${row.id} and state = 'sending'`;
        await notice(store, registry, row, "uncertain");
        continue;
      }
      const p = row.payload as Payload;
      const account = accounts.find(a => a.id === p.account && a.person === row.person && a.door === door);
      const origin = listAgents(registry).find(a => a.id === p.agent && a.person === row.person && a.door === door && a.chat === row.chat);
      if (!(await chatUsable(store, row.door, row.chat)) || !origin || !account || accountHash(account) !== p.config_hash || account.identity !== p.identity || p.person !== row.person ||
          !validTarget(p.target, account.platform) || !senderAllowed(registry, row.person, row.door, row.approved_by ?? "")) {
        await held(store,registry,row,"account-or-authority-changed");
        continue;
      }
      let adapter;
      try { adapter = await adapterFor(account); } catch {
        await held(store,registry,row,"adapter-unavailable"); continue;
      }
      if (!adapter.capabilities.includes(p.target.kind)) {
        await held(store,registry,row,"target-unsupported"); continue;
      }
      const attempt = randomUUID();
      const won = await store.sql`update outbound_delivery set state = 'sending', attempt_id = ${attempt}, cause = null, updated_at = now()
        where confirmation_id = ${row.id} and state = 'queued' returning confirmation_id`;
      if (!won.length) continue;
      // The claim committed BEFORE transport. No error can put it back to queued.
      let receipt: { identity: string; receipt: string } | null = null;
      try {
        const result = await bounded(signal => adapter.send({ account: p.account, identity: p.identity, target: p.target, text: p.text, attempt_id: attempt }, account.options ?? {}, signal));
        if (result?.identity === p.identity && typeof result.receipt === "string" && result.receipt.length > 0 && result.receipt.length <= 2000) receipt = result;
      } catch { /* An exception proves neither delivery nor its absence. Never log provider text or retry. */ }
      const state = receipt ? "sent" : "uncertain";
      await store.sql`update outbound_delivery set state = ${state}, receipt = ${receipt}::jsonb,
        cause = ${receipt ? null : "send-outcome-unknown"}, updated_at = now()
        where confirmation_id = ${row.id} and attempt_id = ${attempt} and state in ('sending','uncertain')`;
      await notice(store, registry, row, state);
    } finally { await release(); }
  }
}
