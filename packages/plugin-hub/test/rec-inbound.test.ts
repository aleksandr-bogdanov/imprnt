// REC-03. The state of a message is computed from its events.
//
// SPEC §7: "The current state of a diary is derived by code: `inbound` is
// computed from its events." L17: "Nobody reads a diary to learn the present."
//
// The probe walks the five stamps one event at a time, writing nothing else, and
// then closes the other door: a hand-written state is refused, so appending an
// event is the only path to a state change.

import { test, expect, beforeAll, afterAll } from "bun:test";
import { startCluster, freshDatabase, seam, type Cluster } from "./helpers/cluster.ts";

let cluster: Cluster;

const FIVE = ["received", "acked", "started", "answered", "delivered"] as const;
const ACTOR: Record<string, string> = {
  received: "door",
  acked: "runner",
  started: "runner",
  answered: "runner",
  delivered: "door",
};

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

test("REC-03 the current state of a diary is derived by code: the message state advances with each event and nothing else is written (SPEC §7, L17)", async () => {
  const { openStore, closeStore } = await seam("src/store/connect.ts");
  const { enqueueInbound } = await seam("src/store/inbound.ts");
  const { stamp } = await seam("src/records/stamps.ts");
  const { inboundState } = await seam("src/records/inbound-state.ts");
  expect(typeof inboundState).toBe("function");
  expect(typeof stamp).toBe("function");

  const db = await freshDatabase(cluster);
  const store = await (openStore as Function)({ url: cluster.url(db) });

  await (enqueueInbound as Function)(store, {
    id: "m-derived",
    person: "p1",
    agent: "p1-lair",
    body: "what happened to my message",
  });

  expect(await (inboundState as Function)(store, "m-derived")).toBe("received");

  const owner = cluster.connect(db) as unknown as Conn;

  for (const kind of FIVE.slice(1)) {
    await (stamp as Function)(store, {
      messageId: "m-derived",
      kind,
      actor: ACTOR[kind],
    });

    // Read the events themselves, not only the derived answer. The second seat
    // named the hole this closes: "a stamp function that directly sets a
    // protected inbound.state column and never appends an event passes. The
    // test calls stamp and reads state through inboundState. It never reads
    // ledger_event."
    const events = (await owner.unsafe(
      `select kind from ledger_event
       where stream = 'inbound' and subject = 'm-derived' order by seq`,
    )) as { kind: string }[];
    const upTo = FIVE.slice(0, FIVE.indexOf(kind) + 1) as unknown as string[];
    expect(events.map((e) => e.kind)).toEqual(upTo);

    // The derived state equals the derivation from those events, which is the
    // last one appended. Asserted after every event, so an implementation that
    // settles the state only at the end fails here rather than at the last line.
    const derivedFromEvents = events[events.length - 1].kind;
    expect(derivedFromEvents).toBe(kind);
    expect(await (inboundState as Function)(store, "m-derived")).toBe(
      derivedFromEvents,
    );
  }

  await owner.close();

  await (closeStore as Function)(store);
});

test("REC-03 the message state cannot be set by hand, so appending an event is the only path to it (SPEC §7, L17)", async () => {
  const { openStore, closeStore } = await seam("src/store/connect.ts");
  const { enqueueInbound } = await seam("src/store/inbound.ts");
  const { inboundState } = await seam("src/records/inbound-state.ts");
  expect(typeof inboundState).toBe("function");

  const db = await freshDatabase(cluster);
  const store = await (openStore as Function)({ url: cluster.url(db) });

  await (enqueueInbound as Function)(store, {
    id: "m-byhand",
    person: "p1",
    agent: "p1-lair",
    body: "hello",
  });

  const owner = cluster.connect(db) as unknown as Conn;
  let message = "";
  try {
    await owner.unsafe(
      "update inbound set state = 'delivered' where id = 'm-byhand'",
    );
  } catch (err) {
    message = String((err as Error).message);
  }
  expect(message.length).toBeGreaterThan(0);

  // And the state did not move, so the refusal was real rather than cosmetic.
  expect(await (inboundState as Function)(store, "m-byhand")).toBe("received");

  await owner.close();
  await (closeStore as Function)(store);
});
