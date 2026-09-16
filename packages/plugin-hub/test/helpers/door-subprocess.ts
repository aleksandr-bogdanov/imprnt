// Test infrastructure. Runs the REAL door in a process of its own.
//
// D-33 and D-63. A `kill -9` at an exact point cannot be staged in process, and
// the two door kill tests are the phase's first criterion. So the door runs
// here, as a `bun` child, wired to the fake platform over HTTP. It calls the
// production `runDoor` and defines no door of its own: a copy would be a
// fixture doing the production work, and the check would prove nothing.
//
// It prints exactly one JSON line on stdout when the handle is up,
// {"ready":true,"pid":<n>}, and the test waits for that line before staging
// anything. Without it a check cannot tell "not started yet" from "started and
// waiting", and would kill the wrong moment.
//
// Usage: bun run test/helpers/door-subprocess.ts <registryFile> <doorId> <platformServerUrl>

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { platformClient } from "./fake-platform.ts";

const hub = dirname(dirname(import.meta.dir));
const doorModule = join(hub, "src/door/run.ts");

function fail(message: string): never {
  process.stdout.write(JSON.stringify({ ready: false, error: message }) + "\n");
  process.exit(1);
}

const [registryFile, doorId, platformUrl] = process.argv.slice(2);
if (!registryFile || !doorId || !platformUrl) {
  fail("usage: door-subprocess.ts <registryFile> <doorId> <platformServerUrl>");
}

if (!existsSync(doorModule)) {
  fail(`seam module missing: src/door/run.ts (expected at ${doorModule})`);
}

let mod: Record<string, unknown>;
try {
  mod = (await import(doorModule)) as Record<string, unknown>;
} catch (err) {
  fail(`could not import src/door/run.ts: ${(err as Error).message}`);
}

const runDoor = mod.runDoor as
  | ((options: {
      door: string;
      registryFile: string;
      platform: unknown;
    }) => Promise<{ door: string; stop(): Promise<void> }>)
  | undefined;

if (typeof runDoor !== "function") {
  fail("src/door/run.ts does not export runDoor");
}

let handle: { stop(): Promise<void> };
try {
  handle = await runDoor({
    door: doorId,
    registryFile,
    // The client asks the server what it is before it is handed over, so a
    // door in this process holds the same typing lifetime the in-process one
    // does (D-125).
    platform: await platformClient(platformUrl),
  });
} catch (err) {
  fail(`runDoor refused to start: ${(err as Error).message}`);
}

process.stdout.write(
  JSON.stringify({ ready: true, pid: process.pid }) + "\n",
);

// A clean stop on SIGTERM, so a test that is not staging a kill can end the
// door politely. A kill -9 gets no handler, which is the point.
const stop = async () => {
  try {
    await handle.stop();
  } finally {
    process.exit(0);
  }
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);

// Stay alive. The door's own work runs on its handle.
await new Promise<void>(() => {});
