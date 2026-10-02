import { randomUUID } from "node:crypto";
import { projectInbound } from "../chatlog/project.ts";
import { recordOperationFailure } from "../diagnostics.ts";
import { archiveOf, generalOf, legacyBindingOf, legacyMastersOf, topicCategoryOf, type LegacyMaster } from "../registry/topics.ts";
import { attemptsOf, stopsOf } from "../store/controls.ts";
import type { Store, StoreLike } from "../store/connect.ts";
import { openHoldsOf } from "../store/conversations.ts";
import { wantEffect } from "../store/effects.ts";
import { enqueueInbound } from "../store/inbound.ts";
import { attentionFor } from "../store/topic-attention.ts";
import { servingOf } from "../store/topic-serving.ts";
import { councilGapOf, debtOf } from "../council/attention.ts";
import { needWords } from "../council/lines.ts";
import {
  IdentityReserved, adoptNamed, adoptRefused, announceTopic, attentionCatchup, channelKnown, completeTransition, completedTransitions,
  createFailed, createIntent, createLook, createUnsent, fenceOf, legacyTopics, linkLegacyTopic, markChannelMissing, newestReopenSinceSample, noteAttention,
  observeChannel, openTransitionsOfDoor, readSeen, readTopic, readTopicByAgent, readTopicByChat, rebindLegacyTopic, recordChannel, readTransition,
  requestTransition, retiredTopicsOfDoor, setTopicStatus, topicsOfDoor, type AttentionDebt, type ChannelSeen, type Lifecycle, type OutboxNotice, type RouteFence,
  type TopicRow, type TopicSetup, type TransitionRow,
} from "../store/topics.ts";
import { languageOf, listAgents } from "../registry/entries.ts";
import { CURSOR_SHEET, cursorId } from "./cursor.ts";
import { deletionPhase } from "./deletion-task.ts";
import { classify, type EffectsContext } from "./effects.ts";
import {
  planArchive, planRestore, showsArchived, showsPrior, withArchived, type ArchivePlan, type Left, type RestorePlan,
} from "./archive-plan.ts";
import { finding, safeValue } from "./lines.ts";
import type { ChannelInfo } from "./platform.ts";
import {
  archiveDoneNotice, archivePendingNotice, archivedResultsNotice, attentionCatchupNotice, channelMissingNotice, reopenDoneNotice,
  topicAdoptRefusedNotice, topicCreationUnknownNotice, topicReadyNotice, topicStartedLine, topicStepFailedNotice, topicWaitingLine,
  type CatchupState,
} from "./topic-lines.ts";

/**
 * The door's ONE task for topic chats: it makes the channel a confirmed setup asked for, moves a
 * chat into and out of the archive category, tells when a chat is gone, and keeps the one status
 * line of a chat whose machine has not picked its first message up. Like the platform-message
 * task it is a task of the door and not of an agent, costs one loop however many topics the door
 * serves, and is woken by the notification the store already sends the door; it arms a timer only
 * for a moment something is actually waiting for, and with nothing to do it issues no statement
 * at all.
 *
 * THE RULES THIS FILE HOLDS TO, and the tables enforce the same where they can:
 *
 *  * A channel is asked for once. The intent is committed BEFORE the request; an answer that is
 *    lost, a timeout and a 5xx are looked for by the marker in the channel's description and
 *    adopted if found, and otherwise the topic says `creation_unknown` and STAYS so. An empty
 *    look proves nothing: the description is editable, a listing can miss a channel, and the
 *    request may still land. Nothing here creates a second channel, and nothing deletes one.
 *  * A channel the OWNER names (`adopt`) is owed work in both states a create can be stuck in
 *    (`creation_unknown` and `failed`), it wakes this task by itself, and it is read, checked
 *    against the topics and the registry, and committed only for the decision it was read for.
 *    A channel that cannot be used is refused by name, durably, and nothing is created for it.
 *  * The chat and the owner's request become known in ONE transaction, with the chat's first read
 *    position at the start of the chat, so nothing sent in it while it was being set up is lost
 *    and the request is the first thing its agent is given.
 *  * An archive is complete when the channel was read back showing the change AND no attempt of
 *    the master is owned. The store checks both; this file only asks. A reopen puts back only
 *    what the archive changed and reports whatever somebody else changed since.
 *  * A chat is gone only when a complete listing lacks it AND a read of it by id says the
 *    platform does not know it. A refused read, a 5xx, a rate limit and a listing that failed are
 *    "not known", change nothing about the chat and only age the record of when it was looked at.
 *  * THE ORDINARY MASTERS THE REGISTRY NAMES ARE TOPICS TOO. Each is linked once, keeping the
 *    conversation it has, before the task parks for want of topics, and again whenever the
 *    registry's set of them changes; workers and seats are not masters, and General is.
 *  * AN ADOPTED MASTER'S TOPIC FOLLOWS ITS REGISTRY BINDING, and only the FULL eligible binding is watched: the same person, an
 *    ordinary master (a chat, no role) of this door, this chat, not retired. An entry edited onto another chat or door
 *    is looked up by its agent across doors and the ACTIVE topic is moved onto the route the registry now says (the same
 *    topic, conversation and history; never a second topic), and what was seen of the old chat goes with it. One that is
 *    gone from its chat while active is repaired only by a genuinely CHANGED, validated binding, never because the same
 *    agent reappeared; one that is archiving, archived or reopening (or gone from the archive) keeps its gates, its plan
 *    and its history, is not watched on the new route, and is named (`topic-binding-mismatch`) until the compatible binding
 *    is put back. A read that took time is judged again before anything is written from it, and every write about a chat
 *    names the route and generation it looked at, so an old channel's 404 or archive can never gate a repaired route.
 *  * WHAT COULD NOT BE TOLD IS OWED UNTIL IT IS TOLD. A gap kept on a topic (`noteAttention`) is swept at the end of every pass,
 *    whatever else the topic set holds, and when a documented route (the topic's own place, else General) can take it ONE
 *    keyed notice names what was missed and where the chat stands NOW, and clears exactly those gaps in the same transaction.
 *    The task stays due at the retry interval only while a debt could be paid by a change of state; nothing else polls.
 *  * A CATEGORY CHANGE IS NEVER CONSUMED BEFORE THE OPERATION IT IS PERSISTS. What was last seen is
 *    written only after the archive or reopen it asks for was recorded (or found to be recorded
 *    already), so a failed write, a restart, or an answer that says "not now" leaves the change to
 *    be seen again. WHAT AN OPEN OPERATION DOES TO THE CATEGORY IS RECONCILED WHEN IT SETTLES, in either
 *    direction, from what the operation itself left the chat as (its own durable record, never a guess):
 *    a chat moved out while its archive waited for the stop is a reopen once the archive settles, and a
 *    chat moved back INTO the archive category while a reopen was open is an archive once the reopen
 *    settles, through the same gate and stop. A reopen that could not know the chat's prior category and
 *    so left it inside the category is not undone by the observer: being where the operation left it is
 *    not a change.
 *  * Nothing is erased here for a topic the owner has not confirmed the deletion of, and a chat that is merely gone is not
 *    that. A deletion the owner CONFIRMED is the one phase that erases (`deletion-task.ts`), through the store's own routine.
 *
 * Its one process-local memory (`TopicsMemory`) is a rate limit, a schedule and a note of what it
 * has already said or settled. A restart drops all of it, and everything that matters is in the store.
 */

export interface TopicsContext extends EffectsContext {
  /** The registry as it is NOW. May throw for a file caught half written, and nothing then acts on it. */
  registry: () => unknown;
  /** `hub.state_dir`, where the chat log is projected. */
  stateDir: string;
  /** `door.topic_poll_seconds`: how often the server's channel list is read. */
  pollSeconds: number;
  /** The door's own tick, which is how often an archive or reopen is looked at again while it waits. */
  tickMs: number;
}

export interface TopicsMemory {
  /** The account-wide limit, as this task saw it. A platform that keeps its own memory holds the requests anyway. */
  notBefore: number;
  /** When the channel list is next read. */
  nextObserve: number;
  /** True for the first pass of a process: it looks once more at a creation that was left unknown. */
  startup: boolean;
  /** The ordinary masters (and where they answer) the last complete backfill saw, so an unchanged registry costs nothing. */
  reconciled: string | null;
  /** Notices already said in this process, so a look that repeats does not ask the store again. */
  said: Set<string>;
}

export function newTopicsMemory(): TopicsMemory {
  return { notBefore: 0, nextObserve: 0, startup: true, reconciled: null, said: new Set() };
}

const clock = (ctx: TopicsContext): number => (ctx.now ?? Date.now)();
const soonest = (a: number | null, b: number | null): number | null => (a === null ? b : b === null ? a : Math.min(a, b));
const stamp = (ms: number): string => new Date(ms).toISOString();

/** How often the writes of one chat's observation are repeated when nothing changed. */
const REFRESH_MS = 5 * 60 * 1000;
/** More than this many chats absent from a listing are asked for by id in one pass. */
const READS_PER_PASS = 5;
/** The longest wait between two tries of an archive or reopen the platform refused. */
const BACKOFF_CAP_SECONDS = 3600;
/** The lifecycles in which a chat's category is what the topic itself left it as, and so may be remembered. */
const STEADY: readonly Lifecycle[] = ["active", "archived"];

function registryNow(ctx: TopicsContext): unknown | null {
  try { return ctx.registry(); } catch { return null; }
}

async function report(ctx: TopicsContext, target: string, error: unknown): Promise<void> {
  await recordOperationFailure(ctx.store, { operation: "topic", target, error, actor: "door" }).catch(() => {});
}

/** One transaction of the store: what `work` writes through `tx` commits together or not at all. */
async function atomically<T>(store: StoreLike, work: (tx: StoreLike) => Promise<T>): Promise<T> {
  return await store.sql.begin(async (sql) => await work({ ...store, sql: sql as unknown as StoreLike["sql"] })) as T;
}

/**
 * Say something once, where it belongs: where the request was made when that chat can take it, in
 * the person's General when it cannot and General can, and nowhere when neither can (the matter
 * stays on its operation, and on the topic as the attention it could not deliver, which `check`
 * and `inspect` say by name). The notice is keyed, so a look that repeats says nothing twice, and
 * nothing is recorded as said that had nowhere to go.
 */
async function say(ctx: TopicsContext, memory: TopicsMemory, topic: TopicRow, input: {
  key: string; origin: { door: string; chat: string } | null; originIsThisChat?: boolean;
  body: (language: "en" | "ru", platform: string) => string;
}): Promise<boolean> {
  const noticeKey = `topic:${input.key}:${topic.id}`;
  if (memory.said.has(noticeKey)) return false;
  const registry = registryNow(ctx);
  if (registry === null) return false;
  const kind = input.key.split(":")[0];
  const route = await attentionFor(ctx.store, registry, { person: topic.person, origin: input.origin,
    ...(input.originIsThisChat ? { originUsable: false } : {}) });
  if (!route.ok) {
    await noteAttention(ctx.store, topic.id, kind, route.cause);
    return false;
  }
  // The notice and the fact that it was queued commit together: an attention gap is never cleared for a notice that was not
  // queued, and a queued notice is never left beside a gap that says it could not be told.
  await atomically(ctx.store, async (tx) => {
    await tx.sql`select hub_door_notice(${topic.person}, ${route.agent}, ${input.body(route.language, route.platform)}, ${noticeKey},
      ${route.route}::jsonb, 1)`;
    await noteAttention(tx, topic.id, kind, null);
  });
  memory.said.add(noticeKey);
  return true;
}

const originOf = (topic: TopicRow): { door: string; chat: string } | null => {
  const origin = (topic.setup as Partial<TopicSetup>).origin;
  return origin ? { door: origin.door, chat: origin.chat } : null;
};

// ---------------------------------------------------------------------------------------------
// One pass
// ---------------------------------------------------------------------------------------------

/**
 * Do what is due, one topic after another, and say when something is next due (an epoch, or null
 * for nothing waiting on time). A topic that fails is reported and the others go on. It never
 * sleeps: the caller's timer does.
 */
export async function runTopicPass(ctx: TopicsContext, memory: TopicsMemory): Promise<number | null> {
  let next: number | null = null;
  // BEFORE THE PARKING BELOW: a door whose masters have no topic yet has none to park for, and a master moved into the
  // archive category by hand would keep running for good.
  try {
    if (!(await backfillLegacy(ctx, memory))) next = clock(ctx) + Math.max(1, ctx.retrySeconds) * 1000;
  } catch (error) {
    await report(ctx, ctx.door, error);
    next = clock(ctx) + Math.max(1, ctx.retrySeconds) * 1000;
  }
  // A CONFIRMED DELETION IS OWED WHETHER OR NOT THE DOOR STILL SERVES A TOPIC: erasing removes the topic's row, and the door that
  // deleted its last one still has to delete the chat, judge the receipts and say what became of it. With none, it is one statement.
  try {
    next = soonest(next, await deletionPhase(ctx));
  } catch (error) {
    await report(ctx, ctx.door, error);
    next = soonest(next, clock(ctx) + Math.max(1, ctx.retrySeconds) * 1000);
  }
  // A door that serves no topic has nothing here, and that is one statement, not four.
  const [held] = await ctx.store.sql`select exists (select 1 from topic where door = ${ctx.door}) as some`;
  if (held.some !== true) { memory.startup = false; return next; }
  next = soonest(next, await createPhase(ctx, memory));
  next = soonest(next, await transitionPhase(ctx, memory));
  next = soonest(next, await statusPhase(ctx, memory));
  next = soonest(next, await observePhase(ctx, memory));
  // LAST, AND WHATEVER THE TOPIC SET HOLDS: observing returns early for a door with nothing to watch (a chat that is gone is not),
  // and what could not be told is owed all the same.
  next = soonest(next, await catchupPhase(ctx, memory));
  memory.startup = false;
  return next;
}

// ---------------------------------------------------------------------------------------------
// The masters the registry already had
// ---------------------------------------------------------------------------------------------

/**
 * Make every ordinary master of this door a topic that stands where the registry says, once, keeping the conversation it
 * already has, and refusing a retired identity by name. A master is looked up by its AGENT across doors:
 *
 *  * none yet: it is linked.
 *  * one the Hub made: its rules are its own and nothing here touches it.
 *  * an adopted one that stands on this door and this chat: nothing to do.
 *  * an adopted one that stands elsewhere (its registry entry was edited onto another chat, or another door): the ACTIVE topic
 *    is moved onto the route the registry now says (`reconcileRoute`), keeping its topic, agent, conversation and history.
 *
 * Idempotent, bounded (one read of the adopted topics, and a call for each master that needs one), and remembered by what the
 * registry said, so it costs nothing again until the set of masters or where they answer changes. A master whose binding could
 * NOT be reconciled (an archived topic, a retired identity, another person's) is never remembered as reconciled: it is looked at
 * again, and named, and only the ones that a change of state can resolve keep the task due. Only a door that can WATCH its chats
 * and has an archive mapping mirrors anything, so only such a door links; the owner's tools link one lazily as before either way.
 * True when nothing is left owed on a timer.
 */
async function backfillLegacy(ctx: TopicsContext, memory: TopicsMemory): Promise<boolean> {
  const admin = ctx.platform.admin;
  if (!admin?.listChannels || !admin.readChannel) return true;
  const registry = registryNow(ctx);
  if (registry === null) return false;
  if (archiveOf(registry, ctx.door) === null) return true;
  const masters = legacyMastersOf(registry, ctx.door);
  const signature = JSON.stringify(masters.map(one => [one.agent.id, one.agent.person, one.agent.chat, one.machine, one.runner, one.preset]));
  if (memory.reconciled === signature) return true;
  const adopted = new Map((await legacyTopics(ctx.store)).map(one => [one.agent_id, one]));
  // Owed on a timer (a write failed, or the matter resolves by a change of state) and not to be remembered as reconciled.
  let owed = false;
  let unresolved = false;
  for (const one of masters) {
    if (ctx.stop?.()) return false;
    try {
      const standing = adopted.get(one.agent.id) ?? await readTopicByAgent(ctx.store, one.agent.id);
      if (standing === null) {
        await linkLegacyTopic(ctx.store, { person: one.agent.person, agent: one.agent.id, door: ctx.door, chat: one.agent.chat, machine: one.machine,
          runner: one.runner, preset: one.preset, adapter: one.adapter, display_name: one.agent.id });
        continue;
      }
      if (standing.origin !== "legacy") continue;
      const done = await reconcileRoute(ctx, memory, standing, one);
      if (done !== "settled") unresolved = true;
      if (done === "waiting") owed = true;
    } catch (error) {
      if (error instanceof IdentityReserved) {
        // A retired identity is never given a topic: settled, said once, and not tried again by this process.
        if (!memory.said.has(`reserved:${one.agent.id}`)) { memory.said.add(`reserved:${one.agent.id}`); await report(ctx, one.agent.id, error); }
        continue;
      }
      await report(ctx, one.agent.id, error);
      owed = true;
      unresolved = true;
    }
  }
  if (!unresolved) memory.reconciled = signature;
  return !owed;
}

/** How far an adopted master's route was brought to what the registry says: done, waiting on a change of state, or not something this can do. */
type Reconciled = "settled" | "waiting" | "blocked";

/**
 * One adopted master whose topic does not stand where the registry now puts it. The person, the identities (topic, agent and
 * conversation, even for a topic that is already linked) and the route are validated first and by name; an ACTIVE topic, or one
 * gone from its chat while active and now given a genuinely different binding, is moved by the store's narrow legacy route change
 * (`hub_topic_rebind`, which checks all of it again under its locks). One that is archiving, archived or reopening, or that
 * vanished from its archive, keeps its gates, its plan and its history and is not touched: nothing of the old chat's archive is
 * applied to another, and it is named until the compatible binding is restored.
 */
async function reconcileRoute(ctx: TopicsContext, memory: TopicsMemory, topic: TopicRow, master: LegacyMaster): Promise<Reconciled> {
  const agent = master.agent;
  if (topic.door === ctx.door && topic.chat === agent.chat && topic.person === agent.person) return "settled";
  const where = `${agent.door}/${agent.chat}`;
  const was = `${topic.door}/${topic.chat}`;
  if (topic.person !== agent.person) {
    await mismatch(ctx, memory, topic, "person_changed", `the registry now gives ${agent.id} to ${agent.person}, and its topic is ${topic.person}'s`);
    return "blocked";
  }
  if ((await retiredTopicsOfDoor(ctx.store, topic.door)).has(topic.id)) {
    await mismatch(ctx, memory, topic, "identity_reserved", `an identity of ${agent.id}'s topic was retired and is never used again`);
    return "blocked";
  }
  const repairable = topic.lifecycle === "active" || (topic.lifecycle === "channel_missing" && topic.missing_from === "active");
  if (!repairable) {
    await mismatch(ctx, memory, topic, `route_changed_while_${topic.lifecycle}`,
      `the registry now answers ${agent.id} in ${where}, but its topic is ${topic.lifecycle.replace(/_/g, " ")}${topic.missing_from === null ? "" : ` (it vanished while ${topic.missing_from})`} on ${was}: ` +
      "its archive, its gates and its history stay with that chat and none of it was applied to the new one; put the entry back on the old route to use it again");
    return "waiting";
  }
  const holder = await readTopicByChat(ctx.store, ctx.door, agent.chat);
  if (holder !== null && holder.id !== topic.id) {
    await mismatch(ctx, memory, topic, "chat_taken", `the chat ${where} already belongs to another topic`);
    return "waiting";
  }
  const answer = await rebindLegacyTopic(ctx.store, agent.id, agent.chat, { door: ctx.door, person: agent.person, requireChange: true });
  switch (answer) {
    case "rebound": case "unchanged": case "managed":
      return "settled";
    case "chat-taken":
      await mismatch(ctx, memory, topic, "chat_taken", `the chat ${where} already belongs to another topic`);
      return "waiting";
    case "identity-reserved": case "person-mismatch":
      await mismatch(ctx, memory, topic, answer.replace(/-/g, "_"), `the store refused to move ${agent.id}'s topic onto ${where}: ${answer}`);
      return "blocked";
    default:
      await mismatch(ctx, memory, topic, answer.replace(/-/g, "_"), `${agent.id}'s topic is ${answer} and stays on ${was}`);
      return "waiting";
  }
}

/** Say once (per process) that an adopted master's registry binding is not the route its topic stands on, and why. Nothing is changed by saying it. */
async function mismatch(ctx: TopicsContext, memory: TopicsMemory, topic: TopicRow, code: string, cause: string): Promise<void> {
  const key = `binding:${topic.id}:${code}:${topic.door}/${topic.chat}:${topic.lifecycle}`;
  if (memory.said.has(key)) return;
  memory.said.add(key);
  await report(ctx, topic.id, new Error(`topic-binding-mismatch: ${code}: ${cause}`));
}

// ---------------------------------------------------------------------------------------------
// Making the channel
// ---------------------------------------------------------------------------------------------

async function createPhase(ctx: TopicsContext, memory: TopicsMemory): Promise<number | null> {
  let next: number | null = null;
  for (const topic of await topicsOfDoor(ctx.store, ctx.door, { create: ["confirmed", "create_intent", "creation_unknown", "failed"] })) {
    if (ctx.stop?.()) return next;
    try {
      next = soonest(next, await createOne(ctx, memory, topic));
    } catch (error) {
      await report(ctx, topic.id, error);
      next = soonest(next, clock(ctx) + ctx.retrySeconds * 1000);
    }
  }
  return next;
}

async function createOne(ctx: TopicsContext, memory: TopicsMemory, topic: TopicRow): Promise<number | null> {
  const now = clock(ctx);
  if (now < memory.notBefore) return memory.notBefore;
  const due = topic.create_retry_at === null ? null : topic.create_retry_at.getTime();
  if (topic.create_state === "confirmed") return due !== null && due > now ? due : await makeChannel(ctx, memory, topic);
  if (topic.create_state === "create_intent") return due !== null && due > now ? due : await lookForChannel(ctx, memory, topic, false);
  // A refused create: nothing asks again but an explicit decision, and an adoption is one.
  if (topic.create_state === "failed") return await adoptDecided(ctx, memory, topic);
  // creation_unknown: only an explicit decision moves it, and a door that has just started looks once more.
  const decision = topic.create_evidence.decision as { choice?: string; chat?: string } | undefined;
  if (decision?.choice === "adopt" && typeof decision.chat === "string") return await adoptDecided(ctx, memory, topic);
  return memory.startup ? await lookForChannel(ctx, memory, topic, true) : null;
}

/** Ask the platform for the channel: the intent is committed first, and this is the only place a channel is ever asked for. */
async function makeChannel(ctx: TopicsContext, memory: TopicsMemory, topic: TopicRow): Promise<number | null> {
  const now = clock(ctx);
  const registry = registryNow(ctx);
  if (registry === null) return now + ctx.retrySeconds * 1000;
  const parent = topicCategoryOf(registry, ctx.door);
  const attempt = randomUUID();
  if ((await createIntent(ctx.store, topic.id, attempt)) !== "intent") return null;
  const admin = ctx.platform.admin;
  if (!admin?.createChannel) {
    const cause = "unsupported on this platform";
    await createFailed(ctx.store, topic.id, attempt, { step: "channel", code: "unsupported", cause, at: stamp(now) });
    await say(ctx, memory, topic, { key: "create-failed", origin: originOf(topic),
      body: (language, platform) => topicStepFailedNotice(language, { platform, name: topic.display_name, chat: null, step: "channel", cause }) });
    return null;
  }
  let channel: ChannelInfo;
  try {
    channel = await admin.createChannel({ name: topic.display_name, parent_id: parent, topic: topic.marker });
  } catch (error) {
    const verdict = classify(error, ctx);
    if (verdict.kind === "rate_limited") {
      // The platform did not handle it: asked again after exactly the wait it named.
      const at = now + verdict.retryAfterMs;
      if (verdict.global) memory.notBefore = Math.max(memory.notBefore, at);
      await createUnsent(ctx.store, topic.id, attempt, new Date(at), { rate_limited: { retry_after_ms: verdict.retryAfterMs, at: stamp(now) } });
      return at;
    }
    if (verdict.kind === "refused") {
      // Refused without being handled: nothing was made, and only an explicit decision asks again.
      await createFailed(ctx.store, topic.id, attempt, { step: "channel", ...verdict.failure });
      await say(ctx, memory, topic, { key: "create-failed", origin: originOf(topic),
        body: (language, platform) => topicStepFailedNotice(language, { platform, name: topic.display_name, chat: null, step: "channel", cause: String(verdict.failure.cause) }) });
      return null;
    }
    // It may have been made. It is looked for, never asked for again.
    const at = new Date(now + ctx.retrySeconds * 1000);
    await createLook(ctx.store, topic.id, attempt, { answer_lost: verdict.failure }, at, false);
    return at.getTime();
  }
  return await adopt(ctx, topic, channel, "response");
}

/**
 * Look for a channel that may have been made, by the marker its description carries. Positive
 * evidence adopts it. Nothing found is not an answer: the look is repeated a bounded number of
 * times and then the outcome is `creation_unknown` for good. A topic that was already unknown is
 * looked at once when a door starts, and only ever moves to a found channel.
 */
async function lookForChannel(ctx: TopicsContext, memory: TopicsMemory, topic: TopicRow, late: boolean): Promise<number | null> {
  const now = clock(ctx);
  const attempt = topic.create_attempt ?? "";
  const spaced = new Date(now + ctx.retrySeconds * 1000);
  const admin = ctx.platform.admin;
  const conclude = async (proof: Record<string, unknown>, ambiguous = false): Promise<number | null> => {
    if (late) return null;
    const unknown = ambiguous || topic.reconcile_attempts + 1 >= ctx.maxAttempts || !admin?.listChannels;
    await createLook(ctx.store, topic.id, attempt, proof, unknown ? null : spaced, unknown);
    if (unknown) {
      await say(ctx, memory, topic, { key: "create-unknown", origin: originOf(topic),
        body: (language) => topicCreationUnknownNotice(language, { name: topic.display_name }) });
      return null;
    }
    return spaced.getTime();
  };
  if (!admin?.listChannels) return await conclude({ looked: { reason: "no-listing", at: stamp(now) } });
  let channels: ChannelInfo[];
  try {
    channels = await admin.listChannels();
  } catch (error) {
    const verdict = classify(error, ctx);
    if (verdict.kind === "rate_limited") {
      const at = now + verdict.retryAfterMs;
      if (verdict.global) memory.notBefore = Math.max(memory.notBefore, at);
      return at;
    }
    return await conclude({ looked: { reason: "read-failed", failure: verdict.failure, at: stamp(now) } });
  }
  const found = channels.filter(one => one.kind === "text" && one.topic !== null && one.topic.includes(topic.marker));
  if (found.length === 1) return await adopt(ctx, topic, found[0], late ? "marker_late" : "marker");
  if (found.length > 1) return await conclude({ looked: { reason: "ambiguous", channels: found.map(one => one.id), at: stamp(now) } }, true);
  return await conclude({ looked: { reason: "no-marker-found", complete: true, at: stamp(now) } });
}

/**
 * The owner named the channel that is the one, for a create that was unknown or that the platform refused. It is
 * READ AND CHECKED before it is used, against the platform (it is there, and it is a text channel), the topics (no
 * other topic has it) and the registry (no agent already answers in it), and one that fails a check is refused
 * durably and by name, for THIS decision only: the topic stays where it is, the owner is told, and a new decision is
 * a new look. No channel is created, and nothing is deleted.
 *
 * THE LOOKUP IS FENCED BY THE DECISION IT WAS MADE FOR. The revision is read with the topic, before the platform is
 * asked, and the commit (and a refusal) hold only while the store still stands at that revision; a newer choice, another
 * channel or a recreate, has moved it on, and this older answer changes nothing.
 */
async function adoptDecided(ctx: TopicsContext, memory: TopicsMemory, topic: TopicRow): Promise<number | null> {
  const decision = topic.create_evidence.decision as { choice?: string; chat?: string } | undefined;
  if (decision?.choice !== "adopt" || typeof decision.chat !== "string" || decision.chat === "") return null;
  const seq = topic.decision_seq;
  const chat = decision.chat;
  // A decision that was refused has been said, and is not looked at again: another decision is what changes it.
  const refused = topic.create_evidence.adopt_refused as { seq?: unknown } | undefined;
  if (refused !== undefined && Number(refused.seq) === seq) return null;
  const refuse = async (code: string, cause: string): Promise<null> => {
    if ((await adoptRefused(ctx.store, topic.id, seq, code, cause)) === "refused") {
      await say(ctx, memory, topic, { key: `adopt-refused:${seq}`, origin: originOf(topic),
        body: (language) => topicAdoptRefusedNotice(language, { name: topic.display_name, cause }) });
    }
    return null;
  };
  const admin = ctx.platform.admin;
  if (!admin?.readChannel) return await refuse("unsupported", "unsupported on this platform");
  // Asked of the registry and the topics as they are at the moment of asking: once before the platform is read, and once
  // more after it answered, because the answer can take a long time and a binding may have landed while it was on its way.
  // `unreadable` is not a refusal: the registry cannot be judged now, and it is looked at again on the next tick.
  const owned = async (): Promise<{ code: string; cause: string } | "unreadable" | null> => {
    const registry = registryNow(ctx);
    if (registry === null) return "unreadable";
    if (listAgents(registry).some(one => one.door === ctx.door && one.chat === chat)) {
      return { code: "answered_in_registry", cause: "an agent of the registry already answers in that channel" };
    }
    const holder = await readTopicByChat(ctx.store, ctx.door, chat);
    if (holder !== null && holder.id !== topic.id) return { code: "owned_by_topic", cause: "that channel already belongs to another topic chat" };
    return null;
  };
  const first = await owned();
  if (first === "unreadable") return clock(ctx) + Math.max(1, ctx.tickMs);
  if (first !== null) return await refuse(first.code, first.cause);
  let read: Awaited<ReturnType<NonNullable<typeof admin.readChannel>>>;
  try {
    read = await admin.readChannel(chat);
  } catch (error) {
    const verdict = classify(error, ctx);
    if (verdict.kind === "rate_limited") {
      const at = clock(ctx) + verdict.retryAfterMs;
      if (verdict.global) memory.notBefore = Math.max(memory.notBefore, at);
      return at;
    }
    throw error;
  }
  if (!read.exists) return await refuse("not_found", "that channel does not exist");
  if (read.channel.kind !== "text") return await refuse("not_text", "that channel is not a text channel");
  // This is a look, and not a lock: the registry file is written by the hub's writer and the topics table is a different store,
  // so nothing here can make the two checks and the commit one step. What stands behind it is the store's one topic per chat of a
  // door (a commit that lost that race fails and is reported, and adopts nothing), and, for the registry, the hub's bind, which
  // judges `chat_taken` again on the file under the writer's own lock before it writes the agent.
  const later = await owned();
  if (later === "unreadable") return clock(ctx) + Math.max(1, ctx.tickMs);
  if (later !== null) return await refuse(later.code, later.cause);
  return await adopt(ctx, topic, read.channel, "owner_choice", seq);
}

/** A lookup for a decision that has been moved on from: its transaction is rolled back, and nothing of it remains. */
class Superseded extends Error {}

/**
 * The channel is known: ONE transaction records it, stores the owner's request as the first input
 * of the topic's agent, and puts the chat's first read position at its very start. The input's id
 * is derived from the topic, so a repeat finds it there and writes nothing. `fence` is the decision
 * revision an owner's choice was read for; the channel is recorded only if that is still the decision.
 */
async function adopt(ctx: TopicsContext, topic: TopicRow, channel: ChannelInfo, how: string, fence: number | null = null): Promise<number | null> {
  const setup = topic.setup as TopicSetup;
  const inputId = `topic-create:${topic.id}`;
  try {
    await ctx.store.sql.begin(async (sql) => {
      const tx: StoreLike = { ...ctx.store, sql: sql as unknown as StoreLike["sql"] };
      const proof = { channel: { how, chat: channel.id, at: stamp(clock(ctx)) } };
      if (fence === null) {
        await channelKnown(tx, topic.id, channel.id, proof);
      } else {
        const answer = await adoptNamed(tx, topic.id, channel.id, fence, proof);
        if (answer === "stale" || answer === "unknown-topic") throw new Superseded();
      }
      await enqueueInbound(tx, {
        id: inputId, person: topic.person, agent: topic.agent_id, body: setup.initial_request, kind: "human", log_ready: false,
        source: { log_id: inputId, at: (topic.confirmed_at ?? new Date(clock(ctx))).toISOString(), door: topic.door, chat: channel.id,
          sender_id: topic.confirmed_by ?? setup.requested_by, from: topic.person, text: setup.initial_request },
      });
      // From the beginning of the chat, never from where it stands: nothing the owner writes there
      // while it is being set up is skipped as history. An existing position is never moved back.
      await sql`insert into state_row (sheet, id, data) values (${CURSOR_SHEET}, ${cursorId(topic.door, channel.id)}, ${{ cursor: "0" }}::jsonb)
        on conflict (sheet, id) do nothing`;
    });
  } catch (error) {
    if (error instanceof Superseded) return null;
    throw error;
  }
  // The chat log line, once the row is committed. A projection that fails is owed and swept by the door.
  await projectInbound(ctx.store, { stateDir: ctx.stateDir, inboundId: inputId }).catch(() => {});
  return null;
}

// ---------------------------------------------------------------------------------------------
// The status line, and saying it is ready
// ---------------------------------------------------------------------------------------------

/**
 * A topic that is bound is announced where it was asked for, once, and gets ONE status line in its
 * own chat: "Waiting for <machine>" until something shows that machine's runner took the owner's
 * first message up, and then, edited in place, "Started on <machine>". That is a one-time MILESTONE:
 * nothing follows the agent afterwards, and the line never says it is running now.
 *
 * WHAT COUNTS AS STARTED IS EVIDENCE, NOT A CONNECTION. A runner of another machine can be connected
 * to the store with a registry copy that does not name the new agent, and then it claims nothing for it
 * (`store/topic-serving.ts`). The line moves to "Started" only when that runner has claimed the first
 * input or opened an attempt for it, and until then it names why it still waits. Only a chat that is
 * ACTIVE is looked at, and the store refuses to record a start for one that is not: a chat that was
 * archived, is being reopened or is gone while its machine was away never publishes it.
 */
async function statusPhase(ctx: TopicsContext, memory: TopicsMemory): Promise<number | null> {
  const rows = (await ctx.store.sql`select id from topic
    where door = ${ctx.door} and create_state = 'bound' and origin = 'created' and lifecycle = 'active'
      and (not jsonb_exists(create_evidence, 'announced') or create_evidence ->> 'status' = 'waiting')
    order by created_at, id`) as unknown as { id: string }[];
  if (rows.length === 0) return null;
  const wanted = new Set(rows.map(row => row.id));
  let waiting = false;
  for (const topic of await topicsOfDoor(ctx.store, ctx.door, { create: ["bound"], lifecycle: ["active"] })) {
    if (!wanted.has(topic.id)) continue;
    if (ctx.stop?.()) return null;
    try {
      if (!(await statusOne(ctx, memory, topic))) waiting = true;
    } catch (error) {
      await report(ctx, topic.id, error);
      waiting = true;
    }
  }
  return waiting ? clock(ctx) + Math.max(1, ctx.pollSeconds) * 1000 : null;
}

/** True when this topic needs nothing more from the status phase. */
async function statusOne(ctx: TopicsContext, _memory: TopicsMemory, topic: TopicRow): Promise<boolean> {
  const registry = registryNow(ctx);
  if (registry === null || topic.chat === null) return false;
  const language = languageOf(registry, topic.person);
  const evidence = await servingOf(ctx.store, registry, topic);
  const reason = evidence.serving ? null : evidence.reason;
  const line = evidence.serving ? topicStartedLine(language, topic.machine) : topicWaitingLine(language, topic.machine);
  const key = `topic-status:${topic.id}`;
  const want = { key, door: topic.door, chat: topic.chat, owner: `topic:${topic.id}`, text: line, platform: ctx.platform.name };
  const inside = (work: (tx: StoreLike) => Promise<boolean>): Promise<boolean> => atomically(ctx.store, work);

  if (topic.create_evidence.announced !== true) {
    const origin = originOf(topic);
    const route = await attentionFor(ctx.store, registry, { person: topic.person, origin });
    const notice: OutboxNotice | null = route.ok ? {
      person: topic.person, agent: route.agent, key: `topic:ready:${topic.id}`, route: route.route,
      body: topicReadyNotice(route.language, { platform: route.platform, name: topic.display_name, chat: topic.chat, machine: topic.machine, waiting: !evidence.serving }),
    } : null;
    // The announcement, the line and what it says of whether anybody could be told commit together, and the store refuses a
    // start for a chat that is not active. A repeat that finds it announced writes none of the three.
    const made = await inside(async (tx) => {
      const done = await announceTopic(tx, topic.id, notice, evidence.serving ? "running" : "waiting", reason);
      if (done) {
        await wantEffect(tx, want);
        await noteAttention(tx, topic.id, "ready", route.ok ? null : route.cause);
      }
      return done;
    });
    return made && evidence.serving;
  }
  if (evidence.serving) {
    return await inside(async (tx) => {
      const moved = await setTopicStatus(tx, topic.id, "running");
      if (moved) await wantEffect(tx, want);
      return moved;
    });
  }
  // Still waiting: what it waits for is kept when it changes, and nothing else is written.
  if (topic.create_evidence.status_reason !== reason) await setTopicStatus(ctx.store, topic.id, "waiting", reason);
  return false;
}

// ---------------------------------------------------------------------------------------------
// Archive and reopen
// ---------------------------------------------------------------------------------------------

async function transitionPhase(ctx: TopicsContext, memory: TopicsMemory): Promise<number | null> {
  let next: number | null = null;
  for (const { topic, transition } of await openTransitionsOfDoor(ctx.store, ctx.door)) {
    if (ctx.stop?.()) return next;
    try {
      next = soonest(next, await advance(ctx, memory, topic, transition));
    } catch (error) {
      await report(ctx, transition.id, error);
      next = soonest(next, clock(ctx) + ctx.retrySeconds * 1000);
    }
  }
  return next;
}

/** When a transition's platform half is next allowed to be tried, or null. */
function retryAtOf(transition: TransitionRow): number | null {
  const at = transition.channel_result?.retry_at;
  return typeof at === "string" && Number.isFinite(Date.parse(at)) ? Date.parse(at) : null;
}

function backoffOf(ctx: TopicsContext, transition: TransitionRow): { failures: number; retryAt: number } {
  const failures = Number(transition.channel_result?.failures ?? 0) + 1;
  const seconds = Math.min(BACKOFF_CAP_SECONDS, ctx.retrySeconds * 2 ** (failures - 1));
  return { failures, retryAt: clock(ctx) + seconds * 1000 };
}

async function advance(ctx: TopicsContext, memory: TopicsMemory, topic: TopicRow, transition: TransitionRow): Promise<number | null> {
  const now = clock(ctx);
  const wait = Math.max(1, ctx.tickMs);
  if (transition.channel_state !== "applied" && transition.channel_state !== "conflict") {
    const retry = retryAtOf(transition);
    if (retry !== null && retry > now && transition.channel_state !== "intent") return retry;
    if (now < memory.notBefore) return memory.notBefore;
    const stepped = transition.kind === "archive"
      ? await archiveChannel(ctx, memory, topic, transition)
      : await reopenChannel(ctx, memory, topic, transition);
    if (!stepped.done) return stepped.next;
  }
  // Complete, or looked at again at the door's own tick while it waits (a stop that is not yet shown).
  return (await tryComplete(ctx, memory, topic, transition)) ? null : now + wait;
}

interface Stepped { done: boolean; next: number | null }

/** What a read of one channel by id answers: the channel, or that the platform names it as gone. */
type ReadResult = { exists: true; channel: ChannelInfo } | { exists: false };

/**
 * The chat is gone: established by the caller, recorded here, and nothing is erased.
 *
 * IT IS RECORDED AS ABOUT THE ROUTE THE CALLER LOOKED AT (`fenceOf(topic)`): a topic that was repaired onto another chat while
 * the read of the old one was on its way answers `stale`, and the old chat's disappearance gates nothing and opens nothing.
 * Each disappearance that does stand is an operation of its own, named by the store (its gate, its pending request, its notice),
 * so what a repair closed is never mistaken for the next one; the key of `notice` is the store's to write.
 */
async function markMissing(ctx: TopicsContext, _memory: TopicsMemory, topic: TopicRow, proof: Record<string, unknown>): Promise<void> {
  const registry = registryNow(ctx);
  const route = registry === null ? null : await attentionFor(ctx.store, registry, { person: topic.person, origin: null, originUsable: false });
  const notice: OutboxNotice | null = route !== null && route.ok ? {
    person: topic.person, agent: route.agent, key: "topic:missing", route: route.route,
    body: channelMissingNotice(route.language, { name: topic.display_name }),
  } : null;
  // The store queues the notice only for the call that records the disappearance (`ok`): a repeat (`already`), a deletion the
  // Hub itself asked for (`suppressed`) and a look at a route the topic has left (`stale`) queue none. So what is said of whether
  // anybody could be told is written in the same transaction and only for that call, and never for a notice that does not exist.
  await atomically(ctx.store, async (tx) => {
    const done = await markChannelMissing(tx, topic.id, { ...proof, notice: route === null ? "registry-unreadable" : route.ok ? route.via : route.cause },
      notice, fenceOf(topic));
    if (done === "ok" && route !== null) await noteAttention(tx, topic.id, "missing", route.ok ? null : route.cause);
    return done;
  });
}

/** The platform half of an archive: the chat goes into the archive category and is made read only for the named roles. */
async function archiveChannel(ctx: TopicsContext, memory: TopicsMemory, topic: TopicRow, transition: TransitionRow): Promise<Stepped> {
  const now = clock(ctx);
  const registry = registryNow(ctx);
  const config = registry === null ? null : archiveOf(registry, topic.door);
  const admin = ctx.platform.admin;
  const fail = async (cause: string, code: string, extra: Record<string, unknown> = {}): Promise<Stepped> => {
    const { failures, retryAt } = backoffOf(ctx, transition);
    await recordChannel(ctx.store, transition.id, "failed", null, { cause, code, failures, retry_at: stamp(retryAt), at: stamp(now), ...extra });
    await say(ctx, memory, topic, { key: `archive-pending:${transition.id}:channel_failed`, origin: transition.route,
      originIsThisChat: transition.route?.chat === topic.chat,
      body: (language, platform) => archivePendingNotice(language, { platform, name: topic.display_name, chat: topic.chat, reason: "channel_failed" }) });
    return { done: false, next: retryAt };
  };
  if (config === null) return await fail("invalid configuration", "archive-not-configured");
  if (!admin?.readChannel || !admin.editChannel || topic.chat === null) return await fail("unsupported on this platform", "unsupported");

  let read: ReadResult;
  try {
    read = await admin.readChannel(topic.chat);
  } catch (error) {
    return await channelError(ctx, memory, topic, transition, error, "read");
  }
  if (!read.exists) {
    await markMissing(ctx, memory, topic, { listing: "not-consulted", read: "unknown-channel", during: transition.id, at: stamp(now) });
    return { done: false, next: null };
  }
  const channel = read.channel;
  const observedFrom = transition.source === "discord" ? (transition.evidence.observed_from as string | null | undefined) : undefined;
  const recorded = transition.channel_plan as ArchivePlan | null;
  let plan: ArchivePlan;
  if (transition.channel_state === "intent" && recorded !== null) {
    // A change that may have landed. It is read, not assumed.
    if (showsArchived(channel, recorded)) {
      await recordChannel(ctx.store, transition.id, "applied", null, { how: "found-applied", at: stamp(now) });
      return { done: true, next: null };
    }
    // Neither what it was nor what the archive makes: somebody changed it meanwhile. The archive is the owner's
    // explicit request, so it is planned again from what is there now, and what is there now is what is recorded.
    plan = showsPrior(channel, recorded) ? recorded : planArchive(channel, config, observedFrom);
  } else {
    plan = planArchive(channel, config, observedFrom);
  }
  if (showsArchived(channel, plan)) {
    await recordChannel(ctx.store, transition.id, "intent", plan, null);
    await recordChannel(ctx.store, transition.id, "applied", null, { how: "already-archived", at: stamp(now) });
    return { done: true, next: null };
  }
  // Journaled BEFORE the platform is asked. A repeat is a request for the same values.
  await recordChannel(ctx.store, transition.id, "intent", plan, null);
  let updated: ChannelInfo;
  try {
    updated = await admin.editChannel({ chat: topic.chat, parent_id: plan.apply_parent,
      permission_overwrites: withArchived(channel.permission_overwrites, plan) });
  } catch (error) {
    return await channelError(ctx, memory, topic, transition, error, "edit");
  }
  if (showsArchived(updated, plan)) {
    await recordChannel(ctx.store, transition.id, "applied", null, { how: "response", at: stamp(now) });
    return { done: true, next: null };
  }
  // The platform answered and the channel does not show the change. It stays journaled as intent, and the next look reads it.
  return { done: false, next: backoffOf(ctx, transition).retryAt };
}

/** The platform half of a reopen: put back what the archive changed, and only that, and report what was changed since. */
async function reopenChannel(ctx: TopicsContext, memory: TopicsMemory, topic: TopicRow, transition: TransitionRow): Promise<Stepped> {
  const now = clock(ctx);
  const admin = ctx.platform.admin;
  const archived = (await completedTransitions(ctx.store, topic.id, "archive"))[0];
  const plan = (archived?.channel_plan ?? null) as ArchivePlan | null;
  // Nothing was recorded of what the archive changed, so there is nothing to put back.
  if (plan === null || !admin?.readChannel || !admin.editChannel || topic.chat === null) return { done: true, next: null };

  let read: ReadResult;
  try {
    read = await admin.readChannel(topic.chat);
  } catch (error) {
    return await channelError(ctx, memory, topic, transition, error, "read");
  }
  if (!read.exists) {
    await markMissing(ctx, memory, topic, { listing: "not-consulted", read: "unknown-channel", during: transition.id, at: stamp(now) });
    return { done: false, next: null };
  }
  const found = planRestore(read.channel, plan, { moveParent: transition.source === "tool" });
  // A pass that repeats a request whose answer was lost (or a restarted one) may find its own change already on the channel, and
  // then sees less to explain than the request found. What the journaled request found changed by somebody else counts too, so the
  // explanation comes from what is stored and not from what this pass happened to see.
  const left = [...new Set([...found.left, ...journaledLeft(transition)])];
  const restore: RestorePlan = { ...found, left };
  if (restore.nothing) {
    await recordChannel(ctx.store, transition.id, left.length > 0 ? "conflict" : "applied", { restore, archive: archived?.id },
      { left, how: "nothing-to-restore", parent: read.channel.parent_id, at: stamp(now) });
    return { done: true, next: null };
  }
  await recordChannel(ctx.store, transition.id, "intent", { restore, archive: archived?.id }, null);
  let updated: ChannelInfo;
  try {
    updated = await admin.editChannel({ chat: topic.chat,
      ...(restore.parent_id === undefined ? {} : { parent_id: restore.parent_id }),
      ...(restore.overwrites === undefined ? {} : { permission_overwrites: restore.overwrites }) });
  } catch (error) {
    return await channelError(ctx, memory, topic, transition, error, "edit");
  }
  const after = planRestore(updated, plan, { moveParent: transition.source === "tool" });
  // The platform answered and the channel does not show the change: it stays journaled as intent and the next look reads it.
  if (!after.nothing) return { done: false, next: backoffOf(ctx, transition).retryAt };
  // `parent` is where the chat stands as the reopen leaves it: what a later look compares the chat with (`reopenLeftOf`).
  await recordChannel(ctx.store, transition.id, "applied", null, { left, how: "response", parent: updated.parent_id, at: stamp(now) });
  return { done: true, next: null };
}

/** What a journaled restore request had found changed by somebody else: the words are only ever the two `Left` names. */
function journaledLeft(transition: TransitionRow): Left[] {
  if (transition.channel_state !== "intent") return [];
  const left = (transition.channel_plan?.restore as { left?: unknown } | undefined)?.left;
  return Array.isArray(left) ? left.filter((one): one is Left => one === "category" || one === "permissions") : [];
}

/** A refused, limited or lost request of the platform half. Nothing is called a change the platform did not show. */
async function channelError(ctx: TopicsContext, memory: TopicsMemory, topic: TopicRow, transition: TransitionRow,
  error: unknown, during: "read" | "edit"): Promise<Stepped> {
  const now = clock(ctx);
  const verdict = classify(error, ctx);
  if (verdict.kind === "rate_limited") {
    const at = now + verdict.retryAfterMs;
    if (verdict.global) memory.notBefore = Math.max(memory.notBefore, at);
    return { done: false, next: at };
  }
  const gone = verdict.failure.status === 404 && verdict.failure.discord_code === 10003;
  if (gone) {
    await markMissing(ctx, memory, topic, { listing: "not-consulted", [during]: "unknown-channel", during: transition.id, at: stamp(now) });
    return { done: false, next: null };
  }
  const { failures, retryAt } = backoffOf(ctx, transition);
  if (transition.channel_state === "intent" || (during === "edit" && verdict.kind === "uncertain")) {
    // A request may have landed: it stays journaled as intent, and it is read, not repeated blind, at the next look.
    return { done: false, next: now + ctx.retrySeconds * 1000 };
  }
  await recordChannel(ctx.store, transition.id, during === "read" ? "unknown" : "failed", null,
    { cause: verdict.failure.cause, code: verdict.failure.code, failures, retry_at: stamp(retryAt), at: stamp(now) });
  await say(ctx, memory, topic, { key: `${transition.kind}-pending:${transition.id}:${during === "read" ? "channel_unreadable" : "channel_failed"}`, origin: transition.route,
    originIsThisChat: transition.route?.chat === topic.chat,
    body: (language, platform) => archivePendingNotice(language, { platform, name: topic.display_name, chat: topic.chat,
      reason: during === "read" ? "channel_unreadable" : "channel_failed" }) });
  return { done: false, next: retryAt };
}

/** Ask the store to complete a transition. It says yes only when the channel and, for an archive, the stop are both shown. */
async function tryComplete(ctx: TopicsContext, memory: TopicsMemory, topic: TopicRow, loaded: TransitionRow): Promise<boolean> {
  // The row this pass was handed was read BEFORE the channel step ran, so its result is the one from before the step. What the
  // notice says is said from the result the store holds now, which is also what a restarted pass reads.
  const transition = (await readTransition(ctx.store, loaded.id)) ?? loaded;
  const registry = registryNow(ctx);
  const now = clock(ctx);
  const isArchive = transition.kind === "archive";
  // Where it was asked is where it is said, unless that chat cannot take it: a chat that is being archived, read only or gone
  // cannot. A reopen asked for inside the chat that is being reopened is said there, because it is restored by then. The
  // person's General is measured like any other chat, except that a reopen OF General is said in General, restored by then.
  const origin = transition.route;
  const askedHere = origin !== null && origin.door === topic.door && origin.chat === topic.chat;
  const route = registry === null ? null : await attentionFor(ctx.store, registry, { person: topic.person, origin,
    ...(askedHere ? { originUsable: !isArchive } : {}),
    ...(!isArchive && isGeneralOf(registry, topic) ? { generalUsable: true } : {}) });
  let notice: OutboxNotice | null = null;
  if (route !== null && route.ok) {
    let body: string;
    if (isArchive) {
      const stops = await stopsOf(ctx.store, transition.id);
      const stop = stops[0]?.state === "stopped" ? "stopped" : stops[0]?.state === "settled" ? "finished" : "idle";
      const delegated = await delegatedJobs(ctx.store, topic.agent_id);
      body = archiveDoneNotice(route.language, { platform: route.platform, name: topic.display_name, chat: topic.chat, stop, delegated });
    } else {
      const held = (await openHoldsOf(ctx.store, topic.conversation_id)).length;
      const left = ((transition.channel_result?.left ?? []) as string[]).map(one => wordOfLeft(route.language, one));
      body = reopenDoneNotice(route.language, { platform: route.platform, name: topic.display_name, chat: topic.chat, left, held });
    }
    notice = { person: topic.person, agent: route.agent, key: `topic:${transition.kind}-done:${transition.id}`, route: route.route, body };
  }
  // The completion, its notice and what is said of whether anybody could be told commit together: a notice that had nowhere to go
  // is kept on the topic, where check and inspect say it, and a gap is only cleared by the same commit that queued the notice.
  const answer = await atomically(ctx.store, async (tx) => {
    const done = await completeTransition(tx, transition.id, { at: stamp(now), notice: route === null ? "registry-unreadable" : route.ok ? route.via : route.cause }, notice);
    if (done === "complete" && route !== null) await noteAttention(tx, topic.id, `${transition.kind}-done`, route.ok ? null : route.cause);
    return done;
  });
  if (answer === "complete") return true;
  if (answer === "stop-pending") {
    const owned = await attemptsOf(ctx.store, { agent: topic.agent_id }, { ownedOnly: true });
    if (owned.some(one => one.state === "unknown" || one.state === "stop_unknown")) {
      await say(ctx, memory, topic, { key: `archive-pending:${transition.id}:stop_unknown`, origin: transition.route,
        originIsThisChat: transition.route?.chat === topic.chat,
        body: (language, platform) => archivePendingNotice(language, { platform, name: topic.display_name, chat: topic.chat, reason: "stop_unknown" }) });
    }
  }
  return false;
}

/** Whether this topic is the master of the chat that is its person's configured General. */
const isGeneralOf = (registry: unknown, topic: TopicRow): boolean => generalOf(registry, topic.person)?.id === topic.agent_id;

const wordOfLeft = (language: "en" | "ru", left: string): string =>
  left === "category" ? (language === "ru" ? "категорию" : "its category") : (language === "ru" ? "кто может писать" : "who can write in it");

/** Delegated jobs the master approved that have not finished. They are not stopped by an archive. */
async function delegatedJobs(store: StoreLike, agent: string): Promise<number> {
  const [row] = await store.sql`select count(*)::int as n from inbound
    where kind = 'job' and state not in ('answered', 'delivered') and source -> 'dispatch' -> 'return' ->> 'agent' = ${agent}`;
  return Number(row.n);
}

// ---------------------------------------------------------------------------------------------
// Watching the server
// ---------------------------------------------------------------------------------------------

export interface ObservedTransition {
  kind: "archive" | "reopen";
  from: string | null;
  to: string | null;
  /**
   * There was no earlier sample to compare with, so this is the chat's CURRENT state and not a change seen
   * happen: `from` is not known, and is not recorded as if it were. Only an active chat found inside the archive
   * category is one.
   */
  first: boolean;
}

/**
 * What a sample of a chat's category asks for, if anything, and so whether it is an archive or a reopen somebody made in
 * Discord. ONLY the category is compared: a rename, a new description or an edit of who may write is not a transition.
 *
 *  * An ACTIVE chat that was outside the archive category and is inside it now is an archive. One found inside it with
 *    NO earlier sample is the same request made from its current state (a master that was already archived by hand
 *    when it was first seen must not run for good), and says it is `first`. One first seen outside is a baseline and
 *    nothing at all: no history is reconstructed, and a change that completed between two looks is not one.
 *  * An ARCHIVED chat that is no longer where its archive put it (`archivedAt`, the category the completed archive left it
 *    in) is a reopen, whatever was sampled before, which is what makes a chat that was moved out while its archive was
 *    still waiting for the stop come back once that settled. Without the archive's own record it is the change from the
 *    archive category to somewhere else, as before.
 *  * An ACTIVE chat that a reopen has just settled is judged the same way, from where THAT OPERATION left it (`reopenedTo`,
 *    given only while nothing has been sampled since the reopen completed, so the sample in hand is older than the
 *    reopen and says nothing of it). A chat inside the archive category that the reopen left somewhere else was moved
 *    back in while the reopen was still open, and is an archive from where the reopen left it. One the reopen itself left
 *    inside the category (it could not know where the chat was before, and so did not move it) is not: being where the
 *    reopen put it is not a change.
 *  * A chat the Hub is archiving or reopening is not asked again, whichever way the category reads.
 */
export function observedTransitionOf(topic: Pick<TopicRow, "lifecycle">, before: Pick<ChannelSeen, "present" | "parent_id"> | null,
  now: { parent_id: string | null }, archive: { category: string } | null, archivedAt: string | null = null,
  reopenedTo: { parent_id: string | null } | null = null): ObservedTransition | null {
  if (archive === null) return null;
  const known = before !== null && before.present === true;
  const is = now.parent_id === archive.category;
  if (topic.lifecycle === "active") {
    if (!is) return null;
    if (reopenedTo !== null) {
      return reopenedTo.parent_id !== archive.category ? { kind: "archive", from: reopenedTo.parent_id, to: now.parent_id, first: false } : null;
    }
    if (!known) return { kind: "archive", from: null, to: now.parent_id, first: true };
    return before!.parent_id !== archive.category ? { kind: "archive", from: before!.parent_id, to: now.parent_id, first: false } : null;
  }
  if (topic.lifecycle === "archived") {
    if (is) return null;
    if (archivedAt !== null) return now.parent_id !== archivedAt ? { kind: "reopen", from: archivedAt, to: now.parent_id, first: false } : null;
    return known && before!.parent_id === archive.category ? { kind: "reopen", from: before!.parent_id, to: now.parent_id, first: false } : null;
  }
  return null;
}

/**
 * Where the newest completed reopen of this topic left its chat, but only while that is the freshest thing known of it: the
 * sample in hand (`before`) is older than the reopen's completion, so no look has stood on the reopen yet. Null when there
 * is no such reopen, when nothing was sampled before (a first sample is judged as one, and a repaired chat's old reopens are
 * not its own), or when the reopen recorded nothing (then the old sample is all there is, as before).
 *
 * WHICH IS OLDER IS THE STORE'S TO SAY, at the precision it keeps the two timestamps (microseconds): a JavaScript `Date` keeps
 * milliseconds, and a sample taken just before the completion, in the same millisecond, would then be called no older than it, and
 * the reopen's category discarded. The store answers only whether the completed reopen is strictly newer (`newer`); a sample taken
 * at or after the completion, and one that was never taken, are as they always were.
 *
 * A reopen made in Discord left the chat where the owner had put it: what was observed then. A reopen made by the tool left it
 * where the platform showed it when the step was applied, which is where the prior category was put back, or, when nothing
 * recorded that category and so the chat was deliberately not moved, the archive category itself. Both are the operation's own
 * durable record, so a restart between the reopen and the next look changes nothing.
 */
async function reopenLeftOf(ctx: TopicsContext, topic: TopicRow, before: ChannelSeen | null): Promise<{ parent_id: string | null } | null> {
  if (before === null || before.present !== true || before.seen_at === null) return null;
  const latest = await newestReopenSinceSample(ctx.store, topic.id);
  if (latest === null || !latest.newer) return null;
  const done = latest.transition;
  const category = (value: unknown): { parent_id: string | null } | null => (typeof value === "string" || value === null ? { parent_id: value } : null);
  if (done.source === "discord") return Object.hasOwn(done.evidence, "observed_to") ? category(done.evidence.observed_to) : null;
  const result = done.channel_result;
  return result !== null && Object.hasOwn(result, "parent") ? category(result.parent) : null;
}

/**
 * One read of the server's channels per interval, however many topics the door serves. What it
 * shows is written down; a category change becomes an archive or reopen; a chat missing from the
 * listing is asked for by id, and only the platform naming it as gone makes it gone. A listing
 * that failed, was refused or was limited changes nothing about any chat. A legacy master that was
 * retired from the registry is not watched: it has no binding to watch.
 */
async function observePhase(ctx: TopicsContext, memory: TopicsMemory): Promise<number | null> {
  const now = clock(ctx);
  const admin = ctx.platform.admin;
  if (!admin?.listChannels || !admin.readChannel) return null;
  const all = await topicsOfDoor(ctx.store, ctx.door, { create: ["bound", "legacy"], lifecycle: ["active", "archiving", "archived", "reopening"] });
  if (all.length === 0) return null;
  if (now < memory.nextObserve) return memory.nextObserve;
  if (now < memory.notBefore) return memory.notBefore;
  const period = Math.max(1, ctx.pollSeconds) * 1000;
  const registry = registryNow(ctx);
  // A registry that cannot be read says nothing of who is bound, and nothing is observed on a guess.
  if (registry === null) return now + Math.max(1, ctx.tickMs);
  const archive = archiveOf(registry, ctx.door);
  // AN ADOPTED MASTER IS WATCHED ONLY WHERE THE REGISTRY STILL BINDS IT: its full eligible binding (person, an ordinary master of
  // this door, this chat), and not retired. A retired master, one that became a worker or a seat, another person's, one edited onto
  // another chat or door, or one with a retired identity has no route to watch here, and nothing is done to the chat its topic
  // remembers. (What the topic then does about it is `reconcileRoute`'s.)
  const retired = all.some(one => one.origin === "legacy") ? await retiredTopicsOfDoor(ctx.store, ctx.door) : new Set<string>();
  const topics = all.filter(one => one.origin !== "legacy" || (!retired.has(one.id) && legacyBindingOf(registry, one).ok));
  if (topics.length === 0) return null;

  let channels: ChannelInfo[];
  try {
    channels = await admin.listChannels();
  } catch (error) {
    const verdict = classify(error, ctx);
    if (verdict.kind === "rate_limited") {
      const at = now + verdict.retryAfterMs;
      if (verdict.global) memory.notBefore = Math.max(memory.notBefore, at);
      memory.nextObserve = at;
      return at;
    }
    // Aged, not acted on: a listing that could not be read says nothing about any chat.
    for (const topic of topics) {
      await observeChannel(ctx.store, topic.id, null, { code: verdict.failure.code, cause: verdict.failure.cause, at: stamp(now) }, fenceOf(topic)).catch(() => {});
    }
    memory.nextObserve = now + period;
    return memory.nextObserve;
  }

  const byId = new Map(channels.map(one => [one.id, one]));
  let reads = 0;
  for (const topic of topics) {
    if (ctx.stop?.()) return null;
    if (topic.chat === null) continue;
    try {
      const before = await readSeen(ctx.store, topic.id);
      let channel: ChannelInfo | undefined = byId.get(topic.chat);
      if (channel === undefined) {
        // Not in a complete listing is not proof: it is asked for by id, and only "unknown channel" is gone.
        if (reads >= READS_PER_PASS) continue;
        reads += 1;
        const read = await admin.readChannel(topic.chat);
        // THE READ TOOK TIME, and the registry (or the topic) may have moved on while it was on its way: what it says of a chat
        // is judged again against the binding as it stands now before anything is written from it. The store fences the write too.
        if (!(await stillBound(ctx, topic))) continue;
        if (!read.exists) {
          await markMissing(ctx, memory, topic, { listing: "absent", read: "unknown-channel", at: stamp(now) });
          continue;
        }
        channel = read.channel;
      }
      // Where the completed archive left the chat, asked only for an archived chat that is somewhere else.
      let archivedAt: string | null = null;
      if (archive !== null && topic.lifecycle === "archived" && channel.parent_id !== archive.category) {
        const done = (await completedTransitions(ctx.store, topic.id, "archive"))[0];
        const applied = (done?.channel_plan as { apply_parent?: unknown } | null | undefined)?.apply_parent;
        archivedAt = typeof applied === "string" ? applied : null;
      }
      // Where a reopen that has just settled left the chat, asked only of an active chat that is inside the archive category and
      // whose last sample is older than that reopen: the one case in which a chat inside it may be a move made while the reopen
      // was open. A chat outside the category, or one sampled since, costs no statement.
      const reopenedTo = archive !== null && topic.lifecycle === "active" && channel.parent_id === archive.category
        ? await reopenLeftOf(ctx, topic, before) : null;
      const seen = observedTransitionOf(topic, before, channel, archive, archivedAt, reopenedTo);
      // Everything that follows is written about the route and generation this pass inspected, and only while the topic still
      // stands there (the store checks it under the row's lock): an adopted master that was moved to another chat, or repaired,
      // meanwhile is not archived, gated or sampled for what was seen of the chat it left.
      if (!(await stillBound(ctx, topic))) continue;
      let fence: RouteFence | null = fenceOf(topic);
      let recorded = true;
      if (seen !== null) {
        // THE CHANGE IS RECORDED BEFORE IT IS REMEMBERED. Only an operation that stands (made now, or already made under this
        // id) settles what was seen; any other answer (`stale` included), and a write that throws, leave the change to be seen again.
        const answer = await requestTransition(ctx.store, {
          operation: `observed:${topic.id}:${topic.lifecycle_generation + 1}`, topic: topic.id, kind: seen.kind, source: "discord",
          by: "discord:observed", route: null, fence,
          evidence: seen.first
            ? { first_observation: true, observed_to: seen.to, at: stamp(now) }
            : { observed_from: seen.from, observed_to: seen.to, at: stamp(now) },
        });
        recorded = answer === "ok" || answer === "replay";
        // A request that was made moved the generation on by one, and the sample that follows it is the topic's as it stands then.
        // One that was already made by an earlier look leaves the generation unknown here: nothing is written now, and the next look does.
        fence = answer === "ok" ? { chat: fence.chat, generation: fence.generation + 1 } : null;
      }
      // What an archive or reopen in flight has done to the category is not remembered: the topic is not in a state
      // that owns it, and it is looked at again from what the operation itself left once it settles.
      // A sample that was judged against a reopen's record is written at once, so the next look stands on it and not on the reopen.
      if (recorded && fence !== null && STEADY.includes(topic.lifecycle)) await noteSeen(ctx, before, topic, channel, reopenedTo !== null, fence);
    } catch (error) {
      // A refused read (403), a 5xx or a limit: the chat is not known to be gone, and only when it was tried is recorded.
      const verdict = classify(error, ctx);
      if (verdict.kind === "rate_limited") {
        const at = now + verdict.retryAfterMs;
        if (verdict.global) memory.notBefore = Math.max(memory.notBefore, at);
        memory.nextObserve = at;
        return at;
      }
      await observeChannel(ctx.store, topic.id, null, { code: verdict.failure.code, cause: verdict.failure.cause, at: stamp(now) }, fenceOf(topic)).catch(() => {});
    }
  }
  await attentionSweep(ctx, memory);
  memory.nextObserve = now + period;
  return memory.nextObserve;
}

/**
 * Remember what was seen, unless the record already says exactly that and is recent. Compared with the record the store
 * holds, not with anything this process remembers, so a record that was dropped (a chat repaired onto another) is written
 * again at once and a restart repeats nothing.
 */
async function noteSeen(ctx: TopicsContext, before: ChannelSeen | null, topic: TopicRow, channel: ChannelInfo, force: boolean, fence: RouteFence): Promise<void> {
  const now = clock(ctx);
  const same = !force && before !== null && before.present === true && before.last_error === null && before.parent_id === channel.parent_id
    && before.name === channel.name && before.seen_at !== null && now - before.seen_at.getTime() < REFRESH_MS;
  if (same) return;
  await observeChannel(ctx.store, topic.id, { present: true, parent_id: channel.parent_id, name: channel.name }, null, fence);
}

/**
 * Whether the topic and the registry still say what a pass inspected, judged again after a read that took time: for an adopted
 * master, the same route (door, chat) and lifecycle generation in the store and the full eligible binding in the registry as
 * it is NOW. A topic the Hub made never changes route, so it is not asked. False means the pass drops what it was about to write
 * (the next one starts from what stands), and a registry that cannot be read is not a registry that agrees.
 */
async function stillBound(ctx: TopicsContext, topic: TopicRow): Promise<boolean> {
  if (topic.origin !== "legacy") return true;
  const registry = registryNow(ctx);
  if (registry === null) return false;
  const fresh = await readTopic(ctx.store, topic.id);
  if (fresh === null || fresh.door !== topic.door || fresh.chat !== topic.chat || fresh.lifecycle_generation !== topic.lifecycle_generation) return false;
  return legacyBindingOf(registry, fresh).ok;
}

/**
 * Results that arrived for a master that is archived. They are kept, nothing claims them, and the
 * person is told once for each time the chat was archived, in General.
 */
async function attentionSweep(ctx: TopicsContext, memory: TopicsMemory): Promise<void> {
  const rows = (await ctx.store.sql`select t.id, t.lifecycle_generation, count(i.id)::int as n
      from topic t join inbound i on i.agent = t.agent_id
     where t.door = ${ctx.door} and t.lifecycle in ('archiving', 'archived')
       and i.kind = 'report' and i.state not in ('answered', 'delivered')
     group by t.id, t.lifecycle_generation`) as unknown as { id: string; lifecycle_generation: number; n: number }[];
  if (rows.length === 0) return;
  const all = await topicsOfDoor(ctx.store, ctx.door, { lifecycle: ["archiving", "archived"] });
  for (const row of rows) {
    const topic = all.find(one => one.id === row.id);
    if (!topic) continue;
    await say(ctx, memory, topic, { key: `results:${row.lifecycle_generation}`, origin: null,
      body: (language) => archivedResultsNotice(language, { name: topic.display_name, count: Number(row.n) }) });
  }
}

// ---------------------------------------------------------------------------------------------
// What could not be told
// ---------------------------------------------------------------------------------------------

/** Where a topic stands now, as a catch-up says it. */
const catchupStateOf = (topic: TopicRow): CatchupState =>
  topic.lifecycle === "active" ? "open" : topic.lifecycle === "archiving" ? "archiving" : topic.lifecycle === "archived" ? "archived"
    : topic.lifecycle === "reopening" ? "reopening" : topic.lifecycle === "channel_missing" ? "gone" : "setting_up";

/** How one topic's debt stands: paid (or none), payable once something changes in the store, or only once the registry does. */
type Caught = "done" | "wait" | "config";

/**
 * ATTENTION THAT COULD NOT BE TOLD IS OWED, and is paid as soon as a documented place can take it, whatever else the door has to
 * watch: a topic that is gone from Discord is not watched at all, and the very gap its disappearance left is the one this pays.
 * For each topic of the door with a persisted gap, ONE keyed notice names what was missed and where the topic stands now, in the
 * topic's own place when that can take it and otherwise the person's General (`attentionFor`; nowhere else, ever), and exactly those
 * gaps are cleared in the same transaction (`attentionCatchup`). Nothing is said to have been delivered: the notice is queued, and
 * its delivery is the outbox's. A route that is not usable, or a failed write, keeps the debt.
 *
 * WHAT KEEPS THE TASK DUE is only a debt that a change of the store can pay (General is archived, and reopens): the pass comes
 * again at the retry interval, and stops coming when it is paid. A debt only the registry can pay (no General, an unknown origin)
 * is woken by the registry change the door already hears (`door/run.ts`), and nothing polls for it. With no debt this is one
 * statement.
 */
export async function catchupPhase(ctx: TopicsContext, _memory: TopicsMemory): Promise<number | null> {
  const owing = (await ctx.store.sql`select id from topic
    where door = ${ctx.door} and jsonb_typeof(create_evidence -> 'attention') = 'object' and create_evidence -> 'attention' <> '{}'::jsonb
    order by created_at, id`) as unknown as { id: string }[];
  if (owing.length === 0) return null;
  const registry = registryNow(ctx);
  if (registry === null) return clock(ctx) + Math.max(1, ctx.tickMs);
  let waiting = false;
  for (const { id } of owing) {
    if (ctx.stop?.()) return null;
    try {
      const topic = await readTopic(ctx.store, id);
      if (topic !== null && (await catchUp(ctx, registry, topic)) === "wait") waiting = true;
    } catch (error) {
      // The write did not commit, so the gaps stand as they were, and it is tried again.
      await report(ctx, id, error);
      waiting = true;
    }
  }
  return waiting ? clock(ctx) + Math.max(1, ctx.retrySeconds) * 1000 : null;
}

/**
 * A topic's own gaps are paid toward the place it was asked for; a council's (`council/attention.ts`), which the same map keeps,
 * toward the chat the council answers in, which is this topic's own chat: that is where it was meant to be told. Each is its own
 * notice with its own key, and a gap of a council that is gone is cleared without one.
 */
async function catchUp(ctx: TopicsContext, registry: unknown, topic: TopicRow): Promise<Caught> {
  const debt = await debtOf(ctx.store, topic);
  const council = (one: AttentionDebt): boolean => councilGapOf(one.kind) !== null;
  const own = topic.chat === null ? null : { door: topic.door, chat: topic.chat };
  const paid = [
    await payDebt(ctx, registry, topic, debt.filter(one => !council(one)), originOf(topic)),
    await payDebt(ctx, registry, topic, debt.filter(council), own),
  ];
  return paid.includes("wait") ? "wait" : paid.includes("config") ? "config" : "done";
}

async function payDebt(ctx: TopicsContext, registry: unknown, topic: TopicRow, debt: AttentionDebt[], origin: { door: string; chat: string } | null): Promise<Caught> {
  if (debt.length === 0) return "done";
  const route = await attentionFor(ctx.store, registry, { person: topic.person, origin });
  if (!route.ok) return route.cause === "general_unusable" ? "wait" : "config";
  const state = catchupStateOf(topic);
  const kinds: string[] = [];
  const councils: string[] = [];
  for (const one of debt) {
    const words = needWords(route.language, councilGapOf(one.kind)?.need ?? "");
    if (words === null) kinds.push(one.kind);
    else councils.push(words);
  }
  const notice: OutboxNotice = {
    person: topic.person, agent: route.agent, route: route.route,
    // The store names the notice after the occurrences it stands for.
    key: "topic:attention-catchup",
    body: attentionCatchupNotice(route.language, { platform: route.platform, name: topic.display_name,
      chat: state === "gone" || state === "setting_up" ? null : topic.chat, kinds, councils, state }),
  };
  const answer = await attentionCatchup(ctx.store, topic.id, debt.map(({ kind, seq }) => ({ kind, seq })), notice);
  // `stale` is a gap that changed between the read and the lock: nothing was written, and the next look reads it again.
  return answer === "stale" ? "wait" : "done";
}

// ---------------------------------------------------------------------------------------------
// The task
// ---------------------------------------------------------------------------------------------

/**
 * The door's topic task: one loop, woken by the notification the store sends the door, resting
 * with no timer when nothing is waiting on time. `ready` resolves after the first pass has been
 * made, which the door starts only once every chat it serves is being read, so the task's first
 * reads never race the door's own connect reads.
 */
export interface TopicsTask {
  wake(): void;
  ready: Promise<void>;
  stop(): Promise<void>;
}

export function startTopics(options: {
  store: Store;
  platform: TopicsContext["platform"];
  door: string;
  registry: () => unknown;
  stateDir: string;
  settings: () => { retrySeconds: number; maxAttempts: number; pollSeconds: number };
  tickMs: number;
}): TopicsTask {
  let stopping = false;
  let poke: (() => void) | null = null;
  let poked = false;
  const wake = (): void => {
    const waiting = poke;
    poke = null;
    if (waiting) waiting();
    else poked = true;
  };
  const rest = (ms: number | null): Promise<void> => new Promise<void>((resolve) => {
    if (poked) { poked = false; resolve(); return; }
    let timer: ReturnType<typeof setTimeout> | null = null;
    poke = () => { if (timer !== null) clearTimeout(timer); resolve(); };
    if (ms !== null) timer = setTimeout(() => { poke = null; resolve(); }, Math.max(1, ms));
  });
  const memory = newTopicsMemory();
  const context = (): TopicsContext => ({
    store: options.store, platform: options.platform, door: options.door, registry: options.registry, stateDir: options.stateDir,
    tickMs: options.tickMs, stop: () => stopping, ...options.settings(),
  });
  let release!: () => void;
  const ready = new Promise<void>((resolve) => { release = resolve; });
  let failing = false;
  const said = (error: unknown): void => {
    if (!failing) {
      process.stderr.write(finding("en", { code: "topics:pass-failed", target: options.door, cause: safeValue((error as Error)?.message ?? error) }) + "\n");
    }
    failing = true;
  };
  const done = (async () => {
    let next: number | null = null;
    try { next = await runTopicPass(context(), memory); }
    catch (error) { next = Date.now() + options.tickMs; said(error); }
    finally { release(); }
    while (!stopping) {
      await rest(next === null ? null : next - Date.now());
      if (stopping) break;
      try { next = await runTopicPass(context(), memory); failing = false; }
      catch (error) { next = Date.now() + options.tickMs; said(error); }
    }
  })();
  return {
    wake,
    ready,
    async stop() { stopping = true; wake(); await done; },
  };
}
