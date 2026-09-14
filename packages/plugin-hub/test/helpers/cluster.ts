// Test infrastructure: a throwaway Postgres cluster.
//
// Every check in phase 1 runs against a real Postgres. Nothing here mocks the
// database. The helper does initdb into a temporary directory, starts the
// server on a free loopback port with its own unix socket directory, hands out
// fresh databases with src/schema.sql applied, then stops the server and
// deletes the directory.
//
// Binary resolution: every one of initdb, pg_ctl, psql and postgres comes from
// ONE directory. Mixing an initdb from one major version with a server from
// another gives "database files are incompatible with server", which is a
// broken helper and not a red test. On this Mac the directory is Homebrew's
// postgresql@17. On the Pi it is whatever directory on PATH holds all four.

import { SQL } from "bun";
import { mkdtemp, rm, readFile, appendFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

const NEEDED = ["initdb", "pg_ctl", "psql", "postgres"] as const;

const CANDIDATE_PREFIXES = [
  "/opt/homebrew/opt/postgresql@17/bin",
  "/opt/homebrew/opt/postgresql@16/bin",
  "/usr/lib/postgresql/17/bin",
  "/usr/lib/postgresql/16/bin",
  "/usr/lib/postgresql/15/bin",
  "/usr/local/opt/postgresql@17/bin",
];

let cachedPrefix: string | null = null;

/** The one directory every Postgres binary is resolved from. */
export function pgPrefix(): string {
  if (cachedPrefix) return cachedPrefix;

  for (const dir of CANDIDATE_PREFIXES) {
    if (NEEDED.every((b) => existsSync(join(dir, b)))) {
      cachedPrefix = dir;
      return dir;
    }
  }

  // Fall back to PATH, but only to a directory that holds all four.
  const path = process.env.PATH ?? "";
  for (const dir of path.split(":")) {
    if (!dir) continue;
    if (NEEDED.every((b) => existsSync(join(dir, b)))) {
      cachedPrefix = dir;
      return dir;
    }
  }

  throw new Error(
    "no single directory holds initdb, pg_ctl, psql and postgres. Looked in " +
      CANDIDATE_PREFIXES.join(", ") +
      " and every PATH entry. Install Postgres 15 or newer.",
  );
}

export function pgBin(name: (typeof NEEDED)[number]): string {
  return join(pgPrefix(), name);
}

export interface Cluster {
  /** Data directory, deleted on stop. */
  dataDir: string;
  /** The server's own log file. With `log_statement = 'all'` this is how a
   *  check counts what the server was actually asked to do, which is the only
   *  way to tell a notification apart from a poll without a client-side claim. */
  logFile: string;
  /** Unix socket directory the server also listens on. */
  socketDir: string;
  /** Loopback TCP port the server listens on. */
  port: number;
  /** The superuser this cluster was initialised with. */
  superuser: string;
  /** postgres:// URL for a database in this cluster, superuser. */
  url(database: string): string;
  /** A Bun SQL client for a database in this cluster, as the superuser. */
  connect(database: string): SQL;
  /** A Bun SQL client for a database in this cluster, as a named role. */
  connectAs(role: string, database: string): SQL;
  /** Create a new empty database and return its name. */
  createDatabase(): Promise<string>;
  /** Run a .sql file against a database with psql. Throws on a psql error. */
  runSqlFile(database: string, file: string): Promise<void>;
  /** Stop the server and delete the data directory. */
  stop(): Promise<void>;
}

async function run(
  bin: string,
  args: string[],
  env?: Record<string, string>,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([bin, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...(env ?? {}) },
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  return { code, stdout, stderr };
}

async function freePort(): Promise<number> {
  const server = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: { data() {} },
  });
  const port = server.port;
  server.stop(true);
  return port;
}

let counter = 0;

export interface StartOptions {
  /**
   * postgresql.conf settings appended after initdb, before start. The
   * durability checks use this to build a cluster that says ok before the row
   * is on disk, which the store must refuse.
   */
  settings?: Record<string, string>;
}

/** initdb, start, and hand back a live throwaway cluster. */
export async function startCluster(options: StartOptions = {}): Promise<Cluster> {
  const superuser = "hub_super";
  const root = await mkdtemp(join(tmpdir(), "hub-pg-"));
  const dataDir = join(root, "data");
  const socketDir = join(root, "sock");
  await Bun.write(join(socketDir, ".keep"), "");
  const logFile = join(root, "server.log");

  const init = await run(pgBin("initdb"), [
    "-D",
    dataDir,
    "-U",
    superuser,
    "--auth=trust",
    "--encoding=UTF8",
    "--no-sync",
  ]);
  if (init.code !== 0) {
    await rm(root, { recursive: true, force: true });
    throw new Error(
      `initdb failed (prefix ${pgPrefix()}): ${init.stderr || init.stdout}`,
    );
  }

  const port = await freePort();

  const conf: string[] = [
    "",
    "# appended by test/helpers/cluster.ts",
    "listen_addresses = '127.0.0.1'",
    `port = ${port}`,
    `unix_socket_directories = '${socketDir.replace(/'/g, "''")}'`,
    "fsync = on",
    "synchronous_commit = on",
    "full_page_writes = on",
    "max_connections = 40",
    "shared_buffers = 16MB",
    "log_min_messages = warning",
  ];
  for (const [key, value] of Object.entries(options.settings ?? {})) {
    conf.push(`${key} = ${value}`);
  }
  await appendFile(join(dataDir, "postgresql.conf"), conf.join("\n") + "\n");

  const start = await run(pgBin("pg_ctl"), [
    "-D",
    dataDir,
    "-l",
    logFile,
    "-w",
    "-t",
    "30",
    "start",
  ]);
  if (start.code !== 0) {
    let log = "";
    try {
      log = await readFile(logFile, "utf8");
    } catch {
      // the log may not exist if the server never started
    }
    await rm(root, { recursive: true, force: true });
    throw new Error(
      `pg_ctl start failed (prefix ${pgPrefix()}): ${start.stderr || start.stdout}\n${log}`,
    );
  }

  const url = (database: string) =>
    `postgres://${superuser}@127.0.0.1:${port}/${database}`;

  const open: SQL[] = [];
  const track = (client: SQL) => {
    open.push(client);
    return client;
  };

  const cluster: Cluster = {
    dataDir,
    logFile,
    socketDir,
    port,
    superuser,
    url,
    connect: (database) => track(new SQL(url(database), { max: 1 })),
    connectAs: (role, database) =>
      track(
        new SQL(`postgres://${role}@127.0.0.1:${port}/${database}`, { max: 1 }),
      ),
    async createDatabase() {
      const name = `hub_t${Date.now().toString(36)}_${counter++}`;
      const admin = new SQL(url("postgres"), { max: 1 });
      try {
        await admin.unsafe(`CREATE DATABASE ${name}`);
      } finally {
        await admin.close();
      }
      return name;
    },
    async runSqlFile(database, file) {
      if (!existsSync(file)) {
        throw new Error(`schema file not found: ${file}`);
      }
      const res = await run(pgBin("psql"), [
        "-v",
        "ON_ERROR_STOP=1",
        "-q",
        "-X",
        "-f",
        file,
        url(database),
      ]);
      if (res.code !== 0) {
        throw new Error(`psql failed on ${file}: ${res.stderr || res.stdout}`);
      }
    },
    async stop() {
      for (const client of open) {
        try {
          await client.close();
        } catch {
          // a client may already be closed or broken, that is fine on teardown
        }
      }
      await run(pgBin("pg_ctl"), ["-D", dataDir, "-m", "immediate", "-w", "stop"]);
      await rm(root, { recursive: true, force: true });
    },
  };

  return cluster;
}

/** Absolute path to a file inside plugins/hub, resolved from this helper. */
export function hubPath(relative: string): string {
  return join(dirname(dirname(import.meta.dir)), relative);
}

/** The schema file the build tasks must create. Applied by every schema test. */
export const SCHEMA_SQL = hubPath("src/schema.sql");

/**
 * A fresh database in the cluster with src/schema.sql applied.
 *
 * Before the build tasks run, src/schema.sql does not exist and this throws
 * "schema file not found", which is the red reason `schema missing`.
 */
export async function freshDatabase(cluster: Cluster): Promise<string> {
  const database = await cluster.createDatabase();
  await cluster.runSqlFile(database, SCHEMA_SQL);
  return database;
}

/**
 * Import a module from src/ by its path inside plugins/hub, and fail loudly
 * when it is missing.
 *
 * Every check imports its seam this way, inside the test body rather than at
 * the top of the file, so a missing module fails ONE test with a readable
 * reason instead of killing the whole file. The caller then asserts the named
 * export is a function, so a file that exists with the wrong export cannot
 * turn the check green.
 */
export async function seam(relative: string): Promise<Record<string, unknown>> {
  const absolute = hubPath(relative);
  if (!existsSync(absolute)) {
    throw new Error(`seam module missing: ${relative} (expected at ${absolute})`);
  }
  return (await import(absolute)) as Record<string, unknown>;
}

/** The backend pid a connection is using. A connection is one backend (max: 1). */
export async function backendPid(conn: {
  unsafe(query: string): Promise<unknown>;
}): Promise<number> {
  const rows = (await conn.unsafe("select pg_backend_pid() as pid")) as {
    pid: number;
  }[];
  return Number(rows[0].pid);
}

/**
 * Count every statement the server was asked to run by a backend that is not
 * the test's own, from the server's own log.
 *
 * This is how a check tells a waiter that sleeps on a notification apart from
 * one that wakes on a timer and looks. Start the cluster with
 * `log_statement: "'all'"` and `log_line_prefix: "'pid=%p '"`, tell the watch
 * which pids belong to the test, and every remaining `statement:` entry in the
 * window was issued by the thing under test.
 *
 * It counts ENTRIES, not lines, and it does not look at the SQL text. The
 * second seat broke the earlier text-matching version three ways: a statement
 * written across two lines put `SELECT id` and `FROM inbound` on different
 * lines and counted zero, a poll of a different table counted zero, and a poll
 * of a signal table counted zero. None of those escape a count of "any
 * statement at all from the waiter's backend".
 *
 * PostgreSQL's text logger keeps the newlines inside a statement and indents
 * the continuation with a tab, so an entry is a line starting with the prefix
 * and every following line that does not.
 *
 * pg_stat_statements is deliberately not used. It needs a preloaded library and
 * a contrib package, which is one more thing to be missing on the Pi.
 */
export async function statementWatch(
  cluster: Cluster,
  ignorePids: number[] = [],
) {
  const readLog = async (): Promise<string> => {
    // A log we cannot read is an observation we did not make. Reading it as an
    // empty log would score a poll as zero statements, which is the opposite of
    // the truth.
    return await readFile(cluster.logFile, "utf8");
  };

  const from = (await readLog()).length;
  const mine = new Set(ignorePids.map(Number));

  const entries = async () => {
    const text = (await readLog()).slice(from);
    const out: { pid: number; text: string }[] = [];
    let current: { pid: number; text: string } | null = null;
    for (const line of text.split("\n")) {
      const head = /^pid=(\d+)\s/.exec(line);
      if (head) {
        if (current) out.push(current);
        current = /\bstatement:/.test(line)
          ? { pid: Number(head[1]), text: line }
          : null;
      } else if (current) {
        current.text += "\n" + line;
      }
    }
    if (current) out.push(current);
    return out.filter((e) => !mine.has(e.pid));
  };

  return {
    /** Statements issued in the window by any backend that is not the test's. */
    async count(): Promise<number> {
      return (await entries()).length;
    },
    /** Those statements, for a failure message. */
    async lines(): Promise<string[]> {
      return (await entries()).map((e) => e.text);
    },
  };
}
