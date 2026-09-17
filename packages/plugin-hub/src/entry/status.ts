import { command } from "./command.ts";
process.exit(await command(["status", ...process.argv.slice(2)]));
