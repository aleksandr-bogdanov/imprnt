import { adoptPendingEvents, approverOf, homeOf, replyOf, statusOf } from "../council/access.ts";
import { COUNCIL_START, type ProposalPayload } from "../council/approval.ts";
import { checkpointReached } from "../council/checkpoint.ts";
import { fenceCouncilWork } from "../council/fence.ts";
import { proposalPreview } from "../council/lines.ts";
import { chainOf, reconcileCouncil, reconcileInside } from "../council/reconcile.ts";
import { resolveRoster } from "../council/roster.ts";
import {
  conversationOfParticipant, createdAtOf, decisionsOf, eventsOf, membersOf, participantsOf, patchCouncil, patchMember, readCouncil, recordDecision, roundsOf,
  type CouncilRow,
} from "../council/rows.ts";
import { readSnapshot } from "../council/snapshot.ts";
import { councilIdOf, platformOf, quietSecondsOf, startCouncil } from "../council/start.ts";
import { languageOf } from "../registry/entries.ts";
import { ConfirmationRefused, freezeConfirmation } from "../store/confirmations.ts";
import { describeStop } from "../store/controls.ts";
import { HUB_COUNCIL, ToolError, type ToolReply } from "./contracts.ts";
import type { InspectRequest, StartRequest, StopRequest } from "./council-contract.ts";
import { councilContinue } from "./council-continue.ts";
import type { McpBinding } from "./handlers.ts";
import { Undo, operationFor, refusal, requireMaster, runRequest } from "./requests.ts";

/**
 * `hub_council`: start, inspect, stop (`council-continue.ts` has continue). Every change is
 * one `runRequest` transaction: the call recorded under its key, the owner's messages as
 * evidence, the change and the answer together, and nothing left behind by a refusal.
 *
 * WHAT CODE CHECKS HERE AND WHAT IT DOES NOT. It checks that the messages cited are the owner's,
 * sent to this agent, newer than what they authorize and not spent on another request; that the
 * roster is exactly configured workers with exactly their configured preset and machine; that a
 * proposal is shown to the owner frozen and starts only on their reaction. It does NOT check that
 * the owner's words mean "a council" or "these three": the master reads them, the ids are its statement
 * that it did, and no classifier is put in to hide that.
 */

/** The owner asked for a council and named who takes part: it starts at once, with no second approval. */
async function start(binding: McpBinding, request: StartRequest): Promise<ToolReply> {
  const registry = binding.registry();
  if (binding.kind === "worker" && !request.proposal) {
    throw new ToolError("not_owner_conversation", "a worker has no owner to ask: it can only propose a council, with authority {proposal: true}, and the owner approves it");
  }
  const home = await homeOf(binding, registry);
  // A worker cannot put itself on its own council: one attempt of an agent runs at a time.
  const roster = resolveRoster(registry, home.person, [home.master.agent, binding.agent], request.participants);
  if (!roster.ok) {
    return {
      operation_id: null, object_id: null, revision: null, status: "waiting_owner", stage: "needs_participants", cause: "needs_participants",
      status_message: "Nothing was started and nothing was queued. The owner has not fully said who takes part. Ask them, offering these choices, then call start again with every participant's worker_ref, preset_ref, machine_ref and a brief. Do not choose for them.",
      reason: roster.needs.reason, incomplete: roster.needs.incomplete, choices: roster.needs.choices,
    };
  }
  const operation = operationFor(binding, request);
  const id = councilIdOf(operation);
  const at = new Date().toISOString();

  if (request.proposal) {
    // Read before the transaction opens, on the store's own connection: the owner it is pinned to is a fact about the chat.
    const approver = await approverOf(binding, registry, home);
    return await runRequest(binding, {
      tool: HUB_COUNCIL, request, object: id,
      async apply(tx) {
        const payload: ProposalPayload = { kind: COUNCIL_START, person: home.person, master: home.master, route: home.route, proposer: home.proposer,
          parent_job: home.parent_job, question: request.question, context: request.context, participants: roster.participants, debate: request.debate,
          request_key: request.request_key, at };
        const { preview, confirmation } = proposalPreview(languageOf(registry, home.person), {
          question: request.question, context: request.context, debate: request.debate, proposer: { kind: home.proposer.kind, agent: home.proposer.agent },
          participants: roster.participants.map(one => ({ worker_ref: one.worker_ref, preset_ref: one.preset_ref, machine: one.machine,
            model: String(one.preset_snapshot.model ?? ""), brief: one.brief })) });
        try {
          const frozen = await freezeConfirmation(tx, { operationId: operation, operationKind: COUNCIL_START, person: home.person, door: home.route.door,
            chat: home.route.chat, ownerSender: approver, payload, preview, confirmation, platform: platformOf(registry, home.route.door) });
          return { operation_id: operation, object_id: id, revision: null, status: "awaiting_confirmation", stage: "awaiting_confirmation",
            status_message: "Nothing has started. The owner was shown exactly this roster, and only their reaction starts it. Do not start it another way, and do not ask again unless they change it.",
            confirmation: { revision: frozen.revision, state: frozen.state },
            participants: roster.participants.map(one => ({ worker_ref: one.worker_ref, preset_ref: one.preset_ref, machine: one.machine })) };
        } catch (error) {
          if (error instanceof ConfirmationRefused) return refusal(id, `confirmation_${error.code}`, error.message);
          throw error;
        }
      },
    });
  }

  return await runRequest(binding, {
    tool: HUB_COUNCIL, request, object: id,
    async apply(tx, _context, owner) {
      const made = await startCouncil(tx, {
        operation, person: home.person, master: home.master, route: home.route, origin_kind: "owner_request",
        origin: { source_message_ids: request.source_message_ids, sender: owner.sender, proposer: home.proposer, attempt: binding.attempt() },
        parent_job: null, question: request.question, context: request.context, participants: roster.participants,
        debate: request.debate ? { kind: "start", source_message_ids: request.source_message_ids ?? [], at } : null,
        approvedBy: owner.sender, registry, actor: "runner",
        decision: { conversation: binding.conversation, request_key: request.request_key, sources: request.source_message_ids ?? [], attempt: binding.attempt() },
        at,
      });
      const council = (await readCouncil(tx, made.id))!;
      const participants = await participantsOf(tx, made.id);
      return replyOf(council, { operation, stage: "workers_running",
        message: "The council started. Its participants are working independently and their answers will come back to you as one event when every required answer is in. You may go on talking with the owner meanwhile; a question or an unrelated message changes nothing about the council.",
        extra: { debate_opted_in: council.debate_opt_in !== null, participants: participants.map(one => ({ participant_id: one.id, ordinal: one.ordinal, worker_ref: one.worker_agent,
          preset_ref: one.preset_name, preset_id: one.preset_id, machine: one.machine })) } });
    },
  });
}

const ANSWER_ENTRY_CAP = 6000;
const EXCERPT = 300;

/** The council as it is, with per-participant evidence. It reads and reconciles; it changes nothing the owner decides. */
async function inspect(binding: McpBinding, request: InspectRequest): Promise<ToolReply> {
  requireMaster(binding, "inspect a council");
  await reconcileCouncil(binding.store, request.council_id);
  const council = await readCouncil(binding.store, request.council_id);
  if (!council || council.agent !== binding.agent || council.person !== binding.person) {
    const pending = (await binding.store.sql`select operation_id from confirmation where operation_kind = 'council.start' and person = ${binding.person} and state = 'pending'`) as unknown as { operation_id: string }[];
    if (pending.some(one => councilIdOf(one.operation_id) === request.council_id)) {
      return { operation_id: null, object_id: request.council_id, revision: null, status: "awaiting_confirmation", stage: "awaiting_confirmation",
        status_message: "The owner has been shown this council and has not approved it yet. Nothing has started." };
    }
    throw new ToolError("unknown_council", "no council of this owner has that id");
  }
  const store = binding.store;
  const now = new Date();
  const registry = binding.registry();
  const snapshot = await readSnapshot(store, council.id, { now, quietSeconds: quietSecondsOf(registry) });
  const participants = await participantsOf(store, council.id);
  const members = await membersOf(store, council.id);
  const rounds = await roundsOf(store, council.id);
  const events = await eventsOf(store, council.id);
  const decisions = await decisionsOf(store, council.id);
  const views = new Map((snapshot?.members ?? []).map(one => [one.participant, one]));

  const shown = request.round === undefined ? members : members.filter(one => one.round === request.round);
  const answers = new Map<string, string>();
  for (const member of shown) {
    if (member.state !== "answered") continue;
    const id = member.report_id ?? (member.inbound_id ? `report:${member.inbound_id}` : null);
    if (!id) continue;
    const [row] = (await store.sql`select body from inbound where id = ${id}`) as unknown as { body: string }[];
    if (row) answers.set(`${member.participant_id}:${member.round}:${member.input_revision}`, row.body);
  }

  let entries: { seq: number; kind: string; text: string; truncated: boolean; at: Date; attempt: string | null }[] | undefined;
  let next: number | null = null;
  if (request.participant_id !== undefined) {
    const participant = participants.find(one => one.id === request.participant_id);
    if (!participant) throw new ToolError("unknown_participant", "that participant is not on this council");
    const conversation = await conversationOfParticipant(store, participant);
    const limit = request.limit ?? 20;
    const rows = conversation === null ? [] : (await store.sql`select seq, kind, body, execution_id, at from conversation_entry
      where conversation_id = ${conversation} and seq > ${request.after_entry ?? 0} order by seq limit ${limit + 1}`) as unknown as
      { seq: number; kind: string; body: string; execution_id: string | null; at: Date }[];
    entries = rows.slice(0, limit).map(one => ({ seq: one.seq, kind: one.kind, text: one.body.slice(0, ANSWER_ENTRY_CAP), truncated: one.body.length > ANSWER_ENTRY_CAP, at: one.at, attempt: one.execution_id }));
    next = rows.length > limit ? rows[limit - 1].seq : null;
  }

  return {
    operation_id: null, object_id: council.id, revision: council.revision, status: statusOf(council.lifecycle), stage: snapshot?.stage ?? council.lifecycle,
    status_message: describeCouncil(council, snapshot?.stage ?? council.lifecycle),
    council: {
      lifecycle: council.lifecycle, origin: council.origin_kind, round: council.current_round, question: council.question, question_revision: council.question_revision,
      roster_revision: council.roster_revision, epoch: council.epoch,
      checkpoint: { deadline: new Date(council.checkpoint_deadline).toISOString(), reached: checkpointReached(council, now), extension: council.extension },
      debate_opted_in: council.debate_opt_in !== null, debate_opt_in: council.debate_opt_in, waiting: council.waiting, result: council.result,
      finalize: council.finalize ? { attempt: council.finalize.attempt, mode: council.finalize.mode, omitted: council.finalize.omitted } : null,
    },
    participants: participants.map(one => ({
      participant_id: one.id, ordinal: one.ordinal, worker_ref: one.worker_agent, preset_ref: one.preset_name, preset_id: one.preset_id, machine: one.machine,
      state: one.state, replaces: one.replaces, has_conversation: one.worker_conversation !== null,
      now: views.get(one.id) ? { view: views.get(one.id)!.view, cause: views.get(one.id)!.cause, last_activity_at: views.get(one.id)!.activity_at,
        last_activity: views.get(one.id)!.activity, wait: views.get(one.id)!.wait, superseded_outputs: views.get(one.id)!.superseded } : null,
    })),
    rounds: rounds.filter(one => request.round === undefined || one.round === request.round).map(round => ({
      round: round.round, kind: round.kind, state: round.state, question_revision: round.question_revision, epoch: round.epoch,
      inputs: shown.filter(one => one.round === round.round).map(member => {
        const text = answers.get(`${member.participant_id}:${member.round}:${member.input_revision}`);
        return { participant_id: member.participant_id, input_revision: member.input_revision, question_revision: member.question_revision, state: member.state,
          cause: member.cause, valid_for_revision: member.valid_for_revision, ...(member.supersedes !== null ? { supersedes: member.supersedes } : {}),
          ...(text !== undefined ? { answer_excerpt: text.slice(0, EXCERPT), answer_length: text.length } : {}) };
      }),
    })),
    events: events.map(one => ({ seq: one.seq, kind: one.kind, ready_at: one.ready_at, read_by_master: one.consumed_at !== null, disposition: one.disposition })),
    decisions: decisions.map(one => ({ seq: one.seq, kind: one.kind, sources: one.sources, at: one.at, attempt: one.attempt, payload: one.payload })),
    ...(entries !== undefined ? { entries, next_after_entry: next } : {}),
  };
}

/** What the council is, in one sentence for the master, from its stage. */
function describeCouncil(council: CouncilRow, stage: string): string {
  const closed = council.lifecycle === "complete" || council.lifecycle === "stopped";
  const base: Record<string, string> = {
    "workers-running": "Participants are working. Nothing is needed from you until the event says every required answer is in.",
    "waiting-machine": "Participants are queued and waiting for their machine. Nothing was started elsewhere and nothing will be.",
    "waiting-capacity": "Participants are waiting for room on their machine. Nothing was stopped to make room.",
    "waiting-master": "Every required participant has answered and the council is waiting for you: finalize it, start a debate round if the owner opted in, or ask the owner.",
    "assessing-next-round": "You are assessing this council. Call finalize or a further round, or ask the owner.",
    "preparing-result": "Your reply in the turn that called finalize is the council's result.",
    "waiting-owner": "The council is waiting for the owner. See waiting for who and why, tell the owner and record their choice.",
    stopping: "The council is stopping. It is stopped only when every process is shown to have ended.",
    stopped: "The council was stopped. What its participants answered is kept.",
    complete: "The council is complete. Its participants' conversations are kept, and the owner may ask them more with a follow-up.",
  };
  return base[stage] ?? (closed ? "The council is closed." : "The council is in progress.");
}

/**
 * End the council on the owner's word, and say only what is known.
 *
 * THE FENCE COMES FIRST (`council/fence.ts`). Every job the council owns that is not answered is gated, in ascending
 * agent order, BEFORE anything is asked about what is running: after the gates nothing can open an attempt for them, so what is
 * owned when it is read is what there is. That is every job the council owns by its own provenance (of every round, of participants
 * that were replaced or left out, and the continuations of held jobs), and not only the members whose state the roster shows as open: a
 * member that is `missing` because its process is not shown to be gone is exactly one whose process may be running. An
 * earlier choice of the owner's that was waiting for a process to be shown over is superseded (a continuation must not be queued into a
 * council that was stopped). A running attempt is then asked to end with a durable stop request of its own, frozen to that attempt, which
 * the runner that owns it acts on; the member is `stopping` and the council `stopping` until the store's own record says that attempt
 * ended, and an attempt whose end is not shown stays `stopping` (never reported stopped on silence or on a clock). A member is
 * `cancelled` only when, after the gates, nothing of its work is owned. Answers already saved are kept, a worker offline is stopping and
 * not stopped, and no job that is not the council's is touched. New rounds are refused as soon as the council is stopping.
 */
async function stop(binding: McpBinding, request: StopRequest): Promise<ToolReply> {
  requireMaster(binding, "stop a council");
  return await runRequest<StopRequest, CouncilRow>(binding, {
    tool: HUB_COUNCIL, request, object: request.council_id,
    async open(tx) {
      await reconcileInside(tx, request.council_id);
      const council = await readCouncil(tx, request.council_id, { lock: true });
      if (!council || council.agent !== binding.agent || council.person !== binding.person) throw new Undo(refusal(request.council_id, "unknown_council", "no council of this owner has that id"));
      if (council.revision !== request.expected_revision) {
        throw new Undo({ ...refusal(council.id, "stale_revision", "the council changed since you looked: inspect it again and act on what it says now"), revision: council.revision });
      }
      return { context: council, since: { at: await createdAtOf(tx, council.id), what: "the council" } };
    },
    async apply(tx, council, owner) {
      if (council.lifecycle === "complete" || council.lifecycle === "stopped") {
        return refusal(council.id, "closed", `the council is already ${council.lifecycle}: there is nothing to stop`);
      }
      const operation = operationFor(binding, request);
      // 1. THE FENCE, and what it found: every job of the council gated, then every attempt of them read, then every pending choice of the owner's superseded.
      const messages = request.source_message_ids;
      const fence = await fenceCouncilWork(tx, {
        council: council.id,
        gate: () => ({ operation, evidence: { council: council.id, stop: true, messages } }),
        stop: () => ({ operation, by: owner.sender, evidence: { council: council.id, messages } }),
        supersede: { by: owner.sender, evidence: { source: "council", council: council.id, superseded_by: "stop", operation, messages } },
      });
      const owned = new Map(fence.owned.map(one => [one.attempt.job, one] as const));
      // 2. Then each member of the council, of any round and of any participant (replaced ones included), from what is really owned.
      const evidence: { participant: string; state: string; message: string }[] = [];
      for (const member of await membersOf(tx, council.id)) {
        if (member.state !== "open" && member.state !== "superseding" && member.state !== "missing") continue;
        const chain = member.inbound_id ? await chainOf(tx, member.inbound_id) : [];
        const mine = chain.map(job => owned.get(job)).filter((one): one is NonNullable<typeof one> => one !== undefined);
        const key = { council: council.id, round: member.round, participant: member.participant_id, input_revision: member.input_revision };
        if (mine.length > 0) {
          // The newest job of the chain is the one the member is waiting on now; its attempt's stop request is the frozen one.
          const target = mine[mine.length - 1]!;
          await patchMember(tx, key, { state: "stopping", awaiting: { kind: "stop", execution: target.attempt.execution, operation } });
          evidence.push({ participant: member.participant_id, state: target.stop.state, message: describeStop(target.stop).message });
        } else if (member.state === "open" || member.state === "superseding") {
          // Cancelled only because, AFTER the gates, nothing of this member's work is owned: it could not have started, and cannot.
          await patchMember(tx, key, { state: "cancelled", awaiting: null, cause: { kind: "stopped_by_owner" } });
          evidence.push({ participant: member.participant_id, state: "cancelled", message: "It had not started. Its input was disabled and nothing was run." });
        }
      }
      await patchCouncil(tx, council.id, { lifecycle: "stopping", waiting: null, finalize: null });
      await recordDecision(tx, { council: council.id, kind: "stop", conversation: binding.conversation, request_key: request.request_key, operation,
        sources: request.source_message_ids, by: owner.sender, attempt: binding.attempt(), payload: { reason: request.reason ?? null } });
      const after = (await readCouncil(tx, council.id, { lock: true }))!;
      await adoptPendingEvents(tx, after, binding.attempt());
      await reconcileInside(tx, council.id);
      const now = (await readCouncil(tx, council.id))!;
      return replyOf(now, { operation, stage: now.lifecycle === "stopped" ? "stopped" : "stopping",
        message: now.lifecycle === "stopped"
          ? "The council is stopped. Nothing was running, and what participants had already answered is kept."
          : "The stop is recorded. The council is stopping and is called stopped only when every running process is shown to have ended; a participant whose end is not shown stays stopping. Answers already saved are kept.",
        extra: { participants: evidence } });
    },
  });
}

/** What the tool offers, by action. */
export const councilHandlers = { start, continue: councilContinue, inspect, stop } as const;
