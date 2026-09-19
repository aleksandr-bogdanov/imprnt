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
 * How many connections one store holds, and why it is still four.
 *
 * THE CROSSING, reproduced 2026-09-19 by `test/store-crossing.test.ts`, which
 * carries the whole mechanism. With its automatic pipelining on, Bun's Postgres
 * client writes a statement it has already prepared at once, while a statement
 * new to that connection waits for the connection to go idle, and it hands
 * every answer to the oldest statement queued there. On a busy connection the
 * prepared one overtakes, the new one is handed its answer, and the one that
 * overtook is never answered. That is the outage claim that read its `since` as
 * undefined in phase 4, and the diary append with no `seq` in phase 6. A wider
 * pool never prevented it: four and eight connections crossed the same way once
 * every connection was busy, and the width only decided whether the store kept
 * answering afterwards.
 *
 * THE CAUSE IS OFF. Every process is started with `STARTED_WITH` and
 * `openStore` refuses one that was not, so no connection pipelines and the
 * check holds 0 crossings in N. The width was then measured again on what the
 * hub itself needs, and it does not come down:
 *
 *   - At one, the v2 handoff and the history catch-up wedge. Each reserves a
 *     connection for a session advisory lock and then runs its work through
 *     the pool while holding it (`src/migrate/handoff.ts`,
 *     `src/migrate/harvest.ts`), so the reservation is the whole pool and the
 *     next statement waits forever. Every one of the 14 checks that ran in
 *     `test/v2-work-handoff.test.ts` and `test/harvest-v2-catchup.test.ts`
 *     failed, 13 of them by hanging to the 90 s bound.
 *   - At two, a door wedges under load. `test/door-chat-health.test.ts` with
 *     four cores kept busy hung to the 90 s bound in 4 of 8 runs, always in a
 *     same-person route check, and once in a full suite run. The server showed
 *     one door connection idle in a transaction with no lock waiting, so the
 *     door was waiting on its own client, not on the database. It is the width
 *     and not the switch: with the switch off the same runs hung in 3 of 8.
 *     What exactly the door waited for was not pinned down.
 *   - At three the same 8 runs were clean, and at four they were clean and so
 *     was the full suite. Three is not taken: without the mechanism at two, 8
 *     clean runs are a sample and not a floor, and a wedged door costs more
 *     than the 35 MB it would save.
 *
 * So memory stays where it was: a backend after hub-shaped work costs about
 * 5 MB PSS on the hub box, and a two-person household holds 7 stores, about
 * 140 MB at four. What stays true of one connection stays true of the first:
 * the process names itself to the server there, the hub's advisory lock is
 * held by that session, and a waiting process still issues nothing at all.
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
