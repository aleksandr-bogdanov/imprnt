import type { StoreLike } from "./connect.ts";

export interface InboundSource {
  log_id: string;
  at: string;
  door: string;
  chat: string;
  sender_id: string;
  from?: string;
  text: string;
  media?: unknown[];
  /** Present on a job row: who asked, for whom, and where the report goes. */
  dispatch?: DispatchEnvelope;
}

/**
 * What a person approved when they typed the command, and the only route a
 * report may take. `digest` is the sha256 of the task bytes, so a task rewritten
 * between the insert and the projection no longer matches what was approved.
 */
export interface DispatchEnvelope {
  dispatcher: string;
  target: string;
  approved: { by: string; at: string; digest: string; source: string };
  return: { agent: string; door: string; chat: string };
}

/**
 * A job row's own provenance. It has no platform sender of its own, and an
 * agent that has no chat has no door and no chat either, which is why these
 * three are absent where an accepted message always carries them.
 */
export interface JobSource {
  log_id: string;
  at: string;
  door?: string;
  chat?: string;
  from: string;
  text: string;
  dispatch: DispatchEnvelope;
}

export interface InboundMessage {
  source?: InboundSource | JobSource;
  log_ready?: boolean;
  id: string;
  person: string;
  agent: string;
  body: string;
  kind?: string;
}

/**
 * The id a platform message always gets, however often it is handed out. A
 * platform that redelivers after a door died mid-write hands back the same
 * triple, so the insert below meets the row it already wrote.
 */
export function inboundId(
  platform: string,
  chat: string,
  platformMessageId: string,
): string {
  return `${platform}:${chat}:${platformMessageId}`;
}

/**
 * Write the message and its first event through whatever `sql` the store
 * carries, so a caller that hands over its own transaction gets both halves
 * committed or rolled back with it. Ledger and queue are one system, which is
 * what makes that possible.
 *
 * Returns whether the row is new. Redelivery writes no second received stamp.
 * Projection still runs for an existing unready row: its earlier writer may
 * have died after this commit and before the file was durable.
 */
export async function enqueueInbound(
  store: StoreLike,
  message: InboundMessage,
): Promise<boolean> {
  const sql = store.sql;
  const written = (await sql`insert into inbound (id, person, agent, body, kind, source, log_ready)
            values (${message.id}, ${message.person}, ${message.agent},
                    ${message.body}, ${message.kind ?? "human"},
                    ${message.source ?? null}::jsonb,
                    ${message.log_ready ?? (message.source === undefined)})
            on conflict (id) do nothing
            returning id`) as unknown as { id: string }[];
  if (written.length === 0) return false;
  await sql`insert into ledger_event (stream, subject, kind, actor)
            values ('inbound', ${message.id}, 'received', 'door')`;
  return true;
}
