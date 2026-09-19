import { convertV2Chatlog } from "../migrate/chatlog.ts";
import { migrationCommand } from "../migrate/command.ts";
import { conversionDone } from "../door/lines.ts";
process.exit(await migrationCommand("convert-v2-chatlog", async manifest => conversionDone("en", await convertV2Chatlog(manifest))));
