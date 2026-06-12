// imprnt · kleinanzeigen plugin — the send guard.
//
// Sending is the ONLY outward action, and it runs once per explicit human approval — never batched,
// never automatic, never from the scheduled loop. This module holds the one safety rule the code
// enforces on top of the human: a conversation the rater flagged `scam` is refused unless the human
// passes --force. Everything else is the human's call; the guard just stops a fat-fingered reply to an
// obvious fraud.
import type { Conversation } from "./mirror.ts";

export type SendDecision = { allowed: boolean; reason: string };

export function guardSend(c: Conversation, force: boolean): SendDecision {
  if (c.rating === "scam" && !force) {
    return {
      allowed: false,
      reason:
        `refusing to reply to a scam-rated conversation (${c.conv}: ${(c.tells ?? []).join(", ")}). ` +
        "If you're certain, re-run with --force. The vault's rule: anyone steering off Sicher bezahlen is the signal.",
    };
  }
  if (c.state === "closed") {
    return { allowed: false, reason: `conversation ${c.conv} is closed` };
  }
  return { allowed: true, reason: "ok" };
}
