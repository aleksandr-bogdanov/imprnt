import { loaded, type AgentEntry, type RunEntry } from "./load.ts";

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
