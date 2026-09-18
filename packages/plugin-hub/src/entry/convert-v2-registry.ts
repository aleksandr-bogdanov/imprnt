import { convertV2Registry } from "../migrate/registry.ts";
import { discordChannels } from "../door/platforms/discord.ts";
import { migrationCommand } from "../migrate/command.ts";
import { conversionDone } from "../door/lines.ts";
process.exit(await migrationCommand(async manifest => conversionDone("en", await convertV2Registry(manifest, discordChannels))));
