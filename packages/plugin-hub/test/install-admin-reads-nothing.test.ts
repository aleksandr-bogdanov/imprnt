// The database administrator's command is handed SQL, never a path.
//
// On a stock Debian box the administrator is the `postgres` account, reached
// through `sudo -n -u postgres psql`, and the checkout sits in a home directory
// that account cannot enter. An installer that names a file inside the checkout
// on the administrator's command line fails there with "Permission denied",
// after it has created the database and before it has created anything in it.
// So the administrator here is a wrapper that refuses any argument naming a
// file that exists, which is exactly what a `postgres` account outside the
// owner's home can and cannot see, and a control shows the same wrapper lets a
// plain SQL string through.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInstall } from "../src/install/run.ts";
import { pgBin, startCluster, type Cluster } from "./helpers/cluster.ts";
import { writeRegistry } from "./helpers/registry.ts";

let cluster: Cluster;
beforeAll(async () => { cluster = await startCluster(); });
afterAll(async () => { await cluster?.stop(); });

function refusingAdmin(dir: string): string {
  const wrapper = join(dir, "admin.ts");
  writeFileSync(wrapper, `
    import { existsSync, statSync } from "node:fs";
    const args = process.argv.slice(2);
    for (const arg of args) {
      if (arg !== "-" && existsSync(arg) && statSync(arg).isFile()) {
        process.stderr.write("psql: error: " + arg + ": Permission denied\\n");
        process.exit(2);
      }
    }
    const stdin = await Bun.stdin.bytes();
    const result = Bun.spawnSync([${JSON.stringify(pgBin("psql"))}, ...args], { stdin, stdout: "inherit", stderr: "inherit" });
    process.exit(result.exitCode);
  `);
  return wrapper;
}

test("SPEC §6 a fresh install hands the administrator SQL and names no file it would have to open", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hub-install-admin-"));
  const database = `adminreads_${crypto.randomUUID().replaceAll("-", "")}`;
  const registryFile = writeRegistry(dir, { hub: { store_url: cluster.url(database), state_dir: dir } });
  writeFileSync(registryFile, readFileSync(registryFile, "utf8") + `\n[install]\nadmin_argv = ${JSON.stringify([
    process.execPath, refusingAdmin(dir), "-h", "127.0.0.1", "-p", String(cluster.port), "-U", cluster.superuser,
  ])}\n`);
  try {
    expect(await runInstall({ registryFile, stage: "database" })).toEqual({ stage: "database", result: "done" });
    const sql = cluster.connect(database);
    expect((await sql`select to_regclass('public.ledger_event') as ledger`)[0].ledger).toBe("ledger_event");
    expect((await sql`select max(version) as version from schema_version`)[0].version).toBe(6);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("control: the refusing administrator still runs a plain SQL string", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hub-install-admin-control-"));
  try {
    const result = Bun.spawnSync([process.execPath, refusingAdmin(dir), "-h", "127.0.0.1", "-p", String(cluster.port),
      "-U", cluster.superuser, "-d", "postgres", "-At", "-c", "select 42"], { stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString().trim()).toBe("42");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
