import { command } from "./command.ts";
process.exit(await command(["recover", ...process.argv.slice(2)]));
