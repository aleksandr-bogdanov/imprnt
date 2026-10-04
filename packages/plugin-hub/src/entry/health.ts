import { userInfo } from "node:os";
import { operation, safeValue } from "../door/lines.ts";
import { listAgents, listMachines } from "../registry/entries.ts";
import { loadRegistry } from "../registry/load.ts";
import { openStore, type StoreLike } from "../store/connect.ts";
import {
  dismissNotices, previewDismissal, previewRetry, previewStamp, recordedHealthReady, releasedUnfinishedInputs,
  resolveRetry, resolveStamp, retryAgents, standingResolution, stuckNoticeBatches, type HealthAnswer, type Operator,
} from "../store/health.ts";
import { storeUrlFor } from "../store/secrets.ts";

const USAGE = [
  "usage: imprnt hub health <registry> inspect [<target>] [--machine <id>]",
  "       imprnt hub health <registry> resolve <target> --reason <why> [--machine <id>] <evidence>",
  "  outbox:<id>[,<id>...]  --digest <sha256>                                   dismiss whole notice batches, kept undelivered",
  "  agent:<id>             --fingerprint <sha256> --incarnation <id>           an agent's retry recorded by an earlier runner process",
  "  input:<id>             --attempt <id> --revision <n> --fingerprint <sha256>  an input's missing stamps after a released hold",
].join("\n") + "\n";

type Target = { kind: "outbox"; ids: number[] } | { kind: "agent"; id: string } | { kind: "input"; id: string };

/** What each record must name back, beside the reason. */
const EVIDENCE: Record<Target["kind"], string[]> = {
  outbox: ["--digest"],
  agent: ["--fingerprint", "--incarnation"],
  input: ["--attempt", "--revision", "--fingerprint"],
};
const FLAGS = new Set(["--machine", "--reason", "--digest", "--fingerprint", "--incarnation", "--attempt", "--revision"]);
const SHA256 = /^[0-9a-f]{64}$/;

function parseTarget(text: string): Target | null {
  const cut = text.indexOf(":");
  if (cut <= 0 || cut === text.length - 1) return null;
  const kind = text.slice(0, cut);
  const id = text.slice(cut + 1);
  if (kind === "outbox") {
    const parts = id.split(",");
    return parts.every(part => /^[0-9]{1,15}$/.test(part)) ? { kind, ids: parts.map(Number) } : null;
  }
  return kind === "agent" || kind === "input" ? { kind, id } : null;
}

/**
 * `imprnt hub health <registry> inspect|resolve ...`
 *
 * THE OPERATOR'S ONE WAY TO RECORD THAT A HEALTH FINDING IS HISTORY, and to see
 * first what the record would rest on. `inspect` changes nothing: alone it lists
 * every notice batch stuck behind a failed part, every agent whose health is a
 * retry and every input still waiting for a stamp after its owner released its
 * hold, each with the store's verdict and the digest or fingerprint a record
 * must name; with a target it prints that one preview whole. `resolve` names the
 * same evidence back with a reason, and the store refuses it, under the locks
 * the work it races with takes, once any of it moved.
 *
 * Nothing it does sends, retries, deletes, replays or stamps anything, and it
 * writes no chat event: the record is the operator's, on the hub role, from the
 * account that ran it. Exit 0 for a record made, already standing or no longer
 * needed, 1 for a refusal, 2 for a command it could not read.
 */
export async function healthCommand(args: string[]): Promise<number> {
  const out = (line: string): void => { process.stdout.write(`${line}\n`); };
  const usage = (): number => { process.stderr.write(USAGE); return 2; };
  const [registryFile, verb, ...rest] = args;
  if (!registryFile || (verb !== "inspect" && verb !== "resolve")) return usage();
  let named: string | undefined;
  const flags = new Map<string, string>();
  for (let at = 0; at < rest.length; at++) {
    const word = rest[at];
    if (!word.startsWith("--")) {
      if (named !== undefined) return usage();
      named = word;
      continue;
    }
    const value = rest[at + 1];
    if (!FLAGS.has(word) || flags.has(word) || value === undefined || value === "") return usage();
    flags.set(word, value);
    at++;
  }
  const target = named === undefined ? null : parseTarget(named);
  if (named !== undefined && target === null) return usage();
  if (verb === "inspect" && [...flags.keys()].some(flag => flag !== "--machine")) return usage();
  if (verb === "resolve") {
    if (target === null || !flags.get("--reason")?.trim()) return usage();
    const allowed = new Set(["--machine", "--reason", ...EVIDENCE[target.kind]]);
    if ([...flags.keys()].some(flag => !allowed.has(flag)) || EVIDENCE[target.kind].some(flag => !flags.has(flag))) return usage();
    for (const flag of ["--digest", "--fingerprint"]) if (flags.has(flag) && !SHA256.test(flags.get(flag)!)) return usage();
    if (flags.has("--revision") && !/^[1-9][0-9]{0,8}$/.test(flags.get("--revision")!)) return usage();
  }
  try {
    const machines = listMachines(loadRegistry(registryFile));
    const machine = flags.get("--machine") ?? (machines.length === 1 ? machines[0].id : undefined);
    if (machine !== undefined && !machines.some(one => one.id === machine)) return usage();
    // Like `recover`: a household with a second route to the store has to be told which one this is.
    if (machines.some(one => one.store_url !== undefined) && machine === undefined) return usage();
    const registry = loadRegistry(registryFile, { machine: machine ?? "" });
    const runnerOf = (agent: string): string | undefined => listAgents(registry).find(one => one.id === agent)?.runner;
    const store = await openStore({ url: storeUrlFor(registry, "hub_hub") });
    try {
      if (!(await recordedHealthReady(store))) {
        process.stderr.write("health held: this store is before migration 22: run the install step's database stage first\n");
        return 1;
      }
      if (verb === "inspect") {
        if (target === null) await overview(store, runnerOf, out);
        else {
          const preview = await previewOf(store, target, runnerOf);
          if (preview === null) { out(`${named}: no agent of that id in this registry`); return 1; }
          out(JSON.stringify(preview, null, 2));
          const record = target.kind === "outbox" ? null : await standingResolution(store, target.kind === "agent" ? "retry" : "stamp", target.id);
          if (record) out(`resolved ${record.at.toISOString()} by ${safeValue(record.detail.by)}: ${safeValue(record.detail.reason)}`);
        }
        return 0;
      }
      if (target === null) return usage();
      const who = operatorOf(machine);
      const reason = flags.get("--reason")!;
      let answer: HealthAnswer;
      if (target.kind === "outbox") {
        answer = await dismissNotices(store, target.ids, flags.get("--digest")!, reason, who);
      } else if (target.kind === "agent") {
        const runner = runnerOf(target.id);
        if (runner === undefined) { out(operation("en", { operation: "health resolve", target: named, result: "refused" })); out("cause: unknown-agent"); return 1; }
        answer = await resolveRetry(store, { agent: target.id, runner, fingerprint: flags.get("--fingerprint")!,
          incarnation: flags.get("--incarnation")!, reason, who });
      } else {
        answer = await resolveStamp(store, { input: target.id, attempt: flags.get("--attempt")!,
          revision: Number(flags.get("--revision")), fingerprint: flags.get("--fingerprint")!, reason, who });
      }
      out(operation("en", { operation: "health resolve", target: named, result: String(answer.result ?? "refused") }));
      if (answer.result === "refused") {
        out(`cause: ${safeValue(answer.cause)}`);
        out(JSON.stringify(answer, null, 2));
        return 1;
      }
      return 0;
    } finally { await store.close(); }
  } catch (error) {
    process.stderr.write(`health failed: ${safeValue((error as Error).message)}\n`);
    return 1;
  }
}

/** The account that ran the command, and the command on its machine: never a chat sender and never an argument. */
function operatorOf(machine: string | undefined): Operator {
  let account = "";
  try { account = userInfo().username; } catch { account = process.env.USER ?? ""; }
  return { by: account === "" ? "" : `operator:${account}`, source: `imprnt hub health${machine === undefined ? "" : ` on ${machine}`}` };
}

async function previewOf(store: StoreLike, target: Target, runnerOf: (agent: string) => string | undefined): Promise<HealthAnswer | null> {
  if (target.kind === "outbox") return await previewDismissal(store, target.ids);
  if (target.kind === "input") return await previewStamp(store, target.id);
  const runner = runnerOf(target.id);
  return runner === undefined ? null : await previewRetry(store, target.id, runner);
}

async function overview(store: StoreLike, runnerOf: (agent: string) => string | undefined, out: (line: string) => void): Promise<void> {
  let said = 0;
  for (const { batch, ids } of await stuckNoticeBatches(store)) {
    said++;
    const plan = await previewDismissal(store, ids);
    out(`notice batch ${safeValue(batch)}: outbox:${ids.join(",")}: ${plan.verdict}, digest ${plan.digest}`);
    for (const row of (plan.rows ?? []) as Record<string, any>[]) {
      out(`  outbox ${row.id}: part ${row.part}, ${row.state}, attempts ${row.attempts}, failure ${safeValue(row.failure?.code ?? "none")}, written ${row.written_at}`);
    }
  }
  for (const agent of await retryAgents(store)) {
    said++;
    const runner = runnerOf(agent);
    if (runner === undefined) { out(`agent ${safeValue(agent)}: retry recorded for an agent this registry does not declare: not resolvable here`); continue; }
    const plan = await previewRetry(store, agent, runner);
    const health = (plan.health ?? {}) as Record<string, unknown>;
    const record = await standingResolution(store, "retry", agent);
    out(`agent ${safeValue(agent)}: retry (${safeValue(health.cause)}) recorded ${plan.recorded_at} on ${safeValue(runner)} incarnation ${plan.incarnation ?? "none"}: ` +
      `${record ? "resolved" : plan.verdict}, fingerprint ${plan.fingerprint}`);
  }
  for (const input of await releasedUnfinishedInputs(store)) {
    said++;
    const plan = await previewStamp(store, input);
    const attempt = (plan.attempt ?? {}) as Record<string, unknown>;
    const hold = (plan.hold ?? {}) as Record<string, unknown>;
    const record = await standingResolution(store, "stamp", input);
    out(`input ${safeValue(input)}: ${safeValue(plan.agent)}, ${plan.state}, missing ${plan.missing}, attempt ${safeValue(attempt.id)} ${attempt.state}, ` +
      `hold ${hold.state} revision ${hold.revision}: ${record ? "resolved" : plan.verdict}, fingerprint ${plan.fingerprint}`);
  }
  if (said === 0) out("health: nothing recorded as stuck");
}
