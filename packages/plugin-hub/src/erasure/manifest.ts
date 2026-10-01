import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { listAgents } from "../registry/entries.ts";
import type { Registry } from "../registry/load.ts";
import type { ErasureManifest, ManifestTombstone } from "../store/deletions.ts";

/**
 * THE CONTENT-FREE CONTROL MANIFEST, as a file: the erasure generation and, for every deleted topic, its identifiers and nothing
 * else (no name, no request, no word of its history). It is what keeps a deletion from being undone by a restore, a stale pull or a
 * machine that was off while it happened.
 *
 * WHERE IT LIVES. In the store (`hub_erasure_manifest`), in a copy under every machine's state directory that its hub keeps current,
 * and in every backup copy, written BEFORE the copy is assembled. A copy is only ever replaced by one that holds everything it held
 * (`mergeManifests`), so none of them can lose a tombstone.
 *
 * WHAT A RESTORE MAY DO WITH IT (`restoreBarrier`). Nothing is served from a restored store until the latest manifest has been
 * merged and applied to it offline, and a manifest that cannot be read, or whose current counterpart is not available, holds the
 * restore: it does not serve work on the hope that nothing was deleted. The old registry bindings of a deleted agent are checked
 * the same way, so a copy of the registry cannot put a deleted agent back to work.
 */

export const CONTROL_MANIFEST_FILE = "erasure-manifest.json";

export class ManifestMalformed extends Error {
  constructor(message: string) {
    super(`manifest-malformed: ${message}`);
    this.name = "ManifestMalformed";
  }
}

const isText = (value: unknown): value is string => typeof value === "string" && value !== "";

function tombstoneOf(raw: unknown): ManifestTombstone {
  const one = raw as Partial<ManifestTombstone> | null;
  if (one === null || typeof one !== "object" || !isText(one.topic_id) || !isText(one.agent_id) || !isText(one.conversation_id) || !isText(one.deletion_id)
    || (one.origin !== "created" && one.origin !== "legacy") || !Array.isArray(one.workers) || !one.workers.every(isText)
    || !Number.isSafeInteger(one.deletion_generation) || (one.deletion_generation as number) < 1) {
    throw new ManifestMalformed("a tombstone is missing what it is identified by");
  }
  return {
    topic_id: one.topic_id, person: String(one.person ?? ""), agent_id: one.agent_id, conversation_id: one.conversation_id, origin: one.origin,
    door: String(one.door ?? ""), chat: typeof one.chat === "string" ? one.chat : null, machine: String(one.machine ?? ""), runner: String(one.runner ?? ""),
    workers: [...one.workers], deletion_id: one.deletion_id, deletion_generation: one.deletion_generation as number, active_deleted: one.active_deleted === true,
  };
}

/** A manifest from its text, or a throw: a manifest that cannot be read whole is never applied in part. */
export function parseManifest(text: string): ErasureManifest {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw new ManifestMalformed("it is not JSON"); }
  const one = raw as Partial<ErasureManifest> | null;
  if (one === null || typeof one !== "object" || one.version !== 1 || !Number.isSafeInteger(one.generation) || (one.generation as number) < 0
    || !Array.isArray(one.tombstones)) {
    throw new ManifestMalformed("it needs version 1, a generation and a list of tombstones");
  }
  return { version: 1, generation: one.generation as number, tombstones: one.tombstones.map(tombstoneOf) };
}

export function renderManifest(manifest: ErasureManifest): string {
  return `${JSON.stringify({ version: 1, generation: manifest.generation, tombstones: manifest.tombstones.map(one => tombstoneOf(one)) }, null, 2)}\n`;
}

/**
 * Everything either manifest holds. A topic in both keeps the later deletion generation and is active-deleted if either says so,
 * and the generation is the larger: the result never knows less than either of the two.
 */
export function mergeManifests(a: ErasureManifest | null, b: ErasureManifest | null): ErasureManifest {
  const byTopic = new Map<string, ManifestTombstone>();
  for (const one of [...(a?.tombstones ?? []), ...(b?.tombstones ?? [])]) {
    const standing = byTopic.get(one.topic_id);
    if (standing === undefined) { byTopic.set(one.topic_id, one); continue; }
    const later = one.deletion_generation >= standing.deletion_generation ? one : standing;
    byTopic.set(one.topic_id, { ...later, active_deleted: one.active_deleted || standing.active_deleted,
      workers: [...new Set([...standing.workers, ...one.workers])].sort() });
  }
  return {
    version: 1,
    generation: Math.max(a?.generation ?? 0, b?.generation ?? 0),
    tombstones: [...byTopic.values()].sort((x, y) => x.deletion_generation - y.deletion_generation || (x.topic_id < y.topic_id ? -1 : 1)),
  };
}

/** The copy under a machine's state directory, or null when there is none. A copy that is there and unreadable throws. */
export function readLocalManifest(stateDir: string): ErasureManifest | null {
  const file = join(stateDir, CONTROL_MANIFEST_FILE);
  if (!existsSync(file)) return null;
  return parseManifest(readFileSync(file, "utf8"));
}

/**
 * Keep this machine's copy current: the store's manifest merged with what the copy already holds, written whole through a rename.
 * A copy that cannot be read is replaced by the store's alone only when the store has been read, and never made smaller.
 */
export function writeLocalManifest(stateDir: string, fromStore: ErasureManifest): ErasureManifest {
  let standing: ErasureManifest | null = null;
  try { standing = readLocalManifest(stateDir); } catch { standing = null; }
  const merged = mergeManifests(standing, fromStore);
  const file = join(stateDir, CONTROL_MANIFEST_FILE);
  const text = renderManifest(merged);
  // Nothing changed, nothing written: this runs on every tick of every hub.
  if (standing !== null && renderManifest(standing) === text) return merged;
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const candidate = `${file}.${process.pid}.tmp`;
  writeFileSync(candidate, text, { mode: 0o600 });
  try { renameSync(candidate, file); } catch (error) { rmSync(candidate, { force: true }); throw error; }
  return merged;
}

export interface RegistryViolation {
  topic_id: string;
  agent: string;
  why: "agent" | "chat";
}

/** The agents of a registry that a manifest says were deleted: by their id, or by the chat a deleted topic was bound to on the same door. */
export function registryViolations(registry: Registry, manifest: ErasureManifest): RegistryViolation[] {
  const out: RegistryViolation[] = [];
  const deleted = new Map(manifest.tombstones.map(one => [one.agent_id, one] as const));
  for (const agent of listAgents(registry)) {
    const byId = deleted.get(agent.id);
    if (byId !== undefined) { out.push({ topic_id: byId.topic_id, agent: agent.id, why: "agent" }); continue; }
    const byChat = manifest.tombstones.find(one => one.chat !== null && agent.chat === one.chat && agent.door === one.door);
    if (byChat !== undefined) out.push({ topic_id: byChat.topic_id, agent: agent.id, why: "chat" });
  }
  return out;
}

export type RestoreVerdict =
  | { serve: true; apply: ErasureManifest }
  | { serve: false; reason: "current_manifest_unverified" | "snapshot_manifest_malformed" | "registry_binds_deleted"; detail: string };

/**
 * Whether a restored store may serve, and what has to be applied to it first. `current` is the latest manifest from a source that
 * is not the snapshot (the live store, a machine's copy, a backup's): null means it could not be obtained, which HOLDS the restore.
 * `snapshot` is what the restored store carries, null for a snapshot that predates manifests. The caller applies `apply` to the
 * restored store offline (`applyErasureManifest`), and only then lets doors, runners and sync start.
 */
export function restoreBarrier(input: { current: ErasureManifest | null; snapshot: ErasureManifest | null | "malformed"; registry: Registry | null }): RestoreVerdict {
  if (input.current === null) {
    return { serve: false, reason: "current_manifest_unverified", detail: "the latest erasure manifest could not be read, so nothing is served: a deletion may have happened since this copy was made" };
  }
  if (input.snapshot === "malformed") {
    return { serve: false, reason: "snapshot_manifest_malformed", detail: "the manifest the restored copy carries cannot be read whole" };
  }
  const apply = mergeManifests(input.current, input.snapshot);
  if (input.registry !== null) {
    const violations = registryViolations(input.registry, apply);
    if (violations.length > 0) {
      return { serve: false, reason: "registry_binds_deleted",
        detail: `the registry names ${violations.map(one => one.agent).join(", ")}, which were deleted: remove them before anything is served` };
    }
  }
  return { serve: true, apply };
}
