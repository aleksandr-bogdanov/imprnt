// The hub's registry delivery for ONE machine, in a process of its own, for `live/prove-return-move.ts`: on every tick the very functions
// `hub/run.ts` runs, in its order (`deliverRegistry`, `recordRegistryDigest`, `registerMoves`), on a store opened as the hub's role, the way
// `test/helpers/move-e2e-stage.ts` drives them. Not the hub: no units are rendered, installed or started, no erasure pass, no lock.
//
//   bun live/prove-hub-loop.ts <registryFile> <machine> <journalFile>
//
// Prints one JSON line on stdout once the store is open ({"ready":true,"pid":n}) or it could not be ({"ready":false,"error":...}).
// SIGTERM, SIGINT, or (PROVE_STOP_ON_STDIN_EOF=1) the end of stdin: the tick in flight finishes, the store is closed, exit 0.
// The journal holds counts and scrubbed failures only, never the registry's content.

import { appendFileSync } from "node:fs";
import { recordRegistryDigest } from "../src/hub/digest.ts";
import { deliverRegistry } from "../src/hub/distribute.ts";
import { registerMoves } from "../src/hub/moves.ts";
import { appendEntry } from "../src/records/diary.ts";
import { loadRegistry, type Registry } from "../src/registry/load.ts";
import { openStore, type Store } from "../src/store/connect.ts";
import { storeUrlFor } from "../src/store/secrets.ts";
import { scrub } from "./engine-observer.ts";

const TICK_MS = 500;
const say = (line: Record<string, unknown>): void => { process.stdout.write(JSON.stringify(line) + "\n"); };
const [registryFile, machine, journal] = process.argv.slice(2);
if (!registryFile || !machine || !journal) {
  say({ ready: false, error: "usage: prove-hub-loop.ts <registryFile> <machine> <journalFile>" });
  process.exit(2);
}
const note = (line: Record<string, unknown>): void => { appendFileSync(journal, JSON.stringify({ at: new Date().toISOString(), ...line }) + "\n", { mode: 0o600 }); };

const load = (): Registry => loadRegistry(registryFile, { machine });
let store: Store;
try { store = await openStore({ url: storeUrlFor(load(), "hub_hub", `hub-${machine}`) }); }
catch (error) {
  const said = scrub(error, []);
  note({ event: "start_failed", error: said });
  say({ ready: false, error: said });
  process.exit(1);
}
const diary = async (kind: string, subject: string, detail: Record<string, unknown>): Promise<void> => {
  await appendEntry(store, { stream: "machine", subject, kind, actor: "hub", detail });
};

let ticks = 0;
let failures = 0;
const results: Record<string, number> = {};
const tick = async (): Promise<void> => {
  let registry: Registry;
  try { registry = load(); } catch { return; }
  const delivered = await deliverRegistry({ store, registryFile, machine, registry, load, say: diary });
  results[delivered] = (results[delivered] ?? 0) + 1;
  if (delivered === "installed") note({ event: "installed" });
  await recordRegistryDigest(store, machine, registryFile);
  await registerMoves({ store, registryFile, machine, load, say: diary });
};

let stopping = false;
const loop = (async () => {
  while (!stopping) {
    try { await tick(); } catch (error) { failures += 1; note({ event: "tick_failed", error: scrub(error, []) }); }
    ticks += 1;
    await Bun.sleep(TICK_MS);
  }
})();
note({ event: "ready", pid: process.pid, machine });
say({ ready: true, pid: process.pid });

const stop = async (): Promise<void> => {
  if (stopping) return;
  stopping = true;
  await loop;
  await store.close().catch(() => {});
  note({ event: "stopped", ticks, failures, delivered: results });
  process.exit(0);
};
process.on("SIGTERM", () => { void stop(); });
process.on("SIGINT", () => { void stop(); });
if (process.env.PROVE_STOP_ON_STDIN_EOF === "1") {
  void (async () => {
    try { for await (const _ of Bun.stdin.stream()) { /* nothing is read from it */ } } catch { /* an error is an end too */ }
    void stop();
  })();
}
