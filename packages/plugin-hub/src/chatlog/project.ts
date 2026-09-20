import { appendChatLineOnce, type BadRecord } from "../chatlog.ts";
import type { StoreLike } from "../store/connect.ts";
import type { InboundSource } from "../store/inbound.ts";

/** Readiness follows the durable file write, so a failed projection stays owed. */
export async function projectInbound(
  store: StoreLike,
  options: { stateDir: string; inboundId: string;
    accepted?: { person: string; agent: string; source: InboundSource };
    /** Skip a complete record that is not a chat line, and say where. */
    skipBad?(bad: BadRecord): void | Promise<void> },
): Promise<void> {
  // Fresh acceptance already knows the committed row. Replays read its original source.
  const row = options.accepted ? { ...options.accepted, log_ready: false } :
    (await store.sql`select person, agent, source, log_ready from inbound where id = ${options.inboundId}`)[0] as
      { person: string; agent: string; source: InboundSource | null; log_ready: boolean } | undefined;
  if (!row) throw new Error("inbound projection row missing");
  if (row.log_ready) return;
  if (!row.source) throw new Error("inbound projection source missing");
  const source = row.source;
  // The row's person, whose allowlist admitted the sender. The platform
  // username in `source.from` is display only, and harvest and the tail know a
  // speaker by registry id.
  await appendChatLineOnce({ stateDir: options.stateDir, person: row.person, agent: row.agent }, {
    id: source.log_id, at: source.at, direction: "in", from: row.person, text: source.text,
  }, { skipBad: options.skipBad });
  await store.sql`update inbound set log_ready = true where id = ${options.inboundId} and not log_ready`;
}
