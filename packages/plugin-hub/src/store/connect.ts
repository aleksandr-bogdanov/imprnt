import { SQL } from "bun";
import { managedSQL } from "./managed.ts";

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
 * statement another statement's answer (see `test/store-crossing.test.ts`). This switch turns the pipelining off, and Bun reads it ONCE, when the
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
 * It reads the environment, and it is not a behaviour switch: nothing
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
  /** The managed SQL tag and its unsafe, begin and reserve operations. */
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

/** Two slots: migration jobs hold one advisory-lock reservation while using the other.
 * Standalone statements now reserve through result consumption, so they cannot
 * enter another caller's transaction; pool width is no longer that workaround.
 * Serialized door ingress needs only one slot. LISTEN sockets are separate.
 */
const CONNECTIONS_PER_STORE = 2;

export async function openStore(options: { url: string; max?: number }): Promise<Store> {
  refuseUnlessPipeliningIsOff();
  const sql = managedSQL(new SQL(options.url, {
    max: options.max ?? CONNECTIONS_PER_STORE,
    // Startup parameters apply to EVERY pooled backend and every reconnect.
    connection: { application_name: applicationNameOf(options.url) ?? "imprnt-hub" },
  }));
  try {
    const [row] = (await sql.unsafe(
      `select ${SAYS_OK_EARLY.map(([name]) => `current_setting('${name}') as ${name}`).join(", ")}`,
    )) as Record<string, string>[];
    for (const [setting, forbidden] of SAYS_OK_EARLY) {
      const value = String(row[setting]);
      if (forbidden.includes(value)) throw new DurabilityRefused(setting, value);
    }
  } catch (error) {
    await sql.close({ timeout: 5 }).catch(() => {});
    throw error;
  }
  return { sql, url: options.url, close: () => sql.close({ timeout: 5 }) };
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
