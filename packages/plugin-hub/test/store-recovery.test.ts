import { afterAll, beforeAll, expect, test } from "bun:test";
import { SQL } from "bun";
import { startCluster, until, type Cluster } from "./helpers/cluster.ts";
import { openStore, storeUrlAs } from "../src/store/connect.ts";
import { managedSQL } from "../src/store/managed.ts";
import { listenForWork } from "../src/store/listen.ts";

let cluster: Cluster;
beforeAll(async () => { cluster = await startCluster(); });
afterAll(async () => { await cluster?.stop(); });

test("a poisoned reserved backend is reset, the failed write is not replayed, and later work succeeds", async () => {
  const db = await cluster.createDatabase();
  const pool = new SQL(cluster.url(db), { max: 1 });
  const sql = managedSQL(pool);
  const observer = cluster.connect(db);
  try {
    await sql`create table recovery_probe (id int primary key)`;
    const broken = await sql.reserve();
    const [{ pid }] = await broken`select pg_backend_pid() as pid`;
    await broken.unsafe("begin");
    await broken`insert into recovery_probe values (1)`;
    await expect(Promise.resolve(broken`select 1/0`)).rejects.toBeDefined();
    await expect(broken`insert into recovery_probe values (2)`).rejects.toMatchObject({ errno: "25P02" });
    broken.release();
    expect((await observer`select state from pg_stat_activity where pid = ${pid}`)[0].state).toBe("idle");
    const [{ next }] = await sql`select pg_backend_pid() as next`;
    expect(next).toBe(pid);
    expect(await sql`select * from recovery_probe`).toHaveLength(0);
    await sql`insert into recovery_probe values (3)`;
    expect(Array.from(await sql`select * from recovery_probe`)).toEqual([{ id: 3 }]);
  } finally { await pool.close({ timeout: 1 }); await observer.close(); }
});

test("standalone pooled failures reset the poisoned backend and do not replay writes", async () => {
  const db = await cluster.createDatabase();
  const pool = new SQL(cluster.url(db), { max: 1 });
  const sql = managedSQL(pool);
  try {
    await sql`create table recovery_probe (id int primary key)`;
    // Model the driver's leaked aborted transaction before the facade borrows it.
    const broken = await pool.reserve();
    await broken.unsafe("begin");
    await expect(Promise.resolve(broken`select 1/0`)).rejects.toBeDefined();
    broken.release();
    await expect(sql`insert into recovery_probe values (1)`).rejects.toMatchObject({ errno: "25P02" });
    expect(await sql`select * from recovery_probe`).toHaveLength(0);
  } finally { await pool.close({ timeout: 1 }); }
});

test("two slots keep transactions isolated and leave room beside a held advisory lock", async () => {
  const db = await cluster.createDatabase();
  const store = await openStore({ url: cluster.url(db) });
  try {
    const held = await store.sql.reserve();
    try {
      await held`select pg_advisory_lock(42)`;
      expect((await store.sql`select 7 as answer`)[0].answer).toBe(7);
    } finally { await held`select pg_advisory_unlock(42)`; held.release(); }
    await store.sql`create table recovery_probe (id int primary key)`;
    await expect(store.sql.begin(async tx => {
      await tx`insert into recovery_probe values (1)`;
      await tx`select 1/0`;
    })).rejects.toBeDefined();
    expect(await store.sql`select * from recovery_probe`).toHaveLength(0);
    const answers = await Promise.all(Array.from({ length: 20 }, (_, id) =>
      store.sql.begin(async tx => {
        await tx`insert into recovery_probe values (${id})`;
        return (await tx`select ${id}::int as id`)[0].id;
      })));
    expect(answers).toEqual(Array.from({ length: 20 }, (_, id) => id));
  } finally { await store.close(); }
});

test("every pooled and LISTEN backend is named at startup and after reconnect", async () => {
  const db = await cluster.createDatabase();
  const url = storeUrlAs(cluster.url(db), cluster.superuser, "recovery-fixture");
  const store = await openStore({ url });
  const observer = cluster.connect(db);
  const listener = await listenForWork({ url, channel: "recovery_probe", onNotify() {} });
  try {
    const held = await Promise.all([store.sql.reserve(), store.sql.reserve()]);
    const pids: number[] = [];
    try {
      for (const connection of held) {
        const [row] = await connection`select pg_backend_pid() as pid, current_setting('application_name') as name`;
        expect(row.name).toBe("recovery-fixture");
        pids.push(row.pid);
      }
      expect(new Set(pids).size).toBe(2);
      expect((await observer`select count(*)::int as n from pg_stat_activity where datname = ${db} and application_name = 'recovery-fixture'`)[0].n).toBe(3);
    } finally { held.forEach(connection => connection.release()); }
    for (const pid of pids) await observer`select pg_terminate_backend(${pid})`;
    await until("terminated clients gone", async () =>
      (await observer`select count(*)::int as n from pg_stat_activity where datname = ${db} and application_name = 'recovery-fixture'`)[0].n === 1, 5000);
    const [row] = await store.sql`select pg_backend_pid() as pid, current_setting('application_name') as name`;
    expect(pids).not.toContain(row.pid);
    expect(row.name).toBe("recovery-fixture");
  } finally { await listener.close(); await store.close(); await observer.close(); }
});

test("a failed rollback closes that reservation without replay and pool shutdown stays bounded", async () => {
  const db = await cluster.createDatabase();
  const pool = new SQL(cluster.url(db), { max: 1 });
  const observer = cluster.connect(db);
  let poison = true;
  // Interrupt only the cleanup command on a real backend, modelling a link
  // lost between the 25P02 result and its rollback.
  const intercepted = new Proxy(pool, {
    get(target, key) {
      if (key === "reserve") return async () => {
        const connection = await target.reserve();
        const [{ pid }] = await connection`select pg_backend_pid() as pid`;
        if (!poison) return connection;
        poison = false;
        await connection.unsafe("begin");
        try { await connection`select 1/0`; } catch { /* deliberately aborted */ }
        return new Proxy(connection, {
          get(inner, method) {
            if (method === "unsafe") return async (query: string) => {
              if (query === "ROLLBACK") await observer`select pg_terminate_backend(${pid})`;
              return inner.unsafe(query);
            };
            return Reflect.get(inner, method, inner);
          },
        });
      };
      return Reflect.get(target, key, target);
    },
  });
  const sql = managedSQL(intercepted);
  try {
    await expect(sql`select 7 as answer`).rejects.toMatchObject({ errno: "25P02" });
    expect((await sql`select 8 as answer`)[0].answer).toBe(8);
  } finally {
    await pool.close({ timeout: 1 });
    await observer.close();
  }
}, 10000);
