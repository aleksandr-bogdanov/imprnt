import { BACKUP_SHEET } from "../backup/run.ts";
import { finding as findingLine } from "../door/lines.ts";
import { readSheet } from "../records/statesheet.ts";
import type { RunEntry } from "../registry/load.ts";
import type { StoreLike } from "../store/connect.ts";
import { findingId, type Finding } from "./finding.ts";

/** One row per backup entry, holding its last copy's outcome. */
export interface BackupState {
  id: string;
  data: Record<string, unknown>;
}

export async function readBackupState(store: StoreLike): Promise<BackupState[]> {
  return (await readSheet(store, BACKUP_SHEET)).map((row) => ({ id: row.id, data: row.data }));
}

/**
 * A copy that did not land, read from the copy's own sheet: the shape a failed
 * sync already has, keyed on the entry id, so it clears the moment a copy lands
 * and overwrites the row.
 *
 * It reports this machine's backup entries only, so two machines never both
 * report one copy. Pure: the sheet is read by the caller. Whether a copy is
 * LATE is not asked here, because the shipped stamp findings already answer it
 * against the one grace this household has.
 */
export function backupFindings(state: BackupState[], machine: string, entries: RunEntry[]): Finding[] {
  const out: Finding[] = [];
  for (const row of state) {
    if (!entries.some((entry) => entry.id === row.id && entry.kind === "backup")) continue;
    if (row.data.status !== "failed") continue;
    out.push({
      id: findingId(machine, "backup-failed", row.id),
      kind: "backup-failed",
      subject: row.id,
      machine,
      says: findingLine("en", { code: "backup-failed", target: row.id, cause: String(row.data.cause ?? "operation failed") }),
      fix: `repair the reported cause, then run ${row.id} by hand and read its next outcome`,
    });
  }
  return out;
}
