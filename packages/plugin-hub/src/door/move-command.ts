import { languageOf, platformOf } from "../registry/entries.ts";
import type { Registry } from "../registry/load.ts";
import { isMoveCommand } from "../harvest/slice.ts";
import { acknowledgeOpen, withdrawOpen, type DecisionCaller } from "../mcp/topic-move.ts";
import { moveStanding } from "../mcp/move-standing.ts";
import { claimRow } from "../records/statesheet.ts";
import type { StoreLike } from "../store/connect.ts";
import { openMoveOfAgent, readMove, type MoveRow } from "../store/moves.ts";
import { readTopicByAgent } from "../store/topics.ts";
import { MACHINERY_LINES, type Language } from "./lines.ts";
import { moveDoorRefusalLine, moveSeenLine, moveWithdrawnNotice, type MoveDoorKind } from "./move-lines.ts";

/**
 * THE OWNER'S MOVE COMMANDS, READ BY THE DOOR: `/move` (where it stands), `/move withdraw <move-id>`, and `/move seen <attempt> <revision>` (or
 * `/перенос`, `/перенос отозвать <move-id>`, `/перенос принято`). They are the path that answers while the agent is gated, so they are accepted whether
 * or not General, the agent or its runner can run, exactly as `/recover <agent> <attempt> <revision> continue` is: the sender is already
 * allow-listed on this door and the chat is the agent's own (`acceptBatch`), the message is never made an inbound row, so it is never given to
 * the model and never replayed, and the decision is the SAME store routine the hub tool calls (`withdrawOpen`, `acknowledgeOpen`).
 *
 * A COMMAND THAT CHANGES A MOVE IS BOUND, BY A RECEIPT, TO WHAT IT WAS ABOUT. The door never asks "what is open now" of a message it has
 * already taken. The first time a `withdraw` or `seen` message is taken, a receipt is written under the message's own identity (the agent and
 * the message id, which is stable across redeliveries) BEFORE anything is applied or refused. It holds who sent it (person, door, chat,
 * sender), the platform's time, the parsed command, and what it is about: the id of the one move it acts on, or an explicit no-target (nothing
 * was open, the message is not newer than the open move, or the move it names is not this chat's); and, for `seen`, the interruption it was
 * actually shown (attempt, revision and the `since` the store holds for it), or none. Every later delivery reads that receipt and nothing else
 * to choose its target; a receipt whose person or payload is not the message's own is refused, never taken as a new choice.
 *
 * A WITHDRAWAL NAMES ITS MOVE. `/move withdraw <move-id>` carries the immutable id of the one move it is about, shown to the owner by the status
 * and by every refusal that says to send it again, so no message ever chooses a move by what happens to be open, or by how its time compares,
 * when it is first taken: a delayed message about move A cannot reach move B, whenever and however it is delivered. The bare `/move withdraw`
 * changes nothing: it is read as `/move`, which says where the move stands and shows the exact command. The id is never trusted for what it
 * names: the move must be a move of THIS agent, person and chat (the ones the message was accepted for), or the message is bound to no move.
 * A receipt written before the id was part of the command has a command of another shape, so it is not the message's own and is refused.
 *  - THE BINDING IS ITS OWN TRANSACTION, COMMITTED BEFORE THE ACTION. A crash between the two leaves a receipt and no action, and the next delivery
 *    acts on the bound target only. Two deliveries claiming at once meet the one primary key (`records/statesheet.ts` `claimRow`): one writes,
 *    the other is handed what it wrote.
 *  - THE ACTION AND ITS RESULT ARE ONE TRANSACTION. It takes the receipt's row first (so deliveries of one message act one at a time), reads
 *    the result row, and otherwise calls the store routine on the bound move and, when the store applied it (or answered `replay`: the move
 *    was already there, whoever did it), writes the result row in the same commit. A delivery that finds the result answers from it and
 *    touches nothing. A refusal that is only about the moment (a turn still finishing) writes no result and keeps the receipt, so the same
 *    words work on the same move once the cause is gone; a different move, or a different intent, is never picked up by it.
 *  - `status` changes nothing and has no receipt: it reads whatever is open.
 *
 * THE TIME OF THE MESSAGE IS EVIDENCE ABOUT WHAT IT WAS WRITTEN AFTER, NOT THE BINDING OF A WITHDRAWAL (that is the id it names). An
 * acknowledgement, which names no move, that is not newer than the open move it would
 * bind to (compared by the database at the precision it holds, nothing parsed or truncated here) binds to no move. An acknowledgement of an
 * interruption has to be strictly newer than that interruption's `since`, compared by the database in full precision, as the hub tool's is:
 * words from before the owner was shown the interruption are not an answer to it, whenever they are delivered.
 *
 * `seen` NAMES THE ATTEMPT AND THE REVISION THE OWNER WAS SHOWN, as `/recover` does, and the receipt binds the failure that actually stood when
 * the message was first taken. A message taken when no such interruption stood (nothing to acknowledge, or another interruption) is bound to
 * none, and an interruption that appears later is never acknowledged by it. The store still acknowledges exactly that attempt and revision of
 * exactly that move at the moment of the mutation and answers `stale` for any other. An interruption that was already acknowledged is
 * answered as a harmless read (`replay`, or `superseded` when the move now stands on another). No bare `seen` exists.
 *
 * WHAT IS KEPT, AND WHAT IS NOT CLEANED: two state sheets, `move_command` (the receipt, written once and never changed) and `move_command_done`
 * (the result, written once), one row of each at most per command message taken from an allow-listed sender, a few hundred bytes. They are
 * not removed: a receipt has to outlive its move to keep an old message from reaching a newer one.
 *
 * The reply is written once per OUTCOME CLASS (`key`): a redelivery that reaches the same class says nothing again, and a command that was
 * refused first and applied later says the new thing.
 */

/** A move's id as the owner is shown it in a command: one word of ordinary identifier characters (the store's ids are UUIDs). */
const MOVE_ID = /^[A-Za-z0-9._:-]{1,200}$/;

export type MoveCommand = { verb: "status" } | { verb: "withdraw"; move: string } | { verb: "seen"; attempt: string; revision: number };

/**
 * Pure. `null` is not this command, `"usage"` is this command spelled wrong. The verb is at the very start, in any case, as `/recover` is
 * (the same rule `isMoveCommand` gives the chat log); a move id and an attempt are one word of ordinary identifier characters and the revision is
 * a positive integer. A bare `withdraw` is the status reading, never a withdrawal: only a command that names its move can change one.
 */
export function parseMoveCommand(text: string): MoveCommand | "usage" | null {
  if (!isMoveCommand(text)) return null;
  const parts = String(text).trim().split(/\s+/);
  if (parts.length === 1) return { verb: "status" };
  const word = parts[1].toLowerCase();
  if (word === "withdraw" || word === "отозвать") {
    if (parts.length === 2) return { verb: "status" };
    return parts.length === 3 && MOVE_ID.test(parts[2]) ? { verb: "withdraw", move: parts[2] } : "usage";
  }
  if (word === "seen" || word === "принято") {
    if (parts.length !== 4 || !/^[A-Za-z0-9._:-]{1,200}$/.test(parts[2]) || !/^[1-9]\d{0,8}$/.test(parts[3])) return "usage";
    return { verb: "seen", attempt: parts[2], revision: Number(parts[3]) };
  }
  return "usage";
}

/** The platform's own time as an ISO 8601 instant with a zone: the only shape handed to the database, which parses it. */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

/** Whether the message was sent after the move was made, compared by the database at the precision it holds. A time that cannot be read is not after. */
async function sentAfter(store: StoreLike, move: string, at: string): Promise<boolean> {
  if (!ISO_INSTANT.test(at)) return false;
  const [row] = (await store.sql`select ${at}::timestamptz > created_at as newer from topic_move where id = ${move}`) as unknown as { newer: boolean | null }[];
  return row?.newer === true;
}

/** Whether the message was sent strictly after an instant the database stored (`since`, text with its microseconds), compared by the database. A time that cannot be read is not after. */
async function sentAfterInstant(store: StoreLike, at: string, since: string): Promise<boolean> {
  if (!ISO_INSTANT.test(at)) return false;
  const [row] = (await store.sql`select ${at}::timestamptz > ${since}::timestamptz as newer`) as unknown as { newer: boolean | null }[];
  return row?.newer === true;
}

export interface MoveCommandRequest {
  registry: Registry;
  person: string;
  door: string;
  chat: string;
  /** The agent whose own chat the command was typed in. */
  agent: string;
  /** The allow-listed sender on this door: who the decision is recorded as. */
  sender: string;
  /** The command message's id in the chat log: stable across redeliveries. */
  message: string;
  /** The platform's own time for the message, ISO 8601. */
  at: string;
  command: MoveCommand | "usage";
}

export interface MoveCommandAnswer {
  /** The words, marked as the door's. */
  text: string;
  /** The class of outcome: what a redelivery must not say twice. */
  key: string;
}

/** The commands that change a move, and so have a receipt. */
type DecidingCommand = Exclude<MoveCommand, { verb: "status" }>;

/** The interruption a `seen` message was shown, as the store held it when the message was first taken. */
interface BoundFailure { execution: string; revision: number; since: string }

/** What the message is about: one move, or explicitly none (`why`). `failure` is only ever set for `seen`, and only for an interruption that stood. */
interface Target { move: string | null; why: "none" | "older_message" | "other_move" | null; failure: BoundFailure | null }

/** The immutable receipt of one command message. */
interface Receipt {
  person: string;
  agent: string;
  door: string;
  chat: string;
  sender: string;
  at: string;
  command: DecidingCommand;
  target: Target;
}

/** What the store did for a message, written in the commit that did it. */
interface Result { answer: "withdrawn" | "seen"; move: string }

export const MOVE_COMMAND_SHEET = "move_command";
export const MOVE_COMMAND_DONE_SHEET = "move_command_done";

/** The agent and the message, as one unambiguous string whatever either contains. */
const receiptKey = (agent: string, message: string): string => JSON.stringify([agent, message]);

const wordsOf = (command: DecidingCommand): string => (command.verb === "seen" ? `seen ${command.attempt} ${command.revision}` : `withdraw ${command.move}`);

/**
 * Whether a receipt is this very message: the same person, place, sender, time and command, the move a withdrawal names included. A withdrawal
 * receipt that does not carry the move its words named (one written before the id was part of the command) or whose target is another move than
 * the one named is never the message's own, so nothing is applied for it.
 */
const sameMessage = (receipt: Receipt, request: MoveCommandRequest, command: DecidingCommand): boolean =>
  receipt.person === request.person && receipt.agent === request.agent && receipt.door === request.door && receipt.chat === request.chat
  && receipt.sender === request.sender && receipt.at === request.at && wordsOf(receipt.command) === wordsOf(command)
  && (receipt.command.verb !== "withdraw" || (typeof receipt.command.move === "string" && (receipt.target.move === null || receipt.target.move === receipt.command.move)));

const inside = (store: StoreLike, sql: unknown): StoreLike => ({ ...store, sql: sql as StoreLike["sql"] });

/**
 * What a message taken now is about: read once, when the receipt is written, and never again. A withdrawal is about the move it NAMES, if that
 * is a move of this agent, person and chat (the ones the message was accepted for) and of nothing else: what is open now, and the time of the
 * message, take no part in it. Any other id, whoever's it is or whether it exists at all, is bound to no move, and is answered the same way.
 */
async function targetOf(tx: StoreLike, request: MoveCommandRequest, command: DecidingCommand): Promise<Target> {
  if (command.verb === "withdraw") {
    const named = await readMove(tx, command.move);
    const topic = named === null ? null : await readTopicByAgent(tx, request.agent);
    const theirs = named !== null && topic !== null && named.agent === request.agent && named.person === request.person && named.topic_id === topic.id
      && topic.person === request.person && topic.door === request.door && topic.chat === request.chat;
    return theirs ? { move: command.move, why: null, failure: null } : { move: null, why: "other_move", failure: null };
  }
  const move = await openMoveOfAgent(tx, request.agent);
  if (move === null) return { move: null, why: "none", failure: null };
  if (!(await sentAfter(tx, move.id, request.at))) return { move: null, why: "older_message", failure: null };
  const stands = command.verb === "seen" && move.stage === "awaiting_owner" && move.failure !== null
    && move.failure.execution === command.attempt && move.failure.revision === command.revision;
  return { move: move.id, why: null, failure: stands && move.failure !== null ? { execution: move.failure.execution, revision: move.failure.revision, since: String(move.failure.since) } : null };
}

/**
 * THE BINDING: one transaction, committed before anything is applied or refused. The first delivery writes the receipt; a later one, or the
 * loser of two at once, is handed the one that was written. `"conflict"`: the receipt under this message's identity is not this message's own
 * (another person, place, sender, time or command), so nothing is applied for it.
 */
export async function bindMoveCommand(store: StoreLike, request: MoveCommandRequest, command: DecidingCommand): Promise<Receipt | "conflict"> {
  const key = receiptKey(request.agent, request.message);
  return await store.sql.begin(async sql => {
    const tx = inside(store, sql);
    const [found] = (await tx.sql`select data from state_row where sheet = ${MOVE_COMMAND_SHEET} and id = ${key}`) as unknown as { data: Receipt }[];
    let receipt = found?.data;
    if (receipt === undefined) {
      const data: Receipt = { person: request.person, agent: request.agent, door: request.door, chat: request.chat, sender: request.sender, at: request.at,
        command, target: await targetOf(tx, request, command) };
      receipt = (await claimRow(tx, MOVE_COMMAND_SHEET, key, data as unknown as Record<string, unknown>)).data as unknown as Receipt;
    }
    return sameMessage(receipt, request, command) ? receipt : "conflict";
  });
}

export async function answerMoveCommand(store: StoreLike, request: MoveCommandRequest): Promise<MoveCommandAnswer> {
  const language = languageOf(request.registry, request.person);
  const refuse = (kind: MoveDoorKind): MoveCommandAnswer => ({ text: moveDoorRefusalLine(language, kind), key: kind });
  if (request.command === "usage") return refuse("usage");
  const command = request.command;

  // A withdrawal that names no move is a reading, whatever shape it arrives in: nothing here chooses a move for a message.
  if (command.verb === "status" || (command.verb === "withdraw" && typeof command.move !== "string")) {
    // A reading changes nothing and binds nothing: it is about whatever is open now.
    return await store.sql.begin(async sql => {
      const tx = inside(store, sql);
      const move = await openMoveOfAgent(tx, request.agent);
      const topic = move === null ? null : await readTopicByAgent(tx, request.agent);
      if (move === null || topic === null) return refuse("none");
      const standing = await moveStanding(tx, request.registry, topic, move, { inTopic: true });
      return { text: `${MACHINERY_LINES[language]} ${standing.owner_status}`, key: "status" };
    });
  }

  const receipt = await bindMoveCommand(store, request, command);
  if (receipt === "conflict") return refuse("message_conflict");
  return await actOn(store, request, command, receipt, language);
}

/** THE ACTION: one transaction for the store's change, the result and what is read to say it, on the move the receipt names and no other. */
async function actOn(store: StoreLike, request: MoveCommandRequest, command: DecidingCommand, receipt: Receipt, language: Language): Promise<MoveCommandAnswer> {
  const refuse = (kind: MoveDoorKind): MoveCommandAnswer => ({ text: moveDoorRefusalLine(language, kind), key: kind });
  const key = receiptKey(request.agent, request.message);
  return await store.sql.begin(async sql => {
    const tx = inside(store, sql);
    // Deliveries of one message act one at a time: whoever comes second finds what the first committed.
    await tx.sql`select 1 from state_row where sheet = ${MOVE_COMMAND_SHEET} and id = ${key} for update`;
    const [stored] = (await tx.sql`select data from state_row where sheet = ${MOVE_COMMAND_DONE_SHEET} and id = ${key}`) as unknown as { data: Result }[];
    const marked = (words: string): string => `${MACHINERY_LINES[language]} ${words}`;
    /** Written in the commit of the change it records, and only for a change that was made (or found already made). */
    const applied = async (answer: Result["answer"], move: MoveRow): Promise<void> => {
      await tx.sql`insert into state_row (sheet, id, data) values (${MOVE_COMMAND_DONE_SHEET}, ${key}, ${{ answer, move: move.id } satisfies Result})
                   on conflict (sheet, id) do nothing`;
    };

    const bound = stored?.data.move ?? receipt.target.move;
    if (bound === null) return refuse(receipt.target.why ?? "none");
    const move = await readMove(tx, bound);
    const topic = move === null ? null : await readTopicByAgent(tx, move.agent);
    if (move === null || topic === null || topic.id !== move.topic_id) return refuse("none");

    if (stored !== undefined) {
      if (stored.data.answer === "withdrawn") return await withdrawnAnswer(tx, request, language, move);
      // What was recorded is not recorded again: the move is shown as it stands, and nothing is asked of the store.
      const standing = move.stage === "active" || move.stage === "withdrawn" ? "" : (await moveStanding(tx, request.registry, topic, move, { inTopic: true })).owner_status;
      return { text: moveSeenLine(language, move.stage === "awaiting_owner" ? "superseded" : "replay", standing).trim(), key: "seen" };
    }

    const here = { door: request.door, chat: request.chat };
    const caller: DecisionCaller = {
      registry: request.registry, person: request.person, by: request.sender, here, inTopic: true, language,
      evidence: { source: "chat-command", message: request.message, door: request.door, chat: request.chat, sent_at: request.at },
    };

    if (command.verb === "withdraw") {
      const result = await withdrawOpen(tx, caller, topic, move);
      switch (result.answer) {
        case "withdrawn":
        case "replay":
          // `replay` is a withdrawal made by another message in the meantime: this one is accounted for all the same, on the move it was about.
          await applied("withdrawn", move);
          return await withdrawnAnswer(tx, request, language, move);
        case "too-late":
        case "turn_finishing":
        case "turn_unresolved":
          return { text: marked(result.owner), key: result.answer };
        case "withdraw-invalid":
        case "unknown-move":
          return refuse(result.answer === "unknown-move" ? "none" : "usage");
        default:
          return result.answer satisfies never;
      }
    }

    // `seen`: only the interruption the receipt was bound to, and only if the move still stands on exactly it. The one that was already
    // acknowledged is a read: it is said as the replay it is, or as superseded when the move now stands on another.
    const failure = { execution: command.attempt, revision: command.revision };
    const same = (one: { execution: string; revision: number }): boolean => one.execution === failure.execution && one.revision === failure.revision;
    const already = move.acknowledged_failures.some(same);
    const standsOn = move.stage === "awaiting_owner" && move.failure !== null && same(move.failure);
    if (already && !standsOn) {
      if (move.stage === "awaiting_owner") {
        const standing = await moveStanding(tx, request.registry, topic, move, { inTopic: true });
        return { text: moveSeenLine(language, "superseded", standing.owner_status), key: "seen" };
      }
      // The store answers `replay` for it before it looks at anything else, and writes nothing.
      const replay = await acknowledgeOpen(tx, caller, topic, move, failure);
      return replay.answer === "replay" ? { text: moveSeenLine(language, "replay", replay.owner), key: "seen" } : refuse("other_interruption");
    }
    if (move.stage === "active" || move.stage === "withdrawn") return refuse("none");
    // The receipt holds the interruption the message was shown when it was taken. Having seen none, or another, is no permission to answer a later one.
    const shown = receipt.target.failure;
    if (shown === null || !standsOn || move.failure === null || String(move.failure.since) !== shown.since || !same(shown)) {
      return refuse(move.stage === "awaiting_owner" ? "other_interruption" : "nothing_to_acknowledge");
    }
    // Words from before the interruption was there are not an answer to it, however late they are delivered.
    if (!(await sentAfterInstant(tx, request.at, shown.since))) return refuse("before_interruption");
    const result = await acknowledgeOpen(tx, caller, topic, move, failure);
    switch (result.answer) {
      case "waiting":
      case "replay":
      case "awaiting_owner":
        await applied("seen", move);
        return { text: moveSeenLine(language, result.answer, result.owner), key: "seen" };
      case "turn_finishing":
      case "turn_unresolved":
        return { text: marked(result.owner), key: result.answer };
      case "stale":
        return refuse("other_interruption");
      case "stage":
        return refuse("nothing_to_acknowledge");
      case "terminal":
      case "unknown-move":
        return refuse("none");
      case "continue-invalid":
        return refuse("usage");
      default:
        return result.answer satisfies never;
    }
  });
}

/** What a withdrawn move is told as: the door's own line, the chat as "this chat", and where the held messages are now answered. */
async function withdrawnAnswer(tx: StoreLike, request: MoveCommandRequest, language: Language, move: MoveRow): Promise<MoveCommandAnswer> {
  const topic = await readTopicByAgent(tx, move.agent);
  return {
    text: moveWithdrawnNotice(language, {
      platform: platformOf(request.registry, topic?.door ?? request.door), name: topic?.display_name ?? "", agent: move.agent, chat: topic?.chat ?? request.chat,
      source: move.source_machine, dest: move.dest_machine, inTopic: true,
    }),
    key: "withdrawn",
  };
}
