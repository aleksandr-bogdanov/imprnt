import { readRegistryDigests, storeMachineOf } from "../hub/digest.ts";
import type { StoreLike } from "./connect.ts";
import { firstInputPickedUp, runnerLive, type TopicRow } from "./topics.ts";

/**
 * Whether a topic's agent is being served on the machine the owner chose, said only as far as the
 * evidence goes.
 *
 * A connection of the machine's runner to the store is NOT serving. A runner on another machine
 * reads its own copy of the registry, and one whose copy does not yet name the new agent claims
 * nothing for it, however connected it is. So the one thing this calls serving is that the runner
 * has picked up the owner's first input (`firstInputPickedUp`), which it can only do once it serves
 * the agent. Everything short of that is waiting, and names why, from what exists already:
 *
 *  * `runner_offline`      nothing of that runner is connected to the store;
 *  * `registry_not_synced` it is connected, but its machine's registry copy is not shown to be the
 *                          store machine's (the digests every hub writes on its tick), so it may not
 *                          have the agent yet;
 *  * `not_picked_up_yet`   it is connected and shown current, and has not taken the input yet.
 *
 * NOTHING HERE IS A LIVENESS SUBSYSTEM. It reads what is already written and is asked only for a
 * topic that has not yet started; once it has, nobody asks again, and nothing claims the agent is
 * running now.
 */
export type Serving = { serving: true } | { serving: false; reason: "runner_offline" | "registry_not_synced" | "not_picked_up_yet" };

export async function servingOf(store: StoreLike, registry: unknown, topic: TopicRow): Promise<Serving> {
  if (await firstInputPickedUp(store, topic)) return { serving: true };
  if (!(await runnerLive(store, topic.runner))) return { serving: false, reason: "runner_offline" };
  const reference = storeMachineOf(registry);
  if (reference !== null && reference !== topic.machine) {
    const digests = await readRegistryDigests(store);
    const theirs = digests.find(one => one.machine === reference);
    const mine = digests.find(one => one.machine === topic.machine);
    if (!theirs || !mine || theirs.sha256 === "" || mine.sha256 !== theirs.sha256) return { serving: false, reason: "registry_not_synced" };
  }
  return { serving: false, reason: "not_picked_up_yet" };
}
