import type { StoreLike } from "../store/connect.ts";
import { findingId, type Finding } from "./finding.ts";

/** Replies can be settled while a broken door never reaches its first send. */
export async function unattemptedReplyFindings(args: {
  store: StoreLike;
  doors: Set<string>;
  doorOf: (agent: string) => string;
  deliveredSeconds: (person: string) => number;
  machine: string;
  now: Date;
}): Promise<Finding[]> {
  const rows = await args.store.sql`
    select i.id, i.person, i.agent, coalesce(o.route ->> 'door', i.source ->> 'door') as door,
           coalesce((select min(e.at) from ledger_event e
             where e.stream = 'inbound' and e.kind = 'answered' and e.subject = i.id), min(o.written_at)) as since
      from outbox o join inbound i on i.id = o.inbound_id
     where o.kind = 'reply' and o.delivery_state = 'pending' and o.delivered_at is null
       and o.attempts = 0 and i.state = 'answered'
     group by i.id, i.person, i.agent, coalesce(o.route ->> 'door', i.source ->> 'door')`;
  const findings: Finding[] = [];
  for (const row of rows) {
    const door = row.door ?? args.doorOf(row.agent);
    if (!args.doors.has(door)) continue;
    const seconds = Math.floor((args.now.getTime() - new Date(row.since).getTime()) / 1000);
    const allowed = args.deliveredSeconds(row.person);
    if (!Number.isFinite(seconds) || seconds < allowed) continue;
    findings.push({
      id: findingId(args.machine, "reply-unattempted", row.id),
      kind: "reply-unattempted", subject: row.id, machine: args.machine,
      says: `${row.agent}'s reply to ${row.person} has a pending chunk with zero delivery attempts after ${seconds} s, past its ${allowed} s delivered clock`,
      fix: `read the journal of imprnt-hub-${door} and inspect its store connection and outbox delivery loop`,
    });
  }
  return findings;
}
