import { createHash } from "node:crypto";
import { basename } from "node:path";
import { listAgents, listRunEntries } from "../registry/entries.ts";
import { getPreset, presetId } from "../registry/presets.ts";
import type { AgentEntry, Registry } from "../registry/load.ts";

/**
 * THE EFFECTIVE PROFILE OF A PARTICIPANT: everything about how a worker will actually run that the owner's approval of the
 * roster was an approval of, normalized, so that it can be compared again at the moment a job is launched.
 *
 * `presetId` (registry/presets.ts) is a content hash of five settings (adapter, effort, model, paid, provider), which is more than a
 * preset's name, and it is included. It is not enough: the same preset name with another model is caught by it, but which preset the
 * worker's own entry names, which tools it may use, which instruction, settings and MCP files it carries, which runner and which machine
 * serve it, are all things a registry edit changes between the approval and a job that is still queued, or a debate round, follow-up,
 * correction or continuation that comes days later, and none of them is in that hash.
 *
 * WHAT IT HOLDS AND WHAT IT NEVER HOLDS. Names, identifiers and lists that the registry states: the worker, its runner and machine, the
 * preset name and its five settings, the tools it is allowed, and the BASE NAMES of its instruction, settings and MCP files (a path is
 * machine-local, so the same profile would not read the same on two machines, and the contents of a file are the owner's to edit and
 * not what was approved). No credential, no key, no path of a secret and no timestamp goes into it, so it can be hashed and logged.
 *
 * NOTHING HERE CHANGES WHAT AN AGENT CAN DO. A worker whose profile no longer matches is not given other tools, another model or a fresh
 * context: the job is refused by name (`configuration changed`), the council reads the refusal as a member waiting for the owner, and
 * the tools, instructions, MCP and box the worker had are exactly what they were.
 */

export interface EffectiveProfile {
  worker: string;
  runner: string;
  machine: string;
  preset: string;
  preset_id: string;
  settings: { adapter: string | null; effort: string | null; model: string | null; paid: string | null; provider: string | null };
  tools: string[];
  instructions: string | null;
  settings_file: string | null;
  mcp: string | null;
  role: string | null;
}

/** The name a household's machine is known by: its `[[machines]]` id, or the runner's when it declares none. */
export function machineOf(registry: Registry, agent: Pick<AgentEntry, "runner">): string {
  const entry = listRunEntries(registry).find(one => one.id === agent.runner);
  return entry?.machine ? entry.machine : agent.runner;
}

const named = (path: string | undefined): string | null => (path === undefined || path === "" ? null : basename(path));

/** The profile the registry gives this worker now, or null when it is not configured. */
export function profileOf(registry: Registry, agentId: string): EffectiveProfile | null {
  const agent = listAgents(registry).find(one => one.id === agentId);
  if (!agent) return null;
  const preset = getPreset(registry, agent.preset);
  return {
    worker: agent.id, runner: agent.runner, machine: machineOf(registry, agent), preset: agent.preset, preset_id: presetId(preset),
    settings: { adapter: preset.adapter ?? null, effort: preset.effort ?? null, model: preset.model ?? null, paid: preset.paid ?? null, provider: preset.provider ?? null },
    tools: [...(agent.tools ?? [])].sort(), instructions: named(agent.fragment), settings_file: named(agent.settings), mcp: named(agent.mcp), role: agent.role ?? null,
  };
}

/** A short digest of a profile, in a fixed key order, so equal profiles have equal digests wherever they were computed. */
export function profileIdOf(profile: EffectiveProfile): string {
  const ordered = {
    worker: profile.worker, runner: profile.runner, machine: profile.machine, preset: profile.preset, preset_id: profile.preset_id,
    settings: { adapter: profile.settings.adapter, effort: profile.settings.effort, model: profile.settings.model, paid: profile.settings.paid, provider: profile.settings.provider },
    tools: profile.tools, instructions: profile.instructions, settings_file: profile.settings_file, mcp: profile.mcp, role: profile.role,
  };
  return createHash("sha256").update(JSON.stringify(ordered)).digest("hex").slice(0, 24);
}

/** Which parts of the accepted profile the profile now differs in, by name only (never a value): for the refusal and the owner's words. */
export function changedOf(accepted: Record<string, unknown> | null, now: EffectiveProfile | null): string[] {
  if (now === null) return ["worker"];
  if (accepted === null || Object.keys(accepted).length === 0) return [];
  const a = accepted as Partial<EffectiveProfile>;
  const out: string[] = [];
  for (const key of ["worker", "runner", "machine", "preset", "instructions", "settings_file", "mcp", "role"] as const) {
    if ((a[key] ?? null) !== now[key]) out.push(key === "settings_file" ? "settings" : key);
  }
  for (const key of ["adapter", "effort", "model", "paid", "provider"] as const) {
    if ((a.settings?.[key] ?? null) !== now.settings[key]) out.push(key);
  }
  if (JSON.stringify([...(a.tools ?? [])].sort()) !== JSON.stringify(now.tools)) out.push("tools");
  return out;
}
