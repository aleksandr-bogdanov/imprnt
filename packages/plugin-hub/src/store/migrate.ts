import { readFileSync } from "node:fs";
import type { StoreLike } from "./connect.ts";

export interface Migration {
  version: number;
  sql: string;
}

/**
 * Every migration, in order, by file. The installer applies them with psql and
 * the store applies them in-process; both read THIS list, so a step cannot land
 * in one and not the other.
 */
export const MIGRATION_FILES: readonly (readonly [number, string])[] = [
  [1, "001-rollout.sql"],
  [2, "002-door-health.sql"],
  [3, "003-control.sql"],
  [4, "004-voice.sql"],
  [5, "005-dispatch.sql"],
  [6, "006-agent-lifecycle.sql"],
  [7, "007-media.sql"],
  [8, "008-watch.sql"],
  [9, "009-watch-origin.sql"],
  [10, "010-council.sql"],
  [11, "011-conversations.sql"],
  [12, "012-effects-confirmations.sql"],
  [13, "013-execution-controls.sql"],
  [14, "014-councils.sql"],
  [15, "015-topics.sql"],
  [16, "016-topic-move.sql"],
  [17, "017-topic-deletion.sql"],
];

const MIGRATIONS: Migration[] = MIGRATION_FILES.map(([version, file]) => ({
  version,
  sql: readFileSync(new URL(`./migrations/${file}`, import.meta.url), "utf8"),
}));

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
