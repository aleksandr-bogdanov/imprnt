import { appendEntry, readDiary } from "../records/diary.ts";
import type { StoreLike } from "../store/connect.ts";

/**
 * A restart is the bug (L11), so a restart request is a row somebody can read
 * afterwards rather than a signal nobody can.
 *
 * The row is `stream = 'restart'`, `kind = 'requested'`, actor `hub`, and
 * the subject is the entry it is aimed at. The hub reads the ones newer than its
 * own watermark and acts on each exactly once. Two shapes are refused, and a
 * refusal is a row of its own naming both ids: a request whose asker IS its
 * target (L11: the agent carrying the request can never restart itself) and one
 * aimed at the hub's own entry (D7's one hub per machine cannot restart the
 * thing doing the restarting).
 */
export const RESTART_STREAM = "restart";
export const REFUSED_RESTART = "refused.restart";

export interface RestartRequest {
  seq: number;
  at: Date;
  target: string;
  askedBy: string;
  why: string;
}

export async function requestRestart(
  store: StoreLike,
  args: { target: string; askedBy: string; why: string },
): Promise<number> {
  return await appendEntry(store, {
    stream: RESTART_STREAM,
    subject: args.target,
    kind: "requested",
    actor: "hub",
    detail: { target: args.target, asked_by: args.askedBy, why: args.why },
  });
}

/** Every request newer than the watermark, oldest first. */
export async function readRequests(
  store: StoreLike,
  args: { after: number },
): Promise<RestartRequest[]> {
  const rows = await readDiary(store, { stream: RESTART_STREAM });
  return rows
    .filter((row) => row.kind === "requested" && row.seq > args.after)
    .map((row) => ({
      seq: row.seq,
      at: row.at,
      target: String(row.detail.target ?? row.subject),
      askedBy: String(row.detail.asked_by ?? ""),
      why: String(row.detail.why ?? ""),
    }));
}

/** Loud, never silence: the refusal names both ids and says why. */
export async function refuseRestart(
  store: StoreLike,
  args: { request: RestartRequest; reason: string },
): Promise<void> {
  await appendEntry(store, {
    stream: "refusal",
    subject: args.request.target,
    kind: REFUSED_RESTART,
    actor: "hub",
    detail: {
      target: args.request.target,
      asked_by: args.request.askedBy,
      why: args.request.why,
      reason: args.reason,
    },
  });
}
