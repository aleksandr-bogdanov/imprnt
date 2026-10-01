import type { Language } from "../door/lines.ts";
import { moveRefusalLine, moveStatusLine, moveWithdrawnNotice, seenCommand, type MoveLineFacts, type MoveRefusalKind } from "../door/move-lines.ts";
import { languageOf, listAgents, platformOf } from "../registry/entries.ts";
import type { Registry } from "../registry/load.ts";
import { resolveMoveDestination, type ResolvedDestination } from "../registry/topics.ts";
import type { StoreLike } from "../store/connect.ts";
import {
  WITHDRAWABLE_STAGES, continueMove, openMoveOfTopic, readMove, requestMove, withdrawMove, type MoveNotice, type MoveRow,
} from "../store/moves.ts";
import { attentionFor } from "../store/topic-attention.ts";
import { runnerLive, type TopicRow } from "../store/topics.ts";
import { HUB_TOPIC, type MoveRequest, type ToolReply } from "./contracts.ts";
import type { McpBinding } from "./handlers.ts";
import { lineContext, type LineContext } from "./move-general.ts";
import { moveStanding, turnReading, type MoveStanding } from "./move-standing.ts";
import { topicFor } from "./topic-actions.ts";
import { Undo, operationFor, refusal, requireMaster, runRequest } from "./requests.ts";

/**
 * The owner's `move` of a topic chat, in its three shapes: ask for a move to the machine the owner NAMED, withdraw one that is open,
 * and acknowledge the one interruption it stopped on. Each is `requireMaster` + `runRequest` + `topicFor`, as `archive` and `reopen`
 * are, so the request key, the owner's own messages as evidence and the answer that is recorded once are the helper's and not
 * repeated here. What is here is what a move request means, and what every answer of the store is said as.
 *
 * NO CONFIRMATION AND NO DEFAULT. The explicit request is the permission, and the destination is the machine the owner named: it
 * is resolved against the registry (`resolveMoveDestination`), and a machine that is not declared, or has no or several running
 * runners, is a refusal that names it. `topic_machine` is for making a chat; a move never uses it and never picks a runner.
 *
 * THE STORE DECIDES WHAT IT CAN, AND EVERY ANSWER IT GIVES IS MAPPED, with no catch-all that hides one. A reply whose status is
 * `failed` is undone as a whole by `runRequest` (the invocation, the sources it consumed and every row this wrote), exactly as
 * for `archive`: a refusal leaves nothing behind and the key is free. A reply that is not `failed` is recorded and replayed, which
 * is right for the ones that are the owner's request already being true ("already moving to that machine").
 *
 * THE CURRENT TURN FINISHES; AN OFFLINE DESTINATION IS WAITED FOR. `requestMove` places the gate in its own transaction, whether or
 * not the destination is up, and the turn already fed finishes. Nothing here retries, queues a later attempt or falls back to another
 * machine, and no reply says it will.
 *
 * NO OTHER CHAT IS NEEDED TO FOLLOW A MOVE. While a move waits its agent takes no new turn, so the moved chat cannot ask its model where
 * the move stands; the owner's own chat answers instead through the door's deterministic commands (`door/move-command.ts`: `/move`,
 * `/move withdraw <move-id>`, `/move seen <attempt> <revision>`), which call the SAME store routines through the two helpers below
 * (`withdrawOpen`, `acknowledgeOpen`) and are accepted whether or not General, the agent or its runner can run. So a move is never
 * refused for want of a General, and General can move itself.
 *
 * `continue` IS NOT `resume`. It records that the owner saw the failure it was shown (the attempt and the revision) and returns the
 * move to waiting. It releases no hold, authorizes nothing to be fed and replays nothing; the interrupted work is decided
 * separately, with `resume`, and no reply here words it as anything else.
 *
 * WITHDRAWAL NOTICES go only to the route the move was asked from, through the shared attention mechanism (`attentionFor`), and
 * only when that is not the chat the owner is withdrawing in. The notice is written in the same transaction as the withdrawal, by
 * the store, under the move's own key; nothing is sent here.
 */

/** A refusal in the one reply shape, with the person's words beside the model's when there are some. */
function refused(object: string | null, cause: string, message: string, owner?: string): ToolReply {
  return { ...refusal(object, cause, message), ...(owner === undefined ? {} : { owner_status: owner }) };
}

/** The topic a request is about, and the revision the caller said it looked at, if it said one. */
async function openTopic(tx: StoreLike, binding: McpBinding, request: MoveRequest): Promise<TopicRow> {
  const topic = await topicFor(tx, binding, request.topic_id);
  if (request.expected_revision !== undefined && request.expected_revision !== topic.lifecycle_generation) {
    throw new Undo(refused(topic.id, "stale_revision", `the topic is at revision ${topic.lifecycle_generation}, and this asked about ${request.expected_revision}`));
  }
  return topic;
}

const noOpenMove = (topic: TopicRow): ToolReply =>
  refused(topic.id, "no_open_move", "this topic has no move that is open, so there is nothing to withdraw or to decide about");

/** The route this call was made from, which is where a move is said to have been asked: the caller's own door and chat. */
function callerRoute(registry: Registry, binding: McpBinding): { door: string; chat: string } | null {
  const me = listAgents(registry).find(one => one.id === binding.agent);
  return me && me.door !== undefined && me.chat !== undefined ? { door: me.door, chat: me.chat } : null;
}

/** The facts a sentence is made from, for a move that is not (or no longer) open and so has no standing. */
function plainFacts(registry: Registry, topic: TopicRow, move: MoveRow, where: LineContext, over: Partial<MoveLineFacts>): MoveLineFacts {
  return {
    move: move.id, family: null, stage: move.stage, platform: platformOf(registry, topic.door), name: topic.display_name, agent: topic.agent_id, chat: topic.chat,
    source: move.source_machine, dest: move.dest_machine, destLive: true, sourceLive: true, finishing: false,
    withdrawable: WITHDRAWABLE_STAGES.includes(move.stage), inTopic: where.inTopic, ...over,
  };
}

/** What a refusal line is made from, and where it is said: in the topic's own chat or elsewhere, and the exact command to send again there. */
const refusalFacts = (registry: Registry, topic: TopicRow, move: MoveRow, where: LineContext, more: { requested?: string; sourceLive?: boolean; retry?: string } = {}) =>
  ({ move: move.id, platform: platformOf(registry, topic.door), name: topic.display_name, agent: topic.agent_id, chat: topic.chat, source: move.source_machine, dest: move.dest_machine,
    inTopic: where.inTopic,
    ...(more.requested === undefined ? {} : { requested: more.requested }), ...(more.sourceLive === undefined ? {} : { sourceLive: more.sourceLive }),
    ...(more.retry === undefined ? {} : { retry: more.retry }) });

/**
 * What an owned attempt of the agent is, for the refusal of a withdrawal or an answer: the store refuses both the same way for a
 * healthy turn and for one that is unresolved, and the owner is told which it is, in the same words `inspect` uses.
 */
async function ownedTurn(tx: StoreLike, move: MoveRow): Promise<{ unresolved: boolean; sourceLive: boolean }> {
  const sourceLive = await runnerLive(tx, move.source_runner);
  return { unresolved: (await turnReading(tx, move.agent, sourceLive)) === "unresolved", sourceLive };
}

// ---------------------------------------------------------------------------------------------
// ask for a move
// ---------------------------------------------------------------------------------------------

/**
 * WHAT A RECORDED MOVE IS ANSWERED WITH. The request was accepted and is on the store, and that stays true whatever the move stands on;
 * but `accepted` says nothing about progress, so a move that already stands blocked, or waits for the owner's decision, is answered
 * with that standing (the one `inspect` gives) and `recorded: true` for the request, never with a word that reads as going well. A move
 * that is only waiting keeps `accepted` and the stage the caller's own call names. This never rolls the request back: only a
 * `failed` reply does that.
 */
const standsStill = (standing: MoveStanding): boolean => standing.stage === "blocked" || standing.stage === "awaiting_owner";
const recordedAs = (standing: MoveStanding, stage: string): Pick<ToolReply, "status" | "stage"> & { recorded?: true } =>
  standsStill(standing) ? { status: standing.status, stage: standing.stage, recorded: true } : { status: "accepted", stage };

/** A move is open for this topic and the request cannot start another: the same destination is the request already being true, another is a refusal. */
async function answerOpenMove(tx: StoreLike, binding: McpBinding, topic: TopicRow, open: MoveRow, wanted: ResolvedDestination): Promise<ToolReply> {
  const registry = binding.registry();
  const where = lineContext(binding, topic);
  const standing = await moveStanding(tx, registry, topic, open, where);
  if (open.dest_runner === wanted.runner && open.dest_machine === wanted.machine) {
    return {
      operation_id: open.operation_id, object_id: topic.id, revision: topic.lifecycle_generation, ...recordedAs(standing, "already_moving"),
      ...(standing.cause === undefined ? {} : { cause: standing.cause }),
      status_message: `A move of this chat to ${open.dest_machine} is already open, and nothing new was started. ${standing.message}`,
      owner_status: standing.owner_status, move: standing.move,
    };
  }
  const withdraw = (standing.move.actions as string[]).includes("withdraw");
  const language = languageOf(registry, binding.person);
  return refused(topic.id, "move_in_progress",
    `This chat is already being moved to ${open.dest_machine}, and a move is never re-targeted: it was not changed to ${wanted.machine}. ` +
      (withdraw ? "Withdraw that move first (move_decision withdraw), and ask for the new destination once it is withdrawn. " : "It cannot be withdrawn right now, so nothing can be asked for here yet. ") +
      standing.message,
    `${moveRefusalLine(language, "other_destination", refusalFacts(registry, topic, open, where, { requested: wanted.machine }))} ${standing.owner_status}`);
}

/** The store said `in-progress` and no move of this topic is open: an archive or a reopen, or a deletion request, which are told apart. */
async function answerOtherInProgress(tx: StoreLike, topic: TopicRow): Promise<ToolReply> {
  const [open] = (await tx.sql`select kind from topic_transition where topic_id = ${topic.id} and state = 'open' order by seq desc limit 1`) as unknown as { kind: string }[];
  if (open?.kind === "archive" || open?.kind === "reopen") {
    return refused(topic.id, "transition_in_progress", `an ${open.kind} of this chat is under way, and a move is asked for only once it is done: inspect shows where it stands`);
  }
  if (open?.kind === "deletion_request") {
    return refused(topic.id, "deletion_pending", "a request to delete this chat is pending, so it is not moved: that is the owner's to settle first");
  }
  return refused(topic.id, "in_progress", "something else about this chat is already under way, and nothing was started");
}

async function ask(binding: McpBinding, request: MoveRequest): Promise<ToolReply> {
  const named = request.destination_machine!;
  return await runRequest<MoveRequest, TopicRow>(binding, {
    tool: HUB_TOPIC,
    request,
    object: request.topic_id ?? null,
    async open(tx) { return { context: await openTopic(tx, binding, request) }; },
    async apply(tx, topic, owner) {
      const registry = binding.registry();
      const wanted = resolveMoveDestination(registry, named);
      if (!wanted.ok) return refused(topic.id, wanted.code, wanted.message);
      // A move that is already open is answered before anything is measured: the request is what the store already holds, or it is another.
      const standing = await openMoveOfTopic(tx, topic.id);
      if (standing !== null) return await answerOpenMove(tx, binding, topic, standing, wanted);
      const operation = operationFor(binding, request);
      const asked = await requestMove(tx, {
        operation, topic: topic.id, destRunner: wanted.runner, destMachine: wanted.machine, by: owner.sender, route: callerRoute(registry, binding),
        evidence: { request_key: request.request_key, messages: request.source_message_ids, conversation: binding.conversation },
      });
      switch (asked.answer) {
        case "requested":
        case "replay": {
          const now = await moveStanding(tx, registry, topic, asked.move!, lineContext(binding, topic));
          return {
            operation_id: operation, object_id: topic.id, revision: topic.lifecycle_generation, ...recordedAs(now, "move_requested"),
            ...(now.cause === undefined ? {} : { cause: now.cause }),
            status_message: `Recorded. This chat's agent takes no new message on ${asked.move!.source_machine} from now: the turn already being answered finishes, and a destination that is offline is waited for, ` +
              `with nothing moved to another machine. ${now.message}`,
            owner_status: now.owner_status, move: now.move,
          };
        }
        case "in-progress": {
          const open = await openMoveOfTopic(tx, topic.id);
          return open !== null ? await answerOpenMove(tx, binding, topic, open, wanted) : await answerOtherInProgress(tx, topic);
        }
        case "same-machine":
          return refused(topic.id, "already_there", `this chat's agent already runs on ${wanted.machine} (or on the runner that serves it), so there is nothing to move`);
        case "not-active": {
          const why = topic.lifecycle === "active" ? "it has no conversation to move" : `it is ${(topic.lifecycle === "pending" ? topic.create_state : topic.lifecycle).replace(/_/g, " ")}`;
          return refused(topic.id, "not_active", `this chat cannot be moved now: ${why}`);
        }
        case "protocol-inactive":
          return refused(topic.id, "move_unavailable",
            "moving chats between machines is not switched on in this store yet: every runner has to run the version that knows moves first, and nothing was started");
        case "unknown-topic":
          return refused(topic.id, "unknown_topic", "no topic chat of this person has that id");
        default:
          return asked.answer satisfies never;
      }
    },
  });
}

// ---------------------------------------------------------------------------------------------
// withdraw
// ---------------------------------------------------------------------------------------------

interface Open { topic: TopicRow; move: MoveRow }

/**
 * The open move of the topic the request is about, and the moment the owner's words must be newer than (`sinceOf`, as the database
 * holds it: text, microseconds kept), named in the refusal as `what`. No bound when there is none to hold them to.
 */
async function openForDecision(tx: StoreLike, binding: McpBinding, request: MoveRequest, what: string,
  sinceOf: (tx: StoreLike, move: MoveRow) => Promise<string | null>): Promise<{ context: Open; since?: { at: string; what: string } }> {
  const topic = await openTopic(tx, binding, request);
  const move = await openMoveOfTopic(tx, topic.id);
  if (move === null) throw new Undo(noOpenMove(topic));
  const at = await sinceOf(tx, move);
  return { context: { topic, move }, ...(at === null ? {} : { since: { at, what } }) };
}

/** When the move was made, as the database holds it. */
async function madeAt(tx: StoreLike, move: MoveRow): Promise<string> {
  const [row] = (await tx.sql`select created_at::text as at from topic_move where id = ${move.id}`) as unknown as { at: string }[];
  return row.at;
}

/**
 * The notice that tells the owner a move was withdrawn, for the chat it was asked in, when that is not the chat they are withdrawing
 * in. Where it goes is the shared mechanism's (`attentionFor`): the route the move was asked from while it can take a line, then
 * General, and nowhere else. Null when there is nowhere to say it that is another chat: the reply this call gives is then the
 * only word of it, and no other chat is chosen.
 */
async function withdrawnNotice(tx: StoreLike, registry: Registry, person: string, topic: TopicRow, move: MoveRow, here: { door: string; chat: string } | null): Promise<MoveNotice | null> {
  const there = await attentionFor(tx, registry, { person, origin: move.route });
  if (!there.ok || (here !== null && there.route.door === here.door && there.route.chat === here.chat)) return null;
  return {
    // "This chat" is said only where the notice really lands in the topic's own chat; the fallback to General (or any other route) names the chat being moved.
    body: moveWithdrawnNotice(there.language, {
      platform: there.platform, name: topic.display_name, agent: topic.agent_id, chat: topic.chat, source: move.source_machine, dest: move.dest_machine,
      inTopic: there.route.door === topic.door && there.route.chat === topic.chat,
    }),
    person, agent: there.agent, route: there.route,
  };
}

// ---------------------------------------------------------------------------------------------
// the decisions, shared by the hub tool and by the door's own commands
// ---------------------------------------------------------------------------------------------

/**
 * WHO IS DECIDING AND WHERE: what the two decisions below need from whoever asks, whether that is the hub tool (the binding's person, the
 * owner's cited message as `by`) or the door (the allow-listed sender of the command). `evidence` is what the store records with the decision
 * for a withdrawal; for an acknowledgement it is only bounded and checked, because the routine keeps no copy of it.
 */
export interface DecisionCaller {
  registry: Registry;
  person: string;
  /** The sender the owner is recorded as. */
  by: string;
  /** The chat the decision is made from, so that the notice never goes back to it. */
  here: { door: string; chat: string } | null;
  /** The line is delivered in the topic's own chat. */
  inTopic: boolean;
  language: Language;
  evidence: Record<string, unknown>;
}

export type WithdrawOpenAnswer = "withdrawn" | "replay" | "too-late" | "turn_finishing" | "turn_unresolved" | "withdraw-invalid" | "unknown-move";

/**
 * The store's withdrawal of ONE named move and what each of its answers means for the owner. The move is the caller's, already read
 * and bound by the caller to the owner's words; nothing here reads another. `owner` is the person's words, with no marker (a caller that says
 * it as the door's adds its own) and is empty when the answer has none (`withdraw-invalid`, `unknown-move`). `noticed` is whether a notice
 * for another chat was queued with the withdrawal.
 */
export async function withdrawOpen(tx: StoreLike, caller: DecisionCaller, topic: TopicRow, move: MoveRow): Promise<{ answer: WithdrawOpenAnswer; owner: string; noticed: boolean }> {
  const notice = await withdrawnNotice(tx, caller.registry, caller.person, topic, move, caller.here);
  const answer = await withdrawMove(tx, move.id, caller.by, { route: caller.here, notice, evidence: caller.evidence });
  const where: LineContext = { inTopic: caller.inTopic };
  const refusing = (kind: MoveRefusalKind, more: { sourceLive?: boolean } = {}) => moveRefusalLine(caller.language, kind, refusalFacts(caller.registry, topic, move, where, more));
  const said = (kind: WithdrawOpenAnswer, owner: string) => ({ answer: kind, owner, noticed: notice !== null });
  switch (answer) {
    case "withdrawn":
    case "replay":
      return said(answer === "replay" ? "replay" : "withdrawn", moveStatusLine(caller.language, plainFacts(caller.registry, topic, move, where, { stage: "withdrawn" })));
    case "too-late":
      return said("too-late", refusing("too_late"));
    case "execution-unresolved": {
      // The store refuses the same way for both; the owner is told which it is. Either way nothing was recorded, nothing is retried, and nothing is released.
      const turn = await ownedTurn(tx, move);
      return turn.unresolved ? said("turn_unresolved", refusing("turn_unresolved", { sourceLive: turn.sourceLive })) : said("turn_finishing", refusing("turn_finishing"));
    }
    case "withdraw-invalid":
      return said("withdraw-invalid", "");
    case "unknown-move":
      return said("unknown-move", "");
    default:
      return answer satisfies never;
  }
}

export type AcknowledgeOpenAnswer = "waiting" | "replay" | "awaiting_owner" | "stale" | "turn_finishing" | "turn_unresolved" | "stage" | "continue-invalid" | "terminal" | "unknown-move";

/**
 * The store's acknowledgement of ONE named move's interruption, bound to the attempt and the recovery revision the owner was shown: the
 * routine answers `stale` for anything else, so a newer failure is never acknowledged by words about an older one. `standing` is the
 * move's reading after an answer that left it open (`waiting`, `replay`, `awaiting_owner`). It records that the owner SAW the interruption and
 * nothing else: no hold is released and nothing is fed or replayed.
 */
export async function acknowledgeOpen(tx: StoreLike, caller: DecisionCaller, topic: TopicRow, move: MoveRow, failure: { execution: string; revision: number }):
  Promise<{ answer: AcknowledgeOpenAnswer; owner: string; standing: MoveStanding | null }> {
  const answer = await continueMove(tx, move.id, caller.by, failure, caller.evidence);
  const where: LineContext = { inTopic: caller.inTopic };
  const retry = seenCommand(caller.language, { attempt: failure.execution, revision: failure.revision });
  const stood = async (): Promise<MoveStanding> => await moveStanding(tx, caller.registry, topic, (await readMove(tx, move.id)) ?? move, where);
  const said = (kind: AcknowledgeOpenAnswer, owner: string, standing: MoveStanding | null = null) => ({ answer: kind, owner, standing });
  switch (answer) {
    case "waiting":
    case "replay":
    case "awaiting_owner": {
      const standing = await stood();
      return said(answer, standing.owner_status, standing);
    }
    case "ownership-unresolved": {
      const turn = await ownedTurn(tx, move);
      return turn.unresolved
        ? said("turn_unresolved", moveRefusalLine(caller.language, "turn_unresolved", refusalFacts(caller.registry, topic, move, where, { sourceLive: turn.sourceLive, retry })))
        : said("turn_finishing", moveRefusalLine(caller.language, "turn_finishing", refusalFacts(caller.registry, topic, move, where, { retry })));
    }
    case "stale":
    case "stage":
    case "continue-invalid":
    case "terminal":
    case "unknown-move":
      return said(answer, "");
    default:
      return answer satisfies never;
  }
}

async function withdraw(binding: McpBinding, request: MoveRequest): Promise<ToolReply> {
  return await runRequest<MoveRequest, Open>(binding, {
    tool: HUB_TOPIC,
    request,
    object: request.topic_id ?? null,
    open: tx => openForDecision(tx, binding, request, "the move it withdraws", madeAt),
    async apply(tx, { topic, move }, owner) {
      const registry = binding.registry();
      const caller: DecisionCaller = {
        registry, person: binding.person, by: owner.sender, here: callerRoute(registry, binding), inTopic: lineContext(binding, topic).inTopic,
        language: languageOf(registry, binding.person), evidence: { request_key: request.request_key, messages: request.source_message_ids, conversation: binding.conversation },
      };
      const done = await withdrawOpen(tx, caller, topic, move);
      const base = { operation_id: move.operation_id, object_id: topic.id, revision: topic.lifecycle_generation };
      switch (done.answer) {
        case "withdrawn":
        case "replay":
          return {
            ...base, status: "complete", stage: "withdrawn",
            status_message: `Withdrawn. The move to ${move.dest_machine} is cancelled, the chat's agent handles new messages on ${move.source_machine} again, and its history is kept. ` +
              "Interrupted work, if there is any, is still held until the owner decides about it with resume: withdrawing released nothing of it. " +
              (done.noticed ? "The chat the move was asked in is told once." : "No other chat was told: this reply is the word of it."),
            owner_status: done.owner,
          };
        case "too-late":
          return refused(topic.id, "too_late",
            `The move is already past activation: it finishes on ${move.dest_machine} and cannot be withdrawn, and nothing is to be retried.`, done.owner);
        case "turn_unresolved":
          return refused(topic.id, "turn_unresolved",
            `An attempt of this chat's agent on ${move.source_machine} is unresolved (the runner lost track of it, or ${move.source_machine} is not connected), so the move cannot be withdrawn. ` +
              `Nothing was recorded and nothing is retried or released: ${move.source_machine} has to be connected and report on it first, and nothing here promises how it ends.`,
            done.owner);
        case "turn_finishing":
          return refused(topic.id, "turn_still_finishing",
            `A turn of this chat's agent on ${move.source_machine} is still finishing, so the move cannot be withdrawn this instant. Nothing was recorded and nothing is retried: ` +
              "if the owner still wants it withdrawn, ask again once that turn has ended.", done.owner);
        case "withdraw-invalid":
          return refused(topic.id, "withdraw_invalid", "the store could not take this withdrawal as asked, and nothing was recorded");
        case "unknown-move":
          return noOpenMove(topic);
        default:
          return done.answer satisfies never;
      }
    },
  });
}

// ---------------------------------------------------------------------------------------------
// continue
// ---------------------------------------------------------------------------------------------

async function acknowledge(binding: McpBinding, request: MoveRequest): Promise<ToolReply> {
  const decision = request.move_decision as { choice: "continue"; attempt_id: string; expected_recovery_revision: number };
  return await runRequest<MoveRequest, Open>(binding, {
    tool: HUB_TOPIC,
    request,
    object: decision.attempt_id,
    // The owner's words are newer than the interruption they answer: a message from before it cannot be an answer to it.
    open: tx => openForDecision(tx, binding, request, "the interruption it answers", async (_tx, move) => move.failure?.since ?? null),
    async apply(tx, { topic, move }, owner) {
      const registry = binding.registry();
      const caller: DecisionCaller = {
        registry, person: binding.person, by: owner.sender, here: callerRoute(registry, binding), inTopic: lineContext(binding, topic).inTopic,
        language: languageOf(registry, binding.person), evidence: { request_key: request.request_key, messages: request.source_message_ids, conversation: binding.conversation },
      };
      const done = await acknowledgeOpen(tx, caller, topic, move, { execution: decision.attempt_id, revision: decision.expected_recovery_revision });
      const base = { operation_id: move.operation_id, object_id: topic.id, revision: topic.lifecycle_generation };
      const NOT_RESUMED = "This recorded only that the owner saw the interruption: it did not resume, release or replay the interrupted work, which stays held and is decided separately with resume.";
      const standing = done.standing;
      switch (done.answer) {
        case "waiting":
        case "replay":
          return { ...base, status: "accepted", stage: "failure_acknowledged", ...(standing!.cause === undefined ? {} : { cause: standing!.cause }),
            status_message: `${done.answer === "replay" ? "That interruption was already acknowledged." : "Recorded."} The move is back to waiting. ${NOT_RESUMED} ${standing!.message}`,
            owner_status: standing!.owner_status, move: standing!.move };
        case "awaiting_owner":
          return { ...base, status: "waiting_owner", stage: "awaiting_owner",
            status_message: `Recorded, but another interruption now stands and the move is paused again. ${NOT_RESUMED} ${standing!.message}`,
            owner_status: standing!.owner_status, move: standing!.move };
        case "stale":
          return refused(topic.id, "stale_revision", "what the move stopped on is not the interruption that was cited: inspect the topic again, read move.failure, and ask the owner again");
        case "turn_unresolved":
          return refused(topic.id, "turn_unresolved",
            `An attempt of this chat's agent on ${move.source_machine} is unresolved (the runner lost track of it, or ${move.source_machine} is not connected), so this cannot be recorded. ` +
              `Nothing was recorded and nothing is retried or released: ${move.source_machine} has to be connected and report on it first, and nothing here promises how it ends.`,
            done.owner);
        case "turn_finishing":
          return refused(topic.id, "turn_still_finishing",
            `A turn of this chat's agent on ${move.source_machine} is still finishing, so this cannot be recorded this instant. Nothing was recorded and nothing is retried: ask again once that turn has ended.`,
            done.owner);
        case "stage":
          return refused(topic.id, "nothing_to_decide", "this move is not waiting on an interruption, so there is nothing to acknowledge");
        case "continue-invalid":
          return refused(topic.id, "continue_invalid", "the store could not take this as asked, and nothing was recorded");
        case "terminal":
        case "unknown-move":
          return noOpenMove(topic);
        default:
          return done.answer satisfies never;
      }
    },
  });
}

// ---------------------------------------------------------------------------------------------
// the action
// ---------------------------------------------------------------------------------------------

export async function moveTopic(binding: McpBinding, request: MoveRequest): Promise<ToolReply> {
  requireMaster(binding, "move a topic chat");
  const decision = request.move_decision;
  if (decision === undefined) return await ask(binding, request);
  return decision.choice === "withdraw" ? await withdraw(binding, request) : await acknowledge(binding, request);
}
