import { isDigest, taskDigest } from "../door/dispatch.ts";
import { jobRefused, type Language } from "../door/lines.ts";
import { languageOf } from "../registry/entries.ts";
import type { Registry } from "../registry/load.ts";
import { appendEntry } from "../records/diary.ts";
import { stamp } from "../records/stamps.ts";
import type { StoreLike } from "../store/connect.ts";
import type { EligibleRow } from "../store/wake.ts";
import { appendNotice } from "../store/outbox.ts";

/** A job whose approval is missing or is not a digest at all. */
export const NOT_APPROVED = "not approved";
/** A job whose task no longer hashes to what was approved. */
export const COMMAND_ALTERED = "command altered";

export interface JobRefusal {
  cause: typeof NOT_APPROVED | typeof COMMAND_ALTERED;
}

/** A return route with every part a report needs, which the door always pins. */
function wholeRoute(route: unknown): route is { agent: string; door: string; chat: string } {
  const it = route as { agent?: unknown; door?: unknown; chat?: unknown } | null | undefined;
  return !!it && [it.agent, it.door, it.chat].every(part => typeof part === "string" && part !== "");
}

/**
 * The gate a job passes before it is fed, and the whole of it is arithmetic
 * over a string already in hand, so it costs no statement.
 *
 * A JOB WITH NO WAY BACK IS NOT APPROVED. The report is written from the
 * return route the job pinned, and a job missing any part of it would have its
 * task run by the model and then fail to settle on every attempt, running
 * again each time. The door pins a whole route with every approval it writes,
 * so such a job was made some other way, and it is refused before any child
 * starts.
 *
 * WHAT THE DIGEST PROTECTS is a window the door's own grant opens: between the
 * insert and the projection the door holds `update (body, ...)` on the row, and
 * the trigger that closes those columns only fires once the row has been shown
 * to somebody. So in that window a door bug or a widened grant could hand the
 * target a task nobody approved, and this is what refuses it by name. After the
 * projection the database refuses the write itself and this is a second lock on
 * a door that is already closed.
 *
 * A missing block and a malformed digest are the SAME refusal, because a gate
 * written as a plain comparison passes an empty string against an empty hash.
 */
export function admitJob(row: Pick<EligibleRow, "body" | "source">): JobRefusal | null {
  const approved = row.source?.dispatch?.approved;
  if (!approved || !isDigest(approved.digest)) return { cause: NOT_APPROVED };
  if (!wholeRoute(row.source?.dispatch?.return)) return { cause: NOT_APPROVED };
  if (taskDigest(row.body) !== approved.digest) return { cause: COMMAND_ALTERED };
  return null;
}

/**
 * A refused job, settled so it cannot fire again, said once on the route the
 * person who typed the command is reading.
 *
 * The row is stamped `answered` with no report, because a refusal that left the
 * row claimable is a refusal that fires for ever. It posts nothing itself: the
 * door delivers, as it does for every other notice.
 */
export async function refuseJob(
  store: StoreLike,
  refusal: { row: EligibleRow; refusal: JobRefusal; registry: Registry; runner: string },
): Promise<void> {
  const envelope = refusal.row.source?.dispatch;
  // Said only on a route that is whole: a job refused for having none has
  // nowhere to be said, and its refusal is the diary line alone.
  const route = wholeRoute(envelope?.return) ? envelope!.return : undefined;
  const language = languageOf(refusal.registry, refusal.row.person) as Language;
  const platform = ((refusal.registry.data.run ?? []) as { id: string; platform?: string }[])
    .find((entry) => entry.id === route?.door)?.platform ?? "discord";
  await store.sql.begin(async (tx) => {
    const inside = { ...store, sql: tx as unknown as StoreLike["sql"] };
    await stamp(inside, { messageId: refusal.row.id, kind: "answered", actor: "runner" });
    await appendEntry(inside, {
      stream: "control", subject: refusal.row.id, kind: "dispatch.refused", actor: "runner",
      detail: { agent: refusal.row.agent, runner: refusal.runner, cause: refusal.refusal.cause,
        dispatcher: envelope?.dispatcher ?? null },
    });
    if (route) {
      await appendNotice(inside, {
        person: refusal.row.person, agent: envelope!.dispatcher,
        body: jobRefused(language, { agent: refusal.row.agent, cause: refusal.refusal.cause }),
        // The route alone, without the agent the envelope names beside it: an
        // outbox route is a door and a chat and the door reads nothing else.
        noticeKey: `job-refused:${refusal.row.id}`,
        route: { door: route.door, chat: route.chat }, platform, language,
      });
    }
    await tx`update inbound set claimed_by = null, claim_deadline = null
             where id = ${refusal.row.id}`;
  });
}
