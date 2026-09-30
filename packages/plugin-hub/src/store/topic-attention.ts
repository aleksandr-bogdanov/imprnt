import { attentionRoute, generalOf, type AttentionRoute } from "../registry/topics.ts";
import type { StoreLike } from "./connect.ts";
import { chatUsable } from "./topics.ts";

/**
 * Where something that needs the person is said, with BOTH places measured here and nowhere
 * else: the chat it belongs to, and the person's configured General.
 *
 * WHETHER A CHAT CAN TAKE A NOTICE IS NOT WHETHER ITS AGENT CAN RUN. The notice is a line the
 * door itself says; it needs a chat that is not archived, being reopened or gone, and nothing
 * about the agent behind it. A General whose model is gated, stopped, held or busy is a place
 * a notice can go, and treating it as gone would leave the person unable to be told anything.
 * A General whose chat is read only, or deleted, is not, whatever its agent could do.
 *
 * Nothing is chosen: the answer is the pure `attentionRoute` with the two measurements given
 * to it, so a General that is not usable and an origin that is not usable name no chat, and
 * the caller keeps the reason (`noteAttention`) where `check` and `inspect` read it.
 */
export async function attentionFor(store: StoreLike, registry: unknown, input: {
  person: string;
  origin: { door: string; chat: string } | null;
  /** Given when the caller knows better than the topic record does (a reopen asked for inside the chat that is being reopened). */
  originUsable?: boolean;
  /** Likewise for General: a reopen of General itself is said in General, which is restored by the time it is said. */
  generalUsable?: boolean;
}): Promise<AttentionRoute> {
  const originUsable = input.originUsable ?? (input.origin !== null && await chatUsable(store, input.origin.door, input.origin.chat));
  const general = generalOf(registry, input.person);
  const generalUsable = input.generalUsable ?? (general !== null && await chatUsable(store, general.door, general.chat));
  return attentionRoute(registry, { person: input.person, origin: input.origin, originUsable, generalUsable });
}
