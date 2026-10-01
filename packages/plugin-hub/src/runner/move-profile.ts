import { listAgents, listPeople } from "../registry/entries.ts";
import { credentialOfPreset } from "../registry/presets.ts";
import type { Registry } from "../registry/load.ts";
import { isRecord, sameJson } from "./move-handoff.ts";

/**
 * THE PROFILE A MOVE BINDS: what the registry says about how an agent RUNS, with where it runs left out. The store holds one such object
 * for a move in three places and compares them for equality, never ordered: the destination's preflight (`dest_facts.profile`), the hub's
 * receipt after it wrote the registry (`registry_receipt.profile`) and what the destination says it loaded (`loaded.profile`). The source
 * compares its own with the destination's before it releases (`profile_mismatch`). Because `runner` is the one key the hub's write changes,
 * leaving it out is what makes the profile the same before and after that write: a destination can preflight it, the hub can bind it to the
 * receipt, and the destination can load it again.
 *
 * WHAT IT IS, EXACTLY: the agent's own entry (every key but `runner`: person, preset name, chat and door, tools, mode, fragment, settings and
 * mcp NAMES as the file writes them) and its preset (the five settings and the credential's NAME), and `unverified`, the references below.
 * The file is the same for every machine, so what it says here is machine-neutral by construction.
 *
 * WHAT IT IS NOT: a comparison of the CONTENT of the files the launch reads. A person's and an agent's settings, MCP and instruction files are
 * placed per machine, and the profile holds the paths' NAMES and not their bytes, so two machines whose registries agree can still hold
 * different files at those paths; the permissions and servers an agent really runs with are in those files. Nothing compares them, and the
 * credential is host-local and is never read, hashed or exported (an MCP file can hold keys, so a digest of one is not offered either).
 * That is a gate, and it is ENFORCED, not commented: `unverified` names every such reference the launch of THIS agent really reads
 * (`configReferences`), the source refuses to release while it is not empty (`profile_unverified`, `move-export.ts`) and the destination
 * refuses to record its preflight (`dest_profile_unverified`, `move-import.ts`), each naming the references and never a path or a value.
 * No owner acknowledgement clears it: it clears when the registry no longer points the agent at such a file. An agent whose launch reads
 * none (it names none and its person names none, or it is the triage master, which is launched with no tools, no MCP server and no
 * instructions of the person's) has an empty list and is not held by it.
 *
 * NOT IN THE PROFILE, and gated elsewhere: the instruction files a launch reads by default (the vault root's `CLAUDE.md` and
 * `CLAUDE.local.md`, when the person names no list). The registry cannot say whether they exist, and whether they do is a fact of ONE machine,
 * so it cannot be a section this machine-neutral object holds (the hub compares its own reading of the file with what a destination recorded).
 * They are named by file and refused where they exist, never read, hashed or compared: on the source by the scope gate (`defaultInstructionsOf`
 * in `move-scope.ts`, `scope_unsupported`) and on the destination by its preflight (`dest_local_unverified`, `move-import.ts`). A future profile
 * module adds verified evidence as further sections of this object; the comparison below is by section, so adding one changes nothing else.
 */
export const PROFILE_VERSION = 2;

/** A value as jsonb keeps it: undefined dropped, key order irrelevant. */
const plain = (value: unknown): Record<string, unknown> => JSON.parse(JSON.stringify(value)) as Record<string, unknown>;

/**
 * The configuration files the launch of `agentId` reads, as references by owner and kind (`agent.settings`, `person.mcp`, `person.instructions`,
 * `agent.fragment`), sorted: never a path. It follows `makeLoopLaunch`: an agent's own settings and MCP file replace its person's, an agent that
 * names none starts with the person's, the fragment is the agent's alone, and the person's instruction list is read when it names one. The
 * triage master reads none of them.
 */
export function configReferences(registry: Registry, agentId: string): string[] {
  const agent = listAgents(registry).find(one => one.id === agentId);
  if (!agent || agent.role === "triage") return [];
  const person = listPeople(registry).find(one => one.id === agent.person);
  const found: string[] = [];
  if (agent.fragment) found.push("agent.fragment");
  if (agent.settings) found.push("agent.settings"); else if (person?.settings) found.push("person.settings");
  if (agent.mcp) found.push("agent.mcp"); else if (person?.mcp) found.push("person.mcp");
  if (person?.instructions && person.instructions.length > 0) found.push("person.instructions");
  return found.sort();
}

/** The profile of `agentId` in `registry`, or null when the file has no such agent or its preset. */
export function profileOf(registry: Registry, agentId: string): Record<string, unknown> | null {
  const agent = listAgents(registry).find(one => one.id === agentId);
  if (!agent) return null;
  const preset = Object.hasOwn(registry.presets, agent.preset) ? registry.presets[agent.preset] : undefined;
  if (!preset) return null;
  const { runner: _where, ...entry } = agent;
  return {
    version: PROFILE_VERSION, agent: plain(entry), preset: { ...plain(preset), credential: credentialOfPreset(registry, agent.preset) },
    unverified: configReferences(registry, agentId),
  };
}

/**
 * The references a profile says it holds unverified, for the two gates that refuse on them. A profile with no such section says nothing (the
 * store-level callers that supply their own profile have none; the runner's is always `profileOf`'s); one whose section is not a list of
 * strings is itself unverified, never read as empty.
 */
export function profileUnverified(profile: unknown): string[] {
  if (!isRecord(profile) || !Object.hasOwn(profile, "unverified")) return [];
  const listed = profile.unverified;
  if (!Array.isArray(listed) || listed.some(one => typeof one !== "string")) return ["unverified"];
  return (listed as string[]).slice(0, 16);
}

/**
 * The names of what differs between two profiles, never a value: `version`, or `agent.<key>` / `preset.<key>` for every key either side has
 * that the other does not or holds differently, and `unverified` when the references differ. Empty when they are equal. A profile that is not an
 * object differs as `profile`.
 */
export function profileDifference(mine: unknown, theirs: unknown): string[] {
  if (!isRecord(mine) || !isRecord(theirs)) return ["profile"];
  const found: string[] = [];
  for (const section of new Set([...Object.keys(mine), ...Object.keys(theirs)])) {
    const a = mine[section];
    const b = theirs[section];
    if (isRecord(a) && isRecord(b)) {
      for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) if (!sameJson(a[key] ?? null, b[key] ?? null)) found.push(`${section}.${key}`);
    } else if (!sameJson(a ?? null, b ?? null)) found.push(section);
  }
  return found.sort();
}
