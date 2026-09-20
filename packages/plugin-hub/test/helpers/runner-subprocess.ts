// Test infrastructure. Runs the REAL runner in a process of its own.
//
// The runner kill test needs a process the test can kill
// with the settle transaction blocked, and the adapter registry is a
// parameter, so the adapter name comes from argv rather than being fixed here.
// A caller hands it a name generated at run time, which is what makes "no
// branch on the adapter name anywhere but the adapter registry" probeable: a
// build cannot have enumerated a name it could not know.
//
// It calls the production `runRunner` and defines no runner of its own.
//
// Usage: bun run test/helpers/runner-subprocess.ts <registryFile> <runnerId> <adapterServerUrl> <adapterName> [child]
//
// With the fifth argument `child`, the adapter client spawns a REAL child here,
// inside THIS process, so the child's parent pid is the runner's.
// Without it nothing changes and every check that uses this
// entry behaves exactly as it does without the argument.

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { adapterClient } from "./scripted-adapter.ts";

const hub = dirname(dirname(import.meta.dir));
const runnerModule = join(hub, "src/runner/run.ts");

function fail(message: string): never {
  process.stdout.write(JSON.stringify({ ready: false, error: message }) + "\n");
  process.exit(1);
}

const [registryFile, runnerId, adapterUrl, adapterName, childFlag] = process.argv.slice(2);
if (!registryFile || !runnerId || !adapterUrl || !adapterName) {
  fail(
    "usage: runner-subprocess.ts <registryFile> <runnerId> <adapterServerUrl> <adapterName> [child]",
  );
}

if (!existsSync(runnerModule)) {
  fail(`seam module missing: src/runner/run.ts (expected at ${runnerModule})`);
}

let mod: Record<string, unknown>;
try {
  mod = (await import(runnerModule)) as Record<string, unknown>;
} catch (err) {
  fail(`could not import src/runner/run.ts: ${(err as Error).message}`);
}

const runRunner = mod.runRunner as
  | ((options: {
      runner: string;
      registryFile: string;
      adapters: Record<string, unknown>;
    }) => Promise<{ runner: string; stop(): Promise<void> }>)
  | undefined;

if (typeof runRunner !== "function") {
  fail("src/runner/run.ts does not export runRunner");
}

let handle: { stop(): Promise<void> };
try {
  handle = await runRunner({
    runner: runnerId,
    registryFile,
    adapters: {
      [adapterName]: adapterClient(adapterUrl, adapterName, {
        child: childFlag === "child",
      }),
    },
  });
} catch (err) {
  fail(`runRunner refused to start: ${(err as Error).message}`);
}

process.stdout.write(
  JSON.stringify({ ready: true, pid: process.pid }) + "\n",
);

const stop = async () => {
  try {
    await handle.stop();
  } finally {
    process.exit(0);
  }
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);

await new Promise<void>(() => {});
