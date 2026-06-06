// Delta-manifest: track processed sources by content hash so re-ingestion is incremental.
// One JSON file per vault. Plain, greppable, no DB.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
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
    return {};
  }
}

export function saveManifest(vault: string, m: Manifest): void {
  writeFileSync(manifestPath(vault), JSON.stringify(m, null, 2) + "\n");
}
