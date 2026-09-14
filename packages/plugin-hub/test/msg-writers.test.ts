// MSG-01. Two tables, one owner each.
//
// SPEC §2: "Two tables, one owner each: `inbound`, written by the door, and
// `outbox`, written by the runner in chunks. Nobody else writes either." L1's
// Forbidden list carries "a second process writing a table it does not own".
//
// Every refusal below is raised by Postgres on a role connection, never by a
// guard in our TypeScript. A fence that lives in our code is the convention the
// rule exists to replace, because a second process opens its own connection.

import { test, expect, beforeAll, afterAll } from "bun:test";
import { startCluster, freshDatabase, type Cluster } from "./helpers/cluster.ts";

let cluster: Cluster;

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

async function refused(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (err) {
    return String((err as Error).message);
  }
  throw new Error("the database allowed a write it must refuse");
}

/**
 * The refusal has to come from the fence, not from some other error the same
 * statement would have raised anyway. Postgres answers a missing grant with
 * SQLSTATE 42501 and a row-level security refusal with 42501 too, so anything
 * else, a foreign key or a not-null, means the check proved nothing.
 */
async function refusedByTheFence(run: () => Promise<unknown>): Promise<void> {
  const message = await refused(run);
  const isFence =
    /permission denied|row-level security|insufficient privilege|42501/i.test(
      message,
    );
  if (!isFence) {
    throw new Error(
      `refused, but not by the fence. Postgres said: ${message}`,
    );
  }
}

test("MSG-01 a second writer on a table is refused: a role that owns neither table cannot write the ledger or the outbox (SPEC §2 Forbidden, L1)", async () => {
  const db = await freshDatabase(cluster);
  const door = cluster.connectAs("hub_door", db) as unknown as Conn;
  const agent = cluster.connectAs("hub_agent", db) as unknown as Conn;

  // The message exists first, so nothing the agent's statements reference is
  // missing and a foreign key cannot stand in for the fence.
  await door.unsafe(
    `insert into inbound (id, person, agent, body)
     values ('m1', 'p1', 'p1-lair', 'hello')`,
  );

  await refusedByTheFence(() =>
    agent.unsafe(
      `insert into ledger_event (stream, subject, kind, actor)
       values ('inbound', 'm1', 'received', 'door')`,
    ),
  );

  await refusedByTheFence(() =>
    agent.unsafe(
      `insert into outbox (inbound_id, seq_in_reply, body)
       values ('m1', 1, 'a reply the agent wrote itself')`,
    ),
  );

  await agent.close();
  await door.close();
});

test("MSG-01 a second writer on a table is refused: the runner cannot create an inbound message and the door can (SPEC §2 Forbidden, L1)", async () => {
  const db = await freshDatabase(cluster);
  const door = cluster.connectAs("hub_door", db) as unknown as Conn;
  const runner = cluster.connectAs("hub_runner", db) as unknown as Conn;

  const message = `insert into inbound (id, person, agent, body)
     values ('m-owner', 'p1', 'p1-lair', 'hello')`;

  await refused(() => runner.unsafe(message));

  // The control. Without it this check passes on a database that refuses
  // everybody, which is not the rule.
  await door.unsafe(message);

  const reader = cluster.connect(db) as unknown as {
    unsafe(query: string): Promise<unknown>;
    close(): Promise<void>;
  };
  const rows = (await reader.unsafe(
    "select id from inbound where id = 'm-owner'",
  )) as Record<string, unknown>[];
  expect(rows.length).toBe(1);

  await reader.close();
  await door.close();
  await runner.close();
});

test("MSG-01 a second writer on a table is refused: the door cannot write an outbox chunk, the runner can, and the door may only mark it delivered (SPEC §2 Forbidden, L1, and L1 step 6)", async () => {
  const db = await freshDatabase(cluster);
  const door = cluster.connectAs("hub_door", db) as unknown as Conn;
  const runner = cluster.connectAs("hub_runner", db) as unknown as Conn;

  await door.unsafe(
    `insert into inbound (id, person, agent, body)
     values ('m-chunks', 'p1', 'p1-lair', 'hello')`,
  );

  const chunk = `insert into outbox (inbound_id, seq_in_reply, body)
     values ('m-chunks', 1, 'the first chunk of the reply')`;

  await refused(() => door.unsafe(chunk));

  // The control: the runner owns the outbox.
  await runner.unsafe(chunk);

  // L1 step 6: the door marks a chunk delivered after the platform accepted it,
  // and touches nothing else on the row.
  await refused(() =>
    door.unsafe("update outbox set body = 'the door rewrote the reply'"),
  );
  await door.unsafe("update outbox set delivered_at = now()");

  const reader = cluster.connect(db) as unknown as {
    unsafe(query: string): Promise<unknown>;
    close(): Promise<void>;
  };
  const rows = (await reader.unsafe(
    "select body, delivered_at from outbox where inbound_id = 'm-chunks'",
  )) as Record<string, unknown>[];
  expect(rows.length).toBe(1);
  expect(rows[0].body).toBe("the first chunk of the reply");
  expect(rows[0].delivered_at).not.toBeNull();

  await reader.close();
  await door.close();
  await runner.close();
});
