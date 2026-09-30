import type { DispatchEnvelope } from "../store/inbound.ts";

/**
 * Whose job a row is, read from the row's own provenance and nothing else. It imports a type only, so the
 * store's and the runner's own modules can ask it without a cycle.
 */

/** The council a job belongs to, from its own provenance: a member of this design, or a seat of the earlier one. */
export function councilOfJob(source: { dispatch?: DispatchEnvelope } | null | undefined): string | null {
  const dispatch = source?.dispatch;
  return dispatch?.council_round?.council ?? dispatch?.council?.id ?? null;
}

/** The participant a job is an input of: only a member of this design has one (a seat of the earlier one does not). */
export function participantOfJob(source: { dispatch?: DispatchEnvelope } | null | undefined): string | null {
  return source?.dispatch?.council_round?.participant ?? null;
}
