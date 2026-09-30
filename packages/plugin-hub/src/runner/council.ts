/**
 * The runner's one seam into councils. What used to be here (a seat's answer into the door's
 * sheet row, and the merge written by the last seat) is gone: a council of `council/` reads its
 * members from the rows the store already holds.
 *
 * The runner calls these at the points its own transactions cross a council's: a member's job
 * settled, a member's job refused or failed before it ran, and the master's attempt settled. The
 * optional ones are safe to fail and none waits for a council; `afterMasterSettle` is part of the
 * settlement itself, and so are the fences (`fenceUnstartedMember`, `fenceAbandonedClaims`,
 * `sweepAbandonedClaims`) that keep a member's input from being tried again without its owner
 * (`council/hooks.ts`).
 */
export {
  afterMasterSettle, councilOfJob, fenceAbandonedClaims, fenceUnstartedMember, noteJobFailed, noteJobRefused, noteJobSettled, sweepAbandonedClaims,
} from "../council/hooks.ts";
