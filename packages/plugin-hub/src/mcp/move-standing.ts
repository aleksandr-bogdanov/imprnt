import { moveActions, moveStatusLine, type MoveLineFacts } from "../door/move-lines.ts";
import { languageOf, platformOf } from "../registry/entries.ts";
import type { Registry } from "../registry/load.ts";
import type { StoreLike } from "../store/connect.ts";
import { WITHDRAWABLE_STAGES, type MoveRow } from "../store/moves.ts";
import { runnerLive, type TopicRow } from "../store/topics.ts";
import type { ToolReply } from "./contracts.ts";
import type { LineContext } from "./move-general.ts";
import { CLEARED_BY, moveFamilyOf } from "./move-status.ts";

/**
 * Where an open move stands, read ONCE for every surface that tells it: the hub tool's `inspect` and every reply of a move action
 * (`mcp/topic-actions.ts`, `mcp/topic-move.ts`), and the door's own `/move` command (`door/move-command.ts`). It lives here, and not in
 * the tool's file, so the door can read it without loading the tool, and so that the surfaces cannot disagree.
 */

/**
 * What the agent's owned attempts are right now, as the store's withdraw and continue see them (`hub_move_unresolved`, whose list of
 * states this repeats as a read because the tool's role does not execute it): any owned attempt refuses both, with the SAME refusal,
 * but it is not the same thing for the owner.
 *
 *  * `finishing`: a healthy turn is being answered, and it ends by itself.
 *  * `unresolved`: an attempt the runner has lost track of (`unknown`, `stop_unknown`), or any owned attempt while the source is not
 *    connected. Nothing says it ends by itself, so it is never worded as finishing; what restores the observation is the source
 *    machine being connected and reporting.
 *
 * It is a fact of THIS moment, never a promise about the next.
 */
export type TurnReading = "none" | "finishing" | "unresolved";

export async function turnReading(store: StoreLike, agent: string, sourceLive: boolean): Promise<TurnReading> {
  const [row] = await store.sql`select
    exists (select 1 from execution where agent = ${agent}
      and state in ('claimed', 'feed_intent', 'received', 'running', 'unknown', 'stop_requested', 'stop_unknown')) as owned,
    exists (select 1 from execution where agent = ${agent} and state in ('unknown', 'stop_unknown')) as lost`;
  if (row.owned !== true) return "none";
  return row.lost === true || !sourceLive ? "unresolved" : "finishing";
}

export const CHAT_STATES: Record<string, MoveLineFacts["chatState"]> = {
  active: "open", archiving: "archiving", archived: "archived", reopening: "reopening", channel_missing: "gone",
};

/** Where an open move stands, in the one reply shape: what it waits for and what the owner can really do about it. */
export interface MoveStanding {
  status: ToolReply["status"];
  stage: string;
  cause?: string;
  /** English, for the model. */
  message: string;
  /** In the person's language, with no id of an agent; the only move and attempt it names are the ones inside the exact `/move withdraw` and `/move seen` commands it offers in the topic's own chat. */
  owner_status: string;
  /** Structured, for the model: where from and to, the family, the block, and what is available now. */
  move: Record<string, unknown>;
}

/**
 * THE ONE READING OF AN OPEN MOVE. The destination wins over the source's waiting words: while a move is open the chat is waiting for
 * where it is going, and `waiting_for_machine` names that machine. Every fact is one the store holds now (the stage, the block, the failure,
 * whether a runner has a session, whether a turn is owned); nothing is inferred from a machine merely being in the registry.
 *
 * `where` is where the sentence will be said: in the topic's own chat or elsewhere. A BLOCK IS `waiting_owner` ONLY WHEN THE OWNER IS WHO
 * CAN CLEAR IT NOW: the family says who clears it (`CLEARED_BY`), and a family only the other side can clear is `queued`, whether or not a
 * withdrawal happens to be possible. The block's code is for the model's structured field and never for the owner's words.
 */
export async function moveStanding(store: StoreLike, registry: Registry, topic: TopicRow, move: MoveRow, where: LineContext): Promise<MoveStanding> {
  const destLive = await runnerLive(store, move.dest_runner);
  const sourceLive = await runnerLive(store, move.source_runner);
  const turn = await turnReading(store, move.agent, sourceLive);
  const finishing = turn === "finishing";
  const unresolved = turn === "unresolved";
  const family = move.block === null ? null : moveFamilyOf(move.block);
  const failure = move.stage === "awaiting_owner" && move.failure !== null ? { attempt: move.failure.execution, revision: move.failure.revision } : null;
  const facts: MoveLineFacts = {
    move: move.id, family, stage: move.stage, platform: platformOf(registry, topic.door), name: topic.display_name, agent: topic.agent_id, chat: topic.chat, source: move.source_machine, dest: move.dest_machine,
    destLive, sourceLive, finishing, unresolved, withdrawable: WITHDRAWABLE_STAGES.includes(move.stage), chatState: CHAT_STATES[topic.lifecycle] ?? "open",
    inTopic: where.inTopic, failure,
  };
  const actions = moveActions(facts);
  let status: ToolReply["status"];
  let stage: string;
  if (move.stage === "awaiting_owner") {
    status = "waiting_owner";
    stage = "awaiting_owner";
  } else if (family !== null) {
    const clears = CLEARED_BY[family];
    status = clears !== "side" && actions.includes(clears) ? "waiting_owner" : "queued";
    stage = "blocked";
  } else if (move.stage === "waiting") {
    status = "queued";
    stage = unresolved ? "turn_unresolved" : finishing ? "turn_finishing" : !destLive ? "waiting_for_machine" : !sourceLive ? "waiting_for_source" : "waiting_for_destination";
  } else {
    status = "running";
    stage = move.stage === "source_released" ? "handed_off" : move.stage === "importing" ? "setting_up_destination" : "switching_over";
  }
  return {
    status, stage, ...(family === null ? {} : { cause: family }),
    message: moveStatusLine("en", facts),
    owner_status: moveStatusLine(languageOf(registry, topic.person), facts),
    move: {
      from: move.source_machine, to: move.dest_machine, family, withdrawable: facts.withdrawable, turn_finishing: finishing, turn_unresolved: unresolved, actions,
      ...(move.block === null ? {} : { block: { code: move.block.code, family: family! } }),
      ...(failure !== null ? { failure: { attempt_id: failure.attempt, recovery_revision: failure.revision } } : {}),
    },
  };
}
