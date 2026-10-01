import { recordOperationFailure } from "../diagnostics.ts";
import { retentionStatement } from "../erasure/retention.ts";
import {
  deletionSchemaReady, deletionsOfDoor, eraseActive, queueDeletionNotice, readDeletion, receiptsOf, recordReceipt, verifyDeletion,
  type DeletionRow, type ReceiptRow,
} from "../store/deletions.ts";
import { attentionFor } from "../store/topic-attention.ts";
import { deletionBlockedNotice, deletionDoneNotice, deletionWaitingNotice } from "./deletion-lines.ts";
import type { PlatformRefusalDetail } from "./platform.ts";
import type { TopicsContext } from "./topic-task.ts";

/**
 * The door's half of a confirmed topic deletion: it asks the store to remove the active rows once the topic's agent and its
 * delegated conversations are shown stopped, deletes the chat and the Hub's own messages that the receipts name, gets the store's
 * verdict, and tells the owner once. It is a phase of the topic task (`runTopicPass`), not a loop of its own.
 *
 * THE RULES THIS FILE HOLDS TO.
 *
 *  * NOTHING IS ASKED OF THE PLATFORM, AND NOTHING IS ERASED, FOR A DELETION THE OWNER HAS NOT CONFIRMED. The deletions this reads
 *    are the store's confirmed ones (`deletionsOfDoor`), and the removal is a routine that refuses without a tombstone.
 *  * THE PLATFORM IS ASKED AFTER THE STORE HAS ERASED, in the order the receipts were written, and only for what a receipt of this
 *    deletion names: the chat it was bound to, and the Hub's own messages that were posted elsewhere. No listing is searched for
 *    something that looks related. A platform that cannot delete a chat or a message is not asked and is NOT credited: the receipt
 *    is `unsupported`, with the platform's name, and the deletion ends `blocked_scope` saying so.
 *  * "GONE" IS THE PLATFORM'S WORD. A deletion that answered, or that the platform names as already gone, is `erased`. A refusal is
 *    `blocked` with its status. A rate limit, a request whose answer was lost and a transport failure are NOT answers: the receipt
 *    stays open and the same request is made again later (the verbs are safe to repeat), never recorded as erased or as refused.
 *  * THE STORE JUDGES. `active_deleted` is only the store's word, from receipts it holds; this file never writes it. A machine that
 *    has not reported is waited for (`pending_machine`), and the deletion is said to be waiting, not done.
 *  * SAID ONCE, WHERE IT CAN BE HEARD. The completion notice goes where the request was made if that chat survives, and to General
 *    otherwise; it is never aimed at the chat that was deleted. It names what remains (vault notes, earlier backups) and what could
 *    not be erased, and says nothing about historical copies it cannot show gone.
 */

type DeletionContext = Pick<TopicsContext, "store" | "platform" | "door" | "registry" | "retrySeconds" | "now" | "stop">;

const clock = (ctx: DeletionContext): number => (ctx.now ?? Date.now)();
const laterMs = (ctx: DeletionContext): number => clock(ctx) + Math.max(1, ctx.retrySeconds) * 1000;
const soonest = (a: number | null, b: number | null): number | null => (a === null ? b : b === null ? a : Math.min(a, b));

async function report(ctx: DeletionContext, target: string, error: unknown): Promise<void> {
  await recordOperationFailure(ctx.store, { operation: "topic-delete", target, error, actor: "door" }).catch(() => {});
}

/** Whatever the registry says now, or null while it cannot be read. */
function registryNow(ctx: DeletionContext): unknown | null {
  try { return ctx.registry(); } catch { return null; }
}

/** Do what is due for every deletion of this door, and say when something is next due (an epoch, or null). A deletion that fails is reported and the others go on. */
export async function deletionPhase(ctx: DeletionContext): Promise<number | null> {
  // A store that has not been migrated to 017 has no deletion in it, and none of its tables: nothing is asked of it until it is.
  if (!(await deletionSchemaReady(ctx.store))) return null;
  let next: number | null = null;
  for (const deletion of await deletionsOfDoor(ctx.store, ctx.door)) {
    if (ctx.stop?.()) break;
    try {
      next = soonest(next, await advance(ctx, deletion));
    } catch (error) {
      await report(ctx, deletion.id, error);
      next = soonest(next, laterMs(ctx));
    }
  }
  return next;
}

async function advance(ctx: DeletionContext, first: DeletionRow): Promise<number | null> {
  let deletion = first;
  if (deletion.stage === "quiescing" || deletion.stage === "deleting_active" || deletion.stage === "failed") {
    const answer = await eraseActive(ctx.store, deletion.id);
    // The agent or a delegated conversation still owns an attempt nobody has shown gone: nothing is erased, and it is looked at again.
    if (answer === "stop-pending") return laterMs(ctx);
    if (answer !== "erased" && answer !== "replay") return laterMs(ctx);
    deletion = (await readDeletion(ctx.store, deletion.id)) ?? deletion;
  }
  let next: number | null = null;
  if (deletion.stage !== "active_deleted") {
    next = soonest(next, await platformCopies(ctx, deletion));
    const verdict = await verifyDeletion(ctx.store, deletion.id);
    deletion = (await readDeletion(ctx.store, deletion.id)) ?? deletion;
    if (verdict === "rows-remain" || verdict === "not-erased") return soonest(next, laterMs(ctx));
    if (verdict === "pending-machine") {
      await said(ctx, deletion, "waiting");
      return soonest(next, laterMs(ctx));
    }
    if (verdict === "blocked-scope") {
      await said(ctx, deletion, "blocked");
      return next;
    }
  }
  if (deletion.stage === "active_deleted") await said(ctx, deletion, "deleted");
  return next;
}

// ---------------------------------------------------------------------------------------------
// The platform's copies
// ---------------------------------------------------------------------------------------------

/** What the platform said, read off the error the seam throws. */
function detailOf(error: unknown): PlatformRefusalDetail {
  return (error ?? {}) as PlatformRefusalDetail;
}

/**
 * Delete the Hub's own messages that were posted elsewhere, then the chat, for the receipts that are open. Each is recorded as what
 * the platform said. Returns when a request the platform asked to wait for may be made again, or null.
 */
async function platformCopies(ctx: DeletionContext, deletion: DeletionRow): Promise<number | null> {
  const open = await receiptsOf(ctx.store, deletion.id, { classes: ["platform_message", "platform_chat"], open: true, historical: false });
  const admin = ctx.platform.admin;
  let next: number | null = null;
  // THE CHAT IS DELETED AFTER THE AGENT IS OUT OF THE REGISTRY, so this door is not left reading a channel that is gone for an agent
  // that is still declared: while the hub has not reported that entry removed, the chat waits (a refused removal does not hold it).
  const registryPending = (await receiptsOf(ctx.store, deletion.id, { classes: ["registry_binding"], open: true })).length > 0;
  // The messages first: they live in other chats, and the chat's own history goes with the chat.
  for (const receipt of [...open].sort((a, b) => (a.class === b.class ? 0 : a.class === "platform_message" ? -1 : 1))) {
    if (ctx.stop?.()) break;
    if (receipt.class === "platform_message" && receipt.detail.door !== ctx.door) continue;
    if (receipt.class === "platform_chat" && receipt.detail.door !== ctx.door) continue;
    if (receipt.class === "platform_chat" && registryPending) { next = soonest(next, laterMs(ctx)); continue; }
    const verb = receipt.class === "platform_chat" ? admin?.deleteChannel : admin?.deleteMessage;
    if (verb === undefined) {
      await record(ctx, deletion, receipt, "unsupported",
        { platform: ctx.platform.name, reason: receipt.class === "platform_chat" ? "no_channel_deletion" : "no_message_deletion" });
      continue;
    }
    // Journal first for what cannot be looked at again: the receipt is `pending` until the platform answers, and a lost answer
    // leaves it so, which is safe because the verb answers "gone" for something already deleted.
    try {
      const answer = receipt.class === "platform_chat"
        ? await admin!.deleteChannel!(receipt.location)
        : await admin!.deleteMessage!({ chat: String(receipt.detail.chat), id: String(receipt.detail.message) });
      await record(ctx, deletion, receipt, "erased", { was: answer.was, platform: ctx.platform.name });
    } catch (error) {
      const seen = detailOf(error);
      if (seen.retryAfterMs !== undefined || seen.blocked === true) {
        next = soonest(next, clock(ctx) + Math.max(1000, seen.retryAfterMs ?? 0));
      } else if (seen.sent === true || seen.status === undefined || seen.status >= 500) {
        // The outcome is not known: nothing is recorded, and the same request is made again.
        next = soonest(next, laterMs(ctx));
      } else {
        await record(ctx, deletion, receipt, "blocked", { platform: ctx.platform.name, status: seen.status, code: seen.discordCode ?? null });
      }
    }
  }
  return next;
}

async function record(ctx: DeletionContext, deletion: DeletionRow, receipt: ReceiptRow, state: "erased" | "unsupported" | "blocked", detail: Record<string, unknown>): Promise<void> {
  await recordReceipt(ctx.store, deletion.id, { class: receipt.class, location: receipt.location, machine: receipt.machine, state, detail, by: `door:${ctx.door}` });
}

// ---------------------------------------------------------------------------------------------
// What is told
// ---------------------------------------------------------------------------------------------

type Telling = "deleted" | "waiting" | "blocked";

/**
 * Say once, where it can be heard, what became of the deletion. A deletion with nowhere to say it (no General, and the request's own
 * chat gone) says nothing and invents no other place: the stage on the deletion is where it is read.
 */
async function said(ctx: DeletionContext, deletion: DeletionRow, which: Telling): Promise<void> {
  const registry = registryNow(ctx);
  if (registry === null) return;
  const sameChat = deletion.route !== null && deletion.route.door === deletion.door && deletion.route.chat === deletion.chat;
  const route = await attentionFor(ctx.store, registry, { person: deletion.person, origin: sameChat ? null : deletion.route,
    ...(sameChat ? { originUsable: false } : {}) });
  if (!route.ok) return;
  const label = typeof deletion.evidence.label === "string" ? deletion.evidence.label : deletion.agent_id;
  const receipts = await receiptsOf(ctx.store, deletion.id, { historical: false });
  const key = `topic:${which === "deleted" ? "deleted" : which === "waiting" ? "deletion-waiting" : "deletion-blocked"}:${deletion.id}`;
  const body = which === "deleted"
    ? deletionDoneNotice(route.language, { name: label, retention: retentionStatement(route.language, {
      state: deletion.retention_state, days: deletion.retention_days, until: deletion.backup_retention_until }), unsupported: receipts.filter(one => one.state === "unsupported") })
    : which === "waiting"
      ? deletionWaitingNotice(route.language, { name: label, waiting: receipts.filter(one => one.state === "pending" || one.state === "pending_machine") })
      : deletionBlockedNotice(route.language, { name: label, refused: receipts.filter(one => one.state === "unsupported" || one.state === "blocked") });
  await queueDeletionNotice(ctx.store, deletion.id, { person: deletion.person, agent: route.agent, body, key, route: route.route as { door: string; chat: string } });
}
