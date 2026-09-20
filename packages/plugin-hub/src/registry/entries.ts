import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_LANGUAGE,
  HARVEST_DEFAULTS,
  loaded,
  STAMP_THRESHOLD_DEFAULTS,
  TRANSCRIBED_DEFAULT_SECONDS,
  VOICE_DEFAULTS,
  type AgentEntry,
  type CredentialEntry,
  type MachineEntry,
  type PersonEntry,
  type Registry,
  type RepositoryEntry,
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

/** The machines this household declares, in the order the file lists them. */
export function listMachines(registry: unknown): MachineEntry[] {
  return loaded(registry, "listMachines").machines.map((entry) => ({ ...entry }));
}

/** The people this household declares, each with its tree. */
export function listPeople(registry: unknown): PersonEntry[] {
  return loaded(registry, "listPeople").people.map((entry) => ({ ...entry }));
}

/**
 * What this machine runs.
 *
 * The backward compatibility rule made concrete: a file that declares fewer
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

/** Where an agent's chat is read from: the file its door wrote, or the store. */
export type ChatStatePlacement = "file" | "store";

/**
 * Which of the two a runner serving this agent reads, decided by the registry
 * and by nothing else.
 *
 * The chat log is one file per agent, written by its DOOR on the door's own
 * machine. A runner elsewhere has no such file and never will, so it reads the
 * same lines out of the store, which holds every message in both directions
 * already. A file every household starts with declares one machine or none,
 * and then the two entries agree and the file is the answer.
 *
 * It takes the registry and the agent, because a placement that could be
 * switched from a command line or an environment variable is a second place for
 * this household to disagree with itself about where its chat is.
 */
export function chatStateFor(registry: unknown, agentId: string): ChatStatePlacement {
  const it = loaded(registry, "chatStateFor");
  const agent = it.agents.find((one) => one.id === agentId);
  if (!agent) return "file";
  const door = it.run.find((one) => one.id === agent.door);
  const runner = it.run.find((one) => one.id === agent.runner);
  // An entry the file does not declare says nothing about where anything is,
  // and inventing a placement from a missing entry would move an agent's chat
  // on a typo.
  if (!door || !runner) return "file";
  return door.machine === runner.machine ? "file" : "store";
}

/** The person an agent belongs to, or null when the file declares none. */
export function personOf(registry: unknown, agentId: string): PersonEntry | null {
  const it = loaded(registry, "personOf");
  const agent = it.agents.find((one) => one.id === agentId);
  if (!agent) return null;
  const person = it.people.find((one) => one.id === agent.person);
  return person ? { ...person } : null;
}

/** The credentials this household declares, in the order the file lists them. */
export function listCredentials(registry: unknown): CredentialEntry[] {
  return loaded(registry, "listCredentials").credentials.map((entry) => ({ ...entry }));
}

/** One credential by id, or null when the file declares none by that name. */
export function credentialFor(registry: unknown, id: string): CredentialEntry | null {
  const found = loaded(registry, "credentialFor").credentials.find((one) => one.id === id);
  return found ? { ...found } : null;
}

/** The four clocks this person is measured against, defaults filled in. */
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

/** The household's recognizer and the four knobs around it, defaults filled in. */
export interface VoiceSettings {
  /** The name of the `[recognizers.<name>]` table the household chose. */
  recognizer: string;
  provider: string;
  model: string;
  /** The local provider's own directory, and null on a cloud one. */
  runtime: string | null;
  /** The cloud provider's key by credential id, and null on a local one. */
  credential: string | null;
  chunk_seconds: number;
  retry_seconds: number;
  give_up_hours: number;
  chunk_deadline_seconds: number;
}

/**
 * The household's recognizer, or NULL when the file names none.
 *
 * IT TAKES NO PERSON. The recognizer is one per household: there is no
 * per-person field and no consent line, so a `[[people]]` entry that named one
 * would be a key nothing reads. Null is a real answer and means the component
 * is not installed, which is the file a household starts with and the one every
 * shipped check carries.
 */
export function voiceFor(registry: unknown): VoiceSettings | null {
  const it = loaded(registry, "voiceFor");
  const table = (it.data.voice ?? {}) as Record<string, unknown>;
  const named = table.recognizer;
  if (typeof named !== "string") return null;
  const chosen = it.recognizers[named];
  if (!chosen) return null;
  return {
    recognizer: named,
    provider: chosen.provider,
    model: chosen.model,
    runtime: chosen.runtime,
    credential: chosen.credential,
    chunk_seconds: chosen.chunk_seconds,
    retry_seconds: (table.retry_seconds as number) ?? VOICE_DEFAULTS.retry_seconds,
    give_up_hours: (table.give_up_hours as number) ?? VOICE_DEFAULTS.give_up_hours,
    chunk_deadline_seconds:
      (table.chunk_deadline_seconds as number) ?? VOICE_DEFAULTS.chunk_deadline_seconds,
  };
}

/**
 * This machine's transcriber entry with its residency filled in, or null.
 *
 * The same backward compatibility rule `runEntriesFor` has: a file that
 * declares fewer than two machines has nothing to be ambiguous about, so the
 * one entry belongs to whichever machine asks.
 */
export function transcriberFor(registry: unknown, machine: string): RunEntry | null {
  const it = loaded(registry, "transcriberFor");
  const entry = it.run.find(
    (one) =>
      one.kind === "transcriber" && (it.machines.length < 2 || one.machine === machine),
  );
  if (!entry) return null;
  const residency = entry.residency ?? VOICE_DEFAULTS.residency;
  return {
    ...entry,
    residency,
    // Only the residency that lets the model go has an idle window, and the
    // loader refuses one on the residency that does not.
    ...(residency === "idle-unload"
      ? { idle_seconds: entry.idle_seconds ?? VOICE_DEFAULTS.idle_seconds }
      : {}),
  };
}

/**
 * How long this person waits for a voice note's own text, seconds.
 *
 * Its own accessor rather than a fifth key on `thresholdsFor`, because that one
 * answers exactly the four clocks the ruling names and two shipped checks
 * compare its answer whole.
 */
export function transcribedSecondsFor(registry: unknown, personId: string): number {
  const person = loaded(registry, "transcribedSecondsFor").people.find(
    (one) => one.id === personId,
  );
  return person?.transcribed_seconds ?? TRANSCRIBED_DEFAULT_SECONDS;
}

/** What harvests this person's chats, with the defaults filled in. */
export interface HarvestSettings {
  /** The preset name a slice of their chats is read under. */
  harvester: string;
  /** Absolute, the directory holding `vault/` and `raw/`. */
  vault: string;
  quiet_minutes: number;
  min_messages: number;
  report: boolean;
}

/**
 * This person's harvest, or NULL when they name no harvester.
 *
 * Null is a real answer and not a missing one: a household that has not chosen
 * a harvester still runs, nothing harvests that person's chats, and `check`
 * says so, the same shape `credential-undeclared` has.
 *
 * The minimum slice's default comes off the HARVESTER preset's `paid` rather
 * than the agent's, because the cost L19 is talking about is the harvest's own:
 * a plan login can run a strong model on every slice, and a per-token key waits
 * for a bigger one.
 *
 */
export function harvestFor(registry: unknown, personId: string): HarvestSettings | null {
  const it = loaded(registry, "harvestFor");
  const person = it.people.find((one) => one.id === personId);
  if (!person?.harvester || !person.vault) return null;
  const paid = it.presets[person.harvester]?.paid === "key" ? "key" : "plan";
  return {
    harvester: person.harvester,
    vault: person.vault,
    quiet_minutes: person.harvest_quiet_minutes ?? HARVEST_DEFAULTS.quiet_minutes,
    min_messages: person.harvest_min_messages ?? HARVEST_DEFAULTS.min_messages[paid],
    report: person.harvest_report ?? HARVEST_DEFAULTS.report,
  };
}

/** The language this person reads the door's own lines in. */
export function languageOf(registry: unknown, personId: string): "en" | "ru" {
  const person = loaded(registry, "languageOf").people.find((one) => one.id === personId);
  return (person?.language ?? DEFAULT_LANGUAGE) as "en" | "ru";
}

/**
 * Where a notice about this agent goes and how it is written: its door and
 * chat, the platform that door speaks, and its person's language. Everything a
 * notice needs beyond its own words, read from the file in one place, so the
 * runner and the harvest cannot disagree about where a line lands.
 */
export function noticeRoute(registry: Registry, id: string) {
  const agent = listAgents(registry).find(one => one.id === id)!;
  const door = (registry.data.run as { id: string; platform?: string }[]).find(one => one.id === agent.door);
  return { route: { door: agent.door, chat: agent.chat }, platform: door?.platform ?? "discord", language: languageOf(registry, agent.person) };
}

/**
 * The id this agent's outage is keyed by.
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

/** Launch sources are explicit even when the registry omits them. */
export function launchFor(registry: unknown, agentId: string) {
  const agent = loaded(registry, "launchFor").agents.find(one => one.id === agentId);
  if (!agent) throw new TypeError(`unknown agent: ${agentId}`);
  return {
    fragment: agent.fragment ?? null,
    tools: agent.tools === undefined ? null : [...agent.tools],
    settings: agent.settings ? JSON.parse(readFileSync(agent.settings, "utf8")) : {},
    mcp: agent.mcp ? JSON.parse(readFileSync(agent.mcp, "utf8")) : { mcpServers: {} },
  };
}

export function lifetimeFor(registry: unknown, agentId: string) {
  const agent = loaded(registry, "lifetimeFor").agents.find(one => one.id === agentId);
  if (!agent) throw new TypeError(`unknown agent: ${agentId}`);
  return { mode: agent.mode ?? "resident", sleeping: agent.sleeping ?? false, idle_seconds: agent.idle_seconds ?? 300 };
}

export function filingRulesFor(registry: unknown, personId: string): string | null {
  const person = loaded(registry, "filingRulesFor").people.find(one => one.id === personId);
  return person?.filing_rules ?? (person?.vault ? join(person.vault, "CLAUDE.md") : null);
}

export function senderAllowed(registry: unknown, personId: string, door: string, sender: string): boolean {
  const person = loaded(registry, "senderAllowed").people.find(one => one.id === personId);
  const senders = person?.allowed_senders;
  return senders && Object.hasOwn(senders, door) ? senders[door].includes(sender) : false;
}

export function runnerLimitsFor(registry: unknown, runnerId: string) {
  const entry = loaded(registry, "runnerLimitsFor").run.find(one => one.id === runnerId && one.kind === "runner");
  if (!entry) throw new TypeError(`unknown runner: ${runnerId}`);
  return { max_active_children: entry.max_active_children ?? 4, child_memory_budget_mb: entry.child_memory_budget_mb ?? 2048 };
}

/** Every repository the file declares, whichever sync entry lists it. */
export function listRepositories(registry: unknown): RepositoryEntry[] {
  return loaded(registry, "listRepositories").repositories.map((entry) => ({ ...entry }));
}

export function repositoriesFor(registry: unknown, entryId: string) {
  const it = loaded(registry, "repositoriesFor");
  const entry = it.run.find(one => one.id === entryId);
  if (!entry) throw new TypeError(`unknown entry: ${entryId}`);
  return (entry.repositories ?? []).map(id => {
    const repository = it.repositories.find(one => one.id === id)!;
    return { ...repository, required: repository.required ?? true };
  });
}

/** Imported history is excluded independently of the durable harvest watermark. */
export function historyHarvestFrom(registry: unknown, person: string, from: string | null): string | null {
  const exclusion = loaded(registry, "historyHarvestFrom").people.find(p => p.id === person)?.history_harvest_after;
  if (!exclusion) return from;
  return from === null || Date.parse(exclusion) > Date.parse(from) ? exclusion : from;
}
