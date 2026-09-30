import { activeMasters, unreservedMasters } from "../council/capacity.ts";
import type { runnerAdmission } from "../registry/entries.ts";
import type { AgentEntry, Registry } from "../registry/load.ts";
import type { StoreLike } from "../store/connect.ts";

/**
 * The runner's decision to let one more child start, made ONCE and against the world as it is at that moment.
 *
 * Admission has one asynchronous boundary in it: which masters have an active council, whose room is kept free, is a question to the store. Everything else
 * it needs (how many children this runner has reserved, how much memory they were last measured to hold, the limits its entry gives it now, which masters
 * already hold a slot) is in this process's memory and moves while that question is in flight, because other agents of the same runner are being admitted and released
 * concurrently. So the order is the whole of the correctness:
 *
 *   1. `activeMasters` is awaited FIRST. It is the only await.
 *   2. Only then are the counts, the measured memory, the limits and the resident masters read, and the decision is taken, and the reservation is made, in one
 *      synchronous step with no await between the read and the increment. Two callers suspended at the same query resume one after the other, and the second reads
 *      the first's reservation.
 *
 * The earlier order (used memory computed, then the store asked, then the decision made with the old number) let two workers that woke together both find the
 * memory free beside a master's reserve and both take it: the master, whose room admission exists to keep, then could not start.
 *
 * NOTHING HERE IS A NEW POLICY. It is the arithmetic `admitChild` always had: room by count (`reservations + held < max_active_children`) and room by memory
 * (`used + (1 + held) * reserve <= budget`), where `held` is the masters of active councils on this runner that do not already hold a slot. It stops nothing,
 * moves nothing and reserves nothing privately.
 */

export interface AdmissionNow {
  reservations: number;
  /** Bytes the children were last measured to hold, or 0 when nothing has been measured. */
  measuredBytes: number;
  limits: ReturnType<typeof runnerAdmission>;
  /** Whether this master already holds a slot on this runner. */
  resident(agent: string): boolean;
}

export type Admission =
  | { admitted: true }
  | { admitted: false; held: string[]; roomByCount: boolean; usedMb: number; limits: ReturnType<typeof runnerAdmission> };

export async function admitOnce(
  input: {
    store: StoreLike;
    runner: string;
    registry: Registry;
    admitting: Pick<AgentEntry, "id" | "door">;
    /** Read synchronously, after the await, at the moment of the decision. */
    now(): AdmissionNow;
    /** Takes the reservation. Called in the same synchronous step that decided. */
    take(): void;
  },
  reserve: boolean,
): Promise<Admission> {
  const masters = await activeMasters(input.store, { runner: input.runner, registry: input.registry, admitting: input.admitting });
  // ---- no await from here to the return -------------------------------------------------------------------------------------------
  const at = input.now();
  const held = unreservedMasters(masters, at.resident);
  const reserveMb = at.limits.reserve_mb;
  const usedMb = Math.max(at.reservations * reserveMb, at.measuredBytes / 1048576);
  const roomByCount = at.reservations + held.length < at.limits.max_active_children;
  if (roomByCount && usedMb + (1 + held.length) * reserveMb <= at.limits.child_memory_budget_mb) {
    if (reserve) input.take();
    return { admitted: true };
  }
  return { admitted: false, held, roomByCount, usedMb, limits: at.limits };
}
