import { existsSync, lstatSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import type { StoreLike } from "../store/connect.ts";
import type { ErasureManifest, ManifestTombstone } from "../store/deletions.ts";
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
 *   harvest_stage    `<state>/<person>/harvest/harvest-<agent>-<until>/`: notes staged for the vault, before they are filed (the filed note is
 *                    the vault's and is never touched). Chosen by the name `stageSlug` gives a harvest row of THIS agent, nothing looser
 *   move_copy        `<state>/<person>/sessions/<agent>/<conversation>` on the copy's machine: the one location the movement manifest
 *                    (016) says a destination's staged import and a source's retained session both have. The paths the copy's own
 *                    evidence recorded are checked against it, and a copy that recorded another place is blocked and never guessed at
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
export function managedPath(stateDir: string, person: string, receipt: Pick<ReceiptRow, "class" | "location"> & { detail?: Record<string, unknown> }): string | null {
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
    case "harvest_stage":
      return AGENT.test(receipt.location) ? under("harvest") : null;
    case "engine_state": {
      const [agent, conversation, ...rest] = receipt.location.split("/");
      if (agent === undefined || !AGENT.test(agent) || rest.length > 0) return null;
      if (conversation === undefined) return under("sessions", agent);
      return SEGMENT.test(conversation) ? under("sessions", agent, conversation) : null;
    }
    case "move_copy": {
      const agent = receipt.detail?.agent;
      const conversation = receipt.detail?.conversation;
      if (typeof agent !== "string" || typeof conversation !== "string" || !AGENT.test(agent) || !SEGMENT.test(conversation)) return null;
      return under("sessions", agent, conversation);
    }
    default:
      return null;
  }
}

/** The names under a person's harvest folder that are staged notes of THIS agent: `harvest-<agent>-<an ISO date>`, and nothing that merely starts alike. */
export function harvestStagesOf(names: readonly string[], agent: string): string[] {
  if (!AGENT.test(agent)) return [];
  const own = new RegExp(`^harvest-${agent.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-\\d{4}-\\d{2}-\\d{2}T`);
  return names.filter(name => own.test(name));
}

/**
 * Whether the paths a movement copy's own evidence recorded are all the one location its receipt derives. A copy that recorded another
 * (a state directory that moved since, a rule that changed) is not removed on the strength of a derived path, and says what differs.
 */
export function recordedAgrees(stateDir: string, person: string, copy: { agent: string; conversation: string }, derived: string,
  recorded: unknown): { agrees: true } | { agrees: false; differs: string } {
  if (!Array.isArray(recorded)) return { agrees: true };
  // The session directory as the runner wrote it (the state directory as configured) and as the file system names it (links resolved).
  const known = new Set([derived, resolve(stateDir, person, "sessions", copy.agent, copy.conversation)]);
  for (const path of recorded) {
    if (typeof path !== "string" || !known.has(path)) return { agrees: false, differs: typeof path === "string" ? path.slice(0, 200) : "not-a-path" };
  }
  return { agrees: true };
}

/** Whether anything is at the path, a link included: a dangling link is something. */
function present(path: string): boolean {
  try { lstatSync(path); return true; } catch { return existsSync(path); }
}

/** Whether a directory above the path is a link, or cannot be told to be anything else: nothing is removed through one. */
function linkedAbove(path: string): boolean {
  let parent = dirname(path);
  while (parent !== dirname(parent)) {
    try { if (lstatSync(parent).isSymbolicLink()) return true; }
    catch (error) { if ((error as { code?: string }).code !== "ENOENT") return true; }
    parent = dirname(parent);
  }
  return false;
}

export type Removed = { ok: true; existed: boolean } | { ok: false; code: string; errno?: string };

/** Remove one managed path and look at it again. `ok` is only "it is not there now". */
export function removeManaged(path: string): Removed {
  if (linkedAbove(path)) return { ok: false, code: "parent_path_unverified" };
  const existed = present(path);
  try { rmSync(path, { recursive: true, force: true }); } catch (error) {
    return { ok: false, code: "remove_failed", errno: String((error as { code?: unknown })?.code ?? "unknown") };
  }
  return present(path) ? { ok: false, code: "still_present" } : { ok: true, existed };
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
  const real = realpathSync(args.stateDir);
  const say = async (receipt: ReceiptRow, state: "erased" | "blocked", detail: Record<string, unknown>): Promise<void> => {
    await recordReceipt(store, deletion.id, { class: receipt.class, location: receipt.location, machine: receipt.machine, state, detail, by: args.by });
    if (state === "erased") report.erased += 1; else report.blocked += 1;
  };
  // What is asked is every copy of this machine that is not reported erased: a refusal (`blocked`) is asked again, because whatever
  // refused it (a permission, a file in use) may be gone, and the store lets a later report that really erased it supersede the refusal.
  const open = (await receiptsOf(store, deletion.id, { machine: args.machine, historical: false }))
    .filter(receipt => receipt.state === "pending" || receipt.state === "pending_machine" || receipt.state === "blocked");
  for (const receipt of open) {
    if (receipt.class !== "chatlog" && receipt.class !== "inbox_media" && receipt.class !== "engine_state" && receipt.class !== "harvest_stage" && receipt.class !== "move_copy") {
      report.left += 1;
      continue;
    }
    const path = managedPath(real, deletion.person, receipt);
    if (path === null) { await say(receipt, "blocked", { code: "location_not_managed" }); continue; }

    if (receipt.class === "harvest_stage") {
      // The folder holds the staged notes of every harvest of this person: only the ones the row ids of THIS agent name are removed.
      let names: string[];
      try { names = readdirSync(path); } catch (error) {
        if ((error as { code?: string }).code === "ENOENT") { await say(receipt, "erased", { existed: false, by: "local-removal" }); continue; }
        await say(receipt, "blocked", { code: "list_failed", errno: String((error as { code?: unknown })?.code ?? "unknown") });
        continue;
      }
      let failure: Removed | null = null;
      let removed = 0;
      for (const name of harvestStagesOf(names, receipt.location)) {
        const one = removeManaged(resolve(path, name));
        if (one.ok) removed += 1; else { failure = one; break; }
      }
      if (failure !== null && !failure.ok) await say(receipt, "blocked", { code: failure.code, ...(failure.errno === undefined ? {} : { errno: failure.errno }) });
      else await say(receipt, "erased", { existed: removed > 0, removed, by: "local-removal" });
      continue;
    }

    if (receipt.class === "move_copy") {
      // THE LOCATION IS DERIVED FROM THE MOVEMENT MANIFEST'S OWN RULE and checked against what the copy recorded. A kind and a state
      // the store says were already removed are not asked about (the receipt was only written for a live claim).
      const agrees = recordedAgrees(args.stateDir, deletion.person,
        { agent: String(receipt.detail.agent), conversation: String(receipt.detail.conversation) }, path, receipt.detail.recorded);
      if (!agrees.agrees) { await say(receipt, "blocked", { code: "movement_copy_path_differs", recorded: agrees.differs }); continue; }
    }

    const one = removeManaged(path);
    if (!one.ok) { await say(receipt, "blocked", { code: one.code, ...(one.errno === undefined ? {} : { errno: one.errno }) }); continue; }
    await say(receipt, "erased", { existed: one.existed, by: "local-removal", ...(receipt.class === "move_copy" ? { derived: "movement-manifest" } : {}) });
  }
  return report;
}

export interface SweepReport {
  removed: number;
  failed: string[];
}

/**
 * The same machine-local removal, driven by a manifest instead of receipts: what a RESTORE needs. A restored disk can hold a deleted
 * topic's chat log and sessions again (they were copied into the backup before the deletion), and a restored store has no receipts for
 * a deletion it never heard of. Every path is made from the tombstone's identifiers and the inbox digests the store gave back when it
 * erased the rows, each through the same shape checks, and each looked at again. Only tombstones that are `active_deleted`, or that the
 * restored store had to be given, are swept: a deletion still under way on its own store is that store's receipts' to finish, while an
 * attempt may still be writing.
 */
export function sweepFromManifest(stateDir: string, manifest: Pick<ErasureManifest, "tombstones">, scope: {
  only?: ReadonlySet<string>;
  inbox?: readonly { person: string; digest: string }[];
}): SweepReport {
  const report: SweepReport = { removed: 0, failed: [] };
  let real: string;
  try { real = realpathSync(stateDir); } catch { return report; }
  const take = (label: string, path: string | null): void => {
    if (path === null) { report.failed.push(`${label}: not a managed location`); return; }
    const one = removeManaged(path);
    if (!one.ok) report.failed.push(`${label}: ${one.code}`);
    else if (one.existed) report.removed += 1;
  };
  const owned = (one: ManifestTombstone): boolean => one.active_deleted || scope.only?.has(one.topic_id) === true;
  for (const one of manifest.tombstones.filter(owned)) {
    if (one.person === "") continue;
    take(`chatlog ${one.agent_id}`, managedPath(real, one.person, { class: "chatlog", location: one.agent_id }));
    take(`sessions ${one.agent_id}`, managedPath(real, one.person, { class: "engine_state", location: one.agent_id }));
    for (const worker of one.worker_locations ?? []) {
      take(`worker ${worker.conversation}`, managedPath(real, one.person, { class: "engine_state", location: `${worker.agent}/${worker.conversation}` }));
    }
    const stages = managedPath(real, one.person, { class: "harvest_stage", location: one.agent_id });
    if (stages !== null && existsSync(stages)) {
      for (const name of harvestStagesOf(readdirSync(stages), one.agent_id)) take(`harvest ${one.agent_id}`, resolve(stages, name));
    }
  }
  for (const item of scope.inbox ?? []) take(`inbox ${item.digest.slice(0, 8)}`, managedPath(real, item.person, { class: "inbox_media", location: item.digest }));
  return report;
}
