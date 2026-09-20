import { readFileSync } from "node:fs";
import type { StoreLike } from "./connect.ts";

export interface Migration {
  version: number;
  sql: string;
}

const MIGRATIONS: Migration[] = [{
  version: 1,
  sql: readFileSync(new URL("./migrations/001-rollout.sql", import.meta.url), "utf8"),
}, {
  version: 2,
  sql: readFileSync(new URL("./migrations/002-door-health.sql", import.meta.url), "utf8"),
}, {
  version: 3,
  sql: readFileSync(new URL("./migrations/003-control.sql", import.meta.url), "utf8"),
}, {
  version: 4,
  sql: readFileSync(new URL("./migrations/004-voice.sql", import.meta.url), "utf8"),
}];

/** DDL and its version commit together. A failed step can be retried unchanged. */
export async function migrate(store: StoreLike, steps: Migration[] = MIGRATIONS): Promise<void> {
  for (const step of [...steps].sort((a, b) => a.version - b.version)) {
    if (!Number.isSafeInteger(step.version) || step.version <= 0) throw new Error("invalid migration version");
    await store.sql.begin(async sql => {
      await sql`select pg_advisory_xact_lock(682104, 1)`;
      await sql`create table if not exists schema_version (version integer primary key)`;
      const found = await sql`select version from schema_version where version = ${step.version}`;
      if (found.length > 0) return;
      await sql.unsafe(step.sql);
      await sql`insert into schema_version (version) values (${step.version})`;
    });
  }
}
