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

function refuse(message: string): never {
  throw new ToolError("invalid_arguments", message);
}

function exact(value: unknown, allowed: readonly string[], where: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) refuse(`${where} must be an object`);
  const record = value as Record<string, unknown>;
  const extra = Object.keys(record).filter(key => !allowed.includes(key));
  if (extra.length > 0) refuse(`${where} does not take: ${extra.join(", ")}`);
  return record;
}

/** Read the arguments of a `hub_topic` call, refusing anything the schema does not name. */
export function readTopicRequest(args: unknown): HubTopicRequest {
  const top = exact(args, ["action", "request_key", "source_message_ids", "recovery_decision"], "arguments");
  if (top.action === "inspect") {
    exact(top, ["action"], "inspect");
    return { action: "inspect" };
  }
  if (top.action !== "resume") throw new ToolError("unsupported_action", `hub_topic has no action ${JSON.stringify(top.action)} yet`);
  const key = top.request_key;
  if (typeof key !== "string" || key === "" || key.length > 200) refuse("resume needs a request_key");
  const sources = top.source_message_ids;
  if (!Array.isArray(sources) || sources.length < 1 || sources.length > 10 || sources.some(one => typeof one !== "string" || one === "")) {
    refuse("resume needs source_message_ids: the messages in which the owner chose");
  }
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
    source_message_ids: [...new Set(sources as string[])].sort(),
    recovery_decision: {
      attempt_id: decision.attempt_id,
      expected_recovery_revision: decision.expected_recovery_revision as number,
      choice: decision.choice,
      ...(decision.continuation_context !== undefined ? { continuation_context: decision.continuation_context as string } : {}),
    },
  };
}

/**
 * The canonical form a request is hashed in: keys in order, the request key
 * itself left out, so the same arguments hash the same however a model spelled
 * them, and a changed argument under the same key cannot hash the same.
 */
export function canonical(request: HubTopicRequest): string {
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
  status: "accepted" | "queued" | "waiting_owner" | "complete" | "failed";
  stage: string;
  cause?: string;
  status_message?: string;
  next_event_id?: string;
  [extra: string]: unknown;
}
