// STORE-02. One Postgres holds every message, reply, job and turn.
//
// SPEC §1: "One Postgres on the Pi holds every message, reply, job and turn for
// every person and every machine. Ledger and queue in one. No NATS, no SQLite,
// no broker, no per-machine file." D5's reason for one store rather than two:
// "The rule that never loses a message (write first, deliver later, in one
// transaction) needs the state and the queue in the same system. With one
// database that is one transaction. With a file plus a broker it is three
// writes and two systems."
//
// That is the probe. If the ledger and the queue were two systems, the message
// and its event could not be written and undone as one atomic act.
//
// The production write path does it, not the test. A reader named the
// hole that closes: "a store exposing a plain SQL client and two ordinary
// Postgres tables passes while the production enqueue path writes its ledger
// elsewhere. The test itself issues both INSERTs." So `enqueueInbound` is what
// writes here, inside a transaction the test rolls back, and the check watches
// what survives. Nothing searches source for the word NATS.

import { test, expect, beforeAll, afterAll } from "bun:test";
import { startCluster, freshDatabase, seam, type Cluster } from "./helpers/cluster.ts";

let cluster: Cluster;

const SLOW = 90_000;

beforeAll(async () => {
  cluster = await startCluster();
});

afterAll(async () => {
  if (cluster) await cluster.stop();
});

type Conn = {
  unsafe(query: string): Promise<unknown>;
  close(): Promise<void>;
};

class RollBackNow extends Error {}

test(
  "STORE-02 ledger and queue in one: the production enqueue path writes the message and its ledger event inside the caller's transaction, so both survive a commit and neither survives a rollback (SPEC §1, D5)",
  async () => {
    const { openStore, closeStore } = await seam("src/store/connect.ts");
    const { enqueueInbound } = await seam("src/store/inbound.ts");
    expect(typeof enqueueInbound).toBe("function");

    const db = await freshDatabase(cluster);
    const store = (await (openStore as Function)({ url: cluster.url(db) })) as {
      sql: { begin(fn: (tx: unknown) => Promise<unknown>): Promise<unknown> };
    };

    // Undone. `enqueueInbound` runs against the caller's transaction, which the
    // test then aborts by throwing. A ledger that lived in a second system
    // would have kept its row, because a rollback here could not reach it.
    let rolledBack = false;
    try {
      await store.sql.begin(async (tx) => {
        await (enqueueInbound as Function)(
          { ...store, sql: tx },
          {
            id: "m-atomic",
            person: "p1",
            agent: "p1-lair",
            body: "written then undone",
          },
        );
        throw new RollBackNow("abort the transaction");
      });
    } catch (err) {
      rolledBack = err instanceof RollBackNow;
      if (!rolledBack) throw err;
    }
    expect(rolledBack).toBe(true);

    const reader = cluster.connect(db) as unknown as Conn;
    expect(
      ((await reader.unsafe(
        "select id from inbound where id = 'm-atomic'",
      )) as unknown[]).length,
    ).toBe(0);
    expect(
      ((await reader.unsafe(
        "select seq from ledger_event where subject = 'm-atomic'",
      )) as unknown[]).length,
    ).toBe(0);

    // Kept. The same production path, committed, and both halves are there. The
    // control is what stops this passing on an enqueue that writes nothing at
    // all, or that fails silently.
    await store.sql.begin(async (tx) => {
      await (enqueueInbound as Function)(
        { ...store, sql: tx },
        {
          id: "m-kept",
          person: "p1",
          agent: "p1-lair",
          body: "written and kept",
        },
      );
    });

    expect(
      ((await reader.unsafe("select id from inbound where id = 'm-kept'")) as unknown[])
        .length,
    ).toBe(1);
    const events = (await reader.unsafe(
      "select kind from ledger_event where subject = 'm-kept'",
    )) as { kind: string }[];
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events.map((e) => e.kind)).toContain("received");

    await reader.close();
    await (closeStore as Function)(store);
  },
  SLOW,
);
