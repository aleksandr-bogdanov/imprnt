import { existsSync, readFileSync } from "node:fs";
import { agentsFor, listCredentials, listMachines, listPeople, listRunEntries, personOf } from "../registry/entries.ts";
import { loadRegistry, readSetting, RegistryRefused } from "../registry/load.ts";
import { wantedState } from "../os/diff.ts";
import { secretsDirOf } from "../store/secrets.ts";

/**
 * What one spoke machine is asked to run, read off the registry copy on that
 * machine before anything is installed there. The Windows setup (a WSL distro
 * of its own, `docs/windows-executor.md`) runs it first and stops on any
 * problem it names, so a copy that does not describe the machine is said in
 * words rather than found by a unit that will not start.
 *
 * It reads the file and the file system's metadata and nothing else: no store,
 * no credential's contents, no unit. Its answer carries paths and ids, never a
 * secret.
 *
 * A spoke set up this way runs a runner, its hub and optionally a sync, and
 * nothing that listens or speaks to a chat platform: a door on a second
 * machine is a second connection for the same bot token, which the platform
 * answers by dropping one of them, and a board or a recognizer is a listener
 * this setup does not open. Each is refused by name here.
 */
export interface SpokePlan {
  machine: string;
  os: string | null;
  state_dir: string | null;
  secrets_dir: string | null;
  store: { host: string; port: number } | null;
  store_machine: string | null;
  /** Where the store machine keeps the role passwords this machine needs a copy of. */
  store_secrets_dir: string | null;
  runners: string[];
  hub: string | null;
  entries: { id: string; kind: string; wanted: string }[];
  /** Every `claude-login` credential placed on this machine with `on.<machine>.file`. */
  logins: { credential: string; file: string; present: boolean }[];
  agents: { id: string; runner: string; person: string; tree: string; tree_present: boolean }[];
  problems: string[];
}

/** The kinds a spoke set up by the Windows setup may run. */
export const SPOKE_KINDS = ["runner", "hub", "sync"];

export function spokePlan(registryFile: string, machine: string, exists: (path: string) => boolean = existsSync): SpokePlan {
  const plan: SpokePlan = {
    machine, os: null, state_dir: null, secrets_dir: null, store: null, store_machine: null, store_secrets_dir: null,
    runners: [], hub: null, entries: [], logins: [], agents: [], problems: [],
  };
  let registry: unknown;
  try {
    const written = loadRegistry(registryFile);
    const declared = listMachines(written).find(one => one.id === machine);
    if (!declared) {
      plan.problems.push(`no [[machines]] entry has id ${JSON.stringify(machine)}: add it on the store machine's registry, then copy the file here again`);
      return plan;
    }
    plan.os = declared.os;
    registry = loadRegistry(registryFile, { machine });
  } catch (error) {
    plan.problems.push(error instanceof RegistryRefused ? `the registry is refused: ${error.message}` : `the registry cannot be read: ${(error as Error).message}`);
    return plan;
  }
  const own = listMachines(registry).find(one => one.id === machine)!;
  if (plan.os !== "linux") plan.problems.push(`${machine} is os = ${JSON.stringify(plan.os)}, and a WSL distro is os = "linux"`);
  plan.state_dir = typeof readSetting(registry, "hub.state_dir") === "string" ? String(readSetting(registry, "hub.state_dir")) : null;
  plan.secrets_dir = secretsDirOf(registry);
  const storeMachine = readSetting(registry, "hub.store_machine");
  plan.store_machine = typeof storeMachine === "string" && storeMachine !== "" ? storeMachine : null;
  if (plan.store_machine !== null && listMachines(registry).some(one => one.id === plan.store_machine)) {
    plan.store_secrets_dir = secretsDirOf(loadRegistry(registryFile, { machine: plan.store_machine }));
  }
  if (own.state_dir === undefined) plan.problems.push(`${machine} has no state_dir of its own, so it would use the store machine's`);
  if (own.store_url === undefined) {
    plan.problems.push(`${machine} has no store_url of its own: name the store machine's tailnet address, postgres://<address>:5432/hub`);
  } else {
    const url = new URL(own.store_url);
    plan.store = { host: url.hostname, port: url.port === "" ? 5432 : Number(url.port) };
    if (["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname)) {
      plan.problems.push(`${machine} reaches the store at ${url.hostname}, which is this PC itself and not the store machine`);
    }
  }
  if (plan.store_machine === null) plan.problems.push(`[hub] has no store_machine, so no machine's copy of the registry is the one this copy is compared with`);
  else if (plan.store_machine === machine) plan.problems.push(`${machine} is the store_machine, and this setup is for a spoke`);

  const entries = listRunEntries(registry).filter(entry => entry.machine === machine);
  plan.entries = entries.map(entry => ({ id: entry.id, kind: entry.kind, wanted: wantedState(entry) }));
  for (const entry of entries.filter(one => !SPOKE_KINDS.includes(one.kind))) {
    plan.problems.push(entry.kind === "door"
      ? `${entry.id} is a door on ${machine}: a door is one connection per bot token and stays on the store machine`
      : `${entry.id} is a ${entry.kind} on ${machine}, and this setup runs ${SPOKE_KINDS.join(", ")} only, nothing that listens`);
  }
  plan.runners = entries.filter(entry => entry.kind === "runner").map(entry => entry.id);
  if (plan.runners.length !== 1) plan.problems.push(`${machine} has ${plan.runners.length} runner entries, and a machine runs one`);
  const hubs = entries.filter(entry => entry.kind === "hub" && wantedState(entry) === "running");
  plan.hub = hubs.length === 1 ? hubs[0].id : null;
  if (hubs.length !== 1) plan.problems.push(`${machine} has ${hubs.length} resident hub entries, and the install needs exactly one`);

  // Which credentials were placed here on purpose is the file's own word, not
  // the loader's answer: a credential with no `on.<machine>` loads with the
  // store machine's path, which is not a file on this PC.
  const raw = Bun.TOML.parse(readFileSync(registryFile, "utf8")) as { credentials?: Record<string, unknown>[] };
  const placedHere = new Set((raw.credentials ?? [])
    .filter(one => typeof (one.on as Record<string, { file?: unknown }> | undefined)?.[machine]?.file === "string")
    .map(one => String(one.id)));
  plan.logins = listCredentials(registry)
    .filter(one => one.kind === "claude-login" && placedHere.has(one.id))
    .map(one => ({ credential: one.id, file: one.file, present: exists(one.file) }));
  if (plan.logins.length === 0) {
    plan.problems.push(`no claude-login credential is placed on ${machine}: add on = { "${machine}" = { file = "${plan.state_dir ?? "<state_dir>"}/login/.credentials.json" } } to the runner's login credential`);
  }
  for (const login of plan.logins) {
    if (!login.file.endsWith("/.credentials.json")) plan.problems.push(`${login.credential} on ${machine} is ${login.file}, and a runner login file is named .credentials.json`);
  }

  const people = new Map(listPeople(registry).map(one => [one.id, one]));
  for (const runner of plan.runners) {
    for (const agent of agentsFor(registry, { runner })) {
      const tree = personOf(registry, agent.id)?.tree ?? people.get(agent.person)?.tree ?? "";
      plan.agents.push({ id: agent.id, runner, person: agent.person, tree, tree_present: tree !== "" && exists(tree) });
    }
  }
  return plan;
}

if (import.meta.main) {
  const [registryFile, machine, ...rest] = process.argv.slice(2);
  if (!registryFile || !machine || rest.length) {
    process.stderr.write("usage: bun src/install/spoke.ts <registry> <machine>\n");
    process.exit(2);
  }
  const plan = spokePlan(registryFile, machine);
  process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
  process.exit(plan.problems.length === 0 ? 0 : 1);
}
