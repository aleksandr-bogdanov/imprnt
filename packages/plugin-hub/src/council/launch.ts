import type { Registry } from "../registry/load.ts";
import type { StoreLike } from "../store/connect.ts";
import type { InboundSource, JobSource } from "../store/inbound.ts";
import { changedOf, profileIdOf, profileOf } from "./profile.ts";

/**
 * What the runner asks about a council's job at the moment it is about to launch it, before a conversation is chosen, a child is started or a
 * byte reaches an engine: is this worker still what the owner approved?
 *
 * THE APPROVAL WAS OF A PROFILE, AND IT IS CHECKED EVERY TIME (`profile.ts`). A council's job can be launched long after the roster was accepted: a first
 * job that waited for its machine, a debate round, a follow-up, a correction, an owner's retry, a continuation the store queued after a process was
 * shown to be over. All of them carry the mark of their participant (`dispatch.council_round.participant`), and the participant's row (the store's own
 * record, written when the roster was accepted and never changed) holds the profile and its digest. The digest is computed again from the registry this
 * launch is going to use (`registry`, the same object the session is started from, so what is compared is what the engine will really run under) and
 * a job whose worker no longer matches is refused by name: `configuration changed`, with the parts that changed (their names, never a value).
 *
 * WHAT A REFUSAL DOES AND DOES NOT DO. It is the runner's ordinary refusal of a job (`refuseJob`): the row is stamped answered with no report and a
 * diary line, nothing is fed, nothing is retried, replaced or rebuilt, and the council reads it as a member that cannot be waited for and asks its
 * owner. The worker's tools, instructions, MCP and box are untouched, no other model is put in its place and its conversation and its siblings' are exactly as
 * they were.
 *
 * A seat of the earlier design, and a participant with no recorded profile, have nothing approved to compare and are passed as before. The conversation
 * a job names is also checked to be one of this participant's own: a further round is put into the participant's own conversation and into no other.
 */

export interface LaunchRefusal { cause: "configuration changed" | "conversation unavailable" | "not approved"; changed: string[] }

export interface LaunchCheck {
  /** The digest of the profile the job was approved under, or null when the job is not a member of a council of this design or has none recorded. */
  profile: string | null;
  refusal: LaunchRefusal | null;
}

export async function checkLaunch(store: StoreLike, launch: { row: { id: string; agent: string; source?: InboundSource | JobSource | null }; registry: Registry }): Promise<LaunchCheck> {
  const dispatch = (launch.row.source as JobSource | null | undefined)?.dispatch;
  const round = dispatch?.council_round;
  if (!round) return { profile: null, refusal: null };
  const [participant] = (await store.sql`select worker_agent, profile, profile_id, worker_conversation from council_participant
    where id = ${round.participant} and council_id = ${round.council}`) as unknown as
    { worker_agent: string; profile: Record<string, unknown>; profile_id: string | null; worker_conversation: string | null }[];
  if (!participant) return { profile: null, refusal: { cause: "not approved", changed: [] } };
  if (participant.worker_agent !== launch.row.agent) return { profile: null, refusal: { cause: "configuration changed", changed: ["worker"] } };
  if (dispatch?.conversation !== undefined) {
    // The conversations that are this participant's own: the one recorded on it, and any that one of its jobs made.
    const made = (await store.sql`select c.id from conversation c where c.kind = 'worker' and c.owner_ref in (
        select m.inbound_id from round_member m where m.participant_id = ${round.participant} and m.inbound_id is not null)`) as unknown as { id: string }[];
    const own = [...(participant.worker_conversation === null ? [] : [participant.worker_conversation]), ...made.map(one => one.id)];
    if (own.length > 0 && !own.includes(dispatch.conversation)) return { profile: null, refusal: { cause: "conversation unavailable", changed: [] } };
  }
  if (participant.profile_id === null) return { profile: null, refusal: null };
  const now = profileOf(launch.registry, launch.row.agent);
  if (now !== null && profileIdOf(now) === participant.profile_id) return { profile: participant.profile_id, refusal: null };
  return { profile: null, refusal: { cause: "configuration changed", changed: changedOf(participant.profile, now) } };
}

/** The digest of the profile a worker would launch under with this registry, or null when it is not configured. The same digest `checkLaunch` compares. */
export function launchProfileOf(registry: Registry, agent: string): string | null {
  const profile = profileOf(registry, agent);
  return profile === null ? null : profileIdOf(profile);
}
