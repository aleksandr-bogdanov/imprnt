import { catchUpHarvest } from "../migrate/harvest.ts";
import { loadRegistry } from "../registry/load.ts";
import { migrationCommand } from "../migrate/command.ts";
import { harvestDone } from "../door/lines.ts";
process.exit(await migrationCommand(async manifest => {
  await catchUpHarvest(loadRegistry(manifest.registry), manifest.person, manifest.from, manifest.until);
  return harvestDone("en", { person: manifest.person, until: manifest.until });
}));
