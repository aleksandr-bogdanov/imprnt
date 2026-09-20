// The runner, as a program the operating system starts.
//
// Argv is `<registryFile> <entry id>`, which is what to do and to whom,
// and that is all argv may carry. Nothing here reads a behaviour from the
// command line or from the environment: every setting is in the registry file
// this was handed, and a value that is not in that file does not exist.
//
// Usage: bun run src/entry/runner.ts <registryFile> <entry id>

import { ADAPTERS } from "../adapters/index.ts";
import { runRunner } from "../runner/run.ts";
import { hold, usage } from "./hold.ts";

const [registryFile, runner] = process.argv.slice(2);
if (!registryFile || !runner) usage("runner");

const handle = await runRunner({ runner, registryFile, adapters: ADAPTERS });
await hold(handle);
