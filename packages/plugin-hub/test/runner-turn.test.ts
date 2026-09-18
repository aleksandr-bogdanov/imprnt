// MSG-03, MSG-06 and MSG-01, on the runner's own half of a turn.
//
// SPEC §2: "Delivery is machinery. An agent produces text. It never calls a
// send tool, names an address or presses a key, for a human or for another
// agent. The turn's text is the reply." Its Forbidden list carries "a reply
// that depends on the model calling anything". Its Check line: "A turn with no
// tool call still lands." And: "Five stamps per human message, written by
// machinery, never by the model: received, acked, started, answered,
// delivered."
//
// The loop here is the scripted adapter, which implements the five verbs pinned
// in the seam contract and exposes NO tool of any kind, so a reply that needed
// the model to call something could not exist. That is what makes it the probe
// for the Forbidden line rather than a convenience.
//
// Red reason: import missing, src/runner/run.ts.

import { stageHub } from "./helpers/authorized-registry.ts";
import { test, expect, beforeAll, afterAll } from "bun:test";
import {
  startCluster,
  seam,
  foreignBackends,
  until,
  type Cluster,
} from "./helpers/cluster.ts";
import { scriptedReply } from "./helpers/scripted-adapter.ts";
import {
  AGENT,
  CHAT,
  DOOR,
  PERSON,
  RUNNER,
  chatLogLines,
  insertInbound,
  plantChatLine,
} from "./helpers/hub-fixture.ts";

let cluster: Cluster;

const SLOW = 90_000;
const MESSAGE = "how many chunks does one reply take";

beforeAll(async () => {
  cluster = await startCluster();
});

afterAll(async () => {
  if (cluster) await cluster.stop();
});

type Conn = {
  unsafe(query: string, values?: unknown[]): Promise<unknown>;
  close(): Promise<void>;
};

test(
  "MSG-03 a turn with no tool call still lands, and a reply that depends on the model calling anything is absent: the loop has no tool, and the text it produced is byte for byte what the platform received (SPEC §2, L1)",
  async () => {
    const { runRunner } = await seam("src/runner/run.ts");
    expect(typeof runRunner).toBe("function");
    const { runDoor } = await seam("src/door/run.ts");
    expect(typeof runDoor).toBe("function");

    const it = await stageHub(cluster);
    let door: { stop(): Promise<void> } | null = null;
    let runner: { stop(): Promise<void> } | null = null;

    try {
      door = await (runDoor as Function)({
        door: DOOR,
        registryFile: it.registryFile,
        platform: it.fake.platform,
      });
      runner = await (runRunner as Function)({
        runner: RUNNER,
        registryFile: it.registryFile,
        adapters: { [it.adapterName]: it.scripted.adapter },
      });

      it.fake.deliver({ text: MESSAGE });
      await until(
        "the reply was posted",
        () => it.fake.posts().length >= 1,
        45_000,
        async () =>
          `outbox=${JSON.stringify(await it.read.outbox())} ledger=${JSON.stringify(
            await it.read.ledger({ stream: "inbound" }),
          )}`,
      );
      await Bun.sleep(1500);

      // The load: byte equality between the turn's text and the posted text. A
      // build whose reply came from anywhere but the turn's own text fails it,
      // and that is MSG-03's whole content.
      const expected = scriptedReply(MESSAGE);
      const chunks = await it.read.outbox();
      expect(chunks.length).toBe(1);
      expect(chunks.map((c) => c.body).join("")).toBe(expected);
      expect(it.fake.posts().length).toBe(1);
      expect(it.fake.posts()[0].text).toBe(expected);
      expect(chunks[0].delivered_at).not.toBeNull();

      // The chat log holds the two sides of one exchange and nothing else.
      const log = chatLogLines(it.stateDir, PERSON, AGENT);
      expect(log.length).toBe(2);
      expect(log[0].direction).toBe("in");
      expect(log[0].text).toBe(MESSAGE);
      expect(log[1].direction).toBe("out");
      expect(log[1].text).toBe(expected);
    } finally {
      if (runner) await runner.stop();
      if (door) await door.stop();
      await it.stop();
    }
  },
  SLOW,
);

test(
  "MSG-06 the five stamps are written once each and in order, each at its own moment: read while the turn is still open, received, acked and started are there and answered and delivered are not (SPEC §2, L6)",
  async () => {
    const { runRunner } = await seam("src/runner/run.ts");
    expect(typeof runRunner).toBe("function");
    const { runDoor } = await seam("src/door/run.ts");
    expect(typeof runDoor).toBe("function");

    const it = await stageHub(cluster);
    let door: { stop(): Promise<void> } | null = null;
    let runner: { stop(): Promise<void> } | null = null;

    try {
      // L2's tail is fed first on every spawn, so there is a turn before this
      // one. The line planted here makes that tail real, and the gate goes on
      // only once the priming turn is out of the way, so what is held open is
      // the HUMAN message's turn.
      plantChatLine({ stateDir: it.stateDir, text: "what was said yesterday" });

      door = await (runDoor as Function)({
        door: DOOR,
        registryFile: it.registryFile,
        platform: it.fake.platform,
      });
      runner = await (runRunner as Function)({
        runner: RUNNER,
        registryFile: it.registryFile,
        adapters: { [it.adapterName]: it.scripted.adapter },
      });

      await until(
        "the priming turn of the spawn was recorded",
        async () => (await it.read.ledger({ stream: "turn" })).length >= 1,
        45_000,
        () => JSON.stringify(it.scripted.fed().map((f) => f.text)),
      );

      // The turn is now held open at its end, so the ledger can be read from
      // the middle of it. This is the assertion a runner that writes all five
      // stamps in a burst at the end cannot pass. Ordering alone is not enough,
      // because a burst is also in order.
      it.scripted.holdTurnEnd(true);
      it.fake.deliver({ text: MESSAGE });

      // Every assertion reads the store. The adapter's own record is only what
      // tells the test the turn has reached its middle.
      await until(
        "the loop reported its receipt and its first progress",
        () => it.scripted.fed().some((f) => f.text === MESSAGE),
        45_000,
      );
      await until(
        "the started stamp landed",
        async () =>
          (await it.read.ledger({ stream: "inbound", kind: "started" })).length ===
          1,
        45_000,
        async () =>
          JSON.stringify(await it.read.ledger({ stream: "inbound" })),
      );

      const mid = await it.read.ledger({ stream: "inbound" });
      expect(mid.map((e) => e.kind)).toEqual(["received", "acked", "started"]);
      expect(mid.some((e) => e.kind === "answered")).toBe(false);
      expect(mid.some((e) => e.kind === "delivered")).toBe(false);
      expect(await it.read.outbox()).toEqual([]);

      it.scripted.endTurn();
      await until(
        "the delivered stamp landed",
        async () =>
          (
            await it.read.ledger({ stream: "inbound", kind: "delivered" })
          ).length === 1,
        45_000,
        async () =>
          JSON.stringify(await it.read.ledger({ stream: "inbound" })),
      );
      await Bun.sleep(1500);

      const all = await it.read.ledger({ stream: "inbound" });
      expect(all.map((e) => e.kind)).toEqual([
        "received",
        "acked",
        "started",
        "answered",
        "delivered",
      ]);
      // Each one exactly once, by count, not merely present.
      for (const kind of [
        "received",
        "acked",
        "started",
        "answered",
        "delivered",
      ]) {
        expect(all.filter((e) => e.kind === kind).length).toBe(1);
      }
      // And each was written by the machinery that owns it.
      expect(all.map((e) => e.actor)).toEqual([
        "door",
        "runner",
        "runner",
        "runner",
        "door",
      ]);
      // Ordered by seq, which is the diary's own order.
      expect(all.map((e) => e.seq)).toEqual([...all.map((e) => e.seq)].sort((a, b) => a - b));
    } finally {
      if (runner) await runner.stop();
      if (door) await door.stop();
      await it.stop();
    }
  },
  SLOW,
);

test(
  "MSG-01 the runner's process is the runner role: every backend it opened reports hub_runner, and that role cannot create an inbound message (SPEC §2, L1, and 02-CONTEXT D-36)",
  async () => {
    const { runRunner } = await seam("src/runner/run.ts");
    expect(typeof runRunner).toBe("function");

    const it = await stageHub(cluster);
    let runner: { stop(): Promise<void> } | null = null;

    try {
      expect(it.storeUrl).not.toContain("@");
      const readerPid = await it.read.pid();

      runner = await (runRunner as Function)({
        runner: RUNNER,
        registryFile: it.registryFile,
        adapters: { [it.adapterName]: it.scripted.adapter },
      });
      await Bun.sleep(700);

      // Every backend that is not the test's own, so a runner that opens a
      // second connection as somebody else fails here.
      const theirs = await foreignBackends(cluster, it.db, [readerPid]);
      expect(theirs.length).toBeGreaterThan(0);
      for (const backend of theirs) {
        expect(backend.usename).toBe("hub_runner");
      }

      // The pair: the runner process is fenced by the database rather than by
      // its own good manners, which is the rule L1 exists to make true.
      const asRunner = cluster.connectAs("hub_runner", it.db) as unknown as Conn;
      let refusal = "";
      try {
        await asRunner.unsafe(
          `insert into inbound (id, person, agent, body)
           values ('m-runner-wrote-it', '${PERSON}', '${AGENT}', 'the runner invented a message')`,
        );
      } catch (err) {
        refusal = String((err as Error).message);
      }
      await asRunner.close();
      expect(refusal).not.toBe("");
      expect(refusal).toMatch(
        /permission denied|row-level security|insufficient privilege|42501/i,
      );

      // The control. Without it this passes on a database that refuses
      // everybody, which is not the rule.
      await insertInbound(cluster, it.db, {
        id: "m-door-wrote-it",
        body: "a human message",
      });
      expect((await it.read.inbound()).map((r) => r.id)).toEqual([
        "m-door-wrote-it",
      ]);
      expect(CHAT).toMatch(/^[0-9]+$/);
    } finally {
      if (runner) await runner.stop();
      await it.stop();
    }
  },
  SLOW,
);
