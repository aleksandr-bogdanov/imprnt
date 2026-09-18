import { loadRegistry } from "../registry/load.ts";
import { runEntriesFor } from "../registry/entries.ts";
import { wantedState } from "../os/diff.ts";
import { thisOs } from "../os/index.ts";
import type { OsSeam } from "../os/types.ts";

export async function readStatus(options: { registryFile: string; machine: string; os?: OsSeam }) {
  const os = options.os ?? thisOs();
  return await Promise.all(runEntriesFor(loadRegistry(options.registryFile), options.machine).map(async entry => {
    const state = await os.show(entry.id);
    const wanted = wantedState(entry);
    const seen = !state ? "missing" : state.running ? "running" : state.loaded && wanted === "scheduled" ? "scheduled" : "stopped";
    return { id: entry.id, wanted, seen, pid: state?.pid ?? null };
  }));
}
