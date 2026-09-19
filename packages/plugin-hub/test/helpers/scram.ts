// Test infrastructure: a throwaway cluster that asks the hub roles for a
// password, the way the cutover procedure's pg_hba.conf line does.
//
// `startCluster` runs `initdb --auth=trust`, and on a trust cluster a login
// succeeds whether the role has a password or not, so nothing about passwords
// can be measured there. This rewrites the cluster's pg_hba.conf so the test
// superuser keeps its trusted way in (every helper connects as it) and every
// other role, the four hub roles included, must answer scram-sha-256 on
// loopback. The unix socket admits the superuser only.

import { SQL } from "bun";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { until, type Cluster } from "./cluster.ts";

export async function requirePasswords(cluster: Cluster): Promise<void> {
  const admin = new SQL(cluster.url("postgres"), { max: 1 });
  try {
    // A role with no password is the sentinel: once the server refuses it, the
    // new file is the one in force.
    await admin.unsafe("do $$ begin create role hub_scram_sentinel login; exception when duplicate_object then null; end $$");
    writeFileSync(join(cluster.dataDir, "pg_hba.conf"), [
      `local all ${cluster.superuser} trust`,
      `host all ${cluster.superuser} 127.0.0.1/32 trust`,
      `host all ${cluster.superuser} ::1/128 trust`,
      "host all all 127.0.0.1/32 scram-sha-256",
      "host all all ::1/128 scram-sha-256",
      "",
    ].join("\n"));
    await admin.unsafe("select pg_reload_conf()");
    await until("the cluster asks for a password", async () => {
      const probe = new SQL(`postgres://hub_scram_sentinel@127.0.0.1:${cluster.port}/postgres`, { max: 1 });
      try {
        await probe`select 1`;
        return false;
      } catch {
        return true;
      } finally {
        await probe.close().catch(() => {});
      }
    }, 10_000);
  } finally {
    await admin.close();
  }
}

/** Whether a role can log in with this password, or with none when it is null. */
export async function logsIn(cluster: Cluster, database: string, role: string, password: string | null): Promise<boolean> {
  const where = new URL(`postgres://127.0.0.1:${cluster.port}/${database}`);
  where.username = role;
  if (password !== null) where.password = password;
  const sql = new SQL(where.toString(), { max: 1 });
  try {
    const [row] = await sql`select current_user as role`;
    return row.role === role;
  } catch {
    return false;
  } finally {
    await sql.close().catch(() => {});
  }
}
