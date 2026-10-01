import { createHash } from "node:crypto";
import { senderAllowed } from "../registry/entries.ts";
import type { StoreLike } from "../store/connect.ts";
import { operationId } from "../store/controls.ts";
import type { InboundSource } from "../store/inbound.ts";
import { ToolError, canonical, type ToolReply } from "./contracts.ts";
import type { McpBinding } from "./handlers.ts";

/**
 * The one transaction every hub tool call that CHANGES something runs in: a
 * request key that makes it one request, the owner's own messages as evidence,
 * and an answer that is recorded once and replayed unchanged. It was the body of
 * `resume`; it is here so a council's or a topic's action is not a copy of it.
 *
 * SOURCE EVIDENCE is checked here and only here: each cited message has to exist,
 * be a message a person sent to this very agent, from a sender the person allows,
 * and be newer than what the caller says it must be newer than, and one message
 * cannot authorize two different requests. That is all code can prove. It cannot
 * prove that the words mean what the model says they mean, and nothing pretends
 * it can. A request that cites nothing (`source_message_ids` absent or empty) is
 * one whose action does not need the owner's words; whether an action may do that
 * is the action's to say, and nothing here supplies a default.
 *
 * IDEMPOTENCY is the same transaction: the call is recorded before it is applied,
 * so a model that asks again with the same key meets its own answer, and a changed
 * argument under the same key, or the same key under another tool, is a conflict,
 * not a second request. The answer, once recorded, is never recomputed.
 *
 * OPERATIONS. A key is only unique inside one conversation, and a gate or a stop
 * request is owned by an operation that is unique in the whole store. So an action
 * that places one names it with `operationFor` (the origin conversation, the key
 * of the request that started the operation, and an epoch when the same request
 * can start a second cycle), never with the bare key. A later request that has to
 * release or continue the operation has a key of its own, so it references the
 * original by what it was made from and does not derive a new one. See
 * `operationId` in `store/controls.ts` for what is guaranteed.
 *
 * A REFUSAL LEAVES NOTHING BEHIND. Anything thrown out of the transaction (a
 * `ToolError`, an `Undo`, a database error) rolls back the invocation and every
 * source it consumed together, so a request that did not happen does not spend the
 * owner's message and does not occupy its key.
 *
 * Identity is never an argument: the person, the agent, the conversation and the
 * turn come from `McpBinding`, which the runner built from its own launch.
 */

/** A refusal that must leave nothing behind: not the invocation, not the messages it would have used. */
export class Undo extends Error {
  constructor(readonly reply: ToolReply) { super("undo"); }
}

export const digest = (text: string) => createHash("sha256").update(text).digest("hex");

/**
 * The store-wide operation a request starts: this call's conversation and key, and
 * `epoch` for a repeat cycle the same request can authorize. Persist it (or what it
 * is made of) with the domain object, and hand the SAME id to the request that
 * releases or continues the operation: a release has a key of its own and must not
 * derive its id from it.
 */
export function operationFor(binding: Pick<McpBinding, "conversation">, request: Pick<RequestLike, "request_key">, epoch?: number): string {
  return operationId({ conversation: binding.conversation, request: request.request_key, ...(epoch === undefined ? {} : { epoch }) });
}

/** A reply that says the request was refused, in the one reply shape. */
export function refusal(object: string | null, cause: string, message: string): ToolReply {
  return { operation_id: null, object_id: object, revision: null, status: "failed", stage: "refused", cause, status_message: message };
}

/** Only a conversation the owner talks to can act on the owner's behalf; a worker's cannot. */
export function requireMaster(binding: McpBinding, doing: string): void {
  if (binding.kind !== "master") throw new ToolError("not_owner_conversation", `only a conversation the owner talks to can ${doing}`);
}

/**
 * The moment a cited message must be newer than, and what to call it in the refusal. The comparison is made BY THE DATABASE, so a moment is
 * compared as PostgreSQL holds it: a string is a `timestamptz` read as text in the same transaction (`col::text`), microseconds included. A JS
 * `Date` keeps milliseconds only, and a message written microseconds after the news it must follow is in the same millisecond as it: read as a
 * `Date`, it looks equal and is refused as not newer. A caller that has the moment from a row passes it as text; a `Date` is only for a
 * moment that really is one (a clock read in code).
 */
export interface Since { at: Date | string; what: string }

/** What every request that changes something carries. Its arguments were read strictly by the tool's reader. */
export interface RequestLike {
  action: string;
  request_key: string;
  source_message_ids?: readonly string[];
}

export interface RequestPlan<R extends RequestLike, Context> {
  tool: string;
  request: R;
  /** What a reply the helper gives on its own is about (the attempt, the council). */
  object: string | null;
  /**
   * First inside the transaction, after the key is claimed and before any source is
   * read: look up what the request is about. Throw `new Undo(reply)` to refuse it
   * with a reply and leave nothing behind. `since` is the newest time a cited
   * message may not be older than, and `what` names it in the refusal; leave it out
   * when the action sets no such bound.
   */
  open?(tx: StoreLike): Promise<{ context: Context; since?: Since }>;
  /**
   * Apply the request, in the same transaction. `owner.sender` is the sender of the
   * first cited message, or "" when none was cited, and `owner.door` is the door that
   * message was read on ("" likewise): a sender id means something only on that door.
   * Both are the stored message's and were checked above, never an argument of the call.
   * A reply whose status is "failed" is undone as a whole: nothing it wrote is kept and
   * the key is free.
   */
  apply(tx: StoreLike, context: Context, owner: { sender: string; door: string }): Promise<ToolReply>;
}

export async function runRequest<R extends RequestLike, Context = undefined>(binding: McpBinding, plan: RequestPlan<R, Context>): Promise<ToolReply> {
  const { store } = binding;
  const { request } = plan;
  const hash = digest(canonical(request));
  try {
    return await store.sql.begin(async (tx) => {
      const inside = { ...store, sql: tx as unknown as StoreLike["sql"] };
      const fresh = await tx`insert into tool_invocation (conversation_id, request_key, tool, action, payload_hash, execution_id)
        values (${binding.conversation}, ${request.request_key}, ${plan.tool}, ${request.action}, ${hash}, ${binding.attempt()})
        on conflict (conversation_id, request_key) do nothing returning request_key`;
      if (fresh.length === 0) {
        const [seen] = (await tx`select tool, payload_hash, result from tool_invocation
          where conversation_id = ${binding.conversation} and request_key = ${request.request_key}`) as unknown as { tool: string; payload_hash: string; result: ToolReply | null }[];
        // The hash covers the request and not the tool that took it, so two tools whose
        // requests have the same shape (an action and a key) would otherwise be one request:
        // the second would be told the first one's answer and its own would never run. The
        // tool is compared beside the hash, and the recorded hash is not changed, so what a
        // tool already recorded is replayed as it was.
        if (seen.tool !== plan.tool) {
          throw new ToolError("idempotency_conflict", "this request_key was used by another tool: use a new key for a different request");
        }
        if (seen.payload_hash !== hash) {
          throw new ToolError("idempotency_conflict", "this request_key was used with different arguments: use a new key for a different request");
        }
        return seen.result ?? refusal(plan.object, "closed", "the earlier call under this key recorded no result");
      }
      const opened: { context: Context; since?: Since } = plan.open ? await plan.open(inside) : { context: undefined as Context };
      const registry = binding.registry();
      // The bound as the database will compare it: text for a moment read from a row (microseconds kept), an ISO string for a `Date`. Null: no bound.
      const bound = opened.since === undefined ? null : typeof opened.since.at === "string" ? opened.since.at : opened.since.at.toISOString();
      let sender = "";
      let door = "";
      for (const id of request.source_message_ids ?? []) {
        const [row] = (await tx`select id, person, agent, kind, source, received_at <= ${bound}::timestamptz as not_newer from inbound where id = ${id}`) as unknown as
          { id: string; person: string; agent: string; kind: string; source: InboundSource | null; not_newer: boolean | null }[];
        if (!row || row.person !== binding.person || row.agent !== binding.agent || row.kind !== "human" || !row.source?.sender_id) {
          throw new ToolError("source_invalid", `${id} is not a message the owner sent to this agent`);
        }
        if (!senderAllowed(registry, binding.person, String(row.source.door), row.source.sender_id)) {
          throw new ToolError("source_invalid", `${id} is from a sender this person does not allow`);
        }
        if (opened.since && row.not_newer !== false) {
          throw new ToolError("source_invalid", `${id} is older than ${opened.since.what}`);
        }
        if (sender === "") door = String(row.source.door);
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
      const reply = await plan.apply(inside, opened.context, { sender, door });
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
