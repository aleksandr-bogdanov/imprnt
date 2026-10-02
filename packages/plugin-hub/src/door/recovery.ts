import { senderAllowed, listAgents } from "../registry/entries.ts";
import type { Registry } from "../registry/load.ts";
import { chooseHold, type HoldChoiceName, type HoldOutcome } from "../recovery/holds.ts";
import type { StoreLike } from "../store/connect.ts";

/**
 * `/recover <agent> <attempt> <revision> continue|keep-held|fresh-context`: an owner's choice
 * about ONE interrupted attempt of ONE agent, at the recovery revision the
 * notice named. `/recover <agent>` alone is the plumbing restart and is read
 * elsewhere: it restarts a session and never touches a hold.
 *
 * Pure. `null` is not this command (a different token count), `"usage"` is
 * this command spelled wrong.
 */
export function parseHoldChoice(text: string): { agent: string; attempt: string; revision: number; choice: HoldChoiceName } | "usage" | null {
  const parts = String(text ?? "").trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [, agent, attempt, revision, word] = parts;
  const said = word.toLowerCase();
  const choice: HoldChoiceName | null = ["continue", "продолжить"].includes(said) ? "continue"
    : ["fresh-context", "fresh_context"].includes(said) ? "fresh_context"
    : ["keep-held", "keep_held", "keephold", "оставить"].includes(said) ? "keep_held" : null;
  if (choice === null || !/^[1-9]\d{0,8}$/.test(revision)) return "usage";
  return { agent, attempt, revision: Number(revision), choice };
}

/** Every way the door refuses this command carries one name, so it says nothing about which agents exist. */
export class HoldChoiceRefused extends Error {
  constructor() {
    super("recovery-not-authorized");
    this.name = "HoldChoiceRefused";
  }
}

/**
 * Record the choice, from the door and with no runner involved, so it is
 * accepted even when the agent it is about cannot run. The sender is checked
 * against the person's allowlist on this door, the chat has to be one of that
 * person's, and the agent has to be theirs: the sender's own message is the
 * evidence the choice is recorded with.
 */
export async function requestHoldChoice(store: StoreLike, request: {
  registry: Registry;
  person: string;
  door: string;
  chat: string;
  sender_id: string;
  /** The platform message that carried the command, kept with the choice as its evidence. */
  message: string;
  at: string;
  agent: string;
  attempt: string;
  revision: number;
  choice: HoldChoiceName;
}): Promise<HoldOutcome> {
  const agents = listAgents(request.registry);
  if (!senderAllowed(request.registry, request.person, request.door, request.sender_id)) throw new HoldChoiceRefused();
  if (!agents.some(one => one.person === request.person && one.door === request.door && one.chat === request.chat)) throw new HoldChoiceRefused();
  const target = agents.find(one => one.id === request.agent);
  if (!target || target.person !== request.person) throw new HoldChoiceRefused();
  return await chooseHold(store, {
    attempt: request.attempt, agent: request.agent, revision: request.revision, choice: request.choice, by: request.sender_id,
    evidence: { source: "chat-command", message: request.message, door: request.door, chat: request.chat, at: request.at },
  });
}
