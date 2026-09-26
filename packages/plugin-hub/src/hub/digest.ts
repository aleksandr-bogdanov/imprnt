import { putRow, readSheet } from "../records/statesheet.ts";
import { listMachines } from "../registry/entries.ts";
import { registryDigest } from "../registry/load.ts";
import type { StoreLike } from "../store/connect.ts";

/**
 * Whether every machine runs the same registry.
 *
 * The file is one, and a spoke reads a COPY of it. A copy that fell behind is
 * the one way two machines disagree about who serves whom: an agent moved onto
 * the spoke on the hub machine is claimed by nobody, and one moved off it is
 * claimed by both runners, so one chat gets two sessions and two harvests. So
 * every hub writes the digest of the file it runs on to one sheet, one row per
 * machine, on every tick, and a spoke's runner compares its own copy with the
 * store machine's row before it claims anything.
 */
export const REGISTRY_SHEET = "registry";

/**
 * The machine the store is on, whose copy of the registry is the one every
 * other copy is measured against: the one declared machine that reaches the
 * store with no `store_url` of its own. Null when the file declares fewer than
 * two machines, where there is one copy and nothing to compare, and when more
 * than one machine reaches the store on the file's own address, which no
 * household with a spoke has.
 */
export function storeMachineOf(registry: unknown): string | null {
  const machines = listMachines(registry);
  if (machines.length < 2) return null;
  const local = machines.filter((one) => one.store_url === undefined);
  return local.length === 1 ? local[0].id : null;
}

/** What this machine's hub says the registry is, written on its tick. */
export async function recordRegistryDigest(store: StoreLike, machine: string, file: string): Promise<void> {
  await putRow(store, REGISTRY_SHEET, machine, { sha256: registryDigest(file), at: new Date().toISOString() });
}

export interface RegistryDigestRow {
  machine: string;
  sha256: string;
  at: string;
}

export async function readRegistryDigests(store: StoreLike): Promise<RegistryDigestRow[]> {
  return (await readSheet(store, REGISTRY_SHEET)).map((row) => ({
    machine: row.id,
    sha256: String(row.data.sha256 ?? ""),
    at: String(row.data.at ?? ""),
  }));
}

/**
 * Whether the copy at `file`, on `machine`, is behind the store machine's.
 * False whenever there is nothing to compare: one machine, the store machine
 * itself, or a store machine whose hub has not written its row yet.
 */
export async function registryStale(store: StoreLike, args: { registry: unknown; machine: string; file: string }): Promise<boolean> {
  const reference = storeMachineOf(args.registry);
  if (reference === null || reference === args.machine) return false;
  const theirs = (await readRegistryDigests(store)).find((row) => row.machine === reference);
  if (!theirs || theirs.sha256 === "") return false;
  return theirs.sha256 !== registryDigest(args.file);
}
