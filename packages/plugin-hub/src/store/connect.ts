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
 * How many connections one store holds.
 *
 * MEASURED 2026-09-16, and the reason it is not 1 (BUILD-NOTES 8). With a pool
 * of one, two of a process's own tasks that have statements in flight at the
 * same moment get each other's result rows: a runner serving TWO agents read
 * back a `ledger_event.seq` from the other agent's diary write as the value of
 * its own `returning data` column, reproducibly, and the same runner serving
 * ONE agent never did. It is not the statement text, not the prepared
 * statement's name and not a transaction boundary: the same two statements
 * driven by hand in either order never cross, and a pool above one never
 * crosses at all, because two statements in flight are then two connections.
 *
 * The hub's own tasks are genuinely concurrent (a runner's agents, a door's
 * read and post and attend), so this is a floor rather than a tuning knob. What
 * stays true of one connection stays true of the first: the process names
 * itself to the server there, the hub's advisory lock is held by that session,
 * and a waiting process still issues nothing at all.
 */
// Keep concurrent statements separate while leaving room for doors, runners
// and their notification connections in the same cluster.
const CONNECTIONS_PER_STORE = 4;

export async function openStore(options: { url: string }): Promise<Store> {
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
