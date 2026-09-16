import type { StoreLike } from "../store/connect.ts";
import { HARVEST_SHEET } from "../harvest/sheet.ts";
import { appendEntry } from "../records/diary.ts";
import { stamp } from "../records/stamps.ts";
import { putRow } from "../records/statesheet.ts";
import { appendChunks } from "../store/outbox.ts";
import { clearProgress } from "./progress.ts";
import type { Price } from "../registry/presets.ts";

/**
 * D-157. What a HARVEST turn did, beside what it cost.
 *
 * Criterion 2 is one query over this object and `preset_id`, so every field it
 * asks for is here: the bounds the door fixed, why it fired, how many lines the
 * runner really read from the sheet's own watermark, what filed, what
 * conflicted, and where the staged notes are for a human to read.
 */
export interface HarvestRecord {
  from: string | null;
  until: string;
  reason: string;
  lines: number;
  /** `<folder>/<slug>` per note that FILED or was a no-op. */
  notes: string[];
  /** `<folder>/<slug>` per note the vault already held with different text. */
  conflicts: string[];
  /** The staging directory, whether or not anything is still in it. */
  staged: string;
}

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
  /**
   * D-157. Spread onto the record ONLY on a harvest turn, exactly the way
   * phase 4's optional fields are and for the same shipped reason:
   * `test/turn-record.test.ts` and `test/chatlog.test.ts` read this object, and
   * a record that always carried an eighth key would turn them red for a
   * feature their agent never uses.
   */
  harvest?: HarvestRecord;
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
 * D-154. The end of a HARVEST turn, in ONE transaction: the `answered` stamp,
 * the turn record, the watermark when one is owed, and the claim released.
 *
 * A sibling of `refuseTurn` rather than an option on `settleTurn`, because
 * `settleTurn`'s signature is what nine shipped checks sit on and because what
 * a harvest settles is genuinely different: **no chunk**, since a harvest reply
 * is not a reply to anybody and its text never reaches a chat, and **no
 * progress row**, since none was ever written (D-155).
 *
 * THE WATERMARK LANDS WITH THE SETTLE OR NOT AT ALL, which is the whole of
 * HARV-02 read from this end. The order the caller works in is the other half:
 * stage every note, apply them in order and read each outcome, append the
 * report line, and only then settle. A watermark committed in a transaction of
 * its own before this one is a watermark that outlives a crash the filing did
 * not survive.
 *
 * `watermark` is null when nothing was harvested: an empty slice, or a turn the
 * runner is settling because this person names no harvester any more. No row is
 * a record of nothing, which is a different fact from a harvest that found
 * nothing worth keeping.
 */
export async function settleHarvest(
  store: StoreLike,
  settle: {
    inboundId: string;
    turn: TurnRecord;
    watermark: { id: string; data: Record<string, unknown> } | null;
  },
): Promise<void> {
  await store.sql.begin(async (tx) => {
    const inside = { ...store, sql: tx as unknown as StoreLike["sql"] };
    await stamp(inside, {
      messageId: settle.inboundId,
      kind: "answered",
      actor: "runner",
    });
    await appendEntry(inside, {
      stream: "turn",
      subject: settle.inboundId,
      kind: "turn",
      actor: "runner",
      detail: settle.turn as unknown as Record<string, unknown>,
    });
    if (settle.watermark) {
      await putRow(inside, HARVEST_SHEET, settle.watermark.id, settle.watermark.data);
    }
    await tx`update inbound set claimed_by = null, claim_deadline = null
             where id = ${settle.inboundId}`;
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
    /**
     * D-156. Which refusal this is. `refused.harvest` is the one a household
     * reading its own diary needs to tell a dead login from a note the vault
     * would not take, and `ledger_event_runner_turn` already permits it: that
     * policy constrains the STREAM and not the kind, so no schema object
     * changes. Absent means the outage this function was written for.
     */
    kind?: string;
  },
): Promise<void> {
  await store.sql.begin(async (tx) => {
    const inside = { ...store, sql: tx as unknown as StoreLike["sql"] };
    await appendEntry(inside, {
      stream: "refusal",
      subject: refusal.inboundId,
      kind: refusal.kind ?? "refused.outage",
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
