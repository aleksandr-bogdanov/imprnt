import { command } from "./command.ts";
const [registry, ...args] = process.argv.slice(2);
process.exit(await command(["install", registry, ...(args.length ? args : ["database"])]));
