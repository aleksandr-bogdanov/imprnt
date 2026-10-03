import { createHash } from "node:crypto";
import type { Registry } from "../registry/load.ts";
import { listAgents } from "../registry/entries.ts";
import type { StoreLike } from "../store/connect.ts";
import { accountHash, accountsOf } from "./accounts.ts";
import { adapterFor, validTarget } from "./adapter.ts";
import { bounded } from "./delivery.ts";

export const NORMAL_MS = 2 * 60 * 60 * 1000;
export const COOKING_MS = 5 * 60 * 1000;
/** A reported fresh-post window is bounded to one day and must be refreshed by read evidence, not a model flag. */
export function nextRead(now: number, hot: string | null): number {
  return now + (hot && Number.isFinite(Date.parse(hot)) && Date.parse(hot) > now ? COOKING_MS : NORMAL_MS);
}
export async function readOutbound(store: StoreLike, registry: Registry, door: string, now = Date.now()): Promise<void> {
  for (const account of accountsOf(registry).filter(a => a.door === door && a.platform === "linkedin")) {
    await store.sql`insert into outbound_read (account,person,config_hash) values (${account.id},${account.person},${accountHash(account)})
      on conflict (account) do update set person=excluded.person, config_hash=excluded.config_hash, findings='[]'::jsonb, hot_until=null, next_at=now()
      where outbound_read.config_hash <> excluded.config_hash`;
    const claim = await store.sql`update outbound_read set next_at = ${new Date(now + COOKING_MS).toISOString()}::timestamptz
      where account = ${account.id} and next_at <= ${new Date(now).toISOString()}::timestamptz returning hot_until, findings`;
    if (!claim.length) continue;
    let hot = claim[0].hot_until ? new Date(claim[0].hot_until).toISOString() : null;
    try {
      const adapter = await adapterFor(account);
      if (!adapter.read || !adapter.surfaces?.length) throw new Error("reading-unsupported");
      const partial = !["comments", "feed"].every(s => adapter.surfaces?.includes(s));
      const result = await bounded(signal => adapter.read!({ surfaces: ["comments", "feed", "messages"].filter(s => adapter.surfaces?.includes(s)) }, account.options ?? {}, signal));
      if (result.identity !== account.identity || !Array.isArray(result.findings) || result.findings.length > 100 ||
        result.findings.some(f => !f || typeof f.id !== "string" || f.id.length > 1000 || !f.id || !["comments","feed","messages"].includes(f.surface) ||
          !validTarget(f.target, account.platform) || typeof f.text !== "string" || f.text.length > 8000 || !Number.isFinite(Date.parse(f.changed_at)))) throw new Error("reading-invalid");
      if (result.fresh_post_until && Date.parse(result.fresh_post_until) > now) hot = new Date(Math.min(Date.parse(result.fresh_post_until), now + 86400000)).toISOString();
      const findings = result.findings.map(f => ({ ...f, account: account.id, config_hash: accountHash(account) }));
      const saved = await store.sql`update outbound_read set findings = ${findings}::jsonb, hot_until = ${hot}::timestamptz, cause = ${partial ? "partial-reading-support" : null},
        next_at = ${new Date(nextRead(now, hot)).toISOString()}::timestamptz, updated_at = now() where account = ${account.id} and config_hash = ${accountHash(account)} returning account`;
      if (saved.length && findings.length && JSON.stringify(findings) !== JSON.stringify(claim[0].findings)) {
        const agent = listAgents(registry).find(a => a.id === account.agent)!;
        const digest = createHash("sha256").update(JSON.stringify(findings)).digest("hex");
        await store.sql`select hub_door_notice(${account.person}, ${account.agent},
          ${`LinkedIn: ${findings.length} comment/feed/message findings are available to your master. It can select a post and prepare a reply; only your check on the exact draft sends it.`},
          ${`outbound-reading:${account.id}:${digest}`}, ${{ door, chat: agent.chat }}::jsonb, 1)`;
      }
    } catch {
      await store.sql`update outbound_read set cause = 'reading-unavailable', next_at = ${new Date(nextRead(now, hot)).toISOString()}::timestamptz where account = ${account.id} and config_hash = ${accountHash(account)}`;
    }
  }
}
