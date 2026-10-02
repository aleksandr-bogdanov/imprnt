import type { StoreLike } from "../store/connect.ts";

/**
 * What an owner may do about an interrupted attempt, and the words a model is
 * given about it. One handler serves the door's deterministic command and the
 * hub's own tool, so the two cannot disagree about what a choice means.
 */

/** fresh_context discards native context only by explicit owner choice; it never continues unfinished work. */
export const HOLD_CHOICES = ["continue", "keep_held", "fresh_context"] as const;
export type HoldChoiceName = (typeof HOLD_CHOICES)[number];

/**
 * What became of a choice. `continue_pending` is a choice recorded and not yet
 * acted on: the attempt is not shown to be over, so no continuation exists.
 */
export type HoldOutcome =
  | "keep_held" | "continue_pending" | "continuing" | "fresh_context" | "ownership-unresolved"
  | "stale-revision" | "unknown-attempt" | "closed" | "invalid-choice";

/**
 * Whether a held conversation can take a turn on a native context that resumes
 * without replaying what the interrupted attempt left unfinished, as the runner
 * last MEASURED it for that attempt at that revision. `pending` is "not measured
 * (yet) on the engine that is running now" and is never worded as available.
 */
export interface NativeContext {
  state: "ready" | "unavailable" | "pending";
  /** Why it is unavailable: one of `CONTEXT_CAUSES`. */
  cause?: string;
  /** The engine and configuration it was measured on. */
  engine?: string;
  at?: string;
}

/** Every reason a conversation cannot be resumed, named once and worded by each surface. */
export const CONTEXT_CAUSES = ["safe-resume-unvalidated", "no-native-session-recorded", "native-state-uncertain"] as const;

/** The stored value as a status. Anything that is not a well-formed measurement is pending, not ready. */
export function contextOf(raw: unknown): NativeContext {
  const one = (raw ?? null) as Partial<NativeContext> | null;
  if (one && one.state === "ready") return { state: "ready", ...(typeof one.engine === "string" ? { engine: one.engine } : {}), ...(typeof one.at === "string" ? { at: one.at } : {}) };
  if (one && one.state === "unavailable" && typeof one.cause === "string" && (CONTEXT_CAUSES as readonly string[]).includes(one.cause)) {
    return { state: "unavailable", cause: one.cause, ...(typeof one.engine === "string" ? { engine: one.engine } : {}), ...(typeof one.at === "string" ? { at: one.at } : {}) };
  }
  return { state: "pending" };
}

const CONTEXT_WHY: Record<string, string> = {
  "safe-resume-unvalidated": "this engine build has not been shown to resume an interrupted session without replaying unfinished work",
  "no-native-session-recorded": "no engine session was recorded for the interrupted attempt",
  "native-state-uncertain": "the engine never acknowledged this conversation's session, so it cannot be trusted to resume",
};

/**
 * The same fact for the hub's tool and for `check`: what the conversation is
 * waiting for. It never says a continuation is "queued behind the current turn"
 * unless the runner measured that the turn can run, and it says pending
 * verification when nothing was measured.
 */
export function contextSentence(context: NativeContext): string {
  if (context.state === "unavailable") {
    return `The conversation is waiting for native context (${context.cause}: ${CONTEXT_WHY[context.cause ?? ""] ?? "unavailable"}). No executor is started, for a new message or for a continuation, until it is available; nothing is rebuilt automatically. The owner can explicitly choose fresh_context after confirmed process exit to discard native context and allow fresh messages without continuing unfinished work.`;
  }
  if (context.state === "pending") {
    return "Whether the native context can be resumed is pending verification. No executor is started until it has been checked.";
  }
  return "The native context was measured usable, so a turn can start once the old attempt is shown to be over.";
}

/** What an attempt's hold says about its native context right now, or pending when it has no hold. */
export async function holdContextOf(store: StoreLike, attempt: string): Promise<NativeContext> {
  const [hold] = (await store.sql`select native_context from replay_hold where execution_id = ${attempt}`) as unknown as { native_context: unknown }[];
  return contextOf(hold?.native_context);
}

/** What is known about an attempt's effects, in a sentence. Never more than was counted. */
export function effectsLine(effects: Record<string, unknown>): string {
  const actions = Number(effects.actions ?? 0);
  const last = typeof effects.lastAction === "string" && effects.lastAction !== "" ? effects.lastAction : null;
  if (!Number.isFinite(actions) || actions <= 0) {
    return "No tool action was observed before it stopped. That does not prove it changed nothing.";
  }
  return `${actions} tool action${actions === 1 ? " was" : "s were"} started before it stopped` +
    `${last ? `, the last of them ${last}` : ""}. Whether each finished is unknown, and none of it was undone.`;
}

/**
 * The input of the NEW attempt an owner's `continue` queues. The old input is
 * not fed again: the new one says what happened, what is known and unknown, and
 * hands the assignment back for the model to verify before it repeats anything.
 */
export function continuationBody(hold: { cause: string; original: string; effects: Record<string, unknown> }, context?: string): string {
  return [
    `An earlier attempt at the assignment below was interrupted (${hold.cause}) before it finished. The owner has chosen to continue it.`,
    effectsLine(hold.effects),
    "Check the current state of the work before you repeat anything: what that attempt did is still in effect.",
    ...(context && context.trim() !== "" ? ["The owner adds:", context.trim()] : []),
    "The assignment, as it was given:",
    "---",
    hold.original,
    "---",
  ].join("\n");
}

/**
 * What a fresh turn of a conversation with a held assignment is told first.
 * It is context, and it forbids the one thing a model is most inclined to do:
 * carry on with the unfinished assignment because it is there.
 */
export function recoveryContext(hold: { execution_id: string; cause: string; revision: number; body: string; effects: Record<string, unknown> }): string {
  return [
    `[Hub recovery context] An earlier attempt on this conversation (${hold.execution_id}) was interrupted (${hold.cause}).`,
    effectsLine(hold.effects),
    "The input it was working on is held. Do NOT continue that assignment now and do not repeat any of its actions on your own.",
    "If the owner asks what happened, explain what is known and what is not. The assignment continues only if the owner chooses that with the recovery command, and then it arrives as a new message.",
    "The held input:",
    "---",
    hold.body,
    "---",
    "The owner's message follows.",
  ].join("\n");
}

/**
 * Record an owner's choice about one attempt at one recovery revision.
 *
 * The composition of the continuation is done here, from what the hold and its
 * attempt hold NOW, and the store function does the rest under a row lock:
 * a choice made against a revision that has moved is refused by the function
 * and not by this code, so two clients cannot both be right.
 */
export async function chooseHold(
  store: StoreLike,
  choice: { attempt: string; agent: string; revision: number; choice: HoldChoiceName; by: string; evidence: Record<string, unknown>; context?: string },
): Promise<HoldOutcome> {
  let body: string | null = null;
  if (choice.choice === "continue") {
    const [hold] = (await store.sql`select h.cause, i.body as original, e.effects
      from replay_hold h join inbound i on i.id = h.inbound_id join execution e on e.id = h.execution_id
      where h.execution_id = ${choice.attempt} and e.agent = ${choice.agent}`) as unknown as { cause: string; original: string; effects: Record<string, unknown> }[];
    if (!hold) return "unknown-attempt";
    body = continuationBody(hold, choice.context);
  }
  const [answer] = (await store.sql`select hub_hold_choice(${choice.attempt}, ${choice.agent}, ${choice.revision}::integer,
      ${choice.choice}, ${choice.by}, ${choice.evidence}::jsonb, ${body}) as outcome`) as unknown as { outcome: HoldOutcome }[];
  return answer.outcome;
}
