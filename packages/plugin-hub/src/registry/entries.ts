import {
  loaded,
  type AgentEntry,
  type MachineEntry,
  type PersonEntry,
  type RunEntry,
} from "./load.ts";

/**
 * Everything the hub runs for this household. A missing field and a reused id
 * are refusals raised by loadRegistry, so one place refuses a file.
 */
export function listRunEntries(registry: unknown): RunEntry[] {
  return loaded(registry, "listRunEntries").run.map((entry) => ({ ...entry }));
}

export function listAgents(registry: unknown): AgentEntry[] {
  return loaded(registry, "listAgents").agents.map((entry) => ({ ...entry }));
}

/**
 * The agents a piece serves. It is how a door and a runner learn what they are
 * for, from the file rather than from an argument.
 */
export function agentsFor(
  registry: unknown,
  who: { door?: string; runner?: string },
): AgentEntry[] {
  return listAgents(registry).filter(
    (agent) =>
      (who.door === undefined || agent.door === who.door) &&
      (who.runner === undefined || agent.runner === who.runner),
  );
}

/** D-76. The machines this household declares, in the order the file lists them. */
export function listMachines(registry: unknown): MachineEntry[] {
  return loaded(registry, "listMachines").machines.map((entry) => ({ ...entry }));
}

/** D-93. The people this household declares, each with its tree. */
export function listPeople(registry: unknown): PersonEntry[] {
  return loaded(registry, "listPeople").people.map((entry) => ({ ...entry }));
}

/**
 * What this machine runs.
 *
 * D-76's backward compatibility rule made concrete: a file that declares fewer
 * than two machines has nothing to be ambiguous about, so every entry belongs
 * to the one machine the asking process names, whatever it calls itself. Once
 * the file declares two or more, `machine` is required on every entry (the
 * loader refuses a file that omits one) and this filters by it.
 */
export function runEntriesFor(registry: unknown, machine: string): RunEntry[] {
  const it = loaded(registry, "runEntriesFor");
  if (it.machines.length < 2) return listRunEntries(it);
  return listRunEntries(it).filter((entry) => entry.machine === machine);
}

/** The person an agent belongs to, or null when the file declares none. */
export function personOf(registry: unknown, agentId: string): PersonEntry | null {
  const it = loaded(registry, "personOf");
  const agent = it.agents.find((one) => one.id === agentId);
  if (!agent) return null;
  const person = it.people.find((one) => one.id === agent.person);
  return person ? { ...person } : null;
}
