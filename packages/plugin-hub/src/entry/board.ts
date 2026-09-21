// The board, as a program the operating system starts.
//
// Argv is `<registryFile> <entry id>` and nothing else, the shape every other
// program here has. Which address it listens on and on what port are in the
// registry entry the id names, which is what the loader already refuses a board
// for naming badly.
//
// Usage: bun run src/entry/board.ts <registryFile> <entry id>

import { runBoard } from "../board/run.ts";
import { boardBindFailed } from "../door/lines.ts";
import { thisOs } from "../os/index.ts";
import { listRunEntries } from "../registry/entries.ts";
import { setKey } from "../registry/edit.ts";
import { loadRegistry } from "../registry/load.ts";
import { openStore } from "../store/connect.ts";
import { storeUrlFor } from "../store/secrets.ts";
import { hold, usage } from "./hold.ts";

const [registryFile, id, extra] = process.argv.slice(2);
if (!registryFile || !id || extra) usage("board");

const registry = loadRegistry(registryFile);
const entry = listRunEntries(registry).find((one) => one.id === id && one.kind === "board");
if (!entry) {
  process.stderr.write(`${registryFile} has no [[run]] entry ${id} of kind board\n`);
  process.exit(2);
}

// The store is opened under THIS ENTRY'S OWN NAME and never under the hub's.
// `src/hub/run.ts` takes an advisory lock keyed on the hub's application name
// and refuses a second holder as a second hub, so a board wearing that name
// would either refuse to start or take the machine's hub down with it.
const store = await openStore({ url: storeUrlFor(registry, "hub_hub", entry.id) });

let handle: { stop(): Promise<void> };
try {
  handle = await runBoard({
    entry,
    registryFile,
    store,
    os: thisOs(),
    // Start, stop and pause edit the live file through the one registry writer,
    // because the owner ruled that a board reachable only on the tailnet may.
    // The writer names the entry by its id and never by its position, holds a
    // lock no other writer on this machine can pass while it edits, and
    // replaces the file only with a candidate it has loaded and compared
    // against the one intended change. The board's own defences stay in front
    // of it: an act from this machine or from another page never reaches it.
    writeRegistryKey: async ({ file, table, id, key, value }) => {
      await setKey(file, `${table}[${id}]`, key, value);
    },
  });
} catch (error) {
  // A bind this machine does not hold kills the process with the cause named.
  // Nothing falls back to another address and no port is opened, the service
  // manager restarts it, and `check` shows the result as a crash loop or as a
  // missing unit.
  process.stderr.write(
    boardBindFailed("en", {
      bind: entry.bind,
      // Which of the two ports refused, since a board that serves artifacts
      // listens twice and an operator reads one line.
      port: (error as { port?: number }).port ?? entry.port,
      cause: (error as Error).message,
    }) + "\n",
  );
  await store.close().catch(() => {});
  process.exit(1);
}

await hold(handle);
