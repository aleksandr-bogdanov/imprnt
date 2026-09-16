import {
  DEFAULT_LANGUAGE,
  loaded,
  STAMP_THRESHOLD_DEFAULTS,
  type AgentEntry,
  type CredentialEntry,
  type MachineEntry,
  type PersonEntry,
  type RunEntry,
} from "./load.ts";
import { credentialOfPreset } from "./presets.ts";

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

/** D-111. The credentials this household declares, in the order the file lists them. */
export function listCredentials(registry: unknown): CredentialEntry[] {
  return loaded(registry, "listCredentials").credentials.map((entry) => ({ ...entry }));
}

/** One credential by id, or null when the file declares none by that name. */
export function credentialFor(registry: unknown, id: string): CredentialEntry | null {
  const found = loaded(registry, "credentialFor").credentials.find((one) => one.id === id);
  return found ? { ...found } : null;
}

/** D-108. The four clocks this person is measured against, defaults filled in. */
export interface StampThresholds {
  acked_seconds: number;
  started_seconds: number;
  answered_seconds: number;
  delivered_seconds: number;
}

/**
 * The thresholds are one table in the registry, PER PERSON (L6), so a hub with
 * two people measures each against their own numbers. A person who sets none,
 * and a person the file does not declare at all, are measured against L6's
 * defaults, which the ruling itself calls defaults.
 */
export function thresholdsFor(registry: unknown, personId: string): StampThresholds {
  const person = loaded(registry, "thresholdsFor").people.find((one) => one.id === personId);
  return {
    acked_seconds: person?.acked_seconds ?? STAMP_THRESHOLD_DEFAULTS.acked_seconds,
    started_seconds: person?.started_seconds ?? STAMP_THRESHOLD_DEFAULTS.started_seconds,
    answered_seconds: person?.answered_seconds ?? STAMP_THRESHOLD_DEFAULTS.answered_seconds,
    delivered_seconds: person?.delivered_seconds ?? STAMP_THRESHOLD_DEFAULTS.delivered_seconds,
  };
}

/** D-108. The language this person reads the door's own lines in. */
export function languageOf(registry: unknown, personId: string): "en" | "ru" {
  const person = loaded(registry, "languageOf").people.find((one) => one.id === personId);
  return (person?.language ?? DEFAULT_LANGUAGE) as "en" | "ru";
}

/**
 * D-121. The id this agent's outage is keyed by.
 *
 * The credential its preset names, or `preset:<preset name>` when it names
 * none. The fallback is what keeps the one-notice arithmetic sound for a
 * household that has not written `[[credentials]]` yet, and `check` is
 * meanwhile telling it to (`credential-undeclared`).
 */
export function credentialOf(registry: unknown, agentId: string): string {
  const it = loaded(registry, "credentialOf");
  const agent = it.agents.find((one) => one.id === agentId);
  if (!agent) {
    throw new TypeError(
      `${agentId} is not an agent of ${it.file}, and a credential is its preset's`,
    );
  }
  return credentialOfPreset(it, agent.preset) ?? `preset:${agent.preset}`;
}
