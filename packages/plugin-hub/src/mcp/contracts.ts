/**
 * What the hub's tool facade offers a model, and how strictly it is read.
 * Pure: the facade process the engine starts imports only this file, so it
 * carries no database code and no credential of any kind.
 *
 * TWO TOOLS. `hub_topic` has the actions implemented: `inspect` (what is held and what
 * is known about it, or where one topic chat stands), `resume` (the owner's choice about
 * one interrupted attempt), and a topic chat's `create` (which only ever freezes a
 * preview), `archive`, `reopen` and `move`. `hub_council` (`council-contract.ts`) has `start`,
 * `continue`, `inspect` and `stop`. An action that is not implemented (delete, stop
 * of a topic) is not listed, and one that is asked for anyway is refused by name.
 *
 * Identity is never an argument. The person, the agent, the conversation and
 * the turn are the runner's own binding of this launch, and a schema that had a
 * field for them would be a field a model could fill.
 */

import { COUNCIL_TOOL, HUB_COUNCIL, readCouncilRequest } from "./council-contract.ts";
import { ToolError, exact, readRequestKey, readSourceIds, refuse } from "./reading.ts";

export { ToolError, exact, readRequestKey, readSourceIds, refuse, type ToolErrorCode } from "./reading.ts";
export { HUB_COUNCIL } from "./council-contract.ts";

export const HUB_TOPIC = "hub_topic";

/** The tool list, as `tools/list` returns it. */
export const TOOLS = [
  {
    name: HUB_TOPIC,
    description:
      "Inspect work in this conversation that was interrupted, record the owner's decision about one interrupted attempt, " +
      "and make, archive, reopen or move a topic chat. " +
      "inspect: lists interrupted attempts with what is known and not known about their effects; with topic_id it says where one topic chat stands. " +
      "resume: records the owner's choice for ONE attempt at the recovery revision inspect showed. It needs request_key and the platform " +
      "message ids in which the owner actually said so; continue queues a new message behind the current turn once the old attempt is " +
      "shown to be over, and keep_held authorizes nothing. Never use resume on your own initiative. " +
      "create: asks for a new topic chat. It never makes the chat: it freezes the exact preview (Chat, Execution machine, Agent and the message " +
      "the new agent will be given, verbatim) in this conversation's chat, and only the owner's green-check reaction to it creates anything. " +
      "Leave execution_machine or preset out to use the configured defaults, which the preview then shows. To correct a preview, call create " +
      "again with its topic_id and the expected_revision inspect or the last reply gave; the old preview can no longer be approved. " +
      "It needs request_key and the platform message ids in which the owner asked. initial_request is the owner's request, or a handover " +
      "of this discussion only if the owner asked to bring it over; write nothing of your own into it. " +
      "archive / reopen: the owner's explicit request, from that topic's own chat or from General, needs no confirmation and " +
      "carries request_key and source_message_ids. Archive stops the topic's agent now and moves its chat to the archive; delegated work " +
      "the owner already approved keeps running and its results wait. topic_id is a topic id, or the id of a chat's agent. " +
      "move: the owner's explicit request needs no confirmation and carries request_key and source_message_ids. It takes exactly one of " +
      "destination_machine (the machine the owner NAMED: there is no default and none is chosen for them) or move_decision. " +
      "A move gates the topic's agent; the turn already being answered finishes, nothing new is handled on the old machine, and a " +
      "destination that is offline is waited for. The owner asks for it from the topic's own chat or from General. While it waits, the " +
      "owner can type /move in that chat to see where it stands, and the exact /move withdraw <move-id> command (a bare /move withdraw only " +
      "shows the status) and the exact /move seen command that the status shows to withdraw it or to acknowledge an interruption; " +
      "General can also inspect, withdraw or continue it. " +
      "move_decision {choice: withdraw} cancels a move that has not reached activation. It is refused while a turn of that agent is still " +
      "finishing: ask again after it ended. " +
      "move_decision {choice: continue, attempt_id, expected_recovery_revision} only records that the owner saw the interruption inspect " +
      "showed under move.failure and puts the move back to waiting. It does NOT resume, release or replay the interrupted work, which stays held " +
      "and is decided separately with resume. inspect with topic_id shows where an open move stands, and what is available next.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        action: { type: "string", enum: ["inspect", "resume", "create", "archive", "reopen", "move"] },
        request_key: { type: "string", minLength: 1, maxLength: 200 },
        source_message_ids: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 10 },
        topic_id: { type: "string", minLength: 1, maxLength: 200 },
        expected_revision: { type: "integer", minimum: 0 },
        setup: {
          type: "object",
          additionalProperties: false,
          properties: {
            chat_name: { type: "string", minLength: 1, maxLength: 100 },
            execution_machine: { type: "string", minLength: 1, maxLength: 100 },
            preset: { type: "string", minLength: 1, maxLength: 100 },
            tool_profile: { type: "array", items: { type: "string", minLength: 1, maxLength: 100 }, minItems: 1, maxItems: 20 },
            initial_request: { type: "string", minLength: 1, maxLength: 8000 },
          },
          required: ["chat_name", "initial_request"],
        },
        creation_decision: {
          type: "object",
          additionalProperties: false,
          properties: {
            choice: { type: "string", enum: ["adopt", "recreate"] },
            chat: { type: "string", minLength: 1, maxLength: 100 },
          },
          required: ["choice"],
        },
        destination_machine: { type: "string", minLength: 1, maxLength: 100 },
        move_decision: {
          type: "object",
          additionalProperties: false,
          properties: {
            choice: { type: "string", enum: ["withdraw", "continue"] },
            attempt_id: { type: "string", minLength: 1, maxLength: 200 },
            expected_recovery_revision: { type: "integer", minimum: 1 },
          },
          required: ["choice"],
        },
        recovery_decision: {
          type: "object",
          additionalProperties: false,
          properties: {
            attempt_id: { type: "string" },
            expected_recovery_revision: { type: "integer", minimum: 1 },
            choice: { type: "string", enum: ["continue", "keep_held"] },
            continuation_context: { type: "string", maxLength: 4000 },
          },
          required: ["attempt_id", "expected_recovery_revision", "choice"],
        },
      },
      required: ["action"],
    },
  },
  COUNCIL_TOOL,
] as const;

export interface InspectRequest { action: "inspect"; topic_id?: string }
export interface ResumeRequest {
  action: "resume";
  request_key: string;
  source_message_ids: string[];
  recovery_decision: { attempt_id: string; expected_recovery_revision: number; choice: "continue" | "keep_held"; continuation_context?: string };
}
/** What the owner is shown and confirms: exactly these fields, and nothing a model could add. */
export interface TopicSetupRequest {
  chat_name: string;
  execution_machine?: string;
  preset?: string;
  tool_profile?: string[];
  initial_request: string;
}
export interface CreateRequest {
  action: "create";
  request_key: string;
  source_message_ids: string[];
  /** Present only to correct a preview that is still waiting, or to decide about a creation nobody could settle. */
  topic_id?: string;
  expected_revision?: number;
  setup?: TopicSetupRequest;
  creation_decision?: { choice: "adopt" | "recreate"; chat?: string };
}
/** An archive or reopen: the owner's explicit request, with no confirmation of its own. */
interface LifecycleBase {
  request_key: string;
  source_message_ids: string[];
  /** A topic id, or the id of a chat's agent. Absent, it is this conversation's own topic. */
  topic_id?: string;
  expected_revision?: number;
}
export interface ArchiveRequest extends LifecycleBase { action: "archive" }
export interface ReopenRequest extends LifecycleBase { action: "reopen" }
export type LifecycleRequest = ArchiveRequest | ReopenRequest;
/** What the owner decides about an open move: to withdraw it, or to say they saw the interruption it stopped on. */
export type MoveDecision = { choice: "withdraw" } | { choice: "continue"; attempt_id: string; expected_recovery_revision: number };
/** A move: the owner's explicit request with the machine they named, or their decision about a move that is open. Exactly one of the two. */
export interface MoveRequest extends LifecycleBase {
  action: "move";
  destination_machine?: string;
  move_decision?: MoveDecision;
}
export type HubTopicRequest = InspectRequest | ResumeRequest | CreateRequest | ArchiveRequest | ReopenRequest | MoveRequest;

/**
 * One action of `hub_topic`: the keys it takes beside `action`, and how its
 * arguments are read. Adding an action is one entry here, one in the handler table
 * of `handlers.ts`, and the schema in `TOOLS` (which is what is advertised; nothing
 * that is not listed there is offered to a model, and one that is asked for anyway
 * is refused by name).
 */
interface ActionReader<R extends HubTopicRequest> {
  keys: readonly string[];
  read(top: Record<string, unknown>): R;
}

/** A text argument: one string within its bounds, or a refusal that names it. */
function readText(value: unknown, where: string, max: number): string {
  if (typeof value !== "string" || value === "" || value.length > max) refuse(`${where} is text of 1 to ${max} characters`);
  return value as string;
}

/** The arguments an archive and a reopen share: the owner's own words as evidence, and which topic. */
function readLifecycle(top: Record<string, unknown>, action: "archive" | "reopen" | "move"): LifecycleBase & { action: typeof action } {
  const key = readRequestKey(top, action);
  const sources = readSourceIds(top, action, "the messages in which the owner asked for it");
  if (top.topic_id !== undefined) readText(top.topic_id, "topic_id", 200);
  if (top.expected_revision !== undefined && (!Number.isSafeInteger(top.expected_revision) || (top.expected_revision as number) < 0)) {
    refuse("expected_revision is a whole number, the revision the last reply or inspect showed");
  }
  return { action, request_key: key, source_message_ids: sources,
    ...(top.topic_id !== undefined ? { topic_id: top.topic_id as string } : {}),
    ...(top.expected_revision !== undefined ? { expected_revision: top.expected_revision as number } : {}) };
}

const TOPIC_ACTIONS: { [A in HubTopicRequest["action"]]: ActionReader<Extract<HubTopicRequest, { action: A }>> } = {
  inspect: {
    keys: ["topic_id"],
    read: (top) => {
      if (top.topic_id !== undefined) readText(top.topic_id, "topic_id", 200);
      return { action: "inspect", ...(top.topic_id !== undefined ? { topic_id: top.topic_id as string } : {}) };
    },
  },
  create: {
    keys: ["request_key", "source_message_ids", "topic_id", "expected_revision", "setup", "creation_decision"],
    read(top) {
      const key = readRequestKey(top, "create");
      const sources = readSourceIds(top, "create", "the messages in which the owner asked for the chat");
      const out: CreateRequest = { action: "create", request_key: key, source_message_ids: sources };
      if (top.topic_id !== undefined) out.topic_id = readText(top.topic_id, "topic_id", 200);
      if (top.expected_revision !== undefined) {
        if (!Number.isSafeInteger(top.expected_revision) || (top.expected_revision as number) < 0) refuse("expected_revision is a whole number");
        out.expected_revision = top.expected_revision as number;
      }
      if ((top.setup === undefined) === (top.creation_decision === undefined)) {
        refuse("create takes a setup (a new chat, or the correction of a preview) or a creation_decision (about a creation nobody could settle), and one of them");
      }
      if (top.setup !== undefined) {
        const setup = exact(top.setup, ["chat_name", "execution_machine", "preset", "tool_profile", "initial_request"], "setup");
        const made: TopicSetupRequest = {
          chat_name: readText(setup.chat_name, "setup.chat_name", 100),
          initial_request: readText(setup.initial_request, "setup.initial_request", 8000),
        };
        if (setup.execution_machine !== undefined) made.execution_machine = readText(setup.execution_machine, "setup.execution_machine", 100);
        if (setup.preset !== undefined) made.preset = readText(setup.preset, "setup.preset", 100);
        if (setup.tool_profile !== undefined) {
          if (!Array.isArray(setup.tool_profile) || setup.tool_profile.length < 1 || setup.tool_profile.length > 20) {
            refuse("setup.tool_profile is a list of 1 to 20 tool names");
          }
          made.tool_profile = (setup.tool_profile as unknown[]).map((one, at) => readText(one, `setup.tool_profile[${at}]`, 100));
        }
        out.setup = made;
      } else {
        if (out.topic_id === undefined) refuse("a creation_decision names the topic_id it is about");
        const decision = exact(top.creation_decision, ["choice", "chat"], "creation_decision");
        if (decision.choice !== "adopt" && decision.choice !== "recreate") refuse("choice is adopt or recreate");
        if (decision.choice === "adopt") readText(decision.chat, "creation_decision.chat", 100);
        else if (decision.chat !== undefined) refuse("recreate takes no chat");
        out.creation_decision = { choice: decision.choice, ...(decision.chat !== undefined ? { chat: decision.chat as string } : {}) };
      }
      return out;
    },
  },
  archive: {
    keys: ["request_key", "source_message_ids", "topic_id", "expected_revision"],
    read: (top) => readLifecycle(top, "archive") as ArchiveRequest,
  },
  reopen: {
    keys: ["request_key", "source_message_ids", "topic_id", "expected_revision"],
    read: (top) => readLifecycle(top, "reopen") as ReopenRequest,
  },
  move: {
    keys: ["request_key", "source_message_ids", "topic_id", "expected_revision", "destination_machine", "move_decision"],
    read(top) {
      const base = readLifecycle(top, "move");
      if ((top.destination_machine === undefined) === (top.move_decision === undefined)) {
        refuse("move takes a destination_machine (the machine the owner named, to ask for a move) or a move_decision (about a move that is open), and one of them");
      }
      const out: MoveRequest = { ...base, action: "move" };
      if (top.destination_machine !== undefined) {
        out.destination_machine = readText(top.destination_machine, "destination_machine", 100);
        return out;
      }
      const decision = exact(top.move_decision, ["choice", "attempt_id", "expected_recovery_revision"], "move_decision");
      if (decision.choice === "withdraw") {
        if (decision.attempt_id !== undefined || decision.expected_recovery_revision !== undefined) refuse("withdraw takes no attempt_id and no expected_recovery_revision");
        out.move_decision = { choice: "withdraw" };
      } else if (decision.choice === "continue") {
        // The interruption the owner was shown: the attempt and the revision inspect gave under move.failure, and nothing else.
        readText(decision.attempt_id, "move_decision.attempt_id", 200);
        if (!Number.isSafeInteger(decision.expected_recovery_revision) || (decision.expected_recovery_revision as number) < 1) {
          refuse("continue needs expected_recovery_revision, the recovery revision inspect showed under move.failure");
        }
        out.move_decision = { choice: "continue", attempt_id: decision.attempt_id as string, expected_recovery_revision: decision.expected_recovery_revision as number };
      } else {
        refuse("choice is withdraw or continue");
      }
      return out;
    },
  },
  resume: {
    keys: ["request_key", "source_message_ids", "recovery_decision"],
    read(top) {
      const key = readRequestKey(top, "resume");
      const sources = readSourceIds(top, "resume", "the messages in which the owner chose");
      const decision = exact(top.recovery_decision, ["attempt_id", "expected_recovery_revision", "choice", "continuation_context"], "recovery_decision");
      if (typeof decision.attempt_id !== "string" || decision.attempt_id === "") refuse("recovery_decision needs attempt_id");
      if (!Number.isSafeInteger(decision.expected_recovery_revision) || (decision.expected_recovery_revision as number) < 1) refuse("recovery_decision needs expected_recovery_revision");
      if (decision.choice !== "continue" && decision.choice !== "keep_held") refuse("choice is continue or keep_held");
      if (decision.continuation_context !== undefined && (typeof decision.continuation_context !== "string" || decision.continuation_context.length > 4000)) {
        refuse("continuation_context is text of at most 4000 characters");
      }
      return {
        action: "resume",
        request_key: key,
        source_message_ids: sources,
        recovery_decision: {
          attempt_id: decision.attempt_id,
          expected_recovery_revision: decision.expected_recovery_revision as number,
          choice: decision.choice,
          ...(decision.continuation_context !== undefined ? { continuation_context: decision.continuation_context as string } : {}),
        },
      };
    },
  },
};

/** Read the arguments of a `hub_topic` call, refusing anything the schema does not name. */
export function readTopicRequest(args: unknown): HubTopicRequest {
  const every = new Set(Object.values(TOPIC_ACTIONS).flatMap(one => one.keys));
  const top = exact(args, ["action", ...every], "arguments");
  const action = Object.hasOwn(TOPIC_ACTIONS, String(top.action)) ? (top.action as HubTopicRequest["action"]) : null;
  if (action === null) throw new ToolError("unsupported_action", `hub_topic has no action ${JSON.stringify(top.action)} yet`);
  exact(top, ["action", ...TOPIC_ACTIONS[action].keys], action);
  return TOPIC_ACTIONS[action].read(top);
}

/**
 * How each tool's arguments are read: a tool that is not here is `unknown_tool`,
 * before anything of its arguments is looked at. A later tool is one entry here and
 * one in the handler table.
 */
export const READERS: Record<string, (args: unknown) => { action: string }> = {
  [HUB_TOPIC]: readTopicRequest,
  [HUB_COUNCIL]: readCouncilRequest,
};

/**
 * The canonical form a request is hashed in: keys in order, the request key
 * itself left out, so the same arguments hash the same however a model spelled
 * them, and a changed argument under the same key cannot hash the same.
 */
export function canonical(request: unknown): string {
  const sort = (value: unknown): unknown => Array.isArray(value) ? value.map(sort)
    : value && typeof value === "object"
      ? Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([key]) => key !== "request_key")
          .sort(([a], [b]) => (a < b ? -1 : 1)).map(([key, inner]) => [key, sort(inner)]))
      : value;
  return JSON.stringify(sort(request));
}

/** The reply every hub tool gives, so a model reads one shape. */
export interface ToolReply {
  operation_id: string | null;
  object_id: string | null;
  revision: number | null;
  status: "awaiting_confirmation" | "accepted" | "queued" | "running" | "waiting_owner" | "stopping" | "stopped" | "complete" | "failed" | "unknown";
  stage: string;
  cause?: string;
  status_message?: string;
  next_event_id?: string;
  [extra: string]: unknown;
}
