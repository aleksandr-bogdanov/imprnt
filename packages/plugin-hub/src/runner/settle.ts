import type { StoreLike } from "../store/connect.ts";
import { appendEntry } from "../records/diary.ts";
import { stamp } from "../records/stamps.ts";
import { appendChunks } from "../store/outbox.ts";
import type { Price } from "../registry/presets.ts";

/** What one turn cost and what it ran under. Every turn writes one. */
export interface TurnRecord {
  agent: string;
  runner: string;
  preset: string;
  preset_id: string;
  preset_settings: Record<string, string>;
  input_tokens: number | null;
  cached_input_tokens: number | null;
  output_tokens: number | null;
  price: Price | null;
  plan_usage: Record<string, unknown> | null;
  raw_usage: Record<string, unknown>;
  session_id: string | null;
  lacks: string[];
  tail: boolean;
}

/**
 * The end of a turn, in ONE transaction: every chunk of the reply, the answered
 * stamp, the turn record, and the claim released.
 *
 * All of it or none of it. A settle split in two leaves a reply on disk that
 * the redo would write again, and the chunk insert is also what notifies the
 * door, so the door hears about a reply exactly when the whole of it is there.
 */
export async function settleTurn(
  store: StoreLike,
  turn: { inboundId: string; chunks: string[]; turn: TurnRecord },
): Promise<void> {
  await store.sql.begin(async (tx) => {
    const inside = { ...store, sql: tx as unknown as StoreLike["sql"] };
    await appendChunks(inside, turn.inboundId, turn.chunks);
    await stamp(inside, {
      messageId: turn.inboundId,
      kind: "answered",
      actor: "runner",
    });
    await appendEntry(inside, {
      stream: "turn",
      subject: turn.inboundId,
      kind: "turn",
      actor: "runner",
      detail: turn.turn as unknown as Record<string, unknown>,
    });
    await tx`update inbound set claimed_by = null, claim_deadline = null
             where id = ${turn.inboundId}`;
  });
}
