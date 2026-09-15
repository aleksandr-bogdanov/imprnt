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
import { tmpdir, userInfo } from "node:os";
import { join, dirname } from "node:path";

const NEEDED = ["initdb", "pg_ctl", "psql", "postgres"] as const;

// ---------------------------------------------------------------------------
// 03b item 9. The suite does not cost this Mac a shared memory slot every time
// a run is interrupted.
//
// BUILD-NOTES B.3: `kern.sysv.shmmni` is 32 on this Mac, each throwaway cluster
// holds one System V segment, and a cluster KILLED rather than stopped leaks
// it. About thirty interrupted runs later every `initdb` fails with "could not
// create shared memory segment: No space left on device" and the suite reports
// a setup error that says nothing about the real cause.
//
// Two halves. The first stops every cluster this process started when the
// process leaves by any route, which is what stops the leak happening. The
// second sweeps, before `initdb` and on darwin only, the segments this account
// owns that have nobody attached and whose creator is dead, which is what makes
// a leak that happened anyway survivable. Only the second can be checked from
// inside a test, because a check cannot observe its own death.
//
// Linux clusters use POSIX shared memory for the same job, so there is nothing
// to leak and nothing to sweep there.
// ---------------------------------------------------------------------------

/** Every cluster this process started and has not stopped, by data directory. */
const started = new Set<string>();
let leaveWired = false;

/** A stop that works in an `exit` handler, where nothing may be awaited. */
function stopNow(dataDir: string): void {
  try {
    Bun.spawnSync([pgBin("pg_ctl"), "-D", dataDir, "-m", "immediate", "-w", "-t", "10", "stop"], {
      stdout: "ignore",
      stderr: "ignore",
    });
  } catch {
    // A cluster that is already gone is the outcome this wanted.
  }
}

function wireLeaving(): void {
  if (leaveWired) return;
  leaveWired = true;
  process.on("exit", () => {
    for (const dataDir of started) stopNow(dataDir);
  });
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(signal, () => {
      for (const dataDir of started) stopNow(dataDir);
      started.clear();
      // The default disposition, restored: a handler that swallowed the signal
      // would turn an interrupted run into a hung one.
      //
      // THE LISTENER COMES OFF FIRST, and that one line is the difference
      // between ending an interrupted run and hanging it. MEASURED, `bun -e`,
      // two processes of this exact shape holding one fake started entry: a
      // re-raise with the listener still attached RE-ENTERS the handler, which
      // clears an already empty set and signals itself again, and the process
      // was still alive 5000 ms later having burned 5.45 s of cpu. With this
      // line the same process leaves 28 ms after the SIGINT.
      process.removeAllListeners(signal);
      process.kill(process.pid, signal);
    });
  }
}

interface Segment {
  id: number;
  owner: string;
  attached: number;
  creator: number;
}

/** `ipcs -mo` carries the attach count and `ipcs -mp` the creator, so both. */
function segments(): Segment[] {
  const read = (flag: string): Map<number, string[]> => {
    const out = new Map<number, string[]>();
    try {
      const done = Bun.spawnSync(["ipcs", flag], { stdout: "pipe", stderr: "pipe" });
      for (const line of (done.stdout?.toString() ?? "").split("\n")) {
        const columns = line.trim().split(/\s+/);
        if (columns[0] !== "m" || columns.length < 7) continue;
        const id = Number(columns[1]);
        if (Number.isFinite(id)) out.set(id, columns);
      }
    } catch {
      // No `ipcs` is a box with nothing to sweep.
    }
    return out;
  };
  const attach = read("-mo");
  const creator = read("-mp");
  const found: Segment[] = [];
  for (const [id, columns] of attach) {
    const pair = creator.get(id);
    if (!pair) continue;
    found.push({
      id,
      owner: columns[4] ?? "",
      attached: Number(columns[columns.length - 1]),
      // `-mp` prints CPID then LPID, so the creator is the second from last.
      creator: Number(pair[pair.length - 2]),
    });
  }
  return found;
}

function processGone(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    // EPERM is a live process this account does not own, which is somebody
    // else's segment and is never swept.
    return (error as { code?: string }).code !== "EPERM";
  }
}

/**
 * Remove this account's abandoned segments. Never one with a process attached,
 * never one whose creator is still alive, and never one another account owns.
 */
function sweepAbandonedSegments(): void {
  if (process.platform !== "darwin") return;
  let me = "";
  try {
    me = userInfo().username;
  } catch {
    return;
  }
  for (const segment of segments()) {
    if (segment.owner !== me) continue;
    if (segment.attached !== 0) continue;
    if (!processGone(segment.creator)) continue;
    const done = Bun.spawnSync(["ipcrm", "-m", String(segment.id)], {
      stdout: "pipe",
      stderr: "pipe",
    });
    if ((done.exitCode ?? 1) === 0) {
      process.stderr.write(
        `[cluster] swept abandoned shared memory segment ${segment.id}, whose creator ${segment.creator} is gone\n`,
      );
    }
  }
}

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

  // Before `initdb`, because that is the call that runs out of slots.
  wireLeaving();
  sweepAbandonedSegments();

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

  started.add(dataDir);
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
    started.delete(dataDir);
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
      started.delete(dataDir);
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

// ---------------------------------------------------------------------------
// Phase 2. Staging a kill at an exact point, with no switch in production code.
//
// A `kill -9` has to land while the process under test is inside the statement
// the check is about. A sleep before the kill is a race. Postgres gives a
// deterministic alternative: hold `lock table <t> in access exclusive mode` in
// an open transaction on a reserved superuser connection, and every write to
// that table blocks at that statement until the lock is released. The check
// watches `pg_stat_activity` for the blocked backend of the role under test,
// and only when it sees it does it send the signal.
// ---------------------------------------------------------------------------

export interface HeldLock {
  /** The superuser backend holding the lock, so a watch can ignore it. */
  pid: number;
  release(): Promise<void>;
}

/**
 * Hold an access exclusive lock on one table until `release()`.
 *
 * The transaction stays open on a reserved connection, so nothing else on that
 * client can steal it. Releasing commits the empty transaction and hands the
 * connection back.
 */
export async function lockTable(
  cluster: Cluster,
  database: string,
  table: string,
): Promise<HeldLock> {
  if (!/^[a-z_][a-z0-9_]*$/.test(table)) {
    throw new Error(`${table} is not a table name`);
  }
  const client = cluster.connect(database) as unknown as {
    reserve(): Promise<{
      unsafe(query: string): Promise<unknown>;
      release(): void | Promise<void>;
    }>;
    close(): Promise<void>;
  };
  const held = await client.reserve();
  const pid = await backendPid(held);
  await held.unsafe("begin");
  await held.unsafe(`lock table ${table} in access exclusive mode`);
  return {
    pid,
    async release() {
      try {
        await held.unsafe("commit");
      } catch {
        // the transaction may already be gone if the server was stopped
      }
      await held.release();
      await client.close().catch(() => {});
    },
  };
}

/**
 * The pid of a backend of `role` blocked on a lock on `relation`.
 *
 * Throws on the timeout rather than returning zero, because a check that killed
 * a process which had not reached the point under test would be staging its
 * kill somewhere else and would still look like it passed.
 */
export async function waitForLockWaiter(
  cluster: Cluster,
  database: string,
  options: { role: string; relation: string; timeoutMs: number },
): Promise<number> {
  const conn = cluster.connect(database) as unknown as {
    unsafe(query: string, values?: unknown[]): Promise<unknown>;
    close(): Promise<void>;
  };
  const deadline = Date.now() + options.timeoutMs;
  let seen = "nothing at all";
  try {
    for (;;) {
      const rows = (await conn.unsafe(
        `select a.pid
           from pg_stat_activity a
           join pg_locks l on l.pid = a.pid and not l.granted
          where a.usename = $1
            and a.wait_event_type = 'Lock'
            and l.relation = $2::regclass
          order by a.pid`,
        [options.role, options.relation],
      )) as { pid: number }[];
      if (rows.length > 0) return Number(rows[0].pid);

      if (Date.now() >= deadline) {
        const others = (await conn.unsafe(
          `select pid, usename, wait_event_type, wait_event, left(query, 120) as query
             from pg_stat_activity where backend_type = 'client backend'`,
        )) as Record<string, unknown>[];
        seen = others
          .map(
            (r) =>
              `pid ${r.pid} as ${r.usename} waiting on ${r.wait_event_type}/${r.wait_event}: ${r.query}`,
          )
          .join("\n");
        throw new Error(
          `no ${options.role} backend blocked on a lock on ${options.relation} within ${options.timeoutMs} ms. ` +
            `The kill would have landed somewhere other than the point under test. Backends seen:\n${seen}`,
        );
      }
      await Bun.sleep(50);
    }
  } finally {
    await conn.close().catch(() => {});
  }
}

/**
 * Wait until the server has noticed that these backends are gone.
 *
 * A `kill -9` on a client does not release the locks its backend held: the
 * server only reaps the backend when it notices the closed socket. An assertion
 * made before that reads the dead transaction's world, not the one that
 * survived.
 */
export async function waitForBackendsGone(
  cluster: Cluster,
  database: string,
  pids: number[],
  timeoutMs: number,
): Promise<void> {
  if (pids.length === 0) return;
  const conn = cluster.connect(database) as unknown as {
    unsafe(query: string, values?: unknown[]): Promise<unknown>;
    close(): Promise<void>;
  };
  // The pid list goes into the statement as integers rather than as a bound
  // array: bun's SQL client encodes a bound array as a binary array and the
  // server reads the first element as a dimension count. Every value here came
  // from the server as an integer, so the list is built from Number().
  const list = pids.map((p) => Number(p)).join(", ");
  const deadline = Date.now() + timeoutMs;
  try {
    for (;;) {
      const rows = (await conn.unsafe(
        `select pid from pg_stat_activity where pid in (${list})`,
      )) as { pid: number }[];
      if (rows.length === 0) return;
      if (Date.now() >= deadline) {
        throw new Error(
          `backends ${rows.map((r) => r.pid).join(", ")} were still registered ${timeoutMs} ms after the kill`,
        );
      }
      await Bun.sleep(50);
    }
  } finally {
    await conn.close().catch(() => {});
  }
}

/**
 * Every client backend on this database that is not one of the test's own, with
 * the role it connected as.
 *
 * A check that asserts one backend's role passes on a process that opens a
 * second connection as somebody else, so the probes read all of them.
 */
export async function foreignBackends(
  cluster: Cluster,
  database: string,
  minePids: number[],
): Promise<{ pid: number; usename: string }[]> {
  const conn = cluster.connect(database) as unknown as {
    unsafe(query: string, values?: unknown[]): Promise<unknown>;
    close(): Promise<void>;
  };
  try {
    const mine = [0, ...minePids.map((p) => Number(p))].join(", ");
    const rows = (await conn.unsafe(
      `select pid, usename from pg_stat_activity
        where datname = current_database()
          and backend_type = 'client backend'
          and pid <> pg_backend_pid()
          and pid not in (${mine})
        order by pid`,
    )) as { pid: number; usename: string }[];
    return rows.map((r) => ({ pid: Number(r.pid), usename: String(r.usename) }));
  } finally {
    await conn.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// A helper process that says when it is up.
//
// D-64. Every subprocess entry prints exactly one JSON line when its handle has
// returned. A test that staged a kill without waiting for that line could not
// tell "not started yet" from "started and waiting", and would be killing some
// other moment than the one it names.
// ---------------------------------------------------------------------------

export interface ReadyProcess {
  /** The child, so a check can send it a signal. */
  proc: ReturnType<typeof Bun.spawn>;
  /** The pid the child reported as its own. */
  pid: number;
  /** Everything the child has printed, for a failure message. */
  output(): string;
  /** Kill it and wait. Safe to call twice, and safe after a kill -9. */
  stop(signal?: number): Promise<void>;
}

export async function startReadySubprocess(
  entry: string,
  argv: string[],
  timeoutMs = 30_000,
): Promise<ReadyProcess> {
  const proc = Bun.spawn(["bun", "run", hubPath(entry), ...argv], {
    cwd: hubPath("."),
    stdout: "pipe",
    stderr: "pipe",
  });

  let seen = "";
  const decoder = new TextDecoder();
  const reader = proc.stdout.getReader();
  const errors = new Response(proc.stderr).text();

  const stop = async (signal = 15) => {
    try {
      proc.kill(signal);
    } catch {
      // already gone
    }
    await proc.exited.catch(() => {});
  };

  const deadline = Date.now() + timeoutMs;

  /** A read that cannot outlive the deadline, so a silent child cannot hang. */
  const readBounded = async (): Promise<
    { value?: Uint8Array; done: boolean } | "timeout"
  > => {
    const left = deadline - Date.now();
    if (left <= 0) return "timeout";
    return await Promise.race([
      reader.read() as Promise<{ value?: Uint8Array; done: boolean }>,
      Bun.sleep(left).then(() => "timeout" as const),
    ]);
  };

  /** A WHOLE line, so a fragment that merely starts with a brace is not parsed. */
  const readyLine = (): string | null => {
    const cut = seen.indexOf("\n");
    if (cut < 0) return null;
    for (const line of seen.split("\n")) {
      if (line.trim().startsWith("{") && line.trim().endsWith("}")) return line;
    }
    return null;
  };

  try {
    for (;;) {
      const step = await readBounded();
      if (step === "timeout") {
        await stop(9);
        throw new Error(
          `${entry} printed no ready line within ${timeoutMs} ms. stdout: ${seen.trim().slice(0, 400)} stderr: ${(await errors).trim().slice(0, 400)}`,
        );
      }
      if (step.value) seen += decoder.decode(step.value, { stream: true });
      const line = readyLine();
      if (line) {
        const said = JSON.parse(line) as {
          ready: boolean;
          pid?: number;
          error?: string;
        };
        if (!said.ready) {
          await stop(9);
          throw new Error(`${entry} refused to start: ${said.error}`);
        }
        // Keep draining after readiness. A child whose stdout pipe fills up
        // blocks, and a blocked child is a hang with no explanation.
        void (async () => {
          try {
            for (;;) {
              const more = (await reader.read()) as {
                value?: Uint8Array;
                done: boolean;
              };
              if (more.value) seen += decoder.decode(more.value, { stream: true });
              if (more.done) return;
            }
          } catch {
            // the child went away, which is what a kill looks like
          }
        })();
        return {
          proc,
          pid: Number(said.pid),
          output: () => seen,
          stop,
        };
      }
      if (step.done) {
        await stop(9);
        throw new Error(
          `${entry} exited without a ready line. stdout: ${seen.trim().slice(0, 400)} stderr: ${(await errors).trim().slice(0, 400)}`,
        );
      }
    }
  } catch (error) {
    try {
      reader.releaseLock();
    } catch {
      // the reader may already be released
    }
    throw error;
  }
}

/**
 * Wait for a condition, or throw saying what was true instead.
 *
 * A bounded wait, never an unbounded one: a check that hangs says nothing, and
 * a check that sleeps a fixed time and then asserts is slower and flakier than
 * one that watches. The message is what a failure reads like, so it carries the
 * caller's own description.
 */
export async function until(
  what: string,
  ready: () => boolean | Promise<boolean>,
  timeoutMs: number,
  describe: () => string | Promise<string> = () => "",
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await ready()) return;
    if (Date.now() >= deadline) {
      throw new Error(
        `${what} did not happen within ${timeoutMs} ms. ${await describe()}`,
      );
    }
    await Bun.sleep(40);
  }
}
