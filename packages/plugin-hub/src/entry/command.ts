import { loadRegistry } from "../registry/load.ts";
import { listMachines, listRunEntries } from "../registry/entries.ts";
import { openStore } from "../store/connect.ts";
import { storeUrlFor } from "../store/secrets.ts";
import { runCheck } from "../check/run.ts";
import { readKernelView } from "../check/kernel.ts";
import { thisOs } from "../os/index.ts";
import { readStatus } from "../hub/status.ts";
import { runInstall } from "../install/run.ts";
import { requestRecovery } from "../hub/control.ts";
import { readStampMetrics, renderMetrics } from "../metrics/stamps.ts";
import { checkClean, cliUsage, operation, safeValue, status } from "../door/lines.ts";

export async function command(args: string[]): Promise<number> {
  const [verb, registryFile, target, extra, ...rest] = args;
  const usage = () => { process.stderr.write(cliUsage("en") + "\n"); return 2; };
  if (!registryFile || !["check", "status", "metrics", "install", "recover"].includes(verb) || rest.length) return usage();
  if (verb !== "install" && extra || verb === "metrics" && target || verb === "recover" && !/^(agent|door):[^:]+$/.test(target ?? "")) return usage();
  if (verb === "install" && (target && !["database", "services", "entry", "--dry"].includes(target) || ["database", "--dry"].includes(target) && extra || ["services", "entry"].includes(target) && !extra)) return usage();
  try {
    const registry = loadRegistry(registryFile);
    const machines = listMachines(registry);
    const machine = target ?? (machines.length === 1 ? machines[0].id : undefined);
    if (["check", "status"].includes(verb) && (!machine || !machines.some(m => m.id === machine))) return usage();
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
    const store = await openStore({ url: storeUrlFor(registry, "hub_hub") });
    try {
      if (verb === "metrics") process.stdout.write(renderMetrics(await readStampMetrics(store)) + "\n");
      if (verb === "check") {
        const findings = await runCheck({ registryFile, machine: machine!, store, os: thisOs(), kernel: await readKernelView() });
        process.stdout.write((findings.length ? findings.map(f => f.says).join("\n") : checkClean("en")) + "\n");
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
if (import.meta.main) process.exit(await command(process.argv.slice(2)));
