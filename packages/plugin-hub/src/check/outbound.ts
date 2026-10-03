import { accountConfiguration } from "../outbound/accounts.ts";
import { readSetting, type Registry } from "../registry/load.ts";
import type { StoreLike } from "../store/connect.ts";
import { findingId, type Finding } from "./finding.ts";
/** Owner-visible held/uncertain work is retained; check also exposes debt when no chat is usable. */
export async function outboundFindings(store: StoreLike, registry: Registry, machine: string, doors: string[]): Promise<Finding[]> {
  if(readSetting(registry,"outbound.accounts_file")===undefined) return [];
  const result:Finding[]=[];
  const add=(subject:string,says:string,fix:string)=>result.push({id:findingId(machine,"outbound-held",subject),kind:"outbound-held",subject,machine,says,fix});
  try { for(const entry of accountConfiguration(registry).invalid) add(entry.id,"Private outbound account is unavailable","Repair the protected account configuration; no send is authorized by this finding."); }
  catch {add("configuration","Private outbound configuration cannot be read safely","Restore protected owner-controlled configuration before enabling outbound.");}
  const [schema]=await store.sql`select to_regclass('public.outbound_delivery') is not null as ready`;
  if(!schema.ready) {add("schema","Outbound migration021 is not installed","Apply the database installation migrations before enabling outbound.");return result;}
  if(!doors.length) return result;
  const rows=await store.sql`select d.confirmation_id,d.state,d.cause from outbound_delivery d
    where d.door in ${store.sql(doors)} and (d.state='uncertain' or (d.state='queued' and (d.cause is not null or d.updated_at<now()-interval '10 minutes'))) order by d.checked_at limit 100`;
  for(const row of rows) add(String(row.confirmation_id),row.state==='uncertain' ? "An outbound send is uncertain and will not be replayed" : "An approved outbound message remains held",
    row.state==='uncertain' ? "Check the actual destination before preparing a new approved draft." : "Inspect the exact draft in the owner's master chat and repair its account or route.");
  return result;
}
