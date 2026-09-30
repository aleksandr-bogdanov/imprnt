import { listAgents, listRunEntries } from "../registry/entries.ts";
import type { Registry } from "../registry/load.ts";
import { generalOf as sharedGeneralOf } from "../registry/topics.ts";
import { platformOf } from "./start.ts";

/**
 * The owner's General: the one chat where anything that needs them is meant to show up.
 *
 * A COUNCIL'S ATTENTION GOES TO ITS OWN CHAT AND TO GENERAL, and to nowhere else. General is what the
 * registry says it is, explicitly: a person names the agent whose chat is their General, and nothing is
 * guessed. There is no "another chat of the same person" fallback (`routeNotice` picks one and this must not),
 * and no hidden substitute: when a person has no General configured, or the one named is not usable, the
 * answer is `null` and the caller says so, in the council's own chat, by name, and `check` reports it.
 *
 * THIS IS A SEAM OVER THE SHARED SETTING. The setting itself (its key, its validation by the loader and
 * the accessor every feature shares, `registry/topics.ts`) belongs to the topic work: what General IS is
 * decided there, once, and this asks it. What this adds is only the reason a council can give in its own
 * chat and in `check` when there is none, which the shared accessor's plain `null` does not say.
 */
export interface General { agent: string; door: string; chat: string; platform: string; guild: string | null }

export type GeneralIssue = "not-configured" | "unknown-agent" | "no-chat";

export function generalOf(registry: Registry, person: string): { general: General } | { issue: GeneralIssue } {
  const people = (registry.data.people ?? []) as Record<string, unknown>[];
  const named = people.find(one => one.id === person)?.general;
  if (typeof named !== "string" || named === "") return { issue: "not-configured" };
  const shared = sharedGeneralOf(registry, person);
  if (shared === null) {
    const agent = listAgents(registry).find(one => one.id === named && one.person === person);
    return { issue: agent === undefined ? "unknown-agent" : "no-chat" };
  }
  const entry = listRunEntries(registry).find(one => one.id === shared.door);
  return { general: { agent: shared.id, door: shared.door, chat: shared.chat, platform: platformOf(registry, shared.door), guild: entry?.guild ?? null } };
}

/**
 * A link to one message, when the platform has such a thing and everything it needs is known. Null
 * otherwise, and the notice then carries no link and says nothing false about where the message is.
 */
export function messageLink(where: { platform: string; guild: string | null; chat: string; message: string | null }): string | null {
  if (where.platform !== "discord" || where.guild === null || where.message === null) return null;
  return `https://discord.com/channels/${where.guild}/${where.chat}/${where.message}`;
}
