import { putRow, removeRow } from "../records/statesheet.ts";
import type { StoreLike } from "../store/connect.ts";

/**
 * What each agent is waiting on right now, as its runner knows it: one row per
 * agent, overwritten as the wait changes, removed the moment the agent moves.
 *
 * The door reads it when a clock runs out, so the line under "still waiting"
 * can say why. Three of the reasons only the runner can know, because they
 * live in its memory and no table: a slot held by other agents, a session
 * being started from cold, and a background summary the loop yields to. The
 * rest the door derives from the store and the registry on its own.
 */
export const AGENT_WAIT_SHEET = "agent_wait";

export type AgentWait =
  | { kind: "slots"; count: number; holders: string[] }
  | { kind: "starting" }
  | { kind: "harvest" };

/** Record the wait, or clear it, writing only when it changed since the last call. */
export function waitRecorder(store: StoreLike, agent: string) {
  let last: string | null = null;
  return async (wait: AgentWait | null): Promise<void> => {
    const now = wait === null ? null : JSON.stringify(wait);
    if (now === last) return;
    last = now;
    try {
      if (wait === null) await removeRow(store, AGENT_WAIT_SHEET, agent);
      else await putRow(store, AGENT_WAIT_SHEET, agent, { ...wait, at: new Date().toISOString() });
    } catch {
      // The row is a courtesy to the door and never the reason a turn waits,
      // so a store that refused it costs the agent nothing.
      last = null;
    }
  };
}
