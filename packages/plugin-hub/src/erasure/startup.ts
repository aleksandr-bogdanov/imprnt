import { storeMachineOf } from "../hub/digest.ts";
import { RegistryEditRefused, removeEntry } from "../registry/edit.ts";
import { readSetting, type Registry } from "../registry/load.ts";
import type { StoreLike } from "../store/connect.ts";
import { applyErasureManifest, deletionSchemaReady, readErasureManifest, type ApplyResult } from "../store/deletions.ts";
import { sweepFromManifest } from "./files.ts";
import { ManifestMalformed, mergeManifests, readLocalManifest, registryViolations, writeLocalManifest } from "./manifest.ts";

/**
 * STARTUP RECONCILIATION: before this machine starts or restarts a door, a runner or a sync, it is shown that the store it reaches
 * knows every deletion this machine's own copy of the control manifest knows, and that nothing a deletion removed has come back to
 * this machine. It is what stops a store restored from an old snapshot, a stale registry copy, a returning machine and a restored disk
 * from putting a deleted identity back to work.
 *
 *  1. THE STORE IS BROUGHT FORWARD. The machine's copy and the store's manifest are merged. A tombstone the store has never heard of
 *     (it was restored from a copy that predates the deletion) is applied: its identities are reserved again and what the old copy
 *     held is erased, before anything is served. A deletion the store is still carrying out is not touched (the store's own routine
 *     erases it, after the stops are shown).
 *  2. THE REGISTRY IS CHECKED. An agent the merged manifest says was deleted (and that the store has finished, or was just given)
 *     that the registry still declares is removed by the store machine's hub, through the editor under its lock, and the file is read
 *     again. Any other machine, and any binding it cannot remove, holds: its copy is replaced from the store machine's, and until
 *     then nothing is started.
 *  3. THE DISK IS SWEPT, once after a start: the chat log, the session files, the staged notes and the attachments of a topic whose
 *     deletion is finished (or was just applied) are removed again by their identifiers, through the same shape checks as every other
 *     removal. A restored disk can bring them back, and a restored store has no receipts for what it never heard of.
 *  4. THE MACHINE'S COPY OF THE MANIFEST ONLY GROWS.
 *
 * WHAT HOLDS, AND WHAT DOES NOT. `serve: false` means the hub does not install or start anything this tick, and says why. A store that
 * has not been migrated to 017 holds only when this machine's own manifest names a deletion (it cannot be applied there); otherwise it
 * has nothing to reconcile. A file that cannot be removed does not hold (a deleted agent cannot run: its identity is reserved) and is
 * reported by name. Nothing here can know a deletion that no manifest anywhere holds: the barrier is as current as the freshest copy.
 */

export interface ReconcileContext {
  store: StoreLike;
  registryFile: string;
  machine: string;
  load: () => Registry;
  /** Sweep this machine's files (the first pass after a start, and a restore). */
  sweepFiles?: boolean;
}

export type ReconcileVerdict =
  | { serve: true; applied: number; created: string[]; swept: number; failed: string[]; copyUnreadable: boolean }
  | { serve: false; reason: "manifest_unreadable" | "schema_behind" | "manifest_not_applied" | "registry_binds_deleted"; detail: string };

/**
 * THE START FENCE of a door or a runner (the hub reconciles; a process the operating system restarts on its own does not wait for the
 * hub): why this process must not start, or null. It starts only against a store that holds every deletion this machine's own copy of
 * the control manifest records. A store that does not (restored from an older copy) is brought forward by the hub's next pass, and the
 * process is started again by the manager after it; nothing of a deleted identity is served in between. A machine with no copy, or a
 * copy that names nothing, has nothing to be held against.
 */
export async function erasureFence(store: StoreLike, stateDir: string | null): Promise<string | null> {
  if (stateDir === null || stateDir === "") return null;
  let local: ReturnType<typeof readLocalManifest>;
  try { local = readLocalManifest(stateDir); } catch (error) {
    if (!(error instanceof ManifestMalformed)) throw error;
    return "this machine's copy of the erasure manifest cannot be read whole, so it cannot be shown that the store knows what was deleted";
  }
  if (local === null || local.tombstones.length === 0) return null;
  if (!(await deletionSchemaReady(store))) return `the store has not been migrated to hold the ${local.tombstones.length} deletion(s) this machine recorded`;
  const have = await readErasureManifest(store);
  const lacking = local.tombstones.filter(one => !have.tombstones.some(each => each.topic_id === one.topic_id));
  if (lacking.length > 0) return `the store does not hold ${lacking.length} deletion(s) this machine recorded: the hub on this machine applies them first`;
  if (local.generation > have.generation) return "the store's erasure generation is behind this machine's: the hub on this machine brings it forward first";
  return null;
}

const stateDirOf = (registry: Registry): string | null => {
  const setting = readSetting(registry, "hub.state_dir");
  return typeof setting === "string" && setting !== "" ? setting : null;
};

export async function reconcileErasure(ctx: ReconcileContext): Promise<ReconcileVerdict> {
  let registry = ctx.load();
  const stateDir = stateDirOf(registry);

  let local = null as ReturnType<typeof readLocalManifest>;
  let copyUnreadable = false;
  if (stateDir !== null) {
    try { local = readLocalManifest(stateDir); } catch (error) {
      if (!(error instanceof ManifestMalformed)) throw error;
      return { serve: false, reason: "manifest_unreadable", detail: "the local erasure manifest is unreadable; preserve it and obtain an independently verified replacement" };
    }
  }

  if (!(await deletionSchemaReady(ctx.store))) {
    if (local !== null && local.tombstones.length > 0) {
      return { serve: false, reason: "schema_behind",
        detail: `this machine recorded ${local.tombstones.length} deleted topic${local.tombstones.length === 1 ? "" : "s"}, and the store has not been migrated to hold them: migrate it, so that they are applied before anything is served` };
    }
    return { serve: true, applied: 0, created: [], swept: 0, failed: [], copyUnreadable };
  }

  const fromStore = await readErasureManifest(ctx.store);
  const merged = mergeManifests(local, fromStore);
  const known = new Set(fromStore.tombstones.map(one => one.topic_id));
  const unknown = merged.tombstones.filter(one => !known.has(one.topic_id));

  let applied = 0;
  let result: ApplyResult | null = null;
  if (unknown.length > 0 || merged.generation > fromStore.generation) {
    result = await applyErasureManifest(ctx.store, merged);
    applied = result.applied;
  }
  const after = result === null ? fromStore : await readErasureManifest(ctx.store);
  const lacking = merged.tombstones.filter(one => !after.tombstones.some(have => have.topic_id === one.topic_id));
  if (lacking.length > 0) {
    return { serve: false, reason: "manifest_not_applied",
      detail: `the store still does not hold ${lacking.length} deletion${lacking.length === 1 ? "" : "s"} this machine recorded, so nothing is served` };
  }
  const created = result?.created ?? [];
  const everything = mergeManifests(merged, after);
  if (stateDir !== null) writeLocalManifest(stateDir, everything);

  // THE REGISTRY. Only a topic the store has finished with, or was just given, binds nothing any more; one still being deleted is
  // taken out of the registry by `runDeletions`, once its own rows are gone.
  const settled = { ...everything, tombstones: everything.tombstones.filter(one => one.active_deleted || created.includes(one.topic_id)) };
  let violations = registryViolations(registry, settled);
  if (violations.length > 0) {
    const authority = storeMachineOf(registry);
    const mine = authority === null || authority === ctx.machine;
    if (mine) {
      for (const one of violations.filter(each => each.why === "agent")) {
        try { await removeEntry(ctx.registryFile, `agents[${one.agent}]`); } catch (error) {
          if (!(error instanceof RegistryEditRefused)) throw error;
        }
      }
      registry = ctx.load();
      violations = registryViolations(registry, settled);
    }
    if (violations.length > 0) {
      return { serve: false, reason: "registry_binds_deleted",
        detail: `the registry names ${violations.map(one => one.agent).join(", ")}, which ${violations.length === 1 ? "was" : "were"} deleted${mine ? ", and could not be removed" : ": the store machine's hub removes it, and this copy is replaced from it"}` };
    }
  }

  let swept = 0;
  let failed: string[] = [];
  if (ctx.sweepFiles === true && stateDir !== null) {
    // The attachments of a finished deletion are named by the receipts this machine reported, and those of a topic the store was just
    // given by the digests it handed back.
    const rows = (await ctx.store.sql`select d.person, r.location as digest from erasure_receipt r join topic_deletion d on d.id = r.deletion_id
        where d.stage = 'active_deleted' and r.class = 'inbox_media' and r.machine = ${ctx.machine}`) as unknown as { person: string; digest: string }[];
    const report = sweepFromManifest(stateDir, everything, { only: new Set(created), inbox: [...rows, ...(result?.inbox ?? [])] });
    swept = report.removed;
    failed = report.failed;
  }
  return { serve: true, applied, created, swept, failed, copyUnreadable };
}
