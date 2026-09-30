import { createHash } from "node:crypto";
import { chooseHold, contextOf, contextSentence, effectsLine, holdContextOf, type HoldOutcome } from "../recovery/holds.ts";
import { senderAllowed } from "../registry/entries.ts";
import type { Registry } from "../registry/load.ts";
import type { StoreLike } from "../store/connect.ts";
import { openHoldsOf } from "../store/conversations.ts";
import type { InboundSource } from "../store/inbound.ts";
import { HUB_TOPIC, ToolError, canonical, readTopicRequest, type ResumeRequest, type ToolReply } from "./contracts.ts";

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

/** A refusal that must leave nothing behind: not the invocation, not the messages it would have used. */
class Undo extends Error {
  constructor(readonly reply: ToolReply) { super("undo"); }
}

const digest = (text: string) => createHash("sha256").update(text).digest("hex");

/** Run one call of the hub's tool. Throws a `ToolError` for anything the model is to be told by name. */
export async function callTool(binding: McpBinding, name: string, args: unknown): Promise<ToolReply> {
  if (name !== HUB_TOPIC) throw new ToolError("unknown_tool", `the hub has no tool ${JSON.stringify(name)}`);
  const request = readTopicRequest(args);
  return request.action === "inspect" ? await inspect(binding) : await resume(binding, request);
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
  if (binding.kind !== "master") {
    throw new ToolError("not_owner_conversation", "only a conversation the owner talks to can record the owner's choice");
  }
  const { store } = binding;
  const hash = digest(canonical(request));
  const decision = request.recovery_decision;
  try {
    return await store.sql.begin(async (tx) => {
      const inside = { ...store, sql: tx as unknown as StoreLike["sql"] };
      const fresh = await tx`insert into tool_invocation (conversation_id, request_key, tool, action, payload_hash, execution_id)
        values (${binding.conversation}, ${request.request_key}, ${HUB_TOPIC}, 'resume', ${hash}, ${binding.attempt()})
        on conflict (conversation_id, request_key) do nothing returning request_key`;
      if (fresh.length === 0) {
        const [seen] = (await tx`select payload_hash, result from tool_invocation
          where conversation_id = ${binding.conversation} and request_key = ${request.request_key}`) as unknown as { payload_hash: string; result: ToolReply | null }[];
        if (seen.payload_hash !== hash) {
          throw new ToolError("idempotency_conflict", "this request_key was used with different arguments: use a new key for a different request");
        }
        return seen.result ?? failed(decision.attempt_id, "closed", "the earlier call under this key recorded no result");
      }
      const [hold] = (await tx`select h.revision, h.created_at, h.conversation_id from replay_hold h
        where h.execution_id = ${decision.attempt_id}`) as unknown as { revision: number; created_at: Date; conversation_id: string }[];
      if (!hold || hold.conversation_id !== binding.conversation) throw new Undo(failed(decision.attempt_id, "unknown_attempt", "no held attempt with that id in this conversation"));
      const registry = binding.registry();
      let sender = "";
      for (const id of request.source_message_ids) {
        const [row] = (await tx`select id, person, agent, kind, source, received_at from inbound where id = ${id}`) as unknown as
          { id: string; person: string; agent: string; kind: string; source: InboundSource | null; received_at: Date }[];
        if (!row || row.person !== binding.person || row.agent !== binding.agent || row.kind !== "human" || !row.source?.sender_id) {
          throw new ToolError("source_invalid", `${id} is not a message the owner sent to this agent`);
        }
        if (!senderAllowed(registry, binding.person, String(row.source.door), row.source.sender_id)) {
          throw new ToolError("source_invalid", `${id} is from a sender this person does not allow`);
        }
        if (row.received_at.getTime() <= new Date(hold.created_at).getTime()) {
          throw new ToolError("source_invalid", `${id} is older than the interruption it would decide`);
        }
        sender = sender || row.source.sender_id;
        const taken = await tx`insert into source_consumption (source_id, conversation_id, request_key, payload_hash)
          values (${id}, ${binding.conversation}, ${request.request_key}, ${hash})
          on conflict (source_id) do nothing returning source_id`;
        if (taken.length === 0) {
          const [used] = (await tx`select conversation_id, request_key from source_consumption where source_id = ${id}`) as unknown as { conversation_id: string; request_key: string }[];
          if (used.conversation_id !== binding.conversation || used.request_key !== request.request_key) {
            throw new ToolError("source_already_used", `${id} already authorized a different request`);
          }
        }
      }
      const outcome = await chooseHold(inside, {
        attempt: decision.attempt_id, agent: binding.agent, revision: decision.expected_recovery_revision,
        choice: decision.choice, by: sender,
        evidence: { source: "tool", request_key: request.request_key, messages: request.source_message_ids },
        context: decision.continuation_context,
      });
      const reply = await replyFor(inside, decision.attempt_id, outcome, request.request_key);
      if (reply.status === "failed") throw new Undo(reply);
      await tx`update tool_invocation set result = ${reply}::jsonb
        where conversation_id = ${binding.conversation} and request_key = ${request.request_key}`;
      return reply;
    });
  } catch (error) {
    if (error instanceof Undo) return error.reply;
    throw error;
  }
}

function failed(attempt: string, cause: string, message: string): ToolReply {
  return { operation_id: null, object_id: attempt, revision: null, status: "failed", stage: "refused", cause, status_message: message };
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
      return failed(attempt, "stale_revision", "what is known about this attempt changed: inspect again and ask the owner again");
    case "unknown-attempt":
      return failed(attempt, "unknown_attempt", "no held attempt with that id for this agent");
    default:
      return failed(attempt, "closed", "this attempt is already being continued or is closed");
  }
}
