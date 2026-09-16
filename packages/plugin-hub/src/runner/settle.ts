import type { StoreLike } from "../store/connect.ts";
import { appendEntry } from "../records/diary.ts";
import { stamp } from "../records/stamps.ts";
import { appendChunks } from "../store/outbox.ts";
import { clearProgress } from "./progress.ts";
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
    // D-124. The open turn's progress row goes with the settle, inside the one
    // transaction, so the door never edits a line about a turn that has ended.
    await clearProgress(inside, turn.inboundId);
    await tx`update inbound set claimed_by = null, claim_deadline = null
             where id = ${turn.inboundId}`;
  });
}

/**
 * The end of a turn the loop REFUSED, in one transaction: no chunk, no
 * `answered` stamp, one diary line saying why, and the row released onto a
 * recorded retry.
 *
 * D-121. Nothing new is needed and saying so is what stops this looking like
 * machinery: `retry_at` is already a column, `hub_runner` already holds the
 * grant on it, `claimNext` and `readEligible` already honour it, and
 * `untilNextDeadline` already wakes a waiting runner on it. A window hold is
 * the same path with the window's own reset in place of the fixed interval.
 *
 * The person sees NOTHING of this. What they see is one notice per outage,
 * which is the runner's own arithmetic and not this transaction's.
 */
export async function refuseTurn(
  store: StoreLike,
  refusal: {
    inboundId: string;
    runner: string;
    agent: string;
    cause: string;
    said: string;
    retryAt: string;
  },
): Promise<void> {
  await store.sql.begin(async (tx) => {
    const inside = { ...store, sql: tx as unknown as StoreLike["sql"] };
    await appendEntry(inside, {
      stream: "refusal",
      subject: refusal.inboundId,
      kind: "refused.outage",
      actor: "runner",
      detail: {
        agent: refusal.agent,
        runner: refusal.runner,
        cause: refusal.cause,
        said: refusal.said,
        retry_at: refusal.retryAt,
      },
    });
    await clearProgress(inside, refusal.inboundId);
    await tx`update inbound
                set claimed_by = null, claim_deadline = null, retry_at = ${refusal.retryAt}
              where id = ${refusal.inboundId}`;
  });
}
