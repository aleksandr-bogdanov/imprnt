import { stamp } from "../records/stamps.ts";
import { ToolError } from "../mcp/reading.ts";
import type { McpBinding } from "../mcp/handlers.ts";
import type { ToolReply } from "../mcp/contracts.ts";
import { listAgents, senderAllowed } from "../registry/entries.ts";
import type { Registry } from "../registry/load.ts";
import type { StoreLike } from "../store/connect.ts";
import type { InboundSource, JobSource } from "../store/inbound.ts";
import { answerOf, type Evidence } from "./jobs.ts";
import { membersOf, patchCouncil, type CouncilRow, type Lifecycle, type MemberRow, type ParticipantRow, type Route } from "./rows.ts";

/**
 * What every action of `hub_council` needs before it does anything: whose council this is
 * and where it answers, what the reply says, and how the master's own attempt takes over the
 * events that were waiting for it.
 */

export interface Home {
  person: string;
  master: { agent: string; conversation: string | null };
  route: Route;
  proposer: { kind: "master" | "worker"; agent: string; conversation: string };
  parent_job: string | null;
}

/**
 * Where a council started from this conversation belongs and returns to.
 *
 * A MASTER'S IS ITS OWN CHAT. A WORKER'S IS ITS PARENT'S: the master and the chat the job it is doing was
 * dispatched from, read from that job's own pinned return route and never from anything the worker says.
 * A worker has no owner messages and inherits no authorization: it can only propose, and the owner it
 * proposes to is the one who approved the job it is doing, checked against the person's allowed senders now.
 */
export async function homeOf(binding: McpBinding, registry: Registry): Promise<Home> {
  if (binding.kind === "master") {
    const agent = listAgents(registry).find(one => one.id === binding.agent);
    if (!agent || agent.person !== binding.person || agent.door === undefined || agent.chat === undefined) {
      throw new ToolError("not_owner_conversation", "this conversation has no chat of its own for a council to answer in");
    }
    return { person: binding.person, master: { agent: binding.agent, conversation: binding.conversation },
      route: { agent: binding.agent, door: agent.door, chat: agent.chat },
      proposer: { kind: "master", agent: binding.agent, conversation: binding.conversation }, parent_job: null };
  }
  const attempt = binding.attempt();
  const [job] = attempt
    ? (await binding.store.sql`select i.id, i.source from execution e join inbound i on i.id = e.inbound_id where e.id = ${attempt}`) as unknown as { id: string; source: JobSource | null }[]
    : (await binding.store.sql`select i.id, i.source from conversation c join inbound i on i.id = c.owner_ref where c.id = ${binding.conversation}`) as unknown as { id: string; source: JobSource | null }[];
  const back = job?.source?.dispatch?.return;
  if (!job || !back?.agent || !back.door || !back.chat) throw new ToolError("not_owner_conversation", "this worker's job has no master to return to, so it cannot propose a council");
  const parent = listAgents(registry).find(one => one.id === back.agent);
  if (!parent || parent.person !== binding.person || parent.door !== back.door || parent.chat !== back.chat) {
    throw new ToolError("not_owner_conversation", "the master this job returns to is not this owner's agent in that chat any more");
  }
  const [master] = (await binding.store.sql`select id from conversation where kind = 'master' and agent = ${back.agent}`) as unknown as { id: string }[];
  return { person: binding.person, master: { agent: back.agent, conversation: master?.id ?? null },
    route: { agent: back.agent, door: back.door, chat: back.chat },
    proposer: { kind: "worker", agent: binding.agent, conversation: binding.conversation }, parent_job: job.id };
}

/**
 * The owner a proposal is pinned to: for a master, the sender of the newest message in its chat from
 * someone the person allows; for a worker, whoever approved the job it is doing. Nobody else's reaction
 * approves it, and the door checks the standing again when the reaction is read.
 */
export async function approverOf(binding: McpBinding, registry: Registry, home: Home): Promise<string> {
  if (binding.kind === "worker") {
    const attempt = binding.attempt();
    const [job] = attempt
      ? (await binding.store.sql`select i.source from execution e join inbound i on i.id = e.inbound_id where e.id = ${attempt}`) as unknown as { source: JobSource | null }[]
      : (await binding.store.sql`select i.source from conversation c join inbound i on i.id = c.owner_ref where c.id = ${binding.conversation}`) as unknown as { source: JobSource | null }[];
    const by = job?.source?.dispatch?.approved?.by;
    if (typeof by === "string" && by !== "" && senderAllowed(registry, home.person, home.route.door, by)) return by;
    throw new ToolError("not_allowed", "the job this worker is doing was not approved by a sender this person allows now, so there is nobody to approve a council");
  }
  const rows = (await binding.store.sql`select source from inbound where agent = ${binding.agent} and person = ${binding.person} and kind = 'human' and source is not null
    order by received_at desc, id desc limit 20`) as unknown as { source: InboundSource }[];
  const found = rows.find(row => row.source.sender_id && senderAllowed(registry, home.person, home.route.door, row.source.sender_id));
  if (!found) throw new ToolError("not_allowed", "no message from a sender this person allows is here to pin the approval to");
  return found.source.sender_id;
}

/** A council's lifecycle in the words of the one reply shape. `stage` carries the rest. */
export function statusOf(lifecycle: Lifecycle): ToolReply["status"] {
  switch (lifecycle) {
    case "waiting_owner": return "waiting_owner";
    case "stopping": return "stopping";
    case "stopped": return "stopped";
    case "complete": return "complete";
    default: return "running";
  }
}

export function replyOf(council: Pick<CouncilRow, "id" | "revision" | "lifecycle">, reply: { operation?: string | null; status?: ToolReply["status"]; stage: string; message: string; cause?: string; extra?: Record<string, unknown> }): ToolReply {
  return { operation_id: reply.operation ?? null, object_id: council.id, revision: council.revision, status: reply.status ?? statusOf(council.lifecycle),
    stage: reply.stage, ...(reply.cause ? { cause: reply.cause } : {}), status_message: reply.message, ...(reply.extra ?? {}) };
}

/**
 * The events waiting for the master are taken over by the master's own attempt when it acts on the
 * council in a turn of its own: each is recorded as read by that attempt and closed, so the same
 * condition is not handed to the master a second time as a turn of its own when it has already
 * dealt with it. The rows are stamped answered by machinery (they are the hub's notes to the master
 * and have no reply), never while somebody holds one for feeding. A council waiting for its master
 * is then, truthfully, being assessed by it.
 */
export async function adoptPendingEvents(tx: StoreLike, council: CouncilRow, attempt: string | null): Promise<void> {
  const pending = (await tx.sql`select e.seq, e.inbound_id from council_event e join inbound i on i.id = e.inbound_id
    where e.council_id = ${council.id} and e.consumed_at is null and i.claimed_by is null and i.state = 'received' order by e.seq`) as unknown as { seq: number; inbound_id: string }[];
  for (const one of pending) {
    await stamp(tx, { messageId: one.inbound_id, kind: "answered", actor: "runner" });
    await tx.sql`update council_event set consumed_at = now(), consumed_attempt = ${attempt}, disposition = 'in_turn' where council_id = ${council.id} and seq = ${one.seq}`;
  }
  if (council.lifecycle === "waiting_master") await patchCouncil(tx, council.id, { lifecycle: "assessing" });
}

/** The answers a brief quotes, by number, verbatim: the master names whose, and cannot change what they said. */
export async function evidenceFor(
  tx: StoreLike,
  participants: readonly ParticipantRow[],
  members: readonly MemberRow[],
  refs: readonly { participant_id: string; round?: number }[] | undefined,
): Promise<Evidence[]> {
  const out: Evidence[] = [];
  for (const ref of refs ?? []) {
    const participant = participants.find(one => one.id === ref.participant_id);
    if (!participant) throw new ToolError("unknown_participant", `${ref.participant_id} is not a participant of this council, so its answer cannot be quoted`);
    const answered = members.filter(one => one.participant_id === participant.id && one.state === "answered" && (ref.round === undefined || one.round === ref.round));
    const member = answered.sort((a, b) => b.round - a.round || b.input_revision - a.input_revision)[0];
    if (!member) throw new ToolError("invalid_arguments", `participant ${participant.ordinal} has no answer${ref.round === undefined ? "" : ` in round ${ref.round}`} to quote`);
    const answer = await answerOf(tx, member);
    if (!answer) throw new ToolError("invalid_arguments", `participant ${participant.ordinal}'s answer has no recorded text to quote`);
    out.push({ participant: participant.ordinal, round: member.round, text: answer.text, truncated: answer.truncated });
  }
  return out;
}

/** The council's inputs of one round, as rows. */
export const roundMembers = (members: readonly MemberRow[], round: number): MemberRow[] => members.filter(one => one.round === round);

export async function allMembers(tx: StoreLike, council: string): Promise<MemberRow[]> {
  return await membersOf(tx, council);
}
