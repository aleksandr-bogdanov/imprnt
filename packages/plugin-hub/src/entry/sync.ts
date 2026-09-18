import { finding, cliUsage } from "../door/lines.ts";
import { listRunEntries } from "../registry/entries.ts";
import { loadRegistry } from "../registry/load.ts";
import { runSync } from "../sync/run.ts";

const [file, id, extra] = process.argv.slice(2);
if (!file || !id || extra) {
  process.stderr.write(cliUsage("en") + "\n");
  process.exit(2);
}
try {
  const registry = loadRegistry(file);
  const entry = listRunEntries(registry).find(one => one.id === id && one.kind === "sync");
  if (!entry) throw new Error("sync-entry-unknown");
  await runSync(entry, registry);
} catch {
  process.stderr.write(finding("en", { code: "sync-failed", target: id, cause: "operation failed" }) + "\n");
  process.exit(1);
}
