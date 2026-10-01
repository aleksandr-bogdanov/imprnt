import { chooseHold, contextOf, contextSentence, effectsLine, holdContextOf, type HoldOutcome } from "../recovery/holds.ts";
import type { Registry } from "../registry/load.ts";
import type { StoreLike } from "../store/connect.ts";
import { openHoldsOf } from "../store/conversations.ts";
import { HUB_COUNCIL, HUB_TOPIC, READERS, ToolError, type ArchiveRequest, type CreateRequest, type DeleteRequest, type InspectRequest, type MoveRequest, type ReopenRequest, type ResumeRequest, type ToolReply } from "./contracts.ts";
import { councilHandlers } from "./council.ts";
import { Undo, refusal, requireMaster, runRequest } from "./requests.ts";
import { archiveTopic, createTopic, deleteTopic, inspectTopic, reopenTopic } from "./topic-actions.ts";
import { moveTopic } from "./topic-move.ts";

/**
 * What a call is bound to. The runner builds it from its own launch and nothing
 * a model sends can change it: the person, the agent, the conversation and the
 * turn are facts about the process that is asking, not arguments.
 */
export interface McpBinding {
  store: StoreLike;
  person: string;
  agent: string;
  conversation: string;
  kind: "master" | "worker";
  registry(): Registry;
  /** The attempt that is running right now, when one is: recorded with the call. */
  attempt(): string | null;
}

type Handler = (binding: McpBinding, request: never) => Promise<ToolReply>;

/**
 * What each action of each tool does, beside how its arguments are read
 * (`READERS`, `TOPIC_ACTIONS` in `contracts.ts`). A handler that changes something
 * is a few lines around `runRequest`, which owns the request key, the source
 * evidence and the recorded answer; it is handed the arguments its reader accepted
 * and the runner's binding, and nothing a model said names whose call it is.
 */
const HANDLERS: Record<string, Record<string, Handler>> = {
  [HUB_TOPIC]: {
    inspect: (binding, request: InspectRequest) => request.topic_id === undefined ? inspect(binding) : inspectTopic(binding, request),
    resume: (binding, request: ResumeRequest) => resume(binding, request),
    // A topic chat's own actions live in `topic-actions.ts`, beside what a topic's request means.
    create: (binding, request: CreateRequest) => createTopic(binding, request),
    archive: (binding, request: ArchiveRequest) => archiveTopic(binding, request),
    reopen: (binding, request: ReopenRequest) => reopenTopic(binding, request),
    // A move has its own file: its request, withdrawal and acknowledgement are three branches of one action.
    move: (binding, request: MoveRequest) => moveTopic(binding, request),
    // A deletion only ever freezes its scope for the owner's check: nothing in this call erases anything.
    delete: (binding, request: DeleteRequest) => deleteTopic(binding, request),
  },
  [HUB_COUNCIL]: councilHandlers as unknown as Record<string, Handler>,
};

/** Run one call of the hub's tool. Throws a `ToolError` for anything the model is to be told by name. */
export async function callTool(binding: McpBinding, name: string, args: unknown): Promise<ToolReply> {
  const read = Object.hasOwn(READERS, name) ? READERS[name] : undefined;
  if (!read) throw new ToolError("unknown_tool", `the hub has no tool ${JSON.stringify(name)}`);
  const request = read(args);
  const handler = HANDLERS[name]?.[request.action];
  if (!handler) throw new ToolError("unsupported_action", `${name} has no action ${JSON.stringify(request.action)} yet`);
  return await (handler as (binding: McpBinding, request: unknown) => Promise<ToolReply>)(binding, request);
}

/** What is held in this conversation, and what is and is not known about it. */
async function inspect(binding: McpBinding): Promise<ToolReply> {
  const holds = await openHoldsOf(binding.store, binding.conversation);
  // The owner's messages since the oldest interruption, with the ids a choice
  // cites. A model cannot cite what it was never shown.
  const owner = holds.length === 0 ? [] : (await binding.store.sql`select id, body, received_at from inbound
    where agent = ${binding.agent} and person = ${binding.person} and kind = 'human' and source is not null
      and received_at > (select min(created_at) from replay_hold where conversation_id = ${binding.conversation} and state <> 'released')
    order by received_at desc, id desc limit 5`) as unknown as { id: string; body: string; received_at: Date }[];
  return {
    operation_id: null,
    object_id: binding.conversation,
    revision: null,
    status: "complete",
    stage: holds.length > 0 ? "held_work" : "nothing_held",
    ...(owner.length > 0 ? { owner_messages_since: owner.map(row => ({ id: row.id, text: row.body.slice(0, 300), at: row.received_at })) } : {}),
    holds: holds.map(hold => ({
      attempt_id: hold.execution_id,
      recovery_revision: hold.revision,
      cause: hold.cause,
      state: hold.state,
      known_effects: effectsLine(hold.effects),
      // The same measurement the door and `check` say, scoped to this attempt at this revision.
      native_context: { ...contextOf(hold.native_context), status_message: contextSentence(contextOf(hold.native_context)) },
      original_input: hold.body.slice(0, 600),
      ...(hold.choice ? { owner_choice: hold.choice } : {}),
    })),
  };
}

/**
 * The owner's choice about one interrupted attempt, recorded exactly once.
 *
 * SOURCE EVIDENCE is checked here and only here: each message has to exist, be
 * a message a person sent to this very agent, from a sender the person allows,
 * and be newer than the interruption it decides, and one message cannot decide
 * two different requests. That is all code can prove. It cannot prove that the
 * words mean "continue", and nothing is inserted to pretend it can: the model
 * reads what the owner said and the ids are its statement that it did.
 *
 * IDEMPOTENCY is the same transaction: the call is recorded before it is
 * applied, so a model that asks again with the same key meets its own answer,
 * and a changed argument under the same key is a conflict, not a second choice.
 */
async function resume(binding: McpBinding, request: ResumeRequest): Promise<ToolReply> {
  requireMaster(binding, "record the owner's choice");
  const decision = request.recovery_decision;
  return await runRequest(binding, {
    tool: HUB_TOPIC,
    request,
    object: decision.attempt_id,
    async open(tx) {
      // The interruption's time as text (microseconds kept): the comparison with the owner's message is made by the database.
      const [hold] = (await tx.sql`select h.revision, h.created_at::text as created_at, h.conversation_id from replay_hold h
        where h.execution_id = ${decision.attempt_id}`) as unknown as { revision: number; created_at: string; conversation_id: string }[];
      if (!hold || hold.conversation_id !== binding.conversation) throw new Undo(refusal(decision.attempt_id, "unknown_attempt", "no held attempt with that id in this conversation"));
      return { context: hold, since: { at: hold.created_at, what: "the interruption it would decide" } };
    },
    async apply(tx, _hold, owner) {
      const outcome = await chooseHold(tx, {
        attempt: decision.attempt_id, agent: binding.agent, revision: decision.expected_recovery_revision,
        choice: decision.choice, by: owner.sender,
        evidence: { source: "tool", request_key: request.request_key, messages: request.source_message_ids },
        context: decision.continuation_context,
      });
      return await replyFor(tx, decision.attempt_id, outcome, request.request_key);
    },
  });
}

/** What a recorded choice became, in the words of the one reply shape. */
async function replyFor(store: StoreLike, attempt: string, outcome: HoldOutcome, key: string): Promise<ToolReply> {
  const [hold] = (await store.sql`select revision, continuation_id from replay_hold where execution_id = ${attempt}`) as unknown as
    { revision: number; continuation_id: string | null }[];
  const base = { operation_id: key, object_id: attempt, revision: hold?.revision ?? null };
  // The choice is recorded whatever the native context is. What it is WAITING FOR is the runner's
  // measurement, or pending verification when there is none: "queued behind the current turn" is
  // said only when the context was measured usable.
  const context = outcome === "continuing" || outcome === "continue_pending" ? await holdContextOf(store, attempt) : null;
  switch (outcome) {
    case "keep_held":
      return { ...base, status: "accepted", stage: "keep_held", status_message: "Recorded. Nothing is authorized and the input stays held." };
    case "continue_pending":
      return { ...base, status: "queued", stage: "awaiting_exit_evidence",
        status_message: `Recorded. The old attempt is not shown to be over, so nothing new starts until it is.${context!.state === "ready" ? "" : ` ${contextSentence(context!)}`}`,
        ...(context!.state === "ready" ? {} : { native_context: context }) };
    case "continuing":
      if (context!.state !== "ready") {
        return { ...base, status: "accepted", stage: "waiting_native_context", ...(context!.cause ? { cause: context!.cause } : {}),
          ...(hold?.continuation_id ? { next_event_id: hold.continuation_id } : {}), native_context: context,
          status_message: `Recorded. A continuation is authorized but has not started. ${contextSentence(context!)}` };
      }
      return { ...base, status: "queued", stage: "continuation_queued", ...(hold?.continuation_id ? { next_event_id: hold.continuation_id } : {}),
        status_message: "Recorded. A continuation is queued behind the current turn." };
    case "stale-revision":
      return refusal(attempt, "stale_revision", "what is known about this attempt changed: inspect again and ask the owner again");
    case "unknown-attempt":
      return refusal(attempt, "unknown_attempt", "no held attempt with that id for this agent");
    default:
      return refusal(attempt, "closed", "this attempt is already being continued or is closed");
  }
}
