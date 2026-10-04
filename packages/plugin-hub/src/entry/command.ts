import { loadRegistry, registryDigest, type Registry } from "../registry/load.ts";
import { listMachines, listRunEntries } from "../registry/entries.ts";
import { appendEntry } from "../records/diary.ts";
import { storeMachineOf } from "../hub/digest.ts";
import { overrideRegistryCopy, standingOf } from "../hub/distribute.ts";
import { openStore } from "../store/connect.ts";
import { storeUrlFor } from "../store/secrets.ts";
import { runCheck, type Acknowledged } from "../check/run.ts";
import { readKernelView } from "../check/kernel.ts";
import { thisOs } from "../os/index.ts";
import { readStatus } from "../hub/status.ts";
import { runInstall } from "../install/run.ts";
import { relayoutRegistry } from "../registry/relayout.ts";
import { requestRecovery } from "../hub/control.ts";
import { readStampMetrics, renderMetrics } from "../metrics/stamps.ts";
import { checkClean, cliUsage, operation, registryCopy, safeValue, status } from "../door/lines.ts";
import { restoreCommand } from "./restore.ts";
import { healthCommand } from "./health.ts";

export async function command(args: string[]): Promise<number> {
  // `restore` has flags of its own and is read by its own parser (`entry/restore.ts`): it is the barrier a restore runs before serving.
  if (args[0] === "restore") return await restoreCommand(args.slice(1));
  // `health` too: its records name exact evidence by flag (`entry/health.ts`).
  if (args[0] === "health") return await healthCommand(args.slice(1));
  const [verb, registryFile, target, extra, ...rest] = args;
  const usage = () => { process.stderr.write(cliUsage("en") + "\n"); return 2; };
  if (!registryFile || !["check", "status", "metrics", "install", "recover", "relayout", "registry"].includes(verb) || rest.length) return usage();
  // `check`, `status` and `metrics` take the machine as their target, and
  // `recover` takes it after the piece to recover. A machine says which copy
  // of the file to read and which route to the store to take. `registry` takes
  // the machine and, to replace a diverged copy, the full sha256 of the file it
  // discards.
  if (!["install", "recover", "registry"].includes(verb) && extra || verb === "relayout" && target || verb === "recover" && !/^(agent|door|run):[^:]+$/.test(target ?? "")) return usage();
  if (verb === "registry" && (!target || extra !== undefined && !/^[0-9a-f]{64}$/.test(extra))) return usage();
  if (verb === "install" && (target && !["zone", "database", "services", "entry", "--dry"].includes(target) || ["zone", "database", "--dry"].includes(target) && extra || ["services", "entry"].includes(target) && !extra)) return usage();
  try {
    if (verb === "relayout") {
      // Before the load below: the whole point is a file the loader reads and
      // the editor cannot, and the rewrite loads it itself under the lock.
      const { changed } = await relayoutRegistry(registryFile);
      process.stdout.write(operation("en", { operation: "relayout", target: registryFile, result: changed ? "done" : "unchanged" }) + "\n");
      return 0;
    }
    const machines = listMachines(loadRegistry(registryFile));
    const named = verb === "recover" ? extra : verb === "install" ? undefined : target;
    const machine = named ?? (machines.length === 1 ? machines[0].id : undefined);
    if (["check", "status", "registry"].includes(verb) && (!machine || !machines.some(m => m.id === machine))) return usage();
    // A file in which some machine reaches the store by a route of its own
    // has two routes, and a command that opens the store has to be told which
    // one it is on. A file with one route reads as it always did.
    const routesDiffer = machines.some(m => m.store_url !== undefined);
    if (["metrics", "recover"].includes(verb) && routesDiffer && (!machine || !machines.some(m => m.id === machine))) return usage();
    // Read FOR THIS MACHINE: its own state directory, its own secrets and its
    // own route to the store, so a command on a spoke reaches the store the
    // spoke reaches rather than dialling the hub machine's loopback.
    const registry = loadRegistry(registryFile, { machine: machine ?? "" });
    if (verb === "install") {
      if (!target && (machines.length !== 1 || listRunEntries(registry).filter(e => e.kind === "hub").length !== 1)) return usage();
      await runInstall({ registryFile, stage: target === "--dry" ? "database" : target, target: extra, ...(target === "--dry" ? { dry: true } : {}) });
      process.stdout.write(operation("en", { operation: "install", target: extra ?? target ?? "all", result: "done" }) + "\n");
      return 0;
    }
    if (verb === "status") {
      const rows = await readStatus({ registryFile, machine: machine! });
      for (const row of rows) process.stdout.write(status("en", { ...row, pid: row.pid ?? "unknown" }) + "\n");
      return rows.some(row => row.wanted !== row.seen) ? 1 : 0;
    }
    if (verb === "registry") return await registryCopyCommand(registryFile, machine!, registry, extra);
    const store = await openStore({ url: storeUrlFor(registry, "hub_hub") });
    try {
      if (verb === "metrics") process.stdout.write(renderMetrics(await readStampMetrics(store)) + "\n");
      if (verb === "check") {
        const acknowledged: Acknowledged[] = [];
        const findings = await runCheck({ registryFile, machine: machine!, store, os: thisOs(), kernel: await readKernelView(), acknowledged });
        process.stdout.write((findings.length ? findings.map(f => f.says).join("\n") : checkClean("en")) + "\n");
        // What an operator recorded is said after the findings, and never counts as one.
        if (acknowledged.length) process.stdout.write(acknowledged.map(one => one.says).join("\n") + "\n");
        return findings.length ? 1 : 0;
      }
      if (verb === "recover") {
        const [target_kind, target_id] = target.split(":");
        const request = await requestRecovery(store, { id: crypto.randomUUID(), registryFile, source: "cli", actor: "operator", target_kind, target_id });
        process.stdout.write(operation("en", { operation: "recover", target, result: request.status === "applied" ? "done" : request.status === "refused" ? "refused" : "waiting" }) + "\n");
        if (request.status === "refused") return 1;
      }
      return 0;
    } finally { await store.close(); }
  } catch (error) { process.stderr.write(safeValue((error as Error).message) + "\n"); return 1; }
}
/**
 * `registry <registry> <machine> [<sha256>]`: where this machine's copy of the registry stands against what the store machine published, and,
 * given the full digest of the file as it is now, the replacement of a diverged copy. Exit 0 for a current copy (and for a replacement made),
 * 1 for anything else. Nothing is printed that is not a digest, a name or a fixed sentence.
 */
async function registryCopyCommand(registryFile: string, machine: string, registry: Registry, digest: string | undefined): Promise<number> {
  const local = registryDigest(registryFile);
  const reference = storeMachineOf(registry);
  const print = (values: Record<string, unknown>) => process.stdout.write(registryCopy("en", { machine, local: short(local), published: "none", ...values }) + "\n");
  if (reference === null) { print({ verdict: digest === undefined ? "single" : "refused-single-route" }); return digest === undefined ? 0 : 1; }
  if (reference === machine) { print({ verdict: digest === undefined ? "authority" : "refused-store-machine" }); return digest === undefined ? 0 : 1; }
  const store = await openStore({ url: storeUrlFor(registry, "hub_hub") });
  try {
    if (digest === undefined) {
      const standing = await standingOf(store, { registryFile, reference });
      print({ verdict: standing.verdict, local: short(standing.local), ...("published" in standing ? { published: short(standing.published) } : {}) });
      return standing.verdict === "current" ? 0 : 1;
    }
    const said = await overrideRegistryCopy({
      store, registryFile, machine, registry, digest,
      say: async (kind, subject, detail) => { await appendEntry(store, { stream: "machine", subject, kind, actor: "hub", detail }); },
    });
    if (said.result === "replaced") {
      print({ verdict: "replaced", local: short(said.from), published: short(said.to), backup: said.backup });
      return 0;
    }
    print({ verdict: `refused-${said.cause}`, ...(said.local ? { local: short(said.local) } : {}), ...(said.published ? { published: short(said.published) } : {}) });
    return 1;
  } finally { await store.close(); }
}

const short = (digest: string): string => digest.slice(0, 16);

if (import.meta.main) process.exit(await command(process.argv.slice(2)));
