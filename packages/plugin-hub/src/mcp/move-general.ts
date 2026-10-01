import type { TopicRow } from "../store/topics.ts";
import type { McpBinding } from "./handlers.ts";

/**
 * Where a line about a move is said. It is MEASURED from the binding and never taken from anything a model wrote.
 *
 * A move no longer needs any other chat: the owner's own chat answers `/move`, `/move withdraw <move-id>` and `/move seen` through the door's
 * deterministic command path (`door/move-command.ts`), which works while the agent is gated and whether or not General can run. So there is
 * no General to find, and the General chat is neither required to be usable nor named in a line.
 */

/** Where a line about a move is delivered, which decides how it names the chat and what it offers (`door/move-lines.ts`). */
export interface LineContext {
  inTopic: boolean;
}

/** A line the CALLER'S chat will say is delivered in the topic's own chat exactly when the caller is that topic's agent (the binding's, never an argument). */
export const lineContext = (binding: Pick<McpBinding, "agent">, topic: Pick<TopicRow, "agent_id">): LineContext => ({ inTopic: binding.agent === topic.agent_id });
