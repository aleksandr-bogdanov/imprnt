// MSG-06. The five stamps are machinery's.
//
// SPEC §2: "Five stamps per human message, written by machinery, never by the
// model: received, acked, started, answered, delivered." Its Forbidden list
// carries "a stamp written by the model".
//
// Two fences, probed separately, because either one alone leaves the other hole
// open: the role cannot write a stamp, and a stamp claiming the model wrote it
// is refused even from a machinery role.

import { test, expect, beforeAll, afterAll } from "bun:test";
import { startCluster, freshDatabase, seam, type Cluster } from "./helpers/cluster.ts";

let cluster: Cluster;

const FIVE = ["received", "acked", "started", "answered", "delivered"] as const;

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
  throw new Error("the database allowed a stamp it must refuse");
}

test("MSG-06 a stamp written by the model is refused: every one of the five stamps is refused from an agent role, and the door and the runner can still write their own (SPEC §2 Forbidden, L6)", async () => {
  const db = await freshDatabase(cluster);
  const agent = cluster.connectAs("hub_agent", db) as unknown as Conn;
  const door = cluster.connectAs("hub_door", db) as unknown as Conn;
  const runner = cluster.connectAs("hub_runner", db) as unknown as Conn;

  await door.unsafe(
    `insert into inbound (id, person, agent, body)
     values ('m-stamps', 'p1', 'p1-lair', 'hello')`,
  );

  for (const kind of FIVE) {
    const message = await refused(() =>
      agent.unsafe(
        `insert into ledger_event (stream, subject, kind, actor)
         values ('inbound', 'm-stamps', '${kind}', 'door')`,
      ),
    );
    expect(message.length).toBeGreaterThan(0);
  }

  // The controls. The five stamps really are machinery's, so machinery writes
  // them and this check is not passing on a table nobody can write.
  await door.unsafe(
    `insert into ledger_event (stream, subject, kind, actor)
     values ('inbound', 'm-stamps', 'received', 'door')`,
  );
  await runner.unsafe(
    `insert into ledger_event (stream, subject, kind, actor)
     values ('inbound', 'm-stamps', 'acked', 'runner')`,
  );

  // And machinery's own fence, per writer per kind (D-06). Without this a
  // schema that grants both machinery roles all five kinds passes every other
  // assertion in the phase, and L1's order of operations stops being enforced.
  for (const [conn, who, forbidden] of [
    [door, "door", ["acked", "started", "answered"]],
    [runner, "runner", ["received", "delivered"]],
  ] as [Conn, string, string[]][]) {
    for (const kind of forbidden) {
      const message = await refused(() =>
        conn.unsafe(
          `insert into ledger_event (stream, subject, kind, actor)
           values ('inbound', 'm-stamps', '${kind}', '${who}')`,
        ),
      );
      expect(message.length).toBeGreaterThan(0);
    }
  }

  const reader = cluster.connect(db) as unknown as Conn;
  const rows = (await reader.unsafe(
    "select kind from ledger_event where subject = 'm-stamps' order by seq",
  )) as Record<string, unknown>[];
  expect(rows.map((r) => r.kind)).toEqual(["received", "acked"]);

  await reader.close();
  await agent.close();
  await door.close();
  await runner.close();
});

test("MSG-06 a stamp written by the model is refused: a stamp carrying a model actor is refused even from a machinery role, and the seam refuses it before the database does (SPEC §2 Forbidden, L6)", async () => {
  const { openStore, closeStore } = await seam("src/store/connect.ts");
  const { stamp, STAMPS, StampRefused } = await seam("src/records/stamps.ts");
  expect(typeof stamp).toBe("function");

  // The five, in L6's order, so a sixth stamp or a renamed one fails here.
  expect(STAMPS).toEqual(FIVE as unknown as string[]);

  const db = await freshDatabase(cluster);
  const door = cluster.connectAs("hub_door", db) as unknown as Conn;
  const runner = cluster.connectAs("hub_runner", db) as unknown as Conn;

  await door.unsafe(
    `insert into inbound (id, person, agent, body)
     values ('m-actor', 'p1', 'p1-lair', 'hello')`,
  );

  // The role fence is not what refuses here. The runner is machinery and holds
  // the grant. What refuses is the actor the row claims.
  const message = await refused(() =>
    runner.unsafe(
      `insert into ledger_event (stream, subject, kind, actor)
       values ('inbound', 'm-actor', 'acked', 'model')`,
    ),
  );
  expect(message.length).toBeGreaterThan(0);

  const store = await (openStore as Function)({ url: cluster.url(db) });
  let refusal: unknown;
  try {
    await (stamp as Function)(store, {
      messageId: "m-actor",
      kind: "acked",
      actor: "model",
    });
  } catch (err) {
    refusal = err;
  }
  expect(refusal).toBeInstanceOf(StampRefused as Function);

  // The control: the same call with a machinery actor lands.
  await (stamp as Function)(store, {
    messageId: "m-actor",
    kind: "acked",
    actor: "runner",
  });

  const reader = cluster.connect(db) as unknown as Conn;
  const rows = (await reader.unsafe(
    "select actor from ledger_event where subject = 'm-actor'",
  )) as Record<string, unknown>[];
  expect(rows.length).toBe(1);
  expect(rows[0].actor).toBe("runner");

  await reader.close();
  await door.close();
  await runner.close();
  await (closeStore as Function)(store);
});
