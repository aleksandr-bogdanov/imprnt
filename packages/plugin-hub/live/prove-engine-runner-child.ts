// The REAL runner in a process of its own, for `live/prove-engine-runner.ts`. It defines no runner and no adapter: it hands the production
// `runRunner` the production `ADAPTERS`, each wrapped by the pure observer of `live/engine-observer.ts`, so a stop and a start of this process
// are a real runner restart and what the engines did is journaled as normalized metadata.
//
//   bun live/prove-engine-runner-child.ts <registryFile> <runnerId> <journalFile>
//
// Environment: PROVE_REDACT, a JSON array of strings scrubbed from every journaled error (the credential path, for one), and
// PROVE_STOP_BOUND_MS, how long the production stop may take. The engine never sees this process's environment: every production launch
// builds its own from PATH, LANG, LC_ALL and TZ alone.
//
// Prints exactly one JSON line on stdout once `runRunner` has returned ({"ready":true,"pid":n}) or refused ({"ready":false,"error":...}).
// SIGTERM or SIGINT: the production `stop()` (which closes every child it owns), then each session's own exit evidence, then exit 0. A
// second signal does nothing; the parent's SIGKILL after its bound is the only way past a stop that hangs. With PROVE_STOP_ON_STDIN_EOF=1
// the end of stdin is the same stop: a process started over ssh is stopped by closing its stdin, and is stopped too if the link drops.

import { appendFileSync } from "node:fs";
import { ADAPTERS } from "../src/adapters/index.ts";
import { runRunner, type RunnerHandle } from "../src/runner/run.ts";
import { observeAdapters, scrub, type Observed } from "./engine-observer.ts";

const EXIT_EVIDENCE_BOUND_MS = 5_000;
/** How long the production stop may take before each session is ended through its own verbs. The parent's bound is longer. */
const STOP_BOUND_MS = (() => {
  const said = Number(process.env.PROVE_STOP_BOUND_MS);
  return Number.isInteger(said) && said >= 1_000 ? said : 45_000;
})();

const say = (line: Record<string, unknown>): void => { process.stdout.write(JSON.stringify(line) + "\n"); };

const [registryFile, runnerId, journal] = process.argv.slice(2);
if (!registryFile || !runnerId || !journal) {
  say({ ready: false, error: "usage: prove-engine-runner-child.ts <registryFile> <runnerId> <journalFile>" });
  process.exit(2);
}

let redactions: string[] = [];
try {
  const named = JSON.parse(process.env.PROVE_REDACT ?? "[]") as unknown;
  if (Array.isArray(named)) redactions = named.filter((one): one is string => typeof one === "string" && one !== "");
} catch { redactions = []; }

const sink = (line: Observed): void => { appendFileSync(journal, JSON.stringify(line) + "\n", { mode: 0o600 }); };
const observer = observeAdapters(ADAPTERS, sink, redactions);

let handle: RunnerHandle;
try {
  handle = await runRunner({ runner: runnerId, registryFile, adapters: observer.adapters });
} catch (error) {
  const said = scrub(error, redactions);
  sink({ kind: "runner", at: new Date().toISOString(), event: "start_failed", pid: process.pid, error: said });
  say({ ready: false, error: said });
  process.exit(1);
}
sink({ kind: "runner", at: new Date().toISOString(), event: "ready", pid: process.pid });
say({ ready: true, pid: process.pid });

let stopping = false;
const stop = async (): Promise<void> => {
  if (stopping) return;
  stopping = true;
  sink({ kind: "runner", at: new Date().toISOString(), event: "stopping", pid: process.pid });
  const outcome = await Promise.race([
    handle.stop().then(() => "stopped" as const, (error: unknown) => scrub(error, redactions)),
    Bun.sleep(STOP_BOUND_MS).then(() => `the production stop did not finish within ${STOP_BOUND_MS} ms`),
  ]);
  if (outcome === "stopped") sink({ kind: "runner", at: new Date().toISOString(), event: "stopped", pid: process.pid });
  else {
    sink({ kind: "runner", at: new Date().toISOString(), event: "stop_failed", pid: process.pid, error: outcome });
    // The production stop did not end its children: each session is asked to end through its own production verb, its interrupt
    // (tools first, then the loop, then its verified group) where it has one, its close otherwise. Nothing is signalled from here.
    for (const { session } of observer.sessions()) {
      try { await Promise.race([session.interrupt ? session.interrupt({ graceMs: 2_000 }) : session.close(), Bun.sleep(10_000)]); } catch { /* the evidence below says */ }
    }
  }
  // After the production stop closed its children: what each session itself can show of its processes being gone.
  await observer.recordExits(EXIT_EVIDENCE_BOUND_MS);
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

await new Promise<void>(() => {});
