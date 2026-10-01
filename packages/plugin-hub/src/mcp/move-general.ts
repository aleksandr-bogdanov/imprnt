import type { GeneralRef, GeneralState, RecoveryCause } from "../door/move-lines.ts";
import { allowedSendersOn, enabledOf, lifetimeFor, listRunEntries, senderAllowed } from "../registry/entries.ts";
import type { Registry } from "../registry/load.ts";
import { generalOf, legacyBindingOf, legacyMastersOf } from "../registry/topics.ts";
import type { StoreLike } from "../store/connect.ts";
import { gatesOn } from "../store/controls.ts";
import { openMoveOfAgent } from "../store/moves.ts";
import { readTopicByAgent, runnerLive, sessionLive, type TopicRow } from "../store/topics.ts";
import type { McpBinding } from "./handlers.ts";

/**
 * The independent General a move needs, for now, and where a line about a move is said. Both are MEASURED from facts the hub holds and
 * neither is taken from a registry entry's mere existence or from anything a model wrote.
 *
 * WHY A GENERAL AT ALL. While a move waits, its agent takes no new turn, so the moved chat cannot answer "where is it" or "withdraw"
 * itself: they can only be asked of another chat of the person, and the only one the minimal supported path has is General. A door path
 * that answers while the agent is gated is the integration work that can remove this.
 */

/** The platform a door speaks, as the registry says it. */
export const platformOf = (registry: Registry, door: string): string =>
  ((registry.data.run ?? []) as { id: string; platform?: string }[]).find(one => one.id === door)?.platform ?? "discord";

/**
 * Whether the sender of the cited message may be taken as this person in General's chat. A sender id means something only on the door
 * it was read on, so the two doors' ids are never compared: on General's own door the exact sender has to be one the person allows
 * there; from another door, the message is already shown to be this person's (it is the stored message of their conversation, from a
 * sender they allow on its own door), and what is left to show is that the person has a configured route into General's door at all.
 * Nobody else is granted anything because some allowed list exists somewhere.
 */
export function senderReachesGeneral(registry: Registry, person: string, from: { door: string; sender: string }, generalDoor: string): boolean {
  if (from.door === generalDoor) return senderAllowed(registry, person, generalDoor, from.sender);
  return allowedSendersOn(registry, person, generalDoor).length > 0;
}

export type GeneralVerdict = { ok: true; general: GeneralRef & { id: string; door: string } } | { ok: false; cause: RecoveryCause };

const STATES: Record<string, GeneralState> = {
  archived: "archived", archiving: "archiving", reopening: "reopening", channel_missing: "gone", pending: "not_set_up",
};

/**
 * Whether there is a General that can be asked where this move stands and to withdraw it: it is this person's configured General, an
 * ordinary master of its chat (the registry still binds it), not the topic being moved, a chat the asking sender may speak in (when
 * `from` is given), not archived, being reopened or gone, not itself being moved or held by another operation, not kept asleep by the
 * registry, its runner has a session on the store, and its door is enabled and has one too. The first that fails is the answer, as a
 * cause the words are made from. These are facts known now, and not a promise that General stays reachable.
 */
export async function generalFor(tx: StoreLike, registry: Registry, topic: TopicRow, from?: { door: string; sender: string }): Promise<GeneralVerdict> {
  const no = (reason: RecoveryCause["reason"], more: Omit<RecoveryCause, "reason"> = {}): GeneralVerdict => ({ ok: false, cause: { reason, ...more } });
  const general = generalOf(registry, topic.person);
  if (general === null) return no("no_general");
  if (general.id === topic.agent_id) return no("general_is_the_topic");
  const there = await readTopicByAgent(tx, general.id);
  if (there !== null && there.id === topic.id) return no("general_is_the_topic");
  const door = listRunEntries(registry).find(one => one.id === general.door && one.kind === "door");
  if (door === undefined) return no("general_binding_changed");
  if (from !== undefined && !senderReachesGeneral(registry, topic.person, from, general.door)) return no("owner_not_in_general");
  // The registry still binds General as an ordinary master of that chat, whether or not it has a topic yet.
  const bound = there === null ? legacyMastersOf(registry, general.door).some(one => one.agent.id === general.id)
    : there.person !== topic.person ? false
    : there.origin === "legacy" ? legacyBindingOf(registry, there).ok
    : there.door === general.door && there.chat === general.chat;
  if (!bound) return no("general_binding_changed");
  if (there !== null && (there.lifecycle !== "active" || (there.create_state !== "bound" && there.create_state !== "legacy"))) {
    return no("general_not_open", { state: there.lifecycle === "active" ? "not_set_up" : STATES[there.lifecycle] ?? "closed" });
  }
  const [shut] = (await tx.sql`select lifecycle from topic where door = ${general.door} and chat = ${general.chat}
    and lifecycle in ('archiving', 'archived', 'reopening', 'channel_missing') limit 1`) as unknown as { lifecycle: string }[];
  if (shut !== undefined) return no("general_not_open", { state: STATES[shut.lifecycle] ?? "closed" });
  if ((await openMoveOfAgent(tx, general.id)) !== null) return no("general_moving");
  if ((await gatesOn(tx, { kind: "agent", id: general.id })).some(one => one.state === "open")) return no("general_gated");
  // A General the registry keeps asleep claims nothing, however many other agents its runner serves.
  if (lifetimeFor(registry, general.id).sleeping) return no("general_asleep");
  if (!(await runnerLive(tx, general.runner))) {
    return no("general_runner_offline", { machine: listRunEntries(registry).find(one => one.id === general.runner && one.kind === "runner")?.machine });
  }
  // Its door reads the owner's words for it: one the registry keeps stopped, or that has no session on the store, delivers none.
  if (!enabledOf(door)) return no("general_door_off", { machine: door.machine || undefined });
  if (!(await sessionLive(tx, door.id))) return no("general_door_offline", { machine: door.machine || undefined });
  return { ok: true, general: { id: general.id, door: general.door, platform: platformOf(registry, general.door), chat: general.chat } };
}

/** Where a line about a move is delivered, which decides how it names the chat and what it offers (`door/move-lines.ts`). */
export interface LineContext {
  inTopic: boolean;
  /** Only for a line said in the topic's own chat: the General that is shown usable now, or null when none is. */
  general?: GeneralRef | null;
}

/**
 * The context of a line the CALLER'S chat will say: it is delivered in the topic's own chat exactly when the caller is that topic's
 * agent (the binding's, never an argument), and then the General it may be sent to is measured now, because once the turn being
 * answered has ended that chat takes nothing and General is where the move is checked on and withdrawn.
 */
export async function lineContext(tx: StoreLike, binding: Pick<McpBinding, "agent" | "registry">, topic: TopicRow): Promise<LineContext> {
  if (binding.agent !== topic.agent_id) return { inTopic: false };
  const verdict = await generalFor(tx, binding.registry(), topic);
  return { inTopic: true, general: verdict.ok ? { platform: verdict.general.platform, chat: verdict.general.chat } : null };
}
