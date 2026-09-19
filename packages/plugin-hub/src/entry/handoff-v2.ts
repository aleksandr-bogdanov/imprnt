import { applyHandoff } from "../migrate/handoff.ts";
import { migrationCommand } from "../migrate/command.ts";
import { conversionDone } from "../door/lines.ts";
process.exit(await migrationCommand("handoff-v2", async manifest => {
  await applyHandoff(manifest, { registryFile: manifest.registry });
  return conversionDone("en", { count: manifest.items.filter((item: any) => item.state !== "completed").length, skipped: 0 });
}));
