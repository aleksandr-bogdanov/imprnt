// The metrics table, as a command a household runs.
//
// Argv is the registry file and nothing else, which is "what to do and
// to whom" and is all an entry point may take. Nothing is read from the
// environment and no argv value switches behaviour.
//
// What ships here is the DATA and the smallest honest display of it. A richer
// front end belongs on top of this same reader rather than beside it as a
// second copy.
//
// Usage: bun run src/entry/metrics.ts <registryFile>

import { readStampMetrics, renderMetrics } from "../metrics/stamps.ts";
import { loadRegistry } from "../registry/load.ts";
import { closeStore, openStore } from "../store/connect.ts";
import { storeUrlFor } from "../store/secrets.ts";

const [registryFile] = process.argv.slice(2);
if (!registryFile) {
  process.stderr.write("usage: bun run src/entry/metrics.ts <registryFile>\n");
  process.exit(2);
}

const registry = loadRegistry(registryFile);
const store = await openStore({
  url: storeUrlFor(registry, "hub_hub"),
});
try {
  process.stdout.write(`${renderMetrics(await readStampMetrics(store))}\n`);
} finally {
  await closeStore(store);
}
process.exit(0);
