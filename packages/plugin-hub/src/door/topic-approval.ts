import { confirmTopic } from "../store/topics.ts";
import type { ApprovalHooks } from "./confirm.ts";

/**
 * What acts on the owner's green check for a topic chat's setup, registered with the door
 * beside whatever else the door was handed (`runDoor`'s `approvals`).
 *
 * It runs INSIDE the approval's transaction, so the approval and the topic it confirms commit
 * together or not at all, and it writes only to the store: the channel is asked for afterwards,
 * by the door's topic task, from what this committed. It confirms nothing the store does not
 * accept: the approved preview must be exactly what the topic holds, still waiting for it, or
 * the approval is rolled back with it and the preview stays pending, with the reason on it.
 *
 * There is no other way a topic is confirmed. A tool call cannot: the routine behind this is the
 * store's, and the only thing that reaches it is a reaction the door read from the owner.
 */
export const TOPIC_CREATE = "topic.create";

export function topicApprovals(): ApprovalHooks {
  return {
    [TOPIC_CREATE]: async (tx, approval) => {
      await confirmTopic(tx, approval.id);
    },
  };
}
