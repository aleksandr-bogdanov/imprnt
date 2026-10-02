import { NATIVE_DELEGATION_TOOLS } from "../adapters/launch.ts";
import { deletionConfirmationAsk, deletionPreview } from "../door/deletion-lines.ts";
import { TOPIC_CREATE, TOPIC_DELETE } from "../door/topic-approval.ts";
import { topicConfirmationAsk, topicPreview } from "../door/topic-lines.ts";
import { RetentionInvalid, retentionDaysOf, retentionStatement } from "../erasure/retention.ts";
import { languageOf, listAgents, listRunEntries } from "../registry/entries.ts";
import { archiveOf, canMakeChats, generalOf, resolveTopicSetup } from "../registry/topics.ts";
import { ConfirmationRefused, freezeConfirmation, readOperation } from "../store/confirmations.ts";
import type { StoreLike } from "../store/connect.ts";
import { DELETION_SCHEMA_VERSION, deletionOfTopicOrAgent, deletionSchemaReady, readDeletion, requestDeletion, type DeletionRow } from "../store/deletions.ts";
import { EffectTooLong, sanitizeText } from "../store/effects.ts";
import { openMoveOfTopic } from "../store/moves.ts";
import {
  IdentityReserved, allocateTopic, attentionGapsOf, decideCreation, linkLegacyTopic, readTopic, readTopicByAgent, requestTransition, reviseTopic,
  runnerLive, type TopicRow, type TopicSetup,
} from "../store/topics.ts";
import { servingOf } from "../store/topic-serving.ts";
import {
  HUB_TOPIC, type ArchiveRequest, type CreateRequest, type DeleteRequest, type InspectRequest, type LifecycleRequest, type ReopenRequest, type ToolReply,
} from "./contracts.ts";
import type { McpBinding } from "./handlers.ts";
import { lineContext } from "./move-general.ts";
import { moveStanding } from "./move-standing.ts";
import { Undo, operationFor, refusal, requireMaster, runRequest } from "./requests.ts";

/**
 * The hub tool's topic chat actions: `create`, `archive`, `reopen`, and what `inspect` says of a
 * topic (`move` is `topic-move.ts`, which asks `topicFor` of this file and `moveStanding` of `move-standing.ts`). Each is a few lines around `runRequest`, which owns the request key, the owner's own
 * messages as evidence and the answer that is recorded once; what is here is what a topic's
 * request means.
 *
 * NO ACTION HERE CAN CONFIRM ANYTHING. `create` freezes an exact preview and says it is waiting for
 * the owner: the topic is confirmed by the door, from a reaction it read from the owner, in the
 * same transaction as the approval, and there is no argument, field or action that says
 * "approved". `archive` and `reopen` are the owner's explicit request and carry no confirmation of
 * their own, which is what the owner ruled; they need the owner's own words as evidence, and
 * they act on a topic only from its own chat or from the person's General.
 *
 * WHAT A MODEL WRITES IS NOT TRUSTED FOR WHAT CODE CAN CHECK. The machine and the preset are
 * resolved against the registry, so a name it invented is a refusal; the person, the door and
 * the chat the preview is shown in are the binding's; who may confirm is the sender of the
 * owner's message it cited. Code cannot check that the words mean what it says they mean, and
 * nothing pretends to.
 */

const describe = (topic: Pick<TopicRow, "create_state" | "lifecycle">): string =>
  topic.lifecycle === "pending" ? topic.create_state.replace(/_/g, " ") : topic.lifecycle.replace(/_/g, " ");

/** The name a tool is given as its own (a tool a delegation is made through is not a working tool of a chat). */
const toolName = (tool: string): string => tool.split("(")[0].trim();

// ---------------------------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------------------------

interface CreateContext {
  /** The topic being corrected, or null for a new one. */
  topic: TopicRow | null;
  revision: number | null;
}

export async function createTopic(binding: McpBinding, request: CreateRequest): Promise<ToolReply> {
  requireMaster(binding, "ask for a topic chat");
  if (request.creation_decision !== undefined) return await decideOnCreation(binding, request);
  const setup = request.setup!;
  return await runRequest<CreateRequest, CreateContext>(binding, {
    tool: HUB_TOPIC,
    request,
    object: request.topic_id ?? null,
    async open(tx) {
      if (request.topic_id === undefined) return { context: { topic: null, revision: null } };
      const topic = await readTopic(tx, request.topic_id);
      if (!topic || topic.person !== binding.person || topic.origin !== "created" || topic.operation_id === null) {
        throw new Undo(refusal(request.topic_id, "unknown_topic", "no topic chat of this person is being set up under that id"));
      }
      if (topic.create_state !== "previewed") {
        throw new Undo(refusal(topic.id, "closed", `this chat is ${describe(topic)}: a preview that was approved or acted on is not corrected, and a change is a new request`));
      }
      const standing = (await readOperation(tx, topic.operation_id)).at(-1);
      if (!standing || request.expected_revision !== standing.revision) {
        throw new Undo(refusal(topic.id, "stale_revision", `the preview that stands is revision ${standing?.revision ?? "?"}: correct that one, or ask again for a new chat`));
      }
      const [made] = (await tx.sql`select created_at::text as created_at from confirmation where id = ${standing.id}`) as unknown as { created_at: string }[];
      // The owner's correction is newer than the preview it corrects, compared by the database with the microseconds the row holds.
      return { context: { topic, revision: standing.revision }, since: { at: made.created_at, what: "the preview it corrects" } };
    },
    async apply(tx, context, owner) {
      const registry = binding.registry();
      const me = listAgents(registry).find(one => one.id === binding.agent);
      if (!me || me.door === undefined || me.chat === undefined) {
        throw new Undo(refusal(null, "no_chat", "this conversation's agent has no chat in which a preview can be shown"));
      }
      if (owner.sender === "") throw new Undo(refusal(null, "source_invalid", "the owner's message is what says who confirms"));
      // A door that is known not to be able to make a chat is refused BEFORE a preview is frozen, from the registry alone
      // (no permission is probed): a preview that could only fail as unsupported would still be shown, and approved.
      const capable = canMakeChats(registry, me.door);
      if (!capable.ok) throw new Undo(refusal(context.topic?.id ?? null, capable.code, capable.message));
      const resolved = resolveTopicSetup(registry, { person: binding.person, door: me.door, chat_name: setup.chat_name,
        execution_machine: setup.execution_machine, preset: setup.preset });
      if (!resolved.ok) throw new Undo(refusal(context.topic?.id ?? null, resolved.code, resolved.message));
      const request_text = sanitizeText(setup.initial_request);
      if (request_text === "") throw new Undo(refusal(context.topic?.id ?? null, "initial_request_empty", "the message the new agent is given has no text"));
      const tools = setup.tool_profile === undefined ? undefined : [...new Set(setup.tool_profile.map(one => one.trim()))];
      if (tools !== undefined && tools.some(one => one === "" || NATIVE_DELEGATION_TOOLS.includes(toolName(one)))) {
        throw new Undo(refusal(context.topic?.id ?? null, "tool_profile_refused", "a tool profile names working tools, and never one that delegates work: delegation goes through this tool"));
      }
      const language = languageOf(registry, binding.person);
      const platform = ((registry.data.run ?? []) as { id: string; platform?: string }[]).find(one => one.id === me.door)?.platform ?? "discord";
      // Only the three identities go into what is frozen and approved: not the native session and not the marker.
      const build = (identity: { topic_id: string; agent_id: string; conversation_id: string }): TopicSetup => ({
        topic_id: identity.topic_id, agent_id: identity.agent_id, conversation_id: identity.conversation_id,
        person: binding.person, door: me.door!, chat_name: resolved.chat_name,
        machine: resolved.machine, machine_from: resolved.machine_from, runner: resolved.runner,
        preset: resolved.preset, preset_from: resolved.preset_from, adapter: resolved.adapter, model: resolved.model,
        initial_request: request_text, ...(tools === undefined ? {} : { tool_profile: tools }),
        origin: { door: me.door!, chat: me.chat!, agent: me.id }, requested_by: owner.sender,
      });

      let topic: TopicRow;
      let operation: string;
      try {
        if (context.topic === null) {
          operation = operationFor(binding, request);
          topic = await allocateTopic(tx, { operation, person: binding.person, door: me.door, display_name: resolved.chat_name,
            machine: resolved.machine, runner: resolved.runner, preset: resolved.preset, adapter: resolved.adapter, setup: build });
        } else {
          topic = context.topic;
          operation = topic.operation_id!;
          await reviseTopic(tx, { operation, display_name: resolved.chat_name, machine: resolved.machine, runner: resolved.runner,
            preset: resolved.preset, adapter: resolved.adapter,
            setup: build({ topic_id: topic.id, agent_id: topic.agent_id, conversation_id: topic.conversation_id }) });
          topic = (await readTopic(tx, topic.id))!;
        }
      } catch (error) {
        if (error instanceof IdentityReserved) throw new Undo(refusal(null, "identity_unavailable", "a new identity for the chat could not be allocated"));
        throw error;
      }

      let frozen: Awaited<ReturnType<typeof freezeConfirmation>>;
      try {
        frozen = await freezeConfirmation(tx, {
          operationId: operation, operationKind: TOPIC_CREATE, person: binding.person, door: me.door, chat: me.chat,
          ownerSender: owner.sender, payload: topic.setup,
          preview: topicPreview(language, { chat_name: resolved.chat_name, machine: resolved.machine, adapter: resolved.adapter,
            model: resolved.model, ...(resolved.provider === undefined ? {} : { provider: resolved.provider }),
            initial_request: request_text, ...(tools === undefined ? {} : { tool_profile: tools }) }),
          confirmation: topicConfirmationAsk(language), platform,
          ...(context.revision === null ? {} : { replace: { revision: context.revision } }),
        });
      } catch (error) {
        if (error instanceof EffectTooLong) throw new Undo(refusal(topic.id, "request_too_long", "the request does not fit in a preview message with its confirmation line"));
        if (error instanceof ConfirmationRefused) {
          throw new Undo(refusal(topic.id, error.code === "stale-replacement" ? "stale_revision" : "closed", "this preview cannot be changed any more"));
        }
        throw error;
      }
      return {
        operation_id: operation, object_id: topic.id, revision: frozen.revision, status: "awaiting_confirmation", stage: "preview",
        status_message: "The preview is in this chat, and nothing has been created. The chat is made only when the owner reacts to it with the green check. " +
          "Tell the owner what it shows, including the execution machine and agent it resolved to.",
        setup: {
          chat: resolved.chat_name,
          execution_machine: { value: resolved.machine, from: resolved.machine_from },
          agent: { preset: resolved.preset, from: resolved.preset_from, engine: resolved.adapter, model: resolved.model },
          ...(tools === undefined ? {} : { tools }),
        },
      } satisfies ToolReply;
    },
  });
}

/** An explicit decision about a chat that could not be made or found: adopt a channel the owner names, or ask for it to be made again. */
async function decideOnCreation(binding: McpBinding, request: CreateRequest): Promise<ToolReply> {
  const decision = request.creation_decision!;
  return await runRequest<CreateRequest, TopicRow>(binding, {
    tool: HUB_TOPIC,
    request,
    object: request.topic_id!,
    async open(tx) {
      const topic = await readTopic(tx, request.topic_id!);
      if (!topic || topic.person !== binding.person || topic.origin !== "created") {
        throw new Undo(refusal(request.topic_id!, "unknown_topic", "no topic chat of this person is being set up under that id"));
      }
      if (topic.create_state !== "creation_unknown" && topic.create_state !== "failed") {
        throw new Undo(refusal(topic.id, "closed", `this chat is ${describe(topic)}, and there is nothing to decide about its creation`));
      }
      return { context: topic };
    },
    async apply(tx, topic, owner) {
      const state = await decideCreation(tx, topic.id, decision.choice, owner.sender,
        { ...(decision.chat === undefined ? {} : { chat: decision.chat }), proof: { request_key: request.request_key, messages: request.source_message_ids } });
      return {
        operation_id: null, object_id: topic.id, revision: null, status: decision.choice === "recreate" ? "queued" : "accepted",
        stage: decision.choice === "recreate" ? "create_again" : "adopt_named_channel", cause: state,
        status_message: decision.choice === "recreate"
          ? "Recorded. The chat will be asked for again, once. The earlier request may still turn out to have made one: look for a duplicate."
          : "Recorded. The door will read that channel and use it only if it exists and is not another topic's.",
      };
    },
  });
}

// ---------------------------------------------------------------------------------------------
// archive and reopen
// ---------------------------------------------------------------------------------------------

/**
 * The topic a request is about: the id it names (a topic's, or a chat agent's), or this
 * conversation's own. An adopted master that has no topic yet is given one, once, keeping the
 * conversation it already has: that is what "legacy master linkage" is, and a reserved identity
 * is refused there too.
 */
export async function topicFor(tx: StoreLike, binding: McpBinding, named: string | undefined): Promise<TopicRow> {
  const registry = binding.registry();
  const wanted = named ?? binding.agent;
  let topic = (await readTopic(tx, wanted)) ?? (await readTopicByAgent(tx, wanted));
  if (topic === null) {
    const agent = listAgents(registry).find(one => one.id === wanted);
    if (agent && agent.person === binding.person && agent.chat !== undefined && agent.door !== undefined && agent.role === undefined) {
      const runner = listRunEntries(registry).find(one => one.id === agent.runner && one.kind === "runner");
      const preset = registry.presets[agent.preset];
      if (runner && preset) {
        try {
          topic = await linkLegacyTopic(tx, { person: agent.person, agent: agent.id, door: agent.door, chat: agent.chat,
            machine: runner.machine, runner: runner.id, preset: agent.preset, adapter: preset.adapter, display_name: agent.id });
        } catch (error) {
          if (error instanceof IdentityReserved) throw new Undo(refusal(null, "identity_reserved", "that agent id was retired and is not used again"));
          throw error;
        }
      }
    }
  }
  if (topic === null || topic.person !== binding.person) throw new Undo(refusal(null, "unknown_topic", "no topic chat of this person has that id"));
  // Only that topic's own chat, or this person's General, may ask: never another chat of theirs because it looks like one.
  const general = generalOf(registry, binding.person);
  if (topic.agent_id !== binding.agent && general?.id !== binding.agent) {
    throw new Undo(refusal(topic.id, "not_permitted", "only that topic's own chat or this person's General can ask for this"));
  }
  return topic;
}

async function lifecycle(binding: McpBinding, request: LifecycleRequest): Promise<ToolReply> {
  requireMaster(binding, `${request.action} a topic chat`);
  return await runRequest<LifecycleRequest, TopicRow>(binding, {
    tool: HUB_TOPIC,
    request,
    object: request.topic_id ?? null,
    async open(tx) {
      const topic = await topicFor(tx, binding, request.topic_id);
      if (request.expected_revision !== undefined && request.expected_revision !== topic.lifecycle_generation) {
        throw new Undo(refusal(topic.id, "stale_revision", `the topic is at revision ${topic.lifecycle_generation}, and this asked about ${request.expected_revision}`));
      }
      return { context: topic };
    },
    async apply(tx, topic, owner) {
      const registry = binding.registry();
      if (request.action === "archive" && archiveOf(registry, topic.door) === null) {
        throw new Undo(refusal(topic.id, "archive_not_configured",
          "this chat's door names no archive category and no roles to make read only, so nothing can be archived through it: that is a setting the owner adds to the registry"));
      }
      const me = listAgents(registry).find(one => one.id === binding.agent);
      const operation = operationFor(binding, request);
      const answer = await requestTransition(tx, {
        operation, topic: topic.id, kind: request.action, source: "tool", by: owner.sender,
        route: me && me.door !== undefined && me.chat !== undefined ? { door: me.door, chat: me.chat } : null,
        evidence: { request_key: request.request_key, messages: request.source_message_ids, conversation: binding.conversation },
      });
      const base = { operation_id: operation, object_id: topic.id, revision: topic.lifecycle_generation + 1 };
      switch (answer) {
        case "ok":
        case "replay":
          return request.action === "archive"
            ? { ...base, status: "stopping", stage: "archiving",
                status_message: "Recorded. The topic's agent is being stopped now and its chat is being moved to the archive. It is archived only when both are confirmed; " +
                  "delegated work the owner already approved keeps running and its results wait. The owner is told when it is done." }
            : { ...base, status: "accepted", stage: "reopening",
                status_message: "Recorded. The chat is being put back as it was, and the agent will handle what waited. Interrupted work still waits for the owner's choice." };
        case "already-archived":
          return { ...base, revision: topic.lifecycle_generation, status: "complete", stage: "already_archived", status_message: "This chat is already archived." };
        case "in-progress":
          return { ...base, revision: topic.lifecycle_generation, status: "accepted", stage: "in_progress",
            status_message: "An archive or reopen of this chat is already under way, and nothing new was started." };
        case "not-archived":
          throw new Undo(refusal(topic.id, "not_archived", "this chat is not archived"));
        case "missing":
          throw new Undo(refusal(topic.id, "channel_missing", "this chat no longer exists in Discord, and nothing has been erased"));
        case "not-active":
          throw new Undo(refusal(topic.id, "not_active", `this chat is ${describe(topic)} and cannot be ${request.action}d now`));
        default:
          throw new Undo(refusal(topic.id, "unknown_topic", "no topic chat of this person has that id"));
      }
    },
  });
}

export const archiveTopic = (binding: McpBinding, request: ArchiveRequest): Promise<ToolReply> => lifecycle(binding, request);
export const reopenTopic = (binding: McpBinding, request: ReopenRequest): Promise<ToolReply> => lifecycle(binding, request);

// ---------------------------------------------------------------------------------------------
// delete
// ---------------------------------------------------------------------------------------------

/**
 * Where a deletion stands, in the one reply shape and in plain words. It says only what the store holds: a stage the receipts have
 * not supported is never worded as done, and the earlier backup copies are always said to remain unless the store says they expired.
 */
function deletionWords(deletion: DeletionRow): Pick<ToolReply, "status" | "stage"> & { message: string } {
  const retention = retentionStatement("en", { state: deletion.retention_state, days: deletion.retention_days, until: deletion.backup_retention_until });
  switch (deletion.stage) {
    case "awaiting_confirmation":
      return { status: "awaiting_confirmation", stage: "preview", message: "The scope of the deletion is in the chat, and nothing has been deleted. It is deleted only when the owner reacts to it with the green check." };
    case "quiescing":
      return { status: "stopping", stage: "stopping_work", message: "Confirmed. The agent and its delegated work are being stopped, and nothing is erased until each is shown stopped." };
    case "deleting_active":
    case "verifying_active":
      return { status: "running", stage: "erasing", message: "The active history is being removed and each copy is checked." };
    case "pending_machine":
      return { status: "running", stage: "waiting_for_machine", message: "The Hub's own records are deleted, but a machine that holds an active copy has not reported it erased, so the deletion is not complete. It is waited for, and nothing says it is done." };
    case "blocked_scope":
      return { status: "waiting_owner", stage: "not_everything_erased", message: "The Hub's own records are deleted, but a copy could not be erased by this Hub (the platform does not support it, or it was refused), so the deletion is not complete. Say which." };
    case "failed":
      return { status: "failed", stage: "erase_refused", message: "The removal was refused by the store, and nothing half-erased was kept; it is tried again." };
    case "active_deleted":
      return { status: "complete", stage: "active_deleted", message: `The topic, its agent and its active history are deleted. Notes already saved in the vault remain. ${retention}` };
    default:
      return { status: "failed", stage: "superseded", message: "A newer deletion request replaced this one before it was confirmed." };
  }
}

/**
 * The owner's request to delete a topic chat, its agent and its ACTIVE history. It deletes nothing: it works out what a deletion would
 * remove (numbers, never a word of the history), which machines may hold copies, and what the configured backup retention is (or that
 * none is), freezes all of it as a preview in this conversation's chat, and waits. Only the owner's green check on that exact preview,
 * read by the door and committed with the approval, confirms it. There is no argument, field or action that says "approved".
 *
 * WHAT IT NEVER DOES. It does not touch the vault's notes, does not rewrite an earlier backup, and does not run the agent to say
 * goodbye. A topic that is being set up, moved, archived or reopened is refused until that settles; one already being deleted is not
 * asked about twice. The same request key twice is one request.
 */
export async function deleteTopic(binding: McpBinding, request: DeleteRequest): Promise<ToolReply> {
  requireMaster(binding, "delete a topic chat");
  return await runRequest<DeleteRequest, TopicRow>(binding, {
    tool: HUB_TOPIC,
    request,
    object: request.topic_id ?? null,
    async open(tx) {
      const topic = await topicFor(tx, binding, request.topic_id);
      if (request.expected_revision !== undefined && request.expected_revision !== topic.lifecycle_generation) {
        throw new Undo(refusal(topic.id, "stale_revision", `the topic is at revision ${topic.lifecycle_generation}, and this asked about ${request.expected_revision}`));
      }
      return { context: topic };
    },
    async apply(tx, topic, owner) {
      // The store has to carry migration 017 before anything of a deletion is asked of it: a refusal by name, not a missing routine.
      if (!(await deletionSchemaReady(tx))) {
        throw new Undo(refusal(topic.id, "schema_not_ready", `the store has not been migrated to schema ${DELETION_SCHEMA_VERSION} yet, so a deletion cannot be asked for: ask the operator to run the database install step`));
      }
      const registry = binding.registry();
      const me = listAgents(registry).find(one => one.id === binding.agent);
      if (!me || me.door === undefined || me.chat === undefined) {
        throw new Undo(refusal(topic.id, "no_chat", "this conversation's agent has no chat in which the scope of a deletion can be shown"));
      }
      if (owner.sender === "") throw new Undo(refusal(topic.id, "source_invalid", "the owner's message is what says who confirms"));
      let days: number | null;
      try { days = retentionDaysOf(registry); } catch (error) {
        if (error instanceof RetentionInvalid) throw new Undo(refusal(topic.id, "retention_invalid", error.message));
        throw error;
      }
      // Every machine the registry runs something on may hold an active copy (a chat log, a session, an attachment), including the
      // one the topic was moved off: the preview names them all, and each one's report is waited for.
      const machines = [...new Set(listRunEntries(registry).map(one => one.machine).filter((one): one is string => typeof one === "string" && one !== ""))].sort();
      const operation = operationFor(binding, request);
      const answer = await requestDeletion(tx, {
        operation, topic: topic.id, by: owner.sender, source: "tool", retentionDays: days, machines,
        route: { door: me.door, chat: me.chat },
        evidence: { request_key: request.request_key, messages: request.source_message_ids, conversation: binding.conversation, label: topic.display_name },
      });
      switch (answer) {
        case "ok":
        case "replay":
          break;
        case "in-progress":
          throw new Undo(refusal(topic.id, "in_progress", "a deletion, an archive, a reopen or a move of this chat is already under way: ask again when it has finished"));
        case "not-settled":
          throw new Undo(refusal(topic.id, "not_settled", `this chat is ${describe(topic)} and is not ready to be deleted`));
        case "deleted":
          throw new Undo(refusal(topic.id, "already_deleted", "this chat was already deleted"));
        default:
          throw new Undo(refusal(topic.id, "unknown_topic", "no topic chat of this person has that id"));
      }
      const deletion = (await readDeletion(tx, operation))!;
      const base = { operation_id: operation, object_id: topic.id, revision: topic.lifecycle_generation };
      if (deletion.stage !== "awaiting_confirmation") {
        const said = deletionWords(deletion);
        return { ...base, status: said.status, stage: said.stage, status_message: said.message };
      }
      const language = languageOf(registry, binding.person);
      const platform = ((registry.data.run ?? []) as { id: string; platform?: string }[]).find(one => one.id === me.door)?.platform ?? "discord";
      let frozen: Awaited<ReturnType<typeof freezeConfirmation>>;
      try {
        frozen = await freezeConfirmation(tx, {
          operationId: operation, operationKind: TOPIC_DELETE, person: binding.person, door: me.door, chat: me.chat,
          ownerSender: owner.sender, payload: deletion.preview,
          preview: deletionPreview(language, { name: topic.display_name, preview: deletion.preview }),
          confirmation: deletionConfirmationAsk(language), platform,
        });
      } catch (error) {
        if (error instanceof EffectTooLong) throw new Undo(refusal(topic.id, "request_too_long", "the scope does not fit in a preview message with its confirmation line"));
        if (error instanceof ConfirmationRefused) throw new Undo(refusal(topic.id, "closed", "this preview cannot be changed any more"));
        throw error;
      }
      return {
        ...base, revision: frozen.revision, status: "awaiting_confirmation", stage: "preview",
        status_message: "The scope of the deletion is in this chat, and nothing has been deleted. The chat, its agent and its active history are deleted only when the owner reacts to it with the green check. " +
          "Tell the owner what it shows: what is removed, the machines that hold copies, that notes saved in the vault stay, and what the earlier backups do.",
        deletion: {
          removes: deletion.preview.inventory, machines: deletion.preview.machines,
          backup_retention: days === null ? { configured: false } : { configured: true, days },
        },
      } satisfies ToolReply;
    },
  });
}

// ---------------------------------------------------------------------------------------------
// where an open move stands
// ---------------------------------------------------------------------------------------------

// `moveStanding` (the one reading of an open move) and `turnReading` live in `./move-standing.ts`, so the door can read them without this tool.
export { moveStanding, turnReading, type MoveStanding, type TurnReading } from "./move-standing.ts";

// ---------------------------------------------------------------------------------------------
// inspect
// ---------------------------------------------------------------------------------------------

/** Where one topic chat stands, in the one reply shape: what it is doing, what it is waiting for, and what is safe to ask next. */
export async function inspectTopic(binding: McpBinding, request: InspectRequest): Promise<ToolReply> {
  const wanted = request.topic_id!;
  const topic = (await readTopic(binding.store, wanted)) ?? (await readTopicByAgent(binding.store, wanted));
  // A topic that was deleted has no row left, only its deletion: what became of it is still asked about, and answered from the store.
  if (!topic && (await deletionSchemaReady(binding.store))) {
    const gone = await deletionOfTopicOrAgent(binding.store, wanted);
    if (gone !== null && gone.person === binding.person) {
      const said = deletionWords(gone);
      return { operation_id: gone.id, object_id: gone.topic_id, revision: null, status: said.status, stage: said.stage, status_message: said.message,
        deletion: { stage: gone.stage, retention_state: gone.retention_state } } as ToolReply;
    }
  }
  if (!topic || topic.person !== binding.person) return refusal(wanted, "unknown_topic", "no topic chat of this person has that id");
  if (topic.lifecycle === "deleting") {
    const deletion = await deletionOfTopicOrAgent(binding.store, topic.id);
    if (deletion !== null) {
      const said = deletionWords(deletion);
      return { operation_id: deletion.id, object_id: topic.id, revision: topic.lifecycle_generation, status: said.status, stage: said.stage, status_message: said.message,
        topic: { chat: topic.display_name, execution_machine: topic.machine, agent: topic.agent_id, lifecycle: topic.lifecycle, created_by: topic.origin },
        deletion: { stage: deletion.stage, retention_state: deletion.retention_state } } as ToolReply;
    }
  }
  // An open move wins over every waiting word below: those name the machine the topic is bound to, which is the one it is leaving.
  const open = await openMoveOfTopic(binding.store, topic.id);
  if (open !== null) {
    const standing = await moveStanding(binding.store, binding.registry(), topic, open, lineContext(binding, topic));
    return {
      operation_id: open.operation_id, object_id: topic.id, revision: topic.lifecycle_generation, status: standing.status, stage: standing.stage,
      ...(standing.cause === undefined ? {} : { cause: standing.cause }), status_message: standing.message, owner_status: standing.owner_status,
      topic: { chat: topic.display_name, execution_machine: topic.machine, moving_to: open.dest_machine, agent: topic.agent_id, lifecycle: topic.lifecycle, created_by: topic.origin },
      move: standing.move,
    } as ToolReply;
  }
  const revision = topic.create_state === "previewed" && topic.operation_id !== null
    ? (await readOperation(binding.store, topic.operation_id)).at(-1)?.revision ?? null : topic.lifecycle_generation;
  // WHERE THE FIRST MESSAGE OF A CHAT THE HUB MADE STANDS, and nothing about whether its agent runs now. A runner's
  // connection to the store is not serving: the chat is waiting until that runner has picked the first input up, and
  // says why (`store/topic-serving.ts`). An adopted master has no first input, so for it a runner that is not
  // connected is the one thing that can be said.
  let waiting = false;
  let waitingReason: string | null = null;
  if ((topic.create_state === "bound" || topic.create_state === "legacy") && topic.lifecycle === "active") {
    if (topic.origin === "created") {
      if (topic.create_evidence.status !== "running") {
        const serving = await servingOf(binding.store, binding.registry(), topic);
        if (!serving.serving) { waiting = true; waitingReason = serving.reason; }
      }
    } else if (!(await runnerLive(binding.store, topic.runner))) {
      waiting = true;
      waitingReason = "runner_offline";
    }
  }
  const started = topic.origin === "created" && topic.create_evidence.status === "running";
  const waitingWords: Record<string, string> = {
    runner_offline: `Waiting for ${topic.machine}: nothing of its runner is connected. Messages are kept and are handled there when it is back; nothing moves to another machine.`,
    registry_not_synced: `Waiting for ${topic.machine}: its runner is connected, but its copy of the registry is not shown to be the current one, so it may not have this chat's agent yet. Messages are kept; nothing moves to another machine.`,
    not_picked_up_yet: `Waiting for ${topic.machine} to pick the first message up. Messages are kept; nothing moves to another machine.`,
  };
  const refusedAdopt = topic.create_evidence.adopt_refused as { seq?: unknown; cause?: unknown } | undefined;
  const adoptNote = refusedAdopt !== undefined && Number(refusedAdopt.seq) === topic.decision_seq
    ? ` The channel that was named cannot be used: ${String(refusedAdopt.cause)}. Name another, or ask for the chat to be made again.` : "";
  const bindNote = topic.create_state === "channel_known" && topic.create_failure !== null
    ? ` The last try to connect it was refused: ${String(topic.create_failure.cause)}${topic.create_failure.code === undefined ? "" : ` (${String(topic.create_failure.code)})`}.` : "";
  const gaps = attentionGapsOf(topic);
  const gapNote = gaps.length === 0 ? ""
    : ` Something the owner needed to be told could not be delivered, because neither this chat nor General could take it: ${gaps.map(one => `${one.kind} (${one.cause})`).join(", ")}.`;
  const words: Record<string, Pick<ToolReply, "status" | "stage"> & { message: string }> = {
    previewed: { status: "awaiting_confirmation", stage: "preview", message: "The preview is waiting for the owner's green check. Nothing has been created." },
    confirmed: { status: "queued", stage: "confirmed", message: "Approved. The chat is about to be created." },
    create_intent: { status: "running", stage: "creating_channel", message: "The chat is being created." },
    creation_unknown: { status: "waiting_owner", stage: "creation_unknown",
      message: `Whether the chat was created could not be established, and nothing was created again. The owner can name the channel if it is there (creation_decision adopt) or ask for it to be made again (recreate).${adoptNote}` },
    failed: { status: "failed", stage: "channel_refused",
      message: `The platform refused to create the chat, and nothing was made. Nothing retries it: the owner can name a channel that is there (creation_decision adopt) or ask again with creation_decision recreate.${adoptNote}` },
    channel_known: { status: "running", stage: "connecting_agent", message: `The chat exists and the agent is being connected to it. The owner's request is stored and will be its first input.${bindNote}` },
    bind_intent: { status: "running", stage: "connecting_agent", message: "The chat exists and the agent is being connected to it." },
  };
  const bound = topic.create_state === "bound" || topic.create_state === "legacy";
  const lifecycleWords: Record<string, Pick<ToolReply, "status" | "stage"> & { message: string }> = {
    active: waiting
      ? { status: "queued", stage: "waiting_for_machine", message: waitingWords[waitingReason ?? "runner_offline"] }
      : { status: "complete", stage: "active",
          message: started ? `The chat is set up, and its agent started on ${topic.machine} when it picked up the first message. That was one moment; this says nothing of whether it runs now.`
            : "The chat is set up." },
    archiving: { status: "stopping", stage: "archiving", message: "Being archived: complete only when the agent is shown stopped and the chat is shown archived." },
    archived: { status: "complete", stage: "archived", message: "Archived. Its history is kept and it can be reopened." },
    reopening: { status: "accepted", stage: "reopening", message: "Being reopened." },
    channel_missing: { status: "waiting_owner", stage: "channel_missing",
      message: "The chat was deleted in Discord. Its agent and history are still here, nothing was erased, and it takes no new work. To delete them the owner asks for it (delete) and confirms the preview with the green check." },
    deleting: { status: "stopping", stage: "deleting", message: "Being deleted." },
  };
  const said = bound ? lifecycleWords[topic.lifecycle] : words[topic.create_state];
  return {
    operation_id: topic.operation_id, object_id: topic.id, revision, status: said.status, stage: said.stage, status_message: `${said.message}${gapNote}`,
    topic: {
      chat: topic.display_name, execution_machine: topic.machine, agent: topic.agent_id, lifecycle: topic.lifecycle, created_by: topic.origin,
      ...(waitingReason === null ? {} : { waiting_reason: waitingReason }),
      ...(gaps.length === 0 ? {} : { attention_unavailable: gaps.map(one => ({ kind: one.kind, cause: one.cause })) }),
    },
  } as ToolReply;
}
