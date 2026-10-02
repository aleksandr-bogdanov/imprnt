import { appendEntry as appendRegistryEntry, type EditValue } from "../registry/edit.ts";
import { listAgents, listRunEntries, runEntriesFor } from "../registry/entries.ts";
import { wantedState } from "../os/diff.ts";
import type { Registry } from "../registry/load.ts";
import { recordOperationFailure } from "../diagnostics.ts";
import { topicStepFailedNotice } from "../door/topic-lines.ts";
import type { StoreLike } from "../store/connect.ts";
import { attentionFor } from "../store/topic-attention.ts";
import { bindIntent, bindRefused, bound, noteAttention, readTopic, reservedKindOf, type TopicRow, type TopicSetup } from "../store/topics.ts";

/**
 * The hub's half of making a topic: writing its agent into the registry, bound to the chat the
 * door made and to the runner of the machine the owner chose. The hub is the only process that
 * writes the registry, so this is where that happens, and it is a step of its own for the reason
 * every other step is: the intent is committed BEFORE the file is edited, and a hub that dies
 * between the two finds `bind_intent` and looks at the file instead of writing again.
 *
 *  * THE RUNNER IS THE ONE THE OWNER'S MACHINE HAS, and the topic recorded it when the preview was
 *    frozen. It is not the machine this hub happens to run on, which is what `adopt` does.
 *  * WHAT WAS APPROVED IS WHAT IS BOUND. The owner approved a person, a door, a chat's agent, a
 *    machine and its runner, a preset that runs an engine and a model, and a tool profile. The
 *    binding is written only if the registry still says all of it, and an entry that is already
 *    there is accepted only if it is exactly what this bind would have written. Anything else is
 *    refused by name and nothing is overwritten: a preset that now runs another model, a runner
 *    that moved, an entry of that id that says something else. Choosing a different setup is a new
 *    request and a new approval, never a substitution made here.
 *  * THE JUDGMENT IS MADE ON THE FILE THE EDIT REPLACES. The registry this pass loaded is older
 *    than the lock the writer takes, so the same judgment is handed to the writer (`precondition`)
 *    and made there, from the bytes the edit is built from, and a change made between the two
 *    cannot slip through.
 *  * A RESERVED IDENTITY IS NEVER WRITTEN, and the store refuses the intent for one.
 *  * A REFUSED WRITE LEAVES THE TOPIC WHERE IT WAS with what was refused (a code and a cause),
 *    and is tried again no sooner than `RETRY_MS` later; the chat, its messages and the owner's
 *    first input are kept, and restoring what was approved lets the same step finish.
 */

/** How long after a refused write the same topic is looked at again. */
export const RETRY_MS = 60_000;

export interface BindContext {
  store: StoreLike;
  registryFile: string;
  /** This hub's machine: it binds only the topics of the doors it runs. */
  machine: string;
  /** The registry as it is now. May throw for a file caught half written, and then nothing is bound this pass. */
  load: () => Registry;
  now?: () => number;
}

const clock = (ctx: BindContext): number => (ctx.now ?? Date.now)();

/** Bind every topic of this machine's doors that has its channel and is waiting for its agent. */
export async function bindTopics(ctx: BindContext): Promise<void> {
  const registry = ctx.load();
  const doors = new Set(runEntriesFor(registry, ctx.machine).filter(one => one.kind === "door").map(one => one.id));
  if (doors.size === 0) return;
  const rows = (await ctx.store.sql`select id, door from topic where create_state in ('channel_known', 'bind_intent') order by created_at, id`) as unknown as { id: string; door: string }[];
  for (const row of rows) {
    if (!doors.has(row.door)) continue;
    try {
      await bindOne(ctx, registry, row.id);
    } catch (error) {
      // An identity that is reserved is said by name, once, where an operator reads it; nothing is written for it.
      await recordOperationFailure(ctx.store, { operation: reservedKindOf(error) === null ? "topic-bind" : "topic-bind-reserved", target: row.id, error });
    }
  }
}

async function bindOne(ctx: BindContext, registry: Registry, id: string): Promise<void> {
  let topic = await readTopic(ctx.store, id);
  if (topic === null) return;
  if (topic.create_state === "channel_known") {
    const failedAt = topic.create_failure?.at;
    const at = typeof failedAt === "string" ? Date.parse(failedAt) : Number.NaN;
    if (Number.isFinite(at) && at + RETRY_MS > clock(ctx)) return;
    if ((await bindIntent(ctx.store, topic.id)) !== "bind_intent") return;
    topic = await readTopic(ctx.store, id);
    if (topic === null) return;
  }
  if (topic.create_state !== "bind_intent") return;

  const refusal = await writeAgent(ctx, topic);
  if (refusal === null) {
    await bound(ctx.store, topic.id, { at: new Date(clock(ctx)).toISOString() });
    return;
  }
  const first = topic.create_failure === null;
  // A notice that had nowhere to go is tried again on the next look, and one that was said is not said twice (its key is once).
  const unsaid = (topic.create_evidence.attention as Record<string, unknown> | undefined)?.["bind-failed"] !== undefined;
  // The refusal is kept with its code, and what the last try found replaces what the one before found.
  await bindRefused(ctx.store, topic.id, { step: "binding", cause: refusal.cause, code: refusal.code, at: new Date(clock(ctx)).toISOString() });
  if (first || unsaid) await tell(ctx, registry, topic, refusal.cause);
}

/** Why a binding is not written, by a code a check can compare and a cause a person can read. */
export interface BindRefusal {
  code: string;
  cause: string;
}

export type BindVerdict = { verdict: "write" } | { verdict: "present" } | ({ verdict: "refused" } & BindRefusal);

/** The entry a bind writes, and so the only entry that already being there counts as the write having landed. */
export function agentBlockOf(topic: TopicRow): Record<string, EditValue> {
  const setup = topic.setup as Partial<TopicSetup>;
  return {
    id: topic.agent_id, person: topic.person, preset: topic.preset, chat: topic.chat as string, door: topic.door, runner: topic.runner,
    ...(setup.tool_profile && setup.tool_profile.length > 0 ? { tools: setup.tool_profile } : {}),
  };
}

const CHANGED = "approved setup changed";

/**
 * Whether the registry, as this one says it, still carries out what the owner approved for this topic:
 * `write` (it does, and the agent is not there), `present` (it does, and the agent is there exactly as
 * this bind would have written it) or `refused` with the code and the cause. PURE: it is asked of the
 * registry the writer holds its lock on, and of any other a caller wants judged.
 */
export function bindingVerdict(registry: Registry, topic: TopicRow): BindVerdict {
  const setup = topic.setup as Partial<TopicSetup>;
  const refuse = (code: string, cause: string): BindVerdict => ({ verdict: "refused", code, cause });
  if (topic.chat === null) return refuse("chat_unknown", "invalid configuration");
  // What the store keeps and what was approved are one thing. They part only if somebody changed a row by hand.
  if (setup.person !== topic.person || setup.door !== topic.door || setup.agent_id !== topic.agent_id || setup.machine !== topic.machine
    || setup.runner !== topic.runner || setup.preset !== topic.preset) {
    return refuse("setup_inconsistent", `${CHANGED}: what the topic holds is not what was approved`);
  }
  // The preset is bound by name, and what the owner saw was the engine and the model it named then.
  const preset = Object.hasOwn(registry.presets, topic.preset) ? registry.presets[topic.preset] : undefined;
  if (preset === undefined) return refuse("preset_unknown", `${CHANGED}: the preset ${topic.preset} is not defined any more`);
  if (preset.adapter !== setup.adapter || preset.model !== setup.model) {
    return refuse("preset_changed", `${CHANGED}: the preset ${topic.preset} now runs ${preset.adapter} (${preset.model}) and ${String(setup.adapter)} (${String(setup.model)}) was approved`);
  }
  // A setup approved with a provider (a preset on a model key) is approved for THAT provider: the same model
  // behind another one is a different route for the owner's messages.
  if (setup.provider !== undefined && preset.provider !== setup.provider) {
    return refuse("preset_changed", `${CHANGED}: the preset ${topic.preset} now runs on ${preset.provider} and ${setup.provider} was approved`);
  }
  const runs = listRunEntries(registry);
  const door = runs.find(one => one.id === topic.door && one.kind === "door");
  if (!door) return refuse("door_unknown", "invalid configuration");
  if (door.person !== undefined && door.person !== topic.person) return refuse("door_person", `${CHANGED}: the door ${topic.door} is another person's now`);
  const runner = runs.find(one => one.id === topic.runner && one.kind === "runner");
  // The machine the owner chose is one whose runner the file still keeps running: an agent given to a runner nobody starts serves nothing.
  if (!runner || runner.machine !== topic.machine) return refuse("machine_changed", `${CHANGED}: ${topic.runner} is not a runner of ${topic.machine} any more`);
  if (wantedState(runner) !== "running") return refuse("runner_not_running", "invalid configuration");

  const present = (registry.data.agents as Record<string, unknown>[] | undefined)?.find(one => one.id === topic.agent_id);
  if (present !== undefined) {
    // The write landed before it was recorded, or somebody made this id by hand: only the first is this bind's to accept.
    const wanted = agentBlockOf(topic);
    const parts = new Set([...Object.keys(wanted), ...Object.keys(present)]);
    const differs = [...parts].filter(key => !Bun.deepEquals(JSON.parse(JSON.stringify(wanted[key] ?? null)), JSON.parse(JSON.stringify(present[key] ?? null)))).sort();
    return differs.length === 0 ? { verdict: "present" }
      : refuse("binding_conflict", `${CHANGED}: an agent ${topic.agent_id} is in the registry and differs in ${differs.join(", ")}`);
  }
  // Two agents of one door in one chat would both answer every message in it.
  if (listAgents(registry).some(one => one.door === topic.door && one.chat === topic.chat)) return refuse("chat_taken", "invalid configuration");
  return { verdict: "write" };
}

/**
 * Put the agent in the registry, or find that it already is. Null is bound; anything else is the
 * refusal, and nothing has been written for it. The judgment is made twice on purpose: never
 * by this function, but by the writer, on the file it holds the lock on.
 */
async function writeAgent(ctx: BindContext, topic: TopicRow): Promise<BindRefusal | null> {
  const held: { refusal: BindRefusal | null } = { refusal: null };
  try {
    await appendRegistryEntry(ctx.registryFile, "agents", agentBlockOf(topic), {
      precondition: (locked) => {
        const verdict = bindingVerdict(locked, topic);
        if (verdict.verdict === "refused") {
          held.refusal = { code: verdict.code, cause: verdict.cause };
          return { ok: false, reason: verdict.cause };
        }
        return { ok: true, present: verdict.verdict === "present" };
      },
    });
  } catch (error) {
    if (held.refusal !== null) return held.refusal;
    // A file that would not take the edit is left as it was. What it said is for the diary, and a person is told it failed.
    await recordOperationFailure(ctx.store, { operation: "topic-bind", target: topic.id, error });
    return { code: "operation_failed", cause: "operation failed" };
  }
  return null;
}

/** Say once where the setup was asked for that the agent could not be connected, or record that there is nowhere to say it. */
async function tell(ctx: BindContext, registry: Registry, topic: TopicRow, cause: string): Promise<void> {
  const origin = (topic.setup as Partial<TopicSetup>).origin ?? null;
  const route = await attentionFor(ctx.store, registry, { person: topic.person, origin: origin === null ? null : { door: origin.door, chat: origin.chat } });
  if (!route.ok) {
    await noteAttention(ctx.store, topic.id, "bind-failed", route.cause);
    return;
  }
  // The notice and the fact that it was queued commit together, so a gap is cleared only by the commit that queued the notice.
  await ctx.store.sql.begin(async (sql) => {
    const tx: StoreLike = { ...ctx.store, sql: sql as unknown as StoreLike["sql"] };
    await tx.sql`select hub_door_notice(${topic.person}, ${route.agent},
      ${topicStepFailedNotice(route.language, { platform: route.platform, name: topic.display_name, chat: topic.chat, step: "binding", cause })},
      ${`topic:bind-failed:${topic.id}`}, ${route.route}::jsonb, 1)`;
    await noteAttention(tx, topic.id, "bind-failed", null);
  });
}
