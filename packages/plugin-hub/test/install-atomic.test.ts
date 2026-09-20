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

test("SPEC §1 a failed fresh schema leaves no partial installation and can be retried", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hub-install-atomic-"));
  const database = `atomic_${crypto.randomUUID().replaceAll("-", "")}`;
  const fail = join(dir, "fail");
  const wrapper = join(dir, "admin.ts");
  writeFileSync(fail, "fail after the ledger table");
  writeFileSync(wrapper, `
    import { existsSync, readFileSync, writeFileSync } from "node:fs";
    const args = process.argv.slice(2);
    const file = args.indexOf("-f");
    if (file >= 0 && existsSync(${JSON.stringify(fail)})) {
      const original = readFileSync(args[file + 1], "utf8");
      const broken = original.replace("create table inbound", "select 1 / 0;\\ncreate table inbound");
      if (broken === original) throw new Error("schema fault was not installed");
      const path = ${JSON.stringify(join(dir, "broken.sql"))};
      writeFileSync(path, broken);
      args[file + 1] = path;
    }
    const result = Bun.spawnSync([${JSON.stringify(pgBin("psql"))}, ...args], { stdout: "inherit", stderr: "inherit" });
    process.exit(result.exitCode);
  `);
  const registryFile = writeRegistry(dir, { hub: { store_url: cluster.url(database), state_dir: dir } });
  writeFileSync(registryFile, readFileSync(registryFile, "utf8") + `\n[install]\nadmin_argv = ${JSON.stringify([
    process.execPath, wrapper, "-h", "127.0.0.1", "-p", String(cluster.port), "-U", cluster.superuser,
  ])}\n`);
  try {
    await expect(runInstall({ registryFile, stage: "database" })).rejects.toThrow("division by zero");
    const sql = cluster.connect(database);
    expect((await sql`select to_regclass('public.ledger_event') as ledger`)[0].ledger).toBeNull();
    expect(readFileSync(registryFile, "utf8")).not.toContain("[store]");
    rmSync(fail);
    expect(await runInstall({ registryFile, stage: "database" })).toEqual({ stage: "database", result: "done" });
    // The highest version a FRESH schema lands on, which is the count of
    // ordered migrations an upgraded box is brought up to. A step that lands in
    // one and not the other leaves the two boxes on different schemas.
    expect((await sql`select max(version) as version from schema_version`)[0].version).toBe(4);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
