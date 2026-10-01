import type { Registry } from "../registry/load.ts";
import type { StoreLike } from "../store/connect.ts";
import { applyErasureManifest, type ApplyResult, type ErasureManifest } from "../store/deletions.ts";
import { sweepFromManifest, type SweepReport } from "./files.ts";
import { ManifestMalformed, mergeManifests, parseManifest, readLocalManifest, restoreBarrier, writeLocalManifest, type RestoreVerdict } from "./manifest.ts";

/**
 * THE RESTORE BARRIER, as one step a restore runs on the restored store BEFORE doors, runners or sync are enabled: gather the
 * latest control manifest from every source that is not the snapshot, merge in the one the snapshot carries, and apply the result to
 * the restored store, which reserves the deleted identities again and erases whatever of those topics the old copy held.
 *
 * It is run by `imprnt hub restore <registry> <machine>` (`entry/restore.ts`), the step of the restore procedure that cannot be
 * skipped without resurrecting something, and by nothing else. It is a function and not a daemon: it does nothing to a store it was not
 * given, enables nothing itself, and reports `serve: false` (with the reason) instead of guessing when the current manifest cannot be
 * obtained, when the snapshot's own manifest is unreadable, or when a registry copy still binds a deleted agent. Applying is idempotent,
 * so a restore that stopped half way runs it again. The hub's own startup reconciliation (`startup.ts`) is the same barrier for what a
 * restore did not go through: a store behind a machine's copy, a stale registry, a restored disk.
 *
 * WHAT IT CANNOT KNOW. A manifest only knows the deletions it was told of. A deletion confirmed after the newest manifest any source
 * holds, on a machine that was lost with its store, is invisible to it: the barrier is as current as the freshest copy of the
 * manifest, which is why every hub keeps its own and every backup carries one.
 */

export interface RestoreInput {
  /** The restored store, offline: nothing else may be using it. */
  store: StoreLike;
  /** The state directories of every machine whose copy of the manifest can be read (a machine's own, a mounted backup's). */
  stateDirs: readonly string[];
  /** The text of the control manifest the snapshot carries, or null for a snapshot that predates them. */
  snapshotManifest: string | null;
  /** The registry the restored deployment would run, or null when none is available yet. */
  registry: Registry | null;
  /** The manifest of a store that is still reachable, when there is one: the freshest source there is. */
  live?: ErasureManifest | null;
}

export interface RestoreResult {
  verdict: RestoreVerdict;
  applied: ApplyResult | null;
}

export async function runRestoreBarrier(input: RestoreInput): Promise<RestoreResult> {
  // THE CURRENT MANIFEST: everything every readable source holds, merged. A copy that is there and cannot be read is not a source.
  let current: ErasureManifest | null = input.live ?? null;
  for (const dir of input.stateDirs) {
    try {
      const copy = readLocalManifest(dir);
      if (copy !== null) current = mergeManifests(current, copy);
    } catch (error) {
      if (!(error instanceof ManifestMalformed)) throw error;
    }
  }
  let snapshot: ErasureManifest | null | "malformed" = null;
  if (input.snapshotManifest !== null) {
    try { snapshot = parseManifest(input.snapshotManifest); } catch (error) {
      if (!(error instanceof ManifestMalformed)) throw error;
      snapshot = "malformed";
    }
  }
  const verdict = restoreBarrier({ current, snapshot, registry: input.registry });
  if (!verdict.serve) return { verdict, applied: null };
  return { verdict, applied: await applyErasureManifest(input.store, verdict.apply) };
}

/**
 * What the restoring machine does to ITS OWN disk once the barrier let the store through: the restored chat logs, sessions, staged notes
 * and attachments of every topic the manifest names are removed by identifier (the store is offline and restored, so no attempt can
 * be writing), and this machine's copy of the manifest is brought up to the one that was applied.
 */
export function restoreMachine(stateDir: string, applied: { manifest: ErasureManifest; result: ApplyResult }): SweepReport {
  writeLocalManifest(stateDir, applied.manifest);
  return sweepFromManifest(stateDir, applied.manifest, {
    only: new Set(applied.manifest.tombstones.map(one => one.topic_id)), inbox: applied.result.inbox,
  });
}
