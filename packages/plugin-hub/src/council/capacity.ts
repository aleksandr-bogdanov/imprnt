import { listAgents } from "../registry/entries.ts";
import type { AgentEntry, Registry } from "../registry/load.ts";
import type { StoreLike } from "../store/connect.ts";

/**
 * The room a council's master keeps on its own runner.
 *
 * WHILE A COUNCIL IS ACTIVE, ITS MASTER HAS ONE SLOT (AND ONE CHILD'S MEMORY) KEPT FREE ON ITS RUNNER,
 * once per master however many councils it has. A worker is not admitted into the last room a master
 * needs to answer the owner, because the master is what makes the council conversational: it has to be
 * able to take a turn while workers run, to read the event that says the round is complete, and to
 * synthesize. A master that already holds a slot (its child is resident) is counted in the runner's own
 * reservations and needs nothing more; a master with no child running has one slot held back.
 *
 * WHAT IT NEVER DOES. It never stops a healthy participant to make room, never moves a participant to
 * another machine, and never takes room on any runner but the master's own (every other runner keeps its
 * own limits, which is what the design asks). Where the runner's limits leave no room for a worker beside the
 * master, the worker waits and the wait says so (`conflict`), which is a configuration the owner can see and
 * change, not a decision made behind their back.
 *
 * A COUNCIL IS ACTIVE until it is complete or stopped AND the events waiting for its master have been read.
 * Only chat-less agents (workers) are held back: an agent with a chat is a master or a conversation partner,
 * and is never made to wait for a reserve it is itself the reason for.
 */
export async function mastersToHold(
  store: StoreLike,
  where: { runner: string; registry: Registry; admitting: Pick<AgentEntry, "id" | "door">; residentReserved(agent: string): boolean },
): Promise<string[]> {
  return unreservedMasters(await activeMasters(store, where), where.residentReserved);
}

/**
 * The masters of this runner that have an active council, from the store. THE ONE AWAIT of the decision to hold room for them: the runner's admission
 * (`runner/admission.ts`) awaits this FIRST, and only then reads its own reservations, the memory it has measured and which masters hold a slot, and decides,
 * in one synchronous step. A caller that read those before this await decided on a world that had moved while it was suspended: two workers waking together both saw
 * no memory used, both fit beside the master's reserve, and both took it.
 */
export async function activeMasters(
  store: StoreLike,
  where: { runner: string; registry: Registry; admitting: Pick<AgentEntry, "id" | "door"> },
): Promise<string[]> {
  if (where.admitting.door !== undefined) return [];
  const rows = (await store.sql`select distinct c.agent from council c
    where c.origin_kind <> 'legacy'
      and (c.lifecycle not in ('complete', 'stopped')
           or exists (select 1 from council_event e join inbound i on i.id = e.inbound_id
                       where e.council_id = c.id and i.state not in ('answered', 'delivered')))`) as unknown as { agent: string }[];
  if (rows.length === 0) return [];
  const agents = listAgents(where.registry);
  return rows.map(one => one.agent).filter(id => agents.find(agent => agent.id === id)?.runner === where.runner).sort();
}

/** Of those masters, the ones that still need a slot kept for them: a master that holds one already (its child is resident) needs nothing more. Synchronous. */
export function unreservedMasters(masters: readonly string[], residentReserved: (agent: string) => boolean): string[] {
  return masters.filter(id => !residentReserved(id));
}
