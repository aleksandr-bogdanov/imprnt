import { putRow, readSheet } from "../records/statesheet.ts";
import { listMachines } from "../registry/entries.ts";
import { readSetting, registryDigest } from "../registry/load.ts";
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
 * The machine whose copy of the registry is the one every other copy is
 * measured against: `hub.store_machine`, which the loader requires as soon as
 * any machine reaches the store by a route of its own. Null when the file
 * names none, which the loader allows only for a file with one route to the
 * store, where there is one copy and nothing to compare.
 */
export function storeMachineOf(registry: unknown): string | null {
  const named = readSetting(registry, "hub.store_machine");
  return typeof named === "string" && named !== "" && listMachines(registry).some((one) => one.id === named) ? named : null;
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

export interface RegistryStanding {
  /** Whether this machine must claim nothing until its copy is the store machine's. */
  stale: boolean;
  /** Why, in one sentence, for the diary and the finding. Empty when current. */
  reason: string;
}

/**
 * Whether the copy at `file`, on `machine`, may serve: only once it is the
 * store machine's copy, byte for byte. The store machine itself and a file
 * with one route to the store are always current. A store machine whose hub
 * has not written its row yet is NOT agreement: nothing says what the copy is
 * measured against, so the spoke waits and says why.
 */
export async function registryStanding(store: StoreLike, args: { registry: unknown; machine: string; file: string }): Promise<RegistryStanding> {
  const reference = storeMachineOf(args.registry);
  if (reference === null || reference === args.machine) return { stale: false, reason: "" };
  const theirs = (await readRegistryDigests(store)).find((row) => row.machine === reference);
  if (!theirs || theirs.sha256 === "") {
    return { stale: true, reason: `the hub on ${reference} has not written what registry it runs, so this copy cannot be measured against it` };
  }
  if (theirs.sha256 !== registryDigest(args.file)) {
    return { stale: true, reason: `this copy of the registry is not the one ${reference} runs` };
  }
  return { stale: false, reason: "" };
}
