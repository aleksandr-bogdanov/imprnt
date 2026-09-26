import { finding, cliUsage } from "../door/lines.ts";
import { listRunEntries } from "../registry/entries.ts";
import { entryMachine, loadRegistry } from "../registry/load.ts";
import { runWatch, WatchRefused } from "../watch/run.ts";

const [file, id, extra] = process.argv.slice(2);
if (!file || !id || extra) {
  process.stderr.write(cliUsage("en") + "\n");
  process.exit(2);
}
try {
  const registry = loadRegistry(file, { machine: entryMachine(file, id) });
  const entry = listRunEntries(registry).find(one => one.id === id && one.kind === "watch");
  if (!entry) throw new Error("watch-entry-unknown");
  await runWatch(entry, registry);
} catch (error) {
  // The cause is one of the closed list's words and never the source's own
  // answer, which can carry a key or a person's data. Nothing was posted and
  // the state is as the last sweep left it; the stamp is not written, so a
  // watch that keeps failing is `job-stale` within a day.
  const cause = error instanceof WatchRefused ? error.reason : "operation failed";
  process.stderr.write(finding("en", { code: "watch-failed", target: id, cause }) + "\n");
  process.exit(1);
}
