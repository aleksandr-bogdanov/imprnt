import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { CONTROL_MANIFEST_FILE } from "../erasure/manifest.ts";
import { restoreMachine, runRestoreBarrier } from "../erasure/restore.ts";
import { storeMachineOf } from "../hub/digest.ts";
import { RegistryEditRefused, removeEntry } from "../registry/edit.ts";
import { listMachines } from "../registry/entries.ts";
import { loadRegistry, readSetting } from "../registry/load.ts";
import { openStore } from "../store/connect.ts";
import { deletionSchemaReady, DELETION_SCHEMA_VERSION } from "../store/deletions.ts";
import { storeUrlFor } from "../store/secrets.ts";
import { safeValue } from "../door/lines.ts";

/**
 * `imprnt hub restore <registry> <machine> [--from <state dir>]... [--snapshot <copy dir>]`
 *
 * THE STEP OF A RESTORE THAT STANDS BETWEEN A RESTORED COPY AND SERVING. Run it on the restored store, OFFLINE (no door, runner,
 * sync or hub running), after the database is restored and migrated (the install step's database stage) and before any of them is
 * started. It merges the latest content-free erasure manifest into the store, so that every deleted identity is reserved again and
 * whatever the old copy held of those topics is erased, removes this machine's restored copies of them, and exits 0 only when
 * nothing of a deleted topic can be served. Exit 1 holds the restore, with the reason: start nothing.
 *
 *   --from <dir>      a state directory whose `erasure-manifest.json` is a source of the CURRENT manifest: another machine's, kept current
 *                     by its hub (a mounted or copied one), and any backup copy newer than the one restored. This machine's own state
 *                     directory is always one. Without ANY readable source the restore is held: a deletion may have happened since the
 *                     copy was made, and the copy cannot say.
 *   --snapshot <dir>  the backup copy that was restored: its own `erasure-manifest.json` is merged in. A copy that predates manifests
 *                     has none, which is allowed; one that has a torn manifest holds the restore.
 *
 * It removes a registry entry that still declares a deleted agent only on the store machine (the editor, under its lock); on any other
 * machine, or for a binding it cannot remove, it holds, and the registry is replaced from the store machine's first. It prints
 * identifiers and numbers, never a name or a word of any history.
 */
export async function restoreCommand(args: string[]): Promise<number> {
  const out = (line: string): void => { process.stdout.write(`${line}\n`); };
  const usage = (): number => {
    process.stderr.write("usage: imprnt hub restore <registry> <machine> [--from <state dir>]... [--snapshot <copy dir>]\n");
    return 2;
  };
  const [registryFile, machine, ...flags] = args;
  if (!registryFile || !machine) return usage();
  const from: string[] = [];
  let snapshot: string | null = null;
  for (let at = 0; at < flags.length; at += 2) {
    const value = flags[at + 1];
    if (value === undefined || value === "") return usage();
    if (flags[at] === "--from") from.push(value);
    else if (flags[at] === "--snapshot" && snapshot === null) snapshot = value;
    else return usage();
  }
  try {
    const first = loadRegistry(registryFile);
    if (!listMachines(first).some(one => one.id === machine)) return usage();
    const load = () => loadRegistry(registryFile, { machine });
    let registry = load();
    const stateDir = String(readSetting(registry, "hub.state_dir") ?? "");
    if (stateDir === "") { process.stderr.write("restore held: hub.state_dir is not set, so this machine's own copy of the manifest cannot be read\n"); return 1; }
    for (const dir of [...from, ...(snapshot === null ? [] : [snapshot])]) {
      if (!existsSync(dir) || !statSync(dir).isDirectory()) { process.stderr.write(`restore held: ${safeValue(dir)} is not a directory\n`); return 1; }
    }
    let snapshotManifest: string | null = null;
    if (snapshot !== null && existsSync(join(snapshot, CONTROL_MANIFEST_FILE))) snapshotManifest = readFileSync(join(snapshot, CONTROL_MANIFEST_FILE), "utf8");

    const store = await openStore({ url: storeUrlFor(registry, "hub_hub") });
    try {
      if (!(await deletionSchemaReady(store))) {
        process.stderr.write(`restore held: the restored store is not at schema ${DELETION_SCHEMA_VERSION}: run the install step's database stage first, then this\n`);
        return 1;
      }
      const sources = [stateDir, ...from];
      let run = await runRestoreBarrier({ store, stateDirs: sources, snapshotManifest, registry });
      // A registry copy that still declares a deleted agent by its own id is cleaned on the store machine, once, and asked again.
      if (!run.verdict.serve && run.verdict.reason === "registry_binds_deleted") {
        const authority = storeMachineOf(registry);
        const mine = authority === null || authority === machine;
        const removable = (run.verdict.violations ?? []).filter(one => one.why === "agent");
        if (mine && removable.length > 0) {
          for (const one of removable) {
            try { await removeEntry(registryFile, `agents[${one.agent}]`); out(`removed the registry entry of deleted agent ${safeValue(one.agent)}`); } catch (error) {
              if (!(error instanceof RegistryEditRefused)) throw error;
            }
          }
          registry = load();
          run = await runRestoreBarrier({ store, stateDirs: sources, snapshotManifest, registry });
        }
      }
      if (!run.verdict.serve) {
        process.stderr.write(`restore held (${run.verdict.reason}): ${safeValue(run.verdict.detail)}\n`);
        return 1;
      }
      const applied = run.applied!;
      const swept = restoreMachine(stateDir, { manifest: run.verdict.apply, result: applied });
      out(`restore barrier applied: ${applied.tombstones} deleted topic${applied.tombstones === 1 ? "" : "s"} in the manifest, ${applied.created.length} the restored store had not heard of, erasure generation ${applied.generation}`);
      out(`this machine: ${swept.removed} restored cop${swept.removed === 1 ? "y" : "ies"} of deleted topics removed`);
      if (swept.failed.length > 0) {
        process.stderr.write(`restore held: ${swept.failed.length} restored cop${swept.failed.length === 1 ? "y" : "ies"} could not be removed: ${swept.failed.slice(0, 5).map(safeValue).join("; ")}\n`);
        return 1;
      }
      out("nothing of a deleted topic can be served from here: start the hub, then the rest");
      return 0;
    } finally { await store.close(); }
  } catch (error) {
    process.stderr.write(`restore failed: ${safeValue((error as Error).message)}\n`);
    return 1;
  }
}
