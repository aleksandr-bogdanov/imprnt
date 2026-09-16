// The one step a household runs by hand, once per machine: get Postgres, apply
// the schema, and write down where the store's pid file is.
//
// BUILD-NOTES 9's other half. A household installs Postgres from its own package
// manager, so the hub cannot install it as a side effect of running, and nothing
// in v3 has ever written down how a box gets one. This is that step. It detects
// the OS, installs Postgres the standard way when there is none, creates the
// database the registry names, applies `src/schema.sql` to it, and writes the
// `[store]` section with this OS's standard pid file IF THE FILE DOES NOT
// ALREADY CARRY ONE.
//
// RUN-07: argv is `<registryFile> [--dry]`, it says what it is doing and to
// whom, `--dry` is an action modifier and not a behaviour switch (it says "tell
// me what you would do" about the same work), and nothing here reads the
// environment. RUN-14: it never edits a boot file.
//
// WHICH UNITS IT MAY TOUCH, settled 2026-09-16 (03b-DEBTS item 2's dated note,
// VERIFY-CODEX row 2). It installs no unit OF THE HUB'S, because those are the
// hub's, and it touches no boot file. Starting POSTGRES'S OWN service through
// the package manager is a different thing and is part of the standard install:
// on macOS a freshly installed Postgres is not running until `brew services
// start` loads its job, and on Debian `apt-get install postgresql` creates and
// starts the cluster's unit itself, so refusing the macOS half would only mean
// shipping a script that installs a server the household then has to start by
// hand. What holds instead is that nothing lands silently: the command is
// printed by `--dry` whether or not this run would reach for it, named again on
// the way in, and named a third time in the closing line (REVIEW.md D11).
//
// It is IDEMPOTENT by asking rather than by remembering: a database that already
// carries `ledger_event` is not re-applied (the schema creates tables, and only
// its roles are written to survive a second apply), and a `[store]` section that
// is already there is never edited. A second run changes nothing and says so.
//
// Usage: bun run src/entry/install.ts <registryFile> [--dry]

import { SQL } from "bun";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadRegistry, readSetting } from "../registry/load.ts";

/** What this platform's standard install is, measured on both boxes. */
interface Standard {
  /** The package manager command a person would run, as they would type it. */
  install: string[];
  /**
   * The command that starts Postgres's OWN service after that install, as a
   * person would type it, or null on a platform whose package manager starts
   * the cluster itself. It is one constant, used by `--dry` and by the real
   * run, so the command printed is the command issued.
   */
  service: string[] | null;
  /** The pid file that install writes, absolute. */
  pidFile: string;
  /** What the machine's service manager calls it. Informational. */
  unit: string;
}

const [registryFile, ...rest] = process.argv.slice(2);
const dry = rest.includes("--dry");
const unknown = rest.filter((one) => one !== "--dry");

if (!registryFile || unknown.length > 0) {
  process.stderr.write("usage: bun run src/entry/install.ts <registryFile> [--dry]\n");
  process.exit(2);
}

const say = (line: string) => process.stdout.write(`${line}\n`);

/**
 * Every unit this run asked a service manager to load, so the closing line can
 * name them. It is empty on every path but the one that installs Postgres from
 * scratch on macOS, which is the one place 03b item 2's own approach paragraph
 * asks for a manager verb (REVIEW.md D11).
 */
const loaded: string[] = [];

/**
 * The version of the cluster this box already has, when it has one.
 *
 * Debian numbers its clusters and its pid file by version, so the standard path
 * is not one constant. `pg_lsclusters` prints `Ver Cluster Port Status ...`, and
 * a box with no clusters and no tool falls back to the version this hub was
 * built against, which is what a fresh `apt-get install postgresql` gives.
 */
function debianCluster(): { version: string; cluster: string } {
  try {
    const out = Bun.spawnSync(["pg_lsclusters", "--no-header"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    for (const line of (out.stdout?.toString() ?? "").split("\n")) {
      const columns = line.trim().split(/\s+/);
      if (columns.length >= 2 && /^\d+$/.test(columns[0])) {
        return { version: columns[0], cluster: columns[1] };
      }
    }
  } catch {
    // No `pg_lsclusters` is a box with no Debian Postgres packaging on it yet.
  }
  return { version: "15", cluster: "main" };
}

/**
 * Where Homebrew is on THIS Mac, asked rather than assumed.
 *
 * `/opt/homebrew` is Apple Silicon's prefix and `/usr/local` is Intel's. A
 * script that assumed the first would write a `[store]` section naming a pid
 * file that does not exist on the second, `readStorePid` would return null with
 * a reason, and the household would carry `peak-missing:postgres` forever under
 * a section that looks perfectly correct. So brew is asked, and only a box with
 * no brew falls back to the prefix its architecture ships with.
 */
function brewPrefix(): string {
  try {
    const asked = Bun.spawnSync(["brew", "--prefix"], { stdout: "pipe", stderr: "pipe" });
    const said = (asked.stdout?.toString() ?? "").trim();
    if ((asked.exitCode ?? 1) === 0 && said.startsWith("/")) return said;
  } catch {
    // No brew on this box at all, which the fallback below is for.
  }
  return process.arch === "arm64" ? "/opt/homebrew" : "/usr/local";
}

function standardFor(platform: string): Standard {
  if (platform === "darwin") {
    return {
      install: ["brew", "install", "postgresql@17"],
      service: ["brew", "services", "start", "postgresql@17"],
      pidFile: `${brewPrefix()}/var/postgresql@17/postmaster.pid`,
      unit: "homebrew.mxcl.postgresql@17",
    };
  }
  const { version, cluster } = debianCluster();
  return {
    install: ["sudo", "apt-get", "install", "-y", "postgresql"],
    // Debian's own postinst runs `pg_createcluster` and starts the cluster's
    // unit, so there is no second command here and saying so is the honest
    // answer to "what service would you start".
    service: null,
    pidFile: `/var/run/postgresql/${version}-${cluster}.pid`,
    unit: `postgresql@${version}-${cluster}.service`,
  };
}

/** The same server, with the database swapped for the maintenance one. */
function maintenanceUrl(storeUrl: string): string {
  const url = new URL(storeUrl);
  url.pathname = "/postgres";
  return url.toString();
}

function databaseOf(storeUrl: string): string {
  return new URL(storeUrl).pathname.replace(/^\//, "");
}

/**
 * Whether a server answers on this url at all.
 *
 * A server that REFUSED THIS ACCOUNT answered: it is running, it heard the
 * connection and it said no. `apt-get install postgresql` would not help
 * somebody whose role or password is wrong, and putting a second copy on a box
 * that already has a working one is the worst thing this script could do, so an
 * authentication failure counts as up and only a connection that finds nothing
 * at the other end counts as absent.
 */
async function answers(url: string): Promise<{ up: boolean; said: string }> {
  const sql = new SQL(url, { max: 1 });
  try {
    await sql.unsafe("select 1");
    return { up: true, said: "" };
  } catch (error) {
    const said = String((error as Error).message);
    const itAnswered =
      /password|authentication|role .* does not exist|database .* does not exist|permission denied/i.test(
        said,
      );
    return { up: itAnswered, said };
  } finally {
    await sql.close().catch(() => {});
  }
}

async function ask<T>(url: string, body: (sql: SQL) => Promise<T>): Promise<T> {
  const sql = new SQL(url, { max: 1 });
  try {
    return await body(sql);
  } finally {
    await sql.close().catch(() => {});
  }
}

/** The `[store]` section as TOML, appended to a file that carries none. */
function storeSection(standard: Standard): string {
  return [
    "",
    "# Written once by `install`: where this box's store writes its pid, so the",
    "# hub can measure it without guessing at a process tree. Edit it freely, and",
    "# nothing will ever edit it back.",
    "[store]",
    `pid_file = ${JSON.stringify(standard.pidFile)}`,
    `unit = ${JSON.stringify(standard.unit)}`,
    "",
  ].join("\n");
}

const registry = loadRegistry(registryFile);
const storeUrl = String(readSetting(registry, "hub.store_url") ?? "");
if (storeUrl === "") {
  process.stderr.write(`${registryFile} sets no hub.store_url, and the store is where it says\n`);
  process.exit(2);
}

const standard = standardFor(process.platform);
const database = databaseOf(storeUrl);
const declaredPid = readSetting(registry, "store.pid_file");
const alreadyDeclared = declaredPid !== undefined && declaredPid !== null && String(declaredPid) !== "";
const schemaFile = join(import.meta.dir, "..", "schema.sql");

say(`install: the store for ${registryFile}`);
say(`install: this is ${process.platform}, so the standard install is ${standard.install.join(" ")}`);
say(`install: the standard pid file here is ${standard.pidFile}, under the unit ${standard.unit}`);

const reached = await answers(maintenanceUrl(storeUrl));
const serverIsUp = reached.up;

if (dry) {
  say("install: DRY RUN. Nothing below is done, and nothing on this box is changed.");
  say(
    serverIsUp
      ? `install: would install nothing, because postgres already answers at ${maintenanceUrl(storeUrl)}`
      : `install: would run ${standard.install.join(" ")}, because no postgres answers at ${maintenanceUrl(storeUrl)}`,
  );
  // THE SERVICE COMMAND, NAMED WHETHER OR NOT THIS RUN WOULD REACH FOR IT. A
  // dry run on a box that already has a server would otherwise never print the
  // one manager verb this script can issue, which is the half a person is
  // entitled to read before they let it run on a box that has none.
  say(
    standard.service === null
      ? `install: would start no service of its own here: ${standard.install.join(" ")} creates and starts ${standard.unit} itself`
      : `install: the service command here is ${standard.service.join(" ")}, and running it loads the job ${standard.unit}`,
  );
  if (standard.service !== null) {
    say(
      serverIsUp
        ? "install: would not run that service command, because postgres already answers"
        : "install: would run that service command as part of the install above",
    );
  }
  say(`install: would create the database ${database} if it is not there`);
  say(`install: would apply ${schemaFile} with psql -v ON_ERROR_STOP=1`);
  say(
    alreadyDeclared
      ? `install: would leave the [store] section of ${registryFile} exactly as it is, because it already names ${String(declaredPid)}`
      : `install: would write a [store] section into ${registryFile} naming ${standard.pidFile}`,
  );
  say("install: dry run over, and this box is as it was.");
  process.exit(0);
}

// --- 1. the server itself, from the household's own package manager ---------
if (!serverIsUp) {
  say(`install: no postgres answers at ${maintenanceUrl(storeUrl)}, so running ${standard.install.join(" ")}`);
  const done = Bun.spawnSync(standard.install, { stdout: "inherit", stderr: "inherit" });
  if ((done.exitCode ?? 1) !== 0) {
    process.stderr.write(
      `install: ${standard.install.join(" ")} exited ${done.exitCode}. Install postgres by hand and run this again.\n`,
    );
    process.exit(1);
  }
  if (standard.service !== null) {
    // THE ONE UNIT THIS SCRIPT LOADS, and it says so. Starting Postgres's own
    // service through the package manager is the standard install (03b-DEBTS
    // item 2's dated note); what the script never touches is a unit of the
    // HUB's or a boot file. The command is the same constant `--dry` printed,
    // so what a person read is what runs, and the job is named on the way in
    // and again in the closing line (REVIEW.md D11).
    say(`install: running ${standard.service.join(" ")}, which loads the job ${standard.unit}`);
    Bun.spawnSync(standard.service, { stdout: "inherit", stderr: "inherit" });
    loaded.push(standard.unit);
  }
  if (!(await answers(maintenanceUrl(storeUrl))).up) {
    process.stderr.write(
      `install: postgres was installed and still does not answer at ${maintenanceUrl(storeUrl)}\n`,
    );
    process.exit(1);
  }
} else {
  say(
    reached.said === ""
      ? `install: postgres already answers at ${maintenanceUrl(storeUrl)}, so nothing is installed`
      : `install: postgres answers at ${maintenanceUrl(storeUrl)} and refused this account, so nothing is installed: ${reached.said}`,
  );
}

// --- 2. the database the registry names -------------------------------------
const hadDatabase = await ask(maintenanceUrl(storeUrl), async (sql) => {
  const rows = (await sql.unsafe("select 1 from pg_database where datname = $1", [
    database,
  ])) as unknown[];
  if (rows.length > 0) return true;
  // The name comes from the registry and goes into a statement that takes no
  // parameter, so it is checked rather than escaped: a database name is a word.
  if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(database)) {
    process.stderr.write(`install: ${database} is not a database name this will create\n`);
    process.exit(2);
  }
  await sql.unsafe(`create database "${database}"`);
  return false;
});
say(
  hadDatabase
    ? `install: the database ${database} is already there`
    : `install: created the database ${database}`,
);

// --- 3. the schema, applied only to a database that has not had it ----------
const hadSchema = await ask(storeUrl, async (sql) => {
  const rows = (await sql.unsafe(
    "select 1 from information_schema.tables where table_schema = 'public' and table_name = 'ledger_event'",
  )) as unknown[];
  return rows.length > 0;
});
if (hadSchema) {
  say(`install: ${database} already carries the schema, so nothing was applied`);
} else {
  const applied = Bun.spawnSync(
    ["psql", "-v", "ON_ERROR_STOP=1", "-q", "-X", "-f", schemaFile, storeUrl],
    { stdout: "inherit", stderr: "inherit" },
  );
  if ((applied.exitCode ?? 1) !== 0) {
    process.stderr.write(`install: psql exited ${applied.exitCode} applying ${schemaFile}\n`);
    process.exit(1);
  }
  say(`install: applied ${schemaFile} to ${database}`);
}

// --- 4. the [store] section, written ONCE -----------------------------------
// A value a household put there is never edited. That is the rule that makes the
// section safe to write at all: a box whose cluster lives somewhere else says so
// once and this leaves it alone forever.
const text = readFileSync(registryFile, "utf8");
if (alreadyDeclared || /^\s*\[\s*store\s*\]/m.test(text)) {
  say(`install: ${registryFile} already declares its [store], and it is unchanged`);
} else {
  writeFileSync(registryFile, `${text.replace(/\s*$/, "\n")}${storeSection(standard)}`, "utf8");
  say(`install: wrote the [store] section of ${registryFile}, naming ${standard.pidFile}`);
}

say(
  loaded.length === 0
    ? "install: done, and this run loaded no unit."
    : `install: done. This run loaded ${loaded.join(", ")}, and nothing else on this box was touched.`,
);
