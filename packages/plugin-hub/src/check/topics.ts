import { listAgents, listPeople } from "../registry/entries.ts";
import { generalOf, legacyBindingOf } from "../registry/topics.ts";
import type { StoreLike } from "../store/connect.ts";
import { attentionGapsOf } from "../store/topics.ts";
import { findingId, type Finding } from "./finding.ts";

/**
 * What a person has to know about their topic chats, as findings: a creation nobody could settle
 * and that nothing will make again by itself, a chat that is made and not yet connected to its
 * agent, an archive or reopen that is not finishing and why, a chat that vanished from Discord,
 * an agent that the registry names and the store says is never to be used again, and topics with
 * no General to say anything in.
 *
 * Each finding is about ONE thing, keyed on it, so it disappears when the thing is settled. The
 * ages are chosen, not measured: how long a bind or a transition is allowed to look unfinished
 * before it is said is not the owner's number and is not a promise about how long either takes.
 */

/** A chat that has its channel and no agent in the registry for this long is said. */
export const BIND_GRACE_MS = 5 * 60 * 1000;
/** An archive or reopen that is still open after this long is said, with what it is waiting for. */
export const TRANSITION_GRACE_MS = 10 * 60 * 1000;

interface TopicFindingRow {
  id: string; display_name: string; door: string; chat: string | null; agent_id: string; person: string; origin: string; create_state: string;
  lifecycle: string; missing_from: string | null; updated_at: Date; channel_known_at: Date | null; decision_seq: number;
  create_evidence: Record<string, unknown>; create_failure: Record<string, unknown> | null;
}

interface OpenTransitionRow {
  id: string; topic_id: string; kind: string; stage: string; channel_state: string; channel_result: Record<string, unknown> | null; created_at: Date;
}

export async function topicFindings(args: {
  store: StoreLike;
  registry: unknown;
  machine: string;
  now: Date;
  /** The doors this machine runs: a topic is said by the machine its door is on, so two machines never say one twice. */
  doors: ReadonlySet<string>;
  /** The agents of this machine's runners, which are the ones whose identity is checked. */
  agents: readonly string[];
}): Promise<Finding[]> {
  const findings: Finding[] = [];
  const topics = ((await args.store.sql`select id, display_name, door, chat, agent_id, person, origin, create_state, lifecycle, missing_from,
      updated_at, channel_known_at, decision_seq, create_evidence, create_failure from topic`) as unknown as TopicFindingRow[])
    .filter(one => args.doors.has(one.door));
  const opens = (await args.store.sql`select id, topic_id, kind, stage, channel_state, channel_result, created_at
    from topic_transition where state = 'open'`) as unknown as OpenTransitionRow[];
  const byId = new Map(topics.map(one => [one.id, one]));
  const age = (at: Date): number => args.now.getTime() - new Date(at).getTime();

  for (const topic of topics) {
    const subject = topic.id;
    if (topic.create_state === "creation_unknown" || topic.create_state === "failed") {
      if (topic.create_state === "creation_unknown") {
        findings.push({
          id: findingId(args.machine, "topic-creation-unknown", subject), kind: "topic-creation-unknown", subject, machine: args.machine,
          says: `the chat ${topic.display_name} may or may not have been made: the platform's answer was lost and no channel carrying its marker was found. Nothing was created again and nothing was deleted`,
          fix: "look for the channel in the server; then tell General: creation_decision adopt with its id, or recreate to ask for it once more",
        });
      } else {
        findings.push({
          id: findingId(args.machine, "topic-create-failed", subject), kind: "topic-create-failed", subject, machine: args.machine,
          says: `the platform refused to make the chat ${topic.display_name} (${String(topic.create_failure?.cause ?? "refused")}), and nothing was made. Nothing asks again by itself`,
          fix: "fix what was refused (the bot's permission to manage channels), then tell General: creation_decision adopt with a channel that is there, or recreate",
        });
      }
      // The owner named a channel for it and it cannot be used: kept on the topic for that decision, and said here until another is made.
      const refused = topic.create_evidence.adopt_refused as { seq?: unknown; chat?: unknown; code?: unknown; cause?: unknown } | undefined;
      if (refused !== undefined && Number(refused.seq) === Number(topic.decision_seq)) {
        findings.push({
          id: findingId(args.machine, "topic-adopt-refused", subject), kind: "topic-adopt-refused", subject, machine: args.machine,
          says: `the channel named for the chat ${topic.display_name} (${String(refused.chat)}) cannot be used: ${String(refused.cause)} (${String(refused.code)}). Nothing was created and nothing was deleted`,
          fix: "name another channel (creation_decision adopt with its id), or ask for the chat to be made again (recreate)",
        });
      }
    } else if ((topic.create_state === "channel_known" || topic.create_state === "bind_intent")
      // From the moment the channel became known, never from the last attempt: a refused bind that is tried again every minute
      // must not look as fresh as the first one.
      && age(topic.channel_known_at ?? topic.updated_at) > BIND_GRACE_MS) {
      const why = topic.create_failure ? `: ${String(topic.create_failure.cause ?? "refused")}${topic.create_failure.code === undefined ? "" : ` (${String(topic.create_failure.code)})`}` : `, and the hub on ${args.machine} has not done it`;
      findings.push({
        id: findingId(args.machine, "topic-bind-stuck", subject), kind: "topic-bind-stuck", subject, machine: args.machine,
        says: `the chat ${topic.display_name} exists and its agent is not connected to it yet${why}`,
        fix: `check the hub on ${args.machine}: imprnt hub status <registry> ${args.machine}; the chat and the owner's message are kept and nothing is lost`,
      });
    } else if (topic.lifecycle === "channel_missing") {
      findings.push({
        id: findingId(args.machine, "topic-channel-missing", subject), kind: "topic-channel-missing", subject, machine: args.machine,
        says: `the chat ${topic.display_name} was deleted in Discord. Its agent and history are kept, nothing was erased, and the agent takes no new work. Deleting them is not available yet`,
        fix: "nothing to run: the owner is asked in General, and the topic stays as it is until deleting exists",
      });
    }
    // An adopted master whose registry entry was edited onto another route while its topic could not follow: the door moves an
    // ACTIVE topic (or one gone while active) by itself, so what is left here is what it must not touch, and it is said by name.
    if (topic.origin === "legacy") {
      const bound = legacyBindingOf(args.registry, { agent_id: topic.agent_id, person: topic.person, door: topic.door, chat: topic.chat });
      if (!bound.ok && (bound.code === "door_changed" || bound.code === "chat_changed" || bound.code === "person_changed")) {
        const followed = topic.lifecycle === "active" || (topic.lifecycle === "channel_missing" && topic.missing_from === "active");
        if (!followed || bound.code === "person_changed") {
          const now = bound.agent === null ? "somewhere else" : `${bound.agent.door}/${bound.agent.chat} for ${bound.agent.person}`;
          findings.push({
            id: findingId(args.machine, "topic-binding-mismatch", subject), kind: "topic-binding-mismatch", subject, machine: args.machine,
            says: `the registry binds ${topic.agent_id} to ${now}, but its topic ${topic.display_name} is ${topic.lifecycle.replace(/_/g, " ")} on ${topic.door}/${topic.chat ?? "no chat"}. Its archive, its gates and its history belong to that chat and none of it was applied to the new route; nothing watches the new route`,
            fix: bound.code === "person_changed" ? `give ${topic.agent_id} back to ${topic.person} in the registry`
              : `put [[agents]] ${topic.agent_id} back on door ${topic.door}, chat ${topic.chat ?? "(none)"} (a route edit is followed only by an active chat), or reopen the chat first if it is archived`,
          });
        }
      }
    }
    // Something the person needed to be told and neither the chat nor General could take. A person with no General configured
    // has their own finding below, and is not said twice.
    for (const gap of attentionGapsOf(topic)) {
      if (gap.cause === "general_not_configured") continue;
      findings.push({
        id: findingId(args.machine, "topic-attention-unavailable", `${subject}:${gap.kind}`), kind: "topic-attention-unavailable", subject: `${subject}:${gap.kind}`, machine: args.machine,
        says: `${topic.display_name} needed to tell ${topic.person} something (${gap.kind}), and neither its chat nor their General could take it (${gap.cause}). Nothing was recorded as told`,
        fix: gap.cause === "general_unusable" ? "reopen General (move its channel out of the archive category) or set another chat as general on the person's [[people]] entry"
          : "check the chat's entry in the registry: it is not one of this person's chats",
      });
    }
  }

  for (const open of opens) {
    const topic = byId.get(open.topic_id);
    if (!topic || open.kind === "deletion_request" || age(open.created_at) <= TRANSITION_GRACE_MS) continue;
    const waitingFor = open.channel_state === "failed" || open.channel_state === "unknown"
      ? `the platform (${String(open.channel_result?.cause ?? "not answering")})`
      : open.channel_state === "applied" ? "the agent's process to be shown stopped" : "the channel change";
    findings.push({
      id: findingId(args.machine, "topic-transition-stuck", open.id), kind: "topic-transition-stuck", subject: open.id, machine: args.machine,
      says: `${open.kind === "archive" ? "archiving" : "reopening"} ${topic.display_name} is not finished and is waiting for ${waitingFor}`,
      fix: open.channel_state === "applied"
        ? `${topic.agent_id}'s attempt is not shown to be over: see the attempt-held finding for it`
        : "check the bot's Manage Channels permission and the archive category in the registry; the chat stays as it is until it is done",
    });
  }

  // The registry names an agent whose identity was retired. The store already refuses it a conversation and a message.
  const reserved = new Set(((await args.store.sql`select id from identity_reservation where kind = 'agent'`) as unknown as { id: string }[]).map(row => row.id));
  if (reserved.size > 0) {
    const named = new Set(args.agents);
    for (const agent of listAgents(args.registry)) {
      if (!reserved.has(agent.id) || !named.has(agent.id)) continue;
      findings.push({
        id: findingId(args.machine, "reserved-identity-in-registry", agent.id), kind: "reserved-identity-in-registry", subject: agent.id, machine: args.machine,
        says: `the registry names the agent ${agent.id}, whose identity was retired and is never used again. The store refuses it a conversation and a message, so it cannot run`,
        fix: `remove [[agents]] ${agent.id} from the registry`,
      });
    }
  }

  // Topics with nowhere to say anything that needs the person: no General is configured for them, or the configured one is a chat
  // that cannot take a line (archived, being reopened or gone). Whether its agent could think is not asked: a notice is the door's.
  const withTopics = new Set(topics.filter(one => one.create_state === "bound" || one.create_state === "legacy" || one.lifecycle !== "pending").map(one => one.person));
  for (const person of listPeople(args.registry)) {
    if (!withTopics.has(person.id)) continue;
    const general = generalOf(args.registry, person.id);
    if (general === null) {
      findings.push({
        id: findingId(args.machine, "general-not-configured", person.id), kind: "general-not-configured", subject: person.id, machine: args.machine,
        says: `${person.id} has topic chats and names no General, so anything about them that cannot be said in the chat it belongs to (an archived or deleted chat) has nowhere to go`,
        fix: `set general = "<agent id>" on ${person.id}'s [[people]] entry, naming the agent whose chat is their General`,
      });
      continue;
    }
    const held = topics.find(one => one.agent_id === general.id);
    if (held !== undefined && ["archiving", "archived", "reopening", "channel_missing"].includes(held.lifecycle)) {
      findings.push({
        id: findingId(args.machine, "general-unusable", person.id), kind: "general-unusable", subject: person.id, machine: args.machine,
        says: `${person.id}'s General (${general.id}) is ${held.lifecycle.replace(/_/g, " ")}, so it cannot take a notice, and anything about their other chats that cannot be said in the chat it belongs to has nowhere to go`,
        fix: held.lifecycle === "channel_missing" ? `set general = "<agent id>" on ${person.id}'s [[people]] entry, naming a chat that exists`
          : "move General's channel out of the archive category in Discord (that reopens it), or name another chat as general",
      });
    }
  }
  return findings;
}
