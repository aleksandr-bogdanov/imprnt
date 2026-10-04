import { safeValue } from "../door/lines.ts";
import type { StoreLike } from "../store/connect.ts";
import { recordedHealthReady } from "../store/health.ts";
import type { Finding } from "./finding.ts";

/**
 * What an operator recorded about a finding, said by `check` beside the
 * findings and never instead of the evidence: a line a human reads, not a
 * failure, and not a clean bill either.
 */
export interface Acknowledged {
  kind: string;
  subject: string;
  machine: string;
  says: string;
}

/** The findings a stamp resolution speaks for: both say the same input is still waiting for a stamp. */
const STAMP_KINDS = new Set(["stamp-missing", "wait-unexplained"]);

/**
 * The findings that stand, and the ones an operator resolved ON THIS EXACT
 * EVIDENCE. A resolution is matched by the fingerprint the store computes now
 * (`hub_health_retry_fingerprint`, `hub_health_stamp_fingerprint`), so a new
 * failure, a new stamp, a new attempt or a hold that moved is new evidence and
 * its finding stands as itself. Nothing else is ever left out. Notices an
 * operator dismissed are not findings at all (they are neither failed nor
 * pending), and are said once per door so they are not silently gone.
 */
export async function recordedHealth(args: {
  store: StoreLike;
  findings: Finding[];
  machine: string;
  /** The doors on this machine, and the door an agent's notice goes through when its row names none. */
  doors: Set<string>;
  doorOf: (agent: string) => string | undefined;
}): Promise<{ standing: Finding[]; acknowledged: Acknowledged[] }> {
  if (!(await recordedHealthReady(args.store))) return { standing: args.findings, acknowledged: [] };
  const asked = args.findings.filter(finding => finding.kind === "agent-retry" || STAMP_KINDS.has(finding.kind));
  const resolved = new Map<string, { at: Date; detail: Record<string, unknown> }>();
  if (asked.length > 0) {
    const pairs = [...new Map(asked.map(finding => [`${finding.kind}\u0000${finding.subject}`,
      { kind: finding.kind === "agent-retry" ? "retry" : "stamp", subject: finding.subject }])).values()];
    const rows = (await args.store.sql`
      select s.kind, s.subject, e.at, e.detail
        from jsonb_to_recordset(${JSON.stringify(pairs)}::text::jsonb) as s(kind text, subject text)
        join lateral (select l.at, l.detail from ledger_event l
          where l.stream = 'health' and l.subject = s.subject
            and l.kind = case when s.kind = 'retry' then 'retry.resolved' else 'stamp.resolved' end
            and l.detail ->> 'fingerprint' = case when s.kind = 'retry' then hub_health_retry_fingerprint(s.subject)
                                                  else hub_health_stamp_fingerprint(s.subject) end
          order by l.seq desc limit 1) e on true`) as unknown as
      { kind: string; subject: string; at: Date | string; detail: Record<string, unknown> }[];
    for (const row of rows) resolved.set(`${row.kind}\u0000${row.subject}`, { at: new Date(row.at), detail: row.detail });
  }
  const standing: Finding[] = [];
  const acknowledged: Acknowledged[] = [];
  for (const finding of args.findings) {
    const key = finding.kind === "agent-retry" ? `retry\u0000${finding.subject}`
      : STAMP_KINDS.has(finding.kind) ? `stamp\u0000${finding.subject}` : null;
    const record = key === null ? undefined : resolved.get(key);
    if (!record) { standing.push(finding); continue; }
    acknowledged.push({ kind: finding.kind, subject: finding.subject, machine: finding.machine,
      says: `resolved by an operator: ${finding.says} (recorded ${record.at.toISOString()} by ${safeValue(record.detail.by)} ` +
        `from ${safeValue(record.detail.source)}: ${safeValue(record.detail.reason)})` });
  }
  const dismissed = (await args.store.sql`select route ->> 'door' as door, agent, count(*)::int as n
    from outbox where delivery_state = 'dismissed' group by 1, 2`) as unknown as { door: string | null; agent: string; n: number }[];
  const perDoor = new Map<string, number>();
  for (const row of dismissed) {
    const door = row.door ?? args.doorOf(row.agent);
    if (door === undefined || !args.doors.has(door)) continue;
    perDoor.set(door, (perDoor.get(door) ?? 0) + Number(row.n));
  }
  for (const [door, n] of [...perDoor].sort(([a], [b]) => a.localeCompare(b))) {
    acknowledged.push({ kind: "notice-dismissed", subject: door, machine: args.machine,
      says: `dismissed by an operator: ${door}: ${n} notice part${n === 1 ? "" : "s"} kept undelivered, with their bytes and failures ` +
        `(imprnt hub health <registry> inspect)` });
  }
  return { standing, acknowledged };
}
