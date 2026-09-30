/**
 * How every hub tool reads what a model sent, and the error it is told by name. Pure, with no
 * database code: the facade process the engine starts imports `contracts.ts`, which imports this.
 *
 * It is separate from `contracts.ts` only so a tool's own reader (`council-contract.ts`) and the
 * list of tools (`contracts.ts`) can each import it without importing one another.
 */

export type ToolErrorCode =
  | "invalid_arguments" | "unknown_tool" | "unsupported_action"
  | "idempotency_conflict" | "source_invalid" | "source_already_used"
  | "unknown_attempt" | "stale_revision" | "closed" | "not_owner_conversation"
  | "unknown_council" | "unknown_participant" | "unsupported_override" | "invalid_roster" | "not_allowed";

/** An error the model is told by name, with what to do next. */
export class ToolError extends Error {
  constructor(readonly code: ToolErrorCode, message: string) {
    super(message);
    this.name = "ToolError";
  }
}

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
