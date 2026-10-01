import { existsSync, lstatSync, realpathSync, rmSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import type { StoreLike } from "../store/connect.ts";
import { receiptsOf, recordReceipt, type DeletionRow, type ReceiptRow } from "../store/deletions.ts";

/**
 * THE ACTIVE COPIES A MACHINE HOLDS OF A DELETED TOPIC, removed by that machine and reported by it, one receipt at a time.
 *
 * WHAT NAMES A LOCATION IS THE RECEIPT, NOT A SCAN. The store wrote one receipt for every place a copy was recorded at, BEFORE it
 * erased the rows that said where (an attachment's folder is the hash of an input's id, which is gone with the input). This module
 * removes exactly those places on exactly this machine, under this machine's own state directory, and reports each. It never walks
 * a tree looking for something that mentions the topic: the managed copies are the inventory, and a place nothing recorded is not
 * guessed at. No text scan can prove a model never copied something elsewhere, and none is pretended.
 *
 *   chatlog          `<state>/<person>/chatlog/<agent>/`
 *   engine_state     `<state>/<person>/sessions/<agent>` (the master, whole) and `<state>/<person>/sessions/<agent>/<conversation>` (a worker)
 *   inbox_media      `<state>/<person>/inbox/<sha256 of the input id>/`
 *   move_copy        a staged or retained copy of a movement; remains blocked until its exact owned path can be verified
 *
 * A PATH IS MADE ONLY FROM A SHAPE THE ID SYSTEM CAN PRODUCE (an agent id, a conversation id, a hex digest), never from free text,
 * and is checked to be inside the person's own directory before anything is removed. A receipt that fails the check is `blocked`
 * with the reason, and nothing is removed for it. Absence is the answer, not the exit status of a remove: `erased` is reported only
 * when the path is looked at afterwards and is not there.
 */

const AGENT = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const DIGEST = /^[0-9a-f]{64}$/;

/** The directory a receipt names under one person's tree, or null for a shape that is not a managed location. */
export function managedPath(stateDir: string, person: string, receipt: Pick<ReceiptRow, "class" | "location">): string | null {
  if (!SEGMENT.test(person)) return null;
  const root = resolve(stateDir, person);
  const under = (...parts: string[]): string | null => {
    const path = resolve(root, ...parts);
    return path.startsWith(`${root}${sep}`) ? path : null;
  };
  switch (receipt.class) {
    case "chatlog":
      return AGENT.test(receipt.location) ? under("chatlog", receipt.location) : null;
    case "inbox_media":
      return DIGEST.test(receipt.location) ? under("inbox", receipt.location) : null;
    case "engine_state": {
      const [agent, conversation, ...rest] = receipt.location.split("/");
      if (agent === undefined || !AGENT.test(agent) || rest.length > 0) return null;
      if (conversation === undefined) return under("sessions", agent);
      return SEGMENT.test(conversation) ? under("sessions", agent, conversation) : null;
    }
    default:
      return null;
  }
}

/** Whether anything is at the path, a link included: a dangling link is something. */
function present(path: string): boolean {
  try { lstatSync(path); return true; } catch { return existsSync(path); }
}

export interface PurgeReport {
  erased: number;
  blocked: number;
  /** Receipts of a class this machine cannot act on, left as they were. */
  left: number;
}

/**
 * Remove this machine's open copies of one confirmed deletion and report each. Only after the store's own rows are gone
 * (`stage` past `deleting_active`): while an attempt may still be writing, nothing is removed. Safe to run again: a copy already
 * reported erased is not asked about.
 */
export async function purgeMachine(store: StoreLike, deletion: Pick<DeletionRow, "id" | "stage" | "person">, args: { stateDir: string; machine: string; by: string }): Promise<PurgeReport> {
  const report: PurgeReport = { erased: 0, blocked: 0, left: 0 };
  if (deletion.stage === "awaiting_confirmation" || deletion.stage === "quiescing" || deletion.stage === "deleting_active" || deletion.stage === "superseded") return report;
  // What is asked is every copy of this machine that is not reported erased: a refusal (`blocked`) is asked again, because whatever
  // refused it (a permission, a file in use) may be gone, and the store lets a later report that really erased it supersede the refusal.
  const open = (await receiptsOf(store, deletion.id, { machine: args.machine, historical: false }))
    .filter(receipt => receipt.state === "pending" || receipt.state === "pending_machine" || receipt.state === "blocked");
  for (const receipt of open) {
    if (receipt.class === "move_copy") continue;
    if (receipt.class !== "chatlog" && receipt.class !== "inbox_media" && receipt.class !== "engine_state") { report.left += 1; continue; }
    const path = managedPath(realpathSync(args.stateDir), deletion.person, receipt);
    if (path === null) {
      await recordReceipt(store, deletion.id, { class: receipt.class, location: receipt.location, machine: receipt.machine, state: "blocked",
        detail: { code: "location_not_managed" }, by: args.by });
      report.blocked += 1;
      continue;
    }
    // Never recurse through a linked parent into an unrelated directory.
    let parent = dirname(path);
    let linkedParent = false;
    while (parent !== dirname(parent)) {
      try { if (lstatSync(parent).isSymbolicLink()) { linkedParent = true; break; } }
      catch (error) { if ((error as { code?: string }).code !== "ENOENT") { linkedParent = true; break; } }
      parent = dirname(parent);
    }
    if (linkedParent) {
      await recordReceipt(store, deletion.id, { class: receipt.class, location: receipt.location, machine: receipt.machine,
        state: "blocked", detail: { code: "parent_path_unverified" }, by: args.by });
      report.blocked += 1;
      continue;
    }
    const existed = present(path);
    try { rmSync(path, { recursive: true, force: true }); } catch (error) {
      await recordReceipt(store, deletion.id, { class: receipt.class, location: receipt.location, machine: receipt.machine, state: "blocked",
        detail: { code: "remove_failed", errno: String((error as { code?: unknown })?.code ?? "unknown") }, by: args.by });
      report.blocked += 1;
      continue;
    }
    if (present(path)) {
      await recordReceipt(store, deletion.id, { class: receipt.class, location: receipt.location, machine: receipt.machine, state: "blocked",
        detail: { code: "still_present" }, by: args.by });
      report.blocked += 1;
      continue;
    }
    await recordReceipt(store, deletion.id, { class: receipt.class, location: receipt.location, machine: receipt.machine, state: "erased",
      detail: { existed, by: "local-removal" }, by: args.by });
    report.erased += 1;
  }
  // Movement staging paths are not proven to share the session directory. Keep this
  // debt explicit until exact movement-owned paths are inventoried and removed.
  for (const receipt of open.filter(receipt => receipt.class === "move_copy")) {
    await recordReceipt(store, deletion.id, { class: "move_copy", location: receipt.location, machine: receipt.machine,
      state: "blocked", detail: { code: "movement_copy_path_unverified" }, by: args.by });
    report.blocked += 1;
  }
  return report;
}
