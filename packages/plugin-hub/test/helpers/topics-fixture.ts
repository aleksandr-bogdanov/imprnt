// Test infrastructure: a stage for topic chats, built on the effect fixture.
//
// The store, the door's own topic task, the confirmation poll and the Discord seam are the
// real thing; only the network behind the seam is the fake Discord (`fake-discord-rest.ts`).
// What is PLANTED, and decides nothing the code under test decides: the owner's messages
// (as the door writes them), and, for the archive checks, the attempts a runner would have
// opened. A "restart" is a new memory for the topic task over the same database and the same
// fake Discord. "Time" is the fake Discord's clock.
//
// The registry is a real file the loader really loaded: two machines (a Pi and a Mac, each with
// a runner), one person who allows one sender, a General agent, and a Discord door with the
// archive mapping. A check that is about a missing or a wrong setting rewrites it.

import { dirname } from "node:path";
import { pollConfirmations } from "../../src/door/confirm.ts";
import type { Platform } from "../../src/door/platform.ts";
import { newTopicsMemory, runTopicPass, startTopics, type TopicsContext, type TopicsMemory, type TopicsTask } from "../../src/door/topic-task.ts";
import type { Store } from "../../src/store/connect.ts";
import { listenForWork } from "../../src/store/listen.ts";
import { topicApprovals } from "../../src/door/topic-approval.ts";
import { callTool, type McpBinding } from "../../src/mcp/handlers.ts";
import { loadRegistry, type Registry } from "../../src/registry/load.ts";
import { readOperation } from "../../src/store/confirmations.ts";
import { readEffects } from "../../src/store/effects.ts";
import { conversationFor } from "../../src/store/conversations.ts";
import { writeRegistry } from "./authorized-registry.ts";
import type { Cluster } from "./cluster.ts";
import { DOOR, OWNER, PERSON, pass, stageEffects, type EffectsStage } from "./effects-fixture.ts";
import { CHECK } from "./fake-discord-rest.ts";
import type { AgentSpec, PersonSpec, PresetSpec, RegistrySpec, RunSpec } from "./registry.ts";

export { DOOR, OWNER, PERSON };
export const GENERAL = "p1-general";
export const RUNNER_PI = "runner-pi";
export const RUNNER_MAC = "runner-mac";
/** A person who is not the owner, and who is not on the allow list. */
export const STRANGER = "100000000000000777";

export interface TopicsOptions {
  /** Changes to the person's entry. A key set to `undefined` is left out of the file. */
  person?: Partial<PersonSpec>;
  /** Changes to the door's entry. */
  door?: Partial<RunSpec>;
  /**
   * Doors beyond the first, by id, each with the same server, archive category and read-only role as the first (a registry edit
   * that puts an agent behind another door needs one). The topic task of one is run with `topicPass({ door })`.
   */
  moreDoors?: string[];
  /** Agents beyond General. */
  agents?: AgentSpec[];
  /** Leave the General agent out of the file altogether (a person who has no such chat; pair it with `person: { general: undefined }`). */
  withoutGeneralAgent?: boolean;
  /** Changes to a runner's entry, by its id. */
  runner?: Record<string, Partial<RunSpec>>;
  /** Changes to a preset, by its name (`daily` and `fast` exist). A preset the file does not have is added. */
  presets?: Record<string, Partial<PresetSpec>>;
  /** Changes to the `[hub]` table (`store_machine`, for a registry whose copies are measured against one machine's). */
  hub?: Record<string, string | number>;
}

export interface TopicsStage extends EffectsStage {
  dir: string;
  registryFile: string;
  /** The General chat, and the archive category and the role that is made read only in it. */
  general: string;
  archive: string;
  everyone: string;
  load(): Registry;
  /** Write the registry again with these changes, and load it from now on. */
  rewrite(options: TopicsOptions): Registry;
  /** The owner said something in a chat, as the door would have written it. Returns the inbound row's id. */
  said(text: string, over?: { agent?: string; chat?: string; sender?: string }): Promise<string>;
  /** The master conversation of an agent, as the runner binds it for the tool. */
  binding(agent?: string): Promise<McpBinding>;
  /** One call of the hub tool as that master, citing a fresh message of the owner's. */
  ask(binding: McpBinding, args: Record<string, unknown>, said?: string): Promise<Record<string, unknown>>;
  /** The topic task's context, over this door. */
  topicsContext(over?: Partial<TopicsContext>): TopicsContext;
  /** One pass of the topic task, with the memory this stage keeps (a restart is `restart()`). */
  topicPass(over?: Partial<TopicsContext>): Promise<number | null>;
  restart(): TopicsMemory;
  /**
   * The topic task as the shipped door runs it: one loop that rests with no timer, on a connection of its own, woken only by the
   * notification the store sends the door (`hub_project`, payload `topic:<door>`). Nothing in a check that uses it calls a pass.
   * `stop` ends the task and its listener, and a check that starts one stops it before it ends.
   */
  idleTask(options?: { platform?: Platform }): Promise<{ task: TopicsTask; stop(): Promise<void> }>;
  /** Deliver everything asked for (the preview parts, the status line), one pass. */
  deliver(over?: Partial<TopicsContext>): Promise<void>;
  /** The message a reaction is read from: the last part of the newest preview of an operation. */
  confirmationMessage(operation: string): Promise<string>;
  /** One poll of the pending previews, with the topic's approval registered as the shipped door registers it. */
  poll(): Promise<void>;
  /** The owner (or another user, or a bot) reacts with the check on the newest preview of an operation, and one poll is made. */
  react(operation: string, user?: string, options?: { bot?: boolean }): Promise<void>;
  /** The messages of a channel, as text. */
  texts(chat: string): string[];
}

export async function stageTopics(cluster: Cluster, options: TopicsOptions = {}): Promise<TopicsStage> {
  let current: unknown = null;
  const base = await stageEffects(cluster, { registry: () => current });
  const dir = dirname(base.tokenFile);
  const general = base.fake.addChannel({ name: "general" });
  const archive = base.fake.addChannel({ name: "archive", type: 4 });
  const everyone = base.fake.guild;
  let memory = newTopicsMemory();
  let counter = 0;
  let file = "";

  const write = (over: TopicsOptions): Registry => {
    // The owner is the person's one declared sender: the confirmation evidence checks read exactly this list.
    const person: PersonSpec = {
      id: PERSON, allowed_senders: { [DOOR]: [OWNER] }, topic_machine: "pi", topic_preset: "daily", general: GENERAL,
      language: "en", ...over.person,
    };
    const presets: Record<string, PresetSpec> = {
      daily: { adapter: "synthetic", model: "m-daily", provider: "p", effort: "medium", paid: "plan" },
      fast: { adapter: "synthetic", model: "m-fast", provider: "p", effort: "low", paid: "plan" },
    };
    for (const [name, patch] of Object.entries(over.presets ?? {})) presets[name] = { ...presets[name], ...patch };
    const spec: RegistrySpec = {
      hub: { state_dir: dir, ...over.hub },
      machines: [{ id: "pi", os: "linux" }, { id: "mac", os: "macos" }],
      people: [person],
      presets,
      agents: [
        ...(over.withoutGeneralAgent ? [] : [{ id: GENERAL, person: PERSON, preset: "daily", chat: general, door: DOOR, runner: RUNNER_PI }]),
        ...(over.agents ?? []),
      ],
      run: [
        { id: DOOR, kind: "door", machine: "pi", platform: "discord", person: PERSON, token_file: "/dev/null", schedule: "always",
          memory_limit_mb: 192, guild: base.fake.guild, archive_category: archive, archive_readonly_roles: [everyone], ...over.door },
        ...(over.moreDoors ?? []).map((id): RunSpec => ({ id, kind: "door", machine: "pi", platform: "discord", person: PERSON, token_file: "/dev/null",
          schedule: "always", memory_limit_mb: 192, guild: base.fake.guild, archive_category: archive, archive_readonly_roles: [everyone], ...over.door })),
        { id: RUNNER_PI, kind: "runner", machine: "pi", schedule: "always", memory_limit_mb: 512, child_memory_limit_mb: 2048, ...over.runner?.[RUNNER_PI] },
        { id: RUNNER_MAC, kind: "runner", machine: "mac", schedule: "always", memory_limit_mb: 512, child_memory_limit_mb: 2048, ...over.runner?.[RUNNER_MAC] },
      ],
    };
    file = writeRegistry(dir, spec);
    const loaded = loadRegistry(file);
    current = loaded;
    return loaded;
  };
  write(options);

  const stage: TopicsStage = {
    ...base,
    dir,
    get registryFile() { return file; },
    general,
    archive,
    everyone,
    load: () => loadRegistry(file),
    rewrite: (over) => write(over),
    async said(text, over = {}) {
      const id = `owner-${++counter}`;
      await base.admin`insert into inbound (id, person, agent, body, kind, source) values (${id}, ${PERSON}, ${over.agent ?? GENERAL}, ${text}, 'human',
        ${{ log_id: id, at: new Date().toISOString(), door: DOOR, chat: over.chat ?? general, sender_id: over.sender ?? OWNER, text }}::jsonb)`;
      return id;
    },
    async binding(agent = GENERAL) {
      const first = await stage.said("hello", { agent });
      const store = base.as("hub_runner");
      const conversation = await conversationFor(store, { row: { id: first, person: PERSON, agent, kind: "human" }, adapter: "synthetic", machine: "pi" });
      return { store, person: PERSON, agent, conversation: conversation.id, kind: "master", registry: () => loadRegistry(file), attempt: () => null };
    },
    async ask(binding, args, said) {
      const source = said ?? await stage.said(`asked: ${JSON.stringify(args).slice(0, 40)}`, { agent: binding.agent });
      const withEvidence = args.action === "inspect" ? args : { request_key: `k-${++counter}`, source_message_ids: [source], ...args };
      return await callTool(binding, "hub_topic", withEvidence) as Record<string, unknown>;
    },
    topicsContext: (over = {}) => ({
      store: base.as("hub_door"), platform: base.platform(), door: DOOR, retrySeconds: 30, maxAttempts: 3, now: base.fake.now,
      registry: () => loadRegistry(file), stateDir: dir, pollSeconds: 30, tickMs: 1000, ...over,
    }),
    topicPass: (over) => runTopicPass(stage.topicsContext(over), memory),
    restart() { memory = newTopicsMemory(); return memory; },
    async idleTask(options = {}) {
      const store = { ...base.fresh("hub_door"), close: async () => {} } as unknown as Store;
      let task: TopicsTask | undefined;
      // Listening before the first pass, as the door does, so nothing committed in between is missed.
      const listener = await listenForWork({ url: store.url, channel: "hub_project", onNotify: (payload) => { if (payload === `topic:${DOOR}`) task?.wake(); } });
      task = startTopics({ store, platform: options.platform ?? base.platform(), door: DOOR, registry: () => loadRegistry(file), stateDir: dir,
        settings: () => ({ retrySeconds: 30, maxAttempts: 3, pollSeconds: 30 }), tickMs: 1000 });
      await task.ready;
      const started = task;
      return { task: started, async stop() { await started.stop(); await listener.close(); } };
    },
    async deliver(over) {
      await pass(base.context({ registry: () => loadRegistry(file), ...(over ?? {}) } as never), base.gate());
    },
    async confirmationMessage(operation) {
      const rows = await readOperation(base.as("hub_hub"), operation);
      const parts = await readEffects(base.as("hub_hub"), rows[rows.length - 1].effect_keys);
      return parts[parts.length - 1].platform_id!;
    },
    async poll() {
      await pollConfirmations(base.context({ hooks: topicApprovals(), registry: () => loadRegistry(file) }), base.gate());
    },
    async react(operation, user = OWNER, reaction = {}) {
      base.fake.react(general, await stage.confirmationMessage(operation), CHECK, user, reaction.bot === true);
      await stage.poll();
    },
    texts: (chat) => base.fake.messagesIn(chat).map(one => one.content),
  };
  return stage;
}
