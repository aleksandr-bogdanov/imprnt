import { loadRegistry } from "../registry/load.ts";
import { runEntriesFor } from "../registry/entries.ts";
import { wantedState } from "../os/diff.ts";
import { thisOs } from "../os/index.ts";
import type { OsSeam } from "../os/types.ts";

export async function readStatus(options: { registryFile: string; machine: string; os?: OsSeam }) {
  const os = options.os ?? thisOs();
  return await Promise.all(runEntriesFor(loadRegistry(options.registryFile, { machine: options.machine }), options.machine).map(async entry => {
    const state = await os.show(entry.id);
    const wanted = wantedState(entry);
    // WITH NO RECORD AT ALL, a stopped entry reads stopped and not missing.
    // `missing` is the word a finding uses, and a piece the household asked to
    // be down is not missing.
    const seen = !state ? (wanted === "stopped" ? "stopped" : "missing")
      : state.running ? "running" : state.loaded && wanted === "scheduled" ? "scheduled" : "stopped";
    return { id: entry.id, wanted, seen, pid: state?.pid ?? null };
  }));
}
