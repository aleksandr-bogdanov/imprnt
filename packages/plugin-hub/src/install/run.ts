import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { loadRegistry, readSetting } from "../registry/load.ts";
import { listAgents, listMachines, listRunEntries } from "../registry/entries.ts";
import { thisOs } from "../os/index.ts";
import { wantedState } from "../os/diff.ts";
import type { OsSeam } from "../os/types.ts";
import { programForKind } from "../hub/program.ts";
import { openStore } from "../store/connect.ts";
import { recordOperationFailure } from "../diagnostics.ts";
import { standardFor } from "./standard.ts";
import { installDatabaseReady, installPasswordsSet, installPlan, installServicePlan, installTrustRemains } from "../door/lines.ts";
import { HUB_ROLES, passwordFileOf, secretsDirOf, storeUrlFor } from "../store/secrets.ts";
import { newPassword, scramMatches, scramVerifier } from "../store/scram.ts";

type Ask = (db: string, args: string[]) => string;

/** A file only the account running this can read, replaced whole or not at all. */
function writeSecret(file: string, text: string): void {
  const temp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}`;
  writeFileSync(temp, `${text}\n`, { mode: 0o600, flag: "wx" });
  chmodSync(temp, 0o600);
  renameSync(temp, file);
}

function readSecret(file: string): string | null {
  try {
    return readFileSync(file, "utf8").trim();
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return null;
    throw error;
  }
}

/**
 * IMP-158. Every hub role gets a password that only the account running the
 * hub can read, so an agent's shell on the same loopback cannot be one.
 *
 * A role whose stored verifier was made from its file's password is left
 * alone, which is what makes a second run a no-op. Any other role, whether an
 * earlier install left it with no password or its file is gone or edited, gets
 * a new one: the file is written first and the role second, so a run that dies
 * between them leaves a mismatch the next run repairs rather than a role whose
 * password nobody has. The server is handed the verifier, never the password,
 * and on psql's standard input, never its argv.
 */
function givePasswords(ask: Ask, feed: (db: string, sql: string) => void, dir: string): { none: string[]; other: string[] } {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const listed = HUB_ROLES.map((role) => `'${role}'`).join(", ");
  const stored = new Map(ask("postgres", ["-c", `select rolname || ' ' || coalesce(rolpassword, '') from pg_authid where rolname in (${listed})`])
    .split("\n").filter(Boolean).map((line) => [line.split(" ")[0], line.split(" ")[1] ?? ""] as const));
  const none: string[] = [];
  const other: string[] = [];
  const statements: string[] = [];
  for (const role of HUB_ROLES) {
    const file = passwordFileOf(dir, role);
    const verifier = stored.get(role) ?? "";
    const kept = readSecret(file);
    if (kept !== null && scramMatches(verifier, kept)) {
      chmodSync(file, 0o600);
      continue;
    }
    const password = newPassword();
    writeSecret(file, password);
    statements.push(`alter role ${role} password '${scramVerifier(password)}';`);
    (verifier === "" ? none : other).push(role);
  }
  if (statements.length) feed("postgres", `begin;\n${statements.join("\n")}\ncommit;\n`);
  return { none, other };
}

/** IMP-158. The pg_hba.conf lines that would let a hub role into this database with no password. */
function trustedLines(ask: Ask, database: string): string[] {
  const roles = ["all", ...HUB_ROLES].map((role) => `'${role}'`).join(", ");
  return ask(database, ["-c", `select line_number from pg_hba_file_rules where error is null and auth_method = 'trust' ` +
    `and database && array['all', '${database}']::text[] and user_name && array[${roles}]::text[] order by line_number`])
    .split("\n").filter(Boolean);
}

export async function runInstall(options: { registryFile: string; stage?: string; target?: string; os?: OsSeam; dry?: boolean }) {
  const registry = loadRegistry(options.registryFile);
  const entries = listRunEntries(registry);
  for (const entry of entries) programForKind(entry.kind);
  const stage = options.stage ?? "all";
  if (!["all", "database", "services", "entry"].includes(stage)) throw new Error("unknown-stage");
  const url = String(readSetting(registry, "hub.store_url"));
  const standard = standardFor(process.platform);
  if (options.dry) {
    const values = { registry: options.registryFile, install: standard.install.join(" "),
      pid: standard.pidFile, unit: standard.unit, service: standard.service?.join(" ") ?? "" };
    process.stdout.write(installPlan("en", values) + "\n" + installServicePlan("en", values) + "\n");
    return { stage, result: "dry" };
  }
  if (stage === "database" || stage === "all") {
    const argv = readSetting(registry, "install.admin_argv") as string[];
    if (!Array.isArray(argv) || !argv.length) throw new Error("install-admin-required");
    const database = decodeURIComponent(new URL(url).pathname.slice(1));
    if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(database)) throw new Error("invalid-database");
    const ask = (db: string, args: string[]) => {
      const result = Bun.spawnSync([...argv, "-X", "-v", "ON_ERROR_STOP=1", "-At", "-d", db, ...args], { env: process.env, stdout: "pipe", stderr: "pipe" });
      if (result.exitCode !== 0) throw new Error(result.stderr.toString());
      return result.stdout.toString().trim();
    };
    const feed = (db: string, sql: string) => {
      const result = Bun.spawnSync([...argv, "-X", "-v", "ON_ERROR_STOP=1", "-At", "-d", db, "-f", "-"], { env: process.env, stdin: new TextEncoder().encode(sql), stdout: "pipe", stderr: "pipe" });
      if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    };
    if (!ask("postgres", ["-c", `select 1 from pg_database where datname = '${database}'`])) ask("postgres", ["-c", `create database "${database}"`]);
    if (!ask(database, ["-c", "select to_regclass('public.ledger_event')"])) {
      ask(database, ["--single-transaction", "-f", join(import.meta.dir, "../schema.sql")]);
    } else {
      ask(database, ["-c", "create table if not exists schema_version (version integer primary key)"]);
      for (const [version, file] of [[1, "001-rollout.sql"], [2, "002-door-health.sql"], [3, "003-control.sql"]] as const) {
        if (ask(database, ["-c", `select 1 from schema_version where version = ${version}`])) continue;
        ask(database, ["-c", `begin; ${readFileSync(join(import.meta.dir, "../store/migrations", file), "utf8")} insert into schema_version values (${version}); commit;`]);
      }
    }
    const secrets = secretsDirOf(registry);
    if (secrets === null) throw new Error("install-secrets-dir-required");
    const given = givePasswords(ask, feed, secrets);
    if (given.none.length) process.stdout.write(installPasswordsSet("en", { roles: given.none.join(", "), dir: secrets, had: "none" }) + "\n");
    if (given.other.length) process.stdout.write(installPasswordsSet("en", { roles: given.other.join(", "), dir: secrets, had: "other" }) + "\n");
    const trusted = trustedLines(ask, database);
    if (trusted.length) process.stdout.write(installTrustRemains("en", { lines: trusted.join(", ") }) + "\n");
    const text = readFileSync(options.registryFile, "utf8");
    // Decided by what the registry declares, not by how it is spelled: a converted
    // registry writes its store table inline, and a second header would break the file.
    if (registry.data.store === undefined) {
      const data = ask(database, ["-c", "show data_directory"]);
      const external = ask(database, ["-c", "show external_pid_file"]);
      writeFileSync(options.registryFile, `${text.trimEnd()}\n\n[store]\npid_file = ${JSON.stringify(external || join(data, "postmaster.pid"))}\nunit = ${JSON.stringify(standard.unit)}\n`);
    }
    process.stdout.write(installDatabaseReady("en") + "\n");
    if (stage === "database") return { stage, result: "done" };
  }
  const machines = listMachines(registry);
  const target = options.target ? entries.find(e => e.id === options.target) : entries.find(e => e.kind === "hub");
  if (!target || (!options.target && machines.length !== 1)) throw new Error("machine-target-required");
  if (stage !== "entry" && target.kind !== "hub") throw new Error("hub-target-required");
  const selected = entries.filter(e => e.machine === target.machine);
  const hubs = selected.filter(e => e.kind === "hub" && wantedState(e) === "running");
  if (hubs.length !== 1) throw new Error("one-resident-hub-required");
  for (const agent of listAgents(registry)) {
    if (entries.find(e => e.id === agent.runner)?.machine !== entries.find(e => e.id === agent.door)?.machine) throw new Error("agent-state-unavailable");
  }
  const store = await openStore({ url: storeUrlFor(registry, "hub_hub") });
  try {
    await store.sql`select source, log_ready from inbound limit 0`;
    await store.sql`select route, delivery_state from outbox limit 0`;
    const os = options.os ?? thisOs();
    const rendered = (stage === "entry" ? [target] : selected).map(entry => ({ entry, files: os.render(entry, {
      machine: target.machine, execPath: process.execPath, entryScript: programForKind(entry.kind),
      registryFile: options.registryFile, stateDir: String(readSetting(registry, "hub.state_dir")),
      restartDelaySeconds: Number(readSetting(registry, "hub.restart_delay_seconds") ?? 1),
      giveUpAfter: Number(readSetting(registry, "hub.give_up_after") ?? 5),
      giveUpWindowSeconds: Number(readSetting(registry, "hub.give_up_window_seconds") ?? 300),
    }) }));
    for (const { entry, files } of rendered) {
      let operation = "install";
      try {
        await os.install(files);
        if (wantedState(entry) === "running") { operation = "start"; await os.start(entry.id); }
      } catch (error) { await recordOperationFailure(store, { operation, target: entry.id, error }); throw error; }
    }
    return { stage, result: "done" };
  } finally { await store.close(); }
}
