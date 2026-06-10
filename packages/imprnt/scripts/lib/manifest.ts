// Delta-manifest: track processed sources by content hash so re-ingestion is incremental.
// One JSON file per vault. Plain, greppable, no DB.
import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { join } from "node:path";

export type ManifestEntry = { hash: string; note: string; ingested: string; raw?: string; src?: string };
export type Manifest = Record<string, ManifestEntry>; // keyed by source path (or vault-relative raw path for snapshots)

export function manifestPath(vault: string): string {
  return join(vault, ".manifest.json");
}

export function loadManifest(vault: string): Manifest {
  const p = manifestPath(vault);
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, "utf8")) as Manifest;
  } catch {
    // A corrupt/partial manifest must NEVER be silently dropped: returning {} here and then saving
    // would overwrite the file and lose every prior provenance entry. The safer choice is to move the
    // corrupt file aside to a numbered sidecar (never clobbering an earlier backup) so the bytes are
    // preserved for manual recovery, and abort loudly so the caller does not proceed on empty state.
    let n = 0;
    let backup = `${p}.corrupt-${n}`;
    while (existsSync(backup)) backup = `${p}.corrupt-${++n}`;
    renameSync(p, backup);
    throw new Error(`manifest is corrupt and could not be parsed: ${p}\n  backed up to ${backup} — inspect it, then retry. provenance was not lost.`);
  }
}

export function saveManifest(vault: string, m: Manifest): void {
  // Atomic write: a plain writeFileSync truncates-then-writes, so a concurrent reader (the contract
  // anticipates scheduled apply-all runs) can catch a half-written file and abort the run as "corrupt".
  // Write to a temp file in the SAME directory, then renameSync it into place (atomic on POSIX, a same-
  // filesystem rename), so a reader sees either the old full file or the new full file, never a partial
  // one. The temp lives beside the target (a cross-device rename would not be atomic). loadManifest's
  // corrupt-detection stays as the backstop. (The residual lost-update under two TRULY simultaneous
  // writers is an accepted limit for a single-user commands-not-daemon tool, not solved by a lockfile.)
  const p = manifestPath(vault);
  const tmp = `${p}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(m, null, 2) + "\n");
  renameSync(tmp, p);
}
