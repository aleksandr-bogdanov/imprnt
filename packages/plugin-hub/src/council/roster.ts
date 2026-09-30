import { ToolError } from "../mcp/contracts.ts";
import { listAgents } from "../registry/entries.ts";
import { getPreset, presetId } from "../registry/presets.ts";
import type { AgentEntry, Registry } from "../registry/load.ts";
import { changedOf, machineOf, profileIdOf, profileOf, type EffectiveProfile } from "./profile.ts";

/**
 * Who can be on a council, and how the owner's words are resolved to exactly one worker.
 *
 * A PARTICIPANT IS ONE CONFIGURED WORKER, RESOLVED TO THE PRESET AND THE MACHINE THE REGISTRY
 * ALREADY GIVES IT. There is no default roster, no "usual pair", no picking a worker because
 * it is free and no substituting one because it is not: a roster that is not fully named is
 * `needs_participants`, with the real choices, and the master asks. The preset and the machine
 * are part of the request only so the owner's choice is checked and recorded, not so they
 * can be changed: a worker runs the preset its registry entry names on the runner its entry
 * names, and asking for another is refused by name (`unsupported_override`) rather than
 * quietly changed or quietly obeyed. Native model aliases are permitted and recorded as the
 * alias; the model ids an engine actually resolves them to are recorded on each turn.
 *
 * WHICH AGENTS ARE WORKERS. An agent of the person that takes jobs alone, that is, one with
 * no door and no chat, and is not the triage master. An agent with a chat is somebody's
 * conversation partner and running a council member on it would take the slot its own
 * conversation needs (the table allows one attempt per agent), so it is never offered.
 * `role = "council"` seats are workers like any other; the role is no longer what makes
 * a roster.
 */

export const MAX_PARTICIPANTS = 12;
export const MIN_PARTICIPANTS = 2;

export interface Choice { worker_ref: string; preset_ref: string; machine_ref: string; adapter: string; model: string; effort: string }

export interface RosterInput { worker_ref?: string; preset_ref?: string; machine_ref?: string; brief?: string }

export interface Resolved {
  worker_ref: string;
  preset_ref: string;
  preset_id: string;
  preset_snapshot: Record<string, string>;
  machine: string;
  runner: string;
  brief: string;
  /**
   * The normalized effective profile the owner's approval was an approval of (`profile.ts`), and its digest. The runner compares the worker's
   * profile again when it launches every job of this participant, and refuses one that no longer matches. A proposal frozen before this existed
   * has neither: the participant is then resolved again from what the registry says now.
   */
  profile?: EffectiveProfile;
  profile_id?: string;
}

export interface NeedsParticipants {
  reason: string;
  /** Which entries of what was sent lack which fields. Empty when no roster was sent at all. */
  incomplete: { index: number; missing: string[] }[];
  choices: Choice[];
}

export type RosterOutcome = { ok: true; participants: Resolved[] } | { ok: false; needs: NeedsParticipants };

function isWorker(agent: AgentEntry, person: string, exclude: readonly string[]): boolean {
  return agent.person === person && agent.door === undefined && agent.chat === undefined
    && agent.role !== "triage" && !exclude.includes(agent.id);
}

/** Every worker the person has, as the choices an owner can be offered, in the file's order. */
export function eligibleWorkers(registry: Registry, person: string, exclude: readonly string[] = []): Choice[] {
  return listAgents(registry).filter(agent => isWorker(agent, person, exclude)).map((agent) => {
    const preset = getPreset(registry, agent.preset);
    return { worker_ref: agent.id, preset_ref: agent.preset, machine_ref: machineOf(registry, agent),
      adapter: preset.adapter, model: preset.model, effort: preset.effort };
  });
}

/** One worker, resolved exactly. Used for a whole roster and for the one replacement an owner chooses. */
export function resolveWorker(registry: Registry, person: string, exclude: readonly string[], input: Required<RosterInput>): Resolved {
  const agent = listAgents(registry).find(one => one.id === input.worker_ref);
  if (!agent || !isWorker(agent, person, exclude)) {
    throw new ToolError("unknown_participant", `${input.worker_ref} is not a worker of this owner that can be asked to take part. Its choices are listed by leaving participants out.`);
  }
  if (input.preset_ref !== agent.preset) {
    throw new ToolError("unsupported_override", `${agent.id} runs the preset ${agent.preset}, and ${input.preset_ref} cannot be chosen for it here: a worker keeps the preset its configuration gives it, and a different one needs a different worker.`);
  }
  const machine = machineOf(registry, agent);
  if (input.machine_ref !== machine) {
    throw new ToolError("unsupported_override", `${agent.id} runs on ${machine}, and ${input.machine_ref} cannot be chosen for it here: a worker stays on the machine its configuration gives it, and no other machine is picked for it.`);
  }
  const preset = getPreset(registry, agent.preset);
  const profile = profileOf(registry, agent.id)!;
  return { worker_ref: agent.id, preset_ref: agent.preset, preset_id: presetId(preset),
    preset_snapshot: { adapter: preset.adapter, effort: preset.effort, model: preset.model, paid: preset.paid, provider: preset.provider },
    machine, runner: agent.runner, brief: input.brief, profile, profile_id: profileIdOf(profile) };
}

/**
 * The roster the owner's words named, or what is still missing from it. Zero rows are written by
 * either answer: this only reads the registry.
 */
export function resolveRoster(registry: Registry, person: string, exclude: readonly string[], input: readonly RosterInput[] | undefined): RosterOutcome {
  const choices = eligibleWorkers(registry, person, exclude);
  if (!input || input.length === 0) {
    return { ok: false, needs: { reason: "the owner has not said who takes part", incomplete: [], choices } };
  }
  const incomplete = input.flatMap((one, index) => {
    const missing = (["worker_ref", "preset_ref", "machine_ref", "brief"] as const).filter(field => typeof one[field] !== "string" || (one[field] as string).trim() === "");
    return missing.length > 0 ? [{ index, missing: [...missing] }] : [];
  });
  if (incomplete.length > 0) {
    return { ok: false, needs: { reason: "every participant needs a worker, its preset, its machine and a brief", incomplete, choices } };
  }
  if (input.length > MAX_PARTICIPANTS) throw new ToolError("invalid_roster", `a council has at most ${MAX_PARTICIPANTS} participants`);
  const seen = new Set<string>();
  for (const one of input) {
    if (seen.has(one.worker_ref!)) {
      throw new ToolError("invalid_roster", `${one.worker_ref} is named twice: a worker runs one turn at a time, so a second seat needs a second configured worker`);
    }
    seen.add(one.worker_ref!);
  }
  const participants = input.map(one => resolveWorker(registry, person, exclude, one as Required<RosterInput>));
  if (participants.length < MIN_PARTICIPANTS) {
    throw new ToolError("invalid_roster", `a council compares at least ${MIN_PARTICIPANTS} participants`);
  }
  return { ok: true, participants };
}

/**
 * Whether a participant accepted earlier is still what the registry says now, at the moment
 * an approval is acted on. A proposal is frozen with its resolved roster, so what the owner
 * approved is what is asked for; a worker whose configuration has since changed is not
 * started under a changed name. `null` is "unchanged".
 */
export function drift(registry: Registry, person: string, exclude: readonly string[], participant: Pick<Resolved, "worker_ref" | "preset_ref" | "preset_id" | "machine"> & { profile?: EffectiveProfile | Record<string, unknown> | null; profile_id?: string | null }): string | null {
  try {
    const now = resolveWorker(registry, person, exclude, { worker_ref: participant.worker_ref, preset_ref: participant.preset_ref, machine_ref: participant.machine, brief: "x" });
    if (now.preset_id !== participant.preset_id) return "its model settings changed";
    // The rest of what was approved: the tools, instructions, MCP, runner and machine it runs with, compared by digest when the participant has one.
    if (participant.profile_id && now.profile_id !== participant.profile_id) {
      const parts = changedOf((participant.profile ?? null) as Record<string, unknown> | null, now.profile ?? null);
      return parts.length > 0 ? `its configuration changed (${parts.join(", ")})` : "its configuration changed";
    }
    return null;
  } catch (error) {
    return error instanceof ToolError ? error.message : "it is not configured any more";
  }
}
