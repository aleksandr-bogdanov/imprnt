import type { StampThresholds } from "../registry/entries.ts";
import type { StoreLike } from "../store/connect.ts";
import { findingId, type Finding } from "./finding.ts";

/** One human message that has not finished, with the times a gap is measured from. */
export interface StampRow {
  id: string;
  person: string;
  agent: string;
  state: string;
  received_at: string;
  /** The FIRST `answered` event's own time, or null when there is none yet. */
  answered_at: string | null;
}

/**
 * What each state is waiting for, and what the wait is measured
 * from.
 *
 * Three of the four are measured from `received_at`, because that is the moment
 * the person sent it and what they are counting from. The fourth is measured
 * from the `answered` stamp, because what it measures is the door's own post
 * and a turn that took an hour would otherwise make every delivery look late.
 */
const WAITS: Record<
  string,
  { stamp: string; from: "received" | "answered"; of: keyof StampThresholds }
> = {
  received: { stamp: "acked", from: "received", of: "acked_seconds" },
  acked: { stamp: "started", from: "received", of: "started_seconds" },
  started: { stamp: "answered", from: "received", of: "answered_seconds" },
  answered: { stamp: "delivered", from: "answered", of: "delivered_seconds" },
};

/**
 * Every human message this machine's agents own that is not finished.
 *
 * ONE statement. Only `kind = 'human'`, because the five stamps are a human
 * message's (L6): proactive work nobody is waiting on has no clock to be late
 * against. The agent filter is applied in memory rather than bound into the
 * statement, for the reason `waitingPerPerson` gives: this table holds what is
 * in flight and nothing else.
 */
export async function readStampRows(
  store: StoreLike,
  where: { agents: string[] },
): Promise<StampRow[]> {
  const mine = new Set(where.agents);
  const rows = (await store.sql`
    select i.id, i.person, i.agent, i.state, i.received_at,
           (select min(e.at) from ledger_event e
             where e.stream = 'inbound' and e.kind = 'answered' and e.subject = i.id)
             as answered_at
    from inbound i
    where i.kind = 'human' and i.state <> 'delivered'
    order by i.received_at, i.id`) as unknown as {
    id: string;
    person: string;
    agent: string;
    state: string;
    received_at: Date | string;
    answered_at: Date | string | null;
  }[];
  return rows
    .filter((row) => mine.has(row.agent))
    .map((row) => ({
      id: row.id,
      person: row.person,
      agent: row.agent,
      state: row.state,
      received_at: new Date(row.received_at).toISOString(),
      answered_at: row.answered_at === null ? null : new Date(row.answered_at).toISOString(),
    }));
}

/**
 * The finding: a human row past its person's OWN threshold with the next
 * stamp missing.
 *
 * Pure, so the arithmetic is readable without a store, the way `staleJobs` and
 * `silentRunners` already are. A SILENT DAY IS NEVER A FINDING falls out of it
 * rather than being written: no rows, no findings.
 *
 * Rows held by an outage ARE reported. L10's Forbidden line is about what
 * reaches a PERSON in a chat, and `check` is the household's own sheet: a check
 * that went quiet during an outage is the silence this phase is named after.
 */
export function stampFindings(args: {
  rows: StampRow[];
  thresholds: (person: string) => StampThresholds;
  /** The runner entry that owes this agent's messages their stamps. */
  runnerOf: (agent: string) => string;
  machine: string;
  now: Date;
}): Finding[] {
  const out: Finding[] = [];
  for (const row of args.rows) {
    const waiting = WAITS[row.state];
    if (!waiting) continue;
    const from =
      waiting.from === "answered"
        ? row.answered_at === null
          ? null
          : Date.parse(row.answered_at)
        : Date.parse(row.received_at);
    if (from === null || Number.isNaN(from)) continue;
    const allowed = args.thresholds(row.person)[waiting.of];
    const seconds = Math.round((args.now.getTime() - from) / 1000);
    if (seconds < allowed) continue;
    out.push({
      id: findingId(args.machine, "stamp-missing", row.id),
      kind: "stamp-missing",
      subject: row.id,
      machine: args.machine,
      says:
        `${row.person} sent ${row.agent} a message ${seconds} s ago and its ${waiting.stamp} ` +
        `stamp is still missing, and ${row.person} waits ${allowed} s for that one`,
      fix:
        `read the journal of imprnt-hub-${args.runnerOf(row.agent)}, which is the unit ` +
        `that owes this message its ${waiting.stamp} stamp`,
    });
  }
  return out;
}
