import { finding, cliUsage } from "../door/lines.ts";
import { listRunEntries } from "../registry/entries.ts";
import { entryMachine, loadRegistry } from "../registry/load.ts";
import { runSync } from "../sync/run.ts";

const [file, id, extra] = process.argv.slice(2);
if (!file || !id || extra) {
  process.stderr.write(cliUsage("en") + "\n");
  process.exit(2);
}
try {
  // Read for this entry's machine, so a sync on a spoke keeps the checkouts
  // that are there, at the paths they have there.
  const registry = loadRegistry(file, { machine: entryMachine(file, id) });
  const entry = listRunEntries(registry).find(one => one.id === id && one.kind === "sync");
  if (!entry) throw new Error("sync-entry-unknown");
  await runSync(entry, registry);
} catch {
  process.stderr.write(finding("en", { code: "sync-failed", target: id, cause: "operation failed" }) + "\n");
  process.exit(1);
}
