import { classifyPlatformError } from "./reply.ts";
import { ADOPT_PHRASES, AGENT_PHRASES, RETIRE_PHRASES } from "./lines.ts";
import { isAgentCommand } from "../harvest/slice.ts";
import type { ChatResolution, Platform } from "./platform.ts";

/**
 * The two lifecycle verbs a person types from a phone, `adopt` and `retire`.
 *
 * The command is typed WHERE THE DOOR ALREADY LISTENS, and that is a fact about
 * both platforms rather than a preference: a Discord door reads the channels
 * the registry names it and nothing else, so a message in a chat nobody has
 * bound yet is never fetched at all, and a Telegram door drops every update
 * whose chat is not the one it serves. An adopt typed inside the new chat could
 * never arrive.
 */
export class AgentCommandRefused extends Error {
  /** One of the household's own words, which is what a person reads. */
  override readonly cause: string;
  constructor(cause: string) {
    super(`agent-command-refused: ${cause}`);
    this.name = "AgentCommandRefused";
    this.cause = cause;
  }
}

/** What a person typed, or the usage line, or not a lifecycle command at all. */
export type AgentCommand =
  | { operation: "adopt"; agent: string; ref: string }
  | { operation: "retire"; agent: string }
  | "usage"
  | null;

/**
 * PURE. It reads the phrase tables the door's own sentences are built from, so
 * the verb a person is asked to type and the verb the door takes cannot end up
 * spelled two ways.
 */
export function parseAgentCommand(text: string): AgentCommand {
  const said = String(text ?? "");
  if (!isAgentCommand(said)) return null;
  const verb = Object.values(AGENT_PHRASES)
    .find(phrase => said.slice(0, phrase.length).toLowerCase() === phrase.toLowerCase());
  if (verb === undefined) return null;
  const parts = said.slice(verb.length).trim().split(/\s+/).filter(one => one !== "");
  const [sub, agent, ref] = parts;
  if (sub === undefined || agent === undefined || agent === "") return "usage";
  const said2 = sub.toLowerCase();
  if (Object.values(ADOPT_PHRASES).some(phrase => phrase.toLowerCase() === said2)) {
    return ref === undefined || ref === "" ? "usage" : { operation: "adopt", agent, ref };
  }
  if (Object.values(RETIRE_PHRASES).some(phrase => phrase.toLowerCase() === said2)) {
    return { operation: "retire", agent };
  }
  return "usage";
}

/** A resolution, or a platform that could not be asked inside its bounds. */
export type ResolvedRef = ChatResolution | { kind: "failed"; cause: string; detail?: string };

/**
 * Resolve what a person typed through the platform's own seam, under this
 * household's delivery bounds.
 *
 * The retry is the shipped platform shape: a call that failed for a reason that
 * could pass is tried again after `door.delivery_retry_seconds`, up to
 * `door.delivery_max_attempts`, and a permanent refusal stops at once. Every
 * cause goes through `classifyPlatformError`, so a token-shaped fragment of an
 * error message never reaches a chat.
 */
export async function resolveChatRef(platform: Platform, ref: string,
  bounds: { retrySeconds: number; maxAttempts: number }): Promise<ResolvedRef> {
  if (!platform.admin) return { kind: "unsupported", cause: "unsupported on this platform" };
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await platform.admin.resolveChat(ref);
    } catch (error) {
      const failure = classifyPlatformError(error);
      if (failure.kind === "permanent" || attempt >= bounds.maxAttempts) {
        return { kind: "failed", cause: failure.cause, detail: failure.code };
      }
      await Bun.sleep(bounds.retrySeconds * 1000);
    }
  }
}
