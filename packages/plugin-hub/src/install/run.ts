import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { userInfo } from "node:os";
import { join } from "node:path";
import { loadRegistry, readSetting } from "../registry/load.ts";
import { listMachines, listRunEntries } from "../registry/entries.ts";
import { thisOs } from "../os/index.ts";
import { wantedState } from "../os/diff.ts";
import type { OsSeam } from "../os/types.ts";
import { programForKind, transcriberArgv } from "../hub/program.ts";
import { openStore } from "../store/connect.ts";
import { recordOperationFailure } from "../diagnostics.ts";
import { standardFor } from "./standard.ts";
import { installAccountRole, installDatabaseReady, installPasswordsSet, installPlan, installServicePlan, installSocketRemains, installTrustRemains } from "../door/lines.ts";
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
 * Every hub role gets a password that only the account running the
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

/**
 * The name of the operating system account this install runs under, when it is
 * plain enough to put in a query. A local `peer` rule admits that account as the
 * Postgres role of the same name, so the name is part of what has to be checked.
 */
function accountName(): string | null {
  const name = userInfo().username;
  return /^[A-Za-z_][A-Za-z0-9_.-]*$/.test(name) ? name : null;
}

/**
 * The pg_hba.conf lines that would let one of these roles into this database
 * with no password, by every shape that reaches them.
 *
 * `trust` asks for nothing. `peer` and `ident` ask for the operating system
 * account instead of a secret, which is no secret at all to another process of
 * the same account, and an ident map can point any account at any role. On the
 * database side `samerole` and `sameuser` are keywords that can resolve to this
 * database, and on the role side a `+group` entry admits every member of that
 * group, so a hub role reached through one is reached.
 *
 * `kinds` picks which methods this call is about, because a trust line and a
 * socket line are repaired differently and are reported apart.
 */
function passwordlessLines(ask: Ask, database: string, kinds: string[]): string[] {
  const roles = HUB_ROLES.map((role) => `'${role}'`).join(", ");
  const socket = kinds.includes("peer") || kinds.includes("ident");
  const account = socket ? accountName() : null;
  const named = ["all", ...HUB_ROLES, ...(account ? [account] : [])].map((role) => `'${role}'`).join(", ");
  const methods = kinds.map((kind) => `'${kind}'`).join(", ");
  return ask(database, ["-c", `select line_number from pg_hba_file_rules where error is null ` +
    `and auth_method in (${methods}) ` +
    `and database && array['all', 'samerole', 'sameuser', '${database}']::text[] ` +
    `and (user_name && array[${named}]::text[] or exists (` +
      `select 1 from unnest(user_name) as entry join pg_roles grp on grp.rolname = substr(entry, 2) ` +
      `where entry like '+%' and exists (select 1 from pg_roles member where member.rolname in (${roles}) ` +
      `and pg_has_role(member.oid, grp.oid, 'member')))) ` +
    `order by line_number`])
    .split("\n").filter(Boolean);
}

/** Whether the cluster carries a login role named after this account. */
function accountRole(ask: Ask, database: string): string | null {
  const account = accountName();
  if (account === null) return null;
  return ask(database, ["-c", `select rolname from pg_roles where rolcanlogin and rolname = '${account}'`]).trim() || null;
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
      // The same ordered list `src/store/migrate.ts` carries. A step that lands
      // in one of them and not the other leaves an upgraded box a version
      // behind a fresh one.
      for (const [version, file] of [[1, "001-rollout.sql"], [2, "002-door-health.sql"], [3, "003-control.sql"], [4, "004-voice.sql"]] as const) {
        if (ask(database, ["-c", `select 1 from schema_version where version = ${version}`])) continue;
        ask(database, ["-c", `begin; ${readFileSync(join(import.meta.dir, "../store/migrations", file), "utf8")} insert into schema_version values (${version}); commit;`]);
      }
    }
    const secrets = secretsDirOf(registry);
    if (secrets === null) throw new Error("install-secrets-dir-required");
    const given = givePasswords(ask, feed, secrets);
    if (given.none.length) process.stdout.write(installPasswordsSet("en", { roles: given.none.join(", "), dir: secrets, had: "none" }) + "\n");
    if (given.other.length) process.stdout.write(installPasswordsSet("en", { roles: given.other.join(", "), dir: secrets, had: "other" }) + "\n");
    const trusted = passwordlessLines(ask, database, ["trust"]);
    if (trusted.length) process.stdout.write(installTrustRemains("en", { lines: trusted.join(", ") }) + "\n");
    const overSocket = passwordlessLines(ask, database, ["peer", "ident"]);
    if (overSocket.length) {
      process.stdout.write(installSocketRemains("en", { lines: overSocket.join(", ") }) + "\n");
      // Only beside such a rule, because a role of that name is a way in only
      // while a rule admits the account it is named after.
      const named = accountRole(ask, database);
      if (named) process.stdout.write(installAccountRole("en", { role: named }) + "\n");
    }
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
  const store = await openStore({ url: storeUrlFor(registry, "hub_hub") });
  try {
    // The columns a voice note and a chat read from the store both need, asked
    // for in one probe so a box whose migration did not land says so here,
    // naming the column, rather than on the first voice note somebody sends or
    // the first turn a runner has to serve for a door on another machine.
    await store.sql`select source, log_ready, media_state from inbound limit 0`;
    await store.sql`select route, delivery_state from outbox limit 0`;
    const os = options.os ?? thisOs();
    const rendered = (stage === "entry" ? [target] : selected).map(entry => ({ entry, files: os.render(entry, {
      machine: target.machine, execPath: process.execPath, entryScript: programForKind(entry.kind),
      // The same function the hub's own tick calls, so a unit installed by hand
      // and a unit the hub writes cannot differ.
      argv: entry.kind === "transcriber" ? transcriberArgv(registry, entry) : undefined,
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
