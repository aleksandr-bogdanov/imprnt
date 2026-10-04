import { VALIDATED_ORDINARY_PROFILES } from "../adapters/claude-code.ts";
import { ORDINARY_PROFILE } from "../adapters/opencode-config.ts";
import type { StoreLike } from "../store/connect.ts";

/**
 * What an agent that names no tools is launched with, read off the very
 * constants each launch takes it from, so the page and the launch cannot list
 * two different sets.
 *
 *   claude-code  the installed build's validated ordinary profile
 *                (`VALIDATED_ORDINARY_PROFILES`); a build with none refuses the
 *                launch by name. Every validated build is printed when they
 *                differ, because the board does not know which build a runner
 *                has installed.
 *   opencode     `ORDINARY_PROFILE`, the explicit list it is always given.
 *   codex        no list at all: the launch refuses a configured one, and the
 *                engine's own tools run inside the box.
 *
 * Null for an adapter whose default this build does not know, which the page
 * says rather than inventing a list.
 */
export type DefaultTools = { list: string } | { words: string } | null;

export function defaultTools(adapter: string): DefaultTools {
  if (adapter === "claude-code") {
    const builds = Object.entries(VALIDATED_ORDINARY_PROFILES);
    if (builds.length === 0) return { words: "none: this build validated no default list, and the launch is refused" };
    const lists = [...new Set(builds.map(([, tools]) => tools.join(", ")))];
    return lists.length === 1
      ? { list: lists[0] }
      : { list: builds.map(([build, tools]) => `claude ${build}: ${tools.join(", ")}`).join("; ") };
  }
  if (adapter === "opencode") return { list: ORDINARY_PROFILE.join(", ") };
  if (adapter === "codex") return { words: "codex's own tools inside the box; a list cannot be set" };
  return null;
}

/**
 * What the store can say about another machine's declared entries, which is
 * all the board on this machine can say about them.
 *
 * THE BOARD CALLS NO OTHER MACHINE. It has no seam for one, and asking a remote
 * service manager would be a second channel to that box beside the hub's. What
 * it has is the one store every machine writes to, and in it two facts that
 * are true now or carry their own time:
 *
 *   connected   the server's own client list holds a session under the name
 *               that entry's process connects with. It is the look the door's
 *               waiting line takes for a runner. It says a process is
 *               connected, never that it is healthy, and a scheduled piece is
 *               connected only while it runs.
 *   started_at  for a runner, when its current incarnation registered, which
 *               the runner writes once at every start.
 *
 * The memory sample and the findings are read from their own sheets by the
 * page's other readers. NO FINDING IS NOT "RUNNING": a machine whose `check`
 * has not run, or whose hub is down, writes no finding either, so the page never
 * turns an absence into a state.
 *
 * One statement for every remote entry on the page, and none when there is none.
 */

export interface RemoteFact {
  connected: boolean;
  started_at: string | null;
}

/** The name an entry's process connects to the store with: the hub's is per machine, every other is its id. */
export function applicationOf(entry: { id: string; kind: string; machine: string }): string {
  return entry.kind === "hub" ? `hub-${entry.machine}` : entry.id;
}

export async function readRemoteFacts(
  store: StoreLike,
  entries: { id: string; kind: string; machine: string }[],
): Promise<Record<string, RemoteFact>> {
  if (entries.length === 0) return {};
  const asked = entries.map((entry) => ({ id: entry.id, app: applicationOf(entry) }));
  const rows = (await store.sql`
    select e.id,
           exists (select 1 from pg_stat_activity a
                    where a.datname = current_database() and a.application_name = e.app) as connected,
           (select r.started_at from runner_incarnation r where r.runner = e.id) as started_at
    from jsonb_to_recordset(${JSON.stringify(asked)}::text::jsonb) as e(id text, app text)`) as unknown as
    { id: string; connected: boolean; started_at: Date | string | null }[];
  const out: Record<string, RemoteFact> = {};
  for (const row of rows) {
    const when = row.started_at === null ? null : new Date(row.started_at);
    out[row.id] = {
      connected: Boolean(row.connected),
      started_at: when !== null && Number.isFinite(when.getTime()) ? when.toISOString() : null,
    };
  }
  return out;
}

/**
 * The owner's approvals, per chat: how many confirmations wait for the owner's
 * reaction now, and when the last one was approved. One statement, counts and a
 * time only: no payload, no preview and no text leaves the table.
 */
export async function readApprovals(store: StoreLike): Promise<Record<string, { pending: number; approved_at: string | null }>> {
  const rows = (await store.sql`
    select door, chat,
           count(*) filter (where state = 'pending')::int as pending,
           max(approved_at) as approved_at
    from confirmation
    group by door, chat`) as unknown as { door: string; chat: string; pending: number; approved_at: Date | string | null }[];
  const out: Record<string, { pending: number; approved_at: string | null }> = {};
  for (const row of rows) {
    const when = row.approved_at === null ? null : new Date(row.approved_at);
    out[`${row.door}/${row.chat}`] = {
      pending: Number(row.pending),
      approved_at: when !== null && Number.isFinite(when.getTime()) ? when.toISOString() : null,
    };
  }
  return out;
}
