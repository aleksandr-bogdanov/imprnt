import { purgeMachine } from "../erasure/files.ts";
import { writeLocalManifest } from "../erasure/manifest.ts";
import { RegistryEditRefused, removeEntry } from "../registry/edit.ts";
import { listAgents, runEntriesFor } from "../registry/entries.ts";
import { readSetting, type Registry } from "../registry/load.ts";
import type { StoreLike } from "../store/connect.ts";
import { applyErasureManifest, confirmedDeletions, deletionSchemaReady, readErasureManifest, receiptsOf, recordReceipt, verifyDeletion, type DeletionRow } from "../store/deletions.ts";
import { storeMachineOf } from "./digest.ts";

/**
 * THE HUB'S HALF OF A CONFIRMED TOPIC DELETION, one pass per tick of every machine's hub: take the deleted agent out of the registry,
 * remove this machine's own copies and report each, keep this machine's copy of the control manifest current, and sweep what a
 * restore or a late result brought back. The door does the rest (the store's rows, the platform's chat and messages, the verdict).
 *
 *  * THE REGISTRY IS EDITED ONLY BY THE STORE MACHINE'S HUB, through the editor under its lock, as every other registry edit is, and
 *    only once the store's own rows are gone (the agent is shown stopped by then). The entry is removed and the file is read again:
 *    the receipt says `erased` only for an entry that is shown absent. A registry that cannot be read this tick is tried again.
 *  * A MACHINE REPORTS ITS OWN COPIES, AND ONLY ITS OWN (`erasure/files.ts`), under its own state directory. A machine that is off
 *    reports nothing, its receipts stay open, and the deletion is `pending_machine` until it runs again: it is waited for, never
 *    skipped, and never certified from another machine. When it comes back this pass runs before anything it queued is served, in the
 *    sense that the store has already refused the deleted identities and the registry entry is gone.
 *  * THE MANIFEST COPY ONLY GROWS (`writeLocalManifest` merges), so a store restored from an old snapshot cannot make this machine
 *    forget a tombstone, and a machine that was off applies it before the next backup carries it.
 *  * A SWEEP, NOT A SCAN. A tombstone's identities are reserved, so a late input for them is refused at the insert; a late RESULT of a
 *    delegated job is not (it is a worker's settlement), and it lands as a row of the scope. One indexed check finds such a row, and
 *    only then is the manifest applied again, which removes it. Nothing is read when nothing came back.
 */

export interface DeletionPassContext {
  store: StoreLike;
  registryFile: string;
  /** This hub's machine. */
  machine: string;
  /** The registry as it is now, loaded for this machine. May throw for a file caught half written: then nothing is done this pass. */
  load: () => Registry;
}

/** The stages whose store rows are gone: a finished deletion has no open receipt by definition, so it is not looked at again. */
const PAST_ERASE = new Set(["verifying_active", "pending_machine", "blocked_scope"]);

/** One pass. The first error is thrown after every deletion had its look. */
export async function runDeletions(ctx: DeletionPassContext): Promise<void> {
  // A store that has not been migrated to 017 has deleted nothing, and has none of the tables below: nothing to do until it is.
  if (!(await deletionSchemaReady(ctx.store))) return;
  const registry = ctx.load();
  const stateDirSetting = readSetting(registry, "hub.state_dir");
  const stateDir = typeof stateDirSetting === "string" && stateDirSetting !== "" ? stateDirSetting : null;
  const failures: unknown[] = [];
  const note = (error: unknown): void => { failures.push(error); };

  if (stateDir !== null) {
    try { writeLocalManifest(stateDir, await readErasureManifest(ctx.store)); } catch (error) { note(error); }
  }
  for (const deletion of await confirmedDeletions(ctx.store)) {
    if (!PAST_ERASE.has(deletion.stage)) continue;
    try {
      const reported = (await removeFromRegistry(ctx, registry, deletion))
        + (stateDir === null ? 0 : await removeLocalCopies(ctx, deletion, stateDir));
      if (reported > 0) await verifyDeletion(ctx.store, deletion.id);
    } catch (error) { note(error); }
  }
  try { await sweepLate(ctx); } catch (error) { note(error); }
  if (failures.length > 0) throw failures[0];
}

async function removeLocalCopies(ctx: DeletionPassContext, deletion: DeletionRow, stateDir: string): Promise<number> {
  const report = await purgeMachine(ctx.store, deletion, { stateDir, machine: ctx.machine, by: `hub:${ctx.machine}` });
  return report.erased + report.blocked;
}

/**
 * Take the deleted agent's entry out of the registry, if this hub is the one that writes it and the topic's door runs here. Returns
 * how many receipts it reported (0 or 1).
 */
async function removeFromRegistry(ctx: DeletionPassContext, registry: Registry, deletion: DeletionRow): Promise<number> {
  const authority = storeMachineOf(registry);
  if (authority !== null && authority !== ctx.machine) return 0;
  if (!runEntriesFor(registry, ctx.machine).some(one => one.kind === "door" && one.id === deletion.door)) return 0;
  const open = await receiptsOf(ctx.store, deletion.id, { classes: ["registry_binding"], open: true });
  if (open.length === 0) return 0;
  const receipt = open[0];
  const here = (loaded: Registry): boolean => listAgents(loaded).some(one => one.id === deletion.agent_id);
  const was = here(registry);
  if (was) {
    try {
      await removeEntry(ctx.registryFile, `agents[${deletion.agent_id}]`);
    } catch (error) {
      const refused = error instanceof RegistryEditRefused;
      await recordReceipt(ctx.store, deletion.id, { class: "registry_binding", location: receipt.location, machine: receipt.machine, state: "blocked",
        detail: { code: refused ? "registry_edit_refused" : "registry_edit_failed" }, by: `hub:${ctx.machine}` });
      return 1;
    }
    // The file is read again: absent is the answer, not the edit having returned.
    if (here(ctx.load())) {
      await recordReceipt(ctx.store, deletion.id, { class: "registry_binding", location: receipt.location, machine: receipt.machine, state: "blocked",
        detail: { code: "still_in_registry" }, by: `hub:${ctx.machine}` });
      return 1;
    }
  }
  await recordReceipt(ctx.store, deletion.id, { class: "registry_binding", location: receipt.location, machine: receipt.machine, state: "erased",
    detail: { was_present: was }, by: `hub:${ctx.machine}` });
  return 1;
}

/**
 * One indexed look for what came back; only a hit applies the manifest again. A deletion that is still stopping its agent is not
 * looked at: its rows are there by design until the stops are shown, and its own routine erases them then.
 */
async function sweepLate(ctx: DeletionPassContext): Promise<void> {
  const [row] = await ctx.store.sql`with settled as (
      select k.agent_id from topic_tombstone k
       where not exists (select 1 from topic_deletion d where d.id = k.deletion_id and d.stage in ('quiescing', 'deleting_active', 'failed'))
    ) select (
      exists (select 1 from inbound i join settled k on i.agent = k.agent_id)
      or exists (select 1 from conversation c join settled k on c.agent = k.agent_id)
      or exists (select 1 from execution e join settled k on e.agent = k.agent_id)
    ) as late`;
  if (row.late !== true) return;
  await applyErasureManifest(ctx.store, await readErasureManifest(ctx.store));
}
