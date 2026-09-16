// Test infrastructure. Starts a throwaway cluster in a process of its own and
// then waits to be killed.
//
// 03b item 9's FIRST half, the one BUILD-NOTES 19 and the file it lives beside
// both say "cannot be checked from inside a test, because a check cannot
// observe its own death". It can, from outside: this is the process that dies,
// and `test/cluster-shm.test.ts` is the one watching. What is under test is
// `test/helpers/cluster.ts`'s own leaving wiring, so this file imports that
// helper and adds nothing of its own, and a handler that swallowed the signal
// or re-entered itself is a child that is still here ten seconds later.
//
// D-64's rule, as every subprocess helper here follows it: exactly one JSON
// line when it is up, so the watcher never has to guess whether "not started
// yet" or "started and waiting" is what it is looking at.
//
// Usage: bun run test/helpers/cluster-subprocess.ts

import { startCluster } from "./cluster.ts";

const cluster = await startCluster();

process.stdout.write(
  JSON.stringify({
    ready: true,
    pid: process.pid,
    dataDir: cluster.dataDir,
    port: cluster.port,
  }) + "\n",
);

// Held open by the promise alone would spin (the measurement in
// `test/wait-idle.test.ts`'s header), so the event loop is held by a timer the
// way `src/entry/hold.ts` holds it.
setInterval(() => {}, 1_000_000);
await new Promise<void>(() => {});
