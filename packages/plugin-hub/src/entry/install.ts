import { command } from "./command.ts";
process.exit(await command(["install", ...process.argv.slice(2)]));
