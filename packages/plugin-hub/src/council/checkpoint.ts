import { readSetting, type Registry } from "../registry/load.ts";
import type { StoreLike } from "../store/connect.ts";
import { patchCouncil, type CouncilRow } from "./rows.ts";

/**
 * The 30-minute checkpoint, as a rule about STARTING WORK and never about stopping it.
 *
 * The deadline is wall time from the start of the current authorization epoch, persisted on the
 * council, and it is not reset by output, by an unrelated message or by the master's own
 * decision to run another round: only an owner-requested follow-up starts a new epoch. Crossing it
 * changes nothing that is running: a healthy round finishes, and the master may synthesize what
 * it has. What it closes is the door to STARTING further work (a debate round, an owner's retry or a
 * replacement, and the corrected input of a correction), until the owner has chosen. A correction itself is never refused by it:
 * the owner has said the old work is outdated, so it is accepted and the outdated work is asked to stop at once, and only the
 * corrected input waits (`reconcile.ts`, `advanceCorrection`). Their choice is an
 * `extend` with the scope they gave, recorded with their messages: another interval of minutes
 * (a new deadline), or a number of further rounds (an allowance spent one per round). There is no
 * fixed number of rounds and no per-round approval before the deadline.
 */

export function checkpointMinutes(registry: Registry): number {
  return Number(readSetting(registry, "council.checkpoint_minutes"));
}

export function checkpointReached(council: Pick<CouncilRow, "checkpoint_deadline">, now: Date): boolean {
  return now.getTime() > new Date(council.checkpoint_deadline).getTime();
}

export type Allowance = { ok: true; spends: boolean } | { ok: false };

/** Whether one further round may start now, and whether it spends an allowance the owner gave. */
export function allowFurtherRound(council: Pick<CouncilRow, "checkpoint_deadline" | "extension">, now: Date): Allowance {
  if (!checkpointReached(council, now)) return { ok: true, spends: false };
  const extension = council.extension;
  if (extension?.kind === "rounds" && (extension.rounds_left ?? 0) > 0) return { ok: true, spends: true };
  return { ok: false };
}

/** Take one round out of an allowance the owner gave. Call it in the transaction that starts the round. */
export async function spendRound(tx: StoreLike, council: Pick<CouncilRow, "id" | "extension">): Promise<void> {
  const extension = council.extension;
  if (!extension || extension.kind !== "rounds") return;
  await patchCouncil(tx, council.id, { extension: { ...extension, rounds_left: Math.max(0, (extension.rounds_left ?? 0) - 1) } }, { bump: false });
}
