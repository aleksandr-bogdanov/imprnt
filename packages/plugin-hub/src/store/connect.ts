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

export async function openStore(options: { url: string }): Promise<Store> {
  const sql = new SQL(options.url, { max: 1 });
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
