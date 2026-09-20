// The hub, as a program the operating system starts.
//
// Argv is `<registryFile> <entry id>` like every other entry, and the
// machine this hub is for is read off that entry: an identity is "to
// whom", and the registry still says everything about how the machine behaves.
//
// Usage: bun run src/entry/hub.ts <registryFile> <entry id>

import { listRunEntries } from "../registry/entries.ts";
import { loadRegistry } from "../registry/load.ts";
import { runHub } from "../hub/run.ts";
import { hold, usage } from "./hold.ts";

const [registryFile, id] = process.argv.slice(2);
if (!registryFile || !id) usage("hub");

const entry = listRunEntries(loadRegistry(registryFile)).find((one) => one.id === id);
if (!entry) {
  process.stderr.write(`${registryFile} has no [[run]] entry ${id}\n`);
  process.exit(2);
}

const handle = await runHub({ machine: entry.machine, registryFile });
await hold(handle);
