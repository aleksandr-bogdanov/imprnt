import { confirmDeletion } from "../store/deletions.ts";
import { confirmTopic } from "../store/topics.ts";
import type { ApprovalHooks } from "./confirm.ts";

/**
 * What acts on the owner's green check for a topic chat, registered with the door beside whatever else the door was handed
 * (`runDoor`'s `approvals`): the check on a chat's SETUP creates it, and the check on a DELETION's scope confirms that deletion.
 *
 * Each runs INSIDE the approval's transaction, so the approval and the topic or deletion it confirms commit together or not at all,
 * and each writes only to the store: the channel is asked for afterwards, and a deletion's content is erased afterwards, by the
 * door's tasks, from what this committed. It confirms nothing the store does not accept: the approved preview must be exactly what
 * the topic or the deletion holds, still waiting for it, or the approval is rolled back with it and the preview stays pending,
 * with the reason on it.
 *
 * There is no other way a topic is confirmed or a deletion is. A tool call cannot: the routines behind these are the store's, and
 * the only thing that reaches them is a reaction the door read from the owner.
 */
export const TOPIC_CREATE = "topic.create";
export const TOPIC_DELETE = "topic.delete";

export function topicApprovals(): ApprovalHooks {
  return {
    [TOPIC_CREATE]: async (tx, approval) => {
      await confirmTopic(tx, approval.id);
    },
    [TOPIC_DELETE]: async (tx, approval) => {
      await confirmDeletion(tx, approval.id);
    },
  };
}
