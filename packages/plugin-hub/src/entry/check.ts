import { command } from "./command.ts";
process.exit(await command(["check", ...process.argv.slice(2)]));
