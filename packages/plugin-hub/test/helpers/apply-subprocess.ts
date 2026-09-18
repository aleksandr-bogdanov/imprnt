// Test infrastructure. Files one staged note through the real `applyNote`, in
// a process of its own, and prints the answer as JSON on stdout.
//
// A check about the PARENT's environment cannot plant it in the test process.
// Measured on 2026-09-18 under bun 1.3.14: a `Bun.spawn` with no `env` hands
// the child the environment its own process STARTED with, so a variable set or
// deleted in `process.env` afterwards never reaches it. A build that ignores
// `process.env` would then pass or fail depending on the shell the suite was
// started from, which is no check at all.
//
// A separate process has no such history. Its environment is set before `bun`
// starts, exactly as a runner started from a shell with FORCE_COLOR exported
// really has it, and whatever `applyNote` hands its child comes from there.
//
// Usage: bun test/helpers/apply-subprocess.ts <imprnt> <vault root> <staged file>

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

const hub = dirname(dirname(import.meta.dir));
const module = join(hub, "src/harvest/apply.ts");

function fail(message: string): never {
  process.stdout.write(JSON.stringify({ ok: false, error: message }) + "\n");
  process.exit(1);
}

if (!existsSync(module)) {
  fail(`seam module missing: src/harvest/apply.ts (expected at ${module})`);
}

const [imprnt, vault, file] = process.argv.slice(2);
if (!imprnt || !vault || !file) {
  fail("usage: apply-subprocess.ts <imprnt> <vault root> <staged file>");
}

const { applyNote } = (await import(module)) as {
  applyNote?: (args: { imprnt: string; vault: string; file: string }) => Promise<unknown>;
};
if (typeof applyNote !== "function") fail("src/harvest/apply.ts does not export applyNote");

const result = await applyNote({ imprnt, vault, file });
process.stdout.write(JSON.stringify({ ok: true, result }) + "\n");
