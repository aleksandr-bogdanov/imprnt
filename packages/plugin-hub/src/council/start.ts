import { createHash } from "node:crypto";
import { appendEntry } from "../records/diary.ts";
import { languageOf } from "../registry/entries.ts";
import { readSetting, type Registry } from "../registry/load.ts";
import type { StoreLike } from "../store/connect.ts";
import { wantEffect } from "../store/effects.ts";
import { emitEvent, memberMissingBody } from "./events.ts";
import { enqueueMemberJob, firstTask } from "./jobs.ts";
import { statusLine } from "./lines.ts";
import type { Resolved } from "./roster.ts";
import { participantOf, patchCouncil, readCouncil, recordDecision, type CouncilRow, type MemberCause, type Route } from "./rows.ts";
import { readSnapshot } from "./snapshot.ts";

/**
 * One council coming into being, in ONE transaction: the council, its roster with the exact
 * preset and machine each was resolved to, the opening round, every member's job on the queue,
 * the card that will show it, and the diary line. Either all of it or none, so there is never a
 * council whose first round half started.
 *
 * It is the same code for the two ways a council begins: an owner asking for one in their own
 * words (the tool, in the runner, with the owner's messages as evidence, no second approval) and
 * an agent's proposal the owner approved with a green check (the door's approval hook, from the frozen
 * preview). What was approved is what starts: the roster in the proposal's payload is used as it was
 * frozen, and a worker whose configuration has changed since is not started under its old name but
 * recorded as missing, named, and waits for the owner.
 *
 * IDEMPOTENT ON THE OPERATION: the id is made from it, so a repeated tool call, a restarted
 * runner or an approval acted on twice finds the council it made and writes nothing.
 */

export interface StartSpec {
  operation: string;
  person: string;
  master: { agent: string; conversation: string | null };
  route: Route;
  origin_kind: "owner_request" | "proposal";
  /** Who asked and on what evidence. Kept as given and never changed. */
  origin: Record<string, unknown>;
  parent_job: string | null;
  question: string;
  context: { text: string }[];
  participants: Resolved[];
  /** Participants (by index) whose configuration changed between the proposal and its approval, and why. */
  drifted?: ReadonlyMap<number, string>;
  debate: CouncilRow["debate_opt_in"];
  /** The owner whose request or approval this rests on: the one every job is approved by. */
  approvedBy: string;
  registry: Registry;
  /** Who writes the diary line: the process that runs this. */
  actor: "runner" | "door";
  /** The tool call or approval this is the answer to. */
  decision: { conversation: string; request_key: string; sources: readonly string[]; attempt: string | null };
  at: string;
}

/** The council's id, from the operation that started it. Deterministic, so a replay makes no second one. */
export function councilIdOf(operation: string): string {
  return `council:${createHash("sha256").update(operation).digest("hex").slice(0, 24)}`;
}

export function platformOf(registry: Registry, door: string): string {
  return ((registry.data.run ?? []) as { id: string; platform?: string }[]).find(one => one.id === door)?.platform ?? "discord";
}

export const quietSecondsOf = (registry: Registry): number => Number(readSetting(registry, "council.quiet_minutes")) * 60;

/** Put the card's current words on the ledger. The door is the one process that sends it. */
export async function putStatus(store: StoreLike, council: Pick<CouncilRow, "id" | "status_effect_key" | "return_route" | "person">, registry: Registry, now: Date): Promise<boolean> {
  const snapshot = await readSnapshot(store, council.id, { now, quietSeconds: quietSecondsOf(registry) });
  if (!snapshot) return false;
  await wantEffect(store, {
    key: council.status_effect_key, door: council.return_route.door, chat: council.return_route.chat, owner: council.id,
    text: statusLine(languageOf(registry, council.person), snapshot, now), platform: platformOf(registry, council.return_route.door),
  });
  return true;
}

export async function startCouncil(tx: StoreLike, spec: StartSpec): Promise<{ id: string; created: boolean; jobs: string[] }> {
  const id = councilIdOf(spec.operation);
  const minutes = Number(readSetting(spec.registry, "council.checkpoint_minutes"));
  const made = await tx.sql`insert into council (id, person, agent, master_conversation, origin_kind, origin, return_route, operation_id, parent_job,
      question, context, debate_opt_in, lifecycle, epoch_authority, checkpoint_deadline, status_effect_key)
    values (${id}, ${spec.person}, ${spec.master.agent}, ${spec.master.conversation}, ${spec.origin_kind},
      ${JSON.stringify({ ...spec.origin, request_at: spec.at })}::text::jsonb, ${JSON.stringify(spec.route)}::text::jsonb, ${spec.operation}, ${spec.parent_job},
      ${spec.question}, ${JSON.stringify(spec.context)}::text::jsonb, ${spec.debate === null ? null : JSON.stringify(spec.debate)}::text::jsonb,
      'running', ${JSON.stringify({ source_message_ids: spec.decision.sources, at: spec.at })}::text::jsonb,
      now() + make_interval(mins => ${minutes}::integer), ${"council-status:" + id})
    on conflict (operation_id) do nothing returning id`;
  if (made.length === 0) return { id, created: false, jobs: [] };

  await tx.sql`insert into council_round (council_id, round, kind, question_revision, epoch, evidence)
    values (${id}, 1, 'independent', 1, 1, ${JSON.stringify({ source_message_ids: spec.decision.sources })}::text::jsonb)`;
  const council = (await readCouncil(tx, id))!;
  const jobs: string[] = [];
  const drifted: string[] = [];
  for (const [index, one] of spec.participants.entries()) {
    const participantId = `${id}:p${index + 1}`;
    // The profile the owner's approval was an approval of is kept with the participant (`profile.ts`) and never changes; the runner compares it again at every launch.
    await tx.sql`insert into council_participant (id, council_id, ordinal, worker_agent, preset_name, preset_id, preset_snapshot, machine, runner, brief, profile, profile_id)
      values (${participantId}, ${id}, ${index + 1}, ${one.worker_ref}, ${one.preset_ref}, ${one.preset_id}, ${JSON.stringify(one.preset_snapshot)}::text::jsonb,
              ${one.machine}, ${one.runner}, ${one.brief}, ${JSON.stringify(one.profile ?? {})}::text::jsonb, ${one.profile_id ?? null})`;
    const why = spec.drifted?.get(index);
    if (why !== undefined) {
      await tx.sql`insert into round_member (council_id, round, participant_id, input_revision, question_revision, state, cause)
        values (${id}, 1, ${participantId}, 1, 1, 'missing', ${JSON.stringify({ kind: "configuration_changed", detail: why })}::text::jsonb)`;
      drifted.push(participantId);
      continue;
    }
    const participant = (await participantOf(tx, participantId))!;
    jobs.push(await enqueueMemberJob(tx, { council, participant, round: 1, inputRevision: 1, questionRevision: 1,
      task: firstTask(council, one.brief), approvedBy: spec.approvedBy, at: spec.at }));
  }
  await recordDecision(tx, { council: id, kind: "start", conversation: spec.decision.conversation, request_key: spec.decision.request_key, operation: spec.operation,
    sources: spec.decision.sources, by: spec.approvedBy, attempt: spec.decision.attempt,
    payload: { origin_kind: spec.origin_kind, participants: spec.participants.map(one => ({ worker: one.worker_ref, preset: one.preset_id, machine: one.machine })), debate: spec.debate !== null } });
  if (drifted.length > 0) {
    // What was approved cannot be started as approved for these: they wait, named, for the owner.
    await patchCouncil(tx, id, { lifecycle: "waiting_owner", waiting: { kind: "members_missing", members: drifted } }, { bump: false });
    const view = (await readCouncil(tx, id))!;
    const gone = (await tx.sql`select participant_id, cause from round_member where council_id = ${id} and state = 'missing' order by participant_id`) as unknown as
      { participant_id: string; cause: MemberCause }[];
    for (const one of gone) {
      const participant = (await participantOf(tx, one.participant_id))!;
      await emitEvent(tx, view, { kind: "member_missing", dedupe: `missing:${participant.id}:r1:i1:configuration_changed`,
        body: memberMissingBody(view, { participant, member: { council_id: id, round: 1, participant_id: participant.id, input_revision: 1, question_revision: 1,
          inbound_id: null, state: "missing", cause: one.cause, awaiting: null, report_id: null, valid_for_revision: null, supersedes: null, answered_at: null, created_at: new Date() } }),
        provenance: { participant: participant.id, round: 1 } });
    }
  }
  await putStatus(tx, (await readCouncil(tx, id))!, spec.registry, new Date());
  await appendEntry(tx, { stream: "council", subject: id, kind: "started", actor: spec.actor,
    detail: { agent: spec.master.agent, origin_kind: spec.origin_kind, participants: spec.participants.map(one => one.worker_ref), jobs, drifted,
      sources: spec.decision.sources, debate: spec.debate !== null } });
  return { id, created: true, jobs };
}
