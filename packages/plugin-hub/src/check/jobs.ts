import type { StampThresholds } from "../registry/entries.ts";
import type { StoreLike } from "../store/connect.ts";
import { findingId, type Finding } from "./finding.ts";

/**
 * A dispatched job that has not been answered yet.
 *
 * A job is a row on the one queue, so whether it came back is a question about
 * the queue and about nothing else: its `answered` stamp is the runner's own
 * word that the job ran and its report landed, and a refused job is settled
 * `answered` too, so a refusal never becomes a permanent finding.
 */
export interface OpenJobRow {
  id: string;
  agent: string;
  person: string;
  received_at: Date;
}

/**
 * The open jobs of the agents this machine runs, in one statement.
 *
 * Only this machine's own agents, which is the set the stamp finding already
 * uses, so two machines running `check` never both report one job.
 */
export async function readOpenJobs(
  store: StoreLike,
  where: { agents: string[] },
): Promise<OpenJobRow[]> {
  const mine = new Set(where.agents);
  const rows = (await store.sql`
    select id, agent, person, received_at from inbound
    where kind = 'job' and state not in ('answered', 'delivered')
    order by received_at, id`) as unknown as OpenJobRow[];
  return rows
    .filter((row) => mine.has(row.agent))
    .map((row) => ({ ...row, received_at: new Date(row.received_at) }));
}

/**
 * A job older than its person's own answered threshold plus the household's
 * grace is a finding keyed on the JOB ROW, and it clears by the row leaving
 * the reader's answer once the job is answered.
 *
 * The grace is `hub.job_grace_seconds`, the one grace setting this household
 * has, which the scheduled jobs already read. Pure, so the arithmetic is
 * readable without a store or a clock.
 */
export function staleDispatchJobs(args: {
  jobs: OpenJobRow[];
  thresholds: (person: string) => StampThresholds;
  /** The runner entry that owes this agent its work. */
  runnerOf: (agent: string) => string;
  graceSeconds: number;
  machine: string;
  now: Date;
}): Finding[] {
  const out: Finding[] = [];
  for (const job of args.jobs) {
    const allowed = args.thresholds(job.person).answered_seconds;
    const age = Math.floor((args.now.getTime() - job.received_at.getTime()) / 1000);
    const lateBy = age - (allowed + args.graceSeconds);
    if (lateBy <= 0) continue;
    out.push({
      id: findingId(args.machine, "job-stale", job.id),
      kind: "job-stale",
      subject: job.id,
      machine: args.machine,
      says:
        `${job.id} was dispatched to ${job.agent} ${age} seconds ago and has not been answered, ` +
        `which is ${lateBy} seconds past ${job.person}'s own ${allowed} second answered ` +
        `threshold plus the ${args.graceSeconds} second grace`,
      fix:
        `read the journal of imprnt-hub-${args.runnerOf(job.agent)}, which is the unit that ` +
        `owes this job its report, and start it if it is stopped`,
    });
  }
  return out;
}
