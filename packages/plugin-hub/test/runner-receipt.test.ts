// The acked stamp is the loop's own acknowledgement, and the
// started stamp is the loop's first progress.
//
// SPEC §2: "The runner feeds the row and marks it sent only when the loop acks
// that exact message." And the five stamps, "written by machinery, never by the
// model". The started stamp is the FIRST progress event of a turn, which
// is L6's "the model produced its first token or first action". A session
// opening event is not progress.
//
// Three holes a naive runner falls into, one per check:
//
//   1. writing `acked` the moment it hands the message over, rather than when
//      the loop says it has it.
//   2. accepting any receipt at all as the receipt for this message.
//   3. treating the first thing it sees in a turn as progress, so `started`
//      lands before the model produced anything.
//
// Red reason: import missing, src/runner/run.ts.

import { test, expect, beforeAll, afterAll } from "bun:test";
import { startCluster, seam, until, type Cluster } from "./helpers/cluster.ts";
import {
  RUNNER,
  insertInbound,
  plantChatLine,
  stageHub,
} from "./helpers/hub-fixture.ts";

let cluster: Cluster;

const SLOW = 90_000;
const MESSAGE = "when exactly is a message acknowledged";

beforeAll(async () => {
  cluster = await startCluster();
});

afterAll(async () => {
  if (cluster) await cluster.stop();
});

test(
  "MSG-02 the acked stamp is written only after the loop reported the receipt, and never before the feed: with the receipt held the feed happened and no acked exists, and when it arrives the stamp is later than the feed (SPEC §2, L1 step 4, L6)",
  async () => {
    const { runRunner } = await seam("src/runner/run.ts");
    expect(typeof runRunner).toBe("function");

    const it = await stageHub(cluster);
    let runner: { stop(): Promise<void> } | null = null;

    try {
      // L2's tail is fed first on every spawn, so the gate goes on only once
      // that priming turn is out of the way and the human row is inserted
      // after it. The insert's own notification is what wakes the runner, so
      // nothing can be fed between the gate and the row.
      plantChatLine({ stateDir: it.stateDir, text: "what was said yesterday" });
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

      it.scripted.holdReceipt(true);
      await insertInbound(cluster, it.db, { id: "m-ack", body: MESSAGE });

      // The feed is asserted to have happened first, so the absence below
      // cannot pass on a runner that never fed anything.
      await until(
        "the loop was fed the message",
        () => it.scripted.fed().some((f) => f.id === "m-ack" || f.text === MESSAGE),
        45_000,
        () => JSON.stringify(it.scripted.fed()),
      );
      const fedAt = it.scripted.fed().find((f) => f.text === MESSAGE)!.at;

      await Bun.sleep(3000);
      expect(await it.read.ledger({ stream: "inbound", kind: "acked" })).toEqual(
        [],
      );

      // Now the loop says it has that exact message.
      const [row] = await it.read.inbound();
      it.scripted.sendReceipt(row.id);

      await until(
        "the acked stamp landed",
        async () =>
          (await it.read.ledger({ stream: "inbound", kind: "acked" })).length === 1,
        10_000,
        async () => JSON.stringify(await it.read.ledger({ stream: "inbound" })),
      );

      // The feed-time comparison is the load. The absence assertion alone would
      // pass on a runner that is merely slow, and a runner that stamps `acked`
      // optimistically at the moment it hands the message over would land
      // before this moment rather than after it.
      const acked = await it.read.ledger({ stream: "inbound", kind: "acked" });
      expect(acked.length).toBe(1);
      expect(acked[0].actor).toBe("runner");
      expect(new Date(acked[0].at).getTime()).toBeGreaterThan(fedAt);
    } finally {
      if (runner) await runner.stop();
      await it.stop();
    }
  },
  SLOW,
);

test(
  "MSG-06 a receipt for another message writes no acked: the loop acknowledges a message nobody fed and the stamp does not land, and the right id then lands it (SPEC §2, L6)",
  async () => {
    const { runRunner } = await seam("src/runner/run.ts");
    expect(typeof runRunner).toBe("function");

    const it = await stageHub(cluster);
    let runner: { stop(): Promise<void> } | null = null;

    try {
      plantChatLine({ stateDir: it.stateDir, text: "what was said yesterday" });
      runner = await (runRunner as Function)({
        runner: RUNNER,
        registryFile: it.registryFile,
        adapters: { [it.adapterName]: it.scripted.adapter },
      });
      await until(
        "the priming turn of the spawn was recorded",
        async () => (await it.read.ledger({ stream: "turn" })).length >= 1,
        45_000,
      );

      it.scripted.holdReceipt(true);
      await insertInbound(cluster, it.db, { id: "m-wrong-id", body: MESSAGE });
      await until(
        "the loop was fed the message",
        () => it.scripted.fed().some((f) => f.text === MESSAGE),
        45_000,
      );

      // L1 says "only when the loop acknowledges that exact message". Without
      // this half any receipt at all satisfies the rule.
      it.scripted.sendReceipt("a-message-nobody-fed");
      await Bun.sleep(3000);
      expect(await it.read.ledger({ stream: "inbound", kind: "acked" })).toEqual(
        [],
      );

      // The following control, so the check cannot pass on a runner that never
      // stamps anything.
      const [row] = await it.read.inbound();
      it.scripted.sendReceipt(row.id);
      await until(
        "the acked stamp landed for the right id",
        async () =>
          (await it.read.ledger({ stream: "inbound", kind: "acked" })).length === 1,
        10_000,
      );
      const acked = await it.read.ledger({ stream: "inbound", kind: "acked" });
      expect(acked.length).toBe(1);
      expect(acked[0].subject).toBe(row.id);
    } finally {
      if (runner) await runner.stop();
      await it.stop();
    }
  },
  SLOW,
);

test(
  "MSG-06 a session opening event writes no started stamp: with progress withheld the session is open and the message acknowledged and no started exists, and the first real progress lands exactly one (SPEC §2, L6)",
  async () => {
    const { runRunner } = await seam("src/runner/run.ts");
    expect(typeof runRunner).toBe("function");

    const it = await stageHub(cluster);
    let runner: { stop(): Promise<void> } | null = null;

    try {
      plantChatLine({ stateDir: it.stateDir, text: "what was said yesterday" });
      runner = await (runRunner as Function)({
        runner: RUNNER,
        registryFile: it.registryFile,
        adapters: { [it.adapterName]: it.scripted.adapter },
      });
      await until(
        "the priming turn of the spawn was recorded",
        async () => (await it.read.ledger({ stream: "turn" })).length >= 1,
        45_000,
      );

      it.scripted.holdProgress(true);
      await insertInbound(cluster, it.db, { id: "m-init", body: MESSAGE });

      // The session is open and the message is acknowledged, which is the state
      // the verified toolchain is in right after its `system` event of subtype
      // `init`. A runner that treats the first thing it sees as progress, or
      // that stamps on the feed or on the receipt, has already written
      // `started` by now.
      await until(
        "the message was acknowledged",
        async () =>
          (await it.read.ledger({ stream: "inbound", kind: "acked" })).length === 1,
        45_000,
        async () => JSON.stringify(await it.read.ledger({ stream: "inbound" })),
      );
      it.scripted.openSession();
      await Bun.sleep(3000);

      // THE LOAD. Nothing has been produced, so nothing may say it started.
      expect(await it.read.ledger({ stream: "inbound", kind: "started" })).toEqual(
        [],
      );

      it.scripted.sendProgress({ kind: "text", text: "the first token" });
      await until(
        "the started stamp landed on real progress",
        async () =>
          (await it.read.ledger({ stream: "inbound", kind: "started" })).length ===
          1,
        10_000,
      );
      await Bun.sleep(1000);

      const started = await it.read.ledger({
        stream: "inbound",
        kind: "started",
      });
      expect(started.length).toBe(1);
      expect(started[0].actor).toBe("runner");
      // Decoration rather than load, and named as such: the test called
      // openSession before sending progress, so this ordering is nearly given.
      // The absence above is what an implementation can fail.
      expect(new Date(started[0].at).getTime()).toBeGreaterThanOrEqual(
        it.scripted.openedAt()!,
      );
    } finally {
      if (runner) await runner.stop();
      await it.stop();
    }
  },
  SLOW,
);
