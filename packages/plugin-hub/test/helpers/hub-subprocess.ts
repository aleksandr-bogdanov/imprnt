// Test infrastructure. Runs the REAL hub in a process of its own.
//
// The routine-operations smoke asserts that a process id did not change, and a
// process id is a fact about a PROCESS, not about a handle in the test's own
// runtime. That is the reason the door and the runner have one, and it
// is why this file exists rather than a `runHub` call inside a check.
//
// It calls the production `runHub` and defines no hub of its own.
//
// The machine is "to whom", taken from argv, never a setting and never
// read from the environment. `runHub` refuses a machine whose declared `os` is
// not the platform it is running on, so a check declares its `[[machines]]`
// entry through `thisMachine()`.
//
// THE UNIT DIRECTORY IS OPTIONAL AND IS A CHECK'S SAFETY RAIL, not a behaviour.
// `runHub` takes `os?: OsSeam` in the pinned contract, so a check hands it a
// seam pointed at the directory `test/helpers/units.ts` will clean up. Without
// it a check on a Mac would write plists into the owner's own
// `~/Library/LaunchAgents` and leave them there. On linux the fixture's
// directory IS the manager's search path, so nothing changes.
//
// Usage: bun run test/helpers/hub-subprocess.ts <registryFile> <machine> [unitDir]

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

const hub = dirname(dirname(import.meta.dir));
const hubModule = join(hub, "src/hub/run.ts");

function fail(message: string): never {
  process.stdout.write(JSON.stringify({ ready: false, error: message }) + "\n");
  process.exit(1);
}

const [registryFile, machine, unitDir] = process.argv.slice(2);
if (!registryFile || !machine) {
  fail("usage: hub-subprocess.ts <registryFile> <machine> [unitDir]");
}

// The seam-missing path, spelled out, so a check that starts a hub before
// `src/hub/run.ts` exists goes red on ONE readable line rather than on a thirty
// second timeout waiting for a ready line that is never coming.
if (!existsSync(hubModule)) {
  fail(`seam module missing: src/hub/run.ts (expected at ${hubModule})`);
}

let mod: Record<string, unknown>;
try {
  mod = (await import(hubModule)) as Record<string, unknown>;
} catch (err) {
  fail(`could not import src/hub/run.ts: ${(err as Error).message}`);
}

const runHub = mod.runHub as
  | ((options: {
      machine: string;
      registryFile: string;
      os?: unknown;
    }) => Promise<{ machine: string; stop(): Promise<void> }>)
  | undefined;

if (typeof runHub !== "function") {
  fail("src/hub/run.ts does not export runHub");
}

let os: unknown;
if (unitDir) {
  const osModule = join(hub, "src/os/index.ts");
  if (!existsSync(osModule)) {
    fail(`seam module missing: src/os/index.ts (expected at ${osModule})`);
  }
  const osMod = (await import(osModule)) as Record<string, unknown>;
  const thisOs = osMod.thisOs as ((options?: unknown) => unknown) | undefined;
  if (typeof thisOs !== "function") fail("src/os/index.ts does not export thisOs");
  os = thisOs({ unitDir });
}

let handle: { stop(): Promise<void> };
try {
  handle = await runHub(os ? { machine, registryFile, os } : { machine, registryFile });
} catch (err) {
  fail(`runHub refused to start: ${(err as Error).message}`);
}

process.stdout.write(JSON.stringify({ ready: true, pid: process.pid }) + "\n");

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
