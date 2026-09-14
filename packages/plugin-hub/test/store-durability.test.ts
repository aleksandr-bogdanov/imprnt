// STORE-03. A row is on disk before the database says ok.
//
// SPEC §1: "A row is on disk before the database says ok. Any setting that says
// ok earlier is forbidden." D5 names the setting and the ruling on it:
// `synchronous_commit=off`, "no no no no".
//
// Nothing here is mocked. Each check starts a real cluster configured the way
// the rule forbids, or the way it allows, and asks the store to open it.
//
// `full_page_writes = off` was probed here and the check is gone. The second
// seat could not establish that it makes the server say ok before the row is on
// disk, and neither could we: Postgres documents it as torn-page protection,
// which is a different failure from an early acknowledgement. The spec line is
// "any setting that says ok earlier is forbidden", so a setting that does not
// acknowledge earlier does not belong under it. `synchronous_commit = off` and
// `fsync = off` stay, and both do acknowledge earlier.

import { test, expect, beforeAll, afterAll } from "bun:test";
import { startCluster, seam, type Cluster } from "./helpers/cluster.ts";

let durable: Cluster;
let asyncCommit: Cluster;
let noFsync: Cluster;

beforeAll(async () => {
  [durable, asyncCommit, noFsync] = await Promise.all([
    startCluster(),
    startCluster({ settings: { synchronous_commit: "off" } }),
    startCluster({ settings: { fsync: "off" } }),
  ]);
});

afterAll(async () => {
  await Promise.all(
    [durable, asyncCommit, noFsync].filter(Boolean).map((c) => c.stop()),
  );
});

test("STORE-03 a row is on disk before the database says ok: a server running synchronous_commit=off is refused and the refusal names the setting (SPEC §1, D5)", async () => {
  const { openStore, DurabilityRefused } = await seam("src/store/connect.ts");
  expect(typeof openStore).toBe("function");

  const db = await asyncCommit.createDatabase();

  // Control on the fixture itself: the cluster really is the forbidden one.
  const raw = asyncCommit.connect(db);
  const [row] = await raw`select current_setting('synchronous_commit') as value`;
  expect(row.value).toBe("off");
  await raw.close();

  let refusal: unknown;
  try {
    await (openStore as Function)({ url: asyncCommit.url(db) });
  } catch (err) {
    refusal = err;
  }

  expect(refusal).toBeInstanceOf(DurabilityRefused as Function);
  expect((refusal as { setting: string }).setting).toBe("synchronous_commit");
  expect((refusal as { value: string }).value).toBe("off");
});

test("STORE-03 a row is on disk before the database says ok: a server running fsync=off is refused and the refusal names the setting (SPEC §1, D5, D-03 inferred)", async () => {
  const { openStore, DurabilityRefused } = await seam("src/store/connect.ts");
  expect(typeof openStore).toBe("function");

  const db = await noFsync.createDatabase();

  const raw = noFsync.connect(db);
  const [row] = await raw`select current_setting('fsync') as value`;
  expect(row.value).toBe("off");
  await raw.close();

  let refusal: unknown;
  try {
    await (openStore as Function)({ url: noFsync.url(db) });
  } catch (err) {
    refusal = err;
  }

  expect(refusal).toBeInstanceOf(DurabilityRefused as Function);
  expect((refusal as { setting: string }).setting).toBe("fsync");
});

test("STORE-03 the control: a durable server opens and a written row reads back, so the refusal is not a blanket denial (SPEC §1, D5)", async () => {
  const { openStore, closeStore } = await seam("src/store/connect.ts");
  expect(typeof openStore).toBe("function");
  expect(typeof closeStore).toBe("function");

  const db = await durable.createDatabase();
  const store = (await (openStore as Function)({ url: durable.url(db) })) as {
    sql: (strings: TemplateStringsArray, ...values: unknown[]) => Promise<
      Record<string, unknown>[]
    > & { unsafe: (q: string) => Promise<unknown> };
  };

  const sql = store.sql as unknown as {
    (strings: TemplateStringsArray, ...values: unknown[]): Promise<
      Record<string, unknown>[]
    >;
    unsafe(query: string): Promise<unknown>;
  };

  await sql.unsafe("create table durability_probe (id int primary key, body text)");
  await sql.unsafe("insert into durability_probe values (1, 'on disk')");
  const rows = await sql.unsafe("select body from durability_probe where id = 1");
  expect((rows as Record<string, unknown>[])[0].body).toBe("on disk");

  await (closeStore as Function)(store);
});
