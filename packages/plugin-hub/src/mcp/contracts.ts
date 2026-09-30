/**
 * What the hub's tool facade offers a model, and how strictly it is read.
 * Pure: the facade process the engine starts imports only this file, so it
 * carries no database code and no credential of any kind.
 *
 * ONE TOOL SO FAR, `hub_topic`, and only the two actions this slice implements:
 * `inspect` (what is held and what is known about it) and `resume` (the owner's
 * choice about one interrupted attempt). A later slice adds actions to the same
 * tool and a second tool beside it; an action that is not implemented is not
 * listed, and one that is asked for anyway is refused by name.
 *
 * Identity is never an argument. The person, the agent, the conversation and
 * the turn are the runner's own binding of this launch, and a schema that had a
 * field for them would be a field a model could fill.
 */

export type ToolErrorCode =
  | "invalid_arguments" | "unknown_tool" | "unsupported_action"
  | "idempotency_conflict" | "source_invalid" | "source_already_used"
  | "unknown_attempt" | "stale_revision" | "closed" | "not_owner_conversation";

/** An error the model is told by name, with what to do next. */
export class ToolError extends Error {
  constructor(readonly code: ToolErrorCode, message: string) {
    super(message);
    this.name = "ToolError";
  }
}

export const HUB_TOPIC = "hub_topic";

/** The tool list, as `tools/list` returns it. */
export const TOOLS = [
  {
    name: HUB_TOPIC,
    description:
      "Inspect work in this conversation that was interrupted, or record the owner's decision about one interrupted attempt. " +
      "inspect: lists interrupted attempts with what is known and not known about their effects. " +
      "resume: records the owner's choice for ONE attempt at the recovery revision inspect showed. It needs request_key and the platform " +
      "message ids in which the owner actually said so; continue queues a new message behind the current turn once the old attempt is " +
      "shown to be over, and keep_held authorizes nothing. Never use resume on your own initiative.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        action: { type: "string", enum: ["inspect", "resume"] },
        request_key: { type: "string", minLength: 1, maxLength: 200 },
        source_message_ids: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 10 },
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
] as const;

export interface InspectRequest { action: "inspect" }
export interface ResumeRequest {
  action: "resume";
  request_key: string;
  source_message_ids: string[];
  recovery_decision: { attempt_id: string; expected_recovery_revision: number; choice: "continue" | "keep_held"; continuation_context?: string };
}
export type HubTopicRequest = InspectRequest | ResumeRequest;

/** The refusal every reader below gives: named `invalid_arguments`, and it says what was wrong. */
export function refuse(message: string): never {
  throw new ToolError("invalid_arguments", message);
}

/** An object that carries only the keys it may: any other key is refused, so no field a model could fill exists unless the schema names it. */
export function exact(value: unknown, allowed: readonly string[], where: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) refuse(`${where} must be an object`);
  const record = value as Record<string, unknown>;
  const extra = Object.keys(record).filter(key => !allowed.includes(key));
  if (extra.length > 0) refuse(`${where} does not take: ${extra.join(", ")}`);
  return record;
}

/** The `request_key` of a call that changes something: the caller's own idempotency, scoped to the conversation that made it. */
export function readRequestKey(top: Record<string, unknown>, action: string): string {
  const key = top.request_key;
  if (typeof key !== "string" || key === "" || key.length > 200) refuse(`${action} needs a request_key`);
  return key;
}

/** The platform message ids a call cites as its evidence: one to ten, each a non-empty string, deduplicated and in order. */
export function readSourceIds(top: Record<string, unknown>, action: string, why: string): string[] {
  const sources = top.source_message_ids;
  if (!Array.isArray(sources) || sources.length < 1 || sources.length > 10 || sources.some(one => typeof one !== "string" || one === "")) {
    refuse(`${action} needs source_message_ids: ${why}`);
  }
  return [...new Set(sources as string[])].sort();
}

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

const TOPIC_ACTIONS: { [A in HubTopicRequest["action"]]: ActionReader<Extract<HubTopicRequest, { action: A }>> } = {
  inspect: {
    keys: [],
    read: () => ({ action: "inspect" }),
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
  status: "accepted" | "queued" | "waiting_owner" | "stopping" | "stopped" | "complete" | "failed" | "unknown";
  stage: string;
  cause?: string;
  status_message?: string;
  next_event_id?: string;
  [extra: string]: unknown;
}
