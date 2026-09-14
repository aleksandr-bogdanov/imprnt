// Test infrastructure. Reads one setting through the real loader, in a process
// of its own, and prints the answer as JSON on stdout.
//
// RUN-07 forbids "a behaviour switch on the command line or in an environment
// variable". An in-process check cannot prove that honestly: the loader, or any
// helper it imports, can read `process.env` once at import time, and by the
// time a test has planted its override the module graph may already be built.
// Busting the cache of the root module does not help, because a helper module
// imported earlier keeps its snapshot.
//
// A separate process has no such history. The environment and the argument list
// are set before `bun` starts, so whatever the loader does at import time it
// does with the override already in place. The check runs this twice, once
// clean and once poisoned, and the two answers must match.
//
// Usage: bun run test/helpers/read-setting-subprocess.ts [key]
// With no key it reports the first numeric field the loader declares.

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

const hub = dirname(dirname(import.meta.dir));
const loader = join(hub, "src/registry/load.ts");
const shipped = join(hub, "src/registry/registry.example.toml");

function fail(message: string): never {
  process.stdout.write(JSON.stringify({ ok: false, error: message }) + "\n");
  process.exit(1);
}

if (!existsSync(loader)) {
  fail(`seam module missing: src/registry/load.ts (expected at ${loader})`);
}

let mod: Record<string, unknown>;
try {
  mod = (await import(loader)) as Record<string, unknown>;
} catch (err) {
  fail(`could not import src/registry/load.ts: ${(err as Error).message}`);
}

const { loadRegistry, readSetting, SETTING_FIELDS } = mod as {
  loadRegistry: (file: string) => unknown;
  readSetting: (registry: unknown, key: string) => unknown;
  SETTING_FIELDS: { key: string; type: string }[];
};

if (typeof loadRegistry !== "function" || typeof readSetting !== "function") {
  fail("src/registry/load.ts does not export loadRegistry and readSetting");
}

const asked = process.argv[2];
const numeric = (SETTING_FIELDS ?? []).find(
  (f) => f.type === "integer" || f.type === "number",
);
const key = asked ?? numeric?.key;

if (!key) {
  fail("SETTING_FIELDS declares no numeric setting to read");
}

try {
  const value = readSetting(loadRegistry(shipped), key);
  process.stdout.write(JSON.stringify({ ok: true, key, value }) + "\n");
} catch (err) {
  fail(`reading ${key} failed: ${(err as Error).message}`);
}
