import { SQL } from "bun";

/** A server setting that lets the database say ok before the row is on disk. */
export class DurabilityRefused extends Error {
  readonly setting: string;
  readonly value: string;

  constructor(setting: string, value: string) {
    super(
      `this server runs ${setting} = ${value}, which reports success before the row is on disk. ` +
        `The hub only opens a store that has written the row first.`,
    );
    this.name = "DurabilityRefused";
    this.setting = setting;
    this.value = value;
  }
}

/**
 * The environment every process that opens a store is started with.
 *
 * Bun's Postgres client pipelines by default, and in Bun 1.3.14 that hands one
 * statement another statement's answer (the mechanism is below, at the pool
 * size). This switch turns the pipelining off, and Bun reads it ONCE, when the
 * process starts: set from inside a running process it changes nothing, which
 * `test/store-crossing.test.ts` measures. So it cannot be set here. It is set
 * by whatever starts the process: the unit files `src/os/systemd.ts` and
 * `src/os/launchd.ts` render, the `hub.mjs` launcher behind `imprnt hub`, and
 * the package's `test` script.
 */
export const STARTED_WITH: Readonly<Record<string, string>> = Object.freeze({
  BUN_FEATURE_FLAG_DISABLE_SQL_AUTO_PIPELINING: "1",
});

/** A process started without `STARTED_WITH`, which the store will not serve. */
export class PipeliningRefused extends Error {
  readonly variable: string;

  constructor(variable: string, value: string | undefined) {
    // One line, because every command prints the first line of an error.
    super(
      `this process was started without ${variable}=1 (${value === undefined ? "it is unset" : `it is "${value}"`}), ` +
        `and without it Bun's Postgres client can hand one statement the answer meant for another. ` +
        `Start the process with ${variable}=1 in its environment, because setting it after the start does nothing.`,
    );
    this.name = "PipeliningRefused";
    this.variable = variable;
  }
}

/**
 * The refusal, as a function, so it runs before a single connection is opened.
 *
 * It reads the environment, and it is not a behaviour switch (RUN-07): nothing
 * about what the hub does depends on it, only whether the runtime underneath
 * can be trusted to hand each statement its own answer.
 */
function refuseUnlessPipeliningIsOff(): void {
  for (const [variable, wanted] of Object.entries(STARTED_WITH)) {
    const value = process.env[variable];
    if (value !== wanted) throw new PipeliningRefused(variable, value);
  }
}

export interface Store {
  /** The Bun SQL client: a tagged template that also carries unsafe, begin and reserve. */
  sql: SQL;
  /** Where this store is, so a second connection can be opened to the same database. */
  url: string;
  close(): Promise<void>;
}

/** The store a writer is handed. A caller may swap `sql` for its own transaction. */
export interface StoreLike {
  sql: SQL;
  url: string;
}

const SAYS_OK_EARLY: [string, string[]][] = [
  ["synchronous_commit", ["off"]],
  ["fsync", ["off"]],
];

/**
 * How many connections one store holds, and why it is more than one.
 *
 * REPRODUCED 2026-09-19 by `test/store-crossing.test.ts`, which carries the
 * whole mechanism. Bun's Postgres client hands every answer on a connection to
 * the oldest statement queued there, and it writes a statement it has already
 * prepared at once while a statement new to that connection waits for the
 * connection to go idle. On a busy connection the prepared one overtakes, so
 * the new one is handed its answer and the one that overtook is never answered.
 * That is the outage claim that read its `since` as undefined in phase 4, and
 * the diary append with no `seq` in phase 6.
 *
 * A wider pool does not prevent it. The pool only doubles up on a connection
 * once every connection is busy, so four connections cross at a higher load
 * than one and cross all the same. What the width buys is the aftermath: with
 * one connection every later statement of the process waits forever behind the
 * lost one, and with more than one the pool routes around the wedged connection
 * and the store keeps answering. That is the floor the check holds, and it is
 * why claims, deadline reads and the runner's own diary writes each reserve a
 * connection for their statement. Neither `prepare: false` (it sends a jsonb
 * parameter as "[object Object]") nor the client's pipelining switch set from
 * inside the process removes the cause.
 *
 * Four rather than eight because a 40-connection cluster refused a hub, two
 * doors, a runner and their listeners at eight. What stays true of one
 * connection stays true of the first: the process names itself to the server
 * there, the hub's advisory lock is held by that session, and a waiting process
 * still issues nothing at all.
 */
const CONNECTIONS_PER_STORE = 4;

export async function openStore(options: { url: string }): Promise<Store> {
  refuseUnlessPipeliningIsOff();
  const sql = new SQL(options.url, { max: CONNECTIONS_PER_STORE });
  try {
    const [row] = (await sql.unsafe(
      `select ${SAYS_OK_EARLY.map(([name]) => `current_setting('${name}') as ${name}`).join(", ")}`,
    )) as Record<string, string>[];
    for (const [setting, forbidden] of SAYS_OK_EARLY) {
      const value = String(row[setting]);
      if (forbidden.includes(value)) throw new DurabilityRefused(setting, value);
    }
    // D-85. The name a process answers to in the server's own view of its
    // clients, which is what lets a silent runner be DERIVED rather than
    // heartbeaten. One statement, at connect, long before any wait window
    // opens, so a runner that is waiting still issues nothing at all.
    const named = applicationNameOf(options.url);
    if (named !== null) await sql.unsafe("select set_config('application_name', $1, false)", [named]);
  } catch (error) {
    await sql.close().catch(() => {});
    throw error;
  }
  return { sql, url: options.url, close: () => sql.close() };
}

/** The name `storeUrlAs` wrote into the url, when it wrote one. */
function applicationNameOf(url: string): string | null {
  try {
    const found = new URL(url).searchParams.get("application_name");
    return found && found !== "" ? found : null;
  } catch {
    return null;
  }
}

export async function closeStore(store: { close(): Promise<void> }): Promise<void> {
  await store.close();
}

/**
 * The same store, opened as a named role. The registry carries the location and
 * no user, so a process supplies its own identity here and a typo in the file
 * cannot hand the door the runner's role.
 */
export function storeUrlAs(url: string, role: string, applicationName?: string): string {
  const where = new URL(url);
  where.username = role;
  // The name is optional and is the process's own id, never a behaviour: it is
  // how the server's client list says WHO is connected, and nothing reads it
  // back to decide anything.
  if (applicationName !== undefined && applicationName !== "") {
    where.searchParams.set("application_name", applicationName);
  }
  return where.toString();
}
