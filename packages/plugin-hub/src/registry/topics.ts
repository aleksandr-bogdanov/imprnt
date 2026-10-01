import { wantedState } from "../os/diff.ts";
import type { ReplyRoute } from "../store/outbox.ts";
import { languageOf, listAgents, listMachines, listRunEntries, noticeRoute } from "./entries.ts";
import { loaded, type ChatAgent, type Registry, type RunEntry } from "./load.ts";

/**
 * What the registry says about topic chats, and the two answers built on it that nothing else
 * may build a second time: what a new topic chat is made with, and where a notice goes when
 * the chat it belongs to cannot take it.
 *
 * Nothing here reads a store, a platform or the clock, so a door, a hub and a tool call can all
 * ask it, and a later feature (a council's attention notice) can ask it too without importing
 * anything of the topic lifecycle.
 *
 * NO DEFAULT IS INVENTED. A machine or a preset that neither the request nor the door nor the
 * person names is a refusal that says which key is missing, never a machine somebody assumed.
 * A machine that is named but is not one this file declares, has no runner, or has two, is a
 * refusal that names it.
 */

export type ChoiceSource = "request" | "door" | "person";

/** One thing the setup was resolved to, and which of the three said so. */
export interface Chosen<T> {
  value: T;
  from: ChoiceSource;
}

export interface TopicDefaults {
  machine: Chosen<string> | null;
  preset: Chosen<string> | null;
}

/** The defaults for a topic made in one door's chats: the door's own override, else the person's. */
export function topicDefaultsFor(registry: unknown, person: string, door: string): TopicDefaults {
  const it = loaded(registry, "topicDefaultsFor");
  const owner = it.people.find(one => one.id === person);
  const entry = it.run.find(one => one.id === door && one.kind === "door");
  const pick = (own: string | undefined, theirs: string | undefined): Chosen<string> | null =>
    own !== undefined ? { value: own, from: "door" } : theirs !== undefined ? { value: theirs, from: "person" } : null;
  return {
    machine: pick(entry?.topic_machine, owner?.topic_machine),
    preset: pick(entry?.topic_preset, owner?.topic_preset),
  };
}

/**
 * This person's General, or null when they name none.
 *
 * It is the agent the person's own `general` key names and nothing else: the loader has already
 * shown it to be theirs, with a chat, and no seat. Null is a real answer, and a caller that
 * needs General and gets it says so (`attentionRoute`) rather than choosing another chat.
 */
export function generalOf(registry: unknown, person: string): ChatAgent | null {
  const it = loaded(registry, "generalOf");
  const named = it.people.find(one => one.id === person)?.general;
  if (named === undefined) return null;
  const found = it.agents.find(one => one.id === named && one.person === person);
  return found && found.chat !== undefined && found.door !== undefined ? { ...found } as ChatAgent : null;
}

/** Where a notice for this person's General goes, in the shape a notice is written with. Null without a General. */
export function generalRoute(registry: unknown, person: string): { agent: string; route: ReplyRoute; platform: string; language: "en" | "ru" } | null {
  const general = generalOf(registry, person);
  const there = general === null ? null : noticeRoute(loaded(registry, "generalRoute"), general.id);
  return general === null || there === null ? null : { agent: general.id, ...there };
}

export type AttentionRoute =
  | { ok: true; via: "origin" | "general"; agent: string; route: ReplyRoute; platform: string; language: "en" | "ru" }
  | { ok: false; cause: "general_not_configured" | "general_unusable" | "origin_unknown" };

/**
 * Where something that needs the owner is said. A chat that can take it (`originUsable`) is
 * where it goes; a chat that is archived, read only or gone is not, and then it is the person's
 * configured General. A person with no General, or whose General cannot take it either, gets a
 * named refusal and nothing is sent anywhere else: the caller keeps the matter visible where
 * it can (a finding, the operation's own record) and does not pick a chat because it happens
 * to be the person's.
 *
 * BOTH USABILITIES ARE THE CALLER'S TO MEASURE, and neither is assumed. `generalUsable` is
 * whether the configured General's CHAT can take a line said in it (it is not archived, being
 * reopened or gone), which is not whether its agent can think: a General whose model is held,
 * stopped or busy still takes a notice the door says for it. A caller that has a store asks
 * `attentionFor` (`store/topic-attention.ts`), which measures both.
 */
export function attentionRoute(registry: unknown, input: {
  person: string; origin: { door: string; chat: string } | null; originUsable: boolean; generalUsable: boolean;
}): AttentionRoute {
  const it = loaded(registry, "attentionRoute");
  const agentOf = (door: string, chat: string) => it.agents.find(one => one.person === input.person && one.door === door && one.chat === chat);
  if (input.origin !== null && input.originUsable) {
    const asked = agentOf(input.origin.door, input.origin.chat);
    const there = asked === undefined ? null : noticeRoute(it, asked.id);
    if (asked !== undefined && there !== null) return { ok: true, via: "origin", agent: asked.id, ...there };
    // A route the registry does not know for this person is not one to send to.
    return { ok: false, cause: "origin_unknown" };
  }
  const general = generalRoute(registry, input.person);
  if (general === null) return { ok: false, cause: "general_not_configured" };
  if (!input.generalUsable || (input.origin !== null && general.route.door === input.origin.door && general.route.chat === input.origin.chat)) {
    return { ok: false, cause: "general_unusable" };
  }
  return { ok: true, via: "general", ...general };
}

/** What a door says about archiving. Null when it names no category, which is a door that cannot archive. */
export function archiveOf(registry: unknown, door: string): { category: string; readonlyRoles: string[] } | null {
  const entry = loaded(registry, "archiveOf").run.find(one => one.id === door && one.kind === "door");
  if (entry?.archive_category === undefined || entry.archive_readonly_roles === undefined) return null;
  return { category: entry.archive_category, readonlyRoles: [...entry.archive_readonly_roles] };
}

/** The category a new topic chat made through this door is put under, or null for none. */
export function topicCategoryOf(registry: unknown, door: string): string | null {
  return loaded(registry, "topicCategoryOf").run.find(one => one.id === door && one.kind === "door")?.topic_category ?? null;
}

/**
 * The runner that serves a machine, and it has to be exactly one the file says is kept running:
 * an agent given to a runner nobody starts would be an agent nothing serves, and two would be a
 * choice nobody made.
 */
export function runnerOfMachine(registry: unknown, machine: string): { runner: RunEntry } | { refused: "none" | "several"; runners: string[] } {
  const found = listRunEntries(registry).filter(one => one.kind === "runner" && one.machine === machine && wantedState(one) === "running");
  if (found.length === 1) return { runner: found[0] };
  return { refused: found.length === 0 ? "none" : "several", runners: found.map(one => one.id) };
}

/** How a preset's engine reads in a preview. A name nobody gave a label is shown as it is written. */
const ENGINE_LABELS: Record<string, string> = { "claude-code": "Claude Code" };
export function engineLabel(adapter: string): string {
  return Object.hasOwn(ENGINE_LABELS, adapter) ? ENGINE_LABELS[adapter] : adapter;
}

export type SetupRefusalCode =
  | "chat_name_invalid" | "no_machines_declared" | "execution_machine_missing" | "execution_machine_unknown"
  | "execution_machine_has_no_runner" | "execution_machine_has_several_runners" | "preset_missing" | "preset_unknown";

export interface SetupRefusal {
  ok: false;
  code: SetupRefusalCode;
  message: string;
}

/** The setup as it is frozen, hashed and shown: every choice resolved and where it came from. */
export interface ResolvedSetup {
  ok: true;
  chat_name: string;
  machine: string;
  machine_from: ChoiceSource;
  runner: string;
  preset: string;
  preset_from: ChoiceSource;
  adapter: string;
  model: string;
}

/** What Discord accepts of a channel name is more than this; this is what can be shown and passed on whole. */
export const CHAT_NAME_MAX = 100;

/**
 * Resolve a topic chat's setup against the registry, or say by name why it cannot be. Explicit
 * choices win, then the door's, then the person's; nothing else is tried. It is asked BEFORE a
 * preview is frozen, so a preview is only ever of a setup that can be carried out.
 */
export function resolveTopicSetup(registry: unknown, input: {
  person: string;
  door: string;
  chat_name: string;
  execution_machine?: string;
  preset?: string;
}): ResolvedSetup | SetupRefusal {
  const it = loaded(registry, "resolveTopicSetup") as Registry;
  const refuse = (code: SetupRefusalCode, message: string): SetupRefusal => ({ ok: false, code, message });
  const name = input.chat_name.trim();
  if (name === "" || name.length > CHAT_NAME_MAX || /[\u0000-\u001f\u007f]/.test(name)) {
    return refuse("chat_name_invalid", `the chat needs a name of 1 to ${CHAT_NAME_MAX} characters on one line`);
  }
  const machines = listMachines(it);
  if (machines.length === 0) {
    return refuse("no_machines_declared", "this registry declares no [[machines]], so there is no execution machine to choose");
  }
  const defaults = topicDefaultsFor(it, input.person, input.door);
  const machine: Chosen<string> | null = input.execution_machine !== undefined
    ? { value: input.execution_machine, from: "request" } : defaults.machine;
  if (machine === null) {
    return refuse("execution_machine_missing",
      `the request names no execution machine, and neither the door ${input.door} (topic_machine) nor ${input.person} (topic_machine) has a default one`);
  }
  if (!machines.some(one => one.id === machine.value)) {
    return refuse("execution_machine_unknown",
      `${JSON.stringify(machine.value)} is not a machine this registry declares (${machines.map(one => one.id).join(", ")})`);
  }
  const served = runnerOfMachine(it, machine.value);
  if ("refused" in served) {
    return served.refused === "none"
      ? refuse("execution_machine_has_no_runner", `${machine.value} has no runner the registry keeps running, so nothing there could serve the chat`)
      : refuse("execution_machine_has_several_runners", `${machine.value} has more than one running runner (${served.runners.join(", ")}), and which one serves the chat is not chosen for you`);
  }
  const preset: Chosen<string> | null = input.preset !== undefined ? { value: input.preset, from: "request" } : defaults.preset;
  if (preset === null) {
    return refuse("preset_missing",
      `the request names no agent preset, and neither the door ${input.door} (topic_preset) nor ${input.person} (topic_preset) has a default one`);
  }
  if (!Object.hasOwn(it.presets, preset.value)) {
    return refuse("preset_unknown", `${JSON.stringify(preset.value)} is not a preset this registry defines (${Object.keys(it.presets).join(", ")})`);
  }
  const known = it.presets[preset.value];
  return {
    ok: true, chat_name: name,
    machine: machine.value, machine_from: machine.from, runner: served.runner.id,
    preset: preset.value, preset_from: preset.from, adapter: known.adapter, model: known.model,
  };
}

/** The machine a move was asked to go to, and the one runner the registry keeps running there. */
export interface ResolvedDestination {
  ok: true;
  machine: string;
  runner: string;
}

/**
 * Where a move goes: the machine the owner NAMED, and the runner that serves it. There is no default here and nothing is
 * chosen for the caller (`topic_machine` is for making a chat, not for moving one): a machine that is not declared, has no
 * running runner, or has two is a refusal that names it, with the same codes a new chat's setup uses.
 */
export function resolveMoveDestination(registry: unknown, machine: string): ResolvedDestination | SetupRefusal {
  const it = loaded(registry, "resolveMoveDestination") as Registry;
  const refuse = (code: SetupRefusalCode, message: string): SetupRefusal => ({ ok: false, code, message });
  const machines = listMachines(it);
  if (machines.length === 0) {
    return refuse("no_machines_declared", "this registry declares no [[machines]], so there is no machine to move a chat to");
  }
  if (!machines.some(one => one.id === machine)) {
    return refuse("execution_machine_unknown",
      `${JSON.stringify(machine)} is not a machine this registry declares (${machines.map(one => one.id).join(", ")})`);
  }
  const served = runnerOfMachine(it, machine);
  if ("refused" in served) {
    return served.refused === "none"
      ? refuse("execution_machine_has_no_runner", `${machine} has no runner the registry keeps running, so nothing there could take the chat over`)
      : refuse("execution_machine_has_several_runners", `${machine} has more than one running runner (${served.runners.join(", ")}), and which one takes the chat over is not chosen for you`);
  }
  return { ok: true, machine, runner: served.runner.id };
}

/** An ordinary master of one door that a topic can be made for: what the registry says it is, and nothing about a topic. */
export interface LegacyMaster {
  agent: ChatAgent;
  machine: string;
  runner: string;
  preset: string;
  adapter: string;
}

/**
 * The ordinary masters of one door: every agent of it that answers in a chat and has no role, the person's
 * configured General among them (General is an ordinary master, and nothing here treats it otherwise). A worker that
 * only takes jobs has no chat, and a triage or council seat has a role, so neither is here. An agent whose runner or
 * preset the file does not define is left out, because a topic records both. Sorted by id, so two passes agree.
 */
export function legacyMastersOf(registry: unknown, door: string): LegacyMaster[] {
  const it = loaded(registry, "legacyMastersOf");
  const found: LegacyMaster[] = [];
  for (const agent of it.agents) {
    if (agent.door !== door || agent.chat === undefined || agent.role !== undefined) continue;
    const runner = it.run.find(one => one.id === agent.runner && one.kind === "runner");
    const preset = Object.hasOwn(it.presets, agent.preset) ? it.presets[agent.preset] : undefined;
    if (!runner || !preset) continue;
    found.push({ agent: agent as ChatAgent, machine: runner.machine, runner: runner.id, preset: agent.preset, adapter: preset.adapter });
  }
  return found.sort((a, b) => (a.agent.id < b.agent.id ? -1 : 1));
}

/** Why the registry no longer binds an adopted master where its topic says it is. */
export type BindingMismatch = "agent_gone" | "person_changed" | "role_changed" | "not_eligible" | "door_changed" | "chat_changed";

/**
 * Whether the registry still binds an adopted master's topic to the route the topic says (its door and chat), as the FULL
 * eligible binding and not just as an agent id that still exists: the same person, still an ordinary master (a chat and no
 * role), with a runner and a preset the file defines, on that door and that chat. Anything else is named, and nothing watches
 * a route the registry no longer stands behind. `agent` is what the registry says the agent is now, when it names one.
 */
export function legacyBindingOf(registry: unknown, topic: { agent_id: string; person: string; door: string; chat: string | null }):
  { ok: true; master: LegacyMaster } | { ok: false; code: BindingMismatch; agent: ChatAgent | null } {
  const it = loaded(registry, "legacyBindingOf");
  const agent = it.agents.find(one => one.id === topic.agent_id);
  if (agent === undefined) return { ok: false, code: "agent_gone", agent: null };
  const said = agent.chat !== undefined && agent.door !== undefined ? agent as ChatAgent : null;
  if (agent.person !== topic.person) return { ok: false, code: "person_changed", agent: said };
  if (agent.role !== undefined) return { ok: false, code: "role_changed", agent: said };
  if (said === null) return { ok: false, code: "not_eligible", agent: null };
  if (said.door !== topic.door) return { ok: false, code: "door_changed", agent: said };
  if (said.chat !== topic.chat) return { ok: false, code: "chat_changed", agent: said };
  const master = legacyMastersOf(registry, topic.door).find(one => one.agent.id === agent.id);
  return master === undefined ? { ok: false, code: "not_eligible", agent: said } : { ok: true, master };
}

/**
 * Whether the door named here can make a chat at all, judged from what the registry says and nothing else (no
 * permission is probed): a Discord door with a guild. Anything else is named, so a preview is never shown, and never
 * approved, for a chat that could only fail as unsupported.
 */
export function canMakeChats(registry: unknown, door: string): { ok: true } | { ok: false; code: "create_unsupported"; message: string } {
  const it = loaded(registry, "canMakeChats");
  const entry = it.run.find(one => one.id === door && one.kind === "door");
  const platform = ((it.data.run ?? []) as { id: string; platform?: string }[]).find(one => one.id === door)?.platform ?? "discord";
  if (entry === undefined) return { ok: false, code: "create_unsupported", message: `the door ${door} is not in the registry, so no chat can be made through it` };
  if (platform !== "discord") {
    return { ok: false, code: "create_unsupported", message: `the door ${door} speaks ${platform}, and chats are made only through a Discord door` };
  }
  if (entry.guild === undefined) {
    return { ok: false, code: "create_unsupported", message: `the door ${door} names no guild (guild), so it can read and change a chat it is pointed at and cannot make a new one` };
  }
  return { ok: true };
}

/** The agents of a person that are topic-like masters in a chat of one door: what an archive request may name. */
export function chatAgentsOf(registry: unknown, person: string): ChatAgent[] {
  return listAgents(registry).filter((one): one is ChatAgent => one.person === person && one.chat !== undefined && one.door !== undefined);
}

/** The language a person's door lines are written in. Re-exported so a caller of this module needs one import. */
export { languageOf };
