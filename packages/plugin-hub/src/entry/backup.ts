import { finding, cliUsage } from "../door/lines.ts";
import { BackupRefused, runBackup } from "../backup/run.ts";
import { listRunEntries } from "../registry/entries.ts";
import { entryMachine, loadRegistry } from "../registry/load.ts";

const [file, id, extra] = process.argv.slice(2);
if (!file || !id || extra) {
  process.stderr.write(cliUsage("en") + "\n");
  process.exit(2);
}
try {
  const registry = loadRegistry(file, { machine: entryMachine(file, id) });
  const entry = listRunEntries(registry).find(one => one.id === id && one.kind === "backup");
  if (!entry) throw new Error("backup-entry-unknown");
  await runBackup(entry, registry);
} catch (error) {
  // The cause is one of the closed list's words and never the command's own
  // output, which can carry a destination with a login in it.
  const cause = error instanceof BackupRefused ? error.reason : "operation failed";
  process.stderr.write(finding("en", { code: "backup-failed", target: id, cause }) + "\n");
  process.exit(1);
}
